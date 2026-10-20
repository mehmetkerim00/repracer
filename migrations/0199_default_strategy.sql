-- 0199_default_strategy.sql
-- Шаг 103 [Р-228, ADR-0061]: стратегия по умолчанию для новых предложений аккаунта канала (отзыв клиента).
--
-- 1. Журнал умолчания `tenant_data.default_strategy_change` — только на добавление, до закрытия тенанта: аккаунт и стратегия (NULL —
--    «None — assign manually», поведение до шага). Действующее умолчание — последняя строка аккаунта; второго источника (столбца
--    аккаунта) нет [Р-104]. Задаёт владелец или менеджер (право MANAGE_PRICING) от своего имени, без второго фактора: назначение
--    стратегии — действие внутри забора (Р-225). Умолчанием выбирается только стратегия с активной версией, которой канал даёт данные:
--    та же проверка, что у стража назначения и превью [Р-39, OQ-169].
-- 2. Журнал назначений `tenant_data.strategy_assignment` — только на добавление: КАЖДАЯ смена стратегии у единицы записи цены (вручную —
--    строку пишет триггер единицы) и каждое решение правила умолчания о новом предложении (назначено или «не назначено» с причиной).
--    Строка правила ссылается на строку умолчания, а та — на членство человека: ЛЮБОЕ автоназначение прослеживается до живого человека,
--    задавшего умолчание (решение владельца). Карточка стратегии и квитанция говорят по нему «assigned by default rule».
-- 3. Назначение без человека (исключение из Р-97, решение владельца): функция узкой роли `repracer_default_strategy` в той же
--    транзакции, что заводит новое предложение (`record_discovered_offers`); последняя АКТИВНАЯ версия стратегии на момент обнаружения
--    закрепляется за предложением, как при ручном Assign; режим цены остаётся OFF — умолчание назначает, но не включает. Событие —
--    системой в аудите. Существующие предложения правило не трогает: только единица, созданная в этой транзакции и без стратегии.
-- 4. «Не назначено» с причиной: ценообразование канала у предложения [Р-120], листинг eBay, в который писать нельзя (аукцион, не
--    мигрирован, Р-164), стратегия больше не доступна на канале [Р-39].

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_default_strategy') THEN CREATE ROLE repracer_default_strategy NOLOGIN; END IF;
END $$;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Журнал умолчания аккаунта
CREATE TABLE tenant_data.default_strategy_change (
  tenant_id                  uuid NOT NULL,
  default_strategy_change_id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Порядок строк аккаунта: действующая — последняя (у двух строк одной транзакции время совпадает)
  seq                        bigint GENERATED ALWAYS AS IDENTITY,
  channel_account_id         uuid NOT NULL,
  /** NULL — «None — assign manually»: новички остаются без стратегии, как до шага */
  pricing_strategy_id        uuid,
  /** Автор — участник тенанта, всегда человек: умолчание — его правило */
  created_by_membership_id   uuid NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, default_strategy_change_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id)
);
COMMENT ON TABLE tenant_data.default_strategy_change IS
  'Шаг 103 [Р-228]: стратегия по умолчанию для новых предложений аккаунта канала — кто, когда и какую задал; только на добавление, до закрытия тенанта.';
