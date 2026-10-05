-- 0173_tenant_display_titles_day_boundary.sql
-- Шаг 69. Четыре части, каждая со своими проверками в смоуке (tests/db/smoke_append_only.sql — журнал и пояс тенанта,
-- tests/db/smoke_us_digest.sql — кандидаты и неделя письма, tests/db/smoke_oauth.sql — названия из каналов) и строками каталога
-- мутаций [Р-108]:
--   1. K4: пояс продавца — свойство тенанта для ПОКАЗА времени (экраны и письма); по умолчанию — пояс первой витрины тенанта
--      (у витрин США — America/New_York), иначе UTC. Внутри системы всё остаётся UTC: столбец меняет только то, как время ПОКАЗАНО.
--   2. K4: неделя недельного письма тени — по поясу продавца, а не по UTC [Р-174].
--   3. OQ-249: каталог из обнаружения пишет название товара, которое отдал канал; название продавца не затирается. Название из
--      канала — данные канала [Р-3, инвариант 9]: у него отметка последнего чтения, и удаление по сроку стирает его через 18 месяцев.
--   4. Р-204: граница суток витрины с неизвестным поясом (amazon.com, ebay.com) закрывается ХУДШИМ ОКНОМ после недели тени —
--      строкой журнала, которую пишет оператор панели со вторым фактором; доказательство (сутки тени, худшее окно бюджета правок)
--      считает база, а не оператор. Процедура — docs/runbook-day-boundary.md.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. пояс продавца для показа
/**
 * Имя пояса — только IANA (`Europe/Berlin`, `America/Los_Angeles`) или `UTC`, и пояс должен быть известен базе. Сокращения и
 * смещения (`PST`, `+05`) AT TIME ZONE тоже принимает, но смысл у них другой: `PST` не знает перехода на летнее время.
 */
