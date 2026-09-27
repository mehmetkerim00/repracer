import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterLogEntry, ChannelAccountId, FieldWrite, MigrationConsentProof, TenantId } from '@repracer/channel-port';
import {
  bulkUpdateBody, budgetChargesOf, createEbayAdapter, ebayAdapterFactory, decimalToMinor, formatMinor, NOT_MIGRATED_LOG_CODE, parseGetItem, RollingDayLedger, snapshotSha256, TokenBucket,
} from '../src/index.ts';

/** Модульные проверки адаптера eBay (шаг 39). Данные синтетические; формы ответов — как у песочницы (docs/evidence/step39-ebay-sandbox.md) */

const TENANT = '10000000-0000-4000-8000-000000000001' as TenantId;
const ACCOUNT = '20000000-0000-4000-8000-000000000001' as ChannelAccountId;
const NOW = '2026-09-27T10:00:00.000Z';
const ctx: AdapterCallContext = { tenantId: TENANT, channelAccountId: ACCOUNT, correlationId: 'unit', deadline: '2026-09-27T10:05:00.000Z' };

interface Seen { method: string; url: URL; headers: Record<string, string>; body: string }
type Reply = { status: number; body?: unknown; xml?: string } | 'NETWORK_ERROR' | 'BODY_BREAKS';

function world(handler: (r: Seen) => Reply, options: { ledger?: RollingDayLedger; requestBudget?: TokenBucket; writeMode?: 'SHADOW' | 'LIVE' } = {}) {
  const seen: Seen[] = [];
  const logs: AdapterLogEntry[] = [];
  const alerts: Array<{ code: string }> = [];
  let clock = Date.parse(NOW);
  const tokens = { n: 0 };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const r: Seen = { method: init?.method ?? 'GET', url, headers, body: typeof init?.body === 'string' ? init.body : '' };
    if (url.pathname === '/identity/v1/oauth2/token') {
      tokens.n += 1;
      const grant = new URLSearchParams(r.body).get('grant_type');
      return new Response(JSON.stringify({ access_token: grant === 'client_credentials' ? 'syn-app-token' : 'syn-user-token', expires_in: 7200, token_type: 'User Access Token' }), { status: 200 });
    }
    seen.push(r);
    const reply = handler(r);
    if (reply === 'NETWORK_ERROR') throw new TypeError('other side closed');
    // Заголовки пришли, тело оборвалось посреди чтения
    if (reply === 'BODY_BREAKS') return new Response(new ReadableStream({ start(c) { c.error(new TypeError('terminated: other side closed')); } }), { status: 200 });
    if (reply.xml !== undefined) return new Response(reply.xml, { status: reply.status, headers: { 'content-type': 'text/xml' } });
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createEbayAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => (tenantId === TENANT && channelAccountId === ACCOUNT
        ? { ok: true, account: { tenantId, channelAccountId, channel: 'EBAY', externalAccountId: 'syn-seller', marketplaces: ['EBAY_DE', 'EBAY_US'], credentialsRef: 'cred:seller', ...(options.writeMode ? { writeMode: options.writeMode } : {}) } }
        : { ok: false, reason: 'TENANT_MISMATCH' }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'Syn-App-SBX', clientSecret: 'syn-secret' }) },
      alerts: { raise: async (a) => { alerts.push(a); } },
      logger: { log: (e) => { logs.push(e); } },
      now: () => new Date(clock).toISOString(),
    },
    environment: 'SANDBOX', applicationCredentialsRef: 'cred:app', scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
    fetch: fetchFn, sleep: async (ms) => { clock += ms; }, timeoutMs: 1000,
    ...(options.ledger ? { editLedger: options.ledger } : {}),
    ...(options.requestBudget ? { requestBudget: options.requestBudget } : {}),
  });
  return { adapter, seen, logs, alerts, tokens, fetchFn, advance: (ms: number) => { clock += ms; } };
}

function write(id: string, value: FieldWrite['value'], identity: Record<string, string> = {}): FieldWrite {
  return {
    channelWriteId: id as never, version: 1, idempotencyKey: `${id}:1`, attemptNo: 1,
    writeScope: { writeScopeId: `ws-${id}-${value.field}` as never, field: value.field === 'QUANTITY' ? 'QUANTITY' : 'PRICE', scopeKey: `k-${id}`,
      identity: { marketplace: 'EBAY_DE', externalSku: `SYN-${id}`, externalOfferId: `9${id.replace(/\D/g, '').padStart(9, '0')}`, externalListingId: `11${id.replace(/\D/g, '').padStart(10, '0')}`, ...identity } },
    value,
  };
}
const eur = (amountMinor: number) => ({ field: 'PRICE' as const, price: { amountMinor, currency: 'EUR', basis: 'GROSS' as const } });
const batchOf = (items: FieldWrite[]) => ({ batchId: 'b', operation: 'bulkUpdatePriceQuantity', items, budgetCharges: budgetChargesOf(items), requestCount: 1 });

test('money: exactly two decimals from minor units — the sandbox rounded three decimals up silently (EBAY_C03)', () => {
  assert.equal(formatMinor(1199), '11.99');
  assert.equal(formatMinor(5), '0.05');
  assert.equal(formatMinor(1200), '12.00');
  assert.equal(formatMinor(100000001), '1000000.01');
  const body = JSON.stringify(bulkUpdateBody([write('1', eur(1199))]));
  assert.ok(body.includes('"value":"11.99"') && body.includes('"currency":"EUR"'), body);
  assert.equal(decimalToMinor('12.0'), 1200, 'the sandbox answers 12.0');
  assert.equal(decimalToMinor('11.999'), null, 'a sub-cent value is not read as a price');
});

