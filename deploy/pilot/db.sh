#!/usr/bin/env bash
# Шаг 124 [Р-247, Р-248]: база пилота. В отличие от QA (база заново при каждой выкладке) база пилота ЖИВАЯ: в ней подключённый аккаунт продавца, его каталог
# и неделя тени — выкладка применяет только новые миграции (scripts/db/migrate.sh, журнал в настройке базы).
#   первая сборка:  deploy/pilot/db.sh --first-time   — база с регионом, все миграции, роли входа и строки возможностей каналов, пароли ролей, СТРАЖ
#   выкладка:       deploy/pilot/db.sh                — новые миграции, роли и пароли (идемпотентно), проверка стража
# Обычно запускается внутри контейнера базы: deploy/pilot/compose.sh exec -T postgres bash /repo/deploy/pilot/db.sh [--first-time].
# Переменные: REPRACER_PILOT_DB (база), REPRACER_PILOT_REGION (регион базы [Р-60]), REPRACER_PILOT_SECRETS (каталог с pg_role_passwords), PG* — подключение
# суперпользователем. Пароли не печатаются: каждая роль проверяется до смены пароля, ошибки — кратко, без текста запроса.
#
#   сброс QA-B:     deploy/pilot/db.sh --reset-qa-b   — только при REPRACER_PILOT_STAND=qa-b и отметке qa-b у базы (шаг 132): новая база под `<база>_next`
#                   первой сборкой (со стражем), затем замена прежней; повтор после обрыва между удалением и переименованием доводит замену
# Шаг 132: первая сборка отмечает базу стендом — настройка базы `repracer.stand` (pilot | qa-b, REPRACER_PILOT_STAND). Страж боевых записей стоит на базах
# обоих стендов, поэтому сброс отличает QA-B от пилота только этой отметкой: базу с отметкой pilot (или без неё) сброс не трогает.
#
# Страж боевых записей [Р-247]: ставится только первой сборкой. Выкладка его не ставит заново и не снимает: снятие — решение двух людей по процедуре
# deploy/pilot/README.md, §6, и тогда настройка — явное `allowed`. Настройка без значения (кто-то сделал RESET) — отказ выкладки: неизвестно, решение это или ошибка.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "${here}/../.." && pwd)"
DB="${REPRACER_PILOT_DB:-repracer_pilot}"
REGION="${REPRACER_PILOT_REGION:-US}"
SECRETS="${REPRACER_PILOT_SECRETS:-/run/secrets}"
STAND="${REPRACER_PILOT_STAND:-pilot}"
FIRST=0
RESET=0
case "${1:-}" in --first-time) FIRST=1 ;; --reset-qa-b) RESET=1 ;; "") ;; *) echo "usage: deploy/pilot/db.sh [--first-time | --reset-qa-b]" >&2; exit 2 ;; esac
[[ "${DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "REPRACER_PILOT_DB — имя базы из строчных букв, цифр и _" >&2; exit 2; }
[[ "${STAND}" == pilot || "${STAND}" == qa-b ]] || { echo "REPRACER_PILOT_STAND — pilot или qa-b, а не «${STAND}»" >&2; exit 2; }
PSQL=(psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never -q -X)
fail() { echo "PILOT DB RED: $*" >&2; exit 1; }
[ -r "${SECRETS}/pg_role_passwords" ] || fail "нет ${SECRETS}/pg_role_passwords — секреты пилота (deploy/pilot/secrets.sh, push-secrets.sh)"

# Шаг 132: сброс QA-B — по образцу сброса QA-A (scripts/qa-reset.sh, шаг 121.3): база не бывает без стража ни в какой момент
if [ "${RESET}" = 1 ]; then
  [ "${STAND}" = qa-b ] || fail "сброс — только QA-B: стенд «${STAND}» (REPRACER_PILOT_STAND). Базу пилота не пересоздаёт ничто (deploy/pilot/README.md, §5)"
  NEXT="${DB}_next"
  [ ${#NEXT} -le 63 ] || fail "имя базы длиннее 58 знаков — сборке ${NEXT} не хватит места в имени"
  exists() { [ "$("${PSQL[@]}" -d postgres -Atc "SELECT count(*) FROM pg_database WHERE datname = '$1'")" = 1 ]; }
  stand_of() { "${PSQL[@]}" -d postgres -Atc "SELECT coalesce((SELECT substr(c, length('repracer.stand=') + 1) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
    WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '$1') AND starts_with(c, 'repracer.stand=')), '')"; }
  guarded() { [ "$("${PSQL[@]}" -d "$1" -Atc 'SELECT security.live_writes_forbidden()' 2> /dev/null)" = t ]; }
  if ! exists "${DB}"; then
    # Прошлый сброс убит между удалением прежней базы и переименованием готовой: готовая — со стражем и отметкой qa-b, повтор доводит замену
    if exists "${NEXT}" && [ "$(stand_of "${NEXT}")" = qa-b ] && guarded "${NEXT}"; then
      "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${NEXT} RENAME TO ${DB}"
      echo "== сброс доводит замену: ${NEXT} → ${DB}"
      echo "QA-B RESET GREEN: ${DB}"
      exit 0
    fi
    fail "базы ${DB} нет — это первая сборка (deploy/pilot/deploy.sh --first-time), а не сброс"
  fi
  [ "$(stand_of "${DB}")" = qa-b ] || fail "база ${DB} отмечена стендом «$(stand_of "${DB}")» — сброс пересоздаёт только базу, отмеченную qa-b"
  ! exists "${NEXT}" || "${PSQL[@]}" -d postgres -c "DROP DATABASE ${NEXT} WITH (FORCE)"
  echo "== сброс QA-B: новая база собирается под именем ${NEXT}"
  REPRACER_PILOT_DB="${NEXT}" REPRACER_PILOT_STAND=qa-b bash "$0" --first-time
  guarded "${NEXT}" || fail "у собранной ${NEXT} нет стража — прежняя база не тронута"
  "${PSQL[@]}" -d postgres -c "DROP DATABASE ${DB} WITH (FORCE)"
  "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${NEXT} RENAME TO ${DB}"
  guarded "${DB}" || fail "у новой базы ${DB} нет стража"
  echo "QA-B RESET GREEN: ${DB} — новая, страж стоит, отметка стенда qa-b"
  exit 0
fi

if [ "${FIRST}" = 1 ]; then
  echo "== база ${DB}: новая, регион ${REGION}, стенд ${STAND}"
  bash "${repo}/scripts/db/migrate.sh" "${DB}" --create "${REGION}"
  "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.stand = '${STAND}'"
else
  echo "== база ${DB}: новые миграции"
  bash "${repo}/scripts/db/migrate.sh" "${DB}"
fi

# Роли входа процессов и строки возможностей каналов: в работе справочник возможностей грузит развёртывание (OQ-55) — тем же файлом, что тесты и QA.
# Идемпотентно: роли — «если нет», строки — ON CONFLICT DO NOTHING, секции — вперёд от сейчас
echo "== роли входа и возможности каналов"
"${PSQL[@]}" -d "${DB}" -o /dev/null -f "${repo}/packages/pricing-store-pg/test/setup.sql"

echo "== пароли ролей подключения"
n=0
while read -r role pw; do
  [ -n "${role}" ] || continue
  [[ "${role}" =~ ^svc_[a-z_]+$ && "${pw}" =~ ^[0-9a-f]{32,128}$ ]] || fail "строка pg_role_passwords не по форме «svc_<роль> <hex>» (значение не печатается)"
  [ "$("${PSQL[@]}" -d postgres -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '${role}' AND rolcanlogin")" = 1 ] || fail "роли входа ${role} нет"
  # Значение — переменной psql через стандартный ввод: в -c psql переменные не подставляет (шаг 65), а в командной строке пароль был бы виден в ps
  "${PSQL[@]}" -d postgres -v pw="${pw}" -f - <<< "ALTER ROLE ${role} PASSWORD :'pw';" || fail "пароль роли ${role} не задан"
  n=$((n + 1))
done < "${SECRETS}/pg_role_passwords"
echo "паролей задано: ${n}"

setting="$("${PSQL[@]}" -d postgres -Atc "SELECT coalesce((SELECT substr(c, length('repracer.live_writes=') + 1) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
  WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '${DB}') AND starts_with(c, 'repracer.live_writes=')), '')")"
if [ "${FIRST}" = 1 ]; then
  [ -z "${setting}" ] || fail "у новой базы уже есть настройка repracer.live_writes='${setting}'"
  "${PSQL[@]}" -d postgres -c "ALTER DATABASE ${DB} SET repracer.live_writes = 'forbidden'"
  setting=forbidden
fi
guard="$("${PSQL[@]}" -d "${DB}" -Atc 'SELECT security.live_writes_forbidden()')"
case "${setting}" in
  forbidden) [ "${guard}" = t ] || fail "настройка forbidden, а страж базы говорит ${guard}"
    echo "страж P0-09: боевые записи на базе ${DB} ЗАПРЕЩЕНЫ (Р-247) — тень работает, в каналы не уходит ничего" ;;
  allowed) [ "${guard}" = f ] || fail "настройка allowed, а страж базы говорит ${guard}"
    echo "ВНИМАНИЕ: боевые записи на базе ${DB} РАЗРЕШЕНЫ — страж снят по процедуре deploy/pilot/README.md, §6; перевод аккаунта в бой — у владельца тенанта" ;;
  "") fail "на базе ${DB} нет настройки repracer.live_writes: страж снят без явного allowed — верните forbidden или снимите по процедуре README, §6" ;;
  *) [ "${guard}" = t ] || fail "незнакомое значение repracer.live_writes='${setting}' обязано закрывать базу, а страж говорит ${guard}"
    echo "страж P0-09: незнакомое значение '${setting}' закрывает базу (fail-closed) — запишите forbidden или allowed явно" ;;
esac
echo "PILOT DB GREEN: ${DB}"
