import type { OmnibusPriorPrice } from '@repracer/pricing-model';
import type { DecisionExplanation, DistrustRef, ExplanationIntentColumns, SanitySummary, FxFailureCause, FxQuote, HaltRef, HaltReasonCode, MemberRole, PriceIntentDraft as IntentDraft, StopRef, StopScope } from '@repracer/pricing-model';
import type { ExplanationRuleset, StopScope as AuditStopScope } from '@repracer/pricing-model';
import type { CompetitorQuery, CompetitorSnapshot, FieldWrite, Instant, Money, OfferIdentity, PriceBasis, PricingHealthObservation, WriteOutcome } from '@repracer/channel-port';
import type { MoveRecord, SanityContext } from '@repracer/input-sanity';
import type { GuardrailSet } from '@repracer/price-gate';
import type {
  AcceptedSnapshot,
  AlarmClass,
  CostInputs,
  PriceBounds,
  PriceDecisionDraft,
  PriceIntentDraft,
  Reason,
  StrategyDefinition,
  TaxRegime,
} from '@repracer/pricing-model';

/**
 * Порт хранилища пути решения. Реализации: PostgreSQL (@repracer/pricing-store-pg) и двойник в памяти для стенда.
 * Каждая операция принимает тенант явно; реализация не видит других тенантов (RLS).
 *
 * Р-59: одна оценка снимка — не больше трёх транзакций:
 *   1) loadEvaluationContext — всё, что нужно проверке входов, стратегии и Gate, одним чтением;
 *   2) commitEvaluation — снимок, движение, intent, решение и запись цены, переведённая в отправку, одной транзакцией;
 *   3) recordDispatch — итог отправки, только если запись была.
 */

export interface ProductKey {
  channelAccountId: string;
  marketplace: string;
  channelProductRef: string;
  condition: string;
}

export interface PriceScopeContext {
  writeScopeId: string;
  productId: string;
  channelAccountId: string;
  marketplace: string;
  /** Подпись предложения для экранов: unit Kaufland или SKU; ключ записи в канал — только identity */
  externalUnitId: string;
  /** Идентичность записи в канал — `offerIdentityOf` из предложения (OQ-165, шаг 23) */
  identity: OfferIdentity;
  channelProductRef: string;
  condition: string;
  scopeKey: string;
  gtin: string | null;
  /** Валюта — свойство единицы записи [Р-57] */
  currency: string;
  basis: PriceBasis;
  /** Налоговый режим цены витрины [Р-58] */
  taxRegime: TaxRegime;
  pricingMode: 'OFF' | 'ENGINE' | 'KAUFLAND_SMART_PRICING';
  status: 'ACTIVE' | 'HELD' | 'CONTESTED' | 'BLOCKED' | 'RETIRED';
  strategy: StrategyDefinition | null;
  currentPriceMinor: number | null;
  /** Цены, которые канал может сейчас показывать: действующая и недавно отправленные */
  knownPricesMinor: number[];
}

/** Окно массового сдвига [Р-50]: последнее движение каждого товара за окно, в списке — только большие */
export interface ShiftWindow {
  windowSeconds: number;
  minFactor: number;
}

/** Прочитанные границы и версия, к которой привязано решение [Р-54] */
export interface BoundsRead {
  bounds: PriceBounds;
  version: string;
}

/** Всё, что нужно стратегии и Gate по одной единице записи */
export interface ScopeEvaluationContext {
  scope: PriceScopeContext;
  bounds: PriceBounds;
  /** Версия контекста решения [Р-54]: строки границ на обоих уровнях и действующая остановка; фиксация сверяет её под блокировкой */
  contextVersion: string;
  /** Себестоимость и комиссии с налоговым режимом; null — нет профиля в валюте единицы или действующей оценки комиссии */
  cost: CostInputs | null;
  /** Себестоимость единицы товара в валюте единицы — якорь проверки входов, даже без оценки комиссии */
  unitCostMinor: number | null;
  /** Себестоимость есть, но не переведена в валюту единицы записи (нет или устарел курс ЕЦБ) — для объяснения отказа [Р-61] */
  costUnavailableCause?: FxFailureCause | null;
  /** Себестоимости для маржи нет — причина для предупреждения при включении (шаг 12) */
  costMissingCause?: 'COST_PROFILE_MISSING' | 'FEE_ESTIMATE_MISSING' | FxFailureCause | null;
  guardrails: GuardrailSet;
  /** Системная остановка витрины: только цены из данных конкурентов [Р-51] */
  channelHalt: HaltRef | null;
  /** Остановка по недоверию каналу: все цены, снимает только человек [Р-118] */
  channelDistrust: DistrustRef | null;
  /** Остановка человеком: тенант, аккаунт или витрина, все цены [Р-69, Р-70] */
  priceStop: StopRef | null;
  /** Почему единица не активна: ошибка канала, требующая человека */
  blocking: { errorCode: string; since: Instant } | null;
  changesInLastHour: number;
}

