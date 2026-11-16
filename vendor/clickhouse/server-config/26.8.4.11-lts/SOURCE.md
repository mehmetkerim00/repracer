# ClickHouse 26.8.4.11-lts — память сервера в контейнере (шаг 141, QA-B и пилот)

Образ ClickHouse пилота и QA-B закреплён версией 26.8.4.11 (`deploy/pilot/compose.yaml`, как CI и `infra/local/compose.yaml`). Потолок памяти
задаётся ограничением контейнера (`mem_limit`), а не настройкой сервера. На что это опирается — конфигурация по умолчанию того же выпуска,
тег `v26.8.4.11-lts`. Файл не копируется: адрес, дата загрузки, SHA-256 и дословные строки. Загружено 2026-11-16 (`curl -L`, ответ 200).

| Файл | Что взято | SHA-256 |
|---|---|---|
| https://raw.githubusercontent.com/ClickHouse/ClickHouse/v26.8.4.11-lts/programs/server/config.xml | см. ниже | `b44de4e65a74303c4b73e51c1a311f93fc642176c2129f5e340107b1807871c9` |

`max_server_memory_usage_to_ram_ratio` (по умолчанию `0.9`):

> The maximum amount of memory the server is allowed to use, as a ratio to the available memory. Besides capping the hard memory limit at
> startup, the background memory worker periodically recomputes the limit at runtime as (resident memory + system available memory) * this
> ratio, so the server leaves room for other processes on the same host. In a cgroup with a finite memory limit, the cgroup's available memory
> is used instead of the host-wide value.

`max_server_memory_usage` (по умолчанию `0`):

> Zero value or unset means default. Default is "max_server_memory_usage_to_ram_ratio" of available physical RAM. […] It is not practical to
> set this constraint to small values like just a few gigabytes, because memory allocator will keep this amount of memory in caches and the
> server will deny service of queries.

Что из этого следует для `deploy/pilot`:
- `mem_limit` контейнера (cgroup) — потолок, который ClickHouse видит сам: сервер берёт не больше 0,9 от памяти контейнера, а не машины.
  Отдельная настройка `max_server_memory_usage` не нужна.
- Выше потолка контейнера процесс завершает ядро (OOM): сервер с этим потолком отказывает запросам раньше, чем до него дойдёт.
- Предупреждение о «нескольких гигабайтах» касается настройки сервера. Потолок контейнера по умолчанию — 2 GiB: выгрузка пилота — сутки
  одного продавца, а не аналитика. Хватает ли его, покажет первая неделя QA-B (`docker stats`), значение — `REPRACER_CLICKHOUSE_MEM_LIMIT`.
