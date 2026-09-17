import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signKauflandRequest } from '@repracer/kaufland-client';
import { kauflandUnderTest } from './adapters.ts';
import { channelFetch, kauflandAuthChecker, ScriptedChannel, type ObservedRequest, type TraceEntry } from './harness/channel.ts';
import { match } from './harness/matchers.ts';
import { redactExchanges } from './harness/recorder.ts';
import { runScenario } from './harness/runner.ts';
import { SCENARIO_FORMAT, validateScenario, type Scenario, type World } from './harness/scenario.ts';
import { VirtualClock } from './harness/world.ts';

const WORLD: World = {
  clock: '2026-09-14T10:00:00.000Z',
  tenantId: '10000000-0000-4000-8000-000000000001',
  channelAccountId: '20000000-0000-4000-8000-000000000001',
  account: { externalAccountId: 'syn-seller-0001', marketplaces: ['de'] },
  credentials: { seller: { clientKey: 'syn-seller-client-key-0001', secretKey: 'syn-seller-secret-key-0001' } },
};

test('matchers: exact rejects extra keys, subset ignores them, operators work', () => {
  assert.deepEqual(match({ a: 1, b: 2 }, { a: 1 }, 'subset'), []);
  assert.match(match({ a: 1, b: 2 }, { a: 1 }, 'exact')[0]!, /unexpected key/);
  assert.deepEqual(match([1, 2], [1, 2], 'exact'), []);
  assert.equal(match([1], [1, 2], 'subset').length, 1);
  assert.deepEqual(match({ t: '2026-09-14T10:00:00.000Z', x: 'kfl:de:ab' }, { t: { $isoInstant: true }, x: { $regex: '^kfl:' } }, 'subset'), []);
  assert.deepEqual(match({ k: undefined }, { k: { $absent: true } }, 'exact'), []);
  assert.deepEqual(match([{ id: 2 }, { id: 1 }], { $unordered: [{ id: 1 }, { id: 2 }] }, 'subset'), []);
  assert.equal(match([{ id: 2 }], { $contains: [{ id: 3 }] }, 'subset').length, 1);
});

test('scenario validation refuses unreviewed recordings', () => {
  const scenario = {
    format: SCENARIO_FORMAT, id: 'kaufland/x', channel: 'KAUFLAND', apiVersion: '2.44.0', title: 't', description: 'd', tags: [],
    provenance: { kind: 'RECORDED_REDACTED', recordedAt: '2026-09-14T10:00:00.000Z', recorderVersion: 'r', redactions: [], reviewedBy: null },
    world: WORLD, steps: [], exchanges: [],
  } as Scenario;
  assert.match(validateScenario(scenario).join(), /not been reviewed/);
});

function request(overrides: Partial<ObservedRequest> = {}, secretKey = WORLD.credentials.seller.secretKey ?? ''): ObservedRequest {
  const rawUrl = 'https://sellerapi.kaufland.com/v2/units/1?storefront=de';
  const ts = Math.floor(Date.parse(WORLD.clock) / 1000);
  return {
    method: 'GET', rawUrl, path: '/v2/units/1', query: { storefront: 'de' }, rawBody: '', body: undefined,
    headers: {
      'shop-client-key': WORLD.credentials.seller.clientKey ?? '',
      'shop-timestamp': String(ts),
      'shop-signature': signKauflandRequest({ method: 'GET', uri: rawUrl, body: '', timestamp: ts, secretKey }),
      'user-agent': 'test',
    },
    ...overrides,
  };
}

test('auth checker verifies the signature against the synthetic seller secret', () => {
  const check = kauflandAuthChecker(WORLD, new VirtualClock(WORLD.clock));
  assert.deepEqual(check(request()), []);
  assert.match(check(request({}, 'wrong-secret')).join(), /Shop-Signature does not verify/);
});

test('scripted channel: order, exact body and leftovers are enforced', () => {
  const channel = new ScriptedChannel([
    { id: 'a', request: { method: 'POST', path: '/v2/units/bulk', query: { storefront: 'de' }, body: [{ id_unit: 1, unit_data: { amount: 1 } }] }, response: { status: 207, body: { data: [] } } },
    { id: 'b', request: { method: 'GET', path: '/v2/units/1', query: { storefront: 'de' } }, response: { status: 200, body: {} } },
  ], true);
  const extraKey = channel.reply(request({
    method: 'POST', path: '/v2/units/bulk', rawBody: 'x', body: [{ id_unit: 1, unit_data: { amount: 1, listing_price: 100 } }],
  }));
  assert.ok('violation' in extraKey && /unexpected key/.test(extraKey.violation));
  assert.deepEqual(channel.finish(), ['unused exchanges: b']);
  const empty = new ScriptedChannel([], true);
  const unexpected = empty.reply(request());
  assert.ok('violation' in unexpected && /no more scripted exchanges/.test(unexpected.violation));
});

