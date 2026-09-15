-- 0012_retention.sql
-- Хранение: политики сроков, создание и удаление партиций, построчное удаление, закрытие тенанта.
-- Запуск по расписанию (раз в сутки) — логин планировщика, член repracer_retention:
--   SELECT maintenance.ensure_partitions();
--   SELECT maintenance.drop_expired_partitions();  -- повторять, пока не вернёт 0 (не больше p_limit партиций за вызов)
--   SELECT maintenance.delete_expired_rows();
-- Выбор планировщика (pg_cron или внешний) — шаг 4.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- Политики
-- retention      — жёсткий максимум возраста строки.
-- safety_margin  — запас на срыв ежедневного запуска и срок хранения резервных копий:
--                  партиция месяца M удаляется, как только M + (retention - safety_margin) <= now().
--                  Итог при 18 мес и запасе 14 дней: строки живут ~16.5–17.5 мес, никогда > 18.
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance.retention_policy (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  table_name    regclass PRIMARY KEY,
  method        text NOT NULL CHECK (method IN ('DROP_PARTITION', 'DELETE_ROWS', 'TENANT_CLOSURE_ONLY')),
  anchor_column text,
  retention     interval,
  safety_margin interval NOT NULL DEFAULT interval '14 days',
  hash_modulus  int CHECK (hash_modulus > 1),
  backfill      boolean NOT NULL DEFAULT false,
  months_ahead  int NOT NULL DEFAULT 3 CHECK (months_ahead >= 1),
  drop_order    int NOT NULL DEFAULT 100,
  CHECK ((method = 'TENANT_CLOSURE_ONLY') = (retention IS NULL AND anchor_column IS NULL)),
  CHECK (retention IS NULL OR retention > safety_margin),
  CHECK (method = 'DROP_PARTITION' OR hash_modulus IS NULL)
);

INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, hash_modulus, backfill, drop_order) VALUES
  -- CHANNEL: партиции по месяцу
  ('channel_data.channel_observation',     'DROP_PARTITION', 'received_at',       '18 months', '14 days', 16, false, 50),
  ('channel_data.competitor_snapshot',     'DROP_PARTITION', 'received_at',       '18 months', '14 days', 16, false, 50),
  ('channel_data.price_decision',          'DROP_PARTITION', 'intent_created_at', '18 months', '14 days', 16, false, 10),
  ('channel_data.price_intent',            'DROP_PARTITION', 'created_at',        '18 months', '14 days', 16, false, 20),
  ('channel_data.channel_write_response',  'DROP_PARTITION', 'received_at',       '18 months', '14 days', 16, false, 50),
  ('channel_data.fee_actual',              'DROP_PARTITION', 'posted_at',         '18 months', '14 days', 16, true,  50),
  -- CHANNEL: построчно
  ('channel_data.observed_channel_state',  'DELETE_ROWS',    'observed_at',       '18 months', '14 days', NULL, false, 60),
  ('channel_data.divergence_case',         'DELETE_ROWS',    'opened_at',         '18 months', '14 days', NULL, false, 60),
  ('channel_data.fee_estimate',            'DELETE_ROWS',    'computed_at',       '18 months', '14 days', NULL, false, 60),
  ('channel_data.reservation',             'DELETE_ROWS',    'created_at',        '18 months', '14 days', NULL, false, 60),
  ('channel_data.sync_job',                'DELETE_ROWS',    'created_at',        '18 months', '14 days', NULL, false, 60),
  ('channel_data.listing_migration_check', 'DELETE_ROWS',    'checked_at',        '18 months', '14 days', NULL, false, 60),
  -- AUDIT
  ('audit.audit_event',                    'DROP_PARTITION', 'recorded_at',       '18 months', '14 days', NULL, false, 90),
  -- TENANT, операционные счётчики без юридической ценности
  ('tenant_data.edit_budget',              'DELETE_ROWS',    'budget_day',        '35 days',   '0 days',  NULL, false, 95);

INSERT INTO maintenance.retention_policy (table_name, method)
SELECT table_name, 'TENANT_CLOSURE_ONLY'
  FROM security.table_registry
 WHERE storage_class = 'TENANT' AND table_name <> 'tenant_data.edit_budget'::regclass;

SELECT security.register_table('maintenance.retention_policy', 'SYSTEM', 'mutable', 'none');
CREATE POLICY retention_policy_owner ON maintenance.retention_policy TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY retention_policy_read ON maintenance.retention_policy FOR SELECT TO repracer_retention USING (true);
REVOKE ALL ON maintenance.retention_policy FROM repracer_app;
GRANT SELECT ON maintenance.retention_policy TO repracer_retention;

-- Журнал удалений — доказательство исполнения сроков DPP
CREATE TABLE maintenance.retention_run (
  tenant_id       uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  retention_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executed_at     timestamptz NOT NULL DEFAULT now(),
  table_name      text NOT NULL,
  action          text NOT NULL CHECK (action IN ('PARTITION_CREATED', 'PARTITION_DROPPED', 'ROWS_DELETED', 'TENANT_PURGED')),
  object_name     text,
  cutoff          timestamptz,
  rows_affected   bigint,
  subject_tenant_id uuid
);

