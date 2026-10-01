-- 0167_demo_digest_and_shadow_reset.sql
-- Шаг 64, ревью шага: две поправки к теневому режиму [Р-169…Р-171], найденные на профиле США.
--
-- 1. Демо-тенант недельного дайджеста тени не получает (находка 3 ревью). Цели дайджеста — клиентские тенанты с аккаунтом в тени,
--    признак демо функция не смотрела. Пока аккаунт Kaufland демо был боевым, демо в выборку не попадало; с шага 64 у демо аккаунты
--    витрин США, рождённые в тени [Р-176], и планировщик писал бы раз в неделю владельцу демо — по письму на каждый пересев демо.
--    Демо — синтетика для показа [Р-151], отчёт о нём не адресован никому.
--
-- 2. Смена режима записи забывает последнее предложение тени (находка 5 ревью). `last_shadow_amount_minor` пишет только страж
--    вставки теневой записи, и после пути «тень → бой → тень» движок сравнивал новое предложение с ценой, удержанной в ПРОШЛОЙ тени:
--    бой успел записать другую цену, стратегия снова предлагает прежнюю — и получала NO_OP `SHADOW_ALREADY_PROPOSED`, экран тени и
--    дайджест не показывали изменение, которое бой сделал бы. Предложение живёт в пределах одного периода тени.

BEGIN;

-- ---------------------------------------------------------------- 1. дайджест без демо-тенантов
/**
 * Функция правится по месту (как в 0132): её тело велико, и копия во второй миграции разошлась бы с первой. Владелец, права и
 * `SECURITY DEFINER` сохраняются — `CREATE OR REPLACE` из `pg_get_functiondef` несёт все атрибуты.
 */
DO $m$
DECLARE
  def text := pg_get_functiondef('platform.shadow_digest_targets(interval)'::regprocedure);
  fixed text;
BEGIN
  fixed := replace(def, $x$WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND ca.disconnected_at IS NULL$x$,
                        $x$WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND NOT t.demo AND ca.disconnected_at IS NULL$x$);
  IF fixed = def THEN
    RAISE EXCEPTION 'shadow_digest_targets: the tenant filter was not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;

-- ---------------------------------------------------------------- 2. смена режима забывает предложение тени
DO $m$
DECLARE
  def text := pg_get_functiondef('tenant_data.channel_write_mode_apply()'::regprocedure);
  anchor constant text := $x$  UPDATE tenant_data.channel_account SET write_mode = NEW.to_mode
   WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id;
$x$;
  fixed text;
BEGIN
  fixed := replace(def, anchor, anchor || $x$  -- Шаг 64 (ревью, находка 5): предложение тени живёт в пределах одного периода тени — при любой смене режима оно забыто
  UPDATE tenant_data.write_scope_sync_state ss SET last_shadow_amount_minor = NULL
    FROM tenant_data.write_scope ws
   WHERE ws.tenant_id = ss.tenant_id AND ws.write_scope_id = ss.write_scope_id
     AND ss.tenant_id = NEW.tenant_id AND ws.channel_account_id = NEW.channel_account_id
     AND ss.last_shadow_amount_minor IS NOT NULL;
$x$);
  IF fixed = def THEN
    RAISE EXCEPTION 'channel_write_mode_apply: the account update was not found — the function changed, update this migration';
  END IF;
  EXECUTE fixed;
END $m$;
ALTER FUNCTION tenant_data.channel_write_mode_apply() OWNER TO repracer_owner;

COMMENT ON COLUMN tenant_data.write_scope_sync_state.last_shadow_amount_minor IS
  'Шаг 41 [Р-171]: последняя цена, УДЕРЖАННАЯ тенью в ТЕКУЩЕМ периоде тени (шаг 64: смена режима её забывает). Не «отправлено» и не «подтверждено»: в канал она не уходила.';

COMMIT;
