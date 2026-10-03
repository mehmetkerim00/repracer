import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neverWrittenAttributes, type ChannelAccountId, type TenantId } from '@repracer/channel-port';
import { createAmazonAdapter, decimalToMinor, minorToDecimal, patchBody, TwoLevelBudget } from '../src/index.ts';
import { OFFER_TITLE_MAX } from '../src/mapping.ts';

/** Модульные проверки адаптера Amazon (шаг 22). Данные синтетические */

test('money: decimal strings and JSON numbers become whole cents; sub-cent fractions are refused', () => {
  assert.equal(decimalToMinor('17.75'), 1775);
  assert.equal(decimalToMinor(17.8), 1780);
  assert.equal(decimalToMinor('20'), 2000);
  assert.equal(decimalToMinor('17.750'), 1775);
  assert.equal(decimalToMinor('17.755'), null);
  assert.equal(decimalToMinor('-1'), null);
  assert.equal(decimalToMinor('1e3'), null);
  assert.equal(minorToDecimal(1775), 17.75);
  assert.equal(minorToDecimal(1705), 17.05);
  assert.equal(JSON.stringify({ v: minorToDecimal(100000001) }), '{"v":1000000.01}');
});

test('Р-114: a PATCH body contains our_price or fulfillment_availability only — never a channel bound or an automated pricing rule', () => {
  const write = (field: 'PRICE' | 'QUANTITY') => ({
    channelWriteId: 'cw' as never, version: 1, idempotencyKey: 'k', attemptNo: 1,
    writeScope: { writeScopeId: 'ws' as never, field, scopeKey: 'k', identity: { region: 'EU', marketplace: 'A1PA6795UKMFR9', externalSku: 'SYN-1' } },
    value: field === 'PRICE' ? { field, price: { amountMinor: 1999, currency: 'EUR', basis: 'GROSS' as const } } : { field, quantity: 3 },
  });
  for (const body of [JSON.stringify(patchBody('SYN_TYPE', [write('PRICE')])), JSON.stringify(patchBody('SYN_TYPE', [write('QUANTITY')]))]) {
    for (const attribute of neverWrittenAttributes('AMAZON')) assert.ok(!body.includes(attribute), `${attribute} in ${body}`);
  }
  assert.deepEqual(neverWrittenAttributes('AMAZON').sort(), ['automated_pricing_merchandising_rule_plan', 'maximum_seller_allowed_price', 'minimum_seller_allowed_price']);
});

test('E: two-level budget — the pair limit and the application limit, whichever is reached first; sellers share the application level', () => {
  const b = new TwoLevelBudget();
  const t = Date.parse('2026-09-14T10:00:00.000Z');
  for (let i = 0; i < 5; i++) assert.equal(b.tryAcquire('S1', 'patchListingsItem', t).ok, true);
  const sixth = b.tryAcquire('S1', 'patchListingsItem', t);
  assert.ok(!sixth.ok && sixth.level === 'PAIR' && sixth.retryAtMs === t + 200);
  assert.equal(b.tryAcquire('S1', 'patchListingsItem', t + 200).ok, true, 'refills at 5 per second');
  // Уровень приложения: burst пары принят и для приложения (A-09) — пятеро других продавцов исчерпывают общий запас
  const shared = new TwoLevelBudget();
  for (let i = 0; i < 5; i++) assert.equal(shared.tryAcquire(`S${i}`, 'getListingsItem', t).ok, true);
  const other = shared.tryAcquire('S9', 'getListingsItem', t);
  assert.ok(!other.ok && other.level === 'APPLICATION');
  const loaded = new TwoLevelBudget({ applicationLoadRps: () => 100 });
  assert.equal(loaded.tryAcquire('S1', 'getListingsItem', t).ok, false, 'no application capacity left');
  // Ревью шага 22, находка 3: свободно 19 rps из 100 — запросы идут со скоростью свободной доли, а не стоят
  const partly = new TwoLevelBudget({ applicationLoadRps: () => 81 });
  let passed = 0;
  for (let ms = 0; ms < 10_000; ms += 10) if (partly.tryAcquire(`S${ms % 7}`, 'getListingsItem', t + ms).ok) passed += 1;
  assert.ok(passed >= 150 && passed <= 200, `about 19 per second pass: ${passed}`);
  const header = new TwoLevelBudget();
  header.observePairLimit('S1', 'patchListingsItem', 1);
  for (let i = 0; i < 5; i++) header.tryAcquire('S1', 'patchListingsItem', t);
  const slow = header.tryAcquire('S1', 'patchListingsItem', t);
  assert.ok(!slow.ok && slow.retryAtMs === t + 1000, 'x-amzn-RateLimit-Limit lowers the pair rate');
});

