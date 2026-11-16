-- 0235_feed_event_time.sql
-- Шаг 145 (внешний аудит UX, корзина 1.2): удержанная тенью запись стоит в журнале цен в момент своего повода, как на экране тени.
--
-- Журнал цен (Price changes) ставил запись в момент «применена → отправлена → создана», а экран тени относил удержанную запись к
-- моменту её повода (шаг 96.1). В работе это одно и то же: повод, решение и удержанная запись — одна транзакция [Р-54]. На виртуальных
-- часах (прожатая неделя демо, живые прогоны) момент создания ставит база — «сейчас», и за одно окно экран тени и журнал считали
-- разное: на QA-A за 7 суток «Held back» 1 636 против «Held by shadow mode» 1 747, а строки прожатой недели в журнале стояли в момент
-- подготовки демо. Удержанная запись не отправляется и не применяется, поэтому её момент в журнале — повод (`trigger_received_at`),
-- а без повода — создание. Индексы ленты (0117) пересобираются под это выражение; запрос — `feedPage`, выражение — `WRITE_AT_HISTORY`.

BEGIN;

SET ROLE repracer_owner;
DROP INDEX tenant_data.channel_write_history_feed_idx;
DROP INDEX tenant_data.channel_write_history_scope_feed_idx;
-- feedPage: лента цен — страница по моменту события (применена → отправлена → повод удержанной тенью → создана), в целом и по единице
CREATE INDEX channel_write_history_feed_idx ON tenant_data.channel_write_history
  (tenant_id, (coalesce(accepted_at, dispatched_at, CASE WHEN final_status = 'SHADOW_HELD' THEN trigger_received_at END, created_at)) DESC, version DESC)
  WHERE field = 'PRICE';
-- feedPage по одному предложению (фильтр «Offer» журнала цен) — то же выражение
CREATE INDEX channel_write_history_scope_feed_idx ON tenant_data.channel_write_history
  (tenant_id, write_scope_id, (coalesce(accepted_at, dispatched_at, CASE WHEN final_status = 'SHADOW_HELD' THEN trigger_received_at END, created_at)) DESC, version DESC)
  WHERE field = 'PRICE';
RESET ROLE;

COMMIT;
