#!/usr/bin/env bash
# Шаг 124 [Р-248]: выкладка пилота одной командой — код нужной версии, сборка интерфейса, версия сборки, база (первая — заново, дальше — только новые миграции),
# DDL ClickHouse и логины выгрузки, процессы, проверка. В отличие от QA-A база пилота живая: выкладка её не пересоздаёт никогда.
#   deploy/pilot/deploy.sh [<git-ref>] [--first-time]
# <git-ref> — тег или коммит на зелёном SHA main; без него — текущая рабочая копия. --first-time — первая выкладка: базы ещё нет, страж ставится [Р-247].
# Долгая работа и обрыв SSH: QA_STATE_DIR=deploy/pilot/state deploy/qa/detach.sh deploy deploy/pilot/deploy.sh … (README, §5)
# Шаг 131 (откат, решение владельца 2026-11-15): план миграций выкладываемой версии — ДО переключения рабочей копии; версия старше базы — отказ до всего;
# миграции к применению — сначала копия базы с отметкой выкладки (deploy/pilot/pre-release-copy.sh). Процедура отката — README, «Откат».
set -euo pipefail
cd "$(dirname "$0")/../.."
REF=""
FIRST=()
for a in "$@"; do
  case "$a" in --first-time) FIRST=(--first-time) ;; -*) echo "неизвестный ключ: $a" >&2; exit 2 ;; *) REF="$a" ;; esac
done
C=deploy/pilot/compose.sh
set -a; . deploy/pilot/pilot.env; set +a
# Шаг 126 (решение владельца): пилот без копий базы не выкладывается — ключ, строка подключения копии, цель выноса и каталог копий спрашиваются ДО всего
deploy/pilot/backup-state.sh --ready "${REPRACER_SECRETS_DIR}" "${REPRACER_BACKUP_DIR:-}" "${REPRACER_BACKUP_OFFSITE:-}"
# Шаг 129 [Р-127]: и без внешнего контроля — отметки не выключены, адреса шести проверок лежат файлами
deploy/pilot/heartbeat-state.sh "${REPRACER_SECRETS_DIR}"

before="$(git rev-parse HEAD)"
if [ -n "${REF}" ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "в рабочей копии правки — переключать версию нельзя" >&2; exit 1; }
  git fetch --quiet --tags origin
fi
target="$(git rev-parse --verify "${REF:-HEAD}^{commit}")"

# Шаг 131: план миграций ВЫКЛАДЫВАЕМОЙ версии к живой базе — пока рабочая копия и процессы ещё на прежней. Миграции версии берутся из git, а не с диска;
# план считает тот же scripts/db/migrate.sh, что потом применит (одна сверка журнала). Первой выкладке сверять не с чем — базы ещё нет
pending=0
at=""
if [ ${#FIRST[@]} -eq 0 ]; then
  # Без <git-ref> выкладывается рабочая копия — её миграции и сверяются
  migrations=/repo/migrations
  if [ -n "${REF}" ]; then
    plan="deploy/pilot/state/plan"
    rm -rf "${plan}"
    mkdir -p "${plan}"
    git archive "${target}" migrations | tar -x -C "${plan}"
    migrations="/repo/${plan}/migrations"
  fi
  rc=0
  out="$("${C}" exec -T -u postgres -e REPRACER_MIGRATIONS_DIR="${migrations}" postgres bash /repo/scripts/db/migrate.sh "${REPRACER_PILOT_DB}" --check 2>&1)" || rc=$?
  printf '%s\n' "${out}"
  case "${rc}" in
    0) pending="$(sed -n 's/^MIGRATIONS PLAN: .* pending \([0-9][0-9]*\).*$/\1/p' <<< "${out}")"
       at="$(sed -n 's/^MIGRATIONS PLAN: .* at \([0-9]\{4\}\);.*$/\1/p' <<< "${out}")"
       [[ "${pending}" =~ ^[0-9]+$ && "${at}" =~ ^[0-9]{4}$ ]] || { echo "DEPLOY RED: план миграций не разобран — рабочая копия не переключалась" >&2; exit 1; } ;;
    3) echo "DEPLOY RED: версия ${REF:-рабочей копии} старше базы пилота — выкладка остановлена ДО переключения рабочей копии, ничего не менялось. Код прежней версии к базе после миграции не подходит: откат через миграцию — восстановление копии, снятой перед ней (deploy/pilot/README.md, «Откат»)" >&2; exit 1 ;;
    *) echo "DEPLOY RED: план миграций не получен (строка выше) — рабочая копия не переключалась. База не отвечает — deploy/pilot/compose.sh up -d postgres" >&2; exit 1 ;;
  esac
