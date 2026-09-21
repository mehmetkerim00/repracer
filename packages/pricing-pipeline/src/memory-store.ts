import { createHash } from 'node:crypto';
import { EXPLANATION_RULESETS } from './dictionary.ts';
import { rotation } from './reconciliation.ts';
import type { HaltSampleObservation, HaltSampleReview, NotificationLossCheck, PollCandidate, NotificationLossVerdict, SnapshotDelivery, SnapshotOutcome, DiscountAnnouncementInput, DiscountAnnouncementRow, DiscountAnnounceResult, PriceEvidenceDay, ConsoleAuditRow, ConsoleStrategyVersionRow, StrategyAssignInput, StrategyUnassignInput, StrategyUnassignResult, ConsoleDistrustRow, ConsoleOfferChannelPricingRow, ConsolePricingHealthRow, InboundNotificationEntry, OfferChannelPricingObservation, CostImportBatch, CostImportResult, BulkJobArtifact, BulkJobCreated, BulkJobInput, BulkJobKind, BulkJobOutcome, BulkJobProgress, BulkJobRow, OnboardingProgressRow, OnboardingProgressInput, OnboardingStepStatus, ChannelAccountRow} from './store.ts';
import { BULK_JOB_MEMBER_QUEUE_LIMIT, BULK_JOB_QUEUE_LIMIT, FILE_PRODUCING_JOB_KINDS, READ_ONLY_JOB_KINDS } from './store.ts';
import { offerIdentityOf, type CompetitorQuery, type CompetitorSnapshot, type CompetitorSourceDescriptor, type FieldWrite, type Instant, type OfferIdentity, type PriceBasis, type PricingHealthObservation, type WriteOutcome } from '@repracer/channel-port';
import type { CrossChannelReference, DailyRange, SanityContext } from '@repracer/input-sanity';
import { assertWriteWithinBounds, NO_GUARDRAILS, type GuardrailSet } from '@repracer/price-gate';
import { strategyAvailability } from '@repracer/strategy-engine';
import {
  BOUND_CAUSES,
  can,
  convertMinor,
  isCompetitorDerived,
  localDate,
  zonedDayStart,
  omnibusLowestPriorPrice,
  omnibusVerdict,
  priceBasisMismatch,
  resumeActionFor,
  sellerActionFor,
  stopCovers,
  storefrontPriceForMarginBp,
  type AcceptedSnapshot,
  type BoundResolution,
  type CostInputs,
  type SanitySummary,
  type FxQuote,
  type DistrustRef,
  type HaltRef,
  type MemberRole,
  type OmnibusPriorPrice,
  type PriceBounds,
  type PriceDecisionDraft,
  type PriceIntentDraft,
  type Reason,
  type StopRef,
  type StopScope,
  type StrategyDefinition,
  type TaxRegime,
} from '@repracer/pricing-model';
import {
  DEFAULT_RETRY_POLICY,
  planOutcomeTransition,
  planReconciliationTransition,
  type ClaimResult,
  type DueKind,
  type DueScope,
  type OutcomeTransition,
  type PriceBasisDistrust,
  type RecordedOutcome,
  type Reconciliation,
  type RetryPolicy,
  type WriteQueueStore,
} from '@repracer/write-dispatcher';
import type {
  AdminActor,
  BoundsEditInput,
  BoundsEditResult,
  BoundsEditRow,
  StrategySaveInput,
  StrategySaveResult,
  BoundsRead,
  CommittedDecision,
  ConsoleDecisionRow,
  ConsoleMemberRow,
  ConsoleState,
  ConsoleStopRow,
  DispatchRecorded,
  EvaluationCommit,
  EvaluationCommitResult,
  EvaluationContext,
  HaltInfo,
  HaltRecord,
  HaltReviewRecord,
  PriceScopeContext,
  PricingStore,
  ProductKey,
  RejectedSnapshotRecord,
  ScopeEvaluationContext,
  ShiftWindow,
  StopRecord,
  StopRelease,
  StopResult,
  StoredSnapshotRef,
} from './store.ts';

/**
 * Хранилище в памяти для стенда: один тенант. Повторяет инварианты БД, важные для пути решения
 * (ENGINE только с обеими границами, одна транзакция на оценку с закреплённой версией контекста, проверки при отправке,
 * журнал снятия остановки, роли остановки), но не заменяет их: реальные инварианты проверяет @repracer/pricing-store-pg.
 */

export interface SeedBound {
  amountMinor: number;
  id: string;
  currency?: string;
  basis?: PriceBasis;
  isActive?: boolean;
}

export interface MemorySeedScope {
  writeScopeId: string;
  productId: string;
  channelAccountId: string;
  marketplace: string;
  externalUnitId: string;
  channelProductRef: string;
  condition: string;
  gtin?: string | null;
  currency: string;
  basis: PriceBasis;
  /** По умолчанию — по базе цены: GROSS — VAT_INCLUDED, NET — SALES_TAX_EXCLUDED (как CHECK write_scope) [Р-58] */
  taxRegime?: TaxRegime;
  pricingMode: PriceScopeContext['pricingMode'];
  status?: PriceScopeContext['status'];
  strategy: StrategyDefinition | null;
  currentPriceMinor: number | null;
  minPrice?: SeedBound | null;
  maxPrice?: SeedBound | null;
  cost?: CostInputs | null;
  guardrails?: Partial<GuardrailSet>;
  changesLastHour?: number;
}

export interface MemorySeed {
  scopes: MemorySeedScope[];
  /** Канал и регион аккаунта мира: из них строится идентичность записи (OQ-165); по умолчанию Kaufland без региона */
  channel?: 'KAUFLAND' | 'AMAZON';
  region?: string | null;
  /** Источники конкурентов канала — как platform.competitor_source: доступность стратегии при сохранении [Р-39, OQ-166] */
  competitorSources?: CompetitorSourceDescriptor[];
  /**
   * OQ-173 (шаг 24): источники по каналам — для единиц записи аккаунтов других каналов (seed.accounts). Канал без описания — пустой
   * список, как канал без строк platform.competitor_source: стратегии по данным конкурентов недоступны
   */
  competitorSourcesByChannel?: Partial<Record<'KAUFLAND' | 'AMAZON' | 'EBAY', CompetitorSourceDescriptor[]>>;
  /** Р-151: тенант мира — демо (в PostgreSQL — `tenant.demo`) */
  demo?: boolean;
  /** Аккаунты других каналов для единиц записи, которые не принадлежат аккаунту мира (посев в PostgreSQL) */
  accounts?: Array<{
    channelAccountId: string; channel: 'KAUFLAND' | 'AMAZON' | 'EBAY'; region?: string; marketplaces: string[];
    /** Р-150: аккаунт заведён, доступа нет — честное состояние с перечнем того, чего не хватает */
    awaitingAccess?: Array<'PARTNER_REGISTRATION' | 'DEVELOPER_KEYS' | 'NOTIFICATION_QUEUE' | 'SELLER_AUTHORIZATION'>;
  }>;
  /** Валюта и база цены витрин без единиц записи; по умолчанию — витрины Kaufland de и at */
  marketplaces?: Record<string, { currency: string; basis: PriceBasis; timeZone?: string | null }>;
  /** Ключ — «витрина|товар|состояние» */
  competitorDaily?: Record<string, DailyRange[]>;
  competitorState?: Record<string, { observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null }>;
  crossChannel?: Record<string, CrossChannelReference[]>;
  /** Курсы ЕЦБ [Р-61, Р-63] */
  fxRates?: FxQuote[];
  moves?: Array<{ marketplace: string; productRef: string; evaluatedAt: Instant; moveBp: number; sellerRef?: string | null }>;
  /** Системные остановки витрины [Р-51]; остановки человеком — stops */
  halts?: Array<{ marketplace: string | null; haltedAt: Instant; reviewWindowSeconds?: number }>;
  /** Остановки человеком [Р-69, Р-70]; автор по умолчанию — владелец */
  stops?: Array<{ scope: StopScope; channelAccountId?: string | null; marketplace?: string | null; stoppedAt: Instant; membershipId?: string; note?: string }>;
  /** Участники тенанта; по умолчанию — владелец и оператор (DEFAULT_MEMBERS) */
  members?: Array<{ membershipId: string; role: MemberRole; userId?: string }>;
  /** Имитация параллельного изменения границ: при первой фиксации решения по единице граница меняется [Р-54] */
  commitConflicts?: Array<{ writeScopeId: string; bound: 'min' | 'max'; value: SeedBound }>;
}

/** Пользователь синтетического участника: membership-operator → user-operator */
export function standUserOf(membershipId: string): string {
  return `user-${membershipId.replace(/^membership-/, '')}`;
}

/** Синтетические участники стенда: те же псевдонимы членств и пользователей переводит посев PostgreSQL */
export const DEFAULT_MEMBERS: ReadonlyArray<{ membershipId: string; role: MemberRole; userId: string }> = [
  { membershipId: 'membership-owner', role: 'OWNER', userId: 'user-owner' },
  { membershipId: 'membership-admin', role: 'ADMIN', userId: 'user-admin' },
  { membershipId: 'membership-operator', role: 'OPERATOR', userId: 'user-operator' },
  { membershipId: 'membership-pricing-manager', role: 'PRICING_MANAGER', userId: 'user-pricing-manager' },
  { membershipId: 'membership-viewer', role: 'VIEWER', userId: 'user-viewer' },
];

interface ScopeRow extends MemorySeedScope {
  status: PriceScopeContext['status'];
  taxRegime: TaxRegime;
  priceVersion: number;
  knownPricesMinor: number[];
}

interface HaltRow extends HaltRecord {
  haltId: string;
  rejectedSnapshotId: string | null;
  reviewWindowSeconds: number;
  nextReviewAt: Instant;
  releasedAt: Instant | null;
  releasedKind: 'AUTO' | 'MANUAL' | null;
}

/** Запись в канал — как tenant_data.channel_write (0008, 0018, 0036) */
interface WriteRow {
  channelWriteId: string;
  writeScopeId: string;
  amountMinor: number;
  currency: string;
  basis: PriceBasis;
  version: number;
  decisionId: string;
  competitorDerived: boolean;
  scopeKey: string;
  identity: OfferIdentity;
  status: string;
  attemptCount: number;
  createdAt: Instant;
  dispatchedAt: Instant | null;
  acceptedAt: Instant | null;
  nextAttemptAt: Instant | null;
  lastErrorCode: string | null;
  endReason: string | null;
  endParams: Record<string, string | number | boolean | null>;
  supersededByWriteId: string | null;
}

interface CompetitorRow {
  observedAt: Instant;
  buyboxMinor: number | null;
  buyboxIsSelf?: boolean;
  lowestMinor: number | null;
  snapshot: AcceptedSnapshot | null;
  competitorSnapshotId: string | null;
  sanity: SanitySummary | null;
}

const KAUFLAND_STOREFRONTS: Record<string, { currency: string; basis: PriceBasis; timeZone?: string | null }> = {
  de: { currency: 'EUR', basis: 'GROSS', timeZone: 'Europe/Berlin' }, at: { currency: 'EUR', basis: 'GROSS', timeZone: 'Europe/Vienna' },
};
const productKey = (k: { marketplace: string; channelProductRef: string; condition: string }) => `${k.marketplace}|${k.channelProductRef}|${k.condition}`;
const COMPETITOR_STRATEGIES = new Set(['MATCH_BUYBOX', 'BEAT_LOWEST']);
/** Ставки НДС по умолчанию витрин стенда (0033, 0075: amazon.de — Германия) */
const DEFAULT_VAT_BP: Readonly<Record<string, number>> = { de: 1900, at: 2000, A1PA6795UKMFR9: 1900 };
const NOTE_OK = (note: string | null | undefined) => typeof note === 'string' && note.trim().length >= 10 && note.length <= 2000;

export class InMemoryPricingStore implements PricingStore, WriteQueueStore {
  private readonly tenantId: string;
  private readonly channel: 'KAUFLAND' | 'AMAZON';
  private readonly region: string | null;
  private readonly competitorSources: CompetitorSourceDescriptor[] | null;
  private readonly competitorSourcesByChannel: Partial<Record<string, CompetitorSourceDescriptor[]>>;
  private readonly accountChannels = new Map<string, string>();
  /** Р-120: как channel_data.offer_channel_pricing */
  readonly offerChannelPricing: ConsoleOfferChannelPricingRow[] = [];
  readonly pricingHealth: ConsolePricingHealthRow[] = [];
  /** Р-122 (шаг 24): как channel_data.competitor_snapshot_log — полный снимок при любом вердикте, для выгрузки в ClickHouse */
  readonly snapshotLog: Array<{ competitorSnapshotId: string; receivedAt: Instant; verdict: SnapshotOutcome['verdict'] | 'RECONCILIATION'; delivery: SnapshotDelivery; key: ProductKey; snapshot: CompetitorSnapshot }> = [];
  /** Р-121 (0088): проверки потери уведомлений и вердикты базы */
  readonly lossChecks: Array<NotificationLossCheck & { checkId: string }> = [];
  readonly lossVerdicts: Array<{ checkId: string; verdict: NotificationLossVerdict['verdict']; pushSnapshotId: string | null; decidedAt: Instant }> = [];
  /** Журнал обработанных уведомлений: как UNIQUE (tenant_id, channel, notification_id) в 0083 */
  readonly inboundNotifications = new Map<string, InboundNotificationEntry>();
  private readonly scopes = new Map<string, ScopeRow>();
  private readonly competitorDaily = new Map<string, DailyRange[]>();
  private readonly competitorState = new Map<string, CompetitorRow>();
  private readonly crossChannel: Record<string, CrossChannelReference[]>;
  private readonly fxRates: FxQuote[];
  private readonly marketplaces: Record<string, { currency: string; basis: PriceBasis; timeZone?: string | null }>;
  /** Р-123 (шаг 24): применённые цены — как tenant_data.price_history (суточной свёртки у двойника нет, сутки считаются из сырья) */
  readonly priceHistory: Array<{ writeScopeId: string; acceptedAt: Instant; amountMinor: number; currency: string; basis: PriceBasis; channelWriteId?: string; notApplied?: boolean }> = [];
  /** Р-124: подключение единицы записи цены — как write_scope.created_at */
  readonly scopeConnectedAt = new Map<string, Instant>();
  readonly discounts: DiscountAnnouncementRow[] = [];
  private readonly conflicts: Array<{ writeScopeId: string; bound: 'min' | 'max'; value: SeedBound }>;
  private readonly members: ConsoleMemberRow[];
  readonly moves: Array<{ marketplace: string; productRef: string; evaluatedAt: Instant; moveBp: number; verdict: string; sellerRef: string | null }> = [];
  /**
   * Шаг 24 (OQ-161): движения витрины, упорядоченные по времени. Окно сдвига читает только движения внутри окна, а не всю историю:
   * бэктест на 18 месяцев рос квадратично (77 % времени — полный обход moves при каждой оценке)
   */
  private readonly movesByMarketplace = new Map<string, Array<{ at: number; seq: number; move: InMemoryPricingStore['moves'][number] }>>();
  private moveSeq = 0;
  /**
   * Окно сдвига витрины для одного момента оценки: последнее движение каждого товара в окне. Снимки одного момента (каталог в бэктесте)
   * читают его из кеша; новое движение внутри окна обновляет кеш — тот же итог, что обход движений окна
   */
  private readonly windowCache = new Map<string, { nowMs: number; from: number; latest: Map<string, { at: number; seq: number; move: InMemoryPricingStore['moves'][number] }> }>();
  readonly halts: HaltRow[] = [];
  /** Остановки по недоверию каналу [Р-118] — как channel_data.channel_distrust */
  readonly distrusts: ConsoleDistrustRow[] = [];
  private readonly haltSamples: Array<HaltSampleObservation & { haltId: string; recordedAt: Instant }> = [];
  readonly haltReviews: Array<HaltReviewRecord & { haltId: string }> = [];
  readonly stops: ConsoleStopRow[] = [];
  /** Журнал аудита остановок [Р-76] — как audit.audit_event */
  readonly audit: ConsoleAuditRow[] = [];
  /** Справочник версий стратегий для слепков [Р-75] — как tenant_data.pricing_strategy */
  private readonly strategyVersions = new Map<string, StrategyDefinition>();
  /** OQ-170: версии, сохранённые через консоль, — имя, автор, момент; у стратегий посева этих данных нет */
  private readonly strategyMeta = new Map<string, ConsoleStrategyVersionRow>();
  readonly rejectedSnapshots: Array<RejectedSnapshotRecord & { key: ProductKey; rejectedSnapshotId: string }> = [];
  readonly intents: Array<PriceIntentDraft & { intentId: string }> = [];
  readonly decisions: ConsoleDecisionRow[] = [];
  readonly writes: WriteRow[] = [];
  /** Шаг 24 (OQ-161): индексы записей по единице и по идентификатору — записи только добавляются, не удаляются */
  private readonly writesByScope = new Map<string, WriteRow[]>();
  private readonly writesById = new Map<string, WriteRow>();
  readonly divergenceCases: Array<{ divergenceCaseId: string; writeScopeId: string; expectedMinor: number; observedMinor: number; cause: string; status: string; openedAt: Instant }> = [];
  /** Применённые изменения цены по единице записи, по времени — для лимита изменений за час */
  private readonly changes = new Map<string, number[]>();
  private seq = 0;

