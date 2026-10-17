-- 0191_two_roles_demo_guest.sql
-- Шаг 98 [Р-222] (решение владельца): ролей для людей две — Owner и Manager. Права одинаковые во всём, кроме денег: биллинг — только
-- владелец (биллинга в продукте ещё нет — ADR-0057). Всё, что база отдавала только владельцу, теперь у менеджера тоже: перевод аккаунта
-- в бой [Р-170], подтверждение и отзыв записи количества [Р-202], снятие недоверия каналу [Р-118], приглашение людей и смена ролей
-- (MANAGE_TENANT), согласие на миграцию eBay [Р-101]. Второй фактор и обязательные заметки остаются у обеих ролей: это подтверждение
-- действия, а не различие ролей.
--
-- Одно исключение держится намеренно: роль ВЛАДЕЛЬЦА выдаёт, снимает и отзывает только владелец. Иначе менеджер назначил бы себя
-- владельцем, и «биллинг — только Owner» обходился бы одним действием.
--
-- Наблюдатель (VIEWER) удалён. Гость публичного демо [Р-160] — не роль продукта, а внутренняя техническая роль GUEST «только чтение»:
-- людям не назначается и не показывается. Правило «GUEST — тогда и только тогда, когда членство гостевое» — ограничение (его теперь есть
-- чем провалить: приглашение с ролью GUEST, гость с другой ролью); оно же держит правило «гость не повышается».

BEGIN;

-- ---------------------------------------------------------------- 1. Наблюдателей-людей в базе быть не должно — fail-closed
-- Данные — от суперпользователя: у таблицы членств FORCE RLS, и владелец схемы без контекста тенанта увидел бы ноль строк
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM tenant_data.membership WHERE role = 'VIEWER' AND NOT guest;
  IF n > 0 THEN
    RAISE EXCEPTION 'step 98: % memberships of people still hold the removed VIEWER role — give them a role (Owner or Manager) or revoke them before this migration (Р-222)', n;
  END IF;
END $$;

-- ---------------------------------------------------------------- 2. Гость — техническая роль GUEST
ALTER TABLE tenant_data.membership DROP CONSTRAINT membership_role_check;
-- Гость повышения не знает (страж 0124), а журнал ролей и страж смены ролей ждут человека в сессии: техническое переименование роли
-- гостя идёт без них — это не действие человека и не смена прав (гость читал и читает)
ALTER TABLE tenant_data.membership DISABLE TRIGGER USER;
UPDATE tenant_data.membership SET role = 'GUEST' WHERE guest AND role = 'VIEWER';
ALTER TABLE tenant_data.membership ENABLE TRIGGER USER;

SET ROLE repracer_owner;
ALTER TABLE tenant_data.membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('OWNER', 'MANAGER', 'GUEST', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER'));
-- Р-160: технический гость — только гостевое членство, и гостевое членство — только технический гость
ALTER TABLE tenant_data.membership ADD CONSTRAINT membership_guest_role CHECK ((role = 'GUEST') = guest);
COMMENT ON COLUMN tenant_data.membership.guest IS
  'Шаг 37 [Р-160], шаг 98 [Р-222]: членство публичного гостя демо. Заводится без приглашения (исключение из Р-98), поэтому ограничено: только демо-тенант, только техническая роль GUEST (не роль продукта: людям не назначается и не показывается), гостем остаётся навсегда, заданий не создаёт.';

-- ---------------------------------------------------------------- 3. Матрица прав: менеджер = владелец; гость только читает
CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'             THEN ARRAY['OWNER', 'MANAGER', 'GUEST', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER']
    WHEN 'STOP_PRICING'             THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'       THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'      THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT'     THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_DISTRUST' THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'ENABLE_REPRICING'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RETURN_TO_SHADOW'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'MANAGE_PRICING'           THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'PRICING_MANAGER']
    WHEN 'MANAGE_CATALOG'           THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'INVENTORY_MANAGER']
    WHEN 'MANAGE_TENANT'            THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'GIVE_MIGRATION_CONSENT'   THEN ARRAY['OWNER', 'MANAGER']
    ELSE ARRAY[]::text[] END), false)
$fn$;
RESET ROLE;

-- ---------------------------------------------------------------- 4. Стражи «только владелец» — владелец или менеджер
-- Определения правятся точечно, через pg_get_functiondef: так сохраняются владелец функции, SECURITY DEFINER, search_path и права
-- (CREATE OR REPLACE с неполным определением их сбрасывал, шаг 19). Каждая замена проверяет, что нашла свой фрагмент
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_from text, p_to text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE d text := pg_get_functiondef(p_fn);
BEGIN
  IF position(p_from IN d) = 0 THEN RAISE EXCEPTION 'step 98: % does not contain «%»', p_fn, p_from; END IF;
  EXECUTE replace(d, p_from, p_to);