SELECT security.register_table('tenant_data.default_strategy_change', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.default_strategy_change');
-- Журнал правила — то, к чему прослеживается каждое автоназначение; по времени не удаляется [ADR-0004]
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.default_strategy_change', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Действующее умолчание аккаунта — последняя строка аккаунта (обнаружение, экран Channels)
CREATE INDEX default_strategy_change_account_idx ON tenant_data.default_strategy_change (tenant_id, channel_account_id, seq DESC);

GRANT SELECT, INSERT ON tenant_data.default_strategy_change TO repracer_admin;

/**
 * Кто и что. Автор — членство человека в сессии; аккаунт — подключённый аккаунт тенанта; стратегия — с активной версией, которой канал
 * аккаунта даёт данные (та же проверка, что у стража назначения, OQ-169 и Р-39). Право — общий страж административной записи
 * (MANAGE_PRICING): у владельца и менеджера оно есть, у гостя демо — нет
 */
CREATE FUNCTION tenant_data.default_strategy_change_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  person  uuid;
  acc     record;
  v       record;
  unmet   jsonb;
BEGIN
  SELECT mb.user_id INTO person FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.created_by_membership_id AND mb.status = 'ACTIVE';
  -- Умолчание — правило человека: без человека в сессии и чужим членством не записывается (к нему прослеживается каждое автоназначение)
  IF person IS NULL OR person IS DISTINCT FROM security.current_user_id() THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user: the default strategy is the rule of a person (Р-228)', NEW.created_by_membership_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT a.channel, a.disconnected_at INTO acc FROM tenant_data.channel_account a
   WHERE a.tenant_id = NEW.tenant_id AND a.channel_account_id = NEW.channel_account_id;
  -- Неизвестный аккаунт держит внешний ключ; здесь — отключённый: у него новичков нет, и правило ему не задаётся
  IF acc.disconnected_at IS NOT NULL THEN
    RAISE EXCEPTION 'channel account % is disconnected: no default strategy for it', NEW.channel_account_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.pricing_strategy_id IS NOT NULL THEN
    SELECT ps.version, ps.params || jsonb_build_object('type', ps.type) || jsonb_strip_nulls(jsonb_build_object('anchor', u.anchor, 'competeWith', u.compete_with)) AS params
      INTO v FROM tenant_data.pricing_strategy ps
      LEFT JOIN channel_data.pricing_strategy_undercut u ON u.tenant_id = ps.tenant_id AND u.pricing_strategy_id = ps.pricing_strategy_id AND u.version = ps.version
     WHERE ps.tenant_id = NEW.tenant_id AND ps.pricing_strategy_id = NEW.pricing_strategy_id AND ps.status = 'ACTIVE'
     ORDER BY ps.version DESC LIMIT 1;
    -- OQ-169: умолчанием выбирается только стратегия с активной версией
    IF NOT FOUND THEN
      RAISE EXCEPTION 'strategy % has no active version and cannot be the default (OQ-169)', NEW.pricing_strategy_id USING ERRCODE = 'check_violation';
    END IF;
    unmet := channel_data.strategy_unmet(acc.channel, v.params);
    IF unmet <> '{}'::jsonb THEN
      RAISE EXCEPTION 'strategy % is not available on channel % and cannot be the default: %', NEW.pricing_strategy_id, acc.channel, unmet
        USING ERRCODE = 'check_violation', HINT = 'Р-39';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_default_strategy_change_guard BEFORE INSERT ON tenant_data.default_strategy_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.default_strategy_change_guard();

-- ---------------------------------------------------------------- 2. Журнал назначений стратегии
CREATE TABLE tenant_data.strategy_assignment (
  tenant_id                  uuid NOT NULL,
  strategy_assignment_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Порядок строк единицы: источник её нынешней стратегии — последняя строка
  seq                        bigint GENERATED ALWAYS AS IDENTITY,
  channel_account_id         uuid NOT NULL,
  /** Единица записи цены; у листинга eBay, в который писать нельзя, её нет — тогда предложение */
  write_scope_id             uuid,
  offer_mapping_id           uuid,
  pricing_strategy_id        uuid,
  pricing_strategy_version   int,
  /** ASSIGNED — назначена; UNASSIGNED — снята человеком; NOT_ASSIGNED — правило умолчания не назначило, с причиной */
  outcome                    text NOT NULL,
  /** PERSON — человек (Assign, импорт, снятие); DEFAULT_RULE — правило умолчания аккаунта */
  source                     text NOT NULL,
  reason                     text,
  /** Строка умолчания, по которой действовало правило: через неё — человек, задавший умолчание */
  default_strategy_change_id uuid,
  /** Человек ручного назначения (если сессия его назвала) */
  created_by_membership_id   uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, strategy_assignment_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, offer_mapping_id) REFERENCES tenant_data.offer_mapping (tenant_id, offer_mapping_id),
  -- Строку умолчания внешний ключ не держит намеренно: её существование, аккаунт и то, что она действующая, проверяет страж журнала, а
  -- ключ к журналу умолчания перехватывал бы отказ TRUNCATE его собственного стража (Р-99)
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  -- Форма строки одним ограничением: правило умолчания — всегда со строкой умолчания и без человека; назначено — со стратегией и версией;
  -- снято — только человеком; «не назначено» — только правилом и с известной причиной
  CONSTRAINT strategy_assignment_shape CHECK (
    (source = 'DEFAULT_RULE') = (default_strategy_change_id IS NOT NULL)
    AND (source = 'PERSON' OR created_by_membership_id IS NULL)
    AND CASE outcome
      WHEN 'ASSIGNED' THEN write_scope_id IS NOT NULL AND pricing_strategy_id IS NOT NULL AND pricing_strategy_version IS NOT NULL AND reason IS NULL
      WHEN 'UNASSIGNED' THEN source = 'PERSON' AND write_scope_id IS NOT NULL AND pricing_strategy_id IS NULL AND pricing_strategy_version IS NULL AND reason IS NULL
      WHEN 'NOT_ASSIGNED' THEN source = 'DEFAULT_RULE' AND pricing_strategy_id IS NULL AND pricing_strategy_version IS NULL
                               AND reason IN ('CHANNEL_PRICING', 'NOT_WRITABLE', 'STRATEGY_UNAVAILABLE')
                               AND (write_scope_id IS NOT NULL OR offer_mapping_id IS NOT NULL)
      ELSE false END)
);
COMMENT ON TABLE tenant_data.strategy_assignment IS
  'Шаг 103 [Р-228]: каждая смена стратегии единицы записи цены и каждое решение правила умолчания о новом предложении; только на добавление, до закрытия тенанта.';
