/**
 * Реестр причин всех слоёв пути решения [Р-72]: движок отдаёт только код и параметры, тексты — в словаре интерфейса (DE, EN).
 *
 * Для каждого кода объявлены параметры: вид значения и класс источника.
 *  - Вид `money` — целые минимальные единицы; причина с суммой обязана нести `currency` [Р-71], интерфейс валюту не домысливает.
 *  - Класс `CHANNEL` — значение из данных канала (цены конкурентов, счётчики наблюдений). Такие параметры не попадают в
 *    неизменяемый слепок объяснения решения [Р-68]: слепок живёт вечно, данные канала — не дольше 18 месяцев [Р-3, Р-38].
 *  - `TENANT` — данные продавца (наши цены, границы, себестоимость), `CONFIG` — пороги правил, `PUBLIC` — курс ЕЦБ.
 * Один ключ имеет один класс во всех кодах: БД отклоняет слепок с ключами класса CHANNEL по имени (0042).
 */

// ---------------------------------------------------------------------------
// Коды
// ---------------------------------------------------------------------------

/** Проверка входов [Р-42] — совпадает с CHECK channel_data.rejected_competitor_snapshot.reason_code (0030) */
export const SANITY_REASON_CODES = [
  'INVALID_AMOUNT',
  'CURRENCY_MISMATCH',
  'PRICE_BASIS_MISMATCH',
  'INCONSISTENT_SNAPSHOT',
  'SNAPSHOT_FROM_FUTURE',
  'SNAPSHOT_TOO_OLD',
  'OUT_OF_ORDER',
  'CHANNEL_HALTED',
  'CHANNEL_MASS_SHIFT',
  'UNIT_SCALE_X100',
  'UNIT_SCALE_X0_01',
  // основные якоря [Р-49], в порядке применения
  'PRICE_BELOW_COST_ANCHOR',
  'PRICE_ABOVE_COST_ANCHOR',
  'SNAPSHOT_INTERNAL_OUTLIER',
  'CROSS_CHANNEL_MISMATCH',
  'OUTSIDE_HISTORY_BAND',
  'NO_PLAUSIBILITY_ANCHOR',
] as const;
export type SanityReasonCode = (typeof SANITY_REASON_CODES)[number];

/** Предупреждения проверки входов: снимок принимается [Р-49, Р-50, Р-55, Р-63] */
export const SANITY_WARNING_CODES = [
  'OWN_PRICE_DEVIATION',
  'SELF_OFFER_DIVERGENCE',
  'INTERNAL_OUTLIER_IGNORED',
  'MARKET_SHIFT_DISPERSED',
  'MARKET_SHIFT_SINGLE_SELLER',
  'CROSS_CHANNEL_FX_UNAVAILABLE',
] as const;
export type SanityWarningCode = (typeof SANITY_WARNING_CODES)[number];

/** Правила проверки входов в порядке применения; отказ записывается правилом с кодом причины */
export const SANITY_RULES = [
  'CHANNEL_HALTED', 'STRUCTURE', 'FRESHNESS', 'CHANNEL_MASS_SHIFT', 'UNIT_SCALE',
  'COST_ANCHOR', 'INTERNAL_ANCHOR', 'CROSS_CHANNEL_ANCHOR', 'HISTORY_ANCHOR',
] as const;
export type SanityRule = (typeof SANITY_RULES)[number];

/** Пояснения к прошедшим и пропущенным правилам — коды вместо текста [Р-72] */
export const SANITY_NOTE_CODES = [
  'COST_NOT_DECLARED',
  'TOO_FEW_COMPETITOR_OFFERS',
  'HISTORY_TOO_SHORT',
  'HISTORY_AVAILABLE',
  'NO_SCALE_REFERENCE',
  'SINGLE_SELLER_MARKET_EVENT',
  'DISPERSED_MARKET_EVENT',
  'SHIFT_BELOW_SHARE',
  'SMALL_MOVE',
  'NO_PREVIOUS_SNAPSHOT',
  'REFERENCES_CONVERTED_AT_ECB',
  'REFERENCES_WITHOUT_ECB_RATE',
  'NO_FRESH_CROSS_CHANNEL_REFERENCE',
] as const;
export type SanityNoteCode = (typeof SANITY_NOTE_CODES)[number];

export type AlarmClass = 'STRUCTURE' | 'FRESHNESS' | 'UNIT_SCALE' | 'OUTLIER' | 'CHANNEL_SHIFT' | 'CHANNEL_HALTED' | 'ANCHOR_MISSING';

export const SANITY_ALARM_CLASS: Readonly<Record<SanityReasonCode, AlarmClass>> = {
  INVALID_AMOUNT: 'STRUCTURE',
  CURRENCY_MISMATCH: 'STRUCTURE',
  PRICE_BASIS_MISMATCH: 'STRUCTURE',
  INCONSISTENT_SNAPSHOT: 'STRUCTURE',
  SNAPSHOT_FROM_FUTURE: 'FRESHNESS',
  SNAPSHOT_TOO_OLD: 'FRESHNESS',
  OUT_OF_ORDER: 'FRESHNESS',
  CHANNEL_HALTED: 'CHANNEL_HALTED',
  CHANNEL_MASS_SHIFT: 'CHANNEL_SHIFT',
  UNIT_SCALE_X100: 'UNIT_SCALE',
  UNIT_SCALE_X0_01: 'UNIT_SCALE',
  PRICE_BELOW_COST_ANCHOR: 'OUTLIER',
  PRICE_ABOVE_COST_ANCHOR: 'OUTLIER',
  SNAPSHOT_INTERNAL_OUTLIER: 'OUTLIER',
  CROSS_CHANNEL_MISMATCH: 'OUTLIER',
  OUTSIDE_HISTORY_BAND: 'OUTLIER',
  NO_PLAUSIBILITY_ANCHOR: 'ANCHOR_MISSING',
};

