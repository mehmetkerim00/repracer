# Шаг 53, пункты 1–2: устаревания eBay и уровень совместимости Trading

## 1. Устаревания: что мы зовём

Факты об устареваниях — со слов руководителя, 2026-09-29 ([vendor/ebay/2026-09-29/DEPRECATION-NOTE.md](../../vendor/ebay/2026-09-29/DEPRECATION-NOTE.md)). Проверено по коду адаптера `packages/ebay-adapter/src`: имена вызовов Trading и пути REST.

| Устаревшее | Зовём? | Что зовём вместо |
|---|---|---|
| `GeteBayDetails` (устарел 2026-09-21, отключение 2027-03-15, замена — Metadata API) | **Нет** | Сайт и валюту листинга берём из `GetItem`, витрины — из справочника `EBAY_MARKETPLACES` |
| `UploadSiteHostedPictures` (отключение 2026-09-30) | **Нет** | Листинги мы не создаём — вне скоупа |
| Finding API, Shopping API (отключены, замена — Browse) | **Нет** | Browse — живая цена листинга в песочнице; в бою не вызывается до лицензии Buy API [Р-190] |
| VeRO API v1 (отключение 2026-09-30) | **Нет** | — |

Из Trading мы зовём ровно три вызова: `GetItem` и `GetUserPreferences` (предполётная проверка миграции), `GetMyeBaySelling` (обнаружение старых листингов). Плана миграции не нужно.

## 2. Уровень совместимости Trading: 1349 → 1477

Заметки к выпускам загрузились без браузера — [vendor/ebay/2026-09-29/trading-release-notes.html](../../vendor/ebay/2026-09-29/trading-release-notes.html) (SHA-256 в `SHA256SUMS`). Версии после 1349: 1355, 1357, 1359, 1363, 1367, 1371, 1375, 1379, 1391, 1395, 1399, 1415, 1421, 1423, 1451, 1453, 1455, 1475, 1477.

Что касается НАШИХ трёх вызовов:

| Версия | Изменение | Нас касается? |
|---|---|---|
| 1375 (2024-08-26) | Из `GetMyeBaySelling` сняты контейнеры `DeletedFromUnsoldList` и `DeletedFromSoldList` | Нет: запрос берёт только `ActiveList` |
| 1371 (2024-07-17) | Поля GPSR, в том числе economic operator, — в `GetItem` их по-прежнему возвращают | Нет: разбор предполётной проверки (`parseGetItem`) их не читает |
| 1395 (2025-01-14) | `ContactURL` у производителя и ответственного лица, новые состояния б/у одежды | Нет |
| 1423 (2025-07-28) | Новое значение `BestOfferStatusCodeType` | Нет: читаем только `BestOfferDetails.BestOfferEnabled` |
| прочие | Выведены вызовы, которых мы не зовём: `GetSellerDashboard`, `GetSuggestedCategories`, `GetClientAlertsAuthToken`, `GeteBayOfficialTime`, `GetCategoryMappings`, `ExtendSiteHostedPictures`, VeRO-вызовы, `GetCategories`, `GetCategoryFeatures` | Нет |

**Сделано:**
- `TRADING_COMPATIBILITY_LEVEL = '1477'` ([packages/ebay-adapter/src/descriptor.ts](../../packages/ebay-adapter/src/descriptor.ts));
- проверка запросов стенда требует тот же уровень — берёт константу адаптера, а не литерал;
- тест адаптера утверждает 1477.

Адаптер, сценарии стенда и модель eBay — 117 из 117.

**Живьём проверить в следующей сессии песочницы:** `GetItem`, `GetUserPreferences` и `GetMyeBaySelling` с уровнем 1477 — разбор ответов предполётной проверки и обнаружения.
