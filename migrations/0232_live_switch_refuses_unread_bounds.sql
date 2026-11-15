-- 0232_live_switch_refuses_unread_bounds.sql
-- Шаг 136 (отложенное «128», решение владельца 2026-11-15 — вариант (а); release gate из отчёта Мердана «QA-A Testing 1.0»): перевод аккаунта
-- канала из тени в бой ОТКАЗЫВАЕТ, пока у аккаунта есть включённые предложения с рамками Amazon Min/Max без прочитанных значений (или
-- прочитанными не в валюте предложения), и перечисляет их. Без скрытых изменений: автоцена у этих предложений сама не выключается — что делать,
-- решает продавец: убрать рамки в Seller Central или выключить автоцену у предложения [Р-242].
--
-- Почему здесь: шаг 127 (0230) разрешил такие предложения в тени, шаг 128 (0231) — не включать их у аккаунта в бою. Перевод аккаунта в бой
-- оставлял их включёнными, и первая же боевая запись упёрлась бы в адаптер (AMZ_C03: BLOCKED и CRITICAL) — предсказуемый стоп по известному
-- заранее состоянию. Теперь это состояние не пускает в бой, и предсказуемого стопа не бывает.
--
-- Правило — одна функция `tenant_data.live_switch_blocking_offers`: её зовёт страж журнала режимов (отказ) и консоль (список в отказе продавцу).
-- Условие то же, что у стражей шага 128 (`channel_data.offer_channel_pricing_active`): последнее наблюдение ценообразования канала у SKU —
-- рамки есть, а значений в валюте единицы записи нет.
BEGIN;
SET ROLE repracer_owner;

/**
 * Шаг 136: включённые предложения аккаунта, которые держат его в тени, — первые 20 по SKU и витрине и общее число (одно у каждой строки).
 * Включённое — автоцена движком (`pricing_mode = 'ENGINE'`): выключенное ничего не отправит и бой не держит.
 */
CREATE FUNCTION tenant_data.live_switch_blocking_offers(p_tenant_id uuid, p_channel_account_id uuid)
  RETURNS TABLE (external_sku text, marketplace text, total bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT b.external_sku, b.marketplace, b.total FROM (
    SELECT m.external_sku, m.marketplace, count(*) OVER () AS total, row_number() OVER (ORDER BY m.external_sku, m.marketplace) AS n
      FROM tenant_data.offer_mapping m
      JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
      JOIN LATERAL (
        SELECT x.channel_bounds, x.bounds_currency FROM channel_data.offer_channel_pricing x
         WHERE x.tenant_id = m.tenant_id AND x.channel_account_id = m.channel_account_id AND x.marketplace = m.marketplace AND x.external_sku = m.external_sku
         ORDER BY x.observed_at DESC, x.recorded_at DESC LIMIT 1) o ON true
     WHERE m.tenant_id = p_tenant_id AND m.channel_account_id = p_channel_account_id AND m.external_sku IS NOT NULL
       AND s.pricing_mode = 'ENGINE'
       AND o.channel_bounds AND o.bounds_currency IS DISTINCT FROM s.currency) b
   WHERE b.n <= 20
   ORDER BY b.n
$fn$;
COMMENT ON FUNCTION tenant_data.live_switch_blocking_offers(uuid, uuid) IS
  'Шаг 136: включённые предложения аккаунта с рамками Amazon Min/Max без прочитанных значений в валюте предложения — первые 20 и общее число; бой закрыт, пока список не пуст';
REVOKE ALL ON FUNCTION tenant_data.live_switch_blocking_offers(uuid, uuid) FROM PUBLIC;
-- Страж журнала режимов исполняется ролью административного сервиса (вставка строки журнала), консоль читает список ею же
GRANT EXECUTE ON FUNCTION tenant_data.live_switch_blocking_offers(uuid, uuid) TO repracer_admin;

RESET ROLE;

/**
 * Страж журнала режимов правится точечно, через pg_get_functiondef — как в 0191 и 0224: так сохраняются прежние правки, владелец функции,
 * search_path и права. Новая проверка — в ветке «в бой» после свойств витрины: неизвестное про витрину закрывает оператор (Р-204), а это —
 * продавец; оба отказа называют, кто и что делает. Замена проверяет, что нашла свой фрагмент.
 */
CREATE FUNCTION pg_temp.patch(p_fn regprocedure, p_from text, p_to text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE d text := pg_get_functiondef(p_fn);
BEGIN
  IF position(p_from IN d) = 0 THEN RAISE EXCEPTION 'step 136: % does not contain «%»', p_fn, p_from; END IF;
  EXECUTE replace(d, p_from, p_to);
END $fn$;

SELECT pg_temp.patch('tenant_data.channel_write_mode_change_guard()',
  $s$  unknown_detail text;
$s$,
  $s$  unknown_detail text;
  blocked_total bigint;
  blocked_list text;
$s$);

SELECT pg_temp.patch('tenant_data.channel_write_mode_change_guard()',
  $s$    END IF;
    NEW.mfa := true;$s$,
  $s$    END IF;
    -- Шаг 136 (отложенное «128»): включённые предложения с рамками Amazon без прочитанных значений держат аккаунт в тени — бой отказывает
    -- и перечисляет их; автоцену у них никто не выключает, кроме продавца [Р-242]
    SELECT max(b.total), string_agg(b.external_sku || ' (' || b.marketplace || ')', ', ' ORDER BY b.external_sku, b.marketplace)
      INTO blocked_total, blocked_list
      FROM tenant_data.live_switch_blocking_offers(NEW.tenant_id, NEW.channel_account_id) b;
    IF blocked_total IS NOT NULL THEN
      RAISE EXCEPTION 'enabled offers have Amazon Min/Max bounds without read values: % of them, first: % — turn their automatic pricing off or remove the bounds in Seller Central (Р-250)',
        blocked_total, blocked_list USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.mfa := true;$s$);

COMMIT;