export const ENGINE_REASON_CODES = [
  // цель рассчитана (CHANGED, если отличается от текущей цены)
  'FIXED_PRICE',
  'MARGIN_TARGET',
  'BUYBOX_MATCH',
  'BUYBOX_UNDERCUT',
  'LOWEST_MATCH',
  'LOWEST_UNDERCUT',
  // шаги расчёта
  'CAPPED_AT_MIN_PRICE',
  'CAPPED_AT_MAX_PRICE',
  // NO_OP
  'ALREADY_AT_TARGET',
  'WITHIN_DEADBAND',
  'ALREADY_WINNING_BUYBOX',
  'NO_COMPETITOR_OFFERS',
  'TARGET_OUTSIDE_BOUNDS_HOLD',
  // не рассчитано
  'COMPETITOR_REQUIREMENT_NOT_MET',
  'COST_INPUTS_MISSING',
  'MARGIN_UNATTAINABLE',
  'BOUNDS_INVALID',
  'ENGINE_CURRENCY_MISMATCH',
  'INVALID_STRATEGY_PARAMS',
] as const;
export type EngineReasonCode = (typeof ENGINE_REASON_CODES)[number];

/** Price Gate [Р-43, Р-44] — коды отклонения совпадают с CHECK price_decision.rejection_reason (0030, 0042) */
export const GATE_REASON_CODES = [
  'APPROVED',
  'NO_CHANGE',
  'BELOW_MIN_PRICE',
  'BELOW_MARGIN_FLOOR',
  'ABOVE_MAX_PRICE',
  'BOUND_UNRESOLVABLE',
  'STEP_LIMIT',
  'CHANGE_RATE_LIMIT',
  'INTENT_EXPIRED',
  'INTENT_INVALID',
  'SCOPE_NOT_ACTIVE',
  'CHANNEL_HALTED',
  // шаг 12: остановка человеком — все цены без исключений [Р-69]
  'PRICING_STOPPED',
  'INTERNAL_BOUND_VIOLATION',
] as const;
export type GateReasonCode = (typeof GATE_REASON_CODES)[number];

export const PIPELINE_REASON_CODES = [
  'MIN_PRICE_MISSING',
  'MAX_PRICE_MISSING',
  'BOUNDS_INVERTED',
  'BOUND_CURRENCY_MISMATCH',
  'SCOPE_NOT_ENGINE',
  'NO_SCOPE_FOR_PRODUCT',
  'WRITE_BLOCKED_BY_BOUND_RECHECK',
  'WRITE_NOT_ACCEPTED_BY_CHANNEL',
  'BOUNDS_VERSION_CHANGED',
  'DIVERGENCE_CASE_OPENED',
  'HALT_AUTO_RELEASED',
  'HALT_REVIEW_FAILED',
  'HALT_MANUALLY_RELEASED',
  // шаг 12: предупреждение при включении — маржинальная цена без себестоимости
  'MARGIN_WITHOUT_COST',
  // шаг 13 [Р-77]: включение без назначенной стратегии
  'STRATEGY_MISSING',
] as const;
export type PipelineReasonCode = (typeof PIPELINE_REASON_CODES)[number];

/** Диспетчер записей [Р-64] */
export const DISPATCH_REASON_CODES = [
  'WRITE_SUPERSEDED_BY_NEWER_VERSION',
  'WRITE_RETRIES_EXHAUSTED',
  'WRITE_PRICING_MODE_CHANGED',
  'WRITE_EDIT_BUDGET_EXHAUSTED',
  'WRITE_QUEUED_BEHIND_IN_FLIGHT',
  'WRITE_RETRY_SCHEDULED',
  'WRITE_OUTCOME_RECONCILED',
  'WRITE_SCOPE_BLOCKED',
  'WRITE_BUDGET_DAY_UNCONFIRMED',
  // Р-116 (шаг 22): обратное чтение показало цену, отличающуюся от отправленной ровно на ставку налога, — остановка витрины
  'CHANNEL_PRICE_BASIS_MISMATCH',
] as const;
export type DispatchReasonCode = (typeof DISPATCH_REASON_CODES)[number];

export type AnyReasonCode = SanityReasonCode | SanityWarningCode | EngineReasonCode | GateReasonCode | PipelineReasonCode | DispatchReasonCode;

/** Причины завершения записи без отправки — совпадают с CHECK tenant_data.channel_write.end_reason (0036, 0042) */
export const WRITE_END_REASON_CODES = [
  'WRITE_SUPERSEDED_BY_NEWER_VERSION',
  'WRITE_NOT_ACCEPTED_BY_CHANNEL',
  'WRITE_RETRIES_EXHAUSTED',
  'WRITE_BLOCKED_BY_BOUND_RECHECK',
  'CHANNEL_HALTED',
  'PRICING_STOPPED',
  'WRITE_PRICING_MODE_CHANGED',
  'WRITE_EDIT_BUDGET_EXHAUSTED',
  'WRITE_BUDGET_DAY_UNCONFIRMED',
] as const satisfies readonly AnyReasonCode[];
export type WriteEndReasonCode = (typeof WRITE_END_REASON_CODES)[number];

/** Коды всех слоёв без повторов: CHANNEL_HALTED общий у проверки входов, Gate и записи (параметр stage) */
export const ALL_REASON_CODES: readonly AnyReasonCode[] = [
  ...new Set<AnyReasonCode>([...SANITY_REASON_CODES, ...SANITY_WARNING_CODES, ...ENGINE_REASON_CODES, ...GATE_REASON_CODES, ...PIPELINE_REASON_CODES, ...DISPATCH_REASON_CODES]),
];

// ---------------------------------------------------------------------------
// Параметры
// ---------------------------------------------------------------------------

export type ParamKind =
  | 'money' | 'currency' | 'bp' | 'ratio' | 'rateMicros' | 'count' | 'seconds' | 'minutes' | 'instant' | 'date'
  | 'id' | 'enum' | 'enumList' | 'bool' | 'storefrontList' | 'userText';

/**
 * CHANNEL_DERIVED [Р-85] — значение тенанта, из которого выводится значение канала (цель «Buy Box минус подрез», разница с целью
 * в мёртвой зоне). В вечное хранение не допускается, как CHANNEL; в горячих данных решения живёт с ним наравне.
 */
