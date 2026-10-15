# Демо-сценарий показа клиенту (~11 минут)

Воспроизводимый показ на демо-тенанте [Р-151]: данные синтетические, путь настоящий — те же роли базы, путь решения и исполнитель
заданий, что у продавца. Язык показа — английский (первый пилотный клиент — продавец из США). Шаг 87 [Р-214]: развёртывание и демо — в
профиле рынка **us**: американский продавец (amazon.com, ebay.com и с шага 89 walmart.com, доллары, склад «Warehouse Newark, DE»), без Kaufland, витрин ЕС,
немецкого и вкладки Omnibus; прежнее европейское демо поднимается `REPRACER_MARKET_PROFILE=eu`. Ожидаемые экраны ниже сверены
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
- создаёт свою базу `repracer_demo` (тестовую `repracer_eu` и шаблон тестов не трогает); в профиле us база — региона US [Р-60]: данные
  американского продавца живут в базе его региона;
- поднимает стенд в профиле рынка `REPRACER_MARKET_PROFILE` (по умолчанию **us**) с демо-тенантом в тени (`REPRACER_DEMO_SHADOW=on`):
  тенант рождается с аккаунтом amazon.com, рядом — ebay.com и walmart.com (шаг 89), по 12 предложений; на стенде **только
  демо-магазин** (`REPRACER_DEMO_ONLY=on`, шаг 76: без него после входа зритель видел три десятка миров сценариев стенда с описаниями
  для разработчиков); первый экран — английский (`REPRACER_CONSOLE_LOCALE=en`); вход живёт 12 часов (`REPRACER_STAND_TOKEN_SECONDS`;
  прежние 15 минут истекали посреди показа);
- шаг 68: витрины США считают тень в долларах (себестоимость, границы и стратегии заведены), и их **неделя тени прожимается** при подъёме
  (`REPRACER_DEMO_PRESS_DAYS`, по умолчанию 7): решения ложатся в прошлые семь суток, недельное письмо показуемо сразу;
- шаг 69: демо-тенант говорит по-английски, а времена показывает в поясе клиента из США (`REPRACER_DEMO_LOCALE=en`;
  `REPRACER_DEMO_TIME_ZONE` по умолчанию в профиле us — America/New_York: первый клиент — в Делавэре). Язык и пояс — свойства тенанта;
  в профиле us переключателя языка нет вовсе — английский один;
- шаг 87: остатки — склад «Warehouse Newark, DE» (60 штук каждого товара), синхронизация количества amazon.com включена, спрос —
  синтетические заказы amazon.com: первый через 2 минуты после запуска, дальше раз в 10 минут, отгрузка через час;
- шаг 91 (вид преп-центра): рядом с главным демо — два лёгких продавца, **Blue Ridge Trading** (6 предложений на amazon.com и 6 на
  ebay.com) и **Lakeside Home Goods** (по 5): свои пространства с пометкой демо, оба в тени, неделя тени прожата так же. Владелец
  стенда (строка «Owner» на входе) — менеджер у Blue Ridge и наблюдатель у Lakeside: у человека в пространстве одна роль [Р-213]
  (`REPRACER_DEMO_SELLERS`, в профиле us по умолчанию включено);
- поднимает интерфейс на `http://127.0.0.1:5173` и ждёт, пока он ответит;
- ждёт первых решений и печатает запрос-доказательство для шага «а».

Замер шага 87 (машина разработчика, профиль us): от запуска до «Демо готово» — **51 с** (база 19 с, стенд 31 с, из них прожатая неделя
США 29,7 с, интерфейс 1 с; у европейского демо шага 80 — 85 с); строка «Демо готово» печатает эти числа сама. Подготовка держит машину бодрствующей до Ctrl+C (`caffeinate`, шаг 80):
сон macOS остановил подготовку шага 79 на 34 минуты — машина спала, а не считала. Шаг 89 добавил прожатую неделю walmart.com (опрос
Buy Box раз в два часа на товар): подготовка дольше примерно на 20 с — замер — в [отчёте шага](evidence/step89-walmart.md). Шаг 91 — с двумя
лёгкими продавцами (неделя тени прожата и у них): **102 с** (база 18 с, стенд 83 с, из них неделя главного демо 54,8 с и продавцы 27,5 с,
интерфейс 1 с) — [отчёт шага](evidence/step91-agency.md).