/** Ссылка на полный снимок решения: истекает через 18 месяцев [Р-38, Р-68] */
export interface SnapshotRef {
  competitorSnapshotId: string;
  source: string;
  observedAt: Instant;
}

/** Последний принятый снимок товара со сведённым итогом проверки входов — для пересчёта без нового снимка */
export interface StoredSnapshotRef extends SnapshotRef {
  sanity: SanitySummary | null;
}

export interface EvaluationContext {
  scopes: ScopeEvaluationContext[];
  /** Контекст проверки входов; ourPrice и unitCost — по основной единице записи (ENGINE, иначе первая) */
  sanity: SanityContext;
}

export interface RejectedSnapshotRecord {
  source: string;
  sourceEventId?: string;
  observedAt: Instant;
  receivedAt: Instant;
  verdict: 'REJECT' | 'HALT_CHANNEL';
  reasonCode: string;
  alarmClass: AlarmClass;
  details: Reason['params'];
  ruleset: string;
}

/** Системная остановка витрины по испорченным данным [Р-42, Р-51]; остановка человеком — StopRecord [Р-69] */
export interface HaltRecord {
  channelAccountId: string;
  marketplace: string | null;
  reasonCode: HaltReasonCode;
  details: Reason['params'];
  haltedAt: Instant;
}

/** Остановка человеком (kill switch): все изменения цен [Р-69]; тенант — самостоятельный объект [Р-70] */
export interface StopRecord {
  scope: StopScope;
  channelAccountId: string | null;
  marketplace: string | null;
  stoppedAt: Instant;
  stoppedByMembershipId: string;
  /** Пользователь сессии: членство автора должно принадлежать ему — иначе в журнал попал бы не тот автор (находка 4, Р-76) */
  stoppedByUserId: string;
  note: string;
}

export interface StopRelease {
  membershipId: string;
  userId: string;
  /** Р-88: вход со вторым фактором — обязателен для снятия остановки тенанта */
  mfa: boolean;
  note: string;
  at: Instant;
}

export type StopResult =
  | { status: 'STOPPED' | 'ALREADY_ACTIVE' | 'RELEASED'; stop: ConsoleStopRow }
  | { status: 'FORBIDDEN' | 'NOT_ACTIVE' | 'MFA_REQUIRED' };

export interface HaltInfo {
  haltId: string;
  channelAccountId: string;
  marketplace: string | null;
  reasonCode: string;
  haltedAt: Instant;
  reviewWindowSeconds: number;
  nextReviewAt: Instant;
}

/**
 * Находка 2 ревью шага 16 [Р-52, 0063]: наблюдение выборки проверки системной остановки. Путь решения записывает только наблюдения;
 * итог проверки и автоматическое снятие вычисляет хранилище (в PostgreSQL — функция channel_data.review_halt_by_sample).
 */
export interface HaltSampleObservation {
  channelProductRef: string;
  observedAt: Instant;
  verdict: 'ACCEPT' | 'REJECT' | 'READ_FAILED' | 'MASS_SHIFT';
  reasonCode: string | null;
}

export type HaltSampleReview = 'RELEASED' | 'SAMPLE_FAILED' | 'NO_SAMPLE' | 'NOT_DUE' | 'NOT_ACTIVE' | 'MANUAL_ONLY';

export interface HaltReviewRecord {
  kind: 'AUTO_SAMPLE' | 'MANUAL_RELEASE';
  outcome: 'RELEASED' | 'SAMPLE_FAILED';
  sampleSize: number;
  failedCount: number;
  details: Reason['params'];
  membershipId?: string;
  /** Пользователь сессии ручного снятия (находка 4) */
  userId?: string;
  /** Находка 12 ревью шага 15 [Р-88]: ручное снятие — со вторым фактором */
  mfa?: boolean;
  note?: string;
  at: Instant;
}

