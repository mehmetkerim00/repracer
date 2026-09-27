-- 0141_shadow_budget_day.sql
-- Р-188 (решение владельца после ревью шага 47): граница суток витрины нужна только БОЕВОЙ записи.
--
-- До этой миграции база отказывала любой записи с бюджетом правок при неподтверждённой границе суток (0040, Р-65) — и
-- теневой тоже, хотя в тени бюджет не расходуется [Р-171]. У eBay бюджет есть у каждой записи цены (листинг, Р-19), а
-- граница суток EBAY_DE не подтверждена (OQ-112): тень eBay не работала без подтверждения, и прогон пилота подтверждал
-- границу в своей базе суперпользователем — склейка против Р-179.
--
-- Теперь:
--   1. Теневая запись создаётся БЕЗ дня бюджета: день ей не нужен, потому что попытки отправки не будет. Признак
--      «потратило бы» [Р-171] остаётся — он зависит от ключа бюджета, а не от дня.
--   2. Боевая запись при неподтверждённой границе по-прежнему невозможна — тот же страж, та же причина. Ослабление для
--      тени не должно уметь протечь в бой, поэтому у него своя проверка в смоуке и своя строка каталога мутаций.
--   3. Перевод в бой при неподтверждённой границе — 409. До этой миграции это было НЕПРАВДОЙ: граница EBAY_DE задана
--      (Europe/Berlin), но не подтверждена — ревизия называла её `CONSERVATIVE`, а бой держит только `UNKNOWN` [Р-172].
--      Аккаунт eBay переводился в бой, и дальше база отказывала каждой его записи. У канала с бюджетом правок
--      неподтверждённая граница суток консервативного значения не имеет: бюджет считается по суткам, и «худшая граница»
--      [Р-163] в базе не реализована — база отказывает. Поэтому для такого канала ревизия говорит `UNKNOWN`, и бой держит
--      то же правило, что у витрин США, — одно правило, два входа (0130).
--   4. «Потратило бы» при неподтверждённой границе — приблизительно: без границы точного деления по дням нет. Сколько
--      таких записей в окне, считает одна функция; её зовут и экран, и дайджест [Р-171].

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1–2. Страж дня бюджета при вставке
CREATE OR REPLACE FUNCTION tenant_data.channel_write_budget_day_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  mk record;
BEGIN
  IF NEW.budget_scope_key IS NULL THEN
    RETURN NEW;
  END IF;
  /**
   * Р-188: теневая запись дня бюджета не получает — отправки не будет, и списывать нечего. Режим берётся у АККАУНТА в базе
   * [Р-169], а не из вставки: приложение не может объявить запись теневой. Запись теневого аккаунта рождается
   * `SHADOW_HELD` (0128) и в канал не уходит ни одним путём — поэтому пустой день у неё не открывает ничего.
   */
  IF (SELECT ca.write_mode FROM tenant_data.write_scope s
        JOIN tenant_data.channel_account ca ON ca.tenant_id = s.tenant_id AND ca.channel_account_id = s.channel_account_id
       WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id) = 'SHADOW' THEN
    NEW.budget_day := NULL;
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

/**
 * «Ключ бюджета ⇔ день бюджета» — кроме удержанной тенью записи: у неё ключ есть (он и есть «потратило бы»), а дня нет.
 * Статус `SHADOW_HELD` ставит только база по режиму аккаунта (0128), и отправить такую запись нельзя (0128) — поэтому
 * исключение не открывает боевой записи без дня. Ограничение переименовано: прежнее имя было порядковым (`check6`).
 */
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_check6;
ALTER TABLE tenant_data.channel_write ADD CONSTRAINT channel_write_budget_day_iff_key
  CHECK ((budget_scope_key IS NULL) = (budget_day IS NULL) OR (status = 'SHADOW_HELD' AND budget_scope_key IS NOT NULL AND budget_day IS NULL));

RESET ROLE;