SELECT security.register_table('tenant_data.strategy_assignment', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.strategy_assignment');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.strategy_assignment', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Источник нынешней стратегии единицы — её последняя строка (экраны, квитанция, журнал единицы)
CREATE INDEX strategy_assignment_scope_idx ON tenant_data.strategy_assignment (tenant_id, write_scope_id, seq DESC);
-- Решения правила по аккаунту — счётчики «назначено / не назначено» на карточке аккаунта
CREATE INDEX strategy_assignment_rule_idx ON tenant_data.strategy_assignment (tenant_id, default_strategy_change_id) WHERE default_strategy_change_id IS NOT NULL;

-- Читают экраны (административный сервис); пишут только триггер единицы и функция правила — правами узкой роли: вставки, которую
-- регистрация таблицы выдаёт административному сервису, у журнала назначений нет (иначе «правило умолчания» написал бы кто угодно)
REVOKE INSERT ON tenant_data.strategy_assignment FROM repracer_admin;
GRANT SELECT ON tenant_data.strategy_assignment TO repracer_admin;

/**
 * Правило умолчания пишет только то, что из него следует: строка умолчания — ДЕЙСТВУЮЩАЯ для аккаунта и не «None»; назначенная
 * стратегия — стратегия умолчания, версия — последняя активная; предложение — новое (создано этой транзакцией) и того же аккаунта.
 * Так строка правила всегда ведёт к человеку, задавшему ИМЕННО это правило, и к предложению, которое правило вправе тронуть (Р-228, C)
 */
CREATE FUNCTION tenant_data.strategy_assignment_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  d      record;
  latest int;
BEGIN
  IF NEW.source = 'DEFAULT_RULE' THEN
    SELECT c.channel_account_id, c.pricing_strategy_id INTO d FROM tenant_data.default_strategy_change c
     WHERE c.tenant_id = NEW.tenant_id AND c.default_strategy_change_id = NEW.default_strategy_change_id;
    -- Строка умолчания этого аккаунта и не «None»
    IF d.channel_account_id IS DISTINCT FROM NEW.channel_account_id OR d.pricing_strategy_id IS NULL THEN
      RAISE EXCEPTION 'default rule % is not the current default strategy of channel account % (Р-228)', NEW.default_strategy_change_id, NEW.channel_account_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- И действующая: более поздней строки у аккаунта нет
    IF EXISTS (SELECT 1 FROM tenant_data.default_strategy_change n
                WHERE n.tenant_id = NEW.tenant_id AND n.channel_account_id = NEW.channel_account_id
                  AND n.seq > (SELECT c.seq FROM tenant_data.default_strategy_change c
                                WHERE c.tenant_id = NEW.tenant_id AND c.default_strategy_change_id = NEW.default_strategy_change_id)) THEN
      RAISE EXCEPTION 'default rule % is not the current default strategy of channel account % (Р-228)', NEW.default_strategy_change_id, NEW.channel_account_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.outcome = 'ASSIGNED' THEN
      SELECT max(ps.version) INTO latest FROM tenant_data.pricing_strategy ps
       WHERE ps.tenant_id = NEW.tenant_id AND ps.pricing_strategy_id = d.pricing_strategy_id AND ps.status = 'ACTIVE';
      IF NEW.pricing_strategy_id IS DISTINCT FROM d.pricing_strategy_id OR NEW.pricing_strategy_version IS DISTINCT FROM latest THEN
        RAISE EXCEPTION 'assignment of strategy % version % does not follow default rule % (latest active version %)', NEW.pricing_strategy_id,
          NEW.pricing_strategy_version, NEW.default_strategy_change_id, latest USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    -- Только новое предложение своего аккаунта: созданное этой транзакцией (существующие правило не трогает, решение C)
    IF NEW.write_scope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tenant_data.write_scope s
        WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id AND s.channel_account_id = NEW.channel_account_id AND s.created_at = now()) THEN
      RAISE EXCEPTION 'write_scope % is not a new offer of channel account %: the default rule acts on new offers only (Р-228)', NEW.write_scope_id, NEW.channel_account_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.write_scope_id IS NULL AND NOT EXISTS (SELECT 1 FROM tenant_data.offer_mapping m
        WHERE m.tenant_id = NEW.tenant_id AND m.offer_mapping_id = NEW.offer_mapping_id AND m.channel_account_id = NEW.channel_account_id AND m.created_at = now()) THEN
      RAISE EXCEPTION 'offer % is not a new offer of channel account %: the default rule acts on new offers only (Р-228)', NEW.offer_mapping_id, NEW.channel_account_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_strategy_assignment_guard BEFORE INSERT ON tenant_data.strategy_assignment
  FOR EACH ROW EXECUTE FUNCTION tenant_data.strategy_assignment_guard();