test('currency ≠ storefront currency is refused locally, before any eBay call (the sandbox stored USD on EBAY_DE)', async () => {
  const w = world(() => ({ status: 500 }));
  const usd = write('2', { field: 'PRICE', price: { amountMinor: 1049, currency: 'USD', basis: 'GROSS' } });
  const plan = await w.adapter.planDispatch(ctx, [usd]);
  assert.equal(plan.batches.length, 0);
  assert.equal(plan.rejected[0]!.error.code, 'VALIDATION');
  assert.match(plan.rejected[0]!.error.message, /currency USD is not the currency EUR of EBAY_DE/);
  const sent = await w.adapter.dispatch(ctx, batchOf([usd]));
  assert.equal(sent.outcomes[0]!.status, 'REJECTED');
  assert.equal(sent.attemptsMade, 0);
  assert.equal(w.seen.length, 0, 'no request reached eBay');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C03_LOCAL_CURRENCY_AND_SCALE' && l.question === 'E-12'));
});

test('Р-164: a write without the eBay offerId (listing not under Inventory API) is refused before any call, with a log code', async () => {
  const w = world(() => ({ status: 500 }));
  const legacy = write('3', eur(1399), { externalOfferId: '' });
  const plan = await w.adapter.planDispatch(ctx, [legacy]);
  assert.equal(plan.rejected[0]!.error.code, 'PRECONDITION_FAILED');
  assert.match(plan.rejected[0]!.error.message, /not under Inventory API/);
  const sent = await w.adapter.dispatch(ctx, batchOf([legacy]));
  assert.equal(sent.outcomes[0]!.status, 'REJECTED');
  assert.equal(w.seen.length, 0, 'neither a migration nor a write by SKU was attempted');
  assert.equal(w.logs.filter((l) => l.code === NOT_MIGRATED_LOG_CODE).length, 2);
});

test('207 partial: the accepted offer waits for read-back, the unknown offer is NOT_FOUND 25604', async () => {
  const a = write('4', eur(1129));
  const b = write('5', eur(1129));
  const w = world((r) => {
    assert.equal(r.url.pathname, '/sell/inventory/v1/bulk_update_price_quantity');
    assert.equal(r.headers.authorization, 'Bearer syn-user-token');
    return { status: 207, body: { responses: [
      { statusCode: 200, sku: 'SYN-4', offerId: a.writeScope.identity.externalOfferId },
      { statusCode: 400, offerId: b.writeScope.identity.externalOfferId, errors: [{ errorId: 25604, message: 'Input error. Offer not found.' }] },
    ] } };
  });
  const r = await w.adapter.dispatch(ctx, batchOf([a, b]));
  assert.deepEqual(r.outcomes.map((o) => o.status), ['ACCEPTED', 'REJECTED']);
  assert.equal(r.outcomes[0]!.status === 'ACCEPTED' && r.outcomes[0]!.appliedImmediately, false);
  const rejected = r.outcomes[1]!;
  assert.ok(rejected.status === 'REJECTED' && rejected.error.code === 'NOT_FOUND' && rejected.error.channelCode === '25604');
});

test('quantity 0 answered 25004 is OUTCOME_UNKNOWN (the sandbox applied it), never a plain refusal (EBAY_C04)', async () => {
  const w = world(() => ({ status: 400, body: { responses: [{ statusCode: 400, offerId: '9000000006', errors: [{ errorId: 25004, message: 'The quantity must be a valid number greater than 0.' }] }] } }));
  const r = await w.adapter.dispatch(ctx, batchOf([write('6', { field: 'QUANTITY', quantity: 0 })]));
  const o = r.outcomes[0]!;
  assert.equal(o.status, 'OUTCOME_UNKNOWN');
  assert.ok(o.status === 'OUTCOME_UNKNOWN' && o.error.channelCode === '25004');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN' && l.question === 'E-06'));
  assert.ok(JSON.parse(w.seen[0]!.body).requests[0].offers[0].availableQuantity === 0, 'quantity goes to the offer (listing level)');
});

test('request-level 400 without responses[] refuses every item of the call: 25712 (more than 25) and 25709 (invalid value)', async () => {
  for (const errorId of [25712, 25709]) {
    const w = world(() => ({ status: 400, body: { errors: [{ errorId, message: errorId === 25712 ? 'Invalid request size. The maximum size allowed is 25.' : 'Invalid value for Offers.price.value.' }] } }));
    const r = await w.adapter.dispatch(ctx, batchOf([write('7', eur(1110)), write('8', eur(1111))]));
    for (const o of r.outcomes) assert.ok(o.status === 'REJECTED' && o.error.code === 'VALIDATION' && o.error.scope === 'BATCH' && o.error.channelCode === String(errorId), JSON.stringify(o));
  }
});

test('connection closed mid-request: OUTCOME_UNKNOWN, no transport retry of the write (EBAY_C02)', async () => {
  const w = world(() => 'NETWORK_ERROR');
  const r = await w.adapter.dispatch(ctx, batchOf([write('9', eur(1200))]));
  assert.equal(r.outcomes[0]!.status, 'OUTCOME_UNKNOWN');
  assert.equal(w.seen.length, 1, 'the write was sent exactly once');
});

test('Р-163: budget charges per attempt keyed by listing; price and quantity of one offer go in separate calls; 26 writes split 25 + 1', async () => {
  const w = world(() => ({ status: 200 }));
  const price = write('10', eur(1500));
  const qty = write('10', { field: 'QUANTITY', quantity: 4 });
  const plan = await w.adapter.planDispatch(ctx, [price, qty]);
  assert.equal(plan.batches.length, 2, 'one offer per call');
  const charges = plan.batches.flatMap((b) => b.budgetCharges);
  assert.deepEqual(charges.map((c) => [c.budgetScopeKey, c.field, c.attempts]).sort(), [['110000000010', 'PRICE', 1], ['110000000010', 'QUANTITY', 1]]);
  const many = Array.from({ length: 26 }, (_, i) => write(String(100 + i), eur(1000 + i)));
  const split = await w.adapter.planDispatch(ctx, many);
  assert.deepEqual(split.batches.map((b) => b.items.length).sort((x, y) => y - x), [25, 1]);
  assert.ok(split.batches.every((b) => b.requestCount === 1 && b.budgetCharges.every((c) => c.attempts === 1)));
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C09_BATCH_MAX_25'));
});

