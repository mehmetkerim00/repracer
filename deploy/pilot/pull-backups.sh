#!/usr/bin/env bash
# Шаг 126: вынос копий базы пилота НА МАШИНУ ОПЕРАТОРА — вторая бесплатная цель (REPRACER_BACKUP_OFFSITE=pull), когда R2 не выбран. Запускается на машине
# оператора раз в сутки (launchd или cron — deploy/pilot/README.md, «Копии базы»), тянет с сервера по SSH готовые копии, которых здесь ещё нет:
#   deploy/pilot/pull-backups.sh <пользователь@сервер> [<каталог здесь>]
# Готовая копия — та, у которой есть файл сумм (backup-loop пишет его последним). Каждая копия сверяется по SHA-256 ДО того, как её примут: порча при
# переносе — отказ, частей не остаётся. Копии здесь живут столько же, сколько на сервере (REPRACER_BACKUP_KEEP_DAYS, 7 суток): старше — удаляются по
# времени в имени. После прохода на сервер уходит отметка OFFSITE_PULLED с последней принятой копией — её проверяет deploy/pilot/smoke.sh.
# Копии зашифрованы открытым ключом владельца: здесь лежит шифротекст. Параметры сервера в репозитории не зашиваются — адрес аргументом.
set -euo pipefail
DEST="${1:-}"
[ -n "${DEST}" ] || { echo "usage: deploy/pilot/pull-backups.sh <user@server> [<local dir>]" >&2; exit 2; }
LOCAL="${2:-${REPRACER_PILOT_BACKUP_PULL_DIR:-${HOME}/.config/repracer/backups/pilot}}"
REMOTE="${REPRACER_PILOT_REMOTE_BACKUP_DIR:-/srv/repracer-pilot/backups}"
KEEP_DAYS="${REPRACER_BACKUP_KEEP_DAYS:-7}"
[[ "${REMOTE}" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "каталог копий на сервере — абсолютный путь без пробелов и кавычек" >&2; exit 2; }
[[ "${KEEP_DAYS}" =~ ^[1-9][0-9]*$ ]] || { echo "REPRACER_BACKUP_KEEP_DAYS — целое число суток" >&2; exit 2; }
umask 077
mkdir -p "${LOCAL}"
chmod 700 "${LOCAL}"
sha() { if command -v sha256sum > /dev/null; then sha256sum "$@" | awk '{print $1}'; else shasum -a 256 "$@" | awk '{print $1}'; fi; }
# Время в имени копии — UTC; perl есть и у macOS, и у Linux (date у них разный)
cutoff="$(perl -MPOSIX -e "print strftime('%Y%m%dT%H%M%SZ', gmtime(time - ${KEEP_DAYS} * 86400))")"
fail() { echo "PULL RED: $*" >&2; exit 1; }

stamps="$(ssh "${DEST}" "cd '${REMOTE}' && ls -1" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort)" || fail "сервер не отдал список копий (${REMOTE})"
pulled=0
bad=()
for s in ${stamps}; do
  [[ "${s}" < "${cutoff}" ]] && continue
  [ -e "${LOCAL}/repracer-${s}.sha256" ] && continue
  ok=1
  for part in dump.gpg globals.sql.gpg sha256; do
    ssh "${DEST}" "cat '${REMOTE}/repracer-${s}.${part}'" > "${LOCAL}/repracer-${s}.${part}.part" || { ok=0; break; }
  done
  # Те же суммы, что сверяет restore.sh: две строки — копия и роли
  if [ "${ok}" = 1 ] && [ "$(tr -d ' \r' < "${LOCAL}/repracer-${s}.sha256.part")" = "$(sha "${LOCAL}/repracer-${s}.dump.gpg.part" "${LOCAL}/repracer-${s}.globals.sql.gpg.part" | tr -d ' ')" ]; then
    for part in dump.gpg globals.sql.gpg sha256; do mv "${LOCAL}/repracer-${s}.${part}.part" "${LOCAL}/repracer-${s}.${part}"; done
    pulled=$((pulled + 1))
  else
    rm -f "${LOCAL}/repracer-${s}".*.part
    bad+=("${s}")
  fi
done

# Срок здесь — как на сервере: старше среза — удаляются (данные каналов не переживают свой срок в копиях, docs/data-retention.md)
for f in "${LOCAL}"/repracer-*; do
  [ -e "${f}" ] || continue
  s="$(basename "${f}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\..*$/\1/p')"
  [ -n "${s}" ] && [[ "${s}" < "${cutoff}" ]] && rm -f "${f}"
done

newest="$(ls -1 "${LOCAL}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort | tail -1)"
[ ${#bad[@]} -eq 0 ] || fail "копия не сошлась по SHA-256 и не принята: ${bad[*]} — повторите; повторится — копия на сервере испорчена"
[ -n "${newest}" ] || fail "на сервере нет ни одной готовой копии — смотрите сервис backup (deploy/pilot/compose.sh logs backup)"
now="$(date -u +%Y%m%dT%H%M%SZ)"
ssh "${DEST}" "printf '%s\n' '{\"pulledThrough\":\"${newest}\",\"at\":\"${now}\"}' > '${REMOTE}/OFFSITE_PULLED.part' && mv '${REMOTE}/OFFSITE_PULLED.part' '${REMOTE}/OFFSITE_PULLED'" \
  || fail "копии приняты, но отметка на сервер не записалась — смоук назовёт их невынесенными"
echo "PULL GREEN: новых копий ${pulled}, последняя repracer-${newest}, здесь — $(ls -1 "${LOCAL}" | grep -c '\.sha256$') копий в ${LOCAL}"
