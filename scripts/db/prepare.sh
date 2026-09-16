#!/usr/bin/env bash
# Чистая база для тестов [Р-84]: миграции, роли и строки стенда, шаблон для изолированных баз, смоук-тесты схемы (tests/db).
# Использование: PGHOST=… PGPORT=… PGUSER=<суперпользователь> scripts/db/prepare.sh [имя_базы]
# Данные синтетические. Скрипт не запускать на базе с данными: база пересоздаётся.
set -euo pipefail
cd "$(dirname "$0")/../.."
DB="${1:-repracer_eu}"
TEMPLATE="${REPRACER_PG_TEMPLATE:-repracer_template}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)" -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" -c "CREATE DATABASE ${DB}"
"${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.region = 'EU'"
for f in migrations/[0-9]*.sql; do
  echo "== $(basename "$f")"
  "${PSQL[@]}" -d "$DB" -o /dev/null -f "$f"
done
"${PSQL[@]}" -d "$DB" -f packages/pricing-store-pg/test/setup.sql
# Шаблон — копия базы сразу после миграций, без данных смоук-тестов (изолированные базы тестов, test/isolated-db.ts)
"${PSQL[@]}" -d postgres -c "CREATE DATABASE ${TEMPLATE} TEMPLATE ${DB}"

echo "== smoke"
"${PSQL[@]}" -d "$DB" -f tests/db/smoke_setup.sql
# Р-90, Р-96: тенанты — ролью создания тенанта; конфигурация, остановки, роли и снятия — административным сервисом
PGUSER=svc_provisioning "${PSQL[@]}" -d "$DB" -f tests/db/smoke_provision.sql
PGUSER=svc_admin "${PSQL[@]}" -d "$DB" -f tests/db/smoke_app.sql
PGUSER=svc_admin "${PSQL[@]}" -d "$DB" -f tests/db/smoke_admin.sql
# Р-96: путь решения может только вычислить и записать цену — остальное отклоняется отсутствием права
PGUSER=svc_app "${PSQL[@]}" -d "$DB" -f tests/db/smoke_path.sql
"${PSQL[@]}" -d "$DB" -f tests/db/smoke_r65.sql
# Р-103: у каждой append-only таблицы есть строка, изменение отклоняет триггер неизменяемости (откатываемая транзакция)
"${PSQL[@]}" -d "$DB" -f tests/db/smoke_append_only.sql
# Р-102: роль синхронизации остатка — только остатки и резервации
PGUSER=svc_stock "${PSQL[@]}" -d "$DB" -f tests/db/smoke_stock.sql
PGUSER=svc_scheduler "${PSQL[@]}" -d "$DB" -f tests/db/smoke_retention.sql
PGUSER=svc_scheduler "${PSQL[@]}" -d "$DB" -Atc "SELECT maintenance.ensure_partitions(now())" > /dev/null
echo "database ${DB} ready"
