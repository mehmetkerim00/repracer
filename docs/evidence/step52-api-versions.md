# Шаг 52: версии API адаптеров против опубликованных

Дата проверки — **2026-09-29** (заголовки `date` ответов — 2026-09-28 21:43–21:46 GMT). Только чтение: ни снимки в `vendor/`,
ни код не менялись. Сеть — публичные страницы и репозитории (`gh api`, `curl` с User-Agent браузера).

## Итог

- **Amazon: расхождений нет.** HEAD `amzn/selling-partner-api-models` — тот же коммит, что снимок 2026-09-29
  (`713565ff394d136629a342120872e65cb073d162`, 2026-09-22T00:15:01Z). Все 31 файл обоих снимков (2026-09-16 и 2026-09-29)
  совпали по SHA-256 с файлами этого коммита. Более новых версий наших API в репозитории нет. Из устаревающего по
  deprecation schedule мы не используем ничего (Orders v0 — только файл для сравнения, код зовёт Orders 2026-01-01).
- **eBay: опубликованные OpenAPI-контракты Inventory, Account, Identity, Developer Analytics байт в байт совпадают со
  снимком 2026-09-28**, но release notes Inventory называют версию **1.18.8** (2026-08-24) при контракте 1.18.5 — заметки
  опережают опубликованный контракт. **Trading API: мы шлём уровень совместимости 1349 (2024-02-26), текущий — 1477
  (2026-08-24)**; по политике eBay нижняя поддерживаемая версия — «18 months old», значит 1349 уже ниже неё (фактический
  номер нижней версии на странице не обновлён с 2020 — (проверить)). Fulfillment, Browse, Notification — снимка нет, версии
  названы по опубликованным контрактам.
- Документация eBay на этот раз отдала страницы `api-docs/.../release-notes.html` и контракты `api-docs/master/.../openapi/3/*.json`
  без браузера (`curl` с User-Agent браузера — 200). Страница статуса устаревания API — по-прежнему **403** (и `curl`, и WebFetch).

## Amazon SP-API

Источник «актуального»: `gh api repos/amzn/selling-partner-api-models/commits/main` и
`gh api "repos/amzn/selling-partner-api-models/git/trees/main?recursive=1"` (дерево не усечено), файлы —
`raw.githubusercontent.com/amzn/selling-partner-api-models/713565ff…/<путь>`, `shasum -a 256`; устаревание —
[SP-API Deprecation Schedule](https://developer-docs.amazon.com/sp-api/docs/sp-api-deprecations) (Markdown-версия
`developer-docs.amazon/sp-api/docs/sp-api-deprecations.md`, `updatedAt` 2026-09-09T22:32:48Z,
SHA-256 `47357461794b2b15f6e65247ee06d73e01f525310f9ea11440085ffffc84c66a`).

