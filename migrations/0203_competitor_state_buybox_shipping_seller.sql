-- 0203_competitor_state_buybox_shipping_seller.sql
-- Шаг 105.1 [Р-230, решение владельца после шага 105]: проекция снимка `channel_data.competitor_state` хранит доставку и продавца
-- Buy Box — то, что канал назвал: Amazon — доставку из Summary.BuyBoxPrices (держатель не назван, A-29), Kaufland /buybox и Walmart —
-- доставку и продавца держателя. Где канал не назвал — NULL: честное отсутствие, а не ноль.
--
-- До шага проекция хранила только цену и «наш / не наш», и снимок, прочитанный из базы, терял то, что в памяти было: на PostgreSQL цена
-- Buy Box Amazon была вечно «shipping not named», разрыв к держателю, чью доставку канал назвал только в Buy Box, не считался, а «Beat the
-- lowest» с ориентиром Buy Box и сравнением с доставкой решал на базе иначе, чем в памяти (ориентир выпадал «нет доставки»).
--
-- Данные канала: продавец Buy Box — тот же псевдоним или идентификатор продавца, что уже лежит в `offers` и в отрезках держателя
-- (`buybox_span.winner_seller_ref`, 0188), срок таблицы прежний (≤ 18 мес, Р-3); в вечное ядро не попадает [Р-85].

BEGIN;
SET ROLE repracer_owner;

ALTER TABLE channel_data.competitor_state
  ADD COLUMN buybox_shipping_minor bigint
    CONSTRAINT competitor_state_buybox_shipping_nonnegative CHECK (buybox_shipping_minor >= 0),
  ADD COLUMN buybox_seller_ref text
    CONSTRAINT competitor_state_buybox_seller_length CHECK (length(buybox_seller_ref) BETWEEN 1 AND 200),
  -- Доставка — у цены Buy Box: без цены её нечему принадлежать
  ADD CONSTRAINT competitor_state_buybox_shipping_with_price CHECK (buybox_shipping_minor IS NULL OR buybox_amount_minor IS NOT NULL),
  -- Продавец назван только у чужого держателя: у нашего Buy Box продавец — мы, у неизвестного держателя (Amazon, A-29) его нет [Р-221]
  ADD CONSTRAINT competitor_state_buybox_seller_other CHECK (buybox_seller_ref IS NULL OR buybox_is_self IS FALSE);

COMMENT ON COLUMN channel_data.competitor_state.buybox_shipping_minor IS
  'Доставка Buy Box в валюте проекции, если канал её назвал (Amazon Summary.BuyBoxPrices, Kaufland /buybox, Walmart); NULL — не назвал [Р-230]';
COMMENT ON COLUMN channel_data.competitor_state.buybox_seller_ref IS
  'Продавец Buy Box, если канал назвал чужого держателя (Kaufland, Walmart); у нашего и неизвестного держателя — NULL [Р-221, Р-230]';

-- Страж изменяемых столбцов проекции (0016, 0042): новые столбцы обновляются тем же upsert снимка. Прежний список не переписан, а
-- дополнен, как в 0042
DO $$
DECLARE
  args text;
BEGIN
  SELECT string_agg(quote_literal(a), ', ') INTO args
    FROM (SELECT unnest(string_to_array(encode(tgargs, 'escape'), '\000')) AS a
            FROM pg_trigger WHERE tgrelid = 'channel_data.competitor_state'::regclass AND tgname = 'a_competitor_state_restrict_update') x
   WHERE a <> '';
  EXECUTE 'DROP TRIGGER a_competitor_state_restrict_update ON channel_data.competitor_state';
  EXECUTE format('CREATE TRIGGER a_competitor_state_restrict_update BEFORE UPDATE ON channel_data.competitor_state '
              || 'FOR EACH ROW EXECUTE FUNCTION security.restrict_update(%s, %L, %L)', args, 'buybox_shipping_minor', 'buybox_seller_ref');
END $$;

RESET ROLE;
COMMIT;
