#!/usr/bin/env bash
# Шаг 130 (решение владельца 2026-11-15, п. 3.2; Amazon DPP — журналы не меньше 12 месяцев): архив журналов контейнеров пилота. Работу делает ТОТ ЖЕ
# скрипт, что у промышленного профиля (deploy/production/logs-archive.sh): горячий хвост сутками (30–61 суток), затем месячные архивы
# `<REPRACER_ARCHIVE_DIR>/platform=logs/repracer-pilot/<ГГГГ-ММ>.log.gz` с суммой SHA-256, 13 месяцев; сбой — файл LOGS_ARCHIVE_FAILED.
# Здесь — проводка пилота: проект compose repracer-pilot, каталоги из pilot.env и отметка во внешнем сервисе после захода [Р-127]: «жив» — после
# удавшегося, «сбой» — после провала (адрес — файл logs_heartbeat_url, scripts/setup-heartbeats.mjs --stand pilot).
#   deploy/pilot/logs-archive.sh              — полные сутки UTC до сегодняшней полуночи (ежедневно, crontab — deploy/pilot/logs-cron.sh)
#   deploy/pilot/logs-archive.sh --until-now  — по текущий момент (deploy.sh до и после пересоздания контейнеров)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
set -a; . "${here}/pilot.env"; set +a
: "${REPRACER_LOGS_HOT_DIR:?set REPRACER_LOGS_HOT_DIR in pilot.env}"
: "${REPRACER_ARCHIVE_DIR:?set REPRACER_ARCHIVE_DIR in pilot.env}"
export REPRACER_LOGS_HOT_DIR REPRACER_ARCHIVE_DIR
export REPRACER_LOG_PROJECTS=repracer-pilot
HB="${REPRACER_SECRETS_DIR:?set REPRACER_SECRETS_DIR in pilot.env}/logs_heartbeat_url"
# Адрес — секрет: конфигурацией curl со стандартного ввода, а не аргументом (аргументы видны в ps). Нет адреса — архив важнее отметки: заход идёт,
# а выкладку без адреса не пустит heartbeat-state.sh
beat() {
  [ -s "${HB}" ] || return 0
  printf 'url = "%s%s"\n' "$(head -n 1 "${HB}" | tr -d '\r\n')" "$1" | curl -fsS -m 10 --retry 2 -o /dev/null --config - 2> /dev/null \
    || echo '{"event":"LOGS_HEARTBEAT_FAILED"}' >&2
}
rc=0
bash "${here}/../production/logs-archive.sh" "$@" || rc=$?
if [ "${rc}" -eq 0 ]; then beat ""; else beat /fail; fi
exit "${rc}"