CREATE FUNCTION security.time_zone_known(p_time_zone text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_time_zone IS NULL OR p_time_zone !~ '^(UTC|[A-Z][A-Za-z_]+(/[A-Za-z0-9_+-]+){1,2})$' THEN
    RETURN false;
  END IF;
  PERFORM timestamptz '2000-01-01 00:00:00+00' AT TIME ZONE p_time_zone;
  RETURN true;
EXCEPTION WHEN invalid_parameter_value THEN
  RETURN false;
END $fn$;
COMMENT ON FUNCTION security.time_zone_known(text) IS
  'Шаг 69: имя пояса IANA или UTC, известное базе — для пояса показа тенанта и пояса, принятого по Р-204';

ALTER TABLE tenant_data.tenant
  ADD COLUMN time_zone text,
  ADD CONSTRAINT tenant_time_zone_known CHECK (time_zone IS NULL OR security.time_zone_known(time_zone));
COMMENT ON COLUMN tenant_data.tenant.time_zone IS
  'Шаг 69 (K4): пояс, в котором продавцу ПОКАЗЫВАЮТСЯ времена на экранах и в письмах, и пояс недели его письма тени. NULL — пояс первой витрины тенанта с заданным поясом, иначе UTC (tenant_data.display_time_zone). Внутри системы времена — UTC';
-- Пояс меняет администратор тенанта: действие MANAGE_TENANT уже названо стражем административной записи (как у языка, 0124)
GRANT UPDATE (time_zone) ON tenant_data.tenant TO repracer_admin;
GRANT SELECT (time_zone) ON tenant_data.tenant TO repracer_alert_delivery, repracer_resolver;

/**
 * Пояс показа тенанта — одна функция для консоли, письма алерта и письма тени. Принадлежит хранителю (0128: читает тенанта,
 * аккаунты и справочник витрин всех тенантов): у роли доставки справочника витрин нет. Отдаёт только имя пояса.
 */
CREATE FUNCTION tenant_data.display_time_zone(p_tenant_id uuid) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  /**
   * Ревью шага 69, находка 7: у витрин США пояса в справочнике нет (A-03, OQ-112), и продавец из США видел бы UTC — ровно жалоба K4.
   * Пояс показа витрины США по умолчанию — восточное время (America/New_York, где больше всего покупателей США); продавец меняет его
   * на экране настроек. Пояс справочника для США не берётся вовсе: его ставит принятие границы суток худшим окном [Р-204], и показ
   * всех тенантов США не должен молча переезжать вместе с ним
   */
  SELECT coalesce(
    (SELECT t.time_zone FROM tenant_data.tenant t WHERE t.tenant_id = p_tenant_id),
    (SELECT CASE WHEN m.country = 'US' THEN 'America/New_York' ELSE m.time_zone END
       FROM tenant_data.channel_account a
       JOIN platform.marketplace m ON m.channel = a.channel AND m.marketplace = ANY (a.marketplaces)
      WHERE a.tenant_id = p_tenant_id AND a.disconnected_at IS NULL AND (m.time_zone IS NOT NULL OR m.country = 'US')
      ORDER BY a.connected_at, a.channel_account_id, m.marketplace LIMIT 1),
    'UTC')
$fn$;
COMMENT ON FUNCTION tenant_data.display_time_zone(uuid) IS
  'Шаг 69 (K4): пояс показа времени тенанта — заданный тенантом, иначе пояс первой его витрины (у витрин США — America/New_York), иначе UTC';

-- ---------------------------------------------------------------- 2. неделя письма тени — по поясу продавца
CREATE FUNCTION platform.shadow_digest_period_start(p_at timestamptz, p_time_zone text) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT date_trunc('week', p_at AT TIME ZONE p_time_zone) AT TIME ZONE p_time_zone
$fn$;
COMMENT ON FUNCTION platform.shadow_digest_period_start(timestamptz, text) IS
  'Шаг 69 (K4): понедельник 00:00 недели в поясе продавца — начало периода письма тени';

/**
 * Возвращаемый набор вырос на пояс показа (письмо называет период в поясе продавца), поэтому функция пересоздаётся, а не правится
 * заменой текста. Фрагменты, на которые ссылается каталог мутаций (фильтр демо, 0167), сохранены дословно.
 */
DROP FUNCTION platform.shadow_digest_targets(interval);
CREATE FUNCTION platform.shadow_digest_targets(p_since interval DEFAULT '7 days'::interval)
 RETURNS TABLE(tenant_id uuid, tenant_name text, locale text, owner_email text, shadow_accounts bigint, decisions bigint, changes bigint, floor_held bigint, ceiling_held bigint, held_writes bigint, held_price_writes bigint, held_quantity_writes bigint, would_spend_budget bigint, floor_savings jsonb, floor_savings_holds bigint, period_start timestamp with time zone, period_end timestamp with time zone, would_spend_unconfirmed bigint, time_zone text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
  /**
   * НАЧАЛО периода привязано к неделе, а не к моменту вызова. Иначе у каждого прогона свой период, и «одно письмо на
   * период» [Р-174] не значит ничего. Шаг 69 (K4): неделя — в ПОЯСЕ ПРОДАВЦА (понедельник 00:00 по его часам), а не по UTC.
   * Конец — неделей позже в том же поясе (переход на летнее время делает неделю на час длиннее или короче — так и должно быть).
   */
  WITH shadowed AS (
    SELECT t.tenant_id, t.name, t.locale, count(*) AS accounts, tenant_data.display_time_zone(t.tenant_id) AS tz
      FROM tenant_data.tenant t
      JOIN tenant_data.channel_account ca ON ca.tenant_id = t.tenant_id
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND NOT t.demo AND ca.disconnected_at IS NULL
       AND ca.write_mode = 'SHADOW' AND ca.auth_status = 'ACTIVE'
     GROUP BY t.tenant_id, t.name, t.locale
  ), win AS (
    SELECT s.*, platform.shadow_digest_period_start(now() - p_since, s.tz) AS from_ts,
           (date_trunc('week', (now() - p_since) AT TIME ZONE s.tz) + interval '7 days') AT TIME ZONE s.tz AS to_ts
      FROM shadowed s
  )
  SELECT w.tenant_id, w.name, w.locale, security.tenant_owner_email(w.tenant_id), w.accounts,
         coalesce(d.decisions, 0), coalesce(d.changes, 0), coalesce(d.floor_held, 0), coalesce(d.ceiling_held, 0),
         coalesce(h.held, 0), coalesce(h.held_price, 0), coalesce(h.held_quantity, 0), coalesce(h.would_spend, 0),
         fs.savings, fs.priced, w.from_ts, w.to_ts,
         platform.shadow_would_spend_unconfirmed(w.tenant_id, w.from_ts, w.to_ts), w.tz
    FROM win w
    CROSS JOIN LATERAL platform.shadow_floor_savings_between(w.tenant_id, w.from_ts, w.to_ts) fs
    LEFT JOIN LATERAL (
      SELECT count(*) AS decisions,
             count(*) FILTER (WHERE pd.outcome = 'APPROVED') AS changes,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_floor_minor) AS floor_held,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_ceiling_minor) AS ceiling_held
        FROM channel_data.price_decision pd
       WHERE pd.tenant_id = w.tenant_id AND pd.shadow AND pd.decided_at >= w.from_ts AND pd.decided_at < w.to_ts) d ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS held,
             count(*) FILTER (WHERE wh.field <> 'QUANTITY') AS held_price,
             count(*) FILTER (WHERE wh.field = 'QUANTITY') AS held_quantity,
             count(*) FILTER (WHERE wh.would_spend_budget) AS would_spend
        FROM tenant_data.channel_write_history wh
       WHERE wh.tenant_id = w.tenant_id AND wh.final_status = 'SHADOW_HELD' AND wh.finished_at >= w.from_ts AND wh.finished_at < w.to_ts) h ON true
   /**
    * Ревью шага 69, находка 7: неделя — в поясе тенанта, а пояс может смениться (настройка, первая витрина). Письмо, уже собранное за
    * неделю с ДРУГИМ началом, закрывает пересекающийся период: второго письма почти за ту же неделю нет [Р-174]
    */
   WHERE NOT EXISTS (SELECT 1 FROM tenant_data.shadow_digest sd
                      WHERE sd.tenant_id = w.tenant_id AND sd.period_start <> w.from_ts AND sd.period_start < w.to_ts AND sd.period_end > w.from_ts)
   ORDER BY w.name
