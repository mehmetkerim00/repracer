import type { ChannelBehaviour, ChannelReply, ObservedRequest } from '../harness/channel.ts';
import { defaultEbayParams, type EbayModelParams } from './params.ts';

/**
 * Модель eBay Sell Inventory API в симуляторе [Р-187]: канал с состоянием вместо записанных обменов, тот же ChannelBehaviour, что у
 * ScriptedChannel и модели Kaufland, — адаптер, путь решения и сценарии не меняются. Модель повторяет ОТВЕТЫ ПЕСОЧНИЦЫ шага 39
 * (docs/evidence/step39-ebay-sandbox.md), а открытые вопросы E-nn — параметры (params.ts), как K- и A-:
 * - bulk_update_price_quantity: 200 / 207 / 400 по элементам (25004 количество 0 — применено, листинг OUT_OF_STOCK; 25016 ниже EUR 1.00
 *   с параметром MinValue; 25604 предложение или SKU не найдены) и отказы всего запроса (25709 неверное значение, 25712 больше 25);
 *   молчаливое округление трёх знаков вверх и приём чужой валюты (адаптер обязан не допускать их сам — модель отмечает нарушение);
 * - GET offer — НАША запись о предложении; 25713 «This Offer is not available» для листинга не под Inventory API;
 * - Browse — живая цена, оценка количества, sellerItemRevision и цена покупателя с НДС сверху, если так велит параметр E-17;
 * - Trading: GetUserPreferences, GetItem, ReviseFixedPriceItem «другим инструментом» — меняет живой листинг, но не предложение (E-16);
 * - bulk_migrate_listing: предложение появляется без availableQuantity, Best Offer — по E-15;
 * - 250 правок в день канал не применяет, пока его не включит параметр E-02; лимит запросов — только по E-04;
 * - пакет разных SKU принимается, как в песочнице; вариант E-22 отвергает его целиком (Р-189);
 * - Account API getPaymentPolicy — немедленная оплата платёжной политики (Р-191; ответ синтетический, песочница вызов не делала).
 * Не моделируется: страницы inventory_item (обнаружение), заказы, уведомления, вариации. Все данные синтетические.
 */

export interface SimEbayListingSpec {
  listingId: string;
  sku: string;
  marketplace: 'EBAY_DE' | 'EBAY_US';
  /** Предложение Inventory API; без него листинг «старый» (Trading API) — запись по нему невозможна до миграции (Р-164) */
  offerId?: string;
  /** Предложение, которое создаст bulk_migrate_listing (по умолчанию выводится из листинга) */
  migratedOfferId?: string;
  priceMinor: number;
  quantity: number;
  format?: 'FIXED_PRICE' | 'AUCTION';
  bestOffer?: boolean;
  /** Правок листинга сегодня (другими инструментами) — для E-02 */
  revisionsToday?: number;
  /** Предложение без availableQuantity — так пришло мигрированное в песочнице (EBAY_C07) */
  offerWithoutQuantity?: boolean;
  /** Шаг 49 [Р-191]: у листинга задан город (Location); по умолчанию — да */
  itemLocation?: boolean;
  /** Шаг 49 [Р-191]: у листинга есть платёжная бизнес-политика; по умолчанию — да */
  paymentPolicy?: boolean;
}

/** world.channelModel сценария eBay */
export interface EbayChannelModelSpec {
  seed: number;
  params?: Partial<EbayModelParams>;
  sellerUserId?: string;
  outOfStockControl?: boolean;
  /** Шаг 49 [Р-191]: `immediatePay` платёжной политики модели (Account API); null — поле не приходит; по умолчанию true */
  immediatePay?: boolean | null;
  listings: SimEbayListingSpec[];
}

interface ListingState {
  listingId: string;
  sku: string;
  marketplace: 'EBAY_DE' | 'EBAY_US';
  format: 'FIXED_PRICE' | 'AUCTION';
  status: 'ACTIVE' | 'OUT_OF_STOCK' | 'ENDED';
  /** Живой листинг: цена, валюта, количество, ревизия — и история для задержки Browse (E-13) */
  live: { priceMinor: number; currency: string; quantity: number };
  history: Array<{ atMs: number; priceMinor: number; currency: string; quantity: number; revision: number }>;
  revision: number;
  bestOffer: boolean;
  offer: { offerId: string; priceMinor: number; currency: string; availableQuantity: number | null; bestOffer: boolean } | null;
  migratedOfferId: string;
  /** Правки листинга по дням UTC (граница суток неизвестна, E-02): день → число */
  edits: Map<string, number>;
  firstWriteMs: number | null;
}

