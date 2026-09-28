import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { amazonUnderTest } from './adapters.ts';
import { ACCESS_TOKEN, amazonWorld, DE, SELLER } from './amazon-fixtures/build.ts';
import { runScenario } from './harness/runner.ts';
import { expandVariants, SCENARIO_FORMAT, validateScenario, type Scenario, type Step, type World } from './harness/scenario.ts';
import type { AmazonChannelModelSpec, SimAmazonOrderSpec } from './simulator/amazon-channel.ts';
import { AMAZON_PARAMETERS } from './simulator/params.ts';

/**
 * Шаг 51: HTTP-модель SP-API (simulator/amazon-channel.ts) и НАСТОЯЩИЙ адаптер Amazon — как модель eBay [Р-187]. Поведение модели — только из
 * снимка моделей; открытые вопросы A-nn — параметры и варианты сценариев. Живых ключей SP-API нет: всё здесь — модель, не канал.
 */

const SCENARIOS: Scenario[] = [];
const MIN = 60_000;
const FBA_CODE = 'SYN_AMAZON_NETWORK_CODE';

function world(model: Omit<AmazonChannelModelSpec, 'sellerId' | 'region'>, extra: Partial<World> = {}): World {
  return { ...amazonWorld(), clock: '2026-09-29T10:00:00.000Z', channelModel: { sellerId: SELLER, region: 'EU', ...model }, ...extra };
}

function scenario(id: string, title: string, description: string, w: World, steps: Step[], expect: Scenario['expect'], variants: NonNullable<Scenario['variants']> = []): Scenario {
  return {
    format: SCENARIO_FORMAT, id, channel: 'AMAZON', apiVersion: 'sp-api models snapshot 2026-09-29 (model)', title, description, tags: ['simulator', 'amazon'],
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: ['vendor/amazon/sp-api-models/2026-09-29/SOURCE.md', 'docs/channel-capabilities.md#9'] },
    world: w, steps, exchanges: [], expect, ...(variants.length > 0 ? { variants } : {}),
  };
}

const call = (id: string, method: string, args: unknown[], expect?: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'call', method, args, ...(expect !== undefined ? { expect } : {}), ...extra }) as Step;
const wait = (id: string, ms: number) => ({ id, kind: 'advanceClock', ms }) as Step;

const scopeOf = (field: 'PRICE' | 'QUANTITY', sku: string) => ({
  writeScopeId: `ws-sim-amz-${field.toLowerCase()}-${sku}`, field,
  scopeKey: field === 'PRICE' ? `amazon|acct|EU|${DE}|${sku}` : `amazon|acct|EU|${sku}`, identity: { region: 'EU', marketplace: DE, externalSku: sku },
});
const priceWrite = (id: string, sku: string, minor: number) => ({ channelWriteId: id, version: 1, idempotencyKey: `${id}:1`, attemptNo: 1, writeScope: scopeOf('PRICE', sku),
  value: { field: 'PRICE', price: { amountMinor: minor, currency: 'EUR', basis: 'GROSS' } } });
const quantityWrite = (id: string, sku: string, quantity: number) => ({ channelWriteId: id, version: 1, idempotencyKey: `${id}:1`, attemptNo: 1, writeScope: scopeOf('QUANTITY', sku),
  value: { field: 'QUANTITY', quantity } });
const batch = (batchId: string, items: unknown[]) => ({ batchId, operation: 'patchListingsItem', items, budgetCharges: [], requestCount: 2 });
const confirmOf = (w: ReturnType<typeof priceWrite> | ReturnType<typeof quantityWrite>) =>
  ({ channelWriteId: w.channelWriteId, writeScope: w.writeScope, expected: w.value, dispatchedAt: { $clockIso: 0 } });

const FBM = 'SYN-SKU-FBM-0001';
const FBA = 'SYN-SKU-FBA-0002';
const NONE = 'SYN-SKU-NON-0003';
/** Витрина региона EU вне Release 1.0 (marketplace-ids: France) — только в модели, чтобы вариант A-01 было видно */
const FR = 'A13V1IB3VIYZZH';
const offers = [
  { sku: FBM, asin: 'B0SYN00001', marketplaces: [DE, FR], priceMinor: 1999, quantity: 5 },
  { sku: FBA, asin: 'B0SYN00002', marketplaces: [DE], priceMinor: 2499, quantity: 12, fulfillmentCode: FBA_CODE },
  { sku: NONE, asin: 'B0SYN00003', marketplaces: [DE], priceMinor: 2999, quantity: 0, fulfillmentCode: null },
];

