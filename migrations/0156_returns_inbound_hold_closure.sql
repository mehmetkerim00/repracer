-- 0156_returns_inbound_hold_closure.sql
-- Шаг 59: три решения владельца.
--
-- Р-199 (OQ-218) — возврат виден, на полку ставит человек. Строка заказа «возвращено» по отгруженной резервации становится строкой
--   `channel_data.order_return`: у внутреннего пула — PENDING, пока человек с правом на каталог не решит «принять на склад» (движение RETURN
--   с автором, аудит) или «не принимать»; у источника Inbound API — INFO_ONLY: остаток не наш [Р-6], возвраты ведёт система продавца.
--   «Возвращено» канала не значит «лежит на полке и годно к продаже» — автоматического возврата в пул нет.
-- Р-200 (OQ-223) — отгрузка при источнике Inbound API: вычитание отгруженного держится, пока источник не пришлёт остаток с `asOf` позже
--   подтверждения заказа (правило — в запросах пересчёта, код); источник, молчащий сутки, — WARNING один раз на резервацию.
-- Р-201 (OQ-22) — закрытие тенанта: доказательства цен выгружаются клиенту, 30 суток льготы, затем удаляется всё; удержание — только с
--   основанием в аудите. `purge_tenant_data` больше не принимает флаг «удалить доказательства» — они удаляются всегда, но только после
--   выгрузки и льготы.

BEGIN;
SET ROLE repracer_owner;

-- ================================================================ Р-199: возвраты
CREATE TABLE channel_data.order_return (
  tenant_id                uuid NOT NULL,
  order_return_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  reservation_id           uuid NOT NULL,
  product_id               uuid NOT NULL,
  stock_pool_id            uuid NOT NULL,
  source_mode              text NOT NULL,
  quantity                 integer NOT NULL CHECK (quantity > 0),
  channel                  text NOT NULL,
  channel_order_line_ref   text NOT NULL,
  reported_at              timestamptz NOT NULL DEFAULT now(),
  status                   text NOT NULL,
  decided_at               timestamptz,
  decided_by_membership_id uuid,
  stock_movement_id        uuid,
  note                     text,
  PRIMARY KEY (tenant_id, order_return_id),
  -- Одна строка возврата на резервацию: повтор строки заказа канала её не удваивает
  UNIQUE (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES channel_data.reservation (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, decided_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, stock_movement_id) REFERENCES tenant_data.stock_movement (tenant_id, stock_movement_id),
  CONSTRAINT order_return_status_known CHECK (status IN ('PENDING', 'ACCEPTED', 'DISMISSED', 'INFO_ONLY')),
  -- Решать о возврате можно только во внутреннем пуле: у источника Inbound API строка — для сведения [Р-6]
  CONSTRAINT order_return_info_only_iff_foreign_pool CHECK ((status = 'INFO_ONLY') = (source_mode <> 'INTERNAL_POOL')),
  -- Решение — с автором и временем; на склад — только движением
  CONSTRAINT order_return_decision_has_author CHECK ((status IN ('ACCEPTED', 'DISMISSED')) = (decided_at IS NOT NULL AND decided_by_membership_id IS NOT NULL)),
  CONSTRAINT order_return_accepted_has_movement CHECK ((status = 'ACCEPTED') = (stock_movement_id IS NOT NULL))
);
COMMENT ON TABLE channel_data.order_return IS
  'Шаг 59 [Р-199]: возврат по отгруженной резервации; на склад ставит человек движением RETURN, у источника Inbound API — только сведения';
SELECT security.register_table('channel_data.order_return', 'CHANNEL', 'mutable', 'none');
SELECT security.grant_retention('channel_data.order_return');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, bound)
VALUES ('channel_data.order_return', 'DELETE_ROWS', 'reported_at', interval '18 months', 'MAX_AGE');
ALTER TABLE channel_data.order_return ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_data.order_return FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON channel_data.order_return FOR ALL TO repracer_app
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY stock_tenant ON channel_data.order_return FOR ALL TO repracer_stock
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
-- Строку возврата заводит конвейер заказов (роль остатков); решение пишет человек административной ролью
GRANT SELECT, INSERT (tenant_id, reservation_id, product_id, stock_pool_id, source_mode, quantity, channel, channel_order_line_ref, status)
  ON channel_data.order_return TO repracer_stock;
