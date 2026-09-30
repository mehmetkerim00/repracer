import type { Instant, OrderLine } from '@repracer/channel-port';

/** Участник, от чьего имени пишется административная запись [Р-97] */
export interface StockActor {
  membershipId: string;
  userId: string;
  mfa: boolean;
}

export type StockSourceMode = 'INTERNAL_POOL' | 'INBOUND_API';

export interface StockSourceRow {
  stockSourceId: string;
  mode: StockSourceMode;
  name: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: Instant;
  /** Сколько товаров источник уже отдал (пулы с остатком или отметкой источника) */
  products: number;
  /** У источника Inbound API есть действующий ключ (сам ключ не хранится — только отпечаток) */
  hasKey: boolean;
}

export type CreateStockSourceResult =
  /** Ключ Inbound API показывается ОДИН раз при создании: хранится только SHA-256 [0007] */
  | { status: 'CREATED'; stockSourceId: string; apiKey: string | null }
  | { status: 'FORBIDDEN' };

export interface StockImportRow {
  sku: string;
  quantity: number;
}

/** `AMBIGUOUS_SKU` — артикул подходит двум товарам: [Р-138] не угадывать, а показать продавцу */
export type StockImportUnmatchedReason = 'UNKNOWN_SKU' | 'BAD_QUANTITY' | 'DUPLICATE_SKU' | 'AMBIGUOUS_SKU';

export interface StockImportOutcome {
  status: 'APPLIED';
  /** Строк применено к товарам */
  matched: number;
  /** Товаров, у которых остаток ИЗМЕНИЛСЯ (движение записано); равные строки движения не создают */
  changed: number;
  unmatched: Array<{ sku: string; reason: StockImportUnmatchedReason }>;
  productIds: string[];
}

export interface InboundStockRow {
  sku: string;
  quantity: number;
  /** Момент, на который источник знает остаток: более старое значение не заменяет более новое (INV-10) */
  asOf: Instant;
}

export interface InboundStockOutcome {
  applied: number;
  stale: number;
  unknownSkus: string[];
  productIds: string[];
  /**
   * Шаг 59 (ревью шага 58, находка 3): товары ВСЕХ узнанных строк, включая устаревшие. Пересчёт после присылки может отказать по пределу
   * ожидания очереди пересчётов (503); повтор той же присылки придёт устаревшим — и без этого списка не пересчитал бы ничего
   */
  recognizedProductIds: string[];
}

export interface EnableStockSyncInput {
  bufferUnits: number;
  maxQuantity: number | null;
  minQuantityToList: number;
  /**
   * INV-11: у канала с побочным эффектом записи остатка (Amazon EU — весь регион [Р-1]) синхронизация включается только
   * после подтверждения человеком; без подтверждения единицы создаются, но не включаются
   */
  acknowledgeSideEffects: boolean;
}

export type EnableStockSyncResult =
  | { status: 'ENABLED'; scopes: number; created: number; awaitingAck: number }
  | { status: 'NO_OFFERS' }
  | { status: 'FORBIDDEN' }
  /** Шаг 60 [Р-202]: владелец не подтвердил, что количество в этом канале не ведут другие инструменты — запись количества выключена */
  | { status: 'NOT_CONFIRMED'; otherTools: OtherTools | null };

/** Шаг 60 [Р-202]: обновляет ли другой инструмент остатки или цены в этом канале — ответ владельца */
export type OtherTools = 'NONE' | 'STOCK' | 'PRICES' | 'STOCK_AND_PRICES';

export interface QuantityWritesState { externalAccountId: string; otherTools: OtherTools | null; confirmed: boolean }

export type AnswerOtherToolsResult = { status: 'ANSWERED' } | { status: 'FORBIDDEN' | 'NOT_FOUND' } | { status: 'CONFLICT'; reason: 'QUANTITY_WRITES_CONFIRMED' };

export type ConfirmQuantityWritesResult =
  | { status: 'CONFIRMED' }
  | { status: 'FORBIDDEN' | 'NOT_OWNER' | 'NOT_FOUND' | 'ALREADY_CONFIRMED' | 'CONFIRMATION_MISMATCH' | 'ANSWER_FIRST' | 'OTHER_TOOL_MANAGES_STOCK' };

/** Пересчёт: какие записи созданы. Отправляет их диспетчер [Р-64], не пересчёт */
export interface RecalculationOutcome {
  writes: Array<{ writeScopeId: string; quantity: number; version: number }>;
  /** Единицы, у которых значение не изменилось — записи нет */
  unchanged: number;
}

