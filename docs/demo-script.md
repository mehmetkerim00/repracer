# Демо-сценарий показа клиенту (~10 минут)

Воспроизводимый показ на демо-тенанте [Р-151]: данные синтетические, путь настоящий — те же роли базы, путь решения и исполнитель
заданий, что у продавца. Язык показа — английский (первый пилотный клиент — продавец из США). Ожидаемые экраны ниже сверены
**проходом браузером** (шаг 76: безголовый Chrome по `http://127.0.0.1:5173`, снимок и текст каждого экрана) — до него сценарий
сверялся только через API стенда, и страница консоли в браузере была пустой. День показа — [чеклист](demo-preflight.md).

## Подготовка — одна команда

```sh
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=<суперпользователь PostgreSQL> scripts/demo-prepare.sh
```

Команда [scripts/demo-prepare.sh](../scripts/demo-prepare.sh):

- проверяет, что порт стенда 4318 свободен (иначе показ пошёл бы на старом мире), что `127.0.0.1:5173` свободен, и предупреждает,
  если на 5173 слушает чужое приложение — тогда адрес `localhost:5173` откроет его, открывайте только `http://127.0.0.1:5173`;
- проверяет, что код страницы консоли не тянет модулей Node (`scripts/browser-imports.mjs`) — иначе страница пустая (шаг 76);
- создаёт свою базу `repracer_demo` (тестовую `repracer_eu` и шаблон тестов не трогает);
- поднимает стенд с демо-тенантом в тени (`REPRACER_DEMO_SHADOW=on`) и с витринами США (`REPRACER_DEMO_US=on`); на стенде **только
  демо-магазин** (`REPRACER_DEMO_ONLY=on`, шаг 76: без него после входа зритель видел три десятка миров сценариев стенда с описаниями
  для разработчиков); первый экран — английский (`REPRACER_CONSOLE_LOCALE=en`); вход живёт 12 часов (`REPRACER_STAND_TOKEN_SECONDS`;
  прежние 15 минут истекали посреди показа);
- шаг 68: витрины США считают тень в долларах (себестоимость, границы и стратегии заведены), и их **неделя тени прожимается** при подъёме
  (`REPRACER_DEMO_PRESS_DAYS`, по умолчанию 7): решения ложатся в прошлые семь суток, недельное письмо показуемо сразу;
- шаг 69: демо-тенант говорит по-английски, а времена показывает в поясе клиента из США (`REPRACER_DEMO_LOCALE=en`,
  `REPRACER_DEMO_TIME_ZONE=America/Los_Angeles` по умолчанию). Язык и пояс — свойства тенанта: переключатель языка браузера их не меняет;
- поднимает интерфейс на `http://127.0.0.1:5173` и ждёт, пока он ответит;
- ждёт первых решений и печатает запрос-доказательство для шага «а».

Замер шага 76 (машина разработчика): от запуска до «Демо готово» — **1 мин 25 с** (база 19 с, прожатая неделя США 61 с).

Ключей каналов не нужно: Kaufland — симулятор, аккаунты eBay US и Amazon US записаны функцией обнаружения каталога; конкуренты amazon.com —
модель порта Amazon (уведомления ANY_OFFER_CHANGED, конкурент сползает ниже пола и возвращается), у eBay US стратегия от себестоимости:
конкурентов eBay в бою мы не видим [Р-190].

**Запускайте за час до показа.** Время демо-мира настоящее, секунда в секунду (ускорять его нельзя: у базы свои часы — ревью шага 34,
находка 9). Прожатая неделя США — исключение, и честное: она идёт на виртуальных часах ПРОШЛОЙ недели до настоящего момента, решения
ложатся в прошлые сутки, а дальше витрины США живут настоящим временем; подъём из-за неё дольше на 0,5–2 минуты. Kaufland — с момента
запуска: конкурент с дрейфом двигает цену раз в 20 минут, первая волна цен — через ~40 минут, подрезчик отвечает на наши цены через
15 минут, заказ приходит раз в 4 минуты. Замер шага 76: первая резервация — на 5-й минуте после «Демо готово», первое изменение
цены Kaufland — на 19-й (у шага 64 — на 21-й); через час на экранах есть и изменения цен, и резервации. Перезапуск команды — новый мир
с нуля.

