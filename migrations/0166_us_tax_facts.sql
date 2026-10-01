-- 0166_us_tax_facts.sql
-- Шаг 64: профиль США [Р-58, Р-172]. Ревизия свойств витрин США (0130) писала налоговую базу EBAY_US со ссылкой «снимка eBay нет (E-01)»,
-- а снимок есть с шага 48. И она обещала закрыть налоговую базу обеих витрин США ПЕРВОЙ БОЕВОЙ ЗАПИСЬЮ [Р-116] — но сверка базы цены
-- после записи смотрит на ставку НДС, а у витрин США (SALES_TAX_EXCLUDED) ставки нет: первая запись закрыть базу не может. Закрывает её
-- ответ поддержки канала — вопросы E-25 (eBay) и A-02 (Amazon).
--
-- Что снимок eBay говорит про налог США (vendor/ebay/2026-09-28/sell_inventory_v1_oas3.json, Tax.applyTax): eBay сам считает, собирает и
-- перечисляет sales tax во всех 50 штатах и округе Колумбия, таблицы налогов продавца для них больше не действуют. Что входит в `price`
-- у Browse и какие `taxes[]` он отдаёт для EBAY_US, снимок не говорит (спецификации Browse в нём нет) — это E-25.

BEGIN;
SET ROLE repracer_owner;

UPDATE platform.marketplace SET
  tax_question = 'E-25', tax_closes_by = 'CHANNEL_SUPPORT',
  tax_source = 'Р-58: EBAY_US — нетто; снимок eBay 2026-09-28 (Inventory API, Tax.applyTax): sales tax во всех штатах считает, собирает и перечисляет eBay. Что входит в price у Browse и в taxes[] для EBAY_US — не описано (E-25); сверка базы цены [Р-116] для витрин без НДС не работает, поэтому первая боевая запись базу не закрывает'
 WHERE channel = 'EBAY' AND marketplace = 'EBAY_US';

UPDATE platform.marketplace SET
  tax_closes_by = 'CHANNEL_SUPPORT',
  tax_source = 'Р-58: цены amazon.com — нетто, sales tax добавляется при покупке; налоговая база SP-API не подтверждена (A-02); сверка базы цены [Р-116] для витрин без НДС не работает, поэтому первая боевая запись базу не закрывает'
 WHERE channel = 'AMAZON' AND marketplace = 'ATVPDKIKX0DER';

RESET ROLE;
COMMIT;