$function$;

-- ---------------------------------------------------------------- 3. название товара из обнаружения [OQ-249]
/**
 * Название, прочитанное из канала, — ДАННЫЕ КАНАЛА (ревью шага 69, находка 4): у Amazon это `itemName` товара каталога Amazon,
 * у Kaufland — название товара каталога Kaufland. Срок — 18 месяцев с последнего чтения в любом слое [Р-3, инвариант 9]. Поэтому у
 * названия есть отметка последнего чтения: обнаружение обновляет её (не чаще раза в 30 суток, если название не изменилось), удаление
 * по сроку стирает название, которое не читалось 18 месяцев. Название продавца (импорт, посев, ручная правка) отметки не имеет и
 * обнаружением не затирается.
 */
ALTER TABLE tenant_data.product ADD COLUMN title_channel_read_at timestamptz;
COMMENT ON COLUMN tenant_data.product.title_channel_read_at IS
  'Шаг 69 (OQ-249, Р-3): когда название последний раз прочитано из канала; NULL — название продавца, а не канала';
-- Столбец разрешён к правке тем же стражем, что название (0004): перечень разрешённых столбцов — аргументы триггера
DROP TRIGGER product_restrict_update ON tenant_data.product;
CREATE TRIGGER product_restrict_update BEFORE UPDATE ON tenant_data.product
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('sku', 'title', 'gtin', 'mpn', 'brand', 'tax_category', 'status', 'updated_at', 'title_channel_read_at');
-- Роль каталога пишет название НОВОМУ товару и обновляет название из канала; хранитель стирает просроченное
GRANT INSERT (title, title_channel_read_at), UPDATE (title, title_channel_read_at), SELECT (title, title_channel_read_at)
  ON tenant_data.product TO repracer_catalog;
GRANT SELECT (title_channel_read_at), UPDATE (title, title_channel_read_at) ON tenant_data.product TO repracer_retention;
CREATE POLICY retention_channel_title_expiry ON tenant_data.product FOR UPDATE TO repracer_retention USING (true) WITH CHECK (true);

-- Функциями владеют роль каталога (0134) и хранитель (0012): правка — вне SET ROLE, как в 0169 (CREATE OR REPLACE сохраняет владельца)
RESET ROLE;
/**
 * Правка — заменой текста определения, как в 0169: функция несёт правки шагов 44, 45, 47 и 65, и переписывать её целиком значило бы
 * рисковать любой из них. Новый товар получает название и отметку чтения; известный — обновление названия из канала (одна правка до
 * разветвления на ветки товара), если у него нет названия продавца.
 */
DO $m$
DECLARE
  def text := pg_get_functiondef('tenant_data.record_discovered_offers(uuid, uuid, jsonb)'::regprocedure);
  fixed text;
BEGIN
  fixed := replace(def, $x$external_listing_id text, listing_format text, writable boolean)$x$,
                        $x$external_listing_id text, listing_format text, writable boolean, title text)$x$);
  fixed := replace(fixed, $x$INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin)$x$,
                          $x$INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind, gtin, title, title_channel_read_at)$x$);
  fixed := replace(fixed, $x$'SIMPLE', nullif(o.gtin, ''));$x$,
                          $x$'SIMPLE', nullif(o.gtin, ''), nullif(btrim(left(o.title, 200)), ''),
                CASE WHEN nullif(btrim(left(o.title, 200)), '') IS NOT NULL THEN now() END);$x$);
  fixed := replace(fixed, $x$    -- Действующее сопоставление есть — предложение уже в каталоге; завершённое (ENDED) каталогизируется заново
    CONTINUE WHEN EXISTS$x$,
                          $x$    /**
     * Шаг 69 (OQ-249, Р-3): у предложения, которое уже в каталоге, название из канала обновляется и отметка чтения продлевается (не
     * чаще раза в 30 суток, если название то же) — до того, как известное предложение будет пропущено. Товар — тот же, что у
     * действующего сопоставления (тот же поиск, что ниже); название продавца (без отметки чтения) не трогается
     */
    IF nullif(btrim(left(o.title, 200)), '') IS NOT NULL THEN
      UPDATE tenant_data.product p SET title = nullif(btrim(left(o.title, 200)), ''), title_channel_read_at = now()
       WHERE p.tenant_id = p_tenant_id
         AND p.product_id IN (SELECT om.product_id FROM tenant_data.offer_mapping om
                               WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = o.marketplace
                                 AND om.status <> 'ENDED'
                                 AND (om.external_sku = coalesce(o.external_sku, o.external_unit_id)
                                      OR (om.external_sku IS NULL AND om.external_unit_id = coalesce(o.external_sku, o.external_unit_id))))
         AND (p.title IS NULL OR p.title_channel_read_at IS NOT NULL)
         AND (p.title IS DISTINCT FROM nullif(btrim(left(o.title, 200)), '') OR p.title_channel_read_at IS NULL
              OR p.title_channel_read_at < now() - interval '30 days');
    END IF;
    -- Действующее сопоставление есть — предложение уже в каталоге; завершённое (ENDED) каталогизируется заново
    CONTINUE WHEN EXISTS$x$);
  IF fixed = def OR (length(fixed) - length(replace(fixed, 'THEN now() END);', ''))) / length('THEN now() END);') <> 2
     OR (length(fixed) - length(replace(fixed, 'title_channel_read_at = now()', ''))) / length('title_channel_read_at = now()') <> 1 THEN
    RAISE EXCEPTION 'record_discovered_offers: the product inserts or the scope lookup were not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;

