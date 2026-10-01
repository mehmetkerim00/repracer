# Шаг 52: самопроверка по OWASP Top Ten

Приложение к анкете eBay Application Growth Check (пункт «follows OWASP secure coding practices … Top Ten»,
[docs/evidence/step50-growth-check.md](step50-growth-check.md)).

- **Редакция:** OWASP Top 10 — **2021** (A01…A10).
- **Дата:** 2026-09-29, ветка `step51` (коммит `0aee705`).
- **Метод:** чтение кода, миграций, тестов, развёртываний и уже записанных решений (CLAUDE.md, [decisions](../decisions.md),
  [accepted-risks](../accepted-risks.md), [open-questions](../open-questions.md), [ADR](../adr/)). Ничего не запускалось, сеть не
  использовалась, базы не менялись. Внешнего сканирования (DAST, pentest) не было — это самооценка, а не аудит.
- **Оценки:** «соответствует» — механизм есть и проверяется тестом или правилом; «частично» — механизм есть, но есть названный
  пробел; «слабое место» — механизма нет. Где подтверждения в коде не нашлось, так и написано: «не найдено».

---

## A01:2021 — Broken Access Control

**Что есть**

- Изоляция тенантов в БД: общая схема, `tenant_id NOT NULL` в каждой таблице, RLS `ENABLE` + `FORCE`, составные FK,
  роли без `BYPASSRLS` ([ADR-0003](../adr/0003-tenant-isolation.md), [0001_foundation.sql](../../migrations/0001_foundation.sql)).
  Последняя проверка схемы проверяет это для всех таблиц и отсутствие `BYPASSRLS` у ролей
  ([0172_verify_schema_invariants_v44.sql](../../migrations/0172_verify_schema_invariants_v44.sql)).
- Роли подключения разделены [Р-90, Р-96]: у пути решения нет прав на аудит, членства, тенантов, остановки человеком;
  права — списком разрешённого и по столбцам [Р-100] ([0058_role_separation.sql](../../migrations/0058_role_separation.sql),
  [0062_decision_path_allow_list.sql](../../migrations/0062_decision_path_allow_list.sql)).
- Роль пользователя читается из `Membership` при каждом запросе, тенант — по членству, а не из параметра
  ([packages/identity/src/index.ts](../../packages/identity/src/index.ts)); мир чужого тенанта по прямому адресу — 404
  ([apps/console/test/pilot-live.pg.test.ts](../../apps/console/test/pilot-live.pg.test.ts)).
- Второй фактор для опасных операций (снятие остановки тенанта, смена роли, массовые правки, перевод канала в бой) проверяет
  **база**, а не только консоль [Р-88, Р-135, Р-143, Р-170].
- Гость публичного демо — наблюдатель демо-тенанта; его границы (только демо, без повышения роли, без заданий) держит база
  ([0124_guest_demo_access_tenant_locale.sql](../../migrations/0124_guest_demo_access_tenant_locale.sql),
  [tests/db/smoke_guest.sql](../../tests/db/smoke_guest.sql)); остановка цен, правка границ и смена режима отвечают гостю 403
  ([apps/console/test/guest-demo-live.pg.test.ts](../../apps/console/test/guest-demo-live.pg.test.ts)).
- Панель оператора — отдельный процесс, роль подключения только с `EXECUTE` на функции панели, без прав на таблицы
  ([0126_operator_panel.sql](../../migrations/0126_operator_panel.sql), [ADR-0037](../adr/0037-operator-panel.md));
  отказы `permission denied` на себестоимость, границы и цены проверены прогоном
  ([apps/operator/test/operator-live.pg.test.ts](../../apps/operator/test/operator-live.pg.test.ts)).
- Токен канала одного аккаунта не открывается в строке другого (AAD = тенант + аккаунт), ссылка `db:` — только на свой аккаунт
  ([packages/channel-oauth/src/vault.ts](../../packages/channel-oauth/src/vault.ts),
  [0132_channel_oauth_credentials.sql](../../migrations/0132_channel_oauth_credentials.sql)).
- Отдача статики: выход за каталог сборки невозможен и после разыменования символических ссылок (шаг 38)
  ([apps/console/server/static.ts](../../apps/console/server/static.ts), [apps/console/test/static.test.ts](../../apps/console/test/static.test.ts),
  [step38-tails.md](step38-tails.md)).
- Защиты доступа закреплены мутационной проверкой: снятая защита должна уронить свою проверку [Р-95, Р-99]
  ([tests/db/mutations.mjs](../../tests/db/mutations.mjs)); ролевые тесты — [role-separation.pg.test.ts](../../packages/pricing-store-pg/test/role-separation.pg.test.ts),
  RLS между тенантами — [store.pg.test.ts](../../packages/pricing-store-pg/test/store.pg.test.ts).