| Канал | API | Наша версия и источник | Актуальная (2026-09-29) | Расхождение | Что это значит для нас |
|---|---|---|---|---|---|
| Amazon | Listings Items | 2021-08-01 — `vendor/amazon/sp-api-models/2026-09-16` и `2026-09-29` (`listingsItems_2021-08-01.json`, SHA-256 `117617f4…`), `LISTINGS_BASE_PATH` в `packages/amazon-adapter/src/descriptor.ts`, типы `packages/amazon-client/src/types.ts` | 2021-08-01 — последняя версия в дереве `main` (рядом только 2020-09-01); файл на HEAD совпал по SHA-256 | нет | Цена и остаток пишутся по актуальной модели; 2020-09-01 в снимке — только для сравнения. |
| Amazon | Product Pricing | 2022-05-01 (`getCompetitiveSummary`, `COMPETITIVE_SUMMARY_PATH`) и v0 в снимке (`productPricingV0.json`); код v0 не вызывает | 2022-05-01 и v0 — других версий в дереве нет; оба файла совпали. Schedule: у 2022-05-01 удалён только тип референсной цены `CompetitivePriceThreshold` (удаление 2025-09-30) | нет | `CompetitivePriceThreshold` в коде не встречается; v0 в списке устаревания нет. |
| Amazon | Orders | 2026-01-01 (`searchOrders`, `ORDERS_PATH`), снимок 2026-09-29 | 2026-01-01 — последняя; файл совпал. Schedule: **Orders v0** (`getOrders`, `getOrder`, `getOrderItems`, `getOrderBuyerInfo`, `getOrderAddress`, `getOrderItemsBuyerInfo`) устарел 2026-01-28, **удаление 2027-03-27** | нет (v0 — устаревает, но мы его не зовём) | Правильная версия выбрана на шаге 51; `ordersV0.json` в снимке — только для сравнения, вызывать его нельзя. |
| Amazon | FBA Inventory | v1 (`getInventorySummaries`, `FBA_SUMMARIES_PATH`), снимок 2026-09-29 | v1 (`info.version` v1), файл совпал | нет | Чтение остатка FBA — по текущей модели. |
| Amazon | Notifications (API подписок) | v1 (`notifications.json`), в обоих снимках; код API подписок не вызывает — приёмник читает SQS | v1, файл совпал | нет | — |
| Amazon | Схемы уведомлений | `AnyOfferChangedNotification`, `PricingHealthNotification`, `ListingsItemMfnQuantityChange`, `ListingsItemStatusChangeNotification` (+ `FBAInventoryAvailabilityChangeNotification`, `OrderChangeNotification` в снимке 2026-09-29) | все шесть файлов совпали. Schedule: удалены `ORDER_STATUS_CHANGE` (2026-07-29), `LISTINGS_ITEM_ISSUES_CHANGE` payload 1.0 (2026-08-26) — мы их не подписываем (второй встречается только в сценарии стенда как «чужой тип — отказ») | нет | Страница notification-type-values сейчас даёт SHA-256 `f005b780…`, а в SOURCE.md 2026-09-16 записан `339620f2…`; `updatedAt` страницы 2026-09-09 — до даты снимка: изменился ли текст по существу — (проверить). |
| Amazon | Sellers | v1 (`sellers.json`), в обоих снимках; в коде адаптера вызова `getMarketplaceParticipations` не найдено | v1, файл совпал | нет | — |
| Amazon | Feeds | 2021-06-30 (+ схемы `listings-feed-*-v2`), снимок 2026-09-16; код не вызывает | 2021-06-30 — последняя; 2020-09-04 удалена 2024-06-27; файлы совпали | нет | — |
| Amazon | Reports | 2021-06-30, снимок 2026-09-16; код не вызывает | 2021-06-30 — последняя; 2020-09-04 удалена 2024-06-27; файл совпал | нет | — |
| Amazon | Product Type Definitions | 2020-09-01, снимок 2026-09-16; код не вызывает | 2020-09-01, файл совпал | нет | — |
| Amazon | Product Fees | v0, снимок 2026-09-16; код не вызывает | v0, файл совпал; в schedule нет | нет | — |
| Amazon | LWA (токен), SQS (приёмник) | `https://api.amazon.com/auth/o2/token` (`packages/channel-oauth/src/providers.ts`); SQS JSON-протокол `application/x-amz-json-1.0`, `X-Amz-Target: AmazonSQS.*` (`packages/amazon-notifications/src/sqs.ts`) | номера версии у этих интерфейсов нет | — | Сверять нечего; снимки страниц — `vendor/amazon/lwa-authorization`, `vendor/aws`. |

Замечание: `AMAZON_DESCRIPTOR.apiVersion` = `'listings-items-2021-08-01 (snapshot 2026-09-16, commit 3659f968)'` — строка
называет только Listings Items и старый снимок, хотя заказы и FBA написаны по снимку 2026-09-29 (коммит `713565ff`).
Ошибки версии нет (файл Listings Items в обоих снимках один), но строка неполна.

## eBay

