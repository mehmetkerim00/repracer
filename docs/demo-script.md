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
  в профиле us немецкого нет; с шага 98 — английский, испанский и французский, с шага 100 — меню языка в шапке («глобус · EN ▾»);
- шаг 87: остатки — склад «Warehouse Newark, DE» (60 штук каждого товара), синхронизация количества amazon.com включена, спрос —
  синтетические заказы amazon.com: первый через 2 минуты после запуска, дальше раз в 10 минут, отгрузка через час;
- шаг 91 (вид преп-центра): рядом с главным демо — два лёгких продавца, **Blue Ridge Trading** (6 предложений на amazon.com и 6 на
  ebay.com) и **Lakeside Home Goods** (по 5): свои пространства с пометкой демо, оба в тени, неделя тени прожата так же. Владелец
  стенда (строка «Owner» на входе) — менеджер у обоих (шаг 98, Р-222: ролей для людей две): у человека в пространстве одна роль [Р-213]
  (`REPRACER_DEMO_SELLERS`, в профиле us по умолчанию включено);
- поднимает интерфейс на `http://127.0.0.1:5173` и ждёт, пока он ответит;
- ждёт первых решений и печатает запрос-доказательство для шага «а».

Замер шага 87 (машина разработчика, профиль us): от запуска до «Демо готово» — **51 с** (база 19 с, стенд 31 с, из них прожатая неделя
США 29,7 с, интерфейс 1 с; у европейского демо шага 80 — 85 с); строка «Демо готово» печатает эти числа сама. Подготовка держит машину бодрствующей до Ctrl+C (`caffeinate`, шаг 80):
сон macOS остановил подготовку шага 79 на 34 минуты — машина спала, а не считала. Шаг 89 добавил прожатую неделю walmart.com (опрос
Buy Box раз в два часа на товар): подготовка дольше примерно на 20 с — замер — в [отчёте шага](evidence/step89-walmart.md). Шаг 91 — с двумя
лёгкими продавцами (неделя тени прожата и у них): **102 с** (база 18 с, стенд 83 с, из них неделя главного демо 54,8 с и продавцы 27,5 с,
интерфейс 1 с) — [отчёт шага](evidence/step91-agency.md). Шаг 96 — **106 с** (база 18 с, стенд 87 с, из них неделя главного демо
57,2 с и продавцы 28,4 с, интерфейс 1 с) — [отчёт шага](evidence/step96-ux.md); шаг 96.1 — **105 с** (база 18 с, стенд 86 с, из них неделя
главного демо 56,7 с и продавцы 27,8 с, интерфейс 1 с).

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
шаг 98 — ровно две роли: **Owner** «everything: prices, stock, people, channel accounts and sending prices to your store; only an owner grants
the owner role», **Manager** «everything the owner does, except granting or removing the owner role») → строка **Owner** (в шапке —
меню языка — глобус и «EN ▾», по нажатию English · Español · Français с галочкой у текущего (шаги 98, 100); немецкого в профиле us нет; шаг 96.1: справа в шапке — кнопка темы: солнце в светлой теме, луна в тёмной; нажатие переключает светлую ↔ тёмную и запоминает выбор в этом браузере, подсказка называет, куда переключит («Switch to dark theme»); пока выбора нет — тема системы; после входа там имя
человека **Alex Porter**, адрес — подсказкой при наведении) → три карточки (шаг 91): **Demo store (simulator)** — «Owner», **Blue Ridge Trading** — «Manager», **Lakeside Home Goods** —
«Manager», у всех пометка **Demo** → нажатие на «Demo store (simulator)» открывает сразу **Shadow mode**. Перезагрузка страницы (F5) — выход: токен
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
Trading** (Offers 12, роль «Manager») и **Lakeside Home Goods** (Offers 10, роль «Manager»), описание «Synthetic American seller on the
channel simulator: offers on amazon.com and ebay.com, in shadow mode.»; их показ — раздел «ж». Пометка «test environment, synthetic data» в шапке — только здесь и на входе: внутри магазина её роль играет
жёлтая полоса.

**Внутри мира — баннер:** «Demo workspace: synthetic data, real path. Every amount is made up.»

