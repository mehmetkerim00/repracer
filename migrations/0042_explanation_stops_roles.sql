-- 0042_explanation_stops_roles.sql
-- Шаг 12.
-- Р-68: решение хранит неизменяемый слепок объяснения (якоря, правила проверки входов с порогами, версия набора правил,
--       версия и параметры стратегии, проверки Gate) без данных канала; слепок копируется в ядро intent и живёт с ним вечно.
--       Ссылка на полный снимок — отдельная строка данных канала, 18 месяцев [Р-38].
-- Р-69: остановка человеком (kill switch) — все цены, tenant_data.price_stop; системная остановка pricing_halt — только
--       цены из данных конкурентов и только по испорченным данным [Р-51].
-- Р-70: остановка тенанта — самостоятельный объект: действует на любой аккаунт, в том числе подключённый после неё.
-- Р-71: параметр с суммой несёт валюту — CHECK на параметрах причин, слепке и завершении записи.
-- Р-73: отклонение от нарушенной границы хранится; «опасное» — больше 10 % (генерируемый столбец).
-- OQ-125: роль OPERATOR; остановить — владелец и оператор; снять остановку тенанта — только владелец.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------------------
-- 1. Роль оператора (OQ-125)
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_data.membership DROP CONSTRAINT membership_role_check;
ALTER TABLE tenant_data.membership ADD CONSTRAINT membership_role_check
  CHECK (role IN ('OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER'));

-- ---------------------------------------------------------------------------
-- 2. Р-71 и Р-68: проверки JSON причин и слепка
-- ---------------------------------------------------------------------------

