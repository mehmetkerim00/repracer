-- 0082_channel_distrust_strategy_availability.sql
-- Шаг 23.
-- 1. Р-118: третий вид остановки — ОСТАНОВКА ПО НЕДОВЕРИЮ КАНАЛУ (channel_data.channel_distrust). Сломана трансляция цены в канал, а не
--    входные данные: фиксированная цена пройдёт тем же сломанным путём. Держит ВСЕ цены (одобрение, создание и отправку записи PRICE и
--    CHANNEL_MIN_PRICE — OQ-166), ставит её система (путь решения, диспетчер), снимает только человек с правом RELEASE_CHANNEL_DISTRUST,
--    от своего имени, со вторым фактором и заметкой. Не расширение Р-51 (pricing_halt — только цены из данных конкурентов, снимается
--    выборкой) и не kill switch Р-69 (price_stop — ставит человек). Первая причина — неверная база цены [Р-116]; остановка витрины
--    CHANNEL_PRICE_BASIS_MISMATCH из 0080 удаляется, pricing_halt возвращается к одной причине.
-- 2. Р-119: свойство канала «остановка снимается выборкой или только человеком» — platform.channel_behaviour; review_halt_by_sample
--    на канале без выборки возвращает MANUAL_ONLY.
-- 3. OQ-166, Р-39: доступность стратегии проверяет база — источники конкурентов канала (platform.competitor_source, совпадают с описанием
--    адаптеров) и требования стратегии (channel_data.strategy_unmet); назначение недоступной стратегии единице записи — отказ.
-- 4. Р-120: наблюдения собственного ценообразования канала у предложения при обнаружении (channel_data.offer_channel_pricing);
--    назначить стратегию предложению с действующим правилом канала нельзя.

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM channel_data.pricing_halt WHERE reason_code = 'CHANNEL_PRICE_BASIS_MISMATCH') THEN
    RAISE EXCEPTION 'pricing_halt holds CHANNEL_PRICE_BASIS_MISMATCH rows: move them to channel_data.channel_distrust before 0082 (no production data expected)';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Системная остановка витрины — снова только массовый сдвиг [Р-51]
-- ---------------------------------------------------------------------------
DROP TRIGGER ac_price_decision_basis_halt_guard ON channel_data.price_decision;
DROP TRIGGER bc_channel_write_basis_halt_guard ON tenant_data.channel_write;
DROP FUNCTION channel_data.price_decision_basis_halt_guard();
DROP FUNCTION tenant_data.channel_write_basis_halt_guard();
DROP FUNCTION channel_data.price_basis_halt_for(uuid, uuid);
ALTER TABLE channel_data.pricing_halt DROP CONSTRAINT pricing_halt_system_only;
ALTER TABLE channel_data.pricing_halt ADD CONSTRAINT pricing_halt_system_only CHECK (reason_code = 'CHANNEL_MASS_SHIFT');
COMMENT ON CONSTRAINT pricing_halt_system_only ON channel_data.pricing_halt IS
  'Р-69, Р-118: системная остановка витрины — только по испорченным входным данным (массовый сдвиг); недоверие каналу — channel_data.channel_distrust';
DROP INDEX channel_data.pricing_halt_active_uq;
-- Одна действующая остановка на аккаунт и витрину: повтор вставки — ON CONFLICT DO NOTHING (insertHalt)
CREATE UNIQUE INDEX pricing_halt_active_uq ON channel_data.pricing_halt (tenant_id, channel_account_id, (COALESCE(marketplace, '*')))
  WHERE released_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2. Свойства каналов и источники конкурентов — справочники платформы
-- ---------------------------------------------------------------------------
SET ROLE repracer_owner;

-- Справочники без CHECK на значения: строки загружает только миграция, их совпадение с описанием адаптеров (ChannelDescriptor) проверяет
-- channel-reference.pg.test.ts — ограничение значений было бы дублем без собственной проверки [Р-104, Р-108]
CREATE TABLE platform.channel_behaviour (
  tenant_id    uuid NOT NULL DEFAULT security.platform_tenant_id(),
  channel      text NOT NULL,
  -- Р-52, Р-119: SAMPLE — снимается свежей выборкой опросом; MANUAL_ONLY — канал не даёт опроса, только человек
  halt_release text NOT NULL,
  basis        text NOT NULL,
  PRIMARY KEY (tenant_id, channel)
);
SELECT security.register_table('platform.channel_behaviour', 'PLATFORM', 'reference', 'none');
CREATE POLICY channel_behaviour_read ON platform.channel_behaviour FOR SELECT TO repracer_app, repracer_halt_reviewer
  USING (tenant_id = security.platform_tenant_id());
CREATE POLICY channel_behaviour_owner_load ON platform.channel_behaviour TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
GRANT SELECT ON platform.channel_behaviour TO repracer_app, repracer_halt_reviewer;
-- Проверка остановки выборкой (SECURITY DEFINER от роли проверки) читает свойство канала [Р-119]
GRANT USAGE ON SCHEMA platform TO repracer_halt_reviewer;
-- Сгенерировано из ChannelDescriptor.haltRelease адаптеров; совпадение проверяет channel-reference.pg.test.ts
INSERT INTO platform.channel_behaviour (channel, halt_release, basis) VALUES
  ('KAUFLAND', 'SAMPLE', 'Р-52: fresh sample by polling GET /buybox'),
  ('AMAZON', 'MANUAL_ONLY', 'Р-119: no competitor polling on Amazon, a fresh independent sample cannot be taken');

CREATE TABLE platform.competitor_source (
  tenant_id                 uuid NOT NULL DEFAULT security.platform_tenant_id(),
  channel                   text NOT NULL,
  source                    text NOT NULL,
  kind                      text NOT NULL,
  completeness_kind         text NOT NULL,
  completeness_n            int,
  conditions                text[] NOT NULL,
  has_buybox_winner         boolean NOT NULL,
  has_own_rank              boolean NOT NULL,
  has_shipping              boolean NOT NULL,
  typical_staleness_seconds int,
  availability              text NOT NULL,
  role                      text NOT NULL,
  PRIMARY KEY (tenant_id, channel, source)
);
SELECT security.register_table('platform.competitor_source', 'PLATFORM', 'reference', 'none');
CREATE POLICY competitor_source_read ON platform.competitor_source FOR SELECT TO repracer_app
  USING (tenant_id = security.platform_tenant_id());
CREATE POLICY competitor_source_owner_load ON platform.competitor_source TO repracer_owner
  USING (tenant_id = security.platform_tenant_id()) WITH CHECK (tenant_id = security.platform_tenant_id());
GRANT SELECT ON platform.competitor_source TO repracer_app;
-- Сгенерировано из ChannelDescriptor.competitorSources адаптеров Kaufland и Amazon; совпадение проверяет channel-reference.pg.test.ts
INSERT INTO platform.competitor_source (channel, source, kind, completeness_kind, completeness_n, conditions, has_buybox_winner, has_own_rank,
                                        has_shipping, typical_staleness_seconds, availability, role) VALUES
  ('KAUFLAND', 'KAUFLAND_BUY_BOX_CHANGED', 'PUSH', 'TOP_N', 10, ARRAY['new']::text[], true, true, true, NULL, 'EARLY_ACCESS', 'PRIMARY'),
  ('KAUFLAND', 'KAUFLAND_BUYBOX', 'PULL', 'TOP_N', 10, ARRAY['new', 'used', 'used - as new', 'used - very good', 'used - good', 'used - acceptable', 'refurbished', 'refurbished - as new', 'refurbished - very good', 'refurbished - good', 'refurbished - acceptable']::text[], true, true, true, NULL, 'AVAILABLE', 'PRIMARY'),
  ('KAUFLAND', 'KAUFLAND_COMPETITORS_COMPARER', 'REPORT', 'CHEAPEST_ONLY', NULL, ARRAY['new', 'used']::text[], false, false, false, NULL, 'AVAILABLE', 'RECONCILIATION'),
  ('AMAZON', 'AMAZON_ANY_OFFER_CHANGED', 'PUSH', 'TOP_N', 20, ARRAY['new', 'used', 'collectible', 'refurbished', 'club']::text[], true, false, true, NULL, 'AVAILABLE', 'PRIMARY');