Что сказать: это тот же продукт, что у вас будет, — только канал симулирован и цифры выдуманы.

**Меню слева** (шаг 95 [Р-217] — девять пунктов вместо четырнадцати; шаг 96 — Offers в разделе Pricing, остатки — **Inventory**):
Shadow mode; **Pricing** — Price changes, Strategies, Costs & floors, Protections, Offers; Inventory; **Workspace** — Channels, Stop
pricing. У раздела из одного пункта заголовка нет (шаг 96.1): Shadow mode и Inventory стоят своими блоками за тонкой линией. У каждого пункта своя иконка Primer Octicons, смысл читается без подписи (шаг 96: глаз — тень,
история — журнал цен, мишень — стратегии, ценник — себестоимость и пол, щит с галкой — защиты, список — предложения, коробка — остатки,
вилка — каналы, знак «стоп» — остановка). Что сказать: «функции те же — меньше дверей»: журнал цен один (решения — фильтром Kind),
границы и себестоимость — на одном экране, защиты — на одном, путь подключения и аккаунты каналов — на одном, массовые операции —
кнопкой «Bulk operations» на Offers. Прежний адрес остатков `…/stock` ведёт на `…/inventory`.
Над меню — имя магазина и ссылка **«← All workspaces»** (к списку магазинов). У продавца с одним магазином списка нет: вход ведёт сразу
в магазин, и ссылки «All workspaces» нет (шаг 100).

Вкладки **Omnibus** нет: это правило ЕС о прежней цене скидки, а профиль us его не предлагает (шаг 87) — у продавца только с витринами
США её не было и раньше (шаг 68, K3). Если клиент спросит про Европу: она в продукте есть и заморожена — открывается профилем рынка.

## а. Тень: «система физически не может трогать цены» (2,5 мин)

**Экран «Shadow mode».** Ожидаемое:

Шаг 96 [аудит понятности, пункты В21, В22]: на виду — следующий шаг, период, плитки, график и карточки каналов с действием; всё
остальное — свёрнутыми блоками ниже (данные те же, ничего не удалено).

- **Подзаголовок:** «The channel is connected and the engine runs completely — snapshots, checks, strategy, bounds, explanation.» и ссылка
  **«Learn more»** — раскрывает: «Nothing is sent to your store: every change below was held back.»
- **Карточка «Next step»** (шаг 96, В22) — та же логика, что у пути подключения на Channels, один источник: «Next step: Stock
  synchronization enabled (12 of 38)» и кнопка **«Go to inventory»**. У демо путь не пройдётся сам: запись количества eBay и Walmart ждёт
  подтверждения владельца [Р-202] — об этом раздел «г»; с шага 103 открыты и шаги себестоимости, границ и включения — у двух новых
  товаров amazon.com (раздел «г», «Новые товары») себестоимости нет, поэтому пилюли «Waiting for your decision» (путь ждёт только
  владельца) у демо больше нет.
- **Period** (шаг 96, II; шаг 96.1 — один контрол диапазона) — кнопка с датами «Last 7 days · Oct 9 – Oct 16, 2026». Нажатие открывает
  календарь: слева **Last 24 hours / Last 7 days / Last 30 days**, справа два месяца, внизу **Apply / Cancel**. Свой диапазон — двумя
  нажатиями: первое — начало («Now pick the last day — Oct 7, 2026 or later.»), второе — конец; день раньше начала календарь не примет и
  скажет это словами. Дни — в поясе магазина, выбрать можно последние 30 дней (у журнала цен — 90). На телефоне календарь — лист во весь
  экран с одним месяцем. По умолчанию — Last 7 days. Тот же контрол — на Protections и Price changes.
