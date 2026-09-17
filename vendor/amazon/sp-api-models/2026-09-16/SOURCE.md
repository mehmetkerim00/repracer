# Amazon Selling Partner API — снимок моделей

| Поле | Значение |
|---|---|
| Источник | https://github.com/amzn/selling-partner-api-models (официальный репозиторий моделей SP-API) |
| Коммит | `3659f96867bfc669aca7a524c2f95744ff0e4478` (2026-08-26T20:03:32Z, ветка `main`) |
| Скачано | 2026-09-16, `raw.githubusercontent.com/amzn/selling-partner-api-models/<коммит>/<путь>` |
| Формат | OpenAPI 2.0 (Swagger) для моделей, JSON Schema draft-07 для уведомлений и фидов |
| Контрольные суммы | SHA-256 каждого файла — `SHA256SUMS` |

Состав — только модели, нужные для записи цены и остатка, данных конкурентов и подтверждения применения:

| Файл | Операции |
|---|---|
| `models/listings-items-api-model/listingsItems_2021-08-01.json` | `patchListingsItem`, `putListingsItem`, `getListingsItem`, `searchListingsItems`, `deleteListingsItem` |
| `models/listings-items-api-model/listingsItems_2020-09-01.json` | предыдущая версия (для сравнения лимитов) |
| `models/feeds-api-model/feeds_2021-06-30.json` + `schemas/feeds/listings-feed-*-v2.json` | `createFeed`, `JSON_LISTINGS_FEED` |
| `models/product-pricing-api-model/productPricing_2022-05-01.json`, `productPricingV0.json` | `getCompetitiveSummary`, `getItemOffers*`, `getListingOffers*` |
| `models/notifications-api-model/notifications.json` + `schemas/notifications/*.json` | подписки; `ANY_OFFER_CHANGED`, `PRICING_HEALTH`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE`, `LISTINGS_ITEM_STATUS_CHANGE` |
| `models/sellers-api-model/sellers.json` | `getMarketplaceParticipations` |
| `models/product-type-definitions-api-model/definitionsProductTypes_2020-09-01.json` | схемы атрибутов типа товара |
| `models/product-fees-api-model/productFeesV0.json` | оценка комиссий |
| `models/reports-api-model/reports_2021-06-30.json` | отчёты (сверка остатка) |

Файлы не редактируются. Новая версия — новый каталог с датой.

## Страницы документации, использованные для channel-capabilities.md

Текст не копируется. Для каждой страницы — адрес Markdown-версии (документация даёт её по суффиксу `.md`), время загрузки
2026-09-16 19:15 UTC (заголовок `date` ответа), поле `updatedAt` страницы и SHA-256 загруженного текста — чтобы изменение страницы
было видно при следующей сверке.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/listings-items-api-rate-limits.md | см. файл | `4e262784ceff40f0b508b7dde5643817181038208727921012aee95ecbf6f7c6` |
| https://developer-docs.amazon/sp-api/docs/building-listings-management-workflows-guide.md | см. файл | `8c5297a2ff48682545708b9b818a1c48ce21f0bd641d59254995e32a54977bb3` |
| https://developer-docs.amazon/sp-api/docs/usage-plans-and-rate-limits.md | 2026-09-09T22:32:13Z | `bb61409c21b86f2ee611cb39d4603989dac53709999a478fa688dff26e9e6364` |
| https://developer-docs.amazon/sp-api/docs/manage-purchasable-offer.md | см. файл | `d26904966093e9f36c8e2cb54ec432dd66ae0a13c292bfb4c54a1f40d91d5971` |
| https://developer-docs.amazon/sp-api/docs/listings-items-api.md | см. файл | `6c3920e97ba4ceb5e85ca25a67c48e87efab709866bcb25a7b8a71bb67280005` |
| https://developer-docs.amazon/sp-api/docs/notification-type-values.md | см. файл | `339620f2875c16f1fbb2d4207abcd23e352ff5618bf760b92196f4a5492de6ff` |
| https://developer-docs.amazon/sp-api/docs/feeds-api-rate-limits.md | см. файл | `9fefba5a211fec8386abd1f62a10260cc3a2888f3909e52917735fa9fdbb8cb6` |
| https://developer-docs.amazon/sp-api/docs/listings-feed-type-values.md | см. файл | `7b5ebf2cc8b99918f8b6ddacbfe8f3afa674dc04a7f83b7dd4b5d2b3243e566b` |
| https://developer-docs.amazon/sp-api/docs/product-pricing-api.md | см. файл | `926f44d60f480e46988542e4bd8030ad908e94e2d9feedb59363d3bd8df28667` |
| https://developer-docs.amazon/sp-api/docs/pricing-faq.md | см. файл | `81760000276795ceb4e10c43cd13306e557e7d2d4630327e5d0b600bb54a3e37` |
| https://developer-docs.amazon/sp-api/docs/report-type-values-inventory.md | см. файл | `9cc71c616aae0843cd777e75638a70934d0fe7d06b830be7d284bd2c5e516c3d` |
| https://developer-docs.amazon/sp-api/docs/sp-api-endpoints.md | 2026-09-09T09:00:11Z | `2067aae107e3bfea5f61b52b4df59c3771c0fbebd50c537bc0128e812608f89b` |
| https://developer-docs.amazon/sp-api/changelog/sp-api-updates-listings-items-api-adds-multi-marketplace-support-and-july-listing-attribute-enumeration-updates.md | см. файл | `0272ff94ef2dd0d6200d5f51dc89cb99f08d84c1046105d0cd994bc23d54bed1` |
| https://developer-docs.amazon.com/sp-api/docs/marketplace-ids (HTML; Markdown-версии нет — 404) | — | `4b0d40cf647392096389fdd04758e10a2cbe200e77d8675f6b1068859a9d0dc7` |
| https://developer-docs.amazon/sp-api/docs/connecting-to-the-selling-partner-api.md (шаг 22: токен LWA, заголовки запроса) | 2026-09-09T22:32:25Z | `d8ff4f0d83ab41f04cbbe3266b17d65b47e966cb814b88464e7010f399a344cb` |
| https://developer-docs.amazon/sp-api/docs/merge-a-listing.md (шаг 22: остаток через `merge` на `/attributes/fulfillment_availability`) | 2026-09-09T22:43:50Z | `3f660c532fc15b3583d082d818c024f925997ffe11aa0cf575185345b700694a` |

Шаг 22 (адаптер Amazon): страницы manage-purchasable-offer, listings-items-api-rate-limits, usage-plans-and-rate-limits,
building-listings-management-workflows-guide, listings-items-api, sp-api-endpoints и страница изменений о нескольких витринах
загружены повторно 2026-09-17 — SHA-256 совпали с таблицей. Две последние строки таблицы добавлены в шаге 22.