Ключей каналов не нужно: аккаунты eBay US и Amazon US записаны функцией обнаружения каталога; конкуренты amazon.com —
модель порта Amazon (уведомления о смене цены конкурента — на экране «Amazon, notification of a competitor price change»; конкурент сползает ниже пола и возвращается), у eBay US стратегия от себестоимости:
конкурентов eBay в бою мы не видим [Р-190]. Walmart (шаг 89) — HTTP-модель канала по правилам настоящего Walmart (ключей Walmart у
платформы нет, [docs/channels/walmart.md](channels/walmart.md)): конкуренты Buy Box — три поведения, как у amazon.com (дрейф, подрезчик,
волна), квоты — корзиной токенов с заголовками настоящего Walmart, и правило неконкурентной цены — у двух товаров цена на walmart.com
$24.99, а тот же товар «в другом месте» — $19.99, и модель снимает их с публикации.

**Запускайте за полчаса до показа.** Время демо-мира настоящее, секунда в секунду (ускорять его нельзя: у базы свои часы — ревью шага 34,
находка 9). Прожатая неделя США — исключение, и честное: она идёт на виртуальных часах ПРОШЛОЙ недели до настоящего момента, решения
ложатся в прошлые сутки, а дальше витрины США живут настоящим временем. После запуска: конкурент amazon.com меняет цену раз в два часа
у каждого предложения (со сдвигом по предложениям), пересчёт eBay — раз в 15 минут, Buy Box walmart.com — раз в 15 минут, состояние
публикации walmart.com — раз в 10 минут, заказ amazon.com — раз в 10 минут. Замер шага 87:
первая резервация — на 2-й минуте после «Демо готово». Перезапуск команды — новый мир с нуля.

В браузере: `http://127.0.0.1:5173` (не `localhost`) → экран входа уже по-английски (шаг 92: по центру знак PriceTrail — линия цены, удержанная в конце, — и строчное имя **pricetrail**, под ними строка
«Repricing you can audit», под ними карточка входа; шаг 84 — роли строками: цветной кружок, имя роли и что роль может; шаг 88 —
ровно три роли: **Owner** «everything, plus people, channel accounts and live writes», **Manager** «prices, bounds, strategies, stock,
unit cost import, bulk operations, stop pricing», **Viewer** «read-only») → строка **Owner** (переключателя языка в шапке нет —
профиль us; шаг 94: справа в шапке — кнопка темы иконкой (солнце, луна, монитор): нажатие ведёт по кругу Light → Dark → System, выбор хранится в этом браузере, «System» следует теме системы; после входа там имя
человека **Alex Porter**, адрес — подсказкой при наведении) → три карточки (шаг 91): **Demo store (simulator)** — «Owner», **Blue Ridge Trading** — «Manager», **Lakeside Home Goods** —
«Viewer», у всех пометка **Demo** → нажатие на «Demo store (simulator)» открывает сразу **Shadow mode**. Перезагрузка страницы (F5) — выход: токен
живёт только в памяти вкладки; снова строка «Owner», адрес экрана сохраняется.

### Что демо не показывает (сказать клиенту прямо)

- **Неделя тени США — прожатая синтетика.** Это настоящий путь решения на виртуальных часах прошлой недели; цифры выдуманы, и экран и
  письмо помечены «Demo: synthetic data».
- **Заказы — тоже модель:** синтетические заказы amazon.com без данных покупателя; резервация, отгрузка и списание — настоящий путь.
- **Конкуренты США — модель.** У amazon.com — модель порта Amazon; у eBay US конкурентов нет вовсе (в бою Browse недоступен, Р-190),
  поэтому там цена от себестоимости. Запись в каналы США — только в тени: бой на amazon.com, ebay.com и walmart.com закрыт неподтверждённой
  границей суток, и отказ это объясняет словами (шаг «а»).
- **Лёгкие продавцы вида преп-центра — синтетика** (шаг 91): их пространства, роли и цифры заведены посевом. В работе продавец
  приглашает преп-центр в своё пространство сам и назначает роль; сводной панели по всем продавцам, партнёрских тарифов и приглашений
  от лица преп-центра нет — это решения после встречи.
- **Walmart — целиком на симуляторе** (шаг 89): ключей Walmart у платформы нет, подключить его продавец пока не может (экран подключений
  говорит это словами), живой адаптер — отдельным шагом. Порог правила неконкурентной цены (10 %) и цена «в другом месте» — параметры
  модели, а не факты Walmart (вопросы W-10, W-11). Движок снятие с публикации не чинит — только показывает.