/** Удаление по сроку стирает название из канала, не читавшееся 18 месяцев [Р-3]: столбец, а не строка — товар остаётся */
DO $m$
DECLARE
  def text := pg_get_functiondef('maintenance.delete_expired_rows(timestamptz, integer)'::regprocedure);
  fixed text;
BEGIN
  fixed := replace(def, $x$    total := total + tbl;
  END LOOP;
  RETURN total;$x$, $x$    total := total + tbl;
  END LOOP;
  -- Шаг 69 (OQ-249, Р-3): название товара, прочитанное из канала, — данные канала: 18 месяцев с последнего чтения
  UPDATE tenant_data.product SET title = NULL, title_channel_read_at = NULL WHERE title_channel_read_at < p_now - interval '18 months';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN total + n;$x$);
  IF fixed = def THEN
    RAISE EXCEPTION 'delete_expired_rows: the end of the function was not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 4. Р-204: граница суток — худшим окном после недели тени
/**
 * Статус пояса витрины получает третье значение: ACCEPTED_WORST_CASE — пояс канала НЕ подтверждён, но принят по Р-204: бюджет
 * правок держится в любых скользящих 24 часах (второй слой адаптера, Р-163), и неделя тени это показала. Вопрос (A-03, OQ-112)
 * остаётся открытым. Ставит этот статус только журнал принятия ниже.
 */
ALTER TABLE platform.marketplace DROP CONSTRAINT marketplace_time_zone_status_check;
ALTER TABLE platform.marketplace ADD CONSTRAINT marketplace_time_zone_status_check
  CHECK (time_zone_status IN ('CONFIRMED', 'TO_VERIFY', 'ACCEPTED_WORST_CASE'));

/** Ревизия витрин: принятое худшим окном — CONSERVATIVE (бой не держит), а не CONFIRMED и не UNKNOWN */
-- Функции ревизии и стражей дня бюджета правятся вне SET ROLE: их владельцы — не владелец схемы (CREATE OR REPLACE сохраняет владельца)
RESET ROLE;
DO $m$
DECLARE
  def text := pg_get_functiondef('platform.marketplace_readiness()'::regprocedure);
  anchor constant text := $x$CASE WHEN m.time_zone_status = 'CONFIRMED' THEN 'CONFIRMED'$x$;
  fixed text;
BEGIN
  fixed := replace(def, anchor, anchor || $x$
              -- Шаг 69 [Р-204]: пояс принят худшим окном после недели тени — консервативно, вопрос открыт
              WHEN m.time_zone_status = 'ACCEPTED_WORST_CASE' THEN 'CONSERVATIVE'$x$);
  IF fixed = def THEN
    RAISE EXCEPTION 'marketplace_readiness: the day boundary status was not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;

/** День бюджета правок боевой записи: пояс, принятый по Р-204, годится так же, как подтверждённый — худшее окно держит адаптер */
DO $m$
DECLARE
  f text;
  def text;
  fixed text;
BEGIN
  FOREACH f IN ARRAY ARRAY['tenant_data.channel_write_budget_day_guard()', 'tenant_data.channel_write_budget_day_on_retry()'] LOOP
    def := pg_get_functiondef(f::regprocedure);
    fixed := replace(def, $x$IF mk.time_zone IS NULL OR mk.time_zone_status <> 'CONFIRMED' THEN$x$,
                          $x$IF mk.time_zone IS NULL OR mk.time_zone_status NOT IN ('CONFIRMED', 'ACCEPTED_WORST_CASE') THEN$x$);
    IF fixed = def THEN
      RAISE EXCEPTION '%: the time zone status check was not found — the function changed, update this migration', f;
    END IF;
    EXECUTE fixed;
  END LOOP;
END $m$;
SET ROLE repracer_owner;

/**
 * Журнал принятия. Числа доказательства считает база функцией хранителя ниже; ограничения таблицы — критерий достаточности:
 * не меньше семи суток тени, решения были, худшее окно бюджета правок не больше лимита канала.
 */
