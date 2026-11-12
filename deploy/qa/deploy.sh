#!/usr/bin/env bash
# Шаг 121 (QA-A): выкладка одной командой — код нужной версии, зависимости и сборка интерфейса, версия сборки, база заново (миграции новой
# версии, демо заново), процессы, проверка. База QA пересоздаётся при каждой выкладке: миграции применяются к чистой базе так же, как в CI,
# и демо всегда свежее (~3 минуты). Сброс отказывает базе без стража P0-09 (scripts/qa-reset.sh).
#   deploy/qa/deploy.sh [<git-ref>] [--first-time]
# <git-ref> — тег или коммит (qa-YYYYMMDD.N на зелёном SHA); без него — текущая рабочая копия. --first-time — первая выкладка: базы ещё нет.
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
# Правки в рабочей копии — версия так и называется: подвал и /healthz не выдают её за чистую
[ -z "$(git status --porcelain --untracked-files=no)" ] || sha="${sha}-dirty"
# Зависимости и сборка — тем же образом Node, что исполняет процессы; на хосте Node не нужен
NODE_IMAGE="$(awk '/^x-node:/{f=1} f && /image:/{print $2; exit}' deploy/qa/compose.yaml)"
echo "== зависимости и сборка интерфейса (${sha})"
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm -v "${PWD}":/app -w /app "${NODE_IMAGE}" \
  sh -c 'npm ci --no-audit --no-fund && node scripts/browser-imports.mjs && npm run build -w @repracer/console'
printf 'REPRACER_BUILD_SHA=%s\nREPRACER_BUILD_AT=%s\n' "${sha}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > deploy/qa/build.env
deploy/qa/reset.sh ${FIRST[@]+"${FIRST[@]}"}
deploy/qa/smoke.sh