## 0. Вход (30 с)

**Экран — список миров («Your workspaces»):** три карточки (шаг 91). Первая — «Demo store (simulator)», описание «Synthetic American
seller on the channel simulator: offers on amazon.com, ebay.com and walmart.com, a warehouse in Newark, Delaware.», пометка **Demo**;
под ними показатели (шаг 84) — **Offers** 36, **Decisions 24h** …, **Interventions 7d** … и подпись роли «Owner». Рядом — **Blue Ridge
Trading** (Offers 12, роль «Manager») и **Lakeside Home Goods** (Offers 10, роль «Viewer»), описание «Synthetic American seller on the
channel simulator: offers on amazon.com and ebay.com, in shadow mode.»; их показ — раздел «ж». Пометка «test environment, synthetic data» в шапке — только здесь и на входе: внутри магазина её роль играет
жёлтая полоса.

**Внутри мира — баннер:** «Demo workspace: synthetic data, real path. Every amount is made up.»

Что сказать: это тот же продукт, что у вас будет, — только канал симулирован и цифры выдуманы.

**Меню слева** (шаг 95 [Р-217] — девять пунктов вместо четырнадцати): **Overview** — Shadow mode; **Pricing** — Price changes,
Strategies, Costs & floors, Protections; **Stock** — Offers, Stock; **Workspace** — Channels, Stop pricing. Что сказать: «функции те же —
меньше дверей»: журнал цен один (решения — фильтром Kind), границы и себестоимость — на одном экране, защиты — на одном, путь подключения
и аккаунты каналов — на одном, массовые операции — кнопкой «Bulk edit» на Offers.
Над меню — имя магазина и ссылка **«← All workspaces»** (к списку магазинов).

Вкладки **Omnibus** нет: это правило ЕС о прежней цене скидки, а профиль us его не предлагает (шаг 87) — у продавца только с витринами
США её не было и раньше (шаг 68, K3). Если клиент спросит про Европу: она в продукте есть и заморожена — открывается профилем рынка.

## а. Тень: «система физически не может трогать цены» (2,5 мин)

**Экран «Shadow mode».** Ожидаемое:

- **Подзаголовок:** «The channel is connected and the engine runs completely — snapshots, checks, strategy, bounds, explanation.» и ссылка
  **«Learn more»** — раскрывает: «Nothing is written to the channel: every change below was held.»
- **Сводка за «Last 7 days»** (переключатель «Last 7 days» / «Last 30 days» над сводкой) — четыре белые плитки с крупным числом
  (шаг 83): **Decisions**, **Price would change**, **Writes held**, **Without the floor** с подписью «not a forecast». Под ними — карточка
  с графиком **«Decisions per day»** (шаги 82, 84): зелёные столбики решений тени по суткам в поясе магазина, ось значений слева, число
  над каждым столбиком, подписи дней снизу, последний столбик — сегодня. Ниже — карточка-список «показатель — значение» (шаг 84):
  - **Period** — «… — …»;
  - **Price landed exactly on the floor** — «K times», под подписью «the floor decided it, and without the floor it would have gone lower»;
  - **Price landed exactly on the ceiling** — «0 times»;
  - **Writes held by the shadow** — «X — prices P, stock S»;
  - **Would have used the external edit budget of the channel** — «about N»: бюджет правок есть у eBay, а граница его суток не
    подтверждена, поэтому «примерно» [Р-188];
  - **Without the floor you would have sold cheaper by** — «$…», под подписью «counted on the N holds where we still keep what the
    strategy wanted».

  Под списком сноской — «Approximate: the day boundary of the storefront is not confirmed, so the budget cannot be split by day.» и «That
  number is the difference between your floor and what the strategy wanted — not a forecast of revenue…».

  Сразу после подъёма — неделя США: около тысячи решений в числе **Decisions** (замер шага 87 — 1 068), на графике — ровная неделя
  (≈ 156 решений в сутки) и сегодняшний столбик; сегодняшний растёт тем же темпом — тень США живёт настоящим временем.
- **Блок «Weekly email — preview»** (шаг 68, K7): то самое недельное письмо тени, собранное той же функцией, что у доставки, за
  последние семь суток, с пометкой «Demo: synthetic data. This is the email a seller in shadow mode receives every Monday…». Демо-тенанту
  письмо не отправляется (0167) — поэтому оно на экране.
