# repracer

Мультитенантный SaaS для синхронизации остатков и репрайсинга на маркетплейсах
**Kaufland, Amazon (SP-API), eBay**; Otto Market и Walmart — после первых клиентов. Цель — Release 1.0: три канала [Р-11, Р-56]; Amazon и eBay — ЕС и США, Kaufland — Германия и Австрия [Р-26]; EUR и USD, НДС и sales tax [Р-57, Р-58].

> Статус: **шаг 13 — размер слепка, аудит остановок, рабочий вход** [Р-74…Р-77]: слепок объяснения только у решений с изменением цены и отказов Gate, повторяющиеся части — в справочниках; остановки — в журнале аудита; вход по email и паролю с ролями из членств. Шаг 12 — объяснимость на рабочих данных, остановки и роли [Р-68…Р-73]: решение хранит слепок объяснения без данных канала, и экран «почему эта цена» на PostgreSQL показывает все пять шагов; kill switch человеком останавливает все цены, системная остановка — только цены по конкурентам; остановка тенанта — объект; права владельца и оператора проверяет БД; тексты — словарь DE/EN. Шаг 11 — консоль продавца на данных стенда ([apps/console](apps/console/)). Шаг 10 — диспетчер записей, валюты и регионы; брокер и ClickHouse написаны, но на стенде не прогонялись (Docker не скачивает образы). Шаг 9 — оценка цены за 2–3 транзакции, EUR и USD, НДС и sales tax. Всё — на стенде, без сети. Реальный канал не подключался: нет регистрации технологического партнёра (OQ-75).

## Структура

| Путь | Назначение |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Постоянный контекст проекта: что строим, ограничения, правила работы |
| [docs/decisions.md](docs/decisions.md) | Принятые решения владельца продукта (Р-1…Р-77) |
| [docs/domain-model.md](docs/domain-model.md) | Доменная модель: сущности, связи, инварианты |
| [docs/data-retention.md](docs/data-retention.md) | Классы хранения, сроки, механизмы удаления, закрытие тенанта |
| [migrations/](migrations/) | DDL-миграции PostgreSQL (горячий слой): схема, RLS, инварианты, хранение |
| [schemas/clickhouse/](schemas/clickhouse/) | DDL аналитического слоя ClickHouse: таблицы с TTL, роли, политики строк |
| [docs/tenant-isolation-analytics.md](docs/tenant-isolation-analytics.md) | Изоляция тенантов в ClickHouse, архиве и брокере |
| [docs/channel-capabilities.md](docs/channel-capabilities.md) | Матрица возможностей каналов по полям + план проверки |
| [docs/onboarding-ebay-migration.md](docs/onboarding-ebay-migration.md) | Предполётная проверка и согласие на миграцию листингов eBay |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/open-questions.md](docs/open-questions.md) | Открытые вопросы |
| [vendor/kaufland/](vendor/kaufland/) | Снимки спецификации Kaufland Seller API с датой и SHA-256 |
| [services/](services/) | Развёртываемые сервисы: [pricing-worker](services/pricing-worker/) — путь решения за брокером |
| [packages/channel-port](packages/channel-port/) | Порт `ChannelAdapter` — контракт всех адаптеров каналов (TypeScript, только типы) |
| [packages/kaufland-client](packages/kaufland-client/) | Клиент Kaufland: сгенерированные типы + подпись и повторы |
| [packages/kaufland-adapter](packages/kaufland-adapter/) | Адаптер Kaufland: пакеты, 207, подтверждение, конкуренты, вебхуки; консервативные правила KFL_C01…C18 |
| [packages/pricing-model](packages/pricing-model/) | Общие типы пути решения, расчёт маржи, реестр причин с объяснениями |
| [packages/input-sanity](packages/input-sanity/) | Проверка правдоподобия снимков конкурентов до стратегии [Р-42] |
| [packages/strategy-engine](packages/strategy-engine/) | Стратегии цены с объявленной полнотой данных [Р-39] |
| [packages/price-gate](packages/price-gate/) | Price Gate: обе границы, пол маржи, шаг и частота [Р-43, Р-44] |
| [packages/pricing-pipeline](packages/pricing-pipeline/) | Сквозной путь решения, ярусы опроса [Р-47], догон после потери подписки [Р-48] |
| [packages/pricing-store-pg](packages/pricing-store-pg/) | `PricingStore` на PostgreSQL: транзакция решения с закреплённой версией границ [Р-54], тесты БД, нагрузочный замер |
| [packages/write-dispatcher](packages/write-dispatcher/) | Диспетчер записей [Р-64]: отправка из очереди по единице записи, вытеснение с причиной, повтор и сверка неизвестного итога |
| [packages/broker](packages/broker/) | Брокер (Redpanda): идемпотентный продюсер, последовательный по партиции потребитель, ретранслятор outbox [Р-24, Р-34] |
| [packages/fx-rates](packages/fx-rates/) | Дневные курсы ЕЦБ: строгий разбор, загрузка в неизменяемый справочник [Р-61] |
| [packages/analytics-export](packages/analytics-export/) | Выгрузка дневных секций PostgreSQL в ClickHouse, замер сжатия |
| [apps/console](apps/console/) | Консоль продавца на данных стенда [Р-67]: React + Vite, сервер стенда на 127.0.0.1 |
| [packages/console-model](packages/console-model/) | Модели экранов: статусы товаров, путь решения из слепка объяснения, опасные и скорректированные изменения, действующий пол до цента, остановки и права; словарь DE/EN [Р-72] |
| [tests/contract](tests/contract/) | Стенд контрактных тестов record/replay: сценарии в файлах, без сети; основа симулятора |
| [infra/](infra/) | Инфраструктура как код; [infra/local](infra/local/) — локальные Redpanda и ClickHouse для тестов шага 10 |

