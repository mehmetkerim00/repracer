-- 0063_halt_review_by_database.sql
-- Шаг 17, находка 2 ревью шага 16 [Р-52, Р-96]: путь решения подделывал автоматическое снятие системной остановки — сдвигал срок
-- проверки, писал «чистую» проверку выборки и снимал остановку как AUTO. Теперь путь решения НЕ пишет ни проверку, ни снятие
-- (прав на pricing_halt_review и UPDATE pricing_halt у него нет, 0062). Он записывает только наблюдения выборки — какой товар прочитан,
-- когда наблюдён и какой вердикт дала проверка входов. Итог проверки вычисляет и записывает база функцией review_halt_by_sample:
--   срок — из самой остановки; наблюдения — после срока проверки; чистых разных товаров не меньше least(5, число товаров витрины
--   со стратегией по рынку) [OQ-96]; хотя бы один провал — SAMPLE_FAILED и новый срок.
-- Остаток (OQ-143): подлинность самих наблюдений база проверить не может — путь решения по определению пишет рыночные данные, из
-- которых считает цены. Подделка наблюдения возможна, но это то же, что подделка снимка конкурента, и она видна в журнале наблюдений.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_halt_reviewer') THEN
    CREATE ROLE repracer_halt_reviewer NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA security, tenant_data, channel_data TO repracer_halt_reviewer;

SET ROLE repracer_owner;

CREATE TABLE channel_data.pricing_halt_sample (
  tenant_id            uuid NOT NULL,
  pricing_halt_sample_id uuid NOT NULL DEFAULT gen_random_uuid(),
  pricing_halt_id      uuid NOT NULL,
  channel_product_ref  text NOT NULL,
  observed_at          timestamptz NOT NULL,
  recorded_at          timestamptz NOT NULL DEFAULT now(),
  verdict              text NOT NULL CHECK (verdict IN ('ACCEPT', 'REJECT', 'READ_FAILED', 'MASS_SHIFT')),
  reason_code          text CHECK (reason_code ~ '^[A-Z0-9_]+$'),
  PRIMARY KEY (tenant_id, pricing_halt_sample_id),
  FOREIGN KEY (tenant_id, pricing_halt_id) REFERENCES channel_data.pricing_halt (tenant_id, pricing_halt_id),
  CHECK ((verdict = 'ACCEPT') = (reason_code IS NULL)),
  CHECK (observed_at <= recorded_at + interval '5 minutes')
);

-- Подсчёт выборки проверки: наблюдения остановки после срока проверки (review_halt_by_sample)
CREATE INDEX pricing_halt_sample_halt_idx ON channel_data.pricing_halt_sample (tenant_id, pricing_halt_id, recorded_at);
-- Удаление по сроку хранения: maintenance DELETE_ROWS по recorded_at
CREATE INDEX pricing_halt_sample_expiry_idx ON channel_data.pricing_halt_sample (recorded_at);

SELECT security.register_table('channel_data.pricing_halt_sample', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.pricing_halt_sample');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.pricing_halt_sample', 'DELETE_ROWS', 'recorded_at', '18 months', '0 days', 63);

-- Р-96: путь решения записывает и читает наблюдения выборки; список разрешённого дополняется
CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
  RETURNS TABLE (table_name text, privilege text, column_name text)
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT t, p, c FROM (VALUES
    ('platform.marketplace', 'SELECT', NULL), ('platform.fx_rate', 'SELECT', NULL), ('platform.explanation_ruleset', 'SELECT', NULL),
    ('platform.channel_capability', 'SELECT', NULL), ('platform.vat_rate_default', 'SELECT', NULL),
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
    ('channel_data.pricing_halt_sample', 'SELECT', NULL), ('channel_data.pricing_halt_sample', 'INSERT', NULL)
  ) AS a(t, p, c)
$$;

-- Проверка выборки — функция роли repracer_halt_reviewer: единственный путь к автоматической проверке и автоматическому снятию
CREATE FUNCTION channel_data.review_halt_by_sample(p_tenant_id uuid, p_pricing_halt_id uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  h         record;
  eligible  int;
  required  int;
  accepted  int;
  failed    int;
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
  IF now() < h.next_review_at THEN
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
  SELECT count(DISTINCT sm.channel_product_ref) FILTER (WHERE sm.verdict = 'ACCEPT'), count(*) FILTER (WHERE sm.verdict <> 'ACCEPT')
    INTO accepted, failed
    FROM channel_data.pricing_halt_sample sm
   WHERE sm.tenant_id = h.tenant_id AND sm.pricing_halt_id = h.pricing_halt_id AND sm.recorded_at >= h.next_review_at AND sm.observed_at >= h.next_review_at;
  IF failed > 0 THEN
    INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, details, reviewed_at)
    VALUES (h.tenant_id, h.pricing_halt_id, 'AUTO_SAMPLE', 'SAMPLE_FAILED', accepted + failed, failed, jsonb_build_object('required', required), now());
    UPDATE channel_data.pricing_halt SET next_review_at = now() + h.review_window WHERE tenant_id = h.tenant_id AND pricing_halt_id = h.pricing_halt_id;
    RETURN 'SAMPLE_FAILED';
  END IF;
  IF accepted < required THEN
    RETURN 'NO_SAMPLE';
  END IF;
  INSERT INTO channel_data.pricing_halt_review (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, details, reviewed_at)
  VALUES (h.tenant_id, h.pricing_halt_id, 'AUTO_SAMPLE', 'RELEASED', accepted, 0, jsonb_build_object('required', required), now());
  UPDATE channel_data.pricing_halt SET released_at = now(), released_kind = 'AUTO' WHERE tenant_id = h.tenant_id AND pricing_halt_id = h.pricing_halt_id;
  RETURN 'RELEASED';
END $$;

RESET ROLE;

GRANT SELECT, INSERT ON channel_data.pricing_halt_sample TO repracer_app;
GRANT SELECT ON channel_data.pricing_halt_sample, tenant_data.offer_mapping, tenant_data.write_scope, tenant_data.pricing_strategy TO repracer_halt_reviewer;
GRANT SELECT, UPDATE ON channel_data.pricing_halt TO repracer_halt_reviewer;
GRANT SELECT, INSERT ON channel_data.pricing_halt_review TO repracer_halt_reviewer;
GRANT EXECUTE ON FUNCTION security.current_user_id(), security.current_tenant_id() TO repracer_halt_reviewer;
SET ROLE repracer_owner;
CREATE POLICY halt_reviewer_tenant ON channel_data.pricing_halt_sample FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON tenant_data.offer_mapping FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON tenant_data.write_scope FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON tenant_data.pricing_strategy FOR SELECT TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON channel_data.pricing_halt FOR ALL TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY halt_reviewer_tenant ON channel_data.pricing_halt_review FOR ALL TO repracer_halt_reviewer USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
RESET ROLE;
ALTER FUNCTION channel_data.review_halt_by_sample(uuid, uuid) OWNER TO repracer_halt_reviewer;
REVOKE EXECUTE ON FUNCTION channel_data.review_halt_by_sample(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_data.review_halt_by_sample(uuid, uuid) TO repracer_app;

COMMIT;
