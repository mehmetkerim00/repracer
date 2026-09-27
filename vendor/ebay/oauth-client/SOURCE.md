# eBay OAuth — официальный клиент eBay (первоисточник вместо закрытой документации)

Шаг 43 [Р-175]. Документация eBay отвечает 403 (как на шаге 20, `vendor/ebay/sell-inventory-api/NOT-SNAPSHOTTED.md`),
поэтому факты OAuth взяты из ОФИЦИАЛЬНОГО клиента eBay на GitHub, закреплённого коммитом — так же, как модели SP-API
берутся из официального репозитория Amazon.

| Поле | Значение |
|---|---|
| Источник | https://github.com/eBay/ebay-oauth-nodejs-client (организация eBay) |
| Коммит | `28215678741221a3238de984d2cde524c70da904` (2022-09-13, ветка `master`) |
| Скачано | 2026-09-26, `raw.githubusercontent.com/eBay/ebay-oauth-nodejs-client/<коммит>/<путь>` |
| Лицензия | Apache 2.0 (`LICENSE` в каталоге коммита) |
| Контрольные суммы | `28215678741221a3238de984d2cde524c70da904/SHA256SUMS` |

Файлы не редактируются.

## Факты (из `src/constants.js` и `src/index.js`)

- Страница согласия: `https://auth.ebay.com/oauth2/authorize` (песочница — `https://auth.sandbox.ebay.com/oauth2/authorize`),
  параметры `client_id`, `redirect_uri`, `response_type=code`, `scope` (через пробел), необязательные `prompt` и `state`.
- Обмен кода и refresh: `https://api.ebay.com/identity/v1/oauth2/token` (песочница —
  `https://api.sandbox.ebay.com/identity/v1/oauth2/token`), заголовок `Authorization: Basic base64(client_id:client_secret)`,
  тело `application/x-www-form-urlencoded`: `grant_type=authorization_code&code&redirect_uri` или
  `grant_type=refresh_token&refresh_token&scope`.

## Чего клиент не говорит (вопросы E-08…E-10 в channel-capabilities.md)

- E-08: scope Inventory API (в клиенте есть только scope приложения `https://api.ebay.com/oauth/api_scope`) —
  значение задаётся конфигурацией и проверяется первым живым потоком шага 39.
- E-09: ответ обмена refresh-токена после отзыва согласия продавцом.
- E-10: срок жизни refresh-токена пользователя и то, как он приходит в ответе.
