import type { AdapterCallContext, AdapterLogger } from '@repracer/channel-port';

/**
 * Консервативные правила адаптера eBay [Р-162]: поведение, выбранное из-за факта API, которого нет в снимке спецификации (E-01) и
 * который подтверждён только песочницей или не подтверждён вовсе. Код пишется в журнал при срабатывании; question — вопрос
 * в channel-capabilities.md §9 (E-12…E-16 заведены шагом 39).
 */
export interface ConservativeRule { question: string | null; behaviour: string; whenAnswered: string }

export const EBAY_CONSERVATIVE_RULES = {
  EBAY_C01_REQUEST_BUDGET: {
    question: 'E-04',
    behaviour: 'Лимиты вызовов неизвестны (песочница отдаёт заглушку): клиентский бюджет запросов на продавца выбран нами (2 в секунду, запас 4); ответ 429 — RATE_LIMITED с повтором не раньше чем через 60 с',
    whenAnswered: 'Бюджет — по документированным лимитам приложения и пользователя до и после Application Growth Check; общий лимит приложения — в общем хранилище (OQ-78)',
  },
  EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES: {
    question: 'E-03',
    behaviour: 'bulk_update_price_quantity и bulk_migrate_listing не повторяются транспортом: обрыв соединения (в песочнице — «other side closed»), тайм-аут и 5xx — OUTCOME_UNKNOWN, ядро сверяет обратным чтением',
    whenAnswered: 'Если канал подтвердит идемпотентность повтора записи — разрешить транспортный повтор',
  },
  EBAY_C03_LOCAL_CURRENCY_AND_SCALE: {
    question: 'E-12',
    behaviour: 'Валюта цены сверяется с валютой витрины и цена пишется ровно с двумя знаками ДО отправки: песочница молча приняла USD у предложения EBAY_DE и молча округлила 11.999 вверх до 12.0',
    whenAnswered: 'Проверка остаётся: канал, принимающий чужую валюту, не защищает от неё',
  },
  EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN: {
    question: 'E-06',
    behaviour: 'Количество 0 с ответом 25004 — OUTCOME_UNKNOWN, а не отказ: песочница ответила ошибкой, но значение применила (availableQuantity=0, листинг OUT_OF_STOCK); вслепую не повторяется, итог — обратным чтением',
    whenAnswered: 'Если боевой канал отклоняет 0 без применения — отказ VALIDATION; если завершает листинг без out-of-stock control — предполётная C11 становится BLOCKER',
  },
  EBAY_C05_PRICE_READBACK_LIVE_LISTING: {
    question: 'E-13',
    behaviour: 'Р-186: цена наблюдения — ЖИВАЯ цена продавца из Browse (GET offer показывает только нашу запись: после правки через Trading API предложение осталось со старой ценой), цена покупателя Browse — отдельным полем buyerPrice, в сверку базы цены Р-116 не идёт; живой листинг читается всегда: расхождение не на ставку НДС — предупреждение (листинг правит другой инструмент, C10) и живая цена в наблюдении; несовпадение с отправленной — PENDING 10 минут, затем NOT_APPLIED',
    whenAnswered: 'Если канал назовёт источник истины о цене листинга и задержку Browse — окно и чтение уточняются',
  },
  EBAY_C06_BROWSE_APPLICATION_TOKEN: {
    question: 'E-13',
    behaviour: 'Browse API вызывается токеном приложения (client_credentials, scope api_scope — официальный клиент eBay); каким токеном вызывала песочница, журнал не сохранил',
    whenAnswered: 'Если Browse требует токен пользователя или другой scope — сменить вид токена',
  },
  EBAY_C07_QUANTITY_LEVEL_OFFER: {
    question: 'E-03',
    behaviour: 'Количество пишется в предложение (offers[].availableQuantity — количество листинга); количество товара (shipToLocationAvailability) не трогается — песочница показала, что это разные уровни. Нет availableQuantity в предложении (так было у мигрированного) — обратное чтение отказывает, а не угадывает',
    whenAnswered: 'Если канал назовёт единственный уровень остатка для мигрированных листингов — единица записи QUANTITY уточняется',
  },
  EBAY_C08_EDIT_BUDGET_ROLLING_DAY: {
    question: 'E-02',
    behaviour: 'Второй слой бюджета 250 правок листинга (первый — edit_budget в базе): адаптер считает КАЖДУЮ попытку по листингу за любые 24 часа — худший случай неизвестной границы дня; при исчерпании запрос не отправляется',
    whenAnswered: 'Граница дня витрины подтверждена (Р-65) — окно становится календарным днём витрины',
  },
  EBAY_C09_BATCH_MAX_25: {
    question: 'E-03',
    behaviour: 'Не больше 25 записей в одном вызове bulk_update_price_quantity (песочница: 26 — 400 25712 на весь запрос) и не больше одной записи на предложение в вызове (одно statusCode на предложение не различает поля)',
    whenAnswered: 'Если канал подтвердит предел и раздельный статус полей — пакеты уточняются',
  },
  EBAY_C10_BEST_OFFER_LOSS: {
    question: 'E-15',
    behaviour: 'Best Offer при миграции — LOSS, как в документации, пересказанной Р-2, хотя песочница его сохранила (bestOfferEnabled=true после миграции)',
    whenAnswered: 'Если боевой канал подтвердит сохранение Best Offer — находка C03 становится INFO',
  },
  EBAY_C11_TEMPLATE_UNDETECTABLE: {
    question: 'E-14',
    behaviour: 'Шаблон оформления (C06) не определяется: ThemeID 7710 и LayoutID 7710000 есть у каждого листинга песочницы по умолчанию — находка INFO «не определяется», а не LOSS и не «нет»',
    whenAnswered: 'Если канал назовёт признак пользовательского шаблона — C06 становится LOSS по признаку',
  },
  EBAY_C12_OTHER_TOOLS_ALWAYS_WARN: {
    question: 'E-16',
    behaviour: 'C10 (листинг правит другой инструмент) — WARNING у каждого листинга: автоматически не определяется, а песочница после миграции продолжила принимать ReviseFixedPriceItem, и живая цена разошлась с предложением',
    whenAnswered: 'Если боевой канал блокирует Trading Revise после миграции (Р-2) — текст предупреждения уточняется',
  },
  EBAY_C13_QUANTITY_READBACK_OFFER_RECORD: {
    question: 'E-13',
    behaviour: 'Количество подтверждается availableQuantity предложения — это НАША запись, а не живой листинг; у активного листинга оно сверяется с оценкой Browse estimatedAvailableQuantity, расхождение — предупреждение в журнале (значение наблюдения — запись предложения)',
    whenAnswered: 'Если канал назовёт источник истины о количестве листинга — подтверждение переходит на него',
  },
  EBAY_C14_BROWSE_PRICE_WITH_VAT: {
    question: 'E-17',
    behaviour: 'Browse показал цену покупателя = цена продавца × (1 + НДС) с taxes[{taxType VAT, includedInPrice true}] (песочница, частный продавец): наблюдение несёт цену продавца и отдельно цену покупателя (buyerPrice, Р-186); это не правка другим инструментом (C10) и не неверная база цены — проверка Р-116 цену покупателя eBay не читает до ответа на E-17',
    whenAnswered: 'Если у бизнес-продавца в бою цена покупателя равна цене продавца — расхождение на НДС становится признаком неверной базы: цена покупателя переходит в effectivePrice и попадает в проверку Р-116',
  },
  EBAY_C15_VARIATIONS_PRICE_CONFIRMATION: {
    question: 'E-13',
    behaviour: 'Листинг с вариациями: Browse-идентификатор v1|<ItemID>|0 адресует листинг, а не вариацию — подтверждение цены вариации по живому листингу не поддерживается; предполётная находка C12 — WARNING',
    whenAnswered: 'Если канал назовёт идентификатор вариации в Browse — подтверждение цены вариаций включается',
  },
  EBAY_C16_TRADING_LISTING_SITE: {
    question: 'E-19',
    behaviour: 'Обнаружение старых листингов и аукционов — GetMyeBaySelling по сайту каждой витрины аккаунта; у предметов нет поля витрины (песочница), поэтому витрина — та, для которой сделан вызов, и только при совпадении валюты цены с валютой витрины; без валюты у аккаунта с несколькими витринами листинг пропускается. Листинг, у SKU которого есть предложение Inventory API с тем же номером, отдан фазой Inventory и не повторяется',
    whenAnswered: 'Если канал назовёт витрину листинга в GetMyeBaySelling (или вызов фильтрует по сайту) — витрина берётся из ответа',
  },
  EBAY_C17_ORDER_FIELDS_UNVERIFIED: {
    question: 'E-20',
    behaviour: 'Заказы Fulfillment API читаются по времени ИЗМЕНЕНИЯ (фильтр lastmodifieddate, проверить) и по белому списку полей (orderId, creationDate, cancelStatus.cancelState, lineItems: lineItemId, sku, legacyItemId, quantity, lineItemFulfillmentStatus, listingMarketplaceId), имена которых не подтверждены снимком (проверить); строка без нужного поля или с непонятным статусом пропускается с кодом журнала; витрина — из строки или единственная витрина аккаунта; возвраты не читаются (строка остаётся OPEN)',
    whenAnswered: 'По снимку Fulfillment API — поля и статусы сверяются, возвраты — отдельный статус RETURNED',
  },
  EBAY_C18_MULTI_SKU_PROBE: {
    question: 'E-22',
    behaviour: 'Р-189: описание bulkUpdatePriceQuantity в снимке говорит «Only one SKU (one product) can be updated per call», а схема и песочница принимают до 25 предложений разных SKU. Боевой аккаунт доказывает пакет сам: первая боевая запись — пакет из 2 SKU (проба); пакет разных SKU принят — до 25; отвергнут целиком (4xx без ответов по элементам) — записи пробы завершаются отказом канала без повтора (шаг 51: ответ eBay 4xx не повторяется, Growth Check), следующие записи уходят по одной, аккаунт переходит в режим «1 SKU на вызов» функцией базы с алертом EBAY_MULTI_SKU_REFUSED; обратно автоматически не возвращается',
    whenAnswered: 'Если eBay подтвердит пакет разных SKU — проба не нужна (режим MULTI сразу); если запретит — SINGLE для всех аккаунтов',
  },
  EBAY_C19_BROWSE_UNAVAILABLE_IN_PRODUCTION: {
    question: 'E-21',
    behaviour: 'Р-190: в бою Browse API не вызывается, пока лицензия Buy API не выяснена. Подтверждение записи — обратное чтение предложения (GET offer, наша запись); цену покупателя и правки листинга другими программами (C10) в бою не видим; сверка базы цены Р-116 на eBay ограничена: её вход — наша же запись. Пишется один раз на аккаунт за процесс',
    whenAnswered: 'Если лицензия Buy API для репрайсера подтверждена — Browse в бою включается, подтверждение цены переходит на живой листинг (EBAY_C05)',
  },
} as const satisfies Record<string, ConservativeRule>;

export type EbayConservativeRuleCode = keyof typeof EBAY_CONSERVATIVE_RULES;

export function logConservative(
  logger: AdapterLogger,
  ctx: Pick<AdapterCallContext, 'correlationId' | 'tenantId' | 'channelAccountId'> | undefined,
  code: EbayConservativeRuleCode,
  details: Readonly<Record<string, string | number | boolean | null>> = {},
): void {
  const rule: ConservativeRule = EBAY_CONSERVATIVE_RULES[code];
  logger.log({
    level: 'WARN', code, message: rule.behaviour, ...(rule.question ? { question: rule.question } : {}),
    ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}),
    details,
  });
}
