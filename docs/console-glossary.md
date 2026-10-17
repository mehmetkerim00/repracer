# Глоссарий консоли

Шаг 69, K9. Одно понятие — одно слово на каждом языке: на экранах консоли и в письмах продавцу.
Все эти тексты живут в словарях `packages/console-model/src/i18n/en.ts` и `de.ts` [Р-72].

Запрещённые синонимы держит правило «шаг 69 (K9)» в `packages/console-model/src/console-model.test.ts`. Оно читает тексты обоих
словарей без комментариев и ключей, включая тексты-функции; запрещённое слово в тексте — красная сборка. В коде, схеме и документации
для разработчиков действуют свои слова: тенант, единица записи, `write_scope`. Глоссарий — только о том, что читает продавец.

## Термины

| Понятие | EN | DE | Запрещено (EN / DE) | Что это |
|---|---|---|---|---|
| Продукт | **PriceTrail** | **PriceTrail** | repracer (прежнее имя), Pricetrail, Price Trail / то же | Шаг 92 [Р-216]: в прозе — PriceTrail с заглавными P и T; строчное **pricetrail** — только знак в шапке и на входе. Технические имена (`@repracer/*`, `REPRACER_*`, база) не меняются |
| Тенант | **workspace** | **Arbeitsbereich** | tenant, seller account, account group / Mandant, Verkäuferkonto, Händlerkonto | Бизнес продавца в PriceTrail: его участники, каналы, каталог, границы. У агентства их несколько, у каждого свои язык и пояс (K1, K4) |
| Канал | **channel** | **Kanal** | marketplace (о канале) / Marktplatz | Amazon, eBay, Kaufland |
| Витрина | **storefront** | **Storefront** | marketplace / Marktplatz | amazon.de, amazon.com, ebay.com, kaufland.de — страна или сайт канала. На экране — словами, не кодом (`ATVPDKIKX0DER`, `EBAY_US`) |
| Аккаунт канала | **channel account** (рядом с названием канала — «Amazon account») | **Kanalkonto** («Amazon-Konto») | seller account, channel connection / Kanalverbindung, Kanal-Konto | Аккаунт продавца в канале, подключённый к workspace. Раздел «Channel accounts» / «Kanalkonten» экрана «Channels» / «Kanäle» (шаг 95) |
| Кабинет продавца в канале | **channel back office** | **Kanal-Backoffice** | seller account on the marketplace / Kanal-Konto | Seller Central, Seller Hub, Kaufland Seller Portal — где продавец правит предложения руками |
| Товар | **product** | **Produkt** | item, article / Artikel | Вещь продавца с его SKU: себестоимость, общий остаток. У товара может быть несколько предложений |
| Предложение | **offer** | **Angebot** | listing (кроме разговора об eBay), unit, item / Listing, Einheit | Товар на одной витрине одного аккаунта канала: цена, границы, стратегия, запись в канал. Подпись — название товара или SKU и витрина: «Water bottle, black · kaufland.de» |
| Листинг eBay | **eBay listing** | **eBay-Angebot** | — | Слово eBay. Допустимо только в тексте, который говорит об eBay или Trading API (миграция, старые листинги) |
| Количество в штуках | **pieces** | **Stück** | units / Einheiten | «3 pieces reserved», буфер канала — «pieces kept back» |
| Себестоимость | **unit cost** | **Stückkosten** | cost price, product cost / Selbstkosten, Einstandskosten, Einstandspreis | Одна сумма на штуку; «unit cost» — единственное разрешённое «unit» |
| Данные конкурентов на момент | **snapshot** (competitor snapshot) | **Wettbewerbsdaten** (мн. ч.; момент — «Wettbewerbsdaten vom …») | — / Snapshot, Momentaufnahme | Прочитанные у канала предложения конкурентов и Buy Box на один момент: их проверяют до движка, по ним считает стратегия. Слово «Wettbewerbsdaten» уже было в немецком словаре; английское «Snapshot» в немецких текстах (43 текста) заменено на шаге 86 |
| Сервер консоли | **server** | **Server** | stand / Stand, Standdaten | «The server is unavailable». Стенд — испытательный стенд разработчика; на экранах стенда — «test environment» / «Testumgebung» |
| Остановка всего | **stop of the whole workspace** | **Stopp des gesamten Arbeitsbereichs** | tenant stop / Mandantenstopp | Kill switch человеком на весь workspace [Р-69, Р-70] |