- **Четыре плитки** (шаг 96, А1–А3 — у каждой подпись, что значит число): **Decisions** — «times the engine checked prices»; **Price would
  change** — «times the price would have moved»; **Held back** — «price changes we did NOT send to your store» (плитка считает только цены,
  остатки — в блоке «Good to know»); **Your floor saved you from selling cheaper by** — «$…», подпись «protection, not profit».
  Под ними — карточка с графиком **«Decisions per day»**: зелёные столбики решений тени по суткам в поясе магазина, ось значений слева,
  подписи дней снизу. Последний столбик — сегодняшние сутки, они не кончились: приглушённый тон, подпись **«Today»**, подсказка при
  наведении «partial day» (шаг 96.1). У Last 7 days на графике восемь календарных суток: окно «последние 7 дней» начинается внутри первых
  суток. У своего диапазона в прошлом «Today» нет — последний столбик подписан днём.

  Сразу после подъёма — неделя США: около тысячи решений в числе **Decisions** (замер шага 87 — 1 068), на графике — ровная неделя
  (≈ 156 решений в сутки) и сегодняшний столбик; сегодняшний растёт тем же темпом — тень США живёт настоящим временем.
- **Карточки аккаунтов** (поля «Channel account», «Mode», «Sending prices»): **Amazon · A1SYNDEMOUS…**, **eBay · syn_demo_ebay_us_…** и
  **Walmart · syn-demo-walmart-…** (шаг 89) — «12 offers, 12 of them with the engine on», у каждого «shadow (nothing is sent to your
  store)», «To start sending prices to your store, type the account name exactly: …», поле, кнопка **«Start sending prices»** и рядом
  **«Copy»** (шаг 96, Б13): копирует имя аккаунта, его остаётся вставить в поле — подтверждение и журнал прежние [Р-170].
- **Под карточками:** «Sending prices cannot be switched on yet: we do not know amazon.com · Day boundary of the price history, ebay.com · …,
  walmart.com · …. The shadow keeps working, and you keep seeing what the engine would do.» Что мы не знаем про витрину, держит боевой режим
  закрытым [Р-172] — у всех трёх витрин граница суток не подтверждена каналом. Если владелец всё же нажмёт «Start sending prices» на
  amazon.com, отказ скажет: «Sending prices to amazon.com cannot be switched on: the day boundary of the price history of this storefront is
  not confirmed yet. This is usually settled within a week of shadow mode: after seven days of shadow decisions our team checks your shadow
  data… and then sending prices to your store can be switched on. Nothing is needed from you.» (шаг 69, Р-204). Обещание — ровно это:
  неделя тени, затем проверка командой платформы. Процедура — [runbook-day-boundary.md](runbook-day-boundary.md); подтверждением канала её
  не называть, вопрос каналу остаётся открытым.
- **Свёрнутый блок «Good to know»** (шаг 96, А4): сводка «показатель — значение» (Period; Price landed exactly on the floor — «K times»;
  Price landed exactly on the ceiling — «0 times»; **Updates held back by the shadow** — «X — prices P, stock S»; Would have used the
  external edit budget of the channel — «about N»: бюджет правок есть у eBay, а граница его суток не подтверждена, поэтому «примерно»
  [Р-188]; Without the floor you would have sold cheaper by — «$…»), сноски и раздел **«What we are still checking about your stores»**:
  первой строкой **«Nothing is needed from you.»**, затем по строке на витрину и свойство людскими словами — например «amazon.com — When
  the store’s day starts — it decides which day a price belongs to and when the daily edit limit resets. Not known yet — prices are not sent
  to this store until it is. Our team confirms it from the trial week.»
- **Свёрнутый блок «Weekly email — preview»** (шаг 68, K7): то самое недельное письмо тени, собранное той же функцией, что у доставки, за
  последние семь суток, с пометкой «Demo: synthetic data. This is the email a seller in shadow mode receives every Monday…». Демо-тенанту
  письмо не отправляется (0167) — поэтому оно на экране. Блок есть только у периода 7d: письмо — недельное.
- **Свёрнутый блок «Every held change, one by one (N)»** (шаг 96, Б16; колонки «Offer», «Would have been sent», «Held at»): удержанные
  записи, новые сверху; у каждой строки пилюля **price** или **stock**; у цены — ссылка **«Why this price»**, у остатка («… pieces»)
  ссылки нет.

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

Кнопка «Start sending prices»:

- только владелец;
- второй фактор;
- имя аккаунта нужно ввести в поле (кнопка «Copy» копирует его, вставляет человек).

«Back to shadow» — одно нажатие [Р-170].

## б. «Почему эта цена» (2 мин)

