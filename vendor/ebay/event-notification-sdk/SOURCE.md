# eBay Event Notification SDK (Node.js) — первоисточник проверки подписи уведомлений (шаг 49, Р-192)

Страница Marketplace User Account Deletion снимка [`../2026-09-28/`](../2026-09-28/) описывает проверку подлинности уведомления
в три шага и отсылает за деталями к Notification API, которой в снимке нет. Эта же страница называет официальные SDK
eBay; детали взяты из SDK для Node.js, закреплённого коммитом, — так же, как OAuth в [`../oauth-client/`](../oauth-client/).

| Поле | Значение |
|---|---|
| Источник | https://github.com/eBay/event-notification-nodejs-sdk (организация eBay; ссылку даёт страница снимка) |
| Коммит | `feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3` (2023-06-15, последний на ветке по умолчанию) |
| Скачано | 2026-09-28, `raw.githubusercontent.com/eBay/event-notification-nodejs-sdk/<коммит>/<путь>`, каждый файл — 200 |
| Лицензия | Apache 2.0 (`LICENSE.md` в каталоге коммита) |
| Контрольные суммы | `feaf3378ca263a81432cf5b8c8a6fd8cb3d3e2f3/SHA256SUMS` |

Файлы не редактируются. Кода SDK приёмник не использует и зависимостей его (axios, lru-cache) не тянет: он повторяет
проверку встроенным `node:crypto`.

## Факты (из `lib/validator.js`, `lib/constants.js`, `lib/client.js`, `lib/index.js`)

- Заголовок `x-ebay-signature` — base64 от JSON `{alg, kid, signature, digest}`.
- Открытый ключ — `GET https://api.ebay.com/commerce/notification/v1/public_key/<kid>` (песочница —
  `https://api.sandbox.ebay.com/…`), `Authorization: bearer <токен приложения>`; ответ `{key, algorithm, digest}`, `key` —
  PEM без переводов строк; SDK кэширует ключ по `kid`.
- Проверка — `crypto.createVerify('ssl3-sha1')` над `JSON.stringify(message)` разобранного тела, подпись в base64
  (в Node 22 то же самое — ECDSA с SHA-1, `createVerify('sha1')`).
- Итоги SDK: подпись верна — 204; неверна — 412; сбой (ключ не получен и т. п.) — 500.
- Ответ на challenge — SHA-256 от `challengeCode + verificationToken + endpoint`, hex (так же на странице снимка).

## Проверено

Тестовые векторы SDK (`test/test.json`: сообщение, подпись, ответ Notification API с ключом) проходят проверкой приёмника
(`services/ebay-account-deletion/test/verify.test.ts`): VALID — подлинное, INVALID и SIGNATURE_MISMATCH — нет.