В браузере: `http://127.0.0.1:5173` (не `localhost`) → экран входа уже по-английски → **Sign in as Owner** → одна карточка
**Demo store (simulator)** с пометкой **Demo** → нажатие открывает сразу **Shadow mode**. Перезагрузка страницы (F5) — выход: токен
живёт только в памяти вкладки; снова «Sign in as Owner», адрес экрана сохраняется.

### Что демо не показывает (сказать клиенту прямо)

- **Неделя тени США — прожатая синтетика.** Это настоящий путь решения на виртуальных часах прошлой недели; цифры выдуманы, и экран и
  письмо помечены «Demo: synthetic data». Kaufland (евро) — только с момента запуска.
- **Конкуренты США — модель.** У amazon.com — модель порта Amazon; у eBay US конкурентов нет вовсе (в бою Browse недоступен, Р-190),
  поэтому там цена от себестоимости. Запись в каналы США — только в тени: бой на amazon.com и ebay.com закрыт неподтверждённой границей
  суток, и отказ это объясняет словами (шаг «а»).

## 0. Вход (30 с)

**Экран — список миров («Your workspaces»):** одна карточка «Demo store (simulator)», описание «Synthetic store on the channel simulator:
every offer has three competitors — one drifting, one undercutting, one in price waves.», пометки **Demo** и **awaiting access: 1**
(аккаунт Amazon ЕС ждёт доступа [Р-150]), счётчики «Owner · Offers 224 · decisions (24 h) … · interventions (7 days) …».

**Внутри мира — баннер:** «Demo workspace: synthetic data, real path. Every amount is made up.»

Что сказать: это тот же продукт, что у вас будет, — только канал симулирован и цифры выдуманы.

Меню мира строится по витринам тенанта: вкладка **Omnibus** — правило ЕС, и у демо она есть только из-за Kaufland de. У продавца только с
витринами США её нет вовсе (шаг 68, K3) — если клиент спросит, это ответ.

## а. Тень: «система физически не может трогать цены» (2,5 мин)

**Экран «Shadow mode».** Ожидаемое:

- **Вступление:** «The channel is connected and the engine runs completely — snapshots, checks, strategy, bounds, explanation. Nothing is
  written to the channel: every change below was held.»
- **Сводка за «Last 7 days»:**
  - «Decisions made: N; of them the price would have changed M times»;
  - «The price landed exactly on the floor K times — the floor decided it, and without the floor it would have gone lower»;
  - «Writes held by the shadow: X (prices P, stock S)»;
  - «Of them about N would have used the external edit budget of the channel — approximate: the day boundary of the storefront is not
    confirmed…» — бюджет правок есть у eBay, а граница его суток не подтверждена, поэтому «примерно» [Р-188].

  Сразу после подъёма — неделя США: около тысячи решений, «Without the floor you would have sold $… cheaper — counted on … holds»; через
  час добавляются тысячи решений Kaufland в евро.
- **Блок «Weekly email — preview»** (шаг 68, K7): то самое недельное письмо тени, собранное той же функцией, что у доставки, за
  последние семь суток, с пометкой «Demo: synthetic data. This is the email a seller in shadow mode receives every Monday…». Демо-тенанту
  письмо не отправляется (0167) — поэтому оно на экране.
- **Таблица аккаунтов:** Amazon (syn-amazon-…, **0 offers** — это аккаунт Amazon ЕС, ожидающий доступа [Р-150]; чего он ждёт, называет
  экран Channel accounts), Kaufland (syn-…, 200 offers), eBay (syn_demo_ebay_us_…, 12), Amazon (A1SYNDEMOUS…, 12) — у каждого
  «shadow (nothing is written)» и поле «type the account name exactly» с кнопкой «Switch on live writes».
