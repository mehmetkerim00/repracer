-- 0054_revert_partition_compression.sql
-- Шаг 15, Р-86: сжатие ядра внутри PostgreSQL отменяется. Ядро живёт в PostgreSQL окном (≈ 2 месяца) и уходит в архив, где
-- сжимается gzip. Настройка 0049 (lz4, хранение MAIN, toast_tuple_target листовых секций) обычные строки не сжимала вовсе:
-- PostgreSQL сжимает значение, только если строка длиннее TOAST_TUPLE_THRESHOLD (~2 КБ, задан при сборке), и toast_tuple_target
-- этот порог не снижает (замер шага 14, OQ-140). Возвращаются значения по умолчанию: хранение EXTENDED, сжатие по умолчанию
-- кластера, без порога у секций; ensure_partitions — как в 0022.

BEGIN;
SET ROLE repracer_owner;

DO $$
DECLARE
  t   record;
  p   record;
  col text;
BEGIN
  FOR t IN SELECT * FROM (VALUES ('channel_data.price_decision'::regclass, ARRAY['explanation', 'checks', 'reason_params', 'fee_inputs', 'fx']),
                                 ('tenant_data.price_intent_core'::regclass, ARRAY['explanation', 'reason_params'])) AS x(tbl, cols)
  LOOP
    FOR p IN SELECT relid, isleaf FROM pg_partition_tree(t.tbl) LOOP
      FOREACH col IN ARRAY t.cols LOOP
        EXECUTE format('ALTER TABLE ONLY %s ALTER COLUMN %I SET COMPRESSION default', p.relid::regclass, col);
        EXECUTE format('ALTER TABLE ONLY %s ALTER COLUMN %I SET STORAGE EXTENDED', p.relid::regclass, col);
      END LOOP;
      IF p.isleaf THEN
        EXECUTE format('ALTER TABLE %s RESET (toast_tuple_target)', p.relid::regclass);
      END IF;
    END LOOP;
  END LOOP;
END $$;

ALTER TABLE maintenance.retention_policy
  DROP CONSTRAINT retention_policy_leaf_toast_tuple_target,
  DROP COLUMN leaf_toast_tuple_target;

-- ensure_partitions — как в 0022, без порога сжатия
CREATE OR REPLACE FUNCTION maintenance.ensure_partitions(p_now timestamptz DEFAULT now()) RETURNS int
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

RESET ROLE;
COMMIT;
