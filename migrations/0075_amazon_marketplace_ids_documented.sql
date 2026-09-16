-- 0075: шаг 20 — идентификаторы витрин Amazon подтверждены документацией SP-API (снимок vendor/amazon/sp-api-models/2026-09-16,
-- страница marketplace-ids): amazon.de — A1PA6795UKMFR9, amazon.com — ATVPDKIKX0DER. Меняется только источник строки справочника.
-- Налоговый режим и граница суток остаются (проверить): документация их не задаёт (OQ-102, OQ-112, вопросы A-02 и A-03 в
-- docs/channel-capabilities.md). Справочник eBay не меняется: снимок eBay не сохранён (vendor/ebay/sell-inventory-api/NOT-SNAPSHOTTED.md).

BEGIN;
SET ROLE repracer_owner;
UPDATE platform.marketplace
   SET source = 'Р-56: amazon.de; идентификатор витрины SP-API подтверждён документацией (developer-docs.amazon.com/sp-api/docs/marketplace-ids, снимок 2026-09-16); налоговый режим — (проверить, OQ-102)'
 WHERE channel = 'AMAZON' AND marketplace = 'A1PA6795UKMFR9' AND country = 'DE';
UPDATE platform.marketplace
   SET source = 'Р-56: amazon.com; идентификатор витрины SP-API подтверждён документацией (developer-docs.amazon.com/sp-api/docs/marketplace-ids, снимок 2026-09-16); налоговый режим — (проверить, OQ-102)'
 WHERE channel = 'AMAZON' AND marketplace = 'ATVPDKIKX0DER' AND country = 'US';
DO $$ BEGIN
  IF (SELECT count(*) FROM platform.marketplace WHERE channel = 'AMAZON' AND source LIKE '%подтверждён документацией%') <> 2 THEN
    RAISE EXCEPTION 'expected both Amazon storefront rows (A1PA6795UKMFR9 DE, ATVPDKIKX0DER US) to exist';
  END IF;
END $$;
RESET ROLE;
COMMIT;
