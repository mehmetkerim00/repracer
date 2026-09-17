import type {
  ConsoleDecisionRow, ConsoleHaltRow, ConsoleIntentRow, ConsoleScopeRow, ConsoleState, ConsoleStopRow, ConsoleWriteRow,
} from '@repracer/pricing-pipeline';
import type { MemberRole } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';

/**
 * Мир для экранов [Р-67]: состояние хранилища через порт PricingStore.readConsoleState — одинаково в памяти и на PostgreSQL.
 * Объяснения решений — из неизменяемых слепков [Р-68], отчёты прогона экранам не нужны.
 */

export interface StandAccount {
  channelAccountId: string;
  channel: string;
  marketplaces: string[];
}

/** Кто смотрит: от его роли зависят действия [OQ-125] */
export interface Viewer {
  membershipId: string;
  role: MemberRole;
}

export interface StandWorld {
  id: string;
  title: string;
  description: string;
  tenantId: string;
  /** Время мира */
  now: string;
  accounts: StandAccount[];
  viewer: Viewer;
  state: ConsoleState;
}

export type ConsoleScope = ConsoleScopeRow;
export type ConsoleDecision = ConsoleDecisionRow;
export type ConsoleIntent = ConsoleIntentRow;
export type ConsoleWrite = ConsoleWriteRow;
export type ConsoleHalt = ConsoleHaltRow;
export type ConsoleStop = ConsoleStopRow;

/** Пробелы в данных, которые остаются после шага 12: экран говорит «нет данных», а не придумывает значение */
export const GAP_CODES = [
  'PRODUCT_TITLE', 'NEXT_CHECK', 'USER_TIME_ZONE', 'NO_EXPLANATION', 'SNAPSHOT_CONTENT', 'SNAPSHOT_REF_EXPIRED', 'CHANNEL_VALUES_WITHHELD',
  'CONFIRMATION_SOURCE', 'DB_COMMIT_REJECTIONS', 'REJECTED_SNAPSHOT_CONTENT', 'COST_COMPONENTS', 'FEE_TARIFF', 'SELLER_NAMES', 'SOURCE_NAME', 'MFA_AT_PROVIDER',
  'NO_OP_NOT_EXPLAINED', 'EXPLANATION_DICTIONARY_MISSING',
  // Шаг 21: экраны стратегий, правки границ, ленты цен и отчёта об опасных изменениях
  'PREVIEW_LAST_SNAPSHOT', 'PREVIEW_CURRENT_BOUNDS', 'BOUND_LEVELS', 'MASS_EDIT_MFA_PER_TRANSACTION', 'FEED_WINDOW', 'PRICE_HISTORY_NOT_READ',
  'DANGEROUS_REPORT_WINDOW', 'DANGEROUS_THRESHOLD', 'FLOOR_HOLD_TARGET_WINDOW',
] as const;
export type GapCode = (typeof GAP_CODES)[number];

export interface Gap {
  code: GapCode;
  what: string;
  why: string;
}

export function gap(m: Messages, code: GapCode): Gap {
  return { code, ...m.gaps[code] };
}

export function uniqueGaps(gaps: readonly Gap[]): Gap[] {
  const seen = new Set<string>();
  return gaps.filter((g) => (seen.has(g.code) ? false : (seen.add(g.code), true)));
}

export type Tone = 'ok' | 'progress' | 'warn' | 'stop' | 'off' | 'unknown';

export interface StatusCell {
  tone: Tone;
  label: string;
  detail: string;
}

export interface UnitRef {
  writeScopeId: string;
  channel: string;
  marketplace: string;
  externalUnitId: string;
  channelProductRef: string;
  condition: string;
  gtin: string | null;
  label: string;
}

export function channelOf(world: StandWorld, channelAccountId: string): string {
  return world.accounts.find((a) => a.channelAccountId === channelAccountId)?.channel ?? 'UNKNOWN_CHANNEL';
}

export function unitOf(world: StandWorld, scope: ConsoleScope, m: Messages): UnitRef {
  const channel = channelOf(world, scope.channelAccountId);
  return {
    writeScopeId: scope.writeScopeId, channel, marketplace: scope.marketplace, externalUnitId: scope.externalUnitId,
    channelProductRef: scope.channelProductRef, condition: scope.condition, gtin: scope.gtin,
    label: m.ui.common.unitLabel(m.values[channel as keyof typeof m.values] ?? channel, scope.marketplace, scope.externalUnitId),
  };
}

export function scopeById(world: StandWorld, writeScopeId: string): ConsoleScope | undefined {
  return world.state.scopes.find((s) => s.writeScopeId === writeScopeId);
}