- **Карточки аккаунтов** (поля карточки «Channel account», «Write mode», «Live writes»): **Amazon · A1SYNDEMOUS… · amazon.com**,
  **eBay · syn_demo_ebay_us_… · ebay.com** и **Walmart · syn-demo-walmart-…** (шаг 89) — «12 offers, 12 of them with the engine on», у каждого «shadow (nothing is written)», «To
  switch on live writes, type the account name exactly: …», поле и кнопка «Switch on live writes».
- **Под таблицей:** «Live writes stay closed: we do not know amazon.com · Day boundary of the price history, ebay.com · …, walmart.com · …».
  Что мы не знаем про витрину, держит боевой режим закрытым [Р-172] — у всех трёх витрин граница суток не подтверждена каналом. Таблица
  «What we still do not know about these storefronts» — словами: витрина, свойство, значение («net, sales tax added at checkout»), кто
  подтверждает. Если владелец всё же нажмёт «Switch on live writes» на amazon.com, отказ скажет: «Live writes on amazon.com stay closed:
  the day boundary of the price history of this storefront is not confirmed yet. This is usually settled within a week of shadow mode: after
  seven days of shadow decisions our team checks your shadow data… and then live writes open. Nothing is needed from you.» (шаг 69, Р-204).
  Обещание — ровно это: неделя тени, затем проверка командой платформы. Процедура — [runbook-day-boundary.md](runbook-day-boundary.md);
  подтверждением канала её не называть, вопрос каналу остаётся открытым.
- **Строки** (колонки «Offer», «Would have been written», «Held at»): удержанные записи, новые сверху; у цены — ссылка **«Why this price»**,
  у остатка («… pieces») ссылки нет.

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

На экране тени — **Why this price** в строке таблицы удержанных записей (строки amazon.com прожатой недели есть сразу). Пункта меню
«Why this price» больше нет (шаг 95): все решения — в **Price changes** с фильтром **Kind → All decisions**; там вперемешку решения
пересчёта eBay и amazon.com, многие — «No change», фильтра по исходу нет; поэтому показывайте из экрана тени. Квитанция решения
остаётся своей страницей «Why this price», пункт меню над ней — Price changes.

**Экран решения amazon.com** (шаг 68, записано прогоном `demo-us-live`): предложение подписано словами — «Plant pot, green · amazon.com».

- **Итог** (шаг 83 — плашка янтарного фона, цена крупно): **$14.00**, под ней «The price $14.00 was approved; write: held by shadow
  mode (not sent)». У отказа — плашка красного фона, без цены, причина крупно одной фразой. Шаги расчёта — номера в цветных кружках
  (зелёный — пройден, красный — остановлен, серый — не нужен) на тонкой линии.
- **Competitor snapshot:** «Amazon, notification of a competitor price change», время наблюдения.
- **Strategy:** «Proposed $14.00 (−24.3%): Target $12.49 is below your minimum price — capped at $14.00.»; шаги расчёта («Calculation
  step») — «Undercut the lowest price $12.50 by $0.01: $12.49.» и «Target $12.49 is below your minimum price — capped at $14.00.»;
  стратегия — «Beat the lowest: undercut by $0.01, against visible offers; outside bounds — use the bound (version 1)».
- **Price Gate:** «Price $14.00 approved within $14.00–$50.00.», «Floor: $14.00», «Minimum margin: 12%».
- **Input check:** «Snapshot accepted: 9 rules checked»; «Anchor 2: consistency of the snapshot» — «skipped», «fewer competitor offers
  than the 3 needed» — правило и порог, без чисел канала.
- **Write to the channel:** «$14.00: held by shadow mode (not sent)», «Not sent: this channel account is in shadow mode…».

Что сказать:

- каждое решение объясняет себя само: снимок, проверки, стратегия, границы, итог;
- цену конкурента в вечном объяснении мы **не храним** — это данные канала [Р-85]. Три дня её держит горячая запись решения [Р-28], и
  строка стратегии показывает суммы; у решения старше — правило словами, без сумм канала (шаг 68, K11);
- решение без изменения цены хранит только код причины [Р-74], поэтому для показа берите строку с исходом **Approved**.

