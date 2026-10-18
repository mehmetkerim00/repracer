-- 0197_clearance_floor.sql
-- Шаг 102 [Р-227, ADR-0060]: режим распродажи — осознанная продажа ниже безубыточности. «Мы запрещаем СЛУЧАЙНЫЙ убыток; намеренный —
-- разрешён через явный режим».
--
-- 1. Журнал режима `tenant_data.clearance_change` — только на добавление, живёт до закрытия тенанта: включение (пол распродажи, записка,
--    подтверждение «каждая продажа ниже безубыточности — убыток», второй фактор, необязательная дата окончания), выключение одним действием
--    и окончание по дате. Включает владелец или менеджер (право MANAGE_PRICING) от своего имени и со вторым фактором — это «движение забора»
--    (Р-225), исключение из Р-144: правка одного предложения второго фактора не требует, а режим распродажи требует. Выключение — без него:
--    пол поднимается, это безопасное направление (как возврат в тень, Р-170). Всё — в аудит: включение и выключение — событием человека
--    (общий аудит административной записи), окончание по дате — событием системы.
-- 2. Пол [Р-83, Р-5 с исключением]: в режиме распродажи действующий пол — пол распродажи, он заменяет min_price и пол маржи (решение
--    владельца); min_price хранится нетронутым и возвращается при выключении. Вне режима безубыточность (маржа 0 %) ВСЕГДА входит в пол:
--    пол = max(min_price, пол маржи, безубыточность), если себестоимость объявлена; без себестоимости — как прежде (Р-131).
--    Безубыточность считается тем же расчётом, что пол маржи, — с минимальной маржой 0: без комиссии, курса или НДС пол не вычисляется
--    (fail-closed), как и пол маржи.
-- 3. Решение называет строку включения (`price_decision.clearance_change_id`), его пол база сверяет с действующим полом распродажи.
-- 4. Конец распродажи (выключение или дата) — запрос базы на переоценку `CLEARANCE_ENDED`: первый же пересчёт начинает подъём к полу
--    лестницей [Р-208, Р-212] и цену не опускает. Окончание по дате пишет функция узкой роли, которую зовёт пересчёт по расписанию.
-- 5. Удержания пола распродажи помечены (`floor_hold.clearance`) и в «без пола вы продали бы на $X дешевле» не входят [Р-117].
-- 6. Реестры параметров слепка — дополняются значением прежних (две причины движка, граница «распродажа» и «безубыточность», повод
--    «конец распродажи», нижняя граница распродажи у отказа Gate, изменение контекста «распродажа»).

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'repracer_clearance_expiry') THEN CREATE ROLE repracer_clearance_expiry NOLOGIN; END IF;
END $$;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Журнал режима распродажи
CREATE TABLE tenant_data.clearance_change (
  tenant_id                uuid NOT NULL,
  clearance_change_id      uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Порядок строк одной единицы: действующая — последняя по нему (время транзакции у двух строк одной транзакции совпадает)
  seq                      bigint GENERATED ALWAYS AS IDENTITY,
  write_scope_id           uuid NOT NULL,
  action                   text NOT NULL,
  /** Только у включения: абсолютный пол распродажи в валюте единицы записи */
  floor_minor              bigint,
  currency                 text,
  /** Необязательная дата окончания: после неё пол — расчётный, база пишет строку EXPIRE */
  ends_at                  timestamptz,
  /** Записка «зачем»: у включения обязательна, у выключения — по желанию */
  note                     text,
  /** «I understand: every sale below break-even loses money» — у включения обязательно */
  acknowledged             boolean NOT NULL DEFAULT false,
  /** Автор — участник тенанта; у окончания по дате автора нет (система) */
  created_by_membership_id uuid,
  /** Ставит страж: включение без второго фактора не записывается */
  mfa                      boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, clearance_change_id),
  FOREIGN KEY (tenant_id, write_scope_id) REFERENCES tenant_data.write_scope (tenant_id, write_scope_id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT clearance_change_action_known CHECK (action IN ('ENABLE', 'DISABLE', 'EXPIRE'))
);
COMMENT ON TABLE tenant_data.clearance_change IS
  'Шаг 102 [Р-227]: режим распродажи единицы записи цены — включение, выключение и окончание по дате; только на добавление, до закрытия тенанта.';
