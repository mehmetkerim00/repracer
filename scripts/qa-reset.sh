#!/usr/bin/env bash
# Шаг 121 (QA-A): сброс тестовых данных одной командой — база QA пересоздаётся тем же путём, что у подготовки демо
# (scripts/demo-prepare.sh → scripts/db/prepare.sh: миграции, роли, смоук-проверки схемы), потом демо заново сеет стенд при подъёме.
#
# Страховка: сброс ПЕРЕСОЗДАЁТ базу, поэтому он отказывается работать с базой, которая не закрыта стражем P0-09
# (`ALTER DATABASE … SET repracer.live_writes = 'forbidden'`, шаг 119, deploy/production/README.md §4б). Боевая база этим стражем не
# закрыта никогда — значит, на ней сброс физически не запускается. Новой базы ещё нет — её создаёт только явный `--first-time`, и он
# отказывает базе, которая уже есть.
#
# Шаг 121.3: база QA не бывает без стража ни в какой момент сброса. Новая база собирается под именем `<база>_next`, страж ставится на
# неё до замены, и только потом прежняя база удаляется, а готовая получает её имя (настройки уровня базы переименование сохраняет).
# Сброс, убитый посреди сборки (обрыв SSH, kill -9, перезагрузка), оставляет прежнюю базу целой и закрытой; убитый между удалением и
# переименованием — повтор доводит замену, а не отказывает.
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
# Имя базы — простой идентификатор: оно подставляется в SQL; запас в 5 знаков — под имя сборки `<база>_next`
[[ "${DB}" =~ ^[a-z_][a-z0-9_]{0,57}$ ]] || { echo "имя базы — строчные латинские буквы, цифры и _, до 58 знаков: ${DB}" >&2; exit 2; }
NEXT="${DB}_next"
MARKET="${REPRACER_MARKET_PROFILE:-us}"
case "${MARKET}" in us|eu|global) ;; *) echo "REPRACER_MARKET_PROFILE должен быть us, eu или global, а не ${MARKET}" >&2; exit 2 ;; esac
PREPARE="${QA_RESET_PREPARE:-scripts/db/prepare.sh}"
PSQL=(psql -v ON_ERROR_STOP=1 -qAt)

exists() { [ "$("${PSQL[@]}" -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$1'")" = 1 ]; }
# Страж читается из каталога базы функцией самой базы (0224): `SET` в сессии его не подделает. Функции нет — это не база QA
guard_of() {
  "${PSQL[@]}" -d "$1" -c "SELECT CASE WHEN to_regprocedure('security.live_writes_forbidden()') IS NULL THEN 'no-guard' WHEN security.live_writes_forbidden() THEN 'guarded' ELSE 'open' END" 2> /dev/null || echo unreadable
}
# Замена: прежняя база удаляется, только когда готовая закрыта стражем; проверка — новой сессией, той же функцией базы
swap() {
  "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)"
  "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${NEXT} RENAME TO ${DB}"
  [ "$("${PSQL[@]}" -d "${DB}" -c 'SELECT security.live_writes_forbidden()')" = t ] || { echo "страж не встал на ${DB} — стенд не запускать" >&2; exit 4; }
}

# Шаг 121.3: прежний сброс оборвался между удалением базы и переименованием готовой — замена доводится
if ! exists "${DB}" && exists "${NEXT}" && [ "$(guard_of "${NEXT}")" = guarded ]; then
  echo "база ${DB}: прежний сброс оборвался посреди замены — готовая ${NEXT} закрыта стражем, замена доводится"
  if [ "${QA_RESET_CHECK_ONLY:-0}" = 1 ]; then exit 0; fi
  swap
  echo "база ${DB} на месте и закрыта стражем P0-09 (замена доведена)"
  exit 0
fi

if exists "${DB}"; then
  if [ "${FIRST}" = yes ]; then
    echo "отказ: база ${DB} already exists — --first-time создаёт только новую базу; для сброса существующей запустите без него" >&2; exit 3
  fi
  guarded="$(guard_of "${DB}")"
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

echo "== сборка ${NEXT}: миграции, роли и смоук-проверки схемы (обычно меньше минуты); ${DB} пока не тронута"
REPRACER_PG_TEMPLATE="${NEXT}_template" "${PREPARE}" "${NEXT}"
# Демо профиля us — американский продавец: тенант заводится в базе региона US [Р-60]
if [ "${MARKET}" = us ]; then "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${NEXT} SET repracer.region = 'US'"; fi
"${PSQL[@]}" -d postgres -c "ALTER DATABASE ${NEXT} SET repracer.live_writes = 'forbidden'"
[ "$(guard_of "${NEXT}")" = guarded ] || { echo "страж не встал на ${NEXT} — замена не делается, ${DB} не тронута" >&2; exit 4; }
echo "== замена: ${NEXT} закрыта стражем — становится ${DB}"
swap
# Шаблоны подготовки на QA не нужны: стенд их не читает
"${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS ${NEXT}_template" -c "DROP DATABASE IF EXISTS ${DB}_template"
echo "база ${DB} пересоздана и закрыта стражем P0-09 (repracer.live_writes = forbidden)"
