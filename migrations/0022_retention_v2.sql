-- 0022_retention_v2.sql
-- Хранение v2 под три слоя [Р-20]: месячные и дневные партиции, MAX_AGE (данные каналов) и MIN_AGE (горячие данные
-- тенанта), удаление партиции только после подтверждённого экспорта с совпадающим числом строк,
-- принудительное удаление транзитных данных каналов после force_drop_after.
-- Расписание (планировщик, член repracer_retention):
--   SELECT maintenance.ensure_partitions();
--   SELECT maintenance.drop_expired_partitions();   -- повторять, пока не вернёт 0
--   SELECT maintenance.delete_expired_rows();
--   SELECT maintenance.release_expired_reservations();   -- повторять, пока не вернёт 0

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE maintenance.retention_run DROP CONSTRAINT retention_run_action_check;
ALTER TABLE maintenance.retention_run ADD CONSTRAINT retention_run_action_check
  CHECK (action IN ('PARTITION_CREATED', 'PARTITION_DROPPED', 'PARTITION_FORCE_DROPPED', 'ROWS_DELETED', 'TENANT_PURGED'));

-- Партиция: RLS и отсутствие прямого доступа приложения; владелец может посчитать строки партиции
-- (сверка с числом выгруженных строк перед удалением).
CREATE OR REPLACE FUNCTION security.protect_partition(p_partition regclass) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_partition);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_partition);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC, repracer_app, repracer_resolver, repracer_exporter', p_partition);
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = p_partition AND polname = 'owner_row_count') THEN
    EXECUTE format('CREATE POLICY owner_row_count ON %s FOR SELECT TO repracer_owner USING (true)', p_partition);
  END IF;
END $$;

-- Существующие партиции (аудит и др.)
SELECT security.protect_partition(i.inhrelid::regclass)
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE c.relispartition AND c.relkind IN ('r', 'p');

INSERT INTO maintenance.retention_policy
  (table_name, method, anchor_column, retention, safety_margin, bound, partition_interval, requires_export,
   days_ahead, drop_order)
VALUES
  ('tenant_data.outbox_event', 'DROP_PARTITION', 'created_at', '2 days', '0 days', 'MIN_AGE', 'day',
   ARRAY['KAFKA'], 3, 5);

DROP FUNCTION maintenance.ensure_partitions(timestamptz);
DROP FUNCTION maintenance.drop_expired_partitions(timestamptz, int);

-- Истекла ли партиция [p_lower, p_upper) по политике
CREATE FUNCTION maintenance.partition_due(p_policy maintenance.retention_policy, p_lower timestamptz, p_upper timestamptz,
                                          p_now timestamptz) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_policy.bound
           WHEN 'MAX_AGE' THEN p_lower + (p_policy.retention - p_policy.safety_margin) <= p_now
           ELSE p_upper + p_policy.retention <= p_now
         END
$$;

CREATE FUNCTION maintenance.ensure_partitions(p_now timestamptz DEFAULT now()) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  p       record;
  pol     maintenance.retention_policy;
  step    interval;
  m       timestamptz;
  last_m  timestamptz;
  cur_m   timestamptz;
  suffix  text;
  part    text;
  sub     text;
  i       int;
  created int := 0;
BEGIN
  FOR p IN SELECT rp.table_name AS tbl, c.relname, n.nspname
             FROM maintenance.retention_policy rp
             JOIN pg_class c ON c.oid = rp.table_name
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE rp.method = 'DROP_PARTITION'
  LOOP
    SELECT * INTO pol FROM maintenance.retention_policy WHERE table_name = p.tbl;
    step   := CASE pol.partition_interval WHEN 'month' THEN interval '1 month' ELSE interval '1 day' END;
    cur_m  := date_trunc(pol.partition_interval, p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    last_m := cur_m + CASE pol.partition_interval WHEN 'month' THEN make_interval(months => pol.months_ahead)
                                                                ELSE make_interval(days => pol.days_ahead) END;
    m := cur_m - step;
    IF pol.backfill AND pol.bound = 'MAX_AGE' THEN
      m := date_trunc(pol.partition_interval, (p_now - (pol.retention - pol.safety_margin)) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
    END IF;

    WHILE m <= last_m LOOP
      suffix := CASE pol.partition_interval
                  WHEN 'month' THEN '_y' || to_char(m AT TIME ZONE 'UTC', 'YYYY') || 'm' || to_char(m AT TIME ZONE 'UTC', 'MM')
                  ELSE '_d' || to_char(m AT TIME ZONE 'UTC', 'YYYYMMDD') END;
      part := format('%I.%I', p.nspname, p.relname || suffix);
      IF to_regclass(part) IS NULL AND NOT maintenance.partition_due(pol, m, m + step, p_now) THEN
        IF pol.hash_modulus IS NULL THEN
          EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L)', part, p.tbl, m, m + step);
        ELSE
          EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (tenant_id)',
                         part, p.tbl, m, m + step);
          FOR i IN 0 .. pol.hash_modulus - 1 LOOP
            sub := format('%I.%I', p.nspname, p.relname || suffix || '_h' || lpad(i::text, 2, '0'));
            EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                           sub, part, pol.hash_modulus, i);
            PERFORM security.protect_partition(sub::regclass);
          END LOOP;
        END IF;
        PERFORM security.protect_partition(part::regclass);
        INSERT INTO maintenance.retention_run (table_name, action, object_name, cutoff)
        VALUES (p.tbl::text, 'PARTITION_CREATED', part, m);
        created := created + 1;
      END IF;
      m := m + step;
    END LOOP;
  END LOOP;
  RETURN created;
END $$;

-- Удаление истёкших партиций. С requires_export — только если по каждому слою есть подтверждённый экспорт
-- и число выгруженных строк совпадает с партицией; иначе ждём (или force_drop_after для данных без юридической ценности).
CREATE FUNCTION maintenance.drop_expired_partitions(p_now timestamptz DEFAULT now(), p_limit int DEFAULT 10) RETURNS int
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

      -- DETACH проверяет отсутствие ссылающихся строк и снимает зависимости FK
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

REVOKE ALL ON FUNCTION maintenance.ensure_partitions(timestamptz), maintenance.drop_expired_partitions(timestamptz, int)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.ensure_partitions(timestamptz), maintenance.drop_expired_partitions(timestamptz, int)
  TO repracer_retention;
SELECT maintenance.ensure_partitions();

RESET ROLE;
-- Функция принадлежит repracer_retention (0020): право выдаёт мигратор, а не repracer_owner
GRANT EXECUTE ON FUNCTION maintenance.release_expired_reservations(timestamptz, int) TO repracer_retention;
COMMIT;
