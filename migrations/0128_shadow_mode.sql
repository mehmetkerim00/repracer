-- 0128_shadow_mode.sql: теневой режим аккаунта канала (шаг 41) [Р-169, Р-170, Р-171].
--
-- Зачем. Первый живой канал подключает человек, который нам ещё не верит, — и правильно не верит: цену на витрине
-- меняет чужая программа. До этого шага единственным способом посмотреть, ЧТО она сделает, было дать ей писать.
--
-- Теневой режим: путь решения работает ЦЕЛИКОМ (снимки, проверка входов, стратегия, Gate, границы, объяснение), запись
-- создаётся — и завершается состоянием `SHADOW_HELD`, из которого в канал не уходит НИКОГДА. Это инвариант уровня Р-83,
-- и держат его три разных механизма, потому что путей отправки три:
--
--   1. ДИСПЕТЧЕР берёт записи со статусом `PENDING`. Теневая запись не бывает `PENDING`: страж вставки ставит ей
--      `SHADOW_HELD` сразу, и очередь её не видит вовсе.
--   2. ПРЯМАЯ ОТПРАВКА пути решения переводит запись в `DISPATCHED` сама — и не находит строки: теневая запись уже в
--      истории. Честно (находка 8 ревью шага 41): здесь работает не страж переходов, а ОТСУТСТВИЕ строки в очереди, и
--      путь решения узнаёт тень по этому же признаку; в базе свойство держит ограничение ИСТОРИИ записей «у удержанной
--      нет ни времени отправки, ни попыток».
--   3. ПОВТОР после отказа канала возвращает `FAILED → DISPATCHED`. Теневая запись не бывает `FAILED` (её никто не
--      отправлял), но аккаунт мог УЙТИ в тень, пока запись ждала: поэтому у перехода в `DISPATCHED` стоит отдельная
--      проверка режима аккаунта, и она отказывает своей причиной.
--
-- Р-171: в тени внешние бюджеты не расходуются — бюджет списывается при росте `attempt_count` у ОТПРАВЛЕННОЙ записи, а
-- её не бывает. Но «потратило бы» — факт, который продавец должен видеть, поэтому у записи есть признак.

BEGIN;

SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Режим записи аккаунта [Р-169, Р-170]
/**
 * Новый аккаунт подключается в ТЕНЬ [Р-170]: умолчание здесь — это решение продукта, а не удобство. Обратное умолчание
 * означало бы, что продавец, подключивший канал «посмотреть», получил бы изменённые цены на витрине.
 */
ALTER TABLE tenant_data.channel_account
  ADD COLUMN write_mode text NOT NULL DEFAULT 'SHADOW'
  CONSTRAINT channel_account_write_mode_known CHECK (write_mode IN ('SHADOW', 'LIVE'));
COMMENT ON COLUMN tenant_data.channel_account.write_mode IS
  'Шаг 41 [Р-169, Р-170]: SHADOW — путь решения работает целиком, но ни одна запись не уходит в канал; LIVE — записи идут. Новый аккаунт — SHADOW.';
-- Режим читает доставка писем: недельный дайджест тени [Р-171] уходит только по теневым аккаунтам
GRANT SELECT (write_mode) ON tenant_data.channel_account TO repracer_alert_delivery;

-- ---------------------------------------------------------------- 2. Состояние записи [Р-169]
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_status_check;
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_status_check CHECK (status = ANY (ARRAY[
    'PENDING', 'BLOCKED', 'DISPATCHED', 'ACCEPTED', 'APPLIED', 'NOT_APPLIED', 'FAILED',
    'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD']));
ALTER TABLE tenant_data.channel_write DROP CONSTRAINT channel_write_end_reason_known;
ALTER TABLE tenant_data.channel_write
  ADD CONSTRAINT channel_write_end_reason_known CHECK (end_reason IS NULL OR end_reason = ANY (ARRAY[
    'WRITE_SUPERSEDED_BY_NEWER_VERSION', 'WRITE_NOT_ACCEPTED_BY_CHANNEL', 'WRITE_RETRIES_EXHAUSTED',
    'WRITE_BLOCKED_BY_BOUND_RECHECK', 'CHANNEL_HALTED', 'CHANNEL_DISTRUSTED', 'PRICING_STOPPED',
    'WRITE_PRICING_MODE_CHANGED', 'WRITE_EDIT_BUDGET_EXHAUSTED', 'WRITE_BUDGET_DAY_UNCONFIRMED',
    'WRITE_HELD_IN_SHADOW']));

/**
 * «Потратило бы бюджет» [Р-171]. Бюджет правок eBay (250 на листинг в сутки) и лимиты записи в тени не расходуются —
 * расход привязан к попытке ОТПРАВКИ. Но продавцу важно знать цену перехода в бой: столько правок ушло бы в бюджет.
 * Признак ставит база при создании записи, а не приложение: иначе он был бы мнением процесса о себе самом.
 */
ALTER TABLE tenant_data.channel_write
  ADD COLUMN would_spend_budget boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_data.channel_write.would_spend_budget IS
  'Шаг 41 [Р-171]: запись удержана тенью и израсходовала бы внешний бюджет, будь режим боевым. У боевой записи всегда false — она бюджет тратит по-настоящему.';
/**
 * Ограничений «потратило бы только у тени» и «у удержанной нет следов отправки» на САМОЙ `channel_write` НЕТ намеренно
 * [Р-104, находка 8 ревью шага 41]: строки со статусом `SHADOW_HELD` в этой таблице не существует НИКОГДА — при вставке
 * её уносит в историю `ea_channel_write_complete_shadow`, при обновлении `e_channel_write_complete`. Провалить такие
 * ограничения нечем, а ветка, которую нечем провалить, — тавтология [Р-94]. Свойство держат близнецы на ИСТОРИИ записей,
 * и у них есть и проверки смоука, и строки каталога мутаций.
 */

-- История записей: то же состояние и тот же признак
ALTER TABLE tenant_data.channel_write_history DROP CONSTRAINT channel_write_history_final_status_check;
ALTER TABLE tenant_data.channel_write_history
  ADD CONSTRAINT channel_write_history_final_status_check CHECK (final_status = ANY (ARRAY[
    'APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD']));
ALTER TABLE tenant_data.channel_write_history DROP CONSTRAINT channel_write_history_end_explained;
ALTER TABLE tenant_data.channel_write_history
  ADD CONSTRAINT channel_write_history_end_explained CHECK (
    final_status <> ALL (ARRAY['SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD'])
    OR end_reason IS NOT NULL);
ALTER TABLE tenant_data.channel_write_history
  ADD COLUMN would_spend_budget boolean NOT NULL DEFAULT false;
ALTER TABLE tenant_data.channel_write_history
  ADD CONSTRAINT channel_write_history_would_spend_only_in_shadow CHECK (NOT would_spend_budget OR final_status = 'SHADOW_HELD');
ALTER TABLE tenant_data.channel_write_history
  ADD CONSTRAINT channel_write_history_shadow_never_left CHECK (final_status <> 'SHADOW_HELD'
    OR (dispatched_at IS NULL AND accepted_at IS NULL AND applied_at IS NULL AND attempt_count = 0));

-- Экран тени и дайджест читают удержанные записи за период по тенанту: свой индекс под этот запрос
CREATE INDEX channel_write_history_shadow_idx ON tenant_data.channel_write_history (tenant_id, finished_at)
  WHERE final_status = 'SHADOW_HELD';

/**
 * Р-171: последнее предложение, удержанное тенью. Без него движок сравнивал бы предложение с ценой НА ВИТРИНЕ, которая в
 * тени не двигается никогда, — и предлагал бы одно и то же на каждом опросе. Живой прогон шага 41 это и показал: 99
 * удержанных записей на предложение за сутки, экран в дублях и объём работы тени выше боевого в двадцать раз.
 */
-- Ограничения «сумма положительна» здесь нет намеренно [Р-104]: столбец пишет ТОЛЬКО страж вставки записи, из
-- `NEW.amount_minor`, у которого своё ограничение; провалить его нечем, а таблицу состояния ведут только триггеры
ALTER TABLE tenant_data.write_scope_sync_state
  ADD COLUMN last_shadow_amount_minor bigint;
COMMENT ON COLUMN tenant_data.write_scope_sync_state.last_shadow_amount_minor IS
  'Шаг 41 [Р-171]: последняя цена, УДЕРЖАННАЯ тенью. Не «отправлено» и не «подтверждено»: в канал она не уходила.';

-- ---------------------------------------------------------------- 3. Решение помечено тенью [Р-171]
/**
 * Признак тени у РЕШЕНИЯ, а не только у записи: режим аккаунта меняется, и завтра теневые решения стали бы выглядеть
 * боевыми. Ставит его база по режиму аккаунта — путь решения этот столбец не пишет (как `competitor_derived`, 0033).
 */
ALTER TABLE channel_data.price_decision
  ADD COLUMN shadow boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN channel_data.price_decision.shadow IS
  'Шаг 41 [Р-171]: решение принято в теневом режиме — цена посчитана целиком и в канал не ушла. Ставит база по режиму аккаунта.';

CREATE FUNCTION channel_data.price_decision_copy_shadow() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  SELECT ca.write_mode = 'SHADOW' INTO NEW.shadow
    FROM tenant_data.write_scope ws
    JOIN tenant_data.channel_account ca ON ca.tenant_id = ws.tenant_id AND ca.channel_account_id = ws.channel_account_id
   WHERE ws.tenant_id = NEW.tenant_id AND ws.write_scope_id = NEW.write_scope_id;
  IF NEW.shadow IS NULL THEN
    RAISE EXCEPTION 'write_scope % has no channel account: the shadow flag of the decision cannot be derived', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER ab_price_decision_copy_shadow BEFORE INSERT ON channel_data.price_decision
  FOR EACH ROW EXECUTE FUNCTION channel_data.price_decision_copy_shadow();

-- Сводка тени за период: решения по теневым аккаунтам читаются по этому индексу
CREATE INDEX price_decision_shadow_idx ON channel_data.price_decision (tenant_id, decided_at) WHERE shadow;