GRANT SELECT, UPDATE (status, decided_at, decided_by_membership_id, stock_movement_id, note) ON channel_data.order_return TO repracer_admin;
-- Экран остатков — список ждущих решения возвратов тенанта
CREATE INDEX order_return_pending_idx ON channel_data.order_return (tenant_id, reported_at) WHERE status = 'PENDING';

/**
 * Страж решения [Р-199]: из PENDING — один раз, в ACCEPTED или DISMISSED; принятое на склад — ровно движением RETURN этого пула на
 * количество возврата, сделанным тем же человеком; неизменяемые столбцы строки не меняются. Время решения ставит база
 */
CREATE FUNCTION channel_data.order_return_decision_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  mv record;
BEGIN
  IF OLD.status <> 'PENDING' THEN
    RAISE EXCEPTION 'return % is already decided (%) (Р-199)', OLD.order_return_id, OLD.status USING ERRCODE = 'check_violation';
  END IF;
  -- Куда можно из PENDING, держат ограничения строки (`order_return_status_known`, `order_return_info_only_iff_foreign_pool`,
  -- `order_return_decision_has_author`) — второй проверкой здесь был бы дубль [Р-104]
  IF (NEW.reservation_id, NEW.product_id, NEW.stock_pool_id, NEW.source_mode, NEW.quantity, NEW.channel, NEW.channel_order_line_ref, NEW.reported_at)
     IS DISTINCT FROM (OLD.reservation_id, OLD.product_id, OLD.stock_pool_id, OLD.source_mode, OLD.quantity, OLD.channel, OLD.channel_order_line_ref, OLD.reported_at) THEN
    RAISE EXCEPTION 'a return keeps what the channel reported' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'ACCEPTED' THEN
    SELECT m.stock_pool_id, m.delta, m.reason, m.created_by_membership_id INTO mv FROM tenant_data.stock_movement m
     WHERE m.tenant_id = NEW.tenant_id AND m.stock_movement_id = NEW.stock_movement_id;
    IF mv.reason IS DISTINCT FROM 'RETURN' OR mv.stock_pool_id IS DISTINCT FROM NEW.stock_pool_id OR mv.delta IS DISTINCT FROM NEW.quantity
       OR mv.created_by_membership_id IS DISTINCT FROM NEW.decided_by_membership_id THEN
      RAISE EXCEPTION 'an accepted return is a RETURN movement of its pool for its quantity by the same person (Р-199)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  NEW.decided_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_order_return_decision_guard BEFORE UPDATE ON channel_data.order_return
  FOR EACH ROW EXECUTE FUNCTION channel_data.order_return_decision_guard();

-- Шаг 59 [Р-200]: страховка — источник Inbound API, молчащий сутки после подтверждения отгруженного заказа, — WARNING один раз на резервацию
ALTER TABLE channel_data.reservation ADD COLUMN source_silence_alerted_at timestamptz;
GRANT UPDATE (source_silence_alerted_at) ON channel_data.reservation TO repracer_stock;
-- Страж изменяемых столбцов резервации — с новым столбцом (без него отметка молчания отказывала бы на каждом заходе работы заказов;
-- найдено тестом шага 59)
DROP TRIGGER a_reservation_restrict_update ON channel_data.reservation;
CREATE TRIGGER a_reservation_restrict_update BEFORE UPDATE ON channel_data.reservation
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('status', 'confirmed_at', 'confirmed_by_stock_source_id', 'confirmed_external_order_ref',
    'consumed_at', 'released_at', 'release_reason', 'closed_at', 'shipped_reported_at', 'stale_alerted_at', 'source_silence_alerted_at');

-- ================================================================ ревью шага 58, находки 1, 2, 4: место чтения заказов
-- Продолжение по курсору дочитывает окно в том виде, в каком канал отдал его на первой странице (Kaufland — `ts_updated:desc` со смещением:
-- строка, обновлённая после первой страницы, уходит наверх, ДО смещения). Следующее окно считалось от конца последнего успешного запуска —
-- всё обновлённое между первой страницей цепочки и её концом (а цепочка с шага 58 переживает провалы с растущей паузой) не читалось никогда.
-- Теперь место хранит начало чтения цепочки (`order_read_from`): дочитанное окно даёт следующему начало `read_from − интервал`. Отказы на
-- сохранённом курсоре считаются на самом курсоре (`order_cursor_failures`), а не на работе
ALTER TABLE tenant_data.channel_discovery_circle
  ADD COLUMN order_read_from timestamptz,
  ADD COLUMN order_cursor_failures integer NOT NULL DEFAULT 0 CHECK (order_cursor_failures >= 0);
