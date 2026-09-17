import type { Instant } from '@repracer/channel-port';

/**
 * Р-123 (шаг 24): Omnibus — объявляя скидку, продавец указывает прежнюю цену; она не может быть выше наименьшей цены этого оффера за 30 дней
 * до начала скидки, отдельно по каждому каналу (единица записи — канал, витрина, оффер) и по суткам часового пояса витрины [Р-62, Р-65].
 * Наименьшая цена — среди цены, действовавшей к началу окна, и всех цен, применённых в окне: суточная свёртка хранит только дни с
 * изменениями [Р-21], поэтому день без изменения несёт цену, действовавшую с последнего изменения.
 *
 * Та же логика в базе — tenant_data.omnibus_lowest_prior_price (0087); равенство проверяет omnibus.pg.test.ts. Эта функция — для хранилища
 * в памяти и расчёта предупреждения до записи.
 */

export const OMNIBUS_WINDOW_DAYS = 30;

export type OmnibusStatus =
  /** Цена к началу окна известна: наименьшая цена окна посчитана полностью */
  | 'OK'
  /** История цен оффера начинается внутри окна (подключение, первая запись): цены до неё неизвестны, наименьшая — нижняя граница не подтверждена */
  | 'INCOMPLETE_HISTORY'
  /** Цен оффера нет вовсе */
  | 'NO_PRICE_HISTORY'
  /** Часовой пояс витрины не установлен [Р-65]: сутки окна не определить */
  | 'TIME_ZONE_UNKNOWN'
  /** Скидка начинается позже момента проверки: цены до её начала ещё не известны (ревью шага 24, находка 1) */
  | 'WINDOW_OPEN';

export interface OmnibusPriorPrice {
  status: OmnibusStatus;
  /** Наименьшая цена окна; null — цен нет или пояс неизвестен */
  lowestMinor: number | null;
  /** Первый и последний день окна по часовому поясу витрины (YYYY-MM-DD) */
  windowFrom: string | null;
  windowTo: string | null;
  timeZone: string | null;
  historySince: Instant | null;
}

export type OmnibusVerdict = 'COMPLIANT' | 'VIOLATION' | 'UNVERIFIED';

/** Дата в часовом поясе */
export function localDate(instant: Instant | number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Смещение пояса в момент, мс (местное − UTC) */
function offsetMs(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(ms / 1000) * 1000;
}

/** Начало суток date (YYYY-MM-DD) в часовом поясе — момент UTC, мс */
export function zonedDayStart(date: string, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const naive = Date.UTC(y, m - 1, d);
  // Две итерации: смещение в момент начала суток, с учётом перехода на летнее время внутри суток
  let guess = naive - offsetMs(naive, timeZone);
  guess = naive - offsetMs(guess, timeZone);
  return guess;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Наименьшая цена за 30 суток витрины до суток начала скидки и в сутки начала до её начала; asOf — момент проверки. changes — применённые цены оффера (время применения каналом, сумма),
 * в любом порядке.
 */
export function omnibusLowestPriorPrice(changes: ReadonlyArray<{ acceptedAt: Instant; amountMinor: number }>, timeZone: string | null, startsAt: Instant, asOf: Instant): OmnibusPriorPrice {
  const sorted = [...changes].sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt));
  const historySince = sorted[0]?.acceptedAt ?? null;
  if (!timeZone) return { status: 'TIME_ZONE_UNKNOWN', lowestMinor: null, windowFrom: null, windowTo: null, timeZone: null, historySince };
  const startDay = localDate(startsAt, timeZone);
  const windowFrom = addDays(startDay, -OMNIBUS_WINDOW_DAYS);
  const windowTo = addDays(startDay, -1);
  const fromMs = zonedDayStart(windowFrom, timeZone);
  const toMs = zonedDayStart(startDay, timeZone);
  const open = Date.parse(startsAt) > Date.parse(asOf);
  if (sorted.length === 0) return { status: open ? 'WINDOW_OPEN' : 'NO_PRICE_HISTORY', lowestMinor: null, windowFrom, windowTo, timeZone, historySince };
  const before = sorted.filter((c) => Date.parse(c.acceptedAt) < fromMs).at(-1);
  // Сутки начала скидки — до её начала (ревью шага 24, находка 14)
  const inside = sorted.filter((c) => Date.parse(c.acceptedAt) >= fromMs && Date.parse(c.acceptedAt) < Math.max(toMs, Date.parse(startsAt))).map((c) => c.amountMinor);
  const candidates = [...(before ? [before.amountMinor] : []), ...inside];
  const lowestMinor = candidates.length > 0 ? Math.min(...candidates) : null;
  // Ни цены к началу окна, ни цен в окне: история начинается в сутки скидки или позже
  const status: OmnibusStatus = open ? 'WINDOW_OPEN' : before ? 'OK' : lowestMinor === null ? 'NO_PRICE_HISTORY' : 'INCOMPLETE_HISTORY';
  return { status, lowestMinor, windowFrom, windowTo, timeZone, historySince };
}

/** Прежняя цена объявления против наименьшей цены окна */
export function omnibusVerdict(prior: OmnibusPriorPrice, referenceMinor: number): OmnibusVerdict {
  if (prior.lowestMinor !== null && referenceMinor > prior.lowestMinor) return 'VIOLATION';
  return prior.status === 'OK' ? 'COMPLIANT' : 'UNVERIFIED';
}
