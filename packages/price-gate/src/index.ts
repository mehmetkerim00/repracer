import type { Instant, PriceBasis } from '@repracer/channel-port';
import {
  type GateProfile,
  boundDeviationBp,
  sellerActionFor,
  storefrontPriceForMarginBp,
  isCompetitorDerived,
  type DistrustRef,
  type HaltRef,
  type StopRef,
  type StrategyDefinition,
  type CostInputs,
  type DecisionClass,
  type GateCheck,
  type GateOutcome,
  type GateRejectionReason,
  type PipelineReasonCode,
  type PriceBounds,
  type PriceDecisionDraft,
  type PriceIntentDraft,
  type Reason,
} from '@repracer/pricing-model';

/**
 * Price Gate [INV-02, Р-43, Р-44]. Не доверяет движку: границы приходят заново из источника истины.
 *
 * Проверки границ (исправлено на шаге 15 после ретроспективного ревью, A4/B4):
 *   1. предложенная цена против [пол, потолок] (проверки LOWER_BOUND, UPPER_BOUND) — в Gate;
 *   2. FINAL_RECHECK — то же число против тех же границ: корректировок после проверки 1 нет, поэтому ошибку Gate она не ловит;
 *      оставлена как проверка профиля g74.1 (справочник неизменяем) и защита на случай будущих корректировок;
 *   3. настоящая перепроверка — в БД при создании записи и перед КАЖДОЙ отправкой: min_price и пол маржи, вычисленные заново
 *      по текущим себестоимости, комиссии, курсу и ставке (tenant_data.effective_price_floor, 0051) [Р-83].
 *      assertWriteWithinBounds ниже — только хранилище в памяти стенда.
 * Границу нельзя вычислить — решение REJECTED с BOUND_UNRESOLVABLE и CRITICAL-алертом; запись не создаётся.
 * Выход за абсолютную границу не округляется до границы: решение отклоняется и хранится как REJECTED_BY_GATE.
 */

export interface GuardrailSet {
  guardrailIds: string[];
  minMarginBp: number | null;
  maxStepChangeBp: number | null;
  maxChangesPerHour: number | null;
  onViolation: 'REJECT' | 'HOLD';
}

export const NO_GUARDRAILS: GuardrailSet = { guardrailIds: [], minMarginBp: null, maxStepChangeBp: null, maxChangesPerHour: null, onViolation: 'HOLD' };

export interface GateInput {
  intent: PriceIntentDraft;
  scope: {
    writeScopeId: string;
    currency: string;
    basis: PriceBasis;
    pricingMode: 'OFF' | 'ENGINE' | 'KAUFLAND_SMART_PRICING';
    status: 'ACTIVE' | 'HELD' | 'CONTESTED' | 'BLOCKED' | 'RETIRED';
    /** Системная остановка витрины: только цены из данных конкурентов [Р-51] */
    channelHalt: HaltRef | null;
    /** Остановка по недоверию каналу: все цены, снимает только человек [Р-118] */
    channelDistrust?: DistrustRef | null;
    /** Остановка человеком на тенант, аккаунт или витрину: все цены [Р-69, Р-70] */
    priceStop: StopRef | null;
    /** Почему единица не активна: ошибка канала, требующая человека, и с какого момента */
    blocking?: { errorCode: string; since: string } | null;
  };
  /** Прочитаны заново в момент решения */
  bounds: PriceBounds;
  guardrails: GuardrailSet;
  cost: CostInputs | null;
  /** Себестоимость не переведена в валюту цены — причина отказа пола маржи вместо «нет профиля» [Р-61] */
  costUnavailableCause?: string | null;
  changesInLastHour: number;
  now: Instant;
}

const CLASS_BY_OUTCOME: Readonly<Record<GateOutcome, DecisionClass>> = {
  APPROVED: 'CHANGED',
  REJECTED: 'REJECTED_BY_GATE',
  HELD: 'REJECTED_BY_GATE',
  NO_CHANGE: 'NO_OP',
};

interface ResolvedBounds {
  minMinor: number;
  maxMinor: number;
  minIds: string[];
  maxIds: string[];
}