SELECT security.register_table('tenant_data.clearance_change', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.clearance_change');
-- Данные тенанта по времени не удаляются [ADR-0004]: журнал режима — доказательство намеренного убытка, живёт до закрытия тенанта
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.clearance_change', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Действующий режим единицы — последняя строка единицы (пол перед каждой отправкой, контекст решения, экран пола и история режима)
CREATE INDEX clearance_change_scope_idx ON tenant_data.clearance_change (tenant_id, write_scope_id, seq DESC);

-- Пишет административный сервис именем человека; читают путь решения и диспетчер (пол перед каждой отправкой считается их правами, Р-83)
GRANT SELECT, INSERT ON tenant_data.clearance_change TO repracer_admin;
GRANT SELECT ON tenant_data.clearance_change TO repracer_app;

/**
 * Действующий режим распродажи единицы на момент: последняя строка единицы — включение, и его дата окончания ещё не наступила. Время строки
 * не сравнивается с моментом: режим — состояние журнала сейчас, момент нужен только для даты окончания (миры с виртуальными часами видят
 * тот же режим, что база перед отправкой)
 */
CREATE FUNCTION tenant_data.active_clearance(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamptz)
  RETURNS TABLE (clearance_change_id uuid, floor_minor bigint, currency text, ends_at timestamptz, note text, created_at timestamptz,
                 created_by_membership_id uuid)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT c.clearance_change_id, c.floor_minor, c.currency, c.ends_at, c.note, c.created_at, c.created_by_membership_id
    FROM (SELECT x.* FROM tenant_data.clearance_change x
           WHERE x.tenant_id = p_tenant_id AND x.write_scope_id = p_write_scope_id
           ORDER BY x.seq DESC LIMIT 1) c
   WHERE c.action = 'ENABLE' AND (c.ends_at IS NULL OR c.ends_at > p_at)
$fn$;

/**
 * Кто и как. Включение — от своего имени, со вторым фактором, с подтверждением и запиской; пол распродажи положителен и не выше
 * действующего потолка, в валюте единицы цены, дата окончания — в будущем. Выключение — только действующего режима. Окончание по дате —
 * только режима, чья дата наступила. Роль проверяет общий страж административной записи (право MANAGE_PRICING): у владельца и менеджера
 * оно есть, у гостя демо — нет
 */
CREATE FUNCTION tenant_data.clearance_change_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  m      record;
  ws     record;
  active record;
  ceiling bigint;
BEGIN
  IF NEW.action IN ('ENABLE', 'DISABLE') THEN
    SELECT mb.user_id INTO m FROM tenant_data.membership mb
     WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.created_by_membership_id AND mb.status = 'ACTIVE';
    -- «Человек в сессии есть» проверяет общий страж административной записи; здесь — только что членство принадлежит ТОМУ человеку
    IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
      RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.created_by_membership_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  SELECT * INTO active FROM tenant_data.active_clearance(NEW.tenant_id, NEW.write_scope_id, now());

  IF NEW.action = 'ENABLE' THEN
    IF NOT NEW.acknowledged THEN
      RAISE EXCEPTION 'clearance needs the acknowledgement that every sale below break-even loses money (Р-227)'
        USING ERRCODE = 'check_violation';
    END IF;
    IF btrim(coalesce(NEW.note, '')) = '' THEN
      RAISE EXCEPTION 'a note is required to enable clearance: why the offer is sold at a loss (Р-227)' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'enabling clearance moves the floor and requires a second factor (Р-227, Р-225)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT s.currency, s.field INTO ws FROM tenant_data.write_scope s WHERE s.tenant_id = NEW.tenant_id AND s.write_scope_id = NEW.write_scope_id;
    IF ws.field IS DISTINCT FROM 'PRICE' OR NEW.currency IS DISTINCT FROM ws.currency THEN
      RAISE EXCEPTION 'the clearance floor is in % but the offer is priced in % (Р-71)', NEW.currency, ws.currency USING ERRCODE = 'check_violation';
    END IF;
    ceiling := tenant_data.effective_max_price(NEW.tenant_id, NEW.write_scope_id);
    IF NEW.floor_minor IS NULL OR NEW.floor_minor <= 0 OR ceiling IS NULL OR NEW.floor_minor > ceiling THEN
      RAISE EXCEPTION 'the clearance floor % must be positive and not above the max price % (Р-227, Р-43)', NEW.floor_minor, ceiling
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ends_at IS NOT NULL AND NEW.ends_at <= now() THEN
      RAISE EXCEPTION 'the end of clearance % is not in the future', NEW.ends_at USING ERRCODE = 'check_violation';
    END IF;
    NEW.mfa := true;
  ELSIF NEW.action = 'DISABLE' THEN
    IF active.clearance_change_id IS NULL THEN
      RAISE EXCEPTION 'clearance of write_scope % is not active', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.action = 'EXPIRE' THEN
    -- Окончание по дате — правда о дате: у действующего режима без наступившей даты его не записать
    IF NOT EXISTS (SELECT 1 FROM tenant_data.active_clearance(NEW.tenant_id, NEW.write_scope_id, '-infinity'::timestamptz) c
                    WHERE c.ends_at <= now()) THEN
      RAISE EXCEPTION 'clearance of write_scope % has not ended by its date', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_clearance_change_guard BEFORE INSERT ON tenant_data.clearance_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.clearance_change_guard();

RESET ROLE;

-- Страж и аудит административной записи [Р-97, Р-100]: включение и выключение — действие человека, событием в аудите
CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.clearance_change
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zz_admin_write_audit_insert AFTER INSERT ON tenant_data.clearance_change
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();

-- Окончание по дате — событие системы в аудите (как перевод аккаунта в REVOKED, 0138)
CREATE FUNCTION tenant_data.clearance_expired_audit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
BEGIN
  -- Условие — в теле, а не в WHEN триггера: список допустимых условий WHEN держит проверка схемы (шаг 19)
  IF NEW.action <> 'EXPIRE' THEN
    RETURN NULL;
  END IF;
  INSERT INTO audit.audit_event (tenant_id, occurred_at, actor_type, action, entity_type, entity_id, changes)
  VALUES (NEW.tenant_id, now(), 'SYSTEM', 'pricing.clearance_expired', 'write_scope', NEW.write_scope_id,
          jsonb_build_object('clearanceChangeId', NEW.clearance_change_id, 'at', now()));
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.clearance_expired_audit() OWNER TO repracer_audit_writer;
REVOKE EXECUTE ON FUNCTION tenant_data.clearance_expired_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.clearance_expired_audit() TO repracer_owner;

SET ROLE repracer_owner;
CREATE TRIGGER zb_clearance_expired_audit AFTER INSERT ON tenant_data.clearance_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.clearance_expired_audit();
RESET ROLE;

-- Р-100: режим распродажи включает тот, кто вправе править цены (владелец и менеджер), — как границы и гардрейл
DO $do$
DECLARE
  d text := pg_get_functiondef('security.admin_write_action(text)'::regprocedure);
  a text := $s$('tenant_data.cost_import', 'MANAGE_PRICING'),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: security.admin_write_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
    -- Шаг 102 [Р-227]: режим распродажи — движение забора тем же правом, что границы
    ('tenant_data.clearance_change', 'MANAGE_PRICING'),$s$);