- **Под таблицей:** «Live writes stay closed: we do not know amazon.com · Day boundary of the price history, ebay.com · …». Что мы не
  знаем про витрину, держит боевой режим закрытым [Р-172] — у amazon.com и ebay.com граница суток не подтверждена каналом. Таблица
  «What we still do not know about these storefronts» — словами: витрина, свойство, значение («net, sales tax added at checkout»), кто
  подтверждает. Если владелец всё же нажмёт «Switch on live writes» на amazon.com, отказ скажет: «Live writes on amazon.com stay closed:
  the day boundary of the price history of this storefront is not confirmed yet. This is usually settled within a week of shadow mode: after
  seven days of shadow decisions our team checks your shadow data… and then live writes open. Nothing is needed from you.» (шаг 69, Р-204).
  Обещание — ровно это: неделя тени, затем проверка командой платформы. Процедура — [runbook-day-boundary.md](runbook-day-boundary.md);
  подтверждением канала её не называть, вопрос каналу остаётся открытым.
- **Строки:** удержанные записи — offer, значение, время, ссылка **Why**.

**Доказательство из базы** (в терминале; команду печатает подготовка):

```sh
psql -d repracer_demo -c "SELECT final_status, count(*) AS writes, count(dispatched_at) AS sent_to_channel
  FROM tenant_data.channel_write_history WHERE tenant_id IN (SELECT tenant_id FROM tenant_data.tenant WHERE demo) GROUP BY 1"
```

Ожидаемое — одна строка `SHADOW_HELD | X | 0`: всё удержано, в канал не ушло ничего.

Что сказать — почему «физически»:

- режим записи — свойство аккаунта в базе, а не флаг в программе [Р-169];
- удержанная запись рождается завершённой, и база отклоняет у неё любой след отправки (ограничение
  `channel_write_history_shadow_never_left`);
- переход записи в отправку база проверяет перед КАЖДОЙ отправкой заново. Отправить её нечем ни диспетчеру, ни повтору после отказа.

Кнопка «Switch on live writes»:

- только владелец;
- второй фактор;
- имя аккаунта нужно набрать руками.

«Back to shadow» — одно нажатие [Р-170].

## б. «Почему эта цена» (2 мин)

На экране тени — **Why this price** в строке таблицы удержанных записей (строки amazon.com прожатой недели есть сразу; ссылка в меню
с тем же именем ведёт на список решений, а не на строку). В меню «Why this price» список начинается со строк Kaufland «No change» —
фильтра по исходу нет, строку **Approved** листайте; поэтому показывайте из экрана тени.

**Экран решения amazon.com** (шаг 68, записано прогоном `demo-us-live`): предложение подписано словами — «Plant pot, green · amazon.com».

- **Заголовок:** «The price $14.00 was approved; write: held by shadow mode (not sent)».
- **Strategy:** «Proposed $14.00 (−24.3%): Target $12.49 is below min_price — capped at $14.00.»; шаги расчёта — «Undercut the lowest
  price $12.50 by $0.01: $12.49.» и «Target $12.49 is below min_price — capped at $14.00.»; стратегия — «Beat the lowest: undercut by
  $0.01, against visible offers».
- **Price Gate:** «Price $14.00 approved within $14.00–$50.00», пол $14.00, минимальная маржа 12 %.
- **Input check (rule set r49.1):** «Snapshot accepted: 9 rules checked»; «Anchor 2: consistency of the snapshot — skipped: fewer
  competitor offers than the 3 needed» — правило и порог, без чисел канала.
- **Write to the channel:** «$14.00: held by shadow mode (not sent)», «Not sent: this channel account is in shadow mode…».

**Экран решения Kaufland** (записано с демо, цена конкурента сдвинулась):

- **Заголовок:** «The price €18.41 was approved; write: held by shadow mode (not sent)».
- **Competitor snapshot:** источник «Kaufland, Buy Box request», время наблюдения; «Full snapshot — available until …» (полный снимок
  хранится 18 месяцев [Р-68]).
- **Input check (rule set r49.1):** «Snapshot accepted: 9 rules checked» — витрина не остановлена, структура снимка, свежесть, массовый
  сдвиг, ошибка ×100, якоря [Р-42].