CREATE TABLE platform.day_boundary_acceptance (
  -- Тенант — платформенный: строк справочника витрин другого тенанта нет, и внешний ключ ниже это держит (проверка тенанта была бы дублем, Р-104)
  tenant_id                   uuid NOT NULL DEFAULT security.platform_tenant_id(),
  acceptance_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel                     text NOT NULL,
  marketplace                 text NOT NULL,
  -- Пояс, по которому база считает день бюджета и сутки истории цен этой витрины; продавцу время показывается в его поясе
  time_zone                   text NOT NULL CONSTRAINT day_boundary_acceptance_time_zone_known CHECK (security.time_zone_known(time_zone)),
  evidence_tenant_id          uuid NOT NULL,
  evidence_channel_account_id uuid NOT NULL,
  -- Ревью шага 69, находка 3: «неделя тени» — ДЛИТЕЛЬНОСТЬ от первого до последнего теневого решения в целых сутках, а не число дат
  -- (решения с 23:59 первых суток до 00:01 седьмых дают семь дат за пять суток)
  shadow_days                 integer NOT NULL CONSTRAINT day_boundary_acceptance_week_of_shadow CHECK (shadow_days >= 7),
  -- И тень шла подряд: самый длинный перерыв между соседними решениями — не больше полутора суток. Разрозненные дни за две недели
  -- неделей не считаются. Первая редакция требовала решения в каждую дату UTC — и отказывала аккаунту, чьи решения идут раз в сутки:
  -- пересчёт по расписанию берёт единицу через 24 часа и такт после них, время решения сдвигается каждые сутки и однажды перешагивает
  -- полночь UTC, дата остаётся пустой при непрерывной тени (поймал CI шага 69: прожатая неделя с 19:00 UTC, шаг пересчёта — час)
  longest_gap_hours           integer NOT NULL CONSTRAINT day_boundary_acceptance_no_long_gap CHECK (longest_gap_hours <= 36),
  shadow_since                timestamptz NOT NULL,
  decisions                   bigint NOT NULL CONSTRAINT day_boundary_acceptance_decisions_seen CHECK (decisions > 0),
  worst_window_max            bigint NOT NULL,
  budget_limit                integer,
  operator_id                 uuid NOT NULL REFERENCES platform.platform_operator (operator_id),
  note                        text NOT NULL CONSTRAINT day_boundary_acceptance_note_present CHECK (length(btrim(note)) >= 10),
  accepted_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT day_boundary_acceptance_worst_window_within_limit CHECK (budget_limit IS NULL OR worst_window_max <= budget_limit),
  FOREIGN KEY (tenant_id, channel, marketplace) REFERENCES platform.marketplace (tenant_id, channel, marketplace)
);
COMMENT ON TABLE platform.day_boundary_acceptance IS
  'Шаг 69 [Р-204]: граница суток витрины принята худшим окном после недели тени — оператор со вторым фактором, доказательство считает база';