RESET ROLE;

-- Страж и аудит административной записи [Р-97, Р-100]: умолчание задаёт человек, событием в аудите
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.default_strategy_change
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.default_strategy_change
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Решение правила умолчания — событие СИСТЕМЫ в аудите (как окончание распродажи по дате, 0197): со строкой умолчания, через которую
-- оно ведёт к человеку
CREATE FUNCTION tenant_data.strategy_assigned_by_default_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  -- Условие — в теле, а не в WHEN триггера: список допустимых условий WHEN держит проверка схемы (шаг 19)
  IF NEW.source <> 'DEFAULT_RULE' THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'SYSTEM', 'pricing.strategy_assigned_by_default',
          CASE WHEN NEW.write_scope_id IS NOT NULL THEN 'write_scope' ELSE 'offer_mapping' END, coalesce(NEW.write_scope_id, NEW.offer_mapping_id),
          jsonb_strip_nulls(jsonb_build_object('defaultStrategyChangeId', NEW.default_strategy_change_id, 'outcome', NEW.outcome, 'reason', NEW.reason,
            'strategyId', NEW.pricing_strategy_id, 'version', NEW.pricing_strategy_version, 'at', now())));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.strategy_assigned_by_default_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION tenant_data.strategy_assigned_by_default_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.strategy_assigned_by_default_audit() TO repracer_owner;

SET ROLE repracer_owner;
CREATE TRIGGER zb_strategy_assigned_by_default_audit AFTER INSERT ON tenant_data.strategy_assignment
  FOR EACH ROW EXECUTE FUNCTION tenant_data.strategy_assigned_by_default_audit();
RESET ROLE;

-- Р-100: умолчание задаёт тот, кто вправе назначать стратегии (владелец и менеджер), — тем же правом, что границы и стратегии
DO $do$
DECLARE
  d text := pg_get_functiondef('security.admin_write_action(text)'::regprocedure);
  a text := $s$('tenant_data.clearance_change', 'MANAGE_PRICING'),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0199: security.admin_write_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 103 [Р-228]: стратегия по умолчанию аккаунта — тем же правом, что назначение стратегий
    ('tenant_data.default_strategy_change', 'MANAGE_PRICING'),$s$);
END $do$;