/** Итог проверки входов, который фиксируется вместе с решениями */
export interface SnapshotOutcome {
  verdict: 'ACCEPT' | 'REJECT' | 'HALT_CHANNEL';
  observedAt: Instant;
  move: MoveRecord | null;
  accepted?: { snapshot: AcceptedSnapshot; gtin: string | null; competitorSnapshotId: string; sanity: SanitySummary };
  rejected?: RejectedSnapshotRecord;
  halt?: HaltRecord;
  /** Р-55: правка продавца в кабинете канала — кейс расхождения */
  divergence?: { writeScopeId: string; expectedMinor: number; observedMinor: number; observedAt: Instant };
  /**
   * Р-122 (шаг 24): снимок порта целиком — в журнал для выгрузки в ClickHouse при любом вердикте; идентификатор принятого снимка тот же,
   * что в ссылке решения на снимок
   */
  log?: { competitorSnapshotId: string; snapshot: CompetitorSnapshot; receivedAt: Instant; delivery: SnapshotDelivery };
  /** Р-121: проверка потери уведомления по этому снимку опроса — в той же транзакции */
  lossCheck?: NotificationLossCheck;
}

/**
 * Р-121 (шаг 24): как снимок пришёл. PUSH — уведомление с данными; PUSH_FETCH — чтение по уведомлению без данных [Р-46];
 * POLL — опрос по ярусу или сверка; SAMPLE — выборка проверки остановки [Р-52]. Сверка опросом засчитывает доставку только PUSH и PUSH_FETCH
 */
export type SnapshotDelivery = 'PUSH' | 'PUSH_FETCH' | 'POLL' | 'SAMPLE';

/** Р-121: что сверяется — то, о чём канал обязан уведомить (Kaufland — Buy Box, Amazon — наименьшая цена конкурента) */
export type ReconciliationCompared = 'BUYBOX' | 'LOWEST_COMPETITOR';

/** Р-121: опрос разошёлся с последним принятым состоянием товара — проверка, дошло ли уведомление до срока */
export interface NotificationLossCheck {
  channelAccountId: string;
  marketplace: string;
  channelProductRef: string;
  condition: string;
  compared: ReconciliationCompared;
  heldObservedAt: Instant;
  heldMinor: number | null;
  pollSnapshotId: string;
  pollObservedAt: Instant;
  pollMinor: number | null;
  currency: string;
  dueAt: Instant;
}

/** Р-47, Р-126: товар для ярусного опроса */
export interface PollCandidate {
  query: CompetitorQuery;
  lastPolledAt: Instant | null;
  changesLast30Days: number;
}

/** Р-121: вердикт проверки, вычисленный базой (review_notification_loss, 0088) */
export interface NotificationLossVerdict {
  checkId: string;
  verdict: 'DELAYED' | 'LOSS_SUSPECTED';
  marketplace: string;
  channelProductRef: string;
  condition: string;
  pollObservedAt: Instant;
}

export interface DecisionToCommit {
  context: ScopeEvaluationContext;
  intent: PriceIntentDraft;
  /** Решение со слепком объяснения (decision.explanation) [Р-68] */
  decision: PriceDecisionDraft;
  snapshotRef: SnapshotRef | null;
}

export interface EvaluationCommit {
  key: ProductKey;
  now: Instant;
  snapshot?: SnapshotOutcome;
  decisions: DecisionToCommit[];
  /**
   * OQ-171 (шаг 24): уведомление канала, из которого снимок, — в журнал обработанных в той же транзакции. Уже записано — ничего не
   * фиксируется, итог DUPLICATE_NOTIFICATION (повтор доставки, в том числе одновременной)
   */
  notification?: InboundNotificationEntry;
}

export interface CommittedDecision {
  writeScopeId: string;
  intentId: string;
  decisionId: string;
  /** Запись цены уже переведена в отправку: БД перепроверила обе границы и остановку (проверка 3 из 3) */
  write: FieldWrite | null;
  /** Запись создана, но у единицы уже есть запись в полёте: новая ждёт её завершения, отправлять её сейчас нельзя (INV-03) */
  pendingWriteId: string | null;
}

export type EvaluationCommitResult =
  | { status: 'COMMITTED'; rejectedSnapshotId: string | null; divergenceCaseId: string | null; decisions: CommittedDecision[] }
  /**
   * Ничего не записано: контекст решения изменился (BOUNDS_VERSION_CHANGED) или БД отклонила значение при записи
   * (BELOW_MIN_PRICE, ABOVE_MAX_PRICE, CHANNEL_HALTED). Оценка повторяется с новым контекстом.
   */
  | { status: 'CONTEXT_CHANGED'; writeScopeId: string; reason: Reason }
  /** OQ-171: уведомление уже обработано — транзакция откатана */
  | { status: 'DUPLICATE_NOTIFICATION' };

