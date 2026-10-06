# Шаг 72: мутационная проверка строки каталога удержаний пола

Миграция 0178 переопределила триггер `channel_data.price_intent_record_floor_hold()` (удержанная цена шагов CAPPED_* — граница из шага цепочки, новый код `CAPPED_AT_MARGIN_FLOOR`). Строка каталога «OQ-231, OQ-232» прогнана своей проверкой после правок ревью: `node scripts/db/mutation-check.mjs --only 'OQ-231, OQ-232'`. Новых защит у шага нет [Р-108]; полный каталог — полному прогону CI, как на шагах 63–71.

| Строка | Инвариант | Мутация | Поймана своей проверкой | Свои проверки мутации |
|---|---|---|---|---|
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `security.marketplace_properties_unknown(text, text[]): «IF outside IS NOT NULL THEN…» → «IF false THEN…»` | да | ✗ smoke «a LIVE account with a marketplace outside the reference (OQ-231)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `DROP TRIGGER zd_price_intent_record_floor_hold ON channel_data.price_intent` | да | ✗ smoke «the database records how far below the floor the strategy wanted (OQ-232)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `channel_data.price_intent_record_floor_hold(): «coalesce(in_shadow, false)…» → «NOT coalesce(in_shadow, false)…»` | да | ✗ smoke «the database records how far below the floor the strategy wanted (OQ-232)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `GRANT INSERT ON channel_data.floor_hold TO repracer_app` | да | ✗ smoke «the decision path writes a floor hold directly (Р-173)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `ALTER TABLE channel_data.floor_hold DROP CONSTRAINT floor_hold_currency_iso` | да | ✗ smoke «a floor hold without a currency code (OQ-232, Р-71)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `ALTER TABLE channel_data.floor_hold DROP CONSTRAINT floor_hold_below_positive` | да | ✗ smoke «a floor hold that is not below the floor (OQ-232)» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `DROP TRIGGER zz_append_only ON channel_data.floor_hold` | да | ✗ smoke «append-only channel_data.floor_hold» |
| OQ-231, OQ-232 | витрина вне справочника держит бой; удержание полом пишет база при вставке намерения — деньги с валютой, неизменяемо | `DROP TRIGGER zz_no_truncate ON channel_data.floor_hold` | да | ✗ smoke «truncate channel_data.floor_hold» |

Строк с мутациями: 1; ложных (хотя бы одна мутация не поймана заявленными проверками): **0** — —.
Мутаций: 8; не поймано своей проверкой: **0** (из них упала только соседняя проверка строки: 0).
Не мутировались: 1–11 (свойства каталога остались в проверке схемы (0067)); 15 (данные справочника НДС остались в проверке схемы (0067)); 36 (правило проверяло отсутствие объектов входа).
✗ — проверка упала на мутации (поймала), ✓ — осталась зелёной.