Пункта меню «Why this price» нет (шаг 95): квитанция решения — своя страница, пункт меню над ней — Price changes. Короче всего —
**Price changes** → **Kind: All decisions** → **Outcome: price changed** (шаг 96: у решений есть период и фильтр исхода) → поле **Offer**:
начните набирать «plant pot» — таблица фильтруется по мере ввода (шаг 96, Б11) → нажмите на строку amazon.com: строка кликабельна
целиком (Б17) и ведёт на квитанцию. Второй путь — на экране тени раскрыть «Every held change, one by one» и нажать «Why this price».

Над таблицей Price changes в тени — фраза «Trial week: prices were computed but nothing was sent to your stores.» (шаг 96, А5): нули в
сводке «applied 0 · in progress 0 · …» объясняет она, а не догадка зрителя.

**Выгрузка** (шаг 104, Р-229). В конце ряда фильтров — поле **Export** с кнопками **CSV** и **XLSX** и строкой «Column headers in the file
are always in English.» Нажатие — фоновое задание, под рядом фильтров его ход и «Download the file»: в файле ровно то, что на экране, с теми
же фильтрами и периодом; в XLSX второй лист «About this export» (пространство, экран, период, фильтры, кто и когда, число строк). Та же
кнопка — на Protections, Offers, Inventory, в журнале импортов и в журнале аудита на Stop pricing. Что сказать: заголовки английские при
любом языке — на них держатся формулы и интеграции; больше 50 000 строк — честный отказ «narrow the period», а не обрезанный файл; каждая
выгрузка — в журнале аудита. **В публичном демо** (вход гостем) кнопка видна, но отключена: «Export is not available in the public demo».

**Экран решения amazon.com** (шаг 68, записано прогоном `demo-us-live`): предложение подписано словами — «Plant pot, green · amazon.com».

- **Итог** (шаг 83 — плашка янтарного фона, цена крупно): **$14.00**, под ней «The price $14.00 was approved; sending to your store:
  held by shadow mode (not sent)». У отказа — плашка красного фона, без цены, причина крупно одной фразой. Шаги расчёта — номера в цветных кружках
  (зелёный — пройден, красный — остановлен, серый — не нужен) на тонкой линии.
- **Competitor snapshot:** «Amazon, notification of a competitor price change», время наблюдения.
- **Strategy:** «Proposed $14.00 (−24.3%): Target $12.49 is below your minimum price — capped at $14.00.»; шаги расчёта («Calculation
  step») — «Undercut the lowest price $12.50 by $0.01: $12.49.» и «Target $12.49 is below your minimum price — capped at $14.00.»;
  стратегия — «Beat the lowest: undercut by $0.01, against visible offers; outside bounds — use the bound (version 1)».
- **Price Gate:** «Price $14.00 approved within $14.00–$50.00.», «Floor: $14.00», «Minimum margin: 12%».
- **Input check:** «Snapshot accepted: 9 rules checked»; «Anchor 2: consistency of the snapshot» — «skipped», «fewer competitor offers
  than the 3 needed» — правило и порог, без чисел канала.
- **Sending to your store:** «$14.00: held by shadow mode (not sent)», «Not sent: this channel account is in shadow mode, so nothing is
  sent to your store…».

Что сказать:

- каждое решение объясняет себя само: снимок, проверки, стратегия, границы, итог;
- цену конкурента в вечном объяснении мы **не храним** — это данные канала [Р-85]. Три дня её держит горячая запись решения [Р-28], и
  строка стратегии показывает суммы; у решения старше — правило словами, без сумм канала (шаг 68, K11);
- решение без изменения цены хранит только код причины [Р-74], поэтому для показа берите строку с исходом **Approved**.

**Границы.** Рядом с подписью предложения на экране решения — ссылка **«Bounds and floor»** (шаг 76): разбивка пола до цента (экран
«Bounds and price floor»); на нём кнопка **«Change this floor»** (шаг 96, В20) ведёт в правку границ «Set minimum & maximum price» с этим
предложением уже выбранным. У товара amazon.com она отвечает на вопрос «что помешает продать ниже себестоимости»: «Unit cost: $5.00 (as you
declared it)», «Minimum margin $6.85 — margin at least 12%», «Effective floor $14.00 — from your minimum price», в разбивке пола
«Margin $6.90»; комиссия — «fee schedule: 15% + $0.00 (2026-10) — the floor is computed from this one» (версия тарифа — месяц действия).