SELECT security.register_table('maintenance.retention_run', 'SYSTEM', 'append_only', 'none');
CREATE POLICY retention_run_owner ON maintenance.retention_run TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY retention_run_retention ON maintenance.retention_run TO repracer_retention USING (true) WITH CHECK (true);
REVOKE ALL ON maintenance.retention_run FROM repracer_app;
GRANT SELECT, INSERT ON maintenance.retention_run TO repracer_retention;

-- ---------------------------------------------------------------------------
-- Доступ роли хранения: чтение и удаление во всех тенантных, канальных и аудиторских таблицах.
-- Роль NOLOGIN; append-only таблицы удаляются только внутри её SECURITY DEFINER-функций (security.forbid_mutation).
-- Новые таблицы после 0012 обязаны вызвать security.grant_retention().
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.grant_retention(p_table regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE POLICY retention_read ON %s FOR SELECT TO repracer_retention USING (true)', p_table);
  EXECUTE format('CREATE POLICY retention_delete ON %s FOR DELETE TO repracer_retention USING (true)', p_table);
  EXECUTE format('GRANT SELECT, DELETE ON %s TO repracer_retention', p_table);
END $$;

SELECT security.grant_retention(table_name)
  FROM security.table_registry
 WHERE storage_class IN ('TENANT', 'CHANNEL', 'AUDIT');

-- Надгробие закрытого тенанта: обезличивание названия
CREATE POLICY retention_tombstone ON tenant_data.tenant FOR UPDATE TO repracer_retention USING (true) WITH CHECK (true);
GRANT UPDATE (name, status, closed_at) ON tenant_data.tenant TO repracer_retention;

-- ---------------------------------------------------------------------------
-- Партиции: создание (владелец, DDL)
-- ---------------------------------------------------------------------------
CREATE FUNCTION maintenance.ensure_partitions(p_now timestamptz DEFAULT now()) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p        record;
  m        timestamptz;
  last_m   timestamptz;
  part     text;
  sub      text;
  i        int;
  created  int := 0;
  cur_m    timestamptz := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  FOR p IN SELECT rp.*, c.relname, n.nspname
             FROM maintenance.retention_policy rp
             JOIN pg_class c ON c.oid = rp.table_name
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE rp.method = 'DROP_PARTITION'
  LOOP
    last_m := cur_m + make_interval(months => p.months_ahead);
    IF p.backfill THEN
      -- Первый месяц, который ещё не подлежит удалению
      m := date_trunc('month', (p_now - (p.retention - p.safety_margin)) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
      IF m + (p.retention - p.safety_margin) <= p_now THEN
        m := m + interval '1 month';
      END IF;
    ELSE
      m := cur_m - interval '1 month';
    END IF;

    WHILE m <= last_m LOOP
      part := format('%I.%I', p.nspname,
                     p.relname || '_y' || to_char(m AT TIME ZONE 'UTC', 'YYYY') || 'm' || to_char(m AT TIME ZONE 'UTC', 'MM'));
      IF to_regclass(part) IS NULL AND m + (p.retention - p.safety_margin) > p_now THEN
        IF p.hash_modulus IS NULL THEN
          EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
                         part, p.table_name, m, m + interval '1 month');
        ELSE
          EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (tenant_id)',
                         part, p.table_name, m, m + interval '1 month');
          FOR i IN 0 .. p.hash_modulus - 1 LOOP
            sub := format('%I.%I', p.nspname,
                          p.relname || '_y' || to_char(m AT TIME ZONE 'UTC', 'YYYY') || 'm'
                          || to_char(m AT TIME ZONE 'UTC', 'MM') || '_h' || lpad(i::text, 2, '0'));
            EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                           sub, part, p.hash_modulus, i);
            PERFORM security.protect_partition(sub::regclass);
          END LOOP;
        END IF;
        PERFORM security.protect_partition(part::regclass);
        INSERT INTO maintenance.retention_run (table_name, action, object_name, cutoff)
        VALUES (p.table_name::text, 'PARTITION_CREATED', part, m);
        created := created + 1;
      END IF;
      m := m + interval '1 month';
    END LOOP;
  END LOOP;
  RETURN created;
END $$;

-- ---------------------------------------------------------------------------
-- Партиции: удаление по сроку (владелец, DDL). Зависимые таблицы — раньше (drop_order).
-- ---------------------------------------------------------------------------
CREATE FUNCTION maintenance.drop_expired_partitions(p_now timestamptz DEFAULT now(), p_limit int DEFAULT 10) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p       record;
  c       record;
  lower_b timestamptz;
  dropped int := 0;