  constructor(seed: MemorySeed, options: { tenantId?: string } = {}) {
    this.tenantId = options.tenantId ?? 'memory-tenant';
    this.channel = seed.channel ?? 'KAUFLAND';
    this.region = this.channel === 'KAUFLAND' ? null : seed.region ?? null;
    this.competitorSources = seed.competitorSources ? [...seed.competitorSources] : null;
    this.competitorSourcesByChannel = { ...(seed.competitorSourcesByChannel ?? {}) };
    for (const a of seed.accounts ?? []) this.accountChannels.set(a.channelAccountId, a.channel);
    this.seedAccounts = seed.accounts ?? [];
    this.demo = seed.demo === true;
    for (const s of seed.scopes) {
      this.scopes.set(s.writeScopeId, {
        ...s, status: s.status ?? 'ACTIVE', taxRegime: s.taxRegime ?? (s.basis === 'GROSS' ? 'VAT_INCLUDED' : 'SALES_TAX_EXCLUDED'),
        priceVersion: 0, knownPricesMinor: s.currentPriceMinor === null ? [] : [s.currentPriceMinor],
      });
    }
    for (const [k, v] of Object.entries(seed.competitorDaily ?? {})) this.competitorDaily.set(k, [...v]);
    for (const [k, v] of Object.entries(seed.competitorState ?? {})) this.competitorState.set(k, { ...v, snapshot: null, competitorSnapshotId: null, sanity: null });
    this.crossChannel = seed.crossChannel ?? {};
    this.fxRates = [...(seed.fxRates ?? [])];
    this.marketplaces = { ...KAUFLAND_STOREFRONTS, ...seed.marketplaces };
    this.conflicts = [...(seed.commitConflicts ?? [])];
    this.members = (seed.members ?? DEFAULT_MEMBERS).map((m) => ({ ...m, userId: m.userId ?? standUserOf(m.membershipId), status: 'ACTIVE' }));
    for (const s of seed.scopes) if (s.strategy) this.rememberStrategy(s.strategy);
    for (const m of seed.moves ?? []) this.rememberMove({ ...m, verdict: 'ACCEPT', sellerRef: m.sellerRef ?? null });
    const accountId = seed.scopes[0]?.channelAccountId ?? '';
    for (const h of seed.halts ?? []) {
      const window = h.reviewWindowSeconds ?? 1800;
      const haltId = this.id('halt');
      this.halts.push({
        haltId, channelAccountId: accountId, marketplace: h.marketplace, reasonCode: 'CHANNEL_MASS_SHIFT', rejectedSnapshotId: null,
        details: {}, haltedAt: h.haltedAt, reviewWindowSeconds: window, nextReviewAt: new Date(Date.parse(h.haltedAt) + window * 1000).toISOString(),
        releasedAt: null, releasedKind: null,
      });
      this.auditHalt('pricing.halt_created', haltId, h.haltedAt, null, null);
    }
    for (const st of seed.stops ?? []) {
      this.stops.push({
        stopId: this.id('stop'), scope: st.scope, channelAccountId: st.scope === 'TENANT' ? null : st.channelAccountId ?? accountId,
        marketplace: st.scope === 'STOREFRONT' ? st.marketplace ?? null : null, stoppedAt: st.stoppedAt,
        stoppedByMembershipId: st.membershipId ?? 'membership-owner', note: st.note ?? 'Synthetic stop of the scenario',
        releasedAt: null, releasedByMembershipId: null, releaseNote: null,
      });
      this.auditStop('pricing.stop_created', this.stops[this.stops.length - 1]!);
    }
  }