**С кем соревноваться** (шаг 101, Р-226, ~30 с). У товара amazon.com «Water bottle, …» (первый товар; название — в карточке стратегии
**Beat the lowest FBA offer** на экране Strategies, «Show offers») лоукостер **Pine & Co** исполняет заказ сам (FBM) и Buy Box не держит,
Buy Box у **Harbor Goods** (FBA) на $0.25 дороже. Стратегия — «только FBA»: в описании одной строкой «…; compete with: FBA only; …».
Квитанция любой его записи (Price changes → поле Offer → название): над таблицей конкурентов «Compete with: FBA only — considered 1 of 2
offers», строка Pine & Co приглушена с пометкой «excluded by your filter», повод — «Triggered by Harbor Goods», шаги расчёта — «Compete
with: FBA only — considered 1 of 2 offers.» и цель от цены Harbor Goods, а не лоукостера. На экране Strategies в черновике «Beat the lowest»
видны поля **Anchor** (Buy Box price / Lowest price / Lower of the two) и **Compete with**; подпись говорит, что у Walmart фильтр
недоступен — Walmart не называет, кто исполняет предложение.

Что сказать: фильтр — до расчёта; неизвестное исполнение не выбрасывается молча, а считается отдельно; если после фильтра никого — цена
стоит («без изменения»), стратегия не переключается на «всех» сама. Пол, потолок и Gate — те же.

**Распродажа ниже безубыточности** (шаг 102, Р-227, ~40 с). Второй товар amazon.com — в Offers с пилюлей **Clearance**. Его страница пола
(«Bounds and floor»): «Effective floor $10.00 — clearance floor: replaces your minimum price $14.00 and the margin floor while clearance is
on», раздел «Clearance floor — allow selling below break-even»: «Clearance is on: $10.00», break-even $12.95, «Loss per piece −$2.95»,
наибольший общий убыток при текущем остатке, «Enabled by …», «Note: “Clearing summer stock”». Квитанция его записи: пилюля Clearance в
заголовке и строка «Clearance mode: floor $10.00 is below break-even $12.95 (−$2.95 per piece). Enabled by …, note: “Clearing summer
stock”.» В Protections — отдельной строкой «The clearance floor held the price N times … — an intentional loss, not counted above».
Чтобы показать включение: у другого товара на странице пола ввести пол — убыток на штуку считается сразу; кнопка «Enable clearance» без
галочки «I understand: every sale below … loses money» и записки недоступна и говорит почему; включение требует второго фактора (гость
демо его не включит — 403). «Turn clearance off» — одно нажатие, подсказка рядом: «The floor returns to $14.00 at once; the price climbs
back to it in about N steps (~X minutes)».

Что сказать: случайный убыток запрещён — без распродажи пол не ниже безубыточности, даже если min price ниже; намеренный — только явным
режимом с запиской и вторым фактором, и всё это в журнале. Потолок, шаг и все проверки работают и в распродаже.

## в. Три стоп-крана (2 мин)

**Экран «Stop pricing».** Первой строкой под подзаголовком (шаг 96, А10): «Pause is safe: current prices stay as they are, and you can
resume anytime with a note.» Ниже — таблица трёх видов остановки:

| Kind | What it holds | Who sets it | How it ends |
|---|---|---|---|
| Stop by a person | All prices | Owner or manager, with a note | Owner or manager, with a note; the whole workspace — with a second factor |
| Storefront halt | Only competitor-derived prices | System: broken input data | Fresh sample where the channel allows it, otherwise a person |
| Channel distrust | All prices and the channel price threshold | System: the channel changes our numbers | Only a person: the owner, second factor, note |

**Живое действие — остановка человеком:**

1. Блок **Storefronts** → карточка **amazon.com** («Running», «All prices of 12 offers stop changing») → кнопка **«Stop»**. Окно
   подтверждения открывается поверх страницы, по центру (страница затемнена): «Stop all price changes: amazon.com?», «All prices of 12
   offers stop changing. The owner or a manager can resume it with a note.» и «Not stopped: Stock synchronization; An update already sent
   to the channel: its outcome is accepted».
