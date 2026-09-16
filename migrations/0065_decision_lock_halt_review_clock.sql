-- 0065: блокировка товара при фиксации решения и проверка остановки по времени шага — после перехода на список разрешённого (Р-96)
--
-- 1. Фиксация решения берёт FOR SHARE на товар, чтобы упорядочиться с изменением границ, которое держит FOR UPDATE на товаре
--    в отложенной проверке [Р-54]. PostgreSQL требует для FOR SHARE право UPDATE хотя бы на один столбец таблицы — у пути решения
--    его нет и не будет (Р-96). Блокировку берёт функция роли repracer_decision_lock: у роли нет входа, у функции — только
--    блокировка строк товаров единиц записи текущего тенанта.
-- 2. Проверка выборки остановки (0063) принимает момент шага: сценарии стенда идут по виртуальным часам. Момент не может быть
--    позже часов базы (least с now()) — указав будущее, путь решения окно не сократит; прошлое лишь откладывает снятие.
--    Принятые наблюдения считаются только по товарам остановленной витрины (offer_mapping), наблюдения позже момента — не считаются.
-- 3. Наблюдение выборки путь решения вставляет без recorded_at: время записи ставит база (права INSERT — по столбцам).
-- 4. Смена статуса единицы без смены режима не перепроверяет границы (блокировка единицы диспетчером не требует прав на товар).
-- 5. Путь решения читает переопределение лимита правок аккаунта (бюджет записи, 0008).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_decision_lock') THEN
    CREATE ROLE repracer_decision_lock NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA security, tenant_data TO repracer_decision_lock;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_decision_lock;
GRANT SELECT ON tenant_data.write_scope TO repracer_decision_lock;
-- FOR SHARE требует UPDATE хотя бы на один столбец; функция ничего не изменяет, входа у роли нет
GRANT SELECT, UPDATE (product_id) ON tenant_data.product TO repracer_decision_lock;
CREATE POLICY decision_lock_tenant ON tenant_data.write_scope FOR SELECT TO repracer_decision_lock USING (tenant_id = security.current_tenant_id());
CREATE POLICY decision_lock_tenant ON tenant_data.product FOR ALL TO repracer_decision_lock
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

SET ROLE repracer_owner;