**Границы.** Рядом с подписью предложения на экране решения — ссылка **«Bounds and floor»** (шаг 76): разбивка пола до цента (экран
«Bounds and price floor»). У товара amazon.com она отвечает на вопрос «что помешает продать ниже себестоимости»: «Unit cost: $5.00 (as you
declared it)», «Minimum margin $6.85 — margin at least 12%», «Effective floor $14.00 — from your minimum price», в разбивке пола
«Margin $6.90»; комиссия — «fee schedule: 15% + $0.00 (2026-10) — the floor is computed from this one» (версия тарифа — месяц действия).

## в. Три стоп-крана (2 мин)

**Экран «Stop pricing».** Таблица трёх видов остановки:

| Kind | What it holds | Who sets it | How it ends |
|---|---|---|---|
| Stop by a person | All prices | Owner or manager, with a note | Owner or manager, with a note; the whole workspace — with a second factor |
| Storefront halt | Only competitor-derived prices | System: broken input data | Fresh sample where the channel allows it, otherwise a person |
| Channel distrust | All prices and the channel price threshold | System: the channel changes our numbers | Only a person: the owner, second factor, note |

**Живое действие — остановка человеком:**

1. Блок **Storefronts** → карточка **amazon.com** («Running», «All prices of 12 offers stop changing») → кнопка **«Stop»**. Окно
   подтверждения открывается поверх страницы, по центру (страница затемнена): «Stop all price changes: amazon.com?», «All prices of 12
   offers stop changing. The owner or a manager can resume it with a note.» и «Not stopped: Stock synchronization; A write already sent
   to the channel: its outcome is accepted».
2. Поле «Note — why (at least 10 characters)» — заметка **не короче 10 символов** (кнопка «Yes, stop» до этого неактивна), например
   «Demo: checking the stop crane», → **«Yes, stop»**. Ответ: «Stopped. All prices of 12 offers stop changing.»
3. Ниже — «Active stops»: карточка amazon.com с пилюлей «Stopped» и временем, «By: Owner (you)», «Note: “…”»; **«Audit log: stops, roles and channel events»** —
   строка «Pricing stopped». Ниже в том же журнале уже есть строка с подготовки демо: **«Role changed»** · «Owner (you)» ·
   «Jamie Lee: Viewer → Manager» (шаг 88: менеджер пришёл наблюдателем, владелец повысил его; у человека в пространстве одна
   роль — новая заменила прежнюю; шаг 93: человек назван по имени, адрес — подсказкой при наведении). Новые решения по витрине — «Pricing stopped by a person».
4. На карточке остановки — **«Resume»** → окно «Resume pricing: amazon.com?» с заметкой → **«Yes, resume»** → «Pricing resumed.»; в
   журнале вторая строка, остановка уходит в «Resumed» со временем остановки и заметкой снятия. Весь шаг в проходе шага 87 — 1,5 с без
   ожиданий.

**Две системные остановки** в демо вручную не вызываются: их ставит система, когда вход испорчен (массовый сдвиг цен конкурентов) или
канал меняет наши числа (цена покупателя отличается от отправленной ровно на ставку налога) [Р-118]. Показать таблицу и сказать: они в
том же списке, снимает их только человек, а недоверие каналу — только владелец со вторым фактором (шаг 89: снова поверить каналу — не
повседневная остановка, менеджеру это право не дано).

Внизу экрана: «Stock synchronization» и «A write already sent to the channel: its outcome is accepted» — чего остановка НЕ касается.

## г. Внешние писатели: «мы не подерёмся с вашим PrepShipHub» (1,5 мин)

**Экран «Channels»** (шаг 95). Сверху — раздел **Setup**: у демо путь не пройден и не пройдётся сам — «Resume at: Stock synchronization
enabled», 12 of 36 (запись количества eBay и Walmart ждёт подтверждения владельца [Р-202], об этом и рассказ ниже). Прокрутите к разделу
**«Channel accounts»** (или откройте адрес `…/channels/accounts`), карточка **eBay · syn_demo_ebay_us_… · ebay.com**:

- «shadow: connected, nothing is written»;
- «Found 12 offers; the shadow made N decisions in the last 24 hours.» (шаг 68: тень США считает);
- **вопрос:** «Does another tool update stock or prices in this channel?» — «Not answered yet.»;
- **запись остатка:** «Stock writes to this channel: off — the owner has to confirm that no other tool manages stock here.» и «Answer the
  question above first.»

