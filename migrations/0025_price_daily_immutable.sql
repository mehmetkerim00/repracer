-- 0025_price_daily_immutable.sql
-- Р-29: суточная свёртка неизменяема. Строится один раз по закрытому дню (Europe/Berlin) заданием закрытия;
-- исправление — добавочная строка-поправка со ссылкой и причиной; итог — представление price_daily_effective.
-- Внутри дня решение о цене опирается на сырьё price_history (90 дней в горячем слое).
-- Партиция сырья удаляется, только когда все её дни закрыты.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Свёртка больше не расширяется в течение дня
-- ---------------------------------------------------------------------------
DROP TRIGGER price_history_rollup ON tenant_data.price_history;
DROP FUNCTION tenant_data.price_history_rollup();

DROP TRIGGER a_price_daily_only_from_trigger ON tenant_data.price_daily;
DROP TRIGGER b_price_daily_restrict_update ON tenant_data.price_daily;
DROP TRIGGER c_price_daily_guard ON tenant_data.price_daily;
DROP TRIGGER zz_price_daily_no_delete ON tenant_data.price_daily;
DROP TRIGGER zz_price_daily_no_truncate ON tenant_data.price_daily;
DROP FUNCTION tenant_data.price_daily_guard();

UPDATE security.table_registry SET mutation_mode = 'append_only' WHERE table_name = 'tenant_data.price_daily'::regclass;
CREATE TRIGGER zz_append_only BEFORE UPDATE OR DELETE ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();
CREATE TRIGGER zz_no_truncate BEFORE TRUNCATE ON tenant_data.price_daily
  FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate();

-- Приложение только читает свёртку; пишет задание закрытия дня (repracer_retention)
REVOKE INSERT, UPDATE ON tenant_data.price_daily FROM repracer_app;
CREATE POLICY retention_close_day ON tenant_data.price_daily FOR INSERT TO repracer_retention WITH CHECK (true);
GRANT INSERT ON tenant_data.price_daily TO repracer_retention;

-- ---------------------------------------------------------------------------
-- 2. Журнал закрытых дней — доказательство полноты свёртки
-- ---------------------------------------------------------------------------
CREATE TABLE maintenance.price_day_close (
  tenant_id     uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  price_day     date PRIMARY KEY,
  day_tz        text NOT NULL DEFAULT 'Europe/Berlin' CHECK (day_tz = 'Europe/Berlin'),
  closed_at     timestamptz NOT NULL DEFAULT now(),
  rows_inserted bigint NOT NULL CHECK (rows_inserted >= 0)
);

SELECT security.register_table('maintenance.price_day_close', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON maintenance.price_day_close FROM repracer_app;
CREATE POLICY price_day_close_owner ON maintenance.price_day_close TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY price_day_close_retention ON maintenance.price_day_close TO repracer_retention USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON maintenance.price_day_close TO repracer_retention;

-- ---------------------------------------------------------------------------
-- 3. Поправки [Р-29]: цепочка без ветвлений — каждая следующая поправка дня заменяет текущую голову
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_daily_correction (
  tenant_id                 uuid   NOT NULL,
  price_daily_correction_id uuid   NOT NULL DEFAULT gen_random_uuid(),
  write_scope_id            uuid   NOT NULL,
  price_type                text   NOT NULL,
  price_day                 date   NOT NULL,
  min_amount_minor          bigint NOT NULL CHECK (min_amount_minor > 0),
  max_amount_minor          bigint NOT NULL,
  first_amount_minor        bigint NOT NULL,
  first_accepted_at         timestamptz NOT NULL,
  last_amount_minor         bigint NOT NULL,
  last_accepted_at          timestamptz NOT NULL,
  change_count              int    NOT NULL CHECK (change_count >= 1),
  min_floor_minor           bigint NOT NULL CHECK (min_floor_minor > 0),
  reason                    text   NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
  supersedes_correction_id  uuid,
  created_by_membership_id  uuid   NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, price_daily_correction_id),
  FOREIGN KEY (tenant_id, write_scope_id, price_type, price_day)
    REFERENCES tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day),
  FOREIGN KEY (tenant_id, supersedes_correction_id)
    REFERENCES tenant_data.price_daily_correction (tenant_id, price_daily_correction_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CHECK (min_amount_minor <= first_amount_minor AND first_amount_minor <= max_amount_minor),
  CHECK (min_amount_minor <= last_amount_minor AND last_amount_minor <= max_amount_minor),
  CHECK (first_accepted_at <= last_accepted_at),
  CHECK (min_amount_minor >= min_floor_minor)
);

