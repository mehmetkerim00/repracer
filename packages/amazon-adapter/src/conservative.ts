import type { AdapterCallContext, AdapterLogger } from '@repracer/channel-port';

/**
 * Консервативные правила адаптера Amazon: поведение, выбранное из-за факта API, которого снимок и страницы документации не
 * подтверждают. Код пишется в журнал при срабатывании; question — вопрос в channel-capabilities.md §9.
 */
export interface ConservativeRule { question: string | null; behaviour: string; whenAnswered: string }

export const AMAZON_CONSERVATIVE_RULES = {
  AMZ_C01_TWO_LEVEL_BUDGET: {
    question: 'A-09',
    behaviour: 'Бюджет запросов на двух уровнях: пара аккаунт–приложение и приложение (общий для всех тенантов процесса); запрос не отправляется, если исчерпан любой. Burst уровня приложения не документирован — принят равным burst пары',
    whenAnswered: 'Задать документированный burst приложения; общий бюджет приложения для нескольких экземпляров — в общем хранилище (OQ-78)',
  },
  AMZ_C02_NO_TRANSPORT_RETRY_FOR_WRITES: {
    question: 'A-06',
    behaviour: 'patchListingsItem не повторяется транспортом после тайм-аута и 5xx: исход OUTCOME_UNKNOWN, ядро сверяет обратным чтением',
    whenAnswered: 'Если повтор той же отправки безопасен и не меняет порядок применения — разрешить транспортный повтор',
  },
  AMZ_C03_READ_BEFORE_PRICE_WRITE: {
    question: null,
    behaviour: 'Перед записью цены getListingsItem читает атрибуты оффера: правило автоматического ценообразования [Р-115] или границы цены канала [Р-114] — запись не отправляется, единица требует человека',
    whenAnswered: '— (решения Р-114, Р-115)',
  },
  AMZ_C04_OUR_PRICE_VALUE_WITH_TAX: {
    question: 'A-02',
    behaviour: 'Цена пишется в our_price.schedule.value_with_tax для всех витрин, как в примерах страницы manage-purchasable-offer; для amazon.com смысл «with tax» при цене без налога с продаж не подтверждён',
    whenAnswered: 'Для витрин без налога в цене — перейти на подтверждённое поле; сверка базы цены [Р-116] остаётся',
  },
  AMZ_C05_CONFIRMATION_WINDOW: {
    question: 'A-06',
    behaviour: 'Принятая запись (ACCEPTED) подтверждается обратным чтением; пока значение не совпало — PENDING, после окна 30 минут — NOT_APPLIED',
    whenAnswered: 'Окно — по ответу о предельном времени применения',
  },
  AMZ_C06_MULTI_MARKETPLACE_ISSUES: {
    question: 'A-11',
    behaviour: 'Один PATCH цены на несколько витрин региона: INVALID отклоняет все витрины; ошибка ERROR с marketplaceIds — только эти витрины; ошибка ERROR без marketplaceIds — все',
    whenAnswered: 'Если принятая отправка применяется частично — сверка по витринам остаётся, правило разбора ошибок уточняется',
  },
  AMZ_C07_COMPETITOR_PULL_UNAVAILABLE: {
    question: null,
    behaviour: 'Опрос конкурентов для решения не выполняется: getCompetitiveSummary — 0.033 запроса в секунду, burst 1 (CLAUDE.md); конкуренты решения — только ANY_OFFER_CHANGED, опрос — только сверка потерь [Р-121, AMZ_C11]',
    whenAnswered: '—',
  },
  AMZ_C11_COMPETITIVE_SUMMARY_RECONCILIATION: {
    question: 'A-15',
    behaviour: 'getCompetitiveSummary — только сверка потерь ANY_OFFER_CHANGED по кругу [Р-121]: пакет до 20 товаров, lowestPricedOffers New/Consumer; сверяется наименьшая цена конкурента; победитель Buy Box из featuredBuyingOptions не берётся (сегменты по Prime и месту покупателя); момент наблюдения — время ответа (в ответе его нет); только состояние new; лимит уровня приложения не документирован — равен лимиту пары',
    whenAnswered: 'Если набор lowestPricedOffers совпадает с Offers уведомления, известны задержка уведомления и лимит приложения — сравнение, срок и темп сверки уточняются',
  },
  AMZ_C08_NOTIFICATION_NOT_SIGNED: {
    question: 'A-12',
    behaviour: 'Уведомление приходит из очереди без подписи: принимается, только если SellerId уведомления равен аккаунту из сообщения [Р-31]; повтор — тот же NotificationId',
    whenAnswered: 'Если канал доставки даёт проверяемую подлинность — проверять её до разбора',
  },
  AMZ_C09_PRODUCT_TYPE_FROM_SUMMARIES: {
    question: 'A-10',
    behaviour: 'productType запроса PATCH берётся из summaries оффера (чтение перед записью); примеры документации используют значение PRODUCT, но его пригодность для любого оффера не подтверждена',
    whenAnswered: 'Если PRODUCT подходит для записи цены и остатка любого оффера — чтение перед записью остаётся только ради Р-115',
  },
  AMZ_C10_RATE_LIMIT_HEADER: {
    question: null,
    behaviour: 'Заголовок x-amzn-RateLimit-Limit (лимит пары аккаунт–приложение) заменяет скорость пары в бюджете; уровень приложения заголовок не описывает',
    whenAnswered: '—',
  },
  AMZ_C12_ORDERS_MERCHANT_WHITELIST: {
    question: 'A-20',
    behaviour: 'Шаг 51: строки заказов — searchOrders (Orders 2026-01-01) по времени изменения заказа, только fulfilledBy=MERCHANT (заказы FBA наш пул не трогают, Р-6), наборы FULFILLMENT и CANCELLATION без BUYER и RECIPIENT; из ответа берётся белый список (номер заказа и строки, SKU, количество, витрина, статус), прочее не читается. Статус строки: отмена заказа или исполненная отмена строки — CANCELLED; отгружено всё количество строки (или заказ SHIPPED) — SHIPPED; PENDING, PENDING_AVAILABILITY, UNSHIPPED, PARTIALLY_SHIPPED без полной отгрузки строки — OPEN (резервация держится целиком, перепродажи нет); UNFULFILLABLE и незнакомый статус — строка пропускается и считается в журнале',
    whenAnswered: 'Если Amazon подтвердит, что без наборов BUYER и RECIPIENT данных покупателя в ответе нет никогда, и опишет UNFULFILLABLE для заказов продавца — белый список остаётся, пропуск UNFULFILLABLE заменяется правилом',
  },
  AMZ_C13_FBA_BY_CHANNEL_CODE: {
    question: 'A-21',
    behaviour: 'Шаг 51: способ исполнения оффера — по fulfillmentAvailability: код DEFAULT — наш (FBM, MERCHANT); только иной код — Amazon (FBA, CHANNEL); ни одного кода — неизвестно, и оффер считается CHANNEL: количество по нему не пишется (fail-closed). Коды сети Amazon в снимке не перечислены. Количество FBA читается getInventorySummaries (fulfillableQuantity) в предложение обнаружения; шаг 52 — база хранит его наблюдением предложения CHANNEL (0144, 18 месяцев), экран остатков показывает «управляет Amazon», только чтение',
    whenAnswered: 'Если Amazon назовёт коды сети FBA по регионам — неизвестный код станет ошибкой обнаружения, а не молчаливым CHANNEL',
  },
  AMZ_C14_FBA_QUANTITY_NEVER_WRITTEN: {
    question: null,
    behaviour: 'Шаг 51 [Р-6]: количеством FBA управляет Amazon. Запись QUANTITY по SKU, у которого чтение перед записью показывает сеть Amazon без кода DEFAULT или не показывает кодов вовсе, не отправляется; обратное чтение такого SKU (сеть Amazon) — отказ «нужен человек», и сверка блокирует единицу сразу (каталог считал оффер FBM, а он ушёл в FBA)',
    whenAnswered: '—',
  },
  AMZ_C15_RESPONSE_IDENTITY: {
    question: 'A-28',
    behaviour: 'Шаг 70 [Р-205]: ответ сверяется с запросом. sku ответа чтения и ответа записи (обязателен по модели снимка) — запрошенный, иначе RESPONSE_MISMATCH: чтение — отказ без наблюдения, запись до отправки — отказ, ответ на ушедшую запись — исход неизвестен и алерт AMAZON_RESPONSE_MISMATCH. Сводки и офферы витрин вне marketplaceIds не используются и называются в журнале, но не отказ (ревью шага 70: данные и так берутся по своей витрине, а отказ заблокировал бы единицы количества). Обнаружение пропускает чужие сводки и предметы без sku поштучно; сводки FBA другой витрины или о чужом SKU — количество из ответа не берётся. Песочница отдала образец о чужом SKU — до шага адаптер его принял',
    whenAnswered: 'Если SP-API отвечает только витринами запроса и повторяет SKU байт в байт — правило становится фактом [док]; если SKU в ответе нормализуется (регистр, пробелы) — сверка по нормализованному виду',
  },
} as const satisfies Record<string, ConservativeRule>;

export type AmazonConservativeRuleCode = keyof typeof AMAZON_CONSERVATIVE_RULES;

export function logConservative(
  logger: AdapterLogger,
  ctx: Pick<AdapterCallContext, 'correlationId' | 'tenantId' | 'channelAccountId'> | undefined,
  code: AmazonConservativeRuleCode,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const rule: ConservativeRule = AMAZON_CONSERVATIVE_RULES[code];
  logger.log({
    level: 'WARN', code, message: rule.behaviour, ...(rule.question ? { question: rule.question } : {}),
    ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}),
    details,
  });
}
