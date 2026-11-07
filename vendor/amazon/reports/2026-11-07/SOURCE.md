# Amazon SP-API — отчёт листингов: страницы документации

По образцу [`vendor/amazon/listing-status`](../../listing-status/2026-10-21/SOURCE.md): текст страниц не копируется. Для каждой страницы указаны адрес
Markdown-версии (документация отдаёт её по суффиксу `.md`), поле `updatedAt` и SHA-256 загруженного текста. Загружено 2026-11-07, 10:08 UTC. Страницы
`reports-api-v2021-06-30-use-case-guide.md` и `reports-api-rate-limits.md` перенаправляют (301); страницы найдены по указателю
`https://developer-docs.amazon/sp-api/llms.txt`. Повод — шаг 117 (P0-16 аудита, A-31): каталог Amazon обнаруживается отчётом.

Модель операций — снимок [`2026-09-16`](../../sp-api-models/2026-09-16/SOURCE.md): `models/reports-api-model/reports_2021-06-30.json`, SHA-256
`d72db9e5280262a92933a0e45e2207c150272f1d66177b2517c20671d69c732c` (совпадает с `SHA256SUMS`). В снимках 2026-09-29 и 2026-10-29 модели Reports нет.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/report-type-values-inventory.md | 2026-10-28T19:09:48Z | `418c8bdb8dfc2d333492c2217c3b4906aaf53dd777e8c802e4c99945b61dd122` |
| https://developer-docs.amazon/sp-api/docs/request-a-report.md | 2026-09-09T22:51:17Z | `ebb1f3c378a8a5e08c4807b5729f4620d42a5dfbb203f5162265a633e39384b5` |
| https://developer-docs.amazon/sp-api/docs/verify-that-report-processing-is-complete.md | 2026-09-09T22:51:04Z | `8905cdbc7ff802b07075f6dcd32c9522c78cf03f1e749d8338e5729d50c3bae5` |
| https://developer-docs.amazon/sp-api/docs/retrieve-a-report.md | 2026-10-14T21:26:29Z | `cfe2e61eddd2136b65655fb645790b47c44e0f942b2b8d25463454fcdf6160ae` |
| https://developer-docs.amazon/sp-api/docs/reports-api.md | 2026-09-09T22:51:08Z | `d8ed5ac534668cba9e3b8dec770cc2f9b56aefa6814c46842c83a5d07050485c` |
| https://developer-docs.amazon/sp-api/docs/reports-faq.md | 2026-09-09T22:35:05Z | `81c75d04f3eef1f76b4989e88c27be5e53b7775516700b540320e983496dd1e1` |

Страница `report-type-values-inventory.md` уже записана в снимках 2026-09-16 и 2026-10-21; с тех пор обновлена, SHA-256 другой.

## Факты, которые взяты со страниц и из модели (и только они)

- **Отчёт `GET_MERCHANT_LISTINGS_ALL_DATA`** (report-type-values-inventory, «All Listings Report»). Роли — Inventory and Order Tracking, Pricing или
  Direct to Consumer Shipping (Restricted); «can only be requested» — расписания нет; вывод — «Tab-delimited flat file».
  - Одна витрина на отчёт: «When requesting a report with multiple `marketplaceIds`, only the first `marketplaceId` in the list will be accepted».
  - `reportOptions`: `custom` (по умолчанию `false`) и `preferredReportDocumentLocale` — язык заголовков колонок. «Reports are not cached by locale»: из кэша
    (от одного до шести часов, по числу строк) заголовки могут прийти на другом языке.
  - Документ начинается с UTF-8 BOM: «This report includes a UTF-8 Byte Order Mark (BOM) as the first 3 bytes».
  - Колонки (раскрывающийся список страницы), в её порядке: `item-name`, `item-description`, `listing-id`, `seller-sku`, `price`, `quantity`, `open-date`,
    `image-url`, `item-is-marketplace`, `product-id-type`, `zshop-shipping-fee`, `item-note`, `item-condition`, `zshop-category1`, `zshop-browse-path`,
    `zshop-storefront-feature`, `asin1`, `asin2`, `asin3`, `will-ship-internationally`, `expedited-shipping`, `zshop-boldface`, `product-id`,
    `bid-for-featured-placement`, `add-delete`, `pending-quantity`, `fulfillment-channel`, `merchant-shipping-group`, `status`. Значения колонок
    (`item-condition`, `fulfillment-channel`, `status`) страница не описывает.
- **Запрос** (request-a-report): `createReport` с `reportType`, `marketplaceIds`, `reportOptions`; ответ — `reportId`, «unique only in combination with a
  seller ID». Модель: ответ 202, `CreateReportResponse.required` — `reportId`.
- **Готовность** (verify-that-report-processing-is-complete): `getReport` по `reportId` до конечного `processingStatus`. Конечные — `CANCELLED` (отменён
  запросом или «an automatic cancellation if there is no data to return»), `DONE` (есть `reportDocumentId`), `FATAL` (`reportDocumentId` может быть и
  объясняет причину); `IN_PROGRESS` и `IN_QUEUE` — ждать. `getReport` отвечает только об отчётах за последние 90 дней. Модель: `Report.required` —
  `processingStatus`, `reportId`, `reportType`, `createdTime`; ответ 200 — `Report` **без обёртки**. Пример ответа на странице — в `payload` (расхождение,
  вопрос A-35).
- **Документ** (retrieve-a-report): `getReportDocument` даёт подписанный адрес, который «expires after five minutes», и, если документ сжат,
  `compressionAlgorithm` (`GZIP`). Пример кода страницы берёт кодировку из `content-type` ответа хранилища и предполагает, что она там есть.
  Документ хранить незашифрованным нельзя («Unencrypted report content must never be stored on disk»): адаптер держит список SKU в памяти процесса.
- **Лимиты** (модель, Usage Plan в описании операций): `createReport` 0.0167 запроса в секунду, burst 15; `getReport` 2, burst 15; `getReportDocument`
  0.0167, burst 15. Лимит приложения модель не описывает.
- **Свежесть** (reports-faq, страница статуса листинга снимка 2026-10-21): отчёты не в реальном времени; генерация дольше при большом отчёте и нагрузке.

Вопросы, которые снимок не закрывает, — A-35…A-40 в [channel-capabilities.md](../../../../docs/channel-capabilities.md).
