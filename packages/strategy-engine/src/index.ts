import type { CompetitorSnapshot, CompetitorSourceDescriptor, Instant, PriceBasis } from '@repracer/channel-port';
import {
  storefrontPriceForMarginBp,
  type AcceptedSnapshot,
  type CompetitorRequirement,
  type CostInputs,
  type EngineReasonCode,
  type PriceIntentDraft,
  type Reason,
  type StrategyDefinition,
  type StrategyParams,
  type TriggerType,
} from '@repracer/pricing-model';

/**
 * Движок стратегий. Чистые функции: принятый снимок (только AcceptedSnapshot, Р-42), себестоимость, границы
 * и параметры стратегии на входе; PriceIntent с классом CHANGED / NO_OP и цепочкой причин на выходе.
 * Движок не решает, можно ли отправить цену: это Price Gate, который проверяет границы заново.
 * Модели и автоподбор параметров отсутствуют [Р-10].
 */

export interface EngineInput {
  writeScope: { writeScopeId: string; currency: string; basis: PriceBasis };
  strategy: StrategyDefinition;
  snapshot: AcceptedSnapshot | null;
  cost: CostInputs | null;
  /** Границы на момент расчёта; Gate перечитывает их из источника истины */
  bounds: { minMinor: number; maxMinor: number };
  currentPriceMinor: number | null;
  /**
   * Р-171 (шаг 41): последнее предложение, УДЕРЖАННОЕ тенью. В теневом режиме цена на витрине не двигается, поэтому
   * сравнение с ней даёт «изменить» на каждом опросе; сравнение с уже удержанным предложением даёт честное «мы это уже
   * предложили». В боевом режиме поле пустое.
   */
  shadowLastProposedMinor?: number | null;
  now: Instant;
  trigger: { type: TriggerType; sourceEventId?: string };
  intentTtlSeconds?: number;
}

export type EngineResult =
  | { kind: 'INTENT'; intent: PriceIntentDraft }
  | { kind: 'NOT_EVALUATED'; strategyType: StrategyParams['type']; reason: Reason<EngineReasonCode> };

// ---------------------------------------------------------------------------
// Требуемая полнота данных [Р-39]
// ---------------------------------------------------------------------------

const STRATEGY_STALENESS_SECONDS = 900;

export function requirementOf(params: StrategyParams): CompetitorRequirement {
  switch (params.type) {
    case 'FIXED':
    case 'TARGET_MARGIN':
      return { kind: null, needsBuyboxWinner: false, needsOwnRank: false, needsShipping: false, conditions: [], maxStalenessSeconds: null };
    case 'MATCH_BUYBOX':
      return { kind: 'TOP_N', minN: 1, needsBuyboxWinner: true, needsOwnRank: false, needsShipping: false, conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS };
    case 'BEAT_LOWEST':
      return params.scope === 'MARKET'
        ? { kind: 'CHEAPEST_ONLY', needsBuyboxWinner: false, needsOwnRank: false, needsShipping: params.compareLanded, conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS }
        : { kind: 'TOP_N', minN: 1, needsBuyboxWinner: false, needsOwnRank: false, needsShipping: params.compareLanded, conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS };
  }
}

type Completeness = CompetitorSnapshot['completeness'];

function completenessSatisfies(have: Completeness, req: CompetitorRequirement): boolean {
  if (req.kind === null || have.kind === 'FULL') return true;
  if (req.kind === 'TOP_N') return have.kind === 'TOP_N' && have.n >= (req.minN ?? 1);
  return have.kind === req.kind;
}

/** Что из требования не выполнено для конкретного снимка */
export function unmetRequirements(req: CompetitorRequirement, snapshot: CompetitorSnapshot | null, now: Instant): string[] {
  if (req.kind === null) return [];
  if (!snapshot) return ['NO_SNAPSHOT'];
  const unmet: string[] = [];
  if (!completenessSatisfies(snapshot.completeness, req)) unmet.push('COMPLETENESS');
  if (req.needsBuyboxWinner && !snapshot.buybox) unmet.push('BUYBOX_WINNER');
  if (req.needsOwnRank && !snapshot.offers.some((o) => o.isSelf && o.rank !== undefined)) unmet.push('OWN_RANK');
  if (req.needsShipping && snapshot.offers.some((o) => !o.isSelf && !o.shipping)) unmet.push('SHIPPING');
  if (req.conditions.length > 0 && !req.conditions.includes(snapshot.condition.toLowerCase())) unmet.push('CONDITION');
  if (req.maxStalenessSeconds !== null && Date.parse(now) - Date.parse(snapshot.observedAt) > req.maxStalenessSeconds * 1000) unmet.push('STALENESS');
  return unmet;
}