/**
 * Находка 9 ревью шага 41: признак тени жил только в горячем буфере решений (30 суток, Р-28), а ВЕЧНОЕ ядро [Р-38] его не
 * получало — через месяц теневое решение стало бы неотличимо от боевого, и архив ядра [Р-79] не объяснил бы себя. Ядро
 * получает тот же признак, и его ставит та же база, что и у решения.
 */
ALTER TABLE tenant_data.price_intent_core
  ADD COLUMN shadow boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN tenant_data.price_intent_core.shadow IS
  'Шаг 41 [Р-171]: решение принято в теневом режиме — цена посчитана целиком и в канал не ушла. Вечно, вместе с ядром.';

-- Тот же признак — в ВЕЧНОЕ ядро: функция переписывается целиком, как принято в наборе миграций
CREATE OR REPLACE FUNCTION channel_data.price_decision_record_core()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  hidden boolean;
BEGIN
  IF NEW.intent_class <> 'NO_OP' THEN
    hidden := NEW.competitor_derived AND NEW.intent_class = 'REJECTED_BY_GATE';
    INSERT INTO tenant_data.price_intent_core
      (tenant_id, price_intent_id, intent_created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version,
       trigger_type, rule_code, proposed_amount_minor, currency, price_basis, intent_class, price_decision_id,
       decision_outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, violations, decided_at,
       rejection_reason, reason_params, explanation, bound_deviation_bp, dangerous, sanity_ruleset, gate_profile, shadow)
    SELECT i.tenant_id, i.price_intent_id, i.created_at, i.write_scope_id, i.pricing_strategy_id, i.pricing_strategy_version,
           i.trigger_type, i.rule_code, CASE WHEN hidden THEN NULL ELSE i.proposed_amount_minor END, i.currency, i.price_basis, NEW.intent_class,
           NEW.price_decision_id, NEW.outcome, NEW.final_amount_minor, NEW.effective_floor_minor,
           NEW.effective_ceiling_minor, NEW.violations, NEW.decided_at, NEW.rejection_reason,
           CASE WHEN hidden THEN NEW.reason_params - security.channel_rule_derived_param_keys() ELSE NEW.reason_params END,
           NEW.explanation, CASE WHEN hidden THEN NULL ELSE NEW.bound_deviation_bp END, coalesce(NEW.bound_deviation_bp > 1000, false),
           NEW.sanity_ruleset, NEW.gate_profile, NEW.shadow
      FROM channel_data.price_intent i
     WHERE i.tenant_id = NEW.tenant_id AND i.created_at = NEW.intent_created_at
       AND i.price_intent_id = NEW.price_intent_id;
  END IF;
  RETURN NULL;
END $function$;

-- ---------------------------------------------------------------- 4. Три пути отправки и три отказа [Р-169]
CREATE OR REPLACE FUNCTION tenant_data.channel_write_before_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s           record;
  st          record;
BEGIN
  -- Блокировка единицы: смена режима цены не может пройти одновременно с созданием записи
  SELECT * INTO s FROM tenant_data.write_scope
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR SHARE;

  IF s.status = 'RETIRED' THEN
    RAISE EXCEPTION 'write_scope % is RETIRED', NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Р-12: minimum_price Kaufland — только в режиме Smart Pricing; наша цена — только в режиме ENGINE
  IF NEW.field = 'CHANNEL_MIN_PRICE' THEN
    IF s.field <> 'PRICE' OR s.pricing_mode <> 'KAUFLAND_SMART_PRICING' THEN
      RAISE EXCEPTION 'CHANNEL_MIN_PRICE may be written only in KAUFLAND_SMART_PRICING mode'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW.field <> s.field THEN
    RAISE EXCEPTION 'write field % does not match write_scope field %', NEW.field, s.field
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE' THEN
    RAISE EXCEPTION 'PRICE writes require pricing_mode ENGINE (scope is %)', s.pricing_mode
      USING ERRCODE = 'integrity_constraint_violation';
  ELSIF NEW.field = 'QUANTITY' AND NOT s.quantity_sync_enabled THEN
    RAISE EXCEPTION 'quantity sync is disabled for write_scope %', NEW.write_scope_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.field <> 'QUANTITY' THEN
    IF NEW.currency <> s.currency OR NEW.price_basis <> s.price_basis THEN
      RAISE EXCEPTION 'write currency/basis must match write_scope' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- INV-02, Р-83: значение не ниже пола, вычисленного заново: min_price и пол маржи по текущим себестоимости, комиссии,
    -- курсу ЕЦБ и ставке НДС
    PERFORM tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at creation');
  END IF;

  /**
   * Шаг 35 (найдено хранилищем остатков): проверка решения — ОТДЕЛЬНЫМ оператором внутри ветки PRICE, а не одним
   * выражением `field = 'PRICE' AND NOT EXISTS (… price_decision …)`. В одном выражении первые пять исполнений в сессии
   * идут по частному плану, где подзапрос свёрнут, а с шестого PL/pgSQL переходит на общий план — подзапрос остаётся,
   * и роль остатков [Р-105], у которой нет права читать price_decision, получала отказ на ШЕСТОЙ записи остатка в
   * сессии. Смоук вставлял не больше пяти и этого не видел.
   */
  IF NEW.field = 'PRICE' THEN
    IF NOT EXISTS (
         SELECT 1 FROM channel_data.price_decision d
          WHERE d.tenant_id = NEW.tenant_id AND d.price_decision_id = NEW.price_decision_id
            AND d.write_scope_id = NEW.write_scope_id
            AND d.outcome IN ('APPROVED', 'CLAMPED_FLOOR', 'CLAMPED_CEILING')
            AND d.final_amount_minor = NEW.amount_minor
            AND d.currency = NEW.currency AND d.price_basis = NEW.price_basis) THEN
      RAISE EXCEPTION 'PRICE write must equal an approved price_decision of the same write_scope'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  SELECT * INTO st FROM tenant_data.write_scope_sync_state
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  IF NEW.field = 'QUANTITY' THEN
    NEW.direction := CASE
      WHEN st.last_sent_quantity IS NULL        THEN 'INCREASE'
      WHEN NEW.quantity < st.last_sent_quantity THEN 'DECREASE'
      WHEN NEW.quantity > st.last_sent_quantity THEN 'INCREASE'
      ELSE 'SAME' END;
  ELSE
    NEW.direction := NULL;
  END IF;

  IF NEW.status <> 'PENDING' THEN
    RAISE EXCEPTION 'new channel_write must be PENDING' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- INV-14: в удержанной единице запись создаётся заблокированной, кроме уменьшения остатка
  IF s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE') THEN
    NEW.status := 'BLOCKED';
  END IF;

  /**
   * Р-169 (шаг 41): аккаунт в ТЕНИ — запись рождается завершённой. Это первый из трёх механизмов: диспетчер берёт из
   * очереди только `PENDING`, и теневой записи в очереди не бывает вовсе. Признак «потратило бы бюджет» [Р-171]
   * ставится здесь же: бюджет привязан к попытке отправки, а её не будет.
   */
  IF (SELECT ca.write_mode FROM tenant_data.channel_account ca
       WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = s.channel_account_id) = 'SHADOW' THEN
    NEW.status := 'SHADOW_HELD';
    NEW.end_reason := 'WRITE_HELD_IN_SHADOW';
    NEW.end_params := jsonb_build_object('channelAccountId', s.channel_account_id, 'wouldSpendBudget', NEW.budget_scope_key IS NOT NULL);
    NEW.would_spend_budget := NEW.budget_scope_key IS NOT NULL;
    NEW.finished_at := now();
    -- Последнее предложение тени: с ним движок и сравнивает следующее [Р-171]
    IF NEW.field <> 'QUANTITY' THEN
      UPDATE tenant_data.write_scope_sync_state SET last_shadow_amount_minor = NEW.amount_minor
       WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
    END IF;
  END IF;

  IF NEW.budget_scope_key IS DISTINCT FROM s.budget_scope_key THEN
    RAISE EXCEPTION 'budget_scope_key must match write_scope (%)', s.budget_scope_key
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- INV-03: версия строго больше последней созданной в единице записи
  UPDATE tenant_data.write_scope_sync_state
     SET latest_version_created = NEW.version
   WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
     AND latest_version_created < NEW.version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'version % is not greater than latest created version % of write_scope %',
      NEW.version, st.latest_version_created, NEW.write_scope_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.idempotency_key := encode(sha256(convert_to(
    concat_ws('|', NEW.tenant_id, s.channel_account_id, NEW.field, s.scope_key, NEW.version), 'UTF8')), 'hex');
  NEW.created_at := now();
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_before_update()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  s           record;
  st          record;