/** Состояние единицы после итога записи — в той же транзакции */
export interface DispatchRecorded {
  slotFreed: boolean;
  /** Единица свободна и в очереди ждёт запись другой оценки — отправку продолжает диспетчер [Р-64] */
  queuedWaiting: boolean;
  /** Итог записи и блокировка единицы — для тех же алертов, что у диспетчера (шаг 21: путь решения их не поднимал) */
  status: 'DISPATCHED' | 'ACCEPTED' | 'APPLIED' | 'NOT_APPLIED' | 'FAILED' | 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED';
  scopeBlocked: boolean;
  reason: { code: string; params?: Record<string, unknown> } | null;
}

/** Автор административного действия консоли: членство, пользователь сессии и второй фактор из токена поставщика [Р-78, Р-88] */
export interface AdminActor {
  membershipId: string;
  userId: string;
  mfa: boolean;
}

/**
 * Шаг 21: правка границ единицы записи. Пишется уровень WRITE_SCOPE новой версией (append-only); действующая граница — как у
 * базы: пол — наибольший из уровней товара и единицы, потолок — наименьший [Р-18, Р-43]. expected — действующие границы, которые
 * человек видел на экране различий: если они изменились, правка не применяется (CONFLICT), экран строится заново.
 */
export interface BoundsEditInput {
  writeScopeId: string;
  minMinor?: number;
  maxMinor?: number;
  expected: { minMinor: number | null; maxMinor: number | null };
}

export interface BoundsEditRow {
  writeScopeId: string;
  currency: string;
  before: { minMinor: number | null; maxMinor: number | null };
  /** Действующие границы после правки — как их вычислит база */
  after: { minMinor: number | null; maxMinor: number | null };
}

export type BoundsEditResult =
  | { status: 'PREVIEWED' | 'APPLIED'; rows: BoundsEditRow[] }
  | { status: 'FORBIDDEN' }
  /** Р-88: применение правки границ больше одной единицы записи — только со вторым фактором; экран различий его не требует */
  | { status: 'MFA_REQUIRED' }
  | { status: 'CONFLICT'; writeScopeId: string; actual: { minMinor: number | null; maxMinor: number | null } }
  | { status: 'INVALID'; writeScopeId: string; cause: 'SCOPE_NOT_FOUND' | 'AMOUNT_INVALID' | 'MIN_ABOVE_MAX' | 'NOTHING_TO_CHANGE' | 'DUPLICATE_SCOPE' };

/** Шаг 21: новая версия стратегии и её назначение единицам записи — после превью */
export interface StrategySaveInput {
  /** null — новая стратегия */
  strategyId: string | null;
  name: string;
  params: StrategyDefinition['params'];
  deadbandMinor: number;
  assignTo: string[];
  /** Стратегии единиц, которые видел человек на экране превью; изменились — CONFLICT (находка 4 ревью шага 21) */
  expected?: Array<{ writeScopeId: string; strategyId: string | null; version: number | null }>;
}

/** Р-123 (шаг 24): объявление скидки с прежней ценой и проверкой Omnibus на момент объявления */
export interface DiscountAnnouncementInput {
  writeScopeId: string;
  referencePriceMinor: number;
  salePriceMinor: number;
  currency: string;
  startsAt: Instant;
  endsAt: Instant | null;
}

export interface DiscountAnnouncementRow extends DiscountAnnouncementInput {
  announcementId: string;
  createdAt: Instant;
  createdByMembershipId: string;
  /** Проверка на момент объявления — вычислена базой */
  check: OmnibusPriorPrice;
}

export type DiscountAnnounceResult =
  | { status: 'ANNOUNCED'; announcement: DiscountAnnouncementRow }
  | { status: 'FORBIDDEN' }
  /** Прежняя цена выше наименьшей цены окна — база отклонила */
  | { status: 'VIOLATION'; check: OmnibusPriorPrice }
  | { status: 'INVALID'; cause: 'SCOPE_NOT_FOUND' | 'CURRENCY_MISMATCH' | 'PRICES_INVALID' | 'PERIOD_INVALID' | 'STARTS_BEFORE_TODAY' };