END $do$;

-- Р-96: пол перед каждой отправкой [Р-83] считается правами пути решения и диспетчера — режим распродажи для них вход пола
DO $do$
DECLARE
  d text := pg_get_functiondef('security.decision_path_allowed_privileges()'::regprocedure);
  a text := $s$('tenant_data.guardrail', 'SELECT', NULL),$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: security.decision_path_allowed_privileges() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$ ('tenant_data.clearance_change', 'SELECT', NULL),$s$);
END $do$;

-- Закрытие тенанта уносит журнал режима РАНЬШЕ единиц записи и членств, на которые он ссылается (правило 0102)
DO $do$
DECLARE
  d text := pg_get_functiondef('maintenance.purge_tenant_data(uuid)'::regprocedure);
  a text := $s$'tenant_data.channel_write_mode_change',$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: maintenance.purge_tenant_data(uuid) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$'tenant_data.clearance_change', 'tenant_data.channel_write_mode_change',$s$);
END $do$;

-- ---------------------------------------------------------------- 2. Окончание по дате — функция узкой роли
GRANT USAGE ON SCHEMA tenant_data, security TO repracer_clearance_expiry;
GRANT EXECUTE ON FUNCTION security.current_tenant_id() TO repracer_clearance_expiry;
GRANT SELECT, INSERT ON tenant_data.clearance_change TO repracer_clearance_expiry;
GRANT SELECT (tenant_id, write_scope_id, channel_account_id, field) ON tenant_data.write_scope TO repracer_clearance_expiry;
CREATE POLICY clearance_expiry_rw ON tenant_data.clearance_change FOR ALL TO repracer_clearance_expiry
  USING (tenant_id = security.current_tenant_id()) WITH CHECK (tenant_id = security.current_tenant_id());
