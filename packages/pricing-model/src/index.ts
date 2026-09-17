export type {
  AcceptedSnapshot,
  BoundResolution,
  CompetitorRequirement,
  CompletenessKind,
  CostInputs,
  TaxRegime,
  TaxTreatment,
  DecisionClass,
  GateCheck,
  GateOutcome,
  GateRejectionReason,
  IntentClass,
  PriceBounds,
  PriceDecisionDraft,
  PriceIntentDraft,
  Reason,
  ReasonCode,
  SanityCheckRecord,
  StrategyDefinition,
  StrategyParams,
  StrategyType,
  TriggerType,
} from './types.ts';
export { COMPETITOR_DERIVED_RULES, isCompetitorDerived, markAcceptedBySanity } from './types.ts';
export * from './reasons.ts';
export {
  EXPLANATION_FIELD_KINDS,
  type FieldKind,
  buildExplanation,
  channelKeysIn,
  expandExplanation,
  explainedReason,
  EXPLANATION_FORMAT,
  explanationRowOf,
  eternalCoreOf,
  summarizeSanity,
  type ExplanationIntentColumns,
  type ExplanationRow,
  type SanitySummary,
  type DecisionExplanation,
  type ExpandedExplanation,
  type ExpandedReason,
  type ExplainedReason,
  type ExplanationDictionary,
  type ExplanationGap,
  type ExplanationInput,
  type ExplanationRuleset,
  type ExplanationSanity,
  type GateProfile,
  type GateProfileDefinition,
  type SanityRuleset,
  type SanityRulesetDefinition,
} from './explanation.ts';
export * from './policy.ts';
export { marginBpAtPrice, storefrontPriceForMarginBp, type MarginPriceResult } from './margin.ts';
export {
  convertMinor,
  FX_MAX_RATE_AGE_DAYS,
  MINOR_UNIT_EXPONENT,
  pickFxQuote,
  type FxApplied,
  type FxFailureCause,
  type FxQuote,
  type FxResult,
  type FxRounding,
} from './fx.ts';

/** Причина с параметрами */
export function reason<C extends string>(code: C, params: Readonly<Record<string, string | number | boolean | null>> = {}) {
  return { code, params };
}
export { BASIS_MISMATCH_TOLERANCE_MINOR, priceBasisMismatch, type BasisMismatchDirection } from './price-basis.ts';
export { addDays, localDate, OMNIBUS_WINDOW_DAYS, omnibusLowestPriorPrice, omnibusVerdict, zonedDayStart, type OmnibusPriorPrice, type OmnibusStatus, type OmnibusVerdict } from './omnibus.ts';