type Unresolved = { ok: false; bound: 'min' | 'max' | 'both'; cause: string; params: Reason['params'] };

/** Абсолютные границы разрешимы и согласованы: иначе причина с валютой и базой границы и единицы записи */
export function resolveAbsoluteBounds(bounds: PriceBounds, currency: string, basis: PriceBasis): { ok: true; value: ResolvedBounds } | Unresolved {
  const scopeSide = { scopeCurrency: currency, scopeBasis: basis };
  const unresolved = (bound: 'min' | 'max' | 'both', cause: string, extra: Reason['params'] = {}): Unresolved =>
    ({ ok: false, bound, cause, params: { bound, cause, ...extra, ...scopeSide } });
  if (bounds.currency !== currency || bounds.basis !== basis) return unresolved('both', bounds.currency !== currency ? 'CURRENCY_MISMATCH' : 'BASIS_MISMATCH', { boundCurrency: bounds.currency, boundBasis: bounds.basis });
  for (const bound of ['min', 'max'] as const) {
    const b = bounds[bound];
    if (b.status !== 'RESOLVED') {
      return unresolved(bound, b.cause, { ...(b.actualCurrency ? { boundCurrency: b.actualCurrency } : {}), ...(b.actualBasis ? { boundBasis: b.actualBasis } : {}) });
    }
  }
  if (bounds.min.status !== 'RESOLVED' || bounds.max.status !== 'RESOLVED') return unresolved('both', 'MISSING');
  const { amountMinor: min } = bounds.min;
  const { amountMinor: max } = bounds.max;
  if (!Number.isSafeInteger(min) || min <= 0) return unresolved('min', 'INVALID_AMOUNT');
  if (!Number.isSafeInteger(max) || max <= 0) return unresolved('max', 'INVALID_AMOUNT');
  if (min > max) return unresolved('max', 'MIN_ABOVE_MAX');
  return { ok: true, value: { minMinor: min, maxMinor: max, minIds: bounds.min.sourceIds, maxIds: bounds.max.sourceIds } };
}

