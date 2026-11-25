# Шаг 175.1: снимки шагов 174–175 и тон заметки «нет безубыточности»

Снимки «до» и «после» по Р-254 для комментариев перепроверки. Шаги 174 и 175 ушли в CI без них, поэтому их снимки и найденная по ним правка вынесены отдельным лёгким шагом. Так не пришлось перезапускать идущие прогоны.

## Снимки

`docs/evidence/step175.1-ux/` — локальное демо США (профиль us):
- «до» — `ca02d4f` (main, сборка отчёта «QA-A Testing 2.0»);
- «после» — `27196b5` (шаги 174 и 175) с правкой этого шага.

| Снимок | Что видно |
|---|---|
| `*-offers-attention` (светлая и тёмная, 1440 и 375) | Выборка «4 offers need attention». До: галочка «Compact rows», «4 of 38 offers match the filter». После: плотность — стандарт, «Showing 4 of 38 offers» |
| `*-1440-offers-attention-health` (светлая и тёмная) | Строки *Bamboo cutting board, large* и *Pour-over coffee dripper* (amazon.com, без себестоимости) — наблюдение Мердана. До: Health «–». После: «No unit cost or fees» и «What to do» |
| `*-costs-table` (светлая и тёмная, 1440 и 375) | Costs & floors. После: колонка «Effective floor» с источником, цвет и идентификатор в канале |
| `*-floor-glance`, `*-floor-clearance` (1440 светлая и тёмная, 375 светлая) | Страница пола *Bamboo cutting board, large · amazon.com* без себестоимости. До: поле пола распродажи, галочка «I understand: every sale below no value loses money», записка и дата. После: только причина и ссылка «Add unit cost and fees» |
| `light-1440-enable-refused` | Окно отказа включения *Pour-over coffee dripper · amazon.com*. До: «Repricing not enabled» четыре раза. После: один раз, заголовком |
| `light-1440-receipt-shadow` | Квитанция решения тени. После: станция и строка итога — «Not sent — shadow mode» |
| `light-1440-bulk-refusal` | Минимум выше максимума. До: «unexpected error (code MIN_ABOVE_MAX)» в плашке формы, в заголовке задания и в его плашке. После: один текст до задания — предложение, обе суммы, «Nothing was changed.» |
| `light-1440-bulk-done`, `light-1440-bulk-done-table` | После «Done». До: таблица и список выбора — прежний минимум, рядом с «Done» зелёное «… in the background». После: новые значения сами, одна строка «Successfully updated 1 offer.» |

BUG-01 воспроизвёлся и на снимке «до». Скрипт снимков после «Done» читает минимум первой строки таблицы:
- до — `$12.00` при применённых 12.01 (повтор — `$12.01` при 12.02);
- после — то, что применено.

## Правка

Снимок нашёл недочёт шага 174. Причина «Loss cannot be calculated — add unit cost and fees first» стояла плашкой статуса (`p.notice[role=status]`) — это зелёный тон, тон успеха. Но это то, чего сделать нельзя. Теперь это заметка внимания (`role="note"`, янтарный тон), как у прочих «нельзя, пока нет данных».

Красное сначала: `apps/console/test/console.test.ts`, «step 175.1». На коде шага 175 тест красный: `role="status"`.

Safety information preserved: ничего не свёрнуто и не убрано, меняется только тон одной плашки.

Миграций нет.
