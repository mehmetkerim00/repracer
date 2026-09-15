# Хранение и удаление данных

Статус: 2026-09-14 · шаг 7 · три слоя [Р-20]; сроки intent, decision и свёртки цен — Р-27…Р-30, Р-38. Источники истины: `maintenance.retention_policy`, `security.table_registry`
([migrations/](../migrations/)), `schemas/clickhouse/010_tables.sql`. Обоснование — [ADR-0004](adr/0004-storage-tiering.md).

## 1. Слои

| Слой | Технология | Что хранит | Срок | Изоляция |
|---|---|---|---|---|
| **Горячий** | PostgreSQL (база на регион) | Всё, что нужно текущему решению: конфигурация, незавершённые записи, актуальные проекции, сырьё цен 90 дней, суточная свёртка цен (вечно) | По таблицам, раздел 3 | RLS, [ADR-0003](adr/0003-tenant-isolation.md) |
| **Аналитический** | ClickHouse (кластер на регион) | Наблюдения, снимки конкурентов, ответы каналов, комиссии, intent/decision, завершённые записи | ≤ 18 месяцев (TTL) | Шлюз + политики строк, [tenant-isolation-analytics.md](tenant-isolation-analytics.md) |
| **Архив** | Parquet в объектном хранилище (бакет на регион) | Только данные тенанта: сырьё наших цен старше 90 дней, завершённые записи (id, статус, время), ядро intent [Р-38] | Бессрочно; удаление = префикс тенанта + ключ | Префикс и ключ шифрования на тенанта |
| Брокер | Kafka-совместимый | События в пути | ≤ 7 дней | ACL сервисов, [ADR-0005](adr/0005-message-broker.md) |

**Правила, общие для всех слоёв:**
- Данные каналов (всё прочитанное из каналов и производное) — **не дольше 18 месяцев в любом слое**, в архив не попадают.
- Данные тенанта удаляются из горячего слоя по времени **только после подтверждённого экспорта** с совпадающим числом строк.
- PII покупателей не хранится нигде [Р-4].
- Решение о цене не читает ClickHouse и архив [Р-22].

## 2. Механизмы удаления

| Механизм | Где | Как |
|---|---|---|
| `DROP_PARTITION`, `MAX_AGE` | PostgreSQL | Партиция [M, M+шаг) удаляется, когда `M + (срок − запас) ≤ now()`: ни одна строка не старше срока |
| `DROP_PARTITION`, `MIN_AGE` | PostgreSQL | Партиция удаляется, когда `(M + шаг) + срок ≤ now()` **и** есть подтверждённый экспорт в каждый слой из `requires_export` с тем же числом строк. Для данных без юридической ценности — принудительно после `force_drop_after` (фиксируется как `PARTITION_FORCE_DROPPED`) |
| `DELETE_ROWS` | PostgreSQL | Пакетное удаление строк с якорем старше `now() − (срок − запас)` |
| `TENANT_CLOSURE_ONLY` | PostgreSQL | Только при закрытии тенанта |
| TTL `ttl_only_drop_parts` | ClickHouse | Месячная часть удаляется в `начало месяца + 18 мес − 14 дней` |
| Удаление префикса + уничтожение ключа | Архив | При закрытии тенанта |
| Retention топиков | Брокер | ≤ 7 дней |

Запас 14 дней для данных каналов покрывает срыв ежедневного запуска и срок резервных копий (≤ 7 дней, OQ-61).

Расписание PostgreSQL (ежедневно, логин планировщика — член `repracer_retention`):

```sql
SELECT maintenance.ensure_partitions();
SELECT maintenance.close_price_days();              -- ежечасно и до удаления партиций: закрывает прошедшие дни каждого часового пояса витрин (Р-29, Р-62); витрины без подтверждённого пояса пропускаются, секции сырья с их строками не удаляются (Р-65)
SELECT maintenance.drop_expired_partitions();       -- повторять, пока не вернёт 0 (не больше 10 партиций за вызов)
SELECT maintenance.delete_expired_rows();
SELECT maintenance.release_expired_reservations();  -- каждые несколько минут, повторять, пока не вернёт 0 (Р-25)
SELECT maintenance.alert_stale_confirmed_reservations(); -- ежедневно, повторять, пока не вернёт 0: алерт, не освобождение (Р-30)
```

