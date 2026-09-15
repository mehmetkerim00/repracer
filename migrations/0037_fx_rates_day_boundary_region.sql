-- 0037_fx_rates_day_boundary_region.sql
-- Р-61: себестоимость в валюте возникновения; перевод при расчёте по дневному курсу ЕЦБ, известному на момент решения;
--       курс хранится вместе с решением.
-- Р-62: граница суток истории цен — свойство витрины (platform.marketplace.time_zone), а не константа Europe/Berlin.
-- Р-60: регион хранения — место клиента: тенант живёт в одной базе, витрины — любые; перенос тенанта между регионами —
--       отдельная процедура (docs/tenant-region-transfer.md), а не побочный эффект подключения витрины.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_fx_loader') THEN
    CREATE ROLE repracer_fx_loader NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA platform, security TO repracer_fx_loader;
GRANT EXECUTE ON FUNCTION security.platform_tenant_id() TO repracer_fx_loader;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Дневные курсы ЕЦБ [Р-61]. Справочник платформы, неизменяемый: курс дня не переписывается
-- ---------------------------------------------------------------------------
CREATE TABLE platform.fx_rate (
  tenant_id      uuid NOT NULL DEFAULT security.platform_tenant_id() CHECK (tenant_id = security.platform_tenant_id()),
  source         text NOT NULL CHECK (source = 'ECB'),
  rate_date      date NOT NULL,
  base_currency  text NOT NULL CHECK (base_currency = 'EUR'),
  quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$' AND quote_currency <> 'EUR'),
  -- Единиц quote за 1 EUR; в файле ЕЦБ — не больше шести знаков после запятой
  rate           numeric(18, 6) NOT NULL CHECK (rate > 0),
  -- Когда курс загружен: решение, принятое раньше, его не видит (время публикации ЕЦБ не закладывается)
  available_from timestamptz NOT NULL DEFAULT now(),
  source_ref     text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  PRIMARY KEY (tenant_id, source, rate_date, quote_currency)
);

-- Контекст решения: последний курс валюты, загруженный к моменту решения
CREATE INDEX fx_rate_latest_idx ON platform.fx_rate (quote_currency, rate_date DESC) INCLUDE (rate, available_from);

SELECT security.register_table('platform.fx_rate', 'PLATFORM', 'reference', 'none');
CREATE POLICY fx_rate_read ON platform.fx_rate FOR SELECT TO repracer_app USING (tenant_id = security.platform_tenant_id());
CREATE POLICY fx_rate_load ON platform.fx_rate TO repracer_fx_loader
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
GRANT SELECT, INSERT ON platform.fx_rate TO repracer_fx_loader;
CREATE TRIGGER zz_fx_rate_immutable BEFORE UPDATE OR DELETE ON platform.fx_rate
  FOR EACH ROW EXECUTE FUNCTION security.forbid_mutation();
CREATE TRIGGER zz_fx_rate_no_truncate BEFORE TRUNCATE ON platform.fx_rate
  FOR EACH STATEMENT EXECUTE FUNCTION security.forbid_truncate();

-- Курс в решении: откуда, куда, по какому курсу и дате, сколько было и сколько стало
ALTER TABLE channel_data.price_decision ADD COLUMN fx jsonb;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_fx_shape CHECK (fx IS NULL OR (
  jsonb_typeof(fx) = 'object'
  AND fx ?& ARRAY['source', 'rateDate', 'base', 'quote', 'rateMicros', 'from', 'to', 'sourceAmountMinor', 'convertedAmountMinor']));

-- Решение опирается на себестоимость в другой валюте — курс обязан быть записан в решении
CREATE FUNCTION channel_data.price_decision_fx_recorded() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  cost_currency text;
BEGIN
  IF NEW.cost_profile_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT cp.currency INTO cost_currency FROM tenant_data.cost_profile cp
   WHERE cp.tenant_id = NEW.tenant_id AND cp.cost_profile_id = NEW.cost_profile_id;
  IF cost_currency IS DISTINCT FROM NEW.currency
     AND (NEW.fx IS NULL OR NEW.fx ->> 'from' IS DISTINCT FROM cost_currency OR NEW.fx ->> 'to' IS DISTINCT FROM NEW.currency) THEN
    RAISE EXCEPTION 'decision uses a % cost profile for a % price without the exchange rate it was converted at (Р-61)', cost_currency, NEW.currency
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aa_price_decision_fx_recorded BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_fx_recorded();

-- ---------------------------------------------------------------------------
-- 2. Граница суток — свойство витрины [Р-62]
-- ---------------------------------------------------------------------------
ALTER TABLE platform.marketplace ADD COLUMN time_zone text;
UPDATE platform.marketplace SET time_zone = CASE country WHEN 'DE' THEN 'Europe/Berlin' WHEN 'AT' THEN 'Europe/Vienna' END
 WHERE country IN ('DE', 'AT');
-- Витрины США: сутки Amazon US и eBay US — по тихоокеанскому времени (проверить по документации каналов при адаптерах)
UPDATE platform.marketplace SET time_zone = 'America/Los_Angeles',
       source = source || '; граница суток America/Los_Angeles (проверить)'
 WHERE country = 'US';
ALTER TABLE platform.marketplace ALTER COLUMN time_zone SET NOT NULL;

