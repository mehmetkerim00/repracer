# Ревью шага 27

Дата: 2026-09-18. Ветка `step27`, рабочее дерево на момент ревью (коммита шага ещё нет).

## Что читалось и что запускалось

Читалось:

- миграции `0098`…`0102` целиком, плюс `0006`, `0019`, `0025`, `0036`, `0051`, `0062`, `0096` — ради сравнения с тем, что шаг меняет;
- `packages/price-gate/src/index.ts`, `packages/pricing-model/src/reasons.ts`, словари `packages/console-model/src/i18n/{de,en}.ts`;
- `packages/pricing-pipeline/src/{store.ts,pipeline.ts,memory-store.ts}`, `packages/pricing-store-pg/src/store.ts` (флаг `dispatchInline`);
- `services/scheduler/src/{scheduler.ts,jobs.ts,pg-deps.ts}` и `services/scheduler/test/scheduler.test.ts`;
- `packages/service-runtime/*`, `services/pricing-worker/src/{main.ts,worker.ts,config.ts}`, `services/notification-receiver/*`,
  `deploy/worker/*`, `deploy/notification-receiver/*`;
- `tests/contract/src/background-live.pg.test.ts`, `tests/contract/src/live/{fake-clickhouse,kaufland-world,amazon-world}.ts`;
- `tests/db/{smoke_app.sql,smoke_append_only.sql,mutations.mjs}`, `scripts/db/{mutation-check.mjs,check-catalog-coverage.mjs}`;
- `docs/{decisions.md,accepted-risks.md,open-questions.md}`, `migrations/README.md`;
- уже в ходе ревью в дереве появились `docs/adr/0027-live-background-cost-required-backoff.md`,
  `docs/evidence/step27-live-background.md`, `docs/evidence/step27-cost-required.md`, `docs/evidence/step27-mutation.md` —
  прочитаны, числа из них цитируются как утверждения автора, а не как мои измерения.

Запускалось (только на своей базе `repracer_review27`, созданной из `repracer_template` и удалённой в конце; `repracer_eu`
и `repracer_template` не изменялись):

- `migrations/0102_verify_schema_invariants_v24.sql` — проходит;
- то же после подмены `maintenance.purge_tenant_data` (эксперимент к находке 6) — тоже проходит, что и есть находка;
- `node scripts/db/check-catalog-coverage.mjs repracer_review27` — зелено, «every protection outside the step 19 baseline (725)
  has a catalog row»;
- `node scripts/check-test-inclusion.mjs` — 74 файла тестов, вне сборки 0;
- `tsc --noEmit` по `packages/service-runtime`, `services/pricing-worker`, `services/notification-receiver`, `tests/contract` — чисто;
- тесты пакетов, которым не нужна инфраструктура: `price-gate` (14/14), `console-model` (9/9), `service-runtime` (4/4),
  `notification-receiver` (2/2), `apps/console` `test/console.test.ts` (15/15), `services/scheduler` без PG-файлов (16/16),
  `tests/contract` в памяти — `harness`, `kaufland.contract`, `amazon.contract`, `console`, `console-step21` (104/104),
  `pricing-model`, `input-sanity`, `strategy-engine`, `write-dispatcher`, `broker`, `amazon-adapter`, `amazon-notifications`,
  `analytics-export`, `amazon-client` — все зелёные;
- `packages/pricing-pipeline` — **1 из 9 падает** (находка 1).

Не запускалось: `scripts/db/prepare.sh`, `node scripts/test-all.mjs`, `scripts/db/mutation-check.mjs`, смоук-файлы `tests/db/*.sql`
и живой прогон `tests/contract/src/background-live.pg.test.ts` (см. «Чего ревью не покрыло»).

## Находки