2. Поле «Note — why (at least 10 characters)» — заметка **не короче 10 символов** (кнопка «Yes, stop» до этого неактивна), например
   «Demo: checking the stop crane», → **«Yes, stop»**. Ответ: «Stopped. All prices of 12 offers stop changing.»
3. Ниже — «Active stops»: карточка amazon.com с пилюлей «Stopped» и временем, «By: Owner (you)», «Note: “…”»; **«Audit log: stops, roles and channel events»** —
   строка «Pricing stopped» (шаг 98: менеджер в демо приходит менеджером — строки «Role changed» с подготовки больше нет; смена роли
   по-прежнему пишется в этот журнал: кто, чья роль, прежняя → новая, человек назван по имени). Новые решения по витрине — «Pricing stopped by a person».
4. На карточке остановки — **«Resume»** → окно «Resume pricing: amazon.com?» с заметкой → **«Yes, resume»** → «Pricing resumed.»; в
   журнале вторая строка, остановка уходит в «Resumed» со временем остановки и заметкой снятия. Весь шаг в проходе шага 87 — 1,5 с без
   ожиданий.

**Две системные остановки** в демо вручную не вызываются: их ставит система, когда вход испорчен (массовый сдвиг цен конкурентов) или
канал меняет наши числа (цена покупателя отличается от отправленной ровно на ставку налога) [Р-118]. Показать таблицу и сказать: они в
том же списке, снимает их только человек, а недоверие каналу — только владелец со вторым фактором (шаг 89: снова поверить каналу — не
повседневная остановка, менеджеру это право не дано).

Внизу экрана: «Stock synchronization» и «An update already sent to the channel: its outcome is accepted» — чего остановка НЕ касается.

## г. Внешние писатели: «мы не подерёмся с вашим PrepShipHub» (1,5 мин)

**Экран «Channels»** (шаг 95; шаг 96 — В15 и решение по варианту шага 95). У демо путь подключения не пройдётся сам: запись количества
eBay и Walmart ждёт решения владельца [Р-202], об этом и рассказ ниже. Пока путь ждёт только решения владельца, чеклист свёрнут в одну
строку над аккаунтами; с шага 103 у демо открыты и шаги себестоимости, границ и включения (два новых товара amazon.com без себестоимости),
поэтому чеклист «Setup» развёрнут под аккаунтами: «Resume at: Stock synchronization enabled», у шага себестоимости — «36 of 38 offers
have unit costs. Narrowing continues the path with those; the rest stay off until their costs are imported.» Сверху — раздел **«Channel
accounts»**, карточка **eBay · syn_demo_ebay_us_… · ebay.com**:

- «shadow: connected, nothing is sent to your store»;
- «Found 12 offers; the shadow made N decisions in the last 24 hours.» (шаг 68: тень США считает);
- **вопрос:** «Does another tool update stock or prices in this channel?» с пилюлей **«Answer this to finish setup»** (шаг 96) —
  «Not answered yet.»;
- **отправка остатков:** «Stock updates to this channel: off — the owner has to confirm that no other tool manages stock here.» и «Answer
  the question above first.»

**Живое действие:** нажать **«Yes — stock»** у аккаунта eBay (ответ сохраняется сразу, отдельной кнопки нет; пусть это PrepShipHub
клиента). Ожидаемое:

- «Answer saved.» и в строке вопроса — «Your answer: another tool updates stock.»;
- «Another tool updates stock in this channel: if we sent stock too, the two would overwrite each other. Stock updates stay off until that
  tool is switched off and the answer is changed.»;
- кнопки подтверждения отправки остатков нет.

Даже прямой запрос на подтверждение (мимо экрана) база отклоняет: «You told us another tool updates stock in this channel: our stock
updates would overwrite it and it would overwrite ours. Stock updates stay off; switch that tool off and change your answer first.»
(409 `OTHER_TOOL_MANAGES_STOCK`) [Р-202].

Ответ **«Yes — prices»** показывает предупреждение: «Two repricers on one channel are not allowed: each would react to the prices of the
other…».

Ниже — «External edits in the last 24 hours: 0». Если в канале появится цена или остаток, которых мы не отправляли, счётчик это покажет.