Остальные слова экранов остаются, как были, — правило их не трогает:

- «Shadow mode» / «Schattenmodus» [Р-169];
- «bounds» / «Grenzen», «floor» / «Untergrenze»;
- «strategy» / «Strategie», «Price Gate».

### Отправка в магазин (шаг 96)

Жаргон «write / writes» на экранах не говорится: продавец читает «отправили цену в магазин», а не «запись в канал». Магазин продавца —
**store** / **Shop** (разрешённое слово рядом со «storefront», когда речь о том, что видит покупатель).

| Было | EN | DE |
|---|---|---|
| live writes, Switch on live writes | **Start sending prices**; поле карточки — **Sending prices** | **Senden der Preise einschalten**; **Senden der Preise** |
| nothing is written | **nothing is sent to your store** | **es wird nichts an Ihren Shop gesendet** |
| Writes held | **Held back** — «price changes we did NOT send to your store» | **Zurückgehalten** — «Preisänderungen, die wir NICHT an Ihren Shop gesendet haben» |
| Write to the channel (шаг квитанции) | **Sending to your store** | **Übertragung an Ihren Shop** |
| Stock writes, writes in flight, divergences | **stock updates**, **updates being sent now**, **our number differs from the store’s** | **Bestandsaktualisierungen**, **gerade gesendete Aktualisierungen**, **unsere Zahl weicht vom Shop ab** |
| Price writes (поле Kind) | **Prices sent** | **Gesendete Preise** |

«Write» остаётся только в текстах для оператора платформы (алерты диспетчера) и в коде; в немецком «überschreiben» — обычное слово
«перезаписать», не жаргон.

## Испанский и французский (шаг 98, Р-223)

Испанский — нейтральный латиноамериканский, как у продавцов США (обращение «usted», «costo», а не «coste»); французский — французский
Франции (обращение «vous»). Валюта, числа и даты — американские, как в профиле `us` (решение владельца). Не переводятся: **PriceTrail**,
**Buy Box** (имя собственное, род — «la Buy Box» в обоих языках), **Price Gate**, названия каналов и витрин, коды (SKU, EAN, FBA, FBM, CSV,
XLSX). Одно понятие — одно слово по всему продукту, на экранах и в письмах.

| Понятие | EN | ES | FR |
|---|---|---|---|
| Тенант | workspace | **espacio de trabajo** | **espace de travail** |
| Канал | channel | **canal** | **canal** (мн. ч. canaux) |
| Витрина | storefront | **sitio** («el sitio amazon.com») | **site** (« le site amazon.com ») |
| Аккаунт канала | channel account, Amazon account | **cuenta del canal**, «cuenta de Amazon» | **compte du canal**, « compte Amazon » |
| Кабинет продавца в канале | channel back office | **panel de vendedor del canal** | **espace vendeur du canal** |
| Товар | product | **producto** | **produit** |
| Предложение | offer | **oferta** | **offre** |
| Листинг eBay | eBay listing | **anuncio de eBay** | **annonce eBay** |
| Штуки | pieces | **unidades** | **pièces** |
| Себестоимость | unit cost | **costo unitario** | **coût unitaire** |
| Данные конкурентов на момент | snapshot | **datos de la competencia** | **données de la concurrence** |
| Магазин продавца | store | **tienda** | **boutique** |
| Тень | Shadow mode | **Modo sombra** | **Mode fantôme** |
| Границы | bounds | **límites** | **limites** |
| Пол | floor | **piso** («piso de precio») | **plancher** (« prix plancher ») |
| Минимальная и максимальная цена | minimum / maximum price | **precio mínimo / precio máximo** | **prix minimum / prix maximum** |
| Пол маржи | margin floor | **piso de margen** | **plancher de marge** |
| Стратегия | strategy | **estrategia** | **stratégie** |
| Удержано тенью | Held back | **Retenido** | **Retenu** |
| Включить отправку | Start sending prices | **Empezar a enviar precios** | **Commencer à envoyer les prix** |
| Квитанция решения | Why this price | **Por qué este precio** | **Pourquoi ce prix** |
| Остановка всего | stop of the whole workspace | **detención de todo el espacio de trabajo** | **arrêt de tout l’espace de travail** |
| Страница конкурентов | Competition | **Competencia** | **Concurrence** |
| Стратегии по типу | Fixed price · Target margin · Match the Buy Box · Beat the lowest · Win the Buy Box | Precio fijo · Margen objetivo · Igualar la Buy Box · Superar el precio más bajo · Ganar la Buy Box | Prix fixe · Marge cible · S’aligner sur la Buy Box · Battre le prix le plus bas · Remporter la Buy Box |
| Роли | Owner · Manager | **Propietario** · **Gerente** | **Propriétaire** · **Gestionnaire** |
| Сервер | server | **servidor** | **serveur** |

