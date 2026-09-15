# Доменная модель

Статус: **v0.15** · 2026-09-15 · шаг 16. Поля и ограничения окончательно определены DDL в [migrations/](../migrations/); при расхождении с текстом источник истины — миграции.

Документ фиксирует сущности, поля, связи и инварианты. Поля описаны по смыслу, а не как схема БД:
схема — шаг 3. Принятые решения — [decisions.md](decisions.md) (`[Р-n]`).

---

## 0. Соглашения

| Тема | Правило |
|---|---|
| Идентификаторы | Непрозрачные глобально уникальные ID, не переиспользуются. |
| Тенант | Каждая сущность, кроме **глобальных** (`User`, `ChannelCapability`), содержит `tenant_id`. Ссылка между сущностями допустима только при равенстве `tenant_id`. |
| Деньги | `Money { amount_minor: int64, currency: ISO-4217 }` + `price_basis: GROSS \| NET`. Float запрещён. Неявная конвертация валют и баз запрещена. Валюта и база — атрибуты единицы записи; для Германии EUR, GROSS (витрины Kaufland — OQ-57). |
| Время | UTC. `observed_at` / `occurred_at` — время в источнике; `recorded_at` — время записи у нас. |
| Append-only | Не изменяется и не удаляется кодом приложения; исправление — новая запись со ссылкой. Удаление по сроку хранения — только процедурой хранения. |
| Versioned | Меняется созданием новой версии; ссылки указывают на версию. |
| Класс данных | `PII` (не храним, [Р-4]), `AMAZON_INFO` (прочитано из SP-API, ≤ 18 мес), `CHANNEL_INFO` (прочитано из других каналов), `TENANT_OWNED` (введено продавцом или порождено нашими действиями от его имени), `SYSTEM`. |
| Статус значения | Значения в `ChannelCapability`: `DECIDED` (решение), `FROM_REQUIREMENTS` (ТЗ), `TO_VERIFY` (проверить), `UNKNOWN`. |

---

## 0.1 Изменения v0.1 → v0.2

| Что было | Что сломалось | Что стало | Решение |
|---|---|---|---|
| `OfferMapping` — единица версии, дедупликации, схлопывания и истории | Остаток Amazon EU один на SKU для всех маркетплейсов: 5 офферов конкурировали бы за одно значение с независимыми версиями | `WriteScope` на поле; ключи выводятся из `ChannelCapability` | Р-1 |
| `OfferSyncState(offer, field)` | То же | `WriteScopeSyncState(write_scope)` | Р-1 |
| Ключ eBay «item ID + variation SKU или inventory SKU + offer ID» | Выбран Inventory API; не каждый листинг доступен для записи; бюджет правок на листинг | Идентичность Inventory API + статус миграции + `EditBudget` | Р-2 |
| Предположение «любой найденный оффер можно писать» | eBay: только после необратимой миграции с согласием | `OfferMapping.status = MIGRATION_REQUIRED \| INELIGIBLE`; `ListingMigrationCheck`, `MigrationConsent` | Р-2 |
| Единая `PriceHistory` с `EXTERNAL_CHANGE` и `CHANNEL_CONFIRMED` | Прочитанное из SP-API нельзя хранить бессрочно | `PriceHistory` — только наши цены; наблюдения — `ChannelObservation` | Р-3 |
| INV-09 «если PII нужны — хранилище с TTL 30 дней» | PII не запрашиваем | PII нигде не хранится; вычищение на входе | Р-4 |
| `GuardRail.min_price` nullable; floor мог состоять только из `min_margin` | Абсолютный min обязателен | `min_price` обязателен для включения репрайсинга | Р-5 |
| `StockPool` с `on_hand`, списываемым при `CONSUMED`; пулы `CHANNEL_MANAGED` | Мы не владелец остатка | `StockPool` — зеркало внешнего источника | Р-6 |
| `StockAllocation` на оффер, режимы `SHARED`/`DEDICATED` | Общий пул + буфер на канал; остаток Amazon не на оффер | Буфер на `ChannelAccount` с переопределением на `WriteScope(QUANTITY)` | Р-1, Р-6 |
| `Reservation`: `ACTIVE → CONSUMED` | Мы не списываем остаток | `ACTIVE → RELEASED_BY_SOURCE \| CANCELLED \| EXPIRED` | Р-6 |
| `User` 1:1 `Tenant` | Пользователь в нескольких тенантах | `User` глобален + `Membership` | Р-9 |
| «Не-правиловые стратегии — через ADR» | На данных SP-API — никогда | INV-08 усилен | Р-10 |
| Нет расхождения «отправили» / «видим» | Нужна реакция на внешние изменения | `ObservedChannelState`, `ChannelObservation`, `DivergencePolicy`, `DivergenceCase` | — |
| Ключ упорядочивания `(tenant, account, offer)` в ADR-0001 | См. первую строку | `(tenant, write_scope)` | ADR-0002 |

## 0.2 Изменения v0.2 → v0.3 (шаг 3, Р-11…Р-19)

| Что было | Что стало | Решение | Где в схеме |
|---|---|---|---|
| Цель — урезанный первый выпуск | Release 1.0; критерии готовности канала | Р-11 | channel-capabilities §6 |
| `pricing_enabled` на единице | `write_scope.pricing_mode ∈ {OFF, ENGINE, KAUFLAND_SMART_PRICING}`; поле записи `CHANNEL_MIN_PRICE` только в режиме Smart Pricing; intent/decision/PRICE — только в `ENGINE` | Р-12 | 0005, 0008, 0009 |
| Источник конкурентов Kaufland неизвестен | `KAUFLAND_COMPETITORS_COMPARER` | Р-13 | 0009 |
| Ключ Kaufland (проверить) | аккаунт + витрина + unit; витрин несколько | Р-14 | 0003 (CHECK шаблона) |
| `StockPool` — только зеркало | `stock_source.mode`: `INTERNAL_POOL` (журнал `stock_movement`, резервация `CONSUMED`) и `INBOUND_API` (`RELEASED_BY_SOURCE`); `ERP_MIRROR` запрещён в Release 1.0 | Р-15 | 0007, 0009 |
| Изоляция — открытый вопрос | Общая схема + RLS + `tenant_id` везде; глобальные строки у платформенного тенанта; `User` глобален через него | Р-16 | ADR-0003 |
| `ChannelWrite` с ответом канала | `channel_write` — значение, версия, статус, время; ответы — `channel_write_response` (18 мес) | Р-17 | 0008, 0009 |
| `min_price` в `GuardRail` | Отдельная таблица `min_price` (PRODUCT, WRITE_SCOPE); `guardrail` — маржа, потолок, шаг, частота | Р-18 | 0006 |
| Учёт попыток eBay (проверить) | Все попытки на листинг; счётчик растёт до отправки, лимит — CHECK | Р-19 | 0008 |
| Аудит каждого решения и записи | Аудит — люди, конфигурация, безопасность; решения и записи — сами себе журнал | — | 0011 |
| Intent/decision — класс по источнику | Целиком данные каналов (18 мес); бессрочно — `price_history` с полом на момент отправки | Р-3, Р-17 | 0008, 0009 |
| `OfferSyncState`/`WriteScopeSyncState` меняет приложение | Ведётся только триггерами `channel_write` | — | 0005, 0008 |
| Согласие eBay с полем отзыва | `migration_consent` + `migration_consent_item` + `migration_consent_revocation` (все append-only) | Р-2 | 0010 |

## 0.3 Изменения v0.3 → v0.4 (шаг 4, Р-20…Р-26)

| Сущность | Было | Стало | Слой | Решение |
|---|---|---|---|---|
| `ChannelObservation` | Таблица PostgreSQL, 18 мес | ClickHouse; в PostgreSQL — проекции `observed_channel_state` и `observed_price_daily` (60 дней) | CH | Р-20, Р-22 |
| `CompetitorSnapshot` | Таблица PostgreSQL | ClickHouse; в PostgreSQL — `competitor_state` (последнее состояние, вход стратегии) | CH | Р-20, Р-22 |
| `ChannelWrite` | Бессрочно в PostgreSQL | Незавершённые — PostgreSQL; завершённые — транзит `channel_write_history` → ClickHouse (18 мес) и архив (вечно) | PG → CH, архив | Р-20, Р-17 |
| Ответы канала на запись | `channel_write_response` в PostgreSQL | ClickHouse; для опроса статуса — `write_submission` до завершения записи | CH | Р-20 |
| `FeeActual` | PostgreSQL | ClickHouse | CH | Р-20 |
| `PriceIntent`, `PriceDecision` | PostgreSQL, 18 мес | PostgreSQL 3 дня (дневные партиции) → ClickHouse | PG → CH | Р-20 |
| `PriceHistory` | Бессрочно | Сырьё 90 дней → архив; **новая сущность `PriceDaily`** — суточная свёртка, вечно, доказательство Omnibus | PG, архив | Р-21 |
| `Reservation` | `CREATED`… по Р-15 | `CREATED → CONFIRMED_BY_SOURCE → CONSUMED \| RELEASED`, TTL 24 ч, алерт через outbox | PG | Р-25 |
| `MigrationConsent` | Удалялось при закрытии тенанта | Копия в `legal.migration_consent_record` на 3 года, без email и имени | PG (`legal`) | Р-26 |
| **Новое:** `OutboxEvent` | — | События из PostgreSQL в брокер; `scope_seq` — порядок коммитов внутри единицы записи | PG | Р-24 |
| **Новое:** `PartitionExport`, `TenantPurgeStatus` | — | Подтверждение экспорта перед удалением партиции; закрытие тенанта по слоям | PG | Р-20 |
| Валюта | Любая ISO 4217 | Схема мультивалютная, CHECK «только EUR» | PG | Р-26 |