| № | Что | Где | Почему важно | Серьёзность |
|---|-----|-----|--------------|-------------|
| 1 | Из-за `dispatchInline` конвейер без диспетчера больше не отправляет запись в транзакции решения, и сверка базы цены [Р-116] на пути решения не срабатывает: `CHANNEL_DISTRUSTED` не поднимается, недоверия каналу нет. Тест шага 22 падает | `packages/pricing-pipeline/src/pipeline.ts:351`, `packages/pricing-pipeline/src/memory-store.ts:770`, падает `packages/pricing-pipeline/src/price-basis.test.ts:43`; конвейер без диспетчера в бою — `services/notification-receiver/src/main.ts:40` | Сборка красная [Р-84, Р-89]. По существу: у приёмника уведомлений диспетчера нет намеренно, значит находка 1 ревью шага 22 («синхронный канал применяет первую отправку пути решения сразу, поэтому базу цены сверяет путь решения») в живой топологии больше не выполняется — остаётся только `checkPriceBasis` диспетчера воркера | дефект продукта |
| 2 | Р-132 сделал повтор провалившейся работы **длиннее**, а не короче: база паузы — полный период работы. `retryDelaySeconds(86_400, 1) = 86_400` | `services/scheduler/src/scheduler.ts:78-86`; было `Math.min(j.intervalSeconds, 60)` | Суточная выгрузка (`analytics-export-day`, `intervalSeconds: 86_400`) после одного провала не повторяется сутки — раньше повторялась через минуту. 15-минутная недоступность ClickHouse стоит суток истории снимков [Р-122]. Часовые работы (`price-days-close`, `partitions`, `retention`) после провала ждут час вместо минуты. Это и наблюдал живой прогон, но записано как OQ-193 «работа не делает повтор внутри суток», то есть регрессия описана как свойство | дефект продукта |
| 3 | `/healthz` воркера зеленеет от таймера, а не от работы: `setInterval(() => health.alive(), …)` | `services/pricing-worker/src/main.ts:89-93`; цикл обхода без обратного вызова — `services/pricing-worker/src/worker.ts:120-127` | Обход может валиться каждый цикл (`WRITE_DISPATCH_SWEEP_FAILED`, CRITICAL) или база быть недоступна — контейнер останется «здоровым», `restart` не сработает. Комментарии строк 83 и 92 утверждают обратное («отметка ставится и обходом»). У приёмника сделано правильно: `health.alive()` после `pollOnce()` | дефект проверки |
| 4 | `replicas: ${REPRACER_WORKER_REPLICAS:-2}` вместе с фиксированной публикацией порта `127.0.0.1:9465:9465` | `deploy/worker/compose.yaml` (блоки `deploy` и `ports`), пример `worker.env.example` ставит `REPRACER_WORKER_REPLICAS=2` | Второй экземпляр не поднимется: порт занят. Развёртывание, которое по своему же примеру не стартует | дефект продукта |
| 5 | Ждущая запись объясняется причиной `WRITE_QUEUED_BEHIND_IN_FLIGHT` даже когда в полёте ничего нет | `packages/pricing-pipeline/src/pipeline.ts:276-279`; тексты — `packages/console-model/src/i18n/en.ts:155`, `de.ts:156` | Продавец читает «канал ещё не ответил на предыдущую отправку», хотя запись просто ждёт отдельный процесс диспетчера. Объяснение должно называть происходящее [Р-72] | дефект продукта (объяснение) |
| 6 | Новое правило проверки схемы (задача F) сверяет имя таблицы **подстрокой** определения функции очистки | `migrations/0102_verify_schema_invariants_v24.sql:136-144` (`position(r.table_name::text IN pg_get_functiondef(...)) = 0`) | Имя более длинной таблицы засчитывает более короткую. Так «проверены» 9 таблиц: `tenant_data.price_daily`, `price_history`, `product`, `write_scope`, `channel_write`, `migration_consent`, `channel_data.competitor_move`, `price_decision`, `pricing_halt`. То есть вечная свёртка Omnibus может выпасть из очистки тенанта, а правило останется зелёным — это ровно то, что правило обещает ловить [Р-93, Р-94] | дефект проверки |
| 7 | Живой прогон не утверждает ни одной успешной выгрузки строк в ClickHouse; одно утверждение — тавтология, ещё одно проходит и при нуле | `tests/contract/src/background-live.pg.test.ts:299-313` (`assert.equal(exported.length, 0)` — «строк в аналитическом слое нет», `assert.ok(any.n >= 0, 'отметки выгрузки считаются')` — истинно всегда) и `:315-331` (`assert.ok(dropped.n <= verified.n)` истинно и при `dropped = 0`) | Механизм `analytics-export` зарегистрирован в `observes(...)` как утверждённый, но утверждается только путь отказа: ни одна строка снимка за прогон в слой не попала (причина — находка 2). Имя теста («сутки журнала снимков выгружены, проверены и повтор не удваивает строки») расходится с телом. У `retention` утверждение «проверенная секция удаляется» неравенством не закрывается — по доказательству автора (`docs/evidence/step27-live-background.md`) вышло 1 удалённая при 4 проверенных, но тест прошёл бы и при 0 удалённых | дефект проверки |
| 8 | Нет утверждения, что уведомления в прогоне вообще были | `tests/contract/src/background-live.pg.test.ts:290-297` | `assert.equal(n.processed, bg.notificationsSent)` зелено при обоих нулях; алерт `NOTIFICATION_UNPARSEABLE` поднимется и от подстановки `'{}'` (строка 188), то есть даже без единого настоящего уведомления. В прогоне автора их было 66, но если модель порта перестанет их отдавать, проверка промолчит. Нужен `assert.ok(bg.notificationsSent > 0)` | дефект проверки |
| 9 | У новой проверки Р-131 значение по умолчанию открывает её: `cost = { declared: true, cause: null }` | `packages/price-gate/src/index.ts:320-330`; вызовы без аргумента — `packages/price-gate/src/gate.test.ts:111-116` | Любой вызывающий, забывший аргумент, молча получает «себестоимость объявлена». Собственного теста у ветки `COST_REQUIRED` в `gate.test.ts` нет — Р-131 в этом пакете проверяется только через фикстуру конвейера и экран консоли. Параметр стоит сделать обязательным | дефект проверки |
| 10 | `maintenance.correct_closed_price_days` каждый час сканирует всю `tenant_data.price_history_applied` без ограничения по времени | `migrations/0101_late_applied_confirmation_correction.sql:195-216`; работа — `services/scheduler/src/jobs.ts:163-172` (`maintenanceEverySeconds` = 3600) | `price_history_applied` — `TENANT_CLOSURE_ONLY` (растёт вечно), индексов кроме PK `(tenant_id, price_history_id)` нет, предикат `(accepted_at AT TIME ZONE tz)::date <> (applied_at AT TIME ZONE tz)::date` вычисляемый. Ведущая таблица CTE `moved` — именно она. На клиенте с 10 000 офферов это десятки миллионов строк ежечасно. Нужен ограничитель `ap.recorded_at > p_now - interval 'N days'` и/или частичный индекс | риск |
| 11 | `security.grant_export` выдан системной поправке, но у поправки человека прав экспортёра нет | `migrations/0101_…:59` против `migrations/0025_price_daily_immutable.sql` (у `tenant_data.price_daily_correction` `grant_export` нет; проверено в базе: политики `export_read` есть у `price_daily` и `price_daily_system_correction`, у `price_daily_correction` — нет) | Если самодостаточный архив ядра [Р-79] начнут собирать правами `repracer_exporter`, в архиве применится системная поправка там, где действует поправка человека — а она «последнее слово». Сейчас `packages/analytics-export` `price_daily` не выгружает, поэтому риск латентный | риск |
| 12 | `SELECT * INTO roll FROM maintenance.price_day_rollup(...)` молча берёт первую группу `(currency, price_basis)`; идемпотентность не сравнивает `min_floor_minor` | `migrations/0101_…:218` и `:237-245` | Смена валюты/базы единицы записи дала бы поправку по одной из групп без отказа. Расхождение только по `min_floor_minor` поправки не даст — «пол удержал цену» [Р-117] в закрытых сутках останется старым | риск |
| 13 | `tenant_data.price_daily_effective` роль `repracer_app` прочитать не может | Проверено на `repracer_review27`: `PGUSER=svc_app` → `ERROR: permission denied for table price_daily`; `svc_admin` и `svc_scheduler` — 0 строк без ошибки | Не дефект шага 27 (так с 0025: представление `security_invoker`, а прав на базовые таблицы у `repracer_app` нет), но шаг добавил в представление третью таблицу и картину не изменил. Стоит зафиксировать в комментарии, что представление рассчитано на `repracer_admin` и `repracer_retention` | замечание |
| 14 | Комментарий «ClickHouse недоступен полчаса» неверен: 60 тактов × 15 с = 15 минут | `tests/contract/src/background-live.pg.test.ts:191` (строка 71 говорит верно — «первые 15 минут») | Документация расходится с кодом в том самом месте, от которого зависит трактовка находки 7 | замечание |
| 15 | `price_daily_system_correction_chain_uq` — защита без своей проверки | `migrations/0101_…:55-56`; каталог `tests/db/mutations.mjs` строку `OQ-192` про неё не содержит | `scripts/db/check-catalog-coverage.mjs` её не видит (смотрит только триггеры и CHECK), поэтому сборка зелёная. По существу индекс дублирует `a_price_daily_system_correction_chain`, который берёт `pg_advisory_xact_lock` на сутки: по Р-104 — либо своя проверка, либо удалить как дубль | замечание |
| 16 | `secretFromEnv` допускает секрет значением переменной окружения, если нет `<ИМЯ>_FILE` | `packages/service-runtime/src/env.ts:12-22` | Compose-файлы так не делают, и тесты развёртывания это утверждают, но самой защиты нет: переменная `REPRACER_APP_PG_URL` сработает | замечание |
| 17 | Остановка воркера может упереться в SIGKILL | `services/pricing-worker/src/worker.ts:120-127` (`await new Promise((r) => setTimeout(r, sweepEvery))` неотменяемо, `sweepEvery` = 60 000 по умолчанию) против `stop_grace_period: 60s` в `deploy/worker/compose.yaml` | `stop()` ждёт `Promise.allSettled(background)`, то есть до 60 с только на сон обхода — ровно на границе льготного срока | замечание |
| 18 | Строка `retention_run` про пересчёт всегда называет таблицу поправок | `migrations/0101_…:258-261` | В ветке «строки суток не было» пересчёт вставил строку в `tenant_data.price_daily`, а журнал говорит о `price_daily_system_correction` | замечание |
| 19 | Шаг не закрыт по правилам репозитория | в `CLAUDE.md` нет строки статуса шага 27 (ADR-0027 и доказательства `step27-live-background.md`, `step27-cost-required.md`, `step27-mutation.md` появились в дереве уже во время ревью) | Строка статуса — часть завершения шага; ссылок на новые доказательства и ADR в ней пока нет | замечание |
| 20 | Доказательство живого прогона не называет двух незакрытых дыр проверки | `docs/evidence/step27-live-background.md`, раздел «Что утверждает проверка после исправления»: строка «Выгрузка в ClickHouse» перечисляет только отказ; раздел «Чего проверка не покрывает» про это молчит | Читатель доказательства решит, что выгрузка проверена живым прогоном. Стоит прямо написать, что успешной выгрузки строк в прогоне не было (находка 7) — как это сделано про ClickHouse и SQS | замечание |