/**
 * Р-39, OQ-166: что из требований стратегии не выполняет каждый источник конкурентов канала — как strategyAvailability и requirementOf
 * (strategy-engine). Пустой объект — стратегии данные конкурентов не нужны; стратегия доступна, если хотя бы у одного источника список
 * пуст. Неизвестный тип стратегии — недоступен (fail-closed). Совпадение с кодом проверяет channel-reference.pg.test.ts.
 */
CREATE FUNCTION channel_data.strategy_unmet(p_channel text, p_params jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  t          text := p_params ->> 'type';
  req_kind   text;
  min_n      int := 1;
  buybox     boolean := false;
  shipping   boolean := false;
  staleness  int := 900;
  s          record;
  u          text[];
  out        jsonb := '{}'::jsonb;
BEGIN
  IF t IN ('FIXED', 'TARGET_MARGIN') THEN
    RETURN '{}'::jsonb;
  ELSIF t = 'MATCH_BUYBOX' THEN
    req_kind := 'TOP_N'; buybox := true;
  ELSIF t = 'BEAT_LOWEST' THEN
    req_kind := CASE WHEN p_params ->> 'scope' = 'MARKET' THEN 'CHEAPEST_ONLY' ELSE 'TOP_N' END;
    shipping := coalesce((p_params ->> 'compareLanded')::boolean, false);
  ELSE
    RETURN jsonb_build_object('*', jsonb_build_array('UNKNOWN_STRATEGY_TYPE'));
  END IF;
  FOR s IN SELECT * FROM platform.competitor_source c WHERE c.channel = p_channel ORDER BY c.source LOOP
    u := '{}';
    IF s.role <> 'PRIMARY' THEN u := u || 'RECONCILIATION_ONLY'::text; END IF;
    IF s.availability <> 'AVAILABLE' THEN u := u || ('AVAILABILITY_' || s.availability)::text; END IF;
    IF NOT (s.completeness_kind = 'FULL'
            OR (req_kind = 'TOP_N' AND s.completeness_kind = 'TOP_N' AND s.completeness_n >= min_n)
            OR (req_kind <> 'TOP_N' AND s.completeness_kind = req_kind)) THEN
      u := u || 'COMPLETENESS'::text;
    END IF;
    IF buybox AND NOT s.has_buybox_winner THEN u := u || 'BUYBOX_WINNER'::text; END IF;
    IF shipping AND NOT s.has_shipping THEN u := u || 'SHIPPING'::text; END IF;
    IF NOT ('new' = ANY (s.conditions)) THEN u := u || 'CONDITION'::text; END IF;
    IF s.typical_staleness_seconds IS NOT NULL AND s.typical_staleness_seconds > staleness THEN u := u || 'STALENESS'::text; END IF;
    IF cardinality(u) = 0 THEN
      RETURN '{}'::jsonb;
    END IF;
    out := out || jsonb_build_object(s.source, to_jsonb(u));
  END LOOP;
  IF out = '{}'::jsonb THEN
    out := jsonb_build_object('*', jsonb_build_array('NO_COMPETITOR_SOURCE'));
  END IF;
  RETURN out;
END $fn$;
GRANT EXECUTE ON FUNCTION channel_data.strategy_unmet(text, jsonb) TO repracer_app;

-- ---------------------------------------------------------------------------
-- 3. Р-120: собственное ценообразование канала у предложения, наблюдённое при обнаружении и записи
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.offer_channel_pricing (
  tenant_id                   uuid NOT NULL,
  offer_channel_pricing_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id          uuid NOT NULL,
  channel                     text NOT NULL,
  marketplace                 text NOT NULL,
  external_sku                text NOT NULL,
  -- Привязка к правилу автоматического ценообразования канала (Amazon automated_pricing_merchandising_rule_plan) [Р-115]
  automated_pricing           boolean NOT NULL,
  -- Границы цены на стороне канала (Amazon minimum/maximum_seller_allowed_price) [Р-114]
  channel_bounds              boolean NOT NULL,
  source                      text NOT NULL CONSTRAINT offer_channel_pricing_source_known CHECK (source IN ('DISCOVERY', 'PRE_WRITE_READ', 'READBACK')),
  observed_at                 timestamptz NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, offer_channel_pricing_id),
  -- Канал наблюдения — канал аккаунта (составной ключ, как у pricing_halt)
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel)
);
COMMENT ON TABLE channel_data.offer_channel_pricing IS
  'Р-120: наблюдение собственного ценообразования канала у предложения (данные канала, 18 месяцев); действующее — последнее по observed_at';
SELECT security.register_table('channel_data.offer_channel_pricing', 'CHANNEL', 'append_only');
SELECT security.grant_retention('channel_data.offer_channel_pricing');
GRANT SELECT, INSERT ON channel_data.offer_channel_pricing TO repracer_app;
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.offer_channel_pricing', 'DELETE_ROWS', 'recorded_at', interval '18 months', interval '0', 64);
-- Последнее наблюдение предложения: страж назначения стратегии (write_scope_strategy_guard) и список консоли
CREATE INDEX offer_channel_pricing_latest_idx ON channel_data.offer_channel_pricing (tenant_id, channel_account_id, marketplace, external_sku, observed_at DESC);

