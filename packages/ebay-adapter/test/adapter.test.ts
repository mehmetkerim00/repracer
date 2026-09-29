import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterLogEntry, ChannelAccountId, FieldWrite, MigrationConsentProof, TenantId } from '@repracer/channel-port';
import {
  bulkUpdateBody, budgetChargesOf, createEbayAdapter, ebayAdapterFactory, decimalToMinor, EBAY_MARKETPLACES, formatMinor, NOT_MIGRATED_LOG_CODE, parseGetItem, RollingDayLedger, snapshotSha256, TokenBucket,
} from '../src/index.ts';

/** Модульные проверки адаптера eBay (шаг 39). Данные синтетические; формы ответов — как у песочницы (docs/evidence/step39-ebay-sandbox.md) */

const TENANT = '10000000-0000-4000-8000-000000000001' as TenantId;
const ACCOUNT = '20000000-0000-4000-8000-000000000001' as ChannelAccountId;
const NOW = '2026-09-27T10:00:00.000Z';
const ctx: AdapterCallContext = { tenantId: TENANT, channelAccountId: ACCOUNT, correlationId: 'unit', deadline: '2026-09-27T10:05:00.000Z' };

interface Seen { method: string; url: URL; headers: Record<string, string>; body: string }
type Reply = { status: number; body?: unknown; xml?: string } | 'NETWORK_ERROR' | 'BODY_BREAKS';

function world(handler: (r: Seen) => Reply, options: { ledger?: RollingDayLedger; requestBudget?: TokenBucket; writeMode?: 'SHADOW' | 'LIVE'; batchMode?: () => 'PROBE' | 'MULTI' | 'SINGLE' | undefined; environment?: 'SANDBOX' | 'PRODUCTION'; marketplaces?: string[] } = {}) {
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
        ? { ok: true, account: { tenantId, channelAccountId, channel: 'EBAY', externalAccountId: 'syn-seller', marketplaces: options.marketplaces ?? ['EBAY_DE', 'EBAY_US'], credentialsRef: 'cred:seller', ...(options.writeMode ? { writeMode: options.writeMode } : {}), ...(options.batchMode?.() ? { ebayBatchMode: options.batchMode() } : {}) } }
        : { ok: false, reason: 'TENANT_MISMATCH' }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'Syn-App-SBX', clientSecret: 'syn-secret' }) },
      alerts: { raise: async (a) => { alerts.push(a); } },
      logger: { log: (e) => { logs.push(e); } },
      now: () => new Date(clock).toISOString(),
    },
    environment: options.environment ?? 'SANDBOX', applicationCredentialsRef: 'cred:app', scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
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