-- Закрытие тенанта уносит журналы РАНЬШЕ единиц записи, предложений, аккаунтов и членств, на которые они ссылаются (правило 0102);
-- назначения — раньше умолчаний, на которые ссылаются
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.clearance_change', 'tenant_data.channel_write_mode_change',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0199: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.strategy_assignment', 'tenant_data.default_strategy_change', 'tenant_data.clearance_change', 'tenant_data.channel_write_mode_change',$s$);
END $do$;

-- ---------------------------------------------------------------- 3. Узкая роль: журнал назначений и правило умолчания
GRANT USAGE ON SCHEMA tenant_data, channel_data, security, platform TO repracer_default_strategy;
-- Доступность стратегии на канале читает справочник источников конкурентов (strategy_unmet) — правами вызывающей роли
GRANT SELECT ON platform.competitor_source TO repracer_default_strategy;
GRANT EXECUTE ON FUNCTION security.platform_tenant_id() TO repracer_default_strategy;
-- Без своей политики роль видела бы ноль источников, и правило называло бы любую конкурентную стратегию «недоступной» (найдено тестом E3)
CREATE POLICY competitor_source_default_strategy_read ON platform.competitor_source FOR SELECT TO repracer_default_strategy
  USING (tenant_id = security.platform_tenant_id());
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_default_strategy;
GRANT EXECUTE ON FUNCTION security.current_user_id() TO repracer_default_strategy;
GRANT EXECUTE ON FUNCTION channel_data.strategy_unmet(text, jsonb) TO repracer_default_strategy, repracer_admin;
GRANT EXECUTE ON FUNCTION channel_data.offer_channel_pricing_active(uuid, uuid) TO repracer_default_strategy;
GRANT SELECT, INSERT ON tenant_data.strategy_assignment TO repracer_default_strategy;
GRANT SELECT ON tenant_data.default_strategy_change TO repracer_default_strategy;
GRANT SELECT ON tenant_data.pricing_strategy, channel_data.pricing_strategy_undercut TO repracer_default_strategy;
GRANT SELECT (tenant_id, channel_account_id, channel, disconnected_at) ON tenant_data.channel_account TO repracer_default_strategy;
GRANT SELECT (tenant_id, membership_id, user_id, status) ON tenant_data.membership TO repracer_default_strategy;
GRANT SELECT (tenant_id, offer_mapping_id, channel_account_id, marketplace, external_sku, price_write_scope_id, created_at) ON tenant_data.offer_mapping TO repracer_default_strategy;
GRANT SELECT ON channel_data.offer_channel_pricing TO repracer_default_strategy;
-- Назначение: только два столбца стратегии единицы (режим цены роль не трогает — умолчание не включает движок)
GRANT SELECT ON tenant_data.write_scope TO repracer_default_strategy;
GRANT UPDATE (pricing_strategy_id, pricing_strategy_version) ON tenant_data.write_scope TO repracer_default_strategy;
CREATE POLICY default_strategy_assignment_rw ON tenant_data.strategy_assignment FOR ALL TO repracer_default_strategy
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_change_read ON tenant_data.default_strategy_change FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_strategy_read ON tenant_data.pricing_strategy FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_undercut_read ON channel_data.pricing_strategy_undercut FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_account_read ON tenant_data.channel_account FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_membership_read ON tenant_data.membership FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_mapping_read ON tenant_data.offer_mapping FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_channel_pricing_read ON channel_data.offer_channel_pricing FOR SELECT TO repracer_default_strategy USING (tenant_id = security.current_tenant_id());
CREATE POLICY default_strategy_scope_rw ON tenant_data.write_scope FOR ALL TO repracer_default_strategy
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());

/**
 * Журнал ручных назначений: каждая смена стратегии единицы записи цены — строкой PERSON с членством человека сессии (если сессия его
 * назвала). Строку правила умолчания пишет само правило ДО назначения — тогда здесь строки нет (одна строка на назначение)
 */
