-- 099_verify.sql
-- Проверки аналитического слоя. Каждый запрос должен вернуть 0 строк; иначе развёртывание считается неуспешным.

-- 1. Таблица без политики изоляции тенантов для роли чтения
SELECT t.name AS table_without_tenant_policy
FROM system.tables AS t
WHERE t.database = 'repracer_analytics' AND t.engine LIKE '%MergeTree'
  AND t.name NOT IN (SELECT table FROM system.row_policies
                     WHERE database = 'repracer_analytics' AND short_name = 'tenant_isolation');

-- 2. Первый столбец ключа сортировки — не tenant_id
SELECT name AS table_not_ordered_by_tenant, sorting_key
FROM system.tables
WHERE database = 'repracer_analytics' AND engine LIKE '%MergeTree' AND NOT startsWith(sorting_key, 'tenant_id');

-- 3. Таблица без TTL (все данные слоя ограничены 18 месяцами)
SELECT name AS table_without_ttl
FROM system.tables
WHERE database = 'repracer_analytics' AND engine LIKE '%MergeTree' AND positionCaseInsensitive(create_table_query, ' TTL ') = 0;

-- 4. Роль чтения получила что-то кроме SELECT (источники, табличные функции, временные таблицы, DDL)
SELECT role_name, access_type, database, table
FROM system.grants
WHERE role_name = 'repracer_tenant_reader' AND access_type != 'SELECT';

-- 5. Роль записи может читать
SELECT role_name, access_type, database, table
FROM system.grants
WHERE role_name = 'repracer_ingest' AND access_type NOT IN ('INSERT');

-- 6. Р-81: почасовой агрегат NO_OP хранит код причины в ключе — иначе после 7 дней «почему цена не менялась» без ответа
SELECT name AS noop_hourly_without_reason, sorting_key
FROM system.tables
WHERE database = 'repracer_analytics' AND name = 'price_intent_noop_hourly' AND position(sorting_key, 'no_change_reason') = 0;

-- 7. Шаг 20: материализованное представление выполняется правами вставляющего — роль записи без чтения не сможет вставить
SELECT name AS mv_without_definer_security
FROM system.tables
WHERE database = 'repracer_analytics' AND engine = 'MaterializedView' AND positionCaseInsensitive(create_table_query, 'SQL SECURITY DEFINER') = 0;

-- 8. Шаг 20: пользователь-определитель представлений может войти
SELECT name AS mv_definer_can_log_in
FROM system.users
WHERE name = 'repracer_mv_definer' AND (length(host_ip) > 0 OR length(host_names) > 0 OR length(host_names_regexp) > 0 OR length(host_names_like) > 0);