Меню (пункт = заголовок его страницы, правило браузерного смоука на EN, ES и FR):

| EN | ES | FR |
|---|---|---|
| Overview · Pricing · Inventory · Workspace (разделы) | Resumen · Precios · Inventario · Espacio de trabajo | Aperçu · Prix · Stocks · Espace de travail |
| Shadow mode | Modo sombra | Mode fantôme |
| Price changes | Cambios de precio | Changements de prix |
| Strategies | Estrategias | Stratégies |
| Costs & floors | Costos y pisos | Coûts et planchers |
| Protections | Protecciones | Protections |
| Offers | Ofertas | Offres |
| Inventory | Inventario | Stocks |
| Channels | Canales | Canaux |
| Stop pricing | Detener precios | Arrêter les prix |

Период: Period · Last 24 hours · Last 7 days · Last 30 days · Custom · Apply · Cancel — **Período · Últimas 24 horas · Últimos 7 días ·
Últimos 30 días · Personalizado · Aplicar · Cancelar** / **Période · Dernières 24 heures · 7 derniers jours · 30 derniers jours ·
Personnalisé · Appliquer · Annuler**.

Термины, выбранные при переводе (шаг 98; спорные — в отчёте шага, меняются здесь и в словаре вместе):

| Понятие | EN | ES | FR |
|---|---|---|---|
| Автоматическое ценообразование | repricing | **precios automáticos** | **tarification automatique** |
| Бой (отправка в магазин) | live | **en vivo** | **mode réel** |
| Остановка человеком · системная · недоверие каналу | stop · halt · distrust | **detención** · **suspensión** · **desconfianza** (снять — «levantar») | **arrêt** · **suspension** · **défiance envers le canal** |
| Удержание полом (Protections) | floor holds | **el piso contuvo el precio** | **le plancher a retenu le prix** |
| Подрез | undercut | **quedar por debajo** (параметр — «Rebaja») | **écart à la baisse** |
| Ступень лестницы, шаг подъёма | step | **paso** | **palier** |
| Буфер канала | buffer | **colchón por canal** («reserva» — резервации) | **réserve par canal** |
| Путь подключения | Setup | **Configuración inicial** | **Configuration** |
| Аккаунты каналов (экран) | Channel accounts | **Cuentas de canal** | **Comptes des canaux** |
| Массовые операции | Bulk operations | **Operaciones masivas** | **Opérations groupées** |
| Брутто · нетто | gross · net | **bruto (IVA incluido) · neto** | **TTC · HT** |
| Курс ЕЦБ | ECB rate | **tipo de cambio del BCE** | **taux de change de la BCE** |

Даты — американского порядка, месяцы — на языке экрана («oct 17, 2026», «oct. 17, 2026»); поэтому перед датой переводы ставят двоеточие
или скобки, а не предлог. Имена поясов — на языке экрана («Hora oriental (UTC−4)», «Heure de l’Est nord-américain (UTC−4)»).

## Меню рабочего пространства (шаг 95, Р-217; шаг 96)