- CSRF: вход — заголовком `Authorization: Bearer`, а не cookie; единственный cookie — язык интерфейса (`SameSite=Strict`)
  ([apps/console/server/stand-server.ts](../../apps/console/server/stand-server.ts)). Заголовков CORS сервер не выдаёт — чужой
  источник ответ не прочтёт.

**Известные пределы:** суперпользователь БД обходит всё (риск 11), компрометация административного сервиса = компрометация его
тенантов (риск 3) — [accepted-risks](../accepted-risks.md). Доступ к панели оператора ограничивает конфигурация сервера (порт на
`127.0.0.1`, SSH-туннель), а не репозиторий — OQ-227.

**Оценка: соответствует** (с названным пробелом OQ-227 — см. слабое место 7).

---

## A02:2021 — Cryptographic Failures

**Что есть**

- TLS заканчивается на Caddy с сертификатами Let's Encrypt; приложения слушают только сеть compose и `127.0.0.1`
  ([deploy/production/Caddyfile](../../deploy/production/Caddyfile), [deploy/production/compose.yaml](../../deploy/production/compose.yaml)).
- Refresh-токены каналов — AES-256-GCM, 12-байтный IV на каждое шифрование, метка подлинности, AAD, кольцо ключей файлом со
  сменой ключа без перешифровки; ключ в ошибки не попадает [Р-177]
  ([vault.ts](../../packages/channel-oauth/src/vault.ts), тест подмены и чужого аккаунта —
  [packages/channel-oauth/test/oauth.test.ts](../../packages/channel-oauth/test/oauth.test.ts)). Шифротекст читает только роль адаптеров.
- `state` OAuth — 32 случайных байта, в базе только SHA-256; ключ Inbound API — 192 бита случайности, в базе префикс и SHA-256.
- Паролей у нас нет [Р-78]: хранения и хэширования паролей не существует.
- Подписи токенов входа — только RS256 (≥ 2048 бит) и ES256; `none` и HMAC отклоняются
  ([packages/identity/src/oidc.ts](../../packages/identity/src/oidc.ts), [identity.test.ts](../../packages/identity/src/identity.test.ts)).
- HMAC Kaufland сравнивается `timingSafeEqual` ([signing.ts](../../packages/kaufland-client/src/signing.ts)); подпись уведомлений eBay —
  по официальному SDK, закреплённому коммитом ([vendor/ebay/event-notification-sdk/SOURCE.md](../../vendor/ebay/event-notification-sdk/SOURCE.md)).
- `md5` встречается один раз — сверка `MD5OfBody` протокола SQS (целостность ответа по протоколу, не защита)
  ([packages/amazon-notifications/src/sqs.ts](../../packages/amazon-notifications/src/sqs.ts)); `Math.random` — только разброс пауз повтора.

**Пробелы**

- Заголовка HSTS нет ни у лендинга, ни у консоли ([snippets.caddy](../../deploy/production/snippets.caddy)); Caddy по умолчанию
  перенаправляет HTTP на HTTPS, но HSTS сам не ставит.
- Суточная копия PostgreSQL пишется `pg_dump` **без шифрования** в каталог на той же машине
  ([deploy/production/backup-loop.sh](../../deploy/production/backup-loop.sh)); токены каналов в ней зашифрованы, прочие данные
  тенантов — нет. Вынос копии за пределы машины — не найдено.

**Оценка: частично** (слабые места 2 и 6).

---

## A03:2021 — Injection

**Что есть**

- SQL — параметризованные запросы `pg` (`$1…$n`). Интерполяция в тексте запроса встречается только для констант кода (списки
  столбцов, фиксированные статусы) и в одном месте для значений — `worldSummaries`, где идентификаторы тенантов предварительно
  проверяются регулярным выражением UUID, а время — разбором даты
  ([packages/pricing-store-pg/src/store.ts](../../packages/pricing-store-pg/src/store.ts)).
- `SECURITY DEFINER` — с фиксированным `search_path`; это проверяет правило схемы ([0143](../../migrations/0172_verify_schema_invariants_v44.sql)).
- XSS: консоль — React, `dangerouslySetInnerHTML` в коде нет; панель оператора пишет значения через `textContent`
  ([apps/operator/server/page.ts](../../apps/operator/server/page.ts)).
- Имя файла выгрузки очищается до `[\w.\-]` в `Content-Disposition` ([stand-server.ts](../../apps/console/server/stand-server.ts)).
- Разбор файлов продавца (CSV, XLSX) — свой, с пределами распаковки ZIP (книга 306 КБ → 300 МБ отклоняется, шаг 28)
  ([packages/cost-import](../../packages/cost-import/)).