SELECT security.register_table('platform.day_boundary_acceptance', 'SYSTEM', 'append_only', 'none');
REVOKE ALL ON platform.day_boundary_acceptance FROM repracer_app;
REVOKE INSERT, UPDATE, DELETE ON platform.day_boundary_acceptance FROM repracer_admin;
CREATE POLICY day_boundary_acceptance_owner ON platform.day_boundary_acceptance TO repracer_owner USING (true) WITH CHECK (true);
CREATE POLICY day_boundary_acceptance_operator ON platform.day_boundary_acceptance TO repracer_operator_actions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform.day_boundary_acceptance TO repracer_operator_actions;
SELECT security.grant_retention('platform.day_boundary_acceptance');
-- Ревью шага 69, находка 19: строка объясняет, почему бой на витрине открыт, ПОКА витрина в ACCEPTED_WORST_CASE, — срока у неё нет
-- (платформенный тенант не закрывается); удаление через три года оставило бы статус без основания, и проверка схемы 0174 покраснела бы
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('platform.day_boundary_acceptance', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

/**
 * Строка журнала ставит пояс и статус витрины. Подтверждённую границу принятие не трогает — и держит это не условие здесь, а
 * ограничение 0130: у подтверждённой витрины вопроса нет, а у неподтверждённой он обязателен (условие здесь было бы дублем, Р-104)
 */
CREATE FUNCTION platform.day_boundary_acceptance_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  zone text;
BEGIN
  /**
   * Ревью шага 69, находка 1: у витрины, чей пояс уже задан (ebay.de — Europe/Berlin, не подтверждён), принятие худшим окном пояс
   * НЕ меняет: сутки истории цен (Omnibus, §11 PAngV), закрытие суток и день бюджета не переезжают в чужой пояс опечаткой оператора
   */
  SELECT m.time_zone INTO zone FROM platform.marketplace m
   WHERE m.tenant_id = NEW.tenant_id AND m.channel = NEW.channel AND m.marketplace = NEW.marketplace;
  IF zone IS NOT NULL AND zone <> NEW.time_zone THEN
    RAISE EXCEPTION 'storefront % % already counts its days in %: a worst-case acceptance keeps that time zone (Р-204)', NEW.channel, NEW.marketplace, zone
      USING ERRCODE = 'check_violation';
  END IF;
  UPDATE platform.marketplace SET time_zone = NEW.time_zone, time_zone_status = 'ACCEPTED_WORST_CASE',
         time_zone_source = format('Р-204: принят худшим окном после %s суток тени (оператор, %s)', NEW.shadow_days, to_char(NEW.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'))
   WHERE tenant_id = NEW.tenant_id AND channel = NEW.channel AND marketplace = NEW.marketplace;
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_day_boundary_acceptance_apply AFTER INSERT ON platform.day_boundary_acceptance
  FOR EACH ROW EXECUTE FUNCTION platform.day_boundary_acceptance_apply();
-- Функцию триггера не исполняет никто напрямую: SECURITY DEFINER с правом PUBLIC открыл бы её и роли остатков [Р-102]
REVOKE ALL ON FUNCTION platform.day_boundary_acceptance_apply() FROM PUBLIC;

/** Статус «принято худшим окном» ставит ТОЛЬКО журнал (как подтверждение записи количества — только своим журналом, Р-202) */
CREATE FUNCTION platform.marketplace_worst_case_only_by_journal() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.time_zone_status = 'ACCEPTED_WORST_CASE'
     AND (TG_OP = 'INSERT' OR OLD.time_zone_status IS DISTINCT FROM NEW.time_zone_status OR OLD.time_zone IS DISTINCT FROM NEW.time_zone)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'a worst-case day boundary is accepted by a row of platform.day_boundary_acceptance, not directly (Р-204)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a0_marketplace_worst_case_only_by_journal BEFORE INSERT OR UPDATE OF time_zone, time_zone_status ON platform.marketplace
  FOR EACH ROW EXECUTE FUNCTION platform.marketplace_worst_case_only_by_journal();

/**
 * Хранитель читает лимит правок канала: доказательство «худшее окно не больше лимита» без лимита не посчитать. И столбцы, которые
 * читает ревизия витрин (`marketplace_readiness()` исполняется с правами вызывающего): кандидаты — витрины, у которых граница держит
 * бой. Живой прогон панели нашёл это первым же запросом (`permission denied for table channel_capability`) — смоук журнала шёл
 * суперпользователем и функцию кандидатов не звал
 */
CREATE POLICY capability_retention_read ON platform.channel_capability FOR SELECT TO repracer_retention
  USING (tenant_id = security.platform_tenant_id());
GRANT SELECT (tenant_id, channel, field, status, object_edit_limit, valid_from, region, budget_scope_attribute, side_effects,
              write_scope_kind, write_scope_status, write_scope_question, write_scope_closes_by) ON platform.channel_capability TO repracer_retention;

/**
 * Доказательство тени для одного аккаунта на одной витрине за последние p_days суток: сколько суток в тени были решения, сколько
 * их, сколько записей удержано и сколько из них «потратили бы» бюджет правок, и худшее окно — наибольшее число таких записей по
 * одному листингу в любые скользящие 24 часа. Принадлежит хранителю (читает данные тенантов без цен); отдаёт только счётчики.
 */
CREATE FUNCTION platform.day_boundary_shadow_evidence(p_tenant_id uuid, p_channel_account_id uuid, p_marketplace text, p_days int DEFAULT 14)
  RETURNS TABLE (shadow_days integer, longest_gap_hours integer, shadow_since timestamptz, last_shadow_at timestamptz, decisions bigint,
                 held_writes bigint, budget_writes bigint, worst_window_max bigint, budget_limit integer, account_mode text, demo boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  WITH acc AS (
    SELECT a.channel, a.write_mode, t.demo FROM tenant_data.channel_account a JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id
     WHERE a.tenant_id = p_tenant_id AND a.channel_account_id = p_channel_account_id AND a.disconnected_at IS NULL
       AND p_marketplace = ANY (a.marketplaces)
  ), scopes AS (
    SELECT s.write_scope_id FROM tenant_data.offer_mapping om
     CROSS JOIN LATERAL (VALUES (om.price_write_scope_id), (om.quantity_write_scope_id)) s(write_scope_id)
     WHERE om.tenant_id = p_tenant_id AND om.channel_account_id = p_channel_account_id AND om.marketplace = p_marketplace
       AND s.write_scope_id IS NOT NULL
  ), dec AS (
    SELECT pd.decided_at FROM channel_data.price_decision pd
     WHERE pd.tenant_id = p_tenant_id AND pd.shadow AND pd.write_scope_id IN (SELECT write_scope_id FROM scopes)
       AND pd.decided_at >= now() - make_interval(days => p_days)
  ), held AS (
    SELECT h.finished_at, h.would_spend_budget, coalesce(h.budget_scope_key, h.write_scope_id::text) AS k
      FROM tenant_data.channel_write_history h
     WHERE h.tenant_id = p_tenant_id AND h.final_status = 'SHADOW_HELD' AND h.write_scope_id IN (SELECT write_scope_id FROM scopes)
       AND h.finished_at >= now() - make_interval(days => p_days)
  ), win AS (
    SELECT count(*) OVER (PARTITION BY k ORDER BY finished_at RANGE BETWEEN interval '24 hours' PRECEDING AND CURRENT ROW) AS n
      FROM held WHERE would_spend_budget
  )
  /**
   * Ревью шага 69, находка 3: сутки тени — ДЛИТЕЛЬНОСТЬ от первого до последнего решения в целых сутках. Перерыв — самый длинный
   * промежуток между соседними решениями в часах, с округлением вверх (0 — решение одно или их нет); даты UTC не считаются: решения раз
   * в сутки сдвигаются и перешагивают полночь (см. столбец журнала)
   */
  SELECT (SELECT floor(extract(epoch FROM max(decided_at) - min(decided_at)) / 86400)::int FROM dec),
         (SELECT coalesce(ceil(max(extract(epoch FROM decided_at - prev)) / 3600), 0)::int
            FROM (SELECT decided_at, lag(decided_at) OVER (ORDER BY decided_at) AS prev FROM dec) g),
         (SELECT min(decided_at) FROM dec), (SELECT max(decided_at) FROM dec), (SELECT count(*) FROM dec),
         (SELECT count(*) FROM held), (SELECT count(*) FROM held WHERE would_spend_budget),
         coalesce((SELECT max(n) FROM win), 0),
         (SELECT (c.object_edit_limit ->> 'limit')::int FROM platform.channel_capability c
           WHERE c.channel = (SELECT channel FROM acc) AND c.field = 'PRICE' AND c.status = 'ACTIVE' AND c.object_edit_limit IS NOT NULL
           ORDER BY c.valid_from DESC LIMIT 1),
         (SELECT write_mode FROM acc), (SELECT demo FROM acc)
$fn$;
COMMENT ON FUNCTION platform.day_boundary_shadow_evidence(uuid, uuid, text, int) IS
  'Шаг 69 [Р-204]: доказательство тени аккаунта на витрине — сутки тени, решения, удержанные записи и худшее окно бюджета правок; только счётчики';

/**
 * Кандидаты для панели [Р-168]: витрины, у которых граница суток держит бой (UNKNOWN), и теневые аккаунты НЕ демо на них —
 * с доказательством. Демо-тенант доказательством не бывает: его данные синтетические [Р-151].
 */
CREATE FUNCTION platform.day_boundary_candidates() RETURNS TABLE (
  channel text, marketplace text, status text, question text, tenant_id uuid, tenant_name text, channel_account_id uuid,
  shadow_days integer, longest_gap_hours integer, shadow_since timestamptz, decisions bigint, held_writes bigint, budget_writes bigint,
  worst_window_max bigint, budget_limit integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT r.channel, r.marketplace, r.status, r.question, a.tenant_id, t.name, a.channel_account_id,
         e.shadow_days, e.longest_gap_hours, e.shadow_since, e.decisions, e.held_writes, e.budget_writes, e.worst_window_max, e.budget_limit
    FROM platform.marketplace_readiness() r
    JOIN tenant_data.channel_account a ON a.channel = r.channel AND r.marketplace = ANY (a.marketplaces)
                                      AND a.disconnected_at IS NULL AND a.write_mode = 'SHADOW' AND a.auth_status = 'ACTIVE'
    JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id AND NOT t.demo
   CROSS JOIN LATERAL platform.day_boundary_shadow_evidence(a.tenant_id, a.channel_account_id, r.marketplace) e
   WHERE r.property = 'DAY_BOUNDARY' AND r.status = 'UNKNOWN'
   ORDER BY r.channel, r.marketplace, e.shadow_days DESC, t.name
$fn$;

RESET ROLE;

ALTER FUNCTION tenant_data.display_time_zone(uuid) OWNER TO repracer_retention;
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;
ALTER FUNCTION platform.day_boundary_shadow_evidence(uuid, uuid, text, int) OWNER TO repracer_retention;
ALTER FUNCTION platform.day_boundary_candidates() OWNER TO repracer_retention;
REVOKE ALL ON FUNCTION tenant_data.display_time_zone(uuid), platform.shadow_digest_targets(interval),
  platform.day_boundary_shadow_evidence(uuid, uuid, text, int), platform.day_boundary_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.display_time_zone(uuid) TO repracer_admin, repracer_alert_delivery, repracer_resolver;
GRANT EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) TO repracer_alert_delivery;
GRANT EXECUTE ON FUNCTION platform.day_boundary_shadow_evidence(uuid, uuid, text, int), platform.day_boundary_candidates() TO repracer_operator_actions;

SET ROLE repracer_owner;

/**
 * 5. Действие оператора [Р-204, расширение Р-166]: принять границу суток витрины худшим окном. Доказательство оператор НЕ
 * вводит — его считает база; оператор называет витрину, пояс (по которому база будет делить сутки), теневой аккаунт-доказательство
 * и заметку. Демо-тенант доказательством не бывает [Р-151], аккаунт должен быть в тени и на этой витрине.
 */
CREATE FUNCTION security.operator_accept_day_boundary(p_operator_id uuid, p_channel text, p_marketplace text, p_time_zone text,
  p_tenant_id uuid, p_channel_account_id uuid, p_note text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
  e record;
  acc_channel text;
  id uuid;
BEGIN
  /**
   * Ревью шага 69, находка 9: два оператора одной витрины идут по очереди — второй ждёт первого и видит, что витрина уже не кандидат.
   * Блокировка транзакции по имени витрины (строку справочника роли действий блокировать нечем: права на правку у неё нет)
   */
  PERFORM pg_advisory_xact_lock(hashtext('day_boundary:' || p_channel || ':' || p_marketplace));
  SELECT * INTO e FROM platform.day_boundary_shadow_evidence(p_tenant_id, p_channel_account_id, p_marketplace);
  SELECT a.channel INTO acc_channel FROM platform.day_boundary_candidates() a
   WHERE a.channel_account_id = p_channel_account_id AND a.marketplace = p_marketplace LIMIT 1;
  IF e.account_mode IS NULL OR acc_channel IS DISTINCT FROM p_channel THEN
    RAISE EXCEPTION 'account % is not a shadow account of a customer tenant on storefront % % with an unknown day boundary (Р-204)',
      p_channel_account_id, p_channel, p_marketplace USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO platform.day_boundary_acceptance (channel, marketplace, time_zone, evidence_tenant_id, evidence_channel_account_id,
                                                shadow_days, longest_gap_hours, shadow_since, decisions, worst_window_max, budget_limit,
                                                operator_id, note)
  VALUES (p_channel, p_marketplace, p_time_zone, p_tenant_id, p_channel_account_id,
          coalesce(e.shadow_days, 0), coalesce(e.longest_gap_hours, 0), coalesce(e.shadow_since, now()), e.decisions, e.worst_window_max,
          e.budget_limit, p_operator_id, p_note)
  RETURNING acceptance_id INTO id;
  PERFORM security.operator_audit(p_operator_id, security.platform_tenant_id(), 'operator.day_boundary_accepted', 'platform.day_boundary_acceptance', id,
    jsonb_build_object('channel', p_channel, 'marketplace', p_marketplace, 'time_zone', p_time_zone, 'shadow_days', e.shadow_days,
                       'longest_gap_hours', e.longest_gap_hours,
                       'worst_window_max', e.worst_window_max, 'budget_limit', e.budget_limit, 'operator', who));
  RETURN id;
END $fn$;

/** Чтение панели [Р-168]: кандидаты и уже принятые */
CREATE FUNCTION platform.operator_day_boundaries() RETURNS TABLE (
  channel text, marketplace text, status text, question text, tenant_id uuid, tenant_name text, channel_account_id uuid,
  shadow_days integer, longest_gap_hours integer, shadow_since timestamptz, decisions bigint, held_writes bigint, budget_writes bigint,
  worst_window_max bigint, budget_limit integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT * FROM platform.day_boundary_candidates()
$fn$;
CREATE FUNCTION platform.operator_day_boundary_acceptances(p_limit int DEFAULT 100) RETURNS TABLE (
  acceptance_id uuid, channel text, marketplace text, time_zone text, shadow_days integer, longest_gap_hours integer, decisions bigint,
  worst_window_max bigint, budget_limit integer, operator text, note text, accepted_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT j.acceptance_id, j.channel, j.marketplace, j.time_zone, j.shadow_days, j.longest_gap_hours, j.decisions, j.worst_window_max, j.budget_limit,
         o.display_name, j.note, j.accepted_at
    FROM platform.day_boundary_acceptance j JOIN platform.platform_operator o ON o.operator_id = j.operator_id
   ORDER BY j.accepted_at DESC LIMIT greatest(1, least(p_limit, 500))
$fn$;

RESET ROLE;

-- Функции панели — у узкой роли действий, как четыре прежних (0126); права панели — только исполнять их
ALTER FUNCTION security.operator_accept_day_boundary(uuid, text, text, text, uuid, uuid, text) OWNER TO repracer_operator_actions;
ALTER FUNCTION platform.operator_day_boundaries() OWNER TO repracer_operator_actions;
ALTER FUNCTION platform.operator_day_boundary_acceptances(int) OWNER TO repracer_operator_actions;
REVOKE ALL ON FUNCTION security.operator_accept_day_boundary(uuid, text, text, text, uuid, uuid, text), platform.operator_day_boundaries(),
  platform.operator_day_boundary_acceptances(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.operator_accept_day_boundary(uuid, text, text, text, uuid, uuid, text), platform.operator_day_boundaries(),
  platform.operator_day_boundary_acceptances(int) TO repracer_operator;
GRANT SELECT ON platform.platform_operator TO repracer_operator_actions;

COMMIT;