Девять пунктов в четырёх разделах (у раздела из одного пункта заголовок не показывается — шаг 96.1): **Overview** / **Überblick** — Shadow mode; **Pricing** / **Preise** — Price changes, Strategies, Costs &
floors, Protections, Offers; **Inventory** / **Lagerbestand** — Inventory; **Workspace** / **Arbeitsbereich** — Channels, Stop pricing.
Пункт меню и заголовок его страницы — одни и те же слова (правило браузерного смоука «step 86» на обоих языках). У каждого пункта своя
иконка из Primer Octicons, все разные (правило «step 96» в токен-тесте и браузерном смоуке).

| Пункт | EN | DE | Что внутри |
|---|---|---|---|
| Тень | **Shadow mode** | **Schattenmodus** | Что движок сделал бы, пока в магазин ничего не уходит [Р-169]; сверху — карточка **Next step** / **Nächster Schritt** (шаг 96) |
| Журнал цен | **Price changes** | **Preisänderungen** | Единственный журнал цен. «Kind» / «Art»: **Prices sent** / **Gesendete Preise** — цены, отправленные в магазин или удержанные; **All decisions** / **Alle Entscheidungen** — все решения, с отправкой и без (шаг 96 — с фильтром **Outcome** / **Ergebnis**). Период — **Period** / **Zeitraum**: кнопка с датами и календарь (шаг 96.1), пресеты **Last 24 hours / Last 7 days / Last 30 days** (**Letzte 24 Stunden / Letzte 7 Tage / Letzte 30 Tage**), внизу **Apply / Cancel** (**Übernehmen / Abbrechen**). Строка целиком ведёт на квитанцию **Why this price** / **Warum dieser Preis** — своей страницей |
| Стратегии | **Strategies** | **Strategien** | Стратегии, назначение, предпросмотр |
| Себестоимость и пол | **Costs & floors** | **Kosten & Untergrenzen** | Границы всех предложений и массовая правка (**Set minimum & maximum price** / **Mindest- und Höchstpreis festlegen**, кнопка **Preview changes** / **Änderungen ansehen**), ниже — импорт себестоимости («Import unit costs» / «Stückkosten importieren»). Страница предложения — **Bounds and price floor** / **Grenzen und Preisuntergrenze**, кнопка **Change this floor** / **Diese Untergrenze ändern** |
| Защита | **Protections** | **Schutz** | **Stopped by people** / **Von Menschen gestoppt** и **Prevented by rules** / **Durch Regeln verhindert** (сверху — «пол удержал цену N раз»). Шаг 96.2: состояние строки — пилюля **corrected / dangerous / stopped** (**korrigiert / gefährlich / gestoppt**), история цены — **was → wanted → set** (**vorher → gewollt → gesetzt**), повторы — чипом «×N · 7d» |
| Предложения | **Offers** | **Angebote** | Раздел Pricing (шаг 96). Колонка **Issues from the channel** / **Probleme vom Kanal**. Кнопка **Bulk operations** / **Massenvorgänge** ведёт на страницу массовых операций: три ссылки на правки и история |
| Остатки | **Inventory** | **Lagerbestand** | Шаг 96: пункт, страница и раздел меню (прежние **Stock** / **Bestand**, адрес `stock` перенаправляется). Источники, синхронизация, расхождения, возвраты |
| Каналы | **Channels** | **Kanäle** | Путь подключения (**Setup** / **Einrichtung**) — сверху, пока не пройден; когда он ждёт только решения владельца — одной строкой над аккаунтами (шаг 96); **Channel accounts** / **Kanalkonten**, разрешения отправки остатков, язык и пояс |
| Остановка | **Stop pricing** | **Preise stoppen** | Первой строкой — «Pause is safe…» / «Pausieren ist sicher…» (шаг 96); три вида остановки и журнал |

Omnibus — десятым пунктом только у пространства с витриной ЕС в профиле `eu` или `global` [Р-214]. Прежние имена экранов (Setup,
Channel accounts, Why this price, Stopped changes, Dangerous changes, Bounds, Unit cost import, Bulk operations, Stock) живут заголовками
разделов и страниц внутри новых пунктов; их адреса перенаправляются.

## Роли (шаг 88, Р-213; шаг 98, Р-222)