- ClickHouse: изоляция — только через слой, подставляющий `tenant_id` [Р-23]; из пути решения ClickHouse не читается [Р-22].

**Оценка: соответствует.** Отдельного статического анализатора (SAST) в CI — не найдено (см. A06, предложение).

---

## A04:2021 — Insecure Design

**Что есть**

- Инварианты выражены в БД, а не только в коде: обе границы цены проверяются в Price Gate, при вставке решения, при создании
  записи и **перед каждой отправкой** [Р-43, Р-44, Р-83]; три вида остановки [Р-69, Р-118]; теневой режим по умолчанию — новый
  аккаунт не пишет в канал, пока владелец со вторым фактором не переведёт его в бой [Р-169, Р-170]
  ([0128_shadow_mode.sql](../../migrations/0128_shadow_mode.sql), [ADR-0038](../adr/0038-shadow-mode.md)).
- Fail-closed для неподтверждённого поведения каналов (консервативные правила с кодами вопросов) — инвариант 6 CLAUDE.md.
- Необратимая миграция eBay — только по согласию владельца после предполётного чекера [Р-2, Р-101, Р-164].
- Разбор угроз фиксируется решениями и ADR; найденное ревью закрывается правилом [Р-146]; незакрытое — в реестре принятых рисков
  ([accepted-risks](../accepted-risks.md), пересмотр — [step33-risk-review.md](step33-risk-review.md)).
- Пределы, названные явно: тело запроса 64 КиБ (48 МиБ — только предъявившему вход на путях импорта), страница экрана ≤ 10 с и
  8 МБ, очередь заданий у тенанта и участника (OQ-207), выдача гостей демо — окно в минуту.

**Пробел:** общего ограничения частоты запросов к API консоли и Inbound API (на тенанта, ключ или адрес) — не найдено.
Предел гостей демо — один скользящий счётчик на процесс, не на клиента: один клиент может исчерпать демо для всех.

**Оценка: соответствует** в части логики продукта; ограничение частоты — слабое место 8.

---

## A05:2021 — Security Misconfiguration

**Что есть**

- Промышленный профиль не стартует без настоящего поставщика identity; имитатор и локальный издатель отклоняются при старте
  [Р-180, Р-183] ([apps/console/server/config.ts](../../apps/console/server/config.ts), [apps/console/test/config.test.ts](../../apps/console/test/config.test.ts)).
- Секреты — только файлами; значение в переменной окружения принимается лишь в режиме стенда
  ([packages/service-runtime/src/env.ts](../../packages/service-runtime/src/env.ts)).
- Контейнеры — `user: 1000:1000`, `read_only: true`; порты процессов и метрик — только `127.0.0.1`; наружу — только 80/443 прокси
  ([deploy/console/compose.yaml](../../deploy/console/compose.yaml), [deploy/production/compose.yaml](../../deploy/production/compose.yaml)).
- Ошибки: клиенту — код и текст словаря, без стека; в журнал — метод, путь и сообщение, без тела и токена
  ([stand-server.ts](../../apps/console/server/stand-server.ts)). `Cache-Control: no-store` у всех ответов API.
- Лендинг: CSP `default-src 'none'`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  без заголовка `Server`; не опубликован без явного `REPRACER_LANDING_PUBLIC=on`
  ([snippets.caddy](../../deploy/production/snippets.caddy), [scripts/landing-check.mjs](../../scripts/landing-check.mjs)).
- Конфигурации развёртываний разбираются в CI и поднимаются целиком в полном прогоне
  ([scripts/deploy-config-check.mjs](../../scripts/deploy-config-check.mjs), [scripts/deploy-smoke.sh](../../scripts/deploy-smoke.sh)).

**Пробел:** у **консоли** заголовков безопасности нет ни в Node-сервере, ни в фрагменте `(console)` прокси: нет CSP, нет
`frame-ancestors` / `X-Frame-Options` (кликджекинг), нет `nosniff`, нет `Referrer-Policy`, нет HSTS. Панель оператора их тоже
не ставит, но она доступна только через loopback.

**Оценка: частично** (слабое место 2).

---

## A06:2021 — Vulnerable and Outdated Components

**Что есть**

- Зависимостей мало и все закреплены точной версией: во время выполнения — `pg` 8.23.0, `@confluentinc/kafka-javascript` 1.10.1,
  `react`/`react-dom` 19.3.0; разработка — `typescript`, `vite`, `openapi-typescript`, `@types/*`
  ([package.json](../../package.json), [package-lock.json](../../package-lock.json)); установка в CI — `npm ci` по lock-файлу с
  контрольными суммами. Правило «зависимости не устанавливаем, пока шаг не требует» — CLAUDE.md.
- Образы Docker закреплены тегом версии (`node:22.22.3-bookworm-slim`, `caddy:2.10.2-alpine`, `postgres:16.10-bookworm`).

