# ZITADEL — страницы документации входа (шаг 45, OQ-238)

Снимка спецификации нет: вход у поставщика идёт по OIDC, и опираемся мы только на страницы ниже. Текст не копируется в код;
HTML страниц лежит в `2026-09-27/` с суммами в `2026-09-27/SHA256SUMS` (проверка: `cd vendor/zitadel/2026-09-27 && shasum -a 256 -c SHA256SUMS`).
Загружено 2026-09-27 (`curl -L`, ответ 200); версия документации на страницах — v4.19 (Latest).

| Файл | Страница | Что взято | SHA-256 |
|---|---|---|---|
| `claims.html` | https://zitadel.com/docs/apis/openidoauth/claims | матрица «где какое утверждение»: `amr` — **только ID-токен** (Userinfo — No, Introspection — No, Access Token — No); `email` и `email_verified` — Userinfo «When requested», ID-токен — только «When requested and response_type id_token», токен доступа — **No**; `aud`, `exp`, `iss`, `sub` в токене доступа — «When JWT» | `dea5a4e93aa9b0aa62d10fd3d95351f0cc9941f9f1a25aabe1ae446c3a228f42` |
| `endpoints.html` | https://zitadel.com/docs/apis/openidoauth/endpoints | «whenever an access_token is issued, the id_token will not contain any claims of the scopes profile, email, phone and address» — их получают отправкой токена доступа в `userinfo_endpoint` (`${CUSTOM_DOMAIN}/oidc/v1/userinfo`, `Authorization: Bearer <access_token пользователя>`) или включением `id_token_userinfo_assertion`; ответ на обмен кода несёт `access_token` («as JWT or opaque token») и `id_token`; для метода `none (PKCE)` — `code_challenge` (SHA-256 от `code_verifier`) и `code_challenge_method`, который «must be S256»; introspection, в отличие от проверки JWT на стороне клиента, видит отзыв токена | `63e91c77a7a970ca6f26db7c49ae7dda2dcd1ffe1d801a8262ba717a20962c88` |
| `login-users.html` | https://zitadel.com/docs/guides/integrate/login/oidc/login-users | тип приложения «User Agent» — SPA в браузере; PKCE рекомендован для всех типов; обмен кода — `POST ${CUSTOM_DOMAIN}/oauth/v2/token` с `client_id` и `code_verifier` | `069e8fa5a0f6772bf31286e9ef806c1607523030ffa5c480656310858380a465` |
| `scopes.html` | https://zitadel.com/docs/apis/openidoauth/scopes | `openid` обязателен; `email` — «Optional scope to request the email of the subject»; `urn:zitadel:iam:org:project:id:{projectid}:aud` добавляет проект в аудиторию | `6415b53feecca0f434aded7d0c9116ad89b93729aab27621202900fe0097414e` |

## Что из этого следует для кода (решение OQ-238)

1. **Адрес и его подтверждение для приёма приглашения — из userinfo** по токену доступа (`remoteUserinfo`,
   `packages/identity/src/index.ts`); scope консоли содержит `email`. На необязательную настройку
   `id_token_userinfo_assertion` мы не опираемся: без неё адреса нет ни в одном токене.
2. **Второй фактор — из ID-токена**: `amr` есть только в нём. Страница передаёт ID-токен заголовком
   `x-repracer-id-token`; сервер проверяет подпись, издателя и срок, аудиторию — клиент страницы, и совпадение `sub` с
   токеном доступа. Так у консоли и у панели оператора [Р-183].
3. **Токен доступа приложения — JWT.** Сервер проверяет его подписью по JWKS; «opaque» токен не проверится, и вход
   откажет всем (fail-closed, не молча). Тип токена — настройка приложения в ZITADEL; как она называется в консоли
   ZITADEL, эти страницы не говорят — (проверить) при заведении приложения.
4. Отзыв токена локальная проверка не видит (это видит только introspection) — принятое ограничение: срок токена
   доступа короткий, роль и членство читаются из базы при каждом запросе.

Не проверено (нет аккаунта ZITADEL): настоящие значения `amr` у ZITADEL при входе с OTP и passkey (OQ-141) и то, что
userinfo отдаёт `email_verified: true` для подтверждённого адреса. Модель поставщика прогонов
(`packages/identity/src/test-provider.ts`) повторяет матрицу утверждений снимка: в токене доступа нет ни `amr`, ни адреса.