export type ParamClass = 'TENANT' | 'CHANNEL' | 'CHANNEL_DERIVED' | 'CONFIG' | 'PUBLIC';

export interface ParamSpec {
  kind: ParamKind;
  class: ParamClass;
  optional?: boolean;
  nullable?: boolean;
  values?: readonly string[];
}

export type ParamSchema = Readonly<Record<string, ParamSpec>>;

type Opt = { optional?: boolean; nullable?: boolean };
const O: Opt = { optional: true };
const N: Opt = { nullable: true };
const ON: Opt = { optional: true, nullable: true };
const p = (kind: ParamKind, cls: ParamClass, o: Opt = {}, values?: readonly string[]): ParamSpec => ({ kind, class: cls, ...o, ...(values ? { values } : {}) });
const money = (cls: ParamClass, o: Opt = {}) => p('money', cls, o);
const currency = (o: Opt = {}) => p('currency', 'TENANT', o);
const count = (cls: ParamClass, o: Opt = {}) => p('count', cls, o);
const bp = (cls: ParamClass, o: Opt = {}) => p('bp', cls, o);
const ratio = (cls: ParamClass, o: Opt = {}) => p('ratio', cls, o);
const seconds = (cls: ParamClass, o: Opt = {}) => p('seconds', cls, o);
const instant = (cls: ParamClass, o: Opt = {}) => p('instant', cls, o);
const id = (cls: ParamClass, o: Opt = {}) => p('id', cls, o);
const oneOf = (values: readonly string[], cls: ParamClass, o: Opt = {}) => p('enum', cls, o, values);
const listOf = (values: readonly string[], cls: ParamClass, o: Opt = {}) => p('enumList', cls, o, values);

export const PROBE_FIELDS = ['buybox', 'lowest', 'suggested'] as const;
export const SNAPSHOT_FIELDS = ['BUYBOX_PRICE', 'SUGGESTED_PRICE', 'OFFER_PRICE', 'OFFER_SHIPPING', 'OFFER_TOTAL', 'OBSERVED_AT'] as const;
export const PRICE_BASES = ['GROSS', 'NET'] as const;
export const SNAPSHOT_INCONSISTENCIES = ['OFFER_TOTAL_NOT_PRICE_PLUS_SHIPPING', 'MORE_OFFERS_THAN_TOP_N', 'BUYBOX_NOT_RANK_ONE_PRICE'] as const;
export const HALT_STAGES = ['INPUT', 'GATE', 'DISPATCH', 'DATABASE'] as const;
/** Причины системной остановки витрины — совпадают с CHECK channel_data.pricing_halt.reason_code (0042, 0080) */
export const HALT_REASONS = ['CHANNEL_MASS_SHIFT', 'CHANNEL_PRICE_BASIS_MISMATCH'] as const;
export type HaltReasonCode = (typeof HALT_REASONS)[number];
/** Р-116: налог добавлен к отправленной цене (канал считал её нетто) или вычтен (канал считал её брутто) */
export const BASIS_MISMATCH_DIRECTIONS = ['TAX_ADDED', 'TAX_REMOVED'] as const;
export const SHIFT_DIRECTIONS = ['UP', 'DOWN'] as const;
export const SCALE_ANCHORS = ['COST', 'CROSS_CHANNEL', 'HISTORY', 'LAST_ACCEPTED'] as const;
export const CHANNELS = ['KAUFLAND', 'AMAZON', 'EBAY', 'OTTO'] as const;
export const FX_CAUSES = ['FX_RATE_UNAVAILABLE', 'FX_RATE_STALE', 'UNSUPPORTED_CURRENCY', 'INVALID_INPUT'] as const;
export const RULE_CODES = ['FIXED', 'TARGET_MARGIN', 'MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION'] as const;
export const STRATEGY_TYPES = ['FIXED', 'TARGET_MARGIN', 'MATCH_BUYBOX', 'BEAT_LOWEST'] as const;
export const LOWEST_SCOPES = ['VISIBLE_TOP_N', 'MARKET'] as const;
export const UNMET_REQUIREMENTS = ['NO_SNAPSHOT', 'COMPLETENESS', 'BUYBOX_WINNER', 'OWN_RANK', 'SHIPPING', 'CONDITION', 'STALENESS', 'OWN_SHIPPING'] as const;
export const COMPLETENESS_KINDS = ['TOP_N', 'CHEAPEST_ONLY', 'FULL'] as const;
export const COST_INPUTS = ['COST_PROFILE', 'VAT_RATE'] as const;
export const CURRENCY_SOURCES = ['SNAPSHOT', 'COST'] as const;
export const STRATEGY_PARAM_NAMES = ['deadbandMinor', 'priceMinor', 'targetMarginBp', 'undercutMinor'] as const;
export const PARAM_CONSTRAINTS = ['POSITIVE', 'NON_NEGATIVE', 'MARGIN_BELOW_100_PERCENT'] as const;
export const BOUND_NAMES = ['min', 'max', 'margin_floor', 'both'] as const;
export const BOUND_CAUSES = [
  'MISSING', 'CURRENCY_MISMATCH', 'BASIS_MISMATCH', 'INVALID_AMOUNT', 'MIN_ABOVE_MAX', 'COST_PROFILE_MISSING', 'COST_CURRENCY_MISMATCH',
  'VAT_UNKNOWN', 'UNATTAINABLE', 'INVALID_INPUT', 'MARGIN_FLOOR_ABOVE_MAX_PRICE', 'FX_RATE_UNAVAILABLE', 'FX_RATE_STALE', 'UNSUPPORTED_CURRENCY',
  'FEE_ESTIMATE_MISSING',
] as const;