**Чего нет**

- **Аудита зависимостей в CI нет**: ни `npm audit`, ни OSV-Scanner, ни Dependabot/Renovate — в
  [.github/workflows/ci.yml](../../.github/workflows/ci.yml) и в репозитории не найдено.
- Процесса обновления образов и Node — не найдено; закрепление образов по digest отложено с пометкой «(проверить)» в compose.

**Оценка: слабое место** (слабое место 1).

---

## A07:2021 — Identification and Authentication Failures

**Что есть**

- Вход, MFA, сброс пароля, приглашения — у внешнего поставщика (ZITADEL, [ADR-0013](../adr/0013-external-identity-provider.md));
  паролей и серверных сессий у нас нет [Р-78]. Поэтому **своего ограничения частоты попыток входа нет** — перебор паролей
  ограничивает поставщик.
- Проверка токена: подпись (RS256/ES256), издатель, аудитория, `exp`/`nbf`, `kid`; неизвестный `kid` перечитывает JWKS не чаще
  заданного окна, поток поддельных `kid` не становится потоком запросов к поставщику
  ([oidc.ts](../../packages/identity/src/oidc.ts), [jwks.test.ts](../../packages/identity/src/jwks.test.ts)).
- ID-токен как Bearer не принимается; второй фактор берётся из ID-токена того же обмена кода (тот же `sub`, издатель,
  `iat` в пределах 10 с) [Р-183] ([index.ts](../../packages/identity/src/index.ts)).
- Страница входит кодом с PKCE; токен живёт только в памяти страницы, не в `localStorage` и не в cookie
  ([apps/console/src/oidc.ts](../../apps/console/src/oidc.ts), [apps/console/src/api.ts](../../apps/console/src/api.ts)).
- Привязка входа — только приёмом приглашения, адрес подтверждён поставщиком и сверяется базой; перепривязка — новым
  приглашением владельца [Р-88, Р-98].
- Гость демо: выдача не чаще предела в минуту, ответ 429 `DEMO_BUSY`
  ([apps/console/server/console-service.ts](../../apps/console/server/console-service.ts)).
- Ключ Inbound API — 192 бита, сравнение по SHA-256 в базе; перебор невозможен практически.
- Панель оператора: вход у поставщика, второй фактор на каждое действие, отказывает база
  ([apps/operator/server/panel.ts](../../apps/operator/server/panel.ts)).

**Пробел:** подключение к настоящему ZITADEL не прогонялось — утверждения токенов сверены по снимку документации
([vendor/zitadel/SOURCE.md](../../vendor/zitadel/SOURCE.md)) и модели поставщика, а не по настоящему токену (OQ-141).

**Оценка: частично** (слабое место 5).

---

## A08:2021 — Software and Data Integrity Failures

**Что есть**

- `npm ci` по lock-файлу; правило репозитория: каждое рабочее пространство записано в `package-lock.json`
  ([scripts/test/repo-rules.test.ts](../../scripts/test/repo-rules.test.ts)).
- Снимки спецификаций каналов и сторонний код — с SHA-256 или коммитом ([vendor/](../../vendor/)); сгенерированный код
  перегенерируется только из снимка с проверкой SHA-256.
- Миграция из `main` задним числом не меняется — правило репозитория.
- Входящие данные проверяются подписью: вебхук Kaufland (HMAC, подпись проверяется всегда [Р-40]), уведомления eBay Account
  Deletion (подпись ECDSA по SDK eBay, подделка — 412) ([services/ebay-account-deletion/src/verify.ts](../../services/ebay-account-deletion/src/verify.ts),
  [verify.test.ts](../../services/ebay-account-deletion/test/verify.test.ts)).
- Уведомления Amazon из SQS подписи не несут — доверие основано на SigV4-доступе к своей очереди, дедупликации и сверке опросом
  [Р-121] (риск 21, [accepted-risks](../accepted-risks.md)).
- Неизменяемые (append-only) таблицы и аудит — триггерами в базе ([0011_audit.sql](../../migrations/0011_audit.sql)).

**Пробелы:** действия GitHub закреплены тегом (`actions/checkout@v4`), а не SHA; блока `permissions:` в workflow нет — права
`GITHUB_TOKEN` берутся по умолчанию репозитория ([ci.yml](../../.github/workflows/ci.yml)). Образы — по тегу, не по digest.

**Оценка: частично** (слабое место 3).

---

## A09:2021 — Security Logging and Monitoring Failures

**Что есть**