export function decide(input: GateInput): PriceDecisionDraft {
  const { intent, scope, bounds, guardrails, now } = input;
  const checks: GateCheck[] = [];
  let floor: number | null = null;
  let ceiling: number | null = null;
  let minIds: string[] = [];
  let maxIds: string[] = [];
  let deviationBp: number | null = null;
  const currency = scope.currency;

  const finish = (
    outcome: GateOutcome,
    reason: Reason,
    finalMinor: number | null,
    rejectionReason: GateRejectionReason | null,
    alert: PriceDecisionDraft['alert'] = null,
  ): PriceDecisionDraft => ({
    writeScopeId: scope.writeScopeId,
    outcome,
    decisionClass: CLASS_BY_OUTCOME[outcome],
    finalMinor,
    currency: scope.currency,
    basis: scope.basis,
    effectiveFloorMinor: floor,
    effectiveCeilingMinor: ceiling,
    minPriceIds: minIds,
    maxPriceIds: maxIds,
    guardrailIds: guardrails.guardrailIds,
    rejectionReason,
    reason,
    checks,
    alert,
    decidedAt: now,
    // Р-61: курс, по которому себестоимость переведена в валюту цены, — вместе с решением
    fx: input.cost?.fx ?? null,
    boundDeviationBp: deviationBp,
  });
  const fail = (check: string, code: GateRejectionReason, params: Reason['params'], outcome: 'REJECTED' | 'HELD' = 'REJECTED', alert: PriceDecisionDraft['alert'] = null) => {
    const reason: Reason = { code, params };
    checks.push({ check, passed: false, detail: reason });
    return finish(outcome, reason, null, code, alert);
  };
  const ok = (check: string) => checks.push({ check, passed: true, detail: null });

  // Границы, по которым принимается решение, сохраняются в любом решении, даже отклонённом раньше проверки границ
  // (price_decision_bounds_present): отказ по остановке или истёкшему intent тоже доказывает, в каких границах он принят.
  const absolute = resolveAbsoluteBounds(bounds, scope.currency, scope.basis);
  if (absolute.ok) {
    floor = absolute.value.minMinor;
    ceiling = absolute.value.maxMinor;
    minIds = absolute.value.minIds;
    maxIds = absolute.value.maxIds;
  }

  // 0. Остановка человеком — все изменения цен без исключений [Р-69, Р-70]
  if (scope.priceStop) {
    const st = scope.priceStop;
    return fail('PRICE_STOP', 'PRICING_STOPPED', {
      stopId: st.stopId, scope: st.scope, stoppedAt: st.stoppedAt, stoppedBy: st.stoppedByMembershipId,
      channelAccountId: st.channelAccountId, marketplace: st.marketplace, stage: 'GATE',
    }, 'HELD');
  }
  ok('PRICE_STOP');

  // 1. Единица записи в режиме ENGINE и активна
  const inactive = () => ({
    status: scope.status, mode: scope.pricingMode,
    blockedByErrorCode: scope.blocking?.errorCode ?? null, blockedSince: scope.blocking?.since ?? null,
    action: scope.blocking ? sellerActionFor(scope.blocking.errorCode) : scope.status === 'ACTIVE' ? null : sellerActionFor(`SCOPE_${scope.status}`),
  });
  if (scope.pricingMode !== 'ENGINE') return fail('SCOPE', 'SCOPE_NOT_ACTIVE', inactive(), 'REJECTED');
  if (scope.status !== 'ACTIVE') return fail('SCOPE', 'SCOPE_NOT_ACTIVE', inactive(), 'HELD');
  ok('SCOPE');

  // 2. Недоверие каналу [Р-118]: сломана трансляция цены в канал — любая цена, фиксированная и маржинальная тоже, пройдёт тем же путём
  if (scope.channelDistrust) {
    const d = scope.channelDistrust;
    return fail('CHANNEL_DISTRUST', 'CHANNEL_DISTRUSTED', { stage: 'GATE', distrustId: d.distrustId, detectedAt: d.detectedAt, distrustReason: d.reasonCode, marketplace: d.marketplace });
  }
  ok('CHANNEL_DISTRUST');

  // 3. Системная остановка канала блокирует только цены, выведенные из данных конкурентов [Р-42, Р-51]
  if (scope.channelHalt && isCompetitorDerived(intent.ruleCode)) {
    const h = scope.channelHalt;
    return fail('CHANNEL_HALT', 'CHANNEL_HALTED', { stage: 'GATE', haltId: h.haltId, haltedAt: h.haltedAt, haltReason: h.reasonCode, marketplace: h.marketplace, ruleCode: intent.ruleCode });
  }
  ok('CHANNEL_HALT');

  // 3. Корректность intent
  if (intent.writeScopeId !== scope.writeScopeId) return fail('INTENT', 'INTENT_INVALID', { problem: 'WRITE_SCOPE_MISMATCH' });
  if (intent.currency !== scope.currency || intent.basis !== scope.basis) return fail('INTENT', 'INTENT_INVALID', { problem: 'CURRENCY_OR_BASIS_MISMATCH' });
  if (!Number.isSafeInteger(intent.proposedMinor) || intent.proposedMinor <= 0) return fail('INTENT', 'INTENT_INVALID', { problem: 'NON_POSITIVE_AMOUNT' });
  if (Date.parse(now) >= Date.parse(intent.expiresAt)) {
    return fail('INTENT', 'INTENT_EXPIRED', {
      createdAt: intent.createdAt, expiresAt: intent.expiresAt, decidedAt: now, waitedSeconds: Math.round((Date.parse(now) - Date.parse(intent.createdAt)) / 1000),
    });
  }
  ok('INTENT');

  // 4. Абсолютные границы разрешимы [Р-43]
  if (!absolute.ok) {
    return fail('BOUNDS_RESOLVED', 'BOUND_UNRESOLVABLE', absolute.params, 'REJECTED', { code: 'PRICING_BOUND_UNRESOLVABLE', severity: 'CRITICAL' });
  }
  floor = absolute.value.minMinor;
  ceiling = absolute.value.maxMinor;
  minIds = absolute.value.minIds;
  maxIds = absolute.value.maxIds;
  ok('BOUNDS_RESOLVED');

  // 5. Пол маржи: задан ограничением — обязан вычисляться
  let marginFloor: number | null = null;
  if (guardrails.minMarginBp !== null) {
    const cost = input.cost;
    const cause = !cost ? (input.costUnavailableCause ?? 'COST_PROFILE_MISSING') : cost.currency !== scope.currency ? 'COST_CURRENCY_MISMATCH' : null;
    const marginFail = (c: string) => fail('MARGIN_FLOOR', 'BOUND_UNRESOLVABLE', { bound: 'margin_floor', cause: c, minMarginBp: guardrails.minMarginBp }, 'REJECTED',
      { code: 'PRICING_BOUND_UNRESOLVABLE', severity: 'CRITICAL' });
    if (cause) return marginFail(cause);
    const priced = storefrontPriceForMarginBp(cost!, guardrails.minMarginBp);
    if (!priced.ok) return marginFail(priced.cause);
    if (priced.priceMinor > ceiling) return marginFail('MARGIN_FLOOR_ABOVE_MAX_PRICE');
    marginFloor = priced.priceMinor;
    floor = Math.max(floor, marginFloor);
  }
  ok('MARGIN_FLOOR');

  // 6. NO_OP: решение без отправки
  if (intent.intentClass === 'NO_OP') {
    const current = intent.currentMinor;
    const inside = current === null || (current >= floor && current <= ceiling);
    checks.push({
      check: 'CURRENT_WITHIN_BOUNDS', passed: inside,
      detail: inside ? null : { code: 'INTERNAL_BOUND_VIOLATION', params: { check: 'CURRENT_WITHIN_BOUNDS', amountMinor: current, floorMinor: floor, ceilingMinor: ceiling, currency } },
    });
    return finish('NO_CHANGE', { code: 'NO_CHANGE', params: {} }, null, null,
      inside ? null : { code: 'CURRENT_PRICE_OUTSIDE_BOUNDS', severity: 'WARNING' });
  }

  // 7–8. Проверка 1 из 3: предложенная цена против обеих границ
  const proposed = intent.proposedMinor;
  // Отклонение от нарушенной границы — основа «опасного изменения» [Р-73]
  if (proposed < absolute.value.minMinor) {
    deviationBp = boundDeviationBp(proposed, absolute.value.minMinor);
    return fail('LOWER_BOUND', 'BELOW_MIN_PRICE', { proposedMinor: proposed, minMinor: absolute.value.minMinor, deviationBp, source: 'GATE', currency }, 'REJECTED',
      { code: 'PRICE_REJECTED_BY_BOUND', severity: 'WARNING' });
  }
  if (proposed < floor) {
    deviationBp = boundDeviationBp(proposed, floor);
    return fail('LOWER_BOUND', 'BELOW_MARGIN_FLOOR', {
      proposedMinor: proposed, floorMinor: floor, minMinor: absolute.value.minMinor, minMarginBp: guardrails.minMarginBp, deviationBp, currency,
    }, 'REJECTED', { code: 'PRICE_REJECTED_BY_BOUND', severity: 'WARNING' });
  }
  ok('LOWER_BOUND');
  if (proposed > ceiling) {
    deviationBp = boundDeviationBp(proposed, ceiling);
    return fail('UPPER_BOUND', 'ABOVE_MAX_PRICE', { proposedMinor: proposed, maxMinor: ceiling, deviationBp, source: 'GATE', currency }, 'REJECTED',
      { code: 'PRICE_REJECTED_BY_BOUND', severity: 'WARNING' });
  }
  ok('UPPER_BOUND');

  // 9. Шаг изменения
  const current = intent.currentMinor;
  if (guardrails.maxStepChangeBp !== null && current !== null && current > 0) {
    const stepBp = Math.ceil((Math.abs(proposed - current) * 10_000) / current);
    if (stepBp > guardrails.maxStepChangeBp) {
      return fail('STEP', 'STEP_LIMIT', { stepBp, limitBp: guardrails.maxStepChangeBp, currentMinor: current, proposedMinor: proposed, currency }, guardrails.onViolation === 'REJECT' ? 'REJECTED' : 'HELD');
    }
  }
  ok('STEP');

  // 10. Частота изменений
  if (guardrails.maxChangesPerHour !== null && input.changesInLastHour >= guardrails.maxChangesPerHour) {
    return fail('RATE', 'CHANGE_RATE_LIMIT', { changes: input.changesInLastHour, limit: guardrails.maxChangesPerHour }, guardrails.onViolation === 'REJECT' ? 'REJECTED' : 'HELD');
  }
  ok('RATE');

  // 11. Проверка 2 из 3: итоговая цена после всех корректировок
  const finalMinor = proposed;
  if (finalMinor < floor || finalMinor > ceiling) {
    return fail('FINAL_RECHECK', 'INTERNAL_BOUND_VIOLATION', { check: 'FINAL_RECHECK', amountMinor: finalMinor, floorMinor: floor, ceilingMinor: ceiling, currency }, 'REJECTED',
      { code: 'PRICE_GATE_INTERNAL_VIOLATION', severity: 'CRITICAL' });
  }
  ok('FINAL_RECHECK');

  return finish('APPROVED', { code: 'APPROVED', params: { finalMinor, floorMinor: floor, ceilingMinor: ceiling, currency } }, finalMinor, null);
}

