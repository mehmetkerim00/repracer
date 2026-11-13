# Amazon SP-API — авторизация с сайта (website authorization workflow): повторная сверка

Шаг 122 (аудит авторизации Amazon, П6). Текст страницы не копируется — адрес Markdown-версии, поле `updatedAt` и SHA-256 загруженного текста. Загружено
2026-11-14. Снимок [2026-09-26](../2026-09-26/SOURCE.md) остаётся как есть; здесь — то, чего он не записал.

| Страница | updatedAt | SHA-256 |
|---|---|---|
| https://developer-docs.amazon/sp-api/docs/website-authorization-workflow.md | 2026-09-09T23:45:40Z | `9c6bbf156f1dccd3f191ea737b7d3ae6613f921ddd0a50ca8cc340ab674af09c` |

`updatedAt` тот же, что у снимка 2026-09-26, а сумма другая: по одному `updatedAt` не сказать, менялся ли текст. Поэтому шаг сверен с архивными копиями той же
страницы (HTML, Wayback Machine): 2025-06-16 (`web.archive.org/web/20250616071154/…/website-authorization-workflow`) и 2026-01-04
(`web.archive.org/web/20260104093659/…`) — в обеих тот же поток из 16 шагов с шагом log-in URI.

## Факты страницы, которых нет в снимке 2026-09-26

- **Поток с сайта — 16 шагов, и шаги 5–8 идут через log-in URI приложения.** После согласия в Seller Central Amazon вызывает **log-in URI** (указан при
  регистрации приложения) с параметрами `amazon_callback_uri`, `amazon_state`, `selling_partner_id` и, у черновика, `version=beta`. Продавец входит на сайте
  приложения, приложение проверяет запрос, создаёт `state` и отправляет продавца на `amazon_callback_uri` с параметрами `amazon_state`, `state`, необязательным
  `redirect_uri` и, у черновика, `version=beta`. Только после этого Amazon отправляет на redirect URI `state`, `selling_partner_id`, `spapi_oauth_code`.
- **Адрес согласия** (authorization URI): `application_id`, `state`, у черновика `version=beta`. Параметра `redirect_uri` у него нет.
- **`redirect_uri`** — параметр перехода на `amazon_callback_uri` (шаг 8): «Must match a URI you specified when you registered your application. If omitted,
  Amazon uses the first registered redirect URI».
- **Заголовок** `Referrer-Policy: no-referrer` — у консоли он есть (`apps/console/server/stand-server.ts`, `deploy/production/snippets.caddy`).
- **Черновик:** «If you test without `version=beta`, you are authorizing the published version of your application»; к публикации — «List your application in the
  Selling Partner Appstore, which changes its state from Draft to Published» и убрать `version=beta`.

## Что это значит для продукта (шаг 43, Р-175)

Поток подключения шага 43 строит адрес согласия и ждёт код сразу на redirect URI — шагов 5–8 в нём нет, и модель поставщика LWA в прогонах их тоже не делает.
Доклад владельцу — [docs/evidence/step122-small-fixes.md](../../../../docs/evidence/step122-small-fixes.md), раздел «П6».