/** Р-123: доказательная история цен — сутки витрины с наименьшей, наибольшей, первой и последней ценой, исправления отмечены */
export interface PriceEvidenceDay {
  writeScopeId: string;
  day: string;
  timeZone: string;
  currency: string;
  basis: PriceBasis;
  minMinor: number;
  maxMinor: number;
  firstMinor: number;
  lastMinor: number;
  changes: number;
  /** CLOSED — суточная свёртка (вечно, Р-21); OPEN — сутки не закрыты, из сырья цен */
  source: 'CLOSED' | 'OPEN';
  corrected: boolean;
  correctionReason: string | null;
}

/** OQ-170 (шаг 24): кто, когда и в каком статусе создал версию стратегии */
export interface ConsoleStrategyVersionRow {
  strategyId: string;
  version: number;
  name: string;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: Instant | null;
  createdByMembershipId: string | null;
}

/** OQ-169 (шаг 24): назначение существующей версии без новой — после превью её параметров */
export interface StrategyAssignInput {
  strategyId: string;
  version: number;
  assignTo: string[];
  expected?: Array<{ writeScopeId: string; strategyId: string | null; version: number | null }>;
}

/** OQ-169: снять стратегию с единиц записи — только при выключенном репрайсинге (движку нужна стратегия, write_scope_engine_has_strategy) */
export interface StrategyUnassignInput {
  writeScopeIds: string[];
  expected?: Array<{ writeScopeId: string; strategyId: string | null; version: number | null }>;
}

export type StrategyUnassignResult =
  | { status: 'UNASSIGNED'; writeScopeIds: string[] }
  | { status: 'FORBIDDEN' }
  | { status: 'CONFLICT'; writeScopeId: string }
  | { status: 'INVALID'; cause: 'SCOPE_NOT_FOUND' | 'REPRICING_ENABLED'; writeScopeId?: string };

export type StrategySaveResult =
  | { status: 'SAVED'; strategy: StrategyDefinition; assigned: string[] }
  | { status: 'FORBIDDEN' }
  | { status: 'CONFLICT'; writeScopeId: string }
  /** STRATEGY_UNAVAILABLE — канал не даёт нужных данных конкурентов [Р-39]; CHANNEL_PRICING_ACTIVE — у оффера ценообразование канала [Р-120] */
  | { status: 'INVALID'; cause: 'STRATEGY_NOT_FOUND' | 'SCOPE_NOT_FOUND' | 'NAME_REQUIRED' | 'STRATEGY_UNAVAILABLE' | 'CHANNEL_PRICING_ACTIVE' | 'VERSION_NOT_ACTIVE'; writeScopeId?: string };

/** Р-120: наблюдение собственного ценообразования канала у оффера */
export interface OfferChannelPricingObservation {
  marketplace: string;
  externalSku: string;
  automatedPricing: boolean;
  channelBounds: boolean;
  source: 'DISCOVERY' | 'PRE_WRITE_READ' | 'READBACK';
  observedAt: Instant;
}

export interface ConsoleOfferChannelPricingRow extends OfferChannelPricingObservation {
  channelAccountId: string;
}

/** Шаг 23: последнее состояние PRICING_HEALTH оффера для экрана товаров (данные канала, 18 мес) */
export interface ConsolePricingHealthRow {
  channelAccountId: string;
  marketplace: string;
  channelProductRef: string;
  condition: string;
  issueType: string;
  occurredAt: Instant;
  competitivePriceThreshold: Money | null;
}

/** Шаг 23: запись журнала обработанных уведомлений (дедупликация по идентификатору уведомления канала) */
export interface InboundNotificationEntry {
  channelAccountId: string;
  notificationId: string;
  notificationType: string;
  eventTime: Instant | null;
  receivedAt: Instant;
}

