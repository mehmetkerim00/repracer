# Шаг 80: почему подготовка демо шла 34 минуты, и сценарий под названия шага 79

Два вопроса перед показом:

1. почему перезапуск демо в конце шага 79 занял 34 минуты, из них прожатие недели США — 1047 с вместо 25–116 с;
2. совпадает ли текст сценария показа и чеклиста дня показа с экранами после шага 79.

## 1. Причина — сон машины, а не база стенда

### Хронология медленной подготовки (шаг 79, 12 октября, время машины)

| Время | Подготовка (`scripts/demo-prepare.sh`) | Журнал питания macOS (`pmset -g log`) |
|---|---|---|
| 04:59:35 | старт, «== база repracer_demo» | |
| 04:59:38 | | `Sleep — Entering Sleep state due to 'Sleep Service Back to Sleep'` |
| 05:15:50 | | `DarkWake from Deep Idle … 45 secs` |
| 05:16:03 | база готова, «== стенд» | |
| 05:16:35 | | `Sleep — Entering Sleep state due to 'Maintenance Sleep'` |
| 05:33:00 | | `DarkWake from Deep Idle` |
| 05:33:35 | «стенд готов», «demo US week pressed: … 1047.2 s» | |

Подготовка работала только в окна бодрствования: 3 секунды до первого сна, затем 45 и ~60 секунд коротких пробуждений.

- Миграции заняли 16,4 минуты: машина спала с 04:59:38 до 05:15:50.
- Прожатие недели «длилось 1047 с»: стенд меряет его настенными часами, и в них вошли 16,4 минуты сна с 05:16:35 до 05:33:00.

Журнал PostgreSQL за 04:59–05:34 — девять строк, из них ни одной ошибки, ожидания или блокировки. Процессы спали вместе с машиной.

Шаг 79 перезапускал демо без человека у машины и без `caffeinate`. Чеклист дня показа велел запускать `caffeinate -dims` вручную в
отдельном терминале, а при перезапуске из сессии его не было.

### Гипотезы задания

- **Мусор в базе стенда (пересеянные демо-миры, OQ-225) — не подтвердилось.** `scripts/demo-prepare.sh` пересоздаёт базу
  `repracer_demo` при каждом запуске (`scripts/db/prepare.sh`: `DROP DATABASE … WITH (FORCE)`, миграции с нуля). После подготовки в базе
  два демо-тенанта:
  - один — мир смоук-проверок схемы, без предложений;
  - второй — демо стенда, 424 единицы записи. База — 119 МБ.

  OQ-225 — про пересев внутри одной базы развёрнутой консоли. Подготовки демо он не касается, поэтому очистка старых миров в подготовку не
  добавлена: чистить нечего.
- **ANALYZE-триггер Р-203 ждёт на блокировках — не подтвердилось.** Подготовка шага 80 шла с сэмплером: раз в секунду сеансы базы демо
  группировались по состоянию и ожиданию (`pg_stat_activity`), 136 выборок за всю подготовку.
  - Ожиданий блокировки (`Lock`, `LWLock`) — 0.
  - ANALYZE в выборках — только автоочистка с обычной паузой `VacuumDelay` (9 выборок); её никто не ждёт.

  Кроме того, триггер стоит на вставках в очередь записей, а их нет в миграциях, которые в шаге 79 тоже шли 16 минут.

### Замеры

| Запуск | Итог | База | Стенд (из них неделя США) | Интерфейс |
|---|---|---|---|---|
| Шаг 79, машина засыпала | 34 мин 1 с | 16 мин 28 с | 17 мин 32 с (1047,2 с) | 1 с |
| Шаг 80, отдельная база, только миграции и смоук | — | 46 с (при работающем демо) | — | — |
| **Шаг 80, подготовка демо** | **85 с** | **18 с** | **66 с (60,8 с)** | **1 с** |

### Исправление

- **Подготовка держит машину бодрствующей сама.**
  - `caffeinate -dims -w $$` запускается до фазы базы и живёт, пока жив скрипт, то есть до Ctrl+C — всю подготовку и весь показ.
  - На машине без `caffeinate` подготовка предупреждает.
  - Крышку ноутбука закрывать по-прежнему нельзя: это сон и с `caffeinate`, о чём говорит чеклист.
- **Правило [Р-146]** в `scripts/test/repo-rules.test.ts`: `caffeinate … -w $$` стоит в `scripts/demo-prepare.sh` до фазы базы. Контроли:
  без `caffeinate`, после фазы базы и в комментарии правило краснеет.
