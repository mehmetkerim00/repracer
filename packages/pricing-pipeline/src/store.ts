import type { CompetitorView, FloorRaiseReason, OmnibusPriorPrice, PreviousOffers } from '@repracer/pricing-model';
import type { CreepState } from '@repracer/strategy-engine';
import type { DecisionExplanation, DistrustRef, ExplanationIntentColumns, SanitySummary, FxFailureCause, FxQuote, HaltRef, HaltReasonCode, MemberRole, PriceIntentDraft as IntentDraft, StopRef, StopScope } from '@repracer/pricing-model';
import type { ExplanationRuleset, StopScope as AuditStopScope } from '@repracer/pricing-model';
import type { ChannelBoundValues, CompetitorQuery, CompetitorSnapshot, FieldWrite, Instant, Money, OfferIdentity, PriceBasis, PricingHealthObservation, WriteOutcome, WriteRetryRule } from '@repracer/channel-port';
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
  /**
   * Р-171 (шаг 41): последнее предложение, удержанное ТЕНЬЮ. В бою — null: там «текущая цена» двигается сама, и повторов
   * не бывает. В тени она не двигается никогда, и без этого поля движок предлагал бы одно и то же на каждом опросе.
   */
  shadowLastProposedMinor?: number | null;
  /**
   * Р-212 (шаг 74): время последней БОЕВОЙ ступени лестницы к полу за сутки (решение с `ladder_from_minor`, не в тени) — от него
   * считается пауза до следующей
   */
  lastLadderStepAt?: Instant | null;
  /** Р-212: до какой цены дошла последняя БОЕВАЯ ступень за сутки — ступень от неё продолжает лестницу, от другой цены начинает новую */
  lastLadderStepFinalMinor?: number | null;
  /**
   * Шаг 97 [Р-219]: подъём «Win the Buy Box» — последний одобренный подъём и последний возврат после потери (из горячих намерений,
   * 3 суток); у прочих стратегий не читается
   */
  creep?: CreepState | null;
  /**
   * Шаг 75 (ревью шага 74): подпись предложения для писем — название товара или SKU продавца, как подпись K10 консоли. Название — только
   * данное продавцом: прочитанное из канала живёт 18 месяцев [Р-3], а событие алерта хранится до закрытия тенанта (ревью шага 75)
   */
  productTitle?: string | null;
  productSku?: string | null;
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
  costUnavailableCause?: FxFailureCause | 'FEE_ESTIMATE_MISSING' | null;
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
  /**
   * Шаг 53 (ревью шага 52, находка 13): последняя запись цены упёрлась в бюджет правок, который ещё не обновился — новое решение уйти
   * некуда, оценка пропускается без решения (иначе каждая оценка горячего яруса давала CHANGED и запись BUDGET_EXHAUSTED)
   */
  budgetExhausted?: { resetsAt: Instant | null; budgetDay: string | null } | null;
  /** Шаг 102 [Р-227]: действующий режим распродажи единицы — пол распродажи заменяет весь пол; null — режима нет */
  clearance?: ClearanceRef | null;
  /**
   * Шаг 107 [Р-233]: рамки цены, заданные продавцом в канале, по последнему наблюдению — только со значениями в валюте единицы (иначе
   * предложение блокируется целиком, Р-120, и до оценки не доходит); null — рамок нет
   */
  channelBounds?: { minMinor: number | null; maxMinor: number | null } | null;
}

/** Шаг 102 [Р-227]: включённый режим распродажи — строка журнала включения (`tenant_data.clearance_change`) */
/** Шаг 103 [Р-228]: почему правило умолчания не назначило стратегию новому предложению */
export type DefaultRuleReason = 'CHANNEL_PRICING' | 'NOT_WRITABLE' | 'STRATEGY_UNAVAILABLE';

/**
 * Шаг 103 [Р-228]: источник нынешней стратегии единицы — последняя строка журнала назначений. У правила умолчания — строка умолчания и
 * человек, который его задал: любое автоназначение прослеживается до живого человека
 */
export interface StrategyAssignmentRef {
  outcome: 'ASSIGNED' | 'UNASSIGNED' | 'NOT_ASSIGNED';
  source: 'PERSON' | 'DEFAULT_RULE';
  reason: DefaultRuleReason | null;
  strategyId: string | null;
  version: number | null;
  channelAccountId: string;
  at: Instant;
  rule: { changeId: string; setAt: Instant; setByMembershipId: string; setByName: string | null; setByEmail: string | null } | null;
}

/** Шаг 103 [Р-228]: действующее умолчание аккаунта — экран Channels; счётчики — решения правила по нему */
export interface DefaultStrategyRow {
  channelAccountId: string;
  /** null — «None — assign manually» */
  strategyId: string | null;
  strategyName: string | null;
  setAt: Instant;
  setByMembershipId: string;
  setByName: string | null;
  setByEmail: string | null;
  assigned: number;
  notAssigned: Array<{ reason: DefaultRuleReason; count: number }>;
}

export type DefaultStrategyResult =
  | { status: 'SET'; changeId: string }
  | { status: 'FORBIDDEN' }
  /** STRATEGY_UNAVAILABLE — канал не даёт стратегии данных [Р-39]; VERSION_NOT_ACTIVE — у стратегии нет активной версии (OQ-169) */
  | { status: 'INVALID'; cause: 'STRATEGY_UNAVAILABLE' | 'VERSION_NOT_ACTIVE' | 'ACCOUNT_DISCONNECTED' | 'ACCOUNT_NOT_FOUND' | 'STRATEGY_NOT_FOUND'; unmet?: Record<string, string[]> };

export interface ClearanceRef {
  changeId: string;
  floorMinor: number;
  currency: string;
  endsAt: Instant | null;
  note: string;
  enabledAt: Instant;
  enabledByMembershipId: string | null;
  /** Кто включил — имя и адрес участника (административный сервис читает их рядом с журналом); у памяти и без имени — null */
  enabledByName?: string | null;
  enabledByEmail?: string | null;
}

/** Шаг 102 [Р-227]: включение режима распродажи — пол распродажи, записка «зачем», подтверждение убытка, необязательная дата окончания */
export interface ClearanceEnableInput {
  writeScopeId: string;
  floorMinor: number;
  currency: string;
  endsAt: Instant | null;
  note: string;
  acknowledged: boolean;
}
export type ClearanceInvalidCause = 'ACK_REQUIRED' | 'NOTE_REQUIRED' | 'FLOOR_INVALID' | 'CURRENCY_MISMATCH' | 'ENDS_IN_PAST';
export type ClearanceEnableResult =
  | { status: 'ENABLED'; changeId: string }
  | { status: 'INVALID'; cause: ClearanceInvalidCause }
  | { status: 'MFA_REQUIRED' }
  | { status: 'FORBIDDEN' };
export type ClearanceDisableResult = { status: 'DISABLED' } | { status: 'NOT_ACTIVE' } | { status: 'FORBIDDEN' };
/** Строка журнала режима распродажи — история на странице пола; новые первыми */
export interface ClearanceChangeRow {
  changeId: string;
  action: 'ENABLE' | 'DISABLE' | 'EXPIRE';
  floorMinor: number | null;
  currency: string | null;
  endsAt: Instant | null;
  note: string | null;
  membershipId: string | null;
  byName?: string | null;
  byEmail?: string | null;
  at: Instant;
}
export interface ClearanceState {
  active: ClearanceRef | null;
  history: ClearanceChangeRow[];
}
/** Режим распродажи, закончившийся по дате, — для письма владельцу «цена вернётся к полу примерно за N шагов» */
export interface ClearanceEnded {
  writeScopeId: string;
  floorMinor: number;
  currency: string;
  endsAt: Instant;
  note: string;
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
  /** Шаг 97 [Р-218]: предложения предыдущего ПРИНЯТОГО снимка товара — для диффа «кто подвинул цену»; нет снимка — null */
  previousAccepted?: PreviousOffers | null;
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
  /**
   * Шаг 97 [Р-220]: держатель Buy Box по принятому снимку — только когда источник его называет: отрезок доли Buy Box
   * (`channel_data.buybox_span`) открывается или продлевается в той же транзакции
   */
  buyboxHolder?: BuyboxHolderObservation;
}

/** Шаг 97 [Р-220]: держатель Buy Box в момент снимка: мы, другой продавец (если канал его назвал) или никто */
export interface BuyboxHolderObservation {
  holder: 'SELF' | 'OTHER' | 'NONE';
  sellerRef: string | null;
}