/** Причина «пол не вычисляется» из tenant_data.effective_price_floor (0051) → причина границы [Р-83] */
export function floorCauseFromDatabase(cause: string): (typeof BOUND_CAUSES)[number] {
  switch (cause) {
    case 'MIN_PRICE_MISSING': return 'MISSING';
    case 'MARGIN_FLOOR_UNATTAINABLE': return 'UNATTAINABLE';
    default: return (BOUND_CAUSES as readonly string[]).includes(cause) ? cause as (typeof BOUND_CAUSES)[number] : 'INVALID_INPUT';
  }
}
export const CHECK_SOURCES = ['GATE', 'DATABASE'] as const;
export const INTENT_PROBLEMS = ['WRITE_SCOPE_MISMATCH', 'CURRENCY_OR_BASIS_MISMATCH', 'NON_POSITIVE_AMOUNT'] as const;
export const SCOPE_STATUSES = ['ACTIVE', 'HELD', 'CONTESTED', 'BLOCKED', 'RETIRED'] as const;
export const PRICING_MODES = ['OFF', 'ENGINE', 'KAUFLAND_SMART_PRICING'] as const;
export const STOP_SCOPES = ['TENANT', 'CHANNEL_ACCOUNT', 'STOREFRONT'] as const;
export const STOP_STAGES = ['GATE', 'DISPATCH', 'DATABASE'] as const;
export const BOUND_CHECKS = ['CURRENT_WITHIN_BOUNDS', 'FINAL_RECHECK'] as const;
export const RECHECK_VIOLATIONS = ['FLOOR', 'CEILING', 'FLOOR_UNRESOLVABLE'] as const;
/** Коды ошибок канала (channel-port) и коды, которые назначает ядро */
export const WRITE_ERROR_CODES = [
  'RATE_LIMITED', 'CHANNEL_UNAVAILABLE', 'TIMEOUT', 'NETWORK', 'AUTH_INVALID', 'AUTH_EXPIRED', 'ACCOUNT_INACTIVE', 'FORBIDDEN', 'VALIDATION',
  'NOT_FOUND', 'DUPLICATE_ACTION', 'STALE_VERSION', 'ACTION_NOT_ALLOWED', 'PRECONDITION_FAILED', 'EDIT_BUDGET_EXHAUSTED', 'OFFER_NOT_LIVE',
  'POLICY_VIOLATION', 'TENANT_MISMATCH', 'SIGNATURE_INVALID', 'UNSUPPORTED', 'UNKNOWN', 'CHANNEL_REPRICER_ACTIVE', 'CHANNEL_BOUNDS_PRESENT',
  'MAX_ATTEMPTS', 'NOT_APPLIED', 'SCOPE_HELD', 'SCOPE_CONTESTED', 'SCOPE_BLOCKED', 'SCOPE_RETIRED',
  // Итог записи не узнать обратным чтением дольше предела: единица блокируется до разбора человеком (D1)
  'OUTCOME_UNRESOLVED',
] as const;
export const ERROR_CLASSES = ['TRANSIENT', 'PERMANENT', 'REQUIRES_HUMAN'] as const;
export const CONTEXT_CHANGES = ['MIN_PRICE', 'MAX_PRICE', 'CHANNEL_HALT', 'PRICING_STOP'] as const;
export const RECONCILE_RESULTS = ['APPLIED', 'NOT_APPLIED'] as const;
export const SELLER_ACTIONS = ['RECONNECT_ACCOUNT', 'CHECK_ACCOUNT_STATUS', 'CHECK_LISTING', 'REVIEW_CHANNEL_POLICY', 'CONTACT_CHANNEL_SUPPORT', 'REVIEW_OFFER_STATUS', 'DISABLE_CHANNEL_REPRICER', 'REMOVE_CHANNEL_BOUNDS'] as const;
export const MARGIN_COST_CAUSES = ['COST_PROFILE_MISSING', 'FEE_ESTIMATE_MISSING', 'VAT_RATE_MISSING', 'FX_RATE_UNAVAILABLE', 'FX_RATE_STALE', 'UNSUPPORTED_CURRENCY', 'INVALID_INPUT'] as const;
export const BUDGET_SOURCES = ['CHANNEL', 'DATABASE'] as const;
/** Кому нужна себестоимость [Р-77]: стратегии целевой маржи и ограничению минимальной маржи — перечисляются явно */
export const MARGIN_REQUIREMENTS = ['STRATEGY', 'MIN_MARGIN'] as const;

const shiftParams: ParamSchema = {
  direction: oneOf(SHIFT_DIRECTIONS, 'CHANNEL'), sameDirection: count('CHANNEL'), products: count('CHANNEL'),
  windowMinutes: p('minutes', 'CONFIG'), spread: ratio('CHANNEL'), maxSpread: ratio('CONFIG', O), medianFactor: ratio('CHANNEL'),
};
const probe = { field: oneOf(PROBE_FIELDS, 'TENANT') };
const snapshotField = { field: oneOf(SNAPSHOT_FIELDS, 'TENANT'), offerRank: count('CHANNEL', O) };

