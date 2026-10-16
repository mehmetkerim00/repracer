export { catalogFirst, catalogTotal, channelOf, gap, GAP_CODES, scopeById, storefrontName, uniqueGaps, unitOf, type ConsoleDecision, type ConsoleHalt, type ConsoleIntent, type ConsoleScope, type ConsoleStop, type ConsoleWrite, type Gap, type GapCode, type StandAccount, type StandWorld, type StatusCell, type Tone, type UnitRef, type Viewer } from './world.ts';
export { describe, explainabilityCatalogue, LIMIT_CODES, REASON_LIMITS, type ExplainabilityRow, type HumanReason, type LimitCode } from './explain.ts';
export { LOCALES, messagesFor, type Messages } from './i18n/index.ts';
export { zoneName } from './i18n/shape.ts';
export type { Fmt, Locale, Template } from './i18n/types.ts';
/** Права по роли [OQ-125] — те же, что проверяют хранилище и БД */
export { can, EXTENDED_ROLES, offeredRoles, VISIBLE_ROLES, type MemberRole, type PricingAction } from '@repracer/pricing-model';
export { boundText, channelNotes, productList, strategyLabel, type ChannelNote, type FloorCell, type ProductListView, type ProductRow, type StrategyLabel } from './products.ts';
export { decisionItems, decisionListView, type DecisionListView, decisionTrace, explanationOf, isDangerous, noChangeTitle, triggerPhrase, type DecisionListItem, type DecisionTrace, type ItemOutcome, type StepStatus, type TraceCompetitors, type TraceItem, type TraceStep, type TraceStepKey } from './trace.ts';
export { rejectedView, type RejectedItem, type RejectedKind, type RejectedView } from './rejected.ts';
export { boundsView, costInScopeCurrency, effectiveFloor, priceBreakdown, type BoundsView, type EffectiveFloor, type MoneyLine, type PriceBreakdown } from './bounds.ts';
export { planStop, stopView, type AuditCard, type DistrustCard, type HaltCard, type StopKindRow, type StopCard, type StopImpact, type StopPlan, type StopTarget, type StopView, type TargetCard } from './stop.ts';
export { CHANNEL_PRICING_SHOWN, currentStrategies, fingerprint, parseStrategyDraft, unmetText, previewToken, STRATEGY_PREVIEW_ROWS_SHOWN, STRATEGY_SCOPE_EXAMPLES, strategiesView, strategyPreviewView, type DraftProblem, type PreviewRow, type StrategyDraft, type StrategyListItem, type StrategyListView, type StrategyScopeItem, type StrategyPreviewView } from './strategies.ts';
export { boundsDiffView, boundsPlanToken, DIFF_ROWS_SHOWN, expandBoundsEdit, MAX_SCOPES, parseAmountInput, parseBoundsEditRequest, parsePercentInput, type BoundAdjust, type BoundsDiffView, type BoundsEditRequest, type BoundsRequestProblem, type DiffFlag, type DiffRow } from './bounds-edit.ts';
export { OFFER_CHOICES } from './compliance.ts';
export { catalogPageOf, LIST_PAGE_DEFAULT, LIST_PAGE_MAX, listQuery, pageOf, parseListQuery, selectionAfterPaging, type ListQuery, type PageInfo } from './page.ts';
export { FEED_MAX_DAYS, FEED_PAGE_MAX, FEED_PERIODS_DAYS, SEARCH_FILTER_LIMIT, FEED_STATUS_GROUPS, parseFeedQuery, priceFeed, feedPageQuery, feedItemOf, type FeedItem, type FeedQuery, type FeedStatusGroup, type PriceFeedView } from './price-feed.ts';
export { dangerousReport, HOT_DECISIONS_DAYS, REPORT_PERIODS_DAYS, type DangerousItem, type DangerousReportView } from './dangerous-report.ts';
export { parsePeriod, PERIOD_PRESETS, periodDays, periodPhrase, periodRange, periodSearch, zonedDate, zonedDayStart, type Period, type PeriodPreset, type PeriodRange } from './period.ts';
export { complianceView, discountCheckView, historyDepthView, PRICE_EVIDENCE_HEADER, priceEvidenceRows, type ComplianceRow, type ComplianceView, type DiscountCheckView, type HistoryDepthView, type OfferDepthRow } from './compliance.ts';
export { columnName, costImportView, importTargets, PREVIEW_ROWS_SHOWN, SKIPPED_EXAMPLES, type CostImportView, type ImportPreviewRowView, type ImportSkippedGroupView } from './cost-import.ts';
export { bulkJobsView, bulkJobView, canCancelBulkJob, CANCEL_ACTION, type BulkJobView, type BulkJobsView } from './jobs.ts';
export { COST_IMPORT_REPORT_HEADER, costImportReportRows, csvOf, PRICE_FEED_CSV_HEADER, priceFeedFileName, priceFeedRowsOf } from './exports.ts';
export { onboardingView, type OnboardingView, type OnboardingStepView, type ChannelAccountView, type EnableResultView, type OnboardingPathChoice } from './onboarding.ts';
export { stockView, stockDivergencesView, stockReturnsView, stockTraps, type StockView, type StockRowView, type StockChannelCell, type StockTrap, type StockDivergencesView, type StockReturnsView, type StockReturnItem } from './stock.ts';
// Шаг 41 [Р-169…Р-171]: экран теневого режима — сводка, would-be изменения и включение боя
export { shadowView, shadowSummaryLines, shadowSummaryList, type ShadowSummaryRow, shadowChart, type ShadowChartView, liveRefusalText, SHADOW_PERIOD_DAYS, type ShadowView, type ShadowAccountView,
  type ShadowWriteView, type MarketplacePropertyView, type ShadowDigestView, type ShadowPeriodChoice, shadowDigestLetter, type ShadowDigestLetterInput } from './shadow.ts';
export { pageInfo, clampOffset } from './page.ts';
export { lastChangeCell, productPage, WALMART_PUBLISHED, WALMART_UNPUBLISHED } from './products.ts';
/** Р-154: окно отчёта об отклонённых — семь суток; счётчики и строки — по вмешательствам окна, не по буферу */
export { REJECTED_WINDOW_DAYS } from './rejected.ts';
export { connectionsView, accountState, channelLimitText, externalWritersView, OTHER_TOOLS_ANSWERS, type ConnectionsView, type ConnectionAccountView, type ConnectionChannelView, type ConnectionState, type ConnectableChannel, type OtherToolsAnswer, type OtherToolsView, type QuantityWritesView } from './connections.ts';
// Шаг 87 [Р-214]: профиль рынка развёртывания — каналы, витрины, языки и правило Omnibus, которые консоль предлагает
export { connectableInMarket, DEFAULT_MARKET_PROFILE, extendedRolesOf, isMarketProfile, localeInMarket, MARKET_PROFILES, marketProfileOf, marketScope, storefrontInMarket, US_STOREFRONTS, worldInMarket, type MarketProfile, type MarketScope } from './market.ts';
export { BUYBOX_SHARE_HORIZON_MS, BUYBOX_SHARE_KEEP_DAYS, buyboxDiagnosis, buyboxShare, competitionView, competitorColumns, type CompetitorColumns, type BuyboxShare, type CompetitionInput, type CompetitionRow, type CompetitionView, type DiagnosisReason, type ShareSpan } from './competition.ts';