- Журнал действий `audit.audit_event`: административные записи, остановки цен, смена ролей, переключение режима канала, действия
  оператора — триггерами в базе, append-only, 18 месяцев (≥ 12 по DPP Amazon)
  ([0011_audit.sql](../../migrations/0011_audit.sql), [0012_retention.sql](../../migrations/0012_retention.sql),
  [0066](../../migrations/0066_admin_person_audit_relink_explanation_values.sql), [data-retention](../data-retention.md)).
- Алерты — строки `tenant_data.alert` с отметкой доставки: CRITICAL письмом сразу, WARNING часовым дайджестом [Р-156]
  ([0120_alert_delivery.sql](../../migrations/0120_alert_delivery.sql), [packages/alert-delivery](../../packages/alert-delivery/)).
- Журналы процессов — JSON, секреты маскируются вторым слоем ([redact.ts](../../packages/channel-oauth/src/redact.ts),
  [runtime.ts](../../packages/service-runtime/src/runtime.ts)); прокси не пишет тела, `Authorization`, cookie, ID-токен и код
  согласия OAuth ([snippets.caddy](../../deploy/production/snippets.caddy)). Правила репозитория: нет токенов каналов и нет путей
  машины разработчика [Р-148, Р-177] ([repo-rules.test.ts](../../scripts/test/repo-rules.test.ts)).
- Внешний контроль [Р-127]: каждый процесс отмечается во внешнем сервисе, правило держит это для всех процессов
  ([heartbeat.ts](../../packages/service-runtime/src/heartbeat.ts), [scripts/setup-heartbeats.mjs](../../scripts/setup-heartbeats.mjs)).
- Панель оператора показывает просрочку работ, алерты и их доставку, очередь диспетчера [Р-168].

**Пробелы (названы честно)**

- **Внешняя отметка не проверена ни разу** (OQ-188, OQ-198): аккаунта сервиса нет; проверено, что процесс *отправляет* отметку,
  но не что её отсутствие кем-то замечается ([step33-heartbeat-live.md](step33-heartbeat-live.md)).
- **Письмо не отправлялось по-настоящему ни разу** (OQ-224): аккаунта почтового провайдера нет — алерт доходит до базы, но не до
  ящика.
- Журналы процессов и прокси — `json-file` с ротацией 50 МБ × 5 на контейнер; централизованного хранения со сроком ≥ 12 месяцев
  — не найдено (аудит в базе срок держит, журналы процессов — нет).
- Отказы входа (401) отдельно не считаются и алертом не поднимаются — не найдено.

**Оценка: частично** (слабые места 4 и 9).

---

## A10:2021 — Server-Side Request Forgery

Адреса, которые сервер запрашивает, и откуда они берутся:

| Исходящий запрос | Откуда адрес | Может ли пользователь его задать |
|---|---|---|
| Токен LWA, согласие Amazon | константы `LWA_TOKEN_URL` и таблица Seller Central по id витрины из закрытого списка ([providers.ts](../../packages/channel-oauth/src/providers.ts)) | нет; переопределение адреса токена — только в режиме стенда ([channel-apps.ts](../../packages/service-runtime/src/channel-apps.ts)) |
| `redirect_uri` OAuth | конфигурация, в бою проверяется формой `https://<host>/connect/callback`; у eBay — RuName | нет |
| Токен и Identity eBay | константы по окружению PRODUCTION/SANDBOX | нет |
| JWKS и userinfo поставщика | JWKS — конфигурация (`https://` обязателен в бою); userinfo — из документа обнаружения НАСТРОЕННОГО издателя ([index.ts](../../packages/identity/src/index.ts)) | нет |
| Ключ eBay по `kid` | `kid` из заголовка уведомления (задаёт кто угодно) подставляется в путь фиксированного `apiBase` только после проверки `^[A-Za-z0-9-]{1,64}$`; не больше 10 обращений в минуту, неизвестный `kid` кэшируется отрицательно ([verify.ts](../../services/ebay-account-deletion/src/verify.ts)) | только сегмент пути на хосте eBay — хост и схему изменить нельзя |
| API каналов (Kaufland, SP-API, eBay) | константы клиентов по снимкам спецификаций | нет |
| Внешняя отметка, почта, ClickHouse | файлы секретов и конфигурация | нет |
| Перенаправления лендинга `/demo`, `/contact` | переменные compose | нет |

Параметров «URL из тела запроса» (вебхук продавца, импорт по ссылке и т. п.) — не найдено. У исходящих вызовов есть тайм-ауты
(`AbortSignal.timeout`).

**Оценка: соответствует.** Замечание без оценки «слабое место»: отрицательный кэш `kid` в приёмнике eBay не имеет верхней
границы размера, но растёт не быстрее 10 записей в минуту и живёт по сроку.

---

## Исправлено в шаге 52

Разделы A01–A10 выше описывают состояние ДО исправлений; сводка ниже — после. Расхождения с предложенным планом названы:

