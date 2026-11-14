#!/usr/bin/env bash
# Шаг 124 [Р-248]: миграции к ЖИВОЙ базе — только новые. `scripts/db/prepare.sh` базу пересоздаёт (тесты, QA); живой базе пилота это стёрло бы
# подключённый аккаунт продавца и неделю тени. Журнал — настройка уровня базы `repracer.migrations = '<номер>:<сумма>'`: номер последней
# применённой миграции и SHA-256 списка «файл сумма» всех применённых по порядку. Настройку видит только владелец базы (как `repracer.region`).
#   PGHOST=… PGPORT=… PGUSER=<суперпользователь> scripts/db/migrate.sh <база> [--create <регион> | --check]
# --create — новая база: создаётся с регионом [Р-60], применяются все миграции. Без него база обязана существовать и нести журнал.
# --check (шаг 131) — только план: строка «MIGRATIONS PLAN: <база> at <номер>; pending <K>[: <первая>…<последняя>]», ничего не применяется. Его спрашивает
#   deploy/pilot/deploy.sh ДО переключения рабочей копии — у каталога миграций выкладываемой версии (REPRACER_MIGRATIONS_DIR).
# Изменённая после применения миграция — отказ (код 1): «миграция из main не правится задним числом», и накатывать дальше её поверх неизвестно чего нельзя.
# База новее кода (журнал называет миграцию, которой у этого кода нет) — отказ своей причиной (код 3): это откат через миграцию, а не правка
#   задним числом; путь — восстановление копии, снятой перед миграциями (deploy/pilot/README.md, «Откат»).
# REPRACER_MIGRATIONS_DIR — другой каталог миграций (только тест журнала).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
DIR="${REPRACER_MIGRATIONS_DIR:-${here}/../../migrations}"
DB="${1:-}"
[[ "${DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "usage: scripts/db/migrate.sh <database> [--create <region>]" >&2; exit 2; }
shift
CREATE=""
CHECK=0
if [ "${1:-}" = --create ]; then
  CREATE="${2:-}"
  [[ "${CREATE}" =~ ^[A-Z]{2}$ ]] || { echo "--create needs the region of the database, e.g. US or EU [Р-60]" >&2; exit 2; }
  shift 2
elif [ "${1:-}" = --check ]; then
  CHECK=1
  shift
fi
[ $# -eq 0 ] || { echo "unknown arguments: $*" >&2; exit 2; }
PSQL=(psql -v ON_ERROR_STOP=1 -q -X)

sha() { if command -v sha256sum > /dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
# Миграции по порядку номера; README и прочее — не миграции
files=()
while IFS= read -r f; do files+=("$f"); done < <(find "${DIR}" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)
[ ${#files[@]} -gt 0 ] || { echo "no migrations in ${DIR}" >&2; exit 2; }
num() { basename "$1" | cut -c1-4; }
# Сумма применённых по номер включительно: «имя сумма» каждого файла — путь каталога в сумму не входит
digest_through() {
  local last="$1" f
  for f in "${files[@]}"; do
    [ "$(num "$f")" \> "${last}" ] && break
    printf '%s %s\n' "$(basename "$f")" "$(sha "$f" | cut -d' ' -f1)"
  done | sha | cut -d' ' -f1
}

exists="$("${PSQL[@]}" -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '${DB}'")"
if [ -n "${CREATE}" ]; then
  [ "${exists}" = 0 ] || { echo "database ${DB} already exists: --create makes a new one, it does not recreate (Р-248)" >&2; exit 1; }
  "${PSQL[@]}" -d postgres -c "CREATE DATABASE ${DB}" -c "ALTER DATABASE ${DB} SET repracer.region = '${CREATE}'"
  journal=""
else
  [ "${exists}" = 1 ] || { echo "database ${DB} does not exist — a new one: --create <region>" >&2; exit 1; }
  journal="$("${PSQL[@]}" -d postgres -Atc "SELECT substr(c, length('repracer.migrations=') + 1) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
    WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '${DB}') AND starts_with(c, 'repracer.migrations=')")"
  [ -n "${journal}" ] || { echo "database ${DB} has no migration journal (repracer.migrations): what was applied there is unknown — not migrating (Р-248)" >&2; exit 1; }
fi

last="0000"
if [ -n "${journal}" ]; then
  last="${journal%%:*}"
  [[ "${last}" =~ ^[0-9]{4}$ && "${journal#*:}" =~ ^[0-9a-f]{64}$ ]] || { echo "the migration journal of ${DB} is malformed" >&2; exit 1; }
  # Шаг 131: база новее кода — раньше сверки сумм, иначе откат через миграцию читался как «миграцию правили задним числом»
  newest="$(num "${files[${#files[@]}-1]}")"
  [ ! "${last}" \> "${newest}" ] \
    || { echo "database ${DB} is at migration ${last}, this code knows migrations only through ${newest}: the database is newer than the code — going back past migrations is a restore of the copy taken before them (deploy/pilot/README.md, «Откат»), not a deploy (Р-248)" >&2; exit 3; }
  [ "$(digest_through "${last}")" = "${journal#*:}" ] \
    || { echo "applied migrations changed since they were applied (through ${last}): a migration in main is never edited — not migrating (Р-248)" >&2; exit 1; }
fi

if [ "${CHECK}" = 1 ]; then
  pending=()
  for f in "${files[@]}"; do [ "$(num "$f")" \> "${last}" ] && pending+=("$(num "$f")"); done
  list=""
  [ ${#pending[@]} -eq 0 ] || list=": ${pending[0]}"
  [ ${#pending[@]} -le 1 ] || list="${list}…${pending[${#pending[@]}-1]}"
  echo "MIGRATIONS PLAN: ${DB} at ${last}; pending ${#pending[@]}${list}"
  exit 0
fi

applied=0
for f in "${files[@]}"; do
  n="$(num "$f")"
  [ "${n}" \> "${last}" ] || continue
  echo "== $(basename "$f")"
  "${PSQL[@]}" -d "${DB}" -o /dev/null -f "$f"
  # Журнал — после КАЖДОЙ миграции: упавшая откатывает себя (BEGIN…COMMIT в файле) и журнал не сдвигает; следующий запуск начнёт с неё
  "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.migrations = '${n}:$(digest_through "${n}")'"
  last="${n}"
  applied=$((applied + 1))
done
echo "migrations of ${DB}: applied ${applied}, last ${last}"