## 0.4 Изменения v0.4 → v0.5 (шаг 6, Р-27…Р-41)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `WriteScope` Kaufland · QUANTITY | аккаунт + витрина + unit | **аккаунт + `id_offer`**, общий для `de` и `at`; PRICE — по-прежнему витрина + unit | Р-35, Р-37 | 0027 |
| `PriceIntent` | Один класс, 3 дня → ClickHouse 18 мес | `intent_class`: `CHANGED`, `REJECTED_BY_GATE`, `NO_OP`; ядро первых двух — `price_intent_core`, вечно (архив); `NO_OP` — 7 дней, затем почасовой агрегат | Р-27, Р-38 | 0024, CH 030 |
| `PriceDecision` | 3 дня в PostgreSQL | 30 дней | Р-28 | 0024 |
| `PriceDaily` | Строится в течение дня | Строится по закрытому дню и неизменяема; исправления — `PriceDailyCorrection`, итог — представление | Р-29 | 0025 |
| `Reservation` | TTL для открытых | Подтверждённая старше 14 дней — алерт, не освобождение | Р-30 | 0026 |
| `CompetitorSnapshot` | Kaufland — `competitors-comparer` | Kaufland — `buy_box_changed` + `GET /buybox`, сверка — отчёт; у снимка полнота `TOP_N(n) \| CHEAPEST_ONLY \| FULL` | Р-36, Р-39 | 0027, CH 030, ADR-0007 |
| `PricingStrategy` | Доступна при наличии источника конкурентов | Объявляет требуемую полноту; недоступна, если канал её не даёт | Р-39 | ADR-0007 (реализация позже) |
| Вебхук | — | Один адрес на аккаунт с ротируемым токеном; подпись проверяется всегда | Р-40 | `KauflandAdapter.handleInbound` |
| `CHANNEL_MIN_PRICE` | Только режим Smart Pricing | Не пишется ни у кого до ответа поддержки | Р-41 | Адаптер отклоняет |

## 0.5 Изменения v0.5 → v0.6 (шаг 7, Р-42…Р-48)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| **Новое:** `MaxPrice` | Потолок — необязательное поле `GuardRail` | Абсолютный потолок на уровнях товара и единицы записи, обязателен для ENGINE вместе с `MinPrice`; действующий — минимум активных уровней | Р-43, Р-18 | 0030 |
| `GuardRail` | Маржа, потолок, шаг, частота | Маржа, шаг, частота; потолок запрещён | Р-43 | 0030 |
| `PriceDecision` | Пол обязателен, потолок необязателен; округление до границы допускалось | Обе границы и их источники обязательны; `rejection_reason`; выход за границу — `REJECTED`, не округление; невычислимая граница — `BOUND_UNRESOLVABLE` с пустыми границами | Р-44 | 0030 |
| **Новое:** `RejectedCompetitorSnapshot` | — | Снимок, отклонённый проверкой входов: причина, класс тревоги, значения; 45 дней | Р-42 | 0030 |
| **Новое:** `PricingHalt` | — | Остановка цен витрины аккаунта: блокирует одобрение и запись цены; снимает только человек | Р-42 | 0030 |
| **Новое:** `CompetitorPriceDaily`, `CompetitorMove` | — | История принятых цен конкурентов за 45 дней и окно движений за 2 дня — контекст проверки входов в PostgreSQL | Р-42, Р-22 | 0030 |
| `CompetitorSnapshot` → стратегия | Любой полученный снимок | Только принятый проверкой входов (`AcceptedSnapshot`) | Р-42 | `input-sanity` |

---

## 0.6 Изменения v0.6 → v0.7 (шаг 8, Р-49…Р-55)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| Проверка входов | Главный ориентир — наша цена | Основные якоря: себестоимость, согласованность снимка, тот же EAN на другом канале тенанта, история единицы; наша цена — только предупреждение; без основных якорей снимок не используется | Р-49 | `input-sanity` `r49.1` |
| `CompetitorState` | — | + `gtin` — для якоря «тот же EAN на другом канале» | Р-49 | 0032 |
| `CompetitorMove` | Движение цены товара | + `sellerRef`; различитель ошибки разбора и рынка — разброс коэффициента сдвига | Р-50 | 0032 |
| `PricingHalt` | Блокирует все цены витрины; снимает только человек | Блокирует только цены из данных конкурентов; окно проверки и автоматический выход по свежей выборке; ручное снятие с заметкой, без ограничения попыток | Р-51, Р-52 | 0032 |
| **Новое:** `PricingHaltReview` | — | Журнал проверок и снятий: `AUTO_SAMPLE` / `MANUAL_RELEASE`, итог, размер выборки, число провалов; снятие без записи журнала невозможно | Р-52 | 0032 |
| `PriceIntent`, `PriceDecision` | — | + `competitor_derived` (из `rule_code`) — к кому применяется остановка | Р-51 | 0032 |
| **Новое:** `ProductVatRate`, `VatRateDefault` | Ставка НДС неизвестна (OQ-16) | Ставка объявляется на товаре; по умолчанию DE 19 %, AT 20 %; «неизвестна» не бывает | Р-53 | 0032 |
| Фиксация решения | Intent, решение и запись — отдельные операции хранилища | Одна транзакция с закреплённой версией границ; смена версии — откат и пересчёт; решение хранит границы всегда | Р-54 | `pricing-store-pg` |
| `DivergenceCase` | Снимок, где наше предложение далеко от нашей цены, отклонялся | Правка цены в кабинете канала — кейс `EXTERNAL_CHANGE`, снимок принимается; устаревший снимок — отказ с предупреждением | Р-55 | путь решения |

## 0.7 Изменения v0.7 → v0.8 (шаг 9, Р-56…Р-59)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| **Новое:** `Marketplace` (справочник платформы) | Витрина — код в `channel_account.marketplaces`; страна НДС выводилась из кода | Канал, код, страна, валюта, база цены, налоговый режим; единица записи и связка оффера сверяются с ним | Р-56, Р-57 | 0034 |
| Деньги | CHECK «только EUR» в 7 таблицах | EUR и USD наравне; конвертации нет: себестоимость и границы — в валюте единицы записи | Р-57 | 0034 |
| `WriteScope` | Валюта EUR, база брутто | + `tax_regime`: `VAT_INCLUDED` ⇔ брутто, `SALES_TAX_EXCLUDED` ⇔ нетто | Р-58 | 0034 |
| Маржа и пол маржи | Цена всегда брутто с НДС; без ставки — ошибка | `TaxTreatment`: НДС внутри цены или налог вне цены; ставка НДС на товаре — только в странах НДС | Р-58 | `pricing-model` |
| `CompetitorState` | Без валюты; подсказка канала терялась | + `currency`, `price_basis`, `suggested_price_minor` — пересчёт по проекции видит тот же снимок | OQ-94 | 0034 |
| **Новое:** `CompetitorMoveLatest` | Последнее движение товара вычислялось по журналу при каждой оценке | Проекция последнего движения товара витрины, обновляется в транзакции снимка | OQ-93 | 0034 |
| `PriceDecision` | Код причины, границы и список проваленных проверок | + `reason_params`, `checks`; отказ без параметров причины отклоняет БД | OQ-98 | 0034 |
| Путь решения | 10–12 транзакций на оценку | Чтение контекста — один запрос; снимок, intent, решение и запись — одна транзакция; итог отправки — третья | Р-59 | `pricing-store-pg` |

## 0.8 Изменения v0.8 → v0.9 (шаг 10, Р-60…Р-64)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `ChannelWrite` | Вставшая за записью в полёте запись не отправлялась никем; вытеснение без причины | Причина завершения, ссылка на вытеснившую запись, последняя ошибка, срок попытки; завершение без отправки — только с причиной | Р-64 | 0036 |
| **Новое:** диспетчер записей | — | Отправляет ждущую запись единицы по событию `scope.write.v1` или обходу; повтор временной ошибки, сверка неизвестного итога обратным чтением | Р-64 | `write-dispatcher` |
| **Новое:** `FxRate` (справочник платформы) | — | Дневной курс ЕЦБ, неизменяем; «на момент решения» — загружен до решения | Р-61 | 0037 |
| `CostProfile` | Себестоимость в другой валюте единице не подходила | Хранится в валюте возникновения; переводится при расчёте, вверх | Р-61 | путь решения |
| `PriceDecision` | Курса нет | + `fx`: откуда, куда, курс, дата, сумма до и после; обязателен при переводе себестоимости | Р-61 | 0037 |
| `Marketplace` | Сутки истории цен — Europe/Berlin для всех | + `time_zone`; сутки свёрток и закрытие дней — по поясу витрины | Р-62 | 0037 |
| `Tenant.dataRegion` | Не определено для витрин другого региона | Регион — место клиента; витрины любые; перенос — процедура | Р-60 | 0037, [tenant-region-transfer.md](tenant-region-transfer.md) |
| Якорь «тот же EAN» | Ссылка в другой валюте молча отбрасывалась | Перевод по курсу или явное предупреждение с причиной | Р-63 | `input-sanity` |

---