| Категория | Что сделано | Где | Отличие от предложения |
|---|---|---|---|
| A06 | `npm audit --audit-level=high` после `npm ci` в быстром задании CI; Dependabot для npm и действий GitHub | [.github/workflows/ci.yml](../../.github/workflows/ci.yml), [.github/dependabot.yml](../../.github/dependabot.yml) | Экосистема образов контейнеров в Dependabot не добавлена: её значение для файлов compose не сверено с документацией — закрепление образов по digest отдельным шагом |
| A05 | Заголовки каждого ответа консоли (страница, API, ошибки): `Content-Security-Policy: frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; тест HTTP-слоя | [apps/console/server/stand-server.ts](../../apps/console/server/stand-server.ts) (`SECURITY_HEADERS`), [apps/console/test/static.test.ts](../../apps/console/test/static.test.ts) | Политика источников скриптов и соединений (`default-src`, `script-src`, `connect-src` с адресом поставщика identity) не введена: ей нужен адрес поставщика из конфигурации — отдельной строкой плана |
| A02, A05 | `Strict-Transport-Security: max-age=31536000` и `-Server` у консоли и лендинга на прокси (TLS кончается там) | [deploy/production/snippets.caddy](../../deploy/production/snippets.caddy) | — |
| A08 | `permissions: contents: read` — токен заданий CI только читает репозиторий | [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | Действия по SHA и образы по digest — отдельно (нужна сеть и сверка) |

## Исправлено в шаге 53

Порядок — по заданию шага 53: частота, CSP, закрепление, затем три крупных пункта, которые в шаг не вошли.

| Категория | Что сделано | Где | Проверка |
|---|---|---|---|
| A04 (п. 8) | Ограничение частоты в HTTP-слое консоли, ДО разбора тела и проверки входа: скользящее окно 60 с на АДРЕС клиента (шаг 54: ключом был отпечаток `Authorization`, и выдуманный токен давал новый счётчик — ревью шага 53, находка 1); запрос с заголовком входа получает больший предел того же счётчика. `X-Forwarded-For` учитывается только при `REPRACER_CONSOLE_TRUST_PROXY=on` (в промышленном профиле консоль стоит за Caddy). Пределы — `REPRACER_CONSOLE_RATE_AUTHORIZED` (600) и `REPRACER_CONSOLE_RATE_ANONYMOUS` (120); адресов в памяти — не больше 20 000, просроченные убирает таймер. Отказ — `429 RATE_LIMITED` с `Retry-After` и текстом словаря DE/EN. Счётчик в памяти процесса — поэтому реплика консоли одна, и больше одной процесс не запустит (шаг 54, п. 3) | [stand-server.ts](../../apps/console/server/stand-server.ts) (`createRateLimiter`), [config.ts](../../apps/console/server/config.ts), [deploy/console](../../deploy/console/compose.yaml) | [static.test.ts](../../apps/console/test/static.test.ts): выдуманные токены одного адреса делят бюджет, 429 с `Retry-After`, `X-Forwarded-For` без доверия прокси игнорируется, потолок памяти с вытеснением; [config.test.ts](../../apps/console/test/config.test.ts): две реплики — отказ при старте |
| A05 (п. 2) | Полная CSP консоли: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' <origin поставщика identity>; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'`. Origin поставщика берётся из конфигурации (издатель и адрес discovery) — у страницы нет другого внешнего адресата | [stand-server.ts](../../apps/console/server/stand-server.ts) (`consoleContentSecurityPolicy`), [console-service.ts](../../apps/console/server/console-service.ts) | тест политики: собственные источники и origin поставщика в `connect-src`, без `unsafe-*`. Заголовком ответа полная политика НЕ проверена — передачу её из `console-service.ts` тест не держит (ревью шага 53, находка 10, отложено) |
| A06, A08 (п. 3) | Действия GitHub закреплены по SHA коммита (с тегом в комментарии), образы PostgreSQL, Node, Caddy — `тег@sha256:…` в CI и во всех `deploy/*/compose.yaml` и смоуке развёртываний; НЕ закреплены по digest `redpanda` и `clickhouse-server` полного задания CI и `infra/local`, версия Node в `setup-node` — `22` (ревью шага 53, находка 11, отложено); `npm audit --omit=dev --audit-level=high` — блокирующий, отчёт по зависимостям разработки — отдельным неблокирующим шагом | [ci.yml](../../.github/workflows/ci.yml), `deploy/*/compose.yaml`, [deploy-smoke.sh](../../scripts/deploy-smoke.sh) | полный прогон CI поднимает развёртывания по закреплённым образам |

**Не вошло в шаг 53** — сделано в шаге 54 (ниже).

## Исправлено в шаге 54