Экспорт партиций (экспортёр, роль `repracer_exporter`) пишет факт в `maintenance.partition_export`; без него партиция
данных тенанта не удаляется. Каждое создание и удаление партиции и каждое пакетное удаление фиксируются в `maintenance.retention_run`.

## 3. Сущности

### 3.1 Горячий слой (PostgreSQL)

| Сущность | Класс | Срок | Механизм (якорь, разбиение) | Экспорт перед удалением | При закрытии тенанта |
|---|---|---|---|---|---|
| `tenant_data.tenant` | TENANT | Бессрочно | — | — | Надгробие: id, статус, даты; название обезличивается |
| `platform.app_user` | PLATFORM | Пока действует учётная запись | GDPR-процедура (вне шага) | — | Не удаляется (пользователь глобален) |
| `tenant_data.membership`, `channel_account`, `channel_capability_override` | TENANT | Бессрочно | Закрытие | — | Удаляются (этап 2) |
| `tenant_data.product`, `bundle_component`, `cost_profile`, `min_price`, `max_price`, `guardrail`, `pricing_strategy`, `divergence_policy` | TENANT | Бессрочно | Закрытие | — | Удаляются (этап 2) |
| `tenant_data.write_scope`, `write_scope_sync_state`, `offer_mapping` | TENANT | Бессрочно | Закрытие | — | Удаляются (этап 2) |
| `tenant_data.stock_source`, `inbound_api_key`, `stock_pool`, `stock_movement`, `stock_allocation` | TENANT | Бессрочно | Закрытие | — | Удаляются (этап 2) |
| `tenant_data.channel_write` | TENANT | Пока запись не завершена | Перенос в историю при завершении (триггер) | — | Удаляется (этап 2) |
| `tenant_data.channel_write_history` | TENANT (транзит) | ≥ 1 день | `DROP_PARTITION` `MIN_AGE` (`finished_at`, день) | **ClickHouse + архив** | Удаляется (этап 2); в ClickHouse и архиве — отдельно |
| **`tenant_data.price_history`** | TENANT | **≥ 90 дней** в горячем слое, затем архив | `DROP_PARTITION` `MIN_AGE` (`accepted_at`, месяц → HASH 8); партиция удаляется, только когда все её дни закрыты в `price_daily` (0025) | **Архив** | Только с явным подтверждением (OQ-22) |
| **`tenant_data.price_daily`** | TENANT | **Бессрочно** — доказательство Omnibus [Р-21] | Не удаляется; строится по закрытому дню и не меняется [Р-29] | — | Только с явным подтверждением (OQ-22) |
| `tenant_data.price_daily_correction` | TENANT | **Бессрочно** — поправки свёртки со ссылкой и причиной; итог — представление `price_daily_effective` [Р-29] | `TENANT_CLOSURE_ONLY` | — | Только с явным подтверждением (OQ-22) |
| **`tenant_data.price_intent_core`** | TENANT | **≥ 30 дней** в горячем слое, затем архив навсегда — ядро intent `CHANGED` и `REJECTED_BY_GATE` без входов с данными канала, со слепком объяснения решения `explanation` (без данных канала — ключи класса `CHANNEL` отклоняет CHECK); слепок `r80.1` не повторяет столбцы ядра и ссылается на справочник `platform.explanation_ruleset` и на версию `pricing_strategy` (FK; версия — без подреза, Р-91) — при закрытии тенанта ядро удаляется раньше стратегий; **архив тенанта содержит версии стратегий и наборы правил, на которые ссылаются его строки, — секция удаляется только после подтверждённого самодостаточного архива**; величины, из которых выводится цена конкурента, не хранятся: у отклонённой цены из данных конкурентов нет предложенной цены и отклонения, в слепке нет целей стратегий по рынку и подреза, ключи слепка проверяются по реестру fail-closed [Р-27, Р-38, Р-68, Р-75, Р-79, Р-80, Р-85, Р-91] | `DROP_PARTITION` `MIN_AGE` (`intent_created_at`, месяц → HASH 8) | **Архив** (с `explanation_dictionary_included`) | Только с явным подтверждением (OQ-22) |
| `tenant_data.price_stop` | TENANT | Бессрочно — остановки цен человеком: область, автор, заметка, снятие с автором и заметкой [Р-69, Р-70]; действующая — до снятия | `TENANT_CLOSURE_ONLY` | — | Удаляется (этап 2) |
| `tenant_data.product_vat_rate` | TENANT | Бессрочно — ставка НДС, объявленная продавцом на товаре; действующая — последняя версия, иначе ставка страны `platform.vat_rate_default` [Р-53] | `TENANT_CLOSURE_ONLY` | — | Удаляется (этап 2) |
| `tenant_data.outbox_event` | TENANT (транзит) | ≥ 2 дня | `DROP_PARTITION` `MIN_AGE` (`created_at`, день) | **Брокер** | Удаляется (этап 2) |
| `tenant_data.edit_budget` | TENANT (операционные счётчики) | 35 дней | `DELETE_ROWS` (`budget_day`) | — | Удаляется (этап 2) |
| `tenant_data.migration_consent`, `_item`, `_revocation` | TENANT | Бессрочно | Закрытие | — | **Копируются в `legal.migration_consent_record`**, затем удаляются [Р-26] |
| `legal.migration_consent_record` | LEGAL | **3 года после закрытия тенанта** | `DELETE_ROWS` (`tenant_closed_at`) | — | Создаётся при закрытии; минимум PII (id пользователя без email и имени) |
| `channel_data.price_intent` | CHANNEL | ≥ 3 дня; принудительно — 14 дней [Р-28] | `DROP_PARTITION` `MIN_AGE` (день) | **ClickHouse** (или принудительно); `NO_OP` — в `price_intent_noop` | Удаляется сразу (этап 1) |
| `channel_data.price_decision` | CHANNEL | ≥ 30 дней; принудительно — 45 дней [Р-28]; слепок объяснения `explanation` — только у решений CHANGED и REJECTED_BY_GATE, дублируется в вечное ядро `price_intent_core`; у NO_OP — только код причины `no_change_reason` [Р-68, Р-74] | `DROP_PARTITION` `MIN_AGE` (день) | **ClickHouse** (или принудительно) | Удаляется сразу (этап 1) |
| `channel_data.price_decision_snapshot_ref` | CHANNEL | 18 мес — ссылка решения на принятый снимок (идентификатор, источник, время наблюдения); пишется в транзакции решения; после срока объяснение остаётся в слепке ядра без полного снимка [Р-38, Р-68] | `DELETE_ROWS` (`decided_at`) | — | Удаляется сразу |
| `channel_data.pricing_strategy_undercut` | CHANNEL | Величина подреза версии стратегии: пока версия действует — хранится; после её замены — 18 мес, затем удаляется. В вечной версии стратегии (`tenant_data.pricing_strategy`, архив ядра) и в слепке объяснения подреза нет: с опубликованной ценой он давал цену конкурента [Р-91]. Единица, закреплённая за заменённой версией, после удаления подреза не оценивается (OQ-151) | `DELETE_ROWS` (`superseded_at`; действующие версии не удаляются) | — | Удаляется сразу (раньше `pricing_strategy`) |
| `channel_data.competitor_state` | CHANNEL | ≤ 18 мес; `sanity_summary` — итог проверки принятого снимка для пересчёта [Р-68] | `DELETE_ROWS` (`observed_at`) | — | Удаляется сразу |
| `channel_data.competitor_price_daily` | CHANNEL | 45 дней — история для проверки входов за 30 дней [Р-42] | `DELETE_ROWS` (`price_day`) | — | Удаляется сразу |
| `channel_data.competitor_move` | CHANNEL | 2 дня — окно массового сдвига [Р-42] | `DELETE_ROWS` (`evaluated_at`) | — | Удаляется сразу |
| `channel_data.competitor_move_latest` | CHANNEL | 2 дня — последнее движение каждого товара витрины, проекция окна сдвига (OQ-93); обновляется в транзакции снимка | `DELETE_ROWS` (`evaluated_at`) | — | Удаляется сразу |
| `platform.explanation_ruleset` | PLATFORM | Бессрочно — справочник слепков объяснения: наборы правил проверки входов и профили Gate; неизменяем (триггер), на него ссылаются вечные слепки [Р-75] | — | — | Не относится к тенанту |
| `platform.external_identity` | PLATFORM | Пока действует пользователь — привязка внешнего пользователя поставщика identity `(issuer, subject)` к `app_user`; паролей и сессий у нас нет (удалены 0048) [Р-78]; создаётся только приёмом приглашения [Р-88] | GDPR-процедура (вне шага), как `app_user` | — | Не удаляется (пользователь глобален) |
| `platform.identity_invitation` | PLATFORM | 30 дней после срока приглашения (не больше 14 дней от создания) — SHA-256 одноразового токена, пользователь, тенант, кто пригласил, когда и каким subject принято [Р-88] | `DELETE_ROWS` (`expires_at`) | — | Не относится к тенанту (строка тенанта удаляется с пользователем) |
| `platform.fx_rate` | PLATFORM | Бессрочно — дневные справочные курсы ЕЦБ; решение хранит курс, по которому переведена себестоимость [Р-61]; неизменяемы | — | — | Не относится к тенанту |
| `maintenance.outbox_relay_state` | SYSTEM | Бессрочно — водяной знак ретранслятора outbox [Р-34], одна строка на ретранслятор | — | — | Не относится к тенанту |
| `channel_data.rejected_competitor_snapshot` | CHANNEL | 45 дней — разбор инцидентов [Р-42] | `DELETE_ROWS` (`created_at`) | — | Удаляется сразу |
| `channel_data.pricing_halt` | CHANNEL | Только системная остановка (`CHANNEL_MASS_SHIFT`) [Р-69]; действующая — до снятия (автоматически по выборке или владельцем/оператором [Р-52]); снятая — 18 мес | `DELETE_ROWS` (`released_at`; действующие не удаляются) | — | Удаляется сразу |
| `channel_data.pricing_halt_review` | CHANNEL | 18 мес — журнал проверок выборкой и снятий остановки [Р-52] | `DELETE_ROWS` (`reviewed_at`) | — | Удаляется сразу (раньше `pricing_halt`) |
| `channel_data.observed_channel_state` | CHANNEL | ≤ 18 мес | `DELETE_ROWS` (`observed_at`) | — | Удаляется сразу |
| `channel_data.observed_price_daily` | CHANNEL | 45 дней [Р-28] | `DELETE_ROWS` (`price_day`) | — | Удаляется сразу |
| `channel_data.write_submission` | CHANNEL | До завершения записи, ≤ 30 дней | Триггер завершения; `DELETE_ROWS` (`submitted_at`) | — | Удаляется сразу |
| `channel_data.divergence_case`, `fee_estimate`, `sync_job`, `listing_migration_check` | CHANNEL | ≤ 18 мес | `DELETE_ROWS` | — | Удаляются сразу |
| `channel_data.reservation` | CHANNEL | Открытая — по Р-25 (TTL 24 ч для `CREATED`; `CONFIRMED_BY_SOURCE` старше 14 дней не освобождается — алерт [Р-30]); закрытая — 30 дней | TTL-процедура; `DELETE_ROWS` (`closed_at`) | — | Удаляется сразу |
| `audit.audit_event` | AUDIT | 18 мес (≥ 12 по DPP); сюда же — остановки цен человеком и системные остановки с автором, ролью, заметкой и областью [Р-76], хотя сама `price_stop` хранится до закрытия тенанта | `DROP_PARTITION` `MAX_AGE` (месяц) | — | Истекает по сроку |
| `maintenance.partition_export`, `retention_run`, `tenant_purge_status`, `price_day_close` | SYSTEM | Бессрочно | — | — | Остаются как доказательство исполнения |