// 1. Обнаружение и FBA — только чтение [Р-6, AMZ_C13, AMZ_C14]
SCENARIOS.push(scenario('amazon-sim/fba-read-only', 'Модель SP-API: FBM и FBA при обнаружении, количество FBA читается, запись количества FBA не уходит',
  'Сеть исполнения — fulfillmentAvailability: DEFAULT — FBM; код сети Amazon — FBA (количество из getInventorySummaries, только показ); кодов нет — CHANNEL без количества. Запись количества по SKU сети Amazon останавливается чтением перед записью — PATCH до модели не доходит (у модели счётчик таких записей — 0).',
  world({ seed: 1, offers }),
  [
    call('discover', 'discoverOffers', [{ limit: 20 }], { items: [
      { identity: { externalSku: FBA }, fulfillment: 'CHANNEL', currentQuantity: 12 },
      { identity: { externalSku: FBM }, fulfillment: 'MERCHANT', currentQuantity: 5 },
      { identity: { externalSku: NONE }, fulfillment: 'CHANNEL', currentQuantity: { $absent: true } },
    ] }),
    call('fba-quantity', 'dispatch', [batch('b-fba', [quantityWrite('cw-fba', FBA, 30)])], { outcomes: [{ status: 'REJECTED', error: { code: 'PRECONDITION_FAILED' } }] }),
  ],
  { noAlerts: true, channel: { stats: { fbaQuantityWrites: 0, requests: { patchListingsItem: { $absent: true }, getInventorySummaries: 1 } } } },
  [{ id: 'a21-default-switches-to-merchant', question: 'A-21', params: { fbaDefaultWrite: 'SWITCHES_TO_MERCHANT' },
    finding: 'если запись DEFAULT перевела бы листинг в наше исполнение — она не уходит: сеть листинга не меняется',
    expect: { noAlerts: true, channel: { offers: { $contains: [{ sku: FBA, fulfillmentCode: FBA_CODE }] }, stats: { fbaQuantityWrites: 0 } } } }]));

// 2. Запись цены и количества: асинхронное применение (A-06) и область количества (A-01)
{
  const price = priceWrite('cw-p', FBM, 1899);
  const qty = quantityWrite('cw-q', FBM, 7);
  SCENARIOS.push(scenario('amazon-sim/async-apply', 'Модель SP-API: ACCEPTED ≠ применено — подтверждение обратным чтением после применения (A-06); количество DEFAULT на регион (A-01)',
    'patchListingsItem отвечает ACCEPTED; до применения getListingsItem показывает прежнее значение — подтверждение PENDING; после applyDelayMs — APPLIED. Вариант A-06: 2 % принятого не применяется никогда — подтверждение остаётся PENDING в окне.',
    world({ seed: 2, offers }),
    [
      call('price', 'dispatch', [batch('b-p', [price])], { outcomes: [{ status: 'ACCEPTED', appliedImmediately: false }] }),
      call('quantity', 'dispatch', [batch('b-q', [qty])], { outcomes: [{ status: 'ACCEPTED', appliedImmediately: false }] }),
      call('confirm-early', 'confirm', [[confirmOf(price)]], [{ status: 'PENDING' }]),
      wait('apply-delay', 3 * MIN),
      call('confirm-late', 'confirm', [[confirmOf(price), confirmOf(qty)]], [{ status: 'APPLIED' }, { status: 'APPLIED', observation: { value: { quantity: 7 } } }]),
    ],
    { noAlerts: true, channel: { offers: { $contains: [{ sku: FBM, marketplace: DE, priceMinor: 1899, quantity: 7, pending: 0 }, { sku: FBM, marketplace: FR, quantity: 7 }] }, stats: { accepted: 2, applied: 3 } } },
    [{ id: 'a01-quantity-per-marketplace', question: 'A-01', params: { quantityScope: 'MARKETPLACE' },
      finding: 'если количество — на витрину, запись DE не меняет FR; единица записи аккаунт + регион + SKU [Р-194] тогда шире нужного, но не опаснее',
      expect: { noAlerts: true, channel: { offers: { $contains: [{ sku: FBM, marketplace: DE, quantity: 7 }, { sku: FBM, marketplace: FR, quantity: 5 }] } } } },
    { id: 'a06-never-applied', question: 'A-06', params: { acceptedNotAppliedShare: 1 }, finding: 'принятое не применено — подтверждение PENDING, а в окне после — NOT_APPLIED (ядро)',
      stepExpect: { 'confirm-late': [{ status: 'PENDING' }, { status: 'PENDING' }] },
      expect: { noAlerts: true, channel: { offers: { $contains: [{ sku: FBM, priceMinor: 1999, quantity: 5 }] }, stats: { acceptedNeverApplied: 2 } } } }]));
}