export const REASON_PARAMS: Readonly<Record<AnyReasonCode, ParamSchema>> = {
  INVALID_AMOUNT: { ...snapshotField, valueMinor: money('CHANNEL', ON), currency: currency(O) },
  CURRENCY_MISMATCH: { ...snapshotField, actual: p('currency', 'CHANNEL'), expected: p('currency', 'TENANT') },
  PRICE_BASIS_MISMATCH: { ...snapshotField, actual: oneOf(PRICE_BASES, 'CHANNEL'), expected: oneOf(PRICE_BASES, 'TENANT') },
  INCONSISTENT_SNAPSHOT: {
    inconsistency: oneOf(SNAPSHOT_INCONSISTENCIES, 'TENANT'), offerRank: count('CHANNEL', O), offers: count('CHANNEL', O), topN: count('CHANNEL', O),
    offerPriceMinor: money('CHANNEL', O), shippingMinor: money('CHANNEL', O), totalMinor: money('CHANNEL', O),
    buyboxMinor: money('CHANNEL', O), rankOneMinor: money('CHANNEL', O), currency: currency(O),
  },
  SNAPSHOT_FROM_FUTURE: { skewSeconds: seconds('CHANNEL'), maxSkewSeconds: seconds('CONFIG') },
  SNAPSHOT_TOO_OLD: { ageSeconds: seconds('CHANNEL'), maxAgeSeconds: seconds('CONFIG') },
  OUT_OF_ORDER: { lastAcceptedAt: instant('CHANNEL'), observedAt: instant('CHANNEL') },
  CHANNEL_HALTED: {
    stage: oneOf(HALT_STAGES, 'TENANT'), haltId: id('TENANT', O), haltedAt: instant('TENANT', O), haltReason: oneOf(HALT_REASONS, 'TENANT', O),
    marketplace: id('TENANT', ON), ruleCode: oneOf(RULE_CODES, 'TENANT', O),
  },
  CHANNEL_MASS_SHIFT: shiftParams,
  UNIT_SCALE_X100: { ...probe, valueMinor: money('CHANNEL'), referenceMinor: money('CHANNEL'), anchor: oneOf(SCALE_ANCHORS, 'TENANT'), currency: currency() },
  UNIT_SCALE_X0_01: { ...probe, valueMinor: money('CHANNEL'), referenceMinor: money('CHANNEL'), anchor: oneOf(SCALE_ANCHORS, 'TENANT'), currency: currency() },
  PRICE_BELOW_COST_ANCHOR: { ...probe, valueMinor: money('CHANNEL'), costMinor: money('TENANT'), limit: ratio('CONFIG'), currency: currency() },
  PRICE_ABOVE_COST_ANCHOR: { ...probe, valueMinor: money('CHANNEL'), costMinor: money('TENANT'), limit: ratio('CONFIG'), currency: currency() },
  SNAPSHOT_INTERNAL_OUTLIER: { valueMinor: money('CHANNEL'), medianMinor: money('CHANNEL'), offers: count('CHANNEL'), outlierFactor: ratio('CONFIG'), currency: currency() },
  CROSS_CHANNEL_MISMATCH: {
    ...probe, valueMinor: money('CHANNEL'), referenceMinor: money('CHANNEL'), ratio: ratio('CHANNEL'), limit: ratio('CONFIG'), references: count('CHANNEL'),
    referenceStorefronts: p('storefrontList', 'TENANT'), fxRateDate: p('date', 'PUBLIC', O), fxRateMicros: p('rateMicros', 'PUBLIC', O),
    fxFrom: currency(O), currency: currency(),
  },
  OUTSIDE_HISTORY_BAND: {
    ...probe, valueMinor: money('CHANNEL'), bandLowMinor: money('CHANNEL'), bandHighMinor: money('CHANNEL'), days: count('CHANNEL'),
    bandFactor: ratio('CONFIG'), currency: currency(),
  },
  NO_PLAUSIBILITY_ANCHOR: { competitorOffers: count('CHANNEL'), historyDays: count('CHANNEL'), minOffers: count('CONFIG'), minHistoryDays: count('CONFIG'), costDeclared: p('bool', 'TENANT') },
  OWN_PRICE_DEVIATION: { ...probe, valueMinor: money('CHANNEL'), ourPriceMinor: money('TENANT'), ratio: ratio('CHANNEL'), limit: ratio('CONFIG'), currency: currency() },
  SELF_OFFER_DIVERGENCE: { valueMinor: money('CHANNEL'), ourPriceMinor: money('TENANT'), limit: ratio('CONFIG'), currency: currency() },
  INTERNAL_OUTLIER_IGNORED: { valueMinor: money('CHANNEL'), medianMinor: money('CHANNEL'), currency: currency() },
  MARKET_SHIFT_DISPERSED: shiftParams,
  // Имени продавца в данных канала нет: только внутренний идентификатор предложения
  MARKET_SHIFT_SINGLE_SELLER: { ...shiftParams, seller: id('CHANNEL') },
  CROSS_CHANNEL_FX_UNAVAILABLE: { channel: oneOf(CHANNELS, 'TENANT'), marketplace: id('TENANT'), currency: p('currency', 'TENANT'), expected: p('currency', 'TENANT'), cause: oneOf(FX_CAUSES, 'PUBLIC') },

  FIXED_PRICE: { targetMinor: money('TENANT'), currency: currency() },
  MARGIN_TARGET: { marginBp: bp('TENANT'), targetMinor: money('TENANT'), currency: currency() },
  BUYBOX_MATCH: { buyboxMinor: money('CHANNEL'), targetMinor: money('CHANNEL_DERIVED'), currency: currency() },
  BUYBOX_UNDERCUT: { buyboxMinor: money('CHANNEL'), undercutMinor: money('CHANNEL_DERIVED'), targetMinor: money('CHANNEL_DERIVED'), currency: currency() },
  LOWEST_MATCH: { lowestMinor: money('CHANNEL'), scope: oneOf(LOWEST_SCOPES, 'TENANT'), n: count('CHANNEL', N), targetMinor: money('CHANNEL_DERIVED'), currency: currency() },
  LOWEST_UNDERCUT: { lowestMinor: money('CHANNEL'), undercutMinor: money('CHANNEL_DERIVED'), scope: oneOf(LOWEST_SCOPES, 'TENANT'), n: count('CHANNEL', N), targetMinor: money('CHANNEL_DERIVED'), currency: currency() },
  CAPPED_AT_MIN_PRICE: { targetMinor: money('CHANNEL_DERIVED'), minMinor: money('TENANT'), currency: currency() },
  CAPPED_AT_MAX_PRICE: { targetMinor: money('CHANNEL_DERIVED'), maxMinor: money('TENANT'), currency: currency() },
  ALREADY_AT_TARGET: { targetMinor: money('CHANNEL_DERIVED'), currency: currency() },
  WITHIN_DEADBAND: { deltaMinor: money('CHANNEL_DERIVED'), deadbandMinor: money('TENANT'), currency: currency() },
  ALREADY_WINNING_BUYBOX: {},
  NO_COMPETITOR_OFFERS: {},
  TARGET_OUTSIDE_BOUNDS_HOLD: { targetMinor: money('CHANNEL_DERIVED'), minMinor: money('TENANT'), maxMinor: money('TENANT'), currency: currency() },
  COMPETITOR_REQUIREMENT_NOT_MET: {
    unmet: listOf(UNMET_REQUIREMENTS, 'CHANNEL'), requiredCompleteness: oneOf(COMPLETENESS_KINDS, 'CONFIG', ON), requiredN: count('CONFIG', ON),
    actualCompleteness: oneOf(COMPLETENESS_KINDS, 'CHANNEL', ON), actualN: count('CHANNEL', ON), maxStalenessSeconds: seconds('CONFIG', ON), ageSeconds: seconds('CHANNEL', ON),
  },
  COST_INPUTS_MISSING: { missing: oneOf(COST_INPUTS, 'TENANT') },
  MARGIN_UNATTAINABLE: {
    marginBp: bp('TENANT'), feeRateBp: bp('TENANT'), fixedFeeMinor: money('TENANT'), unitCostMinor: money('TENANT'), vatRateBp: bp('TENANT', N), currency: currency(),
  },
  BOUNDS_INVALID: { minMinor: money('TENANT', N), maxMinor: money('TENANT', N), currency: currency() },
  ENGINE_CURRENCY_MISMATCH: { source: oneOf(CURRENCY_SOURCES, 'TENANT'), actual: p('currency', 'CHANNEL'), expected: p('currency', 'TENANT') },
  INVALID_STRATEGY_PARAMS: {
    param: oneOf(STRATEGY_PARAM_NAMES, 'TENANT'), settingMinor: money('TENANT', ON), settingBp: bp('TENANT', ON), allowed: oneOf(PARAM_CONSTRAINTS, 'CONFIG'), currency: currency(O),
  },

  APPROVED: { finalMinor: money('TENANT'), floorMinor: money('TENANT'), ceilingMinor: money('TENANT'), currency: currency() },
  NO_CHANGE: {},
  BELOW_MIN_PRICE: { proposedMinor: money('TENANT', N), minMinor: money('TENANT', N), deviationBp: bp('TENANT', O), source: oneOf(CHECK_SOURCES, 'TENANT', O), currency: currency() },
  BELOW_MARGIN_FLOOR: {
    proposedMinor: money('TENANT'), floorMinor: money('TENANT'), minMinor: money('TENANT', O), minMarginBp: bp('TENANT', O), deviationBp: bp('TENANT', O), currency: currency(),
  },
  ABOVE_MAX_PRICE: { proposedMinor: money('TENANT', N), maxMinor: money('TENANT', N), deviationBp: bp('TENANT', O), source: oneOf(CHECK_SOURCES, 'TENANT', O), currency: currency() },
  BOUND_UNRESOLVABLE: {
    bound: oneOf(BOUND_NAMES, 'TENANT'), cause: oneOf(BOUND_CAUSES, 'TENANT'), boundCurrency: currency(O), boundBasis: oneOf(PRICE_BASES, 'TENANT', O),
    scopeCurrency: currency(O), scopeBasis: oneOf(PRICE_BASES, 'TENANT', O), minMarginBp: bp('TENANT', O),
  },
  STEP_LIMIT: { stepBp: bp('TENANT'), limitBp: bp('TENANT'), currentMinor: money('TENANT'), proposedMinor: money('TENANT'), currency: currency() },
  CHANGE_RATE_LIMIT: { changes: count('TENANT'), limit: count('TENANT') },
  INTENT_EXPIRED: { createdAt: instant('TENANT'), expiresAt: instant('TENANT'), decidedAt: instant('TENANT'), waitedSeconds: seconds('TENANT') },
  INTENT_INVALID: { problem: oneOf(INTENT_PROBLEMS, 'TENANT') },
  SCOPE_NOT_ACTIVE: {
    status: oneOf(SCOPE_STATUSES, 'TENANT'), mode: oneOf(PRICING_MODES, 'TENANT'), blockedByErrorCode: oneOf(WRITE_ERROR_CODES, 'TENANT', ON), blockedSince: instant('TENANT', ON),
    action: oneOf(SELLER_ACTIONS, 'TENANT', ON),
  },
  PRICING_STOPPED: {
    // Отказ БД при фиксации знает только идентификатор остановки
    stopId: id('TENANT'), scope: oneOf(STOP_SCOPES, 'TENANT', O), stoppedAt: instant('TENANT', O), stoppedBy: id('TENANT', O),
    channelAccountId: id('TENANT', ON), marketplace: id('TENANT', ON), stage: oneOf(STOP_STAGES, 'TENANT'),
  },
  INTERNAL_BOUND_VIOLATION: { check: oneOf(BOUND_CHECKS, 'TENANT'), amountMinor: money('TENANT', N), floorMinor: money('TENANT'), ceilingMinor: money('TENANT'), currency: currency() },

  MIN_PRICE_MISSING: {},
  MAX_PRICE_MISSING: {},
  BOUNDS_INVERTED: { minMinor: money('TENANT'), maxMinor: money('TENANT'), currency: currency() },
  BOUND_CURRENCY_MISMATCH: {
    bound: oneOf(BOUND_NAMES, 'TENANT'), cause: oneOf(BOUND_CAUSES, 'TENANT', O), boundCurrency: currency(ON), boundBasis: oneOf(PRICE_BASES, 'TENANT', ON),
    scopeCurrency: currency(), scopeBasis: oneOf(PRICE_BASES, 'TENANT'),
  },
  SCOPE_NOT_ENGINE: { mode: oneOf(PRICING_MODES, 'TENANT', N) },
  NO_SCOPE_FOR_PRODUCT: { writeScopeId: id('TENANT', O) },
  // Р-83: пол при отправке — min_price и пол маржи, вычисленные заново; не вычисляется — запись не уходит (FLOOR_UNRESOLVABLE)
  WRITE_BLOCKED_BY_BOUND_RECHECK: {
    amountMinor: money('TENANT'), floorMinor: money('TENANT', N), ceilingMinor: money('TENANT', N), violated: oneOf(RECHECK_VIOLATIONS, 'TENANT'), currency: currency(),
    minMinor: money('TENANT', O), marginFloorMinor: money('TENANT', O), minMarginBp: bp('TENANT', O), cause: oneOf(BOUND_CAUSES, 'TENANT', O),
  },
  // Текст ответа канала не хранится: для Amazon это Amazon Information [Р-17]; остаются код, класс и идентификатор ошибки канала
  WRITE_NOT_ACCEPTED_BY_CHANNEL: {
    status: oneOf(WRITE_ERROR_CODES, 'TENANT'), errorClass: oneOf(ERROR_CLASSES, 'TENANT', O), httpStatus: count('CHANNEL', O), channelCode: id('CHANNEL', O),
  },
  BOUNDS_VERSION_CHANGED: {
    attempt: count('TENANT'), changed: listOf(CONTEXT_CHANGES, 'TENANT', O), oldMinMinor: money('TENANT', ON), newMinMinor: money('TENANT', ON),
    oldMaxMinor: money('TENANT', ON), newMaxMinor: money('TENANT', ON), currency: currency(O),
  },
  DIVERGENCE_CASE_OPENED: { observedMinor: money('CHANNEL'), expectedMinor: money('TENANT'), currency: currency() },
  HALT_AUTO_RELEASED: { sampleSize: count('TENANT'), haltId: id('TENANT', O) },
  HALT_REVIEW_FAILED: { sampleSize: count('TENANT'), failed: count('TENANT'), haltId: id('TENANT', O), nextReviewAt: instant('TENANT', O) },
  HALT_MANUALLY_RELEASED: { haltId: id('TENANT', O), membershipId: id('TENANT', O), note: p('userText', 'TENANT', O) },
  // Р-77: тип стратегии известен всегда; кому нужна себестоимость — явно, а не выводом из наличия минимальной маржи
  MARGIN_WITHOUT_COST: {
    strategyType: oneOf(STRATEGY_TYPES, 'TENANT'), requiredBy: listOf(MARGIN_REQUIREMENTS, 'TENANT'), minMarginBp: bp('TENANT', N), cause: oneOf(MARGIN_COST_CAUSES, 'TENANT'),
  },
  STRATEGY_MISSING: {},

  WRITE_SUPERSEDED_BY_NEWER_VERSION: { newerVersion: count('TENANT'), newerWriteId: id('TENANT', O) },
  WRITE_RETRIES_EXHAUSTED: { attempts: count('TENANT'), code: oneOf(WRITE_ERROR_CODES, 'TENANT') },
  WRITE_PRICING_MODE_CHANGED: { mode: oneOf(PRICING_MODES, 'TENANT') },
  WRITE_EDIT_BUDGET_EXHAUSTED: {
    limit: count('CONFIG', O), used: count('TENANT', O), budgetDay: p('date', 'TENANT', O), timeZone: id('TENANT', ON), resetsAt: instant('TENANT', ON),
    source: oneOf(BUDGET_SOURCES, 'TENANT', O),
  },
  WRITE_QUEUED_BEHIND_IN_FLIGHT: { inFlightWriteId: id('TENANT', O) },
  WRITE_RETRY_SCHEDULED: { code: oneOf(WRITE_ERROR_CODES, 'TENANT'), attempt: count('TENANT'), at: instant('TENANT') },
  WRITE_OUTCOME_RECONCILED: { result: oneOf(RECONCILE_RESULTS, 'TENANT') },
  WRITE_SCOPE_BLOCKED: { code: oneOf(WRITE_ERROR_CODES, 'TENANT'), action: oneOf(SELLER_ACTIONS, 'TENANT') },
  // Находка 7 шага 15 [Р-65]: повтор записи с бюджетом правок, когда граница суток витрины перестала быть подтверждённой
  WRITE_BUDGET_DAY_UNCONFIRMED: { marketplace: id('TENANT') },
  // Р-116: отправленная цена — наша, применённая — прочитана из канала
  CHANNEL_PRICE_BASIS_MISMATCH: {
    basisError: oneOf(BASIS_MISMATCH_DIRECTIONS, 'TENANT'), vatRateBp: bp('TENANT'), sentMinor: money('TENANT'), observedMinor: money('CHANNEL'),
    currency: currency(), writeScopeId: id('TENANT'), marketplace: id('TENANT'),
  },
};