GRANT INSERT (order_read_from, order_cursor_failures), UPDATE (order_read_from, order_cursor_failures) ON tenant_data.channel_discovery_circle TO repracer_discovery;

-- ================================================================ Р-201: закрытие тенанта
ALTER TABLE maintenance.tenant_purge_status
  ADD COLUMN evidence_exported_at timestamptz,
  ADD COLUMN evidence_export_sha256 text,
  ADD COLUMN evidence_export_rows bigint,
  ADD COLUMN evidence_hold_reason text,
  ADD COLUMN evidence_hold_by uuid,
  ADD COLUMN evidence_hold_at timestamptz,
  ADD CONSTRAINT tenant_purge_status_evidence_export_whole
    CHECK ((evidence_exported_at IS NULL) = (evidence_export_sha256 IS NULL) AND (evidence_exported_at IS NULL) = (evidence_export_rows IS NULL)
           AND (evidence_export_sha256 IS NULL OR evidence_export_sha256 ~ '^[0-9a-f]{64}$')),
  -- Удержание — только с основанием (не отписка) и автором
  ADD CONSTRAINT tenant_purge_status_evidence_hold_explained
    CHECK ((evidence_hold_reason IS NULL) = (evidence_hold_by IS NULL) AND (evidence_hold_reason IS NULL) = (evidence_hold_at IS NULL)
           AND (evidence_hold_reason IS NULL OR length(btrim(evidence_hold_reason)) >= 20));

-- Выгрузка доказательств читает поправки суточной свёртки — её итог без них неверен [Р-29]
GRANT SELECT ON tenant_data.price_daily_correction, tenant_data.price_daily_system_correction TO repracer_exporter;
CREATE POLICY export_read ON tenant_data.price_daily_correction FOR SELECT TO repracer_exporter USING (true);
CREATE POLICY export_read ON tenant_data.price_daily_system_correction FOR SELECT TO repracer_exporter USING (true);

RESET ROLE;

-- Решение о возврате — административная запись (стражи — вне SET ROLE: функции аудита принадлежат роли аудита): только человек, и каждая в аудите [Р-97, Р-100] (как у резервации)
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON channel_data.order_return FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER a0_admin_write_person_update BEFORE UPDATE ON channel_data.order_return FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON channel_data.order_return FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();
CREATE TRIGGER zz_admin_write_audit_update AFTER UPDATE ON channel_data.order_return FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Функции-переопределения — вне SET ROLE (владельцы — узкие роли, как в 0115, 0120, 0128)
CREATE OR REPLACE FUNCTION security.stock_path_allowed_privileges()
 RETURNS TABLE(table_name text, privilege text, column_name text)
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT t, p, c FROM (VALUES
    ('tenant_data.product', 'SELECT', NULL), ('tenant_data.stock_source', 'SELECT', NULL), ('tenant_data.stock_allocation', 'SELECT', NULL),
    ('tenant_data.stock_pool', 'SELECT', NULL), ('tenant_data.stock_pool', 'INSERT', NULL), ('tenant_data.stock_pool', 'UPDATE', NULL),
    ('tenant_data.stock_movement', 'SELECT', NULL), ('tenant_data.stock_movement', 'INSERT', NULL),
    -- Шаг 59 [Р-199]: строку возврата заводит конвейер заказов; решение — не его
    ('channel_data.order_return', 'SELECT', NULL), ('channel_data.order_return', 'INSERT', 'tenant_id'), ('channel_data.order_return', 'INSERT', 'reservation_id'), ('channel_data.order_return', 'INSERT', 'product_id'), ('channel_data.order_return', 'INSERT', 'stock_pool_id'), ('channel_data.order_return', 'INSERT', 'source_mode'), ('channel_data.order_return', 'INSERT', 'quantity'), ('channel_data.order_return', 'INSERT', 'channel'), ('channel_data.order_return', 'INSERT', 'channel_order_line_ref'), ('channel_data.order_return', 'INSERT', 'status'),
    ('channel_data.reservation', 'SELECT', NULL), ('channel_data.reservation', 'INSERT', NULL), ('channel_data.reservation', 'UPDATE', NULL),
    -- Р-105: запись остатка в канал — только поле QUANTITY (политика строк по виду поля); таблицы, которые читают и пишут триггеры записи
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    -- Ревью шага 19, находка 6: завершение записи (в том числе вытеснение ждущей новой версией) переносит её в историю и удаляет
    -- строку и её отправки триггером channel_write_complete правами вызывающего; удаление незавершённой отклоняет страж удаления
    ('tenant_data.channel_write', 'DELETE', NULL), ('channel_data.write_submission', 'SELECT', NULL), ('channel_data.write_submission', 'DELETE', NULL),
    -- UPDATE (status): триггер записи блокирует единицу FOR SHARE, а это требует права UPDATE хотя бы на один столбец; сменить статус
    -- роль может только как путь решения — ACTIVE → BLOCKED (страж 0068), и только у единицы остатка (политика)
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL),
    ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.marketplace', 'SELECT', NULL)
  ) AS a(t, p, c)
