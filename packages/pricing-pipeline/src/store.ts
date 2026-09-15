import type { DecisionExplanation, ExplanationIntentColumns, SanitySummary, FxFailureCause, FxQuote, HaltRef, MemberRole, PriceIntentDraft as IntentDraft, StopRef, StopScope } from '@repracer/pricing-model';
import type { ExplanationRuleset, StopScope as AuditStopScope } from '@repracer/pricing-model';
import type { CompetitorQuery, FieldWrite, Instant, PriceBasis, WriteOutcome } from '@repracer/channel-port';
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
  externalUnitId: string;
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
  reasonCode: 'CHANNEL_MASS_SHIFT';
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

export interface HaltReviewRecord {
  kind: 'AUTO_SAMPLE' | 'MANUAL_RELEASE';
  outcome: 'RELEASED' | 'SAMPLE_FAILED';
  sampleSize: number;
  failedCount: number;
  details: Reason['params'];
  membershipId?: string;
  /** Пользователь сессии ручного снятия (находка 4) */
  userId?: string;
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
  | { status: 'CONTEXT_CHANGED'; writeScopeId: string; reason: Reason };

/** Состояние единицы после итога записи — в той же транзакции */
export interface DispatchRecorded {
  slotFreed: boolean;
  /** Единица свободна и в очереди ждёт запись другой оценки — отправку продолжает диспетчер [Р-64] */
  queuedWaiting: boolean;
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

  getPriceScope(tenantId: string, writeScopeId: string): Promise<PriceScopeContext | null>;
  resolveBounds(tenantId: string, writeScopeId: string): Promise<BoundsRead>;
  /** Включение режима ENGINE; реализация обязана отказать без обеих границ (как триггер 0030) */
  setPricingMode(tenantId: string, writeScopeId: string, mode: PriceScopeContext['pricingMode']): Promise<void>;

  listDueHalts(tenantId: string, channelAccountId: string, now: Instant): Promise<HaltInfo[]>;
  getHalt(tenantId: string, haltId: string): Promise<HaltInfo | null>;
  /** Товары витрины для независимой выборки при проверке остановки [Р-52] */
  pickReviewSample(tenantId: string, halt: HaltInfo, size: number): Promise<CompetitorQuery[]>;
  /** Запись в журнал и снятие остановки — одна транзакция */
  releaseHalt(tenantId: string, haltId: string, review: HaltReviewRecord): Promise<void>;
  /** Запись в журнал и перенос следующей проверки — одна транзакция */
  recordFailedReview(tenantId: string, haltId: string, review: HaltReviewRecord, nextReviewAt: Instant): Promise<void>;

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
  action: 'pricing.stop_created' | 'pricing.stop_released' | 'pricing.halt_created' | 'pricing.halt_released';
  actorType: 'USER' | 'SYSTEM';
  membershipId: string | null;
  /** Роль участника в момент действия */
  role: MemberRole | null;
  entityType: 'price_stop' | 'pricing_halt';
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
  reasonCode: 'CHANNEL_MASS_SHIFT';
  details: Reason['params'];
  haltedAt: Instant;
  nextReviewAt: Instant;
  releasedAt: Instant | null;
  releasedKind: 'AUTO' | 'MANUAL' | null;
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
  stops: ConsoleStopRow[];
  rejectedSnapshots: ConsoleRejectedSnapshotRow[];
  divergenceCases: ConsoleDivergenceRow[];
  fxRates: FxQuote[];
  members: ConsoleMemberRow[];
  /** Справочники слепка [Р-75]: версии стратегий, на которые ссылаются решения, наборы правил и профили Gate */
  strategies: StrategyDefinition[];
  explanationRulesets: ExplanationRuleset[];
  audit: ConsoleAuditRow[];
}
