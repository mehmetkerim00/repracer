import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterLogEntry, ChannelAccountId, FieldWrite, MigrationConsentProof, TenantId } from '@repracer/channel-port';
import {
  bulkUpdateBody, budgetChargesOf, createEbayAdapter, ebayAdapterFactory, decimalToMinor, formatMinor, NOT_MIGRATED_LOG_CODE, parseGetItem, RollingDayLedger, snapshotSha256,
} from '../src/index.ts';

/** Модульные проверки адаптера eBay (шаг 39). Данные синтетические; формы ответов — как у песочницы (docs/evidence/step39-ebay-sandbox.md) */

const TENANT = '10000000-0000-4000-8000-000000000001' as TenantId;
const ACCOUNT = '20000000-0000-4000-8000-000000000001' as ChannelAccountId;
const NOW = '2026-09-27T10:00:00.000Z';
const ctx: AdapterCallContext = { tenantId: TENANT, channelAccountId: ACCOUNT, correlationId: 'unit', deadline: '2026-09-27T10:05:00.000Z' };

interface Seen { method: string; url: URL; headers: Record<string, string>; body: string }
type Reply = { status: number; body?: unknown; xml?: string } | 'NETWORK_ERROR' | 'BODY_BREAKS';

function world(handler: (r: Seen) => Reply, options: { ledger?: RollingDayLedger } = {}) {
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
        ? { ok: true, account: { tenantId, channelAccountId, channel: 'EBAY', externalAccountId: 'syn-seller', marketplaces: ['EBAY_DE', 'EBAY_US'], credentialsRef: 'cred:seller' } }
        : { ok: false, reason: 'TENANT_MISMATCH' }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'Syn-App-SBX', clientSecret: 'syn-secret' }) },
      alerts: { raise: async (a) => { alerts.push(a); } },
      logger: { log: (e) => { logs.push(e); } },
      now: () => new Date(clock).toISOString(),
    },
    environment: 'SANDBOX', applicationCredentialsRef: 'cred:app', scopes: ['https://api.ebay.com/oauth/api_scope/sell.inventory'],
    fetch: fetchFn, sleep: async (ms) => { clock += ms; }, timeoutMs: 1000,
    ...(options.ledger ? { editLedger: options.ledger } : {}),
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

test('read-back: value is the seller price of the offer, effectivePrice the live buyer price; a difference that is not the VAT raises C10', async () => {
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
  assert.ok(obs.value.field === 'PRICE' && obs.value.price.amountMinor === 1499, 'the seller price from the offer');
  assert.equal(obs.effectivePrice?.amountMinor, 1399, 'the buyer price of the live listing');
  assert.deepEqual(w.alerts.map((a) => a.code), ['EBAY_OFFER_LISTING_DIVERGENCE']);
  const confirm = await w.adapter.confirm(ctx, [{ channelWriteId: w0.channelWriteId, writeScope: w0.writeScope, expected: eur(1499), dispatchedAt: NOW }]);
  assert.equal(confirm[0]!.status, 'APPLIED', 'confirmation compares the seller price');
});

test('E-17: Browse = seller price × 1.19 with taxes VAT includedInPrice — effectivePrice carries it, no C10 alert, EBAY_C14 logged', async () => {
  const w0 = write('13', eur(1349));
  const w = world((r) => (r.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', availableQuantity: 4, pricingSummary: { price: { value: '13.49', currency: 'EUR' } },
      listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.05', currency: 'EUR' }, taxes: [{ taxType: 'VAT', taxPercentage: '19.0', includedInPrice: true, ebayCollectAndRemitTax: true }] } }));
  const r = await w.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  const obs = r.observations[0]!;
  assert.ok(obs.value.field === 'PRICE' && obs.value.price.amountMinor === 1349 && obs.effectivePrice?.amountMinor === 1605);
  assert.deepEqual(w.alerts, [], 'the VAT on top is not another tool editing the listing');
  assert.ok(w.logs.some((l) => l.code === 'EBAY_C14_BROWSE_PRICE_WITH_VAT' && l.question === 'E-17' && l.details?.vatBasisPoints === 1900));
  // Без taxes та же разница — уже C10
  const w2 = world((q) => (q.url.pathname.startsWith('/sell/')
    ? { status: 200, body: { offerId: w0.writeScope.identity.externalOfferId, marketplaceId: 'EBAY_DE', pricingSummary: { price: { value: '13.49', currency: 'EUR' } }, listing: { listingId: w0.writeScope.identity.externalListingId, listingStatus: 'ACTIVE' } } }
    : { status: 200, body: { price: { value: '16.05', currency: 'EUR' } } }));
  await w2.adapter.readBack(ctx, [{ writeScope: w0.writeScope, fields: ['PRICE'] }]);
  assert.deepEqual(w2.alerts.map((a) => a.code), ['EBAY_OFFER_LISTING_DIVERGENCE']);
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