BEGIN
  IF NEW.status <> OLD.status AND (OLD.status, NEW.status) NOT IN (VALUES
       ('PENDING', 'DISPATCHED'), ('PENDING', 'SUPERSEDED'), ('PENDING', 'BLOCKED'),
       ('PENDING', 'DISCARDED_STALE'), ('PENDING', 'BUDGET_EXHAUSTED'),
       ('BLOCKED', 'PENDING'), ('BLOCKED', 'SUPERSEDED'), ('BLOCKED', 'DISCARDED_STALE'),
       ('DISPATCHED', 'ACCEPTED'), ('DISPATCHED', 'FAILED'), ('DISPATCHED', 'BUDGET_EXHAUSTED'),
       ('FAILED', 'DISPATCHED'), ('FAILED', 'DISCARDED_STALE'), ('FAILED', 'BUDGET_EXHAUSTED'),
       ('ACCEPTED', 'APPLIED'), ('ACCEPTED', 'NOT_APPLIED'),
       -- Шаг 41 [Р-169, Р-170]: возврат аккаунта в тень удерживает всё, что ещё не ушло. Обратного перехода из
       -- `SHADOW_HELD` НЕТ ни одного: удержанная тенью запись не оживает — включение боя даёт НОВЫЕ решения
       -- ТОЛЬКО из состояний, в которых запись НИКУДА не уходила. Уже отправленная (`FAILED` после отказа канала) в
       -- тень не переписывается: у неё есть время отправки и попытки, и `SHADOW_HELD` для неё был бы неправдой —
       -- она завершается как `DISCARDED_STALE` с той же причиной (см. применение перехода ниже)
       ('PENDING', 'SHADOW_HELD'), ('BLOCKED', 'SHADOW_HELD')) THEN
    RAISE EXCEPTION 'channel_write status transition % -> % is not allowed', OLD.status, NEW.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  SELECT * INTO s FROM tenant_data.write_scope WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;

  -- Выход из BLOCKED и отправка возможны только в незаблокированной единице (кроме уменьшения остатка)
  IF NEW.status IN ('PENDING', 'DISPATCHED') AND NEW.status <> OLD.status
     AND (s.status = 'RETIRED'
          OR (s.status IN ('HELD', 'CONTESTED', 'BLOCKED') AND NOT (NEW.field = 'QUANTITY' AND NEW.direction = 'DECREASE'))) THEN
    RAISE EXCEPTION 'write_scope % is %: write cannot proceed', s.write_scope_id, s.status
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.status = 'DISPATCHED' AND OLD.status <> 'DISPATCHED' THEN
    /**
     * Р-169 (шаг 41), третий механизм: аккаунт мог УЙТИ в тень, пока запись ждала отправки или повтора после отказа
     * канала. Проверяется режим на момент отправки, а не на момент создания: инвариант тут тот же, что у пола цены
     * [Р-83] — «перед КАЖДОЙ отправкой заново», и по той же причине.
     */
    IF (SELECT ca.write_mode FROM tenant_data.channel_account ca
         WHERE ca.tenant_id = NEW.tenant_id AND ca.channel_account_id = s.channel_account_id) = 'SHADOW' THEN
      RAISE EXCEPTION 'channel account % is in SHADOW mode: no write leaves the shadow (Р-169)', s.channel_account_id
        USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO st FROM tenant_data.write_scope_sync_state
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id FOR UPDATE;

    -- INV-03: отправляется только самая свежая версия; старое значение не может перезаписать новое
    IF NEW.version <> st.latest_version_created THEN
      RAISE EXCEPTION 'stale write: version % < latest created %', NEW.version, st.latest_version_created
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF st.in_flight_write_id IS NOT NULL AND st.in_flight_write_id <> NEW.channel_write_id THEN
      RAISE EXCEPTION 'write_scope % already has in-flight write %', NEW.write_scope_id, st.in_flight_write_id
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (NEW.field = 'PRICE' AND s.pricing_mode <> 'ENGINE')
       OR (NEW.field = 'CHANNEL_MIN_PRICE' AND s.pricing_mode <> 'KAUFLAND_SMART_PRICING') THEN
      RAISE EXCEPTION 'pricing_mode changed to %: write cannot be dispatched', s.pricing_mode
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- INV-02, Р-83: пол вычисляется заново перед КАЖДОЙ отправкой (первая попытка и повторы): min_price и пол маржи
    IF NEW.field <> 'QUANTITY' THEN
      NEW.floor_at_dispatch_minor := tenant_data.assert_price_floor(NEW.tenant_id, NEW.write_scope_id, NEW.amount_minor, 'at dispatch');
    END IF;

    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_dispatched = greatest(latest_version_dispatched, NEW.version),
           in_flight_write_id = NEW.channel_write_id
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
    NEW.dispatched_at := coalesce(NEW.dispatched_at, now());
  END IF;

  -- Р-19: каждая попытка расходует бюджет до отправки; превышение лимита отклоняет обновление
  IF NEW.attempt_count <> OLD.attempt_count THEN
    IF NEW.attempt_count < OLD.attempt_count OR NEW.status <> 'DISPATCHED' THEN
      RAISE EXCEPTION 'attempt_count may only grow while DISPATCHED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.budget_scope_key IS NOT NULL THEN
      PERFORM tenant_data.consume_edit_budget(
        NEW.tenant_id, s.channel_account_id, NEW.budget_scope_key, NEW.budget_day,
        s.capability_id, s.capability_version,
        CASE WHEN NEW.field <> 'QUANTITY' THEN 'PRICE'
             WHEN NEW.direction = 'DECREASE' THEN 'QUANTITY_DECREASE'
             ELSE 'QUANTITY' END,
        NEW.attempt_count - OLD.attempt_count);
    END IF;
  END IF;

  IF NEW.status = 'ACCEPTED' AND OLD.status <> 'ACCEPTED' THEN
    NEW.accepted_at := coalesce(NEW.accepted_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_accepted = greatest(latest_version_accepted, NEW.version),
           last_sent_amount_minor  = CASE WHEN NEW.field <> 'QUANTITY' THEN NEW.amount_minor ELSE last_sent_amount_minor END,
           last_sent_quantity      = CASE WHEN NEW.field = 'QUANTITY' THEN NEW.quantity ELSE last_sent_quantity END,
           -- Синхронные каналы: запись завершена; асинхронные: в полёте до APPLIED/NOT_APPLIED
           in_flight_write_id      = CASE WHEN s.processing_mode = 'SYNC' AND in_flight_write_id = NEW.channel_write_id
                                          THEN NULL ELSE in_flight_write_id END
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status = 'APPLIED' AND OLD.status <> 'APPLIED' THEN
    NEW.applied_at := coalesce(NEW.applied_at, now());
    UPDATE tenant_data.write_scope_sync_state
       SET latest_version_applied = greatest(latest_version_applied, NEW.version)
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id;
  END IF;

  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'FAILED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD')
     AND NEW.status <> OLD.status THEN
    UPDATE tenant_data.write_scope_sync_state
       SET in_flight_write_id = NULL
     WHERE tenant_id = NEW.tenant_id AND write_scope_id = NEW.write_scope_id
       AND in_flight_write_id = NEW.channel_write_id;
    IF NEW.status <> 'FAILED' THEN
      NEW.finished_at := coalesce(NEW.finished_at, now());
    END IF;
  END IF;

  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION tenant_data.channel_write_complete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  /**
   * Шаг 41 [Р-169]: теневая запись завершена УЖЕ ПРИ ВСТАВКЕ, поэтому у этой функции появился вход по INSERT. Путь в
   * историю остаётся ОДИН [Р-145]: второй обработчик «почти такой же» разошёлся бы с этим в первый же шаг.
   */
  IF NEW.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD')
     AND (TG_OP = 'INSERT' OR NEW.status <> OLD.status) THEN
    INSERT INTO tenant_data.channel_write_history
      (tenant_id, channel_write_id, finished_at, write_scope_id, field, amount_minor, currency, price_basis, quantity,
       version, origin, price_decision_id, direction, final_status, attempt_count, budget_scope_key, budget_day, would_spend_budget,
       floor_at_dispatch_minor, trigger_received_at, created_at, dispatched_at, accepted_at, applied_at,
       end_reason, end_params, superseded_by_write_id, last_error_code)
    VALUES
      (NEW.tenant_id, NEW.channel_write_id, coalesce(NEW.finished_at, now()), NEW.write_scope_id, NEW.field,
       NEW.amount_minor, NEW.currency, NEW.price_basis, NEW.quantity, NEW.version, NEW.origin, NEW.price_decision_id,
       NEW.direction, NEW.status, NEW.attempt_count, NEW.budget_scope_key, NEW.budget_day, NEW.would_spend_budget, NEW.floor_at_dispatch_minor,
       NEW.trigger_received_at, NEW.created_at, NEW.dispatched_at, NEW.accepted_at, NEW.applied_at,
       NEW.end_reason, NEW.end_params, NEW.superseded_by_write_id, NEW.last_error_code);
    DELETE FROM channel_data.write_submission
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
    DELETE FROM tenant_data.channel_write
     WHERE tenant_id = NEW.tenant_id AND channel_write_id = NEW.channel_write_id;
  END IF;
  RETURN NULL;
END $function$;

-- Тень завершается при вставке: тот же обработчик, что завершает боевую запись [Р-145]
CREATE TRIGGER ea_channel_write_complete_shadow AFTER INSERT ON tenant_data.channel_write
  FOR EACH ROW WHEN (NEW.status = 'SHADOW_HELD') EXECUTE FUNCTION tenant_data.channel_write_complete();

/**
 * Удаление завершённой записи (строка ушла в историю) пропускается только из обработчика завершения. Список состояний
 * пополняется тенью: без этого удержанная тенью запись осталась бы в очереди навсегда — в истории и в очереди сразу.
 */
CREATE OR REPLACE FUNCTION tenant_data.channel_write_delete_guard() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF current_user = 'repracer_retention'
     OR (pg_trigger_depth() >= 2
         AND OLD.status IN ('APPLIED', 'NOT_APPLIED', 'SUPERSEDED', 'DISCARDED_STALE', 'BUDGET_EXHAUSTED', 'SHADOW_HELD')) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'channel_write rows are removed only on completion' USING ERRCODE = 'insufficient_privilege';
END $fn$;

-- ---------------------------------------------------------------- 5. Переключение режима [Р-170]
/**
 * Переключение — это ДЕЙСТВИЕ ЧЕЛОВЕКА, и записано оно строкой журнала, как остановка цен [Р-76]: у столбца аккаунта
 * своего автора и своего времени нет, а у перехода в бой они обязаны быть. Применяет переход триггер этой же строки —
 * прямой UPDATE столбца отклоняется (страж ниже).
 *
 * Направления разные НАМЕРЕННО [Р-170]: в бой — владелец, со вторым фактором и набранным подтверждением; в тень — одним
 * действием, без подтверждений. Тень безопасна, и требовать церемонию на безопасном направлении значит учить продавца
 * бояться кнопки, которая его защищает.
 */
