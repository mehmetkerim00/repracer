import { ALL_REASON_CODES, paramSchema, validateReason, type AnyReasonCode, type Reason } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import type { Fmt } from './i18n/types.ts';

/**
 * Причины человеческим языком [Р-72]: текст — из словаря по коду, значения — из параметров. Интерфейс ничего не домысливает:
 * сумма без валюты [Р-71], пустой параметр, неизвестный код или значение без подписи — проблема, видимая в проверке объяснимости.
 * Параметры из данных канала, не вошедшие в слепок [Р-68], показываются пометкой «значение канала не хранится».
 */

/** Причины, которые и после шага 12 объяснимы не полностью: чего нет и почему параметр невозможен */
export const LIMIT_CODES = ['SELLER_NAME_NOT_IN_CHANNEL_DATA', 'CHANNEL_MESSAGE_NOT_STORED', 'DELAY_CAUSE_NOT_RECORDED', 'CHANNEL_BUDGET_COUNTERS_UNKNOWN'] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];

export const REASON_LIMITS: Readonly<Partial<Record<AnyReasonCode, LimitCode>>> = {
  MARKET_SHIFT_SINGLE_SELLER: 'SELLER_NAME_NOT_IN_CHANNEL_DATA',
  WRITE_NOT_ACCEPTED_BY_CHANNEL: 'CHANNEL_MESSAGE_NOT_STORED',
  INTENT_EXPIRED: 'DELAY_CAUSE_NOT_RECORDED',
  WRITE_EDIT_BUDGET_EXHAUSTED: 'CHANNEL_BUDGET_COUNTERS_UNKNOWN',
};

export interface HumanReason {
  code: string;
  title: string;
  text: string;
  /** Машинные метки проблем объяснения (для проверки объяснимости, не для продавца) */
  problems: string[];
  /** Чего не хватает и почему параметр невозможен */
  limit: string | null;
  /** Значения канала, не вошедшие в слепок */
  withheld: string[];
}

type Params = Reason['params'];

export function describe(reason: { code: string; params: Params; withheld?: readonly string[] }, m: Messages): HumanReason {
  const params = reason.params ?? {};
  const withheld = new Set(reason.withheld ?? []);
  const problems: string[] = [];
  const WITHHELD = Symbol('withheld');
  const MISSING = Symbol('missing');
  const get = (key: string): string | number | boolean | typeof WITHHELD | typeof MISSING => {
    if (withheld.has(key)) return WITHHELD;
    const v = params[key];
    if (v === undefined || v === null) {
      const spec = paramSchema(reason.code)?.[key];
      if (!spec || !(v === null ? spec.nullable : spec.optional)) problems.push(`MISSING_PARAM:${key}`);
      return MISSING;
    }
    return v;
  };
  const numeric = (key: string, render: (v: number) => string): string => {
    const v = get(key);
    if (v === WITHHELD) return m.ui.common.withheld;
    if (v === MISSING) return m.ui.common.noValue;
    if (typeof v !== 'number') {
      problems.push(`NOT_A_NUMBER:${key}`);
      return String(v);
    }
    return render(v);
  };
  const label = (code: string): string => {
    const text = (m.values as Record<string, string | undefined>)[code];
    if (text === undefined) {
      problems.push(`UNLABELLED_VALUE:${code}`);
      return code;
    }
    return text;
  };
  const plain = (key: string, render: (v: string) => string): string => {
    const v = get(key);
    return v === WITHHELD ? m.ui.common.withheld : v === MISSING ? m.ui.common.noValue : render(String(v));
  };
  const f: Fmt = {
    has: (key) => withheld.has(key) || (params[key] !== undefined && params[key] !== null),
    get: (key) => params[key],
    money: (key) => numeric(key, (v) => {
      const currency = params.currency;
      if (typeof currency !== 'string') {
        problems.push('AMOUNT_WITHOUT_CURRENCY');
        return m.ui.common.amountWithoutCurrency(String(v));
      }
      return m.money(v, currency);
    }),
    bp: (key) => numeric(key, (v) => m.percentBp(v)),
    ratio: (key) => numeric(key, (v) => m.ratio(v)),
    count: (key) => numeric(key, (v) => m.number(v)),
    seconds: (key) => numeric(key, (v) => m.duration(v)),
    minutes: (key) => numeric(key, (v) => m.duration(v * 60)),
    when: (key) => plain(key, (v) => m.when(v)),
    date: (key) => plain(key, (v) => m.date(v)),
    value: (key) => plain(key, label),
    list: (key) => plain(key, (v) => v.split(',').filter(Boolean)
      .map((x) => (x.includes(':') ? x.split(':').map((part, i) => (i === 0 ? label(part) : part)).join(' ') : label(x))).join(', ')),
    raw: (key) => plain(key, (v) => v),
  };
  const render = (m.reasons as Record<string, ((f: Fmt) => string) | undefined>)[reason.code]
    ?? (m.notes as Record<string, ((f: Fmt) => string) | undefined>)[reason.code];
  if (!render) problems.push('UNKNOWN_CODE');
  const text = render ? render(f) : m.ui.common.unknownReason(reason.code);
  // Схема сверяется для причин целиком; у причины из слепка часть обязательных параметров вырезана намеренно
  if (withheld.size === 0) for (const p of validateReason({ code: reason.code, params })) problems.push(`SCHEMA:${p}`);
  const limit = REASON_LIMITS[reason.code as AnyReasonCode];
  return {
    code: reason.code,
    title: (m.titles as Record<string, string | undefined>)[reason.code] ?? (m.ui.rules as Record<string, string | undefined>)[reason.code] ?? reason.code,
    text,
    problems: [...new Set(problems)],
    limit: limit ? m.limits[limit] : null,
    withheld: [...withheld],
  };
}

export interface ExplainabilityRow {
  code: AnyReasonCode;
  title: string;
  verdict: 'FULL' | 'LIMITED';
  note: string | null;
}

/** Все коды реестра: объяснимы полностью или с ограничением, которое невозможно снять параметром */
export function explainabilityCatalogue(m: Messages): ExplainabilityRow[] {
  return ALL_REASON_CODES.map((code) => {
    const limit = REASON_LIMITS[code];
    return { code, title: m.titles[code], verdict: limit ? 'LIMITED' : 'FULL', note: limit ? m.limits[limit] : null };
  });
}