| Категория | Что сделано | Где | Проверка |
|---|---|---|---|
| A09 (п. 9) | Журналы ≥ 12 месяцев (решение руководителя): таймер хоста раз в сутки выгружает журналы контейнеров всех проектов в сжатый файл суток — горячий хвост 30–61 суток; месяц, вышедший из окна, — один архив `platform=logs/<проект>/<ГГГГ-ММ>.log.gz` с SHA-256 рядом с архивом событий; месяцы старше 13 уходят. Отдельного хранилища нет до замеров пилота. Шаг 55 (ревью шага 54, находки 10–12): выгрузка от отметки «выгружено по» (пропущенные сутки догоняются), перед выкладкой — `--until-now` (журнал контейнера уходит вместе с ним при пересоздании), сбой проекта не останавливает остальные **Шаг 55** (ревью шага 54, находки 10–12): выгрузка от отметки «выгружено по» (пропущенные сутки догоняются); перед выкладкой — `--until-now`, потому что журнал контейнера уходит вместе с ним при пересоздании; сбой проекта не останавливает остальные | [logs-archive.sh](../../deploy/production/logs-archive.sh), [systemd](../../deploy/production/systemd/) | [logs-archive.test.ts](../../scripts/test/logs-archive.test.ts): тот же скрипт с подставным `docker` — 62 дня, месяц в архиве целиком и по порядку, сумма, срок 13 месяцев, собранный архив не пересобирается из остатка |
| A02 (п. 6) | Шифрование копии: GnuPG есть в образе postgres (официальный Dockerfile ставит `gnupg` отдельным слоем и не удаляет); `pg_dump` идёт в `gpg --encrypt` потоком — открытой копии на диске нет; на сервере только ОТКРЫТЫЙ ключ файлом в каталоге секретов, закрытый — у владельца; без ключа копия не пишется (fail-closed) | [backup-loop.sh](../../deploy/production/backup-loop.sh), [compose.yaml](../../deploy/production/compose.yaml), README 3в | [backup-restore.pg.test.ts](../../packages/pricing-store-pg/test/backup-restore.pg.test.ts): тот же скрипт одной итерацией с одноразовой парой ключей → на диске нет ни формата pg_dump, ни открытых имён → закрытый ключ расшифровывает → восстановление на чистой базе и защиты схемы |
| A01/A05 (п. 7) | Изоляция панели (OQ-227 закрыт): правило сборки — каждый порт каждого развёртывания публикуется на `127.0.0.1`, наружу только 80/443 прокси (с положительным контролем); полный прогон CI проверяет, что панель не отвечает по внешнему адресу машины | [repo-rules.test.ts](../../scripts/test/repo-rules.test.ts), [deploy-smoke.sh](../../scripts/deploy-smoke.sh) | правило и смоук полного прогона |

**Осталось только внешнее:** вынос копий и месячных архивов журналов с сервера забором второй машиной или хранилищем (у сервера
нет учётных данных внешнего хранилища) и firewall хоста вторым слоем — README 3в; живой вход ZITADEL (OQ-141), внешний контроль и
почта (OQ-188, OQ-224).

## Сводка

Состояние после шага 54.


| Категория (2021) | Оценка | Главное |
|---|---|---|
| A01 Broken Access Control | соответствует | RLS + FORCE, роли по столбцам, второй фактор в базе, мутационная проверка; панель — OQ-227 |
| A02 Cryptographic Failures | соответствует | AES-256-GCM с AAD, RS256/ES256; HSTS у прокси — шаг 52; копия БД шифруется GnuPG открытым ключом — шаг 54; вынос с сервера — внешнее |
| A03 Injection | соответствует | параметризованный SQL, UUID-проверка в единственной интерполяции значений, React/`textContent` |
| A04 Insecure Design | соответствует | инварианты цены в БД, тень по умолчанию, fail-closed; ограничение частоты в HTTP-слое консоли — шаг 53 |
| A05 Security Misconfiguration | соответствует | секреты файлами, non-root read-only, лендинг с CSP; у консоли — полная CSP (шаг 53), X-Frame-Options, nosniff, Referrer-Policy; изоляция панели — правило сборки и смоук CI, шаг 54 (OQ-227 закрыт) |
| A06 Vulnerable and Outdated Components | соответствует (было «слабое место») | мало зависимостей, точные версии; с шага 52 — `npm audit --audit-level=high` в быстром задании CI и Dependabot для npm и действий GitHub; с шага 53 — действия по SHA, образы развёртываний по digest; `redpanda`, `clickhouse-server` полного задания CI — по тегу (отложено, ревью шага 53, находка 11) |
| A07 Identification and Authentication Failures | частично | внешний IdP, строгая проверка JWT, PKCE, MFA из ID-токена; ZITADEL живьём не проверен (OQ-141) |
| A08 Software and Data Integrity Failures | соответствует | lock-файл, снимки с SHA-256, подписи вебхуков; `permissions: contents: read` в CI — шаг 52; с шага 53 — действия по SHA, образы развёртываний по digest (кроме двух образов полного задания CI — отложено) |
| A09 Security Logging and Monitoring Failures | частично | аудит 18 мес, алерты с доставкой; журналы процессов ≥ 12 месяцев — шаг 54; отметка (OQ-188) и почта (OQ-224) не проверены живьём — внешнее |
| A10 Server-Side Request Forgery | соответствует | все исходящие адреса — константы или конфигурация; `kid` ограничен формой и частотой |

