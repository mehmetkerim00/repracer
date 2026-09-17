import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import type { Exchange, Scenario, Step } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';
import { amazonWorld, anyOfferChanged, competitiveSummaryExchange, DE, delivery, patchPriceExchange, preReadExchange, pricingHealthNotification, readBackExchange, searchListingsExchange, sku, tokenExchange } from './build.ts';

/**
 * Сценарии ядра с адаптером Amazon (шаг 22): Р-115 — правило автоматического ценообразования канала блокирует единицу записи и
 * при записи, и при обратном чтении; Р-116 — применённая цена отличается от отправленной на ставку НДС: остановка витрины, любая
 * цена удерживается, снятие — только человеком. Данные синтетические.
 */

const SOURCES = [
  'vendor/amazon/sp-api-models/2026-09-16/models/listings-items-api-model/listingsItems_2021-08-01.json',
  'https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md',
  'docs/decisions.md#Р-115',
  'docs/decisions.md#Р-116',
];

const ACCOUNT = '20000000-0000-4000-8000-000000000001';

function fixedScope(unit: number, priceMinor: number, currentMinor: number): MemorySeedScope {
  return {
    writeScopeId: `ws-price-de-${unit}`, productId: `prod-${unit}`, channelAccountId: ACCOUNT, marketplace: DE, externalUnitId: sku(unit),
    channelProductRef: `B0${String(unit).padStart(8, '0')}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE',
    strategy: { strategyId: `st-fixed-${priceMinor}`, version: 1, params: { type: 'FIXED', priceMinor }, deadbandMinor: 0 },
    currentPriceMinor: currentMinor, minPrice: { amountMinor: 1000, id: `min-${unit}` }, maxPrice: { amountMinor: 5000, id: `max-${unit}` },
    // Ставка НДС товара [Р-53] — ей сверяется база цены при обратном чтении [Р-116]
    cost: { currency: 'EUR', costProfileId: `cp-${unit}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  };
}

function scenario(id: string, title: string, description: string, tags: string[], scopes: MemorySeedScope[], steps: Step[], exchanges: Exchange[], expect: Scenario['expect'],
  extra: { sources?: string[]; pricing?: Record<string, unknown> } = {}): Scenario {
  return {
    format: SCENARIO_FORMAT, id, channel: 'AMAZON', apiVersion: 'listings-items-2021-08-01', title, description, tags,
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: extra.sources ?? SOURCES },
    world: amazonWorld({ pricing: { scopes, marketplaces: { [DE]: { currency: 'EUR', basis: 'GROSS' } }, ...extra.pricing } } as never),
    steps, exchanges, expect,
  };
}

const recompute = (id: string, unit: number, expect: unknown): Step => ({ id, kind: 'pipelineRecompute', writeScopeId: `ws-price-de-${unit}`, trigger: { type: 'COST_CHANGE' }, expect } as Step);

