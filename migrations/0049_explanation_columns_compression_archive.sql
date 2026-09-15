-- 0049_explanation_columns_compression_archive.sql
-- Шаг 14:
--  Р-80: ядро и решение уменьшаются двумя способами сразу.
--        1) Слепок не повторяет данные, которые строка хранит столбцами: итог, причину и границы Gate, отклонение, профиль и набор
--           правил, стратегию, правило, триггер, предложенную цену (формат r80.1). Решению для этого нужны столбцы intent —
--           их заполняет триггер из price_intent (горячий intent живёт 3 дня, решение — 30). Повтор столбца в слепке отклоняет БД.
--        2) Сжатие значения в секциях: jsonb-столбцы — lz4 с хранением MAIN; у листовых секций — toast_tuple_target.
--           ИСПРАВЛЕНО на шаге 15: предположение этой миграции неверно — toast_tuple_target НЕ снижает порог сжатия. PostgreSQL
--           сжимает значение, только если строка длиннее TOAST_TUPLE_THRESHOLD (~2 КБ, задан при сборке); обычная строка ядра
--           и решения короче и не сжималась. Настройка отменена решением Р-86 (миграция 0054).
--  Р-79: архив ядра самодостаточен — экспорт ядра в ARCHIVE подтверждается только с версиями стратегий и справочником
--        объяснений в архиве; экспортёру — чтение стратегий и справочника.
-- Формат r74.1 не выпускался: слепков в базе нет (проверка ниже), переписывать нечего.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM channel_data.price_decision) OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core) THEN
    RAISE EXCEPTION 'price decisions or intent cores exist: explanations of format r74.1 would need a rewrite (Р-80)';
  END IF;
END $$;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Решение: столбцы intent [Р-80]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  ADD COLUMN pricing_strategy_id uuid,
  ADD COLUMN pricing_strategy_version int,
  ADD COLUMN rule_code text,
  ADD COLUMN trigger_type text NOT NULL,
  ADD COLUMN proposed_amount_minor bigint NOT NULL;

-- Столбцы intent — только из intent: приложение их не задаёт, расходиться с intent они не могут
CREATE FUNCTION channel_data.price_decision_intent_columns() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  i record;
BEGIN
  SELECT pi.pricing_strategy_id, pi.pricing_strategy_version, pi.rule_code, pi.trigger_type, pi.proposed_amount_minor INTO i
    FROM channel_data.price_intent pi
   WHERE pi.tenant_id = NEW.tenant_id AND pi.created_at = NEW.intent_created_at AND pi.price_intent_id = NEW.price_intent_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'decision refers to no price intent %', NEW.price_intent_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.pricing_strategy_id      := i.pricing_strategy_id;
  NEW.pricing_strategy_version := i.pricing_strategy_version;
  NEW.rule_code                := i.rule_code;
  NEW.trigger_type             := i.trigger_type;
  NEW.proposed_amount_minor    := i.proposed_amount_minor;
  RETURN NEW;
END $$;
CREATE TRIGGER a0_price_decision_intent_columns BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_intent_columns();