export interface OrderLinesOutcome {
  created: number;
  consumed: number;
  released: number;
  /** Строки, чей оффер нам неизвестен: резервации нет, остаток не трогается */
  unknownOffers: number;
  /**
   * Р-157 (шаг 36): отгрузка по резервации, которую источник ещё не подтвердил. Списать пул нельзя [Р-25] — подтверждает
   * источник, — но и молчать нельзя: до шага 36 такая строка просто пропадала (остаток ревью шага 35, находка 13)
   */
  awaitingConfirmation: number;
  /** Шаг 59 [Р-199]: новых строк возврата — у внутреннего пула ждут решения человека, у Inbound API — сведения */
  returns: number;
  /**
   * Шаг 57 (ревью шага 56, находка 1): товары ВСЕХ сопоставленных строк, а не только изменённых этим вызовом. Запись резерваций и пересчёт —
   * разные транзакции: упади пересчёт, повтор того же окна резерваций уже не меняет, и список «изменённых» пуст — остаток в каналах остался бы
   * завышенным до следующей продажи этого товара. Пересчёт неизменённого товара записей не создаёт
   */
  productIds: string[];
}

/** Р-157: источник Inbound API сообщает «заказ учтён»; резервации этого заказа переходят в CONFIRMED_BY_SOURCE */
export interface ConfirmOrdersOutcome {
  /** Сколько резерваций подтверждено этим вызовом */
  confirmed: number;
  /** Заказы, чьи резервации уже подтверждены (и, возможно, списаны): повтор вызова безвреден */
  alreadyConfirmed: string[];
  /**
   * Заказы, резервации которых УЖЕ СНЯТЫ — отменены или освобождены по сроку. Для склада это не «уже подтверждено»:
   * резерва нет, товар мог уйти другому покупателю [находка 8 ревью шага 36]
   */
  releasedOrders: string[];
  /** Заказы, резерваций которых у этого источника нет вовсе */
  unknownOrders: string[];
}

export interface StockChannelRow {
  writeScopeId: string;
  channelAccountId: string;
  channel: string;
  /** Витрины, которые делят это значение (Kaufland: все витрины одного id_offer) */
  marketplaces: string[];
  syncEnabled: boolean;
  /** Что мы посчитали к публикации по правилу буфера — ещё до записи */
  published: number;
  /** Последняя запись в канал: в полёте или завершённая */
  sent: { quantity: number; status: string; at: Instant; version: number } | null;
  /** Последняя запись, которую канал ПОДТВЕРДИЛ обратным чтением (APPLIED) */
  confirmed: { quantity: number; at: Instant; /** Р-190: подтверждено только нашей записью у канала (eBay в бою без Browse) */ ownRecordOnly?: boolean } | null;
  /** Последняя завершённая запись не применена каналом или не ушла — расхождение «у нас / в канале» */
  divergence: { status: string; since: Instant; errorCode: string | null } | null;
  /** Побочный эффект записи по возможности канала [Р-153]: общая на регион / на id_offer; требует ли подтверждения */
  sideEffects: { requiresAck: boolean; acknowledged: boolean; text: string | null };
}

export interface StockRow {
  productId: string;
  sku: string;
  gtin: string | null;
  onHand: number;
  reserved: number;
  available: number;
  channels: StockChannelRow[];
  /**
   * Шаг 52: количество, которым управляет КАНАЛ (Amazon FBA), у предложений товара — только для чтения, последнее наблюдение. В доступное
   * наше количество не входит и нашей записи не касается [Р-6]
   */
  channelManaged?: Array<{ channel: string; marketplace: string; quantity: number; observedAt: Instant }>;
}

export interface StockSummary {
  products: number;
  withStock: number;
  /** Единиц записи остатка с включённой синхронизацией */
  synced: number;
  pendingWrites: number;
  diverged: number;
  openReservations: number;
}

export interface StockPage {
  items: StockRow[];
  total: number;
  summary: StockSummary;
}

export interface StockDivergenceRow {
  writeScopeId: string;
  productId: string;
  sku: string;
  channel: string;
  marketplaces: string[];
  sent: number;
  confirmed: number | null;
  status: string;
  errorCode: string | null;
  since: Instant;
}

/**
 * Порт хранилища остатков. Роли разделены [Р-90, Р-102]: административная роль заводит источники, ключи, буферы и
 * единицы записи (человеком, с аудитом); роль остатков `svc_stock` двигает пулы, резервации и записи количества [Р-105].
 */