export function buildCoreScenarios(): Array<{ file: string; scenario: Scenario }> {
  const basis = scenario(
    'amazon/pipeline/price-basis-mismatch-halt',
    'Р-116, Р-118: применённая цена больше отправленной ровно на НДС — недоверие каналу, фиксированная цена удерживается, снятие только человеком',
    'Фиксированная цена 19.99 уходит в amazon.de и принята асинхронно. Обратное чтение после окна: our_price 19.99 как отправлено, но цена покупки в offers — 23.79, то есть 19.99 × 1.19. Канал считает нашу сумму нетто [A-02]: каждая следующая цена будет выше на ту же долю — сломана трансляция цены в канал. Диспетчер ставит ОСТАНОВКУ ПО НЕДОВЕРИЮ КАНАЛУ [Р-118] и CRITICAL-алерт. Это не остановка витрины Р-51: удерживается и фиксированная цена второго товара; проверка остановок её не касается. Снять её не может ни оператор, ни владелец без второго фактора; владелец со вторым фактором и заметкой снимает — после этого цена второго товара уходит.',
    ['pipeline', 'dispatcher', 'r116', 'r118', 'mandatory:price-basis-readback'],
    [fixedScope(8101, 1999, 1850), fixedScope(8102, 2100, 2000)],
    [
      recompute('first-fixed-price-accepted', 8101, { decision: { outcome: 'APPROVED', finalMinor: 1999 } }),
      { id: 'in-flight-window-passes', kind: 'advanceClock', ms: 121_000 },
      { id: 'readback-shows-tax-added', kind: 'pipelineDispatchDue', expect: { due: 1, reports: [{ writeScopeId: 'ws-price-de-8101', steps: [
        { action: 'RECONCILED', version: 1, result: 'APPLIED', recorded: 'APPLIED' }, { action: 'CHANNEL_DISTRUSTED' }, { action: 'IDLE' }] }] } } as Step,
      recompute('second-fixed-price-held', 8102, { decision: { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' } }),
      { id: 'halt-review-does-not-touch-distrust', kind: 'pipelineReviewHalts', sampleSize: 5, expect: [] } as Step,
      { id: 'operator-cannot-release', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-operator', note: 'Operator tries to release the distrust' } as Step,
      { id: 'owner-without-second-factor-cannot-release', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-owner', mfa: false, note: 'Owner without a second factor' } as Step,
      recompute('still-held-after-refused-releases', 8102, { decision: { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' } }),
      { id: 'owner-releases-after-fixing-price-settings', kind: 'pipelineReleaseDistrust', distrustIndex: 0, membershipId: 'membership-owner', note: 'Preisbasis im Kanalkonto geprüft und korrigiert', expect: { released: true } } as Step,
      recompute('second-fixed-price-after-release', 8102, { decision: { outcome: 'APPROVED', finalMinor: 2100 } }),
    ],
    [
      tokenExchange(),
      preReadExchange('pre-read-8101', sku(8101), [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-8101-1999', sku(8101), [{ minor: 1999 }]),
      readBackExchange('readback-8101-net-treated', sku(8101), [{ priceMinor: 1999, purchaseMinor: 2379 }]),
      preReadExchange('pre-read-8102', sku(8102), [{ priceMinor: 2000 }]),
      patchPriceExchange('patch-8102-2100', sku(8102), [{ minor: 2100 }]),
    ],
    {
      alerts: [{ code: 'PRICING_CHANNEL_DISTRUSTED', severity: 'CRITICAL', count: 1 }, { code: 'PRICING_CHANNEL_TRUST_RESTORED', severity: 'WARNING', count: 1 }],
      pipeline: {
        halts: [],
        distrusts: [{ reasonCode: 'PRICE_BASIS_MISMATCH', released: true }],
        decisions: [
          { outcome: 'APPROVED', finalMinor: 1999 }, { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' }, { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' },
          { outcome: 'APPROVED', finalMinor: 2100 },
        ],
        writes: [{ amountMinor: 1999, status: 'APPLIED' }, { amountMinor: 2100, status: 'ACCEPTED' }],
      },
    },
  );

  const repricer = scenario(
    'amazon/pipeline/channel-repricer-blocks-scope',
    'Р-115: правило автоматического ценообразования Amazon у оффера — единица записи блокируется, продавец получает действие',
    'Первый товар: чтение перед записью показывает привязку automated_pricing_merchandising_rule_plan — PATCH не отправляется, запись отклонена CHANNEL_REPRICER_ACTIVE (REQUIRES_HUMAN), единица BLOCKED, CRITICAL-алерт с кодом и действием «выключить репрайсер канала». Второй товар: запись принята, а правило привязано в кабинете позже — изменения правил асинхронны, поэтому обратное чтение getListingsItem видит его уже после записи: сверка не повторяется час, единица блокируется сразу, принятая запись остаётся принятой.',
    ['pipeline', 'dispatcher', 'r115', 'mandatory:channel-repricer-pipeline'],
    [fixedScope(8201, 1999, 1850), fixedScope(8202, 2100, 2000)],
    [
      recompute('repricer-rule-before-write', 8201, { decision: { outcome: 'APPROVED', finalMinor: 1999 } }),
      recompute('scope-blocked-next-decision-held', 8201, { decision: { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE' } }),
      recompute('second-accepted', 8202, { decision: { outcome: 'APPROVED', finalMinor: 2100 } }),
      { id: 'in-flight-window-passes', kind: 'advanceClock', ms: 121_000 },
      { id: 'readback-sees-rule-after-write', kind: 'pipelineDispatchDue', expect: { due: 1, reports: [{ writeScopeId: 'ws-price-de-8202', steps: [
        { action: 'RECONCILED', version: 1, result: 'UNKNOWN', recorded: 'ACCEPTED' }] }] } } as Step,
      recompute('second-scope-blocked-next-decision-held', 8202, { decision: { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE' } }),
    ],
    [
      tokenExchange(),
      preReadExchange('pre-read-8201-rule', sku(8201), [{ priceMinor: 1850, rulePlan: true }]),
      preReadExchange('pre-read-8202', sku(8202), [{ priceMinor: 2000 }]),
      patchPriceExchange('patch-8202-2100', sku(8202), [{ minor: 2100 }]),
      readBackExchange('readback-8202-rule', sku(8202), [{ priceMinor: 2100, rulePlan: true }]),
    ],
    {
      alerts: [{ code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', count: 2, details: { code: 'CHANNEL_REPRICER_ACTIVE' } }],
      pipeline: {
        decisions: [
          { outcome: 'APPROVED', finalMinor: 1999 }, { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE', reasonParams: { status: 'BLOCKED', blockedByErrorCode: 'CHANNEL_REPRICER_ACTIVE', action: 'DISABLE_CHANNEL_REPRICER' } },
          { outcome: 'APPROVED', finalMinor: 2100 }, { outcome: 'HELD', rejectionReason: 'SCOPE_NOT_ACTIVE', reasonParams: { status: 'BLOCKED', blockedByErrorCode: 'CHANNEL_REPRICER_ACTIVE', action: 'DISABLE_CHANNEL_REPRICER' } },
        ],
        writes: [{ amountMinor: 1999, status: 'FAILED' }, { amountMinor: 2100, status: 'ACCEPTED' }],
        // Р-120 (ревью шага 23, находка 2): найденное при записи и сверке правило — наблюдение оффера, как при обнаружении
        offerChannelPricing: [
          { externalSku: sku(8201), automatedPricing: true, channelBounds: false, source: 'PRE_WRITE_READ' },
          { externalSku: sku(8202), automatedPricing: true, channelBounds: false, source: 'READBACK' },
        ],
      },
    },
  );

  const discovery = scenario(
    'amazon/pipeline/discovery-channel-pricing',
    'Р-120: при обнаружении офферов видно правило автоматического ценообразования и границы канала — до назначения стратегии',
    'Путь решения читает офферы аккаунта searchListingsItems с атрибутами. У первого оффера — привязка automated_pricing_merchandising_rule_plan (Automate Pricing), у второго — minimum/maximum_seller_allowed_price, третий чистый. Наблюдения записываются для всех трёх; продавец получает предупреждение о двух офферах, а назначить им стратегию не даст база (write_scope_strategy_guard, 0082). Раньше правило обнаруживалось только при первой записи цены [Р-115].',
    ['pipeline', 'r120', 'mandatory:discovery-channel-pricing'],
    [fixedScope(8301, 1999, 1850), fixedScope(8302, 2100, 2000), fixedScope(8303, 2200, 2100)],
    [{ id: 'discover-account-offers', kind: 'pipelineDiscoverOffers', expect: { offers: 3, recorded: 3, withChannelPricing: [
      { marketplace: DE, externalSku: sku(8301), automatedPricing: true, channelBounds: false },
      { marketplace: DE, externalSku: sku(8302), automatedPricing: false, channelBounds: true },
    ] } } as Step],
    [
      tokenExchange(),
      searchListingsExchange('search-account-offers', [
        { sku: sku(8301), offers: [{ priceMinor: 1850, rulePlan: true }] },
        { sku: sku(8302), offers: [{ priceMinor: 2000, bounds: true }] },
        { sku: sku(8303), offers: [{ priceMinor: 2100 }] },
      ]),
    ],
    {
      alerts: [{ code: 'OFFERS_WITH_CHANNEL_PRICING', severity: 'WARNING', count: 1, details: { offers: 2 } }],
      pipeline: { offerChannelPricing: [
        { externalSku: sku(8301), automatedPricing: true, channelBounds: false, source: 'DISCOVERY' },
        { externalSku: sku(8302), automatedPricing: false, channelBounds: true, source: 'DISCOVERY' },
        { externalSku: sku(8303), automatedPricing: false, channelBounds: false, source: 'DISCOVERY' },
      ] },
    },
  );

  // Шаг 23, A: приёмник уведомлений из очереди SQS целиком — очередь в памяти по протоколу AWS JSON, подпись SigV4, адаптер, путь решения
  const ASIN = 'B000008401';
  const aoc = (n: string, atMs: number, minor: number, seller?: string) =>
    anyOfferChanged(`syn-notification-${n}`, DE, ASIN, { $clockIso: atMs }, [{ seller: 'Synthetic Competitor', minor, buyBoxWinner: true }, { seller: 'self', minor: 1850 }], seller);
  const outcomes = (...list: Array<[string, string]>) => [{ outcomes: list.map(([n, outcome]) => ({ notificationId: `syn-notification-${n}`, outcome })) }];
  const receiver = scenario(
    'amazon/pipeline/notification-receiver',
    'Шаг 23: приёмник уведомлений — дубль, нарушение порядка, PRICING_HEALTH, чужой продавец, сбой хранилища, опоздание, искажённое тело',
    'Стандартная очередь SQS не гарантирует порядок и доставляет повторно (set-up-notifications-with-amazon-sqs). Пачка обрабатывается по EventTime; повтор NotificationId — DUPLICATE по журналу хранилища, в путь не идёт, из очереди удаляется; PRICING_HEALTH — состояние оффера и алерт; продавец без аккаунта — UNKNOWN_SELLER с алертом; сбой хранилища — сообщение остаётся, повтор после паузы видимости; опоздавшее уведомление — алерт NOTIFICATION_LATE, а старый снимок ядро не применяет поверх нового; искажённое тело (MD5) не удаляется — придёт снова и уйдёт в очередь недоставленных.',
    ['pipeline', 'receiver', 'mandatory:notification-receiver'],
    [fixedScope(8401, 1850, 1850)],
    [
      { id: 'batch-out-of-order-with-duplicate', kind: 'receiverPoll', send: [
        { body: aoc('0302', -5_000, 1780) }, { body: aoc('0301', -30_000, 1790), copies: 2 }, { body: pricingHealthNotification('syn-notification-0303', DE, ASIN, { $clockIso: -10_000 }, 1799) },
      ], expect: { polls: outcomes(['0301', 'DELIVERED'], ['0301', 'DUPLICATE'], ['0303', 'DELIVERED'], ['0302', 'DELIVERED']), queued: 0 } },
      { id: 'redelivery-after-a-lost-delete', kind: 'receiverPoll', send: [{ body: aoc('0302', -5_000, 1780) }], expect: { polls: outcomes(['0302', 'DUPLICATE']), queued: 0 } },
      { id: 'seller-without-account', kind: 'receiverPoll', send: [{ body: aoc('0304', -1_000, 1700, 'A9SYNOTHERSELLER') }], expect: { polls: outcomes(['0304', 'UNKNOWN_SELLER']), queued: 0 } },
      { id: 'store-fails-message-stays', kind: 'receiverPoll', failSink: 1, send: [{ body: aoc('0305', -2_000, 1770) }], expect: { polls: outcomes(['0305', 'RETRY']), queued: 1 } },
      { id: 'retry-after-visibility-pause', kind: 'receiverPoll', advanceMs: 31_000, expect: { polls: outcomes(['0305', 'DELIVERED']), queued: 0 } },
      { id: 'late-and-older-than-accepted', kind: 'receiverPoll', send: [{ body: aoc('0306', -16 * 60_000, 1760), ageMs: 16 * 60_000 }],
        expect: { polls: [{ outcomes: [{ notificationId: 'syn-notification-0306', outcome: 'DELIVERED', late: true }] }], queued: 0 } },
      // OQ-171 (шаг 24): два приёмника одновременно получают повтор одного уведомления — журнал в транзакции снимка пропускает одно
      { id: 'parallel-duplicate-processed-once', kind: 'receiverPoll', parallelReceivers: 2, send: [{ body: aoc('0308', -500, 1740), copies: 2 }],
        expect: { polls: { $unordered: [
          { outcomes: [{ notificationId: 'syn-notification-0308', outcome: 'DELIVERED' }] },
          { outcomes: [{ notificationId: 'syn-notification-0308', outcome: 'DUPLICATE' }] },
        ] }, queued: 0 } },
      { id: 'corrupt-body-is-kept', kind: 'receiverPoll', send: [{ body: aoc('0307', -1_000, 1750), corruptMd5: true }], expect: { polls: [{ outcomes: [{ outcome: 'CORRUPT' }], deleted: 0 }], queued: 1 } },
    ] as Step[],
    [],
    {
      alerts: [
        { code: 'OFFER_PRICING_HEALTH', severity: 'WARNING', count: 1, details: { issueType: 'BuyBoxDisqualification' } },
        { code: 'NOTIFICATION_UNKNOWN_SELLER', severity: 'WARNING', count: 1 },
        { code: 'NOTIFICATION_LATE', severity: 'WARNING', count: 1 },
      ],
      pipeline: {
        pricingHealth: [{ marketplace: DE, channelProductRef: ASIN, issueType: 'BuyBoxDisqualification', thresholdMinor: 1799 }],
        inboundNotifications: ['0301', '0303', '0302', '0305', '0306', '0308'].map((n) => ({ notificationId: `syn-notification-${n}` })),
        // Р-122 (шаг 24): журнал снимков — при любом вердикте; повтор уведомления в журнал не попадает
        snapshotLog: { $unordered: ['ACCEPT', 'ACCEPT', 'ACCEPT', 'REJECT', 'ACCEPT'].map((verdict) => ({ channelProductRef: ASIN, verdict, source: 'AMAZON_ANY_OFFER_CHANGED' })) },
      },
    },
  );

  // Шаг 23, B/C/F: мир консоли стенда — действующее недоверие каналу, оффер с Automate Pricing и состояние PRICING_HEALTH
  const consoleWorld = scenario(
    'amazon/pipeline/console-channel-trust',
    'Консоль: недоверие каналу держит все цены, оффер с правилом канала виден до стратегии, оффер выбыл из Featured Offer',
    'Мир стенда консоли (шаг 23). Первая фиксированная цена применена каналом с налогом сверху — недоверие каналу, все цены витрины удерживаются до снятия человеком [Р-118]; системной остановки нет и автоматического снятия у Amazon нет [Р-119]. Обнаружение офферов находит правило Automate Pricing у второго оффера [Р-120]. Уведомление PRICING_HEALTH первого оффера приходит через приёмник очереди.',
    ['pipeline', 'console-stand', 'r118', 'r120'],
    [fixedScope(8501, 1999, 1850), fixedScope(8502, 2100, 2000), fixedScope(8503, 2200, 2200)],
    [
      recompute('first-fixed-price-accepted', 8501, { decision: { outcome: 'APPROVED', finalMinor: 1999 } }),
      { id: 'in-flight-window-passes', kind: 'advanceClock', ms: 121_000 },
      { id: 'readback-shows-tax-added', kind: 'pipelineDispatchDue', expect: { due: 1 } } as Step,
      recompute('third-offer-held-while-distrusted', 8503, { decision: { outcome: 'REJECTED', rejectionReason: 'CHANNEL_DISTRUSTED' } }),
      { id: 'discover-account-offers', kind: 'pipelineDiscoverOffers', expect: { offers: 3, recorded: 3 } } as Step,
      { id: 'pricing-health-arrives', kind: 'receiverPoll', send: [{ body: pricingHealthNotification('syn-notification-0501', DE, 'B000008501', { $clockIso: -5_000 }, 1949) }],
        expect: { polls: [{ outcomes: [{ outcome: 'DELIVERED' }] }] } } as Step,
    ],
    [
      tokenExchange(),
      preReadExchange('pre-read-8501', sku(8501), [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-8501-1999', sku(8501), [{ minor: 1999 }]),
      readBackExchange('readback-8501-net-treated', sku(8501), [{ priceMinor: 1999, purchaseMinor: 2379 }]),
      searchListingsExchange('search-account-offers', [
        { sku: sku(8501), offers: [{ priceMinor: 1999 }] },
        { sku: sku(8502), offers: [{ priceMinor: 2000, rulePlan: true }] },
        { sku: sku(8503), offers: [{ priceMinor: 2200 }] },
      ]),
    ],
    {
      pipeline: {
        distrusts: [{ reasonCode: 'PRICE_BASIS_MISMATCH', released: false }],
        offerChannelPricing: [{ externalSku: sku(8501), automatedPricing: false }, { externalSku: sku(8502), automatedPricing: true }, { externalSku: sku(8503), automatedPricing: false }],
        pricingHealth: [{ channelProductRef: 'B000008501', thresholdMinor: 1949 }],
      },
    },
  );

  // Р-121 (шаг 24): сверка Amazon по кругу — квота getCompetitiveSummary не позволяет опрашивать все товары
  const refs = [8301, 8302, 8303].map((u) => `B0${String(u).padStart(8, '0')}`);
  const lossScopes = [8301, 8302, 8303].map((u) => ({ ...fixedScope(u, 1999, 1850), pricingMode: 'OFF' as const }));
  const rotation = scenario(
    'amazon/pipeline/notification-loss-rotation',
    'Р-121: сверка ANY_OFFER_CHANGED опросом по кругу — расхождение без уведомления до срока — подозрение на потерю с алертом',
    'Шаг 24. У ANY_OFFER_CHANGED нет номеров последовательности, очередь SQS теряет без следа (риск 21). getCompetitiveSummary — 0.033 запроса в секунду, до 20 ASIN: сверка идёт по кругу, окно товаров аккаунта сдвигается каждый цикл [AMZ_C11]. Последнее принятое состояние трёх товаров — наименьшая цена конкурента 18.00. Опрос: B000008301 — 17.80, уведомления не будет; B000008302 — 18.00; B000008303 — 17.50, ANY_OFFER_CHANGED приходит через 5 минут. Снимки опроса — в журнал с вердиктом RECONCILIATION, в решение не идут. Через 16 минут база ставит «задержка» товару 3 и «подозрение на потерю» товару 1; один CRITICAL-алерт. Сверяется наименьшая цена конкурента: победителя Buy Box ответ не даёт.',
    ['pipeline', 'r-121', 'notification-loss'],
    lossScopes,
    [
      { id: 'rotation-window', kind: 'pipelineReconcileRotation', size: 20, cycle: 0, graceSeconds: 900,
        expect: { queries: 3, failures: [], snapshots: [], reconciliation: { matched: 1, diverged: 2, noBaseline: 0, notNewer: 0, logged: 3 } } } as Step,
      { id: 'five-minutes', kind: 'advanceClock', ms: 300_000 },
      { id: 'late-any-offer-changed', kind: 'pipelineInbound', delivery: delivery(anyOfferChanged('syn-notification-0301', DE, refs[2]!, { $clockIso: -60_000 },
        [{ seller: 'Synthetic Competitor', minor: 1750, buyBoxWinner: true }, { seller: 'self', minor: 1850 }])),
        expect: { snapshots: [{ channelProductRef: refs[2] }] } } as Step,
      { id: 'review-before-due', kind: 'pipelineReviewNotificationLoss', expect: { delayed: 0, lossSuspected: [] } } as Step,
      { id: 'eleven-minutes', kind: 'advanceClock', ms: 660_000 },
      { id: 'review-after-due', kind: 'pipelineReviewNotificationLoss',
        expect: { delayed: 1, lossSuspected: [{ verdict: 'LOSS_SUSPECTED', marketplace: DE, channelProductRef: refs[0], condition: 'new' }] } } as Step,
    ],
    [
      tokenExchange(),
      competitiveSummaryExchange('summary-rotation', [
        { asin: refs[0]!, offers: [{ seller: 'A1SYNCOMPETITOR', minor: 1780 }, { seller: 'A1SYNSELLER0001', minor: 1850 }] },
        { asin: refs[1]!, offers: [{ seller: 'A1SYNCOMPETITOR', minor: 1800 }, { seller: 'A1SYNSELLER0001', minor: 1850 }] },
        { asin: refs[2]!, offers: [{ seller: 'A1SYNCOMPETITOR', minor: 1750 }, { seller: 'A1SYNSELLER0001', minor: 1850 }] },
      ]),
    ],
    {
      alerts: [{ code: 'NOTIFICATION_LOSS_SUSPECTED', severity: 'CRITICAL', count: 1 }],
      pipeline: {
        writes: [],
        lossChecks: { $unordered: [
          { channelProductRef: refs[0], compared: 'LOWEST_COMPETITOR', heldMinor: 1800, pollMinor: 1780, verdict: 'LOSS_SUSPECTED' },
          { channelProductRef: refs[2], compared: 'LOWEST_COMPETITOR', heldMinor: 1800, pollMinor: 1750, verdict: 'DELAYED' },
        ] },
        snapshotLog: { $unordered: [
          ...refs.map((r) => ({ channelProductRef: r, verdict: 'RECONCILIATION', delivery: 'POLL', source: 'AMAZON_COMPETITIVE_SUMMARY' })),
          { channelProductRef: refs[2], delivery: 'PUSH', source: 'AMAZON_ANY_OFFER_CHANGED' },
        ] },
      },
    },
    {
      sources: ['vendor/amazon/sp-api-models/2026-09-16/models/product-pricing-api-model/productPricing_2022-05-01.json', 'https://developer-docs.amazon/sp-api/docs/notification-type-values.md', 'docs/decisions.md#Р-121'],
      pricing: { competitorState: Object.fromEntries(refs.map((r) => [`${DE}|${r}|new`, { observedAt: '2026-09-14T09:30:00.000Z', buyboxMinor: 1800, lowestMinor: 1800 }])) },
    },
  );

  return [
    { file: 'pipeline-notification-loss-rotation.json', scenario: rotation },
    { file: 'pipeline-discovery-channel-pricing.json', scenario: discovery },
    { file: 'pipeline-console-channel-trust.json', scenario: consoleWorld },
    { file: 'pipeline-notification-receiver.json', scenario: receiver },
    { file: 'pipeline-price-basis-mismatch-halt.json', scenario: basis },
    { file: 'pipeline-channel-repricer-blocks-scope.json', scenario: repricer },
  ];
}