/** Р-120: у предложения единицы записи действует собственное ценообразование канала по последнему наблюдению */
CREATE FUNCTION channel_data.offer_channel_pricing_active(p_tenant_id uuid, p_write_scope_id uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT CASE WHEN o.automated_pricing THEN 'CHANNEL_REPRICER_ACTIVE' WHEN o.channel_bounds THEN 'CHANNEL_BOUNDS_PRESENT' END
    FROM tenant_data.offer_mapping m
    JOIN LATERAL (
      SELECT x.automated_pricing, x.channel_bounds FROM channel_data.offer_channel_pricing x
       WHERE x.tenant_id = m.tenant_id AND x.channel_account_id = m.channel_account_id AND x.marketplace = m.marketplace AND x.external_sku = m.external_sku
       ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1) o ON true
   WHERE m.tenant_id = p_tenant_id AND m.price_write_scope_id = p_write_scope_id AND m.external_sku IS NOT NULL
     AND (o.automated_pricing OR o.channel_bounds)
   LIMIT 1
$fn$;
GRANT EXECUTE ON FUNCTION channel_data.offer_channel_pricing_active(uuid, uuid) TO repracer_app;

-- Р-39, OQ-166, Р-120: стратегия назначается единице записи, только если канал даёт нужные ей данные конкурентов и у предложения нет
-- действующего собственного ценообразования канала
CREATE FUNCTION tenant_data.write_scope_strategy_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  params  jsonb;
  unmet   jsonb;
  pricing text;
BEGIN
  IF NEW.field <> 'PRICE' OR NEW.pricing_strategy_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pricing_strategy_id IS NOT DISTINCT FROM OLD.pricing_strategy_id
     AND NEW.pricing_strategy_version IS NOT DISTINCT FROM OLD.pricing_strategy_version
     AND NEW.pricing_mode IS NOT DISTINCT FROM OLD.pricing_mode THEN
    RETURN NEW;
  END IF;
  SELECT ps.params || jsonb_build_object('type', ps.type) INTO params FROM tenant_data.pricing_strategy ps
   WHERE ps.tenant_id = NEW.tenant_id AND ps.pricing_strategy_id = NEW.pricing_strategy_id AND ps.version = NEW.pricing_strategy_version;
  unmet := channel_data.strategy_unmet(NEW.channel, params);
  IF unmet <> '{}'::jsonb THEN
    RAISE EXCEPTION 'strategy % version % is not available on channel %: %', NEW.pricing_strategy_id, NEW.pricing_strategy_version, NEW.channel, unmet
      USING ERRCODE = 'check_violation', HINT = 'Р-39';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    pricing := channel_data.offer_channel_pricing_active(NEW.tenant_id, NEW.write_scope_id);
    IF pricing IS NOT NULL THEN
      RAISE EXCEPTION 'write_scope % has channel-owned pricing (%): a strategy cannot be assigned (Р-120)', NEW.write_scope_id, pricing
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a2_write_scope_strategy_guard BEFORE INSERT OR UPDATE OF pricing_strategy_id, pricing_strategy_version, pricing_mode ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_strategy_guard();

-- ---------------------------------------------------------------------------
-- 4. Р-118: остановка по недоверию каналу
-- ---------------------------------------------------------------------------
CREATE TABLE channel_data.channel_distrust (
  tenant_id                 uuid NOT NULL,
  channel_distrust_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id        uuid NOT NULL,
  channel                   text NOT NULL,
  marketplace               text,
  reason_code               text NOT NULL CONSTRAINT channel_distrust_reason_known CHECK (reason_code IN ('PRICE_BASIS_MISMATCH')),
  -- Только наши значения (отправленная цена, ставка, направление): цена, прочитанная из канала, не хранится [Р-3]
  details                   jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object' AND NOT details ? 'observedMinor'),
  detected_at               timestamptz NOT NULL DEFAULT now(),
  released_at               timestamptz,
  released_by_membership_id uuid,
  release_note              text,
  PRIMARY KEY (tenant_id, channel_distrust_id),
  FOREIGN KEY (tenant_id, channel_account_id, channel) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id, channel),
  FOREIGN KEY (tenant_id, released_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  -- Снятие — целиком: момент, участник и заметка 10…2000 символов вместе [Р-118]
  CONSTRAINT channel_distrust_release_by_person CHECK ((released_at IS NULL) = (released_by_membership_id IS NULL)
                                                        AND (released_at IS NULL) = (release_note IS NULL)
                                                        AND (release_note IS NULL OR length(release_note) BETWEEN 10 AND 2000)
                                                        AND (released_at IS NULL OR released_at >= detected_at))
);
COMMENT ON TABLE channel_data.channel_distrust IS
  'Р-118: остановка по недоверию каналу — сломана трансляция цены в канал; все цены; ставит система, снимает только человек со вторым фактором';
SELECT security.register_table('channel_data.channel_distrust', 'CHANNEL', 'mutable');
SELECT security.grant_retention('channel_data.channel_distrust');
INSERT INTO maintenance.retention_policy (table_name, method, anchor_column, retention, safety_margin, drop_order)
VALUES ('channel_data.channel_distrust', 'DELETE_ROWS', 'released_at', interval '18 months', interval '14 days', 61);
-- Р-100: путь решения и диспетчер вставляют только рабочие столбцы; снятие — административный сервис, только столбцы снятия
REVOKE INSERT, UPDATE ON channel_data.channel_distrust FROM repracer_admin;
GRANT SELECT ON channel_data.channel_distrust TO repracer_app;
GRANT INSERT (tenant_id, channel_account_id, channel, marketplace, reason_code, details, detected_at) ON channel_data.channel_distrust TO repracer_app;
GRANT UPDATE (released_at, released_by_membership_id, release_note) ON channel_data.channel_distrust TO repracer_admin;
-- Одна действующая остановка на аккаунт, витрину и причину: повтор обнаружения не создаёт вторую (ON CONFLICT DO NOTHING в хранилище)
CREATE UNIQUE INDEX channel_distrust_active_uq ON channel_data.channel_distrust (tenant_id, channel_account_id, (COALESCE(marketplace, '*')), reason_code)
  WHERE released_at IS NULL;

/** Действующая остановка по недоверию каналу для единицы записи [Р-118] */
CREATE FUNCTION channel_data.channel_distrust_for(p_tenant_id uuid, p_write_scope_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT d.channel_distrust_id
    FROM tenant_data.write_scope s
    JOIN channel_data.channel_distrust d
      ON d.tenant_id = s.tenant_id AND d.channel_account_id = s.channel_account_id AND d.released_at IS NULL
   WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
     AND (d.marketplace IS NULL OR EXISTS (
           SELECT 1 FROM tenant_data.offer_mapping m
            WHERE m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.marketplace = d.marketplace))
   ORDER BY d.detected_at
   LIMIT 1
$fn$;
GRANT EXECUTE ON FUNCTION channel_data.channel_distrust_for(uuid, uuid) TO repracer_app;

-- Ставит система: человек в административном сервисе недоверие не создаёт, вставка уже снятой — отказ
CREATE FUNCTION channel_data.channel_distrust_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF security.admin_session() THEN
    RAISE EXCEPTION 'a person does not create a channel distrust: it is set by the system from what the channel did with our price (Р-118)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a00_channel_distrust_insert_guard BEFORE INSERT ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION channel_data.channel_distrust_insert_guard();

-- Снимает только человек: членство пользователя сессии, второй фактор; один раз. Право RELEASE_CHANNEL_DISTRUST по роли проверяет страж
-- административной записи (security.admin_write_action, Р-100) — здесь не дублируется [Р-104]
CREATE FUNCTION channel_data.channel_distrust_release_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  u uuid;
BEGIN
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'channel distrust % is already released', OLD.channel_distrust_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT m.user_id INTO u FROM tenant_data.membership m
   WHERE m.tenant_id = NEW.tenant_id AND m.membership_id = NEW.released_by_membership_id AND m.status = 'ACTIVE';
  IF security.current_user_id() IS NULL OR u IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.released_by_membership_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT security.session_mfa() THEN
    RAISE EXCEPTION 'releasing channel distrust % requires a second factor (Р-118, Р-88)', NEW.channel_distrust_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
-- Изменяемые столбцы ограничивают права по столбцам (снятие — только released_*): отдельный триггер был бы дублем [Р-104]
CREATE TRIGGER ca_channel_distrust_release_guard BEFORE UPDATE ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION channel_data.channel_distrust_release_guard();

-- Аудит [Р-76]: создание — актор SYSTEM; снятие — участник с ролью, областью и заметкой, как снятие остановки человеком (price_stop_audit).
-- Административная запись дополнительно пишет admin_change.update (Р-97), но без роли и заметки — экран журнала остановок её не читает
-- (находка шага 23: снятие в базе было видно только как изменение столбцов)
CREATE FUNCTION channel_data.channel_distrust_audit() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE
  m record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
    VALUES (NEW.tenant_id, now(), 'SYSTEM', 'pricing.distrust_created', 'channel_distrust', NEW.channel_distrust_id,
            jsonb_build_object('reasonCode', NEW.reason_code, 'scope', CASE WHEN NEW.marketplace IS NULL THEN 'CHANNEL_ACCOUNT' ELSE 'STOREFRONT' END,
                               'channelAccountId', NEW.channel_account_id, 'marketplace', NEW.marketplace, 'at', NEW.detected_at));
    RETURN NULL;
  END IF;
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT mm.role, mm.user_id INTO m FROM tenant_data.membership mm WHERE mm.tenant_id = NEW.tenant_id AND mm.membership_id = NEW.released_by_membership_id;
  IF m IS NULL THEN
    RAISE EXCEPTION 'channel distrust %: author % is not a member; the audit event needs its author (Р-76)', NEW.channel_distrust_id, NEW.released_by_membership_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, actor_user_id, actor_membership_id, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'USER', m.user_id, NEW.released_by_membership_id, 'pricing.distrust_released', 'channel_distrust', NEW.channel_distrust_id,
          jsonb_build_object('role', m.role, 'reasonCode', NEW.reason_code, 'scope', CASE WHEN NEW.marketplace IS NULL THEN 'CHANNEL_ACCOUNT' ELSE 'STOREFRONT' END,
                             'channelAccountId', NEW.channel_account_id, 'marketplace', NEW.marketplace, 'note', NEW.release_note, 'at', NEW.released_at));
  RETURN NULL;
END $fn$;
CREATE TRIGGER zb_channel_distrust_audit AFTER INSERT OR UPDATE OF released_at ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION channel_data.channel_distrust_audit();

-- Одобрение любой цены при недоверии каналу — отказ
CREATE FUNCTION channel_data.price_decision_distrust_guard() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE
  distrust_id uuid;
BEGIN
  IF NEW.outcome = 'APPROVED' THEN
    distrust_id := channel_data.channel_distrust_for(NEW.tenant_id, NEW.write_scope_id);
    IF distrust_id IS NOT NULL THEN
      RAISE EXCEPTION 'pricing is held: the channel is distrusted by channel_distrust % for write_scope % (Р-118)', distrust_id, NEW.write_scope_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ac_price_decision_distrust_guard BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_distrust_guard();

-- Создание и отправка записи цены и порога цены канала [OQ-166] при недоверии каналу — отказ; остаток не держит
CREATE FUNCTION tenant_data.channel_write_distrust_guard() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE
  distrust_id uuid;
BEGIN
  IF NEW.field NOT IN ('PRICE', 'CHANNEL_MIN_PRICE') OR (TG_OP = 'UPDATE' AND NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED')) THEN
    RETURN NEW;
  END IF;
  distrust_id := channel_data.channel_distrust_for(NEW.tenant_id, NEW.write_scope_id);
  IF distrust_id IS NOT NULL THEN
    RAISE EXCEPTION 'pricing is held: the channel is distrusted by channel_distrust % for write_scope % (Р-118)', distrust_id, NEW.write_scope_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER bc_channel_write_distrust_guard BEFORE INSERT OR UPDATE OF status ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_distrust_guard();

-- Коды причин
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_rejection_reason_known;
ALTER TABLE channel_data.price_decision ADD CONSTRAINT price_decision_rejection_reason_known CHECK (rejection_reason IN (
  'BELOW_MIN_PRICE', 'BELOW_MARGIN_FLOOR', 'ABOVE_MAX_PRICE', 'BOUND_UNRESOLVABLE', 'STEP_LIMIT', 'CHANGE_RATE_LIMIT', 'INTENT_EXPIRED', 'INTENT_INVALID',
  'SCOPE_NOT_ACTIVE', 'CHANNEL_HALTED', 'CHANNEL_DISTRUSTED', 'PRICING_STOPPED', 'INTERNAL_BOUND_VIOLATION'));
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_reason_known;
ALTER TABLE tenant_data.channel_write ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason IN (
  'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED', 'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED',
  'CHANNEL_DISTRUSTED', 'PRICING_STOPPED', 'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED', 'WRITE_BUDGET_DAY_UNCONFIRMED'));

-- Профиль Gate с проверкой недоверия каналу [Р-75]: g74.1 остаётся для решений до шага 23
INSERT INTO platform.explanation_ruleset (ruleset_id, kind, definition) VALUES
  ('g118.1', 'GATE', '{"CHANGED":["PRICE_STOP","SCOPE","CHANNEL_DISTRUST","CHANNEL_HALT","INTENT","BOUNDS_RESOLVED","MARGIN_FLOOR","LOWER_BOUND","UPPER_BOUND","STEP","RATE","FINAL_RECHECK"],"NO_OP":["PRICE_STOP","SCOPE","CHANNEL_DISTRUST","CHANNEL_HALT","INTENT","BOUNDS_RESOLVED","MARGIN_FLOOR","CURRENT_WITHIN_BOUNDS"]}');

RESET ROLE;

-- Страж и аудит административной записи [Р-97, Р-100] — функции служебных ролей, триггеры создаёт суперпользователь
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER a0_admin_write_person_update BEFORE UPDATE ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_update AFTER UPDATE ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON channel_data.channel_distrust
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Функции аудита — от роли записи аудита (как pricing_halt_audit, 0058)
ALTER FUNCTION channel_data.channel_distrust_audit() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION channel_data.channel_distrust_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION channel_data.channel_distrust_audit() FROM PUBLIC;

-- Р-119 в функции проверки выборкой
CREATE OR REPLACE FUNCTION channel_data.review_halt_by_sample(p_tenant_id uuid, p_pricing_halt_id uuid, p_at timestamp with time zone)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
  -- Р-119: у канала нет опроса конкурентов — выборку взять неоткуда, снятие только человеком (свойство канала, не пробел)
  IF (SELECT b.halt_release FROM platform.channel_behaviour b WHERE b.channel = h.channel) IS DISTINCT FROM 'SAMPLE' THEN
    RETURN 'MANUAL_ONLY';
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
END $function$;

CREATE OR REPLACE FUNCTION security.decision_path_allowed_privileges()
 RETURNS TABLE(table_name text, privilege text, column_name text)
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
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
    ('channel_data.divergence_case', 'SELECT', NULL),
    -- Р-100: путь решения открывает случай расхождения; разрешение (resolution, resolved_*, status) — действие человека
    ('channel_data.divergence_case', 'INSERT', 'tenant_id'), ('channel_data.divergence_case', 'INSERT', 'write_scope_id'), ('channel_data.divergence_case', 'INSERT', 'field'), ('channel_data.divergence_case', 'INSERT', 'expected_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'observed_amount_minor'), ('channel_data.divergence_case', 'INSERT', 'cause'), ('channel_data.divergence_case', 'INSERT', 'opened_at'),
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
    ('channel_data.pricing_halt', 'SELECT', NULL),
    -- Р-100: путь решения ставит системную остановку; снятие, срок проверки и окно — не его столбцы (находка 4 ревью шага 17)
    ('channel_data.pricing_halt', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt', 'INSERT', 'channel_account_id'), ('channel_data.pricing_halt', 'INSERT', 'channel'), ('channel_data.pricing_halt', 'INSERT', 'marketplace'), ('channel_data.pricing_halt', 'INSERT', 'reason_code'), ('channel_data.pricing_halt', 'INSERT', 'rejected_snapshot_id'), ('channel_data.pricing_halt', 'INSERT', 'details'), ('channel_data.pricing_halt', 'INSERT', 'halted_at'), ('channel_data.pricing_halt', 'INSERT', 'review_window'),
    -- Шаг 23 [Р-118, Р-119, Р-39, Р-120]: недоверие каналу ставит путь решения и диспетчер; справочники каналов; наблюдения чужого ценообразования
    ('channel_data.channel_distrust', 'SELECT', NULL),
    ('channel_data.channel_distrust', 'INSERT', 'tenant_id'), ('channel_data.channel_distrust', 'INSERT', 'channel_account_id'), ('channel_data.channel_distrust', 'INSERT', 'channel'),
    ('channel_data.channel_distrust', 'INSERT', 'marketplace'), ('channel_data.channel_distrust', 'INSERT', 'reason_code'), ('channel_data.channel_distrust', 'INSERT', 'details'),
    ('channel_data.channel_distrust', 'INSERT', 'detected_at'),
    ('platform.channel_behaviour', 'SELECT', NULL), ('platform.competitor_source', 'SELECT', NULL),
    ('channel_data.offer_channel_pricing', 'SELECT', NULL), ('channel_data.offer_channel_pricing', 'INSERT', NULL),
    ('channel_data.pricing_halt_sample', 'SELECT', NULL),
    ('channel_data.pricing_halt_sample', 'INSERT', 'tenant_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'pricing_halt_id'), ('channel_data.pricing_halt_sample', 'INSERT', 'channel_product_ref'), ('channel_data.pricing_halt_sample', 'INSERT', 'observed_at'), ('channel_data.pricing_halt_sample', 'INSERT', 'verdict'), ('channel_data.pricing_halt_sample', 'INSERT', 'reason_code')
  ) AS a(t, p, c)
$function$;

CREATE OR REPLACE FUNCTION security.pricing_permission(p_role text, p_action text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT coalesce(p_role = ANY (CASE p_action
    WHEN 'VIEW_PRICING'           THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER', 'INVENTORY_MANAGER', 'VIEWER']
    WHEN 'STOP_PRICING'           THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RESUME_TENANT_STOP'     THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'RESUME_CHANNEL_STOP'    THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_HALT'   THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'RELEASE_CHANNEL_DISTRUST' THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'ENABLE_REPRICING'       THEN ARRAY['OWNER', 'ADMIN', 'OPERATOR', 'PRICING_MANAGER']
    WHEN 'MANAGE_PRICING'         THEN ARRAY['OWNER', 'ADMIN', 'PRICING_MANAGER']
    WHEN 'MANAGE_CATALOG'         THEN ARRAY['OWNER', 'ADMIN', 'INVENTORY_MANAGER']
    WHEN 'MANAGE_TENANT'          THEN ARRAY['OWNER', 'ADMIN']
    WHEN 'GIVE_MIGRATION_CONSENT' THEN ARRAY['OWNER']
    ELSE ARRAY[]::text[] END), false)
$function$;

CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_TENANT'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.guardrail', 'MANAGE_PRICING'), ('tenant_data.pricing_strategy', 'MANAGE_PRICING'), ('channel_data.pricing_strategy_undercut', 'MANAGE_PRICING'),
    ('tenant_data.divergence_policy', 'MANAGE_PRICING'), ('channel_data.fee_estimate', 'MANAGE_PRICING'), ('tenant_data.product_vat_rate', 'MANAGE_PRICING'),
    ('channel_data.divergence_case', 'MANAGE_PRICING'),
    ('tenant_data.product', 'MANAGE_CATALOG'), ('tenant_data.bundle_component', 'MANAGE_CATALOG'), ('tenant_data.offer_mapping', 'MANAGE_CATALOG'),
    ('tenant_data.stock_source', 'MANAGE_CATALOG'), ('tenant_data.stock_pool', 'MANAGE_CATALOG'), ('tenant_data.stock_movement', 'MANAGE_CATALOG'),
    ('tenant_data.stock_allocation', 'MANAGE_CATALOG'), ('channel_data.reservation', 'MANAGE_CATALOG'), ('channel_data.sync_job', 'MANAGE_CATALOG'),
    ('channel_data.listing_migration_check', 'MANAGE_CATALOG'),
    ('tenant_data.migration_consent', 'GIVE_MIGRATION_CONSENT'), ('tenant_data.migration_consent_item', 'GIVE_MIGRATION_CONSENT'),
    ('tenant_data.migration_consent_revocation', 'GIVE_MIGRATION_CONSENT'),
    ('channel_data.pricing_halt', 'RELEASE_CHANNEL_HALT'),
    ('channel_data.channel_distrust', 'RELEASE_CHANNEL_DISTRUST'), ('channel_data.offer_channel_pricing', 'MANAGE_CATALOG'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

-- Реестры параметров и полей слепка (0066, 0070): CHANNEL_DISTRUSTED, контекст channelDistrust, возврат причин остановки витрины
CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ABOVE_MAX_PRICE":["currency","deviationBp","maxMinor","proposedMinor","source"],"ALREADY_AT_TARGET":["currency"],"ALREADY_WINNING_BUYBOX":[],"APPROVED":["ceilingMinor","currency","finalMinor","floorMinor"],"BELOW_MARGIN_FLOOR":["currency","deviationBp","floorMinor","minMarginBp","minMinor","proposedMinor"],"BELOW_MIN_PRICE":["currency","deviationBp","minMinor","proposedMinor","source"],"BOUND_CURRENCY_MISMATCH":["bound","boundBasis","boundCurrency","cause","scopeBasis","scopeCurrency"],"BOUND_UNRESOLVABLE":["bound","boundBasis","boundCurrency","cause","minMarginBp","scopeBasis","scopeCurrency"],"BOUNDS_INVALID":["currency","maxMinor","minMinor"],"BOUNDS_INVERTED":["currency","maxMinor","minMinor"],"BOUNDS_VERSION_CHANGED":["attempt","changed","currency","newMaxMinor","newMinMinor","oldMaxMinor","oldMinMinor"],"BUYBOX_MATCH":["currency"],"BUYBOX_UNDERCUT":["currency"],"CAPPED_AT_MAX_PRICE":["currency","maxMinor"],"CAPPED_AT_MIN_PRICE":["currency","minMinor"],"CHANGE_RATE_LIMIT":["changes","limit"],"CHANNEL_DISTRUSTED":["detectedAt","distrustId","distrustReason","marketplace","stage"],"CHANNEL_HALTED":["haltId","haltReason","haltedAt","marketplace","ruleCode","stage"],"CHANNEL_MASS_SHIFT":["maxSpread","windowMinutes"],"CHANNEL_PRICE_BASIS_MISMATCH":["basisError","currency","marketplace","sentMinor","vatRateBp","writeScopeId"],"COMPETITOR_REQUIREMENT_NOT_MET":["maxStalenessSeconds","requiredCompleteness","requiredN"],"COST_INPUTS_MISSING":["missing"],"COST_NOT_DECLARED":[],"CROSS_CHANNEL_FX_UNAVAILABLE":["cause","channel","currency","expected","marketplace"],"CROSS_CHANNEL_MISMATCH":["currency","field","fxFrom","fxRateDate","fxRateMicros","limit","referenceStorefronts"],"CURRENCY_MISMATCH":["expected","field"],"DISPERSED_MARKET_EVENT":["maxSpread"],"DIVERGENCE_CASE_OPENED":["currency","expectedMinor"],"ENGINE_CURRENCY_MISMATCH":["expected","source"],"FIXED_PRICE":["currency","targetMinor"],"HALT_AUTO_RELEASED":["haltId","sampleSize"],"HALT_MANUALLY_RELEASED":["haltId","membershipId","note"],"HALT_REVIEW_FAILED":["failed","haltId","nextReviewAt","sampleSize"],"HISTORY_AVAILABLE":[],"HISTORY_TOO_SHORT":["minHistoryDays"],"INCONSISTENT_SNAPSHOT":["currency","inconsistency"],"INTENT_EXPIRED":["createdAt","decidedAt","expiresAt","waitedSeconds"],"INTENT_INVALID":["problem"],"INTERNAL_BOUND_VIOLATION":["amountMinor","ceilingMinor","check","currency","floorMinor"],"INTERNAL_OUTLIER_IGNORED":["currency"],"INVALID_AMOUNT":["currency","field"],"INVALID_STRATEGY_PARAMS":["allowed","currency","param","settingBp","settingMinor"],"LOWEST_MATCH":["currency","scope"],"LOWEST_UNDERCUT":["currency","scope"],"MARGIN_TARGET":["currency","marginBp","targetMinor"],"MARGIN_UNATTAINABLE":["currency","feeRateBp","fixedFeeMinor","marginBp","unitCostMinor","vatRateBp"],"MARGIN_WITHOUT_COST":["cause","minMarginBp","requiredBy","strategyType"],"MARKET_SHIFT_DISPERSED":["maxSpread","windowMinutes"],"MARKET_SHIFT_SINGLE_SELLER":["maxSpread","windowMinutes"],"MAX_PRICE_MISSING":[],"MIN_PRICE_MISSING":[],"NO_CHANGE":[],"NO_COMPETITOR_OFFERS":[],"NO_FRESH_CROSS_CHANNEL_REFERENCE":["maxAgeSeconds"],"NO_PLAUSIBILITY_ANCHOR":["costDeclared","minHistoryDays","minOffers"],"NO_PREVIOUS_SNAPSHOT":[],"NO_SCALE_REFERENCE":[],"NO_SCOPE_FOR_PRODUCT":["writeScopeId"],"OUT_OF_ORDER":[],"OUTSIDE_HISTORY_BAND":["bandFactor","currency","field"],"OWN_PRICE_DEVIATION":["currency","field","limit","ourPriceMinor"],"PRICE_ABOVE_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICE_BASIS_MISMATCH":["expected","field"],"PRICE_BELOW_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICING_STOPPED":["channelAccountId","marketplace","scope","stage","stopId","stoppedAt","stoppedBy"],"REFERENCES_CONVERTED_AT_ECB":["currency","fxFrom","fxRateDate","fxRateMicros"],"REFERENCES_WITHOUT_ECB_RATE":[],"SCOPE_NOT_ACTIVE":["action","blockedByErrorCode","blockedSince","mode","status"],"SCOPE_NOT_ENGINE":["mode"],"SELF_OFFER_DIVERGENCE":["currency","limit","ourPriceMinor"],"SHIFT_BELOW_SHARE":["minProducts","share"],"SINGLE_SELLER_MARKET_EVENT":[],"SMALL_MOVE":["minFactor"],"SNAPSHOT_FROM_FUTURE":["maxSkewSeconds"],"SNAPSHOT_INTERNAL_OUTLIER":["currency","outlierFactor"],"SNAPSHOT_TOO_OLD":["maxAgeSeconds"],"STEP_LIMIT":["currency","currentMinor","limitBp","proposedMinor","stepBp"],"STRATEGY_MISSING":[],"TARGET_OUTSIDE_BOUNDS_HOLD":["currency","maxMinor","minMinor"],"TOO_FEW_COMPETITOR_OFFERS":["minOffers"],"UNIT_SCALE_X0_01":["anchor","currency","field"],"UNIT_SCALE_X100":["anchor","currency","field"],"WITHIN_DEADBAND":["currency","deadbandMinor"],"WRITE_BLOCKED_BY_BOUND_RECHECK":["amountMinor","cause","ceilingMinor","currency","floorMinor","marginFloorMinor","minMarginBp","minMinor","violated"],"WRITE_BUDGET_DAY_UNCONFIRMED":["marketplace"],"WRITE_EDIT_BUDGET_EXHAUSTED":["budgetDay","limit","resetsAt","source","timeZone","used"],"WRITE_NOT_ACCEPTED_BY_CHANNEL":["errorClass","status"],"WRITE_OUTCOME_RECONCILED":["result"],"WRITE_PRICING_MODE_CHANGED":["mode"],"WRITE_QUEUED_BEHIND_IN_FLIGHT":["inFlightWriteId"],"WRITE_RETRIES_EXHAUSTED":["attempts","code"],"WRITE_RETRY_SCHEDULED":["at","attempt","code"],"WRITE_SCOPE_BLOCKED":["action","code"],"WRITE_SUPERSEDED_BY_NEWER_VERSION":["newerVersion","newerWriteId"]}'::jsonb
$$;

CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"ABOVE_MAX_PRICE":{"proposedMinor":{"k":"money","n":true},"maxMinor":{"k":"money","n":true},"deviationBp":{"k":"bp"},"source":{"k":"enum","v":["GATE","DATABASE"]},"currency":{"k":"currency"}},"ALREADY_AT_TARGET":{"currency":{"k":"currency"}},"ALREADY_WINNING_BUYBOX":{},"APPROVED":{"finalMinor":{"k":"money"},"floorMinor":{"k":"money"},"ceilingMinor":{"k":"money"},"currency":{"k":"currency"}},"BELOW_MARGIN_FLOOR":{"proposedMinor":{"k":"money"},"floorMinor":{"k":"money"},"minMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"deviationBp":{"k":"bp"},"currency":{"k":"currency"}},"BELOW_MIN_PRICE":{"proposedMinor":{"k":"money","n":true},"minMinor":{"k":"money","n":true},"deviationBp":{"k":"bp"},"source":{"k":"enum","v":["GATE","DATABASE"]},"currency":{"k":"currency"}},"BOUND_CURRENCY_MISMATCH":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"boundCurrency":{"k":"currency","n":true},"boundBasis":{"k":"enum","n":true,"v":["GROSS","NET"]},"scopeCurrency":{"k":"currency"},"scopeBasis":{"k":"enum","v":["GROSS","NET"]}},"BOUND_UNRESOLVABLE":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"boundCurrency":{"k":"currency"},"boundBasis":{"k":"enum","v":["GROSS","NET"]},"scopeCurrency":{"k":"currency"},"scopeBasis":{"k":"enum","v":["GROSS","NET"]},"minMarginBp":{"k":"bp"}},"BOUNDS_INVALID":{"minMinor":{"k":"money","n":true},"maxMinor":{"k":"money","n":true},"currency":{"k":"currency"}},"BOUNDS_INVERTED":{"minMinor":{"k":"money"},"maxMinor":{"k":"money"},"currency":{"k":"currency"}},"BOUNDS_VERSION_CHANGED":{"attempt":{"k":"count"},"changed":{"k":"enumList","v":["MIN_PRICE","MAX_PRICE","CHANNEL_HALT","CHANNEL_DISTRUST","PRICING_STOP"]},"oldMinMinor":{"k":"money","n":true},"newMinMinor":{"k":"money","n":true},"oldMaxMinor":{"k":"money","n":true},"newMaxMinor":{"k":"money","n":true},"currency":{"k":"currency"}},"BUYBOX_MATCH":{"currency":{"k":"currency"}},"BUYBOX_UNDERCUT":{"currency":{"k":"currency"}},"CAPPED_AT_MAX_PRICE":{"maxMinor":{"k":"money"},"currency":{"k":"currency"}},"CAPPED_AT_MIN_PRICE":{"minMinor":{"k":"money"},"currency":{"k":"currency"}},"CHANGE_RATE_LIMIT":{"changes":{"k":"count"},"limit":{"k":"count"}},"CHANNEL_DISTRUSTED":{"stage":{"k":"enum","v":["INPUT","GATE","DISPATCH","DATABASE"]},"distrustId":{"k":"id"},"detectedAt":{"k":"instant"},"distrustReason":{"k":"enum","v":["PRICE_BASIS_MISMATCH"]},"marketplace":{"k":"id","n":true}},"CHANNEL_HALTED":{"stage":{"k":"enum","v":["INPUT","GATE","DISPATCH","DATABASE"]},"haltId":{"k":"id"},"haltedAt":{"k":"instant"},"haltReason":{"k":"enum","v":["CHANNEL_MASS_SHIFT"]},"marketplace":{"k":"id","n":true},"ruleCode":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","POSITION"]}},"CHANNEL_MASS_SHIFT":{"windowMinutes":{"k":"minutes"},"maxSpread":{"k":"ratio"}},"CHANNEL_PRICE_BASIS_MISMATCH":{"basisError":{"k":"enum","v":["TAX_ADDED","TAX_REMOVED"]},"vatRateBp":{"k":"bp"},"sentMinor":{"k":"money"},"currency":{"k":"currency"},"writeScopeId":{"k":"id"},"marketplace":{"k":"id"}},"COMPETITOR_REQUIREMENT_NOT_MET":{"requiredCompleteness":{"k":"enum","n":true,"v":["TOP_N","CHEAPEST_ONLY","FULL"]},"requiredN":{"k":"count","n":true},"maxStalenessSeconds":{"k":"seconds","n":true}},"COST_INPUTS_MISSING":{"missing":{"k":"enum","v":["COST_PROFILE","VAT_RATE"]}},"COST_NOT_DECLARED":{},"CROSS_CHANNEL_FX_UNAVAILABLE":{"channel":{"k":"enum","v":["KAUFLAND","AMAZON","EBAY","OTTO"]},"marketplace":{"k":"id"},"currency":{"k":"currency"},"expected":{"k":"currency"},"cause":{"k":"enum","v":["FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]}},"CROSS_CHANNEL_MISMATCH":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"referenceStorefronts":{"k":"storefrontList"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"},"fxFrom":{"k":"currency"},"currency":{"k":"currency"}},"CURRENCY_MISMATCH":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"expected":{"k":"currency"}},"DISPERSED_MARKET_EVENT":{"maxSpread":{"k":"ratio"}},"DIVERGENCE_CASE_OPENED":{"expectedMinor":{"k":"money"},"currency":{"k":"currency"}},"ENGINE_CURRENCY_MISMATCH":{"source":{"k":"enum","v":["SNAPSHOT","COST"]},"expected":{"k":"currency"}},"FIXED_PRICE":{"targetMinor":{"k":"money"},"currency":{"k":"currency"}},"HALT_AUTO_RELEASED":{"sampleSize":{"k":"count"},"haltId":{"k":"id"}},"HALT_MANUALLY_RELEASED":{"haltId":{"k":"id"},"membershipId":{"k":"id"},"note":{"k":"userText"}},"HALT_REVIEW_FAILED":{"sampleSize":{"k":"count"},"failed":{"k":"count"},"haltId":{"k":"id"},"nextReviewAt":{"k":"instant"}},"HISTORY_AVAILABLE":{},"HISTORY_TOO_SHORT":{"minHistoryDays":{"k":"count"}},"INCONSISTENT_SNAPSHOT":{"inconsistency":{"k":"enum","v":["OFFER_TOTAL_NOT_PRICE_PLUS_SHIPPING","MORE_OFFERS_THAN_TOP_N","BUYBOX_NOT_RANK_ONE_PRICE"]},"currency":{"k":"currency"}},"INTENT_EXPIRED":{"createdAt":{"k":"instant"},"expiresAt":{"k":"instant"},"decidedAt":{"k":"instant"},"waitedSeconds":{"k":"seconds"}},"INTENT_INVALID":{"problem":{"k":"enum","v":["WRITE_SCOPE_MISMATCH","CURRENCY_OR_BASIS_MISMATCH","NON_POSITIVE_AMOUNT"]}},"INTERNAL_BOUND_VIOLATION":{"check":{"k":"enum","v":["CURRENT_WITHIN_BOUNDS","FINAL_RECHECK"]},"amountMinor":{"k":"money","n":true},"floorMinor":{"k":"money"},"ceilingMinor":{"k":"money"},"currency":{"k":"currency"}},"INTERNAL_OUTLIER_IGNORED":{"currency":{"k":"currency"}},"INVALID_AMOUNT":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"currency":{"k":"currency"}},"INVALID_STRATEGY_PARAMS":{"param":{"k":"enum","v":["deadbandMinor","priceMinor","targetMarginBp","undercutMinor"]},"settingMinor":{"k":"money","n":true},"settingBp":{"k":"bp","n":true},"allowed":{"k":"enum","v":["POSITIVE","NON_NEGATIVE","MARGIN_BELOW_100_PERCENT"]},"currency":{"k":"currency"}},"LOWEST_MATCH":{"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]},"currency":{"k":"currency"}},"LOWEST_UNDERCUT":{"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]},"currency":{"k":"currency"}},"MARGIN_TARGET":{"marginBp":{"k":"bp"},"targetMinor":{"k":"money"},"currency":{"k":"currency"}},"MARGIN_UNATTAINABLE":{"marginBp":{"k":"bp"},"feeRateBp":{"k":"bp"},"fixedFeeMinor":{"k":"money"},"unitCostMinor":{"k":"money"},"vatRateBp":{"k":"bp","n":true},"currency":{"k":"currency"}},"MARGIN_WITHOUT_COST":{"strategyType":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST"]},"requiredBy":{"k":"enumList","v":["STRATEGY","MIN_MARGIN"]},"minMarginBp":{"k":"bp","n":true},"cause":{"k":"enum","v":["COST_PROFILE_MISSING","FEE_ESTIMATE_MISSING","VAT_RATE_MISSING","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]}},"MARKET_SHIFT_DISPERSED":{"windowMinutes":{"k":"minutes"},"maxSpread":{"k":"ratio"}},"MARKET_SHIFT_SINGLE_SELLER":{"windowMinutes":{"k":"minutes"},"maxSpread":{"k":"ratio"}},"MAX_PRICE_MISSING":{},"MIN_PRICE_MISSING":{},"NO_CHANGE":{},"NO_COMPETITOR_OFFERS":{},"NO_FRESH_CROSS_CHANNEL_REFERENCE":{"maxAgeSeconds":{"k":"seconds"}},"NO_PLAUSIBILITY_ANCHOR":{"minOffers":{"k":"count"},"minHistoryDays":{"k":"count"},"costDeclared":{"k":"bool"}},"NO_PREVIOUS_SNAPSHOT":{},"NO_SCALE_REFERENCE":{},"NO_SCOPE_FOR_PRODUCT":{"writeScopeId":{"k":"id"}},"OUT_OF_ORDER":{},"OUTSIDE_HISTORY_BAND":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"bandFactor":{"k":"ratio"},"currency":{"k":"currency"}},"OWN_PRICE_DEVIATION":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"ourPriceMinor":{"k":"money"},"limit":{"k":"ratio"},"currency":{"k":"currency"}},"PRICE_ABOVE_COST_ANCHOR":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"costMinor":{"k":"money"},"limit":{"k":"ratio"},"currency":{"k":"currency"}},"PRICE_BASIS_MISMATCH":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"expected":{"k":"enum","v":["GROSS","NET"]}},"PRICE_BELOW_COST_ANCHOR":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"costMinor":{"k":"money"},"limit":{"k":"ratio"},"currency":{"k":"currency"}},"PRICING_STOPPED":{"stopId":{"k":"id"},"scope":{"k":"enum","v":["TENANT","CHANNEL_ACCOUNT","STOREFRONT"]},"stoppedAt":{"k":"instant"},"stoppedBy":{"k":"id"},"channelAccountId":{"k":"id","n":true},"marketplace":{"k":"id","n":true},"stage":{"k":"enum","v":["GATE","DISPATCH","DATABASE"]}},"REFERENCES_CONVERTED_AT_ECB":{"fxFrom":{"k":"currency"},"currency":{"k":"currency"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"}},"REFERENCES_WITHOUT_ECB_RATE":{},"SCOPE_NOT_ACTIVE":{"status":{"k":"enum","v":["ACTIVE","HELD","CONTESTED","BLOCKED","RETIRED"]},"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]},"blockedByErrorCode":{"k":"enum","n":true,"v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"blockedSince":{"k":"instant","n":true},"action":{"k":"enum","n":true,"v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS","DISABLE_CHANNEL_REPRICER","REMOVE_CHANNEL_BOUNDS"]}},"SCOPE_NOT_ENGINE":{"mode":{"k":"enum","n":true,"v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"SELF_OFFER_DIVERGENCE":{"ourPriceMinor":{"k":"money"},"limit":{"k":"ratio"},"currency":{"k":"currency"}},"SHIFT_BELOW_SHARE":{"minProducts":{"k":"count"},"share":{"k":"ratio"}},"SINGLE_SELLER_MARKET_EVENT":{},"SMALL_MOVE":{"minFactor":{"k":"ratio"}},"SNAPSHOT_FROM_FUTURE":{"maxSkewSeconds":{"k":"seconds"}},"SNAPSHOT_INTERNAL_OUTLIER":{"outlierFactor":{"k":"ratio"},"currency":{"k":"currency"}},"SNAPSHOT_TOO_OLD":{"maxAgeSeconds":{"k":"seconds"}},"STEP_LIMIT":{"stepBp":{"k":"bp"},"limitBp":{"k":"bp"},"currentMinor":{"k":"money"},"proposedMinor":{"k":"money"},"currency":{"k":"currency"}},"STRATEGY_MISSING":{},"TARGET_OUTSIDE_BOUNDS_HOLD":{"minMinor":{"k":"money"},"maxMinor":{"k":"money"},"currency":{"k":"currency"}},"TOO_FEW_COMPETITOR_OFFERS":{"minOffers":{"k":"count"}},"UNIT_SCALE_X0_01":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"}},"UNIT_SCALE_X100":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"}},"WITHIN_DEADBAND":{"deadbandMinor":{"k":"money"},"currency":{"k":"currency"}},"WRITE_BLOCKED_BY_BOUND_RECHECK":{"amountMinor":{"k":"money"},"floorMinor":{"k":"money","n":true},"ceilingMinor":{"k":"money","n":true},"violated":{"k":"enum","v":["FLOOR","CEILING","FLOOR_UNRESOLVABLE"]},"currency":{"k":"currency"},"minMinor":{"k":"money"},"marginFloorMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]}},"WRITE_BUDGET_DAY_UNCONFIRMED":{"marketplace":{"k":"id"}},"WRITE_EDIT_BUDGET_EXHAUSTED":{"limit":{"k":"count"},"used":{"k":"count"},"budgetDay":{"k":"date"},"timeZone":{"k":"id","n":true},"resetsAt":{"k":"instant","n":true},"source":{"k":"enum","v":["CHANNEL","DATABASE"]}},"WRITE_NOT_ACCEPTED_BY_CHANNEL":{"status":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"errorClass":{"k":"enum","v":["TRANSIENT","PERMANENT","REQUIRES_HUMAN"]}},"WRITE_OUTCOME_RECONCILED":{"result":{"k":"enum","v":["APPLIED","NOT_APPLIED"]}},"WRITE_PRICING_MODE_CHANGED":{"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"WRITE_QUEUED_BEHIND_IN_FLIGHT":{"inFlightWriteId":{"k":"id"}},"WRITE_RETRIES_EXHAUSTED":{"attempts":{"k":"count"},"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"WRITE_RETRY_SCHEDULED":{"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"attempt":{"k":"count"},"at":{"k":"instant"}},"WRITE_SCOPE_BLOCKED":{"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"action":{"k":"enum","v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS","DISABLE_CHANNEL_REPRICER","REMOVE_CHANNEL_BOUNDS"]}},"WRITE_SUPERSEDED_BY_NEWER_VERSION":{"newerVersion":{"k":"count"},"newerWriteId":{"k":"id"}}}'::jsonb
$$;

CREATE OR REPLACE FUNCTION security.explanation_field_kinds() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"$.format":{"k":"enum","v":["r80.1"]},"$.snapshot.source":{"k":"code"},"$.sanity.checks[].rule":{"k":"enum","v":["CHANNEL_HALTED","STRUCTURE","FRESHNESS","CHANNEL_MASS_SHIFT","UNIT_SCALE","COST_ANCHOR","INTERNAL_ANCHOR","CROSS_CHANNEL_ANCHOR","HISTORY_ANCHOR"]},"$.sanity.checks[].outcome":{"k":"enum","v":["PASS","FAIL","SKIPPED"]},"$.sanity.anchorsUsed":{"k":"codeList"},"$.strategy.intentClass":{"k":"enum","v":["NO_OP"]},"$.strategy.currentMinor":{"k":"money","n":true},"$.strategy.currency":{"k":"currency"},"$.strategy.boundsAtStrategy.minMinor":{"k":"money"},"$.strategy.boundsAtStrategy.maxMinor":{"k":"money"},"$.strategy.boundsAtStrategy.currency":{"k":"currency"},"$.gate.failed.check":{"k":"code"},"$.gate.minMarginBp":{"k":"bp"},"$.gate.fx.source":{"k":"enum","v":["ECB"]},"$.gate.fx.rateDate":{"k":"date"},"$.gate.fx.base":{"k":"enum","v":["EUR"]},"$.gate.fx.quote":{"k":"currency"},"$.gate.fx.rateMicros":{"k":"rateMicros"},"$.gate.fx.from":{"k":"currency"},"$.gate.fx.to":{"k":"currency"},"$.gate.fx.sourceAmountMinor":{"k":"money"},"$.gate.fx.convertedAmountMinor":{"k":"money"},"$.gate.fx.rounding":{"k":"enum","v":["UP","NEAREST"]},"$.context.channelHalt.haltId":{"k":"uuid"},"$.context.channelHalt.reasonCode":{"k":"enum","v":["CHANNEL_MASS_SHIFT"]},"$.context.channelHalt.marketplace":{"k":"id","n":true},"$.context.channelHalt.haltedAt":{"k":"instant"},"$.context.channelDistrust.distrustId":{"k":"uuid"},"$.context.channelDistrust.reasonCode":{"k":"enum","v":["PRICE_BASIS_MISMATCH"]},"$.context.channelDistrust.marketplace":{"k":"id","n":true},"$.context.channelDistrust.detectedAt":{"k":"instant"},"$.context.priceStop.stopId":{"k":"uuid"},"$.context.priceStop.scope":{"k":"enum","v":["TENANT","CHANNEL_ACCOUNT","STOREFRONT"]},"$.context.priceStop.channelAccountId":{"k":"uuid","n":true},"$.context.priceStop.marketplace":{"k":"id","n":true},"$.context.priceStop.stoppedAt":{"k":"instant"},"$.context.priceStop.stoppedByMembershipId":{"k":"uuid"}}'::jsonb
$$;

-- Закрытие тенанта: данные канала шага 23 удаляются вместе с остальными (до аккаунтов канала)
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
    'channel_data.price_decision', 'channel_data.price_intent', 'channel_data.observed_channel_state',
    'channel_data.observed_price_daily', 'channel_data.divergence_case', 'channel_data.competitor_state',
    'channel_data.fee_estimate', 'channel_data.reservation', 'channel_data.sync_job',
    'channel_data.listing_migration_check', 'channel_data.write_submission',
    'channel_data.pricing_halt_review', 'channel_data.pricing_halt', 'channel_data.channel_distrust', 'channel_data.offer_channel_pricing', 'channel_data.competitor_move_latest', 'channel_data.competitor_move', 'channel_data.competitor_price_daily',
    'channel_data.rejected_competitor_snapshot']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  INSERT INTO maintenance.tenant_purge_status (subject_tenant_id, postgres_channel_purged_at)
  VALUES (p_tenant_id, now())
  ON CONFLICT (subject_tenant_id) DO UPDATE SET postgres_channel_purged_at = now();
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('channel_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

-- Форма слепка (0070): контекст решения несёт и недоверие каналу [Р-118]
CREATE OR REPLACE FUNCTION security.explanation_shape() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT '{"$":["format","snapshot","sanity","strategy","gate","context"],"$.snapshot":["source"],"$.sanity":["checks","anchorsUsed","warnings"],"$.sanity.checks[]":["rule","outcome","detail"],"$.strategy":["intentClass","currentMinor","boundsAtStrategy","currency","reason","steps","chain"],"$.strategy.boundsAtStrategy":["minMinor","maxMinor","currency"],"$.gate":["failed","minMarginBp","fx"],"$.gate.failed":["check","detail"],"$.gate.fx":["source","rateDate","base","quote","rateMicros","from","to","sourceAmountMinor","convertedAmountMinor","rounding"],"$.context":["channelHalt","channelDistrust","priceStop"],"$.context.channelHalt":["haltId","reasonCode","marketplace","haltedAt"],"$.context.channelDistrust":["distrustId","reasonCode","marketplace","detectedAt"],"$.context.priceStop":["stopId","scope","channelAccountId","marketplace","stoppedAt","stoppedByMembershipId"],"reasons":["$.sanity.checks[].detail","$.sanity.warnings[]","$.strategy.reason","$.strategy.steps[]","$.strategy.chain[]","$.gate.failed.detail"]}'::jsonb
$$;

COMMIT;