export const SANITY_NOTE_PARAMS: Readonly<Record<SanityNoteCode, ParamSchema>> = {
  COST_NOT_DECLARED: {},
  TOO_FEW_COMPETITOR_OFFERS: { offers: count('CHANNEL'), minOffers: count('CONFIG') },
  HISTORY_TOO_SHORT: { days: count('CHANNEL'), minHistoryDays: count('CONFIG') },
  HISTORY_AVAILABLE: { days: count('CHANNEL') },
  NO_SCALE_REFERENCE: {},
  SINGLE_SELLER_MARKET_EVENT: { seller: id('CHANNEL') },
  DISPERSED_MARKET_EVENT: { spread: ratio('CHANNEL'), maxSpread: ratio('CONFIG') },
  SHIFT_BELOW_SHARE: { sameDirection: count('CHANNEL'), products: count('CHANNEL'), minProducts: count('CONFIG'), share: ratio('CONFIG') },
  SMALL_MOVE: { minFactor: ratio('CONFIG') },
  NO_PREVIOUS_SNAPSHOT: {},
  REFERENCES_CONVERTED_AT_ECB: { fxFrom: currency(), currency: currency(), fxRateDate: p('date', 'PUBLIC'), fxRateMicros: p('rateMicros', 'PUBLIC') },
  REFERENCES_WITHOUT_ECB_RATE: {},
  NO_FRESH_CROSS_CHANNEL_REFERENCE: { maxAgeSeconds: seconds('CONFIG') },
};

