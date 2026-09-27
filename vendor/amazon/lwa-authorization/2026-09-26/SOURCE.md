# Amazon SP-API — авторизация приложения продавцом (OAuth, LWA): страницы документации

Шаг 43 [Р-175, Р-177]. Текст страниц не копируется — для каждой адрес Markdown-версии (документация отдаёт её по
суффиксу `.md`), поле `updatedAt` и SHA-256 загруженного текста, чтобы изменение страницы было видно при сверке.
Загружено 2026-09-26.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/website-authorization-workflow.md | 2026-09-09T23:45:40Z | `bf5ec2f645e963b0d3a03bfc457e4fd1623f3f64ff498ee1c390bcf01c13c713` |
| https://developer-docs.amazon/sp-api/docs/authorizing-selling-partner-api-applications.md | 2026-09-09T23:45:55Z | `f46ccf6f61083981182f8106e220c0fc156d9dc9a58cb3087261a2f1dede277e` |
| https://developer-docs.amazon/sp-api/docs/revoke-authorizations.md | 2026-09-09T23:45:30Z | `91afc33a79832835b8297bb179fa59966500d1e5f09582b6332691b01517a441` |
| https://developer-docs.amazon/sp-api/docs/seller-central-urls.md | 2026-09-09T23:44:51Z | `78084a57e44be30c699cb8eaf5d0dfcdc6b6f5bb6449ee71b1951adc664191f1` |
| https://developer-docs.amazon/sp-api/docs/application-authorization-limits.md | 2026-09-09T23:45:24Z | `56bc6c03a40e6796d3f08a0ae043b5f06658e5f41b80a7f8150074e86339dabb` |
| https://developer.amazon.com/docs/login-with-amazon/authorization-code-grant.html (HTML, коды ошибок LWA) | — | `3ef8f88ae6ca2725067b9324ede576ebba4cbd25b64a754c363eb69ad0dfd473` |

## Факты, которые взяты со страниц (и только они)

- **Согласие:** адрес Seller Central витрины продавца + `/apps/authorize/consent` с параметрами `application_id`, `state`
  и `version=beta` для приложения в состоянии Draft. Адрес Seller Central — по витрине: Германия, Франция, Италия,
  Испания, Великобритания — `https://sellercentral-europe.amazon.com`, США — `https://sellercentral.amazon.com`.
- **Ответ согласия** приходит на `redirect_uri` с параметрами `state`, `selling_partner_id`, `spapi_oauth_code`.
- **Код живёт пять минут**; весь поток дольше десяти минут может сломаться, и продавцу надо начать заново.
- **Обмен кода:** `POST https://api.amazon.com/auth/o2/token`, форма `grant_type=authorization_code`, `code`,
  `redirect_uri` (совпадает с зарегистрированным), `client_id`, `client_secret`. Ответ: `access_token`,
  `token_type=bearer`, `expires_in` (обычно 3600), `refresh_token`.
- **Хранение:** refresh-токен — в зашифрованной базе, не в коде клиента, не в журналах, не в адресах; доступ только
  нужным частям приложения; процесс ротации и отзыва; раз в год просить продавца авторизовать заново.
- **Отзыв:** OAuth-авторизацию отзывает ТОЛЬКО продавец — Seller Central → Apps and Services → Manage Your Apps →
  Disable authorization. Уведомления приложению об отзыве страницы НЕ описывают.
- **Ошибки токена LWA:** `invalid_grant` — «код авторизации недействителен, истёк, ОТОЗВАН или выдан другому
  `client_id`»; `invalid_client` — ошибка аутентификации клиента; `unauthorized_client`, `unsupported_grant_type`,
  `ServerError`. Страница описывает эти коды для обмена КОДА; что отвечает обмен refresh-токена после отзыва — не
  сказано прямо (вопрос A-17).
- **Предел авторизаций** у публичного приложения, не выставленного в Appstore, — 25 OAuth-авторизаций продавцов.

## Чего страницы не говорят (вопросы в channel-capabilities.md)

- A-17: ответ `refresh_token` после отзыва продавцом (ожидаем `invalid_grant`, консервативно — любой `invalid_grant`
  значит «нужна новая авторизация»).
- A-18: приходит ли приложению какое-либо уведомление об отзыве (страницы — нет; обнаружение — только обменом токена).
