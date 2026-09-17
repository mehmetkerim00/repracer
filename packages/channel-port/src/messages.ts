import type { ChannelError } from './errors.ts';
import type {
  ChannelAccountId,
  ChannelWriteId,
  Instant,
  Money,
  OfferIdentity,
  ScopeField,
  TenantId,
  WriteField,
  WriteScopeId,
} from './primitives.ts';

// ---------------------------------------------------------------------------
// Запись
// ---------------------------------------------------------------------------

/** Ссылка на единицу записи. Ключ и идентичность выведены ядром из channel_capability (ADR-0002). */
export interface WriteScopeRef {
  writeScopeId: WriteScopeId;
  field: ScopeField;
  scopeKey: string;
  identity: OfferIdentity;
  /** Ключ дневного бюджета правок, если у поля есть бюджет */
  budgetScopeKey?: string;
}

export type WriteValue =
  | { field: 'PRICE'; price: Money }
  | { field: 'QUANTITY'; quantity: number }
  /** Только режим KAUFLAND_SMART_PRICING [Р-12] */
  | { field: 'CHANNEL_MIN_PRICE'; minPrice: Money };

/** Команда записи: строка tenant_data.channel_write в статусе PENDING/DISPATCHED */
export interface FieldWrite {
  channelWriteId: ChannelWriteId;
  writeScope: WriteScopeRef;
  version: number;
  idempotencyKey: string;
  value: WriteValue;
  /** Номер попытки (tenant_data.channel_write.attempt_count после увеличения) */
  attemptNo: number;
}

/** Расход бюджета правок одним вызовом канала: ядро списывает его в edit_budget до отправки [Р-19] */
export interface BudgetCharge {
  budgetScopeKey: string;
  field: WriteField;
  attempts: number;
}

export interface DispatchBatch {
  batchId: string;
  /** Операция канала (PATCH /units/{id_unit}, POST /units/bulk, patchListingsItem, bulkUpdatePriceQuantity) */
  operation: string;
  /** Не больше одной записи на единицу записи; порядок единицы гарантирует ядро (ADR-0005) */
  items: FieldWrite[];
  budgetCharges: BudgetCharge[];
  /** Сколько запросов к каналу займёт пакет — для лимитера */
  requestCount: number;
}

export interface DispatchPlan {
  batches: DispatchBatch[];
  /** Записи, которые адаптер отказывается отправлять без обращения к каналу (нарушено предусловие, лимит значения) */
  rejected: Array<{ channelWriteId: ChannelWriteId; error: ChannelError }>;
}

export type WriteOutcome =
  | {
      channelWriteId: ChannelWriteId;
      status: 'ACCEPTED';
      /** Канал применил синхронно и вернул значение (ответ содержит объект) */
      appliedImmediately: boolean;
      /** Ссылка на асинхронную отправку — хранится в channel_data.write_submission */
      submissionRef?: string;
      observation?: IdentifiedObservation;
    }
  | { channelWriteId: ChannelWriteId; status: 'REJECTED'; error: ChannelError }
  /** Запрос мог дойти до канала: перед повтором ядро делает readBack */
  | { channelWriteId: ChannelWriteId; status: 'OUTCOME_UNKNOWN'; error: ChannelError };

export interface DispatchResult {
  batchId: string;
  outcomes: WriteOutcome[];
  /** Фактическое число HTTP-попыток (с повторами транспорта) — для сверки с бюджетом */
  attemptsMade: number;
  rateLimit?: RateLimitObservation;
}

export interface RateLimitObservation {
  observedAt: Instant;
  operation: string;
  limitPerSecond?: number;
  remaining?: number;
}

// ---------------------------------------------------------------------------
// Наблюдение, обратное чтение, подтверждение
// ---------------------------------------------------------------------------

/** Наблюдение, привязанное к идентичности канала; ядро находит единицу записи по ключу */
export interface IdentifiedObservation {
  identity: OfferIdentity;
  field: WriteField;
  value: WriteValue;
  observedAt: Instant;
  source: 'READBACK' | 'PUSH_EVENT' | 'REPORT' | 'SYNC_RESPONSE';
  sourceEventId?: string;
  /** Цена, которую видит покупатель, если канал меняет её сам (Kaufland Smart Pricing: price ≠ listing_price) */
  effectivePrice?: Money;
  liveness?: { isLive: boolean; reasons: string[] };
}

export interface ReadBackRequest {
  writeScope: WriteScopeRef;
  fields: WriteField[];
}

export interface ReadBackResult {
  observations: IdentifiedObservation[];
  failures: Array<{ writeScopeId: WriteScopeId; error: ChannelError }>;
}

export interface ConfirmationRequest {
  channelWriteId: ChannelWriteId;
  writeScope: WriteScopeRef;
  expected: WriteValue;
  submissionRef?: string;
  dispatchedAt: Instant;
}

export type ConfirmationResult =
  | { channelWriteId: ChannelWriteId; status: 'APPLIED'; observation: IdentifiedObservation }
  | { channelWriteId: ChannelWriteId; status: 'NOT_APPLIED'; observation: IdentifiedObservation }
  | { channelWriteId: ChannelWriteId; status: 'PENDING'; checkAfter: Instant }
  | { channelWriteId: ChannelWriteId; status: 'UNKNOWN'; error: ChannelError };

// ---------------------------------------------------------------------------
// Конкуренты
// ---------------------------------------------------------------------------

