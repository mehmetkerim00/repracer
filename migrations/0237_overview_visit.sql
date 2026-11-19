-- 0237_overview_visit.sql
-- Шаг 172 (#34, ярус 2, часть 2; решение владельца 2026-11-18): «Since your last visit» — отметка последнего визита на пользователя.
--
-- `tenant_data.overview_visit` — журнал визитов Daily Overview только на добавление: визит человека (его членство в тенанте) и момент. Визит — открытие
-- Overview, если прошлый визит этого человека старше 30 минут; окно карточек — от визита ДО нынешнего. Строку пишет административный сервис именем
-- человека: членство — того человека, что в сессии; момент ставит база. Аудит — общим триггером административной записи (кто и когда).
-- Право — то же, что видеть цены (VIEW_PRICING): Overview открывает любой участник.
BEGIN;
SET ROLE repracer_owner;

CREATE TABLE tenant_data.overview_visit (
  tenant_id     uuid NOT NULL,
  visit_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL,
  visited_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, visit_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);
COMMENT ON TABLE tenant_data.overview_visit IS
  'Шаг 172: визиты Daily Overview человека — журнал только на добавление; окно «Since your last visit» — от визита до нынешнего; до закрытия тенанта';
SELECT security.register_table('tenant_data.overview_visit', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.overview_visit');
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.overview_visit', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Последние визиты человека — начало окна Overview (два последних)
CREATE INDEX overview_visit_member_idx ON tenant_data.overview_visit (tenant_id, membership_id, visited_at DESC);
GRANT SELECT, INSERT (tenant_id, membership_id) ON tenant_data.overview_visit TO repracer_admin;
RESET ROLE;

/** Визит — того человека, что в сессии (что человек в сессии есть и у его роли право видеть цены, проверяет общий страж административной записи); момент — часы базы */
CREATE FUNCTION tenant_data.overview_visit_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  person uuid;
BEGIN
  SELECT mb.user_id INTO person FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.membership_id AND mb.status = 'ACTIVE';
  IF person IS NULL OR person IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.membership_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.visited_at := now();
  RETURN NEW;
END $fn$;
ALTER FUNCTION tenant_data.overview_visit_guard() OWNER TO repracer_owner;
CREATE TRIGGER b_overview_visit_guard BEFORE INSERT ON tenant_data.overview_visit FOR EACH ROW EXECUTE FUNCTION tenant_data.overview_visit_guard();

-- Страж и аудит административной записи [Р-97, Р-100]: визит — действие человека, событием в аудите (кто и когда)
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.overview_visit
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.overview_visit
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Р-100: визит пишет любой участник, который видит цены
DO $do$
DECLARE
  d text := pg_get_functiondef('security.admin_write_action(text)'::regprocedure);
  a text := $s$('tenant_data.default_strategy_change', 'MANAGE_PRICING'),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0237: security.admin_write_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 172: визит Daily Overview — тем же правом, что видеть цены
    ('tenant_data.overview_visit', 'VIEW_PRICING'),$s$);
END $do$;

-- Закрытие тенанта уносит журнал РАНЬШЕ членства, на которое он ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.offer_pricing_switch',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0237: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.overview_visit', 'tenant_data.offer_pricing_switch',$s$);
END $do$;

COMMIT;
