-- 0171_write_queue_statistics.sql
-- Шаг 66 (OQ-247): план поисков очереди записей не зависит от того, когда статистика застала очередь пустой.
--
-- Очередь `tenant_data.channel_write` в работе то и дело пустеет: запись уходит в историю. Статистика, снятая в такой момент, говорит
-- «0 строк на N страниц». Тогда любой индекс с `tenant_id` стоит для планировщика ровно столько же, сколько индекс единицы (проверено:
-- стоимость 4,13 у всех путей, выбор — любой). Поиски по единице идут индексом тенанта, и транзакция, ставящая десятки тысяч записей,
-- идёт O(n²): пересчёт 50 000 единиц ~10 минут вместо 17 с (шаг 65).
--
-- Проверено на воспроизведении и НЕ держит план: vacuum_truncate = off (очистка оставляет «0 строк на N страниц» — хуже), анализ только
-- при большой очереди (очистка всё равно записывает живые строки — ноль), барьеры MATERIALIZED и OFFSET 0 (выбор индекса внутри барьера тот
-- же), ORDER BY по версии (держит в одних состояниях и не держит в других), перестановка столбцов ключей. Держит одно — статистика,
-- в которой строки есть: ANALYZE внутри транзакции считает её ещё не зафиксированные строки живыми.
--
-- Решение (docs/decisions.md, Р-203): транзакция, поставившая в очередь сотую запись, обновляет статистику очереди сама (триггер
-- `aa_channel_write_queue_stats`): ANALYZE внутри транзакции считает её незафиксированные строки живыми, и следующие поиски той же
-- транзакции идут индексом единицы. Блокировку ждать 2 с (дольше deadlock_timeout — автоочистку база снимет), занято — повтор на
-- удвоенном числе записей. Обычные транзакции (одна-две записи) до
-- порога не доходят и ничего не платят. Автоанализ очереди остаётся включённым (ревью шага 66, находка 5): выключенный, он замораживал
-- статистику столбцов на выборке последней большой транзакции — тенант, которого в ней не было, снова попадал в ничью путей, а его
-- очередь, накопленную мелкими транзакциями, не анализировал никто. Пустую очередь с мёртвыми строками автоанализ не застаёт:
-- при большом числе мёртвых строк автоочистка сначала очищает таблицу, потом анализирует.
--
-- Тем же шагом (п. 3 задания): «уже объявлено в транзакции» в отложенном триггере объявления хранилось ОДНОЙ строкой, и каждая запись
-- искала себя в ней и дописывала её копией — O(n²): 50 000 записей ~55 с на одну боевую транзакцию. Теперь это множество по хешу единицы
-- (1024 корзины), каждая запись смотрит только свою корзину.

BEGIN;

-- ---------------------------------------------------------------- 1) большая транзакция обновляет статистику очереди сама
/**
 * Строчный триггер очереди, первый по алфавиту среди AFTER INSERT: до поиска прежних версий (`c_channel_write_after_insert`) той же
 * строки. Строки многострочной вставки к этому моменту уже в таблице: AFTER ROW срабатывает после всей вставки.
 *
 * Число записей транзакции — счётчик в настройке транзакции с номером транзакции (`номер:записей:следующий порог`); чужой номер —
 * счёт с нуля. Счётчик PostgreSQL (`pg_stat_get_xact_tuples_inserted`) для этого не годится: он несёт и вставки ПРЕЖНИХ транзакций
 * сеанса, пока статистика не сброшена (до 10 с), и маленькая транзакция после большой делала ANALYZE (найдено тестом шага 66).
 * Выставить настройку может и сам сеанс (ревью, находка 9) — так он получит ANALYZE в своей транзакции и ничего больше: держать
 * эту блокировку роль с правом изменения очереди может и `LOCK TABLE`. Порог — 100 записей; ANALYZE удался — порог снимается до конца
 * транзакции, блокировка занята (другая большая транзакция держит её до своей фиксации) — следующая попытка при вдвое большем числе
 * записей (находка 4), в том числе внутри одной многострочной вставки: статистика обновится, как только блокировка освободится.
 *
 * ANALYZE — от имени владельца очереди (SECURITY DEFINER). Права исполнения функции нет ни у одной роли: триггер срабатывает от события
 * таблицы, а вызвать функцию напрямую нельзя — у роли остатков по-прежнему нет ни одной функции с правами владельца (Р-102).
 * Блокировку ждать 2 с — дольше `deadlock_timeout` (1 с): автоочистку, держащую её (автоанализ после всплеска записей), база снимает
 * ради ждущего сеанса только через `deadlock_timeout`, и при 100 мс ожидания попытки на всех порогах проигрывали ей за доли секунды —
 * замер 50 000: боевой пересчёт 767 с вместо 27. Функция ничего не пишет в данные
 */
