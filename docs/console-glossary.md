# Глоссарий консоли

Шаг 69, K9. Одно понятие — одно слово на каждом языке: на экранах консоли и в письмах продавцу.
Все эти тексты живут в словарях `packages/console-model/src/i18n/en.ts` и `de.ts` [Р-72].

Запрещённые синонимы держит правило «шаг 69 (K9)» в `packages/console-model/src/console-model.test.ts`. Оно читает тексты обоих
словарей без комментариев и ключей, включая тексты-функции; запрещённое слово в тексте — красная сборка. В коде, схеме и документации
для разработчиков действуют свои слова: тенант, единица записи, `write_scope`. Глоссарий — только о том, что читает продавец.

## Термины

| Понятие | EN | DE | Запрещено (EN / DE) | Что это |
|---|---|---|---|---|
| Тенант | **workspace** | **Arbeitsbereich** | tenant, seller account, account group / Mandant, Verkäuferkonto, Händlerkonto | Бизнес продавца в repracer: его участники, каналы, каталог, границы. У агентства их несколько, у каждого свои язык и пояс (K1, K4) |
| Канал | **channel** | **Kanal** | marketplace (о канале) / Marktplatz | Amazon, eBay, Kaufland |
| Витрина | **storefront** | **Storefront** | marketplace / Marktplatz | amazon.de, amazon.com, ebay.com, kaufland.de — страна или сайт канала. На экране — словами, не кодом (`ATVPDKIKX0DER`, `EBAY_US`) |
| Аккаунт канала | **channel account** (рядом с названием канала — «Amazon account») | **Kanalkonto** («Amazon-Konto») | seller account, channel connection / Kanalverbindung, Kanal-Konto | Аккаунт продавца в канале, подключённый к workspace. Экран — «Channel accounts» / «Kanalkonten» |
| Кабинет продавца в канале | **channel back office** | **Kanal-Backoffice** | seller account on the marketplace / Kanal-Konto | Seller Central, Seller Hub, Kaufland Seller Portal — где продавец правит предложения руками |
| Товар | **product** | **Produkt** | item, article / Artikel | Вещь продавца с его SKU: себестоимость, общий остаток. У товара может быть несколько предложений |
| Предложение | **offer** | **Angebot** | listing (кроме разговора об eBay), unit, item / Listing, Einheit | Товар на одной витрине одного аккаунта канала: цена, границы, стратегия, запись в канал. Подпись — название товара или SKU и витрина: «Water bottle, black · kaufland.de» |
| Листинг eBay | **eBay listing** | **eBay-Angebot** | — | Слово eBay. Допустимо только в тексте, который говорит об eBay или Trading API (миграция, старые листинги) |
| Количество в штуках | **pieces** | **Stück** | units / Einheiten | «3 pieces reserved», буфер канала — «pieces kept back» |
| Себестоимость | **unit cost** | **Stückkosten** | — | Одна сумма на штуку; «unit cost» — единственное разрешённое «unit» |
| Сервер консоли | **server** | **Server** | stand / Stand | «The server is unavailable». Стенд — испытательный стенд разработчика; на экранах стенда — «test environment» / «Testumgebung» |
| Остановка всего | **stop of the whole workspace** | **Stopp des gesamten Arbeitsbereichs** | tenant stop / Mandantenstopp | Kill switch человеком на весь workspace [Р-69, Р-70] |

Остальные слова экранов остаются, как были, — правило их не трогает:

- «Shadow mode» / «Schattenmodus», «live writes» / «echte Schreibvorgänge» [Р-169];
- «bounds» / «Grenzen», «floor» / «Untergrenze»;
- «strategy» / «Strategie», «Price Gate».

## Язык и время показа (K1, K4)

| Свойство | Где хранится | По умолчанию |
|---|---|---|
| Язык экранов и писем | `tenant_data.tenant.locale` — свойство workspace | Язык развёртывания региона при создании workspace (`REPRACER_OPERATOR_DEFAULT_LOCALE`) |
| Пояс показа времён | `tenant_data.tenant.time_zone` | Пояс первой витрины workspace (`tenant_data.display_time_zone`); у витрин США пояса нет — America/New_York; иначе UTC |

- Внутри системы все времена — UTC. Пояс влияет только на показ: времена подписаны смещением («2026-10-02 09:34:21 UTC+2»).
- Неделя дайджеста тени считается с понедельника по воскресенье в поясе workspace; после смены пояса письмо за ту же неделю второй раз не уходит.
- Итоги и файлы фоновых заданий — языком и в поясе workspace, а не браузера.
- Публичное демо — один workspace на всех гостей: язык у него — гостя (переключатель в шапке), пояс — демо.
- Меняет язык и пояс владелец или администратор на экране «Channel accounts» → «Language and time zone of this workspace». Пояс по
  умолчанию экран называет отдельно и не превращает в заданный, пока его не правили.

## Блоки «Good to know about this screen» (K5)

Блок под экраном — то, что продавцу полезно знать, его словами («Gut zu wissen zu dieser Seite»). Заметки разработчика сюда не
попадают — ни об уровнях опроса, ни о способе подтверждения, ни о симуляторе стенда. Их коды убраны вместе с текстами (шаг 69).
