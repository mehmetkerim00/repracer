# Шаг 51, часть 2: начало фронта Amazon — снимок, модель стенда, заказы, FBA

Живых ключей SP-API нет: регистрация разработчика готовится. Всё ниже построено по официальным моделям и проверено против модели стенда. Живьём не проверено ничего, включая LWA.

## Что уже было (шаг 22 и дальше) и что добавил шаг

До шага 51 у Amazon уже были:
- снимок моделей SP-API 2026-09-16;
- клиент LWA по снимку страниц `vendor/amazon/lwa-authorization`;
- адаптер: обнаружение `searchListingsItems`, чтение `getListingsItem`, запись цены и количества `patchListingsItem`;
- двухуровневый token bucket;
- 40 контрактных сценариев и модель уровня порта.

Аккаунт любого канала рождается в тени, и все пути боевой записи держит база: `channel_account.write_mode` (0128, Р-169, Р-170), OAuth — Р-176. Отдельного кода для Amazon здесь не нужно.

Не хватало: заказов (порт отвечал `UNSUPPORTED`), FBA и модели, через которую идёт НАСТОЯЩИЙ адаптер.

## 4. Снимок моделей

[vendor/amazon/sp-api-models/2026-09-29/SOURCE.md](../../vendor/amazon/sp-api-models/2026-09-29/SOURCE.md): 14 файлов на коммите `713565ff` репозитория `amzn/selling-partner-api-models`, SHA-256 каждого.
- **Новые:** Orders (`orders_2026-01-01.json`, `ordersV0.json`), FBA Inventory (`fbaInventory.json`), уведомления `FBAInventoryAvailabilityChange` и `OrderChange`.
- **Прежние файлы** Listings Items, Product Pricing, Sellers и Notifications совпали с 2026-09-16 побайтно.
- **Лимиты.** Отдельных материалов о лимитах в репозитории нет. Лимит пары — таблица Usage Plan в описании каждой операции: `searchOrders` 0.0056 / 20, `getInventorySummaries` 2 / 2. Лимит приложения у них не описан (A-23).
- **Операции FBA Inventory `createInventoryItem`, `addInventory`, `deleteInventoryItem`** по модели работают только в песочнице. Адаптер их не вызывает.

## 5. Модель стенда на уровне HTTP

[tests/contract/src/simulator/amazon-channel.ts](../../tests/contract/src/simulator/amazon-channel.ts) — `SimulatedAmazonChannel`, по образцу модели eBay: тот же `ChannelBehaviour`, мир сценария `channelModel` с ключом `offers`. Поведение — только из снимка:
- **LWA** — токен по refresh_token.
- **`searchListingsItems` и `getListingsItem`** — наборы по `includedData`.
- **`patchListingsItem`**:
  - ответ `ACCEPTED`, применение через `applyDelayMs`, часть принятого не применяется (A-06);
  - количество DEFAULT — на регион или на витрину (A-01);
  - запись DEFAULT по SKU сети Amazon не применяется и считается (A-21).
- **`searchOrders`**:
  - ровно одно из `createdAfter` и `lastUpdatedAfter` — фраза модели;
  - фильтры `marketplaceIds` и `fulfilledBy`, наборы `includedData`;
  - страницы 1…100 с `paginationToken`;
  - данные покупателя — только по набору `BUYER`, если параметр A-20 не велит иное.
- **`getInventorySummaries`** — `granularityType=Marketplace`, одна витрина, не больше 50 SKU; только SKU сети Amazon.
- **Лимиты** — token bucket по Usage Plan операции; превышение — 429. Код 429 есть в перечне ответов операций, тела ошибок синтетические с приставкой `SYN_`: коды ошибок SP-API в моделях не перечислены.

Модель уровня порта (`amazon-port.ts`) остаётся: на ней живые прогоны с потоком конкурентов (`ANY_OFFER_CHANGED`).

Сценарии модели — [tests/contract/src/simulator-amazon-http.test.ts](../../tests/contract/src/simulator-amazon-http.test.ts), 6 прогонов, включая 2 варианта:
- **`fba-read-only`**: обнаружение FBM, FBA и SKU без кодов; запись количества FBA-SKU отвергнута до PATCH (у модели `patchListingsItem` не вызывался, счётчик записей FBA — 0).
- **`async-apply`**: `ACCEPTED` ≠ применено. Подтверждение до применения — `PENDING`, через 3 минуты — `APPLIED` для цены и количества. Вариант A-06: принятое не применяется.
- **`orders`**: 5 заказов модели. Заказ FBA не читается (запрос просит только MERCHANT), заказ вне окна не читается. Частичная отгрузка строки — OPEN, отгруженная строка — SHIPPED, отменённая — CANCELLED; две страницы. Вариант A-20: канал шлёт данные покупателя без набора BUYER, и ни строки, ни журнал их не несут. Отрицательный контроль: модель в варианте их действительно шлёт.
- **`orders-usage-plan`**: 20 вызовов `searchOrders` подряд проходят, 21-й — `RATE_LIMITED` с `retryAt` от ограничителя адаптера, без запроса. Модель 429 не отдала ни разу.

## 6. Адаптер: заказы, FBA, лимиты

