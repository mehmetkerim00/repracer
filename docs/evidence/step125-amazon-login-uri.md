# Шаг 125: log-in URI Amazon — шаги 5–8 потока с сайта (П6)

Решение владельца по докладу шага 122: «П6 — да, отдельным шагом и РАНЬШЕ П1… красное сначала: тест, воспроизводящий приход продавца со стороны
Amazon (все параметры, которые Amazon шлёт на log-in URI), до правки должен падать». Решение — [ADR-0076](../adr/0076-amazon-login-uri.md).

## Источник

Страница website-authorization-workflow загружена заново 2026-11-14: SHA-256 `9c6bbf15…af09c` — та же, что в снимке
[2026-11-14](../../vendor/amazon/lwa-authorization/2026-11-14/SOURCE.md). Из неё взяты: таблица 16 шагов (шаг 5 — `amazon_callback_uri`,
`amazon_state`, `selling_partner_id`; шаг 7 — проверка и `state`; шаг 8 — `amazon_state`, `state`, необязательный `redirect_uri`), «Log-in URI
details» (`version=beta` у черновика), «Amazon callback URI details» (пример `https://amazon.com/apps/authorize/confirm/<application_id>`,
«If omitted, Amazon uses the first registered redirect URI», `Referrer-Policy: no-referrer`) и «весь поток дольше 10 минут may break».

## Что сделано

- **Поставщик LWA** (`packages/channel-oauth/src/providers.ts`): `continueFromLogin` — разбор параметров log-in URI и адрес продолжения
  `amazon_callback_uri` + `amazon_state`, `state`, `redirect_uri`, `version=beta` у черновика. Отказ своей причиной: нет адреса или
  `amazon_state`; адрес не https на `amazon.com` и его поддоменах, с логином, портом или фрагментом; путь не `/apps/authorize/confirm/<наш
  application_id>`; `version` расходится с флагом черновика.
- **Консоль:** маршрут `POST …/connections/amazon-login` (право «Connect», `MANAGE_TENANT`), служба подключения продолжает только ждущий
  запрос Amazon этого тенанта (не отменён, не истёк, обмен не начат) — `PgChannelConnectStore.pendingRequest` читает запрос по отпечатку
  `state` и ничего не меняет. Журнал: `channel_connect_login_continue`, `channel_connect_login_refused` (причина и хост адреса; без
  `amazon_state` и `state`). Страница: `/connect/amazon/login` — параметры в хранилище вкладки до входа, адрес стирается сразу, после входа —
  пересылка серверу вместе со `state` «Connect» и уход на адрес продолжения; `state` после использования стирается, мир остаётся для
  `/connect/callback`; без «Connect» в этой вкладке — «откройте Channels и нажмите Connect Amazon», запроса к серверу нет. Тексты — EN/DE/ES/FR.
- **Модель поставщика LWA** (`packages/channel-oauth/src/model.ts`): согласие Amazon ведёт на log-in URI со всеми параметрами; код выдаёт только
  `confirm` — возврат на `amazon_callback_uri` (одноразовый `amazon_state` не старше 10 минут, путь и `application_id` визита, тот же `version`,
  зарегистрированный `redirect_uri`, непустой `state`). Модель Amazon без log-in URI не создаётся.
- **Документы:** `deploy/pilot/README.md`, §1 — Login URI `https://app.<домен>/connect/amazon/login`; чеклист первого живого аккаунта, A1 —
  что записать (хост и путь `amazon_callback_uri`, форма `application_id`, A-34) и что делать при отказе; отложенное — строка «125»: поток,
  начатый в Appstore, до публикации приложения не продолжается.

## Красное сначала

Сначала изменены модель поставщика (приход продавца со стороны Amazon — на log-in URI со всеми параметрами) и тесты; код продукта — прежний:

| Тест | На старом коде |
|---|---|
| `packages/channel-oauth/test/oauth.test.ts` — 2 новых теста шага и 5 прежних потоков Amazon | 7 из 14 красные: `continueFromLogin is not a function` |
| `apps/console/test/connect-live.pg.test.ts` — живой прогон через HTTP | 3 из 3 красные: log-in URI консоли — `404 NOT_FOUND` |
| `apps/console/test/browser-smoke.test.ts`, «step 125 (П6) …» — настоящий браузер | Красный: адрес log-in URI остаётся в истории, страница его не обрабатывает |

`apps/console/test/pilot-live.pg.test.ts` переведён на тот же поток (на старом коде упал бы тем же 404).

## Зелёное и зубы

- OAuth 14 из 14, живой прогон подключения 3 из 3 (с отказами log-in URI: чужой хост `amazon.com.evil.example` — 400
  `LOGIN_CALLBACK_NOT_AMAZON` и адреса в ответе нет; чужой `state` — 409 `UNKNOWN_STATE`; оператор — 403; запрос после отказов ждёт, и
  настоящее продолжение проходит; отменённая попытка — 409 `ALREADY_DONE`), пилот 1 из 1, браузерный смоук шагов 125 и 76 — 2 из 2, модель
  консоли 94, консоль без базы 46 + 14, проверка типов — 0.
- Ручные мутации, каждая поймана своим утверждением: хост «оканчивается на `amazon.com`» без точки — `evilamazon.com` проходит
  (OAuth, тест границ); путь «начинается с `/apps/authorize/confirm/`» — чужое приложение проходит (там же); служба без проверки ждущего
  запроса — «возврат отменённой попытки ничего не подключает» (живой прогон).

Миграций нет: шаг читает существующий запрос согласия (0132).