CREATE FUNCTION tenant_data.write_scope_strategy_journal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.field <> 'PRICE' THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.pricing_strategy_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.pricing_strategy_id IS NOT DISTINCT FROM OLD.pricing_strategy_id
     AND NEW.pricing_strategy_version IS NOT DISTINCT FROM OLD.pricing_strategy_version THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.strategy_assignment a
              WHERE a.tenant_id = NEW.tenant_id AND a.write_scope_id = NEW.write_scope_id AND a.source = 'DEFAULT_RULE' AND a.outcome = 'ASSIGNED'
                AND a.pricing_strategy_id = NEW.pricing_strategy_id AND a.pricing_strategy_version = NEW.pricing_strategy_version AND a.created_at = now()) THEN
    RETURN NULL;
  END IF;
  INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, write_scope_id, pricing_strategy_id, pricing_strategy_version, outcome, source,
                                               created_by_membership_id)
  VALUES (NEW.tenant_id, NEW.channel_account_id, NEW.write_scope_id, NEW.pricing_strategy_id, NEW.pricing_strategy_version,
          CASE WHEN NEW.pricing_strategy_id IS NULL THEN 'UNASSIGNED' ELSE 'ASSIGNED' END, 'PERSON',
          (SELECT mb.membership_id FROM tenant_data.membership mb
            WHERE mb.tenant_id = NEW.tenant_id AND mb.user_id = security.current_user_id() AND mb.status = 'ACTIVE' LIMIT 1));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.write_scope_strategy_journal() OWNER TO repracer_default_strategy;
REVOKE EXECUTE ON FUNCTION tenant_data.write_scope_strategy_journal() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.write_scope_strategy_journal() TO repracer_owner;

SET ROLE repracer_owner;
CREATE TRIGGER zc_write_scope_strategy_journal AFTER INSERT OR UPDATE OF pricing_strategy_id, pricing_strategy_version ON tenant_data.write_scope
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_strategy_journal();
RESET ROLE;

/**
 * Правило умолчания для НОВОГО предложения (зовёт обнаружение в той же транзакции). Нет умолчания или «None» — ничего (поведение до
 * шага). Иначе — строка журнала ДО назначения и назначение последней активной версии; «не назначено» с причиной: листинг eBay, в который
 * писать нельзя; стратегия больше не доступна на канале; ценообразование канала у предложения [Р-120]. Режим цены не трогается
 */
CREATE FUNCTION tenant_data.apply_default_strategy(p_tenant_id uuid, p_channel_account_id uuid, p_write_scope_id uuid, p_offer_mapping_id uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  d       record;
  v       record;
  channel text;
  reason  text;
BEGIN
  SELECT c.default_strategy_change_id, c.pricing_strategy_id INTO d FROM tenant_data.default_strategy_change c
   WHERE c.tenant_id = p_tenant_id AND c.channel_account_id = p_channel_account_id ORDER BY c.seq DESC LIMIT 1;
  IF NOT FOUND OR d.pricing_strategy_id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_write_scope_id IS NULL THEN
    reason := 'NOT_WRITABLE';
  ELSE
    SELECT a.channel INTO channel FROM tenant_data.channel_account a WHERE a.tenant_id = p_tenant_id AND a.channel_account_id = p_channel_account_id;
    SELECT ps.version, ps.params || jsonb_build_object('type', ps.type) || jsonb_strip_nulls(jsonb_build_object('anchor', u.anchor, 'competeWith', u.compete_with)) AS params
      INTO v FROM tenant_data.pricing_strategy ps
      LEFT JOIN channel_data.pricing_strategy_undercut u ON u.tenant_id = ps.tenant_id AND u.pricing_strategy_id = ps.pricing_strategy_id AND u.version = ps.version
     WHERE ps.tenant_id = p_tenant_id AND ps.pricing_strategy_id = d.pricing_strategy_id AND ps.status = 'ACTIVE'
     ORDER BY ps.version DESC LIMIT 1;
    IF NOT FOUND OR channel_data.strategy_unmet(channel, v.params) <> '{}'::jsonb THEN
      reason := 'STRATEGY_UNAVAILABLE';
    ELSIF channel_data.offer_channel_pricing_active(p_tenant_id, p_write_scope_id) IS NOT NULL THEN
      reason := 'CHANNEL_PRICING';
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, write_scope_id, offer_mapping_id, outcome, source, reason, default_strategy_change_id)
    VALUES (p_tenant_id, p_channel_account_id, p_write_scope_id, p_offer_mapping_id, 'NOT_ASSIGNED', 'DEFAULT_RULE', reason, d.default_strategy_change_id);
    RETURN 'NOT_ASSIGNED';
  END IF;
  INSERT INTO tenant_data.strategy_assignment (tenant_id, channel_account_id, write_scope_id, offer_mapping_id, pricing_strategy_id, pricing_strategy_version,
                                               outcome, source, default_strategy_change_id)
  VALUES (p_tenant_id, p_channel_account_id, p_write_scope_id, p_offer_mapping_id, d.pricing_strategy_id, v.version, 'ASSIGNED', 'DEFAULT_RULE', d.default_strategy_change_id);
  -- Новизну единицы держит страж журнала (строка выше не записалась бы для существующей); режим цены не трогается — движок не включается
  UPDATE tenant_data.write_scope s SET pricing_strategy_id = d.pricing_strategy_id, pricing_strategy_version = v.version
   WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id;
  RETURN 'ASSIGNED';