## Как воспроизвести

- **1.** `cd packages/pricing-pipeline && npm test` → `not ok 6 - finding 1 of the step 22 review…`. В ошибке видно, что вместо
  `CHANNEL_DISTRUSTED` последняя стадия — `DISPATCH_PLAN / QUEUED_BEHIND_IN_FLIGHT`. Тест строит конвейер без `dispatcher`
  (`price-basis.test.ts:38`), поэтому `Boolean(deps.dispatcher)` = `false` и запись остаётся ждущей.
- **2.** `services/scheduler/test/scheduler.test.ts` (новый тест Р-132) сам это и утверждает:
  `assert.equal(retryDelaySeconds(86_400, 1), 86_400, 'суточная работа повторяется не раньше следующих суток')`. Для наблюдения
  последствия: в `background-live.pg.test.ts` ClickHouse лежит 15 минут, а выгрузка за прогон не повторяется (утверждение
  `exported.length === 0`, строка 304, и OQ-193).
- **3, 4, 5, 14, 16, 17, 18.** Чтение кода; воспроизведение поведением требует запуска контейнеров (`docker compose up` для 3, 4, 17)
  или живой очереди (5) — в этой сессии не запускалось.
- **6.** Воспроизведено на `repracer_review27` (копия `repracer_template`):
  1. выгрузить `pg_get_functiondef('maintenance.purge_tenant_data(uuid,boolean)'::regprocedure)` в файл;
  2. убрать из массива `'tenant_data.price_daily', ` (оставив `'tenant_data.price_daily_correction'`), применить `CREATE OR REPLACE`;
  3. `psql -f migrations/0102_verify_schema_invariants_v24.sql` — **проходит без ошибок**.
  Список таблиц, защищённых только подстрокой, даёт запрос:
  `SELECT a.table_name FROM security.table_registry a WHERE a.storage_class IN ('TENANT','CHANNEL') AND EXISTS (SELECT 1 FROM security.table_registry b WHERE b.table_name <> a.table_name AND position(a.table_name::text IN b.table_name::text) = 1)` — 9 строк.
