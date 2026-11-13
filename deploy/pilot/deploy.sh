#!/usr/bin/env bash
# Шаг 124 [Р-248]: выкладка пилота одной командой — код нужной версии, сборка интерфейса, версия сборки, база (первая — заново, дальше — только новые миграции),
# DDL ClickHouse и логины выгрузки, процессы, проверка. В отличие от QA-A база пилота живая: выкладка её не пересоздаёт никогда.
#   deploy/pilot/deploy.sh [<git-ref>] [--first-time]
# <git-ref> — тег или коммит на зелёном SHA main; без него — текущая рабочая копия. --first-time — первая выкладка: базы ещё нет, страж ставится [Р-247].
# Долгая работа и обрыв SSH: QA_STATE_DIR=deploy/pilot/state deploy/qa/detach.sh deploy deploy/pilot/deploy.sh … (README, §5)
set -euo pipefail
cd "$(dirname "$0")/../.."
REF=""
FIRST=()
for a in "$@"; do
  case "$a" in --first-time) FIRST=(--first-time) ;; -*) echo "неизвестный ключ: $a" >&2; exit 2 ;; *) REF="$a" ;; esac
done
if [ -n "${REF}" ]; then
  [ -z "$(git status --porcelain --untracked-files=no)" ] || { echo "в рабочей копии правки — переключать версию нельзя" >&2; exit 1; }
  git fetch --quiet --tags origin
  git checkout --quiet --detach "${REF}"
fi
sha="$(git rev-parse HEAD)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || sha="${sha}-dirty"
C=deploy/pilot/compose.sh
set -a; . deploy/pilot/pilot.env; set +a
# Зависимости и сборка — тем же образом Node, что исполняет процессы; на хосте Node не нужен
NODE_IMAGE="$(awk '/^  bulk-worker:/{f=1} f && /image:/{print $2; exit}' deploy/pilot/compose.yaml)"
echo "== зависимости и сборка интерфейса (${sha})"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "${PWD}":/app -w /app "${NODE_IMAGE}" \
  sh -c 'npm ci --no-audit --no-fund && node scripts/browser-imports.mjs && npm run build -w @repracer/console'
printf 'REPRACER_BUILD_SHA=%s\nREPRACER_BUILD_AT=%s\n' "${sha}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > deploy/pilot/build.env
echo "== база и ClickHouse"
"${C}" up -d --wait postgres clickhouse
"${C}" exec -T -u postgres -e REPRACER_PILOT_DB="${REPRACER_PILOT_DB}" -e REPRACER_PILOT_REGION="${REPRACER_PILOT_REGION}" postgres \
  bash /repo/deploy/pilot/db.sh ${FIRST[@]+"${FIRST[@]}"}
"${C}" run --rm tools sh -c 'node infra/local/apply-clickhouse.mjs && node deploy/pilot/clickhouse-users.mjs'
echo "== процессы"
"${C}" up -d --wait --remove-orphans
deploy/pilot/smoke.sh