fi

if [ -n "${REF}" ]; then
  git checkout --quiet --detach "${target}"
fi
sha="$(git rev-parse HEAD)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || sha="${sha}-dirty"
# Зависимости и сборка — тем же образом Node, что исполняет процессы; на хосте Node не нужен
NODE_IMAGE="$(awk '/^  bulk-worker:/{f=1} f && /image:/{print $2; exit}' deploy/pilot/compose.yaml)"
echo "== зависимости и сборка интерфейса (${sha})"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "${PWD}":/app -w /app "${NODE_IMAGE}" \
  sh -c 'npm ci --no-audit --no-fund && node scripts/browser-imports.mjs && npm run build -w @repracer/console'
printf 'REPRACER_BUILD_SHA=%s\nREPRACER_BUILD_AT=%s\n' "${sha}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > deploy/pilot/build.env
# Шаг 130 (Amazon DPP — журналы ≥ 12 месяцев): журнал контейнера уходит вместе с ним, а `up` пересоздаёт контейнеры с изменённой настройкой.
# Поэтому сначала — журналы по сей момент; провал выгрузки останавливает выкладку (строка LOGS_ARCHIVE_FAILED выше). Первая выкладка — контейнеров ещё нет
if [ -n "$("${C}" ps -aq 2> /dev/null)" ]; then
  echo "== журналы по сей момент (до пересоздания контейнеров)"
  deploy/pilot/logs-archive.sh --until-now
fi
echo "== база и ClickHouse"
"${C}" up -d --wait postgres clickhouse
# Шаг 131: у выкладки есть миграции — копия базы до них; провал копии — стоп до миграций
if [ "${pending}" -gt 0 ]; then
  echo "== копия базы до миграций (${pending} к применению, база на ${at})"
  deploy/pilot/pre-release-copy.sh "${before}" "${sha}" "${at}"
fi
# Шаг 132: стенд (pilot | qa-b) — отметка базы при первой сборке; по ней сброс отличает QA-B от пилота
"${C}" exec -T -u postgres -e REPRACER_PILOT_DB="${REPRACER_PILOT_DB}" -e REPRACER_PILOT_REGION="${REPRACER_PILOT_REGION}" -e REPRACER_PILOT_STAND="${REPRACER_PILOT_STAND:-pilot}" postgres \
  bash /repo/deploy/pilot/db.sh ${FIRST[@]+"${FIRST[@]}"}
"${C}" run --rm tools sh -c 'node infra/local/apply-clickhouse.mjs && node deploy/pilot/clickhouse-users.mjs'
echo "== процессы"
"${C}" up -d --wait --remove-orphans
# Шаг 131: журнал выкладок — откат без SHA (deploy/pilot/rollback.sh) возвращает к версии, с которой ушла последняя выкладка
mkdir -p deploy/pilot/state
printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${before}" "${sha}" >> deploy/pilot/state/releases.log
# Шаг 130: отметка «выгружено по» у новых контейнеров и ежедневная выгрузка в crontab (одна строка, сколько бы ни было выкладок)
echo "== журналы: выгрузка и ежедневный запуск"
deploy/pilot/logs-archive.sh --until-now
deploy/pilot/logs-cron.sh
deploy/pilot/smoke.sh