-- Одна поправка может быть заменена только одной (линейная цепочка)
CREATE UNIQUE INDEX price_daily_correction_supersedes_uq
  ON tenant_data.price_daily_correction (tenant_id, supersedes_correction_id) WHERE supersedes_correction_id IS NOT NULL;
-- Итоговое представление: действующая поправка дня
CREATE INDEX price_daily_correction_day_idx
  ON tenant_data.price_daily_correction (tenant_id, write_scope_id, price_type, price_day, created_at DESC);

CREATE FUNCTION tenant_data.price_daily_correction_chain_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  head uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    concat_ws('|', NEW.tenant_id, NEW.write_scope_id, NEW.price_type, NEW.price_day), 0));
  SELECT c.price_daily_correction_id INTO head
    FROM tenant_data.price_daily_correction c
   WHERE c.tenant_id = NEW.tenant_id AND c.write_scope_id = NEW.write_scope_id
     AND c.price_type = NEW.price_type AND c.price_day = NEW.price_day
     AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_correction s
                      WHERE s.tenant_id = c.tenant_id AND s.supersedes_correction_id = c.price_daily_correction_id);
  IF NEW.supersedes_correction_id IS DISTINCT FROM head THEN
    RAISE EXCEPTION 'correction must supersede the current correction % of this day', head
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER a_price_daily_correction_chain BEFORE INSERT ON tenant_data.price_daily_correction
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_daily_correction_chain_guard();

SELECT security.register_table('tenant_data.price_daily_correction', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.price_daily_correction');
INSERT INTO maintenance.retention_policy (table_name, method) VALUES ('tenant_data.price_daily_correction', 'TENANT_CLOSURE_ONLY');

-- Итог: базовая свёртка с действующей поправкой. security_invoker — RLS применяется от имени читающего.
CREATE VIEW tenant_data.price_daily_effective WITH (security_invoker = true) AS
SELECT d.tenant_id, d.write_scope_id, d.price_type, d.price_day, d.day_tz, d.currency, d.price_basis,
       coalesce(c.min_amount_minor,   d.min_amount_minor)   AS min_amount_minor,
       coalesce(c.max_amount_minor,   d.max_amount_minor)   AS max_amount_minor,
       coalesce(c.first_amount_minor, d.first_amount_minor) AS first_amount_minor,
       coalesce(c.first_accepted_at,  d.first_accepted_at)  AS first_accepted_at,
       coalesce(c.last_amount_minor,  d.last_amount_minor)  AS last_amount_minor,
       coalesce(c.last_accepted_at,   d.last_accepted_at)   AS last_accepted_at,
       coalesce(c.change_count,       d.change_count)       AS change_count,
       coalesce(c.min_floor_minor,    d.min_floor_minor)    AS min_floor_minor,
       c.price_daily_correction_id                          AS correction_id,
       c.reason                                             AS correction_reason,
       (c.price_daily_correction_id IS NOT NULL)            AS corrected
  FROM tenant_data.price_daily d
  LEFT JOIN LATERAL (
    SELECT x.*
      FROM tenant_data.price_daily_correction x
     WHERE x.tenant_id = d.tenant_id AND x.write_scope_id = d.write_scope_id
       AND x.price_type = d.price_type AND x.price_day = d.price_day
       AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily_correction s
                        WHERE s.tenant_id = x.tenant_id AND s.supersedes_correction_id = x.price_daily_correction_id)
  ) c ON true;

GRANT SELECT ON tenant_data.price_daily_effective TO repracer_app, repracer_retention;

-- ---------------------------------------------------------------------------
-- 4. Закрытие дней (планировщик, ежедневно после 01:00 Europe/Berlin)
-- ---------------------------------------------------------------------------
RESET ROLE;
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

CREATE FUNCTION maintenance.close_price_days(p_now timestamptz DEFAULT now(), p_max_days int DEFAULT 7) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  local_today date := (p_now AT TIME ZONE 'Europe/Berlin')::date;
  next_day    date;
  day_start   timestamptz;
  day_end     timestamptz;
  inserted    bigint;
  closed      int := 0;