## 0.9 Изменения v0.9 → v0.10 (шаг 11, Р-65…Р-67)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `Marketplace` | `time_zone` обязателен; витринам США — America/Los_Angeles | `time_zone` — только у подтверждённой витрины; `time_zone_status` (`CONFIRMED` / `TO_VERIFY`) и `time_zone_source` по каждой витрине; у amazon.com и EBAY_US пояс не задан | Р-65 | 0040 |
| `ChannelWrite` | `budget_day` задаёт тот, кто создаёт запись | Запись с бюджетом правок — только при подтверждённом поясе витрины и `budget_day` = текущий местный день витрины | Р-65, Р-19 | 0040 |
| `PricingHalt` | Кто и почему создал остановку — не хранится; проверка выборкой выбирает любую остановку после окна | Ручная остановка (`MANUAL`) обязана иметь автора и заметку; проверка выборкой снимает только `CHANNEL_MASS_SHIFT`; порт `PricingStore.haltChannel` | Р-51, Р-52, Р-67 | 0040 |

## 0.10 Изменения v0.10 → v0.11 (шаг 12, Р-68…Р-73)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `PriceDecision` | Объяснение — код и параметры причины и проверки Gate; связь со снимком — только в отчёте прогона | Неизменяемый слепок объяснения `explanation` (`r68.1`): источник снимка, итог проверки входов с правилами и якорями, версия и параметры стратегии, проверки Gate, остановки в контексте; без данных канала. `bound_deviation_bp`, генерируемый `dangerous` (> 10 %) | Р-68, Р-73 | 0042 |
| `PriceIntentCore` | Ядро без объяснения | Копия слепка `explanation`, `bound_deviation_bp`, `dangerous` — вечно | Р-68, Р-38 | 0042 |
| **Новое:** `PriceDecisionSnapshotRef` | — | Ссылка решения на принятый снимок: идентификатор, источник, время наблюдения; 18 месяцев; пишется в транзакции решения | Р-68, Р-38 | 0042 |
| `CompetitorState` | Проекция снимка без итога проверки | `sanity_summary` — итог проверки принятого снимка: пересчёт объясняется так же, как исходная оценка | Р-68 | 0042 |
| **Новое:** `PriceStop` | Остановка человеком — `PricingHalt` с `MANUAL`, остановка тенанта — набор остановок аккаунтов | Остановка человеком: область `TENANT` / `CHANNEL_ACCOUNT` / `STOREFRONT`, автор, заметка, снятие с автором и заметкой; блокирует все цены; одна действующая на область; тенант — без аккаунта и покрывает аккаунты, подключённые позже | Р-69, Р-70 | 0042 |
| `PricingHalt` | Системная или ручная | Только системная (`CHANNEL_MASS_SHIFT`), только цены из данных конкурентов; ручное снятие — владелец или оператор | Р-51, Р-69 | 0042 |
| `Membership` | Роли без оператора; права на остановку не заданы | Роль `OPERATOR`; остановить — владелец и оператор, возобновить тенант — владелец, аккаунт и витрину — владелец и оператор (триггеры БД) | OQ-125 | 0042 |
| Причины решения | Текст объяснения в движке; суммы без валюты | Код и параметры со схемой (вид, класс источника); каждая сумма с валютой; тексты — словарь интерфейса DE/EN | Р-71, Р-72 | `pricing-model`, 0042 |

## 0.11 Изменения v0.11 → v0.12 (шаг 13, Р-74…Р-77)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `PriceDecision` | Слепок объяснения `r68.1` у каждого решения, целиком | Слепок `r74.1` — только у CHANGED и REJECTED_BY_GATE; у NO_OP — код причины `no_change_reason`. Слепок ссылается на справочник (`sanity_ruleset`, `gate_profile`) и на версию стратегии, а не повторяет их | Р-74, Р-75 | 0044 |
| **Новое:** `ExplanationRuleset` | Порог и порядок правил повторялись в каждом слепке | Неизменяемый справочник платформы: набор правил проверки входов (порядок, пороги по кодам) и профиль Gate (порядок проверок) | Р-75 | 0044 |
| `PriceIntentCore` | Слепок целиком | Ссылки на справочник и внешний ключ на версию `PricingStrategy` | Р-75 | 0044 |
| `WriteScope` | Стратегия — только в режиме ENGINE | Стратегия хранится независимо от режима; ENGINE без стратегии невозможен; в режиме Smart Pricing стратегии нет | Р-77, Р-12 | 0045 |
| `PriceStop`, `PricingHalt` | Автор и заметка — только в своей таблице | Каждая остановка, возобновление и системная остановка — событие `AuditEvent` с автором, ролью в момент действия, заметкой и областью | Р-76 | 0045 |
| `Membership` | Остановка — владелец и оператор | Остановить и возобновить аккаунт или витрину — владелец, администратор, оператор, менеджер цен; возобновить тенант — владелец и администратор; матрица в БД `security.pricing_permission` | OQ-129 | 0045 |
| **Новое:** `UserCredential`, `UserSession` | Входа не было (синтетический пользователь стенда) | Пароль — хеш scrypt, блокировка после неудачных входов; сессия — SHA-256 токена, срок, уровень аутентификации (место под MFA); роли — из `Membership` при каждом запросе (**отменено в v0.13**) | OQ-128 | 0046 |

## 0.12 Изменения v0.12 → v0.13 (шаг 14, Р-78…Р-82)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| ~~`UserCredential`, `UserSession`~~ | Пароль, блокировка, сессия у нас | **Удалены.** Вход, MFA, сброс пароля, приглашения — у внешнего поставщика identity | Р-78 | 0048 |
| **Новое:** `ExternalIdentity` | — | Привязка пользователя поставщика `(issuer, subject)` к `User`; одна на поставщика; видна и создаётся только самим пользователем; роли — из `Membership` при каждом запросе | Р-78 | 0048 |
| `PriceStop`, `PricingHalt` (ручное снятие) | Автор — любое членство с правом | Автор — членство пользователя сессии; без пользователя сессии действие не принимается; в `AuditEvent` — этот пользователь | находка 4, Р-76 | 0048 |
| `PriceDecision` | Слепок `r74.1` повторял итог, причину и границы Gate, стратегию, правило, триггер, предложенную цену | Слепок `r80.1` — только то, чего нет в столбцах; решение хранит столбцы intent (стратегия, правило, триггер, предложенная цена), их заполняет БД из intent; у NO_OP нет ссылки на снимок | Р-80, находка 10 | 0048, 0049 |
| `PriceIntentCore` | Слепок `r74.1`; архив — строки ядра | Слепок `r80.1`; архив тенанта — строки ядра со всеми версиями стратегий и наборами правил, на которые они ссылаются; подтверждается только если каждое объяснение разворачивается без базы | Р-79, Р-80 | 0049, `analytics-export` |
| NO_OP в аналитике | Агрегат по правилу и триггеру | Агрегат по коду причины, правилу и триггеру | Р-81 | `060_step14.sql` |

## 0.13 Изменения v0.13 → v0.14 (шаг 15, Р-83…Р-88)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| `ChannelWrite` | При создании и отправке — только `min_price` и `max_price` | Перед созданием и каждой отправкой (включая повторы) пол вычисляется заново: `min_price` и пол маржи по текущим себестоимости, комиссии, курсу ЕЦБ и ставке НДС; не вычисляется — отказ | Р-83 | 0051 |
| `ChannelWrite` (бюджет правок) | Повтор списывался на день создания записи | Повтор списывается на текущий местный день витрины с подтверждённым поясом | C2 | 0055 |
| `PriceIntentCore` | Хранил цели стратегий по рынку, а у отклонённой цены из данных конкурентов — предложенную цену и отклонение | Производные от цены конкурента не хранятся; «опасное» — флаг | Р-85 | 0052 |
| **Новое:** `IdentityInvitation` | — | Одноразовый токен (SHA-256), пользователь, тенант, срок ≤ 14 дней; приём — единственный путь создать `ExternalIdentity` | Р-88 | 0053 |
| `Membership` | Роль менялась любым кодом приложения | Смена роли — другим действующим владельцем или администратором со вторым фактором | Р-88 | 0053 |
| `PriceStop` (тенант) | Снятие — владелец или администратор | То же, со вторым фактором; остановка не создаётся сразу снятой | Р-88, находка 2 | 0053 |
| `PricingHaltReview` | Запись о снятии без самого снятия принималась | Только при снятии в той же транзакции, от участника с правом; автоматическое — системой после окна | находки 1, 3 | 0053 |

## 0.14 Изменения v0.14 → v0.15 (шаг 16, Р-89…Р-93)

| Сущность | Было | Стало | Решение | Где |
|---|---|---|---|---|
| Роли подключения к БД | Путь решения, консоль и вход — одна роль `repracer_app`; пользователь сессии и второй фактор выставлялись ею самой | Путь решения (`repracer_app`) не пишет аудит, членства, тенантов, пользователей, остановки человеком, не приглашает и не сопоставляет вход; пользователь сессии и второй фактор принимаются только у административного сервиса (`repracer_admin`); тенант создаётся функцией роли создания тенанта; вход — роль `repracer_authenticator`; аудит пишут только триггеры. Что база не обещает — ADR-0016, OQ-149 | Р-90 | 0058 |
| `Membership` | Приложение вставляло членство с любой ролью и переводило статус в ACTIVE | Создаётся только приглашением или вместе с тенантом; ACTIVE — только приёмом приглашения; отозванное не возвращается; владельца назначает и снимает только владелец, администратор не назначает администраторов; смена роли и отзыв — в аудите | Р-90, находки 2, 3, 9 | 0058 |
| `ExternalIdentity` | Пользователь с привязкой не принимал приглашение во второй тенант; email_verified не проверялся | Тот же вход принимает приглашение в следующий тенант [Р-9]; адрес подтверждён поставщиком; перепривязка к другому входу того же поставщика не поддерживается (OQ-148) | Находки 10, 11 | 0058 |
| `PricingHalt` (ручное снятие) | Без второго фактора | Со вторым фактором | Находка 12, Р-88 | 0058 |
| `PricingStrategy` | Параметры версии, в том числе подрез, — вечно (архив ядра) | Версия — тип и параметры без подреза | Р-91 | 0059 |
| **Новое:** `PricingStrategyUndercut` | — | Подрез версии стратегии; удаляется через 18 месяцев после замены версии; стратегия по рынку без подреза не создаётся | Р-91 | 0059 |
| `PriceDecision`, `PriceIntentCore` (слепок) | Запрещённые ключи — по списку; незаявленный ключ проходил | Разрешены только поля формата `r80.1`, коды причин и ключи их параметров из реестра (fail-closed); подрез — производная величина | Р-91, находка 15 | 0059 |
| `ChannelWrite` (завершение) | Отказ повтора при неподтверждённом поясе витрины не распознавался — запись висела FAILED | Завершение с причиной `WRITE_BUDGET_DAY_UNCONFIRMED` и алертом | Находка 7, Р-64 | 0057 |