  /** Как offer_mapping в PostgreSQL: у Kaufland ключ — unit, у Amazon — регион и SKU (OQ-165) */
  private identityOf(row: ScopeRow) {
    return offerIdentityOf({
      channel: this.channel, field: 'PRICE', region: this.region, marketplace: row.marketplace,
      externalUnitId: this.channel === 'KAUFLAND' ? row.externalUnitId : null, externalSku: this.channel === 'KAUFLAND' ? null : row.externalUnitId,
    });
  }

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(4, '0')}`;
  }

  private context(row: ScopeRow): PriceScopeContext {
    return {
      writeScopeId: row.writeScopeId, productId: row.productId, channelAccountId: row.channelAccountId, marketplace: row.marketplace,
      externalUnitId: row.externalUnitId, channelProductRef: row.channelProductRef, condition: row.condition,
      identity: this.identityOf(row),
      scopeKey: `${this.channel.toLowerCase()}|${row.channelAccountId}|${this.region ? `${this.region}|` : ''}${row.marketplace}|${row.externalUnitId}`, gtin: row.gtin ?? null,
      currency: row.currency, basis: row.basis, taxRegime: row.taxRegime, pricingMode: row.pricingMode, status: row.status, strategy: row.strategy,
      currentPriceMinor: row.currentPriceMinor, knownPricesMinor: [...row.knownPricesMinor],
    };
  }

  private activeHalt(channelAccountId: string, marketplace: string): HaltRow | undefined {
    return this.halts.find((h) => h.releasedAt === null && h.channelAccountId === channelAccountId && (h.marketplace === null || h.marketplace === marketplace));
  }

  /** Системная остановка витрины блокирует только цены из данных конкурентов [Р-51] */
  private static haltBlocks(halt: HaltRow | undefined, competitorDerived: boolean): halt is HaltRow {
    return halt !== undefined && competitorDerived;
  }

  /** Остановка по недоверию каналу [Р-118] — как channel_data.channel_distrust_for (0082): все цены */
  private activeDistrust(channelAccountId: string, marketplace: string): ConsoleDistrustRow | undefined {
    return this.distrusts.find((d) => d.releasedAt === null && d.channelAccountId === channelAccountId && (d.marketplace === null || d.marketplace === marketplace));
  }

  private static distrustRef(d: ConsoleDistrustRow): DistrustRef {
    return { distrustId: d.distrustId, reasonCode: d.reasonCode, marketplace: d.marketplace, detectedAt: d.detectedAt };
  }

  private static distrustReason(d: ConsoleDistrustRow, stage: 'DISPATCH' | 'DATABASE'): Reason {
    return { code: 'CHANNEL_DISTRUSTED', params: { stage, distrustId: d.distrustId, detectedAt: d.detectedAt, distrustReason: d.reasonCode, marketplace: d.marketplace } };
  }

  /** Остановка тенанта действует на любой аккаунт, в том числе подключённый после неё [Р-70] */
  private activeStop(channelAccountId: string, marketplace: string): ConsoleStopRow | undefined {
    const order: Record<StopScope, number> = { TENANT: 0, CHANNEL_ACCOUNT: 1, STOREFRONT: 2 };
    return this.stops.filter((s) => s.releasedAt === null && stopCovers(s, channelAccountId, marketplace)).sort((a, b) => order[a.scope] - order[b.scope])[0];
  }

  private static haltRef(h: HaltRow): HaltRef {
    return { haltId: h.haltId, reasonCode: h.reasonCode, marketplace: h.marketplace, haltedAt: h.haltedAt };
  }

  private static stopRef(s: ConsoleStopRow): StopRef {
    return { stopId: s.stopId, scope: s.scope, channelAccountId: s.channelAccountId, marketplace: s.marketplace, stoppedAt: s.stoppedAt, stoppedByMembershipId: s.stoppedByMembershipId };
  }

  /**
   * Шаг 24 (OQ-161): удаление по сроку, как в PostgreSQL (intent 3 дня, решения 30 дней [Р-28], завершённые записи уходят в историю):
   * строки старше момента cutoff, которые больше не участвуют в решении. Нужна бэктесту на 18 месяцев по каталогу — иначе хранилище в
   * памяти держит все решения периода. Незавершённые записи, их решения и системные остановки не удаляются.
   */
  pruneBefore(cutoff: Instant): { intents: number; decisions: number; writes: number; moves: number; rejectedSnapshots: number } {
    const at = Date.parse(cutoff);
    const FINISHED = new Set(['APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'NOT_APPLIED']);
    // Строки добавляются по времени: удаляется начало списка до первой строки не старше cutoff; из него остаются строки, которые ещё нужны
    const removeIf = <T>(list: T[], drop: (x: T) => boolean, old: (x: T) => boolean): number => {
      let end = 0;
      while (end < list.length && old(list[end]!)) end++;
      if (end === 0) return 0;
      const kept = list.slice(0, end).filter((x) => !drop(x));
      list.splice(0, end, ...kept);
      return end - kept.length;
    };
    this.windowCache.clear();
    const writes = removeIf(this.writes, (w) => FINISHED.has(w.status), (w) => Date.parse(w.createdAt) < at);
    if (writes > 0) {
      this.writesById.clear();
      this.writesByScope.clear();
      for (const w of this.writes) {
        this.writesById.set(w.channelWriteId, w);
        this.writesOf(w.writeScopeId).push(w);
      }
    }
    const referenced = new Set(this.writes.map((w) => w.decisionId));
    const decisions = removeIf(this.decisions, (d) => !referenced.has(d.decisionId), (d) => Date.parse(d.decidedAt) < at);
    const intentOfDecision = new Set(this.decisions.map((d) => d.intentId));
    // Меньше строк — дешевле: при удалении по сроку сравниваются только старые строки
    const intents = removeIf(this.intents, (i) => !intentOfDecision.has(i.intentId), (i) => Date.parse(i.createdAt) < at);
    const moves = removeIf(this.moves, () => true, (m) => Date.parse(m.evaluatedAt) < at);
    for (const list of this.movesByMarketplace.values()) removeIf(list, () => true, (m) => m.at < at);
    for (const list of this.changes.values()) removeIf(list, () => true, (t) => t < at);
    const rejectedSnapshots = removeIf(this.rejectedSnapshots, () => true, (r) => Date.parse(r.receivedAt) < at);
    removeIf(this.snapshotLog, () => true, (r) => Date.parse(r.receivedAt) < at);
    removeIf(this.priceHistory, () => true, (h) => Date.parse(h.acceptedAt) < at);
    return { intents, decisions, writes, moves, rejectedSnapshots };
  }

  /** Источники конкурентов канала аккаунта; null — описания каналов в посеве нет (проверка не выполняется, как до шага 23) */
  private sourcesFor(channelAccountId: string): CompetitorSourceDescriptor[] | null {
    const channel = this.accountChannels.get(channelAccountId) ?? this.channel;
    const byChannel = this.competitorSourcesByChannel[channel];
    if (byChannel) return byChannel;
    if (channel === this.channel) return this.competitorSources;
    return this.competitorSources || Object.keys(this.competitorSourcesByChannel).length > 0 ? [] : null;
  }

  private writesOf(writeScopeId: string): WriteRow[] {
    let list = this.writesByScope.get(writeScopeId);
    if (!list) {
      list = [];
      this.writesByScope.set(writeScopeId, list);
    }
    return list;
  }

  private scopesByProduct: Map<string, ScopeRow[]> | null = null;

  /** Единицы записи товара аккаунта; единицы создаются только в конструкторе — индекс строится один раз */
  private scopesOfProduct(channelAccountId: string, key: string): ScopeRow[] {
    if (!this.scopesByProduct) {
      this.scopesByProduct = new Map();
      for (const s of this.scopes.values()) {
        const k = `${s.channelAccountId}|${productKey(s)}`;
        this.scopesByProduct.set(k, [...(this.scopesByProduct.get(k) ?? []), s]);
      }
    }
    return this.scopesByProduct.get(`${channelAccountId}|${key}`) ?? [];
  }

  private blocking(row: ScopeRow): { errorCode: string; since: Instant } | null {
    if (row.status === 'ACTIVE') return null;
    // Принятая запись, сверка которой остановлена (D1, Р-115), тоже несёт код: без него продавец не видит своего действия
    const w = [...this.writesOf(row.writeScopeId)].reverse().find((x) => x.lastErrorCode && (x.status === 'FAILED' || x.status === 'ACCEPTED') && !x.nextAttemptAt);
    return w ? { errorCode: w.lastErrorCode!, since: w.dispatchedAt ?? w.createdAt } : null;
  }

  // --- мутации мира для шагов стенда -------------------------------------
  setBound(writeScopeId: string, bound: 'min' | 'max', value: SeedBound | null): void {
    const row = this.scope(writeScopeId);
    if (bound === 'min') row.minPrice = value; else row.maxPrice = value;
    if (row.pricingMode === 'ENGINE') this.assertBounds(row);
  }

  setCost(writeScopeId: string, cost: CostInputs | null): void {
    this.scope(writeScopeId).cost = cost;
  }

  private scope(writeScopeId: string): ScopeRow {
    const row = this.scopes.get(writeScopeId);
    if (!row) throw new Error(`unknown write scope ${writeScopeId}`);
    return row;
  }

  private assertBounds(row: ScopeRow): void {
    const b = this.boundsOf(row);
    if (b.min.status !== 'RESOLVED' || b.max.status !== 'RESOLVED' || b.min.amountMinor > b.max.amountMinor) {
      throw new Error(`write_scope ${row.writeScopeId}: ENGINE requires resolvable min_price <= max_price (Р-43)`);
    }
  }

  private boundsOf(row: ScopeRow): PriceBounds {
    const one = (b: SeedBound | null | undefined): BoundResolution => {
      if (!b || b.isActive === false) return { status: 'UNRESOLVABLE', cause: 'MISSING' };
      const actual = { actualCurrency: b.currency ?? row.currency, actualBasis: b.basis ?? row.basis };
      if ((b.currency ?? row.currency) !== row.currency) return { status: 'UNRESOLVABLE', cause: 'CURRENCY_MISMATCH', ...actual };
      if ((b.basis ?? row.basis) !== row.basis) return { status: 'UNRESOLVABLE', cause: 'BASIS_MISMATCH', ...actual };
      if (!Number.isSafeInteger(b.amountMinor) || b.amountMinor <= 0) return { status: 'UNRESOLVABLE', cause: 'INVALID_AMOUNT' };
      return { status: 'RESOLVED', amountMinor: b.amountMinor, sourceIds: [b.id] };
    };
    return { currency: row.currency, basis: row.basis, min: one(row.minPrice), max: one(row.maxPrice) };
  }

  private contextVersion(row: ScopeRow): string {
    const v = (b: SeedBound | null | undefined) => (b ? `${b.id}:${b.amountMinor}:${b.isActive !== false}` : '-');
    return `${v(row.minPrice)}|${v(row.maxPrice)}|halt:${this.activeHalt(row.channelAccountId, row.marketplace)?.haltId ?? '-'}|distrust:${this.activeDistrust(row.channelAccountId, row.marketplace)?.distrustId ?? '-'}|stop:${this.activeStop(row.channelAccountId, row.marketplace)?.stopId ?? '-'}`;
  }

  private scopeEvaluationContext(row: ScopeRow, now: Instant): ScopeEvaluationContext {
    const since = Date.parse(now) - 3_600_000;
    // Р-61: себестоимость в валюте возникновения переводится в валюту единицы записи по курсу ЕЦБ на момент решения
    const converted = row.cost ? convertMinor(row.cost.unitCostMinor, row.cost.currency, row.currency, this.fxRates, now, 'UP') : null;
    const cost: CostInputs | null = row.cost && converted?.ok
      ? { ...row.cost, currency: row.currency, unitCostMinor: converted.amountMinor, fx: converted.fx }
      : null;
    const halt = this.activeHalt(row.channelAccountId, row.marketplace);
    const stop = this.activeStop(row.channelAccountId, row.marketplace);
    return {
      scope: this.context(row),
      bounds: this.boundsOf(row),
      contextVersion: this.contextVersion(row),
      cost,
      unitCostMinor: cost?.unitCostMinor ?? null,
      costUnavailableCause: converted && !converted.ok ? converted.cause : null,
      costMissingCause: !row.cost ? 'COST_PROFILE_MISSING' : converted && !converted.ok ? converted.cause : null,
      guardrails: { ...NO_GUARDRAILS, ...row.guardrails },
      channelHalt: halt ? InMemoryPricingStore.haltRef(halt) : null,
      channelDistrust: (() => { const d = this.activeDistrust(row.channelAccountId, row.marketplace); return d ? InMemoryPricingStore.distrustRef(d) : null; })(),
      priceStop: stop ? InMemoryPricingStore.stopRef(stop) : null,
      blocking: this.blocking(row),
      changesInLastHour: (row.changesLastHour ?? 0) + (this.changes.get(row.writeScopeId) ?? []).filter((at) => at >= since).length,
    };
  }

  // --- PricingStore: оценка ------------------------------------------------
  async loadEvaluationContext(_tenantId: string, key: ProductKey, now: Instant, shift: ShiftWindow): Promise<EvaluationContext> {
    const rows = this.scopesOfProduct(key.channelAccountId, productKey(key));
    const scopes = rows.map((r) => this.scopeEvaluationContext(r, now));
    const primary = scopes.find((s) => s.scope.pricingMode === 'ENGINE') ?? scopes[0] ?? null;
    const state = this.competitorState.get(productKey(key));
    const productRef = `${key.channelProductRef}|${key.condition}`;
    const halt = this.activeHalt(key.channelAccountId, key.marketplace);
    const storefront = this.marketplaces[key.marketplace];
    const sanity: SanityContext = {
      now,
      // Витрина не описана — сверять не с чем: любой снимок отклоняется как чужая валюта (fail-closed)
      expectedCurrency: primary?.scope.currency ?? storefront?.currency ?? '',
      expectedBasis: primary?.scope.basis ?? storefront?.basis ?? 'GROSS',
      unitCostMinor: primary?.unitCostMinor ?? null,
      crossChannel: this.crossChannel[productKey(key)] ?? [],
      fxRates: this.fxRates,
      competitorDaily: this.competitorDaily.get(productKey(key)) ?? [],
      lastAccepted: state ? { observedAt: state.observedAt, buyboxMinor: state.buyboxMinor, lowestMinor: state.lowestMinor, buyboxIsSelf: state.buyboxIsSelf ?? false } : null,
      ourPriceMinor: primary?.scope.currentPriceMinor ?? null,
      ourKnownPricesMinor: primary?.scope.knownPricesMinor ?? [],
      channel: {
        halt: halt ? { haltId: halt.haltId, haltedAt: halt.haltedAt, reasonCode: halt.reasonCode, marketplace: halt.marketplace } : null,
        ...this.shiftWindow(key.marketplace, productRef, now, shift),
      },
    };
    return { scopes, sanity };
  }

  async loadScopeContext(_tenantId: string, writeScopeId: string, now: Instant) {
    const row = this.scopes.get(writeScopeId);
    if (!row) return null;
    const state = this.competitorState.get(productKey(row));
    const snapshotRef: StoredSnapshotRef | null = state?.snapshot && state.competitorSnapshotId
      ? { competitorSnapshotId: state.competitorSnapshotId, source: state.snapshot.source, observedAt: state.observedAt, sanity: state.sanity }
      : null;
    return { context: this.scopeEvaluationContext(row, now), snapshot: state?.snapshot ?? null, snapshotRef };
  }

  private rememberMove(m: InMemoryPricingStore['moves'][number]): void {
    this.moves.push(m);
    const list = this.movesByMarketplace.get(m.marketplace) ?? [];
    this.movesByMarketplace.set(m.marketplace, list);
    // Вставка с сохранением порядка по времени (при равенстве — последним, как «последний записанный побеждает» прежнего обхода)
    const at = Date.parse(m.evaluatedAt);
    const entry = { at, seq: this.moveSeq++, move: m };
    let i = list.length;
    while (i > 0 && list[i - 1]!.at > at) i--;
    list.splice(i, 0, entry);
    const cached = this.windowCache.get(m.marketplace);
    if (cached && at >= cached.from && at <= cached.nowMs) {
      const previous = cached.latest.get(m.productRef);
      if (!previous || previous.at <= at) cached.latest.set(m.productRef, entry);
    }
  }

  /** Как PgPricingStore: последнее движение каждого товара за окно; в списке — только большие движения, число товаров — отдельно */
  private shiftWindow(marketplace: string, productRef: string, now: Instant, shift: ShiftWindow) {
    const nowMs = Date.parse(now);
    const from = nowMs - shift.windowSeconds * 1000;
    let cached = this.windowCache.get(marketplace);
    if (!cached || cached.nowMs !== nowMs || cached.from !== from) {
      const latest = new Map<string, { at: number; seq: number; move: InMemoryPricingStore['moves'][number] }>();
      const list = this.movesByMarketplace.get(marketplace) ?? [];
      // Первое движение позже момента оценки; обход назад до начала окна: первое встреченное движение товара — его последнее
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid]!.at <= nowMs) lo = mid + 1; else hi = mid;
      }
      for (let i = lo - 1; i >= 0 && list[i]!.at >= from; i--) {
        const e = list[i]!;
        if (!latest.has(e.move.productRef)) latest.set(e.move.productRef, e);
      }
      cached = { nowMs, from, latest };
      this.windowCache.set(marketplace, cached);
    }
    const up = Math.round(shift.minFactor * 10_000);
    const down = Math.round(10_000 / shift.minFactor);
    const big: Array<{ at: number; seq: number; move: InMemoryPricingStore['moves'][number] }> = [];
    for (const e of cached.latest.values()) {
      if (e.move.productRef !== productRef && (e.move.moveBp >= up || e.move.moveBp <= down)) big.push(e);
    }
    // Порядок — от нового к старому, как обход движений окна с конца
    big.sort((a, b) => b.at - a.at || b.seq - a.seq);
    return {
      recentMoves: big.map(({ move: m }) => ({ productRef: m.productRef, evaluatedAt: m.evaluatedAt, moveBp: m.moveBp, sellerRef: m.sellerRef })),
      windowProducts: cached.latest.size - (cached.latest.has(productRef) ? 1 : 0),
    };
  }

  /** Что изменилось в контексте решения между чтением и фиксацией — параметры BOUNDS_VERSION_CHANGED [Р-54] */
  private contextChange(read: ScopeEvaluationContext, row: ScopeRow): Reason {
    const now = this.boundsOf(row);
    const amount = (b: BoundResolution) => (b.status === 'RESOLVED' ? b.amountMinor : null);
    const same = (a: BoundResolution, b: BoundResolution) => a.status === b.status && amount(a) === amount(b) && JSON.stringify(a) === JSON.stringify(b);
    const changed: string[] = [];
    if (!same(read.bounds.min, now.min)) changed.push('MIN_PRICE');
    if (!same(read.bounds.max, now.max)) changed.push('MAX_PRICE');
    if ((read.channelHalt?.haltId ?? null) !== (this.activeHalt(row.channelAccountId, row.marketplace)?.haltId ?? null)) changed.push('CHANNEL_HALT');
    if ((read.channelDistrust?.distrustId ?? null) !== (this.activeDistrust(row.channelAccountId, row.marketplace)?.distrustId ?? null)) changed.push('CHANNEL_DISTRUST');
    if ((read.priceStop?.stopId ?? null) !== (this.activeStop(row.channelAccountId, row.marketplace)?.stopId ?? null)) changed.push('PRICING_STOP');
    return {
      code: 'BOUNDS_VERSION_CHANGED',
      params: {
        attempt: 1, changed: changed.join(','), oldMinMinor: amount(read.bounds.min), newMinMinor: amount(now.min),
        oldMaxMinor: amount(read.bounds.max), newMaxMinor: amount(now.max), currency: row.currency,
      },
    };
  }

  async commitEvaluation(_tenantId: string, input: EvaluationCommit): Promise<EvaluationCommitResult> {
    // Как PgPricingStore (OQ-171): уведомление уже в журнале — ничего не фиксируется
    if (input.notification && this.inboundNotifications.has(`${this.channel}|${input.notification.notificationId}`)) return { status: 'DUPLICATE_NOTIFICATION' };
    // Имитация параллельного изменения границ между чтением и фиксацией
    for (const d of input.decisions) {
      const i = this.conflicts.findIndex((c) => c.writeScopeId === d.context.scope.writeScopeId);
      if (i < 0) continue;
      const [c] = this.conflicts.splice(i, 1);
      const row = this.scope(c!.writeScopeId);
      if (c!.bound === 'min') row.minPrice = c!.value; else row.maxPrice = c!.value;
    }
    // Проверки до любых изменений: транзакция атомарна
    for (const d of input.decisions) {
      const row = this.scope(d.context.scope.writeScopeId);
      if (this.contextVersion(row) !== d.context.contextVersion) {
        return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: this.contextChange(d.context, row) };
      }
      if (d.decision.outcome === 'APPROVED' && d.decision.finalMinor !== null) {
        const recheck = assertWriteWithinBounds(d.decision.finalMinor, this.boundsOf(row), row.currency, row.basis);
        if (!recheck.ok) return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: recheck.reason };
        // Как assert_price_floor при вставке записи (0051): пол маржи по текущей себестоимости, курсу и НДС [Р-83]
        const floor = this.priceFloor(row, input.now);
        if (!floor.ok) {
          return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: { code: 'BOUND_UNRESOLVABLE', params: { bound: floor.cause === 'MISSING' ? 'min' : 'margin_floor', cause: floor.cause } } };
        }
        if (d.decision.finalMinor < floor.floorMinor) {
          return {
            status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId,
            reason: floor.marginFloorMinor !== null && floor.marginFloorMinor > floor.minMinor
              ? { code: 'BELOW_MARGIN_FLOOR', params: { proposedMinor: d.decision.finalMinor, floorMinor: floor.floorMinor, minMinor: floor.minMinor, minMarginBp: floor.minMarginBp!, currency: row.currency } }
              : { code: 'BELOW_MIN_PRICE', params: { proposedMinor: d.decision.finalMinor, minMinor: floor.minMinor, source: 'DATABASE', currency: row.currency } },
          };
        }
        const stop = this.activeStop(row.channelAccountId, row.marketplace);
        if (stop) {
          return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: InMemoryPricingStore.stopReason(stop, 'DATABASE') };
        }
        const distrust = this.activeDistrust(row.channelAccountId, row.marketplace);
        if (distrust) {
          return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: InMemoryPricingStore.distrustReason(distrust, 'DATABASE') };
        }
        const halt = this.activeHalt(row.channelAccountId, row.marketplace);
        if (InMemoryPricingStore.haltBlocks(halt, isCompetitorDerived(d.intent.ruleCode))) {
          return { status: 'CONTEXT_CHANGED', writeScopeId: row.writeScopeId, reason: InMemoryPricingStore.haltReason(halt, 'DATABASE', d.intent.ruleCode) };
        }
      }
    }

    let rejectedSnapshotId: string | null = null;
    let divergenceCaseId: string | null = null;
    const s = input.snapshot;
    if (s) {
      if (s.lossCheck) this.recordNotificationLossCheck(s.lossCheck);
      if (s.log) this.snapshotLog.push({ competitorSnapshotId: s.log.competitorSnapshotId, receivedAt: s.log.receivedAt, verdict: s.verdict, delivery: s.log.delivery, key: input.key, snapshot: s.log.snapshot });
      if (s.move) this.rememberMove({ marketplace: input.key.marketplace, productRef: s.move.productRef, evaluatedAt: input.now, moveBp: s.move.moveBp, verdict: s.verdict, sellerRef: s.move.sellerRef });
      if (s.accepted) this.acceptSnapshot(input.key, s.accepted.snapshot, s.accepted.competitorSnapshotId, s.accepted.sanity);
      if (s.rejected) {
        rejectedSnapshotId = this.id('rej');
        this.rejectedSnapshots.push({ ...s.rejected, key: input.key, rejectedSnapshotId });
      }
      if (s.halt && !this.halts.some((h) => h.releasedAt === null && h.channelAccountId === s.halt!.channelAccountId && h.marketplace === s.halt!.marketplace && h.reasonCode === s.halt!.reasonCode)) {
        const window = 1800;
        const haltId = this.id('halt');
        this.halts.push({ ...s.halt, haltId, rejectedSnapshotId, reviewWindowSeconds: window, nextReviewAt: new Date(Date.parse(s.halt.haltedAt) + window * 1000).toISOString(), releasedAt: null, releasedKind: null });
        this.auditHalt('pricing.halt_created', haltId, s.halt.haltedAt, null, null);
      }
      if (s.divergence && !this.divergenceCases.some((c) => c.writeScopeId === s.divergence!.writeScopeId && c.status === 'OPEN')) {
        divergenceCaseId = this.id('div');
        this.divergenceCases.push({ divergenceCaseId, writeScopeId: s.divergence.writeScopeId, expectedMinor: s.divergence.expectedMinor, observedMinor: s.divergence.observedMinor, cause: 'EXTERNAL_CHANGE', status: 'OPEN', openedAt: input.now });
      }
    }

    const committed: CommittedDecision[] = [];
    for (const d of input.decisions) {
      const row = this.scope(d.context.scope.writeScopeId);
      // Как CHECK price_decision_explanation_by_class (0044): слепок — у всех решений, кроме NO_OP; у NO_OP — только код причины [Р-74]
      const noChange = d.decision.decisionClass === 'NO_OP';
      if (noChange === Boolean(d.decision.explanation)) throw new Error(`decision for ${row.writeScopeId}: an explanation is required exactly when the decision is not NO_OP (Р-68, Р-74)`);
      if (noChange !== Boolean(d.decision.noChangeReason)) throw new Error(`decision for ${row.writeScopeId}: a reason code is required exactly for a NO_OP decision (Р-74)`);
      // Как триггер price_decision_snapshot_ref_guard (0048): у NO_OP нет ссылки на снимок (находка 10)
      if (noChange && d.snapshotRef) throw new Error(`decision for ${row.writeScopeId}: a NO_OP decision keeps no snapshot reference (Р-74)`);
      // Как CHECK price_decision_explanation_by_class (0049): слепок ссылается на профиль Gate столбцом [Р-80]
      if (!noChange && !d.decision.gateProfile) throw new Error(`decision for ${row.writeScopeId}: an explanation without its Gate profile column (Р-80)`);
      // Слепок ссылается на версию стратегии — она остаётся в справочнике [Р-75]
      if (d.context.scope.strategy && d.intent.strategyId === d.context.scope.strategy.strategyId) this.rememberStrategy(d.context.scope.strategy);
      const intentId = this.id('intent');
      this.intents.push({ ...d.intent, intentId });
      const decisionId = this.id('decision');
      this.decisions.push({
        ...d.decision, decisionId, intentId, snapshotRef: d.snapshotRef,
        // Как триггер price_decision_intent_columns (0049): столбцы intent — в решении, слепок их не повторяет [Р-80]
        strategyId: d.intent.strategyId, strategyVersion: d.intent.strategyVersion, ruleCode: d.intent.ruleCode, trigger: d.intent.trigger.type, proposedMinor: d.intent.proposedMinor,
      });
      if (d.decision.outcome !== 'APPROVED' || d.decision.finalMinor === null) {
        committed.push({ writeScopeId: row.writeScopeId, intentId, decisionId, write: null, pendingWriteId: null });
        continue;
      }
      row.priceVersion += 1;
      const scope = d.context.scope;
      const write: WriteRow = {
        channelWriteId: this.id('cw'), writeScopeId: row.writeScopeId, amountMinor: d.decision.finalMinor, currency: scope.currency, basis: scope.basis,
        version: row.priceVersion, decisionId, competitorDerived: isCompetitorDerived(d.intent.ruleCode), scopeKey: scope.scopeKey,
        identity: scope.identity, status: 'PENDING', attemptCount: 0, createdAt: input.now,
        dispatchedAt: null, acceptedAt: null, nextAttemptAt: null, lastErrorCode: null, endReason: null, endParams: {}, supersededByWriteId: null,
      };
      // Как триггеры channel_write (0036): новая версия вытесняет ждущие с причиной; при записи в полёте новая ждёт её завершения
      this.supersedeOlder(write);
      this.writes.push(write);
      this.writesById.set(write.channelWriteId, write);
      this.writesOf(write.writeScopeId).push(write);
      if (this.inFlight(row.writeScopeId)) {
        committed.push({ writeScopeId: row.writeScopeId, intentId, decisionId, write: null, pendingWriteId: write.channelWriteId });
        continue;
      }
      this.markDispatched(write, input.now);
      committed.push({ writeScopeId: row.writeScopeId, intentId, decisionId, pendingWriteId: null, write: this.toFieldWrite(write) });
    }
    if (input.notification) this.inboundNotifications.set(`${this.channel}|${input.notification.notificationId}`, { ...input.notification });
    return { status: 'COMMITTED', rejectedSnapshotId, divergenceCaseId, decisions: committed };
  }

  private static stopReason(stop: ConsoleStopRow, stage: 'DISPATCH' | 'DATABASE'): Reason {
    return {
      code: 'PRICING_STOPPED',
      params: { stopId: stop.stopId, scope: stop.scope, stoppedAt: stop.stoppedAt, stoppedBy: stop.stoppedByMembershipId, channelAccountId: stop.channelAccountId, marketplace: stop.marketplace, stage },
    };
  }

  private static haltReason(halt: HaltRow, stage: 'DISPATCH' | 'DATABASE', ruleCode?: string): Reason {
    return {
      code: 'CHANNEL_HALTED',
      params: { stage, haltId: halt.haltId, haltedAt: halt.haltedAt, haltReason: halt.reasonCode, marketplace: halt.marketplace, ...(ruleCode ? { ruleCode } : {}) },
    };
  }

  private acceptSnapshot(key: ProductKey, snapshot: AcceptedSnapshot, competitorSnapshotId: string, sanity: SanitySummary): void {
    const k = productKey(key);
    const previous = this.competitorState.get(k);
    // Более старый снимок проекцию не перезаписывает — как условие ON CONFLICT в PostgreSQL
    if (previous && Date.parse(previous.observedAt) > Date.parse(snapshot.observedAt)) return;
    const buybox = snapshot.buybox?.price.amountMinor ?? null;
    const competitors = snapshot.offers.filter((o) => !o.isSelf).map((o) => o.price.amountMinor);
    const lowest = competitors.length ? Math.min(...competitors) : null;
    this.competitorState.set(k, { observedAt: snapshot.observedAt, buyboxMinor: buybox, buyboxIsSelf: snapshot.buybox?.isSelf ?? false, lowestMinor: lowest, snapshot, competitorSnapshotId, sanity });
    const day = snapshot.observedAt.slice(0, 10);
    // История — цены конкурентов: наш собственный Buy Box в якорь не попадает [Р-49]
    const competitorBuybox = snapshot.buybox && !snapshot.buybox.isSelf ? buybox : null;
    const values = [competitorBuybox, lowest].filter((v): v is number => v !== null);
    if (values.length === 0) return;
    const days = this.competitorDaily.get(k) ?? [];
    const existing = days.find((d) => d.day === day);
    if (existing) {
      existing.minMinor = Math.min(existing.minMinor, ...values);
      existing.maxMinor = Math.max(existing.maxMinor, ...values);
    } else {
      days.push({ day, minMinor: Math.min(...values), maxMinor: Math.max(...values) });
    }
    this.competitorDaily.set(k, days);
  }

  async recordDispatch(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant): Promise<DispatchRecorded> {
    return this.recordOutcome(tenantId, write, outcome, now, DEFAULT_RETRY_POLICY);
  }

  // --- WriteQueueStore [Р-64]: те же правила, что PgWriteQueueStore и триггеры channel_write -------------
  private inFlight(writeScopeId: string): WriteRow | undefined {
    // Как write_scope_sync_state.in_flight_write_id (0051): принятая, но не применённая запись держит единицу до подтверждения [Р-64].
    // До шага 21 здесь был только DISPATCHED — симулятор с задержкой применения (K-15) показал, что стенд отправлял следующие цены
    // поверх неподтверждённой, а PostgreSQL их ждёт.
    return this.writesOf(writeScopeId).find((w) => w.status === 'DISPATCHED' || w.status === 'ACCEPTED');
  }

  private supersedeOlder(newer: WriteRow): void {
    for (const w of this.writesOf(newer.writeScopeId)) {
      if (w.version >= newer.version || !['PENDING', 'BLOCKED', 'FAILED'].includes(w.status)) continue;
      w.status = w.status === 'FAILED' ? 'DISCARDED_STALE' : 'SUPERSEDED';
      w.endReason = 'WRITE_SUPERSEDED_BY_NEWER_VERSION';
      w.endParams = { newerVersion: newer.version, newerWriteId: newer.channelWriteId };
      w.supersededByWriteId = newer.channelWriteId;
      w.nextAttemptAt = null;
    }
  }

  private markDispatched(w: WriteRow, now: Instant): void {
    w.status = 'DISPATCHED';
    w.attemptCount += 1;
    w.dispatchedAt = now;
    w.nextAttemptAt = null;
  }

  private end(w: WriteRow, status: 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED', reason: Reason<string>): void {
    w.status = status;
    w.endReason = reason.code;
    w.endParams = { ...reason.params };
    w.nextAttemptAt = null;
  }

  private toFieldWrite(w: WriteRow): FieldWrite {
    return {
      channelWriteId: w.channelWriteId as FieldWrite['channelWriteId'],
      writeScope: { writeScopeId: w.writeScopeId as FieldWrite['writeScope']['writeScopeId'], field: 'PRICE', scopeKey: w.scopeKey, identity: w.identity },
      version: w.version,
      idempotencyKey: `${w.writeScopeId}:${w.version}`,
      value: { field: 'PRICE', price: { amountMinor: w.amountMinor, currency: w.currency, basis: w.basis } },
      attemptNo: w.attemptCount,
    };
  }

  /**
   * Пол цены, вычисленный заново, — как tenant_data.effective_price_floor (0051) [Р-83]: min_price и пол маржи по текущим
   * себестоимости, комиссии, курсу ЕЦБ и ставке НДС. Минимальная маржа задана, а пол маржи не вычисляется — отказ.
   */
  private priceFloor(row: ScopeRow, now: Instant):
    | { ok: true; floorMinor: number; minMinor: number; marginFloorMinor: number | null; minMarginBp: number | null }
    | { ok: false; cause: (typeof BOUND_CAUSES)[number] } {
    const b = this.boundsOf(row);
    if (b.min.status !== 'RESOLVED') return { ok: false, cause: 'MISSING' };
    const minMinor = b.min.amountMinor;
    const minMarginBp = row.guardrails?.minMarginBp ?? null;
    if (minMarginBp === null) return { ok: true, floorMinor: minMinor, minMinor, marginFloorMinor: null, minMarginBp: null };
    const ctx = this.scopeEvaluationContext(row, now);
    if (!ctx.cost) return { ok: false, cause: (ctx.costMissingCause ?? 'COST_PROFILE_MISSING') as (typeof BOUND_CAUSES)[number] };
    const priced = storefrontPriceForMarginBp(ctx.cost, minMarginBp);
    if (!priced.ok) return { ok: false, cause: priced.cause };
    return { ok: true, floorMinor: Math.max(minMinor, priced.priceMinor), minMinor, marginFloorMinor: priced.priceMinor, minMarginBp };
  }

  private dispatchRefusal(w: WriteRow, now: Instant): { status: 'DISCARDED_STALE' | 'BLOCKED'; reason: Reason<string> } | null {
    const row = this.scope(w.writeScopeId);
    if (row.pricingMode !== 'ENGINE') return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_PRICING_MODE_CHANGED', params: { mode: row.pricingMode } } };
    if (row.status !== 'ACTIVE') {
      const code = `SCOPE_${row.status}`;
      return { status: 'BLOCKED', reason: { code: 'WRITE_SCOPE_BLOCKED', params: { code, action: sellerActionFor(code) } } };
    }
    // Р-69: остановка человеком — никакая цена не уходит, в том числе фиксированная и маржинальная
    const stop = this.activeStop(row.channelAccountId, row.marketplace);
    if (stop) return { status: 'DISCARDED_STALE', reason: InMemoryPricingStore.stopReason(stop, 'DISPATCH') };
    const b = this.boundsOf(row);
    const ceiling = b.max.status === 'RESOLVED' ? b.max.amountMinor : null;
    const priced = this.priceFloor(row, now);
    if (!priced.ok) {
      return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor: w.amountMinor, floorMinor: null, ceilingMinor: null, violated: 'FLOOR_UNRESOLVABLE', cause: priced.cause, currency: w.currency } } };
    }
    const floor = priced.floorMinor;
    if (w.amountMinor < floor) {
      return {
        status: 'DISCARDED_STALE',
        reason: {
          code: 'WRITE_BLOCKED_BY_BOUND_RECHECK',
          params: {
            amountMinor: w.amountMinor, floorMinor: floor, ceilingMinor: ceiling, violated: 'FLOOR', minMinor: priced.minMinor,
            ...(priced.marginFloorMinor !== null ? { marginFloorMinor: priced.marginFloorMinor, minMarginBp: priced.minMarginBp! } : {}), currency: w.currency,
          },
        },
      };
    }
    if (ceiling === null || w.amountMinor > ceiling) {
      return { status: 'DISCARDED_STALE', reason: { code: 'WRITE_BLOCKED_BY_BOUND_RECHECK', params: { amountMinor: w.amountMinor, floorMinor: floor, ceilingMinor: ceiling, violated: 'CEILING', currency: w.currency } } };
    }
    const distrust = this.activeDistrust(row.channelAccountId, row.marketplace);
    if (distrust) return { status: 'DISCARDED_STALE', reason: InMemoryPricingStore.distrustReason(distrust, 'DISPATCH') };
    const halt = this.activeHalt(row.channelAccountId, row.marketplace);
    if (InMemoryPricingStore.haltBlocks(halt, w.competitorDerived)) return { status: 'DISCARDED_STALE', reason: InMemoryPricingStore.haltReason(halt, 'DISPATCH') };
    return null;
  }

  async claimNext(_tenantId: string, writeScopeId: string, now: Instant, policy: RetryPolicy): Promise<ClaimResult> {
    const row = this.scopes.get(writeScopeId);
    if (!row) return { kind: 'IDLE' };
    const flying = this.inFlight(writeScopeId);
    if (flying) {
      const since = flying.acceptedAt ?? flying.dispatchedAt ?? now;
      const reconcileDue = flying.nextAttemptAt
        ? Date.parse(flying.nextAttemptAt) <= Date.parse(now)
        : Date.parse(since) + policy.inFlightTimeoutMs <= Date.parse(now);
      return { kind: 'IN_FLIGHT', channelAccountId: row.channelAccountId, write: this.toFieldWrite(flying), status: flying.status as 'DISPATCHED' | 'ACCEPTED', since, reconcileDue };
    }
    const candidate = this.writesOf(writeScopeId)
      .filter((w) => w.status === 'PENDING' || w.status === 'FAILED')
      .sort((a, b) => b.version - a.version)[0];
    if (!candidate) return { kind: 'IDLE' };
    if (candidate.status === 'FAILED') {
      if (!candidate.nextAttemptAt) return { kind: 'IDLE' };
      if (Date.parse(candidate.nextAttemptAt) > Date.parse(now)) return { kind: 'RETRY_LATER', channelWriteId: candidate.channelWriteId, at: candidate.nextAttemptAt };
      if (candidate.attemptCount >= policy.maxAttempts) {
        const reason = { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: candidate.attemptCount, code: 'MAX_ATTEMPTS' } };
        this.end(candidate, 'DISCARDED_STALE', reason);
        return { kind: 'ENDED', channelWriteId: candidate.channelWriteId, status: 'DISCARDED_STALE', reason };
      }
    }
    const refusal = this.dispatchRefusal(candidate, now);
    if (refusal) {
      if (refusal.status === 'BLOCKED') {
        if (candidate.status === 'PENDING') {
          candidate.status = 'BLOCKED';
          candidate.lastErrorCode = String(refusal.reason.params.code);
        }
      } else {
        this.end(candidate, refusal.status, refusal.reason);
      }
      return { kind: 'ENDED', channelWriteId: candidate.channelWriteId, status: refusal.status, reason: refusal.reason };
    }
    this.markDispatched(candidate, now);
    return { kind: 'DISPATCH', channelAccountId: row.channelAccountId, write: this.toFieldWrite(candidate) };
  }

  async recordOutcome(_tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome> {
    const w = this.writesById.get(write.channelWriteId);
    if (!w || w.status !== 'DISPATCHED') return this.recorded(write.writeScope.writeScopeId, (w?.status ?? 'APPLIED') as RecordedOutcome['status'], null, null, false);
    return this.apply(w, 'DISPATCHED', planOutcomeTransition(outcome, w.attemptCount, now, policy), now, 'PRE_WRITE_READ');
  }

  /** Как channel_data.offer_channel_pricing_active (0082): последнее наблюдение оффера — правило или границы канала */
  private channelPricingActive(row: ScopeRow): boolean {
    if (this.channel === 'KAUFLAND') return false;
    const latest = this.offerChannelPricing
      .filter((o) => o.channelAccountId === row.channelAccountId && o.marketplace === row.marketplace && o.externalSku === row.externalUnitId)
      .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
    return latest !== undefined && (latest.automatedPricing || latest.channelBounds);
  }

  async recordOfferChannelPricing(_tenantId: string, channelAccountId: string, observations: readonly OfferChannelPricingObservation[]): Promise<number> {
    for (const o of observations) this.offerChannelPricing.push({ ...o, channelAccountId });
    return observations.length;
  }

  async recordPricingHealth(_tenantId: string, channelAccountId: string, health: PricingHealthObservation, notification?: InboundNotificationEntry): Promise<'RECORDED' | 'DUPLICATE_NOTIFICATION'> {
    if (notification) {
      const key = `${this.channel}|${notification.notificationId}`;
      if (this.inboundNotifications.has(key)) return 'DUPLICATE_NOTIFICATION';
      this.inboundNotifications.set(key, { ...notification });
    }
    this.pricingHealth.push({
      channelAccountId, marketplace: health.marketplace, channelProductRef: health.channelProductRef, condition: health.condition, issueType: health.issueType,
      occurredAt: health.occurredAt, competitivePriceThreshold: health.competitivePriceThreshold,
    });
    return 'RECORDED';
  }

  async wasNotificationProcessed(_tenantId: string, _channelAccountId: string, notificationId: string): Promise<boolean> {
    return this.inboundNotifications.has(`${this.channel}|${notificationId}`);
  }

  async markNotificationProcessed(_tenantId: string, entry: InboundNotificationEntry): Promise<void> {
    const key = `${this.channel}|${entry.notificationId}`;
    if (!this.inboundNotifications.has(key)) this.inboundNotifications.set(key, { ...entry });
  }

  /** Как PgWriteQueueStore.checkPriceBasis: ставка — товара или страны витрины; недоверие каналу — одно на витрину и причину [Р-118] */
  async checkPriceBasis(_tenantId: string, write: FieldWrite, observedMinor: number, now: Instant): Promise<PriceBasisDistrust | null> {
    if (write.value.field !== 'PRICE') return null;
    const row = this.scopes.get(write.writeScope.writeScopeId);
    if (!row) return null;
    // Как tenant_data.effective_vat_rate_bp: ставка товара, иначе ставка страны витрины по умолчанию [Р-53] (ревью шага 22, находка 9)
    const vatRateBp = row.taxRegime !== 'VAT_INCLUDED' ? null
      : row.cost?.tax.regime === 'VAT_INCLUDED' ? row.cost.tax.vatRateBp : DEFAULT_VAT_BP[row.marketplace] ?? null;
    const sentMinor = write.value.price.amountMinor;
    const basisError = priceBasisMismatch(sentMinor, observedMinor, vatRateBp);
    if (!basisError) return null;
    const reason: Reason = {
      code: 'CHANNEL_PRICE_BASIS_MISMATCH',
      params: { basisError, vatRateBp: vatRateBp!, sentMinor, observedMinor, currency: write.value.price.currency, writeScopeId: row.writeScopeId, marketplace: row.marketplace },
    };
    let d = this.distrusts.find((x) => x.releasedAt === null && x.channelAccountId === row.channelAccountId && x.marketplace === row.marketplace && x.reasonCode === 'PRICE_BASIS_MISMATCH');
    if (!d) {
      d = {
        distrustId: this.id('distrust'), channelAccountId: row.channelAccountId, marketplace: row.marketplace, reasonCode: 'PRICE_BASIS_MISMATCH', detectedAt: now,
        // В остановке только наши значения: цена покупателя из канала не хранится (ревью шага 22, находка 10)
        details: Object.fromEntries(Object.entries(reason.params).filter(([k]) => k !== 'observedMinor')),
        releasedAt: null, releasedByMembershipId: null, releaseNote: null,
      };
      this.distrusts.push(d);
      this.auditDistrust('pricing.distrust_created', d, null);
    }
    return { distrustId: d.distrustId, reason };
  }

  /** Как channel_distrust_release_guard (0082): право RELEASE_CHANNEL_DISTRUST, пользователь сессии, второй фактор, заметка */
  async releaseDistrust(_tenantId: string, distrustId: string, release: { membershipId: string; userId: string; mfa: boolean; note: string; at: Instant }): Promise<'RELEASED' | 'NOT_ACTIVE'> {
    const d = this.distrusts.find((x) => x.distrustId === distrustId);
    if (!d || d.releasedAt !== null) return 'NOT_ACTIVE';
    const m = this.member(release.membershipId);
    if (!m || !can(m.role, 'RELEASE_CHANNEL_DISTRUST')) throw new Error(`membership ${release.membershipId} may not release a channel distrust (Р-118)`);
    if (m.userId !== release.userId) throw new Error(`membership ${release.membershipId} is not the membership of the session user`);
    if (!release.mfa) throw new Error(`releasing channel distrust ${distrustId} requires a second factor (Р-118, Р-88)`);
    if (!NOTE_OK(release.note)) throw new Error('releasing a channel distrust requires a note of 10 to 2000 characters');
    d.releasedAt = release.at;
    d.releasedByMembershipId = m.membershipId;
    d.releaseNote = release.note;
    this.auditDistrust('pricing.distrust_released', d, m);
    return 'RELEASED';
  }

  /** Как channel_distrust_audit (0082): создание — актор SYSTEM, снятие — участник с ролью и заметкой [Р-76] */
  private auditDistrust(action: 'pricing.distrust_created' | 'pricing.distrust_released', d: ConsoleDistrustRow, m: ConsoleMemberRow | null): void {
    this.audit.push({
      at: action === 'pricing.distrust_created' ? d.detectedAt : d.releasedAt!, action, actorType: m ? 'USER' : 'SYSTEM', membershipId: m?.membershipId ?? null, role: m?.role ?? null,
      entityType: 'channel_distrust', entityId: d.distrustId, scope: d.marketplace === null ? 'CHANNEL_ACCOUNT' : 'STOREFRONT', channelAccountId: d.channelAccountId,
      marketplace: d.marketplace, note: m ? d.releaseNote : null,
    });
  }

  async recordReconciliation(_tenantId: string, write: FieldWrite, result: Reconciliation, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome> {
    const w = this.writesById.get(write.channelWriteId);
    if (!w || (w.status !== 'DISPATCHED' && w.status !== 'ACCEPTED')) {
      return this.recorded(write.writeScope.writeScopeId, (w?.status ?? 'APPLIED') as RecordedOutcome['status'], null, null, false);
    }
    const since = w.acceptedAt ?? w.dispatchedAt ?? now;
    return this.apply(w, w.status, planReconciliationTransition(w.status, result, w.attemptCount, since, now, policy), now, 'READBACK');
  }

  /** Как PgWriteQueueStore.observeChannelPricing (ревью шага 23, находка 2): найденное ценообразование канала — наблюдение оффера [Р-120] */
  private observeChannelPricing(w: WriteRow, errorCode: string, source: 'PRE_WRITE_READ' | 'READBACK', now: Instant): void {
    if (errorCode !== 'CHANNEL_REPRICER_ACTIVE' && errorCode !== 'CHANNEL_BOUNDS_PRESENT') return;
    const row = this.scope(w.writeScopeId);
    this.offerChannelPricing.push({
      channelAccountId: row.channelAccountId, marketplace: row.marketplace, externalSku: row.externalUnitId,
      automatedPricing: errorCode === 'CHANNEL_REPRICER_ACTIVE', channelBounds: errorCode === 'CHANNEL_BOUNDS_PRESENT', source, observedAt: now,
    });
  }

  private apply(w: WriteRow, from: 'DISPATCHED' | 'ACCEPTED', t: OutcomeTransition, now: Instant, source: 'PRE_WRITE_READ' | 'READBACK'): RecordedOutcome {
    let nextAttemptAt: Instant | null = null;
    let reason: Reason<string> | null = null;
    let scopeBlocked = false;
    switch (t.to) {
      case 'ACCEPTED':
        w.acceptedAt = w.acceptedAt ?? now;
        w.nextAttemptAt = null;
        if (from === 'DISPATCHED') w.lastErrorCode = null;
        w.status = t.applied ? 'APPLIED' : 'ACCEPTED';
        reason = t.reason;
        if (from === 'DISPATCHED') this.priceAccepted(w, now);
        break;
      case 'RETRY':
        w.status = 'FAILED';
        w.lastErrorCode = t.errorCode;
        w.nextAttemptAt = t.nextAttemptAt;
        nextAttemptAt = t.nextAttemptAt;
        reason = t.reason;
        break;
      case 'RECONCILE':
        w.lastErrorCode = t.errorCode;
        w.nextAttemptAt = t.nextAttemptAt;
        nextAttemptAt = t.nextAttemptAt;
        break;
      case 'DISCARD':
        w.lastErrorCode = t.errorCode;
        this.end(w, 'DISCARDED_STALE', t.reason);
        reason = t.reason;
        break;
      case 'BUDGET_EXHAUSTED':
        w.lastErrorCode = t.errorCode;
        this.end(w, 'BUDGET_EXHAUSTED', t.reason);
        reason = t.reason;
        break;
      case 'BLOCK_SCOPE':
        w.status = 'FAILED';
        w.lastErrorCode = t.errorCode;
        w.nextAttemptAt = null;
        this.scope(w.writeScopeId).status = 'BLOCKED';
        this.observeChannelPricing(w, t.errorCode, source, now);
        reason = t.reason;
        scopeBlocked = true;
        break;
      case 'UNRESOLVED':
        // Как PgWriteQueueStore (D1): сверка прекращается, единица — до разбора человеком
        if (from === 'DISPATCHED') w.status = 'FAILED';
        w.lastErrorCode = t.errorCode;
        w.nextAttemptAt = null;
        this.scope(w.writeScopeId).status = 'BLOCKED';
        this.observeChannelPricing(w, t.errorCode, source, now);
        reason = t.reason;
        scopeBlocked = true;
        break;
      case 'NOT_APPLIED':
        w.status = 'NOT_APPLIED';
        w.nextAttemptAt = null;
        reason = t.reason;
        // Как price_history_mark_not_applied (0091, риск 28)
        for (const h of this.priceHistory) if (h.channelWriteId === w.channelWriteId) h.notApplied = true;
        break;
    }
    return this.recorded(w.writeScopeId, w.status as RecordedOutcome['status'], nextAttemptAt, reason, scopeBlocked);
  }

  private priceAccepted(w: WriteRow, now: Instant): void {
    const scope = this.scope(w.writeScopeId);
    scope.currentPriceMinor = w.amountMinor;
    scope.knownPricesMinor = [...new Set([w.amountMinor, ...scope.knownPricesMinor])].slice(0, 3);
    this.priceHistory.push({ writeScopeId: scope.writeScopeId, acceptedAt: now, amountMinor: w.amountMinor, currency: scope.currency, basis: scope.basis, channelWriteId: w.channelWriteId });
    const changes = this.changes.get(scope.writeScopeId) ?? [];
    this.changes.set(scope.writeScopeId, changes);
    changes.push(Date.parse(now));
  }

  private recorded(writeScopeId: string, status: RecordedOutcome['status'], nextAttemptAt: Instant | null, reason: Reason<string> | null, scopeBlocked: boolean): RecordedOutcome {
    const slotFreed = !this.inFlight(writeScopeId);
    const queuedWaiting = slotFreed && this.writesOf(writeScopeId).some((x) => x.status === 'PENDING');
    return { status, slotFreed, queuedWaiting, nextAttemptAt, reason, scopeBlocked };
  }

  async dueScopes(now: Instant, options: { pendingMinAgeMs: number; inFlightTimeoutMs: number; limit: number }): Promise<DueScope[]> {
    const nowMs = Date.parse(now);
    const due: DueScope[] = [];
    for (const row of this.scopes.values()) {
      const scopeWrites = this.writesOf(row.writeScopeId);
      const flying = scopeWrites.find((w) => w.status === 'DISPATCHED' || w.status === 'ACCEPTED');
      const push = (dueKind: DueKind, dueSince: Instant) => due.push({ tenantId: this.tenantId, writeScopeId: row.writeScopeId, dueKind, dueSince });
      const pending = scopeWrites.filter((w) => w.status === 'PENDING' && Date.parse(w.createdAt) <= nowMs - options.pendingMinAgeMs);
      if (!flying && pending.length > 0) push('PENDING', pending.map((w) => w.createdAt).sort()[0]!);
      // Как maintenance.due_write_scopes (0055, D2): повтор и сверка — только в действующей единице; удержанная ждёт человека
      const active = row.status === 'ACTIVE';
      for (const w of scopeWrites) if (active && w.nextAttemptAt && Date.parse(w.nextAttemptAt) <= nowMs) push(w.status === 'FAILED' ? 'RETRY' : 'RECONCILE', w.nextAttemptAt);
      if (active && flying && !flying.nextAttemptAt && Date.parse(flying.acceptedAt ?? flying.dispatchedAt ?? now) <= nowMs - options.inFlightTimeoutMs) {
        push('IN_FLIGHT_STALE', flying.dispatchedAt ?? now);
      }
    }
    return due.sort((a, b) => Date.parse(a.dueSince) - Date.parse(b.dueSince)).slice(0, options.limit);
  }

  // --- PricingStore: включение репрайсинга ----------------------------------
  async getPriceScope(_tenantId: string, writeScopeId: string): Promise<PriceScopeContext | null> {
    const row = this.scopes.get(writeScopeId);
    return row ? this.context(row) : null;
  }

  async resolveBounds(_tenantId: string, writeScopeId: string): Promise<BoundsRead> {
    const row = this.scope(writeScopeId);
    return { bounds: this.boundsOf(row), version: this.contextVersion(row) };
  }

  async setPricingMode(_tenantId: string, writeScopeId: string, mode: PriceScopeContext['pricingMode'], _userId?: string): Promise<void> {
    const row = this.scope(writeScopeId);
    if (mode === 'ENGINE') this.assertBounds(row);
    // Как CHECK write_scope_engine_has_strategy (0045): движок без стратегии не включается [Р-77]
    if (mode === 'ENGINE' && !row.strategy) throw new Error(`write scope ${writeScopeId} has no strategy; ENGINE cannot be enabled (Р-77)`);
    // Как write_scope_strategy_guard (0082): включение ENGINE при ценообразовании канала — отказ; выключение — всегда [Р-120]
    if (mode === 'ENGINE' && row.pricingMode !== 'ENGINE' && this.channelPricingActive(row)) {
      const latest = this.offerChannelPricing.filter((o) => o.channelAccountId === row.channelAccountId && o.marketplace === row.marketplace && o.externalSku === row.externalUnitId)
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0]!;
      throw new Error(`write_scope ${writeScopeId} has channel-owned pricing (${latest.automatedPricing ? 'CHANNEL_REPRICER_ACTIVE' : 'CHANNEL_BOUNDS_PRESENT'}): a strategy cannot be assigned (Р-120)`);
    }
    row.pricingMode = mode;
  }

  // --- PricingStore: правка границ и стратегий из консоли (шаг 21) ---------------
  // --- Omnibus [Р-123] (шаг 24): как tenant_data.omnibus_lowest_prior_price и discount_announcement_guard (0087) -------------
  private timeZoneOf(writeScopeId: string): string | null {
    return this.marketplaces[this.scope(writeScopeId).marketplace]?.timeZone || null;
  }

  async omnibusCheck(_tenantId: string, writeScopeId: string, startsAt: Instant): Promise<OmnibusPriorPrice> {
    // Как omnibus_lowest_prior_price (0091): цены, которые канал не применил, не учитываются; цены мимо нас — кейсы расхождения
    return omnibusLowestPriorPrice(this.priceHistory.filter((h) => h.writeScopeId === writeScopeId && !h.notApplied), this.timeZoneOf(writeScopeId), startsAt, new Date().toISOString(), {
      connectedAt: this.scopeConnectedAt.get(writeScopeId) ?? null,
      external: this.divergenceCases.filter((c) => c.writeScopeId === writeScopeId).map((c) => ({ at: c.openedAt, amountMinor: c.observedMinor })),
    });
  }

  async announceDiscount(_tenantId: string, input: DiscountAnnouncementInput, actor: AdminActor): Promise<DiscountAnnounceResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    const row = this.scopes.get(input.writeScopeId);
    if (!row) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
    if (row.currency !== input.currency) return { status: 'INVALID', cause: 'CURRENCY_MISMATCH' };
    if (!(input.salePriceMinor > 0 && input.referencePriceMinor > input.salePriceMinor)) return { status: 'INVALID', cause: 'PRICES_INVALID' };
    if (input.endsAt !== null && Date.parse(input.endsAt) <= Date.parse(input.startsAt)) return { status: 'INVALID', cause: 'PERIOD_INVALID' };
    // Как discount_announcement_guard: начало — не раньше текущих суток витрины (без пояса — суток UTC)
    const tz = this.timeZoneOf(input.writeScopeId) ?? 'UTC';
    if (Date.parse(input.startsAt) < zonedDayStart(localDate(Date.now(), tz), tz)) return { status: 'INVALID', cause: 'STARTS_BEFORE_TODAY' };
    const check = await this.omnibusCheck('', input.writeScopeId, input.startsAt);
    if (omnibusVerdict(check, input.referencePriceMinor) === 'VIOLATION') return { status: 'VIOLATION', check };
    const announcement: DiscountAnnouncementRow = {
      ...input, announcementId: this.id('discount'), createdAt: new Date().toISOString(), createdByMembershipId: actor.membershipId, check,
    };
    this.discounts.push(announcement);
    return { status: 'ANNOUNCED', announcement };
  }

  async discountAnnouncements(_tenantId: string): Promise<DiscountAnnouncementRow[]> {
    return [...this.discounts].sort((a, b) => Date.parse(b.startsAt) - Date.parse(a.startsAt)).map((d) => ({ ...d, check: { ...d.check } }));
  }

  async priceEvidence(_tenantId: string, range: { from: string; to: string; writeScopeIds?: string[] }): Promise<PriceEvidenceDay[]> {
    const days = new Map<string, PriceEvidenceDay>();
    for (const h of this.priceHistory) {
      if (range.writeScopeIds && !range.writeScopeIds.includes(h.writeScopeId)) continue;
      const tz = this.timeZoneOf(h.writeScopeId);
      if (!tz) continue;
      const day = localDate(h.acceptedAt, tz);
      if (day < range.from || day > range.to) continue;
      const key = `${h.writeScopeId}|${day}`;
      const d = days.get(key);
      if (!d) {
        days.set(key, { writeScopeId: h.writeScopeId, day, timeZone: tz, currency: h.currency, basis: h.basis, minMinor: h.amountMinor, maxMinor: h.amountMinor, firstMinor: h.amountMinor,
          lastMinor: h.amountMinor, changes: 1, source: 'OPEN', corrected: false, correctionReason: null });
      } else {
        d.minMinor = Math.min(d.minMinor, h.amountMinor);
        d.maxMinor = Math.max(d.maxMinor, h.amountMinor);
        d.lastMinor = h.amountMinor;
        d.changes += 1;
      }
    }
    return [...days.values()].sort((a, b) => a.writeScopeId.localeCompare(b.writeScopeId) || a.day.localeCompare(b.day));
  }

  /**
   * Второй фактор задания [Р-139]: модель в памяти обязана повторять базу, иначе тест на стенде зеленеет там, где база
   * отказывает (находка 17 ревью шага 30). Проверяются те же три условия: вид задания, живая аренда и второй фактор при его
   * создании — непустого идентификатора недостаточно.
   */
  private jobSecondFactor(actor: AdminActor, kinds: readonly BulkJobKind[]): boolean {
    if (!actor.bulkJobId) return false;
    const job = this.bulkJobs.find((j) => j.jobId === actor.bulkJobId);
    return job !== undefined && job.createdWithMfa && job.status === 'RUNNING'
      && job.leaseUntil !== null && Date.parse(job.leaseUntil) > Date.now() && kinds.includes(job.kind);
  }

  private adminMember(actor: AdminActor): ConsoleMemberRow | null {
    const m = this.member(actor.membershipId);
    // Как security.admin_write_action (0068): действие человека с его ролью; автор — пользователь сессии
    return m && m.userId === actor.userId && can(m.role, 'MANAGE_PRICING') ? m : null;
  }

  async editBounds(_tenantId: string, edits: readonly BoundsEditInput[], actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<BoundsEditResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    const ids = edits.map((e) => e.writeScopeId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) return { status: 'INVALID', writeScopeId: duplicate, cause: 'DUPLICATE_SCOPE' };
    // Р-88: массовая правка границ — больше одной единицы записи — только со вторым фактором
    if (mode === 'APPLY' && new Set(ids).size > 1 && !actor.mfa && !this.jobSecondFactor(actor, ['COST_IMPORT', 'BOUNDS_EDIT'])) return { status: 'MFA_REQUIRED' };
    const effective = (row: ScopeRow) => {
      const b = this.boundsOf(row);
      return { minMinor: b.min.status === 'RESOLVED' ? b.min.amountMinor : null, maxMinor: b.max.status === 'RESOLVED' ? b.max.amountMinor : null };
    };
    const rows: BoundsEditRow[] = [];
    const planned: Array<{ row: ScopeRow; min: SeedBound | null | undefined; max: SeedBound | null | undefined }> = [];
    for (const e of edits) {
      const row = this.scopes.get(e.writeScopeId);
      if (!row) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'SCOPE_NOT_FOUND' };
      if (e.minMinor === undefined && e.maxMinor === undefined) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'NOTHING_TO_CHANGE' };
      if ([e.minMinor, e.maxMinor].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v <= 0))) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'AMOUNT_INVALID' };
      const before = effective(row);
      if (before.minMinor !== e.expected.minMinor || before.maxMinor !== e.expected.maxMinor) return { status: 'CONFLICT', writeScopeId: e.writeScopeId, actual: before };
      const version = (b: SeedBound | null | undefined, kind: 'min' | 'max') => `${kind}-${row.writeScopeId}-v${Number((b?.id ?? '').match(/-v(\d+)$/)?.[1] ?? 1) + 1}`;
      const min = e.minMinor === undefined ? row.minPrice : { amountMinor: e.minMinor, id: version(row.minPrice, 'min') };
      const max = e.maxMinor === undefined ? row.maxPrice : { amountMinor: e.maxMinor, id: version(row.maxPrice, 'max') };
      const after = effective({ ...row, minPrice: min ?? null, maxPrice: max ?? null });
      // Как отложенная проверка write_scope_requires_min_price (0030): у включённой единицы пол не выше потолка
      if (after.minMinor !== null && after.maxMinor !== null && after.minMinor > after.maxMinor) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'MIN_ABOVE_MAX' };
      rows.push({ writeScopeId: row.writeScopeId, currency: row.currency, before, after });
      planned.push({ row, min, max });
    }
    if (mode === 'APPLY') for (const p of planned) { p.row.minPrice = p.min ?? null; p.row.maxPrice = p.max ?? null; }
    return { status: mode === 'APPLY' ? 'APPLIED' : 'PREVIEWED', rows };
  }

  /**
   * Р-134, Р-135 (шаг 28): массовый импорт себестоимости в памяти ведёт себя как база: предпросмотр ничего не меняет, применение
   * требует второго фактора и применяется целиком — ни одной строки, если хоть одна не годится.
   */
  /**
   * Р-139 (шаг 30): фоновые задания в памяти — для стенда. Аренда, ход и итог ведут себя как в базе: задание берётся одним
   * исполнителем, ход виден во время работы, а прерванное задание возвращается в очередь.
   */
  private readonly bulkJobs: BulkJobRow[] = [];
  private readonly bulkArtifacts = new Map<string, BulkJobArtifact>();

  async createBulkJob(_tenantId: string, input: BulkJobInput, actor: AdminActor): Promise<BulkJobCreated> {
    /**
     * Право — по тому, что задание ДЕЛАЕТ. Выгрузка доказательной истории [Р-123] ничего не меняет и нужна тому, кто отвечает
     * за спор о скидке: её создаёт и зритель. Задания, меняющие цены, — только участник с правом и со вторым фактором [Р-135].
     */
    const readOnly = READ_ONLY_JOB_KINDS.includes(input.kind);
    const member = readOnly ? this.member(actor.membershipId) : this.adminMember(actor);
    if (!member || member.userId !== actor.userId) return { status: 'FORBIDDEN' };
    // Второй фактор при создании обязателен только у импорта: он массовый всегда [Р-134, находка 4 ревью шага 30]
    if (input.kind === 'COST_IMPORT' && !actor.mfa) return { status: 'MFA_REQUIRED' };
    // OQ-207: предел очереди тенанта — тот же, что в базе (0111). Модель обязана повторять базу, иначе стенд слабее её
    const waiting = this.bulkJobs.filter((j) => j.status === 'PENDING' || j.status === 'RUNNING' || j.status === 'INTERRUPTED');
    if (waiting.length >= BULK_JOB_QUEUE_LIMIT) return { status: 'QUEUE_FULL' };
    // Предел участника меньше общего: один не занимает очередь тенанта [находка 14 ревью шага 31]
    if (waiting.filter((j) => j.createdByMembershipId === actor.membershipId).length >= BULK_JOB_MEMBER_QUEUE_LIMIT) return { status: 'QUEUE_FULL' };
    const createdAt = new Date().toISOString();
    const job: BulkJobRow = {
      jobId: `job-${this.bulkJobs.length + 1}-${Date.now().toString(36)}`, kind: input.kind, status: 'PENDING', params: input.params, phase: 'PREPARING',
      totalItems: input.totalItems ?? null, doneItems: 0, result: null, errorCode: null, attempts: 0,
      createdWithMfa: actor.mfa === true, createdByMembershipId: actor.membershipId, createdByUserId: actor.userId, createdAt,
      startedAt: null, finishedAt: null, leaseOwner: null, leaseUntil: null, leaseExpired: false,
    };
    this.bulkJobs.push(job);
    return { status: 'CREATED', jobId: job.jobId, createdAt };
  }

  async claimBulkJob(_tenantId: string, owner: string, leaseSeconds: number): Promise<BulkJobRow | null> {
    const now = Date.now();
    const job = this.bulkJobs.find((j) => j.status === 'PENDING' || j.status === 'INTERRUPTED'
      || (j.status === 'RUNNING' && j.leaseUntil !== null && Date.parse(j.leaseUntil) <= now));
    if (!job) return null;
    job.status = 'RUNNING';
    job.leaseOwner = owner;
    job.leaseUntil = new Date(now + leaseSeconds * 1000).toISOString();
    job.startedAt = job.startedAt ?? new Date().toISOString();
    job.attempts += 1;
    job.phase = 'PREPARING';
    job.doneItems = 0;
    return { ...job };
  }

  async updateBulkJobProgress(_tenantId: string, jobId: string, owner: string, progress: BulkJobProgress): Promise<boolean> {
    const job = this.bulkJobs.find((j) => j.jobId === jobId && j.leaseOwner === owner && j.status === 'RUNNING');
    if (!job) return false;
    if (progress.phase !== undefined) job.phase = progress.phase;
    if (progress.done !== undefined) job.doneItems = progress.done;
    if (progress.total !== undefined) job.totalItems = progress.total;
    job.leaseUntil = new Date(Date.now() + (progress.leaseSeconds ?? 60) * 1000).toISOString();
    return true;
  }

  async finishBulkJob(_tenantId: string, jobId: string, owner: string, outcome: BulkJobOutcome): Promise<boolean> {
    const job = this.bulkJobs.find((j) => j.jobId === jobId && j.leaseOwner === owner);
    if (!job) return false;
    if (outcome.status === 'INTERRUPTED') {
      job.status = 'INTERRUPTED';
      job.leaseOwner = null;
      job.leaseUntil = null;
      job.phase = null;
      return true;
    }
    job.status = outcome.status;
    job.result = outcome.result ?? null;
    job.errorCode = outcome.status === 'FAILED' ? outcome.errorCode : null;
    job.phase = 'DONE';
    job.finishedAt = new Date().toISOString();
    job.leaseOwner = null;
    job.leaseUntil = null;
    return true;
  }

  async bulkJobArtifactSummaries(_tenantId: string, jobIds: readonly string[]): Promise<Map<string, { fileName: string; rows: number; sha256: string }>> {
    return new Map([...this.bulkArtifacts.entries()].filter(([jobId]) => jobIds.includes(jobId))
      .map(([jobId, a]) => [jobId, { fileName: a.fileName, rows: a.rows, sha256: a.sha256 }]));
  }

  async cancelBulkJob(_tenantId: string, jobId: string, actor: AdminActor): Promise<'CANCELLED' | 'NOT_WAITING' | 'FORBIDDEN'> {
    const member = this.member(actor.membershipId);
    if (!member || member.userId !== actor.userId) return 'FORBIDDEN';
    const job = this.bulkJobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== 'PENDING') return 'NOT_WAITING';
    job.status = 'CANCELLED';
    job.finishedAt = new Date().toISOString();
    return 'CANCELLED';
  }

  async listBulkJobs(_tenantId: string, limit = 20): Promise<BulkJobRow[]> {
    return [...this.bulkJobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit).map((j) => ({ ...j }));
  }

  async bulkJob(_tenantId: string, jobId: string): Promise<BulkJobRow | null> {
    const job = this.bulkJobs.find((j) => j.jobId === jobId);
    return job ? { ...job } : null;
  }

  /**
   * Р-145 (шаг 32): хранилище в памяти ПОВТОРЯЕТ стражи базы (0113), а не игнорирует их. Иначе регрессию «исполнитель
   * перестал называть аренду» видно только на PostgreSQL — а ровно это и случилось: первая редакция шага 32 забыла передать
   * аренду, и в памяти всё было зелено (находка 10 ревью шага 32).
   */
  async saveBulkJobArtifact(_tenantId: string, jobId: string, artifact: BulkJobArtifact, leaseOwner: string): Promise<void> {
    const job = this.bulkJobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== 'RUNNING' || job.leaseOwner !== leaseOwner) {
      throw Object.assign(new Error('the file is written only by the process that holds the live lease (Р-145)'), { cause: 'LEASE_LOST' });
    }
    if (!FILE_PRODUCING_JOB_KINDS.includes(job.kind)) {
      throw Object.assign(new Error(`a bulk job of kind ${job.kind} gives the seller no file (Р-145)`), { cause: 'NO_FILE_FOR_KIND' });
    }
    if (artifact.sha256 !== createHash('sha256').update(artifact.content).digest('hex')) {
      throw Object.assign(new Error('the checksum of the file does not match its content (Р-145)'), { cause: 'BAD_CHECKSUM' });
    }
    this.bulkArtifacts.set(jobId, { ...artifact });
  }

  // --- онбординг [Р-149], канал без доступов [Р-150] ---------------------------------------------------------------
  private onboarding: OnboardingProgressRow | null = null;
  private demo = false;
  /** Аккаунты посева с состоянием доступа [Р-150] */
  private seedAccounts: NonNullable<MemorySeed['accounts']> = [];

  async onboardingProgress(_tenantId: string): Promise<OnboardingProgressRow | null> {
    return this.onboarding ? { ...this.onboarding } : null;
  }

  async saveOnboardingProgress(_tenantId: string, input: OnboardingProgressInput, actor: AdminActor): Promise<'SAVED' | 'FORBIDDEN'> {
    if (!this.adminMember(actor)) return 'FORBIDDEN';
    if (input.scopeWriteScopeIds !== null && input.scopeWriteScopeIds.length === 0) {
      throw Object.assign(new Error('the onboarding set is narrowed to nothing (Р-131, Р-149)'), { code: '23514' });
    }
    const now = new Date().toISOString();
    const prev = this.onboarding;
    this.onboarding = {
      scopeWriteScopeIds: input.scopeWriteScopeIds, startedAt: prev?.startedAt ?? now, updatedAt: now,
    };
    return 'SAVED';
  }

  /** То же правило, что у базы: шаг завершён, потому что состояние проверяемо, — считается по тем же данным, что включение */
  async onboardingStatus(tenantId: string): Promise<OnboardingStepStatus[]> {
    const chosen = this.onboarding?.scopeWriteScopeIds ?? null;
    const rows = [...this.scopes.values()].filter((s) => s.status !== 'RETIRED' && (chosen === null || chosen.includes(s.writeScopeId)));
    const now = new Date().toISOString() as Instant;
    let costs = 0; let bounds = 0; let strategies = 0; let engines = 0;
    for (const s of rows) {
      const loaded = await this.loadScopeContext(tenantId, s.writeScopeId, now);
      if (loaded?.context.cost) costs += 1;
      if (loaded && loaded.context.bounds.min.status === 'RESOLVED' && loaded.context.bounds.max.status === 'RESOLVED') bounds += 1;
      if (s.strategy !== null) strategies += 1;
      if (s.pricingMode === 'ENGINE') engines += 1;
    }
    const accounts = this.channelAccountRows();
    const active = accounts.filter((a) => a.authStatus === 'ACTIVE').length;
    const awaiting = accounts.filter((a) => a.authStatus === 'AWAITING_ACCESS').length;
    const total = rows.length;
    const step = (name: OnboardingStepStatus['step'], done: number, all: number, isDone: boolean, aw = false): OnboardingStepStatus =>
      ({ step: name, doneCount: done, totalCount: all, done: isDone, awaiting: aw });
    return [
      step('TENANT', 1, 1, true),
      step('CHANNEL', active, active + awaiting, active > 0, awaiting > 0),
      step('COSTS', costs, total, total > 0 && costs === total),
      step('BOUNDS', bounds, total, total > 0 && bounds === total),
      step('STRATEGY', strategies, total, total > 0 && strategies === total),
      step('ENABLE', engines, total, total > 0 && engines === total),
    ];
  }

  /**
   * Аккаунты мира. Посев называет только аккаунты ДРУГИХ каналов; аккаунт самого мира в нём не описан — он виден по
   * единицам записи. Первая редакция его забывала, и стенд в памяти говорил «канал не подключён» о мире, который работает
   * (ревью шага 34, находка 8).
   */
  private channelAccountRows(): ChannelAccountRow[] {
    const seeded = new Set(this.seedAccounts.map((a) => a.channelAccountId));
    const own = new Map<string, Set<string>>();
    for (const s of this.scopes.values()) {
      if (seeded.has(s.channelAccountId)) continue;
      const marketplaces = own.get(s.channelAccountId) ?? new Set<string>();
      marketplaces.add(s.marketplace);
      own.set(s.channelAccountId, marketplaces);
    }
    const ownRows: ChannelAccountRow[] = [...own].map(([channelAccountId, marketplaces]) => ({
      channelAccountId, channel: this.channel, displayName: null, marketplaces: [...marketplaces].sort(), authStatus: 'ACTIVE', accessBlockers: [],
    }));
    return [...ownRows, ...this.seedAccounts.map((a): ChannelAccountRow => ({
      channelAccountId: a.channelAccountId, channel: a.channel, displayName: null, marketplaces: a.marketplaces,
      authStatus: a.awaitingAccess && a.awaitingAccess.length > 0 ? 'AWAITING_ACCESS' : 'ACTIVE',
      accessBlockers: a.awaitingAccess ?? [],
    }))];
  }

  async scopesWithCost(tenantId: string): Promise<string[]> {
    const now = new Date().toISOString() as Instant;
    const ids: string[] = [];
    for (const s of this.scopes.values()) {
      if (s.status === 'RETIRED') continue;
      const loaded = await this.loadScopeContext(tenantId, s.writeScopeId, now);
      if (loaded?.context.cost) ids.push(s.writeScopeId);
    }
    return ids.sort();
  }

  async tenantIsDemo(_tenantId: string): Promise<boolean> {
    return this.demo;
  }

  async channelAccounts(_tenantId: string): Promise<ChannelAccountRow[]> {
    return this.channelAccountRows();
  }

  async bulkJobArtifact(_tenantId: string, jobId: string): Promise<BulkJobArtifact | null> {
    return this.bulkArtifacts.get(jobId) ?? null;
  }

  async importCosts(_tenantId: string, batch: CostImportBatch, actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<CostImportResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    if (batch.rows.length === 0) return { status: 'INVALID', cause: 'NO_ROWS' };
    const ids = batch.rows.map((r) => r.writeScopeId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) return { status: 'INVALID', cause: 'DUPLICATE_SCOPE', writeScopeId: duplicate };
    const planned: Array<{ row: ScopeRow; cost: CostInputs }> = [];
    for (const r of batch.rows) {
      const row = this.scopes.get(r.writeScopeId);
      if (!row) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND', writeScopeId: r.writeScopeId };
      if (!Number.isSafeInteger(r.unitCostMinor) || r.unitCostMinor < 0) return { status: 'INVALID', cause: 'AMOUNT_INVALID', writeScopeId: r.writeScopeId };
      if (r.fixedFeeMinor !== undefined && (!Number.isSafeInteger(r.fixedFeeMinor) || r.fixedFeeMinor < 0)) return { status: 'INVALID', cause: 'AMOUNT_INVALID', writeScopeId: r.writeScopeId };
      if (r.feeRateBp !== undefined && (!Number.isSafeInteger(r.feeRateBp) || r.feeRateBp < 0 || r.feeRateBp >= 10_000)) {
        return { status: 'INVALID', cause: 'AMOUNT_INVALID', writeScopeId: r.writeScopeId };
      }
      if (row.currency !== r.currency) return { status: 'INVALID', cause: 'CURRENCY_MISMATCH', writeScopeId: r.writeScopeId };
      planned.push({
        row,
        cost: {
          currency: r.currency, costProfileId: `cp-import-${row.writeScopeId}-${(row.cost?.costProfileId ?? '').length}`,
          unitCostMinor: r.unitCostMinor,
          fixedFeeMinor: r.fixedFeeMinor ?? row.cost?.fixedFeeMinor ?? 0,
          feeRateBp: r.feeRateBp ?? row.cost?.feeRateBp ?? 0,
          tax: row.cost?.tax ?? (row.taxRegime === 'SALES_TAX_EXCLUDED' ? { regime: 'SALES_TAX_EXCLUDED' } : { regime: 'VAT_INCLUDED', vatRateBp: null }),
        },
      });
    }
    const offers = new Set(ids).size;
    // Р-135: второй фактор проверяется после разбора — продавец видит содержательную причину отказа, а не «нет второго фактора» на мусорный файл
    if (mode === 'APPLY' && !actor.mfa && !this.jobSecondFactor(actor, ['COST_IMPORT'])) return { status: 'MFA_REQUIRED' };
    if (mode === 'PREVIEW') return { status: 'PREVIEWED', rows: batch.rows.length, offers };
    for (const p of planned) p.row.cost = p.cost;
    return { status: 'APPLIED', importId: `import-${batch.fingerprint}`, rows: batch.rows.length, offers };
  }

  async saveStrategy(_tenantId: string, input: StrategySaveInput, actor: AdminActor): Promise<StrategySaveResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    if (input.name.trim().length === 0) return { status: 'INVALID', cause: 'NAME_REQUIRED' };
    if (input.assignTo.some((id) => !this.scopes.has(id))) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
    for (const x of input.expected ?? []) {
      const row = this.scopes.get(x.writeScopeId);
      if (!row) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
      if ((row.strategy?.strategyId ?? null) !== x.strategyId || (row.strategy?.version ?? null) !== x.version) return { status: 'CONFLICT', writeScopeId: x.writeScopeId };
    }
    const versions = [...this.strategyVersions.values()].filter((d) => d.strategyId === input.strategyId);
    if (input.strategyId !== null && versions.length === 0) return { status: 'INVALID', cause: 'STRATEGY_NOT_FOUND' };
    // Как write_scope_strategy_guard (0082): стратегия доступна на канале [Р-39, OQ-166], у оффера нет ценообразования канала [Р-120]
    // OQ-173: как write_scope_strategy_guard — по каналу каждой единицы записи, а не по каналу мира
    for (const id of input.assignTo) {
      const sources = this.sourcesFor(this.scope(id).channelAccountId);
      if (sources && !strategyAvailability(input.params, sources).available) return { status: 'INVALID', cause: 'STRATEGY_UNAVAILABLE', writeScopeId: id };
    }
    for (const id of input.assignTo) {
      if (this.channelPricingActive(this.scope(id))) return { status: 'INVALID', cause: 'CHANNEL_PRICING_ACTIVE', writeScopeId: id };
    }
    const strategy: StrategyDefinition = {
      strategyId: input.strategyId ?? `strategy-${this.strategyVersions.size + 1}`,
      version: versions.reduce((v, d) => Math.max(v, d.version), 0) + 1,
      params: { ...input.params }, deadbandMinor: input.deadbandMinor,
    };
    this.rememberStrategy(strategy);
    this.strategyMeta.set(`${strategy.strategyId}@${strategy.version}`, {
      strategyId: strategy.strategyId, version: strategy.version, name: input.name.trim(), status: 'ACTIVE', createdAt: new Date().toISOString(), createdByMembershipId: actor.membershipId,
    });
    for (const id of input.assignTo) this.scope(id).strategy = strategy;
    return { status: 'SAVED', strategy, assigned: [...input.assignTo] };
  }

  private expectedConflict(expected: StrategyAssignInput['expected']): { status: 'CONFLICT'; writeScopeId: string } | { status: 'INVALID'; cause: 'SCOPE_NOT_FOUND' } | null {
    for (const x of expected ?? []) {
      const row = this.scopes.get(x.writeScopeId);
      if (!row) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
      if ((row.strategy?.strategyId ?? null) !== x.strategyId || (row.strategy?.version ?? null) !== x.version) return { status: 'CONFLICT', writeScopeId: x.writeScopeId };
    }
    return null;
  }

  /** Как PgPricingStore.assignStrategyVersion (OQ-169): существующая действующая версия, те же проверки назначения */
  async assignStrategyVersion(_tenantId: string, input: StrategyAssignInput, actor: AdminActor): Promise<StrategySaveResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    if (input.assignTo.some((id) => !this.scopes.has(id))) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
    const conflict = this.expectedConflict(input.expected);
    if (conflict) return conflict;
    const strategy = this.strategyVersions.get(`${input.strategyId}@${input.version}`);
    if (!strategy) return { status: 'INVALID', cause: 'STRATEGY_NOT_FOUND' };
    const meta = this.strategyMeta.get(`${input.strategyId}@${input.version}`);
    if (meta && meta.status !== 'ACTIVE') return { status: 'INVALID', cause: 'VERSION_NOT_ACTIVE' };
    for (const id of input.assignTo) {
      const sources = this.sourcesFor(this.scope(id).channelAccountId);
      if (sources && !strategyAvailability(strategy.params, sources).available) return { status: 'INVALID', cause: 'STRATEGY_UNAVAILABLE', writeScopeId: id };
      if (this.channelPricingActive(this.scope(id))) return { status: 'INVALID', cause: 'CHANNEL_PRICING_ACTIVE', writeScopeId: id };
    }
    for (const id of input.assignTo) this.scope(id).strategy = strategy;
    return { status: 'SAVED', strategy, assigned: [...input.assignTo] };
  }

  /** Как PgPricingStore.unassignStrategy (OQ-169): только при выключенном репрайсинге */
  async unassignStrategy(_tenantId: string, input: StrategyUnassignInput, actor: AdminActor): Promise<StrategyUnassignResult> {
    if (!this.adminMember(actor)) return { status: 'FORBIDDEN' };
    const conflict = this.expectedConflict(input.expected);
    if (conflict) return conflict;
    if (input.writeScopeIds.some((id) => !this.scopes.has(id))) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
    const engine = input.writeScopeIds.find((id) => this.scope(id).pricingMode === 'ENGINE');
    if (engine) return { status: 'INVALID', cause: 'REPRICING_ENABLED', writeScopeId: engine };
    for (const id of input.writeScopeIds) this.scope(id).strategy = null;
    return { status: 'UNASSIGNED', writeScopeIds: [...input.writeScopeIds] };
  }

  // --- PricingStore: системные остановки [Р-51, Р-52] ---------------------------
  private haltInfo(h: HaltRow): HaltInfo {
    return { haltId: h.haltId, channelAccountId: h.channelAccountId, marketplace: h.marketplace, reasonCode: h.reasonCode, haltedAt: h.haltedAt, reviewWindowSeconds: h.reviewWindowSeconds, nextReviewAt: h.nextReviewAt };
  }

  async listDueHalts(_tenantId: string, channelAccountId: string, now: Instant): Promise<HaltInfo[]> {
    return this.halts
      // Как PgPricingStore.listDueHalts: выборкой проверяется только остановка по массовому сдвигу [Р-52]; по базе цены — только человек [Р-116]
      .filter((h) => h.releasedAt === null && h.channelAccountId === channelAccountId && h.reasonCode === 'CHANNEL_MASS_SHIFT' && Date.parse(h.nextReviewAt) <= Date.parse(now))
      .map((h) => this.haltInfo(h));
  }

  async getHalt(_tenantId: string, haltId: string): Promise<HaltInfo | null> {
    const h = this.halts.find((x) => x.haltId === haltId && x.releasedAt === null);
    return h ? this.haltInfo(h) : null;
  }

  async recordReconciliationSnapshot(_tenantId: string, entry: { channelAccountId: string; competitorSnapshotId: string; snapshot: CompetitorSnapshot; receivedAt: Instant; lossCheck?: NotificationLossCheck }): Promise<void> {
    const { snapshot } = entry;
    // Одна транзакция: проверка отклонена — журнал тоже не пишется
    if (entry.lossCheck) this.recordNotificationLossCheck(entry.lossCheck);
    this.snapshotLog.push({
      competitorSnapshotId: entry.competitorSnapshotId, receivedAt: entry.receivedAt, verdict: 'RECONCILIATION', delivery: 'POLL', snapshot,
      key: { channelAccountId: entry.channelAccountId, marketplace: snapshot.marketplace, channelProductRef: snapshot.channelProductRef, condition: snapshot.condition },
    });
  }

  async heldCompetitorState(_tenantId: string, key: ProductKey): Promise<{ observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null } | null> {
    const state = this.competitorState.get(productKey(key));
    return state ? { observedAt: state.observedAt, buyboxMinor: state.buyboxMinor, lowestMinor: state.lowestMinor } : null;
  }

  private recordNotificationLossCheck(check: NotificationLossCheck): void {
    // Как ограничения notification_loss_check (0088)
    if (check.heldMinor === check.pollMinor) throw new Error('new row violates check constraint "notification_loss_check_diverged"');
    if (!(Date.parse(check.pollObservedAt) > Date.parse(check.heldObservedAt) && Date.parse(check.dueAt) > Date.parse(check.pollObservedAt))) {
      throw new Error('new row violates check constraint "notification_loss_check_order"');
    }
    this.lossChecks.push({ ...check, checkId: this.id('loss-check') });
  }

  async reviewNotificationLoss(_tenantId: string, channelAccountId: string, at: Instant): Promise<NotificationLossVerdict[]> {
    // Как channel_data.review_notification_loss (0088)
    const out: NotificationLossVerdict[] = [];
    const atMs = Date.parse(at);
    for (const c of [...this.lossChecks].sort((a, b) => Date.parse(a.pollObservedAt) - Date.parse(b.pollObservedAt) || a.channelProductRef.localeCompare(b.channelProductRef))) {
      if (c.channelAccountId !== channelAccountId || Date.parse(c.dueAt) > atMs || this.lossVerdicts.some((v) => v.checkId === c.checkId)) continue;
      const push = this.snapshotLog
        .filter((l) => l.key.channelAccountId === c.channelAccountId && l.key.marketplace === c.marketplace && l.key.channelProductRef === c.channelProductRef
          && l.key.condition === c.condition && (l.delivery === 'PUSH' || l.delivery === 'PUSH_FETCH')
          && Date.parse(l.receivedAt) > Date.parse(c.heldObservedAt) && Date.parse(l.receivedAt) <= Date.parse(c.dueAt)
          && Date.parse(l.snapshot.observedAt) > Date.parse(c.heldObservedAt))
        .sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt))[0];
      const verdict = push ? 'DELAYED' : 'LOSS_SUSPECTED';
      this.lossVerdicts.push({ checkId: c.checkId, verdict, pushSnapshotId: push?.competitorSnapshotId ?? null, decidedAt: at });
      out.push({ checkId: c.checkId, verdict, marketplace: c.marketplace, channelProductRef: c.channelProductRef, condition: c.condition, pollObservedAt: c.pollObservedAt });
    }
    return out;
  }

  /** Р-126: время последнего опроса товара (как channel_data.competitor_poll_state) */
  readonly pollState = new Map<string, Instant>();

  async listPollCandidates(_tenantId: string, channelAccountId: string, now: Instant): Promise<PollCandidate[]> {
    // Движение 10 000 б. п. — цена не изменилась: не волатильность (ревью шага 25, находка 2). Движение хранит товар как «ref|condition»:
    // сравнение с одним ref не находило ни одного движения, и в памяти все товары были холодными (найдено шагом «остаётся холодным» фикстуры)
    const since = Date.parse(now) - 48 * 3_600_000;
    const out = new Map<string, PollCandidate>();
    for (const s of this.scopes.values()) {
      if (s.channelAccountId !== channelAccountId || !s.channelProductRef) continue;
      const query = { marketplace: s.marketplace, channelProductRef: s.channelProductRef, condition: s.condition };
      const key = `${channelAccountId}|${productKey(query)}`;
      if (out.has(key)) continue;
      const observed = (this.movesByMarketplace.get(s.marketplace) ?? []).filter((m) => m.at >= since && m.move.productRef === `${s.channelProductRef}|${s.condition}`);
      const moves = observed.filter((m) => m.move.moveBp !== 10_000).length;
      // Р-128: волатильность известна, если наблюдения товара охватывают сутки
      const volatilityKnown = observed.some((m) => m.at <= Date.parse(now) - 24 * 3_600_000);
      out.set(key, { query, lastPolledAt: this.pollState.get(key) ?? null, changesLast30Days: moves * 15, volatilityKnown });
    }
    return [...out.values()];
  }

  async markPolled(_tenantId: string, channelAccountId: string, queries: readonly CompetitorQuery[], at: Instant): Promise<void> {
    for (const q of queries) this.pollState.set(`${channelAccountId}|${productKey(q)}`, at);
  }

  async pickReconciliationSample(_tenantId: string, channelAccountId: string, size: number, cycle: number): Promise<{ queries: CompetitorQuery[]; total: number }> {
    const refs = new Map<string, CompetitorQuery>();
    for (const s of this.scopes.values()) {
      if (s.channelAccountId !== channelAccountId || !s.channelProductRef) continue;
      refs.set(productKey(s), { marketplace: s.marketplace, channelProductRef: s.channelProductRef, condition: s.condition });
    }
    return { queries: rotation([...refs.values()], size, cycle), total: refs.size };
  }

  async pickReviewSample(_tenantId: string, halt: HaltInfo, size: number): Promise<CompetitorQuery[]> {
    // Шаг 26: сначала товары с ценой из данных конкурентов, затем остальные товары витрины — как в PostgreSQL
    const competitor = new Map<string, CompetitorQuery>();
    const other = new Map<string, CompetitorQuery>();
    for (const s of [...this.scopes.values()].sort((a, b) => a.channelProductRef.localeCompare(b.channelProductRef))) {
      if (s.channelAccountId !== halt.channelAccountId || (halt.marketplace !== null && s.marketplace !== halt.marketplace)) continue;
      const derived = s.pricingMode === 'ENGINE' && s.strategy !== null && COMPETITOR_STRATEGIES.has(s.strategy.params.type);
      (derived ? competitor : other).set(productKey(s), { marketplace: s.marketplace, channelProductRef: s.channelProductRef, condition: s.condition });
    }
    for (const k of competitor.keys()) other.delete(k);
    return [...competitor.values(), ...other.values()].slice(0, size);
  }

  private member(membershipId: string | undefined): ConsoleMemberRow | undefined {
    return this.members.find((m) => m.membershipId === membershipId && m.status === 'ACTIVE');
  }

  async releaseHalt(_tenantId: string, haltId: string, review: HaltReviewRecord): Promise<void> {
    const h = this.halts.find((x) => x.haltId === haltId);
    if (!h || h.releasedAt !== null) throw new Error(`pricing halt ${haltId} is not active`);
    if (review.kind === 'MANUAL_RELEASE') {
      if (!review.membershipId || !NOTE_OK(review.note)) throw new Error('manual release requires a member and a note (Р-52)');
      const m = this.member(review.membershipId);
      // Как триггер pricing_halt_release_role_guard (0048): право по матрице и членство пользователя сессии
      if (!m || !can(m.role, 'RELEASE_CHANNEL_HALT')) throw new Error(`membership ${review.membershipId} may not release a channel halt`);
      if (m.userId !== review.userId) throw new Error(`membership ${review.membershipId} is not the membership of the session user`);
      // Как pricing_halt_release_role_guard (0058): ручное снятие — со вторым фактором (находка 12, Р-88)
      if (!review.mfa) throw new Error(`releasing channel halt ${haltId} manually requires a second factor (finding 12, Р-88)`);
    } else {
      throw new Error('an automatic halt release is computed by reviewHaltBySample from the recorded sample (0063), not written by the decision path');
    }
    this.haltReviews.push({ ...review, haltId });
    h.releasedAt = review.at;
    h.releasedKind = 'MANUAL';
    this.auditHalt('pricing.halt_released', haltId, review.at, review.kind === 'MANUAL_RELEASE' ? review.membershipId ?? null : null, review.kind === 'MANUAL_RELEASE' ? review.note ?? null : null);
  }

  /** Наблюдения выборки проверки остановки — как channel_data.pricing_halt_sample (0063) */
  async recordHaltSample(_tenantId: string, haltId: string, samples: readonly HaltSampleObservation[], now: Instant): Promise<void> {
    const h = this.halts.find((x) => x.haltId === haltId);
    if (!h) throw new Error(`pricing halt ${haltId} does not exist`);
    for (const sample of samples) this.haltSamples.push({ ...sample, haltId, recordedAt: now });
  }

  /** Итог проверки выборки — как channel_data.review_halt_by_sample (0063): путь решения не пишет проверку и снятие сам */
  async reviewHaltBySample(_tenantId: string, haltId: string, now: Instant): Promise<HaltSampleReview> {
    const h = this.halts.find((x) => x.haltId === haltId && x.releasedAt === null && x.reasonCode === 'CHANNEL_MASS_SHIFT');
    if (!h) return 'NOT_ACTIVE';
    // Как review_halt_by_sample (0082) и platform.channel_behaviour: на Amazon выборки нет — только ручное снятие [Р-119]
    if (this.channel === 'AMAZON') return 'MANUAL_ONLY';
    if (Date.parse(now) < Date.parse(h.nextReviewAt)) return 'NOT_DUE';
    const eligible = new Set<string>();
    for (const s of this.scopes.values()) {
      if (s.channelAccountId !== h.channelAccountId || (h.marketplace !== null && s.marketplace !== h.marketplace)) continue;
      if (s.pricingMode !== 'ENGINE' || !s.strategy || !COMPETITOR_STRATEGIES.has(s.strategy.params.type)) continue;
      eligible.add(s.channelProductRef);
    }
    const required = Math.max(1, Math.min(5, eligible.size));
    // Принятые наблюдения — только по товарам остановленной витрины (0065)
    const haltedRefs = new Set([...this.scopes.values()]
      .filter((s) => s.channelAccountId === h.channelAccountId && (h.marketplace === null || s.marketplace === h.marketplace)).map((s) => s.channelProductRef));
    const due = Date.parse(h.nextReviewAt);
    const rows = this.haltSamples.filter((x) => x.haltId === haltId && Date.parse(x.recordedAt) >= due && Date.parse(x.observedAt) >= due && Date.parse(x.observedAt) <= Date.parse(now));
    const failed = rows.filter((x) => x.verdict !== 'ACCEPT').length;
    const accepted = new Set(rows.filter((x) => x.verdict === 'ACCEPT' && haltedRefs.has(x.channelProductRef)).map((x) => x.channelProductRef)).size;
    if (failed > 0) {
      this.haltReviews.push({ kind: 'AUTO_SAMPLE', outcome: 'SAMPLE_FAILED', sampleSize: accepted + failed, failedCount: failed, details: { required }, at: now, haltId });
      h.nextReviewAt = new Date(Date.parse(now) + h.reviewWindowSeconds * 1000).toISOString();
      return 'SAMPLE_FAILED';
    }
    if (accepted < required) return 'NO_SAMPLE';
    this.haltReviews.push({ kind: 'AUTO_SAMPLE', outcome: 'RELEASED', sampleSize: accepted, failedCount: 0, details: { required }, at: now, haltId });
    h.releasedAt = now;
    h.releasedKind = 'AUTO';
    this.auditHalt('pricing.halt_released', haltId, now, null, null);
    return 'RELEASED';
  }

  private rememberStrategy(def: StrategyDefinition): void {
    const key = `${def.strategyId}@${def.version}`;
    const known = this.strategyVersions.get(key);
    // Версия стратегии неизменяема (append-only в БД): другие параметры под той же версией — ошибка данных
    if (known && JSON.stringify(known) !== JSON.stringify(def)) throw new Error(`strategy ${key} changed its parameters without a new version (Р-75)`);
    this.strategyVersions.set(key, { ...def, params: { ...def.params } });
  }

  /** Как триггер price_stop_audit (0045): автор, его роль в момент действия, заметка, область [Р-76] */
  private auditStop(action: 'pricing.stop_created' | 'pricing.stop_released', stop: ConsoleStopRow): void {
    const created = action === 'pricing.stop_created';
    const membershipId = created ? stop.stoppedByMembershipId : stop.releasedByMembershipId;
    const m = this.members.find((x) => x.membershipId === membershipId);
    if (!m) throw new Error(`stop ${stop.stopId}: membership ${membershipId} is unknown; the audit event needs its author (Р-76)`);
    this.audit.push({
      at: created ? stop.stoppedAt : stop.releasedAt!, action, actorType: 'USER', membershipId: m.membershipId, role: m.role, entityType: 'price_stop',
      entityId: stop.stopId, scope: stop.scope, channelAccountId: stop.channelAccountId, marketplace: stop.marketplace, note: created ? stop.note : stop.releaseNote,
    });
  }

  /** Как триггеры pricing_halt_audit и pricing_halt_review_audit (0045): системная остановка — актор SYSTEM, ручное снятие — участник */
  private auditHalt(action: 'pricing.halt_created' | 'pricing.halt_released', haltId: string, at: Instant, membershipId: string | null, note: string | null): void {
    const h = this.halts.find((x) => x.haltId === haltId)!;
    const m = membershipId ? this.members.find((x) => x.membershipId === membershipId) : undefined;
    if (membershipId && !m) throw new Error(`halt ${haltId}: membership ${membershipId} is unknown; the audit event needs its author (Р-76)`);
    this.audit.push({
      at, action, actorType: m ? 'USER' : 'SYSTEM', membershipId: m?.membershipId ?? null, role: m?.role ?? null, entityType: 'pricing_halt', entityId: haltId,
      scope: h.marketplace === null ? 'CHANNEL_ACCOUNT' : 'STOREFRONT', channelAccountId: h.channelAccountId, marketplace: h.marketplace, note,
    });
  }

  // --- PricingStore: остановки человеком [Р-69, Р-70] ---------------------------
  async stopPricing(_tenantId: string, record: StopRecord): Promise<StopResult> {
    const m = this.member(record.stoppedByMembershipId);
    // Как price_stop_role_guard (0048): право по роли и членство пользователя сессии
    if (!m || m.userId !== record.stoppedByUserId || !can(m.role, 'STOP_PRICING')) return { status: 'FORBIDDEN' };
    if (!NOTE_OK(record.note)) throw new Error('a stop requires a note of 10 to 2000 characters');
    // Как CHECK price_stop_scope_shape (0042)
    const channelAccountId = record.scope === 'TENANT' ? null : record.channelAccountId;
    const marketplace = record.scope === 'STOREFRONT' ? record.marketplace : null;
    if ((record.scope !== 'TENANT' && !channelAccountId) || (record.scope === 'STOREFRONT' && !marketplace)) throw new Error('stop scope does not match its account and storefront');
    const active = this.stops.find((s) => s.releasedAt === null && s.scope === record.scope && s.channelAccountId === channelAccountId && s.marketplace === marketplace);
    if (active) return { status: 'ALREADY_ACTIVE', stop: { ...active } };
    const stop: ConsoleStopRow = {
      stopId: this.id('stop'), scope: record.scope, channelAccountId, marketplace, stoppedAt: record.stoppedAt, stoppedByMembershipId: m.membershipId,
      note: record.note.trim(), releasedAt: null, releasedByMembershipId: null, releaseNote: null,
    };
    this.stops.push(stop);
    this.auditStop('pricing.stop_created', stop);
    return { status: 'STOPPED', stop: { ...stop } };
  }

  async releaseStop(_tenantId: string, stopId: string, release: StopRelease): Promise<StopResult> {
    const stop = this.stops.find((s) => s.stopId === stopId && s.releasedAt === null);
    if (!stop) return { status: 'NOT_ACTIVE' };
    const m = this.member(release.membershipId);
    if (!m || m.userId !== release.userId || !can(m.role, resumeActionFor(stop.scope))) return { status: 'FORBIDDEN' };
    // Как price_stop_role_guard (0053): снятие остановки тенанта — только со вторым фактором [Р-88]
    if (stop.scope === 'TENANT' && !release.mfa) return { status: 'MFA_REQUIRED' };
    if (!NOTE_OK(release.note)) throw new Error('a release requires a note of 10 to 2000 characters');
    stop.releasedAt = release.at;
    stop.releasedByMembershipId = m.membershipId;
    stop.releaseNote = release.note.trim();
    this.auditStop('pricing.stop_released', stop);
    return { status: 'RELEASED', stop: { ...stop } };
  }

  // --- Состояние для консоли ------------------------------------------------------
  async readConsoleState(_tenantId: string, _now: Instant): Promise<ConsoleState> {
    return {
      tenantId: this.tenantId,
      demo: this.demo,
      scopes: [...this.scopes.values()].map((s) => {
        const halt = this.activeHalt(s.channelAccountId, s.marketplace);
        const stop = this.activeStop(s.channelAccountId, s.marketplace);
        return {
          writeScopeId: s.writeScopeId, productId: s.productId, channelAccountId: s.channelAccountId, marketplace: s.marketplace, externalUnitId: s.externalUnitId,
          channelProductRef: s.channelProductRef, condition: s.condition, gtin: s.gtin ?? null, currency: s.currency, basis: s.basis, taxRegime: s.taxRegime,
          pricingMode: s.pricingMode, status: s.status, strategy: s.strategy, currentPriceMinor: s.currentPriceMinor, bounds: this.boundsOf(s),
          cost: s.cost ?? null, minMarginBp: s.guardrails?.minMarginBp ?? null,
          channelHalt: halt ? InMemoryPricingStore.haltRef(halt) : null, priceStop: stop ? InMemoryPricingStore.stopRef(stop) : null,
          channelDistrust: (() => { const d = this.activeDistrust(s.channelAccountId, s.marketplace); return d ? InMemoryPricingStore.distrustRef(d) : null; })(),
        };
      }),
      intents: this.intents.map((i) => ({ ...i })),
      decisions: this.decisions.map((d) => ({ ...d })),
      writes: this.writes.map((w) => ({
        channelWriteId: w.channelWriteId, writeScopeId: w.writeScopeId, decisionId: w.decisionId, amountMinor: w.amountMinor, currency: w.currency, basis: w.basis,
        version: w.version, status: w.status, attemptCount: w.attemptCount, competitorDerived: w.competitorDerived, createdAt: w.createdAt, dispatchedAt: w.dispatchedAt,
        acceptedAt: w.acceptedAt, nextAttemptAt: w.nextAttemptAt, lastErrorCode: w.lastErrorCode, endReason: w.endReason, endParams: { ...w.endParams },
        supersededByWriteId: w.supersededByWriteId,
      })),
      halts: this.halts.map((h) => ({
        haltId: h.haltId, channelAccountId: h.channelAccountId, marketplace: h.marketplace, reasonCode: h.reasonCode, details: h.details, haltedAt: h.haltedAt,
        nextReviewAt: h.nextReviewAt, releasedAt: h.releasedAt, releasedKind: h.releasedKind,
      })),
      haltReviews: this.haltReviews.map((r) => ({ ...r })),
      distrusts: this.distrusts.map((d) => ({ ...d, details: { ...d.details } })),
      offerChannelPricing: [...new Map([...this.offerChannelPricing].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))
        .map((o) => [`${o.channelAccountId}|${o.marketplace}|${o.externalSku}`, { ...o }])).values()],
      pricingHealth: [...new Map([...this.pricingHealth].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
        .map((h) => [`${h.channelAccountId}|${h.marketplace}|${h.channelProductRef}|${h.condition}`, { ...h }])).values()],
      stops: this.stops.map((s) => ({ ...s })),
      rejectedSnapshots: this.rejectedSnapshots.map((r) => ({ ...r })),
      divergenceCases: this.divergenceCases.map((c) => ({ ...c })),
      fxRates: [...this.fxRates],
      members: this.members.map((m) => ({ ...m })),
      strategies: [...this.strategyVersions.values()].map((d) => ({ ...d, params: { ...d.params } })),
      strategyVersions: [...this.strategyMeta.values()].map((v) => ({ ...v })),
      explanationRulesets: [...EXPLANATION_RULESETS],
      audit: this.audit.map((a) => ({ ...a })),
    };
  }

  /** Состояние для ожиданий сценария */
  async dump() {
    return {
      scopes: [...this.scopes.values()].map((s) => ({ writeScopeId: s.writeScopeId, pricingMode: s.pricingMode, currentPriceMinor: s.currentPriceMinor })),
      rejectedSnapshots: this.rejectedSnapshots.map((r) => ({ verdict: r.verdict, reasonCode: r.reasonCode, alarmClass: r.alarmClass, key: { channelProductRef: r.key.channelProductRef, marketplace: r.key.marketplace } })),
      halts: this.halts.map((h) => ({ haltId: h.haltId, channelAccountId: h.channelAccountId, marketplace: h.marketplace, reasonCode: h.reasonCode, releasedAt: h.releasedAt, releasedKind: h.releasedKind, nextReviewAt: h.nextReviewAt })),
      haltReviews: this.haltReviews.map((r) => ({ kind: r.kind, outcome: r.outcome, sampleSize: r.sampleSize, failedCount: r.failedCount })),
      distrusts: this.distrusts.map((d) => ({ distrustId: d.distrustId, marketplace: d.marketplace, reasonCode: d.reasonCode, releasedAt: d.releasedAt, released: d.releasedAt !== null })),
      offerChannelPricing: this.offerChannelPricing.map((o) => ({ marketplace: o.marketplace, externalSku: o.externalSku, automatedPricing: o.automatedPricing, channelBounds: o.channelBounds, source: o.source })),
      pricingHealth: this.pricingHealth.map((h) => ({ marketplace: h.marketplace, channelProductRef: h.channelProductRef, issueType: h.issueType, thresholdMinor: h.competitivePriceThreshold?.amountMinor ?? null })),
      inboundNotifications: [...this.inboundNotifications.values()].map((n) => ({ notificationId: n.notificationId, notificationType: n.notificationType })),
      snapshotLog: this.snapshotLog.map((l) => ({ channelProductRef: l.key.channelProductRef, verdict: l.verdict, source: l.snapshot.source, delivery: l.delivery })),
      lossChecks: this.lossChecks.map((c) => ({
        channelProductRef: c.channelProductRef, compared: c.compared, heldMinor: c.heldMinor, pollMinor: c.pollMinor,
        verdict: this.lossVerdicts.find((v) => v.checkId === c.checkId)?.verdict ?? null,
      })),
      stops: this.stops.map((s) => ({ stopId: s.stopId, scope: s.scope, marketplace: s.marketplace, releasedAt: s.releasedAt })),
      intents: this.intents.map((i) => ({ writeScopeId: i.writeScopeId, ruleCode: i.ruleCode, proposedMinor: i.proposedMinor })),
      decisions: this.decisions.map((d) => ({
        writeScopeId: d.writeScopeId, outcome: d.outcome, decisionClass: d.decisionClass, rejectionReason: d.rejectionReason, finalMinor: d.finalMinor,
        reasonParams: d.reason.params, fx: d.fx ?? null, boundDeviationBp: d.boundDeviationBp,
      })),
      writes: this.writes.map((w) => ({ writeScopeId: w.writeScopeId, amountMinor: w.amountMinor, version: w.version, status: w.status, endReason: w.endReason })),
      divergenceCases: this.divergenceCases.map((c) => ({ writeScopeId: c.writeScopeId, expectedMinor: c.expectedMinor, observedMinor: c.observedMinor, cause: c.cause, status: c.status })),
      competitorState: Object.fromEntries([...this.competitorState.entries()].map(([k, v]) => [k, {
        observedAt: v.observedAt, buyboxMinor: v.buyboxMinor, lowestMinor: v.lowestMinor,
        currency: v.snapshot?.buybox?.price.currency ?? v.snapshot?.offers[0]?.price.currency ?? null,
        suggestedMinor: v.snapshot?.channelSuggestedPrice?.amountMinor ?? null,
      }])),
    };
  }
}
