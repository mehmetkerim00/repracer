-- 0111: стражи массового изменения считают ОДИН РАЗ НА ОПЕРАТОР, а не на каждую строку [Р-135, задача D шага 31]
--
-- Причина — замер. Правка границ всего каталога (10 000 предложений) занимала 44 секунды фоновым заданием против 3,9 секунды
-- тем же расчётом в запросе. Разница не в задании: у сессии человека второй фактор есть, и страж выходит первой же строкой; у
-- задания предпросмотра его нет и быть не должно [Р-143], поэтому страж считал окно ПО КАЖДОЙ СТРОКЕ — а само окно к тому
-- моменту содержало те же 10 000 строк. Это квадрат: 10 000 просмотров по 10 000 строк.
--
-- Считать надо ровно то же самое и ровно так же строго, но один раз на оператор. Строковые проверки, которые обязаны быть
-- строковыми (время версии — время транзакции [Р-88]), остаются строковыми: они стоят копейки.

BEGIN;

SET ROLE repracer_owner;

/** Р-88: версия границы создаётся временем транзакции. Проверка строковая — она о самой строке, и она дешёвая */
CREATE FUNCTION tenant_data.bound_version_created_now() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF NEW.created_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'a bound version is created at the transaction time, not %: backdated versions are not accepted from the administrative service (Р-88)', NEW.created_at
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.bound_version_created_now() OWNER TO repracer_owner;

/**
 * Р-88, OQ-144: границы больше чем одного предложения в одной транзакции — только со вторым фактором. Считается один раз на
 * оператор, по таблице переходов: тенант берётся из неё же, и ни одна строка не считает окно заново.
 */
CREATE OR REPLACE FUNCTION tenant_data.bounds_mass_edit_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  offers integer;
  tenant uuid;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT']) THEN RETURN NULL; END IF;
  SELECT c.tenant_id INTO tenant FROM changed c LIMIT 1;
  IF tenant IS NULL THEN RETURN NULL; END IF;
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text) AS k
      FROM tenant_data.min_price b
     WHERE b.tenant_id = tenant AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
    UNION ALL
    SELECT coalesce('WRITE_SCOPE:' || b.write_scope_id::text, 'PRODUCT:' || b.product_id::text)
      FROM tenant_data.max_price b
     WHERE b.tenant_id = tenant AND b.created_at = now() AND tenant_data.row_in_current_transaction(b.xmin)
  ) edited;
  IF offers > 1 THEN
    RAISE EXCEPTION 'bounds of % offers changed in one transaction without a second factor: a mass bounds edit requires it (Р-88)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.bounds_mass_edit_requires_mfa() OWNER TO repracer_owner;

/**
 * Р-135: окно десяти минут. Тоже один раз на оператор — считает оно то же самое, и считать это на каждую строку значило бы
 * просматривать окно столько раз, сколько в нём строк.
 */
CREATE OR REPLACE FUNCTION tenant_data.mass_change_window_requires_mfa() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  window_start timestamptz := now() - interval '10 minutes';
  offers       int;
  wide         boolean;
  tenant       uuid;
BEGIN
  IF NOT security.admin_session() THEN RETURN NULL; END IF;
  IF security.second_factor_present(ARRAY['COST_IMPORT', 'BOUNDS_EDIT']) THEN RETURN NULL; END IF;
  SELECT c.tenant_id INTO tenant FROM changed c LIMIT 1;
  IF tenant IS NULL THEN RETURN NULL; END IF;
  -- Считаются только правки БЕЗ второго фактора: массовый импорт и массовая правка его уже предъявили. Ключ — товар: граница
  -- уровня единицы записи приводится к товару этой единицы, поэтому себестоимость и границы одного оффера — один ключ.
  SELECT count(DISTINCT k) INTO offers FROM (
    SELECT 'PRODUCT:' || c.product_id::text AS k FROM tenant_data.cost_profile c
     WHERE c.tenant_id = tenant AND c.created_at >= window_start AND NOT c.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.min_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = tenant AND b.created_at >= window_start AND NOT b.created_with_mfa
    UNION ALL
    SELECT 'PRODUCT:' || coalesce(b.product_id, w.product_id)::text FROM tenant_data.max_price b
     LEFT JOIN tenant_data.write_scope w ON w.tenant_id = b.tenant_id AND w.write_scope_id = b.write_scope_id AND w.field = 'PRICE'
     WHERE b.tenant_id = tenant AND b.created_at >= window_start AND NOT b.created_with_mfa
  ) changed_rows;
  -- Гардрейл шире предложения в окне: он уже изменил пол маржи у всех — следующая правка без второго фактора не проходит
  SELECT EXISTS (
    SELECT 1 FROM tenant_data.guardrail g
     WHERE g.tenant_id = tenant AND g.created_at >= window_start AND g.scope_type IN ('TENANT', 'CHANNEL_ACCOUNT')
  ) INTO wide;
  IF wide THEN
    RAISE EXCEPTION 'a guardrail of every offer was changed within ten minutes: further changes need a second factor (Р-135)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF offers > 5 THEN
    RAISE EXCEPTION 'prices of % offers changed within ten minutes without a second factor: a mass change requires it (Р-135)', offers
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $fn$;
ALTER FUNCTION tenant_data.mass_change_window_requires_mfa() OWNER TO repracer_owner;

