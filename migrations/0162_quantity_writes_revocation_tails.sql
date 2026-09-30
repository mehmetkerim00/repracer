-- 0162_quantity_writes_revocation_tails.sql
-- Шаг 62: отложенный список шага 61 [Р-202].
-- 1. Страж отправки количества (0160) получает фиксированный `search_path`, как остальные функции шага: без него имя в теле функции
--    разрешалось бы по пути вызывающего.
-- 2. Блокировка строки аккаунта FOR UPDATE в страже журнала снята: выдачу и отзыв ставит в очередь advisory-блокировка (её взятие проверяет
--    смоук своей сессии — гонку одна сессия не покажет), а гонку «подтверждение ↔ ответ „остатки ведёт другой инструмент“» держит страж
--    аккаунта на ИТОГОВОЙ строке (п. 4): ревью шага 62, находка 1 — FOR UPDATE упорядочивал и её, и без проверки итоговой строки
--    подтверждение, прочитавшее прежний ответ, давало бы двух писателей.
-- 3. Внешняя правка количества — только у единицы с включённой синхронизацией: после отзыва количество законно ведёт другой инструмент.
-- 4. Страж аккаунта проверяет «подтверждено + остатки ведёт другой инструмент» на итоговой строке при ЛЮБОМ изменении любого из двух
--    столбцов, включая применение подтверждения журналом (глубина 2): прочитанное стражем журнала до чужого ответа не спасает.

BEGIN;
SET ROLE repracer_owner;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_quantity_writes_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  account uuid;
BEGIN
  IF NEW.field <> 'QUANTITY' OR NOT (NEW.status = 'DISPATCHED' AND OLD.status IS DISTINCT FROM 'DISPATCHED') THEN
    RETURN NEW;
  END IF;
  SELECT ws.channel_account_id INTO account FROM tenant_data.write_scope ws
   WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
  -- Разделяемая блокировка аккаунта: захваты не ждут друг друга, а идущий отзыв (исключительная) — ждут; признак читается после неё
  PERFORM pg_advisory_xact_lock_shared(202, hashtext(account::text));
  IF NOT EXISTS (SELECT 1 FROM tenant_data.channel_account ca
                  WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = account AND ca.quantity_writes_confirmed) THEN
    RAISE EXCEPTION 'quantity writes of channel account % are not confirmed by the owner: no quantity is sent (Р-202)', account
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION tenant_data.channel_quantity_writes_confirmation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  m record;
  a record;
BEGIN
  SELECT mb.user_id, mb.role INTO m FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.confirmed_by_membership_id AND mb.status = 'ACTIVE';
  IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.confirmed_by_membership_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF m.role IS DISTINCT FROM 'OWNER' THEN
    RAISE EXCEPTION 'only the owner confirms or revokes quantity writes of a channel account (Р-202)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  /**
   * Блокировка аккаунта — advisory, исключительная: страж отправки количества берёт её разделяемой, и отзыв ждёт захвата, начатого до
   * него, а захват после отзыва видит отзыв (ревью шага 61, находка 2). Она же ставит в очередь выдачу и отзыв одного аккаунта, поэтому
   * блокировка строки аккаунта FOR UPDATE (0160) снята как дубль [Р-104]: снять её не ловила ни одна проверка (ревью шага 61, находка 7)
   */
  PERFORM pg_advisory_xact_lock(202, hashtext(NEW.channel_account_id::text));
  SELECT ca.external_account_id, ca.other_tools, ca.quantity_writes_confirmed INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id;
  IF NEW.action = 'REVOKE' THEN
    IF NOT a.quantity_writes_confirmed THEN
      RAISE EXCEPTION 'quantity writes of this channel account are not confirmed: nothing to revoke (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.action = 'CONFIRM' THEN
    IF a.quantity_writes_confirmed THEN
      RAISE EXCEPTION 'quantity writes of this channel account are already confirmed (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
    IF a.other_tools IS NULL THEN
      RAISE EXCEPTION 'answer first whether another tool updates stock or prices in this channel (Р-202)' USING ERRCODE = 'check_violation';
    END IF;
    -- «Остатки ведёт другой инструмент» здесь не проверяется: запрет двух писателей держит страж аккаунта на ИТОГОВОЙ строке при
    -- применении подтверждения, и прежняя ветка стала его дублем [Р-104] (полный каталог мутаций шага 62)
  END IF;
  IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
    RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-202)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Как у журнала переключений (0142, Р-192): у eBay внешний идентификатор — userId продавца; подтверждение проверено базой, хранится отметка
  NEW.typed_confirmation := 'matched';
  NEW.confirmed_at := now();
  RETURN NEW;
