import type { Channel, IdentityAttribute, PriceBasis, WriteField } from './primitives.ts';

/**
 * Самоописание адаптера. Это та же информация, что строка platform.channel_capability (ADR-0002):
 * ядро выводит единицы записи и бюджеты из описания, адаптер их не вычисляет.
 */
export interface ChannelDescriptor {
  channel: Channel;
  /** Совпадает с channel_capability.api_mode */
  apiMode: string;
  region?: string;
  /** Версия API/спецификации, по которой написан адаптер (Kaufland: 2.44.0) */
  apiVersion: string;
  marketplaces: MarketplaceDescriptor[];
  fields: FieldCapability[];
  rateLimits: RateLimitRule[];
  capabilities: OptionalCapability[];
  /** Источники данных о конкурентах и их полнота [Р-39, ADR-0007] */
  competitorSources?: CompetitorSourceDescriptor[];
  /**
   * Как снимается системная остановка витрины по массовому сдвигу [Р-52, Р-119]. SAMPLE — автоматически по свежей выборке опросом
   * конкурентов; MANUAL_ONLY — только человеком: канал не даёт опроса, выборку взять неоткуда. Свойство канала, а не пробел; совпадает с
   * platform.channel_behaviour (0082).
   */
  haltRelease: { kind: 'SAMPLE' | 'MANUAL_ONLY'; basis: string };
  /**
   * Р-124 (шаг 25): отдаёт ли канал историю наших цен оффера. При подключении оффера история запрашивается у канала, если он её отдаёт
   * (AVAILABLE, метод порта readPriceHistory); иначе полнота проверки Omnibus отсчитывается с даты подключения. Факт — из снимка
   * спецификации с основанием
   */
  priceHistory: { kind: 'AVAILABLE' | 'UNAVAILABLE'; basis: string };
}

export interface CompetitorSourceDescriptor {
  /** Совпадает с channel_data.competitor_state.source */
  source: string;
  kind: 'PUSH' | 'PULL' | 'REPORT';
  completeness: { kind: 'TOP_N'; n: number } | { kind: 'CHEAPEST_ONLY' } | { kind: 'FULL' };
  conditions: string[];
  hasBuyboxWinner: boolean;
  hasOwnRank: boolean;
  hasShipping: boolean;
  /** null — зависит от расписания опроса или не документировано */
  typicalStalenessSeconds: number | null;
  /** EARLY_ACCESS — выдаётся каналом по запросу (Kaufland buy_box_changed, Р-45) */
  availability: 'AVAILABLE' | 'EARLY_ACCESS' | 'UNAVAILABLE';
  /** RECONCILIATION — только сверка, не вход стратегии (Р-36) */
  role: 'PRIMARY' | 'RECONCILIATION';
}

export interface MarketplaceDescriptor {
  /** Код в идентичности оффера: A1PA6795UKMFR9, EBAY_DE, de, at, otto.de */
  code: string;
  currency: string;
  priceBasis: PriceBasis;
  /** Граница «дня» для суточных свёрток и дневных бюджетов */
  timeZone: string;
}

export type OptionalCapability = 'PUSH_SUBSCRIPTIONS' | 'LISTING_MIGRATION' | 'ASYNC_REPORTS' | 'COMPETITOR_PULL';

export type Verification = 'DOCUMENTED' | 'DECIDED' | 'TO_VERIFY';

export interface FieldCapability {
  field: WriteField;
  /** Единица записи поля: ключ из атрибутов идентичности в заданном порядке */
  writeScope: { kind: string; keyTemplate: IdentityAttribute[] };
  /** Сколько записей помещается в один вызов канала и какие атрибуты у записей пакета обязаны совпадать */
  batch: { maxItems: number; sameAcrossBatch: IdentityAttribute[] };
  processing: 'SYNC' | 'ASYNC';
  confirmation: ConfirmationMethod[];
  editBudget?: EditBudgetRule;
  sideEffects: SideEffect[];
  preconditions: Precondition[];
  reversibility: { kind: 'REVERSIBLE' } | { kind: 'CONDITIONAL'; condition: string } | { kind: 'IRREVERSIBLE'; what: string };
  valueLimits?: { minAmountMinor?: number; maxAmountMinor?: number; maxQuantity?: number };
  verification: Verification;
}

/** Бюджет правок объекта канала (eBay: 250 правок листинга в календарный день, Р-2, Р-19) */
export interface EditBudgetRule {
  /** Атрибут идентичности, по которому считается бюджет (eBay — external_listing_id) */
  budgetScope: IdentityAttribute;
  limit: number;
  period: 'CALENDAR_DAY';
  /** null — граница дня канала не подтверждена */
  dayBoundaryTimeZone: string | null;
  /** Р-19: неуспешные попытки тоже расходуют бюджет */
  countsFailedAttempts: boolean;
  /** Один бюджет на все поля объекта (цена и остаток) */
  sharedAcrossFields: boolean;
}

export interface RateLimitRule {
  /** Кому принадлежит квота: продавцу, приложению (общая для тенантов) или паре продавец × приложение × операция */
  owner: 'SELLER' | 'APPLICATION' | 'SELLER_APPLICATION_OPERATION';
  /** Операция канала; не задано — квота общая на все операции */
  operation?: string;
  requestsPerSecond?: number;
  burst?: number;
  requestsPerDay?: number;
  source: 'DOCUMENTED' | 'OBSERVED_HEADER' | 'UNKNOWN';
}

export type ConfirmationMethod =
  | { kind: 'SYNC_RESPONSE' }
  | { kind: 'READBACK'; operation: string }
  | { kind: 'PUSH_EVENT'; event: string; reliability: 'GUARANTEED_WITH_RETRIES' | 'BEST_EFFORT' }
  | { kind: 'SUBMISSION_STATUS'; operation: string }
  | { kind: 'REPORT'; report: string; freshness: string };

export type SideEffect =
  /** Одно значение поля действует на нескольких маркетплейсах: остаток Amazon EU (регион), остаток Kaufland (id_offer) */
  | { kind: 'SHARED_ACROSS_MARKETPLACES'; linkedBy: 'REGION' | 'CHANNEL_OFFER_LINK'; note: string }
  /** Запись включает собственный репрайсер канала (Kaufland minimum_price → Smart Pricing, Р-12) */
  | { kind: 'ACTIVATES_CHANNEL_REPRICER'; note: string }
  /** Значение может завершить листинг (eBay quantity = 0 без out-of-stock control) */
  | { kind: 'MAY_END_LISTING'; condition: string };

export type Precondition =
  /** eBay: листинг под Inventory API (после необратимой миграции, Р-2) */
  | { kind: 'LISTING_MANAGED_BY_WRITE_API' }
  /** Режим цены единицы записи [Р-12] */
  | { kind: 'PRICING_MODE'; mode: 'ENGINE' | 'KAUFLAND_SMART_PRICING' }
  | { kind: 'OFFER_EXISTS_IN_CHANNEL' };
