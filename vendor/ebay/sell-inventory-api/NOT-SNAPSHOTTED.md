# eBay Sell Inventory API — снимок НЕ сохранён (шаг 20)

Спецификация и страницы документации eBay на шаге 20 скачать не удалось. Сторонние копии спецификации (найдены в чужих
репозиториях на GitHub) снимком канала не считаются: происхождение и неизменность не проверяются.

| Адрес | Откуда | Итог |
|---|---|---|
| https://developer.ebay.com/api-docs/master/sell/inventory/openapi/3/sell_inventory_v1_oas3.json | рабочая машина, 2026-09-16 | 403, страница «Error Page \| eBay» (защита от автоматических запросов) |
| то же, `sell_account_v1_oas3.json`, `sell_metadata_v1_oas3.json`, страницы `sell/inventory/overview`, `bulkMigrateListing`, `api-call-limits`, `rest-request-components` | GitHub Actions `ubuntu-24.04`, 2026-09-16 (прогон 35138583343 ветки step20-infra) | 403 на каждый адрес, тело — та же страница ошибки (1 832 байта) |
| https://developer.ebay.com/ (корень) | рабочая машина | 200 — сайт доступен, закрыты только разделы документации |

Официальный путь без браузера, найденный в репозитории eBay `npm-public-api-mcp`, — поиск спецификаций
`https://api.ebay.com/developer/mcp/v1/search`, требует OAuth-токена приложения eBay, то есть ключей разработчика — доступа, которого нет.

Что нужно для снимка (вопрос E-01 в channel-capabilities.md §9): скачать спецификацию вручную в браузере владельцем аккаунта
разработчика eBay или через API с ключами приложения; сохранить сюда каталогом с датой, `SOURCE.md` и `SHA256SUMS`, как у Kaufland
и Amazon. До этого все значения eBay в channel-capabilities.md остаются (проверить).
