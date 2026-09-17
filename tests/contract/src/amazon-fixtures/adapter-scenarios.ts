import type { Exchange, Scenario, Step } from '../harness/scenario.ts';
import { SCENARIO_FORMAT } from '../harness/scenario.ts';
import { accepted, amazonWorld, anyOfferChanged, DE, delivery, patchPriceExchange, preReadExchange, pricingHealthNotification, readBackExchange, SELLER, tokenExchange, US } from './build.ts';

/** Сценарии адаптера Amazon: обязательные сценарии Kaufland в смысле Amazon и асинхронное применение (шаг 22). Данные синтетические */

const SOURCES = [
  'vendor/amazon/sp-api-models/2026-09-16/models/listings-items-api-model/listingsItems_2021-08-01.json',
  'https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md',
  'https://developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits.md',
  'https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide.md',
];

const SKU = 'SYN-SKU-7001';

function priceWrite(id: string, version: number, minor: number, marketplace = DE, currency = 'EUR', basis = 'GROSS') {
  return {
    channelWriteId: id, version, idempotencyKey: `${id}:${version}`, attemptNo: 1,
    writeScope: { writeScopeId: `ws-amz-price-${marketplace}-7001`, field: 'PRICE', scopeKey: `amazon|acct-1|${marketplace === DE ? 'EU' : 'NA'}|${marketplace}|${SKU}`,
      identity: { region: marketplace === DE ? 'EU' : 'NA', marketplace, externalSku: SKU } },
    value: { field: 'PRICE', price: { amountMinor: minor, currency, basis } },
  };
}

function quantityWrite(id: string, version: number, quantity: number) {
  return {
    channelWriteId: id, version, idempotencyKey: `${id}:${version}`, attemptNo: 1,
    writeScope: { writeScopeId: 'ws-amz-qty-EU-7001', field: 'QUANTITY', scopeKey: `amazon|acct-1|EU|${SKU}`, identity: { region: 'EU', marketplace: DE, externalSku: SKU } },
    value: { field: 'QUANTITY', quantity },
  };
}

const batch = (batchId: string, items: unknown[]) => ({ batchId, operation: 'patchListingsItem', items, budgetCharges: [], requestCount: 2 });

function scenario(id: string, title: string, description: string, tags: string[], steps: Step[], exchanges: Exchange[], expect: Scenario['expect'] = {}, world = amazonWorld()): Scenario {
  return { format: SCENARIO_FORMAT, id, channel: 'AMAZON', apiVersion: 'listings-items-2021-08-01', title, description, tags,
    provenance: { kind: 'SYNTHETIC_FROM_DOCS', sources: SOURCES }, world, steps, exchanges, expect };
}

const call = (id: string, method: string, args: unknown[], expect?: unknown, extra: Record<string, unknown> = {}) =>
  ({ id, kind: 'call', method, args, ...(expect !== undefined ? { expect } : {}), ...extra }) as Step;

