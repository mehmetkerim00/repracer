# ADR-0006: Порт `ChannelAdapter`

- **Статус:** Accepted
- **Дата:** 2026-09-14
- **Реализация:** [packages/channel-port](../../packages/channel-port/) (только типы)
- **Связанные документы:** [ADR-0002](0002-write-scope-per-field.md), [ADR-0005](0005-message-broker.md), [channel-capabilities.md](../channel-capabilities.md), решения Р-12, Р-19, Р-22, Р-31, Р-32

## Контекст

Четыре канала различаются всем, что важно для записи:

| Различие | Канал | Где решено |
|---|---|---|
| Остаток — одно значение на SKU во всём регионе, цена — по маркетплейсу | Amazon EU | Р-1, ADR-0002 |
| Остаток связан между витринами через `id_offer`, цена — по витрине | Kaufland (документация 2.44.0) | OQ-72 |
| Запись только после необратимой миграции листинга с согласием | eBay | Р-2, миграция 0010 |
| 250 правок листинга в день, считаются все попытки | eBay | Р-19, `edit_budget` |
| Поле, запись которого включает собственный репрайсер канала | Kaufland `minimum_price` | Р-12 |
| Асинхронная обработка с последующим подтверждением | Amazon, возможно Otto | — |
| Пакеты: 150 unit одной витрины / 25 офферов / 1 SKU | Kaufland / eBay / Amazon | channel-capabilities |
| Уведомления без данных, с данными, без идентификатора продавца | Все | — |

Ядро уже держит инварианты в PostgreSQL: версии, пол цены, режимы, бюджеты, согласия. Порт не должен дублировать их
и не должен позволять адаптеру их обойти.

## Решение

### 1. Разделение ответственности

| Ядро | Адаптер |
|---|---|
| Выбирает, **что** писать: версии, пол, режим цены, порядок, повторы | Знает, **как** писать в канал: эндпоинты, пакеты, подпись, разбор ответов |
| Выводит единицы записи и бюджеты из описания канала | Описывает канал данными (`ChannelDescriptor` = строки `channel_capability`) |
| Списывает бюджет правок до отправки | Считает, сколько бюджета займёт вызов (`planDispatch`) |
| Решает, что делать с ошибкой | Классифицирует ошибку: `TRANSIENT` / `PERMANENT` / `REQUIRES_HUMAN` |
| Знает тенанта | Получает тенанта в каждом вызове и **проверяет** его по каталогу аккаунтов до обращения к каналу [Р-31] |

Адаптер без состояния синхронизации: всё, что должно пережить перезапуск, живёт в PostgreSQL.

### 2. Интерфейс

```ts
interface ChannelAdapter {
  readonly descriptor: ChannelDescriptor;                               // данные channel_capability
  planDispatch(ctx, writes: FieldWrite[]): Promise<DispatchPlan>;       // пакеты + расход бюджета, без I/O
  dispatch(ctx, batch: DispatchBatch): Promise<DispatchResult>;         // ACCEPTED | REJECTED | OUTCOME_UNKNOWN по записи
  readBack(ctx, requests: ReadBackRequest[]): Promise<ReadBackResult>;  // текущие значения в канале
  confirm(ctx, requests: ConfirmationRequest[]): Promise<ConfirmationResult[]>; // APPLIED | NOT_APPLIED | PENDING | UNKNOWN
  readCompetitors(ctx, queries: CompetitorQuery[]): Promise<CompetitorReadResult>;
  discoverOffers(ctx, page): Promise<Page<DiscoveredOffer>>;
  readOrderLines(ctx, window): Promise<Page<OrderLine>>;
  handleInbound(delivery: InboundDelivery): Promise<InboundResult>;    // подпись, разбор, проверка тенанта
}
// необязательные возможности, объявляются в descriptor.capabilities:
interface SupportsPushSubscriptions { ensureSubscriptions(ctx, desired) }
interface SupportsListingMigration  { preflight(ctx, listingIds); migrate(ctx, proofs: MigrationConsentProof[]) }
interface SupportsAsyncReports      { requestReport(ctx, type, marketplace?); pollReport(ctx, handle) }
```