- **7, 8, 20.** Чтение утверждений теста и доказательства автора (`docs/evidence/step27-live-background.md`, появилось в дереве во
  время ревью). Сам прогон не запускался; тавтологичность `any.n >= 0` и слабость `dropped.n <= verified.n` видны из текста.
- **9.** `grep -n validateRepricingEnablement packages/price-gate/src/gate.test.ts` — четыре вызова без аргумента `cost`;
  ветка `COST_REQUIRED` в модульных тестах пакета не вызывается ни разу.
- **10.** Схема: `\d tenant_data.price_history_applied` — единственный индекс `price_history_applied_pkey (tenant_id, price_history_id)`;
  `SELECT * FROM maintenance.retention_policy WHERE table_name::text = 'tenant_data.price_history_applied'` — `TENANT_CLOSURE_ONLY`.
  Замера на объёме не делалось.
- **11.** `SELECT tablename, policyname, cmd, roles FROM pg_policies WHERE schemaname='tenant_data' AND tablename LIKE 'price_daily%'`:
  `export_read` есть у `price_daily` и `price_daily_system_correction`, у `price_daily_correction` — нет.
- **12, 15, 18, 19.** Чтение кода и файлов репозитория.
- **13.** `PGUSER=svc_app psql -d <база> -c 'SELECT count(*) FROM tenant_data.price_daily_effective'` → `permission denied for table price_daily`.

