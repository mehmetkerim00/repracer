-- 0045_stop_audit_roles_strategy.sql
-- Шаг 13:
--  Р-76: остановки цен человеком и системные остановки витрин пишутся в audit.audit_event триггерами — с автором, ролью в момент
--        действия, заметкой и областью; остановку или снятие без события аудита записать нельзя.
--  OQ-129: одна матрица прав на остановку и возобновление — security.pricing_permission; копия в коде — PRICING_PERMISSIONS.
--  Р-77: стратегия хранится на единице записи независимо от режима (выключенное предложение знает свою стратегию);
--        движок без стратегии не включается.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Матрица прав [OQ-129]
-- ---------------------------------------------------------------------------
CREATE FUNCTION security.pricing_permission(p_role text, p_action text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'         THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER']
    WHEN 'STOP_PRICING'         THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'   THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'  THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT' THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'ENABLE_REPRICING'     THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    ELSE ARRAY[]::text[] END), false)
$$;
GRANT EXECUTE ON FUNCTION security.pricing_permission(text, text) TO repracer_app;

CREATE OR REPLACE FUNCTION tenant_data.price_stop_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  member_id uuid;
  r         text;
  u         uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'price stop % is already released', OLD.price_stop_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  member_id := CASE TG_OP WHEN 'INSERT' THEN NEW.stopped_by_membership_id ELSE NEW.released_by_membership_id END;
  IF TG_OP = 'UPDATE' AND NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.role, m.user_id INTO r, u FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = member_id AND m.status = 'ACTIVE';
  IF r IS NULL
     OR (TG_OP = 'INSERT' AND NOT security.pricing_permission(r, 'STOP_PRICING'))
     OR (TG_OP = 'UPDATE' AND NOT security.pricing_permission(r, CASE WHEN NEW.scope_type = 'TENANT' THEN 'RESUME_TENANT_STOP' ELSE 'RESUME_CHANNEL_STOP' END)) THEN
    RAISE EXCEPTION 'membership % (role %) may not % a % price stop', member_id, coalesce(r, 'none'),
      CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'release' END, NEW.scope_type USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- В сессии пользователя действовать можно только от своего членства
  IF security.current_user_id() IS NOT NULL AND u IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % belongs to another user', member_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION channel_data.pricing_halt_release_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r text;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_kind = 'MANUAL' THEN
    SELECT m.role INTO r FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR NOT security.pricing_permission(r, 'RELEASE_CHANNEL_HALT') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.released_by_membership_id, coalesce(r, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Аудит остановок [Р-76]
-- ---------------------------------------------------------------------------
-- occurred_at — время записи действия в базе (now()); время из запроса — в changes.at: часы запроса не обходят проверку
-- audit_event «не из будущего», а событие не теряет исходное время.
CREATE FUNCTION tenant_data.price_stop_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  created boolean := TG_OP = 'INSERT';
  member  uuid;
  m       record;
BEGIN
  IF NOT created AND (OLD.released_at IS NOT NULL OR NEW.released_at IS NULL) THEN
    RETURN NULL;
  END IF;
  member := CASE WHEN created THEN NEW.stopped_by_membership_id ELSE NEW.released_by_membership_id END;
  SELECT mm.role, mm.user_id INTO m FROM tenant_data.membership mm WHERE mm.tenant_id = NEW.tenant_id AND mm.membership_id = member;
  IF m IS NULL THEN
    RAISE EXCEPTION 'price stop %: author % is not a member; the audit event needs its author (Р-76)', NEW.price_stop_id, member
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'USER', m.user_id, member,
          CASE WHEN created THEN 'pricing.stop_created' ELSE 'pricing.stop_released' END, 'price_stop', NEW.price_stop_id,
          jsonb_build_object(
            'role', m.role, 'scope', NEW.scope_type, 'channelAccountId', NEW.channel_account_id, 'marketplace', NEW.marketplace,
            'note', CASE WHEN created THEN NEW.stop_note ELSE NEW.release_note END,
            'at', CASE WHEN created THEN NEW.stopped_at ELSE NEW.released_at END));
  RETURN NULL;
END $$;
CREATE TRIGGER zb_price_stop_audit AFTER INSERT OR UPDATE ON tenant_data.price_stop
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_stop_audit();

-- Системная остановка витрины — действие системы
CREATE FUNCTION channel_data.pricing_halt_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'SYSTEM', 'pricing.halt_created', 'pricing_halt', NEW.pricing_halt_id,
          jsonb_build_object('reasonCode', NEW.reason_code, 'scope', CASE WHEN NEW.marketplace IS NULL THEN 'CHANNEL_ACCOUNT' ELSE 'STOREFRONT' END,
                             'channelAccountId', NEW.channel_account_id, 'marketplace', NEW.marketplace, 'at', NEW.halted_at));
  RETURN NULL;
END $$;
CREATE TRIGGER zb_pricing_halt_audit AFTER INSERT ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_audit();

-- Снятие системной остановки: выборкой — система, вручную — участник с ролью и заметкой (журнал проверок, Р-52)
CREATE FUNCTION channel_data.pricing_halt_review_audit() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  h          record;
  actor_user uuid;
  actor_role text;
  manual     boolean := NEW.kind = 'MANUAL_RELEASE';
BEGIN
  SELECT ph.channel_account_id, ph.marketplace INTO h FROM channel_data.pricing_halt ph
   WHERE ph.tenant_id = NEW.tenant_id AND ph.pricing_halt_id = NEW.pricing_halt_id;
  IF manual THEN
    SELECT mm.user_id, mm.role INTO actor_user, actor_role FROM tenant_data.membership mm
     WHERE mm.tenant_id = NEW.tenant_id AND mm.membership_id = NEW.membership_id;
    IF actor_user IS NULL THEN
      RAISE EXCEPTION 'halt release %: author % is not a member; the audit event needs its author (Р-76)', NEW.pricing_halt_review_id, NEW.membership_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), CASE WHEN manual THEN 'USER' ELSE 'SYSTEM' END, actor_user, CASE WHEN manual THEN NEW.membership_id END,
          'pricing.halt_released', 'pricing_halt', NEW.pricing_halt_id,
          jsonb_build_object('kind', NEW.kind, 'role', actor_role, 'note', NEW.note,
                             'scope', CASE WHEN h.marketplace IS NULL THEN 'CHANNEL_ACCOUNT' ELSE 'STOREFRONT' END,
                             'channelAccountId', h.channel_account_id, 'marketplace', h.marketplace, 'at', NEW.reviewed_at));
  RETURN NULL;
END $$;
CREATE TRIGGER zb_pricing_halt_review_audit AFTER INSERT ON channel_data.pricing_halt_review
  FOR EACH ROW WHEN (NEW.outcome = 'RELEASED') EXECUTE FUNCTION channel_data.pricing_halt_review_audit();

-- ---------------------------------------------------------------------------
-- 3. Стратегия независимо от режима [Р-77]
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.write_scope
  -- Было: стратегия только у ENGINE — у выключенного предложения тип стратегии был неизвестен (OQ-127)
  DROP CONSTRAINT write_scope_check3,
  -- Р-12: единица записи в режиме Smart Pricing Kaufland не имеет нашей стратегии
  ADD CONSTRAINT write_scope_strategy_not_smart_pricing CHECK (pricing_strategy_id IS NULL OR pricing_mode IS DISTINCT FROM 'KAUFLAND_SMART_PRICING'),
  ADD CONSTRAINT write_scope_engine_has_strategy CHECK (pricing_mode IS DISTINCT FROM 'ENGINE' OR pricing_strategy_id IS NOT NULL);

RESET ROLE;
COMMIT;