**Живое действие:** нажать **«Yes — stock»** у аккаунта eBay (ответ сохраняется сразу, отдельной кнопки нет; пусть это PrepShipHub
клиента). Ожидаемое:

- «Answer saved.» и в строке вопроса — «Your answer: another tool updates stock.»;
- «Another tool updates stock in this channel: if we wrote stock too, the two would overwrite each other. Stock writes stay off until that
  tool is switched off and the answer is changed.»;
- кнопки подтверждения записи остатка нет.

Даже прямой запрос на подтверждение (мимо экрана) база отклоняет: «You told us another tool updates stock in this channel: our stock
writes would overwrite it and it would overwrite ours. Stock writes stay off; switch that tool off and change your answer first.»
(409 `OTHER_TOOL_MANAGES_STOCK`) [Р-202].

Ответ **«Yes — prices»** показывает предупреждение: «Two repricers on one channel are not allowed: each would react to the prices of the
other…».

Ниже — «External edits in the last 24 hours: 0». Если в канале появится цена или остаток, которых мы не писали, счётчик это покажет.

Рядом — карточка **Amazon · A1SYNDEMOUS… · amazon.com**: «Your answer: no other tool.» и «Stock writes to this channel: on — confirmed by
the owner.» — так выглядит канал, остатки которого ведёт склад демо.

Что сказать: по умолчанию мы остатки в канал не пишем вовсе, пока владелец не подтвердил, что другой инструмент их не ведёт. Подтверждение
отзывается тем же экраном и выключает запись остатка сразу.

## д. Продажа: резервация и остатки (2 мин)

**Экран «Stock».** Сводка сверху:

> «Products 36: with stock 36; offers in sync 12; writes in flight 0; divergences 0; open reservations R.»
>
> «Warehouse Newark, DE — File import (internal pool); 36 products with figures»

Заказ amazon.com приходит раз в 10 минут (первый — через 2 минуты после запуска), отгрузка — через час, поэтому R — от одного до шести.
«offers in sync 12» — синхронизацию количества ведёт amazon.com; у ebay.com и walmart.com она выключена (вопрос о других инструментах —
шаг «г», запись количества по Р-202 выключена до подтверждения владельца).

Сверху таблицы — товары с остатком по убыванию «Available», при равенстве выше — с резервами (шаг 84.1). Поставьте флажок **«Only products
with reservations»** — список фильтруется сразу, над таблицей «N of 36 products match.» и
кнопка «Show all» (или ищите по названию и SKU: поле «Search by name or SKU» и кнопка «Search», шаг 69, K8) — останутся строки с
заказами. Первая резервация в проходе шага 76 появилась на 5-й минуте после запуска. Ожидаемая строка, например:

| Product | On hand | Reserved | Available | Channels |
|---|---|---|---|---|
| Water bottle, green · SYN-DEMO-US-AMZ-01 | 60 | 1 | 59 | Amazon · amazon.com, пилюля «held by shadow mode»; ниже «to publish: 57; held by shadow mode: 57 would be sent (Oct 14, 2026, 08:00 UTC−4) — nothing was sent; channel has not confirmed yet» |

Что сказать:

- **заказ канала стал резервацией** [Р-25]: на складе 60, одна штука обещана покупателю, доступно 59;
- **в канал идёт общий остаток минус буфер канала** [Р-6]: 59 − 2 = 57;
- **в тени и это количество удержано**, в канал ничего не ушло;
- через час заказ отгружается: резервация закрывается, и на складе остаётся 59 — списание движением базы, а не правкой числа.

Под таблицей — «Before anything is written». Там названы ловушки каналов ДО первой записи [Р-153]:

- у Amazon остаток MFN — одно значение на весь регион аккаунта; для amazon.com это Северная Америка (владелец подтвердил это при
  включении синхронизации);
- у Walmart — одно значение на SKU на складе аккаунта по умолчанию; как оно ложится на несколько складов (ship nodes), Walmart не
  подтвердил (шаг 89, W-04).

## е. Walmart: паритет цен — «мы видим все каналы сразу» (1 мин)

**Экран «Offers»** (меню Stock → Offers; справа в шапке таблицы — кнопка **«Bulk edit»** к массовым операциям): «Total 36: on 36, …» — предложения трёх витрин одной таблицей. У двух предложений walmart.com
в колонке **«Channel says»** — красная пилюля **«Unpublished (uncompetitive price)»** и под ней коротко: «Cheaper elsewhere: $19.99.
Since Oct 7, 2026, 15:31 UTC−4; PriceTrail does not change the price here.» Наведите курсор на ячейку — подсказка с полным объяснением:

