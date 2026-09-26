-- 0130_us_marketplace_facts_and_digest.sql
-- Шаг 42 [Р-172…Р-174]: готовность к витринам США, деньги в дайджесте тени, отметка его доставки.
--
-- Часть A — исправления ревью шага 41, которые попали в УЖЕ СЛИТУЮ миграцию 0126. Находка 11 того же ревью говорит
-- ровно об этом: миграция, попавшая в main, задним числом не правится, иначе файл и развёрнутая база разойдутся молча.
-- Правки шага 41 из 0126 убраны, и здесь они выходят как новая миграция; правило репозитория держит границу [Р-146].
--
-- Часть B — Р-172: всё, что про витрины США неизвестно, становится КОНФИГУРИРУЕМЫМ свойством витрины с честным
-- статусом. Значение каждого свойства живёт там, где жило (`platform.marketplace`, `platform.channel_capability`), — у
-- него появляется статус и ответ на вопрос «чем закрывается»: документацией, поддержкой канала или ТЕНЬЮ на живом
-- аккаунте. Тень — не обход проверки, а способ проверки: она читает канал по-настоящему и ничего не пишет [Р-169, Р-171].
-- Зубы у этого: аккаунт нельзя перевести в БОЙ, пока у его витрины есть свойство со статусом UNKNOWN.
--
-- Часть C — Р-173: дайджест тени говорит деньгами поверх Р-117 — «пол удержал цену N раз; без него вы продали бы на X
-- дешевле». X — разница цен из уже хранимых столбцов решения, по каждой валюте отдельно [Р-71], и это НЕ прогноз выручки.
--
-- Часть D — Р-174: у дайджеста появляется отметка доставки тем же механизмом, что у алертов [Р-156] — строка периода с
-- временем доставки, видом и попытками. Одна строка на период: второе письмо за ту же неделю отклоняет база.

BEGIN;

-- ================================================================ A. исправления ревью шага 41 в 0126
/**
 * Приёмник уведомлений на экране панели: столбец «разобрано» убран как ТАВТОЛОГИЯ [Р-94] — `channel_data.inbound_notification`
 * хранит только разобранные уведомления (`processed_at` NOT NULL с умолчанием), и счётчик был равен «получено» всегда.
 * Потерянное уведомление видно не здесь, а сверкой опросом [Р-121].
 *
 * Плюс окно ограничено с ДВУХ сторон: `p_since => interval '100 years'` давал полный проход по таблице приёмника.
 * Возвращаемый тип меняется, поэтому функция пересоздаётся, и владелец с правом выдаются заново.
 */
