-- Шаг 55 (п. 3): смоук-мир живёт в фиксированной дате 2026-09-14…15 — секции суточных таблиц под неё создаются ЗДЕСЬ, в базе смоук-тестов,
-- а не в шаблоне изолированных баз: шаблон с фиксированными датами стареет, и удаление по сроку сносит его секции принудительно.
-- Один файл на оба пути, которые поднимают смоук-мир: scripts/db/prepare.sh и scripts/db/mutation-check.mjs
\set ON_ERROR_STOP 1
SELECT maintenance.ensure_partitions('2026-09-15 12:00+00'::timestamptz) IS NOT NULL AS smoke_partitions \gset

/**
 * Шаг 56 (п. 6): смоук-мир не пересекает полночь витрины. Бюджет правок исчерпывается «сегодня» одним файлом (smoke_app.sql) и
 * проверяется другими (smoke_r65.sql, smoke_stock.sql), а страж базы сверяет день бюджета с ТЕКУЩИМИ сутками витрины по её часам —
 * заморозить часы базы нельзя, и параметр дня тут не поможет: запись со вчерашним днём отклонит сам страж. Поэтому последовательность
 * не начинается за 15 минут до полуночи Europe/Berlin — ждёт минуту после неё. Последовательность идёт ~3 минуты: исход не зависит от
 * того, когда её запустили (prepare.sh и каждый прогон мутации идут через этот файл первым)
 */
SELECT CASE WHEN (date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') + interval '1 day') - (now() AT TIME ZONE 'Europe/Berlin') < interval '15 minutes'
            THEN pg_sleep(extract(epoch FROM (date_trunc('day', now() AT TIME ZONE 'Europe/Berlin') + interval '1 day' + interval '1 minute')
                                            - (now() AT TIME ZONE 'Europe/Berlin'))) END IS NULL AS smoke_day_guard \gset