## Слабые места и предложения

### Мелкие — можно исправить в шаге за ≤ 1 час

1. **A06: аудит зависимостей в CI.** Файл [.github/workflows/ci.yml](../../.github/workflows/ci.yml), задание `fast`: после шага
   `npm ci` добавить шаг `npm audit --audit-level=high` (блокирующий; сеть в CI есть). Рядом — новый файл
   `.github/dependabot.yml` с экосистемами `npm` (корень), `github-actions` и `docker` (каталоги `deploy/*`), интервал — weekly.
   Оценка: 30–45 минут, включая разбор первых находок, если они не требуют обновления мажорных версий.
2. **A05/A02: заголовки консоли и HSTS.** Файл [deploy/production/snippets.caddy](../../deploy/production/snippets.caddy): во фрагмент
   `(console)` добавить блок `header` — `Content-Security-Policy "default-src 'self'; connect-src 'self' <origin издателя>; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"`,
   `X-Content-Type-Options nosniff`, `Referrer-Policy no-referrer`, `Strict-Transport-Security "max-age=31536000"`, `-Server`;
   во фрагмент `(landing)` — тот же `Strict-Transport-Security`. Origin издателя передать прокси переменной в
   [deploy/production/compose.yaml](../../deploy/production/compose.yaml) (сервис `proxy`, значение из `REPRACER_CONSOLE_OIDC_ISSUER`).
   Инлайн-стилей и инлайн-скриптов в консоли нет (`style={{` — 0 вхождений, скрипт — модуль сборки vite), поэтому
   `'unsafe-inline'` не нужен. Проверка — полный прогон CI, где гость проходит профиль production через прокси.
3. **A08: права токена CI.** В [.github/workflows/ci.yml](../../.github/workflows/ci.yml) на верхнем уровне добавить
   `permissions: { contents: read }` (задания только читают код и загружают артефакт). Закрепление `actions/*@v4` по SHA и
   образов по digest — там же и в `deploy/*/compose.yaml`, но это требует сети для получения хэшей: в шаге с сетью — ≤ 1 часа.

### Крупные — в план, оценка в днях

4. **A09: внешняя отметка и почта не проверены живьём (OQ-188, OQ-198, OQ-224).** Нужны аккаунты владельца (сервис отметок, почтовый
   провайдер); после них — одна команда `scripts/setup-heartbeats.mjs`, снятие `off` в смоуке развёртываний и по одному живому
   письму на сценарий. ~0,5–1 день после регистрации аккаунтов владельцем.
5. **A07: подключение настоящего ZITADEL (OQ-141).** Проект и приложения OIDC, прогон входа с настоящим токеном (утверждения, `amr`,
   ротация ключей), в том числе у панели. ~1 день после создания проекта владельцем.
6. **A02: шифрование и вынос резервной копии.** В [backup-loop.sh](../../deploy/production/backup-loop.sh) — шифрование копии
   открытым ключом (закрытый хранится вне сервера), выгрузка копии за пределы машины, тест восстановления из шифрованной копии в
   [backup-restore.pg.test.ts](../../packages/pricing-store-pg/test/backup-restore.pg.test.ts). ~1 день.
7. **A01/A05: доступ к панели оператора (OQ-227).** Перевести панель на unix-сокет либо добавить в смоук развёртываний проверку
   «порт панели недоступен снаружи». ~0,5–1 день.
8. **A04: ограничение частоты запросов.** Предел на ключ Inbound API и на тенанта для API консоли; предел гостей демо — на клиента,
   а не один на процесс. Стандартный Caddy ограничителя частоты не содержит — реализация в HTTP-слое консоли
   ([stand-server.ts](../../apps/console/server/stand-server.ts)) с тестом через HTTP. ~1–2 дня.
9. **A09: хранение журналов процессов ≥ 12 месяцев и сигнал об отказах входа.** Централизованный сбор журналов прокси и процессов
   со сроком хранения (DPP Amazon требует журналы ≥ 12 месяцев; аудит в базе это уже держит), счётчик 401 в метриках с порогом.
   ~1–2 дня, выбор хранилища — решение владельца.
