export { channelOf, gap, GAP_CODES, scopeById, uniqueGaps, unitOf, type ConsoleDecision, type ConsoleHalt, type ConsoleIntent, type ConsoleScope, type ConsoleStop, type ConsoleWrite, type Gap, type GapCode, type StandAccount, type StandWorld, type StatusCell, type Tone, type UnitRef, type Viewer } from './world.ts';
export { describe, explainabilityCatalogue, LIMIT_CODES, REASON_LIMITS, type ExplainabilityRow, type HumanReason, type LimitCode } from './explain.ts';
export { LOCALES, messagesFor, type Messages } from './i18n/index.ts';
export type { Fmt, Locale, Template } from './i18n/types.ts';
/** Права по роли [OQ-125] — те же, что проверяют хранилище и БД */
export { can, type MemberRole, type PricingAction } from '@repracer/pricing-model';
export { boundText, channelNotes, productList, strategyLabel, type ChannelNote, type FloorCell, type ProductListView, type ProductRow, type StrategyLabel } from './products.ts';
export { decisionList, decisionTrace, explanationOf, isDangerous, noChangeTitle, type DecisionListItem, type DecisionTrace, type ItemOutcome, type StepStatus, type TraceItem, type TraceStep, type TraceStepKey } from './trace.ts';
export { rejectedView, type RejectedItem, type RejectedKind, type RejectedView } from './rejected.ts';
export { boundsView, costInScopeCurrency, effectiveFloor, priceBreakdown, type BoundsView, type EffectiveFloor, type MoneyLine, type PriceBreakdown } from './bounds.ts';
export { planStop, stopView, type AuditCard, type DistrustCard, type HaltCard, type StopKindRow, type StopCard, type StopImpact, type StopPlan, type StopTarget, type StopView, type TargetCard } from './stop.ts';
export { currentStrategies, fingerprint, parseStrategyDraft, previewToken, strategiesView, strategyPreviewView, type DraftProblem, type PreviewRow, type StrategyDraft, type StrategyListItem, type StrategyListView, type StrategyScopeItem, type StrategyPreviewView } from './strategies.ts';
export { boundsDiffView, boundsPlanToken, expandBoundsEdit, parseAmountInput, parseBoundsEditRequest, parsePercentInput, type BoundAdjust, type BoundsDiffView, type BoundsEditRequest, type BoundsRequestProblem, type DiffFlag, type DiffRow } from './bounds-edit.ts';
export { FEED_PAGE_MAX, FEED_PERIODS_DAYS, FEED_STATUS_GROUPS, parseFeedQuery, priceFeed, type FeedItem, type FeedQuery, type FeedStatusGroup, type PriceFeedView } from './price-feed.ts';
export { dangerousReport, REPORT_PERIODS_DAYS, type DangerousItem, type DangerousReportView } from './dangerous-report.ts';
export { complianceView, discountCheckView, priceEvidenceCsv, type ComplianceRow, type ComplianceView, type DiscountCheckView } from './compliance.ts';