/** Доступность стратегии на канале по заявленным источникам: для интерфейса и включения стратегии [Р-39] */
export function strategyAvailability(
  params: StrategyParams,
  sources: readonly CompetitorSourceDescriptor[],
): { available: true; via: string | null } | { available: false; unmet: Record<string, string[]> } {
  const req = requirementOf(params);
  if (req.kind === null) return { available: true, via: null };
  const unmet: Record<string, string[]> = {};
  for (const s of sources) {
    const u: string[] = [];
    if (s.role !== 'PRIMARY') u.push('RECONCILIATION_ONLY');
    if (s.availability !== 'AVAILABLE') u.push(`AVAILABILITY_${s.availability}`);
    if (!completenessSatisfies(s.completeness, req)) u.push('COMPLETENESS');
    if (req.needsBuyboxWinner && !s.hasBuyboxWinner) u.push('BUYBOX_WINNER');
    if (req.needsOwnRank && !s.hasOwnRank) u.push('OWN_RANK');
    if (req.needsShipping && !s.hasShipping) u.push('SHIPPING');
    if (!req.conditions.every((c) => s.conditions.includes(c))) u.push('CONDITION');
    if (req.maxStalenessSeconds !== null && s.typicalStalenessSeconds !== null && s.typicalStalenessSeconds > req.maxStalenessSeconds) u.push('STALENESS');
    if (u.length === 0) return { available: true, via: s.source };
    unmet[s.source] = u;
  }
  return { available: false, unmet };
}

// ---------------------------------------------------------------------------
// Расчёт
// ---------------------------------------------------------------------------

function r<C extends EngineReasonCode>(code: C, params: Reason['params'] = {}): Reason<C> {
  return { code, params };
}