## 1. Ограниченные контексты

| Контекст | Сущности |
|---|---|
| Tenancy & Identity | Tenant, User, ExternalIdentity, IdentityInvitation, Membership (вход — у поставщика identity, Р-78; привязка — приглашением, Р-88) |
| Channel Reference | ChannelCapability, ChannelCapabilityOverride |
| Channel Integration | ChannelAccount, OfferMapping, WriteScope, WriteScopeSyncState, ChannelWrite, EditBudget, SyncJob, ListingMigrationCheck, MigrationConsent |
| Channel Observation | ObservedChannelState, ChannelObservation, DivergencePolicy, DivergenceCase |
| Catalog | Product, BundleComponent |
| Economics | CostProfile, FeeEstimate, FeeActual |
| Pricing | PricingStrategy, PricingStrategyUndercut (Р-91), GuardRail, PriceIntent, PriceDecision, PriceHistory, CompetitorSnapshot |
| Inventory | StockPool, StockAllocation, Reservation |
| Audit | AuditEvent |

---

## 2. Схема связей

```
User (global) ─1:N─ Membership ─N:1─ Tenant

ChannelCapability (global, versioned) ─1:N─ WriteScope          [правило вывода ключа]
ChannelCapability ─1:N─ ChannelCapabilityOverride ─N:1─ ChannelAccount

Tenant ─1:N─ ChannelAccount ─1:N─ OfferMapping ─N:1─ Product ─1:N─ CostProfile (versioned)
                   │                    │                  ├─1:N─ BundleComponent ─N:1─ Product(SIMPLE)
                   │                    │                  └─1:N─ StockPool (зеркало внешнего источника)
                   │                    │
                   │                    ├─N:1─ WriteScope(PRICE)      ┐ одна на поле;
                   │                    └─N:1─ WriteScope(QUANTITY)   ┘ несколько офферов могут делить одну
                   │
                   ├─1:N─ WriteScope ─1:1─ WriteScopeSyncState
                   │          ├─1:N─ ChannelWrite ─N:0..1─ EditBudget (budget_scope_key, день)
                   │          ├─1:1─ ObservedChannelState ─1:N─ DivergenceCase
                   │          ├─1:N─ ChannelObservation            (append-only, срок по классу данных)
                   │          ├─1:N─ PriceIntent ─1:1─ PriceDecision ─0..1─ ChannelWrite   [PRICE]
                   │          ├─1:N─ PriceHistory                  (append-only, не удаляется)  [PRICE]
                   │          └─0..1─ StockAllocation (переопределение буфера)             [QUANTITY]
                   ├─0..1─ StockAllocation (буфер канала по умолчанию)
                   ├─1:N─ CompetitorSnapshot, FeeActual, SyncJob, Reservation
                   └─1:N─ ListingMigrationCheck ─N:M─ MigrationConsent        [только eBay]

GuardRail   ─scope→ Tenant | ChannelAccount | Product | WriteScope(PRICE)
DivergencePolicy ─scope→ Tenant | ChannelAccount | Product | WriteScope
AuditEvent  → любая сущность своего тенанта (append-only)
```

---

## 3. Сущности

### 3.1 Tenant

| Поле | Описание |
|---|---|
| `id` | Неизменяемый |
| `name` | |
| `status` | `TRIAL \| ACTIVE \| SUSPENDED \| OFFBOARDING \| CLOSED` |
| `data_region` | `EU \| US`; Release 1.0 — только `EU` [Р-7] |
| `default_currency`, `timezone` | Release 1.0: EUR, Europe/Berlin |
| `created_at`, `offboarding_requested_at`, `closed_at` | |

Инварианты:
- `id` и `data_region` неизменяемы.
- В `SUSPENDED`, `OFFBOARDING`, `CLOSED` исходящие `ChannelWrite` не отправляются.
- `CLOSED` ⇒ секреты удалены, подписки отозваны, данные удалены по матрице хранения (судьба `PriceHistory` — OQ-22).

### 3.2 User — глобальная [изменено, Р-9]

| Поле | Описание |
|---|---|
| `id` | |
| `email`, `display_name` | Персональные данные пользователя (GDPR), не PII покупателей |
| `status` | `ACTIVE \| DISABLED` |
| `mfa_enabled`, `last_login_at` | |

Инварианты:
- `email` уникален на платформе.
- `User` сам по себе не даёт доступа ни к каким данным тенанта — только через `Membership`.
- MFA — свойство пользователя и действует во всех его тенантах.

### 3.3 Membership [новое, Р-9]

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `user_id` | |
| `role` | `OWNER \| ADMIN \| OPERATOR \| PRICING_MANAGER \| INVENTORY_MANAGER \| VIEWER`; `OPERATOR` — остановка и возобновление цен (кроме остановки тенанта), снятие системной остановки, включение репрайсинга [OQ-125] |
| `status` | `INVITED \| ACTIVE \| REVOKED` |
| `invited_by`, `created_at`, `revoked_at` | |

Инварианты:
- `(tenant_id, user_id)` уникальна.
- У `ACTIVE` тенанта есть ≥ 1 `ACTIVE` `OWNER`.
- **Каждый запрос выполняется в контексте ровно одного тенанта**, выбранного в сессии через `Membership`. Смена тенанта = новый контекст.
- Нет представлений, объединяющих данные нескольких тенантов пользователя (INV-01, INV-07).
- Изменение ролей, `GuardRail`, `ChannelAccount`, `DivergencePolicy` требует MFA; согласие на миграцию eBay — только `OWNER` (OQ-56).

### 3.4 ChannelAccount

| Поле | Описание |
|---|---|
| `id`, `tenant_id` | |
| `channel` | `AMAZON \| EBAY \| KAUFLAND \| OTTO` |
| `region` | Amazon: `EU` (Release 1.0), позже `NA` |
| `external_account_id` | Amazon `selling_partner_id`, eBay user ID, Kaufland seller ID, Otto partner ID |
| `marketplaces[]` | Где мы работаем. Release 1.0: `A1PA6795UKMFR9` (amazon.de), `EBAY_DE`, `de` (Kaufland), `otto.de` |
| `known_other_marketplaces[]` | Где у SKU есть офферы, которыми мы не управляем, но на которые действуют побочные эффекты (остаток Amazon EU) |
| `credentials_ref` | Ссылка на секрет во внешнем хранилище |
| `auth_status` | `ACTIVE \| REAUTH_REQUIRED \| REVOKED \| DISCONNECTED` |
| `access_token_expires_at`, `authorization_expires_at` | |
| `granted_scopes[]` | **Без restricted-ролей** [Р-4] |
| `notification_subscriptions[]` | |
| `connected_at`, `connected_by_membership_id`, `disconnected_at` | |

Инварианты:
- `(channel, region, external_account_id)` привязан максимум к одному неудалённому тенанту на всей платформе.
- Входящее событие резолвится в тенанта только по этому ключу; нет совпадения — событие отбрасывается.
- Restricted-роли и Restricted Data Token не запрашиваются никогда [Р-4].
- При `auth_status ≠ ACTIVE` исходящие записи → `BLOCKED`.

### 3.5 ChannelCapability — глобальная, versioned [новое]

**Справочные данные, а не код.** Описывают, как канал принимает запись одного поля. Заполненная матрица —
[channel-capabilities.md](channel-capabilities.md).

| Поле | Описание |
|---|---|
| `id`, `version`, `status`, `valid_from` | `status`: `DRAFT \| ACTIVE \| DEPRECATED` |
| `channel`, `region`, `marketplace_pattern` | Область применимости |
| `api_mode` | Напр. `AMAZON_LISTINGS_ITEMS`, `EBAY_INVENTORY_API` |
| `field` | `PRICE \| QUANTITY` |
| `write_operation` | Операция API |
| `write_scope_kind` | Напр. `ACCOUNT_MARKETPLACE_SKU`, `ACCOUNT_REGION_SKU`, `ACCOUNT_MARKETPLACE_OFFER`, `ACCOUNT_INVENTORY_SKU`, `ACCOUNT_STOREFRONT_UNIT`, `ACCOUNT_SKU` |
| `write_scope_key_template` | Упорядоченный список атрибутов идентичности оффера, из которых строится `scope_key` |
| `write_semantics` | `LAST_WRITE_WINS`; `conditional_write_supported: bool` |
| `batch_max_items` | Размер пакета |
| `rate_limit` | `{requests_per_second, burst, limited_per: SELLER_APP \| APP \| PARTNER \| UNKNOWN, dynamic: bool}` |
| `object_edit_limit` | `{limit, period: CALENDAR_DAY, budget_scope_kind (напр. LISTING), shared_across_fields: bool, day_boundary_tz}` или `null` |
| `processing_mode` | `SYNC \| ASYNC` |
| `confirmation_methods[]` | `SYNC_RESPONSE \| SUBMISSION_STATUS \| NOTIFICATION(type) \| READBACK(operation) \| REPORT(type)` |
| `apply_grace_period` | Сколько ждать применения, прежде чем считать расхождением |
| `reversible` | `YES \| NO \| CONDITIONAL` + условие |
| `webhooks` | `YES \| NO \| UNKNOWN` + типы событий |
| `channel_decrements_on_order` | Для `QUANTITY`: канал сам уменьшает остаток при заказе |
| `side_effects` | Напр. «меняет остаток SKU во всех маркетплейсах EU» |
| `preconditions` | Напр. «листинг под управлением Inventory API» |
| `target_latency_p95` | [Р-8] |
| `observation_data_class` | `AMAZON_INFO \| CHANNEL_INFO` |
| `verification` | По каждому полю: `{status, source, verified_at}` |