- **Время каждой фазы — в строке «Демо готово»**: подготовка, база, стенд (из них неделя США из журнала стенда), интерфейс, первые решения.
  Медленный подъём теперь виден по фазам сразу. Чеклист говорит: дольше 5 минут — машина засыпала или занята.

## 2. Сценарий и чеклист под экраны шага 79

Тексты сверены с живым демо на коде шага 79: браузером сняты экраны входа, списка магазинов, тени, двух решений (amazon.com и kaufland.de),
границ, списка решений, остановки с её окном (окно открыто и отменено — ничего не остановлено), подключений и остатков. Замены:

### docs/demo-script.md

| Было | Стало |
|---|---|
| — (меню не было описано) | «Меню слева»: Overview — Setup, Shadow mode; Pricing — Why this price, Strategies, Price changes, Stopped changes, Dangerous changes, Bounds; Stock — Stock, **Offers**, **Unit cost import**; **Workspace** — Channel accounts, Omnibus, Bulk operations, Stop pricing; над меню — **«← All workspaces»** |
| «у демо она есть только из-за Kaufland de» | «… из-за kaufland.de» |
| Вступление тени целиком | подзаголовок первым предложением и ссылка **«Learn more»** |
| «Decisions made: N; of them the price would have changed M times» в сводке | четыре плитки **Decisions**, **Price would change**, **Writes held**, **Without the floor** («not a forecast»); строка «Decisions made» в сводке экрана больше не повторяется (осталась в письме) |
| «Without the floor you would have sold $… cheaper — counted on … holds» | «… cheaper in total — counted on the N holds where we still keep what the strategy wanted» |
| Таблица аккаунтов: «у каждого «shadow (nothing is written)» и поле «type the account name exactly»» | колонки «Channel account», «Write mode», «Live writes»; у аккаунта Amazon ЕС вместо поля — пилюля **«waiting for access»** и «Nothing to switch on yet: …»; у трёх подключённых — «To switch on live writes, type the account name exactly: …» |
| «Строки: … ссылка **Why**» | колонки «Offer», «Would have been written», «Held at»; ссылка **«Why this price»** у цены, у остатка («… pieces») ссылки нет |
| «В меню «Why this price» список…» | «… открывается список «Price decisions» … (ссылка в строке — «Why»)» |
| «Target $12.49 is below min_price — capped at $14.00.» (дважды) | «Target $12.49 is below **your minimum price** — capped at $14.00.» |
| «Input check (rule set r49.1)» (дважды) | «Input check» |
| — | у amazon.com: «Competitor snapshot: Amazon, notification of a competitor price change» |
| стратегия «Beat the lowest: undercut by $0.01, against visible offers» | «… ; outside bounds — use the bound (version 1)» |
| «Price $14.00 approved within $14.00–$50.00», «пол $14.00, минимальная маржа 12 %» | «Price $14.00 approved within $14.00–$50.00.», «Floor: $14.00», «Minimum margin: 12%» |
| «Full snapshot — available until …» | «Full snapshot: available until …» |
| «Proposed €18.41 (−0.5%)», «Price before €18.50», «Bounds at calculation €12.00 – €30.00» | «Proposed €17.85 (−3.5%): Undercut the Buy Box €17.90 by €0.05: €17.85.», «Price before: €18.50», «Bounds at calculation: €12.00 – €30.00» |
| «Channel confirmation: пропущено — записи не было» | «Channel confirmation: not needed — No channel confirmation: the write is held by shadow mode (not sent)» |
| Границы: «пол маржи $6.85 …, действующий пол $14.00 = min_price» | «Unit cost: $5.00 (as you declared it)», «Minimum margin $6.85 — margin at least 12%», «Effective floor $14.00 — from your minimum price», «Margin $6.90»; экран — «Bounds and price floor» |
| Kaufland: «пол = min_price €12.00» | «Effective floor €12.00 — from your minimum price»; в ответе зрителю «минимальная цена (minimum price)» вместо `min_price` |
| Таблица остановок: заголовки «Holds / Set by / Release», «a tenant stop — the owner with a second factor» | «Kind / What it holds / Who sets it / How it ends», «the whole workspace — the owner with a second factor» |
| карточка **«Kaufland de»**, кнопка **«Stop…»**, «окно сверху страницы» | карточка **«kaufland.de»**, кнопка **«Stop»**, окно **поверх страницы по центру** (страница затемнена) |
| «Stop all price changes: Kaufland de?» | «Stop all price changes: kaufland.de?» |
| «Not stopped: … A write already sent to the channel» | «… A write already sent to the channel: its outcome is accepted» |
| «Заметка — не короче 10 символов» | поле «Note — why (at least 10 characters)» |
| «Active stops: Kaufland de, «Stopped … · By: Owner (you)»» | карточка kaufland.de, пилюля «Stopped» и время, «By: Owner (you)», «Note: “…”» |
| **«Resume…»** | **«Resume»** → окно «Resume pricing: kaufland.de?» → «Yes, resume» |
| «аккаунт eBay (syn_demo_ebay_us_…, ebay.com)» | карточка **«eBay · syn_demo_ebay_us_… · ebay.com»** |
| «Your answer: another tool updates stock.» | «Answer saved.» и в строке вопроса — «Your answer: another tool updates stock.» |
| поле «Search» | флажок фильтрует сразу («N of 224 products match.», «Show all»); поиск — поле «Search by name or SKU» и кнопка «Search» |
| Таблица остатков: «SKU / … / Channel», «Kaufland · de — «held by shadow mode: …»» | «Product / On hand / Reserved / Available / Channels», «Plant pot, large · syn-prod-de-…», «Kaufland · kaufland.de», пилюля «held by shadow mode», ниже «to publish: 21; held by shadow mode: 21 would be sent (…) — nothing was sent; channel has not confirmed yet» |
| «уведомления ANY_OFFER_CHANGED» (описание модели конкурентов) | «уведомления о смене цены конкурента — на экране «Amazon, notification of a competitor price change»» |
| «Замер шага 76: 1 мин 25 с (база 19 с, неделя 61 с)» | «Замер шага 80: 85 с (база 18 с, стенд 66 с, из них неделя США 61 с, интерфейс 1 с)» и `caffeinate` |