-- ---------------------------------------------------------------------------
-- 2. Слепок r80.1 без копий столбцов [Р-80]
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.explanation_repeats_no_columns(e jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT NOT (coalesce(e -> 'strategy' ?| ARRAY['strategyId', 'version', 'ruleCode', 'trigger', 'proposedMinor'], false)
           OR coalesce(e -> 'gate' ?| ARRAY['profile', 'outcome', 'reason', 'checks', 'floorMinor', 'ceilingMinor', 'boundDeviationBp', 'currency'], false)
           OR coalesce(e -> 'sanity' ? 'ruleset', false))
$$;
GRANT EXECUTE ON FUNCTION security.explanation_repeats_no_columns(jsonb) TO repracer_app;

ALTER TABLE channel_data.price_decision
  DROP CONSTRAINT price_decision_explanation_by_class,
  -- coalesce: CHECK с NULL-результатом строку пропускает
  ADD CONSTRAINT price_decision_explanation_by_class CHECK (coalesce(CASE
    WHEN intent_class = 'NO_OP' THEN explanation IS NULL AND no_change_reason IS NOT NULL AND sanity_ruleset IS NULL AND gate_profile IS NULL
    ELSE no_change_reason IS NULL AND jsonb_typeof(explanation) = 'object' AND explanation ->> 'format' = 'r80.1'
         AND jsonb_typeof(explanation -> 'strategy') = 'object' AND gate_profile LIKE 'g%'
         AND (sanity_ruleset IS NULL OR sanity_ruleset LIKE 'r%') AND (sanity_ruleset IS NOT NULL) = (explanation ? 'sanity')
  END, false)),
  ADD CONSTRAINT price_decision_explanation_no_column_copies CHECK (explanation IS NULL OR security.explanation_repeats_no_columns(explanation));

ALTER TABLE tenant_data.price_intent_core
  DROP CONSTRAINT price_intent_core_explanation_present,
  -- Версия стратегии — столбец ядра с внешним ключом на справочник стратегий (0044); в слепке её больше нет
  DROP CONSTRAINT price_intent_core_explanation_strategy,
  ADD CONSTRAINT price_intent_core_explanation_present CHECK (coalesce(
    jsonb_typeof(explanation) = 'object' AND explanation ->> 'format' = 'r80.1' AND jsonb_typeof(explanation -> 'strategy') = 'object'
    AND gate_profile LIKE 'g%' AND (sanity_ruleset IS NULL OR sanity_ruleset LIKE 'r%') AND (sanity_ruleset IS NOT NULL) = (explanation ? 'sanity'), false)),
  ADD CONSTRAINT price_intent_core_explanation_no_column_copies CHECK (security.explanation_repeats_no_columns(explanation));

-- ---------------------------------------------------------------------------
-- 3. Сжатие значения в секциях [Р-80]
-- ---------------------------------------------------------------------------
ALTER TABLE maintenance.retention_policy
  ADD COLUMN leaf_toast_tuple_target int,
  -- Порог сжатия строки — только у секционируемых таблиц; 128 — минимум PostgreSQL
  ADD CONSTRAINT retention_policy_leaf_toast_tuple_target CHECK (
    leaf_toast_tuple_target IS NULL OR (method = 'DROP_PARTITION' AND leaf_toast_tuple_target BETWEEN 128 AND 8160));

UPDATE maintenance.retention_policy SET leaf_toast_tuple_target = 128
 WHERE table_name IN ('channel_data.price_decision'::regclass, 'tenant_data.price_intent_core'::regclass);

-- Родитель передаёт сжатие и хранение новым секциям; существующие секции (ALTER родителя их не меняет) — по дереву
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
        EXECUTE format('ALTER TABLE ONLY %s ALTER COLUMN %I SET COMPRESSION lz4', p.relid::regclass, col);
        EXECUTE format('ALTER TABLE ONLY %s ALTER COLUMN %I SET STORAGE MAIN', p.relid::regclass, col);
      END LOOP;
      IF p.isleaf THEN
        EXECUTE format('ALTER TABLE %s SET (toast_tuple_target = %s)', p.relid::regclass,
                       (SELECT leaf_toast_tuple_target FROM maintenance.retention_policy WHERE table_name = t.tbl));
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- ensure_partitions (0022) + порог сжатия листовых секций
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
          IF pol.leaf_toast_tuple_target IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %s SET (toast_tuple_target = %s)', part, pol.leaf_toast_tuple_target);
          END IF;
        ELSE
          EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES FROM (%L) TO (%L) PARTITION BY HASH (tenant_id)',
                         part, p.tbl, m, m + step);
          FOR i IN 0 .. pol.hash_modulus - 1 LOOP
            sub := format('%I.%I', p.nspname, p.relname || suffix || '_h' || lpad(i::text, 2, '0'));
            EXECUTE format('CREATE TABLE %s PARTITION OF %s FOR VALUES WITH (MODULUS %s, REMAINDER %s)',
                           sub, part, pol.hash_modulus, i);
            -- Р-80 (отменено Р-86, 0054): порог не снижает TOAST_TUPLE_THRESHOLD — строка короче ~2 КБ не сжимается и с ним
            IF pol.leaf_toast_tuple_target IS NOT NULL THEN
              EXECUTE format('ALTER TABLE %s SET (toast_tuple_target = %s)', sub, pol.leaf_toast_tuple_target);
            END IF;
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

-- ---------------------------------------------------------------------------
-- 4. Самодостаточный архив ядра [Р-79]
-- ---------------------------------------------------------------------------
ALTER TABLE maintenance.partition_export
  ADD COLUMN explanation_dictionary_included boolean NOT NULL DEFAULT false,
  -- Подтверждённый экспорт ядра в архив — только со справочниками объяснения: иначе секция удалится, а архив не объяснит себя
  ADD CONSTRAINT partition_export_core_archive_self_contained CHECK (
    parent_table <> 'tenant_data.price_intent_core' OR target <> 'ARCHIVE' OR verified_at IS NULL OR explanation_dictionary_included);

-- Экспортёр кладёт в архив тенанта версии стратегий и справочник объяснений
SELECT security.grant_export('tenant_data.pricing_strategy');
SELECT security.grant_export('platform.explanation_ruleset');
GRANT USAGE ON SCHEMA platform TO repracer_exporter;

RESET ROLE;
COMMIT;