CREATE FUNCTION platform.marketplace_time_zone_valid() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  -- Неизвестный часовой пояс отклоняется сервером (invalid_parameter_value)
  PERFORM now() AT TIME ZONE NEW.time_zone;
  RETURN NEW;
END $$;
CREATE TRIGGER a_marketplace_time_zone_valid BEFORE INSERT OR UPDATE OF time_zone ON platform.marketplace
  FOR EACH ROW EXECUTE FUNCTION platform.marketplace_time_zone_valid();

-- Задание закрытия дней и удаление секций читают часовые пояса витрин
CREATE POLICY marketplace_retention_read ON platform.marketplace FOR SELECT TO repracer_retention
  USING (tenant_id = security.platform_tenant_id());
GRANT SELECT ON platform.marketplace TO repracer_retention;

/** Часовой пояс витрины единицы записи; NULL — у единицы нет связки оффера */
CREATE FUNCTION tenant_data.write_scope_time_zone(p_tenant_id uuid, p_write_scope_id uuid) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT mk.time_zone
    FROM tenant_data.write_scope s
    JOIN tenant_data.offer_mapping m
      ON m.tenant_id = s.tenant_id AND (m.price_write_scope_id = s.write_scope_id OR m.quantity_write_scope_id = s.write_scope_id)
    JOIN platform.marketplace mk ON mk.channel = s.channel AND mk.marketplace = m.marketplace
   WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
   ORDER BY m.created_at
   LIMIT 1
$$;
GRANT EXECUTE ON FUNCTION tenant_data.write_scope_time_zone(uuid, uuid) TO repracer_app, repracer_retention;

-- «Только Europe/Berlin» снимается со свёрток и журнала закрытых дней
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS t, conname FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('tenant_data.price_daily'::regclass, 'channel_data.observed_price_daily'::regclass, 'maintenance.price_day_close'::regclass)
       AND pg_get_constraintdef(oid) LIKE '%day_tz%Europe/Berlin%'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.t, c.conname);
  END LOOP;
END $$;
ALTER TABLE tenant_data.price_daily ALTER COLUMN day_tz DROP DEFAULT;
ALTER TABLE channel_data.observed_price_daily ALTER COLUMN day_tz DROP DEFAULT;
ALTER TABLE maintenance.price_day_close ALTER COLUMN day_tz DROP DEFAULT;

-- Сутки свёртки — сутки витрины единицы записи
CREATE FUNCTION tenant_data.daily_day_tz_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  tz text := tenant_data.write_scope_time_zone(NEW.tenant_id, NEW.write_scope_id);
BEGIN
  IF tz IS NULL OR NEW.day_tz IS DISTINCT FROM tz THEN
    RAISE EXCEPTION '%: day_tz % does not match the storefront time zone % of write_scope % (Р-62)', TG_TABLE_NAME, NEW.day_tz, tz, NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER aa_price_daily_day_tz BEFORE INSERT ON tenant_data.price_daily
  FOR EACH ROW EXECUTE FUNCTION tenant_data.daily_day_tz_guard();
CREATE TRIGGER aa_observed_price_daily_day_tz BEFORE INSERT ON channel_data.observed_price_daily
  FOR EACH ROW EXECUTE FUNCTION tenant_data.daily_day_tz_guard();

-- Закрытый день — по часовому поясу: один и тот же календарный день в Берлине и Лос-Анджелесе закрывается в разное время
ALTER TABLE maintenance.price_day_close DROP CONSTRAINT price_day_close_pkey;
ALTER TABLE maintenance.price_day_close ADD PRIMARY KEY (day_tz, price_day);

RESET ROLE;
GRANT CREATE ON SCHEMA maintenance TO repracer_retention;
SET ROLE repracer_retention;

-- Закрытие дней по каждому часовому поясу витрин. День закрывается для пояса целиком (все тенанты), в том числе
-- без строк сырья: удаление секции сырья требует закрытых дней всех поясов.
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
  FOR tz IN SELECT DISTINCT time_zone FROM platform.marketplace ORDER BY 1 LOOP
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
      -- День закрывается через час после местной полуночи витрины
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

SET ROLE repracer_owner;

-- Секция сырья цен удаляется, только когда её местные дни закрыты во всех часовых поясах витрин
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

      -- Р-29, Р-62: сырьё цен — источник вечной свёртки; все местные дни секции закрыты в каждом часовом поясе витрин
      IF pol.table_name = 'tenant_data.price_history'::regclass AND EXISTS (
           SELECT 1
             FROM (SELECT DISTINCT time_zone FROM platform.marketplace) z
             CROSS JOIN LATERAL generate_series((lower_b AT TIME ZONE z.time_zone)::date,
                                                (upper_b AT TIME ZONE z.time_zone)::date, interval '1 day') AS d(day)
            WHERE NOT EXISTS (SELECT 1 FROM maintenance.price_day_close pc
                               WHERE pc.day_tz = z.time_zone AND pc.price_day = d.day::date)) THEN
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

-- ---------------------------------------------------------------------------
-- 3. Регион хранения — место клиента [Р-60]
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN tenant_data.tenant.data_region IS
  'Р-60: регион хранения определяется местом клиента, а не витрины. Тенант живёт в одной базе региона, витрины — любые '
  '(EU-тенант с amazon.com хранится в базе EU). Значение неизменяемо (tenant_region_guard); перенос между регионами — '
  'отдельная процедура docs/tenant-region-transfer.md, не побочный эффект подключения витрины.';

RESET ROLE;
COMMIT;
