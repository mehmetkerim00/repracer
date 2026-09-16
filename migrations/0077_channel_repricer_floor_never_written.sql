-- 0077: шаг 21 — Р-111. Поле Amazon `minimum_seller_allowed_price`, как и Kaufland `minimum_price` [Р-12], не пишется никогда:
-- по A-05 это вероятный аналог поля, включающего собственное автоматическое ценообразование площадки. В модели записи оба — поле
-- CHANNEL_MIN_PRICE. База отклоняет его запись для любого канала, кроме Kaufland в явном режиме тенанта Smart Pricing, тремя
-- ограничениями: возможность канала (0003), режим единицы записи (0005) и страж вставки записи (0051). До шага 21 два из них
-- были безымянными CHECK вне каталога мутаций; им даются имена, у каждого — своя проверка и строка каталога [Р-108].

BEGIN;
ALTER TABLE platform.channel_capability RENAME CONSTRAINT channel_capability_check1 TO channel_capability_channel_min_price_only_kaufland;
COMMENT ON CONSTRAINT channel_capability_channel_min_price_only_kaufland ON platform.channel_capability IS
  'Р-12, Р-111: поле собственного автоматического ценообразования площадки (Kaufland minimum_price, Amazon minimum_seller_allowed_price) описывается только для Kaufland (режим Smart Pricing); для Amazon не пишется никогда';
ALTER TABLE tenant_data.write_scope RENAME CONSTRAINT write_scope_check2 TO write_scope_smart_pricing_only_kaufland;
COMMENT ON CONSTRAINT write_scope_smart_pricing_only_kaufland ON tenant_data.write_scope IS
  'Р-12, Р-111: режим, в котором пишется поле-порог площадки, существует только у Kaufland';
COMMIT;