/** Шаг 97 [Р-220]: отрезок держателя Buy Box — с какого снимка по какой, кто держал */
export interface BuyboxSpanRow {
  holder: 'SELF' | 'OTHER' | 'NONE';
  sellerRef: string | null;
  startedAt: Instant;
  lastSeenAt: Instant;
  snapshots: number;
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
  /** Р-128: самое старое наблюдение товара (движение, в том числе без изменения цены) за 48 ч старше суток */
  volatilityKnown: boolean;
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
  /** Шаг 97 [Р-218]: картина рынка и «кто подвинул» — только у цены из данных конкурентов и решения не «без изменения» (0187) */
  competitorView?: CompetitorView | null;
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
  /**
   * Р-169 (шаг 41): запись удержана ТЕНЬЮ — она завершена и в канал не пойдёт. Отличается от `pendingWriteId` тем, что
   * ждать нечего: это не очередь, а режим аккаунта, и на экране это разные причины [Р-94].
   */
  heldInShadow?: boolean;
  /**
   * Шаг 47 [Р-19, Р-163]: запись создана, но база не дала списать попытку правки — бюджет объекта канала за сутки витрины исчерпан
   * (edit_budget, у eBay — листинг). Решение и запись сохранены, запись завершена BUDGET_EXHAUSTED с причиной; в канал она не уйдёт.
   * До шага 47 отказ бюджета в транзакции фиксации откатывал решение целиком (PRICING_COMMIT_FAILED) — решение терялось.
   */
  endedUnsent?: { channelWriteId: string; status: 'BUDGET_EXHAUSTED'; reason: { code: string; params: Record<string, string | number | boolean | null> } };
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
  /**
   * Р-139 (шаг 30): действие выполняет фоновое задание этого тенанта. Второй фактор предъявлен при СОЗДАНИИ задания, поэтому
   * `mfa` здесь false: задание работает без человека у экрана. Стражи массового изменения принимают такое задание
   * (`security.second_factor_present`), а не признак, который процесс объявил бы сам за себя [Р-135].
   */
  bulkJobId?: string;
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
  /**
   * OQ-196 (шаг 33): `window` отличает окно [Р-135] («правок больше пяти за десять минут») от массовой правки («больше
   * одного предложения одной транзакцией»). Продавцу это разные события, и совет у них разный.
   */
  | { status: 'MFA_REQUIRED'; window?: boolean }
  | { status: 'CONFLICT'; writeScopeId: string; actual: { minMinor: number | null; maxMinor: number | null } }
  | { status: 'INVALID'; writeScopeId: string; cause: 'SCOPE_NOT_FOUND' | 'AMOUNT_INVALID' | 'MIN_ABOVE_MAX' | 'NOTHING_TO_CHANGE' | 'DUPLICATE_SCOPE' };

/**
 * Р-134 (шаг 28): массовый импорт себестоимости. Строка импорта — это себестоимость одного оффера: в базе она хранится профилем
 * товара в области оффера (товар + аккаунт + витрина), как и ручная правка.
 */
export interface CostImportRowInput {
  writeScopeId: string;
  /** Шаг 99: нет — себестоимость не меняется, строка несёт только комиссию */
  unitCostMinor?: number;
  currency: string;
  /** Фиксированная комиссия канала и комиссия от цены — оценка комиссии оффера [Р-32]; без них остаётся прежняя */
  fixedFeeMinor?: number;
  feeRateBp?: number;
  /**
   * Шаг 99 [Р-224]: что было на примерке — действующий профиль себестоимости предложения (null — не было) и оценка комиссии продавца.
   * Изменилось к применению — CONFLICT, ничего не применяется
   */
  expected?: { costProfileId: string | null; sellerFee: { feeRateBp: number | null; fixedFeeMinor: number | null } | null };
}

export interface CostImportBatch {
  /** Имя файла продавца — чтобы он узнал свой импорт в списке */
  sourceName: string;
  sourceFormat: 'CSV' | 'XLSX';
  /** Отпечаток предпросмотра: применяется ровно показанное [Р-134] */
  fingerprint: string;
  /** Сколько строк файла применены НЕ будут (показаны продавцу отдельно) */
  skippedRows: number;
  rows: readonly CostImportRowInput[];
  /** Шаг 99 [Р-224]: строка журнала импортов — пишется В ТОЙ ЖЕ транзакции, что и применение */
  run?: ImportRunInput;
  /** Шаг 99: часы мира, по которым считалась примерка, — на них сверяются ожидаемые значения (`expected` строк) */
  asOf?: string;
}

export type CostImportResult =
  | { status: 'PREVIEWED'; rows: number; offers: number }
  | { status: 'APPLIED'; importId: string | null; rows: number; offers: number; run?: ImportRunRow }
  /** Шаг 99 [Р-224]: данные предложения изменились после примерки — не применено ничего */
  | { status: 'CONFLICT'; writeScopeId: string }
  | { status: 'FORBIDDEN' }
  /** Р-135: импорт применяется только со вторым фактором; предпросмотр его не требует */
  | { status: 'MFA_REQUIRED'; window?: boolean }
  | { status: 'INVALID'; cause: 'NO_ROWS' | 'DUPLICATE_SCOPE' | 'AMOUNT_INVALID' | 'SCOPE_NOT_FOUND' | 'CURRENCY_MISMATCH'; writeScopeId?: string };

/**
 * Шаг 99 [Р-224]: импорт продавца — один из четырёх видов, и у каждого запуска (примерка, применение, отказ) строка журнала. Журнал
 * только на добавление; автора, момент и длительность ставит база из задания, которое строку пишет
 */
export type ImportKind = 'COSTS' | 'STOCK' | 'BOUNDS' | 'STRATEGY';
export const IMPORT_KINDS: readonly ImportKind[] = ['COSTS', 'STOCK', 'BOUNDS', 'STRATEGY'];
export type ImportRunOutcome = 'CHECKED' | 'APPLIED' | 'REFUSED';

export interface ImportRunInput {
  kind: ImportKind;
  outcome: ImportRunOutcome;
  /** Только у отказа: код причины (DATA_CHANGED, HAS_ERRORS, NOTHING_TO_APPLY, MFA_REQUIRED…) */
  reason?: string;
  fileName: string;
  /** SHA-256 файла продавца — по байтам, как он лежит у него на диске */
  fileSha256: string;
  rowsTotal: number;
  rowsChanged: number;
  rowsUnchanged: number;
  rowsRejected: number;
}

export interface ImportRunRow extends Omit<ImportRunInput, 'reason'> {
  runId: string;
  reason: string | null;
  bulkJobId: string;
  createdByMembershipId: string;
  createdByUserId: string;
  /** От нажатия («Check» или «Apply») до итога — считает база */
  durationMs: number;
  recordedAt: Instant;
}

/**
 * Шаг 99 [Р-224, Р-225]: импорт границ — нижняя и верхняя граница и минимальная маржа предложения. Всё уровня единицы записи;
 * `expected` — действующие значения на примерке: изменились — CONFLICT
 */
export interface BoundsImportRowInput {
  writeScopeId: string;
  minMinor?: number;
  maxMinor?: number;
  minMarginBp?: number;
  expected: { minMinor: number | null; maxMinor: number | null; minMarginBp: number | null };
}

export type BoundsImportResult =
  | { status: 'APPLIED'; offers: number; run?: ImportRunRow }
  | { status: 'FORBIDDEN' }
  | { status: 'MFA_REQUIRED'; window?: boolean }
  | { status: 'CONFLICT'; writeScopeId: string }
  | { status: 'INVALID'; writeScopeId: string; cause: 'SCOPE_NOT_FOUND' | 'AMOUNT_INVALID' | 'MIN_ABOVE_MAX' | 'NOTHING_TO_CHANGE' | 'DUPLICATE_SCOPE' };

/** Шаг 99 [Р-225]: назначение стратегий из файла — у каждого предложения своя действующая версия; `expected` — как у назначения */
export interface StrategiesImportInput {
  assignments: ReadonlyArray<{ writeScopeId: string; strategyId: string; version: number }>;
  expected: Array<{ writeScopeId: string; strategyId: string | null; version: number | null }>;
  run?: ImportRunInput;
}

export type StrategiesImportResult =
  | { status: 'ASSIGNED'; offers: number; run?: ImportRunRow }
  | { status: 'FORBIDDEN' }
  | { status: 'CONFLICT'; writeScopeId: string }
  | { status: 'INVALID'; cause: 'STRATEGY_NOT_FOUND' | 'SCOPE_NOT_FOUND' | 'STRATEGY_UNAVAILABLE' | 'CHANNEL_PRICING_ACTIVE' | 'VERSION_NOT_ACTIVE'; writeScopeId?: string };

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
  /** Шаг 107 [Р-233]: значения рамок, которые назвал канал; нет поля — значения не прочитаны (блок предложения целиком, Р-120) */
  boundValues?: ChannelBoundValues | null;
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

/** Повод запроса на переоценку — вход пола, который изменился [Р-209…Р-211]; тот же перечень, что у причины подъёма */
export type FloorRaiseAfter = FloorRaiseReason;
/** Шаг 73: единица для подъёма к полу без наблюдения конкурентов; `after` — повод (null — следующая ступень лестницы [Р-208]) */
export interface FloorRaiseCandidate { writeScopeId: string; after: FloorRaiseAfter | null; requestedAt: Instant | null }

export interface PricingStore {
  loadEvaluationContext(tenantId: string, key: ProductKey, now: Instant, shift: ShiftWindow): Promise<EvaluationContext>;
  /** Пересчёт без нового снимка: контекст единицы и последний принятый снимок её товара */
  loadScopeContext(tenantId: string, writeScopeId: string, now: Instant): Promise<{ context: ScopeEvaluationContext; snapshot: AcceptedSnapshot | null; snapshotRef: StoredSnapshotRef | null } | null>;
  commitEvaluation(tenantId: string, input: EvaluationCommit): Promise<EvaluationCommitResult>;
  /**
   * Итог отправки — те же правила, что у диспетчера [Р-64]: ACCEPTED (и APPLIED, если канал применил сразу), временная ошибка —
   * FAILED со сроком повтора, постоянная — завершение с причиной, OUTCOME_UNKNOWN — запись в полёте до сверки.
   */
  recordDispatch(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant, rule?: WriteRetryRule): Promise<DispatchRecorded>;
  /** Р-116: как WriteQueueStore.checkPriceBasis — для первой отправки пути решения (ревью шага 22, находка 1) */
  checkPriceBasis(tenantId: string, write: FieldWrite, observedMinor: number, now: Instant): Promise<{ distrustId: string; reason: { code: string; params: Record<string, unknown> } } | null>;
  /** Р-189 (E-22): как WriteQueueStore.recordEbayBatchOutcome — если своя отправка пути решения несёт итог пакета разных SKU */
  recordEbayBatchOutcome(tenantId: string, channelAccountId: string, multiSkuAccepted: boolean): Promise<string>;
  /**
   * Р-118: снятие остановки по недоверию каналу — только человек с правом RELEASE_CHANNEL_DISTRUST, от своего имени, со вторым фактором
   * и заметкой; БД дублирует проверки (0082). RELEASED или NOT_ACTIVE (уже снята или не существует).
   */
  releaseDistrust(tenantId: string, distrustId: string, release: { membershipId: string; userId: string; mfa: boolean; note: string; at: Instant }): Promise<'RELEASED' | 'NOT_ACTIVE'>;

