import type {
  BOUND_CAUSES, BOUND_CHECKS, BOUND_NAMES, BUDGET_SOURCES, CHANNELS, CHECK_SOURCES, COMPLETENESS_KINDS, CONTEXT_CHANGES, COST_INPUTS, CURRENCY_SOURCES,
  ERROR_CLASSES, FX_CAUSES, HALT_REASONS, HALT_STAGES, INTENT_PROBLEMS, MARGIN_COST_CAUSES, MEMBER_ROLES, PARAM_CONSTRAINTS, PRICE_BASES, PRICING_MODES,
  PROBE_FIELDS, RECHECK_VIOLATIONS, RECONCILE_RESULTS, RULE_CODES, SCALE_ANCHORS, SCOPE_STATUSES, SELLER_ACTIONS, SHIFT_DIRECTIONS, SNAPSHOT_FIELDS,
  SNAPSHOT_INCONSISTENCIES, STOP_SCOPES, STOP_STAGES, STRATEGY_PARAM_NAMES, STRATEGY_TYPES, UNMET_REQUIREMENTS, WRITE_ERROR_CODES, LOWEST_SCOPES, MARGIN_REQUIREMENTS, BASIS_MISMATCH_DIRECTIONS, DISTRUST_REASONS,
} from '@repracer/pricing-model';
import type { Locale } from './types.ts';

/** Все значения кодов, которым словарь обязан дать подпись: пропуск не компилируется */
export type ValueKey =
  | (typeof BOUND_CAUSES)[number] | (typeof BOUND_CHECKS)[number] | (typeof BOUND_NAMES)[number] | (typeof BUDGET_SOURCES)[number]
  | (typeof CHANNELS)[number] | (typeof CHECK_SOURCES)[number] | (typeof COMPLETENESS_KINDS)[number] | (typeof CONTEXT_CHANGES)[number]
  | (typeof COST_INPUTS)[number] | (typeof CURRENCY_SOURCES)[number] | (typeof ERROR_CLASSES)[number] | (typeof FX_CAUSES)[number]
  | (typeof HALT_REASONS)[number] | (typeof HALT_STAGES)[number] | (typeof INTENT_PROBLEMS)[number] | (typeof MARGIN_COST_CAUSES)[number]
  | (typeof MEMBER_ROLES)[number] | (typeof PARAM_CONSTRAINTS)[number] | (typeof PRICE_BASES)[number] | (typeof PRICING_MODES)[number]
  | (typeof PROBE_FIELDS)[number] | (typeof RECHECK_VIOLATIONS)[number] | (typeof RECONCILE_RESULTS)[number] | (typeof RULE_CODES)[number]
  | (typeof SCALE_ANCHORS)[number] | (typeof SCOPE_STATUSES)[number] | (typeof SELLER_ACTIONS)[number] | (typeof SHIFT_DIRECTIONS)[number]
  | (typeof SNAPSHOT_FIELDS)[number] | (typeof SNAPSHOT_INCONSISTENCIES)[number] | (typeof STOP_SCOPES)[number] | (typeof STOP_STAGES)[number]
  | (typeof STRATEGY_PARAM_NAMES)[number] | (typeof STRATEGY_TYPES)[number] | (typeof UNMET_REQUIREMENTS)[number] | (typeof WRITE_ERROR_CODES)[number]
  | (typeof LOWEST_SCOPES)[number] | (typeof MARGIN_REQUIREMENTS)[number] | (typeof BASIS_MISMATCH_DIRECTIONS)[number] | (typeof DISTRUST_REASONS)[number]
  | 'INTERNAL' | 'VAT_INCLUDED' | 'SALES_TAX_EXCLUDED' | 'VAT_RATE_MISSING' | 'UNKNOWN_CHANNEL' | 'OTTO';

export interface NumberFormat {
  money(minor: number | null | undefined, currency: string | null | undefined): string;
  percentBp(bp: number | null | undefined): string;
  ratio(v: number): string;
  decimal(v: number, maxFraction: number): string;
  number(v: number): string;
  duration(seconds: number): string;
  when(iso: string | null | undefined): string;
  date(value: string | null | undefined): string;
  change(from: number | null | undefined, to: number | null | undefined): string | null;
  rate(micros: number): string;
}

const SYMBOLS: Readonly<Record<string, string>> = { EUR: '€', USD: '$' };

/** Числа без Intl: одинаково в Node и браузере; суммы — из целых минимальных единиц без округления */
export function numberFormat(locale: Locale, noValue: string): NumberFormat {
  const decimalSep = locale === 'de' ? ',' : '.';
  const groupSep = locale === 'de' ? '.' : ',';
  const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, groupSep);
  const decimal = (v: number, maxFraction: number): string => {
    const sign = v < 0 ? '−' : '';
    const fixed = Math.abs(v).toFixed(maxFraction).replace(/\.?0+$/, '');
    const [int, frac] = fixed.split('.');
    return `${sign}${group(Number(int))}${frac ? decimalSep + frac : ''}`;
  };
  const p2 = (n: number) => String(n).padStart(2, '0');
  const iso = (value: string) => {
    const ms = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
    return Number.isNaN(ms) ? null : new Date(ms);
  };
  return {
    money(minor, currency) {
      if (minor === null || minor === undefined || !Number.isSafeInteger(minor) || !currency) return noValue;
      const sign = minor < 0 ? '−' : '';
      const abs = Math.abs(minor);
      const amount = `${group(Math.floor(abs / 100))}${decimalSep}${p2(abs % 100)}`;
      const symbol = SYMBOLS[currency];
      if (!symbol) return `${sign}${amount} ${currency}`;
      return locale === 'de' ? `${sign}${amount} ${symbol}` : `${sign}${symbol}${amount}`;
    },
    percentBp(bp) {
      if (bp === null || bp === undefined || !Number.isFinite(bp)) return noValue;
      return `${decimal(bp / 100, 2)}${locale === 'de' ? ' %' : '%'}`;
    },
    ratio: (v) => `${decimal(v, 4)}×`,
    decimal,
    number: (v) => decimal(v, 2),
    duration(seconds) {
      const s = Math.round(seconds);
      if (Math.abs(s) < 120) return `${s} s`;
      if (Math.abs(s) < 7200) return `${decimal(s / 60, 1)} min`;
      return `${decimal(s / 3600, 1)} h`;
    },
    when(value) {
      if (!value) return noValue;
      const d = iso(value);
      if (!d) return value;
      const time = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
      return locale === 'de'
        ? `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}, ${time}`
        : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${time}`;
    },
    date(value) {
      if (!value) return noValue;
      const d = iso(value);
      if (!d) return value;
      return locale === 'de' ? `${p2(d.getUTCDate())}.${p2(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}` : `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
    },
    change(from, to) {
      if (from === null || from === undefined || to === null || to === undefined || from <= 0) return null;
      const pct = ((to - from) * 100) / from;
      const sign = pct > 0 ? '+' : pct < 0 ? '−' : '±';
      return `${sign}${decimal(Math.abs(pct), 1)}${locale === 'de' ? ' %' : '%'}`;
    },
    rate: (micros) => decimal(micros / 1_000_000, 6),
  };
}