// 3. Заказы: только FBM, белый список, статусы строк, страницы (A-20)
{
  const order = (id: string, status: SimAmazonOrderSpec['status'], items: SimAmazonOrderSpec['items'], extra: Partial<SimAmazonOrderSpec> = {}): SimAmazonOrderSpec =>
    ({ orderId: id, marketplace: DE, fulfilledBy: 'MERCHANT', status, createdOffsetMs: -3 * 3_600_000, updatedOffsetMs: -3_600_000, items, ...extra });
  const orders: SimAmazonOrderSpec[] = [
    order('901-0000101-0000001', 'UNSHIPPED', [{ orderItemId: 'syn-oi-1', sku: FBM, quantity: 2 }]),
    order('901-0000102-0000002', 'PARTIALLY_SHIPPED', [{ orderItemId: 'syn-oi-2', sku: FBM, quantity: 3, quantityFulfilled: 1 }, { orderItemId: 'syn-oi-3', sku: FBM, quantity: 1, quantityFulfilled: 1 }]),
    order('901-0000103-0000003', 'UNSHIPPED', [{ orderItemId: 'syn-oi-4', sku: FBM, quantity: 1, cancelledBy: 'BUYER' }]),
    order('901-0000104-0000004', 'SHIPPED', [{ orderItemId: 'syn-oi-5', sku: FBA, quantity: 1 }], { fulfilledBy: 'AMAZON' }),
    order('901-0000105-0000005', 'SHIPPED', [{ orderItemId: 'syn-oi-6', sku: FBM, quantity: 1 }], { updatedOffsetMs: -3 * 86_400_000, createdOffsetMs: -4 * 86_400_000 }),
  ];
  const expected = [
    { externalOrderLineRef: 'syn-oi-1', quantity: 2, status: 'OPEN', identity: { region: 'EU', marketplace: DE, externalSku: FBM } },
    { externalOrderLineRef: 'syn-oi-2', quantity: 3, status: 'OPEN' },
    { externalOrderLineRef: 'syn-oi-3', status: 'SHIPPED' },
  ];
  SCENARIOS.push(scenario('amazon-sim/orders', 'Модель SP-API: строки заказов FBM за сутки изменений — белый список, частичная отгрузка держит резервацию, отмена строки, страницы',
    'searchOrders с lastUpdatedAfter за сутки: заказ FBA (исполняет Amazon) не читается — запрос просит только MERCHANT; заказ, изменённый трое суток назад, — вне окна. Страница — 2 заказа, вторая — по paginationToken. Вариант A-20: канал отдаёт данные покупателя без набора BUYER — до строк они не доходят (утверждение — отдельный тест).',
    world({ seed: 3, offers, orders }),
    [
      call('page-1', 'readOrderLines', [{ since: { $clockIso: -86_400_000 }, limit: 2 }], { items: expected, nextCursor: 'syn-orders-page-1' }),
      call('page-2', 'readOrderLines', [{ since: { $clockIso: -86_400_000 }, limit: 2, cursor: 'syn-orders-page-1' }],
        { items: [{ externalOrderLineRef: 'syn-oi-4', status: 'CANCELLED' }], nextCursor: { $absent: true } }),
    ],
    { noAlerts: true, channel: { stats: { requests: { searchOrders: 2 } } } },
    [{ id: 'a22-partial-not-reported', question: 'A-22', params: { partialShipmentReported: false },
      finding: 'без quantityFulfilled у строк частично отгруженного заказа отгруженная строка остаётся OPEN: резервация держится дольше, перепродажи нет',
      stepExpect: { 'page-1': { items: [expected[0], expected[1], { externalOrderLineRef: 'syn-oi-3', status: 'OPEN' }], nextCursor: 'syn-orders-page-1' } },
      expect: { noAlerts: true, channel: { stats: { requests: { searchOrders: 2 } } } } },
    { id: 'a20-buyer-without-dataset', question: 'A-20', params: { ordersBuyerWithoutDataset: true }, finding: 'данные покупателя без набора BUYER — белый список адаптера их не пропускает',
      expect: { noAlerts: true, channel: { stats: { requests: { searchOrders: 2 } } } } }]));
}