Инварианты:
- Не содержит данных тенантов; тенанты только читают.
- Ровно одна `ACTIVE` версия на `(channel, region, marketplace_pattern, api_mode, field)`.
- Изменение — только новой версией через ревью; каждое изменение аудируется.
- **Значение со статусом `TO_VERIFY`/`UNKNOWN` в лимитах ⇒ Dispatcher применяет консервативную политику** (без пакетов, один параллельный запрос на аккаунт, backoff по 429). Цифры не додумываются.
- Смена `write_scope_kind` или шаблона ключа в новой версии — **перевыпуск ключей** (retire старых `WriteScope`, создание новых со ссылкой `supersedes_id`); активировать такую версию без процедуры перевыпуска нельзя.
- Для `field = PRICE` на маркетплейсах ЕС шаблон ключа обязан включать маркетплейс/витрину (история цен по каналу — Omnibus).

### 3.5a ChannelCapabilityOverride

Переопределение лимитов для конкретного аккаунта (напр. после eBay Growth Check или по фактическим заголовкам лимитов Amazon).

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id`, `capability_id` | |
| `rate_limit`, `object_edit_limit`, `batch_max_items` | Только лимиты; `write_scope_kind` переопределять нельзя |
| `evidence` | Основание (одобрение Growth Check, наблюдаемый заголовок лимита) |
| `valid_from`, `valid_to` | |

Инвариант: переопределение повышает лимит только при наличии `evidence`; понижение — всегда допустимо.

### 3.6 Product

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `sku` | `sku` уникален в тенанте |
| `kind` | `SIMPLE \| BUNDLE` |
| `title`, `gtin`, `mpn`, `brand` | |
| `tax_category` | Для ставки НДС (DE: 19% / 7%) |
| `status` | `ACTIVE \| ARCHIVED` |

Инварианты: как в v0.1. `BUNDLE` имеет ≥ 1 компонент и не имеет `StockPool`; мультипак = `BUNDLE`;
архивирование запрещено при наличии `ACTIVE` офферов.

### 3.7 BundleComponent

Без изменений: `bundle_product_id`, `component_product_id` (`SIMPLE`), `quantity ≥ 1`;
`available(bundle) = min_i ⌊available(component_i) / quantity_i⌋`; без вложенности.

### 3.8 OfferMapping [изменено]

**Больше не единица синхронизации.** Отвечает только на вопрос «какой оффер канала — какой товар».
Единица записи — `WriteScope` (3.9).

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `product_id`, `channel_account_id` | |
| `marketplace` | |
| `identity` | Атрибуты идентичности оффера в канале — по каналу, см. таблицу ниже |
| `channel_product_ref` | ASIN / ePID / EAN — для конкурентов |
| `condition`, `fulfillment` | `fulfillment`: `MERCHANT \| CHANNEL` |
| `currency`, `price_basis` | Release 1.0: EUR, GROSS |
| `status` | `DISCOVERED \| ACTIVE \| PAUSED \| CONFLICT \| MIGRATION_REQUIRED \| INELIGIBLE \| ENDED` |
| `price_write_scope_id`, `quantity_write_scope_id` | Nullable; выводятся, не задаются вручную |
| `pricing_enabled`, `stock_sync_enabled` | |
| `pricing_strategy_id` | |

Атрибуты `identity` по каналам:

| Канал | Атрибуты |
|---|---|
| Amazon | `region`, `marketplace_id`, `seller_sku`, `asin` |
| eBay | `marketplace_id`, `inventory_sku`, `offer_id`, `listing_id` (ItemID), `listing_format`, `inventory_api_managed`, `migration_status` |
| Kaufland | `storefront`, `id_unit`, `id_offer` (обязателен для синхронизации остатка, Р-35), `ean` |
| Otto | `sku` (дополнительные идентификаторы — проверить) |

Инварианты:
- `(channel_account_id, marketplace, identity-ключ)` уникальна среди неокончённых маппингов ⇒ оффер соответствует ровно одному `Product`.
- **Все `OfferMapping`, входящие в один `WriteScope`, ссылаются на один и тот же `Product`.** Иначе — `CONFLICT` для всех членов, запись в этот scope блокируется. (Пример: SKU на amazon.de и amazon.fr сопоставлен разным товарам при общем остатке.)
- `pricing_enabled = true` ⇒ существует `price_write_scope_id` и для него разрешим абсолютный `min_price` [Р-5].
- `stock_sync_enabled = true` ⇒ `fulfillment = MERCHANT`, существует `quantity_write_scope_id`, для аккаунта задан буфер канала [Р-6], и пользователь подтвердил побочные эффекты scope (INV-11).
- eBay: запись разрешена только при `inventory_api_managed = true`. Иначе статус `MIGRATION_REQUIRED` или `INELIGIBLE` [Р-2].
- Смена `product_id` — не update: старый маппинг `ENDED`, новый создаётся; `WriteScope` и история по нему сохраняются.

### 3.9 WriteScope [новое]

Единица записи одного поля в канал. Ключ выводится из `ChannelCapability` и атрибутов `OfferMapping.identity`.
Обоснование — [ADR-0002](adr/0002-write-scope-per-field.md).

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id` | |
| `field` | `PRICE \| QUANTITY` |
| `capability_id`, `capability_version` | Из какого правила выведен |
| `scope_kind` | Из `ChannelCapability.write_scope_kind` |
| `scope_key` | Канонический ключ по шаблону (примеры ниже) |
| `budget_scope_key` | Nullable; ключ дневного бюджета правок (eBay: ItemID) |
| `status` | `ACTIVE \| HELD` (открыт `DivergenceCase` с `ASK_HUMAN`) `\| CONTESTED` (обнаружен конкурирующий писатель) `\| BLOCKED` `\| RETIRED` |
| `side_effects_ack` | Кто и когда подтвердил побочные эффекты (для остатка Amazon EU) |
| `supersedes_id` | При перевыпуске ключей |

Примеры `scope_key` (SKU `A-1`):

| Канал · поле | `scope_key` | Членов-офферов |
|---|---|---|
| Amazon · PRICE | `EU/A1PA6795UKMFR9/A-1` | 1 на маркетплейс |
| Amazon · QUANTITY | `EU/A-1` | все маркетплейсы EU, где есть SKU |
| eBay · PRICE | `EBAY_DE/offer:7700…` | 1 |
| eBay · QUANTITY | `inv:A-1` (уровень — проверить, OQ-47) | 1 в Release 1.0 |
| Kaufland · PRICE | `de/unit:5550…` | 1 |
| Kaufland · QUANTITY | `offer:A-1` (общая для `de` и `at`) [Р-35] | все unit с этим `id_offer` на витринах аккаунта |
| Otto · PRICE / QUANTITY | `A-1` | 1 |

Инварианты:
- `(channel_account_id, field, scope_key)` уникальна.
- Создаётся только выводом из capability; вручную не создаётся и не редактируется. Перевыпуск = `RETIRED` + новый со `supersedes_id`.
- **От `write_scope_id` зависят:** последовательность версий, ключ идемпотентности, схлопывание, in-flight, ключ упорядочивания событий, `ObservedChannelState`, применение `DivergencePolicy`, `PriceHistory` (для PRICE).
- Для `QUANTITY` публикуемое значение вычисляется **один раз на scope**, а не на каждый оффер-член.

### 3.10 WriteScopeSyncState [изменено: бывш. OfferSyncState]

Ключ: `write_scope_id`.

| Поле | Описание |
|---|---|
| `latest_version_created`, `latest_version_dispatched`, `latest_version_accepted` | Водяные знаки; только растут |
| `latest_version_applied` | Подтверждено наблюдением (см. OQ-45 о классе данных) |
| `in_flight_write_id` | |
| `last_sent_value` | Значение последней принятой каналом записи |

