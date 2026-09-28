# Amazon Selling Partner API — снимок моделей (шаг 51)

| Поле | Значение |
|---|---|
| Источник | https://github.com/amzn/selling-partner-api-models (официальный репозиторий моделей SP-API) |
| Коммит | `713565ff394d136629a342120872e65cb073d162` (2026-09-22T00:15:01Z, ветка `main`) |
| Скачано | 2026-09-29, `raw.githubusercontent.com/amzn/selling-partner-api-models/<коммит>/<путь>` |
| Формат | OpenAPI 2.0 (Swagger) для моделей, JSON Schema для уведомлений |
| Контрольные суммы | SHA-256 каждого файла — `SHA256SUMS`; проверка: `cd vendor/amazon/sp-api-models/2026-09-29 && shasum -a 256 -c SHA256SUMS` |

Файлы не редактируются. Новая версия — новый каталог с датой; прежний снимок [`2026-09-16`](../2026-09-16/SOURCE.md) остаётся:
на него ссылаются адаптер, фиды, типы товаров, комиссии и отчёты, которых в этом снимке нет.

## Состав — разделы шага 51

| Файл | Операции | Лимит модели (Usage Plan: rate / burst) | Против снимка 2026-09-16 |
|---|---|---|---|
| `models/listings-items-api-model/listingsItems_2021-08-01.json` | `getListingsItem`, `patchListingsItem`, `searchListingsItems` … | 5 / 5 (лимиты — страница listings-items-api-rate-limits, снимок 2026-09-16) | тот же файл, SHA-256 совпал |
| `models/product-pricing-api-model/productPricing_2022-05-01.json` | `getCompetitiveSummary`, `getFeaturedOfferExpectedPriceBatch` | 0.033 / 1 | совпал |
| `models/product-pricing-api-model/productPricingV0.json` | `getPricing`, `getItemOffers*`, `getListingOffers*` | по операции | совпал |
| `models/fba-inventory-api-model/fbaInventory.json` | `getInventorySummaries` (чтение); `createInventoryItem`, `addInventory`, `deleteInventoryItem` — **только песочница** («This is a sandbox-only operation») | `getInventorySummaries`: 2 / 2 | **новый** |
| `models/orders-api-model/orders_2026-01-01.json` | `searchOrders`, `getOrder` | `searchOrders`: 0.0056 / 20; `getOrder`: 0.5 / 30 | **новый** |
| `models/orders-api-model/ordersV0.json` | `getOrders`, `getOrderItems`, `getOrderBuyerInfo`, `getOrderAddress` … (для сравнения, адаптер не использует) | `getOrders`: 0.0167 / 20 | **новый** |
| `models/sellers-api-model/sellers.json` | `getMarketplaceParticipations` | — | совпал |
| `models/notifications-api-model/notifications.json` | подписки и адресаты | — | совпал |
| `schemas/notifications/AnyOfferChangedNotification.json`, `PricingHealthNotification.json`, `ListingsItemMfnQuantityChange.json`, `ListingsItemStatusChangeNotification.json` | уведомления, которые принимает приёмник | — | совпали |
| `schemas/notifications/FBAInventoryAvailabilityChangeNotification.json`, `OrderChangeNotification.json` | уведомления об остатке FBA и о заказе (приёмник их не подписывает) | — | **новые** |

**Лимиты запросов.** Отдельных материалов о лимитах в репозитории моделей нет: лимит пары «продавец × приложение» —
таблица «Usage Plan» в описании каждой операции модели (выписана выше); лимит уровня приложения моделью не описан
(для Listings Items он есть на странице документации — снимок 2026-09-16), у Orders и FBA Inventory — вопрос A-23.

## Что из снимка использует адаптер (шаг 51)

- **Заказы — `searchOrders` (2026-01-01), а не `getOrders` v0.** Окно — `lastUpdatedAfter` (в запросе ровно одно из
  `createdAfter` и `lastUpdatedAfter`; со страницей — те же параметры и `paginationToken`: «All other parameters must be provided with the same values»); `fulfilledBy=MERCHANT` — заказы FBA не трогают наш пул [Р-6]; `includedData=FULFILLMENT,CANCELLATION` —
  без наборов `BUYER` и `RECIPIENT` (данные покупателя — только по явному набору, Р-4). Строки заказа (`orderItems`: `orderItemId`,
  `quantityOrdered`, `product.sellerSku`) — обязательная часть `Order` в модели, отдельного вызова `getOrderItems` нет.
- **FBA Inventory — только `getInventorySummaries`**: количество FBA читается, но не пишется [Р-6]; операции записи модели —
  операции песочницы.

## Страницы документации, загруженные на шаге 52 (Р-194, A-24)

Текст не копируется — адрес, поле `updatedAt` страницы и SHA-256 загруженного текста (2026-09-29).

| Страница | updatedAt | SHA-256 | Что взято |
|---|---|---|---|
| https://developer-docs.amazon/sp-api/docs/sp-api-endpoints.md | 2026-09-09T09:00:11Z | `195f1b5cbe8c7253accc1b81fe7a5b66db55edb6f5e530e31009b9d33337bad9` | Selling regions и их витрины. `updatedAt` тот же, что в снимке 2026-09-16, а сумма другая (`2067aae1…`): в заголовке страницы появился блок `agentTools`, таблица регионов совпадает по содержанию |
| https://developer-docs.amazon.com/sp-api/docs/marketplace-ids (HTML) | — | `ce90494b890168357bfe73aaae63b60ff1892f6fb33e97bee1ea2d9accb9bc46` | Идентификаторы витрин по регионам (UK — `A1F83G8C2ARO7P`) |
| https://developer-docs.amazon/sp-api/docs/merge-a-listing.md | 2026-09-09T22:43:50Z | `6e56cd278bc60dc17be651c485708cb428ef6180e74c22310d3c38a359a1f648` | Селектор `fulfillment_availability` — `fulfillment_channel_code` |
| https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md | 2026-09-09T22:43:25Z | `89dc7fb733db0a10ebee3c38ba5437bec8cf2dcc2afe474bda4d18e6107db155` | Селекторы `purchasable_offer` — `marketplace_id`, `currency`, `audience` |
