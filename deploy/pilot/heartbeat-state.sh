#!/usr/bin/env bash
# Шаг 129 (решение владельца 2026-11-15, п. 3.1): пилот без внешнего контроля [Р-127] не выкладывается.
#   deploy/pilot/heartbeat-state.sh <каталог секретов>
# Проверяет две вещи: отметки процессов не выключены (REPRACER_*_HEARTBEAT=off из pilot.env) и у каждой из шести проверок, которые отмечаются
# с сервера, есть файл адреса https. Четыре процесса — планировщик, консоль, панель и исполнитель заданий; пятая — копии базы (backup-heartbeat);
# шестая — архив журналов (deploy/pilot/logs-archive.sh, шаг 130).
# Седьмая проверка — вынос копий: она отмечается с машины оператора (pull-backups.sh), её проверяет backup-state.sh по отметке OFFSITE_PULLED.
# Спрашивают deploy.sh (до сборки) и smoke.sh. Красное — строкой «HEARTBEAT RED: …» и кодом 1. Адреса — секреты: читается только их начало,
# в вывод они не попадают.
set -euo pipefail
SECRETS="${1:?usage: heartbeat-state.sh <secrets dir>}"
red() { echo "HEARTBEAT RED: $*" >&2; exit 1; }
for v in REPRACER_SCHEDULER_HEARTBEAT REPRACER_CONSOLE_HEARTBEAT REPRACER_OPERATOR_HEARTBEAT REPRACER_BULK_HEARTBEAT; do
  [ "${!v:-}" != off ] || red "${v}=off — отметки пилота не выключаются (deploy/pilot/README.md, §9): уберите строку из pilot.env"
done
files=(scheduler_heartbeat_url console_heartbeat_url operator_heartbeat_url bulk_heartbeat_url backup_heartbeat_url logs_heartbeat_url)
for f in "${files[@]}"; do
  p="${SECRETS}/${f}"
  [ -s "${p}" ] || red "нет ${p} — адрес отметки во внешнем сервисе: scripts/setup-heartbeats.mjs --stand pilot на машине владельца, затем push-secrets.sh (README, §9)"
  [ "$(head -c 8 "${p}")" = "https://" ] || red "${p} — не адрес https (scripts/setup-heartbeats.mjs кладёт ping_url проверки)"
  [ "$(wc -l < "${p}" | tr -d ' ')" -le 1 ] || red "${p} — больше одной строки: там не адрес отметки"
done
echo "HEARTBEAT READY: ${#files[@]} адресов отметок — файлами, ни одна отметка не выключена"
