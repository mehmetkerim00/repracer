-- 0040_storefront_time_zone_manual_halt.sql
-- Р-65: часовой пояс — свойство витрины в справочнике каналов. Общее значение для США не подставляется: 0037 выставила
--       America/Los_Angeles всем витринам страны US — это снято. Amazon US и eBay US помечены (проверить) по отдельности,
--       со своими источниками: от границы суток eBay зависит дневной бюджет 250 правок листинга [Р-2, Р-19].
--       Пока пояс витрины не подтверждён: запись с бюджетом правок не создаётся, дни не закрываются, сырьё цен не удаляется.
-- Шаг 11 (kill switch): ручная остановка хранит, кто и почему остановил; автоматическая проверка выборкой [Р-52]
--       ручную остановку не снимает (исправлено в хранилищах: выборка проверяет только CHANNEL_MASS_SHIFT).

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Пояс витрины: значение, статус и источник — по каждой витрине [Р-65]
-- ---------------------------------------------------------------------------
ALTER TABLE platform.marketplace
  ADD COLUMN time_zone_status text NOT NULL DEFAULT 'TO_VERIFY' CHECK (time_zone_status IN ('CONFIRMED', 'TO_VERIFY')),
  ADD COLUMN time_zone_source text;
ALTER TABLE platform.marketplace ALTER COLUMN time_zone DROP NOT NULL;

UPDATE platform.marketplace SET source = replace(source, '; граница суток America/Los_Angeles (проверить)', '');
UPDATE platform.marketplace SET time_zone = v.tz, time_zone_status = 'TO_VERIFY', time_zone_source = v.src
  FROM (VALUES
    ('KAUFLAND', 'de', 'Europe/Berlin', 'Местное время Германии — сутки истории цен (Omnibus, §11 PAngV); граница суток Kaufland для витрины de (проверить)'),
    ('KAUFLAND', 'at', 'Europe/Vienna', 'Местное время Австрии — сутки истории цен (Omnibus); граница суток Kaufland для витрины at (проверить)'),
    ('AMAZON', 'A1PA6795UKMFR9', 'Europe/Berlin', 'amazon.de: местное время Германии для истории цен; граница суток отчётов и уведомлений SP-API (проверить)'),
    ('EBAY', 'EBAY_DE', 'Europe/Berlin', 'EBAY_DE: местное время Германии для истории цен; граница календарного дня лимита 250 правок листинга (проверить) [Р-2, Р-19]'),
    ('AMAZON', 'ATVPDKIKX0DER', NULL, 'amazon.com: граница суток не установлена — проверить по документации SP-API; общее значение для США не подставляется [Р-65]'),
    ('EBAY', 'EBAY_US', NULL, 'EBAY_US: граница календарного дня лимита 250 правок листинга не установлена — проверить по документации eBay; от неё зависит edit_budget.budget_day [Р-65]')
  ) AS v(channel, marketplace, tz, src)
 WHERE platform.marketplace.channel = v.channel AND platform.marketplace.marketplace = v.marketplace;

ALTER TABLE platform.marketplace
  ALTER COLUMN time_zone_source SET NOT NULL,
  ADD CONSTRAINT marketplace_time_zone_source CHECK (length(time_zone_source) BETWEEN 10 AND 500),
  -- Подтверждённый пояс всегда задан; неподтверждённый может быть неизвестен
  ADD CONSTRAINT marketplace_time_zone_known_if_confirmed CHECK (time_zone IS NOT NULL OR time_zone_status = 'TO_VERIFY');

-- Проверка корректности пояса — только для заданного значения
CREATE OR REPLACE FUNCTION platform.marketplace_time_zone_valid() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.time_zone IS NOT NULL THEN
    PERFORM now() AT TIME ZONE NEW.time_zone;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Бюджет правок — только по подтверждённой границе суток витрины [Р-65, Р-19]
-- ---------------------------------------------------------------------------
CREATE FUNCTION tenant_data.channel_write_budget_day_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mk record;
BEGIN
  IF NEW.budget_scope_key IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.marketplace, m.time_zone, m.time_zone_status INTO mk
    FROM tenant_data.write_scope s
    JOIN tenant_data.offer_mapping om
      ON om.tenant_id = s.tenant_id AND (om.price_write_scope_id = s.write_scope_id OR om.quantity_write_scope_id = s.write_scope_id)
    JOIN platform.marketplace m ON m.channel = s.channel AND m.marketplace = om.marketplace
   WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id
   ORDER BY om.created_at
   LIMIT 1;
  IF mk.time_zone IS NULL OR mk.time_zone_status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'edit budget day of storefront % is not confirmed (Р-65): budgeted writes are refused until the day boundary is verified', mk.marketplace
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.budget_day IS DISTINCT FROM (now() AT TIME ZONE mk.time_zone)::date THEN
    RAISE EXCEPTION 'budget_day % is not the current day % of storefront % (%)', NEW.budget_day, (now() AT TIME ZONE mk.time_zone)::date, mk.marketplace, mk.time_zone
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aa_channel_write_budget_day_tz BEFORE INSERT ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_budget_day_guard();

-- ---------------------------------------------------------------------------
-- 3. Ручная остановка — кто и почему [kill switch, Р-51]
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.pricing_halt
  ADD COLUMN halted_by_membership_id uuid,
  ADD COLUMN halt_note text CHECK (length(halt_note) BETWEEN 10 AND 2000);
