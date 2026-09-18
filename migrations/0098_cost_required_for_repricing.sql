-- 0098_cost_required_for_repricing.sql
-- Шаг 27, B [Р-131, OQ-186]: без себестоимости репрайсинг НЕ ВКЛЮЧАЕТСЯ.
-- У товара без себестоимости, без истории и без того же EAN на другом канале нет ни одного якоря проверки входов [Р-49]: снимок
-- отклоняется NO_PLAUSIBILITY_ANCHOR, история для якоря строится только из принятых снимков — круг не размыкается сам (живой режим шага 26).
-- Именно на новом товаре у продавца нет ощущения нормальной цены: ошибка в сто раз пройдёт незамеченной. Себестоимость и так обязательна
-- для пола маржи [Р-5, Р-83].
-- Правило в базе: перевод единицы записи цены в режим ENGINE требует действующей себестоимости товара. Продавец видит требование при
-- попытке включить стратегию (причина COST_REQUIRED в консоли), а не молчаливое отсутствие оценок.

BEGIN;

SET ROLE repracer_owner;

/** Действующая себестоимость единицы записи: тот же выбор профиля, что у пола маржи (0051) */
CREATE FUNCTION tenant_data.write_scope_has_cost(p_tenant_id uuid, p_write_scope_id uuid, p_at timestamptz DEFAULT now()) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM tenant_data.write_scope s
      -- Витрина единицы — из привязки оффера, как в пересчёте пола (0051)
      LEFT JOIN LATERAL (SELECT om.marketplace FROM tenant_data.offer_mapping om
                          WHERE om.tenant_id = s.tenant_id AND om.price_write_scope_id = s.write_scope_id
                          ORDER BY om.created_at LIMIT 1) m ON true
      JOIN tenant_data.cost_profile cp ON cp.tenant_id = s.tenant_id AND cp.product_id = s.product_id
     WHERE s.tenant_id = p_tenant_id AND s.write_scope_id = p_write_scope_id
       AND (cp.channel_account_id IS NULL OR (cp.channel_account_id = s.channel_account_id AND cp.marketplace = m.marketplace))
       AND cp.valid_from <= p_at);
$fn$;
GRANT EXECUTE ON FUNCTION tenant_data.write_scope_has_cost(uuid, uuid, timestamptz) TO repracer_app, repracer_admin;

/**
 * Р-131: включение движка без себестоимости отклоняет база. Проверяется только переход в ENGINE — выключение и правка уже включённой
 * единицы не блокируются (себестоимость могли удалить позже; решения по такой единице всё равно не примутся: пол маржи fail-closed).
 */
CREATE FUNCTION tenant_data.write_scope_cost_required_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.pricing_mode = 'ENGINE' AND (TG_OP = 'INSERT' OR OLD.pricing_mode IS DISTINCT FROM 'ENGINE')
     AND NOT tenant_data.write_scope_has_cost(NEW.tenant_id, NEW.write_scope_id) THEN
    RAISE EXCEPTION 'repricing needs the declared unit cost of the product (Р-131)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$;
-- Отложенный и с именем после write_scope_requires_min_price: сначала продавец узнаёт об отсутствующих границах, потом о себестоимости
CREATE CONSTRAINT TRIGGER zw_write_scope_cost_required_guard AFTER INSERT OR UPDATE OF pricing_mode ON tenant_data.write_scope
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenant_data.write_scope_cost_required_guard();

RESET ROLE;

COMMIT;