CREATE FUNCTION tenant_data.channel_write_queue_stats() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  SET lock_timeout = '2s'
AS $$
DECLARE
  xact text := pg_current_xact_id()::text;
  state text := coalesce(current_setting('repracer.queue_stats', true), '');
  written bigint := 1;
  next_at bigint := 100;
BEGIN
  IF split_part(state, ':', 1) = xact THEN
    written := split_part(state, ':', 2)::bigint + 1;
    next_at := split_part(state, ':', 3)::bigint;
  END IF;
  IF written >= next_at THEN
    BEGIN
      ANALYZE tenant_data.channel_write;
      next_at := 9223372036854775807;
    -- Ожидание дольше deadlock_timeout делает возможной проверку взаимоблокировок: жертва — это ожидание, а не транзакция
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      next_at := written * 2;
    END;
  END IF;
  PERFORM set_config('repracer.queue_stats', xact || ':' || written || ':' || next_at, true);
  RETURN NULL;
END $$;
ALTER FUNCTION tenant_data.channel_write_queue_stats() OWNER TO repracer_owner;
REVOKE ALL ON FUNCTION tenant_data.channel_write_queue_stats() FROM PUBLIC;
CREATE TRIGGER aa_channel_write_queue_stats AFTER INSERT ON tenant_data.channel_write
  FOR EACH ROW EXECUTE FUNCTION tenant_data.channel_write_queue_stats();

-- ---------------------------------------------------------------- 2) «уже объявлено» — множество по хешу единицы
CREATE OR REPLACE FUNCTION tenant_data.channel_write_announce_dispatch()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  scope_key text := NEW.tenant_id::text || ':' || NEW.write_scope_id::text || ',';
  -- Шаг 66: корзина множества «уже объявлено в транзакции» — 1024 корзины по хешу единицы; одна строка на всех была O(n²)
  bucket text := 'repracer.dispatch_announced_' || (hashtext(scope_key) & 1023)::text;
  announced text := coalesce(current_setting(bucket, true), '');
BEGIN
  -- Одно событие на единицу за транзакцию: вставка и захват одной записи дают два срабатывания
  IF position(scope_key IN announced) > 0 THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM tenant_data.write_scope_sync_state ss
              WHERE ss.tenant_id = NEW.tenant_id AND ss.write_scope_id = NEW.write_scope_id AND ss.in_flight_write_id IS NULL)
     AND EXISTS (SELECT 1 FROM tenant_data.channel_write w
                  WHERE w.tenant_id = NEW.tenant_id AND w.write_scope_id = NEW.write_scope_id AND w.status = 'PENDING') THEN
    INSERT INTO tenant_data.outbox_event (tenant_id, topic, partition_key, write_scope_id, event_type, payload)
    VALUES (NEW.tenant_id, 'scope.write.v1', NEW.write_scope_id, NEW.write_scope_id, 'WRITE_DISPATCH_DUE',
            jsonb_build_object('writeScopeId', NEW.write_scope_id));
    PERFORM set_config(bucket, announced || scope_key, true);
  END IF;
  RETURN NULL;
END $function$;

COMMIT;