// ---------------------------------------------------------------------------
// Проверка 3 из 3: перед отправкой записи
// ---------------------------------------------------------------------------

export function assertWriteWithinBounds(amountMinor: number, bounds: PriceBounds, currency: string, basis: PriceBasis, marginFloorMinor: number | null = null):
  { ok: true } | { ok: false; reason: Reason<PipelineReasonCode | 'BOUND_UNRESOLVABLE'> } {
  const absolute = resolveAbsoluteBounds(bounds, currency, basis);
  if (!absolute.ok) return { ok: false, reason: { code: 'BOUND_UNRESOLVABLE', params: absolute.params } };
  const floorMinor = Math.max(absolute.value.minMinor, marginFloorMinor ?? 0);
  if (amountMinor < floorMinor || amountMinor > absolute.value.maxMinor) {
    return {
      ok: false,
      reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor, floorMinor, ceilingMinor: absolute.value.maxMinor, violated: amountMinor < floorMinor ? 'FLOOR' : 'CEILING', currency } },
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Включение репрайсинга [Р-43]: оба абсолютных предела обязательны
// ---------------------------------------------------------------------------

export function validateRepricingEnablement(
  bounds: PriceBounds, currency: string, basis: PriceBasis, strategy: StrategyDefinition | null,
  // Р-131: аргумент обязателен — умолчание «себестоимость объявлена» молча открывало бы проверку забывшему его вызывающему
  // (ревью шага 27, находка 9)
  cost: { declared: boolean; cause: string | null },
): Reason<PipelineReasonCode>[] {
  const problems: Reason<PipelineReasonCode>[] = [];
  /**
   * Р-131 (шаг 27): без себестоимости репрайсинг не включается. У товара без себестоимости, истории и того же EAN на другом канале нет ни
   * одного якоря проверки входов [Р-49, OQ-186]: ошибка в сто раз пройдёт незамеченной именно там, где у продавца нет ощущения нормальной
   * цены. Себестоимость и так обязательна для пола маржи.
   */
  if (!cost.declared) problems.push({ code: 'COST_REQUIRED', params: cost.cause ? { cause: cost.cause } : {} });
  // Р-77: движок без стратегии не включается — и тип стратегии известен там, где решается о предупреждениях
  if (!strategy) problems.push({ code: 'STRATEGY_MISSING', params: {} });
  const scopeSide = { scopeCurrency: currency, scopeBasis: basis };
  if (bounds.currency !== currency || bounds.basis !== basis) {
    problems.push({ code: 'BOUND_CURRENCY_MISMATCH', params: { bound: 'both', cause: bounds.currency !== currency ? 'CURRENCY_MISMATCH' : 'BASIS_MISMATCH', boundCurrency: bounds.currency, boundBasis: bounds.basis, ...scopeSide } });
  }
  for (const bound of ['min', 'max'] as const) {
    const b = bounds[bound];
    if (b.status === 'RESOLVED') continue;
    problems.push(b.cause === 'MISSING'
      ? { code: bound === 'min' ? 'MIN_PRICE_MISSING' : 'MAX_PRICE_MISSING', params: {} }
      : { code: 'BOUND_CURRENCY_MISMATCH', params: { bound, cause: b.cause, boundCurrency: b.actualCurrency ?? null, boundBasis: b.actualBasis ?? null, ...scopeSide } });
  }
  if (bounds.min.status === 'RESOLVED' && bounds.max.status === 'RESOLVED' && bounds.min.amountMinor > bounds.max.amountMinor) {
    problems.push({ code: 'BOUNDS_INVERTED', params: { minMinor: bounds.min.amountMinor, maxMinor: bounds.max.amountMinor, currency } });
  }
  return problems;
}

/**
 * Профиль Gate — справочник слепка объяснения [Р-75]: проверки идут строго в этом порядке и останавливаются на первой
 * непрошедшей, поэтому слепок хранит только её. Изменение порядка — новая версия профиля и строка в
 * `platform.explanation_ruleset` (совпадение с БД и с порядком `decide` проверяют тесты).
 */
/** Профиль до шага 23 — неизменяемый справочник решений, принятых по нему [Р-75]; новые решения его не используют */
export const GATE_PROFILE_G74: GateProfile = {
  rulesetId: 'g74.1',
  kind: 'GATE',
  definition: {
    CHANGED: ['PRICE_STOP', 'SCOPE', 'CHANNEL_HALT', 'INTENT', 'BOUNDS_RESOLVED', 'MARGIN_FLOOR', 'LOWER_BOUND', 'UPPER_BOUND', 'STEP', 'RATE', 'FINAL_RECHECK'],
    NO_OP: ['PRICE_STOP', 'SCOPE', 'CHANNEL_HALT', 'INTENT', 'BOUNDS_RESOLVED', 'MARGIN_FLOOR', 'CURRENT_WITHIN_BOUNDS'],
  },
};

export const GATE_PROFILE: GateProfile = {
  // Шаг 23 [Р-118]: проверка недоверия каналу — новая версия профиля; g74.1 остаётся для решений, принятых до неё
  rulesetId: 'g118.1',
  kind: 'GATE',
  definition: {
    CHANGED: ['PRICE_STOP', 'SCOPE', 'CHANNEL_DISTRUST', 'CHANNEL_HALT', 'INTENT', 'BOUNDS_RESOLVED', 'MARGIN_FLOOR', 'LOWER_BOUND', 'UPPER_BOUND', 'STEP', 'RATE', 'FINAL_RECHECK'],
    NO_OP: ['PRICE_STOP', 'SCOPE', 'CHANNEL_DISTRUST', 'CHANNEL_HALT', 'INTENT', 'BOUNDS_RESOLVED', 'MARGIN_FLOOR', 'CURRENT_WITHIN_BOUNDS'],
  },
};

/**
 * Предупреждения при включении репрайсинга (шаг 12, Р-77): стратегия целевой маржи или ограничение минимальной маржи
 * без себестоимости дадут отказ каждой цены — продавец узнаёт об этом до включения. Стратегия известна всегда
 * (без неё включение отказывает, STRATEGY_MISSING); кому нужна себестоимость — перечисляется явно.
 */
export function repricingWarnings(input: {
  strategy: StrategyDefinition;
  minMarginBp: number | null;
  cost: CostInputs | null;
  costMissingCause: string | null;
}): Reason<PipelineReasonCode>[] {
  const requiredBy = [
    ...(input.strategy.params.type === 'TARGET_MARGIN' ? ['STRATEGY'] : []),
    ...(input.minMarginBp !== null ? ['MIN_MARGIN'] : []),
  ];
  if (requiredBy.length === 0) return [];
  const cause = !input.cost ? (input.costMissingCause ?? 'COST_PROFILE_MISSING')
    : input.cost.tax.regime === 'VAT_INCLUDED' && input.cost.tax.vatRateBp === null ? 'VAT_RATE_MISSING' : null;
  if (!cause) return [];
  return [{
    code: 'MARGIN_WITHOUT_COST',
    params: { strategyType: input.strategy.params.type, requiredBy: requiredBy.join(','), minMarginBp: input.minMarginBp, cause },
  }];
}