export interface StockStore {
  stockSources(tenantId: string): Promise<StockSourceRow[]>;
  createStockSource(tenantId: string, input: { mode: StockSourceMode; name: string }, actor: StockActor): Promise<CreateStockSourceResult>;
  /** Файл продавца → внутренний пул: инвентаризация (STOCKTAKE) до целевого значения по каждому найденному товару */
  importStock(tenantId: string, stockSourceId: string, rows: readonly StockImportRow[], actor: StockActor): Promise<StockImportOutcome | { status: 'FORBIDDEN' | 'NOT_INTERNAL_POOL' }>;
  /** Inbound API → пул источника: значение с более старым `asOf` не применяется */
  inboundStock(tenantId: string, stockSourceId: string, rows: readonly InboundStockRow[]): Promise<InboundStockOutcome>;
  /** Ключ Inbound API → тенант и источник; сам ключ сюда не попадает — только префикс и отпечаток */
  resolveInboundKey(keyPrefix: string, keySha256Hex: string): Promise<{ tenantId: string; stockSourceId: string } | null>;
  /**
   * Р-157: подтверждение заказа источником Inbound API. Освобождение по сроку [Р-25] остаётся СТРАХОВКОЙ, а не основным
   * путём: источник, который сообщил об учёте заказа, закрывает резервацию сразу.
   */
  confirmInboundOrders(tenantId: string, stockSourceId: string, orderRefs: readonly string[]): Promise<ConfirmOrdersOutcome>;
  /** Буфер аккаунта + единицы записи QUANTITY для активных предложений продавца + включение синхронизации [Р-6] */
  enableStockSync(tenantId: string, channelAccountId: string, input: EnableStockSyncInput, actor: StockActor): Promise<EnableStockSyncResult>;
  /** Пересчёт публикуемого количества и записи в канал для изменившихся единиц; null — все товары тенанта */
  recalculate(tenantId: string, productIds: readonly string[] | null, now: Instant, options?: { lockTimeoutMs?: number }): Promise<RecalculationOutcome>;
  /** Шаг 60 [Р-202]: состояние записи количества аккаунта — что набирать при подтверждении, ответ о других инструментах, подтверждено ли */
  quantityWritesState?(tenantId: string, channelAccountId: string): Promise<QuantityWritesState | null>;
  /** Шаг 60 [Р-202]: ответ владельца о других инструментах канала — автор и время ставит база */
  answerOtherTools?(tenantId: string, channelAccountId: string, answer: OtherTools, actor: StockActor): Promise<AnswerOtherToolsResult>;
  /** Шаг 60 [Р-202]: владелец подтверждает набранным идентификатором аккаунта, что количество в канале не ведут другие инструменты */
  confirmQuantityWrites?(tenantId: string, channelAccountId: string, typedConfirmation: string, actor: StockActor): Promise<ConfirmQuantityWritesResult>;
  /** Шаг 59 [Р-199]: возвраты — ждущие решения человека первыми, затем последние решённые и сведения по чужим пулам */
  listReturns?(tenantId: string, limit: number): Promise<OrderReturnRow[]>;
  /**
   * Шаг 59 [Р-199]: решение человека о возврате внутреннего пула — «принять на склад» (движение RETURN с автором) или «не принимать».
   * Права (каталог), человек и аудит — у базы
   */
  decideReturn?(tenantId: string, orderReturnId: string, decision: { accept: boolean; note: string | null }, actor: StockActor): Promise<DecideReturnOutcome>;
  /** Шаг 59 [Р-200]: источники Inbound API, молчащие сутки после подтверждения отгруженного заказа; каждая резервация — один раз */
  markSilentInboundSources?(tenantId: string): Promise<Array<{ stockSourceId: string; reservations: number; oldestConfirmedAt: Instant }>>;
  /** Строки заказов канала → резервации [Р-25]: OPEN — создаётся и подтверждается, SHIPPED — списывается, CANCELLED — освобождается */
  recordOrderLines(tenantId: string, channelAccountId: string, lines: readonly OrderLine[], now: Instant): Promise<OrderLinesOutcome>;
  /** Шаг 52: товары аккаунта, чья последняя запись количества упёрлась в бюджет правок прошлого дня витрины — пересчитать после смены суток */
  budgetRolledOverProducts?(tenantId: string, channelAccountId: string): Promise<string[]>;
  stockPage(tenantId: string, query: { offset: number; limit: number }): Promise<StockPage>;
  stockDivergences(tenantId: string, limit: number): Promise<StockDivergenceRow[]>;
}

/** Шаг 59 [Р-199]: строка возврата для экрана остатков */
export interface OrderReturnRow {
  orderReturnId: string;
  productId: string;
  sku: string;
  channel: string;
  channelOrderLineRef: string;
  quantity: number;
  /** INTERNAL_POOL — решает человек; иначе — только сведения, остаток ведёт источник [Р-6] */
  sourceMode: string;
  status: 'PENDING' | 'ACCEPTED' | 'DISMISSED' | 'INFO_ONLY';
  reportedAt: Instant;
  decidedAt: Instant | null;
  note: string | null;
}

export type DecideReturnOutcome =
  | { status: 'DECIDED'; productId: string; accepted: boolean }
  | { status: 'NOT_FOUND' | 'NOT_PENDING' | 'FORBIDDEN' };