CREATE POLICY clearance_expiry_scope_read ON tenant_data.write_scope FOR SELECT TO repracer_clearance_expiry USING (tenant_id = security.current_tenant_id());

/**
 * Режимы распродажи аккаунта, чья дата окончания наступила, — строкой EXPIRE (запрос на переоценку ставит триггер). Время — часы базы:
 * «закончить из будущего» нечем. Зовёт пересчёт по расписанию в начале захода и пишет владельцу «цена вернётся к полу примерно за N шагов»
 */
CREATE FUNCTION tenant_data.expire_clearance_floors(p_channel_account_id uuid)
  RETURNS TABLE (write_scope_id uuid, floor_minor bigint, currency text, ends_at timestamptz, note text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  t uuid := security.current_tenant_id();
  r record;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'expiring clearance floors needs the tenant of the session';
  END IF;
  FOR r IN
    SELECT c.write_scope_id, c.floor_minor, c.currency, c.ends_at, c.note
      FROM tenant_data.clearance_change c
      JOIN tenant_data.write_scope s ON s.tenant_id = c.tenant_id AND s.write_scope_id = c.write_scope_id
     WHERE c.tenant_id = t AND s.channel_account_id = p_channel_account_id AND c.action = 'ENABLE' AND c.ends_at <= now()
       AND NOT EXISTS (SELECT 1 FROM tenant_data.clearance_change n
                        WHERE n.tenant_id = c.tenant_id AND n.write_scope_id = c.write_scope_id AND n.seq > c.seq)
  LOOP
    INSERT INTO tenant_data.clearance_change (tenant_id, write_scope_id, action) VALUES (t, r.write_scope_id, 'EXPIRE');
    write_scope_id := r.write_scope_id; floor_minor := r.floor_minor; currency := r.currency; ends_at := r.ends_at; note := r.note;
    RETURN NEXT;
  END LOOP;
END $fn$;
ALTER FUNCTION tenant_data.expire_clearance_floors(uuid) OWNER TO repracer_clearance_expiry;
REVOKE EXECUTE ON FUNCTION tenant_data.expire_clearance_floors(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_data.expire_clearance_floors(uuid) TO repracer_app;

-- ---------------------------------------------------------------- 3. Конец распродажи — запрос на переоценку [Р-208, Р-212]
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.request_floor_raise()'::regprocedure);
  a text := $s$  ELSIF TG_ARGV[0] = 'channel_write_history'$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: tenant_data.request_floor_raise() is not the definition the migration expects';
  END IF;
  -- Ветка журнала — ДО ветки истории записей: та читает поля записи в одном выражении с аргументом, а у журнала их нет
  EXECUTE replace(d, a, $s$  -- Шаг 102 [Р-227]: конец распродажи (выключение или дата) — первый же пересчёт начинает подъём к расчётному полу
  ELSIF TG_ARGV[0] = 'clearance_change' THEN
    IF NEW.action NOT IN ('DISABLE', 'EXPIRE') THEN
      RETURN NULL;
    END IF;
    why := 'CLEARANCE_ENDED';
$s$ || a);
END $do$;
GRANT SELECT (tenant_id, write_scope_id, action) ON tenant_data.clearance_change TO repracer_floor_raise;

SET ROLE repracer_owner;
CREATE TRIGGER zf_clearance_change_request_floor_raise AFTER INSERT ON tenant_data.clearance_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.request_floor_raise('clearance_change');

-- ---------------------------------------------------------------- 4. Пол базы: распродажа заменяет пол, безубыточность — всегда в нём
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.effective_price_floor(uuid,uuid,timestamptz)'::regprocedure);
  a text := $s$  IF min_margin_bp IS NULL THEN
    floor_minor := min_price_minor;
    RETURN NEXT;
    RETURN;
  END IF;

$s$;
  b text := $s$   ORDER BY (cp.channel_account_id IS NOT NULL) DESC, cp.valid_from DESC, cp.version DESC LIMIT 1;
$s$;
  e text := $s$    IF unit < 0 OR min_margin_bp < 0 OR min_margin_bp >= 10000 THEN$s$;
  f text := $s$candidate := tenant_data.price_for_margin_bp((fee ->> 'fixedFeeMinor')::bigint + unit, (fee ->> 'feeRateBp')::bigint, t, min_margin_bp);$s$;
  n int;
BEGIN
  SELECT (length(d) - length(replace(d, a, ''))) / length(a) + (length(d) - length(replace(d, b, ''))) / length(b)
       + (length(d) - length(replace(d, e, ''))) / length(e) + (length(d) - length(replace(d, f, ''))) / length(f) INTO n;
  IF n <> 4 THEN
    RAISE EXCEPTION '0197: tenant_data.effective_price_floor() is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(replace(replace(d, a, $s$  -- Шаг 102 [Р-227]: в режиме распродажи пол — пол распродажи; он заменяет min_price и пол маржи (решение владельца)
  SELECT ac.floor_minor INTO candidate FROM tenant_data.active_clearance(p_tenant_id, p_write_scope_id, p_at) ac;
  IF candidate IS NOT NULL THEN
    floor_minor := candidate;
    RETURN NEXT;
    RETURN;
  END IF;

$s$),
    b, b || $s$  -- Шаг 102 [Р-227]: без минимальной маржи пол — безубыточность (маржа 0 %), если себестоимость объявлена; без неё — min_price (Р-131)
  IF min_margin_bp IS NULL AND c IS NULL THEN
    floor_minor := min_price_minor;
    RETURN NEXT;
    RETURN;
  END IF;
$s$),
    e, $s$    IF unit < 0 OR coalesce(min_margin_bp, 0) < 0 OR coalesce(min_margin_bp, 0) >= 10000 THEN$s$),
    f, $s$candidate := tenant_data.price_for_margin_bp((fee ->> 'fixedFeeMinor')::bigint + unit, (fee ->> 'feeRateBp')::bigint, t, coalesce(min_margin_bp, 0));$s$);