$function$;

CREATE OR REPLACE FUNCTION maintenance.purge_tenant_channel_data(p_tenant_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t     text;
  n     bigint;
  total bigint := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant
                  WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'tenant % must be a CUSTOMER in OFFBOARDING or CLOSED', p_tenant_id;
  END IF;
  FOREACH t IN ARRAY ARRAY[
    'channel_data.price_decision_snapshot_ref', 'channel_data.price_decision', 'channel_data.price_intent',
    'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate',
    -- Шаг 59 [Р-199]: возвраты ссылаются на резервацию — удаляются раньше неё
    'channel_data.order_return', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_sample', 'channel_data.pricing_halt_review', 'channel_data.pricing_halt',
    'channel_data.channel_distrust', 'channel_data.channel_quantity_current', 'channel_data.offer_channel_pricing', 'channel_data.inbound_notification',
    'channel_data.offer_pricing_health', 'channel_data.notification_loss_verdict', 'channel_data.notification_loss_check',
    'channel_data.competitor_poll_state', 'channel_data.competitor_snapshot_log', 'channel_data.competitor_move_latest',
    'channel_data.competitor_move', 'channel_data.competitor_price_daily', 'channel_data.floor_hold', 'channel_data.pricing_strategy_undercut',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  -- Шаг 25 (ревью, находка 10): пропуски выгрузки и их разбор хранят идентификаторы снимков тенанта
  DELETE FROM maintenance.snapshot_export_skip_resolution r
   USING maintenance.snapshot_export_skip s WHERE s.competitor_snapshot_id = r.competitor_snapshot_id AND s.subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;
  DELETE FROM maintenance.snapshot_export_skip WHERE subject_tenant_id = p_tenant_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  total := total + n;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_CATALOG'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.cost_import', 'MANAGE_PRICING'),
    ('tenant_data.guardrail', 'MANAGE_PRICING'), ('tenant_data.pricing_strategy', 'MANAGE_PRICING'), ('channel_data.pricing_strategy_undercut', 'MANAGE_PRICING'),
    ('tenant_data.divergence_policy', 'MANAGE_PRICING'), ('channel_data.fee_estimate', 'MANAGE_PRICING'), ('tenant_data.product_vat_rate', 'MANAGE_PRICING'),
    ('channel_data.divergence_case', 'MANAGE_PRICING'),
    ('tenant_data.product', 'MANAGE_CATALOG'), ('tenant_data.bundle_component', 'MANAGE_CATALOG'), ('tenant_data.offer_mapping', 'MANAGE_CATALOG'),
    ('tenant_data.stock_source', 'MANAGE_CATALOG'), ('tenant_data.stock_pool', 'MANAGE_CATALOG'), ('tenant_data.stock_movement', 'MANAGE_CATALOG'),
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.order_return', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
    ('channel_data.listing_migration_check', 'MANAGE_CATALOG'),
    ('tenant_data.migration_consent', 'GIVE_MIGRATION_CONSENT'), ('tenant_data.migration_consent_item', 'GIVE_MIGRATION_CONSENT'),
    ('tenant_data.migration_consent_revocation', 'GIVE_MIGRATION_CONSENT'),
    ('channel_data.pricing_halt', 'RELEASE_CHANNEL_HALT'),
    ('channel_data.channel_distrust', 'RELEASE_CHANNEL_DISTRUST'), ('channel_data.offer_channel_pricing', 'MANAGE_CATALOG'),
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    ('tenant_data.onboarding_progress', 'MANAGE_PRICING'),
    -- Шаг 43 [Р-175]: канал подключает тот, кто управляет тенантом, — и запрос согласия, и полученный токен
    ('tenant_data.channel_authorization_request', 'MANAGE_TENANT'), ('tenant_data.channel_credential', 'MANAGE_TENANT'),
    ('tenant_data.channel_write_mode_change', 'OWN_GUARD'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

DROP FUNCTION maintenance.purge_tenant_data(uuid, boolean);
CREATE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t         text;
  n         bigint;
  total     bigint := 0;
  closed_ts timestamptz;
  hold      text;
BEGIN
  SELECT closed_at INTO closed_ts FROM tenant_data.tenant
   WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED';
  IF closed_ts IS NULL THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status
                  WHERE subject_tenant_id = p_tenant_id AND postgres_channel_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  /**
   * Шаг 59 [Р-201]: льготный период 30 суток после закрытия — клиент может вернуться или оспорить выгрузку; раньше ничего не удаляется
   */
  IF closed_ts > now() - interval '30 days' THEN
    RAISE EXCEPTION 'tenant % is in its 30-day grace period after closure until % (Р-201)', p_tenant_id, (closed_ts + interval '30 days')::date
      USING ERRCODE = 'check_violation';
  END IF;
  -- Удержание доказательств — только с основанием, записанным в аудит (maintenance.hold_price_evidence); пока оно действует, не удаляется ничего
  SELECT evidence_hold_reason INTO hold FROM maintenance.tenant_purge_status WHERE subject_tenant_id = p_tenant_id;
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'price evidence of tenant % is held: % (Р-201)', p_tenant_id, hold USING ERRCODE = 'check_violation';
  END IF;
  -- Доказательства цен уходят только после ВЫГРУЗКИ клиенту: он уносит их с собой, у нас они не остаются
  IF (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.discount_announcement WHERE tenant_id = p_tenant_id)
      OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id))
     AND NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status WHERE subject_tenant_id = p_tenant_id AND evidence_exported_at IS NOT NULL) THEN
    RAISE EXCEPTION 'tenant % has price evidence not yet exported to the customer (Р-201)', p_tenant_id USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO legal.migration_consent_record
    (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id,
     consenting_role, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration,
     other_tools_list, typed_confirmation, given_at, expires_at, revoked_at, items, tenant_closed_at)
  SELECT c.tenant_id, c.migration_consent_id, c.channel_account_id, ca.external_account_id, c.user_id,
         m.role, c.mfa_verified_at, c.disclosure_version, c.disclosure_text_sha256, c.other_tools_declaration,
         c.other_tools_list, c.typed_confirmation, c.given_at, c.expires_at, r.revoked_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'listing_id', i.listing_id,
                     'listing_snapshot_sha256', encode(i.listing_snapshot_sha256, 'hex'),
                     'verdict_at_consent', i.verdict_at_consent,
                     'acknowledged_losses', to_jsonb(i.acknowledged_losses)))
                     FROM tenant_data.migration_consent_item i
                    WHERE i.tenant_id = c.tenant_id AND i.migration_consent_id = c.migration_consent_id), '[]'::jsonb),
         closed_ts
    FROM tenant_data.migration_consent c
    JOIN tenant_data.channel_account ca ON ca.tenant_id = c.tenant_id AND ca.channel_account_id = c.channel_account_id
    JOIN tenant_data.membership m ON m.tenant_id = c.tenant_id AND m.membership_id = c.membership_id
    LEFT JOIN tenant_data.migration_consent_revocation r
      ON r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id
   WHERE c.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, migration_consent_id) DO NOTHING;

  FOREACH t IN ARRAY ARRAY[
    -- Шаг 34 [Р-149]: прогресс онбординга — данные тенанта
    -- Шаг 36 [Р-156]: алерты тенанта уходят вместе с ним
    -- Шаг 41 [Р-170]: журнал переключений теневого режима — данные тенанта, уходят вместе с ним
    'tenant_data.channel_write_mode_change',
    -- Шаг 42 [Р-174]: дайджест тени с отметкой доставки — данные тенанта (таблицу заводит 0130; список исполняется
    -- динамически, поэтому порядок миграций здесь ничего не ломает)
    'tenant_data.channel_discovery_circle', 'tenant_data.channel_credential', 'tenant_data.channel_authorization_request', 'tenant_data.shadow_digest',
    'tenant_data.alert',
    'tenant_data.onboarding_progress',
    -- Шаг 30 [Р-139]: задания массовых операций и их файлы — данные тенанта; удаляются раньше членства, на которое ссылаются
    'tenant_data.bulk_job_artifact', 'tenant_data.bulk_job',
    'tenant_data.outbox_event', 'tenant_data.price_history_not_applied', 'tenant_data.price_history_applied', 'tenant_data.price_history', 'tenant_data.price_daily_correction', 'tenant_data.price_daily_system_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    -- Остановки цен человеком: тоже данные тенанта, удалялись только вместе с базой (найдено правилом проверки схемы шага 26)
    'tenant_data.price_stop',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.product_vat_rate', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile', 'tenant_data.cost_import',
    'tenant_data.discount_announcement', 'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  UPDATE maintenance.tenant_purge_status
     SET postgres_tenant_purged_at = now(),
         legal_hold_until = CASE WHEN EXISTS (SELECT 1 FROM legal.migration_consent_record WHERE tenant_id = p_tenant_id)
                                 THEN (closed_ts + interval '3 years')::date END
   WHERE subject_tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;
ALTER FUNCTION maintenance.purge_tenant_data(uuid) OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION maintenance.purge_tenant_data(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.purge_tenant_data(uuid) TO repracer_retention;

/** Шаг 56–59: курсор — только вместе с началом окна и началом чтения цепочки; начало окна без курсора держит окно */
DROP FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz);
DROP FUNCTION tenant_data.order_read_position(uuid, uuid);
CREATE FUNCTION tenant_data.save_order_read_position(p_tenant_id uuid, p_channel_account_id uuid, p_since timestamptz, p_cursor text,
                                                     p_read_from timestamptz, p_cursor_failures integer, p_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF p_cursor IS NOT NULL AND (p_since IS NULL OR p_read_from IS NULL) THEN
    RAISE EXCEPTION 'an order read cursor needs the start of its window and of its reading' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO tenant_data.channel_discovery_circle AS c (tenant_id, channel_account_id, order_since, order_cursor, order_read_from, order_cursor_failures, updated_at)
  VALUES (p_tenant_id, p_channel_account_id, p_since, p_cursor, p_read_from, coalesce(p_cursor_failures, 0), p_at)
  ON CONFLICT (tenant_id, channel_account_id) DO UPDATE SET order_since = excluded.order_since, order_cursor = excluded.order_cursor,
    order_read_from = excluded.order_read_from, order_cursor_failures = excluded.order_cursor_failures, updated_at = excluded.updated_at;
END $fn$;
CREATE FUNCTION tenant_data.order_read_position(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (since timestamptz, cursor text, read_from timestamptz, cursor_failures integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT c.order_since, c.order_cursor, c.order_read_from, c.order_cursor_failures FROM tenant_data.channel_discovery_circle c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id AND c.order_since IS NOT NULL
$fn$;
ALTER FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz, integer, timestamptz) OWNER TO repracer_discovery;
ALTER FUNCTION tenant_data.order_read_position(uuid, uuid) OWNER TO repracer_discovery;
REVOKE EXECUTE ON FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz, integer, timestamptz) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION tenant_data.order_read_position(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.save_order_read_position(uuid, uuid, timestamptz, text, timestamptz, integer, timestamptz) TO repracer_app;
GRANT EXECUTE ON FUNCTION tenant_data.order_read_position(uuid, uuid) TO repracer_app;

/**
 * Р-201: выгрузка доказательств цен клиенту записана — сумма и число строк пакета. Только у закрытого тенанта: выгрузка при закрытии —
 * последний пакет, после которого доказательства у нас больше не меняются
 */
CREATE FUNCTION maintenance.record_closure_evidence_export(p_tenant_id uuid, p_sha256 text, p_rows bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'the closure evidence is exported for a CLOSED customer tenant, not %', p_tenant_id USING ERRCODE = 'check_violation';
  END IF;
  IF p_rows IS NULL OR p_rows < 0 THEN
    RAISE EXCEPTION 'the closure evidence export needs its row count' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, evidence_exported_at, evidence_export_sha256, evidence_export_rows)
  VALUES (p_tenant_id, now(), p_sha256, p_rows)
  ON CONFLICT (subject_tenant_id) DO UPDATE SET evidence_exported_at = now(), evidence_export_sha256 = excluded.evidence_export_sha256,
    evidence_export_rows = excluded.evidence_export_rows;
END $fn$;
ALTER FUNCTION maintenance.record_closure_evidence_export(uuid, text, bigint) OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION maintenance.record_closure_evidence_export(uuid, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION maintenance.record_closure_evidence_export(uuid, text, bigint) TO repracer_exporter;

/**
 * Р-201: удержание доказательств цен закрытого тенанта — с основанием в аудите. Это шаг процедуры закрытия (её исполняет администратор
 * базы, как и очистку), а не действие панели оператора [Р-166]: оператор назван и проверен тем же `operator_acting` (активная учётная
 * запись, второй фактор), событие с основанием пишет роль аудита. Снятие — так же, с заметкой
 */
CREATE FUNCTION maintenance.hold_price_evidence(p_operator_id uuid, p_tenant_id uuid, p_reason text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
BEGIN
  -- Основание не короче 20 символов держит ограничение `tenant_purge_status_evidence_hold_explained` — и у функции, и у прямой записи [Р-104]
  IF NOT EXISTS (SELECT 1 FROM tenant_data.tenant WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status IN ('OFFBOARDING', 'CLOSED')) THEN
    RAISE EXCEPTION 'the price evidence is held for a closing customer tenant, not %', p_tenant_id USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, evidence_hold_reason, evidence_hold_by, evidence_hold_at)
  VALUES (p_tenant_id, btrim(p_reason), p_operator_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET evidence_hold_reason = excluded.evidence_hold_reason, evidence_hold_by = excluded.evidence_hold_by,
    evidence_hold_at = excluded.evidence_hold_at;
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'closure.price_evidence_held', 'maintenance.tenant_purge_status', p_tenant_id,
    jsonb_build_object('operator', who, 'reason', btrim(p_reason)));
END $fn$;

CREATE FUNCTION maintenance.release_price_evidence_hold(p_operator_id uuid, p_tenant_id uuid, p_note text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
  released int;
BEGIN
  UPDATE maintenance.tenant_purge_status SET evidence_hold_reason = NULL, evidence_hold_by = NULL, evidence_hold_at = NULL
   WHERE subject_tenant_id = p_tenant_id AND evidence_hold_reason IS NOT NULL;
  GET DIAGNOSTICS released = ROW_COUNT;
  IF released = 0 THEN
    RAISE EXCEPTION 'the price evidence of tenant % is not held', p_tenant_id USING ERRCODE = 'check_violation';
  END IF;
  PERFORM security.operator_audit(p_operator_id, p_tenant_id, 'closure.price_evidence_released', 'maintenance.tenant_purge_status', p_tenant_id,
    jsonb_build_object('operator', who, 'note', p_note));
END $fn$;
ALTER FUNCTION maintenance.hold_price_evidence(uuid, uuid, text) OWNER TO repracer_retention;
ALTER FUNCTION maintenance.release_price_evidence_hold(uuid, uuid, text) OWNER TO repracer_retention;
REVOKE EXECUTE ON FUNCTION maintenance.hold_price_evidence(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION maintenance.release_price_evidence_hold(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION security.operator_acting(uuid) TO repracer_retention;
GRANT EXECUTE ON FUNCTION security.operator_audit(uuid, uuid, text, text, uuid, jsonb) TO repracer_retention;

COMMIT;
