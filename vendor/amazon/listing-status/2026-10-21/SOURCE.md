# Amazon SP-API — статус листинга и роли: страницы документации

По образцу [`vendor/amazon/sandbox`](../../sandbox/2026-10-05/SOURCE.md): текст страниц не копируется. Для каждой страницы указаны адрес
Markdown-версии (документация отдаёт её по суффиксу `.md`), поле `updatedAt` и SHA-256 загруженного текста. Загружено 2026-10-21,
12:59–13:01 UTC. Адрес `understanding-amazon-listing-status.md` перенаправляет на 404; страница найдена по указателю
`https://developer-docs.amazon/sp-api/llms.txt`. Повод — вопрос A-30 (защита от ценовой ошибки) и проверка ролей пакета анкеты
разработчика.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/understanding-amazon-listing-status-and-seller-fulfilled-inventory-management.md | 2026-09-09T22:39:21Z | `9d6a42dc310a9921ea13c09802aa748938c04364f66109476351bbe008e15def` |
| https://developer-docs.amazon/sp-api/docs/notification-type-values.md | 2026-09-30T21:24:42Z | `41d2ca3121085fd542b50c88425b56e7f32a34a74e4596303f2b1aa91ca3fe86` |
| https://developer-docs.amazon/sp-api/docs/report-type-values-inventory.md | 2026-10-06T16:32:27Z | `65a9cd53b2f57dd10330b39465df00626b5a22f5df311a32ec9bcad192741428` |
| https://developer-docs.amazon/sp-api/docs/roles-in-the-selling-partner-api.md | 2026-10-13T20:37:15Z | `abc529ce2adfe729dac2f125a904dddc3aff7a01716361ff1c1265cf68308a74` |
| https://developer-docs.amazon/sp-api/docs/role-mappings.md | 2026-10-13T19:52:02Z | `65e74023327bcbb03611a41d1400ab01b73c8c030ad301942be494b1eeeb56b3` |
| https://developer-docs.amazon/sp-api/docs/role-mappings-for-types.md | 2026-09-09T23:08:08Z | `a5aff53f1e17a47f898d3735bbadd3884fe1ae0c4fd0e98cdd70fd82c2eb2522` |

Страницы `notification-type-values.md` и `report-type-values-inventory.md` уже записаны в снимке
[`2026-09-16`](../../sp-api-models/2026-09-16/SOURCE.md). С тех пор они обновлены: SHA-256 другие.

## Факты, которые взяты со страниц (и только они)

- **Статусы листинга** (understanding-amazon-listing-status). У листинга два состояния: **Buyable** (покупатель может купить) и
  **Discoverable** (покупатель может найти). Инвентарь и отчёты делят листинги на Open, Active, Inactive и Cancelled/Blocked. У класса
  Cancelled/Blocked в таблице указано «Blocked due to pricing rules violations» и «Not buyable but are still discoverable».
- **Чтение статуса.** `searchListingsItems` с фильтрами `withStatus` / `withoutStatus` (`BUYABLE`, `DISCOVERABLE`). Пример: «можно
  найти, нельзя купить» — `withoutStatus=BUYABLE`, `withStatus=DISCOVERABLE`. Значения фильтров совпадают с моделью снимка
  [`2026-09-29`](../../sp-api-models/2026-09-29/SOURCE.md). Точная причина — `getListingsItem` с `includedData=issues`.
- **Предел `searchListingsItems`.** «This operation retrieves listings in batches, but is limited to 1000 listings total across all
  pages». Тот же предел — в модели снимка [`2026-09-29`](../../sp-api-models/2026-09-29/SOURCE.md), в описании `numberOfResults`:
  «The maximum number of items (SKUs) that can be returned and paged through is 1000»; сам `numberOfResults` — сколько найдено
  («only results up to the page count limit is returned per request regardless of the number found»). На странице `listings-items-api.md`
  предела нет. Что канал отвечает за пределом (нет токена или ошибка) — не сказано. Вопрос — A-31. *(Поправка шага 106: в первой
  редакции этого файла было «нет ни в модели снимка» — неверно, предел искался по словам «1000 listings».)*
- **Отчёты.** `GET_MERCHANT_LISTINGS_INACTIVE_DATA` содержит листинги с нулевым количеством, заблокированные, подавленные, ещё не
  открытые и с истёкшим сроком продажи. `GET_MERCHANTS_LISTINGS_FYP_REPORT` содержит только подавленные листинги, с причинами и с
  тем, как снять подавление. Отчёты не в реальном времени: свежесть данных об остатке до 3 ч, повторные вызовы — данные возрастом
  1–6 ч.
- **Уведомления.** `LISTINGS_ITEM_STATUS_CHANGE` приходит при создании и удалении листинга и при смене buyability.
  `LISTINGS_ITEM_ISSUES_CHANGE` приходит при создании, исправлении и изменении проблемы листинга:
  - несёт серьёзность и действия Amazon (версия `2023-12-13` даёт больше действий; `LISTING_SUPPRESSED` снимает buyability);
  - подробности — через Listings Items API;
  - не у всех проблем есть определённые issues: «this notification does not necessarily represent all problems with a listing
    (neither does the Selling Partner API for Listings Items)»;
  - у `ISSUES_CHANGE` версия «1.0» «will be deprecated soon» — подписка на `2023-12-13`.
- **Доставка уведомлений** («Workflow» на notification-type-values):

| Уведомления | Доставка |
|---|---|
| `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` | Amazon EventBridge |
| `ANY_OFFER_CHANGED`, `PRICING_HEALTH` | Amazon SQS |

- `PRICING_HEALTH` — другое: предложение не может быть Featured Offer из-за неконкурентной цены, а не деактивация листинга.
- **Роли** (role-mappings, role-mappings-for-types; «need at least one»):

| Что | Роли (хотя бы одна) |
|---|---|
| `getListingsItem`, `searchListingsItems`, `patchListingsItem` | Inventory and Order Tracking, Product Listing |
| `LISTINGS_ITEM_STATUS_CHANGE`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_MFN_QUANTITY_CHANGE` | Product Listing |
| `ANY_OFFER_CHANGED`, `PRICING_HEALTH`, `getCompetitiveSummary` | Pricing |
| `GET_MERCHANT_LISTINGS_INACTIVE_DATA` | Inventory and Order Tracking, Pricing, Product Listing |
| `GET_MERCHANTS_LISTINGS_FYP_REPORT` | Product Listing |
| `getInventorySummaries` | Amazon Fulfillment, Product Listing |
| `createSubscription` | роль, связанная с типом уведомления |
| `createDestination` | роль не нужна (grantless) |

В модели снимка `2026-09-29` у `Issue` есть категории, среди них `INVALID_PRICE`, и действия: `LISTING_SUPPRESSED`,
`ATTRIBUTE_SUPPRESSED`, `CATALOG_ITEM_REMOVED`, `SEARCH_SUPPRESSED`. Какими кодом, категорией и действием помечена именно
деактивация за ценовую ошибку, документация не говорит.
