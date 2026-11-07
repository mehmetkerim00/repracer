-- 0222_offer_pricing_switch.sql
-- Шаг 118 (решение владельца по докладу 117, обязательный шаг MVP): «вот этот SKU не трогай». Владелец или менеджер выключает автоцену одного предложения
-- и включает обратно — без второго фактора: забор не двигается (Р-225); записка по желанию — это не экстренная остановка.
--
-- 1. `tenant_data.offer_pricing_switch` — журнал только на добавление: кто, когда, выключил или включил, записка. Строку пишет административный сервис
--    именем человека; аудит — общим триггером административной записи (кто и когда).
--    Смену режима «кто и когда» пишет в аудит общий триггер административной записи на любом пути; журнал добавляет записку и строку экрана.
-- 2. Страж Р-12 «режим не меняется при незавершённых записях» остаётся для переходов со Smart Pricing Kaufland. Между ENGINE и OFF он больше не держит:
--    «не трогай» действует сразу, а запись, уже отправленная в канал, доходит до своего итога.
-- 3. Цена предложения с выключенной автоценой в канал не уходит: перевод записи в отправку отклоняет прежний страж отправки (0008, сейчас 0128:
--    «pricing_mode changed to …»), диспетчер завершает её причиной WRITE_PRICING_MODE_CHANGED — и ждавшую в очереди, и повтор уже ушедшей.
--    До шага эта ветка была почти недостижима (Р-12 не давал сменить режим при незавершённых записях); второго стража не нужно (Р-104).
BEGIN;
SET ROLE repracer_owner;

CREATE TABLE tenant_data.offer_pricing_switch (
  tenant_id                uuid NOT NULL,
  switch_id                uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Порядок строк одной единицы: действующая — последняя по нему
  seq                      bigint GENERATED ALWAYS AS IDENTITY,
  write_scope_id           uuid NOT NULL,
  -- OFF — автоцена выключена, ON — включена обратно (или впервые)
  action                   text NOT NULL,
  -- Записка «зачем» — по желанию
  note                     text,
  created_by_membership_id uuid NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, switch_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT offer_pricing_switch_action_known CHECK (action IN ('OFF', 'ON')),
  CONSTRAINT offer_pricing_switch_note_form CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 500))
);
COMMENT ON TABLE tenant_data.offer_pricing_switch IS
  'Шаг 118: выключение и включение автоцены одного предложения человеком — журнал только на добавление, до закрытия тенанта';
SELECT security.register_table('tenant_data.offer_pricing_switch', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.offer_pricing_switch');
INSERT INTO maintenance.retention_policy (table_name, method, bound) VALUES ('tenant_data.offer_pricing_switch', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Последняя строка единицы — статус «выключено кем и когда» на экране Offers
CREATE INDEX offer_pricing_switch_scope_idx ON tenant_data.offer_pricing_switch (tenant_id, write_scope_id, seq DESC);
GRANT SELECT, INSERT (tenant_id, write_scope_id, action, note, created_by_membership_id) ON tenant_data.offer_pricing_switch TO repracer_admin;
RESET ROLE;

/**
 * Кто и что. Членство — того человека, что в сессии (что человек в сессии есть и у него право на цену, проверяет общий страж административной записи).
 * Выключить можно только включённое движком предложение, включить — только выключенное
 */
CREATE FUNCTION tenant_data.offer_pricing_switch_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  person uuid;
  mode   text;
BEGIN
  SELECT mb.user_id INTO person FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.created_by_membership_id AND mb.status = 'ACTIVE';
  IF person IS NULL OR person IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.created_by_membership_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.pricing_mode INTO mode FROM tenant_data.write_scope s WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id AND s.field = 'PRICE';
  IF NEW.action = 'OFF' AND mode IS DISTINCT FROM 'ENGINE' THEN
    RAISE EXCEPTION 'automatic pricing of write_scope % is not on (mode %): nothing to turn off', NEW.write_scope_id, coalesce(mode, 'none')
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'ON' AND mode IS DISTINCT FROM 'OFF' THEN
    RAISE EXCEPTION 'automatic pricing of write_scope % is not off (mode %): nothing to turn on', NEW.write_scope_id, coalesce(mode, 'none')
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $fn$;
ALTER FUNCTION tenant_data.offer_pricing_switch_guard() OWNER TO repracer_owner;
CREATE TRIGGER b_offer_pricing_switch_guard BEFORE INSERT ON tenant_data.offer_pricing_switch FOR EACH ROW EXECUTE FUNCTION tenant_data.offer_pricing_switch_guard();

-- Р-12: режим цены не меняется при незавершённых записях — для переходов со Smart Pricing Kaufland. Между ENGINE и OFF — меняется: невышедшие записи
-- завершит страж отправки (пункт 3), ушедшая доходит до своего итога
CREATE OR REPLACE FUNCTION tenant_data.write_scope_mode_switch_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pricing_mode IS DISTINCT FROM OLD.pricing_mode
     AND NOT (OLD.pricing_mode IN ('ENGINE', 'OFF') AND NEW.pricing_mode IN ('ENGINE', 'OFF')) AND (
       EXISTS (SELECT 1 FROM tenant_data.channel_write w
                WHERE w.tenant_id = NEW.tenant_id AND w.write_scope_id = NEW.write_scope_id
                  AND w.status IN ('PENDING', 'BLOCKED', 'DISPATCHED', 'FAILED'))
    OR EXISTS (SELECT 1 FROM tenant_data.write_scope_sync_state ss
                WHERE ss.tenant_id = NEW.tenant_id AND ss.write_scope_id = NEW.write_scope_id
                  AND ss.in_flight_write_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'write_scope % has unfinished writes; pricing_mode cannot change', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION tenant_data.write_scope_mode_switch_guard() OWNER TO repracer_owner;

-- Страж и аудит административной записи [Р-97, Р-100]: выключение и включение — действие человека, событием в аудите (кто и когда)
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.offer_pricing_switch
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.offer_pricing_switch
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Р-100: журнал пишет тот, кто вправе включать автоцену (владелец и менеджер), — тем же правом, что смена режима единицы
DO $do$
DECLARE
  d text := pg_get_functiondef('security.admin_write_action(text)'::regprocedure);
  a text := $s$('tenant_data.default_strategy_change', 'MANAGE_PRICING'),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0222: security.admin_write_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 118: выключение и включение автоцены одного предложения — тем же правом, что смена режима единицы
    ('tenant_data.offer_pricing_switch', 'ENABLE_REPRICING'),$s$);
END $do$;

-- Закрытие тенанта уносит журнал РАНЬШЕ единицы записи, на которую он ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.clearance_change',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0222: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.offer_pricing_switch', 'tenant_data.clearance_change',$s$);
END $do$;

COMMIT;