> «Walmart took this offer off walmart.com on Oct 7, 2026, 15:31 UTC−4: the same product is cheaper elsewhere ($19.99) — on another channel
> or sold by Walmart itself — and shoppers on walmart.com no longer see it. Bring the walmart.com price close to that price and Walmart
> publishes the offer again; PriceTrail does not change the price for you here.»

Время — момент подготовки демо минус неделя: Walmart снял их в первом же опросе прожатой недели. На телефоне таблица Offers листается
в своей рамке — колонка «Channel says» правее.

Это **Wall clock, small · walmart.com** и **Yoga mat, small · walmart.com**: «Current price» у них $24.99.

**Экран «Stop pricing»**, журнал **«Audit log: stops, roles and channel events»**: две строки «Offer unpublished: uncompetitive price» ·
«Walmart» · подпись предложения · «The same product is cheaper elsewhere ($19.99) — on another channel or sold by Walmart itself. PriceTrail
does not change the price for you here.» — событие канала рядом с остановками и сменами ролей, со временем.

Что сказать — паритет как причина пользоваться PriceTrail, а не страшилка:

- у Walmart есть правило: если тот же товар заметно дешевле на другой площадке или у самого Walmart, листинг снимается с публикации.
  Продавец, который ведёт цены каждой площадки отдельно, узнаёт об этом, когда продажи walmart.com уже встали;
- PriceTrail видит все каналы сразу — одна таблица, одно состояние у предложения, одно событие в журнале со временем и причиной;
- что делать с ценой — решает продавец: движок снятие с публикации сам не чинит (шаг 89), автоматический ответ — отдельное решение;
- честно: Walmart в демо — модель по правилам настоящего Walmart; ключей Walmart у нас пока нет, порог 10 % и цена «в другом месте» —
  параметры модели (W-10, W-11 в [docs/channels/walmart.md](channels/walmart.md)).

Если спросят «а тень?» — на экране тени у этих предложений уже есть удержанные записи ниже $19.99 по стратегии «Beat the lowest»: движок
считает цену как обычно, но в тени ничего не пишется, поэтому листинг остаётся снятым.

## ж. Для преп-центра: три продавца одним списком (1 мин)

Зачем: на вопрос «как я увижу своих продавцов?» ответ — экран, а не слова. Новых экранов и прав для этого нет: это рабочие пространства и
одна роль на человека в каждом [Р-9, Р-213].

1. **«← All workspaces»** над меню → **«Your workspaces»**: три карточки, у каждой свои показатели и своя роль подписью —
   «Demo store (simulator)» · Owner, «Blue Ridge Trading» · Manager, «Lakeside Home Goods» · Viewer (числа — прожатая неделя, порядок
   замера шага 91: Offers 12, Decisions 24h ~80, Interventions 7d ~260 у Blue Ridge; 10, ~65, ~220 у Lakeside).
2. Нажать **Blue Ridge Trading** → сразу **Shadow mode** этого продавца: в шапке меню «Blue Ridge Trading», аккаунты
   **Amazon · A1SYNSELLER…** и **eBay · syn_demo_ebay_us_…** в тени, плитки недели (Decisions, Price would change, Writes held, Without the
   floor) и график «Decisions per day». Кнопки «Switch on live writes» нет — бой включает владелец пространства, а здесь вы менеджер.
3. **«← All workspaces»** → снова три карточки.

Что сказать:

- каждый продавец — своё пространство: его каналы, его цены, его остановки; данные пространств не смешиваются — это граница в базе, а
  не фильтр экрана;
- в каждом пространстве у вас ровно одна роль, её назначает владелец пространства: у одного продавца вы ведёте цены (Manager), у другого
  только смотрите (Viewer) — изменение там откажет и консоль, и база (проверено живым прогоном шага 91);
- карточки списка считаются одним обращением к базе на весь список, а не по пространству: список агентства из 50 продавцов — 2 обращения
  (шаг 45, Р-182).

Честно: сводной панели «все продавцы сразу», партнёрских тарифов и приглашений от лица преп-центра нет — это решения после встречи.

## Если что-то пошло не так

Порядок действий и перезапуск — [docs/demo-preflight.md](demo-preflight.md), раздел «Если завис экран или упал процесс».