DROP FUNCTION platform.operator_notifications(interval);
CREATE FUNCTION platform.operator_notifications(p_since interval DEFAULT interval '24 hours')
  RETURNS TABLE (channel text, notification_type text, received bigint, last_received_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  SELECT n.channel, n.notification_type, count(*), max(n.received_at)
    FROM channel_data.inbound_notification n
   WHERE n.received_at >= now() - least(greatest(p_since, interval '1 hour'), interval '30 days')
   GROUP BY n.channel, n.notification_type
   ORDER BY max(n.received_at) DESC
$fn$;
ALTER FUNCTION platform.operator_notifications(interval) OWNER TO repracer_operator_actions;
-- Пересозданная функция получает права заново: у SECURITY DEFINER их не бывает у PUBLIC (0126), иначе её позвала бы
-- любая роль, включая роль остатков [Р-102] — проверка схемы это и нашла
REVOKE EXECUTE ON FUNCTION platform.operator_notifications(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.operator_notifications(interval) TO repracer_operator;

/** Заметка человека — заметка, а не файл: снизу её длину держит ограничение таблицы разбора, сверху — эта проверка */
CREATE OR REPLACE FUNCTION security.operator_resolve_snapshot_skip(p_operator_id uuid, p_snapshot_id uuid, p_resolution text, p_note text)
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $fn$
DECLARE
  who text := security.operator_acting(p_operator_id);
BEGIN
  IF length(p_note) > 2000 THEN
    RAISE EXCEPTION 'the note of a snapshot resolution is at most 2000 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO maintenance.snapshot_export_skip_resolution (competitor_snapshot_id, resolution, resolved_by, note, operator_id, mfa)
  VALUES (p_snapshot_id, p_resolution, who, p_note, p_operator_id, true);
  PERFORM security.operator_audit(p_operator_id, security.platform_tenant_id(), 'operator.snapshot_skip_resolved',
    'maintenance.snapshot_export_skip', p_snapshot_id, jsonb_build_object('resolution', p_resolution, 'operator', who));
END $fn$;

-- Разбор входа операторов зовёт ТОЛЬКО панель: роль входа продавцов операторов не разбирает — лишнее право [Р-96]
REVOKE EXECUTE ON FUNCTION security.resolve_platform_operator(text, text) FROM repracer_authenticator;

-- ================================================================ B. Р-172: свойства витрин США со честным статусом
/**
 * Три свойства витрин США неизвестны, и до этого шага каждое жило допущением: граница суток amazon.com и EBAY_US
 * (A-03, OQ-112), налоговая база цены amazon.com (A-02) и область записи остатка в регионе NA (Р-1 — «одно значение на
 * SKU в регионе» подтверждено для MFN, а не для всех типов исполнения).
 *
 * Значение каждого остаётся ТАМ, где жило: часовой пояс — в `platform.marketplace.time_zone`, налоговая база — в
 * `price_basis`/`tax_regime`, область записи — в `platform.channel_capability.write_scope_kind`. Второго источника
 * значения не появляется [Р-104]; появляется СТАТУС и ответ на вопрос «чем закрывается».
 *
 * Словарь статусов один на все свойства:
 *   CONFIRMED    — подтверждено документацией или ответом канала;
 *   CONSERVATIVE — действуем по консервативному значению, вопрос открыт и назван;
 *   UNKNOWN      — значения нет вовсе, и подставлять его нельзя [Р-65].
 * Словарь «чем закрывается»:
 *   SHADOW_READ      — ТЕНЬ на живом аккаунте: она читает канал по-настоящему и не пишет [Р-169, Р-171];
 *   FIRST_LIVE_WRITE — только первая боевая запись и обратное чтение (Р-116): в тени отправленной цены нет;
 *   CHANNEL_SUPPORT  — только ответ поддержки канала или его документация.
 */

ALTER TABLE platform.marketplace
  ADD COLUMN tax_status text NOT NULL DEFAULT 'CONSERVATIVE',
  ADD COLUMN tax_question text,
  ADD COLUMN tax_source text NOT NULL DEFAULT 'не заполнено',
  ADD COLUMN tax_closes_by text NOT NULL DEFAULT 'CHANNEL_SUPPORT',
  ADD COLUMN time_zone_closes_by text NOT NULL DEFAULT 'CHANNEL_SUPPORT',
  ADD COLUMN time_zone_question text;

/**
 * Подтверждение свойства убирает его открытый вопрос. Это уборка, а не проверка: «подтверждено, и вопрос ещё открыт» —
 * состояние, которого не бывает, и база приводит его к правде сама.
 */
CREATE FUNCTION platform.marketplace_confirmed_has_no_question() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.time_zone_status = 'CONFIRMED' THEN NEW.time_zone_question := NULL; END IF;
  IF NEW.tax_status = 'CONFIRMED' THEN NEW.tax_question := NULL; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_marketplace_confirmed_has_no_question BEFORE INSERT OR UPDATE ON platform.marketplace
  FOR EACH ROW EXECUTE FUNCTION platform.marketplace_confirmed_has_no_question();

COMMENT ON COLUMN platform.marketplace.tax_status IS
  'Р-172: статус налоговой базы цены витрины. CONSERVATIVE — действуем по консервативному значению, вопрос назван';
COMMENT ON COLUMN platform.marketplace.tax_closes_by IS
  'Р-172: чем закрывается вопрос о налоговой базе — тенью (чтением), первой боевой записью или поддержкой канала';

/**
 * Значения по списку ревизии. Витрины ЕС: налоговая база брутто — консервативная до ответа на K-12 у Kaufland и OQ-102 у
 * Amazon; закрывается она ПЕРВОЙ БОЕВОЙ ЗАПИСЬЮ, а не тенью: Р-116 сверяет применённую цену с ОТПРАВЛЕННОЙ, а в тени
 * отправленной цены нет. Это и есть честный ответ на вопрос «что закроет тень»: не всё.
 */
UPDATE platform.marketplace SET
  tax_status = 'CONSERVATIVE', tax_question = 'K-12', tax_closes_by = 'FIRST_LIVE_WRITE',
  tax_source = 'Р-53, Р-58: цены витрин Kaufland — брутто с НДС внутри; подтверждения документацией нет (K-12), сверка — обратным чтением Р-116',
  time_zone_question = 'K-13'
 WHERE channel = 'KAUFLAND';

UPDATE platform.marketplace SET
  tax_status = 'CONSERVATIVE', tax_question = 'OQ-102', tax_closes_by = 'FIRST_LIVE_WRITE',
  tax_source = 'Р-58: amazon.de — брутто (VAT_INCLUDED) по правилам витрин ЕС; налоговый режим SP-API не подтверждён (OQ-102)',
  time_zone_closes_by = 'SHADOW_READ', time_zone_question = 'A-03'
 WHERE channel = 'AMAZON' AND country = 'DE';

/**
 * amazon.com: ОБА свойства открыты и по-разному.
 * Граница суток — UNKNOWN: значения нет, общее значение для США не подставляется [Р-65]. Закрывает её ТЕНЬ: суточные
 * отчёты и уведомления SP-API приходят на чтение, и момент, когда сутки отчёта переворачиваются, виден без единой записи.
 * Налоговая база — CONSERVATIVE: цены витрин США — нетто, налог добавляется при покупке [Р-58]. Это консервативно в
 * нужную сторону (пол считается по нетто, то есть выше), но закрывается только первой боевой записью [Р-116].
 */
UPDATE platform.marketplace SET
  tax_status = 'CONSERVATIVE', tax_question = 'A-02', tax_closes_by = 'FIRST_LIVE_WRITE',
  tax_source = 'Р-58: цены amazon.com — нетто, sales tax добавляется при покупке; налоговая база SP-API не подтверждена (A-02)',
  time_zone_closes_by = 'SHADOW_READ', time_zone_question = 'A-03'
 WHERE channel = 'AMAZON' AND country = 'US';

UPDATE platform.marketplace SET
  tax_status = 'CONSERVATIVE', tax_question = 'E-01', tax_closes_by = 'FIRST_LIVE_WRITE',
  tax_source = 'Р-58: EBAY_DE — брутто, EBAY_US — нетто; снимка спецификации eBay нет (E-01), поля не подтверждены',
  time_zone_closes_by = 'CHANNEL_SUPPORT', time_zone_question = 'OQ-112'
 WHERE channel = 'EBAY';
UPDATE platform.marketplace SET
  time_zone_closes_by = 'CHANNEL_SUPPORT',
  time_zone_source = 'EBAY_US: граница календарного дня лимита 250 правок листинга не установлена; наблюдением её не закрыть — счётчик бюджета виден только записи (E-01, OQ-112)'
 WHERE marketplace = 'EBAY_US';
-- Подтверждённое свойство вопроса не несёт; на момент миграции подтверждённых поясов нет ни у одной витрины
UPDATE platform.marketplace SET time_zone_question = NULL WHERE time_zone_status = 'CONFIRMED';

-- Ограничения ставятся ПОСЛЕ заполнения значений: пустой вопрос у неподтверждённого свойства — то, что они и ловят
ALTER TABLE platform.marketplace
  ADD CONSTRAINT marketplace_property_status_known
    CHECK (tax_status IN ('CONFIRMED', 'CONSERVATIVE', 'UNKNOWN')),
  ADD CONSTRAINT marketplace_property_closes_by_known
    CHECK (tax_closes_by IN ('SHADOW_READ', 'FIRST_LIVE_WRITE', 'CHANNEL_SUPPORT')
       AND time_zone_closes_by IN ('SHADOW_READ', 'FIRST_LIVE_WRITE', 'CHANNEL_SUPPORT')),
  /**
   * Неподтверждённое свойство ОБЯЗАНО называть вопрос: иначе «проверить» теряется молча, и через полгода никто не помнит,
   * что значение было взято консервативно. Обратную половину («подтверждённое вопроса не несёт») держит не ограничение, а
   * триггер ниже: подтверждение приходит одной правкой статуса из десятка мест, и отказ вместо уборки означал бы, что
   * подтвердить свойство можно только зная про столбец вопроса.
   */
  ADD CONSTRAINT marketplace_tax_question_named_while_unconfirmed
    CHECK (tax_status = 'CONFIRMED' OR tax_question IS NOT NULL),
  ADD CONSTRAINT marketplace_time_zone_question_named_while_unconfirmed
    CHECK (time_zone_status = 'CONFIRMED' OR time_zone_question IS NOT NULL),
  ADD CONSTRAINT marketplace_question_shape
    CHECK ((tax_question IS NULL OR tax_question ~ '^(OQ|[A-Z])-[0-9]{1,3}$')
       AND (time_zone_question IS NULL OR time_zone_question ~ '^(OQ|[A-Z])-[0-9]{1,3}$')),
  ADD CONSTRAINT marketplace_tax_source_named CHECK (length(tax_source) BETWEEN 10 AND 500);


/**
 * Область записи остатка — свойство ВОЗМОЖНОСТИ канала, а не витрины: она одна на регион. Столбец добавляется без
 * умолчания и заполняется поимённо — умолчание здесь было бы утверждением о том, чего мы не проверяли.
 */
ALTER TABLE platform.channel_capability
  ADD COLUMN write_scope_status text,
  ADD COLUMN write_scope_question text,
  ADD COLUMN write_scope_closes_by text;

UPDATE platform.channel_capability SET write_scope_status = 'CONFIRMED', write_scope_closes_by = 'CHANNEL_SUPPORT';
UPDATE platform.channel_capability SET
  write_scope_status = 'CONSERVATIVE', write_scope_question = 'A-16', write_scope_closes_by = 'FIRST_LIVE_WRITE'
 WHERE channel = 'AMAZON' AND field = 'QUANTITY';
UPDATE platform.channel_capability SET
  write_scope_status = 'CONSERVATIVE', write_scope_question = 'E-01', write_scope_closes_by = 'CHANNEL_SUPPORT'
 WHERE channel = 'EBAY';

ALTER TABLE platform.channel_capability
  ALTER COLUMN write_scope_status SET NOT NULL,
  ALTER COLUMN write_scope_closes_by SET NOT NULL,
  ADD CONSTRAINT channel_capability_write_scope_status_known
    CHECK (write_scope_status IN ('CONFIRMED', 'CONSERVATIVE', 'UNKNOWN')),
  ADD CONSTRAINT channel_capability_write_scope_closes_by_known
    CHECK (write_scope_closes_by IN ('SHADOW_READ', 'FIRST_LIVE_WRITE', 'CHANNEL_SUPPORT')),
  ADD CONSTRAINT channel_capability_write_scope_question_iff_unconfirmed
    CHECK ((write_scope_status = 'CONFIRMED') = (write_scope_question IS NULL));

COMMENT ON COLUMN platform.channel_capability.write_scope_status IS
  'Р-172: подтверждена ли ОБЛАСТЬ записи. Amazon QUANTITY — CONSERVATIVE: «одно значение на SKU в регионе» [Р-1] известно для MFN (A-16)';

/**
 * Ревизия одной функцией: свойство, его значение, статус, открытый вопрос и чем закрывается. Читают её консоль и страж
 * перевода в бой, поэтому она СОБИРАЕТ данные, а не хранит их — разойтись со значением ей нечем.
 */
CREATE FUNCTION platform.marketplace_readiness()
  RETURNS TABLE (channel text, marketplace text, country text, property text, value text, status text,
                 question text, closes_by text, source text)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  SELECT m.channel, m.marketplace, m.country, 'DAY_BOUNDARY',
         m.time_zone,
         CASE WHEN m.time_zone_status = 'CONFIRMED' THEN 'CONFIRMED'
              WHEN m.time_zone IS NULL             THEN 'UNKNOWN'
              ELSE 'CONSERVATIVE' END,
         m.time_zone_question, m.time_zone_closes_by, m.time_zone_source
    FROM platform.marketplace m
  UNION ALL
  SELECT m.channel, m.marketplace, m.country, 'PRICE_TAX_BASIS',
         m.price_basis || ' / ' || m.tax_regime, m.tax_status, m.tax_question, m.tax_closes_by, m.tax_source
    FROM platform.marketplace m
  UNION ALL
  /**
   * Область записи объявлена возможностью канала по региону, а витрины к региону приводит справочник: у Amazon регион NA
   * — витрины США, EU — витрины ЕС. Строка возможности без региона относится ко всем витринам канала.
   */
  SELECT m.channel, m.marketplace, m.country, 'QUANTITY_SCOPE',
         c.write_scope_kind, c.write_scope_status, c.write_scope_question, c.write_scope_closes_by,
         coalesce(c.side_effects, 'область записи остатка объявлена возможностью канала')
    FROM platform.marketplace m
    JOIN platform.channel_capability c
      ON c.channel = m.channel AND c.field = 'QUANTITY' AND c.status = 'ACTIVE'
     AND (c.region IS NULL
          OR (c.region = 'NA' AND m.country IN ('US', 'CA', 'MX'))
          OR (c.region = 'EU' AND m.country NOT IN ('US', 'CA', 'MX')))
$fn$;
COMMENT ON FUNCTION platform.marketplace_readiness() IS
  'Р-172: ревизия свойств витрин — значение, статус и чем закрывается; значения собираются оттуда, где они живут';
GRANT EXECUTE ON FUNCTION platform.marketplace_readiness() TO repracer_app, repracer_admin, repracer_operator;
/**
 * Своих прав и политик этот шаг НЕ добавляет [Р-104, находка 8 ревью шага 42]: `repracer_admin` — член `repracer_app` с
 * наследованием, а у `repracer_app` право на справочники и политики `marketplace_read` / `capability_read` есть с 0034 и
 * 0027. Первая редакция выдала ещё и роли панели оператора — у неё не должно быть прав НИ НА ОДНУ таблицу [Р-165], и
 * ревизию она не читает вовсе. Свойство «роль без доступа к справочнику не включает бой» держит не право, а fail-closed
 * ветка правила: ноль видимых витрин — отказ.
 */

/**
 * Зубы Р-172 — ОДНО правило, два входа. Правило: у боевого аккаунта свойства ВСЕХ его витрин должны быть видны и не
 * должны быть неизвестны. Входов два, потому что состояние «боевой аккаунт с витриной, свойства которой неизвестны»
 * достигается двумя разными путями, и проверка только на переходе в бой закрывает один из них:
 *   1) перевод в бой (строка журнала) — страж `channel_write_mode_change_guard` ниже;
 *   2) ДОБАВЛЕНИЕ ВИТРИНЫ боевому аккаунту обычной правкой (`marketplaces` — изменяемый столбец, 0012) и создание
 *      аккаунта СРАЗУ боевым — страж `a_channel_account_live_marketplaces_known`. Это находка ревью шага 42: без него
 *      боевой аккаунт получал `amazon.com` одним UPDATE — без журнала, без второго фактора и без всякой проверки,
 *      то есть ровно то, что Р-172 объявляет невозможным.
 * Правило живёт в одной функции: две копии разошлись бы в первый же шаг [Р-104 по духу].
 */
CREATE FUNCTION security.marketplace_properties_unknown(p_channel text, p_marketplaces text[])
  RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $fn$
DECLARE
  u record;
BEGIN
  SELECT count(*) AS seen,
         count(*) FILTER (WHERE r.status = 'UNKNOWN') AS unknown,
         min(CASE WHEN r.status = 'UNKNOWN' THEN r.marketplace || ' / ' || r.property || ' (' || coalesce(r.question, 'вопрос не назван') || ')' END) AS first_unknown
    INTO u
    FROM platform.marketplace_readiness() r
   WHERE r.channel = p_channel AND r.marketplace = ANY (p_marketplaces);
  /**
   * fail-closed [инвариант 6]: витрины аккаунта должны быть ВИДНЫ. Ноль строк значит одно из двух — аккаунт не называет
   * ни одной витрины из справочника, или роль не видит справочник; в обоих случаях «неизвестных свойств нет» — неправда.
   */
  IF u.seen = 0 THEN
    RETURN 'свойства витрин не видны: ' || coalesce(array_to_string(p_marketplaces, ', '), 'витрины не названы');
  END IF;
  IF u.unknown > 0 THEN
    RETURN u.first_unknown;
  END IF;
  RETURN NULL;
END $fn$;
COMMENT ON FUNCTION security.marketplace_properties_unknown(text, text[]) IS
  'Р-172: NULL — свойства всех витрин известны; иначе текст с витриной, свойством и вопросом. Ноль видимых витрин — тоже отказ';
GRANT EXECUTE ON FUNCTION security.marketplace_properties_unknown(text, text[]) TO repracer_app, repracer_admin;

/**
 * Второй вход правила: боевой аккаунт не получает витрину с неизвестными свойствами ни правкой, ни при создании.
 * Тень при этом не ограничена ничем — витрину можно добавить и смотреть, что движок сделал бы.
 */
CREATE FUNCTION tenant_data.channel_account_live_marketplaces_known() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  detail text;
BEGIN
  IF NEW.write_mode <> 'LIVE' THEN
    RETURN NEW;
  END IF;
  detail := security.marketplace_properties_unknown(NEW.channel, NEW.marketplaces);
  IF detail IS NOT NULL THEN
    RAISE EXCEPTION 'marketplace property is unknown: % — LIVE writes stay closed while the shadow keeps working (Р-172)', detail
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_channel_account_live_marketplaces_known
  BEFORE INSERT OR UPDATE OF marketplaces, write_mode ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_live_marketplaces_known();


CREATE OR REPLACE FUNCTION tenant_data.channel_write_mode_change_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  m record;
  a record;
  unknown_detail text;
BEGIN
  SELECT mb.user_id, mb.role INTO m FROM tenant_data.membership mb
   WHERE mb.tenant_id = NEW.tenant_id AND mb.membership_id = NEW.changed_by_membership_id AND mb.status = 'ACTIVE';
  /**
   * «Человек в сессии есть» проверяет СТАНДАРТНЫЙ страж административной записи (`a0_admin_write_person_insert`), и его
   * случай сюда не попадает специально: иначе он отказывал бы дважды, и снятие стандартного стража ловилось бы этой
   * проверкой — соседней [Р-99, Р-104]. Здесь — только то, чего стандартный не знает: членство принадлежит ТОМУ человеку.
   */
  IF security.current_user_id() IS NOT NULL AND (m.user_id IS NULL OR m.user_id IS DISTINCT FROM security.current_user_id()) THEN
    RAISE EXCEPTION 'membership % is not the membership of the session user', NEW.changed_by_membership_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT ca.write_mode, ca.external_account_id, ca.channel, ca.marketplaces INTO a FROM tenant_data.channel_account ca
   WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = NEW.channel_account_id;
  -- Переход объявляется от ТЕКУЩЕГО режима: строка «из тени в бой», записанная у боевого аккаунта, — не история, а ложь
  IF NEW.from_mode IS DISTINCT FROM a.write_mode THEN
    RAISE EXCEPTION 'channel account % is in % mode, not in %', NEW.channel_account_id, a.write_mode, NEW.from_mode
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.to_mode = 'LIVE' THEN
    IF m.role <> 'OWNER' THEN
      RAISE EXCEPTION 'only the owner switches a channel account to LIVE writes (Р-170)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT security.session_mfa() THEN
      RAISE EXCEPTION 'switching to LIVE writes requires a second factor (Р-170, Р-88)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF btrim(NEW.typed_confirmation) IS DISTINCT FROM a.external_account_id THEN
      RAISE EXCEPTION 'the typed confirmation does not name the channel account (Р-170)' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- Р-172: то же правило, что у стража аккаунта, — одной функцией (неизвестное свойство держит БОЙ, а не тень)
    unknown_detail := security.marketplace_properties_unknown(a.channel, a.marketplaces);
    IF unknown_detail IS NOT NULL THEN
      RAISE EXCEPTION 'marketplace property is unknown: % — LIVE writes stay closed while the shadow keeps working (Р-172)',
        unknown_detail USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    NEW.mfa := true;
  ELSIF m.role NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'only the owner or an admin switches a channel account back to SHADOW (Р-170)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $fn$;

-- ================================================================ C. Р-173: дайджест говорит деньгами
/**
 * Поверх Р-117: «пол удержал цену N раз; без него вы продали бы на X дешевле». X считается из УЖЕ ХРАНИМЫХ столбцов
 * решения — предложенной цены и действующего пола, — и это РАЗНИЦА ЦЕН, а не прогноз выручки: купил бы покупатель по
 * более низкой цене или нет, мы не знаем и не обещаем (OQ-230 остаётся открытым).
 *
 * Суммы по каждой валюте ОТДЕЛЬНО [Р-71]: у тенанта с витринами ЕС и США евро и доллары складывать нельзя, и функция не
 * даёт этого сделать — она отдаёт список пар «валюта, сумма», а не число.
 */
CREATE FUNCTION platform.money_list_valid(p jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $fn$
  SELECT jsonb_typeof(p) = 'array' AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p) e
     WHERE jsonb_typeof(e) <> 'object'
        OR e->>'currency' IS NULL OR e->>'currency' !~ '^[A-Z]{3}$'
        OR jsonb_typeof(e->'minor') <> 'number' OR (e->>'minor')::numeric < 0
        OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 2)
$fn$;
COMMENT ON FUNCTION platform.money_list_valid(jsonb) IS
  'Р-71: список сумм — массив объектов {currency, minor}; сумма без валюты в базу не попадает';

/**
 * Сколько денег удержал пол — по каждой валюте, только по ТЕНЕВЫМ решениям окна [Р-173].
 *
 * Цель стратегии выведена из цены конкурента, и в решении её НЕТ: вечный слепок производных не хранит [Р-85], а горячий
 * слепок решения чистит от параметров класса CHANNEL сама база (0070). Она есть только в ГОРЯЧЕМ НАМЕРЕНИИ, и живёт три
 * суток [Р-28] — это же ограничение уже названо отчётом границ (Р-117, пробел FLOOR_HOLD_TARGET_WINDOW).
 *
 * Поэтому функция отдаёт ДВА числа: сумму по валютам и СКОЛЬКО удержаний в неё попало. Письмо говорит оба: «пол удержал
 * N раз, и у M из них цель ещё известна — это $X». Делить одно на другое и выдавать за неделю нельзя: это была бы
 * выдумка про те удержания, чью цель мы честно уже удалили.
 */
CREATE FUNCTION platform.shadow_floor_savings(p_tenant_id uuid, p_from timestamptz)
  RETURNS TABLE (savings jsonb, priced bigint)
  LANGUAGE sql STABLE SET search_path = pg_catalog AS $fn$
  /**
   * Окно приходит МОМЕНТОМ, а не интервалом (находка 4 ревью шага 42): экран считает своё окно от часов КОНСОЛИ (у живых
   * прогонов они виртуальные), письмо — от суток базы, и функция, считавшая `now() - интервал` сама, давала на экране
   * суммы по другому периоду, чем остальные его счётчики. Теперь окно одно на весь ответ, каким бы ни были часы.
   *
   * Снизу окно ограничено сроком ГОРЯЧЕГО НАМЕРЕНИЯ: старше трёх суток цели стратегии нет физически [Р-28], и проход по
   * суточным секциям за её пределами читал бы миллионы строк ради заведомого нуля (находка 9 ревью).
   */
  WITH held AS (
    SELECT i.currency,
           /**
            * Удержанная цена минус цель стратегии. Удержанная — `proposed_amount_minor` намерения: при `CAPPED_AT_MIN_PRICE`
            * это и есть пол, а при `TARGET_OUTSIDE_BOUNDS_HOLD` — цена, оставленная без изменения.
            */
           i.proposed_amount_minor - (step.params ->> 'targetMinor')::bigint AS below
      FROM channel_data.price_intent i
      JOIN channel_data.price_decision d
        ON d.tenant_id = i.tenant_id AND d.price_intent_id = i.price_intent_id AND d.intent_created_at = i.created_at
      CROSS JOIN LATERAL (
        SELECT e.value AS params
          FROM jsonb_array_elements(coalesce(i.rationale -> 'explanation', '[]'::jsonb)) x
          CROSS JOIN LATERAL (SELECT x -> 'params' AS value) e
         WHERE x ->> 'code' IN ('CAPPED_AT_MIN_PRICE', 'TARGET_OUTSIDE_BOUNDS_HOLD')
           AND x -> 'params' ? 'targetMinor'
         LIMIT 1) step
     WHERE i.tenant_id = p_tenant_id AND d.shadow
       AND i.created_at >= greatest(p_from, now() - interval '3 days')
       AND (step.params ->> 'targetMinor')::bigint < i.proposed_amount_minor
  )
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('currency', currency, 'minor', total) ORDER BY currency)
                     FROM (SELECT currency, sum(below)::bigint AS total FROM held GROUP BY currency) g), '[]'::jsonb),
         (SELECT count(*) FROM held)
