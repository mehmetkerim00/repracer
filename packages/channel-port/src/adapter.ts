import type { ChannelDescriptor } from './descriptor.ts';
import type { ChannelError } from './errors.ts';
import type {
  CompetitorQuery,
  CompetitorReadResult,
  ConfirmationRequest,
  ConfirmationResult,
  DiscoveredOffer,
  DispatchBatch,
  DispatchPlan,
  DispatchResult,
  FieldWrite,
  InboundDelivery,
  InboundResult,
  OrderLine,
  ReadBackRequest,
  ReadBackResult,
} from './messages.ts';
import type {
  AdapterCallContext,
  Channel,
  ChannelAccountId,
  Instant,
  Page,
  PageRequest,
  TenantId,
} from './primitives.ts';

// ---------------------------------------------------------------------------
// Зависимости, которые адаптер получает от ядра
// ---------------------------------------------------------------------------

export interface VerifiedChannelAccount {
  tenantId: TenantId;
  channelAccountId: ChannelAccountId;
  channel: Channel;
  region?: string;
  externalAccountId: string;
  marketplaces: string[];
  credentialsRef: string;
}

/**
 * Р-31: адаптер не выбирает тенанта. Перед любым обращением к каналу адаптер вызывает verify с тенантом и аккаунтом
 * из сообщения; `mismatch` — отказ с TENANT_MISMATCH и алертом, без обращения к каналу.
 */
export interface ChannelAccountDirectory {
  verify(
    tenantId: TenantId,
    channelAccountId: ChannelAccountId,
  ): Promise<{ ok: true; account: VerifiedChannelAccount } | { ok: false; reason: 'NOT_FOUND' | 'TENANT_MISMATCH' | 'DISCONNECTED' }>;
}

/** Секреты канала по ссылке credentials_ref; содержимое непрозрачно для ядра */
export interface CredentialProvider {
  get(credentialsRef: string): Promise<Readonly<Record<string, string>>>;
}

export interface AlertSink {
  raise(alert: {
    code: string;
    severity: 'WARNING' | 'CRITICAL';
    tenantId?: TenantId;
    channelAccountId?: ChannelAccountId;
    correlationId?: string;
    details: Readonly<Record<string, string | number | boolean>>;
  }): Promise<void>;
}

/**
 * Журнал адаптера. Каждое консервативное поведение из-за неподтверждённого факта API пишется с кодом правила
 * и ссылкой на вопрос в поддержку канала (question), чтобы после ответа было видно, что меняется.
 */
export interface AdapterLogEntry {
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  code: string;
  message: string;
  question?: string;
  correlationId?: string;
  tenantId?: TenantId;
  channelAccountId?: ChannelAccountId;
  details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface AdapterLogger {
  log(entry: AdapterLogEntry): void;
}

export interface AdapterDependencies {
  accounts: ChannelAccountDirectory;
  credentials: CredentialProvider;
  alerts: AlertSink;
  logger: AdapterLogger;
  now: () => Instant;
}

// ---------------------------------------------------------------------------
// Порт
// ---------------------------------------------------------------------------

/**
 * ChannelAdapter — всё, что ядро знает о канале. Адаптер переводит команды ядра в вызовы API и ответы канала в факты.
 * Адаптер не принимает решений о цене и остатке, не хранит состояние синхронизации, не выбирает тенанта,
 * не повторяет запись новой версией и не решает, повторять ли запись: он классифицирует ошибку (errors.ts).
 */
export interface ChannelAdapter {
  readonly descriptor: ChannelDescriptor;

  /**
   * Разбить записи на вызовы канала и посчитать расход бюджета правок — без обращения к каналу.
   * Ядро списывает budgetCharges в edit_budget и переводит записи в DISPATCHED до вызова dispatch [Р-19].
   */
  planDispatch(ctx: AdapterCallContext, writes: readonly FieldWrite[]): Promise<DispatchPlan>;