CREATE TABLE tenant_data.channel_write_mode_change (
  tenant_id                uuid NOT NULL,
  change_id                uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_account_id       uuid NOT NULL,
  /**
   * Ограничения на список у `from_mode` НЕТ намеренно [Р-104, находка 2 ревью шага 41]: страж сверяет его с ТЕКУЩИМ
   * режимом аккаунта и отказывает раньше любого списка — провалить список нечем. У `to_mode` список есть: его страж не
   * сверяет ни с чем, и «перевести в режим MAYBE» иначе прошло бы.
   */
  from_mode                text NOT NULL,
  /**
   * Списка у `to_mode` НЕТ намеренно [Р-104, находка ревью шага 41]: режим из строки журнала ЛОЖИТСЯ на аккаунт, и там
   * его отвергает `channel_account_write_mode_known` — своя проверка у этого ограничения есть, а у списка здесь она
   * совпадала бы с ним, то есть мутация ловилась бы соседней защитой.
   */
  to_mode                  text NOT NULL,
  changed_by_membership_id uuid NOT NULL,
  /** Набранный продавцом текст: внешний идентификатор аккаунта. Только у перехода в бой */
  typed_confirmation       text,
  mfa                      boolean NOT NULL DEFAULT false,
  note                     text,
  changed_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, change_id),
  FOREIGN KEY (tenant_id, channel_account_id) REFERENCES tenant_data.channel_account (tenant_id, channel_account_id),
  FOREIGN KEY (tenant_id, changed_by_membership_id) REFERENCES tenant_data.membership (tenant_id, membership_id),
  CONSTRAINT channel_write_mode_change_direction CHECK (from_mode <> to_mode),
  -- Подтверждение и второй фактор — свойство НАПРАВЛЕНИЯ, а не настроение вызывающего
  CONSTRAINT channel_write_mode_change_live_confirmed CHECK ((to_mode = 'LIVE') = (typed_confirmation IS NOT NULL))
  /**
   * Ограничения «в бой — только со вторым фактором» здесь НЕТ намеренно [Р-104]: признак `mfa` ставит СТРАЖ (он же его и
   * требует), поэтому провалить такое ограничение нечем — оно было бы истинно всегда, а ветка, которую нечем провалить,
   * тавтология [Р-94]. Второй фактор проверяется отказом стража, и у этого отказа своя строка каталога мутаций.
   */
);
COMMENT ON TABLE tenant_data.channel_write_mode_change IS
  'Шаг 41 [Р-170]: переключение аккаунта между тенью и боем — действие человека со автором, временем и подтверждением.';
SELECT security.register_table('tenant_data.channel_write_mode_change', 'TENANT', 'append_only');
SELECT security.grant_retention('tenant_data.channel_write_mode_change');
-- Данные тенанта по времени не удаляются [ADR-0004]: журнал переключений живёт до закрытия тенанта
INSERT INTO maintenance.retention_policy (table_name, method, bound)
VALUES ('tenant_data.channel_write_mode_change', 'TENANT_CLOSURE_ONLY', 'MAX_AGE');
-- Экран тени показывает, когда и кем режим менялся: последние переключения аккаунта
CREATE INDEX channel_write_mode_change_account_idx ON tenant_data.channel_write_mode_change (tenant_id, channel_account_id, changed_at DESC);

/**
 * Кто переключает. В бой — ТОЛЬКО владелец, от своего имени, со вторым фактором и с набранным внешним идентификатором
 * аккаунта: это то же требование, что у согласия на миграцию eBay [Р-101], и по той же причине — действие необратимо по
 * последствиям (цены на витрине изменятся). В тень — владелец или администратор, без второго фактора.
 */
CREATE FUNCTION tenant_data.channel_write_mode_change_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
DECLARE
  m record;
  a record;
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

  SELECT ca.write_mode, ca.external_account_id INTO a FROM tenant_data.channel_account ca
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
    NEW.mfa := true;
  ELSIF m.role NOT IN ('OWNER', 'ADMIN') THEN
    RAISE EXCEPTION 'only the owner or an admin switches a channel account back to SHADOW (Р-170)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER b_channel_write_mode_change_guard BEFORE INSERT ON tenant_data.channel_write_mode_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_mode_change_guard();

/**
 * Применение перехода. Уход в ТЕНЬ удерживает всё, что ещё не ушло: ждущие и отказавшие записи этого аккаунта
 * завершаются `SHADOW_HELD`. Без этого возврат в тень оставлял бы очередь, которую диспетчер попытался бы отправить, и
 * отказ пришёл бы записью в журнал ошибок вместо честного «остановились».
 */
CREATE FUNCTION tenant_data.channel_write_mode_apply() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  UPDATE tenant_data.channel_account SET write_mode = NEW.to_mode
   WHERE tenant_id = NEW.tenant_id AND channel_account_id = NEW.channel_account_id;
  IF NEW.to_mode = 'SHADOW' THEN
    -- Ждущие записи НИКУДА не уходили — их удерживает тень
    UPDATE tenant_data.channel_write w
       SET status = 'SHADOW_HELD', end_reason = 'WRITE_HELD_IN_SHADOW',
           end_params = jsonb_build_object('channelAccountId', NEW.channel_account_id, 'modeChangeId', NEW.change_id),
           -- Находка 10 ревью шага 41: признак ставился только при вставке, и две одинаковые записи получали разное
           -- «потратило бы» в зависимости от того, КОГДА аккаунт ушёл в тень
           would_spend_budget = w.budget_scope_key IS NOT NULL,
           next_attempt_at = NULL
      FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = w.tenant_id AND ws.write_scope_id = w.write_scope_id
       AND w.tenant_id = NEW.tenant_id AND ws.channel_account_id = NEW.channel_account_id
       AND w.status IN ('PENDING', 'BLOCKED');
    /**
     * Запись, которая УЖЕ уходила и получила отказ канала, тенью не помечается: у неё есть время отправки и попытки, и
     * `SHADOW_HELD` для неё был бы неправдой. Она завершается с той же ПРИЧИНОЙ — повторов у неё больше не будет, и
     * продавец видит в ленте отказ, а не «удержано тенью».
     */
    UPDATE tenant_data.channel_write w
       SET status = 'DISCARDED_STALE', end_reason = 'WRITE_HELD_IN_SHADOW',
           end_params = jsonb_build_object('channelAccountId', NEW.channel_account_id, 'modeChangeId', NEW.change_id),
           next_attempt_at = NULL
      FROM tenant_data.write_scope ws
     WHERE ws.tenant_id = w.tenant_id AND ws.write_scope_id = w.write_scope_id
       AND w.tenant_id = NEW.tenant_id AND ws.channel_account_id = NEW.channel_account_id
       AND w.status = 'FAILED';
  END IF;
  RETURN NULL;
END $fn$;
CREATE TRIGGER c_channel_write_mode_apply AFTER INSERT ON tenant_data.channel_write_mode_change
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_mode_apply();

/**
 * Столбец режима меняет только строка журнала. Без этого стража административная роль переключала бы аккаунт в бой
 * обычным UPDATE — без автора, без второго фактора и без подтверждения, то есть мимо всего Р-170.
 */
CREATE FUNCTION tenant_data.channel_account_write_mode_only_from_journal() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog AS $fn$
BEGIN
  IF NEW.write_mode IS DISTINCT FROM OLD.write_mode AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'write_mode is changed by a row of tenant_data.channel_write_mode_change, not directly (Р-170)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER a_channel_account_write_mode_only_from_journal BEFORE UPDATE OF write_mode ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_account_write_mode_only_from_journal();

-- Список изменяемых столбцов аккаунта (0012) пополняется режимом: без него страж `restrict_update` отклонял бы и
-- применение строки журнала — «столбец менять нельзя» вместо «меняется только журналом»
DROP TRIGGER channel_account_restrict_update ON tenant_data.channel_account;
CREATE TRIGGER channel_account_restrict_update BEFORE UPDATE ON tenant_data.channel_account
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('display_name', 'marketplaces', 'known_other_marketplaces',
    'credentials_ref', 'auth_status', 'access_token_expires_at', 'authorization_expires_at', 'granted_scopes',
    'disconnected_at', 'write_mode');

-- Право на столбец [Р-100]: переключение ведёт административная роль, и только этот столбец ей для него нужен
GRANT UPDATE (write_mode) ON tenant_data.channel_account TO repracer_admin;


/**
 * Недельный дайджест тени [Р-171]: кому и что писать. Функция отдаёт ТОЛЬКО ЧИСЛА, имя тенанта, его язык [Р-161] и адрес
 * владельца — ни одной цены и ни одного идентификатора предложения.
 *
 * Права — ПРАВАМИ ВЫЗЫВАЮЩЕГО (как `security.tenant_owner_email`, 0120), а не SECURITY DEFINER от владельца схемы: у
 * владельца таблиц политик строк нет (RLS FORCE смотрит и на него), и первая редакция этой функции молча отдавала ноль
 * строк — живой прогон шага 41 это и показал. Поэтому роль доставки получает СВОИ узкие права по столбцам [Р-100]:
 * `shadow`, `outcome`, `decided_at` у решения и `final_status`, `field`, `would_spend_budget`, `finished_at` у истории
 * записей. Цен, сумм, товаров и единиц записи в этом списке нет — «сколько раз», а не «какая цена».
 */
