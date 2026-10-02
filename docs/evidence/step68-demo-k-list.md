# Шаг 68: K-список, часть 1 — то, что клиент увидит на демо

Исходный список K1…K11 — [проход консоли шага 64](step64-console-pass.md). В этом шаге сделаны K6, K11, K7, K3, K2, K10. K1, K4, K5,
K8 и K9 — следующим шагом, не тронуты.

## 0. Первое действие: шаги 65–67 в main

Оба прогона шага 67 ([36969654773](https://github.com/mehmetkerim00/repracer/actions/runs/36969654773) и
[36969653513](https://github.com/mehmetkerim00/repracer/actions/runs/36969653513)) зелёные целиком. Фоновое ожидание слияния вывода не
дало и не слило, поэтому `02f064c` отправлен в main вручную в начале шага; ожидание остановлено.

## 1. Что теперь видит клиент из США (демо через консоль, как гость, английский)

Прогон — `apps/console/test/demo-us-live.pg.test.ts`: разворачиваемая консоль (`startConsole`), публичное демо с профилем США
и прожатой неделей (`REPRACER_CONSOLE_DEMO_PRESS_DAYS=7`), гость ходит по HTTP. Ниже — что он видит. Данные синтетические, и экран это
говорит [Р-151].

**Неделя тени США прожата при подъёме.** Восемь виртуальных суток идут поминутно с прошлого момента до настоящего:

| Прогон | amazon.com: снимков → решений | eBay US: пересчётов по расписанию | Длительность |
|---|---|---|---|
| машина разработчика, пять подъёмов | 996 → 997 (503 с изменением цены, 494 без) | 84 → 84 (10 с изменением, 60 без, 14 отклонены Gate) | 25,2–115,8 с |

Длительность зависит от нагрузки машины: подкачка 8,5 из 9,2 ГБ, средняя загрузка 7–9, чужие процессы ([заметка о машине](step67-discovery-and-screens.md)).
Модель детерминирована (семя 68), поэтому числа одинаковы во всех подъёмах. Алертов прожатия 14 (отказы Gate eBay) — они остаются в
памяти процесса, как у Kaufland-демо.

**Экран «Shadow mode», сводка за «Last 7 days»** (строки экрана):

- «Decisions made: 1069; of them the price would have changed 503 times»;
- «The price landed exactly on the floor 131 times — the floor decided it, and without the floor it would have gone lower»;
- «Writes held by the shadow: 513 (prices 513, stock 0)»;
- «Of them about 10 would have used the external edit budget of the channel — approximate: the day boundary of the storefront is not
  confirmed…» (бюджет правок — у eBay, граница суток EBAY_US не подтверждена [Р-188]);
- «Without the floor you would have sold $4,106.25 cheaper in total — counted on the 625 holds where we still keep what the strategy
  wanted» и оговорка «not a forecast of revenue» [Р-173].

**Блок «Weekly email — preview»** (K7): пометка «Demo: synthetic data. This is the email a seller in shadow mode receives every Monday; the
real one covers the previous week, Monday to Sunday (UTC).», тема «repracer: what the engine would have done this week (Demo store
(simulator))» и текст письма — те же строки, собранные ТОЙ ЖЕ функцией, что у доставки (`shadowDigestLetter`), за последние семь суток.

**«Почему эта цена» на amazon.com** (K6, K11) — предложение «Plant pot, green · amazon.com»:

- заголовок «The price $14.00 was approved; write: held by shadow mode (not sent)»;
- Strategy — «Proposed $14.00 (−24.3%): Target $12.49 is below min_price — capped at $14.00.»; стратегия «Beat the lowest: undercut by
  $0.01, against visible offers; outside bounds — use the bound (version 1)»; шаги — «Undercut the lowest price $12.50 by $0.01: $12.49.»
  и «Target $12.49 is below min_price — capped at $14.00.»;
- Input check — «Too few competitor offers: fewer competitor offers than the 3 needed», «Price history available: enough price history to
  check against»; Price Gate — «Price $14.00 approved within $14.00–$50.00», пол $14.00, минимальная маржа 12 %;
- запись — «held by shadow mode (not sent)», причина словами.

**«Почему эта цена» на ebay.com** — «Water bottle, blue · ebay.com»: «Proposed $19.92 (−0.4%): Price for the target margin 30%: $19.92.»,
Gate «approved within $15.12–$50.00». Решение ниже `min_price` — «Rejected: $11.11 is below min_price $12.00 by 7.42%.», «corrected».

**Отказ перевода в бой** (K2; владелец, прогоны `us-shadow-live` и `pilot-us-live`): «Live writes on ebay.com stay closed: the day boundary
of the price history of this storefront is not confirmed yet. Only the channel can confirm it — through its support or its documentation;
the question is open and there is no date for an answer. Nothing is needed from you…». У amazon.com — «It can be confirmed from what the
channel shows while you are in the shadow; our team does that by hand, and there is no date for it yet…» (первая редакция обещала
«we confirm it on our side» и «we follow the question up» — автоматики и процесса за этим нет, ревью, находка 2). Ни `ATVPDKIKX0DER`,
ни `DAY_BOUNDARY`, ни кода вопроса в тексте нет — это утверждается.

**Меню** (K3): у демо вкладка Omnibus есть (Kaufland de — витрина ЕС); у продавца только с ebay.com её нет (`pilot-us-live` утверждает
`euStorefronts: false`), прямой адрес отвечает «The Omnibus rule for discount prices is EU law. None of your connected storefronts is in
the EU…».

## 2. Что сделано по пунктам

**K6 — тень США считает в долларах.** `apps/console/server/demo-us.ts`: предложения аккаунтов США получают себестоимость в USD,
оценку комиссии, `min_price`/`max_price`, минимальную маржу и стратегию одной административной транзакцией владельца демо (второй фактор —
окно массовой правки [Р-135]); ENGINE, аккаунты остаются в тени [Р-169]. amazon.com — «подрезать самого дешёвого на цент», конкуренты —
модель порта Amazon [Р-113] с уведомлениями ANY_OFFER_CHANGED: конкурент сползает ниже пола и возвращается ступенями не круче 20 % [Р-42],
у каждого предложения своя фаза — рынок движется вразброс, а не единым сдвигом [Р-50]. eBay US — целевая маржа 30 %: конкурентов eBay в
бою мы не видим [Р-190], решение приносит пересчёт по расписанию [шаг 47]. Путь решения мира выбирается по каналу аккаунта вызова.
Попутно: консоль давала аккаунту eBay описание Kaufland (мир тенанта, предпросмотр стратегии исполнителя заданий, снятие остановки
стенда) — теперь описание канала берётся одной функцией `descriptorOf`, неизвестный канал — отказ.

**K11 — строка стратегии без заглушки.**

- Пока у решения есть горячее намерение (3 суток [Р-28]), причины стратегии показываются с суммами из него. Цепочка намерения и слепок
  построены одним расчётом.
- У решения старше — свой текст без сумм канала («Undercut the Buy Box price seen at that moment by the strategy step. Competitor prices
  are kept for 3 days, so the amounts are no longer shown.»). Такой текст есть у каждой причины, которая бывает в вечном объяснении:
  стратегия, предупреждения и заметки проверки входов, всего 24 кода на двух языках.
- У остальных причин с параметрами канала (отказы снимка, в объяснение не попадают) — «правило словами», если шаблон всё же упёрся в
  невыданное значение.
- У кодов заметок проверки входов (SMALL_MOVE, NO_FRESH_CROSS_CHANNEL_REFERENCE и другие) появились заголовки.
- Подпись стратегии говорила «undercut not kept (18 months after the strategy version was replaced)» о ДЕЙСТВУЮЩЕЙ версии: справочник
  стратегий консоли не читал таблицу подреза [Р-91]. Теперь читает.
- Правилом [Р-146]: тест перебирает все 41 код с параметрами канала на обоих языках — заглушки нет, у причин вечного объяснения свой
  текст; отрицательный контроль — словарь без этих текстов правило ловит.

**K7 — недельное письмо тени на демо.**

- Неделя США прожимается при подъёме: `REPRACER_DEMO_PRESS_DAYS` у стенда (команда подготовки ставит 7) и
  `REPRACER_CONSOLE_DEMO_PRESS_DAYS` у консоли, 0…7, по умолчанию 0.
- Решения ложатся в прошлые сутки. Их секции создаёт та же функция базы, что планировщик (`maintenance.ensure_partitions` с моментом
  каждых прошлых суток): у свежей базы секций старше вчерашних нет. Горячие намерения старше трёх суток затем удалит удаление по сроку —
  как у настоящего продавца через неделю тени.
- Письмо: текст собирает одна функция `shadowDigestLetter` (console-model) у доставки (`packages/alert-delivery`) и у предпросмотра.
- Предпросмотр — только у демо-тенанта и только за неделю: демо-тенанту письмо не отправляется (0167).

**K3 — Omnibus только при витрине ЕС.** Признак `euStorefronts` считает база в том же обращении, что счётчики списка миров: подключённый
аккаунт с витриной в стране ЕС (`platform.marketplace.country`, состав ЕС — список, а не «цена брутто»: НДС есть и вне ЕС, A-24). Меню
мира без витрин ЕС вкладки не показывает, прямой адрес объясняет почему.

**K2 — отказ перевода в бой словами.**

- База называет первое неизвестное свойство строкой «витрина / СВОЙСТВО (вопрос)» [Р-172]. Консоль переводит её словами:
  - витрина — «amazon.com»;
  - что не подтверждено — «the day boundary of the price history»;
  - кто подтверждает — по способу закрытия свойства из ревизии витрин.
- Строку не той формы текст пересказывает общими словами, а не показывает сырой.
- Таблица «What we still do not know about these storefronts» — витрина и значение словами («net, sales tax added at checkout», «one value
  per SKU for the whole region»), без кода вопроса.
- Правилом: каждое значение `platform.marketplace_readiness()`, кроме часового пояса, имеет слова на обоих языках.

**K10.**

- **Подпись предложения** — название товара или SKU продавца и витрина словами: «Plant pot, green · amazon.com», «Water bottle, black ·
  kaufland.de», а не «Kaufland de · unit 100200». Тот же шаблон — у поиска в базе, и равенство держит тест шага 67.
- **Названия товаров демо** — синтетические и общие.
- **Онбординг:** аккаунт — «Amazon · amazon.com», а не «AMAZON · ATVPDKIKX0DER»; чего не хватает аккаунту без доступа — словами, а не
  `NOTIFICATION_QUEUE, SELLER_AUTHORIZATION`.
- **Пустые «Rejected» и «Compliance»** объясняют, что значит пустота и когда там что-то появится.
- **Роли** уже везде из словаря (`m.values[role]`). Обход всех экранов демо гостем на обоих языках кодов ролей не нашёл.
- **Немецкий словарь вычищен** от «(Р-74)», «(OQ-169)», «(0078)», «(Frage E-21)», «(A-16)» и ссылок на шаги и риски. Гость публичного
  демо открывает консоль по-немецки и видел «(Р-74)» в объяснении первого же решения. Правило шага 64 держало только английский — теперь
  держит оба языка и коды вопросов каналов.

## 3. Что осталось из K-списка

| | Что | Оценка шага 64 |
|---|---|---|
| K1 | Язык консоли — свойство развёртывания, а не тенанта; агентство с тенантами DE и US видит один язык | ~1 день |
| K4 | Все времена в UTC; неделя дайджеста — по UTC, а не по поясу продавца | 1–2 дня |
| K5 | Блоки «What this screen does not have» местами — заметки разработчика | ~0,5 дня |
| K8 | На экране остатков нет поиска и фильтра «с резервациями» | ~0,5 дня |
| K9 | Термины непоследовательны (tenant, storefront, unit, offer, product) | ~1 день |

Шаг 68 их не трогал по заданию. K10 и K9 пересекаются: подписи предложений сделаны, словарь терминов — K9.

Открыто шагом: названия предложений из каналов не читаются — после «Connect» у продавца подписи по SKU (OQ-249). Подтверждение
свойства витрины (граница суток amazon.com и ebay.com) ставит команда платформы руками — процесса и срока нет, и тексты отказа теперь это
говорят (ревью, находка 2).
