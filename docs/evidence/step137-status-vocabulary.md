# Шаг 137: один словарь статусов цены — BUG-03, INV-02…INV-04 [Р-252]

Источник — отчёт Мердана «QA-A Bug & Findings Report 1.0» (BUG-03, INV-02, INV-03, INV-04, UX-08). По решению владельца дефекты идут
первыми. Словарь: Adjusted to limit / Blocked / Rejected / Held in shadow mode — как в UX-08.

## Воспроизведение на QA-A (`b249573`)

Через API стенда изнутри сети compose, вход Owner, «Demo store (simulator)»:
- **Protections → Prevented by rules.** Строка «Desk lamp · ebay.com», Nov 14, 2026, 21:46 UTC−5: было $19.99, предложено $11.99, итог
  $19.99, граница «your minimum price $12.00», отклонение 0.09 %, пилюля **corrected**.
- **Сводка.** `corrected: 133` = 121 цель стратегии, поставленная на границу (`STRATEGY_CAP`), плюс **12 отказов Gate**, у которых цена
  не менялась. Заголовок — «Your bounds stopped 0 dangerous changes and corrected 133».
- **Квитанция того же решения.** Шаг Gate — STOP «Rejected: $11.99 is below your minimum price $12.00 by 0.09%», а строка «Distance
  from the bound» — «0.09% — corrected».
- **Случай Desk lamp · amazon.com, Nov 15, 15:57** (распродажа в тени) — не этот дефект: цель $8.99 поставлена на пол распродажи
  $10.00, решение одобрено, запись удержана тенью.

Причина — правило Р-73 в коде: отказ Gate в пределах 10 % от границы классифицировался как «скорректировано» (`rejected.ts`,
`classifyBoundIntervention`). Цель стратегии, поставленная на границу, называлась тем же словом.

## Что сделано

- **`packages/console-model/src/statuses.ts`** — один словарь и одно правило:
  - `ADJUSTED_TO_LIMIT` — цель стратегии поставлена на границу, цена = граница;
  - `REJECTED` — Gate отклонил, цена прежняя; больше 10 % за границей — ещё и `dangerous` (Р-73);
  - `BLOCKED` — пауза: остановка человеком, неактивная единица, ограничители, запись остановлена перепроверкой, снимок отклонён или
    витрина остановлена;
  - `HELD_IN_SHADOW` — одобрено у аккаунта в тени;
  - `APPROVED_LIVE` — одобрено у аккаунта в бою;
  - `NO_CHANGE`.
- **Protections** (`rejectedView`, экран):
  - у строки — `status` и `dangerous` вместо `intervention`;
  - пилюля — словом из словаря, опасный отказ — «Rejected · dangerous»;
  - сводка: `adjusted` (только `STRATEGY_CAP`), `rejected`, `dangerous`;
  - заголовок — «Your bounds adjusted N prices to a limit and rejected M proposals[, K of them dangerous]».
- **Квитанция:**
  - пилюля статуса тем же словом в заголовке;
  - строка отклонения — «0.09% beyond the bound — rejected; the price did not change» (опасное — «rejected, a dangerous change (over
    10%)»).
- **Журнал решений (INV-02):**
  - статус строки — из словаря; одобренное в тени — «Held in shadow mode», а не «Approved», будто цена ушла;
  - у решения — признак тени (`price_decision.shadow`, уже был в базе, теперь загружается);
  - фильтр исхода — «approved (sent, or held in shadow mode)» и «rejected or blocked».
- **INV-03:** строка стратегии «Bounds at calculation» в распродаже называет пол распродажи — «$14.00 – $50.00; in clearance mode the
  clearance floor $10.00 replaces the lower bound». Раньше $14–$50 здесь и $10–$50 у Gate читались как противоречие; арифметика не
  менялась.
- **INV-04:** дата у полной записи рынка теперь названа своим сроком — «Full market snapshot (kept 18 months): kept until …», рядом с
  «Competitor details are kept for 30 days with the decision». Хранение не менялось.
- **Тексты** на EN/DE/ES/FR. Глоссарий, FDD (Protections и глоссарий), решение Р-252 (уточняет Р-73).

## Красное сначала

`tests/contract/src/console.test.ts`, «step 137 (BUG-03)», — настоящий отказ Gate сценария `kaufland/pipeline/above-max-price` с
отклонением, уменьшенным до 0.09 % (как у Мердана). На коде шага 136 тест красный: у строки нет статуса, отказ — «corrected».

Тест держит:
- статус `REJECTED`, итог = прежняя цена;
- `adjusted` = только подтягивания к границе;
- в заголовке нет «corrected»;
- квитанция говорит тем же словом, строка отклонения — без «corrected»;
- в журнале решений одобренное в тени — «Held in shadow mode».

## Зелёное

- Тесты консоли на стенде — 11 из 11; модель и словари — 96 из 96; типы — 0 ошибок.
- Тесты консоли и браузерный смоук — 71 из 72. Данные смоука шага 96.2 переписаны под новый смысл: «одно состояние» — две причины
  подтягивания, «разные состояния» — опасный отказ «Rejected · dangerous».
- Не прошёл «step 85» на 375 px, `products/bulk` (368 px в окне 360). Он красный и на коде шага 136, без правок этого шага: на этой
  машине (macOS) экран шире, CI на Linux решает.

Миграций нет.