export interface EbaySimulatorStats {
  requests: Record<string, number>;
  rateLimited: number;
  editLimited: number;
  itemsApplied: number;
  itemsRejected: number;
  roundedUpSilently: number;
  foreignCurrencyStored: number;
  otherToolRevisions: number;
  otherToolRefused: number;
  migrations: number;
  /** E-22: вызовы с разными SKU, отвергнутые целиком (параметр multiSkuPerCall) */
  multiSkuRefused: number;
}

const CURRENCY: Readonly<Record<string, string>> = { EBAY_DE: 'EUR', EBAY_US: 'USD' };
const XMLNS = 'urn:ebay:apis:eBLBaseComponents';
const major = (minor: number) => `${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`;
/** Цена покупателя с НДС сверху — округление до цента половиной вверх, как показала песочница (13.49 → 16.05) */
const withVat = (minor: number, bp: number) => Math.floor((minor * (10_000 + bp) + 5_000) / 10_000);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const restError = (errorId: number, message: string, parameters?: Array<{ name: string; value: string }>) => ({
  errorId, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'REQUEST', message, ...(parameters ? { parameters } : {}),
});

/** GetItem, сокращённый до элементов, которые читает предполётная проверка адаптера (как фикстуры шага 39) */
export const SIM_PAYMENT_POLICY_ID = '6200000002';

/**
 * Шаг 49 [Р-191]: у листинга модели по умолчанию есть платёжная политика и город (`Location` в ItemType) — условия bulkMigrateListing из
 * снимка документации; `itemLocation: false` и `paymentPolicy: false` их убирают. Значения синтетические.
 */
export function ebayGetItemXml(l: { listingId: string; sku: string; format: 'FIXED_PRICE' | 'AUCTION'; bestOffer: boolean; priceMinor: number; quantity: number; currency: string;
  itemLocation?: boolean; paymentPolicy?: boolean }): string {
  const type = l.format === 'AUCTION' ? 'Chinese' : 'FixedPriceItem';
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GetItemResponse xmlns="${XMLNS}"><Ack>Success</Ack><Version>1193</Version><Item><Currency>${l.currency}</Currency><ItemID>${l.listingId}</ItemID>`
    + '<ListingDesigner><LayoutID>7710000</LayoutID><ThemeID>7710</ThemeID></ListingDesigner>'
    + `<ListingDuration>${l.format === 'AUCTION' ? 'Days_7' : 'GTC'}</ListingDuration><ListingType>${type}</ListingType><Quantity>${l.quantity}</Quantity>`
    + `<SellingStatus><CurrentPrice currencyID="${l.currency}">${major(l.priceMinor)}</CurrentPrice><ListingStatus>Active</ListingStatus></SellingStatus>`
    + (l.bestOffer ? '<BestOfferDetails><BestOfferCount>0</BestOfferCount><BestOfferEnabled>true</BestOfferEnabled><NewBestOffer>false</NewBestOffer></BestOfferDetails>' : '')
    + (l.itemLocation === false ? '' : '<Location>Syn-Stadt</Location>')
    + `<SKU>${l.sku}</SKU><SellerProfiles><SellerShippingProfile><ShippingProfileID>6200000001</ShippingProfileID></SellerShippingProfile>`
    + (l.paymentPolicy === false ? '' : `<SellerPaymentProfile><PaymentProfileID>${SIM_PAYMENT_POLICY_ID}</PaymentProfileID></SellerPaymentProfile>`)
    + '</SellerProfiles></Item></GetItemResponse>';
}

function tradingFailure(code: string, message: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response xmlns="${XMLNS}"><Ack>Failure</Ack><Errors><ShortMessage>${message}</ShortMessage><ErrorCode>${code}</ErrorCode></Errors></Response>`;
}

