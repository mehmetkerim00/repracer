-- 0211_cost_import_trigger_indexes.sql
-- Шаг 113 (обратный билет 110.5): применение импорта себестоимости — пакетом без квадрата. Путь хранилища уже пакетный (одна вставка
-- версий `cost_profile` и одна — оценок комиссии), но на каждую строку срабатывают построчные триггеры, и два их запроса были
-- квадратичными: 10 000 строк — 32 с на машине разработчика, из них 22,9 с — подъём пола, 4,8 с — страж `valid_from`
-- (`pg_stat_user_functions`). Триггеры, стражи, аудит и запросы на подъём пола не меняются: только индексы под их запросы.

BEGIN;
SET ROLE repracer_owner;

/**
 * Под запрос ветки `cost_profile` функции `tenant_data.request_floor_raise()` (0182): единицы ЦЕНЫ товара в режиме ENGINE —
 * `tenant_id = … AND product_id = … AND field = 'PRICE' AND pricing_mode = 'ENGINE'`. Прежний индекс по товару (`write_scope_product_idx`)
 * частичный «не RETIRED» — под запрос без этого условия он не подходит, и каждая новая версия себестоимости проходила все единицы
 * тенанта. Частичный по `ENGINE`: подъём касается только их
 */
CREATE INDEX write_scope_engine_product_idx ON tenant_data.write_scope (tenant_id, product_id)
  WHERE field = 'PRICE' AND pricing_mode = 'ENGINE';

/**
 * Под запрос стража `tenant_data.cost_profile_valid_from_guard()` (0005): более поздняя версия того же товара —
 * `tenant_id = … AND product_id = … AND valid_from > …` (аккаунт и витрина — `IS NOT DISTINCT FROM`, индексом не ищутся). У свежей таблицы
 * (первый импорт тенанта, демо, новая база) общий план брал индекс `(tenant_id, created_at)` и проходил все версии тенанта, растущие по
 * ходу той же вставки; с этим индексом условие на товар и время — в поиске при любой статистике
 */
CREATE INDEX cost_profile_product_valid_from_idx ON tenant_data.cost_profile (tenant_id, product_id, valid_from);

RESET ROLE;
COMMIT;
