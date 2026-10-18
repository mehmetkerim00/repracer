export { createPricingPipeline, floorRaiseRetryable, type HaltReviewReport, type PipelineDeps, type PollOptions, type ReconciliationReport, type PricingPipeline, type ScopeReport, type SnapshotReport, type Stage, type StageRecord, type StrategyPreview } from './pipeline.ts';
export type {
  AdminActor,
  BoundsEditInput,
  BoundsEditResult,
  CostImportBatch,
  CostImportResult,
  CostImportRowInput,
  BoundsEditRow,
  StrategySaveInput,
  StrategySaveResult,
  StrategyAssignInput,
  DiscountAnnouncementInput,
  DiscountAnnouncementRow,
  DiscountAnnounceResult,
  PriceEvidenceDay,
  StrategyUnassignInput,
  StrategyUnassignResult,
  ConsoleStrategyVersionRow,
  BoundsRead,
  ConsoleDecisionRow,
  ConsoleDivergenceRow,
  ConsoleHaltReviewRow,
  ConsoleDistrustRow,
  ConsoleOfferChannelPricingRow,
  ConsolePricingHealthRow,
  InboundNotificationEntry,
  OfferChannelPricingObservation,
  ConsoleHaltRow,
  ConsoleIntentRow,
  ConsoleMemberRow,
  ConsoleRejectedSnapshotRow,
  BulkJobArtifact,
  BulkJobCreated,
  BulkJobInput,
  BulkJobKind,
  BulkJobOutcome,
  BulkJobPhase,
  BulkJobProgress,
  BulkJobRow,
  BulkJobStatus,
  ConsoleScopeRow,
  ConsoleState,
  ConsoleStopRow,
  ConsoleWriteRow,
  SnapshotRef,
  StopRecord,
  StopRelease,
  StopResult,
  StoredSnapshotRef,
  CommittedDecision,
  DecisionToCommit,
  DispatchRecorded,
  EvaluationCommit,
  EvaluationCommitResult,
  EvaluationContext,
  HaltInfo,
  HaltRecord,
  HaltSampleObservation, HaltSampleReview, HaltReviewRecord,
  PriceScopeContext,
  PricingStore,
  ProductKey,
  RejectedSnapshotRecord,
  ScopeEvaluationContext,
  ShiftWindow,
  SnapshotOutcome,
  NotificationLossCheck,
  NotificationLossVerdict,
  PollCandidate,
  ReconciliationCompared,
  SnapshotDelivery,
} from './store.ts';
export { DEFAULT_MEMBERS, InMemoryPricingStore, seedSkuOf, standUserOf, type MemorySeed, type MemorySeedScope, type SeedBound } from './memory-store.ts';
export {
  DEFAULT_TIERS,
  planPollingTiers,
  planSubscriptionCatchUp,
  type CatchUpInput,
  type CatchUpTask,
  type PollingPlan,
  type PollItem,
  type PollTier,
  type TierConfig,
} from './polling.ts';
export { EXPLANATION_RULESETS } from './dictionary.ts';
export type { ChannelObservation, ConsoleAuditRow, DiscoveredCatalogOffer, MemberRoleChangeResult, DiscoveryStop, FloorRaiseAfter, FloorRaiseCandidate, BuyboxSpanRow, BuyboxHolderObservation } from './store.ts';
export { comparedValue, DEFAULT_LOSS_GRACE_SECONDS, LOSS_GRACE_BASIS, reconcile, rotation, snapshotDigest, stalestFirst, type HeldState, type ReconciliationOutcome } from './reconciliation.ts';
export { BULK_JOB_MEMBER_QUEUE_LIMIT, BULK_JOB_QUEUE_LIMIT, READ_ONLY_JOB_KINDS } from './store.ts';
// Шаг 99 [Р-225]: доступность стратегии каналу [Р-39] — та же проверка, что у назначения и предпросмотра, для импорта стратегий
export { strategyAvailability } from '@repracer/strategy-engine';
// Шаг 99 [Р-224, Р-225]: импорты продавца — виды, журнал, применение границ и стратегий из файла
export { IMPORT_KINDS, XLSX_CONTENT_TYPE } from './store.ts';
// Шаг 102 [Р-227]: «вернётся к полу примерно за N шагов» — та же арифметика, что у лестницы движка [Р-208]
export { ladderSteps } from '@repracer/strategy-engine';
export type { ClearanceRef, ClearanceEnableInput, ClearanceEnableResult, ClearanceDisableResult, ClearanceInvalidCause, ClearanceChangeRow, ClearanceState, ClearanceEnded } from './store.ts';
export type { ImportKind, ImportRunOutcome, ImportRunInput, ImportRunRow, BoundsImportRowInput, BoundsImportResult, StrategiesImportInput, StrategiesImportResult } from './store.ts';
// Шаг 34 [Р-149, Р-150]: онбординг и честное состояние канала
export type { OnboardingProgressRow, OnboardingProgressInput, OnboardingStepStatus, OnboardingStep, OnboardingPath, ChannelAccountRow, ChannelAccessBlocker, ChannelAuthStatus } from './store.ts';
export { ONBOARDING_STOCK_STEPS, ONBOARDING_PRICING_STEPS, onboardingStepsOf } from './store.ts';
export { ONBOARDING_STEPS, CHANNEL_ACCESS_BLOCKERS } from './store.ts';
// Шаг 35 [Р-154]: потоки консоли — страницами, окнами, агрегатами
export { DECISION_OUTCOME_GROUPS, type DecisionOutcomeGroup } from './store.ts';
export type { DecisionPageQuery, DecisionPage, DecisionDetail, ScopeDecisionStats, ConsoleStateOptions, ConsoleCatalogPage, ConsoleCatalogFactsQuery, ConsoleCatalogFacts, InterventionSlice, FeedStatusGroup, FeedPageQuery, FeedPageItem, FeedPage, WorldCounters } from './store.ts';
export { feedGroupOf, FEED_IN_FLIGHT_STATUSES, FEED_NOT_SENT_STATUSES, INTERVENTION_SLICE_LIMIT } from './store.ts';

/** Шаг 97 (ревью, в1): пауза подъёма «Win the Buy Box» — одно число у движка, хранилища в памяти и PostgreSQL */
export { CREEP_PAUSE_PERIODS, CREEP_STALE_PERIODS } from '@repracer/strategy-engine';