CREATE FUNCTION platform.shadow_digest_targets(p_since interval DEFAULT interval '7 days')
  RETURNS TABLE (tenant_id uuid, tenant_name text, locale text, owner_email text, shadow_accounts bigint,
                 decisions bigint, changes bigint, floor_held bigint, ceiling_held bigint,
                 held_writes bigint, held_price_writes bigint, held_quantity_writes bigint, would_spend_budget bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $fn$
  WITH shadowed AS (
    SELECT t.tenant_id, t.name, t.locale, count(*) AS accounts
      FROM tenant_data.tenant t
      JOIN tenant_data.channel_account ca ON ca.tenant_id = t.tenant_id
     -- Тенант ПРОБНЫЙ или действующий: умолчание статуса — `TRIAL`, и именно пробный тенант чаще всего и сидит в тени
     -- (первая редакция этой функции требовала `ACTIVE` и не находила никого — живой прогон шага 41 это показал)
     -- Находка 11 ревью шага 41: канал БЕЗ ДОСТУПОВ писать не может в принципе [Р-150], и «ведёт канал в тени» о нём —
     -- неправда. В цели дайджеста идут только аккаунты, которым тень действительно что-то запрещает
     WHERE t.status IN ('TRIAL', 'ACTIVE') AND t.kind = 'CUSTOMER' AND ca.disconnected_at IS NULL
       AND ca.write_mode = 'SHADOW' AND ca.auth_status = 'ACTIVE'
     GROUP BY t.tenant_id, t.name, t.locale
  )
  SELECT s.tenant_id, s.name, s.locale, security.tenant_owner_email(s.tenant_id), s.accounts,
         coalesce(d.decisions, 0), coalesce(d.changes, 0), coalesce(d.floor_held, 0), coalesce(d.ceiling_held, 0),
         coalesce(h.held, 0), coalesce(h.held_price, 0), coalesce(h.held_quantity, 0), coalesce(h.would_spend, 0)
    FROM shadowed s
    LEFT JOIN LATERAL (
      -- Находка 3 ревью шага 41: исходов CLAMPED_* не бывает [Р-44] — «пол удержал» значит «цена пришла ровно на пол»
      SELECT count(*) AS decisions,
             count(*) FILTER (WHERE pd.outcome = 'APPROVED') AS changes,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_floor_minor) AS floor_held,
             count(*) FILTER (WHERE pd.final_amount_minor IS NOT NULL AND pd.final_amount_minor = pd.effective_ceiling_minor) AS ceiling_held
        FROM channel_data.price_decision pd
       WHERE pd.tenant_id = s.tenant_id AND pd.shadow AND pd.decided_at >= now() - greatest(p_since, interval '1 hour')) d ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS held,
             count(*) FILTER (WHERE wh.field <> 'QUANTITY') AS held_price,
             count(*) FILTER (WHERE wh.field = 'QUANTITY') AS held_quantity,
             count(*) FILTER (WHERE wh.would_spend_budget) AS would_spend
        FROM tenant_data.channel_write_history wh
       WHERE wh.tenant_id = s.tenant_id AND wh.final_status = 'SHADOW_HELD'
         AND wh.finished_at >= now() - greatest(p_since, interval '1 hour')) h ON true
   ORDER BY s.name
$fn$;
REVOKE EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.shadow_digest_targets(interval) TO repracer_alert_delivery;

-- Никаких прав на таблицы роли доставки шаг не добавляет: всё, что ей нужно, — позвать функцию выше [Р-100, Р-156]

RESET ROLE;

/**
 * Владелец функции дайджеста — РОЛЬ УДАЛЕНИЯ ПО СРОКУ: у неё есть кросс-тенантные политики строк на все нужные таблицы
 * (она их чистит), и писем она не отправляет. Роль доставки получает только право позвать функцию — ни одного столбца
 * решений, записей и аккаунтов ей не выдано (находка 12 ревью шага 41).
 */
ALTER FUNCTION platform.shadow_digest_targets(interval) OWNER TO repracer_retention;
/**
 * Адрес владельца функция берёт тем же способом, что доставка алертов (0120). `security.tenant_owner_email` работает
 * ПРАВАМИ ВЫЗЫВАЮЩЕГО, поэтому роли удаления по сроку нужны те же два чтения, что и роли доставки: членства и адреса. У
 * неё уже есть политики на всё (она чистит данные тенанта), недостаёт только прав на столбцы.
 */
GRANT EXECUTE ON FUNCTION security.tenant_owner_email(uuid) TO repracer_retention;
GRANT SELECT (user_id, email) ON platform.app_user TO repracer_retention;
-- Политика строк: у роли удаления по сроку её на пользователях не было (она их не чистит), а адрес владельца нужен
CREATE POLICY retention_owner_email_read ON platform.app_user FOR SELECT TO repracer_retention USING (true);