/** Каждый объект с суммой (ключ *Minor с числом) несёт валюту: currency или пару from/to (перевод по курсу ЕЦБ) */
CREATE FUNCTION security.jsonb_amounts_have_currency(j jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF j IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(j) LOOP
      IF NOT security.jsonb_amounts_have_currency(v) THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;
  END IF;
  IF jsonb_typeof(j) <> 'object' THEN
    RETURN true;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
    IF k LIKE '%Minor' AND jsonb_typeof(v) = 'number'
       AND NOT (jsonb_typeof(j -> 'currency') = 'string' OR (jsonb_typeof(j -> 'from') = 'string' AND jsonb_typeof(j -> 'to') = 'string')) THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(v) IN ('object', 'array') AND NOT security.jsonb_amounts_have_currency(v) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END $$;

/** Есть ли в JSON ключ объекта из списка (на любой глубине) */
CREATE FUNCTION security.jsonb_has_any_key(j jsonb, p_keys text[]) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  k text;
  v jsonb;
BEGIN
  IF j IS NULL THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT value FROM jsonb_array_elements(j) LOOP
      IF security.jsonb_has_any_key(v, p_keys) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;
  IF jsonb_typeof(j) <> 'object' THEN
    RETURN false;
  END IF;
  FOR k, v IN SELECT key, value FROM jsonb_each(j) LOOP
    IF k = ANY (p_keys) OR security.jsonb_has_any_key(v, p_keys) THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END $$;

/**
 * Ключи параметров класса CHANNEL — packages/pricing-model/src/reasons.ts (CHANNEL_PARAM_KEYS); совпадение проверяет тест.
 * В слепке объяснения их быть не должно: слепок живёт вечно, данные канала — не дольше 18 месяцев [Р-3, Р-38].
 */
CREATE FUNCTION security.channel_param_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT ARRAY['actual', 'actualCompleteness', 'actualN', 'ageSeconds', 'bandHighMinor', 'bandLowMinor', 'buyboxMinor', 'channelCode',
               'competitorOffers', 'days', 'direction', 'historyDays', 'httpStatus', 'lastAcceptedAt', 'lowestMinor', 'medianFactor', 'medianMinor',
               'n', 'observedAt', 'observedMinor', 'offerPriceMinor', 'offerRank', 'offers', 'products', 'rankOneMinor', 'ratio', 'referenceMinor',
               'references', 'sameDirection', 'seller', 'shippingMinor', 'skewSeconds', 'spread', 'topN', 'totalMinor', 'unmet', 'valueMinor']::text[]
$$;

-- ---------------------------------------------------------------------------
-- 3. Р-68: слепок объяснения в решении и в ядре intent; Р-73: отклонение от границы
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  ADD COLUMN explanation jsonb,
  ADD COLUMN bound_deviation_bp int CHECK (bound_deviation_bp >= 0),
  ADD COLUMN dangerous boolean GENERATED ALWAYS AS (coalesce(bound_deviation_bp > 1000, false)) STORED;

ALTER TABLE channel_data.price_decision
  -- IS NOT NULL явно: CHECK с NULL-результатом строку пропускает
  ADD CONSTRAINT price_decision_explanation_present CHECK (
    explanation IS NOT NULL AND jsonb_typeof(explanation) = 'object' AND explanation ->> 'format' = 'r68.1' AND explanation ?& ARRAY['snapshot', 'sanity', 'strategy', 'gate', 'context']),
  ADD CONSTRAINT price_decision_explanation_no_channel_data CHECK (NOT security.jsonb_has_any_key(explanation, security.channel_param_keys())),
  -- Цена из данных конкурентов объясняется снимком и проверкой входов
  ADD CONSTRAINT price_decision_explanation_competitor_inputs CHECK (
    NOT competitor_derived OR (jsonb_typeof(explanation -> 'snapshot') = 'object' AND jsonb_typeof(explanation -> 'sanity') = 'object')),
  ADD CONSTRAINT price_decision_amounts_have_currency CHECK (
    security.jsonb_amounts_have_currency(reason_params) AND security.jsonb_amounts_have_currency(checks) AND security.jsonb_amounts_have_currency(explanation)),
  -- Р-73: отклонение есть ровно у отказов по нарушенной границе
  ADD CONSTRAINT price_decision_bound_deviation CHECK (
    (bound_deviation_bp IS NOT NULL) = (rejection_reason IS NOT NULL AND rejection_reason IN ('BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE')));

ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN explanation jsonb,
  ADD COLUMN bound_deviation_bp int CHECK (bound_deviation_bp >= 0),
  ADD COLUMN dangerous boolean GENERATED ALWAYS AS (coalesce(bound_deviation_bp > 1000, false)) STORED;
ALTER TABLE tenant_data.price_intent_core
  ADD CONSTRAINT price_intent_core_explanation_present CHECK (explanation IS NOT NULL AND jsonb_typeof(explanation) = 'object'),
  ADD CONSTRAINT price_intent_core_explanation_no_channel_data CHECK (NOT security.jsonb_has_any_key(explanation, security.channel_param_keys()));

-- Р-71 на остальных параметрах причин
ALTER TABLE channel_data.price_intent
  ADD CONSTRAINT price_intent_rationale_amounts_have_currency CHECK (security.jsonb_amounts_have_currency(rationale));
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_params_currency CHECK (security.jsonb_amounts_have_currency(end_params));
ALTER TABLE channel_data.rejected_competitor_snapshot
  ADD CONSTRAINT rejected_competitor_snapshot_details_currency CHECK (security.jsonb_amounts_have_currency(details));

-- Ядро intent — со слепком и отклонением, в той же транзакции, что и решение
CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, i.proposed_amount_minor, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason, NEW.reason_params,
           NEW.explanation, NEW.bound_deviation_bp
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Ссылка на полный снимок решения: данные канала, 18 месяцев [Р-38, Р-68]
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.price_decision_snapshot_ref (
  tenant_id              uuid        NOT NULL,
  price_decision_id      uuid        NOT NULL,
  decided_at             timestamptz NOT NULL,
  write_scope_id         uuid        NOT NULL,
  competitor_snapshot_id uuid        NOT NULL,
  source                 text        NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  observed_at            timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, price_decision_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id)
);

-- Удаление ссылок старше срока (maintenance.purge_expired_rows по decided_at)
CREATE INDEX price_decision_snapshot_ref_expiry_idx ON channel_data.price_decision_snapshot_ref (decided_at);

SELECT security.register_table('channel_data.price_decision_snapshot_ref', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.price_decision_snapshot_ref');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.price_decision_snapshot_ref', 'DELETE_ROWS', 'decided_at', '18 months', '0 days', 61);

-- Итог проверки входов принятого снимка — для пересчёта без нового снимка; без данных канала
ALTER TABLE channel_data.competitor_state
  ADD COLUMN sanity_summary jsonb,
  ADD CONSTRAINT competitor_state_sanity_summary_no_channel_data CHECK (NOT security.jsonb_has_any_key(sanity_summary, security.channel_param_keys()));

DO $$
DECLARE
  args text;