test('EBAY_C08: price gets 190 of 250 attempts in any 24 hours (as edit_budget 0008), the listing quantity keeps the reserve', async () => {
  const ledger = new RollingDayLedger();
  assert.equal(ledger.priceLimit, 190, 'limit 250 − quantity reserve 50 − unaccounted margin 10, from the descriptor editBudget');
  const price = write('11', eur(1500));
  const qty = write('11', { field: 'QUANTITY', quantity: 2 });
  const key = `ebay:${ACCOUNT}|${price.writeScope.identity.externalListingId}`;
  ledger.preload(key, 189, Date.parse(NOW) - 3600_000, 'PRICE');
  const w = world((r) => {
    const offers = JSON.parse(r.body).requests[0].offers[0];
    if (offers.price) return { status: 400, body: { responses: [{ statusCode: 400, offerId: offers.offerId, errors: [{ errorId: 25016, message: 'below the minimum price of EUR 1.00', parameters: [{ name: 'MinValue', value: 'EUR 1.00' }] }] }] } };
    return { status: 200, body: { responses: [{ statusCode: 200, offerId: offers.offerId }] } };
  }, { ledger });
  const p190 = await w.adapter.dispatch(ctx, batchOf([price]));
  const refused = p190.outcomes[0]!;
  assert.ok(refused.status === 'REJECTED' && refused.error.channelCode === '25016' && /MinValue EUR 1.00/.test(refused.error.message), 'the 190th price attempt was sent; a failed attempt still counts');
  const p191 = await w.adapter.dispatch(ctx, batchOf([price]));
  const o = p191.outcomes[0]!;
  assert.ok(o.status === 'REJECTED' && o.error.code === 'EDIT_BUDGET_EXHAUSTED' && /price edits .* \(190 of 190\)/.test(o.error.message), JSON.stringify(o));
  assert.equal(o.status === 'REJECTED' && o.error.retryAt, new Date(Date.parse(NOW) - 3600_000 + 24 * 3600_000).toISOString());
  assert.equal(p191.attemptsMade, 0);
  const q = await w.adapter.dispatch(ctx, batchOf([qty]));
  assert.equal(q.outcomes[0]!.status, 'ACCEPTED', 'a stock write after 190 price edits still goes: the reserve is not eaten by the price');
  assert.equal(w.seen.length, 2, 'the 191st price attempt did not reach eBay');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C08_EDIT_BUDGET_ROLLING_DAY' && l.question === 'E-02' && l.details?.limit === 190));
  // Весь лимит 250 исчерпан (190 цен + 60 остатков) — отказывает и остаток
  const full = new RollingDayLedger();
  full.preload('L', 190, Date.parse(NOW), 'PRICE');
  full.preload('L', 60, Date.parse(NOW), 'QUANTITY');
  const last = full.tryCharge({ listingKey: 'L', field: 'QUANTITY', attempts: 1 }, Date.parse(NOW));
  assert.ok(!last.ok && last.limit === 250 && last.used === 250);
});

test('Р-186: read-back value is the LIVE seller price from Browse (GET offer is only our record), buyerPrice apart, no effectivePrice; a difference that is not the VAT raises C10', async () => {
  const w0 = write('12', eur(1499));
  const w = world((r) => {
    if (r.url.pathname.startsWith('/sell/inventory/v1/offer/')) {
      assert.equal(r.headers.authorization, 'Bearer syn-user-token');
      return { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, sku: 'SYN-12', marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', availableQuantity: 4,
        pricingSummary: { price: { value: '14.99', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } };
    }
    assert.equal(r.url.pathname, `/buy/browse/v1/item/v1|${w0.writeScope.identity.externalListingId}|0`);
    assert.equal(r.url.searchParams.get('fieldgroups'), 'COMPACT');
    assert.equal(r.headers['x-ebay-c-marketplace-id'], 'EBAY_DE');
    assert.equal(r.headers.authorization, 'Bearer syn-app-token');
    return { status: 200, body: { price: { value: '13.99', currency: 'EUR' }, sellerItemRevision: '2' } };
  });
  const r = await w.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  assert.deepEqual(r.failures, []);
  const obs = r.observations[0]!;
  assert.ok(obs.value.field === 'PRICE' && obs.value.price.amountMinor === 1399, 'the live price: another tool edited the listing, the offer still says 14.99');
  assert.equal(obs.buyerPrice?.amountMinor, 1399, 'the buyer price of the live listing');
  assert.equal(obs.effectivePrice, undefined, 'Р-186: the eBay buyer price never goes to the Р-116 check');
  assert.deepEqual(w.alerts.map((a) => a.code), ['EBAY_OFFER_LISTING_DIVERGENCE']);
  const confirm = await w.adapter.confirm(ctx, [{ channelWriteId: w0.channelWriteId, writeScope: w0.writeScope, expected: eur(1499), dispatchedAt: NOW }]);
  assert.equal(confirm[0]!.status, 'PENDING', 'our 14.99 is not live: the listing shows what the other tool set');
});

test('E-17: Browse = seller price × 1.19 with taxes VAT includedInPrice — buyerPrice carries it, effectivePrice stays empty, no C10 alert, EBAY_C14 logged', async () => {
  const w0 = write('13', eur(1349));
  const w = world((r) => (r.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', availableQuantity: 4, pricingSummary: { price: { value: '13.49', currency: 'EUR' } },
      listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.05', currency: 'EUR' }, taxes: [{ taxType: 'VAT', taxPercentage: '19.0', includedInPrice: true, ebayCollectAndRemitTax: true }] } }));
  const r = await w.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  const obs = r.observations[0]!;
  assert.ok(obs.value.field === 'PRICE' && obs.value.price.amountMinor === 1349 && obs.buyerPrice?.amountMinor === 1605 && obs.effectivePrice === undefined);
  assert.deepEqual(w.alerts.map((a) => a.code), ['EBAY_BUYER_PRICE_VAT_ON_TOP'], 'the VAT on top is not another tool editing the listing — but the seller is told buyers pay more');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C14_BROWSE_PRICE_WITH_VAT' && l.question === 'E-17' && l.details?.vatBasisPoints === 1900));
  // Без taxes та же разница — уже C10
  const w2 = world((q) => (q.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', pricingSummary: { price: { value: '13.49', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.05', currency: 'EUR' } } }));
  await w2.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  assert.deepEqual(w2.alerts.map((a) => a.code), ['EBAY_OFFER_LISTING_DIVERGENCE']);
  // Другой инструмент поставил 14.00, eBay добавляет НДС сверху: Browse 16.66 — живая цена продавца без НДС, 14.00
  const w3 = world((q) => (q.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', pricingSummary: { price: { value: '13.49', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.66', currency: 'EUR' }, taxes: [{ taxType: 'VAT', taxPercentage: '19.0', includedInPrice: true }] } }));
  const r3 = await w3.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  const o3 = r3.observations[0]!;
  assert.ok(o3.value.field === 'PRICE' && o3.value.price.amountMinor === 1400 && o3.buyerPrice?.amountMinor === 1666, JSON.stringify(o3));
  assert.deepEqual(w3.alerts.map((a) => a.code), ['EBAY_OFFER_LISTING_DIVERGENCE']);
});

