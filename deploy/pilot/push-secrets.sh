#!/usr/bin/env bash
# Шаг 124 [Р-248]: каталог секретов пилота — с машины владельца на сервер одним потоком tar по SSH. Значения не печатаются ни здесь, ни на сервере;
# на сервере каталог 700, файлы 600, владелец — пользователь выкладки (от его uid работают контейнеры процессов, deploy/pilot/README.md, §2).
#   deploy/pilot/push-secrets.sh <пользователь@сервер> [<каталог на сервере>]
# Адрес сервера — аргумент: параметры сервера в репозитории не зашиваются.
set -euo pipefail
DEST="${1:-}"
REMOTE="${2:-/srv/repracer-pilot/secrets}"
[ -n "${DEST}" ] || { echo "usage: deploy/pilot/push-secrets.sh <user@server> [<remote dir>]" >&2; exit 2; }
[[ "${REMOTE}" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "каталог на сервере — абсолютный путь без пробелов и кавычек" >&2; exit 2; }
LOCAL="${REPRACER_PILOT_LOCAL_SECRETS:-${HOME}/.config/repracer/secrets/pilot}"
[ -d "${LOCAL}" ] || { echo "нет ${LOCAL} — сначала deploy/pilot/secrets.sh" >&2; exit 1; }
[ -e "${LOCAL}/tunnel.env" ] || { echo "нет ${LOCAL}/tunnel.env — токен туннеля кладёт владелец (deploy/pilot/README.md, §3)" >&2; exit 1; }
tar -C "${LOCAL}" -cf - . | ssh "${DEST}" "umask 077 && mkdir -p '${REMOTE}' && tar -C '${REMOTE}' -xf - && chmod 700 '${REMOTE}' && find '${REMOTE}' -type f -exec chmod 600 {} + && echo \"секретов на сервере: \$(find '${REMOTE}' -type f | wc -l)\""
