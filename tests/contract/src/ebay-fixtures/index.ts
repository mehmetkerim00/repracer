import { budgetChargesOf, GET_USER_PREFERENCES_REQUEST, getItemRequest, parseGetItem, snapshotSha256 } from '@repracer/ebay-adapter';
import type { Exchange, Provenance, Scenario, Step, World } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';

/**
 * Построитель сценариев eBay (шаг 39) [Р-162…Р-164]. Сценарии RECONSTRUCTED_FROM_SANDBOX восстановлены по протоколу прогона в песочнице
 * eBay 27.09.2026 (docs/evidence/step39-ebay-sandbox.md), а не записаны рекордером: у каждого обмена названо происхождение — SANDBOX
 * (ответ есть в протоколе: errorId, текст ошибки и статус — как ответила песочница) или SYNTHETIC (ответа в протоколе нет, он выведен).
 * Обезличено: идентификаторы листингов, предложений, политик, SKU и мест хранения — синтетические, идентификаторы запросов убраны, из
 * ответов Trading API оставлены только элементы, которые читают проверки (блок Seller — с синтетической почтой). Сценарии без ответа
 * песочницы (429, исчерпанный бюджет, отказы до обращения к каналу) — SYNTHETIC_FROM_DOCS со ссылкой на вопрос.
 *
 * Фикстуры в fixtures/ebay — результат этого построителя; тест сверяет, что они не разошлись (npm run fixtures:ebay).
 */

export const EBAY_FIXTURES_DIR = new URL('../../fixtures/ebay/', import.meta.url);

const EVIDENCE = 'docs/evidence/step39-ebay-sandbox.md';
const RECORDED: Provenance = {
  kind: 'RECONSTRUCTED_FROM_SANDBOX', sandbox: true, recordedAt: '2026-09-27', evidence: EVIDENCE, reviewedBy: 'step39-review: обезличивание проверено',
  redactions: ['listing, offer, policy ids and SKUs replaced with synthetic ones', 'request ids dropped', 'Trading API responses reduced to the elements the checks read; the Seller block (e-mail, address) removed', 'tokens were never logged'],
};
/** Происхождение обмена в восстановленном сценарии: SANDBOX — ответ есть в протоколе прогона, SYNTHETIC — выведен */
const sb = (e: Exchange): Exchange => ({ ...e, origin: 'SANDBOX' });
const sy = (e: Exchange): Exchange => ({ ...e, origin: 'SYNTHETIC' });
const synthetic = (...sources: string[]): Provenance => ({ kind: 'SYNTHETIC_FROM_DOCS', sources: [EVIDENCE, 'docs/channel-capabilities.md#9', ...sources] });

const USER_TOKEN = 'syn-ebay-user-token-0001';
const APP_TOKEN = 'syn-ebay-app-token-0001';
const OTHER_TENANT = '10000000-0000-4000-8000-0000000000ff';
const SELLER_EMAIL = 'syn-seller-0001@example.invalid';