export function runStrategy(input: EngineInput): EngineResult {
  const { strategy, snapshot, writeScope, bounds, currentPriceMinor: current, now } = input;
  const heldInShadow = input.shadowLastProposedMinor ?? null;
  const params = strategy.params;
  const currency = writeScope.currency;
  const notEvaluated = (reason: Reason<EngineReasonCode>): EngineResult => ({ kind: 'NOT_EVALUATED', strategyType: params.type, reason });
  const safe = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
  const invalidMoney = (param: string, value: unknown, allowed: 'POSITIVE' | 'NON_NEGATIVE') =>
    notEvaluated(r('INVALID_STRATEGY_PARAMS', { param, settingMinor: safe(value), allowed, currency }));

  if (!Number.isSafeInteger(bounds.minMinor) || !Number.isSafeInteger(bounds.maxMinor) || bounds.minMinor <= 0 || bounds.maxMinor < bounds.minMinor) {
    return notEvaluated(r('BOUNDS_INVALID', { minMinor: safe(bounds.minMinor), maxMinor: safe(bounds.maxMinor), currency }));
  }
  if (!Number.isSafeInteger(strategy.deadbandMinor) || strategy.deadbandMinor < 0) return invalidMoney('deadbandMinor', strategy.deadbandMinor, 'NON_NEGATIVE');

  const req = requirementOf(params);
  const unmet = unmetRequirements(req, snapshot, now);
  if (unmet.length > 0) {
    return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', {
      unmet: unmet.join(','), requiredCompleteness: req.kind, requiredN: req.minN ?? null,
      actualCompleteness: snapshot?.completeness.kind ?? null, actualN: snapshot?.completeness.kind === 'TOP_N' ? snapshot.completeness.n : null,
      maxStalenessSeconds: req.maxStalenessSeconds, ageSeconds: snapshot ? Math.max(0, Math.round((Date.parse(now) - Date.parse(snapshot.observedAt)) / 1000)) : null,
    }));
  }
  if (snapshot && req.kind !== null) {
    const foreign = [snapshot.buybox?.price, ...snapshot.offers.map((o) => o.price)].find((m) => m && m.currency !== writeScope.currency);
    if (foreign) return notEvaluated(r('ENGINE_CURRENCY_MISMATCH', { source: 'SNAPSHOT', actual: foreign.currency, expected: writeScope.currency }));
  }

  const explanation: Reason[] = [];
  let target: number;
  let referenceMinor: number | null = null;
  let capable = false;

  switch (params.type) {
    case 'FIXED': {
      if (!Number.isSafeInteger(params.priceMinor) || params.priceMinor <= 0) return invalidMoney('priceMinor', params.priceMinor, 'POSITIVE');
      target = params.priceMinor;
      explanation.push(r('FIXED_PRICE', { targetMinor: target, currency }));
      break;
    }
    case 'TARGET_MARGIN': {
      const cost = input.cost;
      if (!cost) return notEvaluated(r('COST_INPUTS_MISSING', { missing: 'COST_PROFILE' }));
      if (cost.currency !== writeScope.currency) return notEvaluated(r('ENGINE_CURRENCY_MISMATCH', { source: 'COST', actual: cost.currency, expected: writeScope.currency }));
      const priced = storefrontPriceForMarginBp(cost, params.targetMarginBp);
      if (!priced.ok) {
        if (priced.cause === 'VAT_UNKNOWN') return notEvaluated(r('COST_INPUTS_MISSING', { missing: 'VAT_RATE' }));
        if (priced.cause === 'UNATTAINABLE') {
          return notEvaluated(r('MARGIN_UNATTAINABLE', {
            marginBp: params.targetMarginBp, feeRateBp: cost.feeRateBp, fixedFeeMinor: cost.fixedFeeMinor, unitCostMinor: cost.unitCostMinor,
            vatRateBp: cost.tax.regime === 'VAT_INCLUDED' ? cost.tax.vatRateBp : null, currency,
          }));
        }
        return notEvaluated(r('INVALID_STRATEGY_PARAMS', {
          param: 'targetMarginBp', settingBp: Number.isInteger(params.targetMarginBp) ? params.targetMarginBp : null, allowed: 'MARGIN_BELOW_100_PERCENT',
        }));
      }
      target = priced.priceMinor;
      referenceMinor = cost.unitCostMinor > 0 ? cost.unitCostMinor : null;
      explanation.push(r('MARGIN_TARGET', { marginBp: params.targetMarginBp, targetMinor: target, currency }));
      break;
    }
    case 'MATCH_BUYBOX': {
      if (!Number.isSafeInteger(params.undercutMinor) || params.undercutMinor < 0) return invalidMoney('undercutMinor', params.undercutMinor, 'NON_NEGATIVE');
      const bb = snapshot!.buybox!;
      capable = true;
      if (bb.isSelf) {
        if (params.holdWhenWinning) {
          return intent('NO_OP', current ?? bb.price.amountMinor, r('ALREADY_WINNING_BUYBOX'), [r('ALREADY_WINNING_BUYBOX')], bb.price.amountMinor);
        }
        // Не соревнуемся сами с собой: ориентир — лучшее чужое предложение по рангу
        const next = snapshot!.offers.filter((o) => !o.isSelf).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
        if (!next) return intent('NO_OP', current ?? bb.price.amountMinor, r('NO_COMPETITOR_OFFERS'), [r('NO_COMPETITOR_OFFERS')], null);
        referenceMinor = next.price.amountMinor;
      } else {
        referenceMinor = bb.price.amountMinor;
      }
      target = referenceMinor - params.undercutMinor;
      explanation.push(params.undercutMinor > 0
        ? r('BUYBOX_UNDERCUT', { buyboxMinor: referenceMinor, undercutMinor: params.undercutMinor, targetMinor: target, currency })
        : r('BUYBOX_MATCH', { buyboxMinor: referenceMinor, targetMinor: target, currency }));
      break;
    }
    case 'BEAT_LOWEST': {
      if (!Number.isSafeInteger(params.undercutMinor) || params.undercutMinor < 0) return invalidMoney('undercutMinor', params.undercutMinor, 'NON_NEGATIVE');
      capable = true;
      const competitors = snapshot!.offers.filter((o) => !o.isSelf);
      if (competitors.length === 0) return intent('NO_OP', current ?? bounds.minMinor, r('NO_COMPETITOR_OFFERS'), [r('NO_COMPETITOR_OFFERS')], null);
      let ownShipping = 0;
      if (params.compareLanded) {
        const self = snapshot!.offers.find((o) => o.isSelf);
        if (!self?.shipping) return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: 'OWN_SHIPPING' }));
        ownShipping = self.shipping.amountMinor;
      }
      const landed = competitors.map((o) => (params.compareLanded ? o.totalPrice?.amountMinor ?? o.price.amountMinor + (o.shipping?.amountMinor ?? 0) : o.price.amountMinor));
      referenceMinor = Math.min(...landed);
      target = referenceMinor - params.undercutMinor - ownShipping;
      const n = snapshot!.completeness.kind === 'TOP_N' ? snapshot!.completeness.n : null;
      explanation.push(params.undercutMinor > 0
        ? r('LOWEST_UNDERCUT', { lowestMinor: referenceMinor, undercutMinor: params.undercutMinor, targetMinor: target, scope: params.scope, n, currency })
        : r('LOWEST_MATCH', { lowestMinor: referenceMinor, scope: params.scope, n, targetMinor: target, currency }));
      break;
    }
  }

  // Границы: стратегии, следующие за рынком, встают на границу или держат цену; фиксированная цена и маржа —
  // нет: конфликт настройки с границами должен дойти до Gate и быть виден как REJECTED_BY_GATE [Р-44]
  let proposed = target;
  if (capable && (target < bounds.minMinor || target > bounds.maxMinor)) {
    const atBound = (params as { atBound: 'CAP' | 'HOLD' }).atBound;
    if (atBound === 'HOLD') {
      const held = r('TARGET_OUTSIDE_BOUNDS_HOLD', { targetMinor: target, minMinor: bounds.minMinor, maxMinor: bounds.maxMinor, currency });
      if (current === null) return notEvaluated(held);
      return intent('NO_OP', current, held, [...explanation, held], referenceMinor);
    }
    if (target < bounds.minMinor) {
      proposed = bounds.minMinor;
      explanation.push(r('CAPPED_AT_MIN_PRICE', { targetMinor: target, minMinor: bounds.minMinor, currency }));
    } else {
      proposed = bounds.maxMinor;
      explanation.push(r('CAPPED_AT_MAX_PRICE', { targetMinor: target, maxMinor: bounds.maxMinor, currency }));
    }
  }
  if (proposed <= 0) proposed = bounds.minMinor;

  if (current !== null) {
    const delta = Math.abs(proposed - current);
    if (delta === 0) {
      const same = r('ALREADY_AT_TARGET', { targetMinor: proposed, currency });
      return intent('NO_OP', current, same, [...explanation, same], referenceMinor);
    }
    if (delta < strategy.deadbandMinor) {
      const band = r('WITHIN_DEADBAND', { deltaMinor: delta, deadbandMinor: strategy.deadbandMinor, currency });
      return intent('NO_OP', current, band, [...explanation, band], referenceMinor);
    }
  }
  /**
   * Р-171: то же самое предложение уже удержано тенью — повторять его незачем. Проверка стоит ПОСЛЕ сравнения с текущей
   * ценой: в бою поле пустое, и ветка недостижима; в тени именно она превращает поток дублей в один held-write на
   * изменение.
   */
  if (heldInShadow !== null && Math.abs(proposed - heldInShadow) <= strategy.deadbandMinor) {
    const already = r('SHADOW_ALREADY_PROPOSED', { proposedMinor: proposed, heldMinor: heldInShadow, currency });
    return intent('NO_OP', current ?? heldInShadow, already, [...explanation, already], referenceMinor);
  }
  return intent('CHANGED', proposed, explanation[explanation.length - 1]!, explanation, referenceMinor);

  function intent(intentClass: 'CHANGED' | 'NO_OP', proposedMinor: number, main: Reason, chain: Reason[], reference: number | null): EngineResult {
    const ttl = input.intentTtlSeconds ?? 600;
    return {
      kind: 'INTENT',
      intent: {
        writeScopeId: writeScope.writeScopeId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        trigger: input.trigger,
        ruleCode: params.type,
        intentClass,
        proposedMinor,
        currentMinor: current,
        referenceMinor: reference,
        currency: writeScope.currency,
        basis: writeScope.basis,
        reason: main,
        explanation: chain,
        inputs: {
          ...(snapshot?.sourceEventId ? { snapshotSourceEventId: snapshot.sourceEventId } : {}),
          ...(snapshot ? { snapshotObservedAt: snapshot.observedAt, snapshotSource: snapshot.source } : {}),
          ...(input.cost ? { costProfileId: input.cost.costProfileId } : {}),
          boundsAtStrategy: { minMinor: bounds.minMinor, maxMinor: bounds.maxMinor },
        },
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + ttl * 1000).toISOString(),
      },
    };
  }
}