END $fn$;

/**
 * Ревью шага 62, находка 1: ответ «остатки ведёт другой инструмент» не берёт блокировку аккаунта, и подтверждение, прочитавшее прежний ответ
 * «нет», применялось поверх зафиксированного «остатки» — страж ниже смотрел только на смену ответа. Теперь запрет двух писателей — на итоговой
 * строке: при применении подтверждения повторное чтение строки (EvalPlanQual) видит чужой ответ, и подтверждение отказывает
 */
CREATE OR REPLACE FUNCTION tenant_data.channel_account_other_tools_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.quantity_writes_confirmed IS DISTINCT FROM OLD.quantity_writes_confirmed AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'quantity writes are confirmed by a row of tenant_data.channel_quantity_writes_confirmation, not directly (Р-202)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.other_tools IN ('STOCK', 'STOCK_AND_PRICES') AND NEW.quantity_writes_confirmed THEN
    RAISE EXCEPTION 'quantity writes of this channel account are confirmed: another tool managing stock would make two writers (Р-202)'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.other_tools IS DISTINCT FROM OLD.other_tools THEN
    NEW.other_tools_answered_at := now();
    NEW.other_tools_answered_by := security.current_user_id();
  END IF;
  RETURN NEW;
END $fn$;

RESET ROLE;

-- Функция принадлежит роли каталога (0158) — заменяет её суперпользователь, владелец сохраняется
CREATE OR REPLACE FUNCTION channel_data.record_channel_observations(p_tenant_id uuid, p_channel_account_id uuid, p_items jsonb)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  i record;
  om record;
  lw record;
  tw record;
  n integer := 0;
  inserted integer;