test('EBAY_C13: quantity read-back is our offer record, compared with the Browse estimate of an active listing; a mismatch is logged', async () => {
  const w0 = write('14', { field: 'QUANTITY', quantity: 5 });
  const w = world((r) => (r.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', availableQuantity: 5, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '10.00', currency: 'EUR' }, estimatedAvailabilities: [{ estimatedAvailableQuantity: 4 }] } }));
  const r = await w.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['QUANTITY'] }]);
  assert.ok(r.observations[0]!.value.field === 'QUANTITY' && r.observations[0]!.value.quantity === 5);
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C13_QUANTITY_READBACK_OFFER_RECORD' && l.question === 'E-13' && l.details?.mismatch === true && l.details?.estimatedAvailableQuantity === 4));
});

test('QUANTITY write scope is per storefront: a quantity write without the marketplace is refused (one offer per storefront, Р-6)', async () => {
  const w = world(() => ({ status: 500 }));
  const qty = write('15', { field: 'QUANTITY', quantity: 1 });
  delete (qty.writeScope.identity as { marketplace?: string }).marketplace;
  const plan = await w.adapter.planDispatch(ctx, [qty]);
  assert.ok(plan.rejected[0]!.error.code === 'VALIDATION' && /marketplace \(none\)/.test(plan.rejected[0]!.error.message));
});

test('a body cut mid-read is a transport failure: the write is OUTCOME_UNKNOWN, not an exception', async () => {
  const w = world(() => 'BODY_BREAKS');
  const r = await w.adapter.dispatch(ctx, batchOf([write('16', eur(1200))]));
  const o = r.outcomes[0]!;
  assert.ok(o.status === 'OUTCOME_UNKNOWN' && o.error.code === 'NETWORK', JSON.stringify(o));
  assert.equal(w.seen.length, 1, 'no retry of the write');
});

test('ebayAdapterFactory: adapters of one factory share the token cache and the edit budget', async () => {
  const base = world(() => ({ status: 200, body: { responses: [] } }));
  const make = ebayAdapterFactory({ environment: 'SANDBOX', applicationCredentialsRef: 'cred:app', scopes: ['s'], fetch: base.fetchFn, timeoutMs: 1000 });
  const deps = {
    accounts: { verify: async () => ({ ok: true as const, account: { tenantId: TENANT, channelAccountId: ACCOUNT, channel: 'EBAY' as const, externalAccountId: 's', marketplaces: ['EBAY_DE'], credentialsRef: 'cred:seller' } }) },
    credentials: { get: async (ref: string): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'Syn-App-SBX', clientSecret: 'syn-secret' }) },
    alerts: { raise: async () => {} }, logger: { log: () => {} }, now: () => NOW,
  };
  const a = make(deps);
  const b = make(deps);
  await a.dispatch(ctx, batchOf([write('17', eur(1200))]));
  await b.dispatch(ctx, batchOf([write('18', eur(1200))]));
  assert.equal(base.tokens.n, 1, 'the second adapter reused the user token of the first');
});