$fn$;

DROP FUNCTION platform.shadow_digest_targets(interval);
CREATE FUNCTION platform.shadow_digest_targets(p_since interval DEFAULT interval '7 days')
  RETURNS TABLE (tenant_id uuid, tenant_name text, locale text, owner_email text, shadow_accounts bigint,
                 decisions bigint, changes bigint, floor_held bigint, ceiling_held bigint,
                 held_writes bigint, held_price_writes bigint, held_quantity_writes bigint, would_spend_budget bigint,
                 floor_savings jsonb, floor_savings_holds bigint, period_start timestamptz, period_end timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  /**
   * НАЧАЛО периода привязано к суткам, а не к моменту вызова. Иначе у каждого прогона свой период, и «одно письмо на
   * период» [Р-174] не значит ничего: два прогона подряд отправили бы два письма о тех же событиях (так и случилось в
   * первом живом прогоне шага 42). Конец — момент сборки письма: числа считаются по всему, что уже случилось.
   */
  WITH win AS (
    SELECT date_trunc('day', now()) - greatest(p_since, interval '1 hour') AS from_ts, now() AS to_ts
  ), shadowed AS (
    SELECT t.tenant_id, t.name, t.locale, count(*) AS accounts
      FROM tenant_data.tenant t
      JOIN tenant_data.channel_account ca ON ca.tenant_id = t.tenant_id
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND ca.disconnected_at IS NULL
       AND ca.write_mode = 'SHADOW' AND ca.auth_status = 'ACTIVE'
     GROUP BY t.tenant_id, t.name, t.locale
  )
  SELECT s.tenant_id, s.name, s.locale, security.tenant_owner_email(s.tenant_id), s.accounts,
         coalesce(d.decisions, 0), coalesce(d.changes, 0), coalesce(d.floor_held, 0), coalesce(d.ceiling_held, 0),
         coalesce(h.held, 0), coalesce(h.held_price, 0), coalesce(h.held_quantity, 0), coalesce(h.would_spend, 0),
         fs.savings, fs.priced, w.from_ts, w.to_ts
    FROM shadowed s
    CROSS JOIN win w
    CROSS JOIN LATERAL platform.shadow_floor_savings(s.tenant_id, w.from_ts) fs
    LEFT JOIN LATERAL (
      SELECT count(*) AS decisions,
             count(*) FILTER (WHERE pd.outcome = 'APPROVED') AS changes,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_floor_minor) AS floor_held,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_ceiling_minor) AS ceiling_held
        FROM channel_data.price_decision pd
       WHERE pd.tenant_id = s.tenant_id AND pd.shadow AND pd.decided_at >= w.from_ts) d ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS held,
             count(*) FILTER (WHERE wh.field <> 'QUANTITY') AS held_price,
             count(*) FILTER (WHERE wh.field = 'QUANTITY') AS held_quantity,
             count(*) FILTER (WHERE wh.would_spend_budget) AS would_spend
        FROM tenant_data.channel_write_history wh
       WHERE wh.tenant_id = s.tenant_id AND wh.final_status = 'SHADOW_HELD' AND wh.finished_at >= w.from_ts) h ON true
   ORDER BY s.name