-- ---------------------------------------------------------------- 7. Административная запись: действие и его стражи
-- Р-97, Р-100: у таблицы объявлено действие (свой страж ролей), запись — только при пользователе сессии и вся в аудите
CREATE OR REPLACE FUNCTION security.admin_write_action(p_table text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT a FROM (VALUES
    ('tenant_data.tenant', 'MANAGE_TENANT'), ('tenant_data.channel_account', 'MANAGE_TENANT'), ('tenant_data.inbound_api_key', 'MANAGE_CATALOG'),
    ('tenant_data.channel_capability_override', 'MANAGE_TENANT'), ('tenant_data.price_daily_correction', 'MANAGE_TENANT'),
    ('tenant_data.write_scope', 'ENABLE_REPRICING'),
    ('tenant_data.cost_profile', 'MANAGE_PRICING'), ('tenant_data.min_price', 'MANAGE_PRICING'), ('tenant_data.max_price', 'MANAGE_PRICING'),
    ('tenant_data.cost_import', 'MANAGE_PRICING'),
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
    ('tenant_data.discount_announcement', 'MANAGE_PRICING'),
    ('tenant_data.bulk_job', 'VIEW_PRICING'),
    -- Шаг 34 [Р-149]: путь ведёт тот, кто вправе править цены
    ('tenant_data.onboarding_progress', 'MANAGE_PRICING'),
    -- Шаг 41 [Р-170]: у журнала переключений теневого режима СВОЙ страж ролей (владелец в бой, владелец или администратор в тень)
    ('tenant_data.channel_write_mode_change', 'OWN_GUARD'),
    ('tenant_data.price_stop', 'OWN_GUARD'), ('channel_data.pricing_halt_review', 'OWN_GUARD'), ('tenant_data.membership', 'OWN_GUARD'),
    ('channel_data.pricing_halt_sample', 'OWN_GUARD')
  ) AS t(tbl, a) WHERE tbl = p_table
$function$;

CREATE TRIGGER a0_admin_write_person_insert BEFORE INSERT ON tenant_data.channel_write_mode_change
  FOR EACH ROW EXECUTE FUNCTION security.require_person_for_admin_write();
CREATE TRIGGER zc_channel_write_mode_change_audit AFTER INSERT ON tenant_data.channel_write_mode_change
  FOR EACH ROW EXECUTE FUNCTION security.audit_admin_write();


-- ---------------------------------------------------------------- 8. Реестр параметров причин и список причин NO_OP
/**
 * Находка 1 ревью шага 41 — КРИТИЧНАЯ: новая причина `SHADOW_ALREADY_PROPOSED` не была объявлена базе, и она отвергала
 * КАЖДОЕ решение NO_OP теневого мира ограничением `price_decision_no_change_reason_code` (пять кодов с шага 13). Это тот
 * же класс, что шаг 23 уже ловил на ClickHouse: код есть в модели, а база о нём не знает.
 *
 * Здесь: причина добавлена в список кодов NO_OP, и оба реестра параметров (ключи и виды значений, 0099) знают её и
 * причину завершения записи `WRITE_HELD_IN_SHADOW` — иначе слепок объяснения отклонялся бы fail-closed [Р-85].
 */
ALTER TABLE channel_data.price_decision DROP CONSTRAINT price_decision_no_change_reason_code;
ALTER TABLE channel_data.price_decision
  ADD CONSTRAINT price_decision_no_change_reason_code CHECK (no_change_reason = ANY (ARRAY[
    'ALREADY_AT_TARGET', 'WITHIN_DEADBAND', 'ALREADY_WINNING_BUYBOX', 'NO_COMPETITOR_OFFERS',
    'TARGET_OUTSIDE_BOUNDS_HOLD', 'SHADOW_ALREADY_PROPOSED']));

CREATE OR REPLACE FUNCTION security.eternal_param_keys() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT '{"ABOVE_MAX_PRICE":["currency","deviationBp","maxMinor","proposedMinor","source"],"ALREADY_AT_TARGET":["currency"],"ALREADY_WINNING_BUYBOX":[],"APPROVED":["ceilingMinor","currency","finalMinor","floorMinor"],"BELOW_MARGIN_FLOOR":["currency","deviationBp","floorMinor","minMarginBp","minMinor","proposedMinor"],"BELOW_MIN_PRICE":["currency","deviationBp","minMinor","proposedMinor","source"],"BOUNDS_INVALID":["currency","maxMinor","minMinor"],"BOUNDS_INVERTED":["currency","maxMinor","minMinor"],"BOUNDS_VERSION_CHANGED":["attempt","changed","currency","newMaxMinor","newMinMinor","oldMaxMinor","oldMinMinor"],"BOUND_CURRENCY_MISMATCH":["bound","boundBasis","boundCurrency","cause","scopeBasis","scopeCurrency"],"BOUND_UNRESOLVABLE":["bound","boundBasis","boundCurrency","cause","minMarginBp","scopeBasis","scopeCurrency"],"BUYBOX_MATCH":["currency"],"BUYBOX_UNDERCUT":["currency"],"CAPPED_AT_MAX_PRICE":["currency","maxMinor"],"CAPPED_AT_MIN_PRICE":["currency","minMinor"],"CHANGE_RATE_LIMIT":["changes","limit"],"CHANNEL_DISTRUSTED":["detectedAt","distrustId","distrustReason","marketplace","stage"],"CHANNEL_HALTED":["haltId","haltReason","haltedAt","marketplace","ruleCode","stage"],"CHANNEL_MASS_SHIFT":["maxSpread","windowMinutes"],"CHANNEL_PRICE_BASIS_MISMATCH":["basisError","currency","marketplace","sentMinor","vatRateBp","writeScopeId"],"COMPETITOR_REQUIREMENT_NOT_MET":["maxStalenessSeconds","requiredCompleteness","requiredN"],"COST_INPUTS_MISSING":["missing"],"COST_NOT_DECLARED":[],"COST_REQUIRED":["cause"],"CROSS_CHANNEL_FX_UNAVAILABLE":["cause","channel","currency","expected","marketplace"],"CROSS_CHANNEL_MISMATCH":["currency","field","fxFrom","fxRateDate","fxRateMicros","limit","referenceStorefronts"],"CURRENCY_MISMATCH":["expected","field"],"DISPERSED_MARKET_EVENT":["maxSpread"],"DIVERGENCE_CASE_OPENED":["currency","expectedMinor"],"ENGINE_CURRENCY_MISMATCH":["expected","source"],"FIXED_PRICE":["currency","targetMinor"],"HALT_AUTO_RELEASED":["haltId","sampleSize"],"HALT_MANUALLY_RELEASED":["haltId","membershipId","note"],"HALT_REVIEW_FAILED":["failed","haltId","nextReviewAt","sampleSize"],"HISTORY_AVAILABLE":[],"HISTORY_TOO_SHORT":["minHistoryDays"],"INCONSISTENT_SNAPSHOT":["currency","inconsistency"],"INTENT_EXPIRED":["createdAt","decidedAt","expiresAt","waitedSeconds"],"INTENT_INVALID":["problem"],"INTERNAL_BOUND_VIOLATION":["amountMinor","ceilingMinor","check","currency","floorMinor"],"INTERNAL_OUTLIER_IGNORED":["currency"],"INVALID_AMOUNT":["currency","field"],"INVALID_STRATEGY_PARAMS":["allowed","currency","param","settingBp","settingMinor"],"LOWEST_MATCH":["currency","scope"],"LOWEST_UNDERCUT":["currency","scope"],"MARGIN_TARGET":["currency","marginBp","targetMinor"],"MARGIN_UNATTAINABLE":["currency","feeRateBp","fixedFeeMinor","marginBp","unitCostMinor","vatRateBp"],"MARGIN_WITHOUT_COST":["cause","minMarginBp","requiredBy","strategyType"],"MARKET_SHIFT_DISPERSED":["maxSpread","windowMinutes"],"MARKET_SHIFT_SINGLE_SELLER":["maxSpread","windowMinutes"],"MAX_PRICE_MISSING":[],"MIN_PRICE_MISSING":[],"NO_CHANGE":[],"NO_COMPETITOR_OFFERS":[],"NO_FRESH_CROSS_CHANNEL_REFERENCE":["maxAgeSeconds"],"NO_PLAUSIBILITY_ANCHOR":["costDeclared","minHistoryDays","minOffers"],"NO_PREVIOUS_SNAPSHOT":[],"NO_SCALE_REFERENCE":[],"NO_SCOPE_FOR_PRODUCT":["writeScopeId"],"OUTSIDE_HISTORY_BAND":["bandFactor","currency","field"],"OUT_OF_ORDER":[],"OWN_PRICE_DEVIATION":["currency","field","limit","ourPriceMinor"],"PRICE_ABOVE_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICE_BASIS_MISMATCH":["expected","field"],"PRICE_BELOW_COST_ANCHOR":["costMinor","currency","field","limit"],"PRICING_STOPPED":["channelAccountId","marketplace","scope","stage","stopId","stoppedAt","stoppedBy"],"REFERENCES_CONVERTED_AT_ECB":["currency","fxFrom","fxRateDate","fxRateMicros"],"REFERENCES_WITHOUT_ECB_RATE":[],"SCOPE_NOT_ACTIVE":["action","blockedByErrorCode","blockedSince","mode","status"],"SCOPE_NOT_ENGINE":["mode"],"SELF_OFFER_DIVERGENCE":["currency","limit","ourPriceMinor"],"SHADOW_ALREADY_PROPOSED":["currency","heldMinor","proposedMinor"],"SHIFT_BELOW_SHARE":["minProducts","share"],"SINGLE_SELLER_MARKET_EVENT":[],"SMALL_MOVE":["minFactor"],"SNAPSHOT_FROM_FUTURE":["maxSkewSeconds"],"SNAPSHOT_INTERNAL_OUTLIER":["currency","outlierFactor"],"SNAPSHOT_TOO_OLD":["maxAgeSeconds"],"STEP_LIMIT":["currency","currentMinor","limitBp","proposedMinor","stepBp"],"STRATEGY_MISSING":[],"TARGET_OUTSIDE_BOUNDS_HOLD":["currency","maxMinor","minMinor"],"TOO_FEW_COMPETITOR_OFFERS":["minOffers"],"UNIT_SCALE_X0_01":["anchor","currency","field"],"UNIT_SCALE_X100":["anchor","currency","field"],"WITHIN_DEADBAND":["currency","deadbandMinor"],"WRITE_BLOCKED_BY_BOUND_RECHECK":["amountMinor","cause","ceilingMinor","currency","floorMinor","marginFloorMinor","minMarginBp","minMinor","violated"],"WRITE_BUDGET_DAY_UNCONFIRMED":["marketplace"],"WRITE_EDIT_BUDGET_EXHAUSTED":["budgetDay","limit","resetsAt","source","timeZone","used"],"WRITE_HELD_IN_SHADOW":["channelAccountId"],"WRITE_NOT_ACCEPTED_BY_CHANNEL":["errorClass","status"],"WRITE_OUTCOME_RECONCILED":["result"],"WRITE_PRICING_MODE_CHANGED":["mode"],"WRITE_QUEUED_BEHIND_IN_FLIGHT":["inFlightWriteId"],"WRITE_RETRIES_EXHAUSTED":["attempts","code"],"WRITE_RETRY_SCHEDULED":["at","attempt","code"],"WRITE_SCOPE_BLOCKED":["action","code"],"WRITE_SUPERSEDED_BY_NEWER_VERSION":["newerVersion","newerWriteId"]}'::jsonb
$fn$;

CREATE OR REPLACE FUNCTION security.eternal_param_kinds() RETURNS jsonb
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT '{"ABOVE_MAX_PRICE":{"source":{"k":"enum","v":["GATE","DATABASE"]},"currency":{"k":"currency"},"maxMinor":{"k":"money","n":true},"deviationBp":{"k":"bp"},"proposedMinor":{"k":"money","n":true}},"ALREADY_AT_TARGET":{"currency":{"k":"currency"}},"ALREADY_WINNING_BUYBOX":{},"APPROVED":{"currency":{"k":"currency"},"finalMinor":{"k":"money"},"floorMinor":{"k":"money"},"ceilingMinor":{"k":"money"}},"BELOW_MARGIN_FLOOR":{"currency":{"k":"currency"},"minMinor":{"k":"money"},"floorMinor":{"k":"money"},"deviationBp":{"k":"bp"},"minMarginBp":{"k":"bp"},"proposedMinor":{"k":"money"}},"BELOW_MIN_PRICE":{"source":{"k":"enum","v":["GATE","DATABASE"]},"currency":{"k":"currency"},"minMinor":{"k":"money","n":true},"deviationBp":{"k":"bp"},"proposedMinor":{"k":"money","n":true}},"BOUNDS_INVALID":{"currency":{"k":"currency"},"maxMinor":{"k":"money","n":true},"minMinor":{"k":"money","n":true}},"BOUNDS_INVERTED":{"currency":{"k":"currency"},"maxMinor":{"k":"money"},"minMinor":{"k":"money"}},"BOUNDS_VERSION_CHANGED":{"attempt":{"k":"count"},"changed":{"k":"enumList","v":["MIN_PRICE","MAX_PRICE","CHANNEL_HALT","CHANNEL_DISTRUST","PRICING_STOP"]},"currency":{"k":"currency"},"newMaxMinor":{"k":"money","n":true},"newMinMinor":{"k":"money","n":true},"oldMaxMinor":{"k":"money","n":true},"oldMinMinor":{"k":"money","n":true}},"BOUND_CURRENCY_MISMATCH":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"boundBasis":{"k":"enum","n":true,"v":["GROSS","NET"]},"scopeBasis":{"k":"enum","v":["GROSS","NET"]},"boundCurrency":{"k":"currency","n":true},"scopeCurrency":{"k":"currency"}},"BOUND_UNRESOLVABLE":{"bound":{"k":"enum","v":["min","max","margin_floor","both"]},"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"boundBasis":{"k":"enum","v":["GROSS","NET"]},"scopeBasis":{"k":"enum","v":["GROSS","NET"]},"minMarginBp":{"k":"bp"},"boundCurrency":{"k":"currency"},"scopeCurrency":{"k":"currency"}},"BUYBOX_MATCH":{"currency":{"k":"currency"}},"BUYBOX_UNDERCUT":{"currency":{"k":"currency"}},"CAPPED_AT_MAX_PRICE":{"currency":{"k":"currency"},"maxMinor":{"k":"money"}},"CAPPED_AT_MIN_PRICE":{"currency":{"k":"currency"},"minMinor":{"k":"money"}},"CHANGE_RATE_LIMIT":{"limit":{"k":"count"},"changes":{"k":"count"}},"CHANNEL_DISTRUSTED":{"stage":{"k":"enum","v":["INPUT","GATE","DISPATCH","DATABASE"]},"detectedAt":{"k":"instant"},"distrustId":{"k":"id"},"marketplace":{"k":"id","n":true},"distrustReason":{"k":"enum","v":["PRICE_BASIS_MISMATCH"]}},"CHANNEL_HALTED":{"stage":{"k":"enum","v":["INPUT","GATE","DISPATCH","DATABASE"]},"haltId":{"k":"id"},"haltedAt":{"k":"instant"},"ruleCode":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST","POSITION"]},"haltReason":{"k":"enum","v":["CHANNEL_MASS_SHIFT"]},"marketplace":{"k":"id","n":true}},"CHANNEL_MASS_SHIFT":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"CHANNEL_PRICE_BASIS_MISMATCH":{"currency":{"k":"currency"},"sentMinor":{"k":"money"},"vatRateBp":{"k":"bp"},"basisError":{"k":"enum","v":["TAX_ADDED","TAX_REMOVED"]},"marketplace":{"k":"id"},"writeScopeId":{"k":"id"}},"COMPETITOR_REQUIREMENT_NOT_MET":{"requiredN":{"k":"count","n":true},"maxStalenessSeconds":{"k":"seconds","n":true},"requiredCompleteness":{"k":"enum","n":true,"v":["TOP_N","CHEAPEST_ONLY","FULL"]}},"COST_INPUTS_MISSING":{"missing":{"k":"enum","v":["COST_PROFILE","VAT_RATE"]}},"COST_NOT_DECLARED":{},"COST_REQUIRED":{"cause":{"k":"enum","v":["COST_PROFILE_MISSING","FEE_ESTIMATE_MISSING","VAT_RATE_MISSING","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]}},"CROSS_CHANNEL_FX_UNAVAILABLE":{"cause":{"k":"enum","v":["FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]},"channel":{"k":"enum","v":["KAUFLAND","AMAZON","EBAY","OTTO"]},"currency":{"k":"currency"},"expected":{"k":"currency"},"marketplace":{"k":"id"}},"CROSS_CHANNEL_MISMATCH":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"fxFrom":{"k":"currency"},"currency":{"k":"currency"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"},"referenceStorefronts":{"k":"storefrontList"}},"CURRENCY_MISMATCH":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"expected":{"k":"currency"}},"DISPERSED_MARKET_EVENT":{"maxSpread":{"k":"ratio"}},"DIVERGENCE_CASE_OPENED":{"currency":{"k":"currency"},"expectedMinor":{"k":"money"}},"ENGINE_CURRENCY_MISMATCH":{"source":{"k":"enum","v":["SNAPSHOT","COST"]},"expected":{"k":"currency"}},"FIXED_PRICE":{"currency":{"k":"currency"},"targetMinor":{"k":"money"}},"HALT_AUTO_RELEASED":{"haltId":{"k":"id"},"sampleSize":{"k":"count"}},"HALT_MANUALLY_RELEASED":{"note":{"k":"userText"},"haltId":{"k":"id"},"membershipId":{"k":"id"}},"HALT_REVIEW_FAILED":{"failed":{"k":"count"},"haltId":{"k":"id"},"sampleSize":{"k":"count"},"nextReviewAt":{"k":"instant"}},"HISTORY_AVAILABLE":{},"HISTORY_TOO_SHORT":{"minHistoryDays":{"k":"count"}},"INCONSISTENT_SNAPSHOT":{"currency":{"k":"currency"},"inconsistency":{"k":"enum","v":["OFFER_TOTAL_NOT_PRICE_PLUS_SHIPPING","MORE_OFFERS_THAN_TOP_N","BUYBOX_NOT_RANK_ONE_PRICE"]}},"INTENT_EXPIRED":{"createdAt":{"k":"instant"},"decidedAt":{"k":"instant"},"expiresAt":{"k":"instant"},"waitedSeconds":{"k":"seconds"}},"INTENT_INVALID":{"problem":{"k":"enum","v":["WRITE_SCOPE_MISMATCH","CURRENCY_OR_BASIS_MISMATCH","NON_POSITIVE_AMOUNT"]}},"INTERNAL_BOUND_VIOLATION":{"check":{"k":"enum","v":["CURRENT_WITHIN_BOUNDS","FINAL_RECHECK"]},"currency":{"k":"currency"},"floorMinor":{"k":"money"},"amountMinor":{"k":"money","n":true},"ceilingMinor":{"k":"money"}},"INTERNAL_OUTLIER_IGNORED":{"currency":{"k":"currency"}},"INVALID_AMOUNT":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"currency":{"k":"currency"}},"INVALID_STRATEGY_PARAMS":{"param":{"k":"enum","v":["deadbandMinor","priceMinor","targetMarginBp","undercutMinor"]},"allowed":{"k":"enum","v":["POSITIVE","NON_NEGATIVE","MARGIN_BELOW_100_PERCENT"]},"currency":{"k":"currency"},"settingBp":{"k":"bp","n":true},"settingMinor":{"k":"money","n":true}},"LOWEST_MATCH":{"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]},"currency":{"k":"currency"}},"LOWEST_UNDERCUT":{"scope":{"k":"enum","v":["VISIBLE_TOP_N","MARKET"]},"currency":{"k":"currency"}},"MARGIN_TARGET":{"currency":{"k":"currency"},"marginBp":{"k":"bp"},"targetMinor":{"k":"money"}},"MARGIN_UNATTAINABLE":{"currency":{"k":"currency"},"marginBp":{"k":"bp"},"feeRateBp":{"k":"bp"},"vatRateBp":{"k":"bp","n":true},"fixedFeeMinor":{"k":"money"},"unitCostMinor":{"k":"money"}},"MARGIN_WITHOUT_COST":{"cause":{"k":"enum","v":["COST_PROFILE_MISSING","FEE_ESTIMATE_MISSING","VAT_RATE_MISSING","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","INVALID_INPUT"]},"requiredBy":{"k":"enumList","v":["STRATEGY","MIN_MARGIN"]},"minMarginBp":{"k":"bp","n":true},"strategyType":{"k":"enum","v":["FIXED","TARGET_MARGIN","MATCH_BUYBOX","BEAT_LOWEST"]}},"MARKET_SHIFT_DISPERSED":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"MARKET_SHIFT_SINGLE_SELLER":{"maxSpread":{"k":"ratio"},"windowMinutes":{"k":"minutes"}},"MAX_PRICE_MISSING":{},"MIN_PRICE_MISSING":{},"NO_CHANGE":{},"NO_COMPETITOR_OFFERS":{},"NO_FRESH_CROSS_CHANNEL_REFERENCE":{"maxAgeSeconds":{"k":"seconds"}},"NO_PLAUSIBILITY_ANCHOR":{"minOffers":{"k":"count"},"costDeclared":{"k":"bool"},"minHistoryDays":{"k":"count"}},"NO_PREVIOUS_SNAPSHOT":{},"NO_SCALE_REFERENCE":{},"NO_SCOPE_FOR_PRODUCT":{"writeScopeId":{"k":"id"}},"OUTSIDE_HISTORY_BAND":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"currency":{"k":"currency"},"bandFactor":{"k":"ratio"}},"OUT_OF_ORDER":{},"OWN_PRICE_DEVIATION":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"currency":{"k":"currency"},"ourPriceMinor":{"k":"money"}},"PRICE_ABOVE_COST_ANCHOR":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"currency":{"k":"currency"},"costMinor":{"k":"money"}},"PRICE_BASIS_MISMATCH":{"field":{"k":"enum","v":["BUYBOX_PRICE","SUGGESTED_PRICE","OFFER_PRICE","OFFER_SHIPPING","OFFER_TOTAL","OBSERVED_AT"]},"expected":{"k":"enum","v":["GROSS","NET"]}},"PRICE_BELOW_COST_ANCHOR":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"limit":{"k":"ratio"},"currency":{"k":"currency"},"costMinor":{"k":"money"}},"PRICING_STOPPED":{"scope":{"k":"enum","v":["TENANT","CHANNEL_ACCOUNT","STOREFRONT"]},"stage":{"k":"enum","v":["GATE","DISPATCH","DATABASE"]},"stopId":{"k":"id"},"stoppedAt":{"k":"instant"},"stoppedBy":{"k":"id"},"marketplace":{"k":"id","n":true},"channelAccountId":{"k":"id","n":true}},"REFERENCES_CONVERTED_AT_ECB":{"fxFrom":{"k":"currency"},"currency":{"k":"currency"},"fxRateDate":{"k":"date"},"fxRateMicros":{"k":"rateMicros"}},"REFERENCES_WITHOUT_ECB_RATE":{},"SCOPE_NOT_ACTIVE":{"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]},"action":{"k":"enum","n":true,"v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS","DISABLE_CHANNEL_REPRICER","REMOVE_CHANNEL_BOUNDS"]},"status":{"k":"enum","v":["ACTIVE","HELD","CONTESTED","BLOCKED","RETIRED"]},"blockedSince":{"k":"instant","n":true},"blockedByErrorCode":{"k":"enum","n":true,"v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]}},"SCOPE_NOT_ENGINE":{"mode":{"k":"enum","n":true,"v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"SELF_OFFER_DIVERGENCE":{"limit":{"k":"ratio"},"currency":{"k":"currency"},"ourPriceMinor":{"k":"money"}},"SHADOW_ALREADY_PROPOSED":{"proposedMinor":{"k":"money"},"heldMinor":{"k":"money"},"currency":{"k":"currency"}},"SHIFT_BELOW_SHARE":{"share":{"k":"ratio"},"minProducts":{"k":"count"}},"SINGLE_SELLER_MARKET_EVENT":{},"SMALL_MOVE":{"minFactor":{"k":"ratio"}},"SNAPSHOT_FROM_FUTURE":{"maxSkewSeconds":{"k":"seconds"}},"SNAPSHOT_INTERNAL_OUTLIER":{"currency":{"k":"currency"},"outlierFactor":{"k":"ratio"}},"SNAPSHOT_TOO_OLD":{"maxAgeSeconds":{"k":"seconds"}},"STEP_LIMIT":{"stepBp":{"k":"bp"},"limitBp":{"k":"bp"},"currency":{"k":"currency"},"currentMinor":{"k":"money"},"proposedMinor":{"k":"money"}},"STRATEGY_MISSING":{},"TARGET_OUTSIDE_BOUNDS_HOLD":{"currency":{"k":"currency"},"maxMinor":{"k":"money"},"minMinor":{"k":"money"}},"TOO_FEW_COMPETITOR_OFFERS":{"minOffers":{"k":"count"}},"UNIT_SCALE_X0_01":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"}},"UNIT_SCALE_X100":{"field":{"k":"enum","v":["buybox","lowest","suggested"]},"anchor":{"k":"enum","v":["COST","CROSS_CHANNEL","HISTORY","LAST_ACCEPTED"]},"currency":{"k":"currency"}},"WITHIN_DEADBAND":{"currency":{"k":"currency"},"deadbandMinor":{"k":"money"}},"WRITE_BLOCKED_BY_BOUND_RECHECK":{"cause":{"k":"enum","v":["MISSING","CURRENCY_MISMATCH","BASIS_MISMATCH","INVALID_AMOUNT","MIN_ABOVE_MAX","COST_PROFILE_MISSING","COST_CURRENCY_MISMATCH","VAT_UNKNOWN","UNATTAINABLE","INVALID_INPUT","MARGIN_FLOOR_ABOVE_MAX_PRICE","FX_RATE_UNAVAILABLE","FX_RATE_STALE","UNSUPPORTED_CURRENCY","FEE_ESTIMATE_MISSING"]},"currency":{"k":"currency"},"minMinor":{"k":"money"},"violated":{"k":"enum","v":["FLOOR","CEILING","FLOOR_UNRESOLVABLE"]},"floorMinor":{"k":"money","n":true},"amountMinor":{"k":"money"},"minMarginBp":{"k":"bp"},"ceilingMinor":{"k":"money","n":true},"marginFloorMinor":{"k":"money"}},"WRITE_BUDGET_DAY_UNCONFIRMED":{"marketplace":{"k":"id"}},"WRITE_EDIT_BUDGET_EXHAUSTED":{"used":{"k":"count"},"limit":{"k":"count"},"source":{"k":"enum","v":["CHANNEL","DATABASE"]},"resetsAt":{"k":"instant","n":true},"timeZone":{"k":"id","n":true},"budgetDay":{"k":"date"}},"WRITE_HELD_IN_SHADOW":{"channelAccountId":{"k":"id"}},"WRITE_NOT_ACCEPTED_BY_CHANNEL":{"status":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"errorClass":{"k":"enum","v":["TRANSIENT","PERMANENT","REQUIRES_HUMAN"]}},"WRITE_OUTCOME_RECONCILED":{"result":{"k":"enum","v":["APPLIED","NOT_APPLIED"]}},"WRITE_PRICING_MODE_CHANGED":{"mode":{"k":"enum","v":["OFF","ENGINE","KAUFLAND_SMART_PRICING"]}},"WRITE_QUEUED_BEHIND_IN_FLIGHT":{"inFlightWriteId":{"k":"id"}},"WRITE_RETRIES_EXHAUSTED":{"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"attempts":{"k":"count"}},"WRITE_RETRY_SCHEDULED":{"at":{"k":"instant"},"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"attempt":{"k":"count"}},"WRITE_SCOPE_BLOCKED":{"code":{"k":"enum","v":["RATE_LIMITED","CHANNEL_UNAVAILABLE","TIMEOUT","NETWORK","AUTH_INVALID","AUTH_EXPIRED","ACCOUNT_INACTIVE","FORBIDDEN","VALIDATION","NOT_FOUND","DUPLICATE_ACTION","STALE_VERSION","ACTION_NOT_ALLOWED","PRECONDITION_FAILED","EDIT_BUDGET_EXHAUSTED","OFFER_NOT_LIVE","POLICY_VIOLATION","TENANT_MISMATCH","SIGNATURE_INVALID","UNSUPPORTED","UNKNOWN","CHANNEL_REPRICER_ACTIVE","CHANNEL_BOUNDS_PRESENT","MAX_ATTEMPTS","NOT_APPLIED","SCOPE_HELD","SCOPE_CONTESTED","SCOPE_BLOCKED","SCOPE_RETIRED","OUTCOME_UNRESOLVED"]},"action":{"k":"enum","v":["RECONNECT_ACCOUNT","CHECK_ACCOUNT_STATUS","CHECK_LISTING","REVIEW_CHANNEL_POLICY","CONTACT_CHANNEL_SUPPORT","REVIEW_OFFER_STATUS","DISABLE_CHANNEL_REPRICER","REMOVE_CHANNEL_BOUNDS"]}},"WRITE_SUPERSEDED_BY_NEWER_VERSION":{"newerVersion":{"k":"count"},"newerWriteId":{"k":"id"}}}'::jsonb
$fn$;

-- ---------------------------------------------------------------- 6. Закрытие тенанта уносит журнал переключений
-- Правило 0102 проверяет это само: без строки в очистке проверка схемы не проходит. Функция переписывается целиком
CREATE OR REPLACE FUNCTION maintenance.purge_tenant_data(p_tenant_id uuid, p_delete_price_history boolean DEFAULT false)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  t         text;
  n         bigint;
  total     bigint := 0;
  closed_ts timestamptz;
BEGIN
  SELECT closed_at INTO closed_ts FROM tenant_data.tenant
   WHERE tenant_id = p_tenant_id AND kind = 'CUSTOMER' AND status = 'CLOSED';
  IF closed_ts IS NULL THEN
    RAISE EXCEPTION 'tenant % must be a CLOSED CUSTOMER', p_tenant_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM maintenance.tenant_purge_status
                  WHERE subject_tenant_id = p_tenant_id AND postgres_channel_purged_at IS NOT NULL) THEN
    RAISE EXCEPTION 'purge channel data first (maintenance.purge_tenant_channel_data)';
  END IF;
  IF NOT p_delete_price_history
     AND (EXISTS (SELECT 1 FROM tenant_data.price_daily WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_history WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.discount_announcement WHERE tenant_id = p_tenant_id)
          OR EXISTS (SELECT 1 FROM tenant_data.price_intent_core WHERE tenant_id = p_tenant_id)) THEN
    RAISE EXCEPTION 'tenant % has price evidence; deletion requires explicit confirmation (OQ-22)', p_tenant_id;
  END IF;

  INSERT INTO legal.migration_consent_record
    (tenant_id, migration_consent_id, channel_account_id, channel_external_account_id, consenting_user_id,
     consenting_role, mfa_verified_at, disclosure_version, disclosure_text_sha256, other_tools_declaration,
     other_tools_list, typed_confirmation, given_at, expires_at, revoked_at, items, tenant_closed_at)
  SELECT c.tenant_id, c.migration_consent_id, c.channel_account_id, ca.external_account_id, c.user_id,
         m.role, c.mfa_verified_at, c.disclosure_version, c.disclosure_text_sha256, c.other_tools_declaration,
         c.other_tools_list, c.typed_confirmation, c.given_at, c.expires_at, r.revoked_at,
         coalesce((SELECT jsonb_agg(jsonb_build_object(
                     'listing_id', i.listing_id,
                     'listing_snapshot_sha256', encode(i.listing_snapshot_sha256, 'hex'),
                     'verdict_at_consent', i.verdict_at_consent,
                     'acknowledged_losses', to_jsonb(i.acknowledged_losses)))
                     FROM tenant_data.migration_consent_item i
                    WHERE i.tenant_id = c.tenant_id AND i.migration_consent_id = c.migration_consent_id), '[]'::jsonb),
         closed_ts
    FROM tenant_data.migration_consent c
    JOIN tenant_data.channel_account ca ON ca.tenant_id = c.tenant_id AND ca.channel_account_id = c.channel_account_id
    JOIN tenant_data.membership m ON m.tenant_id = c.tenant_id AND m.membership_id = c.membership_id
    LEFT JOIN tenant_data.migration_consent_revocation r
      ON r.tenant_id = c.tenant_id AND r.migration_consent_id = c.migration_consent_id
   WHERE c.tenant_id = p_tenant_id
  ON CONFLICT (tenant_id, migration_consent_id) DO NOTHING;

  FOREACH t IN ARRAY ARRAY[
    -- Шаг 34 [Р-149]: прогресс онбординга — данные тенанта
    -- Шаг 36 [Р-156]: алерты тенанта уходят вместе с ним
    -- Шаг 41 [Р-170]: журнал переключений теневого режима — данные тенанта, уходят вместе с ним
    'tenant_data.channel_write_mode_change',
    'tenant_data.alert',
    'tenant_data.onboarding_progress',
    -- Шаг 30 [Р-139]: задания массовых операций и их файлы — данные тенанта; удаляются раньше членства, на которое ссылаются
    'tenant_data.bulk_job_artifact', 'tenant_data.bulk_job',
    'tenant_data.outbox_event', 'tenant_data.price_history_not_applied', 'tenant_data.price_history_applied', 'tenant_data.price_history', 'tenant_data.price_daily_correction', 'tenant_data.price_daily_system_correction',
    'tenant_data.price_daily', 'tenant_data.price_intent_core',
    'tenant_data.channel_write_history', 'tenant_data.channel_write', 'tenant_data.edit_budget',
    'tenant_data.migration_consent_revocation', 'tenant_data.migration_consent_item', 'tenant_data.migration_consent',
    'tenant_data.stock_movement', 'tenant_data.stock_allocation', 'tenant_data.stock_pool',
    'tenant_data.inbound_api_key', 'tenant_data.stock_source',
    -- Остановки цен человеком: тоже данные тенанта, удалялись только вместе с базой (найдено правилом проверки схемы шага 26)
    'tenant_data.price_stop',
    'tenant_data.min_price', 'tenant_data.max_price', 'tenant_data.product_vat_rate', 'tenant_data.guardrail', 'tenant_data.divergence_policy',
    'tenant_data.cost_profile', 'tenant_data.cost_import',
    'tenant_data.discount_announcement', 'tenant_data.offer_mapping', 'tenant_data.write_scope_sync_state', 'tenant_data.write_scope',
    'tenant_data.pricing_strategy', 'tenant_data.channel_capability_override', 'tenant_data.channel_account',
    'tenant_data.bundle_component', 'tenant_data.product', 'tenant_data.membership']
  LOOP
    EXECUTE format('DELETE FROM %s WHERE tenant_id = $1', t) USING p_tenant_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;

  UPDATE tenant_data.tenant SET name = 'closed tenant' WHERE tenant_id = p_tenant_id;
  UPDATE maintenance.tenant_purge_status
     SET postgres_tenant_purged_at = now(),
         legal_hold_until = CASE WHEN EXISTS (SELECT 1 FROM legal.migration_consent_record WHERE tenant_id = p_tenant_id)
                                 THEN (closed_ts + interval '3 years')::date END
   WHERE subject_tenant_id = p_tenant_id;
  INSERT INTO maintenance.retention_run (table_name, action, rows_affected, subject_tenant_id)
  VALUES ('tenant_data.*', 'TENANT_PURGED', total, p_tenant_id);
  RETURN total;
END $function$;

COMMIT;