### docs/demo-preflight.md (чеклист и таблица вопросов зрителя)

| Было | Стало |
|---|---|
| «Не дать машине уснуть — caffeinate -dims в отдельном терминале» | подготовка держит машину бодрствующей сама; крышку не закрывать |
| «на машине разработчика — ~1,5 минуты» | строка «Демо готово» с фазами; замер шага 80 — 85 с; дольше 5 минут — машина засыпала или занята |
| «кнопки «Sign in as Owner…»» | «карточки ролей «Sign in as Owner», «Sign in as Admin» и др.» |
| Сводка тени: «Decisions made: …» — больше 1000; «would have changed 0 times» | плитка «Decisions» больше 1000, плитка «Without the floor» в долларах; если плитка «Price would change» — 0, мир младше ~20 минут |
| «строки «… · amazon.com», «Why this price» в каждой» | «… · amazon.com» и «… · kaufland.de», «Why this price» в каждой строке с ценой (у «… pieces» ссылки нет) |
| «хотя бы одна строка с «Reserved 1»» (дважды) | «N of 224 products match.», 1 в колонке «Reserved» |
| «Loading…» дольше 8 секунд или «The service did not answer within 8 s» | «Loading… If there is no answer within N s, an error is shown.» или карточка «This screen could not be loaded» — «The service did not answer within 8 s. Try again in a minute.»; «Retry» в карточке |
| **«← All accounts»** | **«← All workspaces»** над меню |
| «у amazon.com — уведомление ANY_OFFER_CHANGED, у Kaufland — запрос Buy Box» | «Amazon, notification of a competitor price change», «Kaufland, Buy Box request», «Full snapshot: available until …» |
| «пол — наибольшее из min_price и пола маржи» | «… из минимальной цены («Minimum price») и пола маржи («Minimum margin»)»; экран «Bounds and price floor» |
| «Нижняя строка экрана: доступ канала хранится зашифрованным» | «Пояснение в рамке внизу экрана: «We keep the access of the channel encrypted and never show it — …»» |

Остались прежними, потому что совпадают с экраном:

- «Shadow mode», «Why this price», «Stop pricing», «Channel accounts», «Stock», «Omnibus»;
- «Sign in as Owner», «Demo store (simulator)», «Your workspaces», «awaiting access: 1»;
- «Switch on live writes», «Back to shadow», «Yes, stop», «Yes, resume», «Yes — stock», «Yes — prices»;
- «Only products with reservations», «Before anything is written», «Three kinds of stop», «Audit log of stops».

Строка «Products 224: with stock 200; …» — это текст сводки остатков: речь о товарах, а не о названии экрана.