export class SimulatedEbayChannel implements ChannelBehaviour {
  readonly params: EbayModelParams;
  readonly stats: EbaySimulatorStats = {
    requests: {}, rateLimited: 0, editLimited: 0, itemsApplied: 0, itemsRejected: 0, roundedUpSilently: 0, foreignCurrencyStored: 0,
    otherToolRevisions: 0, otherToolRefused: 0, migrations: 0, multiSkuRefused: 0,
  };
  private readonly spec: EbayChannelModelSpec;
  private readonly tokens: { user: string; application: string };
  private readonly listings = new Map<string, ListingState>();
  private readonly violations: string[] = [];
  private readonly requestTimes: number[] = [];
  private nowMs: number;

  constructor(spec: EbayChannelModelSpec, startIso: string, tokens: { user: string; application: string }) {
    this.spec = spec;
    this.params = { ...defaultEbayParams(), ...structuredClone(spec.params ?? {}) };
    this.tokens = tokens;
    this.nowMs = Date.parse(startIso);
    for (const l of spec.listings) {
      const currency = CURRENCY[l.marketplace]!;
      const edits = new Map<string, number>();
      if (l.revisionsToday) edits.set(day(this.nowMs), l.revisionsToday);
      this.listings.set(l.listingId, {
        listingId: l.listingId, sku: l.sku, marketplace: l.marketplace, format: l.format ?? 'FIXED_PRICE', status: 'ACTIVE',
        live: { priceMinor: l.priceMinor, currency, quantity: l.quantity },
        history: [{ atMs: this.nowMs - 86_400_000, priceMinor: l.priceMinor, currency, quantity: l.quantity, revision: 1 }], revision: 1,
        bestOffer: l.bestOffer ?? false,
        offer: l.offerId ? { offerId: l.offerId, priceMinor: l.priceMinor, currency, availableQuantity: l.offerWithoutQuantity ? null : l.quantity, bestOffer: l.bestOffer ?? false } : null,
        migratedOfferId: l.migratedOfferId ?? `9${l.listingId.slice(-9)}`, edits, firstWriteMs: null,
      });
    }
  }

  // -------------------------------------------------------------------------------------------------------------- живой листинг

  private changeLive(l: ListingState, change: Partial<ListingState['live']>): void {
    l.live = { ...l.live, ...change };
    l.revision += 1;
    l.history.push({ atMs: this.nowMs, ...l.live, revision: l.revision });
  }

  /** Browse видит листинг с задержкой E-13: последнее состояние, которому уже больше browseLagMs */
  private browseView(l: ListingState) {
    const visible = l.history.filter((h) => h.atMs + this.params.browseLagMs <= this.nowMs);
    return visible[visible.length - 1] ?? l.history[0]!;
  }

  private countEdit(l: ListingState): void {
    const d = day(this.nowMs);
    l.edits.set(d, (l.edits.get(d) ?? 0) + 1);
  }

  /** E-02: лимит правок листинга, если его применяет канал (по умолчанию — нет, как песочница) */
  private editLimitReached(l: ListingState): boolean {
    const limit = this.params.listingEditLimit;
    return limit !== null && (l.edits.get(day(this.nowMs)) ?? 0) >= limit.perDay;
  }

  /** Сценарный шаг: другой инструмент продавца правит цену листинга через Trading API (ReviseFixedPriceItem) — предложение не меняется */
  reviseByOtherTool(listingId: string, priceMinor: number, nowMs: number): { applied: boolean; reason?: string } {
    this.nowMs = Math.max(this.nowMs, nowMs);
    const l = this.listings.get(listingId);
    if (!l) return { applied: false, reason: 'UNKNOWN_LISTING' };
    if (l.offer && this.params.tradingReviseAfterMigration === 'REFUSED') {
      this.stats.otherToolRefused += 1;
      return { applied: false, reason: 'MANAGED_BY_INVENTORY_API' };
    }
    if (this.editLimitReached(l)) {
      this.stats.editLimited += 1;
      return { applied: false, reason: 'EDIT_LIMIT' };
    }
    this.changeLive(l, { priceMinor });
    this.countEdit(l);
    this.stats.otherToolRevisions += 1;
    return { applied: true };
  }

  // -------------------------------------------------------------------------------------------------------------- HTTP

