import type pg from 'pg';

/**
 * Дневные справочные курсы ЕЦБ [Р-61]. Разбор строгий: всё, что не похоже на известный формат eurofxref-daily.xml,
 * отклоняется — неверный курс опаснее отсутствующего (без курса решение по себестоимости в другой валюте fail-closed).
 * Формат проверен по файлу за 2026-09-14 (test/fixtures). Курс дня неизменяем: повторная загрузка того же курса —
 * без изменений, другой курс за ту же дату — ошибка.
 */

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** Валюты, для которых курс нужен продукту [Р-57]; остальные в файле ЕЦБ не загружаются */
export const SUPPORTED_QUOTES = ['USD'] as const;

export interface EcbDailyRates {
  rateDate: string;
  rates: Array<{ currency: string; rate: string }>;
}

export class EcbFormatError extends Error {}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(['"])([^'"]*)\\1`).exec(tag);
  return m ? m[2]! : null;
};

export function parseEcbDailyXml(xml: string): EcbDailyRates {
  if (!/<gesmes:name>\s*European Central Bank\s*<\/gesmes:name>/.test(xml)) throw new EcbFormatError('sender is not the European Central Bank');
  const timeCubes = [...xml.matchAll(/<Cube\s+time\s*=\s*(['"])(\d{4}-\d{2}-\d{2})\1\s*>/g)];
  if (timeCubes.length !== 1) throw new EcbFormatError(`expected exactly one dated Cube, found ${timeCubes.length}`);
  const rateDate = timeCubes[0]![2]!;
  if (Number.isNaN(Date.parse(`${rateDate}T00:00:00Z`)) || new Date(`${rateDate}T00:00:00Z`).toISOString().slice(0, 10) !== rateDate) {
    throw new EcbFormatError(`invalid rate date ${rateDate}`);
  }
  const rates: EcbDailyRates['rates'] = [];
  for (const m of xml.matchAll(/<Cube\b[^>]*\bcurrency\b[^>]*\/>/g)) {
    const currency = attr(m[0], 'currency');
    const rate = attr(m[0], 'rate');
    if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new EcbFormatError(`invalid currency in ${m[0]}`);
    if (!rate || !/^\d{1,9}(\.\d{1,6})?$/.test(rate) || /^0+(\.0*)?$/.test(rate)) throw new EcbFormatError(`invalid rate for ${currency}: ${rate}`);
    if (rates.some((r) => r.currency === currency)) throw new EcbFormatError(`duplicate currency ${currency}`);
    rates.push({ currency, rate });
  }
  if (rates.length === 0) throw new EcbFormatError('no rates');
  return { rateDate, rates };
}

/** Точный перевод десятичной строки курса в миллионные доли — без двоичной плавающей точки */
export function rateToMicros(rate: string): number {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(rate);
  if (!m) throw new EcbFormatError(`invalid rate ${rate}`);
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'));
}

export interface LoadResult {
  rateDate: string;
  inserted: string[];
  unchanged: string[];
}

/**
 * Загрузка в platform.fx_rate ролью repracer_fx_loader. available_from — момент загрузки: решение, принятое раньше,
 * курс не увидит. Другой курс за уже загруженную дату — ошибка (курс дня неизменяем).
 */
export async function loadEcbDailyRates(pool: pg.Pool, xml: string, sourceRef: string = ECB_DAILY_URL): Promise<LoadResult> {
  const parsed = parseEcbDailyXml(xml);
  const wanted = parsed.rates.filter((r) => (SUPPORTED_QUOTES as readonly string[]).includes(r.currency));
  const result: LoadResult = { rateDate: parsed.rateDate, inserted: [], unchanged: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of wanted) {
      const { rows } = await client.query(
        `SELECT rate::text AS rate FROM platform.fx_rate WHERE source = 'ECB' AND rate_date = $1 AND quote_currency = $2`, [parsed.rateDate, r.currency]);
      if (rows[0]) {
        if (rateToMicros(Number(rows[0].rate).toFixed(6)) !== rateToMicros(r.rate)) {
          throw new EcbFormatError(`ECB ${r.currency} rate for ${parsed.rateDate} differs from the loaded one (${rows[0].rate} vs ${r.rate})`);
        }
        result.unchanged.push(r.currency);
        continue;
      }
      await client.query(
        `INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, source_ref) VALUES ('ECB', $1, 'EUR', $2, $3::numeric, $4)`,
        [parsed.rateDate, r.currency, r.rate, sourceRef]);
      result.inserted.push(r.currency);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