// 4. Лимит searchOrders из снимка: burst 20, 0.0056 rps — 21-й вызов отказывает ограничитель адаптера, до модели не доходит
SCENARIOS.push(scenario('amazon-sim/orders-usage-plan', 'Модель SP-API: Usage Plan searchOrders (0.0056 rps, burst 20) — ограничитель адаптера держит его сам, модель 429 не отдаёт',
  'Token bucket адаптера по таблице Usage Plan снимка: 20 вызовов подряд проходят, 21-й — RATE_LIMITED с retryAt без запроса к каналу. Модель держит тот же лимит и ответила бы 429.',
  world({ seed: 4, offers, orders: [] }),
  [
    ...Array.from({ length: 20 }, (_, i) => call(`orders-${i + 1}`, 'readOrderLines', [{ since: { $clockIso: -86_400_000 }, limit: 10 }], { items: [] })),
    call('orders-21', 'readOrderLines', [{ since: { $clockIso: -86_400_000 }, limit: 10 }], undefined, { expectThrows: { code: 'RATE_LIMITED', retryAt: { $isoInstant: true } } }),
  ],
  { noAlerts: true, channel: { stats: { rateLimited: 0, requests: { searchOrders: 20 } } } }));

// ------------------------------------------------------------------------------------------------ прогоны

test('Amazon HTTP model scenarios are valid scenarios of the stand', () => {
  for (const s of SCENARIOS) assert.deepEqual(validateScenario(s), [], s.id);
});

