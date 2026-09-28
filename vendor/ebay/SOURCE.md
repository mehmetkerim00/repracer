# eBay — снимок спецификаций и страниц документации (E-01, шаг 48)

Документация eBay отвечает 403 на загрузку без браузера (шаги 20 и 39, [sell-inventory-api/NOT-SNAPSHOTTED.md](sell-inventory-api/NOT-SNAPSHOTTED.md)).
Файлы сохранил владелец аккаунта разработчика в браузере **2026-09-28** (08:33–09:19 UTC — время сохранения файлов), каталог
[`2026-09-28/`](2026-09-28/). Проверка: `cd vendor/ebay/2026-09-28 && shasum -a 256 -c SHA256SUMS`.

## Файлы

| Файл | Что это | Версия / адрес | SHA-256 в репозитории | SHA-256 как сохранено |
|---|---|---|---|---|
| `sell_inventory_v1_oas3.json` | OpenAPI Sell Inventory API | `Inventory API` 1.18.5, сервер `https://api.ebay.com/sell/inventory/v1` | `070e35efbc1e6b0c67c702d3bd9d8a4fb5046bcd948dca7170f1bc33d5a36a46` | то же |
| `sell_account_v1_oas3.json` | OpenAPI Sell Account API | `Account v1 API` 1.9.3 | `3f04cf1fd7c80160312d68be5afd7d0de00eb57fd32d508cbb5eeec526b8bfbb` | то же |
| `commerce_identity_v1_oas3.json` | OpenAPI Commerce Identity API | `Identity API` 2.0.0, сервер `https://apiz.ebay.com/commerce/identity/v1` | `8daac3dc299bfb873c1cd27bee76af4dde0812bfb05c7539276d09d9093ce30d` | то же |
| `developer_analytics_v1_beta_oas3.json` | OpenAPI Developer Analytics API | `Analytics API` v1_beta.0.1 | `419ccc5cb97fdeb947bb7d7647b45e19e526ef1264230dc7283f106dc86dab3c` | то же |
| `api-call-limits.html` | Страница «API Call Limits» | https://developer.ebay.com/develop/api/sell/api_call_limits (вкладка Sell) | `4ea5ba65f57cae8ce8e13bf5855831958f061b94cbeb3bf2f35075e885c59e69` | `ca0731c68063c90966af02cb578d96be660b40def6ad47a451d45f22f19a8fa2` |
| `application-growth-check.html` | Страница «Application Growth Check» | https://developer.ebay.com/grow/application-growth-check | `058fae98ecbf567b2f2b2333407c06d97099741b29f3c91db1ac192ed0e232c8` | `1c7c6edf2b8c92dd2d47207100b0ea471ad9d37e4dda0f5674cf864c4d14cd3e` |
| `authorization.html` | Руководство «Authorization» | https://developer.ebay.com/develop/guides/sell/authorization | `f1e451bc3a693e0b9e91bdd1b47d38b57b91b86ec9218547cffb33c5b585aab3` | `21bfdd1009ed31de8d14d9d099903e59f9c937a9cdb0189388baf9b0f07ec899` |
| `marketplace-user-account-deletion.html` | Руководство «Marketplace User Account Deletion» | https://developer.ebay.com/develop/guides/sell/marketplace-user-account-deletion | `e68e1c202da2aab21b1632352882613a1bf79240d74f433306c7b95307ea6f91` | `94e029d2027937c0d3145b584f8cd22fbe97f1986488d0b8af643b1fa846a9eb` |

Адреса страниц взяты из самих файлов (поле `pathname` данных страницы); ссылки `<link rel="canonical">` в сохранённых
страницах нет.

## Обезличивание HTML [Р-148, Р-177]

Страницы сохранены из браузера с выполненным входом, поэтому отличаются от сохранённых оригиналов (суммы оригиналов — в
последнем столбце таблицы; сами оригиналы в репозиторий не попали):

- имя аккаунта разработчика — 5 раз в каждой из четырёх страниц (приветствие «Hi …» и данные страницы `userName`,
  `headername`) — заменено на `developer-account`;
- 6 ПРИМЕРОВ токенов из текста руководства «Authorization» (формы `v^1.1#i^1#…`, сокращённые многоточием в самой
  документации) заменены на `v^1.1#i^1#syn-doc-example`: иначе правило «строк формы токена без `syn-` в репозитории
  нет» [Р-177] не отличило бы пример документации от утёкшего токена.

Ключей, токенов, адресов почты, cookies и путей машины в файлах нет (проверено поиском; совпадения «SessionID» — текст
документации об Auth'n'Auth). Спецификации JSON не изменялись.

## Проверка по содержимому

- **`authorization.html` — не отдельная страница OAuth scopes, а общее руководство «Authorization»**: обзор OAuth и
  Auth'n'Auth, раздел **«Working with OAuth scopes»** (что такое scope и как получить список scope СВОЕГО приложения —
  на странице Application Keys портала), получение токенов (client credentials, authorization code grant, refresh),
  introspection и revocation. **Перечня scope eBay на ней нет**: `sell.fulfillment`, `commerce.identity` не встречаются;
  scope операций берутся из `security` спецификаций снимка.
- **Growth Check сохранён отдельной страницей** (`application-growth-check.html`): проверка бесплатна и обязательна,
  чтобы «increase the API call limits» и «use restricted APIs in production». Требования самой проверки — в разделе
  «Request an Application Growth Check» руководства Get Started, которого в снимке нет.
- Страница лимитов сохранена на вкладке **Sell**: лимитов Buy API (в том числе Browse) в снимке нет, есть только сноска
  «Buy APIs require an additional license».

## Чего в снимке нет

Спецификаций Fulfillment API (заказы, E-20), Browse API (подтверждение цены, E-13) и документации Trading API
(GetMyeBaySelling, GetItem — E-19). Сверка ячеек с песочницей — [docs/channel-capabilities.md](../../docs/channel-capabilities.md)
(§1, §2, §9) и [docs/evidence/step48-ebay-snapshot.md](../../docs/evidence/step48-ebay-snapshot.md).