type Value = string | number | boolean | null;

export function paramSchema(code: string): ParamSchema | null {
  return (REASON_PARAMS as Record<string, ParamSchema | undefined>)[code] ?? (SANITY_NOTE_PARAMS as Record<string, ParamSchema | undefined>)[code] ?? null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function valueProblem(spec: ParamSpec, v: Value): string | null {
  switch (spec.kind) {
    case 'money': case 'count': case 'seconds': case 'minutes': case 'rateMicros':
      return Number.isSafeInteger(v) ? null : 'integer expected';
    case 'bp':
      return typeof v === 'number' && Number.isInteger(v) ? null : 'integer basis points expected';
    case 'ratio':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'number expected';
    case 'currency':
      return typeof v === 'string' && /^[A-Z]{3}$/.test(v) ? null : 'ISO 4217 code expected';
    case 'instant':
      return typeof v === 'string' && ISO_INSTANT.test(v) && !Number.isNaN(Date.parse(v)) ? null : 'ISO instant expected';
    case 'date':
      return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? null : 'YYYY-MM-DD expected';
    case 'enum':
      return typeof v === 'string' && (spec.values ?? []).includes(v) ? null : `one of ${(spec.values ?? []).join('|')} expected`;
    case 'enumList':
      return typeof v === 'string' && v.split(',').every((x) => (spec.values ?? []).includes(x)) ? null : 'comma-separated codes expected';
    case 'storefrontList':
      return typeof v === 'string' && v.split(',').every((x) => /^[A-Z]+:[A-Za-z0-9_]+$/.test(x)) ? null : 'CHANNEL:marketplace list expected';
    case 'bool':
      return typeof v === 'boolean' ? null : 'boolean expected';
    case 'id':
      return typeof v === 'string' && v.length > 0 && v.length <= 200 ? null : 'identifier expected';
    case 'userText':
      return typeof v === 'string' && v.length <= 2000 ? null : 'text up to 2000 characters expected';
  }
}

/**
 * Проверка причины против реестра: известный код, только объявленные параметры, обязательные есть, значения своего вида,
 * у каждой суммы — валюта [Р-71]. Пустой список — причина корректна.
 */
export function validateReason(reason: { code: string; params: Readonly<Record<string, Value>> }): string[] {
  const schema = paramSchema(reason.code);
  if (!schema) return [`${reason.code}: unknown code`];
  const problems: string[] = [];
  const params = reason.params ?? {};
  for (const [key, v] of Object.entries(params)) {
    const spec = schema[key];
    if (!spec) { problems.push(`${reason.code}.${key}: undeclared parameter`); continue; }
    if (v === null) { if (!spec.nullable) problems.push(`${reason.code}.${key}: null is not allowed`); continue; }
    const problem = valueProblem(spec, v);
    if (problem) problems.push(`${reason.code}.${key}: ${problem}`);
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (!spec.optional && !(key in params)) problems.push(`${reason.code}.${key}: missing`);
  }
  const hasAmount = Object.entries(params).some(([k, v]) => schema[k]?.kind === 'money' && v !== null);
  if (hasAmount && (typeof params.currency !== 'string' || !/^[A-Z]{3}$/.test(params.currency))) problems.push(`${reason.code}: amount without currency (Р-71)`);
  return problems;
}

/** Ключи параметров класса CHANNEL — не допускаются в слепке объяснения; список дублирован в БД (0042) */
export const CHANNEL_PARAM_KEYS: readonly string[] = [...new Set(
  [...Object.values(REASON_PARAMS), ...Object.values(SANITY_NOTE_PARAMS)].flatMap((s) => Object.entries(s).filter(([, v]) => v.class === 'CHANNEL').map(([k]) => k)),
)].sort();

/** Ключи класса CHANNEL_DERIVED по кодам — совпадают с security.channel_derived_param_keys() (0052, тест БД) [Р-85] */
export const CHANNEL_DERIVED_PARAM_KEYS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  [...Object.entries(REASON_PARAMS), ...Object.entries(SANITY_NOTE_PARAMS)]
    .map(([code, schema]) => [code, Object.entries(schema).filter(([, v]) => v.class === 'CHANNEL_DERIVED').map(([k]) => k).sort()] as const)
    .filter(([, keys]) => keys.length > 0)
    .sort(([a], [b]) => a.localeCompare(b)),
);