BEGIN
  SELECT max(price_day) + 1 INTO next_day FROM maintenance.price_day_close;
  IF next_day IS NULL THEN
    SELECT min((accepted_at AT TIME ZONE 'Europe/Berlin')::date) INTO next_day FROM tenant_data.price_history;
  END IF;
  IF next_day IS NULL THEN
    RETURN 0;
  END IF;

  WHILE closed < p_max_days LOOP
    day_start := next_day::timestamp AT TIME ZONE 'Europe/Berlin';
    day_end   := (next_day + 1)::timestamp AT TIME ZONE 'Europe/Berlin';
    -- День закрывается через час после полуночи: запись цены попадает в день принятия каналом (accepted_at = now())
    EXIT WHEN next_day >= local_today OR p_now < day_end + interval '1 hour';

    INSERT INTO tenant_data.price_daily
      (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
       first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
    SELECT h.tenant_id, h.write_scope_id, h.price_type, next_day, 'Europe/Berlin', h.currency, h.price_basis,
           min(h.amount_minor), max(h.amount_minor),
           (array_agg(h.amount_minor ORDER BY h.accepted_at, h.price_history_id))[1], min(h.accepted_at),
           (array_agg(h.amount_minor ORDER BY h.accepted_at DESC, h.price_history_id DESC))[1], max(h.accepted_at),
           count(*), min(h.effective_min_price_minor)
      FROM tenant_data.price_history h
     WHERE h.accepted_at >= day_start AND h.accepted_at < day_end
       -- Исправленные строки сырья заменяются исправляющими
       AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c
                        WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
     GROUP BY h.tenant_id, h.write_scope_id, h.price_type, h.currency, h.price_basis
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted = ROW_COUNT;

    INSERT INTO maintenance.price_day_close (price_day, rows_inserted) VALUES (next_day, inserted);
    closed := closed + 1;
    next_day := next_day + 1;
  END LOOP;
  RETURN closed;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;
REVOKE ALL ON FUNCTION maintenance.close_price_days(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.close_price_days(timestamptz, int) TO repracer_retention;

-- ---------------------------------------------------------------------------
-- 5. Партиция сырья цен не удаляется, пока не закрыты все её дни
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION maintenance.drop_expired_partitions(p_now timestamptz DEFAULT now(), p_limit int DEFAULT 10) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  pol      maintenance.retention_policy;
  c        record;
  lower_b  timestamptz;
  upper_b  timestamptz;
  rows_now bigint;
  exported boolean;
  forced   boolean;
  dropped  int := 0;
BEGIN
  FOR pol IN SELECT * FROM maintenance.retention_policy WHERE method = 'DROP_PARTITION' ORDER BY drop_order LOOP
    FOR c IN SELECT ch.oid::regclass AS part, pg_get_expr(ch.relpartbound, ch.oid) AS bound
               FROM pg_inherits i JOIN pg_class ch ON ch.oid = i.inhrelid
              WHERE i.inhparent = pol.table_name
    LOOP
      lower_b := substring(c.bound FROM $re$FROM \('([^']+)'\)$re$)::timestamptz;
      upper_b := substring(c.bound FROM $re$TO \('([^']+)'\)$re$)::timestamptz;
      CONTINUE WHEN lower_b IS NULL OR NOT maintenance.partition_due(pol, lower_b, upper_b, p_now);

      -- Р-29: сырьё цен — источник вечной свёртки; все местные дни партиции должны быть закрыты
      IF pol.table_name = 'tenant_data.price_history'::regclass AND EXISTS (
           SELECT 1 FROM generate_series((lower_b AT TIME ZONE 'Europe/Berlin')::date,
                                         (upper_b AT TIME ZONE 'Europe/Berlin')::date, interval '1 day') AS d(day)
            WHERE NOT EXISTS (SELECT 1 FROM maintenance.price_day_close pc WHERE pc.price_day = d.day::date)) THEN
        CONTINUE;
      END IF;

      exported := true;
      forced   := false;
      IF cardinality(pol.requires_export) > 0 THEN
        EXECUTE format('SELECT count(*) FROM %s', c.part) INTO rows_now;
        exported := NOT EXISTS (
          SELECT 1 FROM unnest(pol.requires_export) AS t(target)
           WHERE NOT EXISTS (SELECT 1 FROM maintenance.partition_export e
                              WHERE e.partition_name = c.part::text AND e.target = t.target
                                AND e.verified_at IS NOT NULL AND e.exported_rows = rows_now));
        forced := NOT exported AND pol.force_drop_after IS NOT NULL AND upper_b + pol.force_drop_after <= p_now;
        CONTINUE WHEN NOT exported AND NOT forced;
      END IF;

      EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', pol.table_name, c.part);
      EXECUTE format('DROP TABLE %s', c.part);
      INSERT INTO maintenance.retention_run (table_name, action, object_name, cutoff, rows_affected)
      VALUES (pol.table_name::text, CASE WHEN forced THEN 'PARTITION_FORCE_DROPPED' ELSE 'PARTITION_DROPPED' END,
              c.part::text, lower_b, rows_now);
      dropped := dropped + 1;
      IF dropped >= p_limit THEN
        RETURN dropped;
      END IF;
    END LOOP;
  END LOOP;
  RETURN dropped;
END $$;

RESET ROLE;
COMMIT;