$fn$;
REVOKE EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) TO repracer_alert_delivery;
/**
 * Владелец — роль удаления по сроку: у неё есть кросс-тенантные политики строк (0128). Обе новые функции ей и
 * принадлежат: роль доставки по-прежнему НЕ имеет ни одного права на `price_decision` — суммы она получает готовыми.
 * Граница «роль доставки не видит цен» сдвинулась осознанно: разница цен — АГРЕГАТ по тенанту, а не цена предложения.
 */
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;
/**
 * Функция сумм остаётся за владельцем схемы и правами ВЫЗЫВАЮЩЕГО: её зовут изнутри `shadow_digest_targets`, то есть уже
 * с правами роли удаления по сроку. Отдельным SECURITY DEFINER она была бы второй дверью к решениям о цене, а владение
 * ролью удаления без SECURITY DEFINER проверка схемы запрещает прямо (правило шага 19).
 */
REVOKE EXECUTE ON FUNCTION platform.shadow_floor_savings(uuid, timestamptz) FROM PUBLIC;
/**
 * Право звать функцию сумм есть у роли удаления (владелец функции дайджеста) и у АДМИНИСТРАТИВНОЙ роли — экран тени
 * показывает те же числа, что письмо [Р-171], и считает их тем же выражением. Роли доставки права НЕТ: ей суммы приходят
 * готовыми внутри `shadow_digest_targets`, и своего доступа к решениям о цене у неё по-прежнему нет [Р-100].
 */