function world(extra: Partial<World> = {}): World {
  return {
    clock: '2026-09-27T10:00:00.000Z',
    tenantId: '10000000-0000-4000-8000-000000000001',
    channelAccountId: '20000000-0000-4000-8000-000000000001',
    account: { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_DE', 'EBAY_US'], channel: 'EBAY' },
    credentials: {
      seller: { refreshToken: 'syn-ebay-refresh-token-0001' }, application: { clientId: 'Syn-Repracer-SBX-0001', clientSecret: 'SBX-syn-client-secret-0001' },
      accessToken: USER_TOKEN, applicationToken: APP_TOKEN,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------------------------------- идентичность и записи

/** Предложение n: листинг 1100000000nn, предложение 91000000nn, SKU SYN-EBAY-nn */
const ids = (n: number) => ({ listingId: `1100000000${String(n).padStart(2, '0')}`, offerId: `91000000${String(n).padStart(2, '0')}`, sku: `SYN-EBAY-${String(n).padStart(2, '0')}` });

function identity(n: number, marketplace = 'EBAY_DE', migrated = true) {
  const i = ids(n);
  return { marketplace, externalSku: i.sku, ...(migrated ? { externalOfferId: i.offerId } : {}), externalListingId: i.listingId };
}

function priceWrite(id: string, n: number, minor: number, o: { version?: number; currency?: string; basis?: string; migrated?: boolean; marketplace?: string } = {}) {
  const version = o.version ?? 1;
  const marketplace = o.marketplace ?? 'EBAY_DE';
  return {
    channelWriteId: id, version, idempotencyKey: `${id}:${version}`, attemptNo: 1,
    writeScope: { writeScopeId: `ws-ebay-price-${marketplace}-${n}`, field: 'PRICE', scopeKey: `ebay|acct-1|${marketplace}|${ids(n).sku}`, identity: identity(n, marketplace, o.migrated ?? true) },
    value: { field: 'PRICE', price: { amountMinor: minor, currency: o.currency ?? 'EUR', basis: o.basis ?? 'GROSS' } },
  };
}

function quantityWrite(id: string, n: number, quantity: number) {
  return {
    channelWriteId: id, version: 1, idempotencyKey: `${id}:1`, attemptNo: 1,
    writeScope: { writeScopeId: `ws-ebay-qty-${n}`, field: 'QUANTITY', scopeKey: `ebay|acct-1|${ids(n).sku}`, identity: identity(n) },
    value: { field: 'QUANTITY', quantity },
  };
}

type Write = ReturnType<typeof priceWrite> | ReturnType<typeof quantityWrite>;
const batch = (batchId: string, items: Write[]) => ({ batchId, operation: 'bulkUpdatePriceQuantity', items, budgetCharges: budgetChargesOf(items as never), requestCount: 1 });
const major = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

// ---------------------------------------------------------------------------------------------------- обмены

function userToken(id = 'user-token'): Exchange {
  return {
    id, note: 'Обновление токена пользователя: grant_type=refresh_token + scope, Basic ключей приложения [песочница: ответ без нового refresh-токена]',
    request: { method: 'POST', path: '/identity/v1/oauth2/token', body: { $type: 'string' } },
    response: { status: 200, body: { access_token: USER_TOKEN, expires_in: 7200, token_type: 'User Access Token' } },
  };
}

function appToken(): Exchange {
  return {
    id: 'app-token', note: 'Токен приложения: grant_type=client_credentials, scope api_scope (официальный клиент eBay) — для Browse API [EBAY_C06]',
    request: { method: 'POST', path: '/identity/v1/oauth2/token', body: { $type: 'string' } },
    response: { status: 200, body: { access_token: APP_TOKEN, expires_in: 7200, token_type: 'Application Access Token' } },
  };
}

function bulkUpdate(id: string, offers: Array<Record<string, unknown>>, response: Exchange['response'] | null, fault?: 'NETWORK_ERROR' | 'TIMEOUT'): Exchange {
  return {
    id, request: { method: 'POST', path: '/sell/inventory/v1/bulk_update_price_quantity', body: { requests: offers.map((o) => ({ offers: [o] })) } },
    ...(fault ? { fault } : { response: response! }),
  };
}

const ok200 = (items: Array<{ n: number }>) => ({ status: 200, body: { responses: items.map(({ n }) => ({ statusCode: 200, sku: ids(n).sku, offerId: ids(n).offerId })) } });

function offerBody(n: number, o: { priceMinor?: number; currency?: string; quantity?: number | null; status?: string; migrated?: boolean } = {}) {
  const i = ids(n);
  return {
    offerId: i.offerId, sku: i.sku, marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE',
    ...(o.quantity === null ? {} : { availableQuantity: o.quantity ?? 5 }),
    pricingSummary: { price: { value: major(o.priceMinor ?? 1149), currency: o.currency ?? 'EUR' } },
    listingPolicies: o.migrated ? { eBayPlusIfEligible: false, bestOfferTerms: { bestOfferEnabled: true } } : { paymentPolicyId: '6200000002', returnPolicyId: '6200000003', fulfillmentPolicyId: '6200000001', eBayPlusIfEligible: false },
    categoryId: '20695', merchantLocationKey: o.migrated ? 'syn-location-auto-1' : 'syn-lager-1', tax: { applyTax: false },
    listing: { listingId: i.listingId, listingStatus: o.status ?? 'ACTIVE', soldQuantity: 0 },
    status: 'PUBLISHED', listingDuration: 'GTC',
  };
}

const getOffer = (id: string, n: number, o: Parameters<typeof offerBody>[1] = {}): Exchange => ({
  id, request: { method: 'GET', path: `/sell/inventory/v1/offer/${ids(n).offerId}` }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: offerBody(n, o) },
});

const browse = (id: string, n: number, minor: number, revision: string, quantity = 5, vat = false): Exchange => ({
  id, note: 'Живой листинг: цена, оценка количества и счётчик правок продавца sellerItemRevision [песочница]',
  request: { method: 'GET', path: `/buy/browse/v1/item/v1|${ids(n).listingId}|0`, query: { fieldgroups: 'COMPACT' } },
  response: { status: 200, body: {
    itemId: `v1|${ids(n).listingId}|0`, sellerItemRevision: revision, price: { value: major(minor), currency: 'EUR' },
    estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: quantity, estimatedSoldQuantity: 0, estimatedRemainingQuantity: quantity }],
    legacyItemId: ids(n).listingId,
    ...(vat ? { taxes: [{ taxJurisdiction: { region: { regionName: 'DE', regionType: 'COUNTRY' } }, taxType: 'VAT', taxPercentage: '19.0', shippingAndHandlingTaxed: true, includedInPrice: true, ebayCollectAndRemitTax: true }] } : {}),
  } },
});

const NOT_AVAILABLE = { status: 404, body: { errors: [{ errorId: 25713, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'Request', message: 'This Offer is not available.' }] } };

function xml(body: string) { return { status: 200, headers: { 'content-type': 'text/xml' }, body }; }

/** GetItem, сокращённый до элементов, которые читают проверки; Seller оставлен с синтетической почтой — проверка утечки (Р-4) */
function getItemXml(n: number, listingType: 'FixedPriceItem' | 'Chinese', bestOffer: boolean, variations: string[] = []): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Timestamp>2026-09-27T17:24:36.316Z</Timestamp><Ack>Success</Ack>'
    + `<Version>1193</Version><Item><Currency>EUR</Currency><ItemID>${ids(n).listingId}</ItemID><ListingDesigner><LayoutID>7710000</LayoutID><ThemeID>7710</ThemeID></ListingDesigner>`
    + `<ListingDuration>${listingType === 'Chinese' ? 'Days_7' : 'GTC'}</ListingDuration><ListingType>${listingType}</ListingType><Quantity>${listingType === 'Chinese' ? 1 : 4}</Quantity>`
    + `<Seller><Email>${SELLER_EMAIL}</Email><UserID>syn_ebay_seller_0001</UserID></Seller><SellingStatus><CurrentPrice currencyID="EUR">${listingType === 'Chinese' ? '5.0' : '14.99'}</CurrentPrice><ListingStatus>Active</ListingStatus></SellingStatus>`
    + `<Site>Germany</Site>${bestOffer ? '<BestOfferDetails><BestOfferCount>0</BestOfferCount><BestOfferEnabled>true</BestOfferEnabled><NewBestOffer>false</NewBestOffer></BestOfferDetails>' : ''}`
    + (variations.length > 0 ? `<Variations>${variations.map((v) => `<Variation><SKU>${v}</SKU><Quantity>2</Quantity></Variation>`).join('')}</Variations>` : '')
    + `<SKU>${ids(n).sku}</SKU><SellerProfiles><SellerShippingProfile><ShippingProfileID>6200000001</ShippingProfileID></SellerShippingProfile><SellerReturnProfile><ReturnProfileID>6200000003</ReturnProfileID></SellerReturnProfile><SellerPaymentProfile><PaymentProfileID>6200000002</PaymentProfileID></SellerPaymentProfile></SellerProfiles></Item></GetItemResponse>`;
}
const PREFS_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<GetUserPreferencesResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Timestamp>2026-09-27T17:24:39.119Z</Timestamp><Ack>Success</Ack><Version>1271</Version><OutOfStockControlPreference>false</OutOfStockControlPreference></GetUserPreferencesResponse>';

const trading = (id: string, body: string, response: string): Exchange => ({ id, request: { method: 'POST', path: '/ws/api.dll', body }, response: xml(response) });
const prefs = (id = 'get-user-preferences') => trading(id, GET_USER_PREFERENCES_REQUEST, PREFS_XML);
const getItem = (id: string, n: number, type: 'FixedPriceItem' | 'Chinese', bestOffer: boolean, variations: string[] = []) => trading(id, getItemRequest(ids(n).listingId), getItemXml(n, type, bestOffer, variations));
const offersBySku = (id: string, n: number): Exchange => ({ id, request: { method: 'GET', path: '/sell/inventory/v1/offer', query: { sku: ids(n).sku } }, response: NOT_AVAILABLE });

// ---------------------------------------------------------------------------------------------------- сценарии

function scenario(file: string, id: string, title: string, description: string, tags: string[], provenance: Provenance, steps: Step[], exchanges: Exchange[],
  expect: Scenario['expect'] = {}, w: World = world()): { file: string; scenario: Scenario } {
  return { file, scenario: { format: SCENARIO_FORMAT, id, channel: 'EBAY', apiVersion: 'sell-inventory-v1 (sandbox 2026-09-27)', title, description, tags, provenance, world: w, steps, exchanges, expect } };
}