export function buildAdapterScenarios(): Array<{ file: string; scenario: Scenario }> {
  const out: Array<{ file: string; scenario: Scenario }> = [];
  const add = (file: string, s: Scenario) => out.push({ file, scenario: s });

  add('dispatch-submission-issues.json', scenario('amazon/dispatch/submission-issues',
    'Отправка отклонена или принята с предупреждением — ошибки по отправке, а не по элементам пакета',
    'Аналог bulk-207-partial. У Amazon нет пакета из разных офферов: одна отправка — один SKU, несколько витрин региона. INVALID с ошибкой INVALID_PRICE — отказ VALIDATION без повтора; ACCEPTED с WARNING — принято. Разбор ошибок по витринам (marketplaceIds у issue) в Release 1.0 не проверить на живом примере: в регионе EU одна витрина amazon.de (Р-56) — модульный тест адаптера.',
    ['mandatory:bulk-207-partial', 'dispatch'],
    [
      call('invalid', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1999)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'REJECTED', error: { code: 'VALIDATION', class: 'PERMANENT', scope: 'ITEM', channelCode: 'SYN_INVALID_PRICE' } }], attemptsMade: 2 }),
      call('accepted-with-warning', 'dispatch', [batch('amz:b2', [priceWrite('cw-2', 2, 2099)])], { outcomes: [{ channelWriteId: 'cw-2', status: 'ACCEPTED', appliedImmediately: false, submissionRef: `syn-submission-${SKU}` }] }),
    ],
    [
      tokenExchange(),
      preReadExchange('read-1', SKU, [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-1999-invalid', SKU, [{ minor: 1999 }], { status: 200, body: { sku: SKU, status: 'INVALID', submissionId: 'syn-submission-invalid',
        issues: [{ code: 'SYN_INVALID_PRICE', message: 'Synthetic invalid price issue', severity: 'ERROR', attributeNames: ['purchasable_offer'], categories: ['INVALID_PRICE'] }] } }),
      preReadExchange('read-2', SKU, [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-2099-warning', SKU, [{ minor: 2099 }], accepted(SKU, [{ code: 'SYN_WARNING', message: 'Synthetic warning', severity: 'WARNING', categories: [] }])),
    ],
    { noAlerts: true, logs: [{ code: 'AMZ_C09_PRODUCT_TYPE_FROM_SUMMARIES', count: 2 }] }));

  add('dispatch-429.json', scenario('amazon/dispatch/429',
    '429 на записи: транспорт повторяет (запрос не принят); после исчерпания попыток — RATE_LIMITED',
    'Страница лимитов: 429 — частота выше лимита; запрос не обработан, повтор безопасен и для PATCH. Первая отправка: 429, затем принято. Вторая: три 429 — RATE_LIMITED с retryAt, класс TRANSIENT.',
    ['mandatory:429', 'dispatch'],
    [
      call('retried-then-accepted', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'ACCEPTED', appliedImmediately: false }], attemptsMade: 3 }),
      call('throttled', 'dispatch', [batch('amz:b2', [priceWrite('cw-2', 2, 1799)])], { outcomes: [{ channelWriteId: 'cw-2', status: 'REJECTED', error: { code: 'RATE_LIMITED', class: 'TRANSIENT', retryAt: { $isoInstant: true } } }], attemptsMade: 4 }),
    ],
    [
      tokenExchange(),
      preReadExchange('read-1', SKU, [{ priceMinor: 1850 }]),
      { ...patchPriceExchange('patch-1899-429', SKU, [{ minor: 1899 }], { status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'The frequency of requests was greater than what is allowed for the application.' }] } }) },
      { ...patchPriceExchange('patch-1899-ok', SKU, [{ minor: 1899 }]) },
      preReadExchange('read-2', SKU, [{ priceMinor: 1899 }]),
      ...[1, 2, 3].map((n) => patchPriceExchange(`patch-1799-429-${n}`, SKU, [{ minor: 1799 }], { status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'The frequency of requests was greater than what is allowed for the application.' }] } })),
    ],
    { noAlerts: true }));

  add('dispatch-timeout-unknown-outcome.json', scenario('amazon/dispatch/timeout-unknown-outcome',
    'Тайм-аут PATCH: исход неизвестен, повтора нет; обратное чтение показывает применённую цену',
    'patchListingsItem не повторяется транспортом [AMZ_C02]: OUTCOME_UNKNOWN. Через минуту обратное чтение: our_price совпадает с отправленной — подтверждение APPLIED.',
    ['mandatory:timeout-unknown-outcome', 'dispatch'],
    [
      call('timed-out', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'OUTCOME_UNKNOWN', error: { code: 'TIMEOUT' } }] }),
      { id: 'one-minute', kind: 'advanceClock', ms: 60_000 },
      call('confirm', 'confirm', [[{ channelWriteId: 'cw-1', writeScope: priceWrite('cw-1', 1, 1899).writeScope, expected: { field: 'PRICE', price: { amountMinor: 1899, currency: 'EUR', basis: 'GROSS' } }, dispatchedAt: { $clockIso: -60_000 } }]],
        [{ channelWriteId: 'cw-1', status: 'APPLIED', observation: { field: 'PRICE', value: { price: { amountMinor: 1899 } }, effectivePrice: { amountMinor: 1899 }, source: 'READBACK' } }]),
    ],
    [tokenExchange(), preReadExchange('read-1', SKU, [{ priceMinor: 1850 }]), patchPriceExchange('patch-1899-timeout', SKU, [{ minor: 1899 }], 'TIMEOUT'), readBackExchange('readback', SKU, [{ priceMinor: 1899 }])],
    { noAlerts: true, logs: [{ code: 'AMZ_C02_NO_TRANSPORT_RETRY_FOR_WRITES', count: 1 }] }));

  const aoc = (idN: string, minor: number, seller = SELLER) => delivery(anyOfferChanged(idN, DE, 'B000007001', { $clockIso: -5_000 },
    [{ seller: 'Synthetic Competitor', minor, buyBoxWinner: true }, { seller: 'self', minor: 1850 }], seller));
  add('notification-duplicate.json', scenario('amazon/notification/duplicate',
    'Повтор уведомления ANY_OFFER_CHANGED: тот же NotificationId — тот же deliveryId',
    'Адаптер без состояния: повторная доставка даёт тот же deliveryId и sourceEventId, дедупликацию делает ядро. Новое уведомление — новый идентификатор.',
    ['mandatory:webhook-duplicate', 'inbound'],
    [
      { id: 'first', kind: 'inbound', delivery: aoc('syn-notification-0001', 1780), expect: { kind: 'EVENTS', deliveryId: 'amazon:syn-notification-0001',
        events: [{ kind: 'COMPETITOR_SNAPSHOT', snapshot: { marketplace: DE, channelProductRef: 'B000007001', source: 'AMAZON_ANY_OFFER_CHANGED', sourceEventId: 'syn-notification-0001',
          buybox: { price: { amountMinor: 1780, currency: 'EUR', basis: 'GROSS' }, isSelf: false } } }] } },
      { id: 'one-second', kind: 'advanceClock', ms: 1000 },
      { id: 'repeat', kind: 'inbound', delivery: aoc('syn-notification-0001', 1780), expect: { kind: 'EVENTS', deliveryId: 'amazon:syn-notification-0001' } },
      { id: 'next', kind: 'inbound', delivery: aoc('syn-notification-0002', 1770), expect: { kind: 'EVENTS', deliveryId: 'amazon:syn-notification-0002' } },
    ], [], { noAlerts: true, logs: [{ code: 'AMZ_C08_NOTIFICATION_NOT_SIGNED', count: 3 }] }));

  add('notification-pricing-health.json', scenario('amazon/notification/pricing-health',
    'PRICING_HEALTH: оффер выбыл из Featured Offer — состояние оффера с порогом конкурентной цены; чужой SellerId — отказ',
    'Шаг 23. Схема PricingHealthNotification.json снимка: ключи со строчной буквы. Событие PRICING_HEALTH несёт витрину, ASIN, состояние, issueType и порог summary.referencePrice.competitivePriceThreshold; порога нет — null. SellerId сверяется с аккаунтом так же, как у ANY_OFFER_CHANGED [Р-31].',
    ['inbound', 'pricing-health'],
    [
      { id: 'with-threshold', kind: 'inbound', delivery: delivery(pricingHealthNotification('syn-notification-0201', DE, 'B000007001', { $clockIso: -5_000 }, 1799)),
        expect: { kind: 'EVENTS', deliveryId: 'amazon:syn-notification-0201', events: [{ kind: 'PRICING_HEALTH', health: {
          marketplace: DE, channelProductRef: 'B000007001', condition: 'new', issueType: 'BuyBoxDisqualification', sourceEventId: 'syn-notification-0201',
          competitivePriceThreshold: { amountMinor: 1799, currency: 'EUR', basis: 'GROSS' } } }] } },
      { id: 'without-threshold', kind: 'inbound', delivery: delivery(pricingHealthNotification('syn-notification-0202', DE, 'B000007001', { $clockIso: -4_000 }, null)),
        expect: { kind: 'EVENTS', events: [{ kind: 'PRICING_HEALTH', health: { competitivePriceThreshold: null } }] } },
      { id: 'foreign-seller', kind: 'inbound', delivery: delivery(pricingHealthNotification('syn-notification-0203', DE, 'B000007001', { $clockIso: -3_000 }, 1799, 'A9SYNOTHERSELLER')),
        expect: { kind: 'REJECTED', error: { code: 'TENANT_MISMATCH' } } },
    ], [], { alerts: [{ code: 'AMAZON_NOTIFICATION_SELLER_MISMATCH', severity: 'CRITICAL', count: 1 }], logs: [{ code: 'AMZ_C08_NOTIFICATION_NOT_SIGNED', count: 3 }] }));

  add('notification-unverifiable.json', scenario('amazon/notification/unverifiable',
    'Уведомление без подписи: чужой SellerId, не JSON, не тот тип, витрина не подключена',
    'Аналог webhook-bad-signature. Уведомления SP-API приходят из очереди без подписи [AMZ_C08]: проверяется совпадение SellerId с аккаунтом из сообщения [Р-31] — несовпадение — отказ TENANT_MISMATCH и алерт CRITICAL; не JSON, другой тип и PRICING_HEALTH не в своём написании ключей — 400; витрина не подключена — принято без событий.',
    ['mandatory:webhook-bad-signature', 'inbound'],
    [
      { id: 'foreign-seller', kind: 'inbound', delivery: aoc('syn-notification-0101', 1780, 'A9SYNOTHERSELLER'), expect: { kind: 'REJECTED', error: { code: 'TENANT_MISMATCH', class: 'REQUIRES_HUMAN' } } },
      { id: 'not-json', kind: 'inbound', delivery: { method: 'POST', url: 'https://sqs.invalid/q', rawBody: 'not json' }, expect: { kind: 'REJECTED', responseStatus: 400, error: { code: 'VALIDATION' } } },
      { id: 'other-type', kind: 'inbound', delivery: delivery({ NotificationType: 'LISTINGS_ITEM_ISSUES_CHANGE', NotificationMetadata: { NotificationId: 'syn-notification-0102' } }), expect: { kind: 'REJECTED', responseStatus: 400 } },
      { id: 'pricing-health-with-pascal-keys', kind: 'inbound', delivery: delivery({ NotificationType: 'PRICING_HEALTH', NotificationMetadata: { NotificationId: 'syn-notification-0104' } }), expect: { kind: 'REJECTED', responseStatus: 400 } },
      { id: 'store-not-enabled', kind: 'inbound', delivery: delivery(anyOfferChanged('syn-notification-0103', US, 'B000007001', { $clockIso: -5_000 }, [{ seller: 'Synthetic Competitor', minor: 1780, buyBoxWinner: true, currency: 'USD' }])),
        expect: { kind: 'EVENTS', deliveryId: 'amazon:syn-notification-0103', events: [] } },
    ], [], { alerts: [{ code: 'AMAZON_NOTIFICATION_SELLER_MISMATCH', severity: 'CRITICAL', count: 1 }], logs: [{ code: 'AMZ_INBOUND_MARKETPLACE_NOT_ENABLED', count: 1 }] }));

  add('plan-stale-version.json', scenario('amazon/plan/stale-version-and-never-written',
    'План: устаревшая версия отклоняется, CHANNEL_MIN_PRICE не пишется никогда, витрина другого региона — отказ',
    'INV-03: из двух записей одной единицы уходит старшая. Р-111, Р-114: minimum_seller_allowed_price — второй набор границ в канале, отказ UNSUPPORTED без обращения к Amazon. Аккаунт региона EU не пишет в amazon.com.',
    ['mandatory:stale-version', 'plan'],
    [call('plan', 'planDispatch', [[priceWrite('cw-old', 1, 1899), priceWrite('cw-new', 2, 1799),
      { ...priceWrite('cw-floor', 3, 1500), value: { field: 'CHANNEL_MIN_PRICE', minPrice: { amountMinor: 1500, currency: 'EUR', basis: 'GROSS' } } },
      priceWrite('cw-us', 1, 1999, US, 'USD', 'NET')]],
      { batches: [{ operation: 'patchListingsItem', items: [{ channelWriteId: 'cw-new' }], requestCount: 2 }],
        rejected: { $unordered: [
          { channelWriteId: 'cw-old', error: { code: 'STALE_VERSION' } },
          { channelWriteId: 'cw-floor', error: { code: 'UNSUPPORTED', class: 'PERMANENT' } },
          { channelWriteId: 'cw-us', error: { code: 'PRECONDITION_FAILED' } },
        ] } })], [], { noAlerts: true }));

  const sixWrites = Array.from({ length: 6 }, (_, i) => call(`dispatch-${i + 1}`, 'dispatch', [batch(`amz:b${i + 1}`, [priceWrite(`cw-${i + 1}`, i + 1, 1800 + i)])]));
  sixWrites[5] = call('dispatch-6', 'dispatch', [batch('amz:b6', [priceWrite('cw-6', 6, 1805)])], { outcomes: [{ channelWriteId: 'cw-6', status: 'REJECTED', error: { code: 'RATE_LIMITED', retryAt: { $isoInstant: true } } }], attemptsMade: 0 });
  add('budget-exhausted.json', scenario('amazon/budget/pair-level-exhausted',
    'Бюджет пары аккаунт–приложение: шестая отправка в ту же секунду не уходит',
    'Страница лимитов: getListingsItem и patchListingsItem — 5 запросов в секунду на пару, burst 5. Пять отправок (чтение и запись) в одну виртуальную секунду проходят; шестая не отправляется: RATE_LIMITED с retryAt, журнал AMZ_C01 с уровнем PAIR.',
    ['mandatory:budget-exhausted', 'budget'],
    sixWrites,
    [tokenExchange(), ...Array.from({ length: 5 }, (_, i) => [preReadExchange(`read-${i + 1}`, SKU, [{ priceMinor: 1850 }]), patchPriceExchange(`patch-${i + 1}`, SKU, [{ minor: 1800 + i }])]).flat()],
    { noAlerts: true, logs: [{ code: 'AMZ_C01_TWO_LEVEL_BUDGET', count: 1, details: { level: 'PAIR', operation: 'getListingsItem' } }] }));

  add('budget-application-level.json', scenario('amazon/budget/application-level-exhausted',
    'Бюджет приложения: другие продавцы того же приложения исчерпали общий лимит',
    'Порог, достигнутый первым, — лимит приложения, а не пары: при нагрузке 100 запросов в секунду на getListingsItem у приложения (лимит 100) даже первая отправка продавца не уходит — RATE_LIMITED, уровень APPLICATION. Бюджет приложения общий для тенантов процесса (AMZ_C01).',
    ['budget'],
    [call('dispatch', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'REJECTED', error: { code: 'RATE_LIMITED' } }], attemptsMade: 0 })],
    [], { noAlerts: true, logs: [{ code: 'AMZ_C01_TWO_LEVEL_BUDGET', count: 1, details: { level: 'APPLICATION' } }] },
    amazonWorld({ adapter: { amazonApplicationLoadRps: 100 } })));

  const confirmReq = (minor: number, dispatchedOffsetMs: number) => [[{ channelWriteId: 'cw-1', writeScope: priceWrite('cw-1', 1, minor).writeScope,
    expected: { field: 'PRICE', price: { amountMinor: minor, currency: 'EUR', basis: 'GROSS' } }, dispatchedAt: { $clockIso: dispatchedOffsetMs } }]];
  add('async-apply.json', scenario('amazon/confirm/async-apply',
    'Асинхронное применение: принято, через 20 секунд ещё старая цена — PENDING; через 5 минут применено',
    'building-listings-management-workflows-guide: ACCEPTED означает, что данные прошли первичную проверку и отправлены на обработку. Подтверждение — обратным чтением our_price [AMZ_C05].',
    ['mandatory:async-apply', 'confirm'],
    [
      call('dispatch', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'ACCEPTED', appliedImmediately: false }] }),
      { id: 'twenty-seconds', kind: 'advanceClock', ms: 20_000 },
      call('still-old', 'confirm', confirmReq(1899, -20_000), [{ channelWriteId: 'cw-1', status: 'PENDING', checkAfter: { $isoInstant: true } }]),
      { id: 'five-minutes', kind: 'advanceClock', ms: 300_000 },
      call('applied', 'confirm', confirmReq(1899, -320_000), [{ channelWriteId: 'cw-1', status: 'APPLIED' }]),
    ],
    [tokenExchange(), preReadExchange('read', SKU, [{ priceMinor: 1850 }]), patchPriceExchange('patch', SKU, [{ minor: 1899 }]),
      readBackExchange('readback-old', SKU, [{ priceMinor: 1850 }]), readBackExchange('readback-new', SKU, [{ priceMinor: 1899 }])],
    { noAlerts: true, logs: [{ code: 'AMZ_C05_CONFIRMATION_WINDOW', count: 1 }] }));

  add('accepted-not-applied.json', scenario('amazon/confirm/accepted-not-applied',
    'Принято, но не применено: через 31 минуту цена в канале прежняя — NOT_APPLIED',
    'Окно подтверждения адаптера — 30 минут (A-06, AMZ_C05). После окна несовпадение — NOT_APPLIED с наблюдением фактической цены; ядро поднимает PRICE_WRITE_NOT_SENT (симулятор шага 21, предел диспетчера).',
    ['mandatory:accepted-not-applied', 'confirm'],
    [
      call('dispatch', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'ACCEPTED', appliedImmediately: false }] }),
      { id: 'thirty-one-minutes', kind: 'advanceClock', ms: 31 * 60_000 },
      call('not-applied', 'confirm', confirmReq(1899, -31 * 60_000), [{ channelWriteId: 'cw-1', status: 'NOT_APPLIED', observation: { value: { price: { amountMinor: 1850 } } } }]),
    ],
    [tokenExchange(), preReadExchange('read', SKU, [{ priceMinor: 1850 }]), patchPriceExchange('patch', SKU, [{ minor: 1899 }]), readBackExchange('readback', SKU, [{ priceMinor: 1850 }])],
    { noAlerts: true, logs: [{ code: 'AMZ_C05_CONFIRMATION_WINDOW', count: 1 }] }));

  add('channel-repricer-detected.json', scenario('amazon/channel-owned-pricing/repricer-rule',
    'Р-115: у оффера правило автоматического ценообразования — цена не пишется, единица требует человека',
    'Чтение перед записью видит automated_pricing_merchandising_rule_plan у purchasable_offer amazon.de: PATCH не отправляется, отказ CHANNEL_REPRICER_ACTIVE класса REQUIRES_HUMAN (ядро блокирует единицу и поднимает алерт). Обратное чтение видит то же: правила меняются асинхронно, поэтому состояние читается при каждой сверке.',
    ['mandatory:channel-repricer', 'r115'],
    [
      call('dispatch', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'REJECTED', error: { code: 'CHANNEL_REPRICER_ACTIVE', class: 'REQUIRES_HUMAN', raiseAlert: true } }], attemptsMade: 1 }),
      call('readback', 'readBack', [[{ writeScope: priceWrite('cw-1', 1, 1899).writeScope, fields: ['PRICE'] }]], { observations: [], failures: [{ writeScopeId: 'ws-amz-price-A1PA6795UKMFR9-7001', error: { code: 'CHANNEL_REPRICER_ACTIVE' } }] }),
    ],
    [tokenExchange(), preReadExchange('read', SKU, [{ priceMinor: 1850, rulePlan: true }]), readBackExchange('readback', SKU, [{ priceMinor: 1850, rulePlan: true }])],
    { logs: [{ code: 'AMZ_C03_READ_BEFORE_PRICE_WRITE', count: 1, details: { repricer: true } }] }));

  add('channel-bounds-present.json', scenario('amazon/channel-owned-pricing/second-bounds',
    'Р-114: у оффера минимальная и максимальная цена в Amazon — цена не пишется; ошибка отправки по этим атрибутам — тот же код',
    'Границы в канале — второй набор границ: базовая цена обязана лежать между ними, иначе Amazon отклоняет запись (Р-114). Первая отправка: чтение видит minimum_seller_allowed_price — отказ CHANNEL_BOUNDS_PRESENT без PATCH. Вторая: границ в прочитанных атрибутах нет, но отправка INVALID с ошибкой по minimum_seller_allowed_price — тот же код, REQUIRES_HUMAN.',
    ['r114'],
    [
      call('dispatch-bounds-seen', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'REJECTED', error: { code: 'CHANNEL_BOUNDS_PRESENT', class: 'REQUIRES_HUMAN' } }] }),
      call('dispatch-bounds-issue', 'dispatch', [batch('amz:b2', [priceWrite('cw-2', 2, 1899)])], { outcomes: [{ channelWriteId: 'cw-2', status: 'REJECTED', error: { code: 'CHANNEL_BOUNDS_PRESENT', class: 'REQUIRES_HUMAN' } }] }),
    ],
    [tokenExchange(), preReadExchange('read-1', SKU, [{ priceMinor: 1850, bounds: true }]), preReadExchange('read-2', SKU, [{ priceMinor: 1850 }]),
      patchPriceExchange('patch-invalid', SKU, [{ minor: 1899 }], { status: 200, body: { sku: SKU, status: 'INVALID', submissionId: 'syn-submission-bounds',
        issues: [{ code: 'SYN_PRICE_OUTSIDE_SELLER_BOUNDS', message: 'Synthetic: price outside seller allowed bounds', severity: 'ERROR', attributeNames: ['minimum_seller_allowed_price'], categories: ['INVALID_PRICE'] }] } })],
    {}));

  add('quantity-region.json', scenario('amazon/quantity/region-level',
    'Остаток MFN — одно значение на SKU в регионе: merge fulfillment_availability с DEFAULT, обратное чтение',
    'Единица записи остатка — аккаунт + регион + SKU (A-01, страница merge-a-listing: merge по fulfillment_channel_code DEFAULT). В запросе одна витрина региона.',
    ['quantity'],
    [
      call('dispatch', 'dispatch', [batch('amz:q1', [quantityWrite('cw-q1', 1, 7)])], { outcomes: [{ channelWriteId: 'cw-q1', status: 'ACCEPTED', appliedImmediately: false }] }),
      call('readback', 'readBack', [[{ writeScope: quantityWrite('cw-q1', 1, 7).writeScope, fields: ['QUANTITY'] }]], { observations: [{ field: 'QUANTITY', value: { quantity: 7 }, identity: { region: 'EU', externalSku: SKU } }], failures: [] }),
    ],
    [tokenExchange(), preReadExchange('read', SKU, [{ priceMinor: 1850, quantity: 3 }]),
      { id: 'patch-quantity', request: { method: 'PATCH', path: `/listings/2021-08-01/items/${SELLER}/${SKU}`, query: { marketplaceIds: DE, includedData: 'issues' },
        body: { productType: 'SYNTHETIC_PRODUCT_TYPE', patches: [{ op: 'merge', path: '/attributes/fulfillment_availability', value: [{ fulfillment_channel_code: 'DEFAULT', quantity: 7 }] }] } },
        // Заголовок модели: лимит пары аккаунт–приложение для операции [AMZ_C10]
        response: { ...accepted(SKU)!, headers: { 'x-amzn-RateLimit-Limit': '5.0' } } },
      readBackExchange('readback', SKU, [{ priceMinor: 1850, quantity: 7 }])],
    { noAlerts: true, logs: [{ code: 'AMZ_C10_RATE_LIMIT_HEADER', count: 1, details: { operation: 'patchListingsItem', rate: 5 } }] }));

  add('competitors-and-orders-unsupported.json', scenario('amazon/port/unsupported-reads',
    'Опрос конкурентов и строки заказов у Amazon не выполняются — отказ, а не пустой ответ',
    'getCompetitiveSummary — 0.033 запроса в секунду [AMZ_C07]: конкуренты только из уведомлений. Orders API нет в снимке, данные с PII [Р-4].',
    ['port'],
    [
      call('competitors', 'readCompetitors', [[{ marketplace: DE, channelProductRef: 'B000007001', condition: 'new' }]], { snapshots: [], failures: [{ error: { code: 'UNSUPPORTED' } }] }),
      call('orders', 'readOrderLines', [{ since: { $clockIso: -86_400_000 }, limit: 10 }], undefined, { expectThrows: { code: 'UNSUPPORTED' } }),
    ], [], { noAlerts: true, logs: [{ code: 'AMZ_C07_COMPETITOR_PULL_UNAVAILABLE', count: 1 }] }));

  add('tenant-mismatch.json', scenario('amazon/port/tenant-mismatch',
    'Р-31: тенант сообщения не владеет аккаунтом — отказ до обращения к Amazon',
    'Каталог аккаунтов сверяет тенант; несовпадение — TENANT_MISMATCH и CRITICAL-алерт, ни одного запроса к SP-API и LWA.',
    ['port'],
    [call('dispatch', 'dispatch', [batch('amz:b1', [priceWrite('cw-1', 1, 1899)])], { outcomes: [{ channelWriteId: 'cw-1', status: 'REJECTED', error: { code: 'TENANT_MISMATCH' } }], attemptsMade: 0 },
      { ctx: { tenantId: '10000000-0000-4000-8000-00000000ffff' } })],
    [], { alerts: [{ code: 'AMAZON_TENANT_MISMATCH', severity: 'CRITICAL', count: 1 }] }));

  return out;
}
