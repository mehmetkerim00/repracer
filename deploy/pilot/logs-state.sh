#!/usr/bin/env bash
# Шаг 130: в порядке ли архив журналов пилота (Amazon DPP — не меньше 12 месяцев). Спрашивает deploy/pilot/smoke.sh.
#   deploy/pilot/logs-state.sh <горячий каталог журналов>
# Зелёное, если ежедневная выгрузка стоит в crontab пользователя выкладки, отметки провала нет и журналы проекта выгружены не раньше 26 часов назад.
# Шаг 133: и вынесены с сервера — отметка LOGS_PULLED от deploy/pilot/pull-backups.sh не старше 26 часов и под внешним контролем (как у копий, шаг 129).
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
# Шаг 133: журналы, которые живут только на сервере, гибнут вместе с ним — требование DPP «12 месяцев» тоже
pulled="${HOT}/LOGS_PULLED"
[ -r "${pulled}" ] || red "журналы не выносились с сервера — на машине оператора: deploy/pilot/pull-backups.sh <пользователь@сервер> (§8, §10)"
at="$(sed -n 's/.*"at":"\([0-9]\{8\}T[0-9]\{6\}Z\)".*/\1/p' "${pulled}")"
stamp="$(perl -MPOSIX -e "print strftime('%Y%m%dT%H%M%SZ', gmtime(time - 26 * 3600))")"
[ -n "${at}" ] && [[ ! "${at}" < "${stamp}" ]] || red "журналы не выносились с сервера дольше 26 ч — deploy/pilot/pull-backups.sh на машине оператора и его ежедневный запуск"
grep -q '"monitored":true' "${pulled}" \
  || red "вынос журналов не под внешним контролем: у pull-backups.sh на машине оператора нет адреса отметки — scripts/setup-heartbeats.mjs --stand pilot (§9)"
echo "LOGS GREEN: журналы пилота выгружены по ${until}; месячные архивы — 13 месяцев; вне сервера — машина оператора, вынос ${at} (deploy/pilot/README.md, §10)"