BEGIN
  FOR i IN SELECT * FROM jsonb_to_recordset(p_items) AS x(marketplace text, external_sku text, external_offer_id text, external_unit_id text,
                                                         price_minor bigint, currency text, quantity bigint, observed_at timestamptz) LOOP
    CONTINUE WHEN i.observed_at IS NULL;
    SELECT m.price_write_scope_id, m.quantity_write_scope_id INTO om FROM tenant_data.offer_mapping m
     WHERE m.tenant_id = p_tenant_id AND m.channel_account_id = p_channel_account_id AND m.marketplace = i.marketplace AND m.status = 'ACTIVE'
       AND ((i.external_offer_id IS NOT NULL AND m.external_offer_id = i.external_offer_id) OR (i.external_unit_id IS NOT NULL AND m.external_unit_id = i.external_unit_id)
            OR (i.external_sku IS NOT NULL AND m.external_sku = i.external_sku))
     ORDER BY m.created_at DESC LIMIT 1;
    CONTINUE WHEN NOT FOUND;
    IF i.price_minor IS NOT NULL AND om.price_write_scope_id IS NOT NULL THEN
      -- Наша применённая: текущая запись, применённая сразу (`applied_at`), или завершённая в истории как APPLIED — самая свежая версия
      SELECT x.channel_write_id, x.amount_minor, x.currency INTO lw FROM (
        SELECT w.channel_write_id, w.amount_minor, w.currency, w.version FROM tenant_data.channel_write w
         WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.price_write_scope_id AND w.field = 'PRICE' AND w.applied_at IS NOT NULL
        UNION ALL
        SELECT h.channel_write_id, h.amount_minor, h.currency, h.version FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.price_write_scope_id AND h.field = 'PRICE' AND h.final_status = 'APPLIED') x
       ORDER BY x.version DESC LIMIT 1;
      -- Цель — самая свежая созданная версия (ждущая, в полёте или завершённая)
      SELECT x.amount_minor INTO tw FROM (
        SELECT w.amount_minor, w.version FROM tenant_data.channel_write w WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.price_write_scope_id AND w.field = 'PRICE'
        UNION ALL
        SELECT h.amount_minor, h.version FROM tenant_data.channel_write_history h WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.price_write_scope_id AND h.field = 'PRICE') x
       ORDER BY x.version DESC LIMIT 1;
      IF lw.channel_write_id IS NOT NULL AND i.currency = lw.currency AND i.price_minor <> lw.amount_minor AND i.price_minor IS DISTINCT FROM tw.amount_minor THEN
        INSERT INTO channel_data.external_edit (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at)
        VALUES (p_tenant_id, p_channel_account_id, om.price_write_scope_id, 'PRICE', i.price_minor, lw.amount_minor, i.currency, lw.channel_write_id, i.observed_at)
        ON CONFLICT ON CONSTRAINT external_edit_once DO NOTHING;
        GET DIAGNOSTICS inserted = ROW_COUNT;
        n := n + inserted;
      END IF;
    END IF;
    /**
     * Шаг 62 [Р-202]: количество — внешняя правка только у единицы, чью синхронизацию мы ведём. После отзыва подтверждения (или пока его
     * нет) владелец объявил, что количество ведёт другой инструмент: его значения законны, а не «чужие правки»
     */
    IF i.quantity IS NOT NULL AND om.quantity_write_scope_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM tenant_data.write_scope qs
                    WHERE qs.tenant_id = p_tenant_id AND qs.write_scope_id = om.quantity_write_scope_id AND qs.quantity_sync_enabled) THEN
      SELECT x.channel_write_id, x.quantity INTO lw FROM (
        SELECT w.channel_write_id, w.quantity, w.version FROM tenant_data.channel_write w
         WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.quantity_write_scope_id AND w.field = 'QUANTITY' AND w.applied_at IS NOT NULL
        UNION ALL
        SELECT h.channel_write_id, h.quantity, h.version FROM tenant_data.channel_write_history h
         WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.quantity_write_scope_id AND h.field = 'QUANTITY' AND h.final_status = 'APPLIED') x
       ORDER BY x.version DESC LIMIT 1;
      SELECT x.quantity INTO tw FROM (
        SELECT w.quantity, w.version FROM tenant_data.channel_write w WHERE w.tenant_id = p_tenant_id AND w.write_scope_id = om.quantity_write_scope_id AND w.field = 'QUANTITY'
        UNION ALL
        SELECT h.quantity, h.version FROM tenant_data.channel_write_history h WHERE h.tenant_id = p_tenant_id AND h.write_scope_id = om.quantity_write_scope_id AND h.field = 'QUANTITY') x
       ORDER BY x.version DESC LIMIT 1;
      IF lw.channel_write_id IS NOT NULL AND i.quantity > lw.quantity AND i.quantity IS DISTINCT FROM tw.quantity::bigint THEN
        INSERT INTO channel_data.external_edit (tenant_id, channel_account_id, write_scope_id, field, observed_value, our_value, currency, since_write_id, observed_at)
        VALUES (p_tenant_id, p_channel_account_id, om.quantity_write_scope_id, 'QUANTITY', i.quantity, lw.quantity, NULL, lw.channel_write_id, i.observed_at)
        ON CONFLICT ON CONSTRAINT external_edit_once DO NOTHING;
        GET DIAGNOSTICS inserted = ROW_COUNT;
        n := n + inserted;
      END IF;
    END IF;
  END LOOP;
  RETURN n;
END $fn$;


COMMIT;