Источник «актуального»: контракты `https://developer.ebay.com/api-docs/master/<группа>/<api>/openapi/3/<файл>.json` и
страницы release notes `https://developer.ebay.com/api-docs/<группа>/<api>/release-notes.html` (для Sell/Buy/Commerce
страница общая — одна страница со всеми API раздела); Trading — `https://developer.ebay.com/devzone/xml/docs/releasenotes.html`
и [eBay Schema Versioning Strategy](https://developer.ebay.com/devzone/xml/docs/HowTo/eBayWS/eBaySchemaVersioning.html).
Официальный GitHub eBay (`gh api orgs/eBay/repos`) OpenAPI-контрактов не публикует; закреплённые у нас SDK —
`eBay/event-notification-nodejs-sdk` (`feaf3378…`, 2023-06-15) и `eBay/ebay-oauth-nodejs-client` (`28215678…`,
2022-09-13) — это и есть HEAD их веток по умолчанию, новее ничего нет.

| Канал | API | Наша версия и источник | Актуальная (2026-09-29) | Расхождение | Что это значит для нас |
|---|---|---|---|---|---|
| eBay | Sell Inventory | 1.18.5 — `vendor/ebay/2026-09-28/sell_inventory_v1_oas3.json` (SHA-256 `070e35ef…`), `INVENTORY_PATH = /sell/inventory/v1` | Опубликованный контракт — **1.18.5, SHA-256 совпал**. Release notes: **1.18.8** (2026-08-24: блокирующая ошибка size standardization для Apparel & Footwear), 1.18.7 (2026-07-07: предупреждения по аспектам), 1.18.6 (2026-06-22: condition grading для salvage) | новее есть (только в release notes; контракт не обновлён) | Изменения 1.18.6–1.18.8 касаются создания листингов (вне скоупа), но новая блокирующая ошибка может прийти и на наш `bulkUpdatePriceQuantity` у одежды — её код в классификаторе ошибок (проверить). |
| eBay | Sell Account v1 | 1.9.3 — `sell_account_v1_oas3.json` (SHA-256 `3f04cf1f…`), `ACCOUNT_PATH = /sell/account/v1` | Контракт 1.9.3, SHA-256 совпал; release notes Account API v1 — последняя 1.9.3 (2025-10-28). Есть отдельный Account API **v2** (2.2.0, 2026-02-26) — другие ресурсы (combined shipping, payout, user preferences) | нет | v2 не замена v1; нужные чекеру ресурсы (политики, программы) — в v1. |
| eBay | Commerce Identity | 2.0.0 (`info.version`) — `commerce_identity_v1_oas3.json` (SHA-256 `8daac3dc…`), `https://apiz.ebay.com/commerce/identity/v1/user/` (`packages/channel-oauth/src/providers.ts`) | Контракт v2.0.0, SHA-256 совпал; release notes называют последней **1.1.0 (2019-10-24)** — заметки отстают от контракта | нет | Расхождение внутри документации eBay, не у нас. |
| eBay | Developer Analytics | v1_beta.0.1 — `developer_analytics_v1_beta_oas3.json` (SHA-256 `419ccc5c…`) | Контракт v1_beta.0.1, SHA-256 совпал; release notes — 1.0.1-beta (2025-04-02, поле `count` в `getRateLimits`) | нет | — |
| eBay | Sell Fulfillment | v1 по пути (`FULFILLMENT_ORDER_PATH = /sell/fulfillment/v1/order`); контракта в снимке нет (SOURCE.md: «Чего в снимке нет») | Контракт **v1.20.7** (SHA-256 `db06cfec913918dc675c19f36efcc8c5d8ae57231463a7e322b4c43b30c16eb9`); release notes Fulfillment — 1.20.7 (2025-07-17). В общей странице Sell таблица Fulfillment заканчивается 1.19.15 (2022) — устаревшая копия | (проверить) — снимка нет | Белый список полей заказа (EBAY_C17) держится без контракта; 1.20.6 (2025-04-10) убрал `legacyOrderId` из `getOrder`/`getOrders` — проверить, что мы его не читаем. |
| eBay | Buy Browse | v1 по пути (`browseItemPath` → `/buy/browse/v1/item/...`); контракта в снимке нет; в бою не вызывается [Р-190] | Контракт **v1.20.4** (SHA-256 `6ce90cbf7facc62b34c25a7eb5e5a164bbe18c3ba99e100dcbc33b7c7cf94414`); release notes Browse — **1.20.5** (2026-07-14: новый код ошибки у методов «get item» при неверных заголовках) | (проверить) — снимка нет; заметки новее контракта | Нас касается напрямую: `getItem` с заголовком `X-EBAY-C-MARKETPLACE-ID` — новый код ошибки заголовков стоит сверить (ср. E-23 `Accept-Language`). |
| eBay | Commerce Notification | v1 по пути (`/commerce/notification/v1/public_key/<kid>`, `services/ebay-account-deletion/src/verify.ts`); контракта нет, факты — из SDK | Контракт **v1.6.7** (SHA-256 `149a7a23e4ca40fbae11b17cfb7df24b55c34117fd8426ea99e9a15483575590`), release notes — 1.6.7 (2025-12-12: новые темы) | (проверить) — снимка нет | Метод `getPublicKey` в заметках 1.6.x не упомянут как изменённый; снимок контракта закрыл бы опору только на SDK 2023 года. |
| eBay | Trading | уровень совместимости **1349** — `TRADING_COMPATIBILITY_LEVEL` в `packages/ebay-adapter/src/descriptor.ts`, заголовок `x-ebay-api-compatibility-level` (`session.ts`); вызовы `GetMyeBaySelling`, `GetItem`, `GetUserPreferences`; документации в снимке нет | Текущая **1477** (2026-08-24); 1349 выпущена 2024-02-26. Политика: «We increment the lowest supported version every 6 months. The lowest supported version will be 18 months old» — к 2026-09 это версия около 2025-03 (≈1399–1415); таблица «Version Support Schedule» на странице не обновлялась с 2020 (последняя строка 1227, август 2022) | **устаревает** (по политике — уже ниже нижней поддерживаемой; точный номер — (проверить)) | Объекты, устаревшие в неподдерживаемых версиях, «may stop working without notice»: между 1349 и 1477 менялись `GetMyeBaySelling` (1375 — убраны `DeletedFromUnsoldList`/`DeletedFromSoldList`; 1451 — убраны поля заказов) и `GetItem` (1371, 1395 и др.); песочница на шаге 39 работала с 1349, но для боя это не доказательство [Р-162]. |
| eBay | OAuth (Identity token) | `/identity/v1/oauth2/token`, клиент `eBay/ebay-oauth-nodejs-client` @ `28215678…` | HEAD репозитория — тот же коммит | нет | — |

Недоступно без браузера: **страница статуса устаревания API eBay** —
https://developer.ebay.com/develop/get-started/api-deprecation-status — 403 и для `curl` с User-Agent браузера, и для
WebFetch. Владельцу открыть в браузере и выписать строки про Inventory, Account v1, Fulfillment, Browse, Identity,
Notification и вызовы Trading `GetItem`, `GetMyeBaySelling`, `GetUserPreferences`.

## Что осталось «(проверить)»

1. **Trading: фактическая нижняя поддерживаемая версия** — страница Schema Versioning показывает таблицу 2020–2022; нужна
   текущая строка (владелец — в браузере, или вопрос в поддержку eBay).
2. **Inventory 1.18.6–1.18.8** — опубликованный контракт отстаёт от release notes; новые коды ошибок (size standardization)
   в контракте не видны.
3. **Browse 1.20.5** — новый код ошибки заголовков у `getItem`; кода нет ни в контракте 1.20.4, ни у нас.
4. **Fulfillment, Browse, Notification** — снимков контрактов в `vendor/ebay` нет; версии выше названы по опубликованным
   контрактам без закрепления в репозитории.
5. **Статус устаревания API eBay** — страница 403 (см. выше).
6. **Amazon notification-type-values** — SHA-256 страницы отличается от записанного 2026-09-16 при том же `updatedAt`.

## Действия на отдельный шаг обновления (здесь не выполнялись)

1. **Trading API: поднять `TRADING_COMPATIBILITY_LEVEL` с 1349 до текущей (1477)** — прочитать «Changed Calls» для
   `GetMyeBaySelling`, `GetItem`, `GetUserPreferences` в версиях 1351…1477, проверить разбор ответов чекера миграции и
   обнаружения (EBAY_C16, E-19: поле `Site`), прогнать сценарии стенда `tests/contract/fixtures/ebay` и один живой вызов
   в песочнице [Р-162].
2. **Снимок eBay: добавить контракты Fulfillment v1.20.7, Browse v1.20.4, Notification v1.6.7** в новый каталог
   `vendor/ebay/2026-09-29/` с SHA-256 (теперь скачиваются `curl` с User-Agent браузера из `api-docs/master/.../openapi/3/`);
   сверить белый список полей заказа (EBAY_C17, E-20) и отсутствие `legacyOrderId` с контрактом Fulfillment.
3. **Release notes eBay в снимок** (Sell, Buy, Trading) — страницы с датой и SHA-256, чтобы следующая сверка видела изменения.
4. **Inventory 1.18.6–1.18.8, Browse 1.20.5:** узнать коды новых ошибок (из заметок или из контракта, когда eBay его обновит)
   и занести в классификатор ошибок адаптера и модель симулятора [Р-187].
5. **Страница статуса устаревания API eBay** — сохранить владельцем в браузере (как на шаге 48) и выписать наши API.
6. **Amazon:** уточнить `AMAZON_DESCRIPTOR.apiVersion` — назвать Orders 2026-01-01 и FBA Inventory v1 со снимком
   2026-09-29 (`713565ff`); заново сохранить notification-type-values с датой и SHA-256.
7. **Amazon Orders v0 удаляется 2027-03-27** — правило репозитория «код не зовёт `/orders/v0/`» [Р-146], чтобы возврат к v0
   не прошёл незамеченным.
8. Повторять эту сверку перед каждым выпуском: HEAD `amzn/selling-partner-api-models` и контракты `api-docs/master` eBay.
