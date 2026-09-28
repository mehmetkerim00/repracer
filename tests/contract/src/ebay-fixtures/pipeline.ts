import { getMyeBaySellingRequest } from '@repracer/ebay-adapter';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import type { Exchange, Provenance, Scenario, Step, World } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';

/**
 * Шаг 47: путь решения о цене для eBay [Р-186, Р-39, Р-163, Р-164]. Те же обязательные сценарии, что у Kaufland и Amazon, там, где они
 * применимы к eBay: у eBay НЕТ данных конкурентов (Р-39) — сценарии проверки входов по снимку, сдвига рынка, якорей и остановки выборкой
 * к нему неприменимы; цена считается фиксированной и маржинальной стратегиями, пересчёт — по себестоимости и расписанию. Плюс сценарии
 * eBay: бюджет 250 правок, исчерпанный посреди дня, запись в немигрированный листинг и цена покупателя с НДС сверху (Р-186, E-17).
 *
 * Каждый сценарий идёт и на хранилище в памяти (ebay.contract.test.ts), и на PostgreSQL (ebay.pipeline.pg.test.ts). Обмены — синтетические
 * по протоколу песочницы шага 39 (формы ответов — как у неё): путь решения eBay в песочнице не прогонялся.
 */

const EVIDENCE = 'docs/evidence/step39-ebay-sandbox.md';
const provenance = (...sources: string[]): Provenance => ({ kind: 'SYNTHETIC_FROM_DOCS', sources: [EVIDENCE, 'docs/decisions.md#Р-186', ...sources] });

const USER_TOKEN = 'syn-ebay-user-token-0001';
const APP_TOKEN = 'syn-ebay-app-token-0001';
const TENANT = '10000000-0000-4000-8000-000000000001';
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const ACCOUNT_US = '20000000-0000-4000-8000-000000000002';