## Что проверено и оказалось в порядке

- **Проверка схемы v24 проходит** на чистой копии шаблона (после `ALTER DATABASE … SET repracer.region = 'EU'`).
- **Покрытие каталога мутаций** (`check-catalog-coverage.mjs`) зелёное: все триггеры и CHECK вне базового списка шага 19 имеют строку.
  `STEP27_ROWS` подключены в `scripts/db/mutation-check.mjs`, `VERIFY` переведён на `0102`.
- **Полнота сборки**: `check-test-inclusion.mjs` — 74 файла, вне сборки 0; `background-live.pg.test.ts` добавлен в скрипт
  `tests/contract/package.json`; новые пакеты попадают в workspaces (`packages/*`, `services/*`).
- **Типы**: `tsc --noEmit` чист для `service-runtime`, `pricing-worker`, `notification-receiver`, `tests/contract`.
- **Порядок работ в `price-days-close`**: сначала `closePriceDays`, потом `correctClosedPriceDays` — правильный; пересчёт видит
  только что закрытые сутки.
- **Перенос цены в другие сутки не теряет её**, если сутки применения ещё не закрыты: `days` их отфильтрует, а `close_price_days`
  (0096) считает сутки по `coalesce(ap.applied_at, h.accepted_at)` и включит цену при закрытии. Двойного счёта нет: после закрытия
  `roll` совпадёт с `eff`, и пересчёт ничего не напишет.
- **Пересчёт не сотрёт старые сутки после удаления сырья**: `moved` джойнит `price_history_applied` к `price_history`, а секции
  `price_history` дропаются по 90 дням — строка выпадает из `moved` целиком, а не превращается в «сутки без цен».
- **Свёртка остаётся неизменяемой** [Р-29]: `price_daily` правится только вставкой (append-only тригеры на месте), поправка — своя
  таблица с цепочкой `supersedes_correction_id`, стражем цепочки с advisory-блокировкой, CHECK формы и границ; смоук
  `tests/db/smoke_append_only.sql` проверяет перенос, пустые сутки, идемпотентность повторного пересчёта и приоритет поправки
  человека, и каждый `expect_fail` называет причину [Р-94].
- **Права новой таблицы**: `repracer_app` прав на неё не получил (`register_table` выдаёт только `repracer_admin`),
  `repracer_admin` — только `SELECT` (INSERT/UPDATE/DELETE отозваны), писать может только `repracer_retention` через
  SECURITY DEFINER-функцию, политики строк `retention_correct_day`/`retention_correct_read` на месте, представление —
  `security_invoker = true`.