END $do$;

-- Пол решения: в режиме распродажи — пол распродажи (решение несёт строку включения), иначе — min_price, как прежде
/**
 * Внешнего ключа на журнал у столбца НЕТ намеренно: пол решения база берёт не из этой ссылки, а из действующего режима единицы (страж ниже),
 * поэтому ссылка — справочная, для квитанции («включил, когда, записка»). Ключ с секционированной таблицы решений мешал бы журналу быть
 * только на добавление: TRUNCATE отказывал бы ключом раньше триггера неизменяемости (Р-103)
 */
ALTER TABLE channel_data.price_decision ADD COLUMN clearance_change_id uuid;
COMMENT ON COLUMN channel_data.price_decision.clearance_change_id IS
  'Р-227 (шаг 102): строка включения режима распродажи, при котором принято решение; его пол — пол распродажи';

DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.price_decision_floor_guard()'::regprocedure);
  a text := $s$  floor_minor := tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id);$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: channel_data.price_decision_floor_guard() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, $s$  -- Шаг 102 [Р-227]: в режиме распродажи нижняя граница решения — пол распродажи, а не min_price
  floor_minor := coalesce((SELECT ac.floor_minor FROM tenant_data.active_clearance(NEW.tenant_id, NEW.write_scope_id, now()) ac),
                          tenant_data.effective_min_price(NEW.tenant_id, NEW.write_scope_id));$s$);