Рядом — карточка **Amazon · A1SYNDEMOUS… · amazon.com**: «Your answer: no other tool.» и «Stock updates to this channel: on — confirmed by
the owner.» — так выглядит канал, остатки которого ведёт склад демо.

Что сказать: по умолчанию мы остатки в канал не отправляем вовсе, пока владелец не подтвердил, что другой инструмент их не ведёт.
Подтверждение отзывается тем же экраном («Revoke stock updates») и выключает отправку остатков сразу.

**Новые товары — со стратегией сами** (шаг 103, Р-228). Внизу карточки amazon.com — строка **«Default strategy for new offers: Beat the
lowest by 1 cent · set by …»** и под ней «Assigned to 2 new offers so far»: после прожатой недели у продавца появились два листинга
(«Bamboo cutting board, large», «Pour-over coffee dripper»), обход каталога завёл их — и правило аккаунта назначило им стратегию. У eBay —
«None — assign manually». В выборе стратегии «Win the Buy Box» серая с причиной: на Amazon держатель Buy Box не назван.

Что сказать: умолчание назначает, но не включает — у новых товаров нет себестоимости, и цена не сдвинется, пока вы сами не включите
репрайсинг; каждое такое назначение в журнале с вашим именем как автора правила; смена умолчания трогает только товары, которые придут
потом. Найти новинки — Offers, поиск «Bamboo»: стратегия есть, решений о цене нет.

## д. Продажа: резервация и остатки (2 мин)

**Экран «Inventory»** (шаг 96, В19: пункт и страница остатков — Inventory, прежний адрес `…/stock` перенаправляется). Сводка сверху
(шаг 96, А7 — людскими словами):

> «Products 38: with stock 36; offers in sync 12; updates being sent now 0; our number differs from the store’s 0; open reservations R.»
>
> «Warehouse Newark, DE — File import (internal pool); 36 products with figures»

Заказ amazon.com приходит раз в 10 минут (первый — через 2 минуты после запуска), отгрузка — через час, поэтому R — от одного до шести.
«offers in sync 12» — синхронизацию количества ведёт amazon.com; у ebay.com и walmart.com она выключена (вопрос о других инструментах —
шаг «г», отправка остатков по Р-202 выключена до подтверждения владельца).

Сверху таблицы — товары с остатком по убыванию «Available», при равенстве выше — с резервами (шаг 84.1). Поставьте флажок **«Only products
with reservations»** — список фильтруется сразу, над таблицей «N of 38 products match.» и
кнопка «Show all» (или ищите по названию и SKU: поле «Search by name or SKU» и кнопка «Search», шаг 69, K8) — останутся строки с
заказами. Первая резервация в проходе шага 76 появилась на 5-й минуте после запуска. Ожидаемая строка, например:

| Product | On hand | Reserved | Available | Channels |
|---|---|---|---|---|
| Water bottle, green · SYN-DEMO-US-AMZ-01 | 60 | 1 | 59 | Amazon · amazon.com, пилюля «held by shadow mode», «57 to publish» |

Что значит состояние и на какой момент — одной строкой при сводке, а не в каждой строке (шаг 96.1): «Channel figures as of Oct 16, 2026,
03:30 UTC−4. Held by shadow mode — the number to publish is computed, but nothing is sent to the store, so the channel has not confirmed
it.» Полное прежнее предложение строки — подсказкой при наведении на строку канала.

Что сказать:

- **заказ канала стал резервацией** [Р-25]: на складе 60, одна штука обещана покупателю, доступно 59;
- **в канал идёт общий остаток минус буфер канала** [Р-6]: 59 − 2 = 57;
- **в тени и это количество удержано**, в канал ничего не ушло;
- через час заказ отгружается: резервация закрывается, и на складе остаётся 59 — списание движением базы, а не правкой числа.

Под таблицей — «Before any stock is sent». Там названы ловушки каналов ДО первой отправки [Р-153]:

- у Amazon остаток MFN — одно значение на весь регион аккаунта; для amazon.com это Северная Америка (владелец подтвердил это при
  включении синхронизации галочкой, которая называет само следствие (шаг 96, А8): «I understand: ONE stock number will cover all of
  Amazon North America»);
