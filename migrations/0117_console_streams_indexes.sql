-- 0117_console_streams_indexes.sql: индексы под потоки консоли — страницы, окна, агрегаты (шаг 35) [Р-154].
--
-- До шага 35 состояние консоли читало ВСЕ решения, намерения, записи и события аудита тенанта на каждый запрос любого
-- экрана: демо на 200 предложениях даёт около ста тысяч решений в сутки, и экран пути отвечал 10,98 с на раннере CI.
-- Теперь потоки читаются страницей, окном или агрегатом — и у каждого такого запроса есть индекс, названный здесь.
-- Каждый индекс — под конкретный запрос `PgPricingStore` (правило репозитория: индекс только с комментарием).

BEGIN;

SET ROLE repracer_owner;

-- decisionPage / worldCounters: страница решений тенанта свежими первыми и счёт за окно
CREATE INDEX price_decision_tenant_time_idx ON channel_data.price_decision (tenant_id, decided_at DESC, price_decision_id DESC);

-- decisionPage по единице / scopeDecisionStats: последнее решение единицы и их число — по индексу, а не обходом тенанта
CREATE INDEX price_decision_scope_time_idx ON channel_data.price_decision (tenant_id, write_scope_id, decided_at DESC, price_decision_id DESC);

-- interventions / worldCounters: вмешательства за окно — решения НЕ «без изменения» (их одно из десяти), частичный индекс
-- отсекает NO_CHANGE ещё в индексе, и окно в семь суток не касается девяти десятых буфера
CREATE INDEX price_decision_intervention_idx ON channel_data.price_decision (tenant_id, decided_at DESC)
  WHERE outcome <> 'NO_CHANGE';

-- interventions: намерения окна читаются ВСЕ (граница эпизода удержания — оконной функцией по соседям), наружу идут только
-- намерения на границе; окно — первичный ключ (tenant_id, created_at, …), отдельный индекс не нужен. Буфер намерений — 3 дня

-- listPollCandidates (планировщик, опрос конкурентов по ярусам): движения ОДНОГО товара за 48 часов. Без этого индекса
-- запрос проходил таблицу движений целиком на каждый товар — 200 товаров × 68 000 строк, 2,9 с на запуск раз в минуту на
-- демо-тенанте к десятому часу суток (найдено прогоном суток шага 35). Индекс окна витрины (0009) отбирает почти всё
CREATE INDEX competitor_move_product_window_idx ON channel_data.competitor_move
  (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, evaluated_at DESC);

-- feedPage: лента цен — страница по моменту записи (применена → отправлена → создана), в целом и по единице
CREATE INDEX channel_write_history_feed_idx ON tenant_data.channel_write_history
  (tenant_id, (coalesce(accepted_at, dispatched_at, created_at)) DESC, version DESC) WHERE field = 'PRICE';
CREATE INDEX channel_write_history_scope_feed_idx ON tenant_data.channel_write_history
  (tenant_id, write_scope_id, (coalesce(accepted_at, dispatched_at, created_at)) DESC, version DESC) WHERE field = 'PRICE';

-- decisionDetail: записи по решению — и в полёте, и в истории
CREATE INDEX channel_write_decision_idx ON tenant_data.channel_write (tenant_id, price_decision_id) WHERE price_decision_id IS NOT NULL;
CREATE INDEX channel_write_history_decision_idx ON tenant_data.channel_write_history (tenant_id, price_decision_id) WHERE price_decision_id IS NOT NULL;

-- interventions: записи, завершённые перепроверкой границ или остановкой человеком, за окно
CREATE INDEX channel_write_history_ended_idx ON tenant_data.channel_write_history (tenant_id, created_at)
  WHERE end_reason IN ('WRITE_BLOCKED_BY_BOUND_RECHECK', 'PRICING_STOPPED');

-- interventions: отклонённые снимки за окно
CREATE INDEX rejected_competitor_snapshot_received_idx ON channel_data.rejected_competitor_snapshot (tenant_id, received_at);

-- auditRecent: последние события остановок — свежие первыми, без обхода журнала
CREATE INDEX audit_event_stop_recent_idx ON audit.audit_event (tenant_id, (changes ->> 'at') DESC, recorded_at DESC)
  WHERE entity_type IN ('price_stop', 'pricing_halt');

RESET ROLE;

COMMIT;