### 3.2 Аналитический слой (ClickHouse)

| Таблица | Класс | Срок | Механизм | При закрытии тенанта |
|---|---|---|---|---|
| `channel_observation` | данные канала | 18 мес − 14 дн от месяца `received_at` | TTL | `DELETE WHERE tenant_id` |
| `competitor_snapshot` | данные канала | то же | TTL | то же |
| `channel_write_response` | данные канала | то же | TTL | то же |
| `fee_actual` | данные канала | то же (от `posted_at`) | TTL | то же |
| `price_intent`, `price_decision` (`CHANGED`, `REJECTED_BY_GATE`) | данные канала | то же | TTL | то же |
| `price_intent_noop` | данные канала | 8 дней от дня `created_at` (сырьё `NO_OP` ≥ 7 дней) [Р-27] | TTL, дневные части | то же |
| `price_intent_noop_hourly` (по коду причины, правилу и триггеру [Р-81]) | данные канала | 18 мес − 14 дн от месяца `hour` | TTL | то же |
| `channel_write_completed` | данные тенанта (копия) | то же | TTL; бессрочно — архив | то же |

### 3.3 Архив

| Набор | Класс | Срок | Содержимое | При закрытии тенанта |
|---|---|---|---|---|
| `dataset=price_history` | данные тенанта | Бессрочно | Все столбцы сырья наших цен | Удаление префикса + уничтожение ключа |
| `dataset=channel_write` | данные тенанта | Бессрочно | id записи, единица, поле, версия, значение, итоговый статус, времена [Р-17] | То же |
| `dataset=price_intent_core` | данные тенанта | Бессрочно | Ядро intent: единица, предложенная цена, правило, опорное значение, итог Gate — без входов с данными канала [Р-38] | То же |

