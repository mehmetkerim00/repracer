#!/usr/bin/env bash
# Шаг 121 (QA-A): сброс тестовых данных одной командой — база QA пересоздаётся тем же путём, что у подготовки демо
# (scripts/demo-prepare.sh → scripts/db/prepare.sh: миграции, роли, смоук-проверки схемы), потом демо заново сеет стенд при подъёме.
#
# Страховка: сброс ПЕРЕСОЗДАЁТ базу, поэтому он отказывается работать с базой, которая не закрыта стражем P0-09
# (`ALTER DATABASE … SET repracer.live_writes = 'forbidden'`, шаг 119, deploy/production/README.md §4б). Боевая база этим стражем не
# закрыта никогда — значит, на ней сброс физически не запускается. Новой базы ещё нет — её создаёт только явный `--first-time`, и он
# отказывает базе, которая уже есть. Пересозданная база теряет настройки уровня базы: страж ставится снова и проверяется ДО того, как к
# базе подключится стенд.
#
# Использование (суперпользователь кластера; на сервере QA — внутри контейнера базы, deploy/qa/reset.sh):
#   PGHOST=… PGPORT=… PGUSER=<суперпользователь> scripts/qa-reset.sh <база> [--first-time]
# Переменные: QA_RESET_CHECK_ONLY=1 — только проверка (предполётная, база не трогается); REPRACER_MARKET_PROFILE — профиль показа (us по
# умолчанию: регион базы US [Р-60]); QA_RESET_PREPARE — команда подготовки (по умолчанию scripts/db/prepare.sh; тест подменяет её быстрой).
# Данные синтетические.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${1:-}"
FIRST=no
[ "${2:-}" = "--first-time" ] && FIRST=yes
if [ -z "${DB}" ] || [ $# -gt 2 ] || { [ $# -eq 2 ] && [ "${FIRST}" = no ]; }; then
  echo "использование: scripts/qa-reset.sh <база> [--first-time]" >&2; exit 2
fi
# Имя базы — простой идентификатор: оно подставляется в SQL
[[ "${DB}" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { echo "имя базы — строчные латинские буквы, цифры и _: ${DB}" >&2; exit 2; }
MARKET="${REPRACER_MARKET_PROFILE:-us}"
case "${MARKET}" in us|eu|global) ;; *) echo "REPRACER_MARKET_PROFILE должен быть us, eu или global, а не ${MARKET}" >&2; exit 2 ;; esac
PREPARE="${QA_RESET_PREPARE:-scripts/db/prepare.sh}"
PSQL=(psql -v ON_ERROR_STOP=1 -qAt)

exists=$("${PSQL[@]}" -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '${DB}'")
if [ "${exists}" = 1 ]; then
  if [ "${FIRST}" = yes ]; then
    echo "отказ: база ${DB} already exists — --first-time создаёт только новую базу; для сброса существующей запустите без него" >&2; exit 3
  fi
  # Страж читается из каталога базы функцией самой базы (0224): `SET` в сессии его не подделает. Функции нет — это не база QA
  guarded=$("${PSQL[@]}" -d "${DB}" -c "SELECT CASE WHEN to_regprocedure('security.live_writes_forbidden()') IS NULL THEN 'no-guard' WHEN security.live_writes_forbidden() THEN 'guarded' ELSE 'open' END" 2> /dev/null || echo unreadable)
  if [ "${guarded}" != guarded ]; then
    echo "отказ: база ${DB} is not guarded by P0-09 (${guarded}) — сброс пересоздаёт базу и запускается только на базе QA, закрытой стражем:" >&2
    echo "  ALTER DATABASE ${DB} SET repracer.live_writes = 'forbidden'   (deploy/production/README.md §4б; на боевой базе — никогда)" >&2
    exit 3
  fi
  echo "база ${DB} guarded (repracer.live_writes): сброс разрешён"
else
  if [ "${FIRST}" = no ]; then
    echo "отказ: базы ${DB} нет — новую базу QA создаёт только явный --first-time" >&2; exit 3
  fi
  echo "базы ${DB} нет: --first-time создаст её и сразу закроет стражем"
fi
if [ "${QA_RESET_CHECK_ONLY:-0}" = 1 ]; then exit 0; fi

echo "== база ${DB}: миграции, роли и смоук-проверки схемы (обычно меньше минуты)"
REPRACER_PG_TEMPLATE="${DB}_template" "${PREPARE}" "${DB}"
# Демо профиля us — американский продавец: тенант заводится в базе региона US [Р-60]
if [ "${MARKET}" = us ]; then "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.region = 'US'"; fi
"${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.live_writes = 'forbidden'"
# Проверка — новой сессией, той же функцией базы: страж стоит до первого подключения стенда
[ "$("${PSQL[@]}" -d "${DB}" -c 'SELECT security.live_writes_forbidden()')" = t ] || { echo "страж не встал на ${DB} — стенд не запускать" >&2; exit 4; }
echo "база ${DB} пересоздана и закрыта стражем P0-09 (repracer.live_writes = forbidden)"