- **Список разрешённого пути решения сведён с правами в обе стороны**: `REVOKE SELECT ON maintenance.price_day_close FROM repracer_app`
  сделан вместе с удалением строки из `security.decision_path_allowed_privileges()`, и после 0101 `price_day_close` действительно
  никто из пути решения не читает (`price_history_mark_applied` переписан).
- **`tenant_data.price_daily_system_correction` названа в `maintenance.purge_tenant_data`** (0101 переопределяет функцию), политика
  хранения `TENANT_CLOSURE_ONLY` заведена, `grant_retention` выдан.
- **Р-131 в базе**: страж `zw_write_scope_cost_required_guard` срабатывает только на переход в `ENGINE`, выбор профиля
  себестоимости совпадает с полом маржи (0051); смоук `tests/db/smoke_app.sql` объявляет себестоимость до проверок границ, чтобы
  соседние `expect_fail` не зеленели чужой защитой, и проверяет Р-131 на отдельном товаре с точной причиной отказа.
- **Р-131 в консоли**: экран показывает препятствие, кнопки «Trotzdem aktivieren» при препятствии нет, подтверждение предупреждения
  себестоимость не объявляет (`apps/console/test/console.test.ts`, 15/15 зелено).
- **Фикстуры**: во все сценарии с `pricingMode: ENGINE` добавлена себестоимость — иначе база включение бы отклонила; контрактные
  тесты в памяти (104) остались зелёными, ожидаемые исходы не менялись.
- **Задача F**: `purge_tenant_channel_data` получила три потерянные таблицы (`price_decision_snapshot_ref`, `pricing_halt_sample`,
  `pricing_strategy_undercut`) в правильном порядке относительно внешних ключей, у каждой — своя строка каталога мутаций.
- **Ретранслятор**: `tryLock` вынесен в публичный метод без изменения поведения цикла `run`.
- **Приёмник уведомлений**: живость привязана к настоящему кругу опроса, а не к таймеру; остановка ждёт цикл.
- **Тесты развёртывания** проверяют, что compose запускает именно точку входа сервиса, монтирует секреты `:ro` и не передаёт
  адрес очереди и ключи AWS значениями переменных.

## Чего ревью не покрыло

- **Живой прогон `tests/contract/src/background-live.pg.test.ts` не запускался**: запуск был отклонён ограничением среды
  (он берёт `REPRACER_PG_URL`/`REPRACER_PG_ADMIN_URL` от рабочего стенда). Поэтому чисел прогона в отчёте нет: находки 7 и 8 —
  из чтения утверждений, а не из наблюдения. Проверить их надо запуском.
- **Не запускались** `scripts/db/prepare.sh`, `node scripts/test-all.mjs`, `scripts/db/mutation-check.mjs` и смоук-файлы
  `tests/db/*.sql` — по условиям ревью. Значит: полный зелёный прогон шага и число пойманных мутаций мной не подтверждены.
  По доказательству автора (`docs/evidence/step27-mutation.md`, появилось в дереве во время ревью) — 71 строка каталога,
  311 мутаций, не поймано 0; проверить это утверждение прогоном я не мог.
- **PG-тесты** (`*.pg.test.ts`) не запускались: без `REPRACER_PG_URL` они падают по Р-84, а с рабочим стендом это чужая база.
  То есть `store.pg.test.ts`, `console.pg.test.ts`, `scheduler.pg.test.ts`, `history-survives-stop.pg.test.ts` и др. вне ревью.
- **Настоящего ClickHouse нет**: выгрузка проверялась только чтением `fake-clickhouse.ts`; совпадение модели с поведением
  настоящей базы (дедупликация вставки, `FINAL`, TTL) не проверялось.
- **Живой очереди SQS и аккаунта Amazon нет** (OQ-167): приёмник и его развёртывание проверены только на модели.
- **Развёртывания не поднимались**: `deploy/worker` и `deploy/notification-receiver` читались как текст; находки 4 и 17 —
  из чтения compose, не из `docker compose up`.
- **Объёмных замеров нет**: находка 10 (ежечасный скан `price_history_applied`) — рассуждение о плане запроса и схеме,
  `EXPLAIN` на реальном объёме не делался.