У человека в рабочем пространстве ровно одна роль; в разных пространствах — разные (агентство). Ролей для людей две — **владелец** и
**менеджер**, права у них одинаковые во всём, кроме денег: биллинг — только владелец (его в продукте ещё нет, ADR-0057), и роль и вход
владельца трогает только владелец. Наблюдателя (Viewer) нет. Администратор и оператор — только с флагом развёртывания «расширенные роли»
(`REPRACER_EXTENDED_ROLES=on`), менеджер цен и менеджер остатков — роли прежних назначений, новым людям не предлагаются. Права — матрица
`packages/pricing-model/src/policy.ts`, в базе — `security.pricing_permission`.

| Роль | EN | DE | ES | FR | Что может |
|---|---|---|---|---|---|
| Владелец | **Owner** | **Inhaber** | **Propietario** | **Propriétaire** | Всё; роль владельца выдаёт и снимает, вход владельца перепривязывает только он; биллинг (когда появится) |
| Менеджер | **Manager** | **Manager** | **Gerente** | **Gestionnaire** | Всё, что владелец, кроме роли владельца и биллинга: цены, остатки, стоп-кран, люди и роли, аккаунты каналов, перевод в бой [Р-170], подтверждение и отзыв записи количества [Р-202], снятие недоверия каналу, согласие на миграцию eBay [Р-101], язык и пояс пространства |
| За флагом | Admin, Operator | Administrator, Operator | Administrador, Operador | Administrateur, Opérateur | Прежние роли: администратор — как владелец, кроме согласия на миграцию eBay, перевода в бой и записи количества; оператор — стоп-кран и включение репрайсинга |
| Прежние назначения | Pricing manager, Inventory manager | Preismanager, Bestandsmanager | Gerente de precios, Gerente de inventario | Gestionnaire des prix, Gestionnaire des stocks | Не предлагаются; работают, пока назначены |

Гость публичного демо [Р-160] — не роль продукта: у него внутренняя техническая роль «только чтение» (`GUEST`), людям она не назначается
и не показывается (в списке пространств у гостя подписи роли нет). В словарях она есть только потому, что словарь называет каждое значение
перечисления: **Demo guest** / **Demo-Gast** / **Invitado de la demo** / **Invité de la démo**.

«Operator» — роль участника пространства; это не оператор платформы (панель оператора, Р-165): у оператора платформы ролей в пространстве нет.

## Язык и время показа (K1, K4)

| Свойство | Где хранится | По умолчанию |
|---|---|---|
| Язык экранов и писем | `tenant_data.tenant.locale` — свойство workspace | Язык развёртывания региона при создании workspace (`REPRACER_OPERATOR_DEFAULT_LOCALE`) |
| Пояс показа времён | `tenant_data.tenant.time_zone` | Пояс первой витрины workspace (`tenant_data.display_time_zone`); у витрин США пояса нет — America/New_York; иначе UTC |

- Внутри системы все времена — UTC. Пояс влияет только на показ: времена подписаны смещением («2026-10-02 09:34:21 UTC+2»).
- Неделя дайджеста тени считается с понедельника по воскресенье в поясе workspace; после смены пояса письмо за ту же неделю второй раз не уходит.
- Итоги и файлы фоновых заданий — языком и в поясе workspace, а не браузера.
- Публичное демо — один workspace на всех гостей: язык у него — гостя (переключатель в шапке), пояс — демо.
- Меняет язык и пояс владелец или менеджер (и прежний администратор) на экране «Channels» → «Language and time zone of this workspace». Пояс по
  умолчанию экран называет отдельно и не превращает в заданный, пока его не правили.

## Блоки «Good to know about this screen» (K5)

Блок под экраном — то, что продавцу полезно знать, его словами («Gut zu wissen zu dieser Seite»). Заметки разработчика сюда не
попадают — ни об уровнях опроса, ни о способе подтверждения, ни о симуляторе стенда. Их коды убраны вместе с текстами (шаг 69).

## Тема (шаг 96.1)

Кнопка темы в шапке — солнце (светлая) или луна (тёмная): та тема, которую человек видит сейчас. Подсказка и имя для экранного диктора
называют, куда она переключит: **Switch to dark theme** / **Zur dunklen Darstellung wechseln**, **Switch to light theme** /
**Zur hellen Darstellung wechseln**. Пока человек не выбрал, действует тема системы; выбора «System» на кнопке больше нет.