-- ---------------------------------------------------------------- 3. Ревизия: граница суток канала с бюджетом правок
-- Владелец функции — суперпользователь (0130); замена владельца не меняет, права остаются
CREATE OR REPLACE FUNCTION platform.marketplace_readiness()
  RETURNS TABLE (channel text, marketplace text, country text, property text, value text, status text,
                 question text, closes_by text, source text)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT m.channel, m.marketplace, m.country, 'DAY_BOUNDARY',
         m.time_zone,
         CASE WHEN m.time_zone_status = 'CONFIRMED' THEN 'CONFIRMED'
              WHEN m.time_zone IS NULL             THEN 'UNKNOWN'
              /**
               * Р-188: у канала с бюджетом правок граница суток несёт бюджет, и неподтверждённое значение консервативным не
               * является — база отказывает боевой записи (0040). Ревизия говорит это прямо, и бой держит то же правило.
               */
              WHEN EXISTS (SELECT 1 FROM platform.channel_capability c
                            WHERE c.channel = m.channel AND c.status = 'ACTIVE' AND c.budget_scope_attribute IS NOT NULL) THEN 'UNKNOWN'
              ELSE 'CONSERVATIVE' END,
         m.time_zone_question, m.time_zone_closes_by, m.time_zone_source
    FROM platform.marketplace m
  UNION ALL
  SELECT m.channel, m.marketplace, m.country, 'PRICE_TAX_BASIS',
         m.price_basis || ' / ' || m.tax_regime, m.tax_status, m.tax_question, m.tax_closes_by, m.tax_source
    FROM platform.marketplace m
  UNION ALL
  /**
   * Область записи объявлена возможностью канала по региону, а витрины к региону приводит справочник: у Amazon регион NA
   * — витрины США, EU — витрины ЕС. Строка возможности без региона относится ко всем витринам канала.
   */
  SELECT m.channel, m.marketplace, m.country, 'QUANTITY_SCOPE',
         c.write_scope_kind, c.write_scope_status, c.write_scope_question, c.write_scope_closes_by,
         coalesce(c.side_effects, 'область записи остатка объявлена возможностью канала')
    FROM platform.marketplace m
    JOIN platform.channel_capability c
      ON c.channel = m.channel AND c.field = 'QUANTITY' AND c.status = 'ACTIVE'
     AND (c.region IS NULL
          OR (c.region = 'NA' AND m.country IN ('US', 'CA', 'MX'))
          OR (c.region = 'EU' AND m.country NOT IN ('US', 'CA', 'MX')))
$fn$;

-- ---------------------------------------------------------------- 4. «Потратило бы» — приблизительно
/**
 * Сколько удержанных тенью записей окна потратили бы бюджет правок на витрине, чья граница суток сейчас НЕ подтверждена.
 * Больше нуля — число «потратило бы» приблизительное: без границы деления по дням нет. Функция работает правами
 * ВЫЗЫВАЮЩЕГО: консоль видит только свой тенант (RLS), дайджест зовёт её из своей функции правами её владельца. Отдельной
 * «перекрёстной» функции нет — счётчик одного тенанта по чужому идентификатору не отдаётся никому.
 */