### 3.11 ChannelWrite [изменено]

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id`, `write_scope_id` | |
| `field`, `value` | |
| `version` | Монотонно по `write_scope_id` |
| `idempotency_key` | `hash(tenant_id, channel_account_id, field, scope_key, version)` |
| `origin` | `PRICE_DECISION(id) \| STOCK_RECALC(ref) \| DIVERGENCE_REASSERT(case_id)` |
| `direction` | Для QUANTITY: `DECREASE \| INCREASE \| SAME` относительно `last_sent_value` (приоритет безопасных записей) |
| `status` | `PENDING → DISPATCHED → ACCEPTED → APPLIED`; `NOT_APPLIED \| FAILED \| SUPERSEDED \| BLOCKED \| BUDGET_EXHAUSTED \| DISCARDED_STALE` |
| `budget_scope_key`, `budget_day` | Если capability имеет `object_edit_limit` |
| `sync_job_id`, `attempt_count` | Ответы канала (`submissionId`, ошибки) — в `channel_write_response`, 18 мес [Р-17] |
| `trigger_received_at` | Для замера SLA [Р-8] |
| `created_at`, `dispatched_at`, `accepted_at`, `applied_at` | |

Инварианты — INV-03, INV-13.

### 3.12 EditBudget [новое, Р-2]

Дневной бюджет правок объекта канала (eBay: 250 правок листинга в календарный день).

| Поле | Описание |
|---|---|
| `tenant_id`, `channel_account_id`, `budget_scope_key`, `budget_day` | Ключ; `budget_day` — календарный день канала (часовой пояс — проверить, OQ-47) |
| `limit` | Из capability/override |
| `quantity_reserve` | Доля, недоступная записям цены (параметр, OQ-53) |
| `used_price`, `used_quantity` | Наш учёт |
| `unaccounted_margin` | Запас на правки, которых мы не видим (продавец в Seller Hub, другие инструменты) |
| `exhausted_at` | Если канал вернул ошибку лимита |

Инварианты:
- Единица бюджета резервируется **до** отправки; нет бюджета — `ChannelWrite` → `BUDGET_EXHAUSTED`, в канал не уходит.
- Записи цены не могут использовать `quantity_reserve`.
- Записи `QUANTITY` с `direction = DECREASE` имеют наивысший приоритет на остаток бюджета.
- При неопределённости, учтена ли попытка каналом, считаем, что учтена.
- Один бюджет на все поля и все SKU-вариации, входящие в листинг (подтвердить, OQ-47).

### 3.13 ObservedChannelState [новое]

**Что мы видим в канале**, отдельно от того, что отправили. Проекция по `write_scope_id`.

| Поле | Описание |
|---|---|
| `tenant_id`, `write_scope_id`, `field` | |
| `observed_value` | |
| `observed_at`, `received_at`, `observation_id` | Ссылка на последнюю `ChannelObservation` |
| `source` | `NOTIFICATION \| READBACK \| REPORT` |
| `expected_value`, `expected_write_id` | Из `WriteScopeSyncState` на момент сравнения |
| `sync_status` | `UNKNOWN` (ещё не наблюдали) `\| IN_SYNC \| PENDING_APPLY` (в пределах `apply_grace_period`) `\| DIVERGED \| STALE` (наблюдение устарело) |
| `divergence_cause` | `NOT_APPLIED` (видим прежнее наше значение) `\| EXTERNAL_CHANGE` (значение не совпадает ни с одной нашей записью) `\| CHANNEL_ORDER_DECREMENT` (QUANTITY уменьшилось на объём заказа) `\| CHANNEL_SUPPRESSION` (канал деактивировал/подавил оффер) |
| `diverged_since` | |
| `external_changes_in_window` | Счётчик для обнаружения конкурирующего писателя |
| `data_class` | `AMAZON_INFO \| CHANNEL_INFO` |

Инварианты:
- Наблюдение **никогда** не изменяет `WriteScopeSyncState.last_sent_value` и водяные знаки отправки; отправка никогда не изменяет `observed_value`.
- Наблюдение с `observed_at` не новее текущего не заменяет его.
- `CHANNEL_ORDER_DECREMENT` не является расхождением, если объяснено `Reservation` того же канала; иначе — `EXTERNAL_CHANGE`.
- Для Amazon — `AMAZON_INFO`: проекция удаляется/обезличивается вместе с исходными наблюдениями по сроку.

### 3.14 ChannelObservation — append-only [новое, Р-3]

Журнал всего прочитанного из канала о значениях наших scope. Для PRICE это и есть «наблюдаемая история цен».

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id`, `write_scope_id`, `field` | |
| `value`, `observed_at`, `received_at` | |
| `source`, `source_event_id` | Дедупликация |
| `data_class` | `AMAZON_INFO` для SP-API ⇒ `retention_until ≤ observed_at + 18 мес` |
| `retention_until` | |

Инварианты:
- Не используется для обучения моделей [Р-10] и межтенантной аналитики.
- Удаляется только процедурой хранения по `retention_until`.

### 3.15 DivergencePolicy — versioned [новое]

Как реагировать на расхождение «отправили ≠ видим».

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `version` | |
| `scope_type`, `scope_id` | `TENANT \| CHANNEL_ACCOUNT \| PRODUCT \| WRITE_SCOPE`; побеждает самый конкретный |
| `field` | `PRICE \| QUANTITY` |
| `on_external_change` | `REASSERT` (вернуть наше) `\| YIELD` (уступить) `\| ASK_HUMAN` (спросить человека) |
| `yield_pause` | Для `YIELD`: пауза автоматики по scope (длительность или до ручного возобновления) |
| `on_not_applied` | `RETRY \| ASK_HUMAN` |
| `max_reasserts_per_period` | Превышение ⇒ scope `CONTESTED` и эскалация в `ASK_HUMAN` |
| `grace_override` | Переопределение `apply_grace_period` (только в большую сторону) |

Предлагаемые значения по умолчанию (подтвердить, OQ-49):

| Поле | `on_external_change` | Почему |
|---|---|---|
| PRICE | `ASK_HUMAN` | Продавец мог сознательно изменить цену в кабинете |
| QUANTITY | `REASSERT` | Мы — зеркало внешнего источника; расхождение означает риск перепродажи |

Инварианты:
- `REASSERT` цены = новый `PriceIntent` (trigger `DIVERGENCE_REASSERT`) → Price Gate → **новая версия**. Повторная отправка старой записи со старой версией запрещена.
- `REASSERT` расходует `EditBudget` наравне с обычными записями.
- `YIELD` цены: наблюдённая цена становится базой для стратегии; в `PriceHistory` **не** записывается (это не наша цена) — остаётся в `ChannelObservation`.
- `ASK_HUMAN`: scope → `HELD`, записи по нему `BLOCKED` до решения, **кроме** `QUANTITY` с `direction = DECREASE` — уменьшение опубликованного остатка никогда не блокируется политикой.
- Наблюдённая цена ниже floor ⇒ всегда `DivergenceCase` с уведомлением, независимо от политики.
- Каждое применение политики ⇒ `AuditEvent`.

### 3.16 DivergenceCase [новое]

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `write_scope_id`, `field` | |
| `expected_value`, `observed_value`, `cause` | |
| `policy_id`, `policy_version`, `action_taken` | `REASSERTED \| YIELDED \| ESCALATED \| RETRIED` |
| `status` | `OPEN \| RESOLVED` |
| `resolution` | `KEEP_OURS \| ACCEPT_OBSERVED \| PAUSE_SCOPE` |
| `resolved_by_membership_id`, `opened_at`, `resolved_at` | |

Инвариант: не более одного `OPEN` кейса на `(write_scope_id, field)`; новые расхождения дополняют его.
Класс данных: содержит наблюдённые значения ⇒ для Amazon `AMAZON_INFO`.

### 3.17 CostProfile — versioned

Без изменений v0.1: версии по `(product_id, scope)`, компоненты затрат NET, ссылки из intent/decision на версию.
Release 1.0: валюта затрат — EUR (иная — OQ-15).

### 3.18 FeeEstimate

Без изменений v0.1: функция комиссий от цены, `source`, `valid_until`, fail-closed при просрочке;
калибровка только по `FeeActual` того же тенанта. Привязка — к `write_scope_id` (PRICE).

### 3.19 FeeActual — append-only

Без изменений v0.1. Для Amazon — `AMAZON_INFO`, ≤ 18 мес; используется только для отчётов и калибровки
в пределах тенанта, **не** для обучения моделей [Р-10].

### 3.20 GuardRail — versioned [изменено, Р-5]

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `version` | |
| `scope_type`, `scope_id` | `TENANT \| CHANNEL_ACCOUNT \| PRODUCT \| WRITE_SCOPE` (PRICE) |
| ~~`min_price`~~ | Вынесен в отдельную таблицу `min_price`: только уровни PRODUCT и WRITE_SCOPE [Р-18] |
| `min_margin` | Nullable |
| `max_price`, `max_step_change_pct`, `max_changes_per_period` | |
| `on_violation` | `CLAMP \| REJECT \| HOLD` |

Вычисление:
- `effective_floor = max(все применимые min_price, cost_floor если задан min_margin)` — побеждает самый строгий [Р-5].
- `effective_ceiling = min(все применимые max_price)`.

Инварианты:
- **Для каждой единицы цены в режиме `ENGINE` или `KAUFLAND_SMART_PRICING` должен разрешаться абсолютный `min_price`; он существует только на уровнях `PRODUCT` и `WRITE_SCOPE` [Р-18].**
- `min_price` в валюте и базе scope; сравнение с иными — запрещено.
- `effective_floor ≥ effective_ceiling` ⇒ `HOLD`.
- Задан `min_margin`, но не хватает входа (себестоимость, комиссии, НДС) ⇒ fail-closed, даже если `min_price` задан.
- Нельзя удалить или ослабить GuardRail так, чтобы требование к `min_price` перестало выполняться у включённого scope.

### 3.21 PricingStrategy — versioned

Изменения: стратегия вычисляет цену для `WriteScope(PRICE)`.
- Чистая функция, детерминирована, без доступа к каналам и часам.
- **Никаких моделей, обученных на данных SP-API, в том числе для одного тенанта, и никакого автоподбора параметров на этих данных** [Р-10]. Параметры задаёт человек.
- Стратегии, зависящие от конкурентов, доступны только для каналов с легальным источником `CompetitorSnapshot`.
- Стратегия объявляет требуемую полноту конкурентных данных; на канале, который её не обеспечивает, стратегия не включается, интерфейс объясняет причину [Р-39, [ADR-0007](adr/0007-competitor-data-completeness.md)].