- **Plausibility anchors:** «Used: unit cost, other offers in the snapshot, price history» [Р-49].
- **Strategy:** «Proposed €18.41 (−0.5%)», «Price before €18.50», «Bounds at calculation €12.00 – €30.00».
- **Price Gate:** «Price €18.41 approved within €12.00–€30.00» и список проверок: не остановлено человеком, границы заданы, пол маржи
  посчитан, не ниже пола, не выше потолка [Р-44, Р-83].
- **Write to the channel:** «€18.41: held by shadow mode (not sent)». Причина: «Not sent: this channel account is in shadow mode, so nothing is written to the channel…».
- **Channel confirmation:** пропущено — записи не было.

Что сказать:

- каждое решение объясняет себя само: снимок, проверки, стратегия, границы, итог;
- цену конкурента в вечном объяснении мы **не храним** — это данные канала [Р-85]. Три дня её держит горячая запись решения [Р-28], и
  строка стратегии показывает суммы; у решения старше — правило словами: «Undercut the Buy Box price seen at that moment by €0.05. The
  decision keeps amounts taken from competitor prices for 3 days, so they are no longer shown; the full snapshot is linked in the
  snapshot step.» (шаг 68, K11);
- решение без изменения цены хранит только код причины [Р-74], поэтому для показа берите строку с исходом **Approved**.

**Границы — только у amazon.com.** Рядом с подписью предложения на экране решения — ссылка **«Bounds and floor»** (шаг 76): разбивка пола
до цента. У товара amazon.com она отвечает на вопрос «что помешает продать ниже себестоимости»: себестоимость $5.00, пол маржи $6.85
(минимальная маржа 12 %), действующий пол $14.00 = min_price, маржа на полу +$6.90. **У товаров Kaufland демо минимальная маржа не
задана**: пол = min_price €12.00 при себестоимости €10.75, и экран честно покажет маржу на полу −€2.47. Если зритель откроет её сам —
это ответ, а не сбой: «без минимальной маржи пол — только min_price, который вы задали; экран видит убыток до цента; задайте минимальную
маржу — и пол поднимется до неё, а цену ниже пола движок поднимет сам» (Р-207). Отложено в [deferred.md](deferred.md).

## в. Три стоп-крана (2 мин)

**Экран «Stop pricing».** Таблица трёх видов остановки:

| Вид | Holds | Set by | Release |
|---|---|---|---|
| Stop by a person | All prices | Owner or operator, with a note | A person with a note; a tenant stop — the owner with a second factor |
| Storefront halt | Only competitor-derived prices | System: broken input data | Fresh sample where the channel allows it, otherwise a person |
| Channel distrust | All prices and the channel price threshold | System: the channel changes our numbers | Only a person: owner or admin, second factor, note |

**Живое действие — остановка человеком:**

1. Блок **Storefronts** → карточка **Kaufland de** → кнопка **«Stop…»**. Окно подтверждения сверху страницы: «Stop all price changes:
   Kaufland de?», «All prices of 200 offers stop changing. The owner or an operator can resume it with a note.» и «Not stopped: Stock
   synchronization; A write already sent to the channel».
2. Заметка — **не короче 10 символов** (кнопка «Yes, stop» до этого неактивна), например «Demo: checking the stop crane», → **«Yes,
   stop»**. Ответ: «Stopped. All prices of 200 offers stop changing.»
3. Ниже — «Active stops»: Kaufland de, «Stopped … · By: Owner (you)», заметка; «Audit log of stops» — строка «Pricing stopped». Новые
   решения по витрине — «Pricing stopped by a person».
4. **«Resume…»** с заметкой → **«Yes, resume»** → «Pricing resumed.»; в журнале вторая строка, остановка уходит в «Resumed» со временем
   остановки и заметкой снятия. Весь шаг в проходе шага 76 — 2,5 с без ожиданий.

