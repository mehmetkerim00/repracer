-- 0239_client_channels_amazon_us.sql: клиентский тенант — только amazon.com (шаг 176, Р-256; продолжение Р-251).
--
-- Зачем. Консоль развёртывания с `REPRACER_CLIENT_CHANNELS=amazon_us` клиенту других каналов не предлагает и прямой запрос подключения
-- отклоняет. Но витрину аккаунта ставит не только консоль: подключение OAuth, посев, ручная правка административной роли. Рамка MVP
-- держится там, где её нельзя обойти одним процессом, — в базе (инвариант в БД, правило репозитория).
--
-- Решение — свойство БАЗЫ, как запрет боевых записей шага 119: `ALTER DATABASE <пилот> SET repracer.client_channels = 'amazon_us'`
-- (ставит первая сборка базы пилота, `deploy/pilot/db.sh`). Пока она стоит, у тенанта не демо:
--   1) аккаунт канала не заводится и не меняется ни на какую витрину, кроме amazon.com, — отказ своей причиной;
--   2) запрос согласия на подключение (OAuth) не начинается ни у какого канала, кроме Amazon amazon.com.
-- Демо-тенант — исключение: симуляторная витрина держит три канала, на ней держатся перепроверки QA. Признак демо задаётся при создании
-- тенанта и неизменяем (0115). Читается правами вызывающего: тенант, которого роль не видит, — не демо, безопасная сторона.
--
-- Настройка читается из КАТАЛОГА (уровень базы): `SET` в сессии её не снимает. Значение, кроме `all`, сужает — опечатка закрывает
-- базу, а не открывает (fail-closed, инвариант 6). Базы без настройки (тесты, QA-A с одним демо) — как до шага.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Правило — одной функцией у двух входов
CREATE FUNCTION security.client_channels_restricted() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(bool_or(cfg <> 'repracer.client_channels=all'), false)
    FROM pg_catalog.pg_db_role_setting s
    CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
   WHERE s.setrole = 0
     AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
     AND starts_with(cfg, 'repracer.client_channels=')
$fn$;
COMMENT ON FUNCTION security.client_channels_restricted() IS
  'Р-256 (шаг 176): на этой базе клиентский тенант — только amazon.com: настройка уровня базы repracer.client_channels (любое значение, кроме all). Сессией не снимается';

CREATE FUNCTION security.client_channel_refused(p_tenant_id uuid, p_channel text, p_marketplaces text[]) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT security.client_channels_restricted()
     AND NOT EXISTS (SELECT 1 FROM tenant_data.tenant t WHERE t.tenant_id = p_tenant_id AND t.demo)
     AND NOT (p_channel = 'AMAZON' AND cardinality(p_marketplaces) > 0 AND p_marketplaces <@ ARRAY['ATVPDKIKX0DER']::text[])
$fn$;
COMMENT ON FUNCTION security.client_channel_refused(uuid, text, text[]) IS
  'Р-256 (шаг 176): витрина не для клиентского тенанта на этой базе — база сужена настройкой, тенант не демо, витрина не amazon.com (пустой список — тоже)';

REVOKE EXECUTE ON FUNCTION security.client_channels_restricted() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION security.client_channel_refused(uuid, text, text[]) FROM PUBLIC;
-- Аккаунты и запросы согласия заводит административная роль (подключение, посев); владелец схемы исполняет свои функции и так
GRANT EXECUTE ON FUNCTION security.client_channels_restricted() TO repracer_admin;
GRANT EXECUTE ON FUNCTION security.client_channel_refused(uuid, text, text[]) TO repracer_admin;

-- ---------------------------------------------------------------- 2. Аккаунт канала — только amazon.com
/**
 * Вставка и смена канала или витрин. Имя ставит страж первым среди стражей аккаунта (a00 раньше a0_): на суженной базе причина — сама
 * рамка, а не свойства витрины или режим. Условие — внутри функции, а не в WHEN: условие WHEN — только из перечня (правило 14e)
 */
CREATE FUNCTION tenant_data.channel_account_client_channels_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF security.client_channel_refused(NEW.tenant_id, NEW.channel, NEW.marketplaces) THEN
    RAISE EXCEPTION 'client channels are Amazon US only on this database: tenant % is a client tenant, % % cannot be connected (R-256)',
      NEW.tenant_id, NEW.channel, NEW.marketplaces
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a00_channel_account_client_channels_guard BEFORE INSERT OR UPDATE OF channel, marketplaces ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_client_channels_guard();

-- ---------------------------------------------------------------- 3. Подключение (OAuth) — не начинается к другому каналу
CREATE FUNCTION tenant_data.channel_authorization_request_client_channels_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF security.client_channel_refused(NEW.tenant_id, NEW.channel, NEW.marketplaces) THEN
    RAISE EXCEPTION 'client channels are Amazon US only on this database: tenant % is a client tenant, % % cannot be connected (R-256)',
      NEW.tenant_id, NEW.channel, NEW.marketplaces
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a00_channel_authorization_request_client_channels_guard BEFORE INSERT ON tenant_data.channel_authorization_request
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_authorization_request_client_channels_guard();

RESET ROLE;

COMMIT;
