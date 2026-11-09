-- 0224_qa_live_writes_guard.sql: база, где боевые записи запрещены (шаг 119, P0-09; ADR-0073, Р-243).
--
-- Зачем. «Тень безопасна» держит база [Р-169], но перевести аккаунт QA в бой ничто не мешало, кроме человека: владелец со вторым фактором
-- и набранным именем аккаунта включал бой и на QA. Как только в QA появится настоящий Amazon (чтение в тени), одна ошибка человека
-- изменила бы настоящую цену.
--
-- Решение — свойство БАЗЫ, а не процесса: `ALTER DATABASE <qa> SET repracer.live_writes = 'forbidden'` (ставит владелец базы при
-- развёртывании QA; в боевой базе настройки нет). Пока она стоит, у тенанта не демо:
--   1) аккаунт канала не переводится в бой и не рождается боевым — отказ своей причиной, раньше остальных проверок перевода;
--   2) ни одна запись не уходит в канал — отказ перед КАЖДОЙ отправкой, как пол цены [Р-83] и тень [Р-169]: аккаунт мог быть боевым
--      до того, как базу закрыли (копия боевой базы, восстановленная в QA, или бой, включённый до стража).
-- Демо-тенант — исключение: его боевой путь на симуляторе QA и проверяет. Признак демо задаётся при создании тенанта и неизменяем (0115).
--
-- Настройка читается из КАТАЛОГА (`pg_db_role_setting`, уровень базы), а не `current_setting`: `SET` в сессии её не снимает, снять может
-- только владелец базы (`ALTER DATABASE … RESET`). Значение, кроме `allowed`, запрещает — опечатка закрывает базу, а не открывает
-- (fail-closed, инвариант 6). Признак демо читается правами вызывающего: тенант, которого роль не видит, считается не демо — и это та же
-- безопасная сторона.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Правило — одной функцией у трёх входов [Р-104 по духу]
CREATE FUNCTION security.live_writes_forbidden() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(bool_or(cfg <> 'repracer.live_writes=allowed'), false)
    FROM pg_catalog.pg_db_role_setting s
    CROSS JOIN LATERAL unnest(s.setconfig) AS cfg
   WHERE s.setrole = 0
     AND s.setdatabase = (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
     AND starts_with(cfg, 'repracer.live_writes=')
$fn$;
COMMENT ON FUNCTION security.live_writes_forbidden() IS
  'P0-09 (шаг 119): на этой базе боевые записи запрещены — настройка уровня базы repracer.live_writes (любое значение, кроме allowed). Сессией не снимается';

CREATE FUNCTION security.live_writes_refused(p_tenant_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT security.live_writes_forbidden()
     AND NOT EXISTS (SELECT 1 FROM tenant_data.tenant t WHERE t.tenant_id = p_tenant_id AND t.demo)
$fn$;
COMMENT ON FUNCTION security.live_writes_refused(uuid) IS
  'P0-09 (шаг 119): боевая запись тенанта на этой базе запрещена — база закрыта настройкой, тенант не демо (невидимый тенант — тоже не демо)';

REVOKE EXECUTE ON FUNCTION security.live_writes_forbidden() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION security.live_writes_refused(uuid) FROM PUBLIC;
-- Стражи срабатывают правами пути решения, диспетчера и административного сервиса — все они в роли приложения
GRANT EXECUTE ON FUNCTION security.live_writes_forbidden() TO repracer_app;
GRANT EXECUTE ON FUNCTION security.live_writes_refused(uuid) TO repracer_app;

-- ---------------------------------------------------------------- 2. Аккаунт не рождается боевым
/**
 * Перевод в бой держит страж журнала ниже; рождение боевым — этот. Правку столбца режима мимо журнала отклоняет страж 0128, поэтому
 * обновление аккаунта отдельного стража не требует. Условие — внутри функции, а не в WHEN: условие WHEN — только из перечня (правило 14e).
 */
CREATE FUNCTION tenant_data.channel_account_born_live_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.write_mode = 'LIVE' AND security.live_writes_refused(NEW.tenant_id) THEN
    RAISE EXCEPTION 'live writes are forbidden on this database: tenant % is not a demo tenant, its channel accounts stay in SHADOW (P0-09)', NEW.tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
-- Имя ставит страж раньше стража свойств витрин (a_channel_account_live_marketplaces_known): на закрытой базе причина — сама база
CREATE TRIGGER a0_channel_account_born_live_guard BEFORE INSERT ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_born_live_guard();

-- ---------------------------------------------------------------- 3. Перед КАЖДОЙ отправкой — заново
/**
 * Тот же переход, что проверяют тень (0128) и подтверждение количества (0160): в отправку. Страж идёт после основного стража записи
 * (`b_channel_write_before_update`): тень, версия и пол называют свою причину первыми, а этот отказывает записи, которая иначе ушла бы.
 * Диспетчер и путь решения распознают отказ и завершают запись причиной WRITE_LIVE_WRITES_FORBIDDEN — обход не падает (класс находки 7 шага 15).
 */
CREATE FUNCTION tenant_data.channel_write_live_writes_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  account uuid;
BEGIN
  IF NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  IF security.live_writes_refused(NEW.tenant_id) THEN
    SELECT ws.channel_account_id INTO account FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
    RAISE EXCEPTION 'live writes are forbidden on this database: channel account % of a non-demo tenant sends nothing (P0-09)', account
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER be_channel_write_live_writes_guard BEFORE UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_live_writes_guard();

-- ---------------------------------------------------------------- 4. Причина завершения записи
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_reason_known;
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY[
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED',
    'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED', 'CHANNEL_DISTRUSTED', 'PRICING_STOPPED',
    'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED', 'WRITE_BUDGET_DAY_UNCONFIRMED',
    'WRITE_HELD_IN_SHADOW', 'QUANTITY_WRITES_REVOKED', 'WRITE_LIVE_WRITES_FORBIDDEN']));