### 3.22 PriceIntent — append-only

Как v0.1; `offer_mapping_id` заменён на `write_scope_id`. `trigger.type` добавлен `DIVERGENCE_REASSERT`.
Класс данных для Amazon при наличии цен конкурентов во входах — `AMAZON_INFO`.
Класс `intent_class` выводится из решения: `CHANGED`, `REJECTED_BY_GATE`, `NO_OP` [Р-27]. Ядро (единица записи, предложенная цена,
правило, опорное значение, итог Gate) для первых двух хранится вечно; входы с данными канала — не дольше 18 месяцев, поэтому окно
бэктеста — максимум 18 месяцев [Р-38].

### 3.23 PriceDecision — append-only

Как v0.1; привязка к `write_scope_id`. Создаётся только Price Gate; `effective_floor ≤ final_price ≤ effective_ceiling`.
Хранит неизменяемый слепок объяснения `explanation` без данных канала [Р-68] и отклонение от нарушенной границы `bound_deviation_bp`;
`dangerous` — отклонение больше 10 % [Р-73]. Решение по цене из данных конкурентов ссылается на снимок через `PriceDecisionSnapshotRef` (18 месяцев).
Одобрение при действующей остановке человеком (`PriceStop`) отклоняет БД для любой цены [Р-69].
С шага 13 слепок есть только у решений CHANGED и REJECTED_BY_GATE; решение NO_OP хранит код причины `no_change_reason` [Р-74].
Слепок ссылается на неизменяемый справочник `ExplanationRuleset` и на версию `PricingStrategy` [Р-75].

### 3.24 PriceHistory — append-only, не удаляется [изменено, Р-3]

**Только наши собственные цены** — данные тенанта. Всё прочитанное из канала — в `ChannelObservation`.

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `write_scope_id` (PRICE) | Ключ истории |
| `channel_account_id`, `marketplace`, `scope_key` | Денормализация для запросов Omnibus |
| `product_id` | На момент записи |
| `price_type` | `REGULAR \| SALE \| REFERENCE` |
| `price`, `price_basis` | |
| `price_decision_id`, `channel_write_id` | |
| `dispatched_at`, `accepted_at` | Факты наших действий: статус и время записи — данные тенанта [Р-17] |
| `corrects_id` | Исправление **нашей** ошибки записи; не по данным наблюдений |
| `recorded_at` | |

Инварианты:
- Append-only; UPDATE/DELETE невозможны на уровне хранилища. Удаление при закрытии тенанта — OQ-22.
- Записи **не содержат** ничего прочитанного из SP-API: ни наблюдённых цен, ни статусов применения.
- Цепочка `WriteScope.supersedes_id` сохраняет непрерывность истории при перевыпуске ключей.
- Минимальная цена за 30 дней для scope = минимум по `PriceHistory` ∪ `ChannelObservation(PRICE)` за окно (окно 30 дней ⊂ 18 месяцев).
- Кандидат в инвариант (ждёт юриста): `REFERENCE`-цена при объявлении скидки = минимальная цена scope за 30 дней.

### 3.25 CompetitorSnapshot — append-only

Без изменений v0.1: строго внутри тенанта, без межтенантной дедупликации; `AMAZON_INFO` ≤ 18 мес;
не используется для обучения [Р-10]. Kaufland — `buy_box_changed` и `GET /buybox`, сверка — `competitors-comparer` [Р-36];
eBay и Otto — OQ-38. Снимок несёт полноту `TOP_N(n) | CHEAPEST_ONLY | FULL` [ADR-0007].

### 3.26 StockPool [изменено, Р-6, Р-15]

**Зеркало внешнего источника остатка.** Мы не владелец и не списываем остаток. *(v0.3: верно для режима `INBOUND_API`; в режиме `INTERNAL_POOL` остаток ведётся у нас журналом `stock_movement` [Р-15].)*

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `product_id` (`SIMPLE`) | |
| `source_system`, `source_location_ref` | ERP/WMS/файл/ручной ввод (источник Release 1.0 — OQ-03) |
| `on_hand` | Целое ≥ 0, только из источника |
| `source_as_of` | Момент, по состоянию на который источник гарантирует значение |
| `source_version` | Если источник его даёт |

Производные:
- `available(SIMPLE) = max(0, Σ on_hand − Σ Reservation(ACTIVE).quantity)`
- `available(BUNDLE) = min_i ⌊available(c_i) / q_i⌋`

Инварианты:
- `on_hand` изменяется только данными источника; значение с `source_as_of` не новее текущего не применяется.
- Нет пулов под FBA/`CHANNEL_MANAGED`: офферы с `fulfillment = CHANNEL` не участвуют в синхронизации остатка.
- Буфер пула удалён — буфер задаётся на канал (3.27), чтобы не было двойного вычета.

### 3.27 StockAllocation [изменено, Р-6]

**Буфер канала** над общим пулом. Режима выделенных долей нет.

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `version` | |
| `scope_type`, `scope_id` | `CHANNEL_ACCOUNT` (обязателен при синхронизации остатка) \| `WRITE_SCOPE` (QUANTITY, переопределение) |
| `buffer_units` | Целое ≥ 0 |
| `max_quantity` | Nullable, верхний предел |
| `min_quantity_to_list` | Ниже — публикуем 0 |

Публикуемое количество для `WriteScope(QUANTITY)`:
`q = max(0, available(product) − buffer)`; `q = min(q, max_quantity)`; если `q < min_quantity_to_list` ⇒ `q = 0`.

Инварианты:
- Считается один раз на `WriteScope(QUANTITY)`; для Amazon EU — одно значение на SKU в регионе [Р-1].
- Буфер Amazon применяется к общему EU-значению, а не к маркетплейсу.
- Изменение количества в канале — только через `ChannelWrite(QUANTITY)`.

### 3.28 Reservation [изменено, Р-6]

**Временный вычет** между заказом в канале и моментом, когда внешний источник учёл заказ в `on_hand`.

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `product_id` (`SIMPLE`), `quantity > 0` | |
| `channel_account_id`, `channel_order_ref`, `channel_order_line_ref` | Без данных покупателя |
| `order_created_at` | Время заказа в канале |
| `managed_listing` | Заказ из оффера, которым мы не управляем (напр. аукцион eBay) — всё равно резервируем |
| `status` | `ACTIVE \| RELEASED_BY_SOURCE \| CANCELLED \| EXPIRED` |
| `expires_at`, `closed_at` | |

Инварианты:
- Идемпотентна по `(channel_account_id, channel_order_line_ref, product_id)`.
- Строка заказа комплекта ⇒ резервации по компонентам, атомарно.
- `RELEASED_BY_SOURCE` — когда источник подтвердил учёт заказа (правило — **OQ-03, блокирует схему**; кандидат: `source_as_of ≥ order_created_at + лаг импорта`).
- `EXPIRED` по TTL — страховка, а не основной путь; каждое истечение логируется как аномалия.
- Импорт заказов — из всех офферов аккаунта, включая неуправляемые, иначе общий пул завышен.
- Никаких PII; поля заказа берутся по белому списку [Р-4].

### 3.29 SyncJob

Как v0.1; добавлены типы `READBACK`, `CAPABILITY_PROBE`, `EBAY_MIGRATION_PREFLIGHT`, `EBAY_LISTING_MIGRATION`.

### 3.30 ListingMigrationCheck — append-only [новое, Р-2]

