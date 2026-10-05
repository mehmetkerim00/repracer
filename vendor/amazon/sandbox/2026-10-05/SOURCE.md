# Amazon SP-API — песочница: страницы документации

Шаг 70. По образцу снимка `vendor/amazon/lwa-authorization`: текст страниц не копируется — для каждой адрес Markdown-версии
(документация отдаёт её по суффиксу `.md`), поле `updatedAt` и SHA-256 загруженного текста. Загружено 2026-10-05. Адреса
`the-selling-partner-api-sandbox.md`, `static-sandbox.md` и `dynamic-sandbox.md` отвечают перенаправлением на 404; страницы найдены
по указателю `https://developer-docs.amazon/sp-api/llms.txt`.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/sp-api-sandbox.md | 2026-09-09T22:32:02Z | `6f82c1806d603f253d0cff796cd5f9393efe1c2fc3d6375d5be4ef3db08f1702` |
| https://developer-docs.amazon/sp-api/docs/onboarding-step-4-register-your-first-sandbox-application.md | 2026-09-09T23:48:58Z | `5931a714dcfd8fc210ac6a05e63557e9413af409099ca05573e0d5f42e776b5a` |
| https://developer-docs.amazon/sp-api/docs/onboarding-step-5-make-your-first-call-to-the-sp-api-sandbox.md | 2026-09-09T23:48:30Z | `f368a6148ab625be81c48744ad0ac1338a9198c42c3b4dff309366fccc99565a` |
| https://developer-docs.amazon/sp-api/docs/sp-api-endpoints.md | 2026-09-09T09:00:11Z | `195f1b5cbe8c7253accc1b81fe7a5b66db55edb6f5e530e31009b9d33337bad9` |
| https://developer-docs.amazon/sp-api/docs/fba-inventory-api-v1-dynamic-sandbox-guide.md | 2026-09-09T22:45:33Z | `a1533829b651328426812f6eb2f7d601d8defd7362b20cc5658c38f816deb1c4` |
| https://developer-docs.amazon/sp-api/docs/marketplace-ids.md | 2026-09-30T21:24:06Z | `cb689f4349b1bf0f7a7c851d25d5d4b2e1616e46c3d01eb2e39ba60d173b247a` |

## Факты, которые взяты со страниц (и только они)

- **Три песочницы.** Статическая — сопоставление по образцу: ответ из объекта `x-amzn-api-sandbox.static` модели операции, когда в
  запросе есть параметры образца. Динамическая — запрос уходит в бэкенд песочницы, ответ зависит от параметров и может хранить
  состояние; операция отмечена `x-amzn-api-sandbox.dynamic`. Третья — локальная, на ИИ (Amazon Bedrock); мы её не используем.
- **Какие API где** (таблица «Sandbox support by API»): Sellers — статическая; Listings Items, Orders (2026-01-01), Product Pricing —
  статическая и ИИ; FBA Inventory — динамическая и ИИ; Notifications — статическая.
- **Адреса песочницы:** `https://sandbox.sellingpartnerapi-na.amazon.com`, `-eu`, `-fe` — те же регионы, что у боевых адресов
  (`sp-api-endpoints.md`).
- **Лимит песочницы** — 5 запросов в секунду, burst 15, для всех вызовов: «Use the hosted sandbox environments to test
  functionality, *not* scalability».
- **Операции с RDT** в песочнице требуют RDT, полученного в бою.
- **Операции только для песочницы** отмечены `x-amzn-api-sandbox-only` (например, `createInventoryItem` и `addInventory` FBA Inventory).
- **Учётные данные песочницы** (шаги 4–5 онбординга): приложение типа Sandbox в Solution Provider Portal; Client ID
  (`amzn1.application-oa2-client.…`) и Client Secret (`amzn1.oa2-cs.v1.…`) — «View sandbox credentials»; refresh-токен
  (`Atzr|…`) — кнопка **Create Token** на странице **Sandbox Testing**. Обмен — тот же `POST https://api.amazon.com/auth/o2/token`,
  `grant_type=refresh_token`; ответ — токен доступа `Atza|…` на час (`{"access_token","token_type":"bearer","expires_in":3600}`).
  Согласие продавца для песочницы не нужно.

- **Динамическая песочница FBA Inventory** (страница руководства): `createInventoryItem`, `addInventory`, `deleteInventoryItem` — операции
  только для песочницы; `getInventorySummaries` отдаёт динамически ASIN, `fnSku`, `sellerSku`, `fulfillableQuantity`,
  `totalReservedQuantity`, `pendingCustomerOrderQuantity`, `totalQuantity`, остальные поля — ноль. ASIN и FNSKU виртуальные. Удалить товар
  можно, только когда `fulfillableQuantity`, `totalReservedQuantity` и `pendingCustomerOrderQuantity` равны нулю; уменьшить запас —
  только заказом в динамической песочнице Fulfillment Outbound. Тела запросов в примерах страницы расходятся с моделью снимка
  (`marketplaceIds` против `marketplaceId`, путь `/v1/items/inventory` без `/fba/inventory`): права модель — песочница отклонила тело
  примера (docs/evidence/step70-amazon-sandbox.md).
- **Идентификаторы витрин по регионам** (marketplace-ids): Северная Америка — CA, US, MX, BR; Европа, Ближний Восток, Индия, Африка —
  IE, ES, UK, FR, BE, NL, DE, IT, SE, ZA, PL, EG, TR, SA, AE, IN; Дальний Восток — SG, AU, JP. Таблица регионов модели стенда
  (`tests/contract/src/simulator/amazon-channel.ts`) — с этой страницы.

## Чего страницы не говорят

- Отвечает ли боевой SP-API на запрос с витриной чужого региона и с токеном, выданным в другом регионе, так же, как песочница
  (вопрос A-27 в `docs/channel-capabilities.md`).
- Как боевой SP-API отличает в ответе 403 отсутствующую роль приложения от недействительного токена (A-26).
- Ограничивает ли SP-API сводки и офферы ответа витринами из `marketplaceIds` запроса (A-28): модель говорит только «store identifiers
  for the request» и «Offer details … for the specified Amazon store».
