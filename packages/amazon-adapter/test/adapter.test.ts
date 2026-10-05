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

/**
 * Шаг 70 [Р-205, AMZ_C15]: ответ сверяется с запросом. Песочница SP-API на чтение SYN-SKU отдала образец о чужом товаре (sku GM-ZDPI-9B4E,
 * витрина Канады вне запроса), и до шага адаптер взял из него тип товара и отправил PATCH. Ответ о другом SKU — отказ RESPONSE_MISMATCH на
 * каждом месте сверки; записи витрин вне запроса не используются и называются в журнале, но не отказ (ревью шага 70, находки 2 и 3)
 */
test('step 70 (Р-205): a response about another SKU is refused with RESPONSE_MISMATCH; entries of storefronts outside the request are skipped, not used', async () => {
  const { fbaQuantitiesOf } = await import('../src/listing.ts');
  const { classifyFailure } = await import('../src/errors.ts');
  const US = 'ATVPDKIKX0DER';
  const CA = 'A2EUQ1WTGCTBG2';
  const NOW = '2026-10-05T10:00:00.000Z';
  const item = (sku: string | undefined, marketplaces: string[], productType = 'SYN_TYPE') => ({
    ...(sku === undefined ? {} : { sku }),
    summaries: marketplaces.map((m) => ({ marketplaceId: m, asin: 'B0SYN00070', productType: m === US ? productType : 'FOREIGN_TYPE', status: ['BUYABLE'], createdDate: NOW, lastUpdatedDate: NOW })),
    attributes: { purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.99 }] }] }] },
    offers: marketplaces.map((m) => ({ marketplaceId: m, offerType: 'B2C', price: { currencyCode: m === US ? 'USD' : 'CAD', amount: m === US ? '12.99' : '17.00' } })),
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 4 }],
  });
  let replies: Array<{ path: RegExp; method?: string; body: unknown }> = [];
  let clockTicks = 0;
  const sent: Array<{ route: string; body?: string }> = [];
  const logs: string[] = [];
  const alerts: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/auth/o2/token') return new Response(JSON.stringify({ access_token: 'syn-lwa-access-token', expires_in: 3600 }), { status: 200 });
    sent.push({ route: `${init?.method ?? 'GET'} ${url.pathname}`, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
    const reply = replies.shift();
    assert.ok(reply && reply.path.test(url.pathname) && (reply.method ?? 'GET') === (init?.method ?? 'GET'), `unexpected ${init?.method ?? 'GET'} ${url.pathname}`);
    return new Response(JSON.stringify(reply.body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', externalAccountId: 'SYN_SELLER', region: 'NA', marketplaces: [US], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'syn-client', clientSecret: 'syn-secret' }) },
      alerts: { raise: async (a) => { alerts.push(`${a.code}:${a.severity}`); } },
      logger: { log: (e) => { const d = e.details as { stage?: string; kind?: string } | undefined; logs.push(`${e.code}:${String(d?.stage)}:${String(d?.kind ?? '')}`); } },
      // Часы идут: бюджет пары (burst 5) иначе кончился бы на шестом чтении теста
      now: () => new Date(Date.parse(NOW) + (clockTicks += 1_000)).toISOString(),
    },
    userAgent: 'repracer-test/1.0', applicationCredentialsRef: 'cred:app', fetch: fetchFn, endpoints: { NA: 'https://sp-api.invalid' }, timeoutMs: 1000,
  });
  const ctx = { tenantId: '10000000-0000-4000-8000-000000000001' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000001' as ChannelAccountId, correlationId: 'unit', deadline: '2026-10-06T10:00:00.000Z' };
  const scope = (field: 'PRICE' | 'QUANTITY') => ({ writeScopeId: `ws-${field}` as never, field, scopeKey: `syn|${field}`, identity: { region: 'NA', marketplace: US, externalSku: 'SYN-SKU-70' } });
  const LISTING = /^\/listings\/2021-08-01\/items\/SYN_SELLER\/SYN-SKU-70$/;
  const refused = (error: { code: string; class: string; raiseAlert: boolean; message: string } | undefined, what: RegExp) => {
    assert.equal(error?.code, 'RESPONSE_MISMATCH');
    assert.equal(error?.class, 'REQUIRES_HUMAN');
    assert.equal(error?.raiseAlert, true);
    assert.match(error!.message, what);
    assert.ok(!error!.message.includes('GM-ZDPI'), 'the foreign SKU is not repeated in the message');
  };

  // Обратное чтение: чужой SKU и ответ без sku — ни одного наблюдения, отказ своей причиной
  for (const [body, what] of [[item('GM-ZDPI-9B4E', [US, CA]), /another SKU/], [item(undefined, [US]), /carries no sku/]] as const) {
    replies = [{ path: LISTING, body }];
    const r = await adapter.readBack(ctx, [{ writeScope: scope('PRICE'), fields: ['PRICE'] }, { writeScope: scope('QUANTITY'), fields: ['QUANTITY'] }]);
    assert.deepEqual(r.observations, [], 'a foreign answer gives no observation');
    assert.equal(r.failures.length, 2);
    for (const f of r.failures) refused(f.error, what);
  }
  // Свой SKU и витрина Канады рядом — наблюдение своей витрины (цена USD, а не CAD) и запись в журнале; отказа нет
  logs.length = 0;
  replies = [{ path: LISTING, body: item('SYN-SKU-70', [US, CA]) }];
  const own = await adapter.readBack(ctx, [{ writeScope: scope('PRICE'), fields: ['PRICE'] }, { writeScope: scope('QUANTITY'), fields: ['QUANTITY'] }]);
  assert.deepEqual(own.failures, []);
  assert.deepEqual(own.observations.map((o) => (o.value.field === 'PRICE' ? `${o.value.price.amountMinor} ${o.value.price.currency}` : o.value.field === 'QUANTITY' ? `qty ${o.value.quantity}` : 'other')), ['1299 USD', 'qty 4']);
  assert.ok(logs.includes('AMZ_C15_RESPONSE_IDENTITY:READBACK:STOREFRONT'), `the foreign storefront is named in the log: ${logs.join(', ')}`);

  // Запись: чтение перед записью о чужом SKU — PATCH не уходит
  const write = { channelWriteId: 'cw-70' as never, writeScope: scope('PRICE'), version: 1, idempotencyKey: 'cw-70:1', attemptNo: 1,
    value: { field: 'PRICE' as const, price: { amountMinor: 1299, currency: 'USD', basis: 'NET' as const } } };
  const batch = { batchId: 'b-70', operation: 'patchListingsItem', items: [write], budgetCharges: [], requestCount: 2 };
  sent.length = 0;
  replies = [{ path: LISTING, body: item('GM-ZDPI-9B4E', [US, CA]) }];
  const beforeWrite = await adapter.dispatch(ctx, batch);
  assert.equal(beforeWrite.outcomes[0]!.status, 'REJECTED');
  refused(beforeWrite.outcomes[0]!.error, /before the write: the response is about another SKU/);
  assert.deepEqual(sent.map((x) => x.route), ['GET /listings/2021-08-01/items/SYN_SELLER/SYN-SKU-70'], 'no PATCH after a foreign pre-read');

  // Свой SKU, рядом витрина Канады с другим типом товара: PATCH уходит с типом СВОЕЙ витрины (запасного хода к первой сводке нет)
  sent.length = 0;
  replies = [{ path: LISTING, body: item('SYN-SKU-70', [CA, US], 'OWN_TYPE') }, { path: LISTING, method: 'PATCH', body: { sku: 'SYN-SKU-70', status: 'ACCEPTED', submissionId: 'syn-70', issues: [] } }];
  assert.equal((await adapter.dispatch(ctx, batch)).outcomes[0]!.status, 'ACCEPTED');
  assert.equal(JSON.parse(sent[1]!.body!).productType, 'OWN_TYPE', 'product type of the requested storefront');
  // Свой SKU, но сводка только витрины Канады: тип товара чужой витрины не берётся — PATCH не уходит (запасного хода к первой сводке нет)
  sent.length = 0;
  replies = [{ path: LISTING, body: item('SYN-SKU-70', [CA]) }];
  const noOwnSummary = await adapter.dispatch(ctx, batch);
  assert.equal(noOwnSummary.outcomes[0]!.status, 'REJECTED');
  assert.equal(noOwnSummary.outcomes[0]!.error?.code, 'NOT_FOUND');
  assert.deepEqual(sent.map((x) => x.route), ['GET /listings/2021-08-01/items/SYN_SELLER/SYN-SKU-70'], 'no PATCH with the product type of another storefront');

  // Запись ушла, ответ о чужом SKU — исход неизвестен (не принято и не отказ), ядро сверит обратным чтением; алерт адаптера — сразу
  alerts.length = 0;
  replies = [{ path: LISTING, body: item('SYN-SKU-70', [US]) },
    { path: LISTING, method: 'PATCH', body: { sku: 'GM-ZDPI-9B4E', status: 'ACCEPTED', submissionId: 'f1dc2914-75dd-11ea-bc55-0242ac130003', issues: [] } }];
  const afterWrite = await adapter.dispatch(ctx, batch);
  assert.equal(afterWrite.outcomes[0]!.status, 'OUTCOME_UNKNOWN');
  refused(afterWrite.outcomes[0]!.error, /patchListingsItem: the response is about another SKU/);
  assert.deepEqual(alerts, ['AMAZON_RESPONSE_MISMATCH:WARNING'], 'the foreign submission is an alert, not only a log line');

  // Обнаружение: предмет без sku и сводка Канады пропускаются поштучно с журналом; остальное страницы — в каталоге
  logs.length = 0;
  replies = [{ path: /^\/listings\/2021-08-01\/items\/SYN_SELLER$/, body: { numberOfResults: 3, items: [item('SYN-1', [US]), item('SYN-2', [US, CA]), item(undefined, [US])] } }];
  const page = await adapter.discoverOffers(ctx, { limit: 20 });
  assert.deepEqual(page.items.map((i) => `${i.identity.externalSku}@${i.identity.marketplace}`), [`SYN-1@${US}`, `SYN-2@${US}`]);
  assert.ok(logs.includes('AMZ_C15_RESPONSE_IDENTITY:DISCOVERY:'), `skipped entries are named in the log: ${logs.join(', ')}`);

  // Обнаружение с SKU сети Amazon: сводки FBA другой витрины — количество не берётся (а не чужое); своя витрина — берётся
  const fbaItem = { ...item('SYN-FBA-70', [US]), fulfillmentAvailability: [{ fulfillmentChannelCode: 'SYN_AMAZON_NETWORK', quantity: 0 }] };
  const fbaReply = (granularityId: string) => ({ path: /^\/fba\/inventory\/v1\/summaries$/, body: { payload: { granularity: { granularityType: 'Marketplace', granularityId },
    inventorySummaries: [{ sellerSku: 'SYN-FBA-70', inventoryDetails: { fulfillableQuantity: 9 } }] } } });
  for (const [granularityId, quantity] of [[CA, undefined], [US, 9]] as const) {
    replies = [{ path: /^\/listings\/2021-08-01\/items\/SYN_SELLER$/, body: { numberOfResults: 1, items: [fbaItem] } }, fbaReply(granularityId)];
    const fbaPage = await adapter.discoverOffers(ctx, { limit: 20 });
    assert.equal(fbaPage.items[0]!.fulfillment, 'CHANNEL');
    assert.equal(fbaPage.items[0]!.currentQuantity, quantity, `FBA summaries of ${granularityId}`);
  }
  assert.ok(logs.includes('AMZ_C15_RESPONSE_IDENTITY:FBA_SUMMARIES:STOREFRONT'));

  // FBA: другая витрина или чужой SKU — ни одного количества; сводка без sellerSku (в модели необязателен) — пропуск поштучно
  const fba = (granularityId: string | undefined, summaries: Array<{ sellerSku?: string; q: number }>) => ({ payload: {
    ...(granularityId ? { granularity: { granularityType: 'Marketplace', granularityId } } : {}),
    inventorySummaries: summaries.map((x) => ({ ...(x.sellerSku ? { sellerSku: x.sellerSku } : {}), inventoryDetails: { fulfillableQuantity: x.q } })) } });
  assert.equal(fbaQuantitiesOf(fba(CA, [{ sellerSku: 'SYN-FBA-70', q: 5 }]), US, ['SYN-FBA-70']).mismatch, 'STOREFRONT');
  const foreignSku = fbaQuantitiesOf(fba(US, [{ sellerSku: 'SYN-FBA-70', q: 5 }, { sellerSku: 'SYN-OTHER', q: 6 }]), US, ['SYN-FBA-70']);
  assert.deepEqual([foreignSku.mismatch, foreignSku.quantities.size], ['SKU', 0], 'a foreign SKU drops the whole answer');
  const noSku = fbaQuantitiesOf(fba(US, [{ q: 3 }, { sellerSku: 'SYN-FBA-70', q: 5 }]), US, ['SYN-FBA-70']);
  assert.deepEqual([noSku.mismatch, noSku.withoutSku, [...noSku.quantities]], [null, 1, [['SYN-FBA-70', 5]]], 'a summary without sellerSku is skipped alone');
  assert.deepEqual([...fbaQuantitiesOf(fba(undefined, [{ sellerSku: 'SYN-FBA-70', q: 5 }]), US, ['SYN-FBA-70']).quantities], [['SYN-FBA-70', 5]], 'granularityId is optional in the model');

  // details — в тексте ошибки (у 403 SP-API причина только в нём); повтор сообщения не дописывается
  const failure = (errors: Array<{ code: string; message: string; details?: string }>) =>
    classifyFailure({ ok: false, status: 403, errors, outcomeUnknown: false, tokenFailure: false, headers: null, attempts: [] }, 'BATCH', Date.parse(NOW));
  assert.equal(failure([{ code: 'Unauthorized', message: 'Access to requested resource is denied.', details: 'The marketplaces you provided are not valid for region.' }]).message,
    'Unauthorized: Access to requested resource is denied. — The marketplaces you provided are not valid for region.');
  assert.equal(failure([{ code: 'InvalidInput', message: 'Invalid Input', details: 'Invalid Input' }]).message, 'InvalidInput: Invalid Input');
  assert.match(failure([{ code: 'X', message: 'm'.repeat(500), details: 'the reason' }]).message, /— the reason$/, 'a long message does not push the reason out');
});