GRANT EXECUTE ON FUNCTION platform.shadow_floor_savings(uuid, timestamptz) TO repracer_retention, repracer_admin;

-- ================================================================ D. Р-174: отметка доставки дайджеста
SET ROLE repracer_owner;

/**
 * Дайджест, живущий только в письме, — недоказанный: после простоя планировщика непонятно, ушло письмо за прошлую неделю
 * или нет, и второе письмо за тот же период отличить от первого нечем. Теперь у каждого периода СВОЯ СТРОКА (0130),
 * механизм тот же, что у алертов [Р-156]: время доставки, вид, ссылка провайдера, попытки, последняя ошибка.
 *
 * Числа письма хранятся вместе с отметкой: через месяц «что мы ему написали» нельзя пересчитать — окно уехало.
 */
CREATE TABLE tenant_data.shadow_digest (
  tenant_id     uuid NOT NULL,
  digest_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  decisions     bigint NOT NULL,
  changes       bigint NOT NULL,
  held_writes   bigint NOT NULL,
  floor_held    bigint NOT NULL,
  /** Р-173: разница цен по каждой валюте отдельно — «на сколько дешевле продали бы без пола» */
  floor_savings jsonb NOT NULL DEFAULT '[]'::jsonb,
  /**
   * Сколько удержаний попало в сумму. Это НЕ подмножество `floor_held`: «пол удержал» считается по решениям, где цена
   * села ровно на пол, а сумма — по намерениям, где стратегия хотела ниже пола и была удержана, в том числе оставлена
   * без изменения (`TARGET_OUTSIDE_BOUNDS_HOLD`). Поэтому ограничения «не больше floor_held» здесь НЕТ: живой прогон
   * шага 42 на него и упёрся, и это была ошибка ограничения, а не данных. Число хранится, чтобы через месяц было видно,
   * на чём считалась сумма; у части удержаний цель уже удалена по сроку [Р-85, Р-28].
   */
  floor_savings_holds bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  /** Пока NULL — дайджест НЕ доставлен, и это видно запросом [Р-174] */
  delivered_at  timestamptz,
  delivery_kind text,
  delivery_ref  text,
  delivery_attempts int NOT NULL DEFAULT 0,
  last_delivery_error text,
  PRIMARY KEY (tenant_id, digest_id),
  -- Один дайджест на период: второе письмо за ту же неделю отклоняет БАЗА, а не осторожность процесса
  CONSTRAINT shadow_digest_one_per_period UNIQUE (tenant_id, period_start),
  CONSTRAINT shadow_digest_period_sane CHECK (period_end > period_start),
  -- Одно ограничение на все числа строки: четыре отдельных были бы четырьмя строками каталога мутаций об одном и том же [Р-104]
  CONSTRAINT shadow_digest_numbers_non_negative
    CHECK (decisions >= 0 AND changes >= 0 AND held_writes >= 0 AND floor_held >= 0
       AND floor_savings_holds >= 0 AND delivery_attempts >= 0),
  CONSTRAINT shadow_digest_delivered_names_kind CHECK ((delivered_at IS NULL) = (delivery_kind IS NULL)),
  -- Третий вид — сухой режим [шаг 37]: письмо собрано целиком и не ушло никуда, и отметка говорит это прямо
  CONSTRAINT shadow_digest_delivery_kind_known CHECK (delivery_kind IN ('EMAIL_DIGEST', 'DRY_RUN')),
  -- Сумма без валюты в базу не попадает [Р-71]
  CONSTRAINT shadow_digest_savings_are_money CHECK (platform.money_list_valid(floor_savings))
);
COMMENT ON TABLE tenant_data.shadow_digest IS
  'Шаг 42 [Р-174]: недельный дайджест тени как СОБЫТИЕ с отметкой доставки; один на период (Р-156 тем же механизмом)';