const getItemXml = (listingType: string, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><ItemID>110000000020</ItemID><ListingDesigner><LayoutID>7710000</LayoutID><ThemeID>7710</ThemeID></ListingDesigner><ListingType>${listingType}</ListingType><Seller><Email>syn-seller@example.invalid</Email></Seller><SKU>SYN-LEGACY</SKU><SellerProfiles><SellerShippingProfile><ShippingProfileID>6200000001</ShippingProfileID></SellerShippingProfile></SellerProfiles>${extra}</Item></GetItemResponse>`;
const prefsXml = '<?xml version="1.0" encoding="UTF-8"?><GetUserPreferencesResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><OutOfStockControlPreference>false</OutOfStockControlPreference></GetUserPreferencesResponse>';

function tradingWorld(listingType: string, extra: string, after: (r: Seen) => Reply) {
  return world((r) => {
    if (r.url.pathname === '/ws/api.dll') {
      assert.equal(r.headers['x-ebay-api-iaf-token'], 'syn-user-token');
      assert.equal(r.headers['x-ebay-api-siteid'], '77');
      assert.equal(r.headers['x-ebay-api-compatibility-level'], '1349');
      return { status: 200, xml: r.headers['x-ebay-api-call-name'] === 'GetUserPreferences' ? prefsXml : getItemXml(listingType, extra) };
    }
    return after(r);
  });
}

test('preflight: an auction is INELIGIBLE; seller e-mail from GetItem does not reach the result or the log', async () => {
  const w = tradingWorld('Chinese', '', () => ({ status: 500 }));
  const [p] = await w.adapter.preflight(ctx, ['110000000020']);
  assert.equal(p!.verdict, 'INELIGIBLE');
  assert.ok(p!.findings.some((f) => f.code === 'C01_AUCTION' && f.severity === 'BLOCKER'));
  assert.ok(!w.seen.some((r) => r.url.pathname.startsWith('/sell/')), 'an auction is not looked up in Inventory API');
  assert.ok(!JSON.stringify([p, w.logs, w.alerts]).includes('syn-seller@example.invalid'));
});

test('preflight: fixed price with Best Offer — READY_WITH_LOSSES; template INFO, other tools WARNING, out-of-stock control off WARNING', async () => {
  const w = tradingWorld('FixedPriceItem', '<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>',
    () => ({ status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } }));
  const [p] = await w.adapter.preflight(ctx, ['110000000020']);
  assert.equal(p!.verdict, 'READY_WITH_LOSSES');
  assert.deepEqual(p!.findings.map((f) => `${f.code}:${f.severity}`).sort(),
    ['C03_BEST_OFFER:LOSS', 'C06_TEMPLATE:INFO', 'C10_OTHER_TOOLS:WARNING', 'C11_OUT_OF_STOCK_CONTROL:WARNING']);
  assert.match(p!.listingSnapshotSha256, /^[0-9a-f]{64}$/);
});

test('migrate: only with a consent proof (type), the snapshot is re-checked; changed listing FAILED without bulk_migrate_listing', async () => {
  const w = tradingWorld('FixedPriceItem', '', (r) => {
    if (r.url.pathname === '/sell/inventory/v1/offer') return { status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } };
    assert.equal(r.url.pathname, '/sell/inventory/v1/bulk_migrate_listing');
    assert.deepEqual(JSON.parse(r.body), { requests: [{ listingId: '110000000020' }] });
    return { status: 200, body: { responses: [{ statusCode: 200, listingId: '110000000020', marketplaceId: 'EBAY_DE', inventoryItems: [{ sku: 'SYN-LEGACY', offerId: '9000000020' }] }] } };
  });
  if (false as boolean) {
    // Р-164: без доказательства согласия метод не вызвать — проверяет tsc
    // @ts-expect-error — listing ids are not MigrationConsentProof
    await w.adapter.migrate(ctx, ['110000000020']);
  }
  const [pf] = await w.adapter.preflight(ctx, ['110000000020']);
  assert.equal(pf!.verdict, 'READY');
  w.advance(10_000); // клиентский бюджет запросов [EBAY_C01] восполняется
  const proof: MigrationConsentProof = { migrationConsentId: 'mc-1', listingId: '110000000020', listingSnapshotSha256: pf!.listingSnapshotSha256, offerMappingStatus: 'MIGRATION_STARTED' };
  const [ok] = await w.adapter.migrate(ctx, [proof]);
  assert.deepEqual(ok, { listingId: '110000000020', status: 'MIGRATED', externalOfferIds: ['9000000020'] });
  w.advance(10_000);
  const before = w.seen.filter((r) => r.url.pathname.endsWith('bulk_migrate_listing')).length;
  const [stale] = await w.adapter.migrate(ctx, [{ ...proof, listingSnapshotSha256: 'f'.repeat(64) }]);
  assert.ok(stale!.status === 'FAILED' && stale!.error.code === 'PRECONDITION_FAILED' && /changed since the owner consented/.test(stale!.error.message));
  assert.equal(w.seen.filter((r) => r.url.pathname.endsWith('bulk_migrate_listing')).length, before, 'no migration call for a changed listing');
  const six = Array.from({ length: 6 }, (_, i) => ({ ...proof, migrationConsentId: `mc-${i}`, listingId: `11000000002${i}` }));
  assert.ok((await w.adapter.migrate(ctx, six)).every((o) => o.status === 'FAILED' && o.error.code === 'VALIDATION'), 'more than 5 listings per call refused');
});

test('snapshot hash covers the facts of the verdict', () => {
  const parsed = parseGetItem(getItemXml('FixedPriceItem'));
  assert.ok(parsed.ok);
  const a = snapshotSha256({ ...parsed.facts, outOfStockControl: false });
  assert.notEqual(a, snapshotSha256({ ...parsed.facts, bestOfferEnabled: true, outOfStockControl: false }));
  assert.notEqual(a, snapshotSha256({ ...parsed.facts, outOfStockControl: true }));
});

test('EBAY_C15: a listing with variations — C12 is a WARNING: the price of a variation cannot be confirmed on the live listing', async () => {
  const w = tradingWorld('FixedPriceItem', '<Variations><Variation><SKU>SYN-V1</SKU></Variation><Variation><SKU>SYN-V2</SKU></Variation></Variations>',
    () => ({ status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } }));
  const [p] = await w.adapter.preflight(ctx, ['110000000020']);
  const f = p!.findings.find((x) => x.code === 'C12_VARIATIONS');
  assert.ok(f && f.severity === 'WARNING' && /cannot be confirmed on the live listing/.test(f.details), JSON.stringify(p));
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C15_VARIATIONS_PRICE_CONFIRMATION' && l.question === 'E-13'));
});

test('migrate: two proofs for one listing — the second is refused by its own position, the first is not overwritten', async () => {
  const w = tradingWorld('FixedPriceItem', '', (r) => (r.url.pathname === '/sell/inventory/v1/offer'
    ? { status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } }
    : { status: 200, body: { responses: [{ statusCode: 200, listingId: '110000000020', inventoryItems: [{ sku: 'SYN-LEGACY', offerId: '9000000020' }] }] } }));
  const [pf] = await w.adapter.preflight(ctx, ['110000000020']);
  w.advance(10_000);
  const proof: MigrationConsentProof = { migrationConsentId: 'mc-a', listingId: '110000000020', listingSnapshotSha256: pf!.listingSnapshotSha256, offerMappingStatus: 'MIGRATION_STARTED' };
  const out = await w.adapter.migrate(ctx, [proof, { ...proof }]);
  assert.equal(out[0]!.status, 'MIGRATED');
  assert.ok(out[1]!.status === 'FAILED' && out[1]!.error.code === 'PRECONDITION_FAILED' && /one consent proof per listing/.test(out[1]!.error.message));
});

// ------------------------------------------------------------------------------------------------ шаг 47

test('review 39 #14: a write repeated after 401 (token refresh) is a second attempt — charged to the rolling ledger and reported in attemptsMade', async () => {
  const w0 = write('31', eur(1290));
  const listingKey = `ebay:${ACCOUNT}|${w0.writeScope.identity.externalListingId}`;
  const run = async (firstAnswer401: boolean) => {
    const ledger = new RollingDayLedger();
    ledger.preload(listingKey, 188, Date.parse(NOW) - 3600_000, 'PRICE');
    let bulk = 0;
    const w = world(() => {
      bulk += 1;
      return firstAnswer401 && bulk === 1 ? { status: 401, body: { errors: [{ errorId: 1001, message: 'Invalid access token' }] } }
        : { status: 200, body: { responses: [{ statusCode: 200, offerId: w0.writeScope.identity.externalOfferId }] } };
    }, { ledger });
    const sent = await w.adapter.dispatch(ctx, batchOf([w0]));
    assert.equal(sent.outcomes[0]!.status, 'ACCEPTED');
    const next = await w.adapter.dispatch(ctx, batchOf([{ ...w0, attemptNo: 2 }]));
    return { attemptsMade: sent.attemptsMade, next: next.outcomes[0]! };
  };
  const retried = await run(true);
  assert.equal(retried.attemptsMade, 2, 'two HTTP attempts of the same write');
  assert.ok(retried.next.status === 'REJECTED' && retried.next.error.code === 'EDIT_BUDGET_EXHAUSTED' && /\(190 of 190\)/.test(retried.next.error.message),
    `188 earlier + 2 attempts of the 401 retry = 190: the next price is refused (${JSON.stringify(retried.next)})`);
  // Контроль: без 401 та же пара записей укладывается — отказ выше вызван именно второй попыткой
  const plain = await run(false);
  assert.equal(plain.attemptsMade, 1);
  assert.equal(plain.next.status, 'ACCEPTED');
});

const GMS = (items: string, pages = 1) => `<?xml version="1.0" encoding="UTF-8"?>\n<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack>`
  + `<ActiveList><ItemArray>${items}</ItemArray><PaginationResult><TotalNumberOfPages>${pages}</TotalNumberOfPages><TotalNumberOfEntries>3</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>`;
const gmsItem = (id: string, type: string, sku: string | null, price: string, currency = 'EUR') =>
  `<Item><ItemID>${id}</ItemID>${sku ? `<SKU>${sku}</SKU>` : ''}<ListingType>${type}</ListingType><Quantity>4</Quantity><QuantityAvailable>3</QuantityAvailable>`
  + `<SellingStatus><CurrentPrice currencyID="${currency}">${price}</CurrentPrice></SellingStatus></Item>`;

test('discovery: Inventory API phase (writable), then GetMyeBaySelling per storefront — legacy fixed price not writable, auction AUCTION, managed listing not repeated (EBAY_C16)', async () => {
  const w = world((r) => {
    if (r.url.pathname === '/sell/inventory/v1/inventory_item') return { status: 200, body: { total: 1, inventoryItems: [{ sku: 'SYN-M', condition: 'NEW' }] } };
    if (r.url.pathname === '/sell/inventory/v1/offer') {
      return r.url.searchParams.get('sku') === 'SYN-M'
        ? { status: 200, body: { offers: [{ offerId: '9100000001', sku: 'SYN-M', marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', availableQuantity: 2, pricingSummary: { price: { value: '12.00', currency: 'EUR' } }, listing: { listingId: '110000000001', listingStatus: 'ACTIVE' } }] } }
        : { status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } };
    }
    assert.equal(r.url.pathname, '/ws/api.dll');
    assert.equal(r.headers['x-ebay-api-call-name'], 'GetMyeBaySelling');
    assert.match(r.body, /<EntriesPerPage>10<\/EntriesPerPage><PageNumber>1<\/PageNumber>/);
    return { status: 200, xml: GMS(gmsItem('110000000001', 'FixedPriceItem', 'SYN-M', '12.00') + gmsItem('110000000002', 'FixedPriceItem', 'SYN-L', '14.99') + gmsItem('110000000003', 'Chinese', 'SYN-A', '5.00')) };
  });
  const p1 = await w.adapter.discoverOffers(ctx, { limit: 10 });
  assert.deepEqual(p1.items.map((i) => [i.identity.externalListingId, i.listing]), [['110000000001', { format: 'FIXED_PRICE', writable: true }]]);
  assert.equal(p1.nextCursor, 'trd:0:1~110000000001', 'the Inventory phase is over: the Trading phase starts at the first storefront and carries the listings already given');
  const offerCalls = () => w.seen.filter((x) => x.url.pathname === '/sell/inventory/v1/offer').length;
  const offersAfterInventory = offerCalls();
  w.advance(5000);
  const de = await w.adapter.discoverOffers(ctx, { limit: 10, cursor: p1.nextCursor! });
  assert.equal(w.seen.find((s) => s.url.pathname === '/ws/api.dll')!.headers['x-ebay-api-siteid'], '77', 'EBAY_DE is site 77');
  assert.deepEqual(de.items.map((i) => ({ id: i.identity.externalListingId, sku: i.identity.externalSku, mk: i.identity.marketplace, offer: i.identity.externalOfferId, listing: i.listing, price: i.currentPrice?.amountMinor })), [
    { id: '110000000002', sku: 'SYN-L', mk: 'EBAY_DE', offer: undefined, listing: { format: 'FIXED_PRICE', writable: false }, price: 1499 },
    { id: '110000000003', sku: 'SYN-A', mk: 'EBAY_DE', offer: undefined, listing: { format: 'AUCTION', writable: false }, price: undefined },
  ], 'the managed listing 110000000001 is not repeated; the auction carries no price');
  assert.equal(de.nextCursor, 'trd:1:1~110000000001', 'then the second storefront of the account');
  assert.equal(offerCalls(), offersAfterInventory, 'review 47 #7: the Trading phase excludes the carried listings without offer?sku= per item');
  w.advance(5000);
  const us = await w.adapter.discoverOffers(ctx, { limit: 10, cursor: de.nextCursor! });
  assert.deepEqual(us.items, [], 'EUR listings are not attributed to EBAY_US');
  assert.equal(us.nextCursor, undefined);
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C16_TRADING_LISTING_SITE' && l.question === 'E-19' && l.details?.skippedSite === 3));
  // Курсор без набора (старый или переполненный `~*`) — прежняя проверка offer?sku= для каждого предмета с SKU
  w.advance(5000);
  const before = offerCalls();
  const fallback = await w.adapter.discoverOffers(ctx, { limit: 10, cursor: 'trd:0:1~*' });
  assert.deepEqual(fallback.items.map((i) => i.identity.externalListingId), ['110000000002', '110000000003'], 'the managed listing is still excluded — by the offer check');
  assert.equal(offerCalls() - before, 3, 'without a carried set every item with a SKU is checked');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C16_TRADING_LISTING_SITE' && l.details?.checkedBySku === 3));
});

test('review 47 #7, #3: the carried set is bounded; an unknown ListingType is counted, a listing without SKU is emitted with its listing id only', async () => {
  const many = Array.from({ length: 501 }, (_, i) => `1200000${String(i).padStart(5, '0')}`);
  const w = world((r) => {
    if (r.url.pathname === '/sell/inventory/v1/inventory_item') {
      const offset = Number(r.url.searchParams.get('offset'));
      return { status: 200, body: { total: 501, inventoryItems: many.slice(offset, offset + 100).map((id) => ({ sku: `S-${id}` })) } };
    }
    if (r.url.pathname === '/sell/inventory/v1/offer') {
      const id = r.url.searchParams.get('sku')!.slice(2);
      return { status: 200, body: { offers: [{ offerId: '9100000001', sku: `S-${id}`, marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', pricingSummary: { price: { value: '12.00', currency: 'EUR' } }, listing: { listingId: id, listingStatus: 'ACTIVE' } }] } };
    }
    return { status: 200, xml: GMS(gmsItem('110000000077', 'FixedPriceItem', null, '9.99') + gmsItem('110000000078', 'AdType', 'SYN-AD', '1.00')) };
  }, { ledger: new RollingDayLedger(), requestBudget: new TokenBucket({ ratePerSecond: 1000, burst: 1000 }) });
  let cursor: string | undefined;
  for (let i = 0; i < 6; i++) {
    w.advance(1000);
    const page = await w.adapter.discoverOffers(ctx, { limit: 100, ...(cursor ? { cursor } : {}) });
    cursor = page.nextCursor;
    if (cursor?.startsWith('trd:')) break;
  }
  assert.equal(cursor, 'trd:0:1~*', 'more than 500 carried listings — the cursor stops carrying them');
  w.advance(1000);
  const trading = await w.adapter.discoverOffers(ctx, { limit: 100, cursor: 'trd:0:1~' });
  assert.deepEqual(trading.items.map((i) => [i.identity, i.listing]), [[{ marketplace: 'EBAY_DE', externalListingId: '110000000077' }, { format: 'FIXED_PRICE', writable: false }]],
    'a legacy listing without SKU is emitted with its listing id only; the unknown AdType is not guessed');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C16_TRADING_LISTING_SITE' && l.details?.unknownType === 1));
});

test('E-20: order lines by whitelist only — buyer name, address and e-mail in the response never reach the OrderLine or the log; unknown fields skip the line', async () => {
  const BUYER = ['syn_buyer_4711', 'Synthetic Buyer Name', 'Musterweg 1', 'buyer-4711@example.invalid', '+49 30 0000000'];
  const order = (id: string, extra: Record<string, unknown>, lines: unknown[]) => ({
    orderId: id, creationDate: '2026-09-27T09:00:00.000Z', orderFulfillmentStatus: 'NOT_STARTED',
    buyer: { username: BUYER[0], buyerRegistrationAddress: { fullName: BUYER[1], email: BUYER[3] } },
    fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: BUYER[1], contactAddress: { addressLine1: BUYER[2] }, primaryPhone: { phoneNumber: BUYER[4] }, email: BUYER[3] } } }],
    lineItems: lines, ...extra,
  });
  const w = world((r) => {
    assert.equal(r.url.pathname, '/sell/fulfillment/v1/order');
    assert.equal(r.url.searchParams.get('filter'), 'lastmodifieddate:[2026-09-27T08:00:00.000Z..]', 'окно — по изменению заказа, не по созданию (находка 1)');
    return { status: 200, body: { total: 5, limit: 3, offset: 0, next: 'https://api.sandbox.ebay.com/sell/fulfillment/v1/order?offset=3', orders: [
      order('01-00001-00001', {}, [
        { lineItemId: '10000000001', sku: 'SYN-1', legacyItemId: '110000000001', quantity: 2, lineItemFulfillmentStatus: 'NOT_STARTED', listingMarketplaceId: 'EBAY_DE', title: BUYER[1] },
        { lineItemId: '10000000002', sku: 'SYN-2', legacyItemId: '110000000002', quantity: 1, lineItemFulfillmentStatus: 'FULFILLED', listingMarketplaceId: 'EBAY_DE' },
      ]),
      order('01-00001-00002', { cancelStatus: { cancelState: 'CANCELED' } }, [{ lineItemId: '10000000003', sku: 'SYN-3', quantity: 1, lineItemFulfillmentStatus: 'NOT_STARTED', listingMarketplaceId: 'EBAY_US' }]),
      order('01-00001-00003', {}, [
        { lineItemId: '10000000004', sku: 'SYN-4', quantity: 1, lineItemFulfillmentStatus: 'NOT_STARTED' },
        { lineItemId: '10000000005', sku: 'SYN-5', quantity: 1, lineItemFulfillmentStatus: 'SOMETHING_NEW', listingMarketplaceId: 'EBAY_DE' },
        { sku: 'SYN-6', quantity: 1, listingMarketplaceId: 'EBAY_DE' },
      ]),
    ] } };
  });
  const page = await w.adapter.readOrderLines(ctx, { since: '2026-09-27T08:00:00.000Z' as never, limit: 3 });
  assert.deepEqual(page.items, [
    { externalOrderRef: '01-00001-00001', externalOrderLineRef: '10000000001', quantity: 2, orderedAt: '2026-09-27T09:00:00.000Z', status: 'OPEN', identity: { marketplace: 'EBAY_DE', externalSku: 'SYN-1', externalListingId: '110000000001' } },
    { externalOrderRef: '01-00001-00001', externalOrderLineRef: '10000000002', quantity: 1, orderedAt: '2026-09-27T09:00:00.000Z', status: 'SHIPPED', identity: { marketplace: 'EBAY_DE', externalSku: 'SYN-2', externalListingId: '110000000002' } },
    { externalOrderRef: '01-00001-00002', externalOrderLineRef: '10000000003', quantity: 1, orderedAt: '2026-09-27T09:00:00.000Z', status: 'CANCELLED', identity: { marketplace: 'EBAY_US', externalSku: 'SYN-3' } },
  ]);
  assert.equal(page.nextCursor, '3');
  const log = w.logs.find((l) => l.code === 'EBAY_C17_ORDER_FIELDS_UNVERIFIED')!;
  assert.equal(log.question, 'E-20');
  // Две витрины у аккаунта, у строки её нет — не угадываем; непонятный статус и строка без lineItemId — пропуск с причиной
  assert.deepEqual(log.details, { lines: 3, skipped: 3, skipped_marketplace: 1, skipped_lineItemFulfillmentStatus: 1, skipped_lineItemId: 1 });
  const everywhere = JSON.stringify({ page, logs: w.logs, alerts: w.alerts });
  for (const pii of BUYER) assert.ok(!everywhere.includes(pii), `buyer data "${pii}" leaked`);
});

test('E-20: without the order scope eBay answers 403 — FORBIDDEN, not an empty page', async () => {
  const w = world(() => ({ status: 403, body: { errors: [{ errorId: 1100, message: 'Access denied' }] } }));
  await assert.rejects(w.adapter.readOrderLines(ctx, { since: NOW as never, limit: 10 }), (e: { error?: { code: string } }) => e.error?.code === 'FORBIDDEN');
});

test('review 47 #4: VAT on top in Browse raises EBAY_BUYER_PRICE_VAT_ON_TOP once per account per process, with the rate and the write mode', async () => {
  const w0 = write('13', eur(1349));
  const handler = (q: Seen): Reply => (q.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', pricingSummary: { price: { value: '13.49', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.05', currency: 'EUR' }, taxes: [{ taxType: 'VAT', taxPercentage: '19.0', includedInPrice: true }] } });
  const shadow = world(handler, { writeMode: 'SHADOW' });
  for (let i = 0; i < 3; i++) await shadow.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  const alerts = shadow.alerts as Array<{ code: string; severity?: string; details?: Record<string, unknown> }>;
  assert.equal(alerts.length, 1, 'one alert per account per process, not per read');
  assert.deepEqual([alerts[0]!.code, alerts[0]!.severity, alerts[0]!.details?.vatBasisPoints, alerts[0]!.details?.writeMode, alerts[0]!.details?.shadow],
    ['EBAY_BUYER_PRICE_VAT_ON_TOP', 'WARNING', 1900, 'SHADOW', true]);
  assert.match(String(alerts[0]!.details?.note), /в тени/);
  const live = world(handler, { writeMode: 'LIVE' });
  await live.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  assert.deepEqual((live.alerts as Array<{ details?: Record<string, unknown> }>).map((a) => [a.details?.writeMode, a.details?.shadow]), [['LIVE', false]], 'a new process (adapter) says it again');
  // Контроль: цена покупателя без НДС сверху — алерта нет
  const plain = world((q) => (q.url.pathname.startsWith('/sell/') ? handler(q) : { status: 200, body: { price: { value: '13.49', currency: 'EUR' } } }), { writeMode: 'LIVE' });
  await plain.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  assert.deepEqual(plain.alerts, []);
});