export interface PricingStore {
  loadEvaluationContext(tenantId: string, key: ProductKey, now: Instant, shift: ShiftWindow): Promise<EvaluationContext>;
  /** Пересчёт без нового снимка: контекст единицы и последний принятый снимок её товара */
  loadScopeContext(tenantId: string, writeScopeId: string, now: Instant): Promise<{ context: ScopeEvaluationContext; snapshot: AcceptedSnapshot | null; snapshotRef: StoredSnapshotRef | null } | null>;
  commitEvaluation(tenantId: string, input: EvaluationCommit): Promise<EvaluationCommitResult>;
  /**
   * Итог отправки — те же правила, что у диспетчера [Р-64]: ACCEPTED (и APPLIED, если канал применил сразу), временная ошибка —
   * FAILED со сроком повтора, постоянная — завершение с причиной, OUTCOME_UNKNOWN — запись в полёте до сверки.
   */
  recordDispatch(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant): Promise<DispatchRecorded>;
  /** Р-116: как WriteQueueStore.checkPriceBasis — для первой отправки пути решения (ревью шага 22, находка 1) */
  checkPriceBasis(tenantId: string, write: FieldWrite, observedMinor: number, now: Instant): Promise<{ distrustId: string; reason: { code: string; params: Record<string, unknown> } } | null>;
  /**
   * Р-118: снятие остановки по недоверию каналу — только человек с правом RELEASE_CHANNEL_DISTRUST, от своего имени, со вторым фактором
   * и заметкой; БД дублирует проверки (0082). RELEASED или NOT_ACTIVE (уже снята или не существует).
   */
  releaseDistrust(tenantId: string, distrustId: string, release: { membershipId: string; userId: string; mfa: boolean; note: string; at: Instant }): Promise<'RELEASED' | 'NOT_ACTIVE'>;