  reply(request: ObservedRequest, nowMs: number): { exchangeId: string; reply: ChannelReply } | { violation: string } {
    this.nowMs = Math.max(this.nowMs, nowMs);
    const { method, path } = request;
    const route = path.startsWith('/buy/browse/') ? 'GET browse' : path.startsWith('/sell/inventory/v1/offer/') ? 'GET offer' : `${method} ${path}`;
    this.stats.requests[route] = (this.stats.requests[route] ?? 0) + 1;
    const json = (status: number, body: unknown) => ({ exchangeId: `sim:${route}`, reply: { kind: 'response' as const, status, headers: { 'content-type': 'application/json' }, body } });
    const xml = (body: string) => ({ exchangeId: `sim:${route}`, reply: { kind: 'response' as const, status: 200, headers: { 'content-type': 'text/xml' }, body } });

    if (path === '/identity/v1/oauth2/token') {
      const grant = new URLSearchParams(request.rawBody).get('grant_type');
      if (grant === 'client_credentials') return json(200, { access_token: this.tokens.application, expires_in: 7200, token_type: 'Application Access Token' });
      if (grant === 'refresh_token') return json(200, { access_token: this.tokens.user, expires_in: 7200, token_type: 'User Access Token' });
      return json(400, { error: 'unsupported_grant_type' });
    }
    // E-04: лимит запросов — только если его задаёт параметр; ответ 429 и тело — синтетические (лимит песочницы — заглушка)
    const limit = this.params.requestLimit;
    if (limit) {
      while (this.requestTimes.length > 0 && this.requestTimes[0]! <= this.nowMs - limit.windowMs) this.requestTimes.shift();
      if (this.requestTimes.length >= limit.calls) {
        this.stats.rateLimited += 1;
        return json(429, { errors: [{ errorId: 2001, domain: 'SYNTHETIC', message: 'Too many requests (model hypothesis E-04)' }] });
      }
      this.requestTimes.push(this.nowMs);
    }

    if (method === 'POST' && path === '/sell/inventory/v1/bulk_update_price_quantity') return this.bulkUpdate(request, json);
    if (method === 'POST' && path === '/sell/inventory/v1/bulk_migrate_listing') return this.migrate(request, json);
    if (method === 'GET' && path.startsWith('/sell/inventory/v1/offer/')) {
      const offerId = path.slice('/sell/inventory/v1/offer/'.length);
      const l = [...this.listings.values()].find((x) => x.offer?.offerId === offerId);
      return l ? json(200, this.offerBody(l)) : json(404, { errors: [restError(25713, 'This Offer is not available.')] });
    }
    // Шаг 47: обнаружение — страница товаров Inventory API (limit/offset) и активные листинги Trading API
    if (method === 'GET' && path === '/sell/inventory/v1/inventory_item') {
      // Шаг 50 [песочница]: без Accept-Language песочница отвечает 400 25709 — модель тоже (спецификация заголовка не объявляет, E-23)
      if (!request.headers['accept-language']) return json(400, { errors: [restError(25709, 'Invalid value for header Accept-Language.')] });
      const limit = Math.max(1, Number(request.query.limit ?? 25));
      const offset = Math.max(0, Number(request.query.offset ?? 0));
      const managed = [...this.listings.values()].filter((l) => l.offer).sort((a, b) => a.sku.localeCompare(b.sku));
      const page = managed.slice(offset, offset + limit);
      return json(200, { total: managed.length, size: page.length, limit, offset,
        inventoryItems: page.map((l) => ({ sku: l.sku, condition: 'NEW', availability: { shipToLocationAvailability: { quantity: l.live.quantity } } })) });
    }
    if (method === 'GET' && path === '/sell/inventory/v1/offer') {
      const l = [...this.listings.values()].find((x) => x.sku === request.query.sku && x.offer);
      return l ? json(200, { total: 1, size: 1, limit: 20, offers: [this.offerBody(l)] }) : json(404, { errors: [restError(25713, 'This Offer is not available.')] });
    }
    // Шаг 49 [Р-191]: Account API getPaymentPolicy [док: sell_account_v1_oas3.json]; ответ синтетический — песочница этот вызов не делала
    if (method === 'GET' && path.startsWith('/sell/account/v1/payment_policy/')) {
      const id = decodeURIComponent(path.slice('/sell/account/v1/payment_policy/'.length));
      if (id !== SIM_PAYMENT_POLICY_ID) return json(404, { errors: [{ errorId: 20404, domain: 'SYNTHETIC', message: 'payment policy not found (model)' }] });
      const immediatePay = this.spec.immediatePay === undefined ? true : this.spec.immediatePay;
      return json(200, { paymentPolicyId: id, name: 'syn-payment-policy', marketplaceId: 'EBAY_DE', ...(immediatePay === null ? {} : { immediatePay }) });
    }
    const browse = /^\/buy\/browse\/v1\/item\/v1\|(\d+)\|0$/.exec(path);
    if (method === 'GET' && browse) {
      const l = this.listings.get(browse[1]!);
      if (!l) return json(404, { errors: [{ errorId: 11001, domain: 'SYNTHETIC', message: 'item not found (model)' }] });
      return json(200, this.browseBody(l));
    }
    if (method === 'POST' && path === '/ws/api.dll') {
      const call = request.headers['x-ebay-api-call-name'];
      const body = typeof request.body === 'string' ? request.body : request.rawBody;
      if (call === 'GetMyeBaySelling') {
        // [песочница] ActiveList: ItemID, SKU, ListingType, Quantity, QuantityAvailable, цена с currencyID; поля витрины у предметов нет
        const perPage = Math.max(1, Number(/<EntriesPerPage>(\d+)<\/EntriesPerPage>/.exec(body)?.[1] ?? 25));
        const pageNo = Math.max(1, Number(/<PageNumber>(\d+)<\/PageNumber>/.exec(body)?.[1] ?? 1));
        const active = [...this.listings.values()].filter((l) => l.status !== 'ENDED').sort((a, b) => a.listingId.localeCompare(b.listingId));
        const page = active.slice((pageNo - 1) * perPage, pageNo * perPage);
        const items = page.map((l) => `<Item><ItemID>${l.listingId}</ItemID><ListingType>${l.format === 'AUCTION' ? 'Chinese' : 'FixedPriceItem'}</ListingType>`
          + `<Quantity>${l.live.quantity}</Quantity><SellingStatus><CurrentPrice currencyID="${l.live.currency}">${major(l.live.priceMinor)}</CurrentPrice></SellingStatus>`
          + `<SKU>${l.sku}</SKU><QuantityAvailable>${l.live.quantity}</QuantityAvailable></Item>`).join('');
        return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<GetMyeBaySellingResponse xmlns="${XMLNS}"><Ack>Success</Ack><ActiveList><ItemArray>${items}</ItemArray>`
          + `<PaginationResult><TotalNumberOfPages>${Math.max(1, Math.ceil(active.length / perPage))}</TotalNumberOfPages><TotalNumberOfEntries>${active.length}</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>`);
      }
      if (call === 'GetUserPreferences') {
        return xml(`<?xml version="1.0" encoding="UTF-8"?>\n<GetUserPreferencesResponse xmlns="${XMLNS}"><Ack>Success</Ack><OutOfStockControlPreference>${this.spec.outOfStockControl ? 'true' : 'false'}</OutOfStockControlPreference></GetUserPreferencesResponse>`);
      }
      const itemId = /<ItemID>(\d+)<\/ItemID>/.exec(body)?.[1] ?? '';
      const l = this.listings.get(itemId);
      if (call === 'GetItem') {
        if (!l) return xml(tradingFailure('17', 'Item cannot be accessed (model).'));
        const spec = this.spec.listings.find((x) => x.listingId === l.listingId);
        return xml(ebayGetItemXml({ listingId: l.listingId, sku: l.sku, format: l.format, bestOffer: l.bestOffer, priceMinor: l.live.priceMinor, quantity: l.live.quantity, currency: l.live.currency,
          ...(spec?.itemLocation === false ? { itemLocation: false } : {}), ...(spec?.paymentPolicy === false ? { paymentPolicy: false } : {}) }));
      }
      if (call === 'ReviseFixedPriceItem') {
        const price = /<StartPrice[^>]*>([\d.]+)<\/StartPrice>/.exec(body)?.[1];
        const r = price ? this.reviseByOtherTool(itemId, Math.round(Number(price) * 100), this.nowMs) : { applied: false, reason: 'NO_PRICE' };
        return xml(r.applied ? `<?xml version="1.0" encoding="UTF-8"?>\n<ReviseFixedPriceItemResponse xmlns="${XMLNS}"><Ack>Success</Ack><ItemID>${itemId}</ItemID></ReviseFixedPriceItemResponse>`
          : tradingFailure('21919028', `Revise refused (model: ${r.reason})`));
      }
      return { violation: `Trading call ${call ?? '(none)'} is not modelled` };
    }
    return { violation: `${method} ${path} is not modelled by the eBay channel model` };
  }

  private offerBody(l: ListingState) {
    const o = l.offer!;
    return {
      offerId: o.offerId, sku: l.sku, marketplaceId: l.marketplace, format: 'FIXED_PRICE',
      ...(o.availableQuantity === null ? {} : { availableQuantity: o.availableQuantity }),
      pricingSummary: { price: { value: major(o.priceMinor), currency: o.currency } },
      listingPolicies: { eBayPlusIfEligible: false, ...(o.bestOffer ? { bestOfferTerms: { bestOfferEnabled: true } } : {}) },
      categoryId: '20695', merchantLocationKey: 'syn-location-1', tax: { applyTax: false },
      listing: { listingId: l.listingId, listingStatus: l.status, soldQuantity: 0 }, status: 'PUBLISHED', listingDuration: 'GTC',
    };
  }

  private browseBody(l: ListingState) {
    const v = this.browseView(l);
    const tax = this.params.buyerPriceTax;
    const vat = tax.mode === 'VAT_ON_TOP' && l.marketplace === 'EBAY_DE' && l.firstWriteMs !== null && this.nowMs >= l.firstWriteMs + tax.afterFirstWriteMs ? tax.rateBp : null;
    return {
      itemId: `v1|${l.listingId}|0`, legacyItemId: l.listingId, sellerItemRevision: String(v.revision),
      price: { value: major(vat === null ? v.priceMinor : withVat(v.priceMinor, vat)), currency: v.currency },
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: l.status === 'ACTIVE' ? 'IN_STOCK' : 'OUT_OF_STOCK', estimatedAvailableQuantity: v.quantity }],
      ...(vat === null ? {} : { taxes: [{ taxJurisdiction: { region: { regionName: 'DE', regionType: 'COUNTRY' } }, taxType: 'VAT', taxPercentage: (vat / 100).toFixed(1),
        shippingAndHandlingTaxed: true, includedInPrice: true, ebayCollectAndRemitTax: true }] }),
    };
  }

  private bulkUpdate(request: ObservedRequest, json: (s: number, b: unknown) => { exchangeId: string; reply: ChannelReply }) {
    const requests = (request.body as { requests?: Array<{ offers?: Array<Record<string, unknown>> }> } | undefined)?.requests;
    if (!Array.isArray(requests)) return json(400, { errors: [restError(25709, 'Invalid value for requests.')] });
    // [песочница] 26 запросов — 400 25712 на весь запрос
    if (requests.length > 25) return json(400, { errors: [restError(25712, 'Invalid request size. The maximum size allowed is 25.')] });
    // E-22 (Р-189): описание операции — «один SKU на вызов». Вариант модели отвергает вызов с разными SKU ЦЕЛИКОМ, ничего не применяя;
    // код и текст — синтетические: настоящего ответа боевого канала никто не видел
    if (this.params.multiSkuPerCall === 'REFUSED_WHOLE_REQUEST') {
      const skus = new Set(requests.map((r) => {
        const o = r.offers?.[0] ?? {};
        const byOffer = typeof o.offerId === 'string' ? [...this.listings.values()].find((x) => x.offer?.offerId === o.offerId) : undefined;
        return byOffer?.sku ?? (typeof o.sku === 'string' ? o.sku : String(o.offerId ?? ''));
      }));
      if (skus.size > 1) {
        this.stats.multiSkuRefused += 1;
        return json(400, { errors: [{ errorId: 99022, domain: 'SYNTHETIC', category: 'REQUEST', message: 'Only one SKU can be updated per call (model hypothesis E-22, the channel error code is unknown)' }] });
      }
    }
    // Проверка всего запроса ДО применения: 25709 — ни один элемент не применяется [песочница: цена -1.00 и «abc»]
    const parsed: Array<{ offerId: string | null; sku: string | null; priceMinor: number | null; currency: string | null; quantity: number | null; roundedUp: boolean }> = [];
    for (const r of requests) {
      const o = r.offers?.[0] ?? {};
      const price = o.price as { value?: unknown; currency?: unknown } | undefined;
      let priceMinor: number | null = null;
      let roundedUp = false;
      if (price) {
        const text = String(price.value ?? '');
        const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
        if (!m) return json(400, { errors: [restError(25709, 'Invalid value for Offers.price.value.')] });
        const frac = m[2] ?? '';
        if (frac.length > 2) {
          if (this.params.subCentPrice === 'REJECTED_25709') return json(400, { errors: [restError(25709, 'Invalid value for Offers.price.value.')] });
          roundedUp = true;
        }
        const exact = Number(m[1]) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'));
        priceMinor = roundedUp && /[1-9]/.test(frac.slice(2)) ? exact + 1 : exact;
      }
      const quantity = o.availableQuantity === undefined ? null : Number(o.availableQuantity);
      if (quantity !== null && (!Number.isSafeInteger(quantity) || quantity < 0)) return json(400, { errors: [restError(25709, 'Invalid value for Offers.availableQuantity.')] });
      parsed.push({ offerId: typeof o.offerId === 'string' ? o.offerId : null, sku: typeof o.sku === 'string' ? o.sku : null, priceMinor,
        currency: price && typeof price.currency === 'string' ? price.currency : null, quantity, roundedUp });
    }
    const responses = parsed.map((p) => this.updateItem(p));
    const ok = responses.filter((r) => r.statusCode === 200).length;
    return json(ok === responses.length ? 200 : ok === 0 ? 400 : 207, { responses });
  }

  private updateItem(p: { offerId: string | null; sku: string | null; priceMinor: number | null; currency: string | null; quantity: number | null; roundedUp: boolean }) {
    const l = [...this.listings.values()].find((x) => (p.offerId !== null ? x.offer?.offerId === p.offerId : x.sku === p.sku && x.offer));
    const id = { ...(p.offerId ? { offerId: p.offerId } : {}), ...(l ? { sku: l.sku } : p.sku ? { sku: p.sku } : {}) };
    const refuse = (statusCode: number, error: unknown, charge = true) => {
      this.stats.itemsRejected += 1;
      if (l && charge && this.params.listingEditLimit?.countsFailed) this.countEdit(l);
      return { statusCode, ...id, errors: [error] };
    };
    if (!l) {
      this.stats.itemsRejected += 1;
      return { statusCode: 400, ...id, errors: [restError(25604, p.offerId ? 'Input error. Offer not found. Please try input valid request or contact customer support..' : 'Input error. SKU not found.')] };
    }
    if (this.editLimitReached(l)) {
      this.stats.editLimited += 1;
      return refuse(this.params.listingEditLimit!.status, { domain: 'SYNTHETIC', message: 'listing revision limit reached (model hypothesis E-02, the channel error code is unknown)' });
    }
    const minCurrency = CURRENCY[l.marketplace]!;
    if (p.priceMinor !== null && p.priceMinor < 100) {
      return refuse(400, restError(25016, `The The price in the listing is either invalid or below the minimum price of ${minCurrency} 1.00. value is invalid.`,
        [{ name: 'MinValue', value: `${minCurrency} 1.00` }, { name: 'ItemID', value: l.listingId }, { name: 'SKU', value: l.sku }]));
    }
    if (p.priceMinor !== null && p.currency !== null && p.currency !== minCurrency) {
      if (this.params.foreignCurrency === 'REJECTED_25709') return refuse(400, restError(25709, 'Invalid value for Offers.price.currency.'));
      // [песочница] USD у предложения EBAY_DE — 200 и сохранено; адаптер обязан проверять валюту сам (EBAY_C03)
      this.stats.foreignCurrencyStored += 1;
      this.violations.push(`bulk_update_price_quantity: currency ${p.currency} sent for ${l.marketplace} offer ${l.offer!.offerId} (stored silently, E-12)`);
    }
    if (p.roundedUp) {
      this.stats.roundedUpSilently += 1;
      this.violations.push(`bulk_update_price_quantity: price with more than two decimals sent for offer ${l.offer!.offerId} (rounded up silently, E-12)`);
    }
    if (l.status === 'ENDED') return refuse(400, { domain: 'SYNTHETIC', message: 'the listing is ended (model)' });
    l.firstWriteMs ??= this.nowMs;
    if (p.quantity === 0) {
      if (this.params.quantityZero === 'ERROR_25004_NOT_APPLIED') return refuse(400, this.quantityZeroError(l));
      l.offer!.availableQuantity = 0;
      this.countEdit(l);
      if (this.params.quantityZero === 'APPLIED_LISTING_ENDED') {
        l.status = 'ENDED';
        this.changeLive(l, { quantity: 0 });
        this.stats.itemsApplied += 1;
        return { statusCode: 200, ...id };
      }
      // [песочница] 400 25004, но значение применено и листинг стал OUT_OF_STOCK; ревизию отказ не увеличил
      l.status = 'OUT_OF_STOCK';
      l.live = { ...l.live, quantity: 0 };
      l.history.push({ atMs: this.nowMs, ...l.live, revision: l.revision });
      this.stats.itemsRejected += 1;
      return { statusCode: 400, ...id, errors: [this.quantityZeroError(l)] };
    }
    const change: Partial<ListingState['live']> = {};
    if (p.priceMinor !== null) {
      l.offer!.priceMinor = p.priceMinor;
      l.offer!.currency = p.currency ?? minCurrency;
      change.priceMinor = p.priceMinor;
      change.currency = p.currency ?? minCurrency;
    }
    if (p.quantity !== null) {
      l.offer!.availableQuantity = p.quantity;
      change.quantity = p.quantity;
      if (l.status === 'OUT_OF_STOCK' && this.params.restockClearsOutOfStock) l.status = 'ACTIVE';
    }
    this.changeLive(l, change);
    this.countEdit(l);
    this.stats.itemsApplied += 1;
    return { statusCode: 200, ...id };
  }

  private quantityZeroError(l: ListingState) {
    return restError(25004, 'The eBay listing associated with the inventory item, or the unpublished offer has an invalid quantity. The quantity must be a valid number greater than 0.',
      [{ name: 'ItemID', value: l.listingId }, { name: 'SKU', value: l.sku }]);
  }

  private migrate(request: ObservedRequest, json: (s: number, b: unknown) => { exchangeId: string; reply: ChannelReply }) {
    const requests = (request.body as { requests?: Array<{ listingId?: string }> } | undefined)?.requests ?? [];
    if (requests.length === 0 || requests.length > 5) return json(400, { errors: [{ domain: 'SYNTHETIC', message: 'bulk_migrate_listing takes 1 to 5 listings (model, Р-2)' }] });
    const responses = requests.map((r) => {
      const l = this.listings.get(String(r.listingId ?? ''));
      if (!l) return { statusCode: 400, listingId: r.listingId, errors: [{ domain: 'SYNTHETIC', message: 'listing not found (model)' }] };
      if (l.format === 'AUCTION') return { statusCode: 400, listingId: l.listingId, errors: [{ domain: 'SYNTHETIC', message: 'auction listings are not migrated (model, Р-2)' }] };
      if (l.offer) return { statusCode: 400, listingId: l.listingId, errors: [{ domain: 'SYNTHETIC', message: 'listing is already managed by Inventory API (model)' }] };
      // [песочница] предложение появилось без availableQuantity; Best Offer — по E-15
      const bestOffer = l.bestOffer && this.params.bestOfferOnMigration === 'KEPT';
      l.bestOffer = bestOffer;
      l.offer = { offerId: l.migratedOfferId, priceMinor: l.live.priceMinor, currency: l.live.currency, availableQuantity: null, bestOffer };
      this.stats.migrations += 1;
      return { statusCode: 200, listingId: l.listingId, marketplaceId: l.marketplace, inventoryItems: [{ sku: l.sku, offerId: l.offer.offerId }] };
    });
    const ok = responses.filter((r) => r.statusCode === 200).length;
    return json(ok === responses.length ? 200 : ok === 0 ? 400 : 207, { responses });
  }

  finish(): string[] {
    return [...this.violations];
  }

  dump(): unknown {
    return {
      listings: [...this.listings.values()].map((l) => ({
        listingId: l.listingId, sku: l.sku, marketplace: l.marketplace, status: l.status, livePriceMinor: l.live.priceMinor, liveCurrency: l.live.currency,
        liveQuantity: l.live.quantity, sellerItemRevision: l.revision, bestOffer: l.bestOffer, editsToday: l.edits.get(day(this.nowMs)) ?? 0,
        offer: l.offer ? { offerId: l.offer.offerId, priceMinor: l.offer.priceMinor, currency: l.offer.currency, availableQuantity: l.offer.availableQuantity, bestOffer: l.offer.bestOffer } : null,
      })),
      stats: this.stats,
      violations: this.violations,
    };
  }
}
