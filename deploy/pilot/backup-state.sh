#!/usr/bin/env bash
# Шаг 126 (решение владельца: «пилот без копий не стартует; копия без проверенного восстановления копией не считается»). Два вопроса — одним скриптом:
#   deploy/pilot/backup-state.sh --ready <каталог секретов> <каталог копий> <r2|pull>
#       настроены ли копии: открытый ключ (и не закрытый), строка подключения копии, выбранная цель выноса, у R2 — адрес бакета и ключи; каталог
#       копий есть и в него можно писать. deploy/pilot/deploy.sh спрашивает это ДО того, как поднять что-либо — без ответа «да» выкладки нет;
#   deploy/pilot/backup-state.sh <каталог копий> <r2|pull>
#       в порядке ли сами копии: свежая готовая копия (не старше 26 ч), она вынесена с сервера (R2 — отметка .offsite, машина оператора — отметка
#       OFFSITE_PULLED не старше 26 ч), среди хранимых копий есть проверенная восстановлением (deploy/pilot/restore-check.sh), отметок провала нет.
#       Это спрашивает deploy/pilot/smoke.sh.
# Красное — строкой «BACKUP RED: …» с тем, что сделать, и кодом 1. Значения секретов не читаются и не печатаются — только их форма.
set -euo pipefail
red() { echo "BACKUP RED: $*" >&2; exit 1; }
mode_ok() { [[ "$1" == r2 || "$1" == pull ]] || red "REPRACER_BACKUP_OFFSITE=r2|pull — куда выносить копии с сервера (deploy/pilot/README.md, «Копии базы»), сейчас: '${1}'"; }
# Время копии — в её имени (UTC, как пишет backup-loop); perl есть и у macOS, и у Linux
ago() { perl -MPOSIX -e "print strftime('%Y%m%dT%H%M%SZ', gmtime(time - $1))"; }

if [ "${1:-}" = --ready ]; then
  SECRETS="${2:?usage: backup-state.sh --ready <secrets dir> <backup dir> <r2|pull>}"
  DIR="${3:?usage: backup-state.sh --ready <secrets dir> <backup dir> <r2|pull>}"
  MODE="${4:-}"
  mode_ok "${MODE}"
  key="${SECRETS}/backup_public_key.asc"
  [ -r "${key}" ] || red "нет ${key} — открытый ключ копии (deploy/pilot/backup-key.sh или gpg на машине владельца, README «Копии базы»)"
  grep -q -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' "${key}" || red "${key} — не открытый ключ PGP"
  # Закрытый ключ на сервере — это копия, которую читает любой, кто украл сервер вместе с копиями
  ! grep -q -- 'PRIVATE KEY' "${key}" || red "${key} содержит ЗАКРЫТЫЙ ключ — на сервере только открытый; закрытый — у владельца"
  ! grep -rlq -- '-----BEGIN PGP PRIVATE KEY BLOCK-----' "${SECRETS}" 2>/dev/null || red "в каталоге секретов сервера лежит закрытый ключ PGP — уберите его, он хранится только у владельца"
  [ -r "${SECRETS}/backup_pg_url" ] || red "нет ${SECRETS}/backup_pg_url — строка подключения копии (deploy/pilot/secrets.sh, push-secrets.sh)"
  if [ "${MODE}" = r2 ]; then
    [[ "${REPRACER_BACKUP_R2_BUCKET_URL:-}" =~ ^https://[a-z0-9.-]+\.r2\.cloudflarestorage\.com$ ]] \
      || red "REPRACER_BACKUP_R2_BUCKET_URL — https://<бакет>.<ACCOUNT_ID>.r2.cloudflarestorage.com (pilot.env), сейчас: '${REPRACER_BACKUP_R2_BUCKET_URL:-}'"
    for f in backup_r2_access_key_id backup_r2_secret_access_key; do [ -s "${SECRETS}/${f}" ] || red "нет ${SECRETS}/${f} — ключ R2 (README «Копии базы»)"; done
  fi
  [ -d "${DIR}" ] || red "нет каталога копий ${DIR} (REPRACER_BACKUP_DIR в pilot.env) — создайте его пользователем выкладки"
  [ -w "${DIR}" ] || red "в каталог копий ${DIR} нельзя писать пользователю выкладки"
  echo "BACKUP READY: ключ — открытый, цель выноса — ${MODE}, каталог — ${DIR}"
  exit 0
fi

DIR="${1:?usage: backup-state.sh <backup dir> <r2|pull>}"
MODE="${2:-}"
mode_ok "${MODE}"
[ -d "${DIR}" ] || red "нет каталога копий ${DIR}"
[ ! -e "${DIR}/BACKUP_FAILED" ] || red "копия базы проваливается: $(tr -d '\n' < "${DIR}/BACKUP_FAILED") — deploy/pilot/compose.sh logs backup"
day="$(ago $((26 * 3600)))"
newest="$(ls -1 "${DIR}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort | tail -1)"
[ -n "${newest}" ] || red "готовых копий нет — сервис backup снимает первую при старте (deploy/pilot/compose.sh logs backup)"
[[ ! "${newest}" < "${day}" ]] || red "последняя копия repracer-${newest} старше 26 ч — сервис backup не снимает копии"
if [ "${MODE}" = r2 ]; then
  [ ! -e "${DIR}/BACKUP_OFFSITE_FAILED" ] || red "вынос в R2 проваливается: $(tr -d '\n' < "${DIR}/BACKUP_OFFSITE_FAILED") — deploy/pilot/compose.sh logs backup-offsite"
  out="$(ls -1 "${DIR}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.offsite$/\1/p' | sort | tail -1)"
  [ -n "${out}" ] && [[ ! "${out}" < "${day}" ]] || red "в R2 нет копии моложе 26 ч — смотрите deploy/pilot/compose.sh logs backup-offsite"
  where="R2, repracer-${out}"
else
  [ -r "${DIR}/OFFSITE_PULLED" ] || red "копии не выносились с сервера — на машине оператора: deploy/pilot/pull-backups.sh <пользователь@сервер>"
  out="$(sed -n 's/.*"pulledThrough":"\([0-9]\{8\}T[0-9]\{6\}Z\)".*/\1/p' "${DIR}/OFFSITE_PULLED")"
  [ -n "${out}" ] && [[ ! "${out}" < "${day}" ]] || red "на машину оператора не вынесено ни одной копии моложе 26 ч — deploy/pilot/pull-backups.sh (и его ежедневный запуск)"
  where="машина оператора, repracer-${out}"
fi
# Отметка проверки живёт дольше своей копии (срок хранения backup-loop считает по времени файла, а отметка пишется позже) — в счёт идёт только
# отметка копии, которая ещё хранится
checked=""
for s in $(ls -1 "${DIR}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.restore-checked$/\1/p' | sort); do
  [ -e "${DIR}/repracer-${s}.sha256" ] && checked="${s}"
done
[ -n "${checked}" ] || red "ни одна из хранимых копий не проверена восстановлением — на машине оператора: ssh <сервер> 'cd /srv/repracer && deploy/pilot/restore-check.sh' < <закрытый ключ>"
echo "BACKUP GREEN: последняя копия repracer-${newest}; вне сервера — ${where}; восстановление проверено на repracer-${checked}"