  getPriceScope(tenantId: string, writeScopeId: string): Promise<PriceScopeContext | null>;
  resolveBounds(tenantId: string, writeScopeId: string): Promise<BoundsRead>;
  /** Включение режима ENGINE; реализация обязана отказать без обеих границ (как триггер 0030) */
  /** Р-97: смена режима — действие человека; userId — пользователь сессии административного сервиса */
  setPricingMode(tenantId: string, writeScopeId: string, mode: PriceScopeContext['pricingMode'], userId?: string): Promise<void>;
  /** Шаг 21: PREVIEW — те же проверки и действующие границы после правки без сохранения; APPLY — всё или ничего */
  editBounds(tenantId: string, edits: readonly BoundsEditInput[], actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<BoundsEditResult>;
  saveStrategy(tenantId: string, input: StrategySaveInput, actor: AdminActor): Promise<StrategySaveResult>;
  /** Р-123 (шаг 24): наименьшая цена за 30 суток витрины до начала скидки — предупреждение до объявления */
  /**
   * Р-121, Р-122: снимок источника только для сверки (роль RECONCILIATION) — в журнал снимков без проверки входов и решения; проверка
   * потери (только при расхождении, совпадение отклоняет база) — в той же транзакции
   */
  recordReconciliationSnapshot(tenantId: string, entry: { channelAccountId: string; competitorSnapshotId: string; snapshot: CompetitorSnapshot; receivedAt: Instant; lossCheck?: NotificationLossCheck }): Promise<void>;
  /** Р-121: последнее принятое состояние товара (competitor_state) — прежнее состояние сверки без чтения контекста решения */
  heldCompetitorState(tenantId: string, key: ProductKey): Promise<{ observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null } | null>;
  /** Р-121: вердикты проверок аккаунта, срок которых наступил к at; вычисляет база */
  reviewNotificationLoss(tenantId: string, channelAccountId: string, at: Instant): Promise<NotificationLossVerdict[]>;
  /**
   * Р-121: сверка по кругу — size товаров аккаунта, окно по номеру вызова cycle; все товары покрываются за ceil(n / size) вызовов подряд.
   * total — число товаров круга (время полного круга, OQ-176)
   */
  pickReconciliationSample(tenantId: string, channelAccountId: string, size: number, cycle: number): Promise<{ queries: CompetitorQuery[]; total: number }>;
  /**
   * Р-47, Р-126 (шаг 25): товары аккаунта для ярусного опроса планировщика — время последнего опроса (не последнего состояния: его
   * обновляют уведомления) и оценка волатильности: изменений цены конкурентов за 48 часов × 15 (движения хранятся 2 суток, Р-42)
   */
  listPollCandidates(tenantId: string, channelAccountId: string, now: Instant): Promise<PollCandidate[]>;
  /** Р-126: опрос товаров выполнен — время последнего опроса */
  markPolled(tenantId: string, channelAccountId: string, queries: readonly CompetitorQuery[], at: Instant): Promise<void>;
  omnibusCheck(tenantId: string, writeScopeId: string, startsAt: Instant): Promise<OmnibusPriorPrice>;
  /** Р-123: объявление скидки — только человек с правом MANAGE_PRICING; нарушение отклоняет база (0087) */
  announceDiscount(tenantId: string, input: DiscountAnnouncementInput, actor: AdminActor): Promise<DiscountAnnounceResult>;
  discountAnnouncements(tenantId: string): Promise<DiscountAnnouncementRow[]>;
  /** Р-123: доказательная история цен за период (сутки витрины, границы включительно) */
  priceEvidence(tenantId: string, range: { from: string; to: string; writeScopeIds?: string[] }): Promise<PriceEvidenceDay[]>;
  /** OQ-169: существующая версия — единицам записи, без новой версии; те же проверки базы, что при сохранении */
  assignStrategyVersion(tenantId: string, input: StrategyAssignInput, actor: AdminActor): Promise<StrategySaveResult>;
  unassignStrategy(tenantId: string, input: StrategyUnassignInput, actor: AdminActor): Promise<StrategyUnassignResult>;
  /** Р-120: наблюдения при обнаружении офферов — до назначения стратегии; назначение по действующему наблюдению отклоняет БД (0082) */
  recordOfferChannelPricing(tenantId: string, channelAccountId: string, observations: readonly OfferChannelPricingObservation[]): Promise<number>;
  /** Шаг 23: PRICING_HEALTH — в решение не входит, состояние оффера для продавца */
  recordPricingHealth(tenantId: string, channelAccountId: string, health: PricingHealthObservation, notification?: InboundNotificationEntry): Promise<'RECORDED' | 'DUPLICATE_NOTIFICATION'>;
  /** Шаг 23: журнал обработанных уведомлений тенанта — повтор доставки из очереди не обрабатывается второй раз */
  wasNotificationProcessed(tenantId: string, channelAccountId: string, notificationId: string): Promise<boolean>;
  markNotificationProcessed(tenantId: string, entry: InboundNotificationEntry): Promise<void>;

  listDueHalts(tenantId: string, channelAccountId: string, now: Instant): Promise<HaltInfo[]>;
  getHalt(tenantId: string, haltId: string): Promise<HaltInfo | null>;
  /** Товары витрины для независимой выборки при проверке остановки [Р-52] */
  pickReviewSample(tenantId: string, halt: HaltInfo, size: number): Promise<CompetitorQuery[]>;
  /** Запись в журнал и снятие остановки — одна транзакция */
  releaseHalt(tenantId: string, haltId: string, review: HaltReviewRecord): Promise<void>;
  /** Запись в журнал и перенос следующей проверки — одна транзакция */
  /** Наблюдения выборки проверки остановки (0063): у пути решения нет прав писать саму проверку и снятие */
  recordHaltSample(tenantId: string, haltId: string, samples: readonly HaltSampleObservation[], now: Instant): Promise<void>;
  /** Итог проверки выборки вычисляет хранилище: провал — новый срок; достаточно чистых наблюдений после срока — автоматическое снятие */
  reviewHaltBySample(tenantId: string, haltId: string, now: Instant): Promise<HaltSampleReview>;

  /**
   * Остановка человеком [Р-69, Р-70]: право — у ролей PRICING_PERMISSIONS.STOP_PRICING, заметка обязательна.
   * Действующая остановка той же области — ALREADY_ACTIVE без изменений. БД дублирует проверки (0042).
   */
  stopPricing(tenantId: string, record: StopRecord): Promise<StopResult>;
  /** Снятие: тенант — только владелец, аккаунт и витрина — владелец и оператор; заметка обязательна */
  releaseStop(tenantId: string, stopId: string, release: StopRelease): Promise<StopResult>;
  /** Состояние для экранов консоли [Р-67, Р-68]: объяснения — из слепков решений, а не из отчётов прогона */
  readConsoleState(tenantId: string, now: Instant): Promise<ConsoleState>;
}

// ---------------------------------------------------------------------------
// Состояние для консоли: одинаково в памяти и на PostgreSQL
// ---------------------------------------------------------------------------

export interface ConsoleScopeRow {
  writeScopeId: string;
  productId: string;
  channelAccountId: string;
  marketplace: string;
  externalUnitId: string;
  channelProductRef: string;
  condition: string;
  gtin: string | null;
  currency: string;
  basis: PriceBasis;
  taxRegime: TaxRegime;
  pricingMode: PriceScopeContext['pricingMode'];
  status: PriceScopeContext['status'];
  strategy: StrategyDefinition | null;
  currentPriceMinor: number | null;
  bounds: PriceBounds;
  /** Себестоимость и комиссии в валюте возникновения (перевод — при показе, как в решении) */
  cost: CostInputs | null;
  minMarginBp: number | null;
  channelHalt: HaltRef | null;
  channelDistrust: DistrustRef | null;
  priceStop: StopRef | null;
}

export interface ConsoleDecisionRow extends PriceDecisionDraft, ExplanationIntentColumns {
  decisionId: string;
  intentId: string;
  /** Нет у решения NO_OP [Р-74] */
  explanation?: DecisionExplanation | null;
  snapshotRef: SnapshotRef | null;
}

/** Остановки и системные остановки в журнале аудита [Р-76] */
export interface ConsoleAuditRow {
  /** Время действия (остановки, снятия) */
  at: Instant;
  action: 'pricing.stop_created' | 'pricing.stop_released' | 'pricing.halt_created' | 'pricing.halt_released' | 'pricing.distrust_created' | 'pricing.distrust_released';
  actorType: 'USER' | 'SYSTEM';
  membershipId: string | null;
  /** Роль участника в момент действия */
  role: MemberRole | null;
  entityType: 'price_stop' | 'pricing_halt' | 'channel_distrust';
  entityId: string;
  scope: AuditStopScope | null;
  channelAccountId: string | null;
  marketplace: string | null;
  note: string | null;
}

export interface ConsoleIntentRow extends IntentDraft {
  intentId: string;
}

export interface ConsoleWriteRow {
  channelWriteId: string;
  writeScopeId: string;
  decisionId: string | null;
  amountMinor: number;
  currency: string;
  basis: PriceBasis;
  version: number;
  status: string;
  attemptCount: number;
  competitorDerived: boolean;
  createdAt: Instant;
  dispatchedAt: Instant | null;
  acceptedAt: Instant | null;
  nextAttemptAt: Instant | null;
  lastErrorCode: string | null;
  endReason: string | null;
  endParams: Reason['params'];
  supersededByWriteId: string | null;
}

export interface ConsoleHaltRow {
  haltId: string;
  channelAccountId: string;
  marketplace: string | null;
  reasonCode: HaltReasonCode;
  details: Reason['params'];
  haltedAt: Instant;
  nextReviewAt: Instant;
  releasedAt: Instant | null;
  releasedKind: 'AUTO' | 'MANUAL' | null;
}

/** Остановка по недоверию каналу [Р-118] */
export interface ConsoleDistrustRow extends DistrustRef {
  channelAccountId: string;
  details: Reason['params'];
  releasedAt: Instant | null;
  releasedByMembershipId: string | null;
  releaseNote: string | null;
}

export interface ConsoleHaltReviewRow extends HaltReviewRecord {
  haltId: string;
}

export interface ConsoleStopRow extends StopRef {
  note: string;
  releasedAt: Instant | null;
  releasedByMembershipId: string | null;
  releaseNote: string | null;
}

export interface ConsoleRejectedSnapshotRow extends RejectedSnapshotRecord {
  rejectedSnapshotId: string;
  key: ProductKey;
}

export interface ConsoleDivergenceRow {
  divergenceCaseId: string;
  writeScopeId: string;
  expectedMinor: number;
  observedMinor: number;
  cause: string;
  status: string;
}

export interface ConsoleMemberRow {
  membershipId: string;
  userId: string;
  role: MemberRole;
  status: 'INVITED' | 'ACTIVE' | 'REVOKED';
}

export interface ConsoleState {
  tenantId: string;
  scopes: ConsoleScopeRow[];
  intents: ConsoleIntentRow[];
  decisions: ConsoleDecisionRow[];
  writes: ConsoleWriteRow[];
  halts: ConsoleHaltRow[];
  haltReviews: ConsoleHaltReviewRow[];
  distrusts: ConsoleDistrustRow[];
  /** Р-120: последнее наблюдение собственного ценообразования канала по каждому офферу */
  offerChannelPricing: ConsoleOfferChannelPricingRow[];
  /** Шаг 23: последнее уведомление PRICING_HEALTH по каждому офферу */
  pricingHealth: ConsolePricingHealthRow[];
  stops: ConsoleStopRow[];
  rejectedSnapshots: ConsoleRejectedSnapshotRow[];
  divergenceCases: ConsoleDivergenceRow[];
  fxRates: FxQuote[];
  members: ConsoleMemberRow[];
  /** Справочники слепка [Р-75]: версии стратегий, на которые ссылаются решения, наборы правил и профили Gate */
  strategies: StrategyDefinition[];
  /**
   * Шаг 23: имя стратегии; шаг 24 (OQ-170): автор, момент и статус каждой версии. Стратегии посева в памяти этих данных не имеют
   */
  strategyVersions: ConsoleStrategyVersionRow[];
  explanationRulesets: ExplanationRuleset[];
  audit: ConsoleAuditRow[];
}