const call = (id: string, method: string, args: unknown[], expect?: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'call', method, args, ...(expect !== undefined ? { expect } : {}), ...extra }) as Step;
const wait = (id: string, ms: number) => ({ id, kind: 'advanceClock', ms }) as Step;
const readBackOf = (w: Write, fields: string[]) => ({ writeScope: w.writeScope, fields });
const confirmOf = (w: Write) => ({ channelWriteId: w.channelWriteId, writeScope: w.writeScope, expected: w.value, dispatchedAt: { $clockIso: 0 } });

export function buildEbayScenarios(): Array<{ file: string; scenario: Scenario }> {
  const out: Array<{ file: string; scenario: Scenario }> = [];

  // 1. Принятая запись цены подтверждается живым листингом
  {
    const w = priceWrite('cw-1', 1, 1149);
    out.push(scenario('dispatch-accepted-live-readback.json', 'ebay/dispatch/accepted-live-readback',
      'Цена принята (200) и подтверждена живым листингом Browse API; расход бюджета правок — по листингу',
      'Ответ по элементу statusCode 200 — ACCEPTED без «применено сразу»: GET offer показывает НАШУ запись, применение к листингу подтверждает Browse API [EBAY_C05]. План несёт расход бюджета правок: листинг, поле, одна попытка [Р-163]. Цена — ровно два знака из целых центов.',
      ['dispatch', 'readback', 'conservative:EBAY_C05_PRICE_READBACK_LIVE_LISTING', 'conservative:EBAY_C06_BROWSE_APPLICATION_TOKEN'], RECORDED,
      [
        call('plan', 'planDispatch', [[w]], { rejected: [], batches: [{ operation: 'bulkUpdatePriceQuantity', requestCount: 1, items: [{ channelWriteId: 'cw-1' }],
          budgetCharges: [{ budgetScopeKey: ids(1).listingId, field: 'PRICE', attempts: 1 }] }] }),
        call('dispatch', 'dispatch', [batch('ebay:b1', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-1', status: 'ACCEPTED', appliedImmediately: false }] }),
        call('confirm', 'confirm', [[confirmOf(w)]], [{ channelWriteId: 'cw-1', status: 'APPLIED', observation: { field: 'PRICE', source: 'READBACK',
          identity: { marketplace: 'EBAY_DE', externalSku: ids(1).sku, externalOfferId: ids(1).offerId, externalListingId: ids(1).listingId },
          value: { price: { amountMinor: 1149, currency: 'EUR', basis: 'GROSS' } }, effectivePrice: { amountMinor: 1149, currency: 'EUR', basis: 'GROSS' },
          liveness: { isLive: true, reasons: [] } } }]),
      ],
      [sb(userToken()), sb(bulkUpdate('bulk-ok', [{ offerId: ids(1).offerId, price: { value: '11.49', currency: 'EUR' } }], ok200([{ n: 1 }]))),
        sb(getOffer('get-offer', 1, { priceMinor: 1149 })), sy(appToken()), sb(browse('browse', 1, 1149, '3'))],
      { noAlerts: true, logs: [{ code: 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', details: { divergence: false } }] }));
  }

  // 2. 207 — частичный успех
  {
    const a = priceWrite('cw-2a', 2, 1129);
    const b = priceWrite('cw-2b', 3, 1129);
    out.push(scenario('bulk-207-partial.json', 'ebay/dispatch/bulk-207-partial',
      '207: одно предложение принято, другое — 25604 «Offer not found»',
      'Записано в песочнице: верный и чужой offerId в одном вызове — 207, у верного 200, у чужого 400 25604. Принятое ждёт обратного чтения, ненайденное — NOT_FOUND без повтора.',
      ['mandatory:bulk-207-partial', 'dispatch'], RECORDED,
      [call('dispatch', 'dispatch', [batch('ebay:b2', [a, b])], { attemptsMade: 1, outcomes: [
        { channelWriteId: 'cw-2a', status: 'ACCEPTED', appliedImmediately: false },
        { channelWriteId: 'cw-2b', status: 'REJECTED', error: { code: 'NOT_FOUND', class: 'PERMANENT', scope: 'ITEM', channelCode: '25604', httpStatus: 400 } },
      ] })],
      [sb(userToken()), sb(bulkUpdate('bulk-partial', [{ offerId: ids(2).offerId, price: { value: '11.29', currency: 'EUR' } }, { offerId: ids(3).offerId, price: { value: '11.29', currency: 'EUR' } }], { status: 207, body: { responses: [
        { statusCode: 200, sku: ids(2).sku, offerId: ids(2).offerId },
        { statusCode: 400, offerId: ids(3).offerId, errors: [{ errorId: 25604, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'REQUEST', message: 'Input error. Offer not found. Please try input valid request or contact customer support..' }] },
      ] } }))],
      { noAlerts: true }));
  }

  // 3. 429
  {
    const w = priceWrite('cw-3', 4, 1500);
    out.push(scenario('dispatch-429.json', 'ebay/dispatch/429',
      '429: запись не принята, повтор не раньше чем через 60 секунд',
      'Лимиты Inventory API неизвестны (песочница — заглушка, Р-162): ответ 429 не записан, форма тела синтетическая. Запись — REJECTED RATE_LIMITED с retryAt +60 с [EBAY_C01, E-04]; транспорт запись не повторяет.',
      ['mandatory:429', 'dispatch', 'conservative:EBAY_C01_REQUEST_BUDGET'], synthetic('docs/channel-capabilities.md#E-04'),
      [call('dispatch', 'dispatch', [batch('ebay:b3', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-3', status: 'REJECTED',
        error: { code: 'RATE_LIMITED', class: 'TRANSIENT', httpStatus: 429, retryAt: { $clockIso: 60_000 } } }] })],
      [userToken(), bulkUpdate('bulk-429', [{ offerId: ids(4).offerId, price: { value: '15.00', currency: 'EUR' } }], { status: 429, body: { errors: [{ errorId: 2001, message: 'Too many requests' }] } })],
      { noAlerts: true, logs: [{ code: 'EBAY_C01_REQUEST_BUDGET', question: 'E-04', count: 1 }] }));
  }

  // 4. Обрыв соединения — исход неизвестен
  {
    const w = quantityWrite('cw-4', 5, 3);
    out.push(scenario('dispatch-connection-closed-unknown-outcome.json', 'ebay/dispatch/connection-closed-unknown-outcome',
      'Обрыв соединения посреди записи: OUTCOME_UNKNOWN, без повтора; итог — обратным чтением',
      'В протоколе песочницы: «SocketError: other side closed» посреди bulk_update_price_quantity, «повтор прошёл». Запись не повторяется транспортом [EBAY_C02]; подтверждение читает предложение (ответ выведен — в протоколе чтения после обрыва нет) и сверяет его с оценкой Browse [EBAY_C13] — количество применено.',
      ['mandatory:timeout-unknown-outcome', 'dispatch', 'conservative:EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES', 'conservative:EBAY_C13_QUANTITY_READBACK_OFFER_RECORD'], RECORDED,
      [
        call('dispatch', 'dispatch', [batch('ebay:b4', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-4', status: 'OUTCOME_UNKNOWN', error: { code: 'NETWORK', class: 'TRANSIENT' } }] }),
        call('confirm', 'confirm', [[confirmOf(w)]], [{ channelWriteId: 'cw-4', status: 'APPLIED', observation: { field: 'QUANTITY', value: { quantity: 3 } } }]),
      ],
      [sb(userToken()), sb(bulkUpdate('bulk-socket-closed', [{ offerId: ids(5).offerId, availableQuantity: 3 }], null, 'NETWORK_ERROR')),
        // «Повтор прошёл» — вот и всё, что есть в протоколе: чтение после обрыва выведено
        sy(getOffer('get-offer', 5, { quantity: 3 })), sy(appToken()), sy(browse('browse-estimate', 5, 1149, '2', 3))],
      { noAlerts: true, logs: [{ code: 'EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES', question: 'E-03', count: 1 },
        { code: 'EBAY_C13_QUANTITY_READBACK_OFFER_RECORD', question: 'E-13', count: 1, details: { availableQuantity: 3, estimatedAvailableQuantity: 3, mismatch: false } }] }));
  }

  // 5. Устаревшая версия
  out.push(scenario('plan-stale-version.json', 'ebay/plan/stale-version',
    'Две версии одной единицы записи в плане: отправляется старшая, младшая — STALE_VERSION',
    'INV-03: старое значение не отправляется. План без обращения к каналу.',
    ['mandatory:stale-version', 'plan'], synthetic(),
    [call('plan', 'planDispatch', [[priceWrite('cw-5a', 6, 1400, { version: 1 }), priceWrite('cw-5b', 6, 1350, { version: 2 })]], {
      batches: [{ items: [{ channelWriteId: 'cw-5b' }] }],
      rejected: [{ channelWriteId: 'cw-5a', error: { code: 'STALE_VERSION', class: 'PERMANENT' } }],
    })], [], { noAlerts: true }));

  // 6. Бюджет правок исчерпан посреди дня
  {
    const w = priceWrite('cw-6', 7, 1290);
    const q = quantityWrite('cw-6q', 7, 2);
    out.push(scenario('budget-exhausted.json', 'ebay/budget/exhausted-mid-day',
      'Р-163: цене — 190 попыток правки листинга за сутки, 191-я не уходит; запись остатка идёт из резерва; через сутки цена снова уходит',
      'За пять часов до 10:00 UTC по листингу было 189 попыток правки цены. План считает расход по листингу; 190-я попытка уходит. Следующая цена не уходит в канал: EDIT_BUDGET_EXHAUSTED, attemptsMade 0, retryAt — когда попытки пятичасовой давности выйдут из 24 часов (худший случай неизвестной границы дня, E-02) [EBAY_C08]. Доли — как edit_budget в базе (0008): цене 250 − резерв остатка 50 − запас 10 = 190, остатку — весь лимит; поэтому запись остатка того же листинга уходит и сейчас (уменьшение остатка не блокируется ценой, Р-6). Через 19 часов цена уходит. Первый слой — edit_budget в базе (ядро списывает budgetCharges); лимит 250 — Р-2, песочницей не воспроизведён (260 правок подряд — все 200, Р-162).',
      ['mandatory:budget-exhausted', 'budget', 'conservative:EBAY_C08_EDIT_BUDGET_ROLLING_DAY'], synthetic('docs/decisions.md#Р-163', 'docs/channel-capabilities.md#E-02'),
      [
        call('plan', 'planDispatch', [[w]], { batches: [{ budgetCharges: [{ budgetScopeKey: ids(7).listingId, field: 'PRICE', attempts: 1 }] }], rejected: [] }),
        call('price-attempt-190', 'dispatch', [batch('ebay:b6', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-6', status: 'ACCEPTED' }] }),
        call('price-attempt-191', 'dispatch', [batch('ebay:b6', [{ ...w, attemptNo: 2 }])], { attemptsMade: 0, outcomes: [{ channelWriteId: 'cw-6', status: 'REJECTED',
          error: { code: 'EDIT_BUDGET_EXHAUSTED', class: 'TRANSIENT', scope: 'ITEM', retryAt: { $clockIso: 19 * 3600_000 }, message: { $regex: '190 of 190' } } }] }),
        call('quantity-from-reserve', 'dispatch', [batch('ebay:b6q', [q])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-6q', status: 'ACCEPTED' }] }),
        wait('until-window-frees', 19 * 3600_000),
        call('price-after-window', 'dispatch', [batch('ebay:b6', [{ ...w, attemptNo: 3 }])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-6', status: 'ACCEPTED' }] }),
      ],
      [userToken(), bulkUpdate('bulk-190th', [{ offerId: ids(7).offerId, price: { value: '12.90', currency: 'EUR' } }], ok200([{ n: 7 }])),
        bulkUpdate('bulk-quantity', [{ offerId: ids(7).offerId, availableQuantity: 2 }], ok200([{ n: 7 }])),
        userToken('user-token-renewed'), bulkUpdate('bulk-next-day', [{ offerId: ids(7).offerId, price: { value: '12.90', currency: 'EUR' } }], ok200([{ n: 7 }]))],
      { noAlerts: true, logs: [{ code: 'EBAY_C08_EDIT_BUDGET_ROLLING_DAY', question: 'E-02', count: 1, details: { used: 190, limit: 190, field: 'PRICE' } }] },
      world({ adapter: { ebayEditAttempts: [{ listingId: ids(7).listingId, attempts: 189, agoMs: 5 * 3600_000, field: 'PRICE' }] } })));
  }

  // 7. Тенант не владеет аккаунтом
  out.push(scenario('tenant-mismatch.json', 'ebay/port/tenant-mismatch',
    'Р-31: тенант сообщения не владеет аккаунтом — отказ до обращения к eBay',
    'Каталог аккаунтов сверяет тенант; несовпадение — TENANT_MISMATCH и CRITICAL-алерт, ни одного запроса ни к Inventory API, ни к серверу токенов.',
    ['port'], synthetic(),
    [call('dispatch', 'dispatch', [batch('ebay:b7', [priceWrite('cw-7', 8, 1500)])], { attemptsMade: 0, outcomes: [{ channelWriteId: 'cw-7', status: 'REJECTED', error: { code: 'TENANT_MISMATCH', scope: 'ACCOUNT' } }] },
      { ctx: { tenantId: OTHER_TENANT } })],
    [], { alerts: [{ code: 'EBAY_TENANT_MISMATCH', severity: 'CRITICAL', count: 1 }] }));

  // 8. Запись в немигрированный листинг
  {
    const w = priceWrite('cw-8', 9, 1399, { migrated: false });
    out.push(scenario('unmigrated-write-rejected.json', 'ebay/r164/unmigrated-write-rejected',
      'Р-164: запись в листинг не под Inventory API отклоняется до обращения к каналу — без миграции и без записи по SKU',
      'У идентичности нет offerId: листинг не мигрирован. План и отправка отказывают PRECONDITION_FAILED (единица требует человека) с кодом журнала; ни одного обмена — ни токена, ни записи, ни bulk_migrate_listing. В песочнице запись по SKU такого листинга — 400 25604 «SKU not found», то есть «попробовать» было бы тратой бюджета правок (Р-19).',
      ['mandatory:unmigrated-write-rejected', 'r164'], synthetic('docs/decisions.md#Р-164'),
      [
        call('plan', 'planDispatch', [[w]], { batches: [], rejected: [{ channelWriteId: 'cw-8', error: { code: 'PRECONDITION_FAILED', class: 'REQUIRES_HUMAN', scope: 'ITEM' } }] }),
        call('dispatch', 'dispatch', [batch('ebay:b8', [w])], { attemptsMade: 0, outcomes: [{ channelWriteId: 'cw-8', status: 'REJECTED', error: { code: 'PRECONDITION_FAILED' } }] }),
      ],
      [], { noAlerts: true, logs: [{ code: 'EBAY_R164_WRITE_TO_UNMIGRATED_LISTING', count: 2, details: { listingId: ids(9).listingId } }] }));
  }

  // 9. Предполётная проверка без согласия: миграции нет
  out.push(scenario('migration-preflight-only.json', 'ebay/migration/preflight-without-consent',
    'Без согласия владельца — только предполётная проверка: фиксированная цена с Best Offer — READY_WITH_LOSSES, bulk_migrate_listing не вызывается',
    'Листинг, созданный Trading API: GetUserPreferences (out-of-stock control выключен), GetItem (FixedPriceItem, SKU, бизнес-политики, Best Offer), Inventory offer?sku= — 404 25713 (не под Inventory API). Вердикт READY_WITH_LOSSES: Best Offer — LOSS (песочница его сохранила, но Р-2 и E-15) [EBAY_C10]; шаблон — INFO «не определяется» [EBAY_C11]; другие инструменты — WARNING [EBAY_C12]; out-of-stock control — WARNING. Миграция без MigrationConsentProof невозможна по типу (ebay.contract.test.ts), а запись в этот листинг отклоняется [Р-164] — ни одного обмена миграции. Почта продавца из GetItem не попадает ни в результат, ни в журнал (Р-4).',
    ['mandatory:migration-without-consent', 'migration', 'conservative:EBAY_C10_BEST_OFFER_LOSS', 'conservative:EBAY_C11_TEMPLATE_UNDETECTABLE', 'conservative:EBAY_C12_OTHER_TOOLS_ALWAYS_WARN'], RECORDED,
    [
      call('preflight', 'preflight', [[ids(20).listingId]], [{ listingId: ids(20).listingId, verdict: 'READY_WITH_LOSSES', listingSnapshotSha256: { $regex: '^[0-9a-f]{64}$' },
        findings: { $unordered: [
          { code: 'C03_BEST_OFFER', severity: 'LOSS' }, { code: 'C06_TEMPLATE', severity: 'INFO' },
          { code: 'C10_OTHER_TOOLS', severity: 'WARNING' }, { code: 'C11_OUT_OF_STOCK_CONTROL', severity: 'WARNING' },
        ] } }]),
      call('write-still-refused', 'planDispatch', [[priceWrite('cw-9', 20, 1349, { migrated: false })]], { batches: [], rejected: [{ channelWriteId: 'cw-9', error: { code: 'PRECONDITION_FAILED' } }] }),
    ],
    [sb(userToken()), sb(prefs()), sb(getItem('get-item', 20, 'FixedPriceItem', true)), sb(offersBySku('offer-by-sku-not-managed', 20))],
    { noAlerts: true, noLogCodes: ['EBAY_LISTING_MIGRATION'] },
    world({ pii: [SELLER_EMAIL] })));

  // 10. Миграция с согласием
  {
    const parsed = parseGetItem(getItemXml(21, 'FixedPriceItem', false));
    if (!parsed.ok) throw new Error(parsed.error);
    const sha = snapshotSha256({ ...parsed.facts, outOfStockControl: false });
    const proof = { migrationConsentId: 'mc-syn-0001', listingId: ids(21).listingId, listingSnapshotSha256: sha, offerMappingStatus: 'MIGRATION_STARTED' };
    out.push(scenario('migration-with-consent.json', 'ebay/migration/with-consent',
      'Миграция с согласием владельца: перепроверка снимка, bulk_migrate_listing одного листинга, предложение Inventory API в ответе',
      'Р-164: ровно один цикл, один листинг — как в песочнице. Согласие дано на снимок предполётной проверки (SHA-256 подмножества GetItem); перед вызовом листинг проверяется заново и снимок совпал. Ответ песочницы: responses[].statusCode 200, inventoryItems[{sku, offerId}] — MIGRATED с идентификатором предложения, которое дальше несёт идентичность записи.',
      ['mandatory:migration-with-consent', 'migration'], RECORDED,
      [
        call('preflight', 'preflight', [[ids(21).listingId]], [{ listingId: ids(21).listingId, verdict: 'READY', listingSnapshotSha256: sha }]),
        wait('budget-refill', 5000),
        call('migrate', 'migrate', [[proof]], [{ listingId: ids(21).listingId, status: 'MIGRATED', externalOfferIds: [ids(21).offerId] }]),
      ],
      // Записанный листинг был с Best Offer; этот — без него, его GetItem выведен
      [sb(userToken()), sb(prefs()), sy(getItem('get-item', 21, 'FixedPriceItem', false)), sb(offersBySku('offer-by-sku-not-managed', 21)),
        sb(prefs('recheck-preferences')), sy(getItem('recheck-get-item', 21, 'FixedPriceItem', false)), sb(offersBySku('recheck-offer-by-sku', 21)),
        { origin: 'SANDBOX', id: 'bulk-migrate', request: { method: 'POST', path: '/sell/inventory/v1/bulk_migrate_listing', body: { requests: [{ listingId: ids(21).listingId }] } },
          response: { status: 200, body: { responses: [{ statusCode: 200, listingId: ids(21).listingId, marketplaceId: 'EBAY_DE', inventoryItems: [{ sku: ids(21).sku, offerId: ids(21).offerId }] }] } } }],
      { noAlerts: true, logs: [{ code: 'EBAY_LISTING_MIGRATION', count: 1, details: { listings: 1, consents: 'mc-syn-0001' } }] }));
  }

  // 10б. Вариации
  out.push(scenario('migration-preflight-variations.json', 'ebay/migration/preflight-variations',
    'Листинг с вариациями: C12 — WARNING, цену вариации по живому листингу не подтвердить',
    'Вариаций в песочнице не было — GetItem синтетический. Browse-идентификатор v1|<ItemID>|0 адресует листинг, а не вариацию, поэтому подтверждение цены вариации не поддерживается [EBAY_C15, E-13]; бюджет 250 правок общий на все вариации (E-02).',
    ['migration', 'conservative:EBAY_C15_VARIATIONS_PRICE_CONFIRMATION'], synthetic(),
    [call('preflight', 'preflight', [[ids(23).listingId]], [{ listingId: ids(23).listingId, verdict: 'READY',
      findings: { $contains: [{ code: 'C12_VARIATIONS', severity: 'WARNING', details: { $regex: 'cannot be confirmed on the live listing' } }] } }])],
    [userToken(), prefs(), getItem('get-item', 23, 'FixedPriceItem', false, ['SYN-EBAY-23-S', 'SYN-EBAY-23-M']), offersBySku('offer-by-sku-not-managed', 23)],
    { noAlerts: true, logs: [{ code: 'EBAY_C15_VARIATIONS_PRICE_CONFIRMATION', count: 1, question: 'E-13' }] }));

  // 11. Аукцион
  out.push(scenario('auction-ineligible.json', 'ebay/migration/auction-ineligible',
    'Аукцион (ListingType Chinese) — INELIGIBLE: не мигрируется и не управляется',
    'Записано в песочнице: аукцион, созданный AddItem. Вердикт INELIGIBLE по C01 [Р-2, Р-164]; Inventory API для аукциона не запрашивается.',
    ['mandatory:auction-ineligible', 'migration'], RECORDED,
    [call('preflight', 'preflight', [[ids(22).listingId]], [{ listingId: ids(22).listingId, verdict: 'INELIGIBLE', findings: { $contains: [{ code: 'C01_AUCTION', severity: 'BLOCKER' }] } }])],
    [sb(userToken()), sb(prefs()), sb(getItem('get-item', 22, 'Chinese', false))], { noAlerts: true }));

  // 12. Количество 0
  {
    const w = quantityWrite('cw-12', 10, 0);
    out.push(scenario('quantity-zero.json', 'ebay/quantity/zero-applied-despite-error',
      'Количество 0: ответ 400 25004, но значение применено — OUTCOME_UNKNOWN, обратное чтение показывает 0 и OUT_OF_STOCK',
      'Записано в песочнице: offers[].availableQuantity=0 → 400, responses[] с errorId 25004 «quantity must be a valid number greater than 0»; GET offer после этого — availableQuantity 0, listingStatus OUT_OF_STOCK (листинг не завершён, E-06). Отказ был бы ложью: запись — OUTCOME_UNKNOWN без повтора [EBAY_C04], подтверждение — APPLIED с признаком «не живой: OUT_OF_STOCK». Уменьшение опубликованного остатка никогда не блокируется (инвариант 5).',
      ['mandatory:quantity-zero', 'quantity', 'conservative:EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN'], RECORDED,
      [
        call('dispatch', 'dispatch', [batch('ebay:b12', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-12', status: 'OUTCOME_UNKNOWN', error: { channelCode: '25004', httpStatus: 400 } }] }),
        call('confirm', 'confirm', [[confirmOf(w)]], [{ channelWriteId: 'cw-12', status: 'APPLIED', observation: { field: 'QUANTITY', value: { quantity: 0 }, liveness: { isLive: false, reasons: ['OUT_OF_STOCK'] } } }]),
      ],
      [sb(userToken()), sb(bulkUpdate('bulk-qty-zero', [{ offerId: ids(10).offerId, availableQuantity: 0 }], { status: 400, body: { responses: [{ statusCode: 400, sku: ids(10).sku, offerId: ids(10).offerId, errors: [{
        errorId: 25004, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'REQUEST',
        message: 'The eBay listing associated with the inventory item, or the unpublished offer has an invalid quantity. The quantity must be a valid number greater than 0.',
        parameters: [{ name: 'ItemID', value: ids(10).listingId }, { name: 'SKU', value: ids(10).sku }] }] }] } })),
        sb(getOffer('get-offer-zero', 10, { quantity: 0, priceMinor: 1129, status: 'OUT_OF_STOCK' }))],
      { noAlerts: true, logs: [{ code: 'EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN', question: 'E-06', count: 1 }] }));
  }

  // 13. Валюта не витрины
  {
    const w = priceWrite('cw-13', 11, 1049, { currency: 'USD' });
    out.push(scenario('currency-mismatch.json', 'ebay/price/currency-mismatch',
      'Цена в USD у предложения EBAY_DE отклоняется до отправки: песочница приняла бы её молча',
      'В песочнице bulk_update_price_quantity с currency USD у предложения EBAY_DE ответил 200 и сохранил {"value":"10.49","currency":"USD"}. Адаптер сверяет валюту с витриной сам: VALIDATION в плане и при отправке, ни одного обмена [EBAY_C03, E-12].',
      ['mandatory:currency-mismatch', 'price', 'conservative:EBAY_C03_LOCAL_CURRENCY_AND_SCALE'], synthetic(),
      [
        call('plan', 'planDispatch', [[w]], { batches: [], rejected: [{ channelWriteId: 'cw-13', error: { code: 'VALIDATION', scope: 'ITEM' } }] }),
        call('dispatch', 'dispatch', [batch('ebay:b13', [w])], { attemptsMade: 0, outcomes: [{ channelWriteId: 'cw-13', status: 'REJECTED', error: { code: 'VALIDATION' } }] }),
      ],
      [], { noAlerts: true, logs: [{ code: 'EBAY_C03_LOCAL_CURRENCY_AND_SCALE', question: 'E-12', count: 2 }] }));
  }

  // 14. Пакет больше 25
  {
    const writes = Array.from({ length: 26 }, (_, i) => priceWrite(`cw-14-${i}`, 30 + i, 1000 + i));
    out.push(scenario('batch-split-25.json', 'ebay/plan/batch-split-25',
      '26 записей: план делит на 25 + 1; пакет больше 25 при отправке отклоняется без обращения к каналу',
      'Песочница: 26 запросов в одном вызове — 400 25712 «The maximum size allowed is 25» на весь запрос [EBAY_C09]. План не собирает пакет больше 25; пакет, собранный мимо плана, отклоняется локально — ни одного обмена.',
      ['mandatory:batch-split-25', 'plan', 'conservative:EBAY_C09_BATCH_MAX_25'], synthetic(),
      [
        call('plan', 'planDispatch', [writes], { rejected: [], batches: [
          { requestCount: 1, items: writes.slice(0, 25).map((x) => ({ channelWriteId: x.channelWriteId })) },
          { requestCount: 1, items: [{ channelWriteId: writes[25]!.channelWriteId }] },
        ] }),
        call('oversized-batch', 'dispatch', [batch('ebay:b14', writes)], { attemptsMade: 0, outcomes: { $every: { status: 'REJECTED', error: { code: 'VALIDATION', scope: 'BATCH' } } } }),
      ],
      [], { noAlerts: true, logs: [{ code: 'EBAY_C09_BATCH_MAX_25', count: 1 }] }));
  }

  // 15. Отказ всего запроса
  {
    const a = priceWrite('cw-15a', 12, 1110);
    const b = priceWrite('cw-15b', 13, 1111);
    out.push(scenario('request-level-400.json', 'ebay/dispatch/request-level-400',
      '400 без responses[] — отказ всего запроса: каждая запись вызова REJECTED с кодом канала',
      'Записано в песочнице: 25709 «Invalid value for Offers.price.value.» приходит на весь запрос, без ответа по элементам. Все записи вызова — VALIDATION, scope BATCH, channelCode 25709; повтора нет.',
      ['mandatory:request-level-400', 'dispatch'], RECORDED,
      [call('dispatch', 'dispatch', [batch('ebay:b15', [a, b])], { attemptsMade: 1, outcomes: [
        { channelWriteId: 'cw-15a', status: 'REJECTED', error: { code: 'VALIDATION', scope: 'BATCH', channelCode: '25709', httpStatus: 400 } },
        { channelWriteId: 'cw-15b', status: 'REJECTED', error: { code: 'VALIDATION', scope: 'BATCH', channelCode: '25709', httpStatus: 400 } },
      ] })],
      [sb(userToken()), sb(bulkUpdate('bulk-invalid-value', [{ offerId: ids(12).offerId, price: { value: '11.10', currency: 'EUR' } }, { offerId: ids(13).offerId, price: { value: '11.11', currency: 'EUR' } }],
        { status: 400, body: { errors: [{ errorId: 25709, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'Request', message: 'Invalid value for Offers.price.value.' }] } }))],
      { noAlerts: true }));
  }

  // 16. Цена ниже минимума витрины
  {
    const w = priceWrite('cw-16', 14, 50);
    out.push(scenario('price-below-minimum.json', 'ebay/price/below-storefront-minimum',
      'Цена ниже минимума витрины: 25016 с параметром MinValue — отказ без повтора',
      'Записано в песочнице для цены 0.00 (ответ по элементу 400 25016 «below the minimum price of EUR 1.00», parameters MinValue=EUR 1.00); в сценарии цена 0.50 — ноль адаптер не отправляет вовсе. Отказ VALIDATION с кодом канала и минимумом в сообщении; попытка расходует бюджет правок (Р-19).',
      ['mandatory:price-below-minimum', 'price'], RECORDED,
      [call('dispatch', 'dispatch', [batch('ebay:b16', [w])], { attemptsMade: 1, outcomes: [{ channelWriteId: 'cw-16', status: 'REJECTED',
        error: { code: 'VALIDATION', class: 'PERMANENT', scope: 'ITEM', channelCode: '25016', message: { $regex: 'MinValue EUR 1\\.00' } } }] })],
      [sb(userToken()), sb(bulkUpdate('bulk-below-minimum', [{ offerId: ids(14).offerId, price: { value: '0.50', currency: 'EUR' } }], { status: 400, body: { responses: [{ statusCode: 400, sku: ids(14).sku, offerId: ids(14).offerId, errors: [{
        errorId: 25016, domain: 'API_INVENTORY', subdomain: 'Selling', category: 'REQUEST',
        message: 'The The price in the listing is either invalid or below the minimum price of EUR 1.00. value is invalid.', inputRefIds: ['price'],
        parameters: [{ name: 'MinValue', value: 'EUR 1.00' }, { name: 'ItemID', value: ids(14).listingId }, { name: 'SKU', value: ids(14).sku }] }] }] } }))],
      { noAlerts: true }));
  }

  // 17. Предложение ↔ живой листинг
  {
    const w = priceWrite('cw-17', 15, 1399);
    out.push(scenario('readback-live-divergence.json', 'ebay/readback/offer-listing-divergence',
      'Живая цена листинга ≠ предложение Inventory API и разница — не НДС: предупреждение о другом инструменте (C10)',
      'По протоколу песочницы: после миграции ReviseFixedPriceItem через Trading API изменил живую цену (13.99), а GET offer продолжал показывать 14.99. Наблюдение, как у Kaufland и Amazon: цена продавца — из предложения (14.99), цена покупателя живого листинга — effectivePrice (13.99, Browse API) [EBAY_C05, токен приложения — EBAY_C06]. Разница не равна НДС из taxes (их нет) — WARNING EBAY_OFFER_LISTING_DIVERGENCE (листинг правит другой инструмент, C10).',
      ['mandatory:readback-browse-divergence', 'readback', 'conservative:EBAY_C05_PRICE_READBACK_LIVE_LISTING', 'conservative:EBAY_C06_BROWSE_APPLICATION_TOKEN'], RECORDED,
      [call('read-back', 'readBack', [[readBackOf(w, ['PRICE'])]], { failures: [], observations: [{ field: 'PRICE', source: 'READBACK',
        value: { price: { amountMinor: 1499, currency: 'EUR', basis: 'GROSS' } }, effectivePrice: { amountMinor: 1399, currency: 'EUR', basis: 'GROSS' } }] })],
      // Живая цена 13.99 после правки Trading API видна в протоколе по GetItem; ответ Browse с ней выведен
      [sb(userToken()), sb(getOffer('get-offer-after-revise', 15, { priceMinor: 1499, quantity: null, migrated: true })), sy(appToken()), sy(browse('browse-live', 15, 1399, '2', 4))],
      { alerts: [{ code: 'EBAY_OFFER_LISTING_DIVERGENCE', severity: 'WARNING', count: 1 }], logs: [{ code: 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', details: { divergence: true } }, { code: 'EBAY_C06_BROWSE_APPLICATION_TOKEN', count: 1 }] }));
  }

  // 17б. Цена покупателя = цена продавца + НДС (E-17)
  {
    const w = priceWrite('cw-17b', 19, 1349);
    out.push(scenario('readback-browse-vat-on-top.json', 'ebay/readback/browse-vat-on-top',
      'E-17: Browse = цена продавца × 1,19 с taxes VAT includedInPrice — effectivePrice несёт цену покупателя, предупреждения C10 нет',
      'По протоколу песочницы (раздел E-17): через ~25 минут после записи Browse показал 16.05 при отправленной 13.49, с taxes [{taxType VAT, taxPercentage 19.0, includedInPrice true, ebayCollectAndRemitTax true}]. Это не правка другим инструментом: цена продавца (13.49) — значение наблюдения, цена покупателя (16.05) — effectivePrice; расхождение ровно на ставку НДС из taxes — журнал EBAY_C14, без алерта C10. Неверную базу цены решает проверка Р-116 пути решения (диспетчер берёт effectivePrice ?? value.price). Подтверждение сравнивает цену продавца — APPLIED.',
      ['mandatory:browse-vat-on-top', 'readback', 'conservative:EBAY_C14_BROWSE_PRICE_WITH_VAT'], RECORDED,
      [call('confirm', 'confirm', [[confirmOf(w)]], [{ channelWriteId: 'cw-17b', status: 'APPLIED', observation: { field: 'PRICE',
        value: { price: { amountMinor: 1349, currency: 'EUR', basis: 'GROSS' } }, effectivePrice: { amountMinor: 1605, currency: 'EUR', basis: 'GROSS' } } }])],
      // Ответ Browse с НДС — в протоколе; чтение предложения с 13.49 выведено (протокол называет 13.49 в GetItem и Browse)
      [sb(userToken()), sy(getOffer('get-offer', 19, { priceMinor: 1349, quantity: null, migrated: true })), sy(appToken()), sb(browse('browse-vat', 19, 1605, '3', 4, true))],
      { noAlerts: true, logs: [{ code: 'EBAY_C14_BROWSE_PRICE_WITH_VAT', question: 'E-17', count: 1, details: { vatBasisPoints: 1900 } }] }));
  }

  // 18. Количество мигрированного предложения
  {
    const w = quantityWrite('cw-18', 16, 4);
    out.push(scenario('quantity-readback-migrated-offer.json', 'ebay/readback/migrated-offer-without-quantity',
      'У мигрированного предложения нет availableQuantity: обратное чтение отказывает, а не угадывает',
      'Записано в песочнице: предложение, созданное bulk_migrate_listing, пришло без availableQuantity (у листинга количество 4). Уровни количества у eBay разные (товар и предложение) — адаптер не подставляет другой уровень [EBAY_C07, E-03].',
      ['quantity', 'readback', 'conservative:EBAY_C07_QUANTITY_LEVEL_OFFER'], RECORDED,
      [call('read-back', 'readBack', [[readBackOf(w, ['QUANTITY'])]], { observations: [], failures: [{ writeScopeId: 'ws-ebay-qty-16', error: { code: 'NOT_FOUND', scope: 'ITEM' } }] })],
      [sb(userToken()), sb(getOffer('get-offer-migrated', 16, { priceMinor: 1499, quantity: null, migrated: true }))],
      { noAlerts: true, logs: [{ code: 'EBAY_C07_QUANTITY_LEVEL_OFFER', question: 'E-03', count: 1 }] }));
  }

  // 19. Обнаружение предложений
  out.push(scenario('discover-offers.json', 'ebay/discovery/offers',
    'Обнаружение: страница товаров Inventory API, предложения каждого SKU; без предложения (404 25713) — пропуск',
    'Ответ offer?sku= и 404 25713 записаны в песочнице; страница inventory_item (total, inventoryItems) в песочнице не записывалась — её форма синтетическая, (проверить). Курсор — смещение. Немигрированные листинги здесь не видны вовсе: их находит предполётная проверка.',
    ['discovery'], synthetic(),
    [call('discover', 'discoverOffers', [{ limit: 2 }], { nextCursor: '2', items: [{
      identity: { marketplace: 'EBAY_DE', externalSku: ids(17).sku, externalOfferId: ids(17).offerId, externalListingId: ids(17).listingId },
      gtins: [], condition: 'new', fulfillment: 'MERCHANT', currentPrice: { amountMinor: 1149, currency: 'EUR', basis: 'GROSS' }, currentQuantity: 5, isLive: true,
    }] })],
    [userToken(),
      { id: 'inventory-page', request: { method: 'GET', path: '/sell/inventory/v1/inventory_item', query: { limit: '2', offset: '0' } },
        response: { status: 200, body: { total: 3, size: 2, limit: 2, inventoryItems: [{ sku: ids(17).sku, condition: 'NEW', availability: { shipToLocationAvailability: { quantity: 7 } } }, { sku: ids(18).sku, condition: 'NEW' }] } } },
      { id: 'offers-17', request: { method: 'GET', path: '/sell/inventory/v1/offer', query: { sku: ids(17).sku } },
        response: { status: 200, body: { total: 1, size: 1, limit: 20, offers: [offerBody(17)] } } },
      offersBySku('offers-18-none', 18)],
    { noAlerts: true }));

  // 20. Входящие, конкуренты, заказы
  out.push(scenario('unsupported-inbound-competitors-orders.json', 'ebay/port/unsupported',
    'Входящие, конкуренты и заказы eBay в шаге 39 не поддерживаются: отказ, а не пустота',
    'Доставка отклоняется 501 UNSUPPORTED без разбора тела; конкуренты — отказ по каждому запросу (пустой снимок выглядел бы как «конкурентов нет»); заказы — UNSUPPORTED (Fulfillment API не проверялся, в заказах PII, Р-4). Ни одного обмена.',
    ['port', 'mandatory:inbound-unsupported'], synthetic(),
    [
      { id: 'inbound', kind: 'inbound', delivery: { method: 'POST', url: 'https://hooks.example.invalid/ebay/syn-token', body: { metadata: { topic: 'SYN' } } },
        expect: { kind: 'REJECTED', responseStatus: 501, error: { code: 'UNSUPPORTED' } } } as Step,
      call('competitors', 'readCompetitors', [[{ marketplace: 'EBAY_DE', channelProductRef: ids(1).listingId, condition: 'new' }]], { snapshots: [], failures: [{ error: { code: 'UNSUPPORTED' } }] }),
      call('orders', 'readOrderLines', [{ since: { $clockIso: -3600_000 }, limit: 10 }], undefined, { expectThrows: { code: 'UNSUPPORTED' } }),
    ],
    [], { noAlerts: true, logs: [{ code: 'EBAY_UNSUPPORTED', count: 3 }] }));

  return out.sort((a, b) => a.file.localeCompare(b.file));
}