test('step 69 (OQ-249): discovery takes the product title from itemName of the marketplace summary — trimmed, capped, absent when missing or blank; no extra call', async () => {
  const MARKETPLACE = 'A1PA6795UKMFR9';
  const NOW = '2026-10-02T10:00:00.000Z';
  const long = `Synthetisches Produkt ${'x'.repeat(300)}`;
  const item = (sku: string, itemName: unknown) => ({
    sku,
    summaries: [{ marketplaceId: MARKETPLACE, asin: `B0${sku.replace(/\D/g, '').padStart(8, '0')}`, productType: 'SYN_TYPE', status: ['BUYABLE', 'DISCOVERABLE'],
      ...(itemName === undefined ? {} : { itemName }), createdDate: NOW, lastUpdatedDate: NOW }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 3 }],
  });
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/auth/o2/token') return new Response(JSON.stringify({ access_token: 'syn-lwa-access-token', expires_in: 3600 }), { status: 200 });
    calls.push(url.pathname);
    assert.equal(url.pathname, '/listings/2021-08-01/items/SYN_SELLER');
    assert.ok(url.searchParams.getAll('includedData').join(',').includes('summaries'), 'the summaries set is already requested by discovery');
    return new Response(JSON.stringify({ numberOfResults: 5, items: [
      item('SYN-1', '  Synthetisches\n Produkt\t1  '), item('SYN-2', '   '), item('SYN-3', undefined), item('SYN-4', long), item('SYN-5', 42),
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', externalAccountId: 'SYN_SELLER', region: 'EU', marketplaces: [MARKETPLACE], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'syn-client', clientSecret: 'syn-secret' }) },
      alerts: { raise: async () => {} },
      logger: { log: () => {} },
      now: () => NOW,
    },
    userAgent: 'repracer-test/1.0', applicationCredentialsRef: 'cred:app', fetch: fetchFn, endpoints: { EU: 'https://sp-api.invalid' }, timeoutMs: 1000,
  });
  const ctx = { tenantId: '10000000-0000-4000-8000-000000000001' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000001' as ChannelAccountId, correlationId: 'unit', deadline: '2026-10-02T10:05:00.000Z' };
  const page = await adapter.discoverOffers(ctx, { limit: 20 });
  assert.deepEqual(page.items.map((i) => i.identity.externalSku), ['SYN-1', 'SYN-2', 'SYN-3', 'SYN-4', 'SYN-5']);
  const [one, blank, missing, capped, notString] = page.items;
  assert.equal(one!.title, 'Synthetisches Produkt 1', 'whitespace and control characters collapse to one space, edges trimmed');
  for (const o of [blank!, missing!, notString!]) {
    assert.equal(o.title, undefined, `${o.identity.externalSku}: no title from the channel`);
    assert.ok(!('title' in o), `${o.identity.externalSku}: the key is absent, not an empty string`);
  }
  assert.equal(Array.from(capped!.title!).length, OFFER_TITLE_MAX);
  assert.ok(long.startsWith(capped!.title!));
  assert.deepEqual(calls, ['/listings/2021-08-01/items/SYN_SELLER'], 'the title comes from the search response itself — no extra call');
});