**Строки заказов** — `readOrderLinesAmazon` ([packages/amazon-adapter/src/listing.ts](../../packages/amazon-adapter/src/listing.ts)), правило AMZ_C12, вопросы A-20 и A-22:
- **Вызов:** `searchOrders` (Orders 2026-01-01), не `getOrders` v0. Строки — обязательная часть `Order` модели, второго вызова `getOrderItems` нет.
- **Окно** — `lastUpdatedAfter`, как у eBay после ревью шага 47: отгрузка и отмена старого заказа читаются.
- **Страницы** — `paginationToken` вместе со ВСЕМИ параметрами первого запроса. Модель: «All other parameters must be provided with the same values … with the exception of maxResultsPerPage and includedData». Критичная находка ревью: первая редакция слала один токен. Вторую страницу Amazon отверг бы, либо вернул без набора FULFILLMENT, и все её заказы пропали бы. Модель стенда теперь сверяет параметры страниц, проверка запросов смотрит каждую страницу.
- **Только `fulfilledBy=MERCHANT`:** заказы FBA наш пул не трогают [Р-6].
- **Наборы:** `FULFILLMENT` и `CANCELLATION`, без `BUYER` и `RECIPIENT` [Р-4]. Типы клиента ([packages/amazon-client/src/types.ts](../../packages/amazon-client/src/types.ts)) данных покупателя не содержат вовсе.
- **Статус строки:**
  - отмена заказа или исполненная отмена строки — CANCELLED;
  - заказ SHIPPED или строка отгружена целиком — SHIPPED;
  - PENDING, PENDING_AVAILABILITY, UNSHIPPED и PARTIALLY_SHIPPED с неполной отгрузкой строки — OPEN: резервация держится на всё количество, перепродажи нет;
  - UNFULFILLABLE, заказ вне Amazon, чужая витрина — пропуск с числом в журнале.
- **Идентичность строки** — регион + витрина + SKU (+ ASIN), как у предложения из обнаружения. Конвейер остатков сопоставляет строку по аккаунту и SKU.
- **Журнал** — только числа.

Контрактный сценарий `orders-merchant-whitelist.json`: 7 заказов, 6 строк, 3 пропуска; вторая страница по токену. Прежний шаг «строки заказов — отказ `UNSUPPORTED`» убран из сценария `competitive-summary`.

**FBA** — правила AMZ_C13 и AMZ_C14, вопрос A-21:
- **Способ исполнения** — по `fulfillmentAvailability` (`fulfillmentOf`, [mapping.ts](../../packages/amazon-adapter/src/mapping.ts)):
  - DEFAULT — FBM (MERCHANT);
  - только иной код — FBA (CHANNEL);
  - кодов нет — CHANNEL без количества (fail-closed).
- **Количество FBA** — `getInventorySummaries` (`fulfillableQuantity`, не `totalQuantity` с поставками в пути) в предложение обнаружения. **В базу и на экраны оно пока не доходит** (ревью, находка 7): у `DiscoveredOffer.currentQuantity` нет потребителя — отложено.
- **Запись количества.** Чтение перед записью количества теперь просит и `fulfillmentAvailability`. SKU сети Amazon без DEFAULT или вовсе без кодов (ревью, находка 8) — `PRECONDITION_FAILED` («нужен человек»), PATCH не уходит: запись DEFAULT могла бы перевести листинг в наше исполнение (A-21).
- **Обратное чтение количества:** сеть Amazon — `PRECONDITION_FAILED`, и сверка блокирует единицу сразу, а не через час неизвестного итога (ревью, находка 6, `planReconciliationTransition`); пусто — «нет данных» (`MERCHANT_QUANTITY_ABSENT`), а не 0, как у eBay.

Контрактный сценарий `fba-read-only.json`.

**Лимиты** — в бюджет адаптера (`AMAZON_RATE_LIMITS`, [descriptor.ts](../../packages/amazon-adapter/src/descriptor.ts)): `searchOrders` 0.0056 / 20, `getInventorySummaries` 2 / 2 на пару «продавец × приложение». Лимит приложения у них не документирован (A-23). Первая редакция приравняла его к лимиту пары, и получилось одно ведро на все аккаунты процесса. Ревью (находка 4): два аккаунта с чтением заказов раз в 5 минут исчерпали бы его за часы, и заказы читались бы с отставанием. Теперь держится только лимит пары, превышение приложения покажет ответ 429 канала. Тест: два продавца по 20 вызовов подряд, 21-й одного продавца отказан уровнем пары.

## 7. Единица остатка и цены; FBA и FBM в модели тенанта

- **Цена** — аккаунт + регион + витрина + SKU (`ACCOUNT_REGION_MARKETPLACE_SKU`), как и была с шага 22.
- **Количество** — аккаунт + РЕГИОН + SKU (`ACCOUNT_REGION_SKU`), а не аккаунт + витрина + SKU, как было написано в задании шага. Причина — Р-1 и страница merge-a-listing: остаток MFN — одно значение на SKU во всех витринах региона ЕС, запись меняет его сразу везде. Единица на витрину дала бы две записи в одно значение канала без порядка между ними. У EBAY единица количества — витрина (предложение), это другой канал. Вопрос A-01 (область записи в ЕС) и A-16 (NA) остаются открытыми, и модель стенда держит обе альтернативы параметром.
- **FBA и FBM в модели тенанта** — база с шага 2:
  - `offer_mapping.fulfillment` (`MERCHANT` / `CHANNEL`);
  - CHECK `offer_mapping_check7` (0005): у CHANNEL нет единицы записи количества — теперь у него есть проверка с причиной в смоуке (`tests/db/smoke_app.sql`, шаг 51);
  - синхронизация остатков берёт только `MERCHANT` (0118);
  - заказы FBA не читаются (`fulfilledBy=MERCHANT`).

## Живьём не проверено (для первого боевого аккаунта)

- LWA с настоящими ключами.
- Коды сети FBA (A-21).
- Данные покупателя без наборов (A-20).
- `quantityFulfilled` при частичной отгрузке (A-22).
- Лимиты приложения (A-23).
- Область записи количества (A-01, A-16).
- Время применения записи (A-06).