- у Walmart — одно значение на SKU на складе аккаунта по умолчанию; как оно ложится на несколько складов (ship nodes), Walmart не
  подтвердил (шаг 89, W-04).

## е. Walmart: паритет цен — «мы видим все каналы сразу» (1 мин)

**Экран «Offers»** (меню Pricing → Offers, шаг 96; справа в шапке таблицы — кнопка **«Bulk operations»**: на её странице три ссылки на
массовые правки — «Set minimum & maximum price for many offers», «Assign a strategy to many offers», «Import unit costs» — и история
операций): «Total 36: on 36, …» — предложения трёх витрин одной таблицей. У двух предложений walmart.com в колонке **«Issues from the
channel»** (шаг 96, А6) — красная пилюля **«Unpublished (uncompetitive price)»**, под ней коротко: «Cheaper elsewhere: $19.99. Since Oct
7, 2026, 15:31 UTC−4; PriceTrail does not change the price here.» и раскрывающаяся ссылка **«What to do»**: «Walmart hides this offer
because the same product is cheaper elsewhere ($19.99). To show it again, bring the walmart.com price close to that price — only if your
floor allows. PriceTrail never changes the price for this on its own.» Наведите курсор на ячейку — подсказка с полным объяснением:

> «Walmart took this offer off walmart.com on Oct 7, 2026, 15:31 UTC−4: the same product is cheaper elsewhere ($19.99) — on another channel
> or sold by Walmart itself — and shoppers on walmart.com no longer see it. Bring the walmart.com price close to that price and Walmart
> publishes the offer again; PriceTrail does not change the price for you here.»

Время — момент подготовки демо минус неделя: Walmart снял их в первом же опросе прожатой недели. На телефоне таблица Offers листается
в своей рамке — колонка «Issues from the channel» правее.

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
считает цену как обычно, но в тени в магазин ничего не уходит, поэтому листинг остаётся снятым.

## ж. Для преп-центра: три продавца одним списком (1 мин)

Зачем: на вопрос «как я увижу своих продавцов?» ответ — экран, а не слова. Новых экранов и прав для этого нет: это рабочие пространства и
одна роль на человека в каждом [Р-9, Р-213].

1. **«← All workspaces»** над меню → **«Your workspaces»**: три карточки, у каждой свои показатели и своя роль подписью —
   «Demo store (simulator)» · Owner, «Blue Ridge Trading» · Manager, «Lakeside Home Goods» · Manager (числа — прожатая неделя, порядок
   замера шага 91: Offers 12, Decisions 24h ~80, Interventions 7d ~260 у Blue Ridge; 10, ~65, ~220 у Lakeside).
2. Нажать **Blue Ridge Trading** → сразу **Shadow mode** этого продавца: в шапке меню «Blue Ridge Trading», аккаунты
   **Amazon · A1SYNSELLER…** и **eBay · syn_demo_ebay_us_…** в тени, плитки недели (Decisions, Price would change, Held back, Your floor
   saved you from selling cheaper by) и график «Decisions per day». Здесь вы менеджер — и можете всё, что владелец пространства, кроме
   роли владельца (шаг 98, Р-222), в том числе включить отправку цен; бой база откроет только по готовой витрине [Р-172].
3. **«← All workspaces»** → снова три карточки.

Что сказать:

- каждый продавец — своё пространство: его каналы, его цены, его остановки; данные пространств не смешиваются — это граница в базе, а
  не фильтр экрана;
- в каждом пространстве у вас ровно одна роль, её назначает владелец пространства (или его менеджер): ролей для людей две — Owner и
  Manager, права одинаковые, кроме денег (биллинг — только владелец, шаг 98); роль владельца трогает только владелец — это держит база;
- карточки списка считаются одним обращением к базе на весь список, а не по пространству: список агентства из 50 продавцов — 2 обращения
  (шаг 45, Р-182).

Честно: сводной панели «все продавцы сразу», партнёрских тарифов и приглашений от лица преп-центра нет — это решения после встречи.

## Если что-то пошло не так

Порядок действий и перезапуск — [docs/demo-preflight.md](demo-preflight.md), раздел «Если завис экран или упал процесс».