test('scripted TIMEOUT fault resolves only through the client abort signal', async () => {
  const clock = new VirtualClock(WORLD.clock);
  const channel = new ScriptedChannel([{ id: 't', request: { method: 'GET', path: '/v2/units/1', query: { storefront: 'de' } }, fault: 'TIMEOUT' }], true);
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const f = channelFetch(channel, () => [], clock, violations, trace);
  await assert.rejects(f('https://sellerapi.kaufland.com/v2/units/1?storefront=de', { signal: AbortSignal.timeout(10) }));
  assert.equal(trace[0]?.outcome, 'TIMEOUT');
});

test('runner fails a scenario when the adapter makes an unscripted request', async () => {
  const scenario: Scenario = {
    format: SCENARIO_FORMAT, id: 'kaufland/harness/unscripted', channel: 'KAUFLAND', apiVersion: '2.44.0', title: 't', description: 'd', tags: [],
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: [] },
    world: WORLD,
    steps: [{
      id: 'read', kind: 'call', method: 'readBack',
      args: [[{ writeScope: { writeScopeId: 'ws', field: 'PRICE', scopeKey: 'k', identity: { marketplace: 'de', externalUnitId: '1' } }, fields: ['PRICE'] }]],
    }],
    exchanges: [],
  };
  const report = await runScenario(scenario, kauflandUnderTest);
  assert.ok(report.failures.some((f) => /unexpected request #1: GET \/v2\/units\/1/.test(f)), report.failures.join('\n'));
});

test('recorder redaction removes buyer PII and remaps ids consistently', () => {
  const { exchanges, provenance } = redactExchanges([{
    id: 'rec-1',
    request: { method: 'GET', path: '/v2/order-units/123456', query: { storefront: 'de' } },
    response: {
      status: 200,
      body: { data: {
        id_order_unit: 123456, id_order: 'MXYZ1', id_offer: 'SKU-REAL', price: 1000, status: 'open',
        buyer: { id_buyer: 42, email: 'synthetic.buyer@example.invalid' },
        shipping_address: { first_name: 'Synth', last_name: 'Buyer', street: 'Synthweg', city: 'Synthstadt', phone: '+49 0' },
        product: { title: 'Real Title', eans: ['4000000000001'] },
      } },
    },
  }], { moneyFactor: 1.1, now: () => new Date('2026-09-14T10:00:00Z') });
  const text = JSON.stringify(exchanges);
  for (const leaked of ['synthetic.buyer@example.invalid', 'Synthweg', 'Synthstadt', 'SKU-REAL', 'MXYZ1', 'Real Title', '4000000000001', '123456']) {
    assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  }
  const body = exchanges[0]!.response!.body as { data: { id_order_unit: number; price: number } };
  assert.equal(exchanges[0]!.request.path, `/v2/order-units/${body.data.id_order_unit}`);
  assert.equal(body.data.price, 1100);
  assert.equal(provenance.kind === 'RECORDED_REDACTED' && provenance.reviewedBy, null);
});

test('step 22: the Amazon request checker flags a never-written attribute in a body, a foreign token, a stale date and a secret in the URL', async () => {
  const { amazonRequestChecker } = await import('./harness/channel.ts');
  const world: World = { ...WORLD, account: { ...WORLD.account, channel: 'AMAZON', region: 'EU' },
    credentials: { seller: { refreshToken: 'Atzr|syn-refresh' }, application: { clientId: 'syn-client', clientSecret: 'syn-client-secret' }, accessToken: 'Atza|syn-access' } };
  const clock = new VirtualClock('2026-09-14T10:00:00.000Z');
  const check = amazonRequestChecker(world, clock, ['minimum_seller_allowed_price', 'automated_pricing_merchandising_rule_plan']);
  const ok = { method: 'PATCH', rawUrl: 'https://sellingpartnerapi-eu.amazon.com/listings/2021-08-01/items/S/K', path: '/listings/2021-08-01/items/S/K', query: {},
    rawBody: '{"patches":[]}', body: {}, headers: { 'x-amz-access-token': 'Atza|syn-access', 'x-amz-date': '20260914T100000Z', 'user-agent': 'ua' } };
  assert.deepEqual(check(ok), []);
  assert.match(check({ ...ok, rawBody: '{"minimum_seller_allowed_price":[]}' }).join(), /never written \(Р-114\)/);
  assert.match(check({ ...ok, rawBody: '{"automated_pricing_merchandising_rule_plan":[]}' }).join(), /never written/);
  assert.match(check({ ...ok, headers: { ...ok.headers, 'x-amz-access-token': 'Atza|other' } }).join(), /not the token issued by LWA/);
  assert.match(check({ ...ok, headers: { ...ok.headers, 'x-amz-date': '20260914T095959Z' } }).join(), /virtual clock/);
  assert.match(check({ ...ok, rawUrl: `${ok.rawUrl}?x=syn-client-secret` }).join(), /secret leaked/);
  assert.match(check({ ...ok, path: '/auth/o2/token', method: 'POST', rawBody: 'grant_type=refresh_token&refresh_token=wrong&client_id=syn-client&client_secret=syn-client-secret' }).join(), /not the seller refresh token/);
});
