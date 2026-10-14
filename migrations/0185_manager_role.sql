-- 0185_manager_role.sql
-- Шаг 88 [Р-213]: одна роль на человека в рабочем пространстве и три видимые роли — Owner, Manager, Viewer.
--
-- Одна роль на человека держалась с первой схемы и не меняется: членство — одна строка на (тенант, пользователь)
-- (`membership_tenant_id_user_id_key`, 0002), роль — один столбец. Второе членство того же человека в том же тенанте отвергает
-- база; в разных тенантах роли у человека разные (агентство).
--
-- Новая роль MANAGER — ежедневная работа: цены, границы, стратегии, остатки, импорт себестоимости, массовые операции, стоп-кран.
-- Это повседневная часть прежних ADMIN и PRICING_MANAGER: права MANAGE_PRICING и ENABLE_REPRICING менеджера цен, MANAGE_CATALOG
-- (остатки) и стоп-кран целиком — остановка, возобновление тенанта и витрины, снятие системной остановки и недоверия каналу (у
-- двух последних база и прежде требовала второй фактор). Управления людьми и аккаунтами каналов (MANAGE_TENANT) у неё нет, как нет
-- и того, что база отдаёт только владельцу: перевод в бой [Р-170], подтверждение записи количества [Р-202], согласие на миграцию
-- eBay [Р-101]. Менять роли и приглашать по-прежнему могут только владелец и администратор (`membership_role_change_guard`,
-- `security.invite_member`) — их списки ролей названы явно и MANAGER не включают.
--
-- Прежние роли (ADMIN, OPERATOR, PRICING_MANAGER, INVENTORY_MANAGER) не удаляются и их права не меняются: существующие назначения
-- работают как работали; консоль прячет их за флагом развёртывания «расширенные роли». Матрица прав в базе и в коде одна и та же —
-- совпадение по каждой роли и каждому праву проверяет тест (step14, finding 2), а набор ролей, который принимает ограничение
-- членства, сверяет с кодом тест шага 88.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Роль MANAGER в членстве
ALTER TABLE tenant_data.membership DROP CONSTRAINT membership_role_check;
ALTER TABLE tenant_data.membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('OWNER', 'MANAGER', 'VIEWER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER'));

COMMENT ON CONSTRAINT membership_tenant_id_user_id_key ON tenant_data.membership IS
  'Р-213 (шаг 88): у человека в рабочем пространстве ровно одна роль — одно членство на (тенант, пользователь). Нужны права двух ролей — назначается одна старшая.';

-- ---------------------------------------------------------------- 2. Права MANAGER в матрице (совпадает с PRICING_PERMISSIONS в коде)
CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'           THEN ARRAY['OWNER', 'MANAGER', 'VIEWER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER']
    WHEN 'STOP_PRICING'           THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'     THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'    THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT'   THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_DISTRUST' THEN ARRAY['OWNER', 'MANAGER', 'ADMIN']
    WHEN 'ENABLE_REPRICING'       THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'MANAGE_PRICING'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'PRICING_MANAGER']
    WHEN 'MANAGE_CATALOG'         THEN ARRAY['OWNER', 'MANAGER', 'ADMIN', 'INVENTORY_MANAGER']
    WHEN 'MANAGE_TENANT'          THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'GIVE_MIGRATION_CONSENT' THEN ARRAY['OWNER']
    ELSE ARRAY[]::text[] END), false)
$function$;

RESET ROLE;

COMMIT;