BEGIN
  SELECT string_agg(quote_literal(a), ', ') INTO args
    FROM (SELECT unnest(string_to_array(encode(tgargs, 'escape'), '\000')) AS a
            FROM pg_trigger WHERE tgrelid = 'channel_data.competitor_state'::regclass AND tgname = 'a_competitor_state_restrict_update') x
   WHERE a <> '';
  EXECUTE 'DROP TRIGGER a_competitor_state_restrict_update ON channel_data.competitor_state';
  EXECUTE format('CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state '
              || 'FOR EACH ROW EXECUTE FUNCTION security.restrict_update(%s, %L)', args, 'sanity_summary');
END $$;

-- ---------------------------------------------------------------------------
-- 5. Р-69, Р-70: остановка человеком
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_data.price_stop (
  tenant_id                 uuid        NOT NULL REFERENCES tenant_data.tenant (tenant_id),
  price_stop_id             uuid        NOT NULL DEFAULT gen_random_uuid(),
  scope_type                text        NOT NULL CHECK (scope_type IN ('TENANT', 'CHANNEL_ACCOUNT', 'STOREFRONT')),
  channel_account_id        uuid,
  marketplace               text CHECK (length(marketplace) BETWEEN 1 AND 40),
  stopped_at                timestamptz NOT NULL DEFAULT now(),
  stopped_by_membership_id  uuid        NOT NULL,
  stop_note                 text        NOT NULL CHECK (length(btrim(stop_note)) BETWEEN 10 AND 2000),
  released_at               timestamptz,
  released_by_membership_id uuid,
  release_note              text CHECK (length(btrim(release_note)) BETWEEN 10 AND 2000),
  PRIMARY KEY (tenant_id, price_stop_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, stopped_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, released_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT price_stop_scope_shape CHECK (
    (scope_type = 'TENANT' AND channel_account_id IS NULL AND marketplace IS NULL)
    OR (scope_type = 'CHANNEL_ACCOUNT' AND channel_account_id IS NOT NULL AND marketplace IS NULL)
    OR (scope_type = 'STOREFRONT' AND channel_account_id IS NOT NULL AND marketplace IS NOT NULL)),
  CONSTRAINT price_stop_release_complete CHECK (
    (released_at IS NULL) = (released_by_membership_id IS NULL) AND (released_at IS NULL) = (release_note IS NULL)),
  CHECK (released_at IS NULL OR released_at >= stopped_at)
);

-- Одна действующая остановка на область; действующие остановки тенанта — проверка при решении и записи (pricing_stop_for)
CREATE UNIQUE INDEX price_stop_active_uq ON tenant_data.price_stop
  (tenant_id, scope_type, (coalesce(channel_account_id, '00000000-0000-0000-0000-000000000000'::uuid)), (coalesce(marketplace, '*')))
  WHERE released_at IS NULL;

SELECT security.register_table('tenant_data.price_stop', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.price_stop');
-- Доказательство действий человека с ценами: удаляется только при закрытии тенанта
INSERT INTO maintenance.retention_policy (table_name, method, drop_order)
VALUES ('tenant_data.price_stop', 'TENANT_CLOSURE_ONLY', 62);

CREATE TRIGGER a_price_stop_restrict_update BEFORE UPDATE ON tenant_data.price_stop
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('released_at', 'released_by_membership_id', 'release_note');

/** Права: остановить — владелец и оператор; снять остановку тенанта — владелец; аккаунта и витрины — владелец и оператор */
CREATE FUNCTION tenant_data.price_stop_role_guard() RETURNS trigger
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
     OR (TG_OP = 'INSERT' AND r NOT IN ('OWNER', 'OPERATOR'))
     OR (TG_OP = 'UPDATE' AND NEW.scope_type = 'TENANT' AND r <> 'OWNER')
     OR (TG_OP = 'UPDATE' AND r NOT IN ('OWNER', 'OPERATOR')) THEN
    RAISE EXCEPTION 'membership % (role %) may not % a % price stop', member_id, coalesce(r, 'none'),
      CASE TG_OP WHEN 'INSERT' THEN 'create' ELSE 'release' END, NEW.scope_type USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- В сессии пользователя действовать можно только от своего членства
  IF security.current_user_id() IS NOT NULL AND u IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % belongs to another user', member_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER aa_price_stop_role_guard BEFORE INSERT OR UPDATE ON tenant_data.price_stop
  FOR EACH ROW EXECUTE FUNCTION tenant_data.price_stop_role_guard();

/** Действующая остановка человеком для единицы записи: тенант, аккаунт или витрина одного из её офферов */
CREATE FUNCTION tenant_data.pricing_stop_for(p_tenant_id uuid, p_write_scope_id uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT st.price_stop_id
    FROM tenant_data.price_stop st
   WHERE st.tenant_id = p_tenant_id AND st.released_at IS NULL
     AND (st.scope_type = 'TENANT'
          OR EXISTS (
               SELECT 1 FROM tenant_data.write_scope s
                WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id AND s.channel_account_id = st.channel_account_id
                  AND (st.scope_type = 'CHANNEL_ACCOUNT' OR EXISTS (
                        SELECT 1 FROM tenant_data.offer_mapping m
                         WHERE m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.marketplace = st.marketplace))))
   ORDER BY CASE st.scope_type WHEN 'TENANT' THEN 0 WHEN 'CHANNEL_ACCOUNT' THEN 1 ELSE 2 END
   LIMIT 1
$$;

/** Действующая системная остановка витрины для единицы записи [Р-51] */
CREATE FUNCTION channel_data.pricing_halt_for(p_tenant_id uuid, p_write_scope_id uuid) RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT h.pricing_halt_id
    FROM tenant_data.write_scope s
    JOIN channel_data.pricing_halt h
      ON h.tenant_id = s.tenant_id AND h.channel_account_id = s.channel_account_id AND h.released_at IS NULL
   WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
     AND (h.marketplace IS NULL OR EXISTS (
           SELECT 1 FROM tenant_data.offer_mapping m
            WHERE m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.marketplace = h.marketplace))
   LIMIT 1
$$;

-- Остановка человеком: ни одобрения, ни записи цены — любой, включая фиксированную и маржинальную [Р-69]
CREATE FUNCTION channel_data.price_decision_stop_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  stop_id uuid;
BEGIN
  IF NEW.outcome = 'APPROVED' THEN
    stop_id := tenant_data.pricing_stop_for(NEW.tenant_id, NEW.write_scope_id);
    IF stop_id IS NOT NULL THEN
      RAISE EXCEPTION 'pricing is stopped by price_stop % for write_scope % (Р-69)', stop_id, NEW.write_scope_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ab_price_decision_stop_guard BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_stop_guard();

CREATE FUNCTION tenant_data.channel_write_stop_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  stop_id uuid;
BEGIN
  IF NEW.field <> 'PRICE' OR (TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED')) THEN
    RETURN NEW;
  END IF;
  stop_id := tenant_data.pricing_stop_for(NEW.tenant_id, NEW.write_scope_id);
  IF stop_id IS NOT NULL THEN
    RAISE EXCEPTION 'pricing is stopped by price_stop % for write_scope % (Р-69)', stop_id, NEW.write_scope_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bb_channel_write_stop_guard BEFORE INSERT OR UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_stop_guard();

-- Проверка 2 из 3 [Р-44]: как 0032, плюс отклонение от границы [Р-73] и идентификатор остановки в сообщении
CREATE OR REPLACE FUNCTION channel_data.price_decision_floor_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  floor_minor   bigint;
  ceiling_minor bigint;
  proposed      bigint;
  bound_minor   bigint;
  halt_id       uuid;
BEGIN
  IF NEW.rejection_reason = 'BOUND_UNRESOLVABLE' THEN
    RETURN NEW;
  END IF;
  floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF floor_minor IS NULL OR NEW.effective_floor_minor < floor_minor THEN
    RAISE EXCEPTION 'decision floor % is below effective min_price %', NEW.effective_floor_minor, floor_minor
      USING ERRCODE = 'check_violation';
  END IF;
  IF ceiling_minor IS NULL OR NEW.effective_ceiling_minor > ceiling_minor THEN
    RAISE EXCEPTION 'decision ceiling % is above effective max_price % (Р-43)', NEW.effective_ceiling_minor, ceiling_minor
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.rejection_reason IN ('BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE') THEN
    SELECT proposed_amount_minor INTO proposed FROM channel_data.price_intent
     WHERE tenant_id = NEW.tenant_id AND created_at = NEW.intent_created_at AND price_intent_id = NEW.price_intent_id;
    IF (NEW.rejection_reason = 'BELOW_MIN_PRICE' AND proposed >= floor_minor)
       OR (NEW.rejection_reason = 'BELOW_MARGIN_FLOOR' AND proposed >= NEW.effective_floor_minor)
       OR (NEW.rejection_reason = 'ABOVE_MAX_PRICE' AND proposed <= NEW.effective_ceiling_minor) THEN
      RAISE EXCEPTION 'rejection reason % contradicts proposed price %', NEW.rejection_reason, proposed
        USING ERRCODE = 'check_violation';
    END IF;
    -- Р-73: отклонение считается от нарушенной границы, вверх до базисного пункта
    bound_minor := CASE NEW.rejection_reason WHEN 'BELOW_MIN_PRICE' THEN floor_minor
                                             WHEN 'BELOW_MARGIN_FLOOR' THEN NEW.effective_floor_minor
                                             ELSE NEW.effective_ceiling_minor END;
    IF NEW.bound_deviation_bp IS DISTINCT FROM ceil(abs(proposed - bound_minor) * 10000.0 / bound_minor)::int THEN
      RAISE EXCEPTION 'bound deviation % bp does not match proposed % against bound % (Р-73)', NEW.bound_deviation_bp, proposed, bound_minor
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.outcome = 'APPROVED' AND NEW.competitor_derived THEN
    halt_id := channel_data.pricing_halt_for(NEW.tenant_id, NEW.write_scope_id);
    IF halt_id IS NOT NULL THEN
      RAISE EXCEPTION 'competitor-derived pricing is halted by pricing_halt % for write_scope % (Р-51)', halt_id, NEW.write_scope_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_ceiling_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ceiling_minor bigint;
  halt_id       uuid;
BEGIN
  IF NEW.field <> 'PRICE' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  ceiling_minor := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
  IF ceiling_minor IS NULL OR NEW.amount_minor > ceiling_minor THEN
    RAISE EXCEPTION 'value % is above effective max_price % (%)', NEW.amount_minor, ceiling_minor,
      CASE TG_OP WHEN 'INSERT' THEN 'at creation' ELSE 'at dispatch' END USING ERRCODE = 'check_violation';
  END IF;
  halt_id := channel_data.pricing_halt_for(NEW.tenant_id, NEW.write_scope_id);
  IF halt_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM channel_data.price_decision d
        WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id AND d.competitor_derived) THEN
    RAISE EXCEPTION 'competitor-derived pricing is halted by pricing_halt % for write_scope % (Р-51)', halt_id, NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 6. Р-69: pricing_halt — только системная остановка по испорченным данным
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.pricing_halt
  DROP CONSTRAINT pricing_halt_manual_attributed,
  DROP CONSTRAINT pricing_halt_reason_code_check,
  DROP COLUMN halted_by_membership_id,
  DROP COLUMN halt_note,
  ADD CONSTRAINT pricing_halt_system_only CHECK (reason_code = 'CHANNEL_MASS_SHIFT');

-- Ручное снятие системной остановки [Р-52] — владелец и оператор
CREATE FUNCTION channel_data.pricing_halt_release_role_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  r text;
BEGIN
  IF OLD.released_at IS NULL AND NEW.released_kind = 'MANUAL' THEN
    SELECT m.role INTO r FROM tenant_data.membership m
     WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
    IF r IS NULL OR r NOT IN ('OWNER', 'OPERATOR') THEN
      RAISE EXCEPTION 'membership % (role %) may not release a channel halt', NEW.released_by_membership_id, coalesce(r, 'none')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ca_pricing_halt_release_role_guard BEFORE UPDATE ON channel_data.pricing_halt
  FOR EACH ROW EXECUTE FUNCTION channel_data.pricing_halt_release_role_guard();

-- ---------------------------------------------------------------------------
-- 7. Коды причин шага 12
-- ---------------------------------------------------------------------------
ALTER TABLE channel_data.price_decision
  DROP CONSTRAINT price_decision_rejection_reason_known,
  DROP CONSTRAINT price_decision_held_reasons;
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_rejection_reason_known CHECK (rejection_reason IN (
    'BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE', 'BOUND_UNRESOLVABLE', 'STEP_LIMIT', 'CHANGE_RATE_LIMIT',
    'INTENT_EXPIRED', 'INTENT_INVALID', 'SCOPE_NOT_ACTIVE', 'CHANNEL_HALTED', 'PRICING_STOPPED', 'INTERNAL_BOUND_VIOLATION')),
  ADD CONSTRAINT price_decision_held_reasons CHECK (
    outcome <> 'HELD' OR rejection_reason IN ('STEP_LIMIT', 'CHANGE_RATE_LIMIT', 'SCOPE_NOT_ACTIVE', 'PRICING_STOPPED'));

ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_reason_known;
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason IN (
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED',
    'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED', 'PRICING_STOPPED', 'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED'));

RESET ROLE;
COMMIT;