**Две системные остановки** в демо вручную не вызываются: их ставит система, когда вход испорчен (массовый сдвиг цен конкурентов) или
канал меняет наши числа (цена покупателя отличается от отправленной ровно на ставку налога) [Р-118]. Показать таблицу и сказать: они в
том же списке, снимает их только человек, а у недоверия каналу — владелец или админ со вторым фактором.

Внизу экрана: «Stock synchronization» и «A write already sent to the channel: its outcome is accepted» — чего остановка НЕ касается.

## г. Внешние писатели: «мы не подерёмся с вашим PrepShipHub» (1,5 мин)

**Экран «Channel accounts»**, аккаунт eBay (syn_demo_ebay_us_…, ebay.com):

- «shadow: connected, nothing is written»;
- «Found 12 offers; the shadow made N decisions in the last 24 hours.» (шаг 68: тень США считает);
- **вопрос:** «Does another tool update stock or prices in this channel?» — «Not answered yet.»;
- **запись остатка:** «Stock writes to this channel: off — the owner has to confirm that no other tool manages stock here.» и «Answer the
  question above first.»

**Живое действие:** нажать **«Yes — stock»** у аккаунта eBay (ответ сохраняется сразу, отдельной кнопки нет; пусть это PrepShipHub
клиента). Ожидаемое:

- «Your answer: another tool updates stock.»;
- «Another tool updates stock in this channel: if we wrote stock too, the two would overwrite each other. Stock writes stay off until that
  tool is switched off and the answer is changed.»;
- кнопки подтверждения записи остатка нет.

Даже прямой запрос на подтверждение (мимо экрана) база отклоняет: «You told us another tool updates stock in this channel: our stock
writes would overwrite it and it would overwrite ours. Stock writes stay off; switch that tool off and change your answer first.»
(409 `OTHER_TOOL_MANAGES_STOCK`) [Р-202].

Ответ **«Yes — prices»** показывает предупреждение: «Two repricers on one channel are not allowed: each would react to the prices of the
other…».

Ниже — «External edits in the last 24 hours: 0». Если в канале появится цена или остаток, которых мы не писали, счётчик это покажет.

Что сказать: по умолчанию мы остатки в канал не пишем вовсе, пока владелец не подтвердил, что другой инструмент их не ведёт. Подтверждение
отзывается тем же экраном и выключает запись остатка сразу.

## д. Продажа: резервация и остатки (2 мин)

**Экран «Stock».** Сводка сверху:

> «Products 224: with stock 200; offers in sync 200; writes in flight 0; divergences 0; open reservations R.»

Заказ в симуляторе приходит раз в 4 минуты, поэтому через час R > 0.

Сверху таблицы — 24 товара США с нулями: источник остатков демо ведёт только каталог Kaufland (цены США показаны на тени и в «Why this
price»). Поставьте флажок **«Only products with reservations»** (или ищите по названию и SKU в поле «Search», шаг 69, K8) — останутся
строки с заказами. Первая резервация в проходе шага 76 появилась на 5-й минуте после запуска. Ожидаемая строка, например:

| SKU | On hand | Reserved | Available | Channel |
|---|---|---|---|---|
| syn-prod-de-340100168 | 24 | 1 | 23 | Kaufland · de — «held by shadow mode: 21 would be sent (…) — nothing was sent» |

Что сказать:

- **заказ канала стал резервацией** [Р-25]: на складе 24, одна штука обещана покупателю, доступно 23;
- **в канал идёт общий остаток минус буфер канала** [Р-6]: 23 − 2 = 21;
- **в тени и это количество удержано**, в канал ничего не ушло;
- через час симулятор отгружает заказ: резервация закрывается, и на складе остаётся 23 — списание движением базы, а не правкой числа.

Под таблицей — «Before anything is written». Там названы ловушки каналов ДО первой записи [Р-153]:

- у Kaufland остаток общий для витрин;
- у Amazon остаток MFN — одно значение на весь регион аккаунта; для amazon.com это Северная Америка.

## Если что-то пошло не так

Порядок действий и перезапуск — [docs/demo-preflight.md](demo-preflight.md), раздел «Если завис экран или упал процесс».