## 4. Закрытие тенанта

| Шаг | Статус | Действие | Отметка в `tenant_purge_status` |
|---|---|---|---|
| 1 | `OFFBOARDING` | Отключение каналов, удаление секретов, остановка записей | — |
| 2 | `OFFBOARDING` | `maintenance.purge_tenant_channel_data(tenant)` | `postgres_channel_purged_at` |
| 3 | `OFFBOARDING` | Экспорт данных клиенту (шлюз, только его данные) | — |
| 4 | `CLOSED` | Перевод в `CLOSED` | — |
| 5 | `CLOSED` | `maintenance.purge_tenant_data(tenant, p_delete_price_history)`: согласия eBay → `legal`, затем удаление; доказательства цен (`price_history`, `price_daily`, поправки, `price_intent_core`) — только при `p_delete_price_history = true` (OQ-22) | `postgres_tenant_purged_at`, `legal_hold_until` |
| 6 | `CLOSED` | ClickHouse: удаление строк тенанта во всех таблицах, проверка нуля | `clickhouse_purged_at` |
| 7 | `CLOSED` | Архив: удаление префикса и ключа тенанта | `archive_prefix_deleted_at`, `archive_key_destroyed_at` |
| 8 | — | Брокер: данные исчезают по retention (≤ 7 дней) | — |
| 9 | — | Через 3 года — удаление `legal.migration_consent_record` по сроку | — |

Льготный период между шагами 4 и 5 и судьба доказательств цен — OQ-22.

## 5. Вне трёх слоёв

| Хранилище | Требование |
|---|---|
| Резервные копии PostgreSQL и ClickHouse | ≤ 7 дней (иначе данные каналов переживут 18 месяцев в копиях) — OQ-61 |
| Логи приложений | ≥ 12 мес, ≤ 18 мес при наличии производных от данных Amazon; без PII и секретов |
| Хранилище секретов | Удаление при отключении аккаунта канала |