END $fn$;
ALTER FUNCTION tenant_data.apply_default_strategy(uuid, uuid, uuid, uuid) OWNER TO repracer_default_strategy;
REVOKE EXECUTE ON FUNCTION tenant_data.apply_default_strategy(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.apply_default_strategy(uuid, uuid, uuid, uuid) TO repracer_catalog;

-- ---------------------------------------------------------------- 4. Обнаружение зовёт правило для каждого нового предложения
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.record_discovered_offers(uuid,uuid,jsonb)'::regprocedure);
  a1 text := $s$  v_ebay text;
BEGIN$s$;
  a2 text := $s$              CASE v_ebay WHEN 'INELIGIBLE' THEN 'INELIGIBLE' ELSE 'MIGRATION_REQUIRED' END, o.listing_format, v_ebay);
      created := created + 1;
      CONTINUE;$s$;
  a3 text := $s$    IF scope IS NULL THEN
      /**$s$;
  a4 text := $s$            o.external_listing_id, CASE WHEN acc.channel = 'EBAY' THEN o.listing_format END, v_ebay);
    created := created + 1;
  END LOOP;$s$;
  n integer;
BEGIN
  SELECT (length(d) - length(replace(d, a1, ''))) / length(a1) + (length(d) - length(replace(d, a2, ''))) / length(a2)
       + (length(d) - length(replace(d, a3, ''))) / length(a3) + (length(d) - length(replace(d, a4, ''))) / length(a4) INTO n;
  IF n <> 4 THEN
    RAISE EXCEPTION '0199: tenant_data.record_discovered_offers() is not the definition the migration expects (%)', n;
  END IF;
  EXECUTE replace(replace(replace(replace(d,
    a1, $s$  v_ebay text;
  -- Шаг 103 [Р-228]: предложение, созданное этим вызовом, — новичок; правило умолчания аккаунта решает о нём в этой же транзакции
  v_mapping uuid;
  v_new_scope boolean;
BEGIN$s$),
    a2, $s$              CASE v_ebay WHEN 'INELIGIBLE' THEN 'INELIGIBLE' ELSE 'MIGRATION_REQUIRED' END, o.listing_format, v_ebay)
      RETURNING offer_mapping_id INTO v_mapping;
      -- Листинг eBay, в который писать нельзя, — «не назначено» правилом умолчания, если оно задано (Р-164)
      PERFORM tenant_data.apply_default_strategy(p_tenant_id, p_channel_account_id, NULL, v_mapping);
      created := created + 1;
      CONTINUE;$s$),
    a3, $s$    v_new_scope := scope IS NULL;
    IF scope IS NULL THEN
      /**$s$),
    a4, $s$            o.external_listing_id, CASE WHEN acc.channel = 'EBAY' THEN o.listing_format END, v_ebay)
    RETURNING offer_mapping_id INTO v_mapping;
    -- Новая единица записи — стратегия по умолчанию аккаунта (существующая единица с заново заведённым предложением — нет)
    IF v_new_scope THEN
      PERFORM tenant_data.apply_default_strategy(p_tenant_id, p_channel_account_id, scope, v_mapping);
    END IF;
    created := created + 1;
  END LOOP;$s$);
END $do$;
ALTER FUNCTION tenant_data.record_discovered_offers(uuid, uuid, jsonb) OWNER TO repracer_catalog;

COMMIT;