- **Не проверялось** поведение пересчёта суток при смене часового пояса витрины и при нескольких витринах одной единицы записи.
- Побочное наблюдение, не находка: на стенде остались базы `mut__123_0`, `mut__123_1`, `mut_oq_192_10`, `mutt__122_3`,
  `mutt__123_0`, `mutt__123_1` — следы прогонов мутационной проверки. Своя база ревью (`repracer_review27`) удалена.

## Что сделано с находками (автор шага, после ревью)

| № | Итог | Как |
|---|---|---|
| 1 | **Исправлено, решение отменено** | Флаг `dispatchInline` убран целиком: путь решения снова отправляет свою запись сам, а диспетчер отправляет ту, что встала за ней [Р-64]. Ревью нашло не только красный тест: сама посылка была неверной — у планировщика адаптер есть, и цену он отправляет. Живой прогон переписан под настоящую топологию, доказательство и Р-130 исправлены |
| 2 | **Не исправлено, вынесено владельцу** | Р-132 владелец сформулировал как «минимум — период самой работы»; цена этого решения (суточная выгрузка ждёт сутки) названа в OQ-193 и в ADR-0027 вместе с альтернативой `min(период, 60 с)` |
| 3 | **Исправлено** | Живость воркера ставит прошедший обход (`onSweep`), таймера больше нет: валящийся обход здоровым не выглядит |
| 4 | **Исправлено** | `replicas: 1` в `deploy/worker/compose.yaml`; пример и README объясняют, что для второго экземпляра нужен свой порт метрик |
| 5 | **Отпало** | Причина `WRITE_QUEUED_BEHIND_IN_FLIGHT` снова верна: запись ждёт именно неразрешённую предыдущую (следствие отмены находки 1) |
| 6 | **Исправлено** | Правило сверяет имя таблицы В КАВЫЧКАХ, как оно стоит в списке очистки. Ужесточение сразу нашло ещё один случай — `tenant_data.tenant`: строка самого тенанта остаётся (в ней записано закрытие), и это записано исключением с обоснованием |
| 7 | **Исправлено** | Отказ слоя сделан точечным (модель отвергает вставку одних суток), успешная выгрузка утверждается числом выгруженных строк и отметкой проверки, повтор вставки — дедупликацией; модель сообщает о непонятых запросах, и это тоже утверждается |
| 8 | **Исправлено** | Добавлено `assert.ok(bg.notificationsSent > 10)`; заодно порог событий ретранслятора поднят с «больше нуля» до 5 |
| 9 | **Исправлено** | Аргумент себестоимости у `validateRepricingEnablement` стал обязательным; добавлен модульный тест ветки `COST_REQUIRED` (нет профиля, нет курса, причина неизвестна, все препятствия сразу) |
| 10 | **Исправлено** | Пересчёт смотрит только отметки за последний месяц (работа идёт каждые несколько минут и идемпотентна), для этого заведён индекс по `recorded_at` |
| 11 | **Исправлено** | `grant_export` у системной поправки снят: прав экспортёра нет ни у неё, ни у поправки человека |
| 12 | **Исправлено частично** | Сравнение идемпотентности учитывает и пол суток (`min_floor_minor`). Выбор первой группы `(currency, price_basis)` остался: смена валюты единицы записи — отдельный вопрос, в этом шаге не решался |
| 13 | **Исправлено** | В миграции записано, кто читает представление и почему `security_invoker` |
| 14 | **Исправлено** | Комментария про «полчаса» больше нет: недоступности по времени в прогоне не осталось |
| 15 | **Исправлено** | Уникальный индекс цепочки удалён как дубль стража цепочки [Р-104] |
| 16 | **Оставлено как есть** | Секрет значением переменной допускают все три процесса (так же у планировщика с шага 26); развёртывания передают только файлы, и это утверждают тесты. Ужесточение — отдельное решение |
| 17 | **Исправлено** | Сон обхода прерывается остановкой: `stop()` больше не ждёт целый обход |
| 18 | **Исправлено** | Журнал `retention_run` называет ту таблицу, в которую писали: поправки — таблицу поправок, первые строки суток — саму свёртку |
| 19, 20 | **Исправлено** | ADR-0027, доказательства живого прогона и Р-131, мутационное доказательство и строка статуса шага в `CLAUDE.md` |

Базы `mut_*`, оставшиеся от прогонов мутационной проверки, удалены.
