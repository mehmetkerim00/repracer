#!/usr/bin/env bash
# Шаг 130: в порядке ли архив журналов пилота (Amazon DPP — не меньше 12 месяцев). Спрашивает deploy/pilot/smoke.sh.
#   deploy/pilot/logs-state.sh <горячий каталог журналов>
# Зелёное, если ежедневная выгрузка стоит в crontab пользователя выкладки, отметки провала нет и журналы проекта выгружены не раньше 26 часов назад.
# Красное — строкой «LOGS RED: …» с тем, что сделать, и кодом 1.
set -euo pipefail
HOT="${1:?usage: logs-state.sh <logs hot dir>}"
red() { echo "LOGS RED: $*" >&2; exit 1; }
crontab -l 2> /dev/null | grep -qF 'deploy/pilot/logs-archive.sh' \
  || red "нет ежедневной выгрузки журналов в crontab пользователя выкладки — deploy/pilot/logs-cron.sh (его зовёт deploy.sh)"
[ ! -e "${HOT}/LOGS_ARCHIVE_FAILED" ] || red "выгрузка журналов проваливается: $(tr -d '\n' < "${HOT}/LOGS_ARCHIVE_FAILED") — journalctl -t repracer-pilot-logs-archive"
mark="${HOT}/repracer-pilot/.until"
[ -s "${mark}" ] || red "журналы пилота ещё не выгружались — deploy/pilot/logs-archive.sh --until-now"
until="$(cat "${mark}")"
# Время — ISO UTC, как пишет logs-archive.sh; perl есть и у macOS, и у Linux
day="$(perl -MPOSIX -e "print strftime('%Y-%m-%dT%H:%M:%SZ', gmtime(time - 26 * 3600))")"
[[ ! "${until}" < "${day}" ]] || red "выгружено по ${until} — старше 26 ч: ежедневная выгрузка не идёт (journalctl -t repracer-pilot-logs-archive)"
echo "LOGS GREEN: журналы пилота выгружены по ${until}; месячные архивы — 13 месяцев (deploy/pilot/README.md, §10)"
