-- 0215_amazon_summary_decision_source.sql
-- Шаг 115 [Р-240]: конкуренты Amazon для пилота — опрос `getCompetitiveSummary` решает цену (решение владельца по аудиту 2026-11-06, вариант (b)).
--
-- Строка источника `AMAZON_COMPETITIVE_SUMMARY` в справочнике становится основной: стратегия доступна на канале по этому источнику [Р-39]. Что он
-- называет (модель productPricing_2022-05-01, настоящий ответ песочницы шага 108):
--   - держатель и цена Buy Box — `featuredBuyingOptions`: предложения по сегментам покупателей с долей просмотров; держатель — продавец большинства
--     просмотров [Р-235]; большинства нет — цена самой большой группы, держатель неизвестен, и стратегия, которой нужен держатель, цену не двигает;
--   - исполнение — `fulfillmentType`, обязательное поле предложения: фильтр «Compete with» [Р-226] работает.
-- Отсюда Q11: «Win the Buy Box» на Amazon становится доступной. Строка уведомлений `ANY_OFFER_CHANGED` прежняя: держателя она не называет (A-29).
-- Снятие остановки выборкой на Amazon по-прежнему неприменимо [Р-119] — причина другая: весь бюджет вызова занят опросом по кругу.
-- Новых защит нет: `channel_data.strategy_unmet` читает те же столбцы; совпадение строки с описанием канала держит channel-reference.pg.test.ts.
SET ROLE repracer_owner;
UPDATE platform.competitor_source
   SET role = 'PRIMARY', has_buybox_winner = true, has_buybox_price = true, has_fulfilment = true
 WHERE channel = 'AMAZON' AND source = 'AMAZON_COMPETITIVE_SUMMARY';
UPDATE platform.channel_behaviour
   SET basis = 'Р-119: the whole getCompetitiveSummary budget (0.033 rps) goes to the rotation poll, a fresh independent sample cannot be taken'
 WHERE channel = 'AMAZON';
RESET ROLE;
