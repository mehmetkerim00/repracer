import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { budgetChargesOf, parseGetItem, snapshotSha256 } from '@repracer/ebay-adapter';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { ebayUnderTest } from './adapters.ts';
import { channelFetch, type TraceEntry } from './harness/channel.ts';
import { runScenario } from './harness/runner.ts';
import { expandVariants, SCENARIO_FORMAT, validateScenario, type Scenario, type Step, type World } from './harness/scenario.ts';
import { VirtualClock } from './harness/world.ts';
import { ebayGetItemXml, SimulatedEbayChannel, type EbayChannelModelSpec, type SimEbayListingSpec } from './simulator/ebay-channel.ts';
import { EBAY_PARAMETERS } from './simulator/params.ts';
import type { AdapterLogEntry, FieldWrite } from '@repracer/channel-port';
import { InMemoryPricingStore } from '@repracer/pricing-pipeline';
import { createWriteDispatcher, planOutcomeTransition, type ClaimResult, type RecordedOutcome, type WriteQueueStore } from '@repracer/write-dispatcher';
import { ebayRequestChecker } from './harness/channel.ts';
import { EBAY_STAND_HOST } from './harness/runner.ts';
import { worldDependencies, type RaisedAlert } from './harness/world.ts';

/**
 * Модель eBay в симуляторе [Р-187]: сценарии того же формата, канал с состоянием, адаптер и путь решения — настоящие. Модель повторяет
 * ответы песочницы шага 39; открытые вопросы E-nn — параметры модели (params.ts), и каждый вопрос переворачивает исход хотя бы одного
 * варианта сценария. Данные синтетические.
 */

const USER_TOKEN = 'syn-ebay-user-token-0001';
const APP_TOKEN = 'syn-ebay-app-token-0001';
const TENANT = '10000000-0000-4000-8000-000000000001';
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const MIN = 60_000;

/** Листинг n: 1300000000nn, предложение 93000000nn, SKU SYN-EBAY-S-nn */
const L = (n: number) => ({ listingId: `1300000000${String(n).padStart(2, '0')}`, offerId: `93000000${String(n).padStart(2, '0')}`, sku: `SYN-EBAY-S-${String(n).padStart(2, '0')}` });
const listing = (n: number, extra: Partial<SimEbayListingSpec> = {}): SimEbayListingSpec => ({ ...L(n), marketplace: 'EBAY_DE', priceMinor: 1149, quantity: 5, ...extra });

function world(model: EbayChannelModelSpec, extra: Partial<World> = {}): World {
  return {
    clock: '2026-09-28T10:00:00.000Z', tenantId: TENANT, channelAccountId: ACCOUNT,
    account: { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_DE'], channel: 'EBAY' },
    credentials: {
      seller: { refreshToken: 'syn-ebay-refresh-token-0001' }, application: { clientId: 'Syn-Repracer-SBX-0001', clientSecret: 'SBX-syn-client-secret-0001' },
      accessToken: USER_TOKEN, applicationToken: APP_TOKEN,
    },
    // Клиентский бюджет адаптера не должен заслонять поведение модели (E-04 проверяется её параметром)
    budget: { seller: { ratePerSecond: 100, burst: 100 } },
    channelModel: model, ...extra,
  };
}

function scenario(id: string, title: string, description: string, w: World, steps: Step[], expect: Scenario['expect'], variants: NonNullable<Scenario['variants']> = []): Scenario {
  return {
    format: SCENARIO_FORMAT, id, channel: 'EBAY', apiVersion: 'sell-inventory-v1 (model of the sandbox 2026-09-27)', title, description, tags: ['simulator', 'ebay'],
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: ['docs/evidence/step39-ebay-sandbox.md', 'docs/decisions.md#Р-187', 'docs/channel-capabilities.md#9'] },
    world: w, steps, exchanges: [], expect, ...(variants.length > 0 ? { variants } : {}),
  };
}

const identity = (n: number, migrated = true) => ({ marketplace: 'EBAY_DE', externalSku: L(n).sku, ...(migrated ? { externalOfferId: L(n).offerId } : {}), externalListingId: L(n).listingId });
const priceWrite = (id: string, n: number, minor: number, o: { attemptNo?: number; currency?: string; migrated?: boolean } = {}) => ({
  channelWriteId: id, version: 1, idempotencyKey: `${id}:1`, attemptNo: o.attemptNo ?? 1,
  writeScope: { writeScopeId: `ws-sim-price-${n}`, field: 'PRICE', scopeKey: `ebay|acct|EBAY_DE|${L(n).sku}`, identity: identity(n, o.migrated ?? true) },
  value: { field: 'PRICE', price: { amountMinor: minor, currency: o.currency ?? 'EUR', basis: 'GROSS' } },
});
const quantityWrite = (id: string, n: number, quantity: number) => ({
  channelWriteId: id, version: 1, idempotencyKey: `${id}:1`, attemptNo: 1,
  writeScope: { writeScopeId: `ws-sim-qty-${n}`, field: 'QUANTITY', scopeKey: `ebay|acct|EBAY_DE|${L(n).sku}`, identity: identity(n) },
  value: { field: 'QUANTITY', quantity },
});
type Write = ReturnType<typeof priceWrite> | ReturnType<typeof quantityWrite>;
const batch = (batchId: string, items: Write[]) => ({ batchId, operation: 'bulkUpdatePriceQuantity', items, budgetCharges: budgetChargesOf(items as never), requestCount: 1 });
const call = (id: string, method: string, args: unknown[], expect?: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'call', method, args, ...(expect !== undefined ? { expect } : {}), ...extra }) as Step;
const wait = (id: string, ms: number) => ({ id, kind: 'advanceClock', ms }) as Step;
const confirmOf = (w: Write, dispatchedAgoMs = 0) => ({ channelWriteId: w.channelWriteId, writeScope: w.writeScope, expected: w.value, dispatchedAt: { $clockIso: -dispatchedAgoMs } });

// ------------------------------------------------------------------------------------------------ сценарии

const SCENARIOS: Scenario[] = [];