export interface CompetitorQuery {
  marketplace: string;
  channelProductRef: string;
  condition: string;
}

export interface CompetitorOffer {
  rank?: number;
  /** Псевдоним/идентификатор продавца канала; не агрегируется между тенантами (AUP) */
  sellerRef?: string;
  isSelf: boolean;
  price: Money;
  shipping?: Money;
  totalPrice?: Money;
  condition?: string;
  fulfillment?: string;
  deliveryDays?: { min: number | null; max: number | null };
}

export interface CompetitorSnapshot {
  marketplace: string;
  channelProductRef: string;
  condition: string;
  /** Совпадает с channel_data.competitor_state.source */
  source: string;
  sourceEventId?: string;
  observedAt: Instant;
  /** Что именно содержит снимок: топ-N предложений, только минимальные цены, полный список */
  completeness: { kind: 'TOP_N'; n: number } | { kind: 'CHEAPEST_ONLY' } | { kind: 'FULL' };
  buybox?: { price: Money; isSelf: boolean };
  offers: CompetitorOffer[];
  /** Подсказка канала о цене для выигрыша (Kaufland target_price) — вход стратегии, не решение */
  channelSuggestedPrice?: Money;
}

export interface CompetitorReadResult {
  snapshots: CompetitorSnapshot[];
  failures: Array<{ query: CompetitorQuery; error: ChannelError }>;
}

// ---------------------------------------------------------------------------
// Офферы и заказы (без PII, Р-4)
// ---------------------------------------------------------------------------

export interface DiscoveredOffer {
  identity: OfferIdentity;
  /** EAN/GTIN — для сопоставления с Product */
  gtins: string[];
  condition: string;
  fulfillment: 'MERCHANT' | 'CHANNEL';
  currentPrice?: Money;
  currentQuantity?: number;
  isLive?: boolean;
  /**
   * Р-120: собственное ценообразование канала у оффера, прочитанное при обнаружении. automatedPricing — привязка к правилу
   * автоматического ценообразования (Amazon), channelBounds — границы цены на стороне канала. Нет поля — канал этого не сообщает.
   */
  channelPricing?: { automatedPricing: boolean; channelBounds: boolean };
}

export interface OrderLine {
  externalOrderRef: string;
  externalOrderLineRef: string;
  identity: OfferIdentity;
  quantity: number;
  orderedAt: Instant;
  status: 'OPEN' | 'CANCELLED' | 'SHIPPED' | 'RETURNED';
  /** Поля заказа берутся по белому списку; адрес, имя, контакты покупателя не передаются */
}

// ---------------------------------------------------------------------------
// Входящие события (вебхуки, уведомления)
// ---------------------------------------------------------------------------

export interface InboundDelivery {
  /** Заявленные ingest-шлюзом тенант и аккаунт (из токена в адресе вебхука или очереди) — проверяются адаптером [Р-31] */
  claimed: { tenantId: TenantId; channelAccountId: ChannelAccountId };
  method: string;
  /** Полный URL запроса — нужен для проверки подписи */
  url: string;
  headers: Readonly<Record<string, string>>;
  rawBody: string;
  receivedAt: Instant;
  /**
   * Уведомление очереди канала (шаг 24, OQ-171): идентификатор для журнала обработанных — путь решения записывает его в той же транзакции,
   * что снимок и решения. Вебхуку без идентификатора уведомления не задаётся
   */
  notification?: { notificationId: string; notificationType: string; eventTime: Instant | null };
}

/**
 * Шаг 23: состояние цены оффера по оценке канала (Amazon PRICING_HEALTH — оффер не может быть Featured Offer из-за неконкурентной цены).
 * Данные канала ≤ 18 мес [Р-3]; в решение о цене не входит — предупреждение продавцу. Перечень issueType канал не публикует.
 */
export interface PricingHealthObservation {
  marketplace: string;
  channelProductRef: string;
  condition: string;
  issueType: string;
  occurredAt: Instant;
  /** Порог конкурентной цены канала (summary.referencePrice.competitivePriceThreshold); нет в уведомлении — null */
  competitivePriceThreshold: Money | null;
  sourceEventId: string;
}

export type InboundEvent =
  | { kind: 'OBSERVATION'; observation: IdentifiedObservation }
  | { kind: 'PRICING_HEALTH'; health: PricingHealthObservation }
  | { kind: 'COMPETITOR_SNAPSHOT'; snapshot: CompetitorSnapshot }
  | { kind: 'ORDER_LINE'; orderLine: OrderLine }
  | { kind: 'OFFER_REMOVED'; identity: OfferIdentity; occurredAt: Instant }
  /** Уведомление без данных: ядро планирует обратное чтение ресурса */
  | {
      kind: 'RESOURCE_CHANGED';
      resource: string;
      identity?: OfferIdentity;
      /** Ресурс — конкуренты товара: ядро опрашивает их этим запросом (уведомление без данных, Р-46) */
      competitorQuery?: CompetitorQuery;
      occurredAt: Instant;
    };

export type InboundResult =
  /** Проверочный запрос подписки (Kaufland mode=subscribe&challenge): ответить ровно этим телом */
  | { kind: 'VERIFICATION'; responseStatus: number; responseBody: string }
  | { kind: 'EVENTS'; deliveryId: string; events: InboundEvent[]; acknowledgeStatus: number }
  | { kind: 'REJECTED'; error: ChannelError; responseStatus: number };
