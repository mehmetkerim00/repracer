import assert from 'node:assert/strict';
import { SANITY_RULESET } from '@repracer/input-sanity';
import { GATE_PROFILE } from '@repracer/price-gate';
import { boundDeviationBp, buildExplanation, summarizeSanity, type PriceDecisionDraft, type PriceIntentDraft, type Reason } from '@repracer/pricing-model';
import type { DecisionToCommit, EvaluationCommitResult, ScopeEvaluationContext, SnapshotRef } from '@repracer/pricing-pipeline';
import type { PgPricingStore } from '../src/index.ts';

const now = () => new Date().toISOString();

/** Проверка Gate, которой отказывает причина — для черновиков без полного прогона Gate */
const FAILED_CHECK: Readonly<Record<string, string>> = {
  PRICING_STOPPED: 'PRICE_STOP', SCOPE_NOT_ACTIVE: 'SCOPE', CHANNEL_HALTED: 'CHANNEL_HALT', INTENT_INVALID: 'INTENT', INTENT_EXPIRED: 'INTENT',
  BOUND_UNRESOLVABLE: 'BOUNDS_RESOLVED', BELOW_MIN_PRICE: 'LOWER_BOUND', BELOW_MARGIN_FLOOR: 'LOWER_BOUND', ABOVE_MAX_PRICE: 'UPPER_BOUND',
  STEP_LIMIT: 'STEP', CHANGE_RATE_LIMIT: 'RATE', INTERNAL_BOUND_VIOLATION: 'FINAL_RECHECK',
};

function profileChecks(d: PriceDecisionDraft): PriceDecisionDraft['checks'] {
  const order = GATE_PROFILE.definition.CHANGED;
  if (d.checks.length > 0 && d.checks.every((c, i) => c.check === order[i])) return d.checks;
  if (d.rejectionReason === null) return order.map((check) => ({ check, passed: true, detail: null }));
  const failed = FAILED_CHECK[d.rejectionReason]!;
  return [...order.slice(0, order.indexOf(failed)).map((check) => ({ check, passed: true, detail: null })), { check: failed, passed: false, detail: d.reason }];
}

const withCurrency = (r: Reason, currency: string): Reason =>
  (Object.keys(r.params).some((k) => k.endsWith('Minor')) && !('currency' in r.params) ? { ...r, params: { ...r.params, currency } } : r);

/**
 * Черновик решения теста в форме пути решения: валюта в суммах [Р-71], отклонение от нарушенной границы [Р-73],
 * слепок объяснения [Р-68]; цене из данных конкурентов — ссылка на снимок и итог проверки входов.
 */
export function explained(
  draft: { context: ScopeEvaluationContext; intent: PriceIntentDraft; decision: PriceDecisionDraft },
  snapshotRef: SnapshotRef | null = null,
): DecisionToCommit {
  const { context } = draft;
  const currency = context.scope.currency;
  const d = draft.decision;
  const params = d.reason.params;
  const bound = d.rejectionReason === 'BELOW_MIN_PRICE' ? params.minMinor
    : d.rejectionReason === 'BELOW_MARGIN_FLOOR' ? params.floorMinor
      : d.rejectionReason === 'ABOVE_MAX_PRICE' ? params.maxMinor : null;
  const deviation = typeof bound === 'number' ? boundDeviationBp(draft.intent.proposedMinor, bound) : null;
  const intent: PriceIntentDraft = { ...draft.intent, reason: withCurrency(draft.intent.reason, currency), explanation: draft.intent.explanation.map((r) => withCurrency(r, currency)) };
  const reason = withCurrency(deviation !== null && !('deviationBp' in params) ? { ...d.reason, params: { ...params, deviationBp: deviation } } : d.reason, currency);
  const decision: PriceDecisionDraft = { ...d, reason, boundDeviationBp: d.boundDeviationBp ?? deviation };
  // Р-75: проверки Gate черновика — в порядке профиля, как их отдал бы Gate
  decision.checks = profileChecks(decision);
  if (decision.decisionClass === 'NO_OP') {
    // Р-74: у NO_OP слепка нет — только код причины
    decision.explanation = null;
    decision.gateProfile = null;
    decision.sanityRuleset = null;
    decision.noChangeReason = intent.reason.code;
  } else {
    const sanity = snapshotRef
      ? summarizeSanity({ ruleset: SANITY_RULESET.rulesetId, anchorsUsed: [], checks: SANITY_RULESET.definition.rules.map((rule) => ({ rule, outcome: 'PASS' as const })), warnings: [] }, SANITY_RULESET)
      : null;
    const built = buildExplanation({
      snapshot: snapshotRef ? { source: snapshotRef.source } : null, sanity,
      intent, decision, minMarginBp: context.guardrails.minMarginBp, channelHalt: context.channelHalt, channelDistrust: context.channelDistrust, priceStop: context.priceStop,
    }, GATE_PROFILE);
    decision.explanation = built.explanation;
    decision.gateProfile = built.gateProfile;
    decision.sanityRuleset = built.sanityRuleset;
  }
  return { context, intent, decision, snapshotRef };
}

export async function contextOf(store: PgPricingStore, tenantId: string, writeScopeId: string): Promise<ScopeEvaluationContext> {
  const loaded = await store.loadScopeContext(tenantId, writeScopeId, now());
  assert.ok(loaded, `scope ${writeScopeId} is not visible`);
  return loaded.context;
}

/** Черновики intent и одобренного решения в границах контекста — как их отдали бы движок и Gate */
export function approved(context: ScopeEvaluationContext, amountMinor: number, ceilingMinor?: number) {
  const { scope, bounds } = context;
  const min = bounds.min.status === 'RESOLVED' ? bounds.min : null;
  const max = bounds.max.status === 'RESOLVED' ? bounds.max : null;
  const at = now();
  const intent: PriceIntentDraft = {
    writeScopeId: scope.writeScopeId, strategyId: scope.strategy!.strategyId, strategyVersion: scope.strategy!.version, trigger: { type: 'SCHEDULE' },
    ruleCode: scope.strategy!.params.type, intentClass: 'CHANGED', proposedMinor: amountMinor, currentMinor: scope.currentPriceMinor,
    referenceMinor: null, currency: scope.currency, basis: scope.basis, reason: { code: 'FIXED_PRICE', params: {} }, explanation: [],
    inputs: { boundsAtStrategy: { minMinor: min!.amountMinor, maxMinor: max!.amountMinor } }, createdAt: at, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
  const decision: PriceDecisionDraft = {
    writeScopeId: scope.writeScopeId, outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: amountMinor, currency: scope.currency, basis: scope.basis,
    effectiveFloorMinor: min!.amountMinor, effectiveCeilingMinor: ceilingMinor ?? max!.amountMinor, minPriceIds: min!.sourceIds, maxPriceIds: max!.sourceIds,
    guardrailIds: [], rejectionReason: null, reason: { code: 'APPROVED', params: { finalMinor: amountMinor } }, checks: [], alert: null, decidedAt: at, boundDeviationBp: null,
  };
  return { context, intent, decision };
}

export function commit(store: PgPricingStore, tenantId: string, ...decisions: ReturnType<typeof approved>[]): Promise<EvaluationCommitResult> {
  const s = decisions[0]!.context.scope;
  return store.commitEvaluation(tenantId, {
    key: { channelAccountId: s.channelAccountId, marketplace: s.marketplace, channelProductRef: s.channelProductRef, condition: s.condition }, now: now(), decisions: decisions.map((d) => explained(d)),
  });
}
