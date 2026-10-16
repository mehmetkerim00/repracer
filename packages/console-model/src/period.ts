import type { Messages } from './i18n/index.ts';

/**
 * Шаг 96: период экрана — одно правило для Shadow mode, Protections и Price changes (обоих видов журнала). Варианты — 24 часа,
 * 7 и 30 дней назад от «сейчас» или свой диапазон календарных дат. Даты — в поясе рабочего пространства [K4]: «с 1 по 5 октября»
 * значит с полуночи 1-го до конца 5-го по часам продавца, а не по UTC. Окно не уходит глубже, чем экран хранит данные (буфер
 * решений — 30 дней [Р-28], сырьё цен — 90 [Р-21]): что раньше, отрезается, и экран говорит это строкой (`clipped`).
 *
 * Строка запроса сверяется со списком и строгим видом даты — свободное число дней не проходит (находка 3 ревью шага 41:
 * «дней = 100000» прочитало бы всю историю тенанта).
 */
export const PERIOD_PRESETS = ['24h', '7d', '30d'] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export type Period = { preset: PeriodPreset } | { from: string; to: string };

const PRESET_HOURS: Readonly<Record<PeriodPreset, number>> = { '24h': 24, '7d': 168, '30d': 720 };
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function validDate(text: string): boolean {
  const m = DATE.exec(text);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === text;
}

/**
 * Период из адреса: `period=24h|7d|30d` или `from=ГГГГ-ММ-ДД&to=ГГГГ-ММ-ДД`. Нет ни того, ни другого — `undefined` (умолчание маршрута);
 * что-то неверное или и то, и другое сразу — `null` (ответ 400)
 */
export function parsePeriod(params: URLSearchParams): Period | null | undefined {
  const preset = params.get('period');
  const from = params.get('from');
  const to = params.get('to');
  if (preset !== null) {
    if (from !== null || to !== null) return null;
    return (PERIOD_PRESETS as readonly string[]).includes(preset) ? { preset: preset as PeriodPreset } : null;
  }
  if (from === null && to === null) return undefined;
  if (from === null || to === null || !validDate(from) || !validDate(to) || from > to) return null;
  return { from, to };
}

/** Параметры адреса для периода — та же форма, что разбирает `parsePeriod` */
export function periodSearch(p: Period): string {
  return 'preset' in p ? `period=${p.preset}` : `from=${p.from}&to=${p.to}`;
}

/** Смещение пояса от UTC в момент `ms`, миллисекунды; пояс, которого Intl не знает, — UTC */
function zoneOffsetMs(timeZone: string, ms: number): number {
  let v: Record<string, string>;
  try {
    v = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])) as Record<string, string>;
  } catch { return 0; }
  const wall = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), Number(v.hour) % 24, Number(v.minute), Number(v.second));
  return wall - Math.floor(ms / 1000) * 1000;
}

/** Начало календарных суток `date` по часам пояса (полночь по местным часам), миллисекунды UTC; переход на летнее время учтён */
export function zonedDayStart(date: string, timeZone: string): number {
  const m = DATE.exec(date)!;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const first = guess - zoneOffsetMs(timeZone, guess);
  const second = guess - zoneOffsetMs(timeZone, first);
  return second;
}

/** Календарная дата момента по часам пояса */
export function zonedDate(ms: number, timeZone: string): string {
  return new Date(ms + zoneOffsetMs(timeZone, ms)).toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  const m = DATE.exec(date)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

export interface PeriodRange {
  /** Начало окна (включительно) и конец (не позже «сейчас»), ISO UTC */
  since: string;
  until: string;
  /** Начало отрезано глубиной хранения экрана */
  clipped: boolean;
  /** Сколько суток экран хранит — для строки об отрезанном */
  maxDays: number;
}

/** Окно периода: пресет — назад от «сейчас»; свой диапазон — от полуночи первой даты до конца последней по поясу пространства */
export function periodRange(p: Period, now: string, timeZone: string | null | undefined, maxDays: number): PeriodRange {
  const nowMs = Date.parse(now);
  const tz = timeZone ?? 'UTC';
  let since: number;
  let until: number;
  if ('preset' in p) {
    since = nowMs - PRESET_HOURS[p.preset] * 3_600_000;
    until = nowMs;
  } else {
    since = zonedDayStart(p.from, tz);
    until = Math.min(zonedDayStart(nextDate(p.to), tz), nowMs);
  }
  const earliest = nowMs - maxDays * DAY_MS;
  const clipped = since < earliest;
  if (clipped) since = earliest;
  if (until < since) until = since;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), clipped, maxDays };
}

/** Сутки окна по поясу — для графика по дням: не меньше одних */
export function periodDays(range: PeriodRange, timeZone: string | null | undefined): number {
  const tz = timeZone ?? 'UTC';
  const first = zonedDate(Date.parse(range.since), tz);
  const last = zonedDate(Math.max(Date.parse(range.since), Date.parse(range.until) - 1), tz);
  return Math.max(1, Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1);
}

/** Фраза периода для заголовков: «in the last 7 days», «from Oct 1, 2026 to Oct 5, 2026» */
export function periodPhrase(p: Period, m: Messages): string {
  if ('preset' in p) return m.ui.period.phrase[p.preset];
  const human = (date: string) => m.date(date);
  return m.ui.period.between(human(p.from), human(p.to));
}