/**
 * Реестры параметров причин (0099) знают новую причину — значением прежнего реестра плюс новая, как в 0160: переписывать длинный
 * список руками — значит рисковать молча потерять чужую причину
 */
DO $do$
BEGIN
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$,
    security.eternal_param_keys() || '{"WRITE_LIVE_WRITES_FORBIDDEN":["channelAccountId"]}'::jsonb);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$,
    security.eternal_param_kinds() || '{"WRITE_LIVE_WRITES_FORBIDDEN":{"channelAccountId":{"k":"id"}}}'::jsonb);
END $do$;

RESET ROLE;

-- ---------------------------------------------------------------- 5. Перевод в бой — первым делом
/**
 * Страж журнала режимов правится точечно, через pg_get_functiondef — как в 0191: так сохраняются его прежние правки (менеджер переводит
 * в бой, шаг 98), владелец функции, search_path и права. Новая проверка — в начале ветки «в бой», раньше роли, второго фактора,
 * подтверждения и свойств витрин: на закрытой базе бой не включится всё равно, и называть сначала «нужен второй фактор» значило бы
 * обещать, что с ним получится. Замена проверяет, что нашла свой фрагмент
 */
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_from text, p_to text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE d text := pg_get_functiondef(p_fn);
BEGIN
  IF position(p_from IN d) = 0 THEN RAISE EXCEPTION 'step 119: % does not contain «%»', p_fn, p_from; END IF;
  EXECUTE replace(d, p_from, p_to);
END $fn$;

SELECT pg_temp.patch('tenant_data.channel_write_mode_change_guard()',
  $s$IF NEW.to_mode = 'LIVE' THEN
    IF m.role NOT IN ('OWNER', 'MANAGER') THEN$s$,
  $s$IF NEW.to_mode = 'LIVE' THEN
    -- Шаг 119 (P0-09): закрытая база не переводит в бой ни одного аккаунта тенанта не демо — раньше всех остальных проверок
    IF security.live_writes_refused(NEW.tenant_id) THEN
      RAISE EXCEPTION 'live writes are forbidden on this database: tenant % is not a demo tenant, its channel accounts stay in SHADOW (P0-09)', NEW.tenant_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF m.role NOT IN ('OWNER', 'MANAGER') THEN$s$);

COMMIT;
