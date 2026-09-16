-- 070_step20.sql
-- Шаг 20: первый прогон выгрузки на настоящем ClickHouse. Вставка NO_OP ролью repracer_ingest падала: материализованное
-- представление почасового агрегата (060) выполняется правами вставляющего и требует у него SELECT на price_intent_noop, а роль
-- записи по правилу 5 из 099_verify не читает. Итог до исправления — NO_OP не выгружался никогда.
-- Представление выполняется правами отдельного пользователя-определителя: войти им нельзя (HOST NONE), права — только чтение
-- источника агрегата и вставка в агрегат.

CREATE USER IF NOT EXISTS repracer_mv_definer IDENTIFIED WITH no_password HOST NONE;
GRANT SELECT ON repracer_analytics.price_intent_noop TO repracer_mv_definer;
GRANT INSERT ON repracer_analytics.price_intent_noop_hourly TO repracer_mv_definer;
-- 020: у каждого, кто читает таблицу с политиками, политика задана явно
CREATE ROW POLICY IF NOT EXISTS mv_definer_all ON repracer_analytics.price_intent_noop AS PERMISSIVE FOR SELECT USING 1 TO repracer_mv_definer;
ALTER TABLE repracer_analytics.price_intent_noop_hourly_mv MODIFY SQL SECURITY DEFINER DEFINER = repracer_mv_definer;

-- Шаг 20, CI: повтор выгрузки неизменного дня удваивал счётчики почасового агрегата — дедупликация части доходила до сырья NO_OP
-- (окно 050), но не до таблицы агрегата: у нереплицируемой таблицы без окна дедупликации нет, и зависимая вставка шла второй раз
ALTER TABLE repracer_analytics.price_intent_noop_hourly MODIFY SETTING non_replicated_deduplication_window = 10000;