`ctx = { tenantId, channelAccountId, correlationId, deadline, signal }` — в каждом вызове.

### 3. Как в порт укладываются известные различия

| Различие | Выражение в порте |
|---|---|
| Глобальный остаток Amazon EU | `FieldCapability.writeScope.keyTemplate = [channel_account, region, external_sku]` + `SideEffect SHARED_ACROSS_MARKETPLACES linkedBy REGION`. Ядро передаёт одну `WriteScopeRef` на все маркетплейсы; наблюдения приходят по идентичности и попадают в ту же единицу |
| Связь остатка Kaufland через `id_offer` | Тот же `SideEffect` с `linkedBy CHANNEL_OFFER_LINK`. Шаблон ключа сейчас по Р-14; смена — перевыпуск ключей (ADR-0002, OQ-72) |
| Витрины Kaufland | Атрибут `marketplace` в ключе и `batch.sameAcrossBatch = [marketplace]`: `planDispatch` не смешивает витрины в одном `units/bulk` |
| Необратимая миграция eBay | Отдельная возможность `SupportsListingMigration`. `migrate` принимает только `MigrationConsentProof` со статусом `MIGRATION_STARTED`, выданный после проверки БД. Запись в немигрированный листинг — `Precondition LISTING_MANAGED_BY_WRITE_API`, `planDispatch` отклоняет её с `PRECONDITION_FAILED` (`REQUIRES_HUMAN`) |
| 250 правок в день | `EditBudgetRule` (область, лимит, граница дня, учёт неуспешных попыток, общий ли на поля). `planDispatch` возвращает `BudgetCharge[]`, ядро списывает их до `dispatch`. Исчерпание — `EDIT_BUDGET_EXHAUSTED` (`TRANSIENT`, `retryAt` = начало следующего дня канала) |
| Smart Pricing Kaufland | Поле записи `CHANNEL_MIN_PRICE` существует только у Kaufland и только при `Precondition PRICING_MODE KAUFLAND_SMART_PRICING`; `SideEffect ACTIVATES_CHANNEL_REPRICER`; цена покупателя — `IdentifiedObservation.effectivePrice` |
| Синхронные и асинхронные записи | `FieldCapability.processing`; `WriteOutcome.appliedImmediately` и `submissionRef`; `confirm` превращает отправку в `APPLIED` / `NOT_APPLIED` |
| Неизвестный исход | `OUTCOME_UNKNOWN`: ядро делает `readBack` до повтора. Транспорт повторяет только идемпотентные запросы |
| Уведомления разной полноты | `InboundEvent`: `OBSERVATION` / `COMPETITOR_SNAPSHOT` / `ORDER_LINE` — с данными; `RESOURCE_CHANGED` — без данных, ядро планирует чтение |
| Уведомление без идентификатора продавца | `InboundDelivery.claimed` — тенант и аккаунт из токена в адресе вебхука, проверяются адаптером [Р-31] |
| Разная полнота данных о конкурентах | `CompetitorSnapshot.completeness`: `TOP_N` (buybox Kaufland, ANY_OFFER_CHANGED), `CHEAPEST_ONLY` (competitors-comparer), `FULL` |
| Разные лимиты запросов | `RateLimitRule.owner`: продавец (Kaufland), приложение — общее для тенантов (eBay), продавец × приложение × операция (Amazon) |

### 4. Классификация ошибок

| Класс | Реакция ядра | Примеры |
|---|---|---|
| `TRANSIENT` | Повтор той же версии не раньше `retryAt` | 429, 503, тайм-аут, исчерпан бюджет правок |
| `PERMANENT` | Запись `FAILED` / `DISCARDED_STALE`, без повтора | Ошибка валидации, unit не найден, повтор действия |
| `REQUIRES_HUMAN` | Единица записи `BLOCKED` (INV-14), кейс, алерт | Ключи недействительны, аккаунт неактивен, листинг не мигрирован, оффер не в продаже по причине канала, несовпадение тенанта |