SELECT security.register_table('tenant_data.shadow_digest', 'TENANT', 'mutable');
SELECT security.grant_retention('tenant_data.shadow_digest');
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.shadow_digest', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');

-- Недоставленные, свежие первыми: очередь доставки читается по этому индексу и не трогает доставленные
CREATE INDEX shadow_digest_undelivered_idx ON tenant_data.shadow_digest (period_start) WHERE delivered_at IS NULL;

/**
 * Числа письма неизменяемы: меняется ТОЛЬКО отметка доставки. Стражем `restrict_update` это НЕ дублируется [Р-104] — как
 * и у алерта (0120): писать строку может одна роль, и право у неё дано ПО СТОЛБЦАМ (ниже), так что переписать числа ей
 * нечем. Страж был бы защитой, которую нечем провалить [Р-94].
 */
/** Доставленная строка не меняется вообще, и время доставки ставит база, а не процесс со сбитыми часами */
CREATE FUNCTION tenant_data.shadow_digest_before_write() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.delivered_at IS NOT NULL THEN
      RAISE EXCEPTION 'a shadow digest cannot be recorded as already delivered (Р-174)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.delivered_at IS NOT NULL THEN
    RAISE EXCEPTION 'delivery of shadow digest % is already recorded (Р-174)', OLD.digest_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.delivered_at IS NOT NULL THEN NEW.delivered_at := now(); END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION tenant_data.shadow_digest_before_write() OWNER TO repracer_owner;