/**
 * Параметры, производные от цены конкурента, когда цена решения из данных конкурентов (правила MATCH_BUYBOX, BEAT_LOWEST,
 * POSITION): предложенная цена, отклонение от границы, шаг, сумма проверки. Опубликованная цена (итог CHANGED) — наша [Р-3],
 * она хранится столбцом; из вечного слепка эти ключи убираются при любом коде причины [Р-85].
 */
export const COMPETITOR_RULE_DERIVED_KEYS: readonly string[] = ['amountMinor', 'deviationBp', 'proposedMinor', 'stepBp'];

/** Что сделать продавцу при ошибке, требующей человека (WRITE_SCOPE_BLOCKED, SCOPE_NOT_ACTIVE) */
export function sellerActionFor(errorCode: string): (typeof SELLER_ACTIONS)[number] {
  switch (errorCode) {
    case 'AUTH_INVALID': case 'AUTH_EXPIRED': case 'SIGNATURE_INVALID': return 'RECONNECT_ACCOUNT';
    case 'ACCOUNT_INACTIVE': case 'TENANT_MISMATCH': return 'CHECK_ACCOUNT_STATUS';
    case 'OFFER_NOT_LIVE': case 'NOT_FOUND': case 'PRECONDITION_FAILED': return 'CHECK_LISTING';
    case 'POLICY_VIOLATION': case 'FORBIDDEN': return 'REVIEW_CHANNEL_POLICY';
    case 'SCOPE_HELD': case 'SCOPE_CONTESTED': case 'SCOPE_BLOCKED': case 'SCOPE_RETIRED': return 'REVIEW_OFFER_STATUS';
    // Р-115, Р-114: правило автоматического ценообразования или границы цены заданы в кабинете канала — снять их может только продавец
    case 'CHANNEL_REPRICER_ACTIVE': return 'DISABLE_CHANNEL_REPRICER';
    case 'CHANNEL_BOUNDS_PRESENT': return 'REMOVE_CHANNEL_BOUNDS';
    default: return 'CONTACT_CHANNEL_SUPPORT';
  }
}