// 1. E-17 и Р-186: цена покупателя с НДС сверху через путь решения
{
  const scope: MemorySeedScope = {
    writeScopeId: 'ws-sim-price-1', productId: 'prod-sim-1', channelAccountId: ACCOUNT, marketplace: 'EBAY_DE', externalUnitId: L(1).sku,
    externalOfferId: L(1).offerId, externalListingId: L(1).listingId, channelProductRef: L(1).listingId, condition: 'new', currency: 'EUR', basis: 'GROSS',
    pricingMode: 'ENGINE', strategy: { strategyId: 'st-sim-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1349 }, deadbandMinor: 0 },
    currentPriceMinor: 1149, minPrice: { amountMinor: 1000, id: 'min-sim-1' }, maxPrice: { amountMinor: 5000, id: 'max-sim-1' },
    cost: { currency: 'EUR', costProfileId: 'cp-sim-1', unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1100, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  };
  const readBack = call('read-back-30-min-later', 'readBack', [[{ writeScope: priceWrite('x', 1, 1349).writeScope, fields: ['PRICE'] }]],
    { failures: [], observations: [{ value: { price: { amountMinor: 1349 } }, buyerPrice: { amountMinor: 1605 }, effectivePrice: { $absent: true } }] });
  const reconcile = { id: 'reconcile-after-window', kind: 'pipelineDispatchDue', expect: { due: 1, reports: [{ steps: [{ action: 'RECONCILED', result: 'APPLIED', recorded: 'APPLIED' }, { action: 'IDLE' }] }] } } as Step;
  SCENARIOS.push(scenario('ebay-sim/pipeline-buyer-price-vat', 'Р-186 на модели eBay: цена 13.49 уходит и подтверждается; НДС сверху в Browse не ведёт к недоверию каналу',
    'Путь решения и диспетчер с моделью eBay. Песочница (E-17): через ~25 минут после первых записей Browse показывает цену продавца × 1,19 без новой ревизии. Сверка через 2 минуты видит цену продавца — APPLIED; чтение через 30 минут — значение 13.49, цена покупателя 16.05 в buyerPrice, журнал EBAY_C14. Ни в одном варианте нет остановки по недоверию каналу: цена покупателя eBay не идёт в Р-116.',
    world({ seed: 1, listings: [listing(1)] }, { pricing: { scopes: [scope] } }),
    [
      { id: 'fixed-price', kind: 'pipelineRecompute', writeScopeId: 'ws-sim-price-1', trigger: { type: 'COST_CHANGE' }, expect: { decision: { outcome: 'APPROVED', finalMinor: 1349 }, dispatch: { status: 'ACCEPTED' } } } as Step,
      wait('in-flight-window', 121_000), reconcile, wait('half-an-hour', 30 * MIN), readBack,
    ],
    { alerts: [{ code: 'EBAY_BUYER_PRICE_VAT_ON_TOP', severity: 'WARNING', count: 1, details: { vatBasisPoints: 1900 } }], logs: [{ code: 'EBAY_C14_BROWSE_PRICE_WITH_VAT', count: 1 }], pipeline: { distrusts: [], writes: [{ amountMinor: 1349, status: 'APPLIED' }] },
      channel: { listings: [{ livePriceMinor: 1349, offer: { priceMinor: 1349 } }], stats: { itemsApplied: 1 } } },
    [
      { id: 'e17-business-seller-gross', question: 'E-17', params: { buyerPriceTax: { mode: 'NONE' } }, finding: 'цена покупателя = цене продавца: C14 не пишется',
        stepExpect: { 'read-back-30-min-later': { observations: [{ value: { price: { amountMinor: 1349 } }, buyerPrice: { amountMinor: 1349 } }] } },
        expect: { noAlerts: true, noLogCodes: ['EBAY_C14_BROWSE_PRICE_WITH_VAT'], pipeline: { distrusts: [], writes: [{ status: 'APPLIED' }] } } },
      { id: 'e17-vat-on-top-at-once', question: 'E-17', params: { buyerPriceTax: { mode: 'VAT_ON_TOP', rateBp: 1900, afterFirstWriteMs: 0 } },
        finding: 'сверка диспетчера сама видит 16.05 — запись APPLIED, недоверия нет (Р-186)',
        expect: { alerts: [{ code: 'EBAY_BUYER_PRICE_VAT_ON_TOP', severity: 'WARNING', count: 1, details: { vatBasisPoints: 1900 } }], logs: [{ code: 'EBAY_C14_BROWSE_PRICE_WITH_VAT', count: 2 }], pipeline: { distrusts: [], writes: [{ status: 'APPLIED' }] } } },
    ]));
}

// 2. E-06: количество 0 и возврат остатка
{
  const zero = quantityWrite('cw-q0', 2, 0);
  const five = quantityWrite('cw-q5', 2, 5);
  SCENARIOS.push(scenario('ebay-sim/quantity-zero-and-restock', 'E-06 на модели: количество 0 — 25004 при применённой записи и OUT_OF_STOCK; запись 5 статус не снимает',
    'Как песочница: offers[].availableQuantity=0 — 400 25004, но availableQuantity 0 и листинг OUT_OF_STOCK, не завершён. Адаптер: OUTCOME_UNKNOWN, итог — обратным чтением (EBAY_C04). Количество 5 — 200, листинг остаётся OUT_OF_STOCK. Варианты — возможные ответы боевого канала.',
    world({ seed: 2, listings: [listing(2)] }),
    [
      call('dispatch-zero', 'dispatch', [batch('b-q0', [zero])], { outcomes: [{ status: 'OUTCOME_UNKNOWN', error: { channelCode: '25004' } }] }),
      call('confirm-zero', 'confirm', [[confirmOf(zero)]], [{ status: 'APPLIED', observation: { value: { quantity: 0 }, liveness: { isLive: false, reasons: ['OUT_OF_STOCK'] } } }]),
      call('dispatch-five', 'dispatch', [batch('b-q5', [five])], { outcomes: [{ status: 'ACCEPTED' }] }),
      call('confirm-five', 'confirm', [[confirmOf(five)]], [{ status: 'APPLIED', observation: { value: { quantity: 5 }, liveness: { isLive: false, reasons: ['OUT_OF_STOCK'] } } }]),
    ],
    { noAlerts: true, logs: [{ code: 'EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN', question: 'E-06', count: 1 }], channel: { listings: [{ status: 'OUT_OF_STOCK', offer: { availableQuantity: 5 } }] } },
    [
      { id: 'e06-zero-not-applied', question: 'E-06', params: { quantityZero: 'ERROR_25004_NOT_APPLIED' }, finding: 'OUTCOME_UNKNOWN остаётся верным: подтверждение видит 5 — PENDING, а не ложный отказ',
        stepExpect: {
          'confirm-zero': [{ status: 'PENDING' }],
          'confirm-five': [{ status: 'APPLIED', observation: { value: { quantity: 5 }, liveness: { isLive: true } } }],
        },
        expect: { noAlerts: true, channel: { listings: [{ status: 'ACTIVE', offer: { availableQuantity: 5 } }] } } },
      { id: 'e06-zero-ends-listing', question: 'E-06', params: { quantityZero: 'APPLIED_LISTING_ENDED' }, finding: 'листинг завершён — запись 5 отклоняется каналом; предполётная C11 стала бы BLOCKER',
        stepExpect: {
          'dispatch-zero': { outcomes: [{ status: 'ACCEPTED' }] },
          'confirm-zero': [{ status: 'APPLIED', observation: { value: { quantity: 0 }, liveness: { isLive: false, reasons: ['ENDED'] } } }],
          'dispatch-five': { outcomes: [{ status: 'REJECTED', error: { code: 'UNKNOWN', httpStatus: 400 } }] },
          'confirm-five': [{ status: 'PENDING' }],
        },
        expect: { noAlerts: true, channel: { listings: [{ status: 'ENDED' }] } } },
      { id: 'e06-restock-clears', question: 'E-06', params: { restockClearsOutOfStock: true }, finding: 'листинг снова живой после записи 5',
        stepExpect: { 'confirm-five': [{ status: 'APPLIED', observation: { value: { quantity: 5 }, liveness: { isLive: true, reasons: [] } } }] },
        expect: { noAlerts: true, channel: { listings: [{ status: 'ACTIVE' }] } } },
    ]));
}

// 3. Ответы по элементам: 207 с 25016 и 25604
{
  const ok = priceWrite('cw-ok', 3, 1290);
  const low = priceWrite('cw-low', 4, 50);
  const foreign = { ...priceWrite('cw-unknown', 99, 1290) };
  SCENARIOS.push(scenario('ebay-sim/bulk-item-errors', 'Смешанный пакет: 207 — 200, 25016 с MinValue и 25604; принятое применено, отклонённые без повтора',
    'Как песочница: у верного предложения 200, у цены 0.50 — 400 25016 «below the minimum price of EUR 1.00» с параметром MinValue, у чужого предложения — 400 25604 «Offer not found». Отказы по элементу ревизию листинга не увеличивают.',
    world({ seed: 3, listings: [listing(3), listing(4)] }),
    [call('dispatch-mixed', 'dispatch', [batch('b-mixed', [ok, low, foreign])], { attemptsMade: 1, outcomes: [
      { channelWriteId: 'cw-ok', status: 'ACCEPTED' },
      { channelWriteId: 'cw-low', status: 'REJECTED', error: { code: 'VALIDATION', channelCode: '25016', message: { $regex: 'MinValue EUR 1\\.00' } } },
      { channelWriteId: 'cw-unknown', status: 'REJECTED', error: { code: 'NOT_FOUND', channelCode: '25604' } },
    ] })],
    { noAlerts: true, channel: { listings: [{ livePriceMinor: 1290, sellerItemRevision: 2 }, { livePriceMinor: 1149, sellerItemRevision: 1 }], stats: { itemsApplied: 1, itemsRejected: 2 } } }));
}

// 4. E-16: правка листинга другим инструментом
{
  const w = priceWrite('cw-rb', 5, 1499);
  SCENARIOS.push(scenario('ebay-sim/other-tool-revise', 'E-16 на модели: ReviseFixedPriceItem другого инструмента меняет живой листинг, но не предложение',
    'Как песочница после миграции: Trading API изменил живую цену (13.99), GET offer показывает 14.99. Р-186: наблюдение несёт живую цену из Browse, алерт EBAY_OFFER_LISTING_DIVERGENCE. Вариант: боевой канал блокирует правки Trading после миграции (Р-2) — живая цена остаётся нашей.',
    world({ seed: 5, listings: [listing(5, { priceMinor: 1499 })] }),
    [
      { id: 'other-tool-revises', kind: 'channelRevise', listingId: L(5).listingId, priceMinor: 1399, expect: { applied: true } } as Step,
      call('read-back', 'readBack', [[{ writeScope: w.writeScope, fields: ['PRICE'] }]], { observations: [{ value: { price: { amountMinor: 1399 } }, buyerPrice: { amountMinor: 1399 } }] }),
    ],
    { alerts: [{ code: 'EBAY_OFFER_LISTING_DIVERGENCE', count: 1 }], channel: { listings: [{ livePriceMinor: 1399, offer: { priceMinor: 1499 } }], stats: { otherToolRevisions: 1 } } },
    [{ id: 'e16-trading-refused-after-migration', question: 'E-16', params: { tradingReviseAfterMigration: 'REFUSED' }, finding: 'расхождения нет, алерта нет',
      stepExpect: { 'other-tool-revises': { applied: false, reason: 'MANAGED_BY_INVENTORY_API' }, 'read-back': { observations: [{ value: { price: { amountMinor: 1499 } } }] } },
      expect: { noAlerts: true, channel: { listings: [{ livePriceMinor: 1499 }], stats: { otherToolRefused: 1 } } } }]));
}

// 5. E-02: 250 правок листинга в день
{
  const first = priceWrite('cw-e1', 6, 1290);
  const second = priceWrite('cw-e2', 6, 1280, { attemptNo: 2 });
  SCENARIOS.push(scenario('ebay-sim/listing-edit-limit', 'E-02 на модели: песочница 250 правок не применяет; если бой применяет — 251-я правка отклоняется каналом',
    'Сегодня по листингу уже 249 правок другими инструментами (второй слой адаптера о них не знает — он считает только свои попытки). Песочница: 260 правок подряд — все 200, поэтому по умолчанию обе записи приняты. Вариант «канал применяет 250 в день»: 250-я правка проходит, 251-я — отказ по элементу без известного кода ошибки; адаптер отказывает UNKNOWN, повтора нет. Вывод: второй слой адаптера (190 цене) не защищает от чужих правок — первым слоем остаётся база и граница суток (Р-163).',
    world({ seed: 6, listings: [listing(6, { revisionsToday: 249 })] }),
    [
      call('edit-250', 'dispatch', [batch('b-e1', [first])], { outcomes: [{ status: 'ACCEPTED' }] }),
      call('edit-251', 'dispatch', [batch('b-e2', [second])], { outcomes: [{ status: 'ACCEPTED' }] }),
    ],
    { noAlerts: true, channel: { listings: [{ livePriceMinor: 1280, editsToday: 251 }], stats: { editLimited: 0 } } },
    [{ id: 'e02-channel-enforces-250', question: 'E-02', params: { listingEditLimit: { perDay: 250, countsFailed: true, status: 400 } },
      finding: 'канал отвечает отказом по элементу без errorId — адаптер: REJECTED UNKNOWN (нужен код ошибки от поддержки)',
      stepExpect: { 'edit-251': { outcomes: [{ status: 'REJECTED', error: { code: 'UNKNOWN', httpStatus: 400 } }] } },
      expect: { noAlerts: true, channel: { listings: [{ livePriceMinor: 1290 }], stats: { editLimited: 1 } } } }]));
}

// 6. E-04: лимит запросов
{
  const w = priceWrite('cw-r', 7, 1290);
  SCENARIOS.push(scenario('ebay-sim/request-limit', 'E-04 на модели: лимита запросов в песочнице нет; при лимите 3 на 15 секунд четвёртая запись — 429',
    'Четыре записи подряд одной секунды. Песочница (заглушка «100 вызовов на 15 с») не отказывала — по умолчанию все приняты. Вариант с лимитом: 429, адаптер — RATE_LIMITED с повтором не раньше чем через 60 секунд (EBAY_C01), запись транспортом не повторяется.',
    world({ seed: 7, listings: [listing(7)] }),
    [1, 2, 3, 4].map((i) => call(`write-${i}`, 'dispatch', [batch(`b-r${i}`, [{ ...w, attemptNo: i }])], { outcomes: [{ status: 'ACCEPTED' }] })),
    { noAlerts: true, channel: { stats: { rateLimited: 0, itemsApplied: 4 } } },
    [{ id: 'e04-3-per-15s', question: 'E-04', params: { requestLimit: { calls: 3, windowMs: 15_000 } }, finding: 'четвёртая — RATE_LIMITED, retryAt +60 с',
      stepExpect: { 'write-4': { attemptsMade: 1, outcomes: [{ status: 'REJECTED', error: { code: 'RATE_LIMITED', httpStatus: 429, retryAt: { $clockIso: 60_000 } } }] } },
      expect: { logs: [{ code: 'EBAY_C01_REQUEST_BUDGET', count: 1 }], channel: { stats: { rateLimited: 1, itemsApplied: 3 } } } }]));
}

// 7. E-12: валюта и три знака — адаптер не допускает
{
  const usd = priceWrite('cw-usd', 8, 1049, { currency: 'USD' });
  SCENARIOS.push(scenario('ebay-sim/currency-guard', 'E-12 на модели: цена в USD у предложения EBAY_DE не уходит в канал — песочница сохранила бы её молча',
    'Модель, как песочница, принимает чужую валюту и округляет три знака вверх молча и отмечает это нарушением стенда. Адаптер сверяет валюту с витриной и пишет ровно два знака сам (EBAY_C03): запрос записи не отправляется ни при каком ответе канала.',
    world({ seed: 8, listings: [listing(8)] }),
    [call('usd-refused-locally', 'dispatch', [batch('b-usd', [usd])], { attemptsMade: 0, outcomes: [{ status: 'REJECTED', error: { code: 'VALIDATION' } }] })],
    { noAlerts: true, logs: [{ code: 'EBAY_C03_LOCAL_CURRENCY_AND_SCALE', count: 1 }], channel: { listings: [{ liveCurrency: 'EUR', offer: { currency: 'EUR' } }], stats: { foreignCurrencyStored: 0, roundedUpSilently: 0, itemsApplied: 0 }, violations: [] } },
    [{ id: 'e12-channel-rejects', question: 'E-12', params: { foreignCurrency: 'REJECTED_25709', subCentPrice: 'REJECTED_25709' }, finding: 'исход тот же: адаптер от ответа канала не зависит' }]));
}

// 8. E-13: задержка Browse
{
  const w = priceWrite('cw-lag', 9, 1290);
  SCENARIOS.push(scenario('ebay-sim/browse-lag', 'E-13 на модели: Browse видит правку сразу — APPLIED; с задержкой 15 минут — PENDING, затем NOT_APPLIED по окну 10 минут',
    'Подтверждение цены — живой листинг Browse (Р-186). Задержку Browse песочница не измеряла. При задержке дольше окна подтверждения (10 мин, EBAY_C05) адаптер объявляет NOT_APPLIED применённую запись — это находка: окно должно быть больше задержки Browse.',
    world({ seed: 9, listings: [listing(9)] }),
    [
      call('dispatch', 'dispatch', [batch('b-lag', [w])], { outcomes: [{ status: 'ACCEPTED' }] }),
      call('confirm-now', 'confirm', [[confirmOf(w)]], [{ status: 'APPLIED' }]),
      wait('eleven-minutes', 11 * MIN),
      call('confirm-after-window', 'confirm', [[confirmOf(w, 11 * MIN)]], [{ status: 'APPLIED' }]),
    ],
    { noAlerts: true },
    [{ id: 'e13-browse-lag-15-min', question: 'E-13', params: { browseLagMs: 15 * MIN }, finding: 'применённая запись объявлена NOT_APPLIED: окно 10 мин меньше задержки',
      stepExpect: { 'confirm-now': [{ status: 'PENDING' }], 'confirm-after-window': [{ status: 'NOT_APPLIED', observation: { value: { price: { amountMinor: 1149 } } } }] },
      expect: { alerts: [{ code: 'EBAY_OFFER_LISTING_DIVERGENCE', count: 2 }] } }]));
}

// 9. E-15: миграция и Best Offer
{
  const facts = parseGetItem(ebayGetItemXml({ listingId: L(10).listingId, sku: L(10).sku, format: 'FIXED_PRICE', bestOffer: true, priceMinor: 1499, quantity: 4, currency: 'EUR' }));
  if (!facts.ok) throw new Error(facts.error);
  const proof = { migrationConsentId: 'mc-sim-0001', listingId: L(10).listingId, listingSnapshotSha256: snapshotSha256({ ...facts.facts, outOfStockControl: false }), offerMappingStatus: 'MIGRATION_STARTED' };
  const after = priceWrite('cw-mig', 10, 1449);
  const qty = quantityWrite('cw-mig-qty', 10, 4);
  const qty6 = quantityWrite('cw-mig-qty6', 10, 6);
  SCENARIOS.push(scenario('ebay-sim/migration-best-offer', 'E-15 на модели: до миграции запись не уходит; после — предложение без количества, Best Offer сохранён (как песочница); пустое количество — «нет данных»',
    'Старый листинг Trading API с Best Offer. Запись по нему адаптер отклоняет до обращения к каналу (Р-164). Предполётная проверка — READY_WITH_LOSSES (Best Offer — потеря по Р-2, EBAY_C10), миграция по доказательству согласия — предложение появилось без availableQuantity, как в песочнице (EBAY_C07; шаг 50: у SYN-SKU-39-LEGACY поле пустое, Browse показывает 4). Шаг 51: пустое поле — «нет данных»: обратное чтение не даёт наблюдения (ни 0, ни 4 с другого уровня), подтверждение — UNKNOWN даже после окна (не NOT_APPLIED: повторной отправки нет и расхождения с нашим значением нет). Наша запись количества заполняет поле, и дальше чтение работает как обычно. Вариант: бой теряет Best Offer.',
    world({ seed: 10, listings: [listing(10, { offerId: undefined, migratedOfferId: L(10).offerId, priceMinor: 1499, quantity: 4, bestOffer: true })] }),
    [
      call('write-before-migration', 'planDispatch', [[priceWrite('cw-pre', 10, 1449, { migrated: false })]], { batches: [], rejected: [{ error: { code: 'PRECONDITION_FAILED' } }] }),
      call('preflight', 'preflight', [[L(10).listingId]], [{ listingId: L(10).listingId, verdict: 'READY_WITH_LOSSES', listingSnapshotSha256: proof.listingSnapshotSha256 }]),
      call('migrate', 'migrate', [[proof]], [{ listingId: L(10).listingId, status: 'MIGRATED', externalOfferIds: [L(10).offerId] }]),
      call('price-after-migration', 'dispatch', [batch('b-mig', [after])], { outcomes: [{ status: 'ACCEPTED' }] }),
      call('quantity-read-back', 'readBack', [[{ writeScope: qty.writeScope, fields: ['QUANTITY'] }]],
        { observations: [], failures: [{ error: { code: 'UNKNOWN', channelCode: 'OFFER_QUANTITY_ABSENT' } }] }),
      // Даже после окна подтверждения пустое поле — не «не применено» (иначе ядро отправило бы запись заново) и не 0
      call('quantity-confirm-empty', 'confirm', [[confirmOf(qty, 11 * MIN)]], [{ status: 'UNKNOWN', error: { code: 'UNKNOWN', channelCode: 'OFFER_QUANTITY_ABSENT' } }]),
      call('quantity-write', 'dispatch', [batch('b-mig-qty', [qty6])], { outcomes: [{ status: 'ACCEPTED' }] }),
      call('quantity-read-back-after-write', 'readBack', [[{ writeScope: qty6.writeScope, fields: ['QUANTITY'] }]],
        { observations: [{ field: 'QUANTITY', value: { quantity: 6 } }], failures: [] }),
    ],
    { noAlerts: true, logs: [{ code: 'EBAY_R164_WRITE_TO_UNMIGRATED_LISTING', count: 1 }, { code: 'EBAY_C07_QUANTITY_LEVEL_OFFER', count: 2 }],
      channel: { listings: [{ bestOffer: true, livePriceMinor: 1449, offer: { offerId: L(10).offerId, availableQuantity: 6, bestOffer: true } }], stats: { migrations: 1 } } },
    [{ id: 'e15-best-offer-lost', question: 'E-15', params: { bestOfferOnMigration: 'LOST' }, finding: 'Best Offer потерян — как предупреждает предполётная C03',
      expect: { noAlerts: true, channel: { listings: [{ bestOffer: false, offer: { bestOffer: false } }], stats: { migrations: 1 } } } }]));
}

// 10. E-22 (Р-189): пакет разных SKU у БОЕВОГО аккаунта — проба пакетом из 2 SKU
{
  const w11 = priceWrite('cw-11', 11, 1311);
  const w12 = priceWrite('cw-12', 12, 1312);
  const w13 = priceWrite('cw-13', 13, 1313);
  const live = { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_DE'], channel: 'EBAY', writeMode: 'LIVE' as const, ebayBatchMode: 'PROBE' as const };
  SCENARIOS.push(scenario('ebay-sim/multi-sku-probe', 'E-22 на модели: боевой аккаунт в пробе — один пакет из 2 SKU, остальные по одному; песочница пакет принимает',
    'Р-189: описание bulkUpdatePriceQuantity — «Only one SKU (one product) can be updated per call», схема и песочница — до 25 разных SKU. Боевой аккаунт без доказанного режима (проба) отправляет ОДИН пакет из 2 SKU, остальные записи — по одной (EBAY_C18). Песочница пакет принимает: итог пакета «принят» — база переведёт аккаунт в MULTI. Вариант: канал отвергает вызов с разными SKU целиком (400 без ответов по элементам, код ошибки синтетический) — адаптер отдаёт TRANSIENT (значение канал не оценивал), итог «отвергнут», база переведёт аккаунт в «1 SKU на вызов» с алертом; ядро такой ответ 4xx не повторяет (шаг 51, правило канала).',
    world({ seed: 11, listings: [listing(11), listing(12), listing(13)] }, { account: live }),
    [
      call('plan-probe', 'planDispatch', [[w11, w12, w13]], { rejected: [], batches: [{ items: [{ channelWriteId: 'cw-11' }, { channelWriteId: 'cw-12' }] }, { items: [{ channelWriteId: 'cw-13' }] }] }),
      call('dispatch-probe', 'dispatch', [batch('b-probe', [w11, w12])], { attemptsMade: 1, ebayBatchOutcome: { multiSkuAccepted: true }, outcomes: [{ status: 'ACCEPTED' }, { status: 'ACCEPTED' }] }),
      call('dispatch-single', 'dispatch', [batch('b-single', [w13])], { ebayBatchOutcome: { $absent: true }, outcomes: [{ status: 'ACCEPTED' }] }),
    ],
    { noAlerts: true, logs: [{ code: 'EBAY_C18_MULTI_SKU_PROBE', question: 'E-22', count: 1 }], channel: { stats: { itemsApplied: 3, multiSkuRefused: 0 } } },
    [{ id: 'e22-multi-sku-refused', question: 'E-22', params: { multiSkuPerCall: 'REFUSED_WHOLE_REQUEST' },
      finding: 'пакет из 2 SKU отвергнут целиком — итог «отвергнут», записи TRANSIENT без повтора ядром (ответ 4xx, шаг 51); запись одного SKU проходит',
      stepExpect: { 'dispatch-probe': { attemptsMade: 1, ebayBatchOutcome: { multiSkuAccepted: false }, outcomes: [
        { status: 'REJECTED', error: { class: 'TRANSIENT', code: 'ACTION_NOT_ALLOWED', channelCode: '99022', httpStatus: 400 } },
        { status: 'REJECTED', error: { class: 'TRANSIENT', code: 'ACTION_NOT_ALLOWED', channelCode: '99022', httpStatus: 400 } }] } },
      expect: { noAlerts: true, logs: [{ code: 'EBAY_C18_MULTI_SKU_PROBE', question: 'E-22', count: 2 }], channel: { stats: { itemsApplied: 1, multiSkuRefused: 1 } } } }]));
}

// 11. Р-191: условия bulkMigrateListing — немедленная оплата и город листинга
{
  const noLocation = listing(14, { offerId: undefined, migratedOfferId: L(14).offerId, itemLocation: false });
  SCENARIOS.push(scenario('ebay-sim/migration-requirements', 'Р-191 на модели: без немедленной оплаты в платёжной политике и без индекса или города листинг — FIXABLE до миграции, а не отказ 25718 при ней',
    'Документация bulkMigrateListing (снимок 2026-09-28): платёжная политика с немедленной оплатой (`immediatePay` Account API) и `PostalCode` или `Location` в листинге. Модель: у листинга 14 нет города, у платёжной политики модели немедленная оплата выключена — два препятствия C14 и C15, вердикт FIXABLE. Ответ Account API синтетический (песочница этот вызов не делала).',
    world({ seed: 14, immediatePay: false, listings: [noLocation] }),
    [call('preflight', 'preflight', [[L(14).listingId]], [{ listingId: L(14).listingId, verdict: 'FIXABLE', findings: { $contains: [
      { code: 'C14_IMMEDIATE_PAY', severity: 'BLOCKER' }, { code: 'C15_LOCATION', severity: 'BLOCKER' }] } }])],
    { noAlerts: true, channel: { stats: { migrations: 0 } } }));
}

// 12. Шаг 51, хвост E-23: аккаунт витрины EBAY_US — REST-вызовы с Accept-Language en-US
{
  const us = { ...priceWrite('cw-us-15', 15, 1599, { currency: 'USD' }) };
  us.writeScope = { ...us.writeScope, scopeKey: `ebay|acct|EBAY_US|${L(15).sku}`, identity: { ...us.writeScope.identity, marketplace: 'EBAY_US' } };
  us.value = { field: 'PRICE', price: { amountMinor: 1599, currency: 'USD', basis: 'NET' } };
  SCENARIOS.push(scenario('ebay-sim/us-storefront-accept-language', 'E-23 на модели: аккаунт EBAY_US — обнаружение и запись цены с Accept-Language en-US',
    'Шаг 50: без Accept-Language песочница отвечает на GET inventory_item 400 25709 — модель тоже. Язык — первой витрины аккаунта: у аккаунта EBAY_US — en-US. Стенд считает чужой язык нарушением (проверка запросов); ответ модели на en-US — тот же, что на de-DE: как eBay US отвечает на язык, не проверено — US-листинга в песочнице нет (E-23).',
    world({ seed: 15, listings: [listing(15, { marketplace: 'EBAY_US' })] }, { account: { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_US'], channel: 'EBAY' } }),
    [
      call('discover', 'discoverOffers', [{ limit: 10 }], { items: [{ identity: { marketplace: 'EBAY_US', externalSku: L(15).sku } }] }),
      call('price', 'dispatch', [batch('b-us', [us as Write])], { outcomes: [{ status: 'ACCEPTED' }] }),
    ],
    { noAlerts: true, channel: { listings: [{ offer: { priceMinor: 1599, currency: 'USD' } }] } }));
}

// ------------------------------------------------------------------------------------------------ прогоны

const variantsRun: string[] = [];

test('eBay simulator scenarios are valid scenarios of the stand', () => {
  for (const s of SCENARIOS) assert.deepEqual(validateScenario(s), [], s.id);
});

for (const s of SCENARIOS) {
  for (const { variant, question, finding, scenario: v } of expandVariants(s)) {
    test(`${s.id} [${variant}${question ? `, ${question}` : ''}]`, async () => {
      const report = await runScenario(v, ebayUnderTest);
      variantsRun.push(`${question ?? '—'} ${s.id}#${variant}${finding ? `: ${finding}` : ''}`);
      const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.outcome}`).join('\n');
      assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
    });
  }
}

test('every open eBay question in the model is exercised by a scenario variant and exists in channel-capabilities.md', () => {
  const asked = new Set(Object.values(EBAY_PARAMETERS).map((p) => p.question).filter((q): q is string => q !== null));
  assert.deepEqual([...asked].sort(), ['E-02', 'E-04', 'E-06', 'E-12', 'E-13', 'E-15', 'E-16', 'E-17', 'E-22']);
  const exercised = new Set(SCENARIOS.flatMap((s) => (s.variants ?? []).map((v) => v.question)));
  assert.deepEqual([...asked].filter((q) => !exercised.has(q)).sort(), []);
  const capabilities = readFileSync(fileURLToPath(new URL('../../../docs/channel-capabilities.md', import.meta.url)), 'utf8');
  for (const q of asked) assert.ok(capabilities.includes(`| ${q} |`), `${q} is not a question in channel-capabilities.md`);
  for (const p of Object.values(EBAY_PARAMETERS)) assert.equal(p.status, 'OPEN', 'Р-162: the sandbox proves nothing about the live channel');
});

// ------------------------------------------------------------------------------------------------ ответы модели напрямую

function direct(model: EbayChannelModelSpec) {
  const clock = new VirtualClock('2026-09-28T10:00:00.000Z');
  const channel = new SimulatedEbayChannel(model, clock.iso(), { user: USER_TOKEN, application: APP_TOKEN });
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const fetch = channelFetch(channel, () => [], clock, violations, trace);
  const bulk = async (offers: Array<Record<string, unknown>>) => {
    const r = await fetch('https://api.sandbox.ebay.com/sell/inventory/v1/bulk_update_price_quantity', { method: 'POST', body: JSON.stringify({ requests: offers.map((o) => ({ offers: [o] })) }) });
    return { status: r.status, body: await r.json() as { responses?: Array<{ statusCode: number; errors?: Array<{ errorId?: number; parameters?: unknown }> }>; errors?: Array<{ errorId: number }> } };
  };
  const get = async (path: string) => {
    const r = await fetch(`https://api.sandbox.ebay.com${path}`, { method: 'GET' });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  return { channel, clock, bulk, get };
}

test('Р-187: the model answers like the sandbox — silent round-up of three decimals and a foreign currency stored, both recorded as stand violations', async () => {
  const m = direct({ seed: 1, listings: [listing(1), listing(2)] });
  const r1 = await m.bulk([{ offerId: L(1).offerId, price: { value: '11.999', currency: 'EUR' } }]);
  assert.equal(r1.status, 200);
  assert.deepEqual(((await m.get(`/sell/inventory/v1/offer/${L(1).offerId}`)).body.pricingSummary as { price: unknown }).price, { value: '12.00', currency: 'EUR' });
  const r2 = await m.bulk([{ offerId: L(2).offerId, price: { value: '10.49', currency: 'USD' } }]);
  assert.equal(r2.status, 200);
  assert.deepEqual(((await m.get(`/sell/inventory/v1/offer/${L(2).offerId}`)).body.pricingSummary as { price: unknown }).price, { value: '10.49', currency: 'USD' });
  assert.equal(m.channel.finish().length, 2, 'the stand flags both: the adapter must never send them (EBAY_C03)');
});

test('Р-187: request-level refusals — 25709 on an invalid value and 25712 on 26 requests, nothing applied; 25604 by SKU and 25713 for a listing not under Inventory API', async () => {
  const m = direct({ seed: 2, listings: [listing(1), listing(3, { offerId: undefined })] });
  for (const value of ['-1.00', 'abc']) {
    const r = await m.bulk([{ offerId: L(1).offerId, price: { value: '12.50', currency: 'EUR' } }, { offerId: L(1).offerId, price: { value, currency: 'EUR' } }]);
    assert.equal(r.status, 400);
    assert.equal(r.body.responses, undefined, 'no per-item answer: the whole request is refused');
    assert.equal(r.body.errors?.[0]?.errorId, 25709);
  }
  const big = await m.bulk(Array.from({ length: 26 }, () => ({ offerId: L(1).offerId, availableQuantity: 3 })));
  assert.equal(big.status, 400);
  assert.equal(big.body.errors?.[0]?.errorId, 25712);
  const legacy = await m.bulk([{ sku: L(3).sku, price: { value: '12.50', currency: 'EUR' } }]);
  assert.equal(legacy.body.responses?.[0]?.errors?.[0]?.errorId, 25604);
  const bySku = await m.get(`/sell/inventory/v1/offer?sku=${L(3).sku}`);
  assert.equal(bySku.status, 404);
  assert.equal((bySku.body.errors as Array<{ errorId: number }>)[0]!.errorId, 25713);
  assert.equal((m.channel.dump() as { listings: Array<{ livePriceMinor: number; sellerItemRevision: number }> }).listings[0]!.livePriceMinor, 1149, 'nothing was applied');
});

test('Р-187: 25016 carries MinValue; refused items do not raise sellerItemRevision; 260 edits in a row are all accepted by default (E-02)', async () => {
  const m = direct({ seed: 3, listings: [listing(1)] });
  const low = await m.bulk([{ offerId: L(1).offerId, price: { value: '0.00', currency: 'EUR' } }]);
  assert.equal(low.status, 400);
  assert.deepEqual(low.body.responses?.[0]?.errors?.[0]?.parameters, [{ name: 'MinValue', value: 'EUR 1.00' }, { name: 'ItemID', value: L(1).listingId }, { name: 'SKU', value: L(1).sku }]);
  const zero = await m.bulk([{ offerId: L(1).offerId, availableQuantity: 0 }]);
  assert.equal(zero.body.responses?.[0]?.errors?.[0]?.errorId, 25004);
  for (let i = 0; i < 260; i++) assert.equal((await m.bulk([{ offerId: L(1).offerId, price: { value: `${10 + (i % 5)}.00`, currency: 'EUR' } }])).status, 200);
  const browse = await m.get(`/buy/browse/v1/item/v1|${L(1).listingId}|0`);
  assert.equal(browse.body.sellerItemRevision, '261', '260 applied edits on top of revision 1; the two refusals did not count');
});

/**
 * Шаг 49 [Р-189, E-22] — путь целиком: диспетчер, адаптер и модель eBay, режим пакетов — у хранилища (как `record_ebay_batch_outcome`), каталог
 * аккаунтов читает его на каждом вызове. Три ждущие записи боевого аккаунта в пробе: пакет из 2 SKU и одна запись. Модель по умолчанию (как
 * песочница) пакет принимает — аккаунт в MULTI, всё за один обход. Вариант E-22 — пакет отвергнут целиком: аккаунт переходит в SINGLE.
 * Шаг 51 (Growth Check): ответ eBay 4xx не повторяется — отвергнутые записи завершаются отказом канала по правилу повтора адаптера
 * (хранилище теста решает НАСТОЯЩИМИ правилами переходов с политикой, которую передал диспетчер), а следующие записи тех же единиц уходят по одной.
 */
test('Р-189 end to end: a refused probe moves the account to one SKU per call, the refused writes are not retried (step 51) and the next writes go one by one; an accepted probe moves it to MULTI', async () => {
  const run = async (multiSkuPerCall: 'ACCEPTED' | 'REFUSED_WHOLE_REQUEST') => {
    const clock = new VirtualClock('2026-09-28T10:00:00.000Z');
    const w = world({ seed: 20, params: { multiSkuPerCall }, listings: [listing(21), listing(22), listing(23)] },
      { account: { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_DE'], channel: 'EBAY', writeMode: 'LIVE', ebayBatchMode: 'PROBE' } });
    const model = new SimulatedEbayChannel(w.channelModel as EbayChannelModelSpec, w.clock, { user: USER_TOKEN, application: APP_TOKEN });
    const violations: string[] = [];
    const sink = { logs: [] as AdapterLogEntry[], alerts: [] as RaisedAlert[] };
    const adapter = ebayUnderTest({ deps: worldDependencies(w, clock, sink), world: w, clock, fetch: channelFetch(model, ebayRequestChecker(w, EBAY_STAND_HOST), clock, violations, []) });
    const modes = new InMemoryPricingStore({ scopes: [], channel: 'EBAY' }, { tenantId: TENANT });
    const writes = [21, 22, 23].map((n) => priceWrite(`cw-${n}`, n, 1300 + n) as unknown as FieldWrite);
    const state = new Map(writes.map((x) => [x.writeScope.writeScopeId as string, { write: x, status: 'PENDING' as 'PENDING' | 'RETRY' | 'DONE' | 'DISCARDED', at: 0, attempts: 0 }]));
    const open = (v: { status: string }) => v.status === 'PENDING' || v.status === 'RETRY';
    const store: WriteQueueStore = {
      async dueScopes() {
        return [...state.entries()].filter(([, v]) => open(v) && v.at <= clock.nowMs())
          .map(([id]) => ({ tenantId: TENANT, writeScopeId: id, dueKind: 'PENDING' as const, dueSince: clock.iso() }));
      },
      async claimNext(_t, id): Promise<ClaimResult> {
        const v = state.get(id)!;
        if (!open(v) || v.at > clock.nowMs() || v.attempts > 0 && v.status === 'PENDING') return { kind: 'IDLE' };
        v.attempts += 1;
        v.status = 'PENDING';
        return { kind: 'DISPATCH', channelAccountId: ACCOUNT, write: { ...v.write, attemptNo: v.attempts } };
      },
      async recordOutcome(_t, write, outcome, now, policy): Promise<RecordedOutcome> {
        const v = state.get(write.writeScope.writeScopeId)!;
        const t = planOutcomeTransition(outcome, write.attemptNo, now, policy);
        v.status = t.to === 'ACCEPTED' ? 'DONE' : t.to === 'RETRY' ? 'RETRY' : 'DISCARDED';
        v.at = t.to === 'RETRY' ? Date.parse(t.nextAttemptAt) : 0;
        return { status: t.to === 'ACCEPTED' ? 'ACCEPTED' : 'FAILED', slotFreed: true, queuedWaiting: false, nextAttemptAt: t.to === 'RETRY' ? t.nextAttemptAt : null, reason: null, scopeBlocked: false };
      },
      async recordReconciliation() { throw new Error('not reached'); },
      async checkPriceBasis() { return null; },
      async recordEbayBatchOutcome(t, a, accepted) {
        const mode = await modes.recordEbayBatchOutcome(t, a, accepted);
        w.account.ebayBatchMode = mode as 'MULTI' | 'SINGLE';
        return mode;
      },
    };
    const dispatcher = createWriteDispatcher({ store, adapterFor: () => adapter, alerts: { raise: async (x) => { sink.alerts.push(x); } }, now: () => clock.iso() });
    const sweeps: number[] = [];
    for (let i = 0; i < 4 && [...state.values()].some(open); i++) {
      sweeps.push((await dispatcher.sweep({ pendingMinAgeMs: 0 })).due);
      clock.advance(5_000);
    }
    // Следующие версии тех же единиц после отказа пробы: аккаунт уже в своём режиме
    const next = writes.map((x) => ({ ...x, channelWriteId: `${x.channelWriteId}-v2` as FieldWrite['channelWriteId'], version: 2 }));
    for (const x of next) state.set(x.writeScope.writeScopeId as string, { write: x, status: 'PENDING', at: 0, attempts: 0 });
    const before = model.stats.requests['POST /sell/inventory/v1/bulk_update_price_quantity'] ?? 0;
    for (let i = 0; i < 4 && [...state.values()].some(open); i++) {
      await dispatcher.sweep({ pendingMinAgeMs: 0 });
      clock.advance(5_000);
    }
    const nextRequests = (model.stats.requests['POST /sell/inventory/v1/bulk_update_price_quantity'] ?? 0) - before;
    return { model, state, modes, sweeps, w, violations, sink, nextRequests };
  };

  const refused = await run('REFUSED_WHOLE_REQUEST');
  assert.equal(refused.w.account.ebayBatchMode, 'SINGLE');
  assert.deepEqual(refused.modes.ebayBatchRefusals.map((r) => [r.from, r.to, r.question]), [['PROBE', 'SINGLE', 'E-22']], 'one refusal, recorded once');
  assert.equal(refused.model.stats.multiSkuRefused, 1, 'the channel refused the multi-SKU call once and it was never sent again');
  assert.deepEqual(refused.sweeps, [3], 'the refused writes were not due again: an eBay 4xx is not retried (step 51)');
  assert.equal(refused.nextRequests, 3, 'the next versions of all three scopes went one SKU per call');
  assert.deepEqual([...refused.state.values()].map((v) => v.status), ['DONE', 'DONE', 'DONE'], 'the next versions arrived');
  assert.equal(refused.model.stats.itemsApplied, 1 + 3, 'first round: only the single write; the two refused ones were not applied');
  assert.equal(refused.model.stats.requests['POST /sell/inventory/v1/bulk_update_price_quantity'], 2 + 3, 'probe (refused) + single, then three singles');
  assert.deepEqual(refused.violations, []);

  const accepted = await run('ACCEPTED');
  assert.deepEqual([...accepted.state.values()].map((v) => v.status), ['DONE', 'DONE', 'DONE']);
  assert.equal(accepted.w.account.ebayBatchMode, 'MULTI');
  assert.deepEqual(accepted.modes.ebayBatchRefusals, []);
  assert.deepEqual(accepted.sweeps, [3], 'one sweep: probe of 2 SKUs + one single');
  assert.equal(accepted.model.stats.requests['POST /sell/inventory/v1/bulk_update_price_quantity'] - accepted.nextRequests, 2);
  assert.equal(accepted.nextRequests, 1, 'MULTI: the next three versions went in one call');
});
