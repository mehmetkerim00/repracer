# Amazon Selling Partner API — снимок моделей (шаг 109)

| Поле | Значение |
|---|---|
| Источник | https://github.com/amzn/selling-partner-api-models (официальный репозиторий моделей SP-API) |
| Коммит | `df7c62985ae6ef8d9a9342ef0fab12f0a2a19661` (2026-10-28T19:01:24Z, ветка `main`, «release:SPAPI-October-2026-Release») |
| Скачано | 2026-10-29, `raw.githubusercontent.com/amzn/selling-partner-api-models/<коммит>/<путь>` |
| Формат | OpenAPI 2.0 (Swagger) для моделей, JSON Schema для уведомлений |
| Контрольные суммы | SHA-256 каждого файла — `SHA256SUMS`; проверка: `cd vendor/amazon/sp-api-models/2026-10-29 && shasum -a 256 -c SHA256SUMS` |

Файлы не редактируются. Состав — тот же, что у снимка [`2026-09-29`](../2026-09-29/SOURCE.md); прежние снимки остаются: на них ссылаются
адаптер, построитель фикстур и доказательства прежних шагов.

## Зачем новый снимок

Разведка шага 108 ([docs/evidence/step108-sp-api-recon.md](../../../../docs/evidence/step108-sp-api-recon.md), расхождение 4): статическая песочница
отдаёт образцы `getListingsItem` и `searchListingsItems` с полями, которых в снимке 2026-09-29 не было, — байт в байт как образцы этой
версии модели.

## Что изменилось против 2026-09-29

| Файл | SHA-256 | Изменение |
|---|---|---|
| `models/listings-items-api-model/listingsItems_2021-08-01.json` | `117617f4…` → `d60eed71…` | `ItemOfferByMarketplace`: новые необязательные `replenishmentDiscount` (скидка Subscribe & Save, «Returned only for offers that have a configured Subscribe & Save discount») и `quantityDiscountPlan` (скидки за количество, «Returned only when the offer has an active quantity discount schedule»); определения `ReplenishmentDiscount`, `QuantityDiscountPlan`, `QuantityDiscountLevel`; образцы песочницы `getListingsItem` и `searchListingsItems` несут эти поля. Обязательные поля и параметры операций прежние; у остальных определений — только текст описаний |
| `models/notifications-api-model/notifications.json` | `6a5e945f…` → `365079ba…` | `TrackingIdentifier.proNumber`; перечень `OrderChangeTypeEnum` — `BuyerRequestedChange`, `DeliveryTipChange`, `OrderStatusChange`, `PreFulfillmentStatusChange` |
| `models/orders-api-model/orders_2026-01-01.json` | `4bd47126…` → `cd5d1fda…` | `OrderFulfillment.promiseCalculationInputs` (и определения к нему), `AssociatedOrderItem.asin` и `purchasePrice`; у `Order`, `OrderItem`, `ItemCancellation` — текст описаний. Поля белого списка адаптера (`searchOrders`, AMZ_C12) не изменились |
| `schemas/notifications/OrderChangeNotification.json` | `f6ab3617…` → `e4527ee9…` | текст описаний `Payload` |

Остальные десять файлов совпали с 2026-09-29 побайтно (SHA-256 в `SHA256SUMS` тот же), в том числе модели Product Pricing, FBA Inventory и
схемы `ANY_OFFER_CHANGED` и `PRICING_HEALTH`.

## Что из снимка использует проверка

- **Правило фикстур ответов API** (шаг 109, A) — `tests/contract/src/amazon-api-fixture-schema.test.ts`: каждое тело ответа SP-API в
  фикстурах `tests/contract/fixtures/amazon` проходит схему ответа операции этой версии модели — без пропуска обязательных полей и без
  полей вне модели.
- **Схемы уведомлений** шага 97 (`tests/contract/src/amazon-fixtures/schema-check.ts`) — отсюда же; файлы те же, что в 2026-09-29.
- **Разведка песочницы** `tools/sp-api-recon.mjs` — параметры образцов `x-amzn-api-sandbox.static` и схемы ответов.

## Наблюдение вне модели

Динамическая песочница FBA Inventory отдаёт `inventoryDetails.futureSupplyQuantity`, которого нет ни в этой модели, ни в 2026-09-29 (файл
FBA Inventory не менялся) — вопрос A-32 в [docs/channel-capabilities.md](../../../../docs/channel-capabilities.md). Адаптер его не читает.