CREATE FUNCTION tenant_data.lock_decision_products(p_tenant_id uuid, p_write_scope_ids uuid[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_tenant_id IS DISTINCT FROM security.current_tenant_id() THEN
    RAISE EXCEPTION 'product lock for tenant % outside the tenant context', p_tenant_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM tenant_data.product p
   WHERE p.tenant_id = p_tenant_id
     AND p.product_id IN (SELECT s.product_id FROM tenant_data.write_scope s WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = ANY (p_write_scope_ids))
   ORDER BY p.product_id
   FOR SHARE;
END $$;

-- Проверка границ единицы при смене статуса (0006) брала FOR UPDATE на товар и при блокировке единицы диспетчером — для этого
-- пути решения понадобилось бы право UPDATE на товар. Смена статуса между ACTIVE, HELD и BLOCKED границ не меняет: включённость
-- границ у всех неснятых единиц держат проверки min_price и max_price при каждой новой версии. Проверка остаётся при вставке,
-- смене режима и выходе из RETIRED.
CREATE OR REPLACE FUNCTION tenant_data.write_scope_min_price_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.field <> 'PRICE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pricing_mode IS NOT DISTINCT FROM OLD.pricing_mode AND OLD.status <> 'RETIRED' THEN
    RETURN NULL;
  END IF;
  PERFORM tenant_data.assert_price_scope_has_min_price(NEW.tenant_id, NEW.write_scope_id);
  RETURN NULL;
END $$;

DROP FUNCTION channel_data.review_halt_by_sample(uuid, uuid);

-- Р-96: наблюдение выборки — без времени записи; список разрешённого переопределяется
CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
    -- лимит правок аккаунта для бюджета записи (0008, channel_write_budget)
    ('tenant_data.channel_capability_override', 'SELECT', NULL),
    ('tenant_data.tenant', 'SELECT', NULL), ('tenant_data.channel_account', 'SELECT', NULL), ('tenant_data.product', 'SELECT', NULL),
    ('tenant_data.product_vat_rate', 'SELECT', NULL), ('tenant_data.offer_mapping', 'SELECT', NULL), ('tenant_data.pricing_strategy', 'SELECT', NULL),
    ('channel_data.pricing_strategy_undercut', 'SELECT', NULL), ('tenant_data.min_price', 'SELECT', NULL), ('tenant_data.max_price', 'SELECT', NULL),
    ('tenant_data.guardrail', 'SELECT', NULL), ('tenant_data.cost_profile', 'SELECT', NULL), ('channel_data.fee_estimate', 'SELECT', NULL),
    ('tenant_data.price_stop', 'SELECT', NULL), ('channel_data.pricing_halt_review', 'SELECT', NULL),
    ('tenant_data.write_scope', 'SELECT', NULL), ('tenant_data.write_scope', 'UPDATE', 'status'),
    ('tenant_data.write_scope_sync_state', 'SELECT', NULL), ('tenant_data.write_scope_sync_state', 'INSERT', NULL), ('tenant_data.write_scope_sync_state', 'UPDATE', NULL),
    ('channel_data.competitor_state', 'SELECT', NULL), ('channel_data.competitor_state', 'INSERT', NULL), ('channel_data.competitor_state', 'UPDATE', NULL),
    ('channel_data.competitor_move', 'SELECT', NULL), ('channel_data.competitor_move', 'INSERT', NULL),
    ('channel_data.competitor_move_latest', 'SELECT', NULL), ('channel_data.competitor_move_latest', 'INSERT', NULL), ('channel_data.competitor_move_latest', 'UPDATE', NULL),
    ('channel_data.competitor_price_daily', 'SELECT', NULL), ('channel_data.competitor_price_daily', 'INSERT', NULL), ('channel_data.competitor_price_daily', 'UPDATE', NULL),
    ('channel_data.rejected_competitor_snapshot', 'SELECT', NULL), ('channel_data.rejected_competitor_snapshot', 'INSERT', NULL),
    ('channel_data.divergence_case', 'SELECT', NULL), ('channel_data.divergence_case', 'INSERT', NULL), ('channel_data.divergence_case', 'UPDATE', NULL),
    ('channel_data.observed_channel_state', 'SELECT', NULL), ('channel_data.observed_channel_state', 'INSERT', NULL), ('channel_data.observed_channel_state', 'UPDATE', NULL),
    ('channel_data.observed_price_daily', 'SELECT', NULL), ('channel_data.observed_price_daily', 'INSERT', NULL), ('channel_data.observed_price_daily', 'UPDATE', NULL),
    ('channel_data.price_intent', 'SELECT', NULL), ('channel_data.price_intent', 'INSERT', NULL),
    ('channel_data.price_decision', 'SELECT', NULL), ('channel_data.price_decision', 'INSERT', NULL),
    ('channel_data.price_decision_snapshot_ref', 'SELECT', NULL), ('channel_data.price_decision_snapshot_ref', 'INSERT', NULL),
    ('tenant_data.price_intent_core', 'INSERT', NULL),
    ('tenant_data.channel_write', 'SELECT', NULL), ('tenant_data.channel_write', 'INSERT', NULL), ('tenant_data.channel_write', 'UPDATE', NULL), ('tenant_data.channel_write', 'DELETE', NULL),
    ('tenant_data.channel_write_history', 'SELECT', NULL), ('tenant_data.channel_write_history', 'INSERT', NULL),
    ('channel_data.write_submission', 'SELECT', NULL), ('channel_data.write_submission', 'INSERT', NULL), ('channel_data.write_submission', 'UPDATE', NULL), ('channel_data.write_submission', 'DELETE', NULL),
    ('tenant_data.edit_budget', 'SELECT', NULL), ('tenant_data.edit_budget', 'INSERT', NULL), ('tenant_data.edit_budget', 'UPDATE', NULL),
    ('tenant_data.outbox_event', 'INSERT', NULL), ('tenant_data.price_history', 'SELECT', NULL), ('tenant_data.price_history', 'INSERT', NULL),
    ('channel_data.pricing_halt', 'SELECT', NULL), ('channel_data.pricing_halt', 'INSERT', NULL),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$$;

-- Проверка выборки — функция роли repracer_halt_reviewer: единственный путь к автоматической проверке и автоматическому снятию
CREATE FUNCTION channel_data.review_halt_by_sample(p_tenant_id uuid, p_pricing_halt_id uuid, p_at timestamptz) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  h         record;
  eligible  int;
  required  int;
  accepted  int;
  failed    int;
  -- Момент проверки — время шага, но не позже часов базы: путь решения не сдвигает окно вперёд, указав будущее
  v_at      timestamptz := least(p_at, now());
BEGIN
  IF security.current_user_id() IS NOT NULL THEN
    RAISE EXCEPTION 'an automatic halt review is a system action, not a session of a person (Р-52)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_tenant_id IS DISTINCT FROM security.current_tenant_id() THEN
    RAISE EXCEPTION 'halt review for tenant % outside the tenant context', p_tenant_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ph.* INTO h FROM channel_data.pricing_halt ph
   WHERE ph.tenant_id = p_tenant_id AND ph.pricing_halt_id = p_pricing_halt_id AND ph.released_at IS NULL AND ph.reason_code = 'CHANNEL_MASS_SHIFT'
   FOR UPDATE;
  IF h IS NULL THEN
    RETURN 'NOT_ACTIVE';
  END IF;
  IF v_at < h.next_review_at THEN
    RETURN 'NOT_DUE';
  END IF;
  -- Товары витрины (или аккаунта) со стратегией по рынку в движке — как выборка в pickReviewSample
  SELECT count(DISTINCT m.channel_product_ref) INTO eligible
    FROM tenant_data.offer_mapping m
    JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
    JOIN tenant_data.pricing_strategy ps ON ps.tenant_id = s.tenant_id AND ps.pricing_strategy_id = s.pricing_strategy_id AND ps.version = s.pricing_strategy_version
   WHERE m.tenant_id = h.tenant_id AND m.channel_account_id = h.channel_account_id AND (h.marketplace IS NULL OR m.marketplace = h.marketplace)
     AND m.status <> 'ENDED' AND m.channel_product_ref IS NOT NULL AND s.pricing_mode = 'ENGINE' AND ps.type IN ('MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION');
  required := greatest(1, least(5, eligible));
  SELECT count(DISTINCT sm.channel_product_ref) FILTER (WHERE sm.verdict = 'ACCEPT' AND EXISTS (
             SELECT 1 FROM tenant_data.offer_mapping om
              WHERE om.tenant_id = sm.tenant_id AND om.channel_account_id = h.channel_account_id AND (h.marketplace IS NULL OR om.marketplace = h.marketplace)
                AND om.status <> 'ENDED' AND om.channel_product_ref = sm.channel_product_ref)), count(*) FILTER (WHERE sm.verdict <> 'ACCEPT')
    INTO accepted, failed
    FROM channel_data.pricing_halt_sample sm
   WHERE sm.tenant_id = h.tenant_id AND sm.pricing_halt_id = h.pricing_halt_id AND sm.recorded_at >= h.next_review_at AND sm.observed_at >= h.next_review_at AND sm.observed_at <= v_at;
  IF failed > 0 THEN
    INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, details, reviewed_at)
    VALUES (h.tenant_id, h.pricing_halt_id, 'AUTO_SAMPLE', 'SAMPLE_FAILED', accepted + failed, failed, jsonb_build_object('required', required), v_at);
    UPDATE channel_data.pricing_halt SET next_review_at = v_at + h.review_window WHERE tenant_id = h.tenant_id AND pricing_halt_id = h.pricing_halt_id;
    RETURN 'SAMPLE_FAILED';
  END IF;
  IF accepted < required THEN
    RETURN 'NO_SAMPLE';
  END IF;
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, details, reviewed_at)
  VALUES (h.tenant_id, h.pricing_halt_id, 'AUTO_SAMPLE', 'RELEASED', accepted, 0, jsonb_build_object('required', required), v_at);
  UPDATE channel_data.pricing_halt SET released_at = v_at, released_kind = 'AUTO' WHERE tenant_id = h.tenant_id AND pricing_halt_id = h.pricing_halt_id;
  RETURN 'RELEASED';
END $$;

RESET ROLE;

ALTER FUNCTION tenant_data.lock_decision_products(uuid, uuid[]) OWNER TO repracer_decision_lock;
REVOKE ALL ON FUNCTION tenant_data.lock_decision_products(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.lock_decision_products(uuid, uuid[]) TO repracer_app;

ALTER FUNCTION channel_data.review_halt_by_sample(uuid, uuid, timestamptz) OWNER TO repracer_halt_reviewer;
REVOKE ALL ON FUNCTION channel_data.review_halt_by_sample(uuid, uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.review_halt_by_sample(uuid, uuid, timestamptz) TO repracer_app;

GRANT SELECT ON tenant_data.channel_capability_override TO repracer_app;
REVOKE INSERT ON channel_data.pricing_halt_sample FROM repracer_app;
GRANT INSERT (tenant_id, pricing_halt_id, channel_product_ref, observed_at, verdict, reason_code) ON channel_data.pricing_halt_sample TO repracer_app;

COMMIT;