END $do$;

-- ---------------------------------------------------------------- 5. Удержания пола распродажи — отдельно от «пол удержал» [Р-117]
ALTER TABLE channel_data.floor_hold ADD COLUMN clearance boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN channel_data.floor_hold.clearance IS
  'Р-227 (шаг 102): удержал пол распродажи — намеренный убыток, в «без пола вы продали бы на X дешевле» не входит';
RESET ROLE;

DO $do$
DECLARE
  d text := pg_get_functiondef('channel_data.price_intent_record_floor_hold()'::regprocedure);
  a text := $s$                           WHEN 'CAPPED_AT_MARGIN_FLOOR' THEN (x -> 'params' ->> 'floorMinor')::bigint$s$;
  b text := $s$   WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'CAPPED_AT_MARGIN_FLOOR', 'TARGET_OUTSIDE_BOUNDS_HOLD') AND x -> 'params' ? 'targetMinor'$s$;
  c text := $s$    INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow)
    VALUES (NEW.tenant_id, NEW.price_intent_id, NEW.created_at, NEW.write_scope_id, NEW.currency, held - target, coalesce(in_shadow, false))$s$;
  n int;
BEGIN
  SELECT (length(d) - length(replace(d, a, ''))) / length(a) + (length(d) - length(replace(d, b, ''))) / length(b)
       + (length(d) - length(replace(d, c, ''))) / length(c) INTO n;
  IF n <> 3 THEN
    RAISE EXCEPTION '0197: channel_data.price_intent_record_floor_hold() is not the definition the migration expects';
  END IF;
  EXECUTE replace(replace(replace(d,
    a, a || $s$
                           WHEN 'CAPPED_AT_CLEARANCE_FLOOR' THEN (x -> 'params' ->> 'floorMinor')::bigint$s$),
    b, $s$   WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'CAPPED_AT_MARGIN_FLOOR', 'CAPPED_AT_CLEARANCE_FLOOR', 'TARGET_OUTSIDE_BOUNDS_HOLD') AND x -> 'params' ? 'targetMinor'$s$),
    c, $s$    -- Шаг 102 [Р-227]: решение в режиме распродажи открывается его причиной — удержание помечено как намеренный убыток
    INSERT INTO channel_data.floor_hold (tenant_id, price_intent_id, intent_created_at, write_scope_id, currency, below_minor, shadow, clearance)
    VALUES (NEW.tenant_id, NEW.price_intent_id, NEW.created_at, NEW.write_scope_id, NEW.currency, held - target, coalesce(in_shadow, false),
            EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(NEW.rationale -> 'explanation', '[]'::jsonb)) y WHERE y ->> 'code' = 'CLEARANCE_FLOOR'))$s$);
END $do$;
GRANT INSERT (clearance) ON channel_data.floor_hold TO repracer_floor_hold;

DO $do$
DECLARE
  d text := pg_get_functiondef('platform.shadow_floor_savings_between(uuid,timestamptz,timestamptz)'::regprocedure);
  a text := $s$fh.intent_created_at < p_to AND fh.shadow$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0197: platform.shadow_floor_savings_between() is not the definition the migration expects';
  END IF;
  -- Шаг 102 [Р-227]: удержание пола распродажи — намеренный убыток, а не то, от чего пол «спас»
  EXECUTE replace(d, a, $s$fh.intent_created_at < p_to AND fh.shadow AND NOT fh.clearance$s$);