ALTER TABLE channel_data.pricing_halt
  ADD CONSTRAINT pricing_halt_manual_by_member FOREIGN KEY (tenant_id, halted_by_membership_id)
    REFERENCES tenant_data.membership (tenant_id, membership_id),
  ADD CONSTRAINT pricing_halt_manual_attributed
    CHECK ((reason_code = 'MANUAL') = (halted_by_membership_id IS NOT NULL AND halt_note IS NOT NULL));

RESET ROLE;

-- ---------------------------------------------------------------------------
-- 4. Сутки витрины с неизвестным поясом не закрываются, их сырьё не удаляется [Р-65]
-- ---------------------------------------------------------------------------
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

CREATE FUNCTION maintenance.price_history_in_unknown_time_zone(p_from timestamptz, p_to timestamptz) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenant_data.price_history h
                  WHERE h.accepted_at >= p_from AND h.accepted_at < p_to
                    AND tenant_data.write_scope_time_zone(h.tenant_id, h.write_scope_id) IS NULL)
$$;

CREATE OR REPLACE FUNCTION maintenance.close_price_days(p_now timestamptz DEFAULT now(), p_max_days int DEFAULT 7) RETURNS int
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tz          text;
  local_today date;
  first_raw   timestamptz;
  next_day    date;
  day_start   timestamptz;
  day_end     timestamptz;
  inserted    bigint;
  tz_closed   int;
  closed      int := 0;
BEGIN
  SELECT min(accepted_at) INTO first_raw FROM tenant_data.price_history;
  -- Витрины без известного пояса пропускаются: их сутки нельзя закрыть (Р-65)
  FOR tz IN SELECT DISTINCT time_zone FROM platform.marketplace WHERE time_zone IS NOT NULL ORDER BY 1 LOOP
    local_today := (p_now AT TIME ZONE tz)::date;
    SELECT max(price_day) + 1 INTO next_day FROM maintenance.price_day_close WHERE day_tz = tz;
    IF next_day IS NULL THEN
      next_day := (first_raw AT TIME ZONE tz)::date;
    END IF;
    CONTINUE WHEN next_day IS NULL;

    tz_closed := 0;
    WHILE tz_closed < p_max_days LOOP
      day_start := next_day::timestamp AT TIME ZONE tz;
      day_end   := (next_day + 1)::timestamp AT TIME ZONE tz;
      EXIT WHEN next_day >= local_today OR p_now < day_end + interval '1 hour';

      INSERT INTO tenant_data.price_daily
        (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor, max_amount_minor,
         first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
      SELECT h.tenant_id, h.write_scope_id, h.price_type, next_day, tz, h.currency, h.price_basis,
             min(h.amount_minor), max(h.amount_minor),
             (array_agg(h.amount_minor ORDER BY h.accepted_at, h.price_history_id))[1], min(h.accepted_at),
             (array_agg(h.amount_minor ORDER BY h.accepted_at DESC, h.price_history_id DESC))[1], max(h.accepted_at),
             count(*), min(h.effective_min_price_minor)
        FROM tenant_data.price_history h
       WHERE h.accepted_at >= day_start AND h.accepted_at < day_end
         AND tenant_data.write_scope_time_zone(h.tenant_id, h.write_scope_id) = tz
         AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c
                          WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
       GROUP BY h.tenant_id, h.write_scope_id, h.price_type, h.currency, h.price_basis
      ON CONFLICT DO NOTHING;
      GET DIAGNOSTICS inserted = ROW_COUNT;

      INSERT INTO maintenance.price_day_close (price_day, day_tz, rows_inserted) VALUES (next_day, tz, inserted);
      tz_closed := tz_closed + 1;
      closed := closed + 1;
      next_day := next_day + 1;
    END LOOP;
  END LOOP;
  RETURN closed;
END $$;

RESET ROLE;
REVOKE CREATE ON SCHEMA maintenance FROM repracer_retention;
REVOKE ALL ON FUNCTION maintenance.price_history_in_unknown_time_zone(timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.price_history_in_unknown_time_zone(timestamptz, timestamptz) TO repracer_owner, repracer_retention;

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

      -- Р-29, Р-62: сырьё цен — источник вечной свёртки; все местные дни секции закрыты в каждом известном поясе витрин
      IF pol.table_name = 'tenant_data.price_history'::regclass AND EXISTS (
           SELECT 1
             FROM (SELECT DISTINCT time_zone FROM platform.marketplace WHERE time_zone IS NOT NULL) z
             CROSS JOIN LATERAL generate_series((lower_b AT TIME ZONE z.time_zone)::date,
                                                (upper_b AT TIME ZONE z.time_zone)::date, interval '1 day') AS d(day)
            WHERE NOT EXISTS (SELECT 1 FROM maintenance.price_day_close pc
                               WHERE pc.day_tz = z.time_zone AND pc.price_day = d.day::date)) THEN
        CONTINUE;
      END IF;
      -- Р-65: сырьё витрины с неизвестным поясом не свёрнуто — секция остаётся
      IF pol.table_name = 'tenant_data.price_history'::regclass AND maintenance.price_history_in_unknown_time_zone(lower_b, upper_b) THEN
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
