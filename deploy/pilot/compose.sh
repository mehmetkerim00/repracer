#!/usr/bin/env bash
# Шаг 124 [Р-248]: все команды compose пилота — через эту обёртку: pilot.env (настройки), build.env (какая сборка работает, пишет deploy/pilot/deploy.sh) и
# amazon.env из каталога секретов (идентификаторы приложения Amazon). Иначе `docker compose up` из другой оболочки поднял бы процессы без версии и без Amazon.
#   deploy/pilot/compose.sh ps | logs -f console | restart scheduler | exec -T -u postgres postgres … | run --rm tools …
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ -f "${here}/pilot.env" ] || { echo "нет ${here}/pilot.env — скопируйте pilot.env.example и заполните (deploy/pilot/README.md, §4)" >&2; exit 1; }
[ -f "${here}/build.env" ] || { echo "нет ${here}/build.env — его пишет deploy/pilot/deploy.sh" >&2; exit 1; }
secrets="$(sed -n 's/^REPRACER_SECRETS_DIR=//p' "${here}/pilot.env")"
[ -f "${secrets}/amazon.env" ] || { echo "нет ${secrets}/amazon.env — секреты пилота (deploy/pilot/secrets.sh, push-secrets.sh)" >&2; exit 1; }
# Шаг 126: вынос копий в R2 — свой сервис под профилем r2; при pull его нет (копии забирает машина оператора)
profile=()
[ "$(sed -n 's/^REPRACER_BACKUP_OFFSITE=//p' "${here}/pilot.env")" = r2 ] && profile=(--profile r2)
# Шаг 141: путь записи (брокер и процесс пути решения) — профиль live, только в день перевода в бой (README, §6). Без строки — off
write_path="$(sed -n 's/^REPRACER_PILOT_WRITE_PATH=//p' "${here}/pilot.env")"
case "${write_path:-off}" in
  off) ;;
  on) profile+=(--profile live) ;;
  *) echo "REPRACER_PILOT_WRITE_PATH — on или off, а в pilot.env «${write_path}» (README, §6)" >&2; exit 2 ;;
esac
exec docker compose -f "${here}/compose.yaml" --env-file "${here}/pilot.env" --env-file "${secrets}/amazon.env" --env-file "${here}/build.env" ${profile[@]+"${profile[@]}"} "$@"
