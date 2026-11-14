#!/usr/bin/env bash
# Шаг 130: ежедневный архив журналов пилота — строка crontab пользователя выкладки. У него нет sudo (deploy/pilot/README.md, §2), поэтому не таймер
# systemd, как у промышленного профиля. Пропущенный запуск не теряет суток: скрипт догоняет их от отметки «выгружено по». Зовёт deploy.sh при каждой
# выкладке: строка ставится одна, прежняя своя заменяется, чужие строки остаются. Вывод захода — в системный журнал (logger), отметка — во внешний
# сервис (deploy/pilot/logs-archive.sh).
#   deploy/pilot/logs-cron.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
line="20 0 * * * cd '${repo}' && deploy/pilot/logs-archive.sh 2>&1 | logger -t repracer-pilot-logs-archive"
# Сначала прочитать целиком, потом писать: чтение и запись одним конвейером идут одновременно, и запись могла бы опередить чтение
current="$(crontab -l 2> /dev/null || true)"
{ [ -z "${current}" ] || printf '%s\n' "${current}" | grep -vF 'deploy/pilot/logs-archive.sh' || true; echo "${line}"; } | crontab -
echo "LOGS CRON: ежедневная выгрузка журналов — 00:20 по часам сервера"