for (const s of SCENARIOS) {
  for (const { variant, question, scenario: v } of expandVariants(s)) {
    test(`${s.id} [${variant}${question ? `, ${question}` : ''}]`, async () => {
      const report = await runScenario(v, amazonUnderTest);
      const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.outcome}`).join('\n');
      assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
      // A-20: ни строки заказа, ни журнал не несут данных покупателя, даже если канал их прислал
      assert.ok(!JSON.stringify([report.results, report.logs]).includes('syn-model-buyer'), 'buyer data reached the results or the logs');
    });
  }
}

test('A-20 negative control: the model really sends buyer data in the variant — the whitelist, not the model, keeps it out', async () => {
  const s = SCENARIOS.find((x) => x.id === 'amazon-sim/orders')!;
  const v = expandVariants(s).find((x) => x.variant === 'a20-buyer-without-dataset')!;
  const report = await runScenario(v.scenario, amazonUnderTest);
  assert.ok(report.trace.some((t) => t.path === '/orders/2026-01-01/orders'), 'searchOrders was called');
  const { SimulatedAmazonChannel } = await import('./simulator/amazon-channel.ts');
  const model = new SimulatedAmazonChannel({ ...(v.scenario.world.channelModel as AmazonChannelModelSpec) }, v.scenario.world.clock, ACCESS_TOKEN);
  const r = model.reply({ method: 'GET', rawUrl: '', path: '/orders/2026-01-01/orders', query: { lastUpdatedAfter: '2026-09-28T10:00:00.000Z', fulfilledBy: 'MERCHANT', includedData: 'FULFILLMENT' }, rawBody: '', body: null, headers: {} },
    Date.parse(v.scenario.world.clock));
  assert.ok('reply' in r && JSON.stringify(r.reply).includes('syn-model-buyer'));
});

test('every open Amazon question of the HTTP model is exercised by a variant and exists in channel-capabilities.md', () => {
  const capabilities = readFileSync(fileURLToPath(new URL('../../../docs/channel-capabilities.md', import.meta.url)), 'utf8');
  for (const q of ['A-01', 'A-06', 'A-20', 'A-21', 'A-22', 'A-23']) assert.ok(capabilities.includes(`| ${q} |`), `${q} is not a question in channel-capabilities.md`);
  const exercised = new Set(SCENARIOS.flatMap((s) => (s.variants ?? []).map((v) => v.question)));
  // Шаг 52 (ревью шага 51, находка 12): вариант есть у каждого открытого вопроса модели; A-23 — только лимит бюджета адаптера (тест бюджета ниже)
  const asked = new Set(Object.values(AMAZON_PARAMETERS).map((p) => p.question).filter((q): q is string => q !== null));
  for (const q of ['A-01', 'A-06', 'A-20', 'A-21', 'A-22']) assert.ok(exercised.has(q), `${q} has no variant`);
  for (const q of ['A-20', 'A-21', 'A-22']) assert.ok(asked.has(q), `${q} is not a parameter of the model`);
  assert.equal(AMAZON_PARAMETERS.ordersBuyerWithoutDataset.question, 'A-20');
});

/**
 * Ревью шага 51, находка 4: у searchOrders лимит приложения не документирован (A-23) — бюджет держит только лимит пары. Два продавца одного
 * процесса не делят 20 запросов: у каждого свой burst, а приложение 429 покажет сам канал
 */
test('searchOrders budget: the undocumented application limit is not the pair limit — two sellers do not share one bucket', async () => {
  const { TwoLevelBudget } = await import('@repracer/amazon-adapter');
  const budget = new TwoLevelBudget();
  const t0 = Date.parse('2026-09-29T10:00:00.000Z');
  for (const seller of ['A1SYNSELLERA', 'A1SYNSELLERB']) {
    for (let i = 0; i < 20; i++) assert.deepEqual(budget.tryAcquire(seller, 'searchOrders', t0), { ok: true }, `${seller} call ${i + 1}`);
  }
  const refused = budget.tryAcquire('A1SYNSELLERA', 'searchOrders', t0);
  assert.equal(refused.ok === false && refused.level, 'PAIR', 'the 21st call of one seller is refused by the pair limit');
});

/**
 * Шаг 52 (страница короче запрошенной): обход через модель — страницы по 2 при запрошенных 20 и 10 и первая пустая с токеном. Каждое
 * предложение и каждая строка заказа — ровно по разу, обход конечен, нарушений стенда нет
 */
test('step 52: short pages and an empty page with a token — discovery and order lines read everything once and end', async () => {
  const { channelFetch, amazonRequestChecker } = await import('./harness/channel.ts');
  const { VirtualClock, worldDependencies } = await import('./harness/world.ts');
  const { SimulatedAmazonChannel } = await import('./simulator/amazon-channel.ts');
  const { neverWrittenAttributes } = await import('@repracer/channel-port');
  const many = Array.from({ length: 7 }, (_, i) => ({ sku: `SYN-SKU-PG-${i}`, asin: `B0SYNPG00${i}`, marketplaces: [DE], priceMinor: 1000 + i, quantity: 1 }));
  const orders: SimAmazonOrderSpec[] = Array.from({ length: 5 }, (_, i) => ({ orderId: `901-00002${i}0-0000001`, marketplace: DE, fulfilledBy: 'MERCHANT' as const, status: 'UNSHIPPED' as const,
    createdOffsetMs: -3_600_000, updatedOffsetMs: -3_600_000 + i, items: [{ orderItemId: `syn-pg-oi-${i}`, sku: many[i]!.sku, quantity: 1 }] }));
  for (const paging of [{ pageSizeCap: null, emptyPageFirst: false }, { pageSizeCap: 2, emptyPageFirst: true }]) {
    const w = world({ seed: 52, offers: many, orders, params: { paging } });
    const clock = new VirtualClock(w.clock);
    const violations: string[] = [];
    const model = new SimulatedAmazonChannel(w.channelModel as AmazonChannelModelSpec, w.clock, ACCESS_TOKEN);
    const adapter = amazonUnderTest({ deps: worldDependencies(w, clock, { logs: [], alerts: [] }), world: w, clock,
      fetch: channelFetch(model, amazonRequestChecker(w, clock, neverWrittenAttributes('AMAZON')), clock, violations, []) });
    const ctx = { tenantId: w.tenantId, channelAccountId: w.channelAccountId, correlationId: 'step52-paging', deadline: new Date(clock.nowMs() + 600_000).toISOString() } as never;
    const skus: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (; pages < 20; pages++) {
      const p = await adapter.discoverOffers(ctx, { limit: 20, ...(cursor ? { cursor } : {}) });
      skus.push(...p.items.map((o) => o.identity.externalSku!));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
      clock.advance(1_000);
    }
    assert.deepEqual(skus.sort(), many.map((o) => o.sku).sort(), `${JSON.stringify(paging)}: every offer once`);
    assert.ok(pages < 20, 'discovery ended');
    const lines: string[] = [];
    cursor = undefined;
    for (pages = 0; pages < 20; pages++) {
      const p = await adapter.readOrderLines(ctx, { since: new Date(clock.nowMs() - 86_400_000).toISOString() as never, limit: 10, ...(cursor ? { cursor } : {}) });
      lines.push(...p.items.map((l) => l.externalOrderLineRef));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    assert.deepEqual(lines.sort(), orders.map((o) => o.items[0]!.orderItemId).sort(), `${JSON.stringify(paging)}: every order line once`);
    assert.deepEqual(violations, []);
  }
});