  resolveBounds(tenantId: string, writeScopeId: string): Promise<BoundsRead>;
  /** Включение режима ENGINE; реализация обязана отказать без обеих границ (как триггер 0030) */
  /** Р-97: смена режима — действие человека; userId — пользователь сессии административного сервиса */
  setPricingMode(tenantId: string, writeScopeId: string, mode: PriceScopeContext['pricingMode'], userId?: string): Promise<void>;
  /** Шаг 21: PREVIEW — те же проверки и действующие границы после правки без сохранения; APPLY — всё или ничего */
  editBounds(tenantId: string, edits: readonly BoundsEditInput[], actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<BoundsEditResult>;
  /** Р-134, Р-135: массовый импорт себестоимости — предпросмотр без записи, применение целиком и со вторым фактором */
  importCosts(tenantId: string, batch: CostImportBatch, actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<CostImportResult>;
  /**
   * Шаг 102 [Р-227]: режим распродажи. Включает владелец или менеджер от своего имени со вторым фактором, подтверждением и запиской —
   * отказывает база (0197), хранилище переводит её отказ в причину. Выключение — одним действием, без второго фактора
   */
  enableClearance(tenantId: string, input: ClearanceEnableInput, actor: AdminActor): Promise<ClearanceEnableResult>;
  disableClearance(tenantId: string, input: { writeScopeId: string; note: string | null }, actor: AdminActor): Promise<ClearanceDisableResult>;
  clearanceOf(tenantId: string, writeScopeId: string): Promise<ClearanceState>;
  /**
   * Шаг 103 [Р-228]: стратегия по умолчанию для НОВЫХ предложений аккаунта (null — «None — assign manually»). Задаёт человек от своего
   * имени без второго фактора (действие внутри забора, Р-225); стратегия — с активной версией и доступная на канале [Р-39]
   */
  setDefaultStrategy(tenantId: string, channelAccountId: string, strategyId: string | null, actor: AdminActor): Promise<DefaultStrategyResult>;
  defaultStrategies(tenantId: string): Promise<DefaultStrategyRow[]>;
  /** Шаг 99 [Р-224, Р-225]: импорт границ и минимальной маржи — целиком, одной транзакцией вместе со строкой журнала */
  importBounds(tenantId: string, input: { rows: readonly BoundsImportRowInput[]; run?: ImportRunInput }, actor: AdminActor): Promise<BoundsImportResult>;
  /** Шаг 99 [Р-225]: назначение стратегий из файла — целиком, одной транзакцией вместе со строкой журнала */
  importStrategies(tenantId: string, input: StrategiesImportInput, actor: AdminActor): Promise<StrategiesImportResult>;
  /**
   * Шаг 99 [Р-224]: строка журнала импортов вне применения (примерка, отказ). Пишет её задание, которое сейчас идёт (`actor.bulkJobId`);
   * повтор того же задания строку не дублирует — возвращается записанная
   */
  recordImportRun(tenantId: string, run: ImportRunInput, actor: AdminActor & { bulkJobId: string }): Promise<ImportRunRow>;
  /** Строка журнала, которую задание уже записало: применение, повторённое после падения процесса, не применяется дважды */
  importRunOfJob(tenantId: string, bulkJobId: string): Promise<ImportRunRow | null>;
  /** История импортов одного вида — новые первыми; читает экран страницы импорта */
  importRuns(tenantId: string, query: { kind: ImportKind; limit: number }): Promise<ImportRunRow[]>;
  /**
   * Шаг 104 [Р-229]: журнал импортов вида за период [since, until) — страницей и с итогом (экран листает, выгрузка идёт подряд). Журнал
   * хранится до закрытия тенанта; без периода — весь
   */
  importRunsPage(tenantId: string, query: { kind: ImportKind; since?: Instant; until?: Instant; offset: number; limit: number }): Promise<{ items: ImportRunRow[]; total: number }>;
  /** Р-139 (шаг 30): массовые операции — фоновые задания с видимым ходом */
  createBulkJob(tenantId: string, input: BulkJobInput, actor: AdminActor): Promise<BulkJobCreated>;
  claimBulkJob(tenantId: string, owner: string, leaseSeconds: number): Promise<BulkJobRow | null>;
  /** Ход задания; false — аренда уже не наша: строку изменил другой процесс [находка 3 ревью шага 30] */
  updateBulkJobProgress(tenantId: string, jobId: string, owner: string, progress: BulkJobProgress): Promise<boolean>;
  /** Итог задания; false — итог НЕ записан, потому что аренда уже не наша */
  finishBulkJob(tenantId: string, jobId: string, owner: string, outcome: BulkJobOutcome): Promise<boolean>;
  listBulkJobs(tenantId: string, limit?: number): Promise<BulkJobRow[]>;
  /** Готовые файлы названных заданий — без содержимого: список заданий показывает, к какому из них можно вернуться */
  bulkJobArtifactSummaries(tenantId: string, jobIds: readonly string[]): Promise<Map<string, { fileName: string; rows: number; sha256: string }>>;
  bulkJob(tenantId: string, jobId: string): Promise<BulkJobRow | null>;
  /**
   * Р-145 (шаг 32): файл кладётся ПОД АРЕНДОЙ. Процесс называет базе свою аренду, и база отказывает, если задание уже взял
   * другой: иначе потерявший аренду процесс дописывает файл чужому заданию, и оно об этом не знает.
   */
  saveBulkJobArtifact(tenantId: string, jobId: string, artifact: BulkJobArtifact, leaseOwner: string): Promise<void>;
  bulkJobArtifact(tenantId: string, jobId: string): Promise<BulkJobArtifact | null>;
  /**
   * OQ-207: отменить ОЖИДАЮЩЕЕ задание. Идущее применение не отменяется: оно целиком или никак [Р-134], и «отмена» на полпути
   * означала бы то же, что падение процесса. Отмена — действие человека: у неё автор и строка аудита [Р-97].
   */
  cancelBulkJob(tenantId: string, jobId: string, actor: AdminActor): Promise<'CANCELLED' | 'NOT_WAITING' | 'FORBIDDEN'>;

  // --- онбординг [Р-149] ------------------------------------------------------------------------------------------------
  /** Где продавец остановился и до какого набора сузил путь; null — путь не начат */
  onboardingProgress(tenantId: string): Promise<OnboardingProgressRow | null>;
  /** Запись человека: последний шаг и сужение набора [Р-131 — пропустить себестоимость нельзя, можно сузить] */
  saveOnboardingProgress(tenantId: string, input: OnboardingProgressInput, actor: AdminActor): Promise<'SAVED' | 'FORBIDDEN'>;
  /** Состояние каждого шага, ВЫВЕДЕННОЕ из данных, а не из галочек: шаг завершён, потому что состояние проверяемо */
  onboardingStatus(tenantId: string): Promise<OnboardingStepStatus[]>;
  /** Аккаунты канала тенанта с честным состоянием доступа [Р-150] */
  channelAccounts(tenantId: string): Promise<ChannelAccountRow[]>;
  /** Р-151: демо ли тенант — по базе. Нужен там, где состояние консоли целиком не читается: исполнителю, когда он метит файл */
  tenantIsDemo(tenantId: string): Promise<boolean>;
  /**
   * Предложения, у которых себестоимость ГОТОВА К ВКЛЮЧЕНИЮ: объявлена [Р-131] и есть полная оценка комиссии
   * (`write_scope_cost_ready`) — то же, чего требует путь решения при включении. Сужение набора [Р-149] считается отсюда, а не по полю экрана: экран и база расходились.
   */
  scopesWithCost(tenantId: string): Promise<string[]>;
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
   * обновляют уведомления) и оценка волатильности: изменений цены конкурентов за 48 часов × 15 (движения хранятся 2 суток, Р-42); движение
   * 10 000 б. п. (новая / прежняя = 1) — цена не изменилась и не считается (ревью шага 25, находка 2)
   */
  listPollCandidates(tenantId: string, channelAccountId: string, now: Instant): Promise<PollCandidate[]>;
  /**
   * Шаг 47: единицы записи цены аккаунта в режиме ENGINE, чья стратегия НЕ читает данных конкурентов (FIXED, TARGET_MARGIN), —
   * их пересчитывает расписание. Без него такая цена не считалась нигде: пересчёт шёл только от снимка конкурентов, а у eBay
   * конкурентов нет вовсе (Р-39) — живой прогон пилота eBay не получил ни одного решения.
   * Ревью шага 47, находка 5: только ДОЛЖНЫЕ — без решения за последние 24 часа (первый раз — сразу после включения), самые давние
   * первыми, не больше `limit`. Иначе 10 000 единиц давали бы ~960 000 решений NO_OP в сутки на тенанта
   */
  /** Шаг 97: `creepPaceSeconds` — период ступени подъёма «Win the Buy Box» (плановый пересчёт канала) */
  listScheduledScopes(tenantId: string, channelAccountId: string, now: Instant, limit: number, creepPaceSeconds?: number): Promise<string[]>;
  /**
   * Шаг 73: единицы аккаунта, которые пересчёт поднимает к полу без наблюдения конкурентов — запрос на переоценку, поставленный базой
   * (повод — изменившийся вход пола [Р-209…Р-211]), и лестница к полу в работе у боевого аккаунта (последнее одобренное изменение —
   * ступень, записи в полёте нет [Р-208]). Самые давние первыми, не больше `limit`
   */
  listFloorRaiseScopes(tenantId: string, channelAccountId: string, now: Instant, limit: number): Promise<FloorRaiseCandidate[]>;
  /** Запрос на переоценку исполнен — снимается, если с прочитанного момента новый не поставлен */
  consumeFloorRaise(tenantId: string, writeScopeId: string, after: FloorRaiseAfter, requestedAt: Instant): Promise<void>;
  /**
   * Р-211 (шаг 74): курсы ЕЦБ и ставки НДС по умолчанию, ставшие действующими с прошлого захода, — запросы на переоценку единиц аккаунта
   * (FX_UPDATE, VAT_UPDATE). Это данные платформы: запрос ставит функция базы в границе тенанта, отметка «видели до» — у аккаунта.
   * Возвращает число поставленных запросов
   */
  requestFloorRaiseForPlatformInputs(tenantId: string, channelAccountId: string, now: Instant): Promise<number>;
  /** Шаг 102 [Р-227]: режимы распродажи аккаунта, чья дата окончания наступила, — строкой EXPIRE (часы базы) и запросом на переоценку */
  expireClearances(tenantId: string, channelAccountId: string): Promise<ClearanceEnded[]>;
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
  /**
   * Шаг 44 [Р-179]: обнаруженные офферы становятся каталогом тенанта — товар по SKU, предложение, единица записи цены в
   * режиме OFF. Идемпотентно; возвращает число СОЗДАННЫХ предложений. Цен и движка не касается [Р-131].
   */
  recordDiscoveredOffers(tenantId: string, channelAccountId: string, offers: readonly DiscoveredCatalogOffer[]): Promise<number>;
  /**
   * Шаг 52: количество, которым управляет канал (FBA), у предложений CHANNEL — наблюдение для экрана остатков (только чтение, 18 месяцев);
   * предложения FBM пропускаются базой. Нет у хранилища — наблюдение не хранится
   */
  recordChannelQuantities?(tenantId: string, channelAccountId: string, items: ReadonlyArray<{ marketplace: string; externalSku: string; quantity: number; observedAt: Instant }>): Promise<number>;
  /**
   * Шаг 60 [Р-202]: цена и количество канала у наших предложений — база сравнивает с последней применённой записью и целью и пишет внешние
   * правки (0158); возвращает число новых правок
   */
  recordChannelObservations?(tenantId: string, channelAccountId: string, items: ReadonlyArray<ChannelObservation>): Promise<number>;
  /**
   * Шаг 55 (OQ-240; ревью шага 54, находка 9): круг обнаружения аккаунта — где остановился прошлый заход. Каталог крупного продавца обходится
   * за несколько заходов; без хранилища круга каждый заход начинал бы с начала и обрывался бы на том же месте
   */
  discoveryCircleCursor?(tenantId: string, channelAccountId: string): Promise<string | null>;
  /** Шаг 56: состояние круга — курсор, начало текущего круга, закрытие прошлого (заходить ли; сколько длится круг аккаунта, Р-198) */
  discoveryCircleState?(tenantId: string, channelAccountId: string): Promise<{ cursor: string | null; circleStartedAt: Instant | null; lastCircleCompletedAt: Instant | null; lastStop: string | null } | null>;
  /**
   * Шаг 57: `startedAt` — начало захода (длительность круга, Р-198); `noProgress` — заход упал, не прочитав ни страницы с места продолжения.
   * 'RESET' — третий такой отказ подряд, круг сброшен к началу (ревью шага 56, находка 6)
   */
  saveDiscoveryCircle?(tenantId: string, channelAccountId: string, entry: { startedFrom: string | null; cursor: string | null; stop: DiscoveryStop; startedAt: Instant; at: Instant; noProgress: boolean }): Promise<'SAVED' | 'RESET'>;
  /** Шаг 55 (OQ-240): один вызов из суточной квоты канала на приложение, размазанной по суткам; false — отложить вызов */
  reserveAppCall?(channel: string, quota: string, dayLimit: number, at: Instant): Promise<boolean>;
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
  /**
   * Состояние для экранов консоли [Р-67, Р-68]: объяснения — из слепков решений, а не из отчётов прогона.
   * Шаг 66 (OQ-248): `scopeIds` — каталог только этих единиц (страница экрана); без него — весь каталог
   */
  readConsoleState(tenantId: string, now: Instant, options?: ConsoleStateOptions): Promise<ConsoleState>;
  /**
   * Шаг 66 (OQ-248): страница каталога и его итоги — базой, без каталога в памяти сервера. Порядок — тот же, что у каталога
   * состояния; смещение за концом подтягивается к последней странице. Хранилищу в памяти не нужно: его каталог мал
   */
  consoleCatalogPage?(tenantId: string, now: Instant, query: { offset: number; limit: number; offers?: OfferPageFilter }): Promise<ConsoleCatalogPage>;
  /**
   * Шаг 67 (OQ-248): то, что экрану нужно знать о каталоге ЦЕЛИКОМ, — числа, первые предложения, поиск, использование стратегий,
   * влияние остановки, ценообразование канала — базой, без каталога в памяти сервера. Хранилищу в памяти не нужно: его каталог мал
   */
  consoleCatalogFacts?(tenantId: string, query: ConsoleCatalogFactsQuery): Promise<ConsoleCatalogFacts>;
  // --- Р-154 (шаг 35): потоки — страницами, окнами, агрегатами -----------------------------------------------------
  decisionPage(tenantId: string, query: DecisionPageQuery): Promise<DecisionPage>;
  decisionDetail(tenantId: string, decisionId: string): Promise<DecisionDetail | null>;
  /**
   * Шаг 97 [Р-220]: отрезки держателя Buy Box предложения единицы, задевающие период [from, to) (и последний до него — его состояние
   * действует с начала периода); консоль считает долю Buy Box по ним
   */
  buyboxSpans(tenantId: string, writeScopeId: string, from: Instant, to: Instant): Promise<BuyboxSpanRow[]>;
  /** Шаг 97 [Р-218]: последний принятый снимок товара единицы — нынешняя картина рынка страницы Competition; нет снимка — null */
  competitionSnapshot(tenantId: string, writeScopeId: string): Promise<{ snapshot: CompetitorSnapshot; source: string; observedAt: Instant } | null>;
  /**
   * Шаг 105 [Р-230]: снимок и отрезки держателя за [from, to) у многих единиц одним обращением — колонки Buy Box показанной страницы Offers и
   * выгрузки; по смыслу — `competitionSnapshot` и `buyboxSpans` каждой единицы
   */
  competitionData(tenantId: string, writeScopeIds: readonly string[], from: Instant, to: Instant): Promise<CompetitionDataRow[]>;
  scopeDecisionStats(tenantId: string, writeScopeIds: readonly string[]): Promise<ScopeDecisionStats[]>;
  interventions(tenantId: string, from: Instant, to: Instant): Promise<InterventionSlice>;
  feedPage(tenantId: string, now: Instant, query: FeedPageQuery): Promise<FeedPage>;
  /** Последние события аудита остановок [Р-76] и смен ролей [Р-213], свежие первыми */
  auditRecent(tenantId: string, limit: number): Promise<ConsoleAuditRow[]>;
  /**
   * Шаг 104 [Р-229]: журнал аудита экрана Stop pricing (остановки, смены ролей, события канала) за период по времени действия [since,
   * until) — страницей и с итогом; свежие первыми, тем же порядком, что `auditRecent`
   */
  auditPage(tenantId: string, query: { since?: Instant; until?: Instant; offset: number; limit: number }): Promise<{ items: ConsoleAuditRow[]; total: number }>;
  /**
   * Шаг 88 [Р-213]: смена роли участника — одна роль на человека, новая заменяет прежнюю. Меняет владелец (или прежний администратор)
   * со вторым фактором; в журнал аудита событие пишет база (кто, когда, прежняя → новая), журнал только на добавление
   */
  changeMemberRole(tenantId: string, membershipId: string, role: MemberRole, actor: { userId: string; mfa: boolean }): Promise<MemberRoleChangeResult>;
  worldCounters(tenantId: string, now: Instant): Promise<WorldCounters>;
}

// ---------------------------------------------------------------------------
// Состояние для консоли: одинаково в памяти и на PostgreSQL
// ---------------------------------------------------------------------------


/**
 * Р-139 (шаг 30): массовые операции продавца — фоновые задания. Синхронный запрос на 10 000 предложений упирается в таймаут
 * прокси, и продавец видит ошибку при том, что изменения прошли. Задание создаётся, показывает ход, переживает перезагрузку
 * страницы, применяется целиком или никак [Р-134] и возобновляется после падения процесса.
 */
/**
 * Что делает задание. `STRATEGY_PREVIEW` ничего не меняет [OQ-201]: он считает решение по КАЖДОМУ предложению каталога, и
 * потому это работа, а не запрос, — предпросмотр по выборке был ценой синхронного ответа, а не свойством продукта.
 */
export type BulkJobKind = 'COST_IMPORT' | 'BOUNDS_EDIT' | 'BOUNDS_PLAN' | 'STRATEGY_ASSIGN' | 'STRATEGY_PREVIEW' | 'PRICE_EVIDENCE' | 'PRICE_FEED_EXPORT'
  /** Шаг 99 [Р-224]: шаблон импорта (файл с текущими значениями) и примерка файла — ничего не меняют, отдают файл */
  | 'IMPORT_TEMPLATE' | 'IMPORT_CHECK'
  /** Шаг 34 [Р-149]: включение движка у набора предложений — последний шаг пути; право своё, ENABLE_REPRICING */
  | 'REPRICING_ENABLE'
  /** Шаг 35 [Р-152]: файл остатков продавца — инвентаризация внутреннего пула; право — на каталог (MANAGE_CATALOG) */
  | 'STOCK_IMPORT'
  /** Шаг 35 [Р-139]: буфер аккаунта, единицы записи остатка и первые записи — на каталог целевого клиента это десятки секунд */
  | 'STOCK_SYNC_ENABLE'
  /** Шаг 104 [Р-229]: выгрузка экрана в файл (CSV / XLSX) — ничего не меняет, отдаёт файл; не больше 50 000 строк */
  | 'SCREEN_EXPORT';

/**
 * Р-143 (шаг 31): виды заданий, которые НИЧЕГО НЕ МЕНЯЮТ. Им второй фактор не нужен, и создать их может любой участник; но
 * ровно поэтому они не открывают окно для операций, которым он нужен, и их записи не считаются подтверждёнными. Список один
 * на всю систему — чтобы «ничего не меняет» и «не требует второго фактора» не разошлись по разным местам.
 */
/** OQ-207: сколько заданий тенант держит в очереди. То же число закреплено в базе (0111) — здесь оно для модели и экрана */
export const BULK_JOB_QUEUE_LIMIT = 20;
/** Сколько заданий держит в очереди ОДИН участник: меньше общего предела, чтобы один не занимал очередь тенанта */
export const BULK_JOB_MEMBER_QUEUE_LIMIT = 5;

export const READ_ONLY_JOB_KINDS: readonly BulkJobKind[] = ['BOUNDS_PLAN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'IMPORT_TEMPLATE', 'IMPORT_CHECK', 'SCREEN_EXPORT'];

/**
 * Р-145 (шаг 32): виды заданий, которые отдают продавцу ФАЙЛ. Повторяет `security.file_producing_job_kinds()` (0193) — список
 * один, база последнее слово. Шаг 99: файлы отдают шаблон импорта и примерка (отчёт об ошибочных строках); импорт себестоимости
 * файла больше не отдаёт — файл с ошибками не применяется вовсе [Р-224].
 */
export const FILE_PRODUCING_JOB_KINDS: readonly BulkJobKind[] = ['IMPORT_TEMPLATE', 'IMPORT_CHECK', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT', 'SCREEN_EXPORT'];
export type BulkJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED' | 'CANCELLED';
export type BulkJobPhase = 'PREPARING' | 'APPLYING' | 'PRODUCING' | 'DONE';

export interface BulkJobInput {
  kind: BulkJobKind;
  /** Что именно делать: ровно то, что человек видел на экране предпросмотра */
  params: Record<string, unknown>;
  totalItems?: number;
}

/** OQ-207: очередь тенанта имеет предел — иначе один участник задерживает массовые операции всех остальных */
export type BulkJobCreated =
  | { status: 'CREATED'; jobId: string; createdAt: string }
  | { status: 'MFA_REQUIRED' | 'FORBIDDEN' | 'QUEUE_FULL' };

export interface BulkJobRow {
  jobId: string;
  kind: BulkJobKind;
  status: BulkJobStatus;
  params: Record<string, unknown>;
  phase: BulkJobPhase | null;
  totalItems: number | null;
  doneItems: number;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  attempts: number;
  createdWithMfa: boolean;
  createdByMembershipId: string;
  /** Человек, создавший задание: его именем фоновый процесс пишет версии цен [Р-97] */
  createdByUserId: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  /**
   * Аренда истекла — то есть процесс, взявший задание, до него больше не дотянулся. Считает ХРАНИЛИЩЕ по часам базы, а не
   * экран по своим: расхождение часов консоли и базы показывало бы идущее применение как прерванное (находка 11 ревью шага 30).
   */
  leaseExpired: boolean;
}

export interface BulkJobProgress {
  phase?: BulkJobPhase;
  done?: number;
  total?: number;
  leaseSeconds?: number;
}

export type BulkJobOutcome =
  | { status: 'SUCCEEDED'; result: Record<string, unknown> }
  | { status: 'FAILED'; errorCode: string; result?: Record<string, unknown> }
  /** Процесс упал посреди применения: задание возвращается в очередь, а транзакция откатилась целиком [Р-134] */
  | { status: 'INTERRUPTED' };

/** Шаг 99: XLSX шаблона импорта — содержимое base64, контрольная сумма по байтам файла */
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export interface BulkJobArtifact {
  fileName: string;
  contentType: 'text/csv' | typeof XLSX_CONTENT_TYPE;
  /** CSV — текст; XLSX — base64 байтов файла */
  content: string;
  sha256: string;
  rows: number;
}

export interface ConsoleScopeRow {
  writeScopeId: string;
  productId: string;
  /** Шаг 68 (K10): SKU продавца и название товара — подпись предложения словами, а не номером единицы канала */
  sku?: string | null;
  title?: string | null;
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
  /**
   * Шаг 99 [Р-224]: себестоимость, объявленная продавцом, — даже без оценки комиссии (у `cost` её тогда нет). Шаблон импорта показывает
   * её как есть, и примерка сравнивает файл с ней: без этого предложение без комиссии всегда выглядело бы «без себестоимости»
   */
  declaredCost?: { costProfileId: string; currency: string; unitCostMinor: number } | null;
  /**
   * Шаг 99 [Р-225]: минимальная маржа уровня предложения (гардрейл единицы записи) и наибольшая из более широких уровней (товар, аккаунт,
   * тенант). Действует наибольшая из всех: маржа предложения ниже более широкой ничего не меняет, и импорт говорит это строкой
   */
  ownMinMarginBp?: number | null;
  widerMinMarginBp?: number | null;
  /**
   * Р-138 (шаг 29): все действующие оценки комиссии с источниками. Оценка продавца (`SELLER_DECLARED`) и тарифная таблица
   * репозитория (`FEE_SCHEDULE`) не смешиваются: при расхождении продавец видит оба числа, а пол считается по большему [Р-83].
   */
  feeEstimates?: Array<{ source: string; feeRateBp: number | null; fixedFeeMinor: number | null; scheduleVersion: string | null }>;
  channelHalt: HaltRef | null;
  channelDistrust: DistrustRef | null;
  priceStop: StopRef | null;
  /**
   * Р-154 (шаг 35): последняя ПРИМЕНЁННАЯ цена единицы — из истории цен (индекс по единице и времени), а не из перебора
   * всех записей тенанта. Принятая, но не применённая запись — в `writes` (в полёте).
   */
  lastApplied: { amountMinor: number; acceptedAt: Instant } | null;
  /** Шаг 102 [Р-227]: действующий режим распродажи — пилюля «Clearance» и пол распродажи на экранах */
  clearance?: ClearanceRef | null;
  /** Предел шага цены (гардрейл) — «вернётся к полу примерно за N шагов» при выключении распродажи */
  maxStepChangeBp?: number | null;
  /** Шаг 103 [Р-228]: откуда нынешняя стратегия — «assigned by default rule» на карточке стратегии; «not assigned: …» с причиной */
  assignment?: StrategyAssignmentRef | null;
}

export interface ConsoleDecisionRow extends PriceDecisionDraft, ExplanationIntentColumns {
  decisionId: string;
  intentId: string;
  /** Нет у решения NO_OP [Р-74] */
  explanation?: DecisionExplanation | null;
  snapshotRef: SnapshotRef | null;
  /** Шаг 97 [Р-218]: картина рынка в момент решения; живёт с решением 30 суток, у старых решений и прочих — null */
  competitorView?: CompetitorView | null;
}

/** Остановки и системные остановки в журнале аудита [Р-76]; с шага 88 [Р-213] — и смены ролей участников */
export interface ConsoleAuditRow {
  /** Время действия (остановки, снятия, смены роли) */
  at: Instant;
  action: 'pricing.stop_created' | 'pricing.stop_released' | 'pricing.halt_created' | 'pricing.halt_released' | 'pricing.distrust_created' | 'pricing.distrust_released'
    | 'membership.role_changed' | 'channel.offer_unpublished';
  actorType: 'USER' | 'SYSTEM';
  membershipId: string | null;
  /** Роль участника в момент действия (у смены роли — роль автора) */
  role: MemberRole | null;
  entityType: 'price_stop' | 'pricing_halt' | 'channel_distrust' | 'membership' | 'offer_pricing_health';
  /** Шаг 88 [Р-213]: смена роли — прежняя и новая роль и чья (адрес участника; в памяти адресов нет — null) */
  roleFrom?: MemberRole | null;
  roleTo?: MemberRole | null;
  memberEmail?: string | null;
  /** Шаг 93: имя участника (`app_user.display_name`), если оно есть, — только для показа; журнал хранит идентификаторы, как прежде */
  memberName?: string | null;
  /**
   * Шаг 89: событие канала в журнале — Walmart снял предложение с публикации (правило неконкурентной цены). Канал, витрина, о каком
   * предложении (название продавца или SKU) и цена «в другом месте», если канал её назвал (W-10). Это наблюдение канала, а не действие
   * человека: в журнал аудита базы оно не пишется, консоль показывает его рядом
   */
  channel?: string | null;
  offerName?: string | null;
  elsewhere?: Money | null;
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
  /** Р-190 (шаг 49): применение подтверждено только нашей записью у канала (eBay: предложение), не живым листингом */
  confirmedByOwnRecord: boolean;
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

export type MemberRoleChangeResult = { status: 'CHANGED' | 'UNCHANGED' } | { status: 'FORBIDDEN' | 'MFA_REQUIRED' | 'NOT_FOUND' };

export interface ConsoleMemberRow {
  membershipId: string;
  userId: string;
  role: MemberRole;
  status: 'INVITED' | 'ACTIVE' | 'REVOKED';
}

/**
 * Р-154 (шаг 35): состояние консоли ОГРАНИЧЕНО КАТАЛОГОМ. Здесь нет решений, намерений, истории записей, отклонённых снимков и
 * аудита — потоков, растущих со временем: демо на 200 предложениях даёт сто тысяч решений в сутки, и экран, читавший их
 * ради шести счётчиков, переставал отвечать за часы. Потоки читаются узкими методами хранилища: страницей, окном, агрегатом.
 * `writes` — только записи В ПОЛЁТЕ (одна на единицу), завершённые — в ленте.
 */
export interface ConsoleState {
  tenantId: string;
  /** Р-151: тенант на симуляторе. Признак — из БАЗЫ (`tenant.demo`), а не из настройки стенда: метку нельзя забыть поставить */
  demo: boolean;
  scopes: ConsoleScopeRow[];
  writes: ConsoleWriteRow[];
  halts: ConsoleHaltRow[];
  haltReviews: ConsoleHaltReviewRow[];
  distrusts: ConsoleDistrustRow[];
  /** Р-120: последнее наблюдение собственного ценообразования канала по каждому офферу */
  offerChannelPricing: ConsoleOfferChannelPricingRow[];
  /** Шаг 23: последнее уведомление PRICING_HEALTH по каждому офферу */
  pricingHealth: ConsolePricingHealthRow[];
  stops: ConsoleStopRow[];
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
}

// --- Р-154: потоки консоли — страницами, окнами и агрегатами ---------------------------------------------------------

/**
 * Шаг 96: группы исхода решения для фильтра журнала — словами продавца: цена изменилась (одобрено, в том числе на границе), без
 * изменения, отказ или удержание (Gate отказал, остановка удержала)
 */
export const DECISION_OUTCOME_GROUPS = { CHANGED: ['APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING'], NO_CHANGE: ['NO_CHANGE'], REJECTED: ['REJECTED', 'HELD'] } as const;
export type DecisionOutcomeGroup = keyof typeof DECISION_OUTCOME_GROUPS;

export interface DecisionPageQuery {
  offset: number;
  limit: number;
  writeScopeId?: string;
  /** Шаг 96 (Б11): набор предложений — найденные поиском экрана по мере ввода; пустой набор — ни одной строки */
  writeScopeIds?: readonly string[];
  /** Шаг 96: окно [since, until) по времени решения и группа исхода */
  since?: Instant;
  until?: Instant;
  outcome?: DecisionOutcomeGroup;
}

export interface DecisionPage {
  /** Свежие первыми */
  items: ConsoleDecisionRow[];
  /** Всего по запросу — считает база */
  total: number;
}

/** Одно решение с тем, что к нему относится: горячее намерение (3 дня) и записи в канал по нему */
export interface DecisionDetail {
  decision: ConsoleDecisionRow;
  intent: ConsoleIntentRow | null;
  writes: ConsoleWriteRow[];
  /** Шаг 102 [Р-227]: строка включения режима распродажи, при котором принято решение, — квитанция называет, кто, когда и зачем */
  clearance?: ClearanceRef | null;
  /** Шаг 103 [Р-228]: назначение стратегии, действовавшее в момент решения, — квитанция говорит «assigned by default rule» */
  assignment?: StrategyAssignmentRef | null;
}

/** Решения показанных единиц: последнее и сколько всего в горячем буфере — только для строк страницы, не для каталога */
export interface ConsoleStateOptions {
  scopeIds?: readonly string[];
}

/** Шаг 66 (OQ-248): страница каталога и итоги по всему каталогу — правила те же, что у экрана товаров (`enabledCell`) */
export interface ConsoleCatalogPage {
  scopeIds: string[];
  offset: number;
  total: number;
  enabled: number;
  stopped: number;
  off: number;
  applying: number;
  /**
   * Шаг 67 (п. 3): уведомления PRICING_HEALTH есть у тенанта — пробел экрана товаров. Мир страницы несёт уведомления только своих
   * единиц, и признак «есть вообще» считает база
   */
  pricingHealthIssues: boolean;
  /** Шаг 105 [Р-230]: предложений, прошедших фильтр экрана (без фильтра — весь каталог); по нему листаются страницы */
  matched: number;
  /** Шаг 105 [Р-230]: строк выгрузки конкурентов у прошедших фильтр (первые 10 снимка и наша строка) — по запросу `countCompetitorRows` */
  competitorRows?: number;
}

/** Шаг 105 [Р-230]: группа держателя Buy Box фильтра Offers; NO_DATA — канал конкурентов не даёт или снимка ещё нет */
export type OfferHolderFilter = 'SELF' | 'OTHER' | 'NONE' | 'UNKNOWN' | 'NO_DATA';
export type OfferSortKey = 'holder' | 'price' | 'gap' | 'share';

/**
 * Шаг 105 [Р-230]: фильтр и порядок страницы Offers. Держатель, цена Buy Box, разрыв и доля — правило страницы Competition (`buyboxFacts`
 * модели экранов), переписанное запросом; равенство держит тест на всех мирах стенда. Что канал называет — свойство аккаунта, его
 * знает консоль по описанию канала: аккаунты без данных конкурентов и аккаунты, чей канал называет держателя
 */
export interface OfferPageFilter {
  storefront?: { channelAccountId: string; marketplace: string };
  holder?: OfferHolderFilter;
  /** Поиск — по подписи экрана, SKU, ключу канала и EAN, как у поиска предложения (`consoleCatalogFacts.search`) */
  search?: { q: string; labelTemplate: string; marketplaceWords: Readonly<Record<string, string>>; channelNames: Readonly<Record<string, string>>; unknownChannel: string };
  sort?: { key: OfferSortKey; dir: 'asc' | 'desc' };
  /** Окно доли Buy Box (те же 7 дней, что у страницы Competition) и что канал аккаунта называет */
  buybox: { since: Instant; until: Instant; noDataAccounts: readonly string[]; namedAccounts: readonly string[] };
  /** Посчитать строки выгрузки конкурентов (потолок 50 000 — до создания задания) */
  countCompetitorRows?: boolean;
}

/** Шаг 105 [Р-230]: снимок и отрезки держателя единицы — то, из чего страница Competition и колонки Offers считают Buy Box */
export interface CompetitionData {
  snapshot: { snapshot: CompetitorSnapshot; source: string; observedAt: Instant } | null;
  spans: BuyboxSpanRow[];
}
/** Строка пакетного чтения: единица и её снимок с отрезками (массив, а не Map: обёртка стенда переводит идентификаторы в данных) */
export interface CompetitionDataRow extends CompetitionData { writeScopeId: string }

/**
 * Шаг 67 (OQ-248): что экран спрашивает о каталоге целиком. Каждое поле — правило экрана, переписанное запросом базы; равенство с
 * правилом экрана на всех мирах стенда держит `console-screens-targeted.pg.test.ts`
 */
export interface ConsoleCatalogFactsQuery {
  /** Первые N предложений каталога в его порядке — выбор предложения в формах (комплаенс, лента) */
  first?: number;
  /**
   * Поиск предложения — как `offers` консоли: подстрока (в нижнем регистре) подписи, номера единицы, ссылки товара или GTIN. Подпись
   * собирается шаблоном экрана (`{p}` — название или SKU товара, `{s}` — витрина словами) — шаг 68 (K10). Витрина — правилом
   * `storefrontName`: Kaufland — `kaufland.<код>`, иначе слово витрины из `marketplaceWords`, иначе имя канала единицы (ключ — код канала;
   * канал не из списка — `unknownChannel`) и код витрины
   */
  search?: { q: string; limit: number; labelTemplate: string; marketplaceWords: Record<string, string | undefined>; channelNames: Record<string, string>; unknownChannel: string };
  /** Использование стратегий: сколько предложений у каждой и первые `examples` из них в порядке каталога */
  strategyUsage?: { examples: number };
  /** Влияние остановки: включённые движком предложения и ждущие записи цены у них — по аккаунту и витрине */
  stopImpact?: boolean;
  /** Р-120: предложения с ценообразованием канала — последнее наблюдение каждого, первые `limit` на аккаунт и сколько всего */
  channelPricing?: { limit: number };
  /** Первая единица каталога по ключу снимка (витрина, ссылка товара, состояние) — отчёт отклонённых */
  keys?: ReadonlyArray<{ marketplace: string; channelProductRef: string; condition: string }>;
}

export interface ConsoleCatalogFacts {
  /** Предложений в каталоге */
  total: number;
  firstIds: string[];
  search: { ids: string[]; total: number } | null;
  /** Шаг 78: `storefronts` — сколько предложений стратегии на каждой витрине (сводка карточки стратегии вместо списка через запятую) */
  strategyUsage: Array<{ strategyId: string; count: number; exampleIds: string[]; firstCurrency: string; storefronts: Array<{ channel: string; marketplace: string; count: number }> }> | null;
  stopImpact: Array<{ channelAccountId: string; marketplace: string; enginePrices: number; pendingWrites: number }> | null;
  channelPricing: Array<{ channelAccountId: string; total: number; rows: ConsoleOfferChannelPricingRow[] }> | null;
  keyed: Array<{ marketplace: string; channelProductRef: string; condition: string; writeScopeId: string }> | null;
}

export interface ScopeDecisionStats {
  writeScopeId: string;
  latestDecisionId: string | null;
  latestDecidedAt: Instant | null;
  decisions: number;
}

/**
 * Вмешательства за окно: всё, что НЕ «без изменения». Решений без изменения — девять из десяти, и они не нужны ни отчёту об
 * отклонённых, ни отчёту об опасных изменениях; окно — свойство отчёта, а не буфера.
 */
/** Р-154: срез не бывает больше этого; отчёт показывает самые свежие и говорит, что показывает не всё */
export const INTERVENTION_SLICE_LIMIT = 5000;

export interface InterventionSlice {
  from: Instant;
  to: Instant;
  /** Вмешательств в окне больше, чем в срезе: отчёт неполон и обязан это сказать */
  truncated: boolean;
  /** Решения с исходом, отличным от NO_CHANGE, — со слепком объяснения */
  decisions: ConsoleDecisionRow[];
  /**
   * Горячие намерения окна, у которых цель упёрлась в границу (CAPPED_AT_*) или удержана (TARGET_OUTSIDE_BOUNDS_HOLD).
   * `episodeStart` — предыдущее намерение той же единицы (любое, не только из среза) не было на границе: с него
   * начинается новый эпизод удержания. Считается там, где видны ВСЕ намерения, — в базе оконной функцией; иначе два
   * удержания, разделённые оценкой без удержания, слиплись бы в одно (ревью шага 22, находка 4).
   */
  intents: Array<ConsoleIntentRow & { episodeStart: boolean }>;
  /** Записи, завершённые перепроверкой границ или остановкой человеком */
  endedWrites: ConsoleWriteRow[];
  rejectedSnapshots: ConsoleRejectedSnapshotRow[];
}

// Шаг 78 (п. 16): удержанное тенью — своя группа: «заменено новой ценой» о нём неправда, а это экран сценария показа
export type FeedStatusGroup = 'APPLIED' | 'IN_FLIGHT' | 'NOT_SENT' | 'SUPERSEDED' | 'SHADOW_HELD';
export const FEED_IN_FLIGHT_STATUSES: readonly string[] = ['PENDING', 'DISPATCHED', 'ACCEPTED', 'BLOCKED'];
export const FEED_NOT_SENT_STATUSES: readonly string[] = ['FAILED', 'NOT_APPLIED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED'];
export function feedGroupOf(status: string): FeedStatusGroup {
  return status === 'APPLIED' ? 'APPLIED' : status === 'SHADOW_HELD' ? 'SHADOW_HELD' : FEED_IN_FLIGHT_STATUSES.includes(status) ? 'IN_FLIGHT' : FEED_NOT_SENT_STATUSES.includes(status) ? 'NOT_SENT' : 'SUPERSEDED';
}

export interface FeedPageQuery {
  writeScopeId?: string;
  status?: FeedStatusGroup;
  /** Окно от `now` назад; без него — вся лента */
  sinceDays?: number;
  /** Шаг 96 (Б11): набор предложений — найденные поиском экрана; пустой набор — ни одной строки */
  writeScopeIds?: readonly string[];
  /** Шаг 96: окно [since, until) по времени записи — период экрана; перекрывает `sinceDays` */
  since?: Instant;
  until?: Instant;
  offset: number;
  limit: number;
  /**
   * Считать ли счётчики групп и итог. Они нужны ЭКРАНУ (подпись «21–40 из 10 000» и группы статусов) и не нужны
   * выгрузке, которая идёт страницами подряд: там это был бы полный подсчёт на каждую страницу (ревью шага 35, находка 8).
   */
  counts?: boolean;
}

export interface FeedPageItem {
  write: ConsoleWriteRow;
  decision: ConsoleDecisionRow | null;
  /** «Было» из горячего намерения (3 дня), если оно ещё есть */
  intentCurrentMinor: number | null;
}

export interface FeedPage {
  items: FeedPageItem[];
  total: number;
  /** По офферу и окну без фильтра статуса: сколько в каждой группе — считает база */
  counts: Record<FeedStatusGroup, number>;
}

/** Счётчики списка миров — агрегатом, без чтения состояния */
export interface WorldCounters {
  scopes: number;
  /** Решений за последние сутки */
  decisionsLastDay: number;
  /** Вмешательств (решений не «без изменения») за последние семь суток */
  interventionsLastWeek: number;
  activeStops: number;
  activeHalts: number;
  demo: boolean;
  /**
   * Шаг 68 (K3): у тенанта есть витрина в стране ЕС (подключённый аккаунт). Omnibus и §11 PAngV — правила ЕС [Р-123]: продавцу только
   * с витринами США вкладка проверки скидок ни о чём, кроме «не применимо», не скажет
   */
  euStorefronts: boolean;
}

// --- онбординг [Р-149], канал без доступов [Р-150] --------------------------------------------------------------------

export type OnboardingStep = 'TENANT' | 'CHANNEL' | 'STOCK_SOURCE' | 'STOCK_SYNC' | 'COSTS' | 'BOUNDS' | 'STRATEGY' | 'ENABLE';
/** Р-152: два пути; репрайсинг — вторым шагом, когда остатки уже идут */
export type OnboardingPath = 'STOCK' | 'STOCK_AND_PRICING';
export const ONBOARDING_STOCK_STEPS: readonly OnboardingStep[] = ['TENANT', 'CHANNEL', 'STOCK_SOURCE', 'STOCK_SYNC'];
export const ONBOARDING_PRICING_STEPS: readonly OnboardingStep[] = ['COSTS', 'BOUNDS', 'STRATEGY', 'ENABLE'];
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [...ONBOARDING_STOCK_STEPS, ...ONBOARDING_PRICING_STEPS];
export function onboardingStepsOf(path: OnboardingPath | null): readonly OnboardingStep[] {
  return path === 'STOCK' ? ONBOARDING_STOCK_STEPS : path === 'STOCK_AND_PRICING' ? ONBOARDING_STEPS : ['TENANT', 'CHANNEL'];
}

export interface OnboardingProgressRow {
  /** null — весь каталог; иначе — предложения, до которых путь сужен */
  scopeWriteScopeIds: string[] | null;
  /** Р-152: выбранный путь; null — не выбран */
  path: OnboardingPath | null;
  startedAt: string;
  updatedAt: string;
}

/**
 * Хранится только сужение набора. Отметки «последний шаг» нет намеренно (ревью шага 34, находка 6): место остановки —
 * первый незавершённый шаг выведенного состояния, а хранимая галочка расходилась бы с данными.
 */
export interface OnboardingProgressInput {
  /** undefined — не менять; null — снять сужение */
  scopeWriteScopeIds?: string[] | null;
  /** undefined — не менять */
  path?: OnboardingPath;
}

export interface OnboardingStepStatus {
  step: OnboardingStep;
  doneCount: number;
  totalCount: number;
  done: boolean;
  /** Только у шага CHANNEL: хотя бы один аккаунт ждёт доступа [Р-150] */
  awaiting: boolean;
}

/** Чего не хватает каналу, чтобы заработать [Р-150]; коды — security.channel_access_blockers() */
export type ChannelAccessBlocker = 'PARTNER_REGISTRATION' | 'DEVELOPER_KEYS' | 'NOTIFICATION_QUEUE' | 'SELLER_AUTHORIZATION';
export const CHANNEL_ACCESS_BLOCKERS: readonly ChannelAccessBlocker[] = ['PARTNER_REGISTRATION', 'DEVELOPER_KEYS', 'NOTIFICATION_QUEUE', 'SELLER_AUTHORIZATION'];
export type ChannelAuthStatus = 'ACTIVE' | 'REAUTH_REQUIRED' | 'REVOKED' | 'DISCONNECTED' | 'AWAITING_ACCESS';

export interface ChannelAccountRow {
  channelAccountId: string;
  channel: string;
  displayName: string | null;
  marketplaces: string[];
  authStatus: ChannelAuthStatus;
  accessBlockers: ChannelAccessBlocker[];
}

/** Шаг 44 [Р-179]: оффер канала для каталога — идентичность предложения, без цены (цена — решение движка, а не каталога) */
export interface DiscoveredCatalogOffer {
  marketplace: string;
  externalSku: string | null;
  externalUnitId: string | null;
  /** Kaufland: `id_offer` — общий на витрины ключ остатка [Р-35] */
  externalOfferId: string | null;
  channelProductRef: string | null;
  gtin: string | null;
  condition: string;
  /** Способ исполнения от канала: CHANNEL (FBA/FBK) остаток не синхронизирует */
  fulfillment: 'MERCHANT' | 'CHANNEL';
  /** Шаг 47 [Р-164]: eBay — номер листинга, формат и можно ли в него писать (под Inventory API) */
  externalListingId?: string | null;
  listingFormat?: 'FIXED_PRICE' | 'AUCTION' | null;
  writable?: boolean | null;
  /** Шаг 69 (OQ-249): название товара из канала — пишется в товар, только если у товара названия ещё нет */
  title?: string | null;
}

/** Шаг 55: чем кончился заход обхода — круг закрыт, срок вызова, квота приложения, предел страниц захода */
export type DiscoveryStop = 'COMPLETED' | 'DEADLINE' | 'APP_QUOTA' | 'PAGE_LIMIT' | 'FAILED';

/** Шаг 60 [Р-202]: что канал показывает у нашего предложения */
export interface ChannelObservation {
  marketplace: string;
  externalSku: string | null;
  externalOfferId: string | null;
  externalUnitId: string | null;
  priceMinor: number | null;
  currency: string | null;
  quantity: number | null;
  observedAt: Instant;
}

/** Шаг 64 (ревью шага 63, находки 6 и 7): путь решения пишет только цену — поле его записей для имени алерта (`writeAlertCode`) и заявок хранилища в памяти */
export const PIPELINE_WRITE_FIELD = 'PRICE' as const;