/** Предложение n: листинг 1200000000nn, предложение 92000000nn, SKU SYN-EBAY-P-nn */
export const pids = (n: number) => ({ listingId: `1200000000${String(n).padStart(2, '0')}`, offerId: `92000000${String(n).padStart(2, '0')}`, sku: `SYN-EBAY-P-${String(n).padStart(2, '0')}` });
const major = (minor: number) => `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

function world(pricing: NonNullable<World['pricing']>, extra: Partial<World> = {}): World {
  return {
    clock: '2026-09-28T10:00:00.000Z', tenantId: TENANT, channelAccountId: ACCOUNT,
    account: { externalAccountId: 'syn_ebay_seller_0001', marketplaces: ['EBAY_DE'], channel: 'EBAY' },
    credentials: {
      seller: { refreshToken: 'syn-ebay-refresh-token-0001' }, application: { clientId: 'Syn-Repracer-SBX-0001', clientSecret: 'SBX-syn-client-secret-0001' },
      accessToken: USER_TOKEN, applicationToken: APP_TOKEN,
    },
    pricing, ...extra,
  };
}

const EUR_COST = (n: number, unitCostMinor = 500) => ({ currency: 'EUR', costProfileId: `cp-ebay-${n}`, unitCostMinor, fixedFeeMinor: 0, feeRateBp: 1100, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } });

/** Единица записи цены eBay: SKU, предложение Inventory API и листинг — как их видит адаптер */
function scope(n: number, o: Partial<MemorySeedScope> & { migrated?: boolean } = {}): MemorySeedScope {
  const i = pids(n);
  const { migrated, ...rest } = o;
  return {
    writeScopeId: `ws-ebay-price-${n}`, productId: `prod-ebay-${n}`, channelAccountId: ACCOUNT, marketplace: 'EBAY_DE',
    externalUnitId: i.sku, ...(migrated === false ? {} : { externalOfferId: i.offerId }), externalListingId: i.listingId,
    channelProductRef: i.listingId, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
    strategy: { strategyId: `st-fixed-${n}`, version: 1, params: { type: 'FIXED', priceMinor: 1299 }, deadbandMinor: 0 },
    currentPriceMinor: 1149, minPrice: { amountMinor: 1000, id: `min-ebay-${n}` }, maxPrice: { amountMinor: 5000, id: `max-ebay-${n}` }, cost: EUR_COST(n),
    ...rest,
  };
}
const fixed = (n: number, priceMinor: number) => ({ strategyId: `st-fixed-${n}-${priceMinor}`, version: 1, params: { type: 'FIXED' as const, priceMinor }, deadbandMinor: 0 });

// ---------------------------------------------------------------------------------------------------- обмены

const userToken = (id = 'user-token'): Exchange => ({
  id, request: { method: 'POST', path: '/identity/v1/oauth2/token', body: { $type: 'string' } },
  response: { status: 200, body: { access_token: USER_TOKEN, expires_in: 7200, token_type: 'User Access Token' } },
});
const appToken = (id = 'app-token'): Exchange => ({
  id, request: { method: 'POST', path: '/identity/v1/oauth2/token', body: { $type: 'string' } },
  response: { status: 200, body: { access_token: APP_TOKEN, expires_in: 7200, token_type: 'Application Access Token' } },
});
function bulkPrice(id: string, n: number, minor: number, fault?: 'NETWORK_ERROR'): Exchange {
  return {
    id, request: { method: 'POST', path: '/sell/inventory/v1/bulk_update_price_quantity', body: { requests: [{ offers: [{ offerId: pids(n).offerId, price: { value: major(minor), currency: 'EUR' } }] }] } },
    ...(fault ? { fault } : { response: { status: 200, body: { responses: [{ statusCode: 200, sku: pids(n).sku, offerId: pids(n).offerId }] } } }),
  };
}
const getOffer = (id: string, n: number, minor: number): Exchange => ({
  id, request: { method: 'GET', path: `/sell/inventory/v1/offer/${pids(n).offerId}` },
  response: { status: 200, body: {
    offerId: pids(n).offerId, sku: pids(n).sku, marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', availableQuantity: 5,
    pricingSummary: { price: { value: major(minor), currency: 'EUR' } }, listing: { listingId: pids(n).listingId, listingStatus: 'ACTIVE', soldQuantity: 0 }, status: 'PUBLISHED',
  } },
});
const browse = (id: string, n: number, minor: number, revision: string, vat = false): Exchange => ({
  id, request: { method: 'GET', path: `/buy/browse/v1/item/v1|${pids(n).listingId}|0`, query: { fieldgroups: 'COMPACT' } },
  response: { status: 200, body: {
    itemId: `v1|${pids(n).listingId}|0`, legacyItemId: pids(n).listingId, sellerItemRevision: revision, price: { value: major(minor), currency: 'EUR' },
    estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 5 }],
    ...(vat ? { taxes: [{ taxJurisdiction: { region: { regionName: 'DE', regionType: 'COUNTRY' } }, taxType: 'VAT', taxPercentage: '19.0', includedInPrice: true, ebayCollectAndRemitTax: true }] } : {}),
  } },
});

// ---------------------------------------------------------------------------------------------------- сценарии

function scenario(file: string, id: string, title: string, description: string, tags: string[], w: World, steps: Step[], exchanges: Exchange[], expect: Scenario['expect'], sources: string[] = []): { file: string; scenario: Scenario } {
  return { file, scenario: { format: SCENARIO_FORMAT, id, channel: 'EBAY' as const, apiVersion: 'sell-inventory-v1 (sandbox 2026-09-27)', title, description, tags: ['pipeline', ...tags], provenance: provenance(...sources), world: w, steps, exchanges, expect } };
}
const recompute = (id: string, writeScopeId: string, expect?: unknown): Step => ({ id, kind: 'pipelineRecompute', writeScopeId, trigger: { type: 'COST_CHANGE' }, ...(expect !== undefined ? { expect } : {}) }) as Step;
const wait = (id: string, ms: number): Step => ({ id, kind: 'advanceClock', ms }) as Step;
const dispatchDue = (id: string, expect?: unknown): Step => ({ id, kind: 'pipelineDispatchDue', ...(expect !== undefined ? { expect } : {}) }) as Step;
/** Окно «в полёте» диспетчера: после него принятая запись сверяется обратным чтением [Р-64] */
const IN_FLIGHT_WINDOW_MS = 121_000;

export function buildEbayPipelineScenarios(): Array<{ file: string; scenario: Scenario }> {
  const out: Array<{ file: string; scenario: Scenario }> = [];

  // 1. Фиксированная цена: решение, запись, подтверждение живым листингом
  out.push(scenario('pipeline-fixed-price-confirmed.json', 'ebay/pipeline/fixed-price-confirmed',
    'Путь решения eBay: фиксированная цена 12.99 одобрена, уходит bulk_update_price_quantity и подтверждается живым листингом Browse',
    'У eBay нет данных конкурентов (Р-39): пересчёт по себестоимости, стратегия FIXED. Gate одобряет в границах 10.00–50.00, адаптер отправляет цену ровно с двумя знаками по offerId предложения Inventory API (Р-164) — ответ 200 по элементу, принято без «применено сразу». После окна «в полёте» диспетчер сверяет обратным чтением: GET offer — наша запись, Browse — живая цена 12.99 [Р-186], запись APPLIED. Повторный пересчёт той же цены — NO_OP, в канал ничего не уходит.',
    ['mandatory:pipeline-write-confirmed'],
    world({ scopes: [scope(1)] }),
    [
      recompute('fixed-price-approved', 'ws-ebay-price-1', { decision: { outcome: 'APPROVED', finalMinor: 1299 }, dispatch: { status: 'ACCEPTED', appliedImmediately: false } }),
      wait('in-flight-window-passes', IN_FLIGHT_WINDOW_MS),
      dispatchDue('readback-confirms', { due: 1, reports: [{ writeScopeId: 'ws-ebay-price-1', steps: [{ action: 'RECONCILED', version: 1, result: 'APPLIED', recorded: 'APPLIED' }, { action: 'IDLE' }] }] }),
      recompute('same-price-no-op', 'ws-ebay-price-1', { decision: { outcome: 'NO_CHANGE' } }),
    ],
    [userToken(), bulkPrice('bulk-1299', 1, 1299), getOffer('get-offer-1299', 1, 1299), appToken(), browse('browse-1299', 1, 1299, '4')],
    { noAlerts: true, pipeline: { writes: [{ writeScopeId: 'ws-ebay-price-1', amountMinor: 1299, version: 1, status: 'APPLIED' }], distrusts: [], halts: [] },
      logs: [{ code: 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', details: { divergence: false } }] }));

  // 1б. Шаг 51 (Growth Check, ревью шага 51, находка 5): своя отправка пути решения берёт правило повтора канала — ответ eBay 429 не повторяется
  out.push(scenario('pipeline-write-429-not-retried.json', 'ebay/pipeline/write-429-not-retried',
    'Путь решения eBay: ответ 429 на первую отправку записи — отказ канала без повтора (правило повтора eBay, Growth Check)',
    'Своя отправка пути решения записывает итог по правилу повтора канала (descriptor.writeRetry): у eBay повторяются только сбои инфраструктуры (5xx, таймаут, обрыв соединения), не больше двух раз; ответ 4xx на значение — отказ канала, запись завершается с причиной, срока повтора у неё нет. Без правила канала (общая политика) та же запись стала бы FAILED со сроком повтора — это и утверждается. Тело 429 синтетическое.',
    ['growth-check'],
    world({ scopes: [scope(9)] }),
    [recompute('rate-limited-first-send', 'ws-ebay-price-9', { decision: { outcome: 'APPROVED', finalMinor: 1299 }, dispatch: { status: 'REJECTED', error: { code: 'RATE_LIMITED', httpStatus: 429 } } })],
    [userToken(), { ...bulkPrice('bulk-429', 9, 1299), response: { status: 429, body: { errors: [{ errorId: 2001, domain: 'SYNTHETIC', message: 'Too many requests (synthetic)' }] } } }],
    { pipeline: { writes: [{ writeScopeId: 'ws-ebay-price-9', amountMinor: 1299, status: 'DISCARDED_STALE' }] } }));

  // 2. Gate: ниже пола и выше потолка
  out.push(scenario('pipeline-gate-bounds.json', 'ebay/pipeline/gate-bounds',
    'Gate eBay: фиксированная цена ниже min_price и выше max_price отклоняется, запись не создаётся',
    'Р-43, Р-44: обе границы — вне движка стратегий. 9.00 при min_price 10.00 — BELOW_MIN_PRICE, 60.00 при max_price 50.00 — ABOVE_MAX_PRICE; решения хранятся с причиной и параметрами, в канал ничего не уходит.',
    ['mandatory:pipeline-below-floor', 'mandatory:pipeline-above-max'],
    world({ scopes: [scope(2, { strategy: fixed(2, 900) }), scope(3, { strategy: fixed(3, 6000) })] }),
    [
      recompute('below-min-price', 'ws-ebay-price-2', { decision: { outcome: 'REJECTED', rejectionReason: 'BELOW_MIN_PRICE' } }),
      recompute('above-max-price', 'ws-ebay-price-3', { decision: { outcome: 'REJECTED', rejectionReason: 'ABOVE_MAX_PRICE' } }),
    ],
    [],
    { pipeline: { decisions: [{ writeScopeId: 'ws-ebay-price-2', rejectionReason: 'BELOW_MIN_PRICE' }, { writeScopeId: 'ws-ebay-price-3', rejectionReason: 'ABOVE_MAX_PRICE' }], writes: [] } }));

  // 3. Налоговые режимы: EBAY_DE брутто с НДС, EBAY_US нетто
  {
    const us = scope(5, {
      channelAccountId: ACCOUNT_US, marketplace: 'EBAY_US', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', strategy: fixed(5, 1500),
      currentPriceMinor: 1600, cost: { currency: 'USD', costProfileId: 'cp-ebay-5', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'SALES_TAX_EXCLUDED' } },
      guardrails: { guardrailIds: ['g-margin-ebay-5'], minMarginBp: 2000 },
    });
    out.push(scenario('pipeline-tax-regimes-margin-floor.json', 'ebay/pipeline/tax-regimes-margin-floor',
      'Одна себестоимость, две витрины eBay: пол маржи EBAY_DE (EUR брутто) и EBAY_US (USD нетто) различается',
      'Себестоимость 10.00, комиссия 15 %, ограничение маржи 20 %, фиксированная цена 15.00. EBAY_DE — цена с НДС 19 %, маржа от цены без НДС: пол 19.15. EBAY_US — цена без sales tax (Р-58): пол 15.39. Обе цены ниже пола; причина хранится с параметрами. Аккаунт EBAY_US — в тени: граница суток EBAY_US не установлена (Р-65, OQ-112), и боевой режим держит свойство витрины со статусом UNKNOWN (Р-172).',
      ['mandatory:pipeline-tax-regimes', 'r-57', 'r-58'],
      world({
        scopes: [scope(4, { strategy: fixed(4, 1500), currentPriceMinor: 1600, cost: { ...EUR_COST(4, 1000), feeRateBp: 1500 }, guardrails: { guardrailIds: ['g-margin-ebay-4'], minMarginBp: 2000 } }), us],
        accounts: [{ channelAccountId: ACCOUNT_US, channel: 'EBAY', marketplaces: ['EBAY_US'], writeMode: 'SHADOW' }],
      }),
      [
        recompute('recompute-eur-gross', 'ws-ebay-price-4', { decision: { outcome: 'REJECTED', rejectionReason: 'BELOW_MARGIN_FLOOR', currency: 'EUR', effectiveFloorMinor: 1915 } }),
        recompute('recompute-usd-net', 'ws-ebay-price-5', { decision: { outcome: 'REJECTED', rejectionReason: 'BELOW_MARGIN_FLOOR', currency: 'USD', effectiveFloorMinor: 1539 } }),
      ],
      [],
      { alerts: [{ code: 'PRICE_REJECTED_BY_BOUND', severity: 'WARNING', count: 2, details: { reason: 'BELOW_MARGIN_FLOOR' } }],
        pipeline: { decisions: [{ writeScopeId: 'ws-ebay-price-4', reasonParams: { proposedMinor: 1500, floorMinor: 1915 } }, { writeScopeId: 'ws-ebay-price-5', reasonParams: { proposedMinor: 1500, floorMinor: 1539 } }], writes: [] } }));
  }

  // 4. max_price обязателен
  out.push(scenario('pipeline-max-price-missing.json', 'ebay/pipeline/max-price-missing',
    'Р-43 на eBay: без max_price репрайсинг не включается; после задания границы — включается',
    'У предложения только min_price: включение отказывает MAX_PRICE_MISSING, режим остаётся OFF. После задания max_price 50.00 включение проходит — фиксированная стратегия доступна на канале без данных конкурентов (Р-39).',
    ['mandatory:pipeline-max-missing'],
    world({ scopes: [scope(6, { pricingMode: 'OFF', maxPrice: null })] }),
    [
      { id: 'enable-without-max', kind: 'pipelineEnableRepricing', writeScopeId: 'ws-ebay-price-6', expect: { enabled: false, problems: [{ code: 'MAX_PRICE_MISSING' }] } } as Step,
      { id: 'set-max-price', kind: 'pricingMutation', op: 'setBound', writeScopeId: 'ws-ebay-price-6', bound: 'max', value: { amountMinor: 5000, id: 'max-ebay-6' } } as Step,
      { id: 'enable-with-both-bounds', kind: 'pipelineEnableRepricing', writeScopeId: 'ws-ebay-price-6', expect: { enabled: true, problems: [] } } as Step,
    ],
    [],
    { logs: [{ code: 'REPRICING_NOT_ENABLED', count: 1 }], noAlerts: true, pipeline: { scopes: [{ pricingMode: 'ENGINE' }], decisions: [], writes: [] } }));

  // 5. Остановка человеком
  out.push(scenario('pipeline-kill-switch-tenant-stop.json', 'ebay/pipeline/kill-switch-tenant-stop',
    'Р-69, Р-70 на eBay: оператор останавливает тенанта — фиксированная цена удерживается; владелец возобновляет — цена уходит',
    'Наблюдатель остановить не может; оператор останавливает весь тенант. Фиксированная цена 15.00 при остановке человеком — HELD с PRICING_STOPPED. Оператор не может возобновить, владелец возобновляет с заметкой, и та же цена одобряется и уходит в eBay.',
    ['mandatory:pipeline-kill-switch'],
    world({ scopes: [scope(7, { strategy: fixed(7, 1500) })] }),
    [
      { id: 'viewer-cannot-stop', kind: 'pricingStop', op: 'stop', scope: 'TENANT', membershipId: 'membership-viewer', note: 'Synthetic stand check of the kill switch', expect: { status: 'FORBIDDEN' } } as Step,
      { id: 'operator-stops-tenant', kind: 'pricingStop', op: 'stop', scope: 'TENANT', membershipId: 'membership-operator', note: 'Synthetic stand check of the kill switch', expect: { status: 'STOPPED', stop: { scope: 'TENANT', channelAccountId: null } } } as Step,
      recompute('fixed-price-held-by-stop', 'ws-ebay-price-7', { decision: { outcome: 'HELD', rejectionReason: 'PRICING_STOPPED' } }),
      { id: 'operator-cannot-resume-tenant', kind: 'pricingStop', op: 'release', stopIndex: 0, membershipId: 'membership-operator', note: 'Operator tries to resume the tenant', expect: { status: 'FORBIDDEN' } } as Step,
      { id: 'owner-resumes', kind: 'pricingStop', op: 'release', stopIndex: 0, membershipId: 'membership-owner', note: 'Kill switch checked, resuming', expect: { status: 'RELEASED' } } as Step,
      recompute('fixed-price-after-resume', 'ws-ebay-price-7', { decision: { outcome: 'APPROVED', finalMinor: 1500 }, dispatch: { status: 'ACCEPTED' } }),
    ],
    [userToken(), bulkPrice('bulk-1500', 7, 1500)],
    { alerts: [{ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', count: 1 }, { code: 'PRICING_RESUMED_BY_PERSON', severity: 'WARNING', count: 1 }],
      pipeline: { stops: [{ scope: 'TENANT' }], decisions: [{ outcome: 'HELD', rejectionReason: 'PRICING_STOPPED', finalMinor: null }, { outcome: 'APPROVED', finalMinor: 1500 }], writes: [{ amountMinor: 1500 }] } }));

  // 6. Системная остановка витрины: фиксированную цену не держит, снимается только человеком
  out.push(scenario('pipeline-halt-manual-only.json', 'ebay/pipeline/halt-manual-only',
    'Р-51, Р-119 на eBay: остановка витрины не держит фиксированную цену; выборкой не снимается (MANUAL_ONLY), снимает человек',
    'Системная остановка EBAY_DE действует только на цены из данных конкурентов [Р-51] — у eBay их нет, фиксированная цена 13.00 уходит. Проверка остановок выборкой на eBay неприменима: канал не даёт опроса конкурентов (haltRelease MANUAL_ONLY, Р-119). Владелец снимает остановку вручную с заметкой.',
    ['mandatory:pipeline-halt-manual-release', 'r-119'],
    world({ scopes: [scope(8, { strategy: fixed(8, 1300) })], halts: [{ marketplace: 'EBAY_DE', haltedAt: '2026-09-28T09:00:00.000Z', reviewWindowSeconds: 60 }] }),
    [
      recompute('fixed-price-not-held-by-halt', 'ws-ebay-price-8', { decision: { outcome: 'APPROVED', finalMinor: 1300 }, dispatch: { status: 'ACCEPTED' } }),
      { id: 'review-by-sample-not-applicable', kind: 'pipelineReviewHalts', sampleSize: 5, expect: [{ outcome: 'MANUAL_ONLY', sampleSize: 0, snapshots: [] }] } as Step,
      { id: 'owner-releases-manually', kind: 'pipelineReleaseHalt', haltIndex: 0, membershipId: 'membership-owner', note: 'Marktverschiebung manuell geprüft', expect: { released: true } } as Step,
    ],
    [userToken(), bulkPrice('bulk-1300', 8, 1300)],
    { pipeline: { halts: [{ marketplace: 'EBAY_DE', releasedKind: 'MANUAL' }], writes: [{ amountMinor: 1300 }] } }));

  // 7. Обрыв соединения, вторая запись в очереди
  out.push(scenario('pipeline-write-queue-second-not-lost.json', 'ebay/pipeline/write-queue-second-not-lost',
    'Обрыв соединения посреди записи: итог неизвестен, вторая цена ждёт в очереди; сверка обратным чтением, вслепую не повторяется',
    'Первая цена 8.90 (маржа 20 % при себестоимости 5.00) уходит, соединение закрыто каналом («other side closed» в песочнице) — OUTCOME_UNKNOWN, запись в полёте, повтора вслепую нет [EBAY_C02]. Себестоимость растёт до 6.00 — вторая цена 10.68 встаёт в очередь [Р-64]. Диспетчер после окна сверяет первую запись обратным чтением (GET offer и Browse — 8.90, применена), единица освобождается, и вторая запись уходит.',
    ['mandatory:pipeline-write-queue', 'mandatory:pipeline-timeout-unknown-outcome'],
    world({ scopes: [scope(9, { minPrice: { amountMinor: 500, id: 'min-ebay-9' }, strategy: { strategyId: 'st-margin-9', version: 1, params: { type: 'TARGET_MARGIN', targetMarginBp: 2000 }, deadbandMinor: 0 } })] }),
    [
      recompute('first-write-connection-closed', 'ws-ebay-price-9', { decision: { outcome: 'APPROVED', finalMinor: 890 }, dispatch: { status: 'OUTCOME_UNKNOWN', error: { code: 'NETWORK' } } }),
      { id: 'cost-rises', kind: 'pricingMutation', op: 'setCost', writeScopeId: 'ws-ebay-price-9', value: EUR_COST(9, 600) } as Step,
      recompute('second-write-queued', 'ws-ebay-price-9', { decision: { outcome: 'APPROVED', finalMinor: 1068 } }),
      wait('reconcile-window', IN_FLIGHT_WINDOW_MS),
      dispatchDue('reconcile-first-send-second', { reports: [{ writeScopeId: 'ws-ebay-price-9', steps: { $contains: [{ action: 'RECONCILED', version: 1, result: 'APPLIED' }, { action: 'DISPATCHED', version: 2 }] } }] }),
    ],
    [userToken(), bulkPrice('bulk-890-connection-closed', 9, 890, 'NETWORK_ERROR'), getOffer('get-offer-890', 9, 890), appToken(), browse('browse-890', 9, 890, '4'), bulkPrice('bulk-1068', 9, 1068)],
    { logs: [{ code: 'EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES', count: 1 }],
      pipeline: { writes: [{ version: 1, amountMinor: 890, status: 'APPLIED' }, { version: 2, amountMinor: 1068, status: 'ACCEPTED' }] } }));

  // 8. Бюджет 250 правок исчерпан посреди дня
  out.push(scenario('pipeline-budget-exhausted-mid-day.json', 'ebay/pipeline/budget-exhausted-mid-day',
    'Р-163 на пути решения: 190-я правка цены листинга уходит, следующая цена — BUDGET_EXHAUSTED без обращения к eBay, с алертом',
    'За пять часов по листингу было 189 попыток правки цены (второй слой бюджета, EBAY_C08). Первая цена 8.90 уходит (190-я попытка) и подтверждается. Себестоимость растёт, вторая цена 10.68 одобрена, но адаптер не отправляет её: цене — 250 − резерв остатка 50 − запас 10 = 190 попыток за любые 24 часа [Р-163]. Запись завершается BUDGET_EXHAUSTED, алерт PRICE_WRITE_NOT_SENT; запросов к eBay — ни одного. Первый слой — edit_budget в базе (ebay.pipeline.pg.test.ts).',
    ['mandatory:pipeline-budget-exhausted', 'conservative:EBAY_C08_EDIT_BUDGET_ROLLING_DAY'],
    world({ scopes: [scope(10, { minPrice: { amountMinor: 500, id: 'min-ebay-10' }, strategy: { strategyId: 'st-margin-10', version: 1, params: { type: 'TARGET_MARGIN', targetMarginBp: 2000 }, deadbandMinor: 0 } })] },
      { adapter: { ebayEditAttempts: [{ listingId: pids(10).listingId, attempts: 189, agoMs: 5 * 3600_000, field: 'PRICE' }] } }),
    [
      recompute('attempt-190-sent', 'ws-ebay-price-10', { decision: { outcome: 'APPROVED', finalMinor: 890 }, dispatch: { status: 'ACCEPTED' } }),
      { id: 'cost-rises', kind: 'pricingMutation', op: 'setCost', writeScopeId: 'ws-ebay-price-10', value: EUR_COST(10, 600) } as Step,
      recompute('second-price-queued', 'ws-ebay-price-10', { decision: { outcome: 'APPROVED', finalMinor: 1068 } }),
      wait('reconcile-window', IN_FLIGHT_WINDOW_MS),
      dispatchDue('confirm-first-refuse-second'),
    ],
    [userToken(), bulkPrice('bulk-890-attempt-190', 10, 890), getOffer('get-offer-890', 10, 890), appToken(), browse('browse-890', 10, 890, '191')],
    { alerts: [{ code: 'PRICE_WRITE_NOT_SENT', severity: 'CRITICAL', count: 1, details: { status: 'BUDGET_EXHAUSTED' } }],
      logs: [{ code: 'EBAY_C08_EDIT_BUDGET_ROLLING_DAY', question: 'E-02', count: 1, details: { used: 190, limit: 190, field: 'PRICE' } }],
      pipeline: { writes: [{ version: 1, status: 'APPLIED' }, { version: 2, status: 'BUDGET_EXHAUSTED' }] } },
    ['docs/decisions.md#Р-163']));

  // 9. Немигрированный листинг
  out.push(scenario('pipeline-unmigrated-write-blocked.json', 'ebay/pipeline/unmigrated-write-blocked',
    'Р-164 на пути решения: цена листинга не под Inventory API одобрена, но не уходит — единица заблокирована до человека',
    'У предложения нет offerId: листинг не мигрирован (на PostgreSQL единицу записи цены у сопоставления с ebay_migration_status REQUIRED не принимает сама база — ebay.pipeline.pg.test.ts; здесь сопоставление без предложения). Адаптер отклоняет запись ДО обращения к каналу — ни токена, ни записи, ни bulk_migrate_listing; ошибка «нужен человек» блокирует единицу с CRITICAL-алертом. Миграция — только владельцем после предполётной проверки (Р-2, Р-164).',
    ['mandatory:pipeline-unmigrated-write', 'r164'],
    world({ scopes: [scope(11, { migrated: false, strategy: fixed(11, 1399) })] }),
    [recompute('approved-but-not-sent', 'ws-ebay-price-11', { decision: { outcome: 'APPROVED', finalMinor: 1399 },
      stages: { $contains: [{ stage: 'DISPATCH_PLAN', outcome: 'REJECTED', reason: { params: { status: 'PRECONDITION_FAILED', errorClass: 'REQUIRES_HUMAN' } } }] } })],
    [],
    { alerts: [{ code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', count: 1 }],
      logs: [{ code: 'EBAY_R164_WRITE_TO_UNMIGRATED_LISTING', details: { listingId: pids(11).listingId } }],
      pipeline: { writes: [{ amountMinor: 1399, status: 'FAILED' }] } },
    ['docs/decisions.md#Р-164']));

  // 10. Цена покупателя с НДС сверху — не недоверие каналу
  out.push(scenario('pipeline-browse-vat-no-distrust.json', 'ebay/pipeline/browse-vat-no-distrust',
    'Р-186: Browse показывает цену покупателя = отправленная × 1,19 — запись подтверждена, недоверия каналу нет, вторая цена уходит',
    'Фиксированная цена 13.49 уходит в EBAY_DE. Обратное чтение после окна: GET offer — 13.49, Browse — 16.05 с taxes [VAT 19 %, includedInPrice, ebayCollectAndRemitTax] — как в песочнице (E-17). У Amazon такое расхождение — неверная база цены и недоверие витрине [Р-116, сценарий amazon/pipeline/price-basis-mismatch-halt]; у eBay цена покупателя хранится отдельно (buyerPrice) и в сверку Р-116 не идёт, пока E-17 не решит бой. Запись APPLIED, остановки по недоверию нет, фиксированная цена второго товара уходит.',
    ['mandatory:pipeline-price-basis-r186', 'conservative:EBAY_C14_BROWSE_PRICE_WITH_VAT'],
    world({ scopes: [scope(12, { strategy: fixed(12, 1349) }), scope(13, { strategy: fixed(13, 2100) })] }),
    [
      recompute('first-fixed-price-accepted', 'ws-ebay-price-12', { decision: { outcome: 'APPROVED', finalMinor: 1349 } }),
      wait('in-flight-window-passes', IN_FLIGHT_WINDOW_MS),
      dispatchDue('readback-shows-buyer-price-with-vat', { due: 1, reports: [{ writeScopeId: 'ws-ebay-price-12', steps: [{ action: 'RECONCILED', version: 1, result: 'APPLIED', recorded: 'APPLIED' }, { action: 'IDLE' }] }] }),
      recompute('second-fixed-price-not-held', 'ws-ebay-price-13', { decision: { outcome: 'APPROVED', finalMinor: 2100 }, dispatch: { status: 'ACCEPTED' } }),
    ],
    [userToken(), bulkPrice('bulk-1349', 12, 1349), getOffer('get-offer-1349', 12, 1349), appToken(), browse('browse-vat-1605', 12, 1605, '3', true), bulkPrice('bulk-2100', 13, 2100)],
    { alerts: [{ code: 'EBAY_BUYER_PRICE_VAT_ON_TOP', severity: 'WARNING', count: 1, details: { vatBasisPoints: 1900 } }], logs: [{ code: 'EBAY_C14_BROWSE_PRICE_WITH_VAT', question: 'E-17', count: 1, details: { vatBasisPoints: 1900 } }],
      pipeline: { distrusts: [], halts: [], writes: [{ amountMinor: 1349, status: 'APPLIED' }, { amountMinor: 2100, status: 'ACCEPTED' }] } },
    ['docs/decisions.md#Р-116', 'docs/channel-capabilities.md#E-17']));

  // 11. Обнаружение → каталог: писать можно / нужна миграция / аукцион
  {
    const offer = (n: number) => ({
      offerId: pids(n).offerId, sku: pids(n).sku, marketplaceId: 'EBAY_DE', format: 'FIXED_PRICE', availableQuantity: 5,
      pricingSummary: { price: { value: '11.49', currency: 'EUR' } }, listing: { listingId: pids(n).listingId, listingStatus: 'ACTIVE', soldQuantity: 0 }, status: 'PUBLISHED',
    });
    const gms = `<?xml version="1.0" encoding="UTF-8"?>\n<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><ActiveList><ItemArray>`
      + ([[30, 'FixedPriceItem', '11.49'], [31, 'FixedPriceItem', '14.99'], [32, 'Chinese', '5.00']] as const).map(([n, type, price]) =>
        `<Item><ItemID>${pids(n).listingId}</ItemID><ListingType>${type}</ListingType><Quantity>4</Quantity><SellingStatus><CurrentPrice currencyID="EUR">${price}</CurrentPrice></SellingStatus>`
        + `<SKU>${pids(n).sku}</SKU><QuantityAvailable>4</QuantityAvailable></Item>`).join('')
      + '</ItemArray><PaginationResult><TotalNumberOfPages>1</TotalNumberOfPages><TotalNumberOfEntries>3</TotalNumberOfEntries></PaginationResult></ActiveList></GetMyeBaySellingResponse>';
    out.push(scenario('pipeline-discovery-catalog.json', 'ebay/pipeline/discovery-catalog',
      'Обнаружение eBay путём решения: листинг под Inventory API, старая фиксированная цена и аукцион попадают в каталог — каждый со своим правом записи',
      'pipeline.discoverOffers проходит обе фазы курсора адаптера: Inventory API (предложение 30 — writable) и GetMyeBaySelling (31 — фиксированная цена не под Inventory API, 32 — аукцион; 30 там тоже есть и не повторяется). Каталог пишет база (0140): 30 — ACTIVE с единицей записи цены в режиме OFF, 31 — MIGRATION_REQUIRED без единицы, 32 — INELIGIBLE без единицы; проверка строк — ebay.pipeline.pg.test.ts. Ответы Trading и 404 25713 — по форме песочницы.',
      ['mandatory:pipeline-discovery-catalog', 'discovery'],
      world({ scopes: [] }, { budget: { seller: { ratePerSecond: 100, burst: 100 } } }),
      [{ id: 'discover-all-listings', kind: 'pipelineDiscoverOffers', pageLimit: 5, expect: { offers: 3, withChannelPricing: [] } } as Step],
      [userToken(),
        { id: 'inventory-page', request: { method: 'GET', path: '/sell/inventory/v1/inventory_item', query: { limit: '5', offset: '0' } },
          response: { status: 200, body: { total: 1, size: 1, limit: 5, inventoryItems: [{ sku: pids(30).sku, condition: 'NEW' }] } } },
        { id: 'offers-30', request: { method: 'GET', path: '/sell/inventory/v1/offer', query: { sku: pids(30).sku } }, response: { status: 200, body: { total: 1, offers: [offer(30)] } } },
        { id: 'get-my-ebay-selling', request: { method: 'POST', path: '/ws/api.dll', body: getMyeBaySellingRequest(1, 5) }, response: { status: 200, headers: { 'content-type': 'text/xml' }, body: gms } },
      ],
      { noAlerts: true, logs: [{ code: 'EBAY_C16_TRADING_LISTING_SITE', count: 1, details: { legacy: 2 } }] },
      ['docs/decisions.md#Р-164']));
  }

  return out;
}

export const EBAY_PIPELINE_TENANT = TENANT;
