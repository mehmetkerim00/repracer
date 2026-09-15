import type { Instant } from '@repracer/channel-port';

/**
 * Валютный пересчёт [Р-61, Р-63]. Себестоимость хранится в валюте возникновения и переводится в валюту цены при расчёте —
 * по дневному курсу ЕЦБ, известному системе на момент решения. Курс, по которому переведено значение, возвращается
 * вместе с результатом и хранится в решении ради объяснимости.
 *
 * Курс ЕЦБ — сколько единиц валюты за 1 EUR; хранится целым числом миллионных долей (1.1551 → 1 155 100): в файле ЕЦБ
 * не больше четырёх знаков после запятой у валют EUR и USD (проверено по eurofxref-daily.xml от 2026-09-14).
 * «Известен на момент решения» — загружен системой не позже момента решения (availableFrom): время публикации ЕЦБ
 * не закладывается. Все расчёты — целые числа через BigInt.
 */

export interface FxQuote {
  source: 'ECB';
  /** Дата курса ЕЦБ, YYYY-MM-DD */
  rateDate: string;
  base: 'EUR';
  quote: string;
  /** Единиц quote за 1 EUR × 1 000 000 */
  rateMicros: number;
  /** Когда курс загружен в систему: раньше этого момента решение его не видит */
  availableFrom: Instant;
}

export type FxRounding = 'UP' | 'NEAREST';

/** Как значение переведено — хранится в решении [Р-61] */
export interface FxApplied {
  source: 'ECB';
  rateDate: string;
  base: 'EUR';
  quote: string;
  rateMicros: number;
  from: string;
  to: string;
  sourceAmountMinor: number;
  convertedAmountMinor: number;
  rounding: FxRounding;
}

export type FxFailureCause = 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE' | 'UNSUPPORTED_CURRENCY' | 'INVALID_INPUT';

export type FxResult =
  | { ok: true; amountMinor: number; fx: FxApplied | null }
  | { ok: false; cause: FxFailureCause; from: string; to: string };

/** Показатель младшей единицы поддерживаемых валют [Р-57] */
export const MINOR_UNIT_EXPONENT: Readonly<Record<string, number>> = { EUR: 2, USD: 2 };

/**
 * Курс старше этого числа календарных дней не применяется (fail-closed). Шесть дней покрывают пасхальные выходные,
 * когда ЕЦБ не публикует курсы с четверга до вторника (календарь закрытий TARGET — проверить).
 */
export const FX_MAX_RATE_AGE_DAYS = 6;

const MICROS = 1_000_000n;
const DAY_MS = 86_400_000;

export function pickFxQuote(
  quotes: readonly FxQuote[], currency: string, at: Instant, maxAgeDays: number = FX_MAX_RATE_AGE_DAYS,
): { ok: true; quote: FxQuote } | { ok: false; cause: 'FX_RATE_UNAVAILABLE' | 'FX_RATE_STALE' } {
  const atMs = Date.parse(at);
  const latest = quotes
    .filter((q) => q.source === 'ECB' && q.base === 'EUR' && q.quote === currency && Date.parse(q.availableFrom) <= atMs
      && Number.isSafeInteger(q.rateMicros) && q.rateMicros > 0)
    .sort((a, b) => b.rateDate.localeCompare(a.rateDate))[0];
  if (!latest) return { ok: false, cause: 'FX_RATE_UNAVAILABLE' };
  const ageDays = Math.floor((Date.parse(`${at.slice(0, 10)}T00:00:00Z`) - Date.parse(`${latest.rateDate}T00:00:00Z`)) / DAY_MS);
  if (ageDays > maxAgeDays) return { ok: false, cause: 'FX_RATE_STALE' };
  return { ok: true, quote: latest };
}

/**
 * Перевод суммы в младших единицах. UP — для себестоимости (пол маржи не может оказаться ниже из-за округления),
 * NEAREST — для сравнения с чужой ценой (якорь «тот же EAN»). Поддерживаются пары с EUR — других валют в продукте нет [Р-57].
 */
export function convertMinor(amountMinor: number, from: string, to: string, quotes: readonly FxQuote[], at: Instant, rounding: FxRounding): FxResult {
  const fail = (cause: FxFailureCause): FxResult => ({ ok: false, cause, from, to });
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return fail('INVALID_INPUT');
  if (from === to) return { ok: true, amountMinor, fx: null };
  const expFrom = MINOR_UNIT_EXPONENT[from];
  const expTo = MINOR_UNIT_EXPONENT[to];
  if (expFrom === undefined || expTo === undefined || (from !== 'EUR' && to !== 'EUR')) return fail('UNSUPPORTED_CURRENCY');
  const picked = pickFxQuote(quotes, from === 'EUR' ? to : from, at);
  if (!picked.ok) return fail(picked.cause);
  const rate = BigInt(picked.quote.rateMicros);
  let numerator = from === 'EUR' ? BigInt(amountMinor) * rate : BigInt(amountMinor) * MICROS;
  let denominator = from === 'EUR' ? MICROS : rate;
  const scale = 10n ** BigInt(Math.abs(expTo - expFrom));
  if (expTo > expFrom) numerator *= scale;
  else if (expTo < expFrom) denominator *= scale;
  const converted = rounding === 'UP' ? (numerator + denominator - 1n) / denominator : (2n * numerator + denominator) / (2n * denominator);
  if (converted > BigInt(Number.MAX_SAFE_INTEGER)) return fail('INVALID_INPUT');
  const amount = Number(converted);
  return {
    ok: true,
    amountMinor: amount,
    fx: {
      source: 'ECB', rateDate: picked.quote.rateDate, base: 'EUR', quote: picked.quote.quote, rateMicros: picked.quote.rateMicros,
      from, to, sourceAmountMinor: amountMinor, convertedAmountMinor: amount, rounding,
    },
  };
}