END $fn$;

SELECT pg_temp.patch('tenant_data.channel_quantity_writes_confirmation_guard()',
  $s$IF m.role IS DISTINCT FROM 'OWNER' THEN
    RAISE EXCEPTION 'only the owner confirms or revokes quantity writes of a channel account (Р-202)'$s$,
  $s$IF m.role IS DISTINCT FROM 'OWNER' AND m.role IS DISTINCT FROM 'MANAGER' THEN
    RAISE EXCEPTION 'only the owner or a manager confirms or revokes quantity writes of a channel account (Р-202, Р-222)'$s$);

SELECT pg_temp.patch('tenant_data.channel_write_mode_change_guard()',
  $s$IF m.role <> 'OWNER' THEN
      RAISE EXCEPTION 'only the owner switches a channel account to LIVE writes (Р-170)'$s$,
  $s$IF m.role NOT IN ('OWNER', 'MANAGER') THEN
      RAISE EXCEPTION 'only the owner or a manager switches a channel account to LIVE writes (Р-170, Р-222)'$s$);

SELECT pg_temp.patch('tenant_data.membership_role_change_guard()',
  $s$AND m.role IN ('OWNER', 'ADMIN') AND m.membership_id <> NEW.membership_id;$s$,
  $s$AND m.role IN ('OWNER', 'MANAGER', 'ADMIN') AND m.membership_id <> NEW.membership_id;$s$);
SELECT pg_temp.patch('tenant_data.membership_role_change_guard()',
  $s$is changed only by another active owner or admin in their session$s$,
  $s$is changed only by another active owner, manager or admin in their session$s$);

SELECT pg_temp.patch('security.invite_member(uuid,text,text,bytea,interval)',
  $s$IF inviter IS NULL OR inviter.role NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'only an active owner or admin of the tenant invites members'$s$,
  $s$IF inviter IS NULL OR inviter.role NOT IN ('OWNER', 'MANAGER', 'ADMIN') THEN
    RAISE EXCEPTION 'only an active owner, manager or admin of the tenant invites members'$s$);

-- Перепривязка входа [Р-98] — то же приглашение человека: владелец или менеджер. Вход ВЛАДЕЛЬЦА перепривязывает только владелец — иначе
-- менеджер перепривязал бы вход владельца на себя и получил бы его роль (то же исключение, что у смены роли)
SELECT pg_temp.patch('security.invite_relink(uuid,uuid,bytea,interval)',
  $s$IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m
                  WHERE m.tenant_id = p_tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE' AND m.role = 'OWNER') THEN
    RAISE EXCEPTION 'only an active owner of the tenant relinks a sign-in (Р-98)' USING ERRCODE = 'insufficient_privilege';
  END IF;$s$,
  $s$IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m
                  WHERE m.tenant_id = p_tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE' AND m.role IN ('OWNER', 'MANAGER')) THEN
    RAISE EXCEPTION 'only an active owner or manager of the tenant relinks a sign-in (Р-98, Р-222)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant_data.membership m WHERE m.tenant_id = p_tenant_id AND m.user_id = security.current_user_id() AND m.status = 'ACTIVE' AND m.role = 'OWNER')
     AND EXISTS (SELECT 1 FROM tenant_data.membership m WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.status = 'ACTIVE' AND m.role = 'OWNER') THEN
    RAISE EXCEPTION 'only an owner relinks the sign-in of an owner (Р-98, Р-222)' USING ERRCODE = 'insufficient_privilege';
  END IF;$s$);

SELECT pg_temp.patch('security.create_demo_guest(uuid,text,text,text)',
  $s$VALUES (p_tenant_id, v_membership, v_user, 'VIEWER', 'ACTIVE', true);$s$,
  $s$VALUES (p_tenant_id, v_membership, v_user, 'GUEST', 'ACTIVE', true);$s$);

-- «Гость не повышается» [Р-160] теперь держит ограничение membership_guest_role: признак гостя не меняется (права на столбец нет ни у
-- кого, кроме роли, создающей членства), а любая другая роль у гостевого членства ему противоречит. Прежний страж смены роли гостя стал
-- дублем — мутация «снять страж» ловилась бы ограничением, а не своей проверкой [Р-104], — и удаляется
DROP TRIGGER b_membership_guest_stays_guest ON tenant_data.membership;
DROP FUNCTION tenant_data.membership_guest_stays_guest();

COMMIT;