// `Site` и `Currency` — как у песочницы: GetItem с сайтом 77 отвечает Site=Germany, Currency=EUR (шаг 39); `site: null` — ответ без поля.
// Шаг 49 [Р-191]: платёжная политика (`SellerPaymentProfile/PaymentProfileID`, как в GetItem песочницы) и место листинга (`Location` или
// `PostalCode` — синтетические значения юнит-теста); `Seller/RegistrationAddress/PostalCode` — адрес продавца, а не место листинга
interface ItemParts { payment?: boolean; place?: 'Location' | 'PostalCode' | null; sellerPostalCode?: boolean }
const getItemXml = (listingType: string, extra = '', site: string | null = 'Germany', parts: ItemParts = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item><Currency>EUR</Currency><ItemID>110000000020</ItemID><ListingDesigner><LayoutID>7710000</LayoutID><ThemeID>7710</ThemeID></ListingDesigner><ListingType>${listingType}</ListingType>`
  + `${(parts.place ?? 'Location') === 'Location' && parts.place !== null ? '<Location>Syn-Stadt</Location>' : parts.place === 'PostalCode' ? '<PostalCode>99999</PostalCode>' : ''}`
  + `<Seller><Email>syn-seller@example.invalid</Email>${parts.sellerPostalCode ? '<RegistrationAddress><PostalCode>99998</PostalCode></RegistrationAddress>' : ''}</Seller>${site === null ? '' : `<Site>${site}</Site>`}<SKU>SYN-LEGACY</SKU>`
  + `<SellerProfiles><SellerShippingProfile><ShippingProfileID>6200000001</ShippingProfileID></SellerShippingProfile>${parts.payment === false ? '' : '<SellerPaymentProfile><PaymentProfileID>6200000002</PaymentProfileID></SellerPaymentProfile>'}</SellerProfiles>${extra}</Item></GetItemResponse>`;
const prefsXml = '<?xml version="1.0" encoding="UTF-8"?><GetUserPreferencesResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><OutOfStockControlPreference>false</OutOfStockControlPreference></GetUserPreferencesResponse>';
/** Account API getPaymentPolicy [док: sell_account_v1_oas3.json]; ответ синтетический — песочница этот вызов не делала */
const POLICY_OK: Reply = { status: 200, body: { paymentPolicyId: '6200000002', name: 'syn-payment', marketplaceId: 'EBAY_DE', immediatePay: true } };

function tradingWorld(listingType: string, extra: string, after: (r: Seen) => Reply, site: string | null = 'Germany', o: { parts?: ItemParts; policy?: Reply } = {}) {
  return world((r) => {
    if (r.url.pathname === '/ws/api.dll') {
      assert.equal(r.headers['x-ebay-api-iaf-token'], 'syn-user-token');
      assert.equal(r.headers['x-ebay-api-siteid'], '77');
      assert.equal(r.headers['x-ebay-api-compatibility-level'], '1477', 'step 53: the current Trading compatibility level');
      return { status: 200, xml: r.headers['x-ebay-api-call-name'] === 'GetUserPreferences' ? prefsXml : getItemXml(listingType, extra, site, o.parts) };
    }
    if (r.url.pathname.startsWith('/sell/account/v1/payment_policy/')) {
      assert.equal(r.url.pathname, '/sell/account/v1/payment_policy/6200000002');
      assert.equal(r.headers.authorization, 'Bearer syn-user-token', 'Account API — токеном пользователя (scope sell.account)');
      return o.policy ?? POLICY_OK;
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
  // Шаг 50 [песочница]: без Accept-Language живая песочница отвечает на GET inventory_item 400 25709 — язык первой витрины аккаунта
  assert.equal(w.seen.find((x) => x.url.pathname === '/sell/inventory/v1/inventory_item')!.headers['accept-language'], 'de-DE');
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

/**
 * Хвост шага 47 (E-19, находка 8 ревью): у предметов GetMyeBaySelling нет поля витрины, и фаза Trading относит листинг к
 * витрине ВЫЗОВА по валюте цены (EBAY_C16). Это верно, пока у каждой валюты одна витрина eBay. Ветку «две витрины одной
 * валюты» в адаптере проверить нечем — такой витрины нет, — поэтому свойство держит правило [Р-146]: витрина с уже занятой
 * валютой (например, EBAY_AT) не добавляется, пока E-19 не закрыт — точным путём был бы `GetItem` (в песочнице он отвечает
 * `Site`), но это вызов на каждый старый листинг из общего лимита приложения.
 */
const sharedCurrencies = (marketplaces: Record<string, { currency: string }>) => {
  const byCurrency = new Map<string, string[]>();
  for (const [code, m] of Object.entries(marketplaces)) byCurrency.set(m.currency, [...(byCurrency.get(m.currency) ?? []), code]);
  return [...byCurrency.entries()].filter(([, codes]) => codes.length > 1);
};
test('E-19: the currency names the eBay storefront of a Trading listing only while each currency has one storefront', () => {
  // Положительный контроль: вторая евровая витрина правило краснит — иначе оно зеленело бы и без свойства [Р-94]
  assert.deepEqual(sharedCurrencies({ ...EBAY_MARKETPLACES, EBAY_AT: { currency: 'EUR' } }), [['EUR', ['EBAY_DE', 'EBAY_AT']]]);
  const shared = sharedCurrencies(EBAY_MARKETPLACES);
  assert.deepEqual(shared, [], `two eBay storefronts share a currency — a Trading listing would land on both; resolve E-19 first: ${JSON.stringify(shared)}`);
});

/**
 * Шаг 48 (E-19, находка 3 ревью): обнаружение относит старый листинг к витрине аккаунта по валюте, а GetMyeBaySelling отдаёт
 * листинги ВСЕГО аккаунта. Евровый листинг ebay.at попадает в каталог как EBAY_DE — и перед миграцией витрину сверяет GetItem.
 */
test('E-19: a legacy listing on another eBay site is INELIGIBLE for this account before migration; an unnamed site is a WARNING', async () => {
  const notFound = () => ({ status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } });
  const foreign = tradingWorld('FixedPriceItem', '', notFound, 'Austria');
  const [p] = await foreign.adapter.preflight(ctx, ['110000000020']);
  assert.equal(p!.verdict, 'INELIGIBLE', 'чужой сайт продавец исправить не может');
  assert.ok(p!.findings.some((f) => f.code === 'C13_SITE' && f.severity === 'BLOCKER' && /site Austria/.test(f.details)), JSON.stringify(p!.findings));
  const unnamed = tradingWorld('FixedPriceItem', '', notFound, null);
  const [q] = await unnamed.adapter.preflight(ctx, ['110000000020']);
  assert.ok(q!.findings.some((f) => f.code === 'C13_SITE_UNCONFIRMED' && f.severity === 'WARNING'), JSON.stringify(q!.findings));
  assert.notEqual(q!.verdict, 'INELIGIBLE', 'неназванный сайт — предупреждение, а не отказ');
  assert.ok(unnamed.logs.some((l) => l.code === 'EBAY_C16_TRADING_LISTING_SITE' && l.details?.confirmed === false), 'консервативное правило записано в журнал');
  // Свой сайт — ни препятствия, ни предупреждения
  const own = tradingWorld('FixedPriceItem', '', notFound);
  const [r] = await own.adapter.preflight(ctx, ['110000000020']);
  assert.ok(!r!.findings.some((f) => f.code.startsWith('C13_')), JSON.stringify(r!.findings));
});

/**
 * Шаг 49 [Р-191]: условия bulkMigrateListing из снимка документации — немедленная оплата платёжной политики и индекс или город листинга.
 * У каждого требования три исхода: выполнено — препятствия нет; не выполнено — BLOCKER и FIXABLE; прочитать не удалось — PREFLIGHT_INCOMPLETE и
 * UNKNOWN (не угадываем).
 */
test('Р-191: immediate payment of the payment policy — on: no blocker; off: C14 BLOCKER, FIXABLE; unread or not stated: UNKNOWN', async () => {
  const notFound = () => ({ status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } }) as Reply;
  const codes = (p: { findings: Array<{ code: string; severity: string }> }) => p.findings.map((f) => `${f.code}:${f.severity}`);
  const on = tradingWorld('FixedPriceItem', '', notFound);
  const [a] = await on.adapter.preflight(ctx, ['110000000020']);
  assert.equal(a!.verdict, 'READY', JSON.stringify(a));
  assert.ok(!codes(a!).some((c) => c.startsWith('C14_')));
  assert.equal(on.seen.filter((r) => r.url.pathname.startsWith('/sell/account/')).length, 1, 'the policy is read once');

  const off = tradingWorld('FixedPriceItem', '', notFound, 'Germany', { policy: { status: 200, body: { paymentPolicyId: '6200000002', immediatePay: false } } });
  const [b] = await off.adapter.preflight(ctx, ['110000000020']);
  assert.equal(b!.verdict, 'FIXABLE');
  assert.ok(b!.findings.some((f) => f.code === 'C14_IMMEDIATE_PAY' && f.severity === 'BLOCKER' && /immediate payment is off/.test(f.details)), JSON.stringify(b));

  const noPolicy = tradingWorld('FixedPriceItem', '', notFound, 'Germany', { parts: { payment: false } });
  const [c] = await noPolicy.adapter.preflight(ctx, ['110000000020']);
  assert.equal(c!.verdict, 'FIXABLE');
  assert.ok(c!.findings.some((f) => f.code === 'C14_IMMEDIATE_PAY' && /no payment business policy/.test(f.details)), JSON.stringify(c));
  assert.equal(noPolicy.seen.filter((r) => r.url.pathname.startsWith('/sell/account/')).length, 0, 'nothing to read without a policy id');

  for (const policy of [{ status: 403, body: { errors: [{ errorId: 1100, message: 'Access denied' }] } }, { status: 200, body: { paymentPolicyId: '6200000002' } }] as Reply[]) {
    const unread = tradingWorld('FixedPriceItem', '', notFound, 'Germany', { policy });
    const [d] = await unread.adapter.preflight(ctx, ['110000000020']);
    assert.equal(d!.verdict, 'UNKNOWN', JSON.stringify(d));
    assert.ok(d!.findings.some((f) => f.code === 'PREFLIGHT_INCOMPLETE' && /payment policy/.test(f.details) && /immediate payment is turned on in the payment policy on eBay/.test(f.details)), JSON.stringify(d));
    assert.ok(!d!.findings.some((f) => f.code === 'C14_IMMEDIATE_PAY'), 'an unread policy is not guessed to be off');
  }
});

test('Р-191: postal code or city of the listing — Location or PostalCode: no blocker; neither: C15 BLOCKER; the seller address does not count; GetItem unread: UNKNOWN', async () => {
  const notFound = () => ({ status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } }) as Reply;
  for (const place of ['Location', 'PostalCode'] as const) {
    const w = tradingWorld('FixedPriceItem', '', notFound, 'Germany', { parts: { place } });
    const [p] = await w.adapter.preflight(ctx, ['110000000020']);
    assert.equal(p!.verdict, 'READY', `${place}: ${JSON.stringify(p)}`);
  }
  const none = tradingWorld('FixedPriceItem', '', notFound, 'Germany', { parts: { place: null, sellerPostalCode: true } });
  const [q] = await none.adapter.preflight(ctx, ['110000000020']);
  assert.equal(q!.verdict, 'FIXABLE');
  assert.ok(q!.findings.some((f) => f.code === 'C15_LOCATION' && f.severity === 'BLOCKER'), JSON.stringify(q));
  assert.ok(!JSON.stringify([q, none.logs]).includes('99998'), 'the postal code of the seller address is neither read as the listing place nor copied anywhere');
  const parsed = parseGetItem(getItemXml('FixedPriceItem', '', 'Germany', { place: null, sellerPostalCode: true }));
  assert.ok(parsed.ok && parsed.facts.itemLocationSet === false && parsed.facts.paymentProfileId === '6200000002');
  // GetItem не прочитан — ни одного из требований не знаем: UNKNOWN, а не «нет места»
  const broken = world((r) => (r.url.pathname === '/ws/api.dll' && r.headers['x-ebay-api-call-name'] === 'GetItem'
    ? { status: 200, xml: '<?xml version="1.0" encoding="UTF-8"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Failure</Ack><Errors><ShortMessage>Internal error</ShortMessage><ErrorCode>10007</ErrorCode></Errors></GetItemResponse>' }
    : r.url.pathname === '/ws/api.dll' ? { status: 200, xml: prefsXml } : { status: 500 }));
  const [u] = await broken.adapter.preflight(ctx, ['110000000020']);
  assert.equal(u!.verdict, 'UNKNOWN');
  assert.ok(!u!.findings.some((f) => f.code === 'C15_LOCATION'), JSON.stringify(u));
});

test('Р-191: the requirements do not enter the consent snapshot — they are conditions of the migration, not what it loses', () => {
  const a = parseGetItem(getItemXml('FixedPriceItem'));
  const b = parseGetItem(getItemXml('FixedPriceItem', '', 'Germany', { place: null, payment: false }));
  assert.ok(a.ok && b.ok);
  assert.equal(snapshotSha256({ ...a.facts, outOfStockControl: false }), snapshotSha256({ ...b.facts, outOfStockControl: false }));
});

/**
 * Шаг 49 [Р-189, E-22]: снимок говорит «один SKU на вызов», схема и песочница — до 25. Боевой аккаунт доказывает пакет сам: проба — один
 * пакет из 2 SKU на план, остальные по одному; MULTI — до 25; SINGLE — по одному; тень и аккаунт без режима записи — как раньше.
 */
test('Р-189: batch planning by the batch mode of a LIVE account — probe 2 + singles, MULTI up to 25, SINGLE one SKU per call; shadow unchanged', async () => {
  const many = Array.from({ length: 30 }, (_, i) => write(String(200 + i), eur(1000 + i)));
  const sizes = async (o: Parameters<typeof world>[1]) => {
    const w = world(() => ({ status: 200 }), o);
    return { sizes: (await w.adapter.planDispatch(ctx, many)).batches.map((b) => b.items.length).sort((x, y) => y - x), logs: w.logs };
  };
  const probe = await sizes({ writeMode: 'LIVE', batchMode: () => 'PROBE' });
  assert.deepEqual(probe.sizes, [2, ...Array(28).fill(1)], 'one probe of 2 SKUs, the rest one per call');
  assert.ok(probe.logs.some((l) => l.code === 'EBAY_C18_MULTI_SKU_PROBE' && l.question === 'E-22'));
  assert.deepEqual((await sizes({ writeMode: 'LIVE' })).sizes, [2, ...Array(28).fill(1)], 'a LIVE account without a named mode is a probe (fail-closed)');
  assert.deepEqual((await sizes({ writeMode: 'LIVE', batchMode: () => 'MULTI' })).sizes, [25, 5]);
  assert.deepEqual((await sizes({ writeMode: 'LIVE', batchMode: () => 'SINGLE' })).sizes, Array(30).fill(1));
  assert.deepEqual((await sizes({ writeMode: 'SHADOW', batchMode: () => 'SINGLE' })).sizes, [25, 5], 'the shadow sends nothing: its plan is unchanged');
});

test('Р-189: a LIVE multi-SKU batch accepted per element is multiSkuAccepted=true; refused as a whole it is retried (TRANSIENT) with false; one SKU carries no outcome', async () => {
  const a = write('41', eur(1301));
  const b = write('42', eur(1302));
  const perItem = () => ({ status: 200, body: { responses: [a, b].map((x) => ({ statusCode: 200, offerId: x.writeScope.identity.externalOfferId })) } }) as Reply;
  const accepted = await world(perItem, { writeMode: 'LIVE', batchMode: () => 'PROBE' }).adapter.dispatch(ctx, batchOf([a, b]));
  assert.deepEqual(accepted.ebayBatchOutcome, { multiSkuAccepted: true });
  assert.deepEqual(accepted.outcomes.map((o) => o.status), ['ACCEPTED', 'ACCEPTED']);
  // Ответ всего вызова без ответов по элементам — отказ формы: код ошибки канала синтетический (реальный неизвестен, E-22)
  const whole = world(() => ({ status: 400, body: { errors: [{ errorId: 99001, message: 'Only one SKU can be updated per call (synthetic)' }] } }), { writeMode: 'LIVE', batchMode: () => 'PROBE' });
  const refused = await whole.adapter.dispatch(ctx, batchOf([a, b]));
  assert.deepEqual(refused.ebayBatchOutcome, { multiSkuAccepted: false });
  for (const o of refused.outcomes) {
    assert.ok(o.status === 'REJECTED' && o.error.class === 'TRANSIENT' && o.error.code === 'ACTION_NOT_ALLOWED' && o.error.channelCode === '99001' && /one SKU per call/.test(o.error.message), JSON.stringify(o));
  }
  assert.ok(whole.logs.some((l) => l.code === 'EBAY_C18_MULTI_SKU_PROBE' && l.details?.sent === true));
  assert.equal(whole.alerts.length, 0, 'the alert is raised by the database function, not a second time here');
  // Не отказ формы: 429 и 25712 — прежняя классификация, итога нет; один SKU — итога нет; тень — итога нет
  const limited = await world(() => ({ status: 429, body: { errors: [{ errorId: 2001, message: 'Too many requests' }] } }), { writeMode: 'LIVE', batchMode: () => 'PROBE' }).adapter.dispatch(ctx, batchOf([a, b]));
  assert.equal(limited.ebayBatchOutcome, undefined);
  assert.equal(limited.outcomes[0]!.status === 'REJECTED' && limited.outcomes[0]!.error.code, 'RATE_LIMITED');
  const single = await world(() => ({ status: 400, body: { errors: [{ errorId: 25709, message: 'Invalid value' }] } }), { writeMode: 'LIVE', batchMode: () => 'PROBE' }).adapter.dispatch(ctx, batchOf([a]));
  assert.equal(single.ebayBatchOutcome, undefined, 'one SKU carries no batch outcome');
  assert.ok(single.outcomes[0]!.status === 'REJECTED' && single.outcomes[0]!.error.class === 'PERMANENT', 'one SKU refused — the old classification');
  const shadow = await world(perItem, { writeMode: 'SHADOW' }).adapter.dispatch(ctx, batchOf([a, b]));
  assert.equal(shadow.ebayBatchOutcome, undefined, 'the database takes an outcome only from a LIVE account');
});

test('Р-189: a plan made before the account went SINGLE is not sent — retried without a call and without an edit charge', async () => {
  let mode: 'PROBE' | 'SINGLE' = 'PROBE';
  const w = world(() => ({ status: 200 }), { writeMode: 'LIVE', batchMode: () => mode });
  const a = write('43', eur(1303));
  const b = write('44', eur(1304));
  const plan = await w.adapter.planDispatch(ctx, [a, b]);
  assert.deepEqual(plan.batches.map((x) => x.items.length), [2]);
  mode = 'SINGLE';
  const r = await w.adapter.dispatch(ctx, plan.batches[0]!);
  assert.equal(w.seen.length, 0, 'no call to eBay');
  assert.equal(r.attemptsMade, 0);
  assert.ok(r.outcomes.every((o) => o.status === 'REJECTED' && o.error.class === 'TRANSIENT'), JSON.stringify(r.outcomes));
  assert.equal(r.ebayBatchOutcome, undefined, 'nothing was sent — no outcome');
  const replanned = await w.adapter.planDispatch(ctx, [a, b]);
  assert.deepEqual(replanned.batches.map((x) => x.items.length), [1, 1], 'the next plan reads the new mode');
});

/**
 * Шаг 49 [Р-190, E-21]: в бою Browse не вызывается, пока лицензия Buy API не выяснена. Цена и количество подтверждаются записью
 * предложения (ownRecordOnly), цены покупателя нет, правку другой программой не видно — это записано в журнал ОДИН раз на аккаунт.
 */
test('Р-190: PRODUCTION never calls Browse — price and quantity from the offer record (ownRecordOnly), no buyerPrice, no C10 alert, EBAY_C19 once per account', async () => {
  const price = write('51', eur(1349));
  const qty = write('51', { field: 'QUANTITY', quantity: 3 });
  const offer = (value: string) => ({ status: 200, body: { offerId: price.writeScope.identity.externalOfferId, sku: 'SYN-51', marketplaceId: 'EBAY_DE', availableQuantity: 3,
    pricingSummary: { price: { value, currency: 'EUR' } }, listing: { listingId: price.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }) as Reply;
  const w = world((r) => {
    assert.ok(!r.url.pathname.startsWith('/buy/'), `Browse must not be called in production: ${r.url.pathname}`);
    assert.equal(r.url.origin, 'https://api.ebay.com', 'production host');
    return offer('13.49');
  }, { environment: 'PRODUCTION', writeMode: 'LIVE' });
  const read = await w.adapter.readBack(ctx, [{ writeScope: price.writeScope, fields: ['PRICE'] }, { writeScope: qty.writeScope, fields: ['QUANTITY'] }]);
  assert.deepEqual(read.failures, []);
  const [p, q] = read.observations;
  assert.ok(p!.value.field === 'PRICE' && p!.value.price.amountMinor === 1349 && p!.ownRecordOnly === true && p!.buyerPrice === undefined && p!.effectivePrice === undefined, JSON.stringify(p));
  assert.ok(q!.value.field === 'QUANTITY' && q!.value.quantity === 3 && q!.ownRecordOnly === true, JSON.stringify(q));
  const [c] = await w.adapter.confirm(ctx, [{ channelWriteId: price.channelWriteId, writeScope: price.writeScope, expected: price.value, dispatchedAt: NOW as never }]);
  assert.equal(c!.status, 'APPLIED', 'the write is confirmed by the offer record');
  assert.equal(w.alerts.length, 0, 'no EBAY_OFFER_LISTING_DIVERGENCE: another tool is not visible without Browse');
  assert.equal(w.logs.filter((l) => l.code === 'EBAY_C19_BROWSE_UNAVAILABLE_IN_PRODUCTION' && l.question === 'E-21').length, 1, 'logged once per account, not per read');
  assert.ok(!w.logs.some((l) => l.code === 'EBAY_C06_BROWSE_APPLICATION_TOKEN'));
  assert.equal(w.tokens.n, 1, 'only the user token was requested — no application token for Browse');
  // Песочница: Browse по-прежнему читается, наблюдение не помечено
  const sb = world((r) => (r.url.pathname.startsWith('/buy/') ? { status: 200, body: { price: { value: '13.49', currency: 'EUR' } } } : offer('13.49')));
  const sbRead = await sb.adapter.readBack(ctx, [{ writeScope: price.writeScope, fields: ['PRICE'] }]);
  assert.ok(sb.seen.some((r) => r.url.pathname.startsWith('/buy/browse/')), 'the sandbox still reads the live listing');
  assert.equal(sbRead.observations[0]!.ownRecordOnly, undefined);
});

/**
 * Ревью шага 49, находка 10: перепроверка перед миграцией пяти листингов — это 12 чтений и вызов миграции при клиентском запасе 4 запроса
 * [EBAY_C01]. Отказ клиентского бюджета — запрос не отправлен, поэтому адаптер ждёт до retryAt в пределах срока вызова, а не объявляет
 * листинг «не перепроверен».
 */
test('review 49 #10: consent for 5 listings passes the full re-check under the default client request budget and migrates all five', async () => {
  const idsOf = Array.from({ length: 5 }, (_, i) => `11000000003${i}`);
  const itemFor = (id: string) => getItemXml('FixedPriceItem').replace('<ItemID>110000000020</ItemID>', `<ItemID>${id}</ItemID>`);
  const w = world((r) => {
    if (r.url.pathname === '/ws/api.dll') {
      if (r.headers['x-ebay-api-call-name'] === 'GetUserPreferences') return { status: 200, xml: prefsXml };
      return { status: 200, xml: itemFor(/<ItemID>(\d+)<\/ItemID>/.exec(r.body)![1]!) };
    }
    if (r.url.pathname.startsWith('/sell/account/v1/payment_policy/')) return POLICY_OK;
    if (r.url.pathname === '/sell/inventory/v1/offer') return { status: 404, body: { errors: [{ errorId: 25713, message: 'This Offer is not available.' }] } };
    assert.equal(r.url.pathname, '/sell/inventory/v1/bulk_migrate_listing');
    return { status: 200, body: { responses: idsOf.map((id, i) => ({ statusCode: 200, listingId: id, inventoryItems: [{ sku: 'SYN-LEGACY', offerId: `900000004${i}` }] })) } };
  });
  const pre = await w.adapter.preflight(ctx, idsOf);
  assert.deepEqual(pre.map((p) => p.verdict), Array(5).fill('READY'), 'the preflight itself waits for the budget too');
  const proofs: MigrationConsentProof[] = pre.map((p, i) => ({ migrationConsentId: `mc-${i}`, listingId: p.listingId, listingSnapshotSha256: p.listingSnapshotSha256, offerMappingStatus: 'MIGRATION_STARTED' }));
  const out = await w.adapter.migrate(ctx, proofs);
  assert.deepEqual(out.map((o) => o.status), Array(5).fill('MIGRATED'), JSON.stringify(out));
  assert.equal(w.seen.filter((r) => r.url.pathname.endsWith('bulk_migrate_listing')).length, 1);
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C01_REQUEST_BUDGET'), 'the client budget was hit — and waited for, not refused');
});

/**
 * Ревью шага 49, находки 6, 7, 14: отказом формы считается только 400 без ответов по элементам с кодом, не относящимся к значениям; «принят» —
 * только при ответе по каждому предложению; в бою каталог без режима записи — проба.
 */
test('review 49 #6 #7 #14: value errors, 404/409 are not a multi-SKU refusal; accepted only with an answer per offer; PRODUCTION without a write mode is a probe', async () => {
  const a = write('61', eur(1301));
  const b = write('62', eur(1302));
  for (const reply of [
    { status: 400, body: { errors: [{ errorId: 25709, message: 'Invalid value for Offers.price.value.' }] } },
    { status: 400, body: { errors: [{ errorId: 25604, message: 'Offer not found' }] } },
    { status: 400, body: { errors: [{ errorId: 25016, message: 'below minimum' }] } },
    { status: 400, body: { errors: [{ errorId: 25002, message: 'user error' }] } },
    { status: 404, body: { errors: [{ errorId: 99001, message: 'not found' }] } },
    { status: 409, body: { errors: [{ errorId: 99002, message: 'conflict' }] } },
  ] as Reply[]) {
    const r = await world(() => reply, { writeMode: 'LIVE', batchMode: () => 'PROBE' }).adapter.dispatch(ctx, batchOf([a, b]));
    assert.equal(r.ebayBatchOutcome, undefined, `no batch outcome for ${JSON.stringify(reply)}`);
    assert.ok(r.outcomes.every((o) => o.status === 'REJECTED' && o.error.class !== 'TRANSIENT'), `the ordinary classification: ${JSON.stringify(r.outcomes)}`);
  }
  // 200 с ответом только по одному предложению из двух — итог пакета не сообщается, журнал называет числа
  const half = world(() => ({ status: 200, body: { responses: [{ statusCode: 200, offerId: a.writeScope.identity.externalOfferId }] } }), { writeMode: 'LIVE', batchMode: () => 'PROBE' });
  const r = await half.adapter.dispatch(ctx, batchOf([a, b]));
  assert.equal(r.ebayBatchOutcome, undefined);
  assert.ok(half.logs.some((l) => l.code === 'EBAY_C18_MULTI_SKU_PROBE' && l.details?.skus === 2 && l.details?.answered === 1 && l.details?.outcome === 'NOT_REPORTED'), JSON.stringify(half.logs));
  // Бой без режима записи в каталоге — проба; песочница без режима — как раньше
  const many = Array.from({ length: 5 }, (_, i) => write(String(300 + i), eur(1000 + i)));
  const prod = await world(() => ({ status: 200 }), { environment: 'PRODUCTION' }).adapter.planDispatch(ctx, many);
  assert.deepEqual(prod.batches.map((x) => x.items.length).sort((x, y) => y - x), [2, 1, 1, 1]);
  const sb = await world(() => ({ status: 200 })).adapter.planDispatch(ctx, many);
  assert.deepEqual(sb.batches.map((x) => x.items.length), [5]);
});

/**
 * Шаг 51, хвост E-23: заголовок Accept-Language REST-вызовов — язык ПЕРВОЙ витрины аккаунта. Аккаунт EBAY_US шлёт en-US, аккаунт
 * EBAY_DE — de-DE. Живьём проверен только de-DE (песочница шага 50); US-листинга в песочнице нет — en-US не проверен (E-23)
 */
test('E-23: Accept-Language follows the first storefront of the account — en-US for an EBAY_US account, de-DE for an EBAY_DE one, on every REST call', async () => {
  const run = async (marketplaces: string[]) => {
    const w = world((r) => {
      if (r.url.pathname === '/sell/inventory/v1/inventory_item') return { status: 200, body: { total: 0, inventoryItems: [] } };
      if (r.url.pathname === '/sell/fulfillment/v1/order') return { status: 200, body: { total: 0, orders: [] } };
      return { status: 200, xml: GMS('', 1) };
    }, { marketplaces });
    await w.adapter.discoverOffers(ctx, { limit: 10 });
    await w.adapter.readOrderLines(ctx, { since: '2026-09-28T00:00:00.000Z', limit: 10 });
    const rest = w.seen.filter((x) => x.url.pathname.startsWith('/sell/'));
    assert.ok(rest.length >= 2, `REST calls were made (${rest.map((x) => x.url.pathname).join(', ')})`);
    return new Set(rest.map((x) => x.headers['accept-language']));
  };
  assert.deepEqual([...await run(['EBAY_US'])], ['en-US']);
  assert.deepEqual([...await run(['EBAY_DE'])], ['de-DE']);
});

/**
 * Шаг 52 (Growth Check: «не ломаться, если eBay изменит число элементов на странице»): следующее смещение limit/offset — из `next` или по
 * числу пришедших записей, а не `offset + limit`: иначе страница короче запрошенной перепрыгивала через записи
 */
test('step 52: short pages — the next offset follows next or the records returned, never offset + limit; an empty page without next ends', async () => {
  const { nextOffsetOf } = await import('../src/listing.ts');
  assert.equal(nextOffsetOf(0, 2, 10, undefined, 5), 2, 'short page with total: continue after what came');
  assert.equal(nextOffsetOf(0, 2, 10, 'https://api.ebay.com/sell/fulfillment/v1/order?limit=2&offset=2', 5), 2, 'next names the offset');
  assert.equal(nextOffsetOf(4, 1, 10, undefined, 5), null, 'the last record reached');
  assert.equal(nextOffsetOf(0, 10, 10, undefined, undefined), 10, 'no total: a full page continues');
  assert.equal(nextOffsetOf(0, 3, 10, undefined, undefined), null, 'no total: a short page is the last');
  assert.equal(nextOffsetOf(6, 0, 10, undefined, 20), null, 'empty page without next: no progress, stop instead of looping');
  assert.equal(nextOffsetOf(6, 0, 10, 'https://api.ebay.com/x?offset=16', 20), 16, 'empty page with next: follow next');

  // Заказы через адаптер: канал урезает limit 10 до 2, всего 5 заказов — все пять строк ровно по разу
  const orders = Array.from({ length: 5 }, (_, i) => ({ orderId: `syn-order-${i}`, creationDate: '2026-09-28T08:00:00.000Z',
    cancelStatus: { cancelState: 'NONE_REQUESTED' }, lineItems: [{ lineItemId: `syn-line-${i}`, sku: 'SYN-S', legacyItemId: '110000000001', quantity: 1, lineItemFulfillmentStatus: 'NOT_STARTED', listingMarketplaceId: 'EBAY_DE' }] }));
  const w = world((r) => {
    const offset = Number(r.url.searchParams.get('offset') ?? 0);
    const page = orders.slice(offset, offset + 2);
    return { status: 200, body: { total: 5, limit: 2, offset, orders: page } };
  }, { marketplaces: ['EBAY_DE'] });
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const p = await w.adapter.readOrderLines(ctx, { since: '2026-09-28T00:00:00.000Z', limit: 10, ...(cursor ? { cursor } : {}) });
    seen.push(...p.items.map((l) => l.externalOrderLineRef));
    if (!p.nextCursor) break;
    cursor = p.nextCursor;
  }
  assert.deepEqual(seen, orders.map((o) => o.lineItems[0]!.lineItemId), 'every line once, none skipped');
});

/** Шаг 52 (ревью шага 51, находка 14): у аккаунта EBAY_US и EBAY_DE запись и чтение предложения EBAY_DE идут с de-DE, вызовы уровня аккаунта — с языком первой витрины */
test('E-23, step 52: Accept-Language of a single-storefront call is the language of that storefront, not of the first storefront of the account', async () => {
  const w0 = write('41', eur(1499));
  const w = world((r) => {
    if (r.url.pathname === '/sell/inventory/v1/bulk_update_price_quantity') return { status: 200, body: { responses: [{ statusCode: 200, offerId: w0.writeScope.identity.externalOfferId }] } };
    if (r.url.pathname.startsWith('/sell/inventory/v1/offer/')) {
      return { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, sku: 'SYN-41', marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', availableQuantity: 4,
        pricingSummary: { price: { value: '14.99', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } };
    }
    if (r.url.pathname === '/sell/fulfillment/v1/order') return { status: 200, body: { total: 0, orders: [] } };
    return { status: 200, body: { price: { value: '14.99', currency: 'EUR' } } };
  }, { marketplaces: ['EBAY_US', 'EBAY_DE'] });
  await w.adapter.dispatch(ctx, batchOf([w0]));
  await w.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['QUANTITY'] }]);
  await w.adapter.readOrderLines(ctx, { since: '2026-09-28T00:00:00.000Z', limit: 10 });
  const lang = (path: string) => w.seen.find((x) => x.url.pathname.startsWith(path))!.headers['accept-language'];
  assert.equal(lang('/sell/inventory/v1/bulk_update_price_quantity'), 'de-DE', 'a write of an EBAY_DE offer');
  assert.equal(lang('/sell/inventory/v1/offer/'), 'de-DE', 'the read-back of an EBAY_DE offer');
  assert.equal(lang('/sell/fulfillment/v1/order'), 'en-US', 'an account-level call: the first storefront');
});

test('step 55 (OQ-240): quotas are read from Developer Analytics — the application with the application token, the seller with the user token (not verified live)', async () => {
  const w = world((r) => {
    if (r.url.pathname === '/developer/analytics/v1_beta/rate_limit/') {
      assert.equal(r.headers.authorization, 'Bearer syn-app-token', 'application quotas — application token');
      assert.equal(r.url.searchParams.get('api_name'), 'TradingAPI');
      return { status: 200, body: { rateLimits: [{ apiContext: 'TradingAPI', apiName: 'TradingAPI', apiVersion: 'v1', resources: [{ name: 'TradingAPI', rates: [{ count: 1200, limit: 5000, remaining: 3800, reset: '2026-09-28T07:00:00.000Z', timeWindow: 86400 }] }] }] } };
    }
    assert.equal(r.url.pathname, '/developer/analytics/v1_beta/user_rate_limit/');
    assert.equal(r.headers.authorization, 'Bearer syn-user-token', 'user quotas — the seller token');
    return { status: 200, body: { rateLimits: [] } };
  });
  const app = await w.adapter.readRateLimits(ctx, 'APPLICATION', { apiName: 'TradingAPI' });
  assert.deepEqual(app.ok && app.limits[0]?.resources[0]?.rates[0], { count: 1200, limit: 5000, remaining: 3800, reset: '2026-09-28T07:00:00.000Z', timeWindow: 86400 });
  const user = await w.adapter.readRateLimits(ctx, 'USER');
  assert.deepEqual(user, { ok: true, limits: [] });
});
