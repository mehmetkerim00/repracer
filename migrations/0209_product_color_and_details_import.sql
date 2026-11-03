-- 0209_product_color_and_details_import.sql
-- Шаг 112 [Р-238]: цвет товара — необязательное свойство товара (SKU), его задаёт продавец импортом «Product details». Интерфейс
-- показывает кружок-образец только у известного слова, незнакомое слово — только текстом; из названия цвет не выводится. Чтение цвета
-- из атрибутов каналов — отдельный отложенный шаг (данные канала, срок 18 месяцев [Р-3]); здесь цвет — данные тенанта, как название
-- продавца.
--
-- Что здесь:
--   1. столбец `tenant_data.product.color` с формой значения; правку разрешает тот же страж, что название;
--   2. вид задания PRODUCT_IMPORT — применение импорта «Product details»: меняет описание товара, не забор цены, поэтому второго
--      фактора не требует [Р-225]; отменить чужое вправе тот, кто ведёт каталог (как остатки, Р-152);
--   3. вид импорта PRODUCTS в журнале импортов и сопоставление «задание применения — вид импорта» у стража журнала.

BEGIN;
SET ROLE repracer_owner;

-- ---------------------------------------------------------------- 1. Цвет товара
/**
 * Цвет — слово продавца как он его написал («grey», «Navy blue», «multicolor»): без пробелов по краям и двойных пробелов, без
 * управляющих знаков, не длиннее 40 знаков. Пусто — NULL, а не пустая строка: «цвета нет» одно на всю систему
 */
ALTER TABLE tenant_data.product ADD COLUMN color text
  CONSTRAINT product_color_form CHECK (color IS NULL OR (color = btrim(color) AND char_length(color) BETWEEN 1 AND 40
                                                         AND color !~ '[[:cntrl:]]' AND color !~ '\s\s'));
COMMENT ON COLUMN tenant_data.product.color IS
  'Шаг 112 [Р-238]: цвет товара словом продавца (импорт «Product details»); NULL — не задан. Кружок-образец — только у известного слова';
-- Столбец разрешён к правке тем же стражем, что название (0004, 0173): перечень разрешённых столбцов — аргументы триггера.
-- Пишет его административная роль (права на таблицу целиком у неё с 0004); у роли каталога права по столбцам — цвета среди них нет
DROP TRIGGER product_restrict_update ON tenant_data.product;
CREATE TRIGGER product_restrict_update BEFORE UPDATE ON tenant_data.product
  FOR EACH ROW EXECUTE FUNCTION security.restrict_update('sku', 'title', 'gtin', 'mpn', 'brand', 'tax_category', 'status', 'updated_at',
                                                        'title_channel_read_at', 'color');

-- ---------------------------------------------------------------- 2. Вид задания: применение импорта «Product details»
ALTER TABLE tenant_data.bulk_job DROP CONSTRAINT bulk_job_kind_known;
ALTER TABLE tenant_data.bulk_job ADD CONSTRAINT bulk_job_kind_known
  CHECK (kind IN ('COST_IMPORT', 'BOUNDS_EDIT', 'BOUNDS_PLAN', 'STRATEGY_ASSIGN', 'STRATEGY_PREVIEW', 'PRICE_EVIDENCE', 'PRICE_FEED_EXPORT',
                  'REPRICING_ENABLE', 'STOCK_IMPORT', 'STOCK_SYNC_ENABLE', 'IMPORT_TEMPLATE', 'IMPORT_CHECK', 'SCREEN_EXPORT', 'PRODUCT_IMPORT'));

-- Р-143: право на вид операции — описание товара ведёт тот, кто ведёт каталог. Прежнее определение дополнено, а не переписано
DO $do$
DECLARE
  d text := pg_get_functiondef('security.bulk_job_cancel_action(text)'::regprocedure);
  a text := $s$WHEN p_kind = 'SCREEN_EXPORT' THEN 'VIEW_PRICING'$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0209: security.bulk_job_cancel_action(text) is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
              -- Шаг 112 [Р-238]: описание товара (цвет) — каталог, как остатки
              WHEN p_kind = 'PRODUCT_IMPORT' THEN 'MANAGE_CATALOG'$s$);
END $do$;

-- ---------------------------------------------------------------- 3. Журнал импортов: вид PRODUCTS
ALTER TABLE tenant_data.import_run DROP CONSTRAINT import_run_kind_known;
ALTER TABLE tenant_data.import_run ADD CONSTRAINT import_run_kind_known CHECK (kind IN ('COSTS', 'STOCK', 'BOUNDS', 'STRATEGY', 'PRODUCTS'));

/**
 * Страж журнала (0193): применение пишет строку только своего вида импорта. Сопоставление дополнено одной веткой — текст прежних веток
 * цитирует каталог мутаций [Р-108]
 */
DO $do$
DECLARE
  d text := pg_get_functiondef('tenant_data.import_run_from_its_job()'::regprocedure);
  a text := $s$WHEN 'BOUNDS_EDIT' THEN 'BOUNDS' WHEN 'STRATEGY_ASSIGN' THEN 'STRATEGY'$s$;
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION '0209: tenant_data.import_run_from_its_job() is not the definition the migration expects';
  END IF;
  EXECUTE replace(d, a, a || $s$
                                         WHEN 'PRODUCT_IMPORT' THEN 'PRODUCTS'$s$);
END $do$;

RESET ROLE;
COMMIT;