## ADR

| № | Решение | Статус |
|---|---|---|
| [0001](docs/adr/0001-event-driven-architecture.md) | Событийная архитектура ядра | Proposed |
| [0002](docs/adr/0002-write-scope-per-field.md) | Единица записи определяется для каждого поля (WriteScope) | Accepted |
| [0003](docs/adr/0003-tenant-isolation.md) | Изоляция тенантов: общая схема + RLS | Accepted |
| [0004](docs/adr/0004-storage-tiering.md) | Трёхслойное хранение: PostgreSQL / ClickHouse / архив | Accepted |
| [0005](docs/adr/0005-message-broker.md) | Брокер Kafka-совместимый, ключ `write_scope_id` | Accepted |
| [0006](docs/adr/0006-channel-port.md) | Порт `ChannelAdapter` | Accepted |
| [0007](docs/adr/0007-competitor-data-completeness.md) | Полнота конкурентных данных по каналам и каталог стратегий | Accepted |
| [0008](docs/adr/0008-price-decision-path.md) | Путь решения о цене: проверка входов, движок стратегий, Price Gate | Accepted |
| [0009](docs/adr/0009-write-dispatcher-and-broker.md) | Диспетчер записей и путь решения за брокером | Accepted |
| [0010](docs/adr/0010-seller-console-on-stand.md) | Консоль продавца на данных стенда | Accepted, уточнено 0011 |
| [0011](docs/adr/0011-explanation-stops-roles.md) | Объяснимость на данных PostgreSQL, остановки и роли | Accepted, уточнено 0012 |
| [0012](docs/adr/0012-explanation-dictionary-audit-identity.md) | Справочник слепка, аудит остановок, рабочий вход | Accepted |

## Ключевые принципы

1. Ни один запрос не пересекает границу тенанта — это обеспечивает сама БД (RLS, составные FK).
2. Обе границы цены (`min_price`, `max_price`) обязательны и проверяются вне движка стратегий — в Gate и в БД при решении и при отправке; входные данные проверяются на правдоподобие до стратегии.
3. Каждая запись в канал идемпотентна и версионирована по единице записи конкретного поля (`WriteScope`).
4. Наши цены хранятся бессрочно по каждому каналу; прочитанное из каналов — с ограниченным сроком.
5. «Отправили» и «видим в канале» — разные состояния; расхождения обрабатываются политикой.
6. Необратимые действия (миграция eBay) — только с явным информированным согласием.

## Разработка

```sh
npm install              # Node ≥ 22; только dev-зависимости
npm run typecheck        # проверка типов всех пакетов
npm test                 # тесты пакетов и стенда (tests/contract), без сети; тесты БД — с REPRACER_PG_URL
npm run stand -w @repracer/console   # сервер стенда для интерфейса: http://127.0.0.1:4318
npm run dev -w @repracer/console     # интерфейс: http://127.0.0.1:5173
```