BEGIN
  FOR p IN SELECT * FROM maintenance.retention_policy WHERE method = 'DROP_PARTITION' ORDER BY drop_order LOOP
    FOR c IN SELECT ch.oid::regclass AS part, pg_get_expr(ch.relpartbound, ch.oid) AS bound
               FROM pg_inherits i JOIN pg_class ch ON ch.oid = i.inhrelid
              WHERE i.inhparent = p.table_name
    LOOP
      lower_b := substring(c.bound FROM $re$FROM \('([^']+)'\)$re$)::timestamptz;
      IF lower_b IS NOT NULL AND lower_b + (p.retention - p.safety_margin) <= p_now THEN
        -- DETACH проверяет отсутствие ссылающихся строк (FK price_decision -> price_intent) и снимает зависимость
        EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', p.table_name, c.part);
        EXECUTE format('DROP TABLE %s', c.part);
        INSERT INTO maintenance.retention_run (table_name, action, object_name, cutoff)
        VALUES (p.table_name::text, 'PARTITION_DROPPED', c.part::text, lower_b);
        dropped := dropped + 1;
        -- Не больше p_limit месячных партиций за вызов: каждая с подпартициями и индексами берёт десятки блокировок
        IF dropped >= p_limit THEN
          RETURN dropped;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  RETURN dropped;
END $$;

REVOKE ALL ON FUNCTION maintenance.ensure_partitions(timestamptz), maintenance.drop_expired_partitions(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.ensure_partitions(timestamptz), maintenance.drop_expired_partitions(timestamptz, int)
  TO repracer_retention;

-- ---------------------------------------------------------------------------
-- Построчное удаление по сроку и закрытие тенанта (роль хранения)
-- ---------------------------------------------------------------------------
CREATE FUNCTION maintenance.delete_expired_rows(p_now timestamptz DEFAULT now(), p_batch int DEFAULT 10000) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p      record;
  cutoff timestamptz;
  n      bigint;
  total  bigint := 0;
  tbl    bigint;
BEGIN
  FOR p IN SELECT * FROM maintenance.retention_policy WHERE method = 'DELETE_ROWS' ORDER BY drop_order LOOP
    cutoff := p_now - (p.retention - p.safety_margin);
    tbl := 0;
    LOOP
      EXECUTE format('DELETE FROM %s WHERE ctid = ANY (ARRAY(SELECT ctid FROM %s WHERE %I < $1 LIMIT $2))',
                     p.table_name, p.table_name, p.anchor_column)
        USING cutoff, p_batch;
      GET DIAGNOSTICS n = ROW_COUNT;
      tbl := tbl + n;
      EXIT WHEN n < p_batch;
    END LOOP;
    IF tbl > 0 THEN
      INSERT INTO maintenance.retention_run (table_name, action, cutoff, rows_affected)
      VALUES (p.table_name::text, 'ROWS_DELETED', cutoff, tbl);
    END IF;
    total := total + tbl;
  END LOOP;
  RETURN total;
END $$;

-- Этап 1 закрытия: данные каналов удаляются сразу (тенант в OFFBOARDING или CLOSED).
CREATE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  -- Порядок: зависимые раньше
  FOREACH t IN ARRAY ARRAY[
    'channel_data.channel_write_response', 'channel_data.price_decision', 'channel_data.price_intent',
    'channel_data.channel_observation', 'channel_data.observed_channel_state', 'channel_data.divergence_case',
    'channel_data.competitor_snapshot', 'channel_data.fee_estimate', 'channel_data.fee_actual',
    'channel_data.reservation', 'channel_data.sync_job', 'channel_data.listing_migration_check']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

-- Этап 2 закрытия: данные тенанта. Аудит не удаляется — истекает по своему сроку.
-- Судьба PriceHistory не решена (OQ-22): без явного подтверждения функция отказывает, если история есть.
CREATE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false) RETURNS bigint
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF EXISTS (SELECT 1 FROM channel_data.reservation WHERE tenant_id = p_tenant_id)
     OR EXISTS (SELECT 1 FROM channel_data.sync_job WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  IF NOT p_delete_price_history AND EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'tenant % has price_history; deletion requires explicit confirmation (OQ-22)', p_tenant_id;
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'tenant_data.price_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    'tenant_data.min_price', 'tenant_data.guardrail', 'tenant_data.divergence_policy', 'tenant_data.cost_profile',
    'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $$;

REVOKE ALL ON FUNCTION maintenance.delete_expired_rows(timestamptz, int),
                       maintenance.purge_tenant_channel_data(uuid),
                       maintenance.purge_tenant_data(uuid, boolean) FROM PUBLIC;

RESET ROLE;

-- Владелец функций удаления — роль хранения (DELETE в append-only разрешён только ей).
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
ALTER FUNCTION maintenance.delete_expired_rows(timestamptz, int) OWNER TO repracer_retention;
ALTER FUNCTION maintenance.purge_tenant_channel_data(uuid) OWNER TO repracer_retention;
ALTER FUNCTION maintenance.purge_tenant_data(uuid, boolean) OWNER TO repracer_retention;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;

SET ROLE repracer_owner;
SELECT maintenance.ensure_partitions();
RESET ROLE;

COMMIT;