CREATE TRIGGER b_shadow_digest_before_write BEFORE INSERT OR UPDATE ON tenant_data.shadow_digest
  FOR EACH ROW EXECUTE FUNCTION tenant_data.shadow_digest_before_write();

RESET ROLE;

-- Роль доставки ведёт дайджест целиком: пишет строку периода и ставит отметку. Своих прав на решения у неё нет
CREATE POLICY shadow_digest_delivery_read ON tenant_data.shadow_digest FOR SELECT TO repracer_alert_delivery USING (true);
CREATE POLICY shadow_digest_delivery_write ON tenant_data.shadow_digest FOR INSERT TO repracer_alert_delivery WITH CHECK (true);
CREATE POLICY shadow_digest_delivery_mark ON tenant_data.shadow_digest FOR UPDATE TO repracer_alert_delivery USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenant_data.shadow_digest TO repracer_alert_delivery;
GRANT UPDATE (delivered_at, delivery_kind, delivery_ref, delivery_attempts, last_delivery_error)
  ON tenant_data.shadow_digest TO repracer_alert_delivery;
-- Продавец видит историю своих дайджестов на экране тени — и только видит: писать её административной роли нечем.
-- Права на запись приходят умолчанием схемы (0012), поэтому их снимают явно: иначе таблица становится «административной
-- записью» без объявленного действия, человека в сессии и строки аудита [Р-97, Р-100] — проверка схемы это и находит.
GRANT SELECT ON tenant_data.shadow_digest TO repracer_admin;
REVOKE INSERT, UPDATE ON tenant_data.shadow_digest FROM repracer_admin;

COMMIT;