CREATE FUNCTION platform.shadow_would_spend_unconfirmed(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
  RETURNS bigint
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT count(*)
    FROM tenant_data.channel_write_history wh
   WHERE wh.tenant_id = p_tenant_id AND wh.final_status = 'SHADOW_HELD' AND wh.would_spend_budget
     AND wh.finished_at >= p_from AND wh.finished_at < p_to
     AND EXISTS (SELECT 1 FROM tenant_data.offer_mapping om
                   JOIN platform.marketplace m ON m.channel = om.channel AND m.marketplace = om.marketplace
                  WHERE om.tenant_id = wh.tenant_id
                    AND (om.price_write_scope_id = wh.write_scope_id OR om.quantity_write_scope_id = wh.write_scope_id)
                    AND (m.time_zone IS NULL OR m.time_zone_status <> 'CONFIRMED'))
$fn$;
COMMENT ON FUNCTION platform.shadow_would_spend_unconfirmed(uuid, timestamptz, timestamptz) IS
  'Р-188: «потратило бы» на витринах с неподтверждённой границей суток — больше нуля значит «приблизительно»';
REVOKE EXECUTE ON FUNCTION platform.shadow_would_spend_unconfirmed(uuid, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.shadow_would_spend_unconfirmed(uuid, timestamptz, timestamptz) TO repracer_admin, repracer_retention;

-- Дайджест говорит то же, что экран [Р-171]: новый столбец результата — функция пересоздаётся с тем же владельцем и правами
DROP FUNCTION platform.shadow_digest_targets(interval);
CREATE FUNCTION platform.shadow_digest_targets(p_since interval DEFAULT interval '7 days')
  RETURNS TABLE (tenant_id uuid, tenant_name text, locale text, owner_email text, shadow_accounts bigint, decisions bigint, changes bigint,
                 floor_held bigint, ceiling_held bigint, held_writes bigint, held_price_writes bigint, held_quantity_writes bigint,
                 would_spend_budget bigint, floor_savings jsonb, floor_savings_holds bigint, period_start timestamptz, period_end timestamptz,
                 would_spend_unconfirmed bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  /**
   * НАЧАЛО периода привязано к суткам, а не к моменту вызова. Иначе у каждого прогона свой период, и «одно письмо на
   * период» [Р-174] не значит ничего: два прогона подряд отправили бы два письма о тех же событиях (так и случилось в
   * первом живом прогоне шага 42). Конец — момент сборки письма: числа считаются по всему, что уже случилось.
   */
  WITH win AS (
    SELECT platform.shadow_digest_period_start(now() - p_since) AS from_ts, platform.shadow_digest_period_start(now() - p_since) + interval '7 days' AS to_ts
  ), shadowed AS (
    SELECT t.tenant_id, t.name, t.locale, count(*) AS accounts
      FROM tenant_data.tenant t
      JOIN tenant_data.channel_account ca ON ca.tenant_id = t.tenant_id
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND ca.disconnected_at IS NULL
       AND ca.write_mode = 'SHADOW' AND ca.auth_status = 'ACTIVE'
     GROUP BY t.tenant_id, t.name, t.locale
  )
  SELECT s.tenant_id, s.name, s.locale, security.tenant_owner_email(s.tenant_id), s.accounts,
         coalesce(d.decisions, 0), coalesce(d.changes, 0), coalesce(d.floor_held, 0), coalesce(d.ceiling_held, 0),
         coalesce(h.held, 0), coalesce(h.held_price, 0), coalesce(h.held_quantity, 0), coalesce(h.would_spend, 0),
         fs.savings, fs.priced, w.from_ts, w.to_ts,
         platform.shadow_would_spend_unconfirmed(s.tenant_id, w.from_ts, w.to_ts)
    FROM shadowed s
    CROSS JOIN win w
    CROSS JOIN LATERAL platform.shadow_floor_savings_between(s.tenant_id, w.from_ts, w.to_ts) fs
    LEFT JOIN LATERAL (
      SELECT count(*) AS decisions,
             count(*) FILTER (WHERE pd.outcome = 'APPROVED') AS changes,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_floor_minor) AS floor_held,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_ceiling_minor) AS ceiling_held
        FROM channel_data.price_decision pd
       WHERE pd.tenant_id = s.tenant_id AND pd.shadow AND pd.decided_at >= w.from_ts AND pd.decided_at < w.to_ts) d ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS held,
             count(*) FILTER (WHERE wh.field <> 'QUANTITY') AS held_price,
             count(*) FILTER (WHERE wh.field = 'QUANTITY') AS held_quantity,
             count(*) FILTER (WHERE wh.would_spend_budget) AS would_spend
        FROM tenant_data.channel_write_history wh
       WHERE wh.tenant_id = s.tenant_id AND wh.final_status = 'SHADOW_HELD' AND wh.finished_at >= w.from_ts AND wh.finished_at < w.to_ts) h ON true
   ORDER BY s.name
$fn$;
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) TO repracer_alert_delivery;

COMMIT;
