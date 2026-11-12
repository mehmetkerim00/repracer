#!/usr/bin/env bash
# Шаг 121 (QA-A): все команды compose профиля — через эту обёртку: она подставляет qa.env (каталог секретов) и build.env (какая сборка
# работает, пишет deploy/qa/deploy.sh). Иначе `docker compose up` из другой оболочки поднял бы контейнеры без версии сборки.
#   deploy/qa/compose.sh ps | logs -f stand | restart stand | …
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "${here}/qa.env" ] || { echo "нет ${here}/qa.env — скопируйте qa.env.example и заполните (deploy/qa/README.md, шаг 4)" >&2; exit 1; }
[ -f "${here}/build.env" ] || { echo "нет ${here}/build.env — его пишет deploy/qa/deploy.sh" >&2; exit 1; }
exec docker compose -f "${here}/compose.yaml" --env-file "${here}/qa.env" --env-file "${here}/build.env" "$@"
