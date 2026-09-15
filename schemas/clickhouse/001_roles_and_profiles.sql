-- 001_roles_and_profiles.sql
-- Аналитический слой [Р-20, Р-22, Р-23]. Отдельный кластер ClickHouse на регион (EU, US) — как базы PostgreSQL [Р-16].
-- Выполняет администратор кластера. Логины создаёт ops и назначает им роли ниже; людям и тенантам логины не выдаются.
-- Пользовательская настройка SQL_tenant_id требует префикса SQL_ в custom_settings_prefixes (значение по умолчанию; проверить на целевой версии).

CREATE DATABASE IF NOT EXISTS repracer_analytics;

-- Запись: потребитель брокера и экспортёр партиций PostgreSQL. Без чтения.
CREATE ROLE IF NOT EXISTS repracer_ingest;
GRANT INSERT ON repracer_analytics.* TO repracer_ingest;

-- Чтение одного тенанта: только шлюз аналитики (симулятор, бэктест, отчёты). Строки ограничены политикой 020.
CREATE ROLE IF NOT EXISTS repracer_tenant_reader;
GRANT SELECT ON repracer_analytics.* TO repracer_tenant_reader;

-- Удаление данных тенанта при закрытии (lightweight DELETE требует ALTER DELETE).
CREATE ROLE IF NOT EXISTS repracer_retention;
GRANT SELECT, ALTER DELETE ON repracer_analytics.* TO repracer_retention;

-- DDL. Чтение бизнес-данных не выдаётся.
CREATE ROLE IF NOT EXISTS repracer_analytics_admin;
GRANT CREATE TABLE, DROP TABLE, ALTER TABLE, CREATE ROW POLICY, ALTER ROW POLICY, DROP ROW POLICY
  ON repracer_analytics.* TO repracer_analytics_admin;

-- Профиль шлюза: только чтение, без DDL, настройки менять можно (нужно для SQL_tenant_id), readonly — нельзя.
-- Роль не получает CREATE TEMPORARY TABLE и источники (S3, URL, FILE, REMOTE, ...): табличные функции недоступны,
-- выгрузка «мимо шлюза» невозможна.
CREATE SETTINGS PROFILE IF NOT EXISTS repracer_tenant_reader_profile
  SETTINGS readonly = 2 CONST,
           allow_ddl = 0 CONST,
           allow_introspection_functions = 0 CONST,
           max_execution_time = 60,
           max_result_rows = 1000000,
           SQL_tenant_id = ''
  TO repracer_tenant_reader;

CREATE SETTINGS PROFILE IF NOT EXISTS repracer_ingest_profile
  SETTINGS allow_ddl = 0 CONST,
           async_insert = 1
  TO repracer_ingest;
