-- 020_row_policies.sql
-- Р-23: изоляция тенантов в ClickHouse. Шлюз аналитики выставляет SQL_tenant_id из аутентифицированного контекста
-- для каждого запроса; политика оставляет только строки этого тенанта. Не выставлено / пусто / не UUID —
-- toUUID() падает, запрос завершается ошибкой (fail-closed).
-- Роль хранения видит все строки — только для удаления данных закрытого тенанта.
-- Поведение пользователей без политики на таблице с политиками зависит от версии ClickHouse (проверить);
-- поэтому у каждой роли с SELECT политика задана явно, а у остальных ролей SELECT нет.

CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.channel_observation
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.competitor_snapshot
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.channel_write_completed
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.channel_write_response
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.price_intent
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.price_decision
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;
CREATE ROW POLICY IF NOT EXISTS tenant_isolation ON repracer_analytics.fee_actual
  AS PERMISSIVE FOR SELECT USING tenant_id = toUUID(getSetting('SQL_tenant_id')) TO repracer_tenant_reader;

CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.channel_observation     AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.competitor_snapshot     AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.channel_write_completed AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.channel_write_response  AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.price_intent            AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.price_decision          AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
CREATE ROW POLICY IF NOT EXISTS retention_all ON repracer_analytics.fee_actual              AS PERMISSIVE FOR SELECT USING 1 TO repracer_retention;