  /** Выполнить один пакет. Не больше одной записи на единицу записи. */
  dispatch(ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult>;

  /** Прочитать текущие значения полей единиц записи в канале */
  readBack(ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult>;

  /** Проверить, применена ли отправленная запись (статус отправки, обратное чтение) */
  confirm(ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]>;

  /** Синхронно прочитать конкурентов по товарам канала (если канал это позволяет — COMPETITOR_PULL) */
  readCompetitors(ctx: AdapterCallContext, queries: readonly CompetitorQuery[]): Promise<CompetitorReadResult>;

  /** Постранично перечислить офферы аккаунта — для сопоставления с товарами и сверки */
  discoverOffers(ctx: AdapterCallContext, page: PageRequest): Promise<Page<DiscoveredOffer>>;

  /** Строки заказов за окно — резервации (Р-25) и сверка пропущенных уведомлений */
  readOrderLines(ctx: AdapterCallContext, window: { since: Instant } & PageRequest): Promise<Page<OrderLine>>;

  /** Проверить подпись и разобрать входящую доставку; тенант из delivery.claimed сверяется по каталогу [Р-31] */
  handleInbound(delivery: InboundDelivery): Promise<InboundResult>;
}

// ---------------------------------------------------------------------------
// Необязательные возможности (объявляются в descriptor.capabilities)
// ---------------------------------------------------------------------------

export interface SubscriptionSpec {
  event: string;
  marketplace?: string;
  callbackUrl: string;
}

export interface SubscriptionState {
  spec: SubscriptionSpec;
  channelSubscriptionId: string;
  active: boolean;
  error?: ChannelError;
}

/** PUSH_SUBSCRIPTIONS: привести подписки канала к желаемому состоянию (идемпотентно) */
export interface SupportsPushSubscriptions {
  ensureSubscriptions(ctx: AdapterCallContext, desired: readonly SubscriptionSpec[]): Promise<SubscriptionState[]>;
}

/**
 * Доказательство согласия на необратимое действие. Создаётся только ядром после того, как БД перевела оффер
 * в MIGRATION_STARTED (миграция 0010) — без него метод вызвать нельзя по типу.
 */
export interface MigrationConsentProof {
  readonly migrationConsentId: string;
  readonly listingId: string;
  readonly listingSnapshotSha256: string;
  readonly offerMappingStatus: 'MIGRATION_STARTED';
}

export interface ListingPreflight {
  listingId: string;
  listingSnapshotSha256: string;
  verdict: 'ALREADY_MANAGED' | 'READY' | 'READY_WITH_LOSSES' | 'FIXABLE' | 'INELIGIBLE' | 'UNKNOWN';
  findings: Array<{ code: string; severity: 'BLOCKER' | 'LOSS' | 'WARNING' | 'INFO'; details: string }>;
}

export type MigrationOutcome =
  | { listingId: string; status: 'MIGRATED'; externalOfferIds: string[] }
  | { listingId: string; status: 'FAILED'; error: ChannelError }
  | { listingId: string; status: 'OUTCOME_UNKNOWN'; error: ChannelError };

/** LISTING_MIGRATION: необратимый перевод листингов под API записи (eBay, Р-2) */
export interface SupportsListingMigration {
  preflight(ctx: AdapterCallContext, listingIds: readonly string[]): Promise<ListingPreflight[]>;
  /** Размер пакета ограничен каналом (eBay: 1–5); адаптер не повторяет вслепую при OUTCOME_UNKNOWN */
  migrate(ctx: AdapterCallContext, proofs: readonly MigrationConsentProof[]): Promise<MigrationOutcome[]>;
}

export interface ReportHandle {
  reportType: string;
  channelReportId: string;
  requestedAt: Instant;
}

export type ReportStatus =
  | { status: 'PENDING'; checkAfter: Instant }
  | { status: 'DONE'; downloadUrl: string }
  | { status: 'FAILED'; error: ChannelError };

/** ASYNC_REPORTS: отчёты и файлы, которые канал готовит асинхронно (Kaufland competitors-comparer, отчёты Amazon) */
export interface SupportsAsyncReports {
  requestReport(ctx: AdapterCallContext, reportType: string, marketplace?: string): Promise<ReportHandle>;
  pollReport(ctx: AdapterCallContext, handle: ReportHandle): Promise<ReportStatus>;
}

export type AdapterFactory = (
  deps: AdapterDependencies,
) => ChannelAdapter & Partial<SupportsPushSubscriptions & SupportsListingMigration & SupportsAsyncReports>;

export function supportsListingMigration(
  adapter: ChannelAdapter & Partial<SupportsListingMigration>,
): adapter is ChannelAdapter & SupportsListingMigration {
  return adapter.descriptor.capabilities.includes('LISTING_MIGRATION')
    && typeof adapter.preflight === 'function' && typeof adapter.migrate === 'function';
}

export function supportsPushSubscriptions(
  adapter: ChannelAdapter & Partial<SupportsPushSubscriptions>,
): adapter is ChannelAdapter & SupportsPushSubscriptions {
  return adapter.descriptor.capabilities.includes('PUSH_SUBSCRIPTIONS') && typeof adapter.ensureSubscriptions === 'function';
}

export function supportsAsyncReports(
  adapter: ChannelAdapter & Partial<SupportsAsyncReports>,
): adapter is ChannelAdapter & SupportsAsyncReports {
  return adapter.descriptor.capabilities.includes('ASYNC_REPORTS')
    && typeof adapter.requestReport === 'function' && typeof adapter.pollReport === 'function';
}