Результат предполётной проверки одного листинга eBay. Сценарий — [onboarding-ebay-migration.md](onboarding-ebay-migration.md).

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id`, `listing_id` | |
| `checked_at`, `sync_job_id` | |
| `listing_snapshot_hash` | Хэш проверенных атрибутов листинга |
| `findings[]` | `{check_code, severity: BLOCKER \| LOSS \| WARNING \| INFO, details}` |
| `verdict` | `ALREADY_MANAGED \| READY \| READY_WITH_LOSSES \| FIXABLE \| INELIGIBLE \| UNKNOWN` |
| `ruleset_version` | Версия набора проверок |

### 3.31 MigrationConsent — append-only [новое, Р-2]

| Поле | Описание |
|---|---|
| `id`, `tenant_id`, `channel_account_id` | |
| `membership_id`, `user_id`, `mfa_verified_at` | |
| `items[]` | `{listing_id, check_id, listing_snapshot_hash, acknowledged_losses[]}` |
| `disclosure_version`, `disclosure_text_hash` | Что именно было показано |
| `other_tools_declaration` | Декларация продавца об иных инструментах, правящих листинги через Trading API |
| `typed_confirmation` | Введённая фраза подтверждения |
| `given_at`, `expires_at`, `revoked_at` | |

Инварианты (INV-12):
- Миграция листинга без действующего согласия, ссылающегося на **актуальную** проверку этого листинга, невозможна.
- Согласие дают только человек с ролью `OWNER` и пройденной MFA; не система, не поддержка, не API-токен.
- Если повторная проверка перед миграцией даёт иной `listing_snapshot_hash` или новые `LOSS`/`BLOCKER` — согласие для листинга недействительно.
- Отзыв возможен до выполнения; после миграции отзыв ничего не откатывает.

### 3.32 AuditEvent — append-only

Как v0.1; `actor` = `user_id` + `membership_id`. Новые обязательные действия: `migration.consent_given`,
`migration.listing_migrated`, `divergence.policy_applied`, `capability.version_activated`, `write_scope.reissued`,
`write_scope.side_effects_acknowledged`.

---

## 4. Сквозные инварианты

### INV-01. Ни один запрос не пересекает границу тенанта
- `tenant_id` — из контекста сессии, выбранного через `Membership`; никогда из параметров запроса.
- Один запрос — один тенант. Пользователь в нескольких тенантах не получает объединённых представлений.
- Ограничение по `tenant_id` — на уровне хранилища (механизм — OQ-40).
- События несут `tenant_id`; потребитель проверяет принадлежность всех сущностей.
- Ключи кэшей, очередей, блокировок, лимитеров включают `tenant_id`; глобальные квоты приложения учитываются по тенантам.
- Глобальные сущности (`User`, `ChannelCapability`) не содержат данных тенантов.

### INV-02. Минимальная цена проверяется вне движка стратегий, на выходе

*Расширено Р-43, Р-44:* обе абсолютные границы (`min_price`, `max_price`) обязательны и проверяются трижды — Gate (предложенная и итоговая цена), вставка решения в БД, создание и отправка записи. Выход за границу отклоняется, а не округляется; невычислимая граница — отказ. Входные данные проверяются на правдоподобие до движка (Р-42). См. [ADR-0008](adr/0008-price-decision-path.md).
- Стратегия выдаёт `PriceIntent`; `PriceDecision` создаёт только Price Gate.
- Dispatcher перед сетевым вызовом повторно проверяет floor и версии входов.
- Ручная цена, `REASSERT`, массовое изменение — через Gate.
- Абсолютный `min_price` обязателен, побеждает максимум [Р-5].

### INV-03. Каждая запись идемпотентна и версионирована по WriteScope
- Версия — из последовательности `write_scope_id`, не из часов.
- `version < latest_version_dispatched` ⇒ `DISCARDED_STALE`.
- Одна in-flight запись на `write_scope_id`; новые схлопываются до последней.
- Ключ идемпотентности: `hash(tenant_id, channel_account_id, field, scope_key, version)`.
- Ключ упорядочивания событий: `(tenant_id, write_scope_id)`.
- Для Amazon QUANTITY все маркетплейсы EU пишут в один scope ⇒ не существует двух версий одного физического значения.

### INV-04. История цен
- `PriceHistory` — только наши цены, по `WriteScope(PRICE)`, append-only, не удаляется [Р-3].
- Прочитанное из каналов — `ChannelObservation`, срок по классу данных; Amazon ≤ 18 мес.
- Одна запись никогда не смешивает наши данные и данные канала.

### INV-05. Fail-closed
Нет входов floor, неразрешим `min_price`, неактивна авторизация, листинг eBay не под Inventory API, нет бюджета
правок, неизвестный тенант события ⇒ действие не выполняется, причина фиксируется. Неподтверждённые лимиты
capability ⇒ консервативная политика Dispatcher.

### INV-06. Деньги
Целые minor units + валюта + база; конвертации явные. Release 1.0: EUR, GROSS.

### INV-07. Нет агрегации данных разных тенантов
Ни отчётов, ни бенчмарков, ни общих кэшей, ни калибровки по нескольким тенантам.

### INV-08. Модели
- На данных SP-API модели не обучаются **никогда** — ни общие, ни для одного тенанта; автоподбор параметров на этих данных запрещён [Р-10].
- На production-данных других каналов — не обучаем до отдельного решения.
- Dev/test/staging — только синтетические данные.

### INV-09. PII
- Restricted-роли и RDT не запрашиваются [Р-4].
- Для каналов, возвращающих PII по умолчанию (заказы eBay/Kaufland/Otto — проверить), поля берутся по белому списку **до** любой записи на диск, включая логи, DLQ и трассировку.

### INV-10. Порядок входящих событий
Наблюдение/событие не новее текущего не перезаписывает состояние; дубликаты — по `source_event_id`.

### INV-11. Согласованность и побочные эффекты WriteScope
- Все офферы одного scope ссылаются на один `Product`.
- Побочные эффекты scope (остаток Amazon меняется во всех маркетплейсах EU) показываются и подтверждаются пользователем до включения синхронизации (`side_effects_ack`).

### INV-12. Миграция eBay
- Кода автоматической миграции не существует; миграция — только `SyncJob(EBAY_LISTING_MIGRATION)` по действующему `MigrationConsent`.
- Листинг не под Inventory API ⇒ никаких записей в него.

### INV-13. Бюджеты правок
- Лимит правок объекта проверяется и резервируется до отправки.
- Резерв под QUANTITY недоступен PRICE; уменьшение остатка — наивысший приоритет.

### INV-14. «Отправили» и «видим» разделены
- `WriteScopeSyncState` и `ObservedChannelState` не перезаписывают друг друга.
- Реакция на расхождение — только через `DivergencePolicy`; `REASSERT` создаёт новую версию через Gate.
- Уменьшение опубликованного остатка не блокируется ни политикой расхождений, ни `HELD`.

---

## 5. Потоки

### 5.1 Цена

```
Событие → Ingest (резолв тенанта, дедуп, порядок) → CompetitorSnapshot
→ OfferContext по WriteScope(PRICE) → Strategy (чистая) → PriceIntent
══ исходящий конвейер ══
→ Price Gate (min_price обязателен, max floors) → PriceDecision
→ ChannelWrite(version по write_scope) → EditBudget (если есть лимит)
→ Dispatcher: повторная проверка floor, лимитер, схлопывание по write_scope
→ канал → ACCEPTED → PriceHistory (наш факт)
→ наблюдение → ChannelObservation → ObservedChannelState → APPLIED | расхождение
```

### 5.2 Остаток

```
Заказ в любом канале → Reservation(ACTIVE)          Внешний источник → StockPool.on_hand (as_of)
                          └──────────── available(product, bundles) ───────────┘
→ по каждому WriteScope(QUANTITY) товара: q = f(available, буфер канала) — один раз на scope
→ ChannelWrite(QUANTITY, direction) → EditBudget → Dispatcher → канал
Источник учёл заказ → Reservation(RELEASED_BY_SOURCE)
```

### 5.3 Наблюдение и расхождение

```
Нотификация / readback / отчёт → ChannelObservation (срок по классу)
→ ObservedChannelState: сравнение с expected
   равно                          → IN_SYNC, ChannelWrite → APPLIED
   не равно, в grace              → PENDING_APPLY
   прежнее наше значение          → NOT_APPLIED → on_not_applied
   уменьшение = заказ этого канала → CHANNEL_ORDER_DECREMENT (не расхождение)
   иначе                          → EXTERNAL_CHANGE → DivergencePolicy
        REASSERT → новый PriceIntent / пересчёт QUANTITY → Gate → новая версия
        YIELD    → база стратегии = наблюдённое, пауза scope
        ASK_HUMAN→ DivergenceCase, scope HELD (кроме уменьшения остатка)
   частые EXTERNAL_CHANGE         → scope CONTESTED → ASK_HUMAN
```

### 5.4 Онбординг eBay
См. [onboarding-ebay-migration.md](onboarding-ebay-migration.md).

---

## 6. Матрица хранения

| Данные | Класс | Срок | Основание |
|---|---|---|---|
| PII покупателей | — | Не храним нигде, включая логи | Р-4 |
| `PriceHistory` | TENANT_OWNED | Не удаляется (закрытие тенанта — OQ-22) | Р-3, Omnibus |
| `ChannelObservation`, `ObservedChannelState`, `DivergenceCase` — Amazon | AMAZON_INFO | ≤ 18 мес | Р-3, DPP |
| То же — eBay/Kaufland/Otto | CHANNEL_INFO | По условиям лицензии канала (OQ-51) | — |
| `CompetitorSnapshot`, `FeeActual`, intent/decision с данными Amazon | AMAZON_INFO | ≤ 18 мес | DPP |
| `ChannelWrite` (Amazon) | смешанный (OQ-45) | ≤ 18 мес до решения OQ-45 | DPP |
| `MigrationConsent`, `ListingMigrationCheck` | TENANT_OWNED / CHANNEL_INFO | Не короче срока жизни аккаунта + срок исковой давности (OQ) | Доказательство согласия |
| `AuditEvent`, логи | SYSTEM | ≥ 12 мес; с данными Amazon ≤ 18 мес | DPP |
| `CostProfile`, `GuardRail`, `PricingStrategy`, `DivergencePolicy` | TENANT_OWNED | Пока тенант активен + срок после offboarding | Договор |
| `User`, `Membership` | GDPR | Пока аккаунт активен + срок | GDPR |
| `ChannelCapability` | SYSTEM | Бессрочно (версии) | — |

---

## 7. Известные слабые места модели (v0.2)

1. **Гонка остатка Amazon EU.** Last write wins на весь регион: если заказ уменьшил остаток, а мы в это время
   записали значение, посчитанное до получения заказа, мы перезапишем уменьшение Amazon. Буфер канала лишь снижает риск.
2. **Освобождение резерваций при чужом остатке.** Без надёжного признака «источник учёл заказ» возможен двойной вычет
   (занижение) или его отсутствие (перепродажа).
3. **Бюджет eBay 250/день** общий для полей, вариаций и невидимых нам правок продавца; при частом репрайсинге
   исчерпывается раньше, чем заканчивается день.
4. **Граница «наше / Amazon Information»** для подтверждений записи определяет, в какой таблице живёт каждое поле.
   Неверное толкование = переделка схемы или нарушение DPP.
5. **Capability как данные.** Ошибочное значение молча меняет семантику записи; смена `write_scope_kind` требует
   перевыпуска ключей и склейки истории.
6. **Kaufland — первый канал и самый неизвестный:** модель unit, лимиты, подтверждение, источник конкурентов.