/**
 * Задача D шага 31: экран различий массовой правки считается БЕЗ ВСТАВКИ. Прежде он вставлял версии границ и откатывал их —
 * по одной на предложение в своей точке сохранения, потому что без второго фактора страж массовой правки больше одной в
 * транзакции не пропускает. На каталоге в 10 000 предложений это 10 000 точек сохранения и 72 секунды.
 *
 * Вставлять незачем: действующая граница — это максимум активных полов и минимум активных потолков. Подставить предлагаемое
 * значение вместо уровня единицы записи можно прямо в запросе, и тогда экран различий не трогает данные вовсе — а значит не
 * будит ни стража, ни аудит, и считается одним запросом на весь каталог.
 */
CREATE FUNCTION tenant_data.effective_min_price_with(p_tenant_id uuid, p_write_scope_id uuid, p_candidate bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $fn$
  WITH s AS (
    SELECT product_id, currency, price_basis FROM tenant_data.write_scope
     WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE'
  ), scope_level AS (
    SELECT m.is_active, m.amount_minor FROM tenant_data.min_price m
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'WRITE_SCOPE' AND m.write_scope_id = p_write_scope_id
     ORDER BY m.version DESC LIMIT 1
  ), product_level AS (
    SELECT m.is_active, m.amount_minor FROM tenant_data.min_price m JOIN s
        ON m.product_id = s.product_id AND m.currency = s.currency AND m.price_basis = s.price_basis
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'PRODUCT'
     ORDER BY m.version DESC LIMIT 1
  )
  SELECT max(amount_minor) FROM (
    -- Предлагаемое значение занимает место уровня единицы записи; NULL — эту границу правка не трогает
    SELECT coalesce(p_candidate, (SELECT amount_minor FROM scope_level WHERE is_active)) AS amount_minor
    UNION ALL
    SELECT amount_minor FROM product_level WHERE is_active
  ) floors
$fn$;
ALTER FUNCTION tenant_data.effective_min_price_with(uuid, uuid, bigint) OWNER TO repracer_owner;

CREATE FUNCTION tenant_data.effective_max_price_with(p_tenant_id uuid, p_write_scope_id uuid, p_candidate bigint) RETURNS bigint
  LANGUAGE sql STABLE AS $fn$
  WITH s AS (
    SELECT product_id, currency, price_basis FROM tenant_data.write_scope
     WHERE tenant_id = p_tenant_id AND write_scope_id = p_write_scope_id AND field = 'PRICE'
  ), scope_level AS (
    SELECT m.is_active, m.amount_minor FROM tenant_data.max_price m
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'WRITE_SCOPE' AND m.write_scope_id = p_write_scope_id
     ORDER BY m.version DESC LIMIT 1
  ), product_level AS (
    SELECT m.is_active, m.amount_minor FROM tenant_data.max_price m JOIN s
        ON m.product_id = s.product_id AND m.currency = s.currency AND m.price_basis = s.price_basis
     WHERE m.tenant_id = p_tenant_id AND m.scope_type = 'PRODUCT'
     ORDER BY m.version DESC LIMIT 1
  )
  SELECT min(amount_minor) FROM (
    SELECT coalesce(p_candidate, (SELECT amount_minor FROM scope_level WHERE is_active)) AS amount_minor
    UNION ALL
    SELECT amount_minor FROM product_level WHERE is_active
  ) ceilings
$fn$;
ALTER FUNCTION tenant_data.effective_max_price_with(uuid, uuid, bigint) OWNER TO repracer_owner;
GRANT EXECUTE ON FUNCTION tenant_data.effective_min_price_with(uuid, uuid, bigint),
                          tenant_data.effective_max_price_with(uuid, uuid, bigint) TO repracer_admin, repracer_app;

RESET ROLE;

-- Триггеры пересоздаются на уровне ОПЕРАТОРА с таблицей переходов; имена сохраняются — на них ссылается каталог мутаций [Р-108]
DROP TRIGGER zc_min_price_mass_edit_requires_mfa ON tenant_data.min_price;
DROP TRIGGER zc_max_price_mass_edit_requires_mfa ON tenant_data.max_price;
DROP TRIGGER zf_cost_profile_mass_window_requires_mfa ON tenant_data.cost_profile;
DROP TRIGGER zf_min_price_mass_window_requires_mfa ON tenant_data.min_price;
DROP TRIGGER zf_max_price_mass_window_requires_mfa ON tenant_data.max_price;

CREATE TRIGGER za_min_price_created_now AFTER INSERT ON tenant_data.min_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bound_version_created_now();
CREATE TRIGGER za_max_price_created_now AFTER INSERT ON tenant_data.max_price
  FOR EACH ROW EXECUTE FUNCTION tenant_data.bound_version_created_now();

CREATE TRIGGER zc_min_price_mass_edit_requires_mfa AFTER INSERT ON tenant_data.min_price
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.bounds_mass_edit_requires_mfa();
CREATE TRIGGER zc_max_price_mass_edit_requires_mfa AFTER INSERT ON tenant_data.max_price
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.bounds_mass_edit_requires_mfa();
CREATE TRIGGER zf_cost_profile_mass_window_requires_mfa AFTER INSERT ON tenant_data.cost_profile
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();
CREATE TRIGGER zf_min_price_mass_window_requires_mfa AFTER INSERT ON tenant_data.min_price
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();
CREATE TRIGGER zf_max_price_mass_window_requires_mfa AFTER INSERT ON tenant_data.max_price
  REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION tenant_data.mass_change_window_requires_mfa();

COMMIT;
