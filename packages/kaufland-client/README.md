# @repracer/kaufland-client

Типизированный клиент Kaufland Marketplace Seller API v2. **Только** сгенерированные типы и тонкий транспорт:
адрес, заголовки, подпись, тайм-аут, повторы. Никакой доменной логики, тенантов, классов ошибок домена.

| Файл | Что это |
|---|---|
| `src/generated/schema.ts` | Сгенерировано `openapi-typescript` из `vendor/kaufland/seller-api-v2/2026-09-14/openapi.json` (2.44.0, SHA-256 в `package.json`). Не редактировать |
| `src/signing.ts` | HMAC-SHA256 `METHOD\nURI\nBODY\nTIMESTAMP`, hex; проверка подписи уведомлений с явными параметрами |
| `src/signing.selftest.ts` | Тестовый вектор из документации |
| `src/transport.ts` | `createKauflandClient()` и типизированный `request(method, path, { path, query, body })` |
| `src/types.check.ts` | Проверка контракта типов при компиляции |

## Команды

```sh
npm run verify-spec -w @repracer/kaufland-client   # контрольная сумма снимка спецификации
npm run generate    -w @repracer/kaufland-client   # перегенерировать типы
npm run typecheck   -w @repracer/kaufland-client
node --experimental-strip-types packages/kaufland-client/src/signing.selftest.ts
```

## Поведение транспорта

- Заголовки: `Accept`, `Shop-Client-Key`, `Shop-Timestamp` (секунды), `Shop-Signature`, `User-Agent`; для технологического партнёра —
  `Shop-Partner-Client-Key`, `Shop-Partner-Signature`. Подпись считается по тому же URI с query-строкой и тому же телу, что отправляются.
- Повторы: 429 — всегда; 500/502/503/504, тайм-аут и обрыв — только для идемпотентных запросов
  (GET, PUT, PATCH, DELETE; POST — только с `idempotent: true`). Экспоненциальная задержка с полным джиттером.
- Результат — `{ ok: true, data }` или `{ ok: false, status, problem, outcomeUnknown }` плюс список всех попыток:
  классификацию ошибок в термины домена делает адаптер (`@repracer/channel-port`).

## Открытые вопросы, влияющие на пакет

K-01 (кодировка подписи), K-02 (подпись уведомлений), K-14 (идемпотентность повтора) — [docs/channel-capabilities.md §7](../../docs/channel-capabilities.md).