Класс по умолчанию задан таблицей `DEFAULT_ERROR_CLASS`. Адаптер может сделать класс строже, но не мягче.
`scope` (`ITEM` / `BATCH` / `ACCOUNT`) показывает, остановить ли одну запись, пакет или весь аккаунт.

### 5. Чего порт сознательно не делает

- Не выбирает тенанта и не читает PostgreSQL или ClickHouse [Р-22, Р-31].
- Не вычисляет пол цены и комиссии; комиссии — тарифные таблицы [Р-32].
- Не хранит водяные знаки версий и не решает, повторять ли запись.
- Не читает и не возвращает PII покупателей: `OrderLine` — белый список полей [Р-4].

## Какие различия каналов порт **не** покрывает

| Различие | Почему не покрыто | Где решается |
|---|---|---|
| **Изменения в канале без нашего участия** (продавец в кабинете, Smart Pricing, другой инструмент) | Порт отдаёт наблюдения; «чьё» это изменение, решает ядро сравнением с отправленным (`DivergencePolicy`) | Ядро, INV-14 |
| **Собственное уменьшение остатка каналом при заказе** (Amazon, возможно Kaufland — K-11) | Гонка между заказом и нашей записью last write wins не выражается интерфейсом записи; порт даёт только `ORDER_LINE` и наблюдение | Ядро: буфер канала, порядок обработки заказов |
| **Жизненный цикл авторизации** (OAuth-согласие Amazon/eBay, регистрация технологического партнёра Kaufland, токены Otto) | Это пользовательские потоки подключения, а не операции над офферами | Сервис подключения аккаунтов (отдельный контракт) |
| **Создание листингов и данных товара** | Вне скоупа продукта | — |
| **Отчёты и фиды как основной путь записи** (фиды Amazon, файлы инвентаря Kaufland) | `SupportsAsyncReports` покрывает чтение отчётов; запись файлами с полным замещением инвентаря витрины (inventory feed Kaufland) опасна и не входит в порт | Отдельное решение, если понадобится |
| **Квоты уровня приложения, общие для тенантов** (eBay) | Порт описывает квоту, но распределение между тенантами — задача лимитера ядра | Dispatcher (ADR-0001 п. 6) |
| **Точная граница «дня» бюджета**, когда канал её не документирует | `dayBoundaryTimeZone: null` — ядро выбирает консервативную границу | OQ-47 |
| **Возвраты, отмены, отгрузки как операции записи** | Порт только читает строки заказов для резерваций; операции выполнения заказов вне скоупа | — |
| **Подписи и форматы, которые документация описывает противоречиво** (Kaufland K-01, K-02) | Порт требует от адаптера проверить подпись, но не может задать алгоритм | Адаптер + поддержка канала |

## Рассмотренные альтернативы

| Вариант | Почему отклонён |
|---|---|
| Порт на уровне оффера (`setPrice(offer)`, `setQuantity(offer)`) | Повторяет ошибку, от которой защищает ADR-0002: остаток Amazon EU и связанные unit Kaufland — не одна запись на оффер |
| Отдельные интерфейсы на канал без общего порта | Ядро пришлось бы писать четыре раза; инварианты разошлись бы |
| Адаптер со своим состоянием и повторами | Второе место правды о версиях и бюджетах; расхождение с PostgreSQL при перезапуске |
| Универсальный метод «выполнить операцию канала» | Нет типовой гарантии: миграция eBay без доказательства согласия, `minimum_price` вне режима Smart Pricing |

## Последствия

- Первая реализация — адаптер Kaufland (шаг 6) поверх `@repracer/kaufland-client`.
- Любое новое различие канала сначала выражается данными `ChannelDescriptor` (новый `SideEffect`, `Precondition`), и только если не
  получается — меняется интерфейс с новой версией этого ADR.
- Контрактные тесты порта (одинаковые для всех адаптеров) — шаг 6.