END $do$;

-- ---------------------------------------------------------------- 6. Реестры параметров слепка
DO $do$
DECLARE
  keys jsonb := security.eternal_param_keys();
  kinds jsonb := security.eternal_param_kinds();
  derived jsonb := security.channel_derived_param_keys();
  after_v jsonb;
BEGIN
  IF keys ? 'CLEARANCE_FLOOR' OR kinds ? 'CAPPED_AT_CLEARANCE_FLOOR' OR derived ? 'CAPPED_AT_CLEARANCE_FLOOR'
     OR kinds #> '{RAISED_TO_FLOOR,bound,v}' <> '["min","margin_floor"]'::jsonb
     OR kinds #> '{BOUNDS_VERSION_CHANGED,changed,v}' <> '["MIN_PRICE","MAX_PRICE","CHANNEL_HALT","CHANNEL_DISTRUST","PRICING_STOP"]'::jsonb
     OR kinds #> '{BOUND_UNRESOLVABLE,bound,v}' <> '["min","max","margin_floor","both"]'::jsonb THEN
    RAISE EXCEPTION '0197: the reason registries are not the ones the migration expects';
  END IF;
  -- Пол распродажи и безубыточность — деньги тенанта: квитанция говорит правду и через год; цель стратегии — производная цены конкурента
  keys := keys || '{"CLEARANCE_FLOOR": ["breakEvenMinor", "currency", "floorMinor", "lossPerUnitMinor"], "CAPPED_AT_CLEARANCE_FLOOR": ["currency", "floorMinor"]}'::jsonb;
  keys := jsonb_set(keys, '{BELOW_MIN_PRICE}', '["currency", "deviationBp", "floor", "minMinor", "proposedMinor", "source"]'::jsonb);
  after_v := (kinds #> '{RAISED_TO_FLOOR,after,v}') || '["CLEARANCE_ENDED"]'::jsonb;
  kinds := kinds || jsonb_build_object(
    'CLEARANCE_FLOOR', '{"floorMinor": {"k": "money"}, "breakEvenMinor": {"k": "money"}, "lossPerUnitMinor": {"k": "money"}, "currency": {"k": "currency"}}'::jsonb,
    'CAPPED_AT_CLEARANCE_FLOOR', '{"floorMinor": {"k": "money"}, "currency": {"k": "currency"}}'::jsonb);
  kinds := jsonb_set(jsonb_set(kinds, '{RAISED_TO_FLOOR,bound,v}', '["min", "margin_floor", "clearance", "break_even"]'), '{RAISED_TO_FLOOR,after,v}', after_v);
  kinds := jsonb_set(jsonb_set(kinds, '{RAISED_TOWARD_FLOOR,bound,v}', '["min", "margin_floor", "clearance", "break_even"]'), '{RAISED_TOWARD_FLOOR,after,v}', after_v);
  kinds := jsonb_set(kinds, '{BELOW_MIN_PRICE,floor}', '{"k": "enum", "v": ["CLEARANCE"]}');
  kinds := jsonb_set(kinds, '{BOUNDS_VERSION_CHANGED,changed,v}', '["MIN_PRICE", "MAX_PRICE", "CHANNEL_HALT", "CHANNEL_DISTRUST", "PRICING_STOP", "CLEARANCE"]');
  -- Без минимальной маржи пол — безубыточность: отказ «пол выше потолка» называет её (у пола маржи 0 % квитанция говорила бы неправду)
  kinds := jsonb_set(kinds, '{BOUND_UNRESOLVABLE,bound,v}', '["min", "max", "margin_floor", "both", "break_even"]');
  derived := derived || '{"CAPPED_AT_CLEARANCE_FLOOR": ["targetMinor"]}'::jsonb;
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, keys);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, kinds);
  EXECUTE format($f$CREATE OR REPLACE FUNCTION security.channel_derived_param_keys() RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $b$ SELECT %L::jsonb $b$$f$, derived);
END $do$;

COMMIT;
