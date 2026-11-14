#!/usr/bin/env bash
# Шаг 126 (решение владельца: «копия без проверенного восстановления копией не считается»): проверка восстановления копии пилота. На сервере, в одноразовом
# контейнере образа базы без сети: закрытый ключ владельца — со стандартного ввода во временную память контейнера, рядом — пустой временный PostgreSQL, и
# копия восстанавливается в него ТЕМ ЖЕ скриптом, что при настоящей беде (deploy/production/restore.sh). Затем — что восстановлено: регион, страж боевых
# записей [Р-247], журнал миграций и числа. Живая база не трогается; на диск сервера не пишется ничего, кроме отметки проверки рядом с копией.
#   на машине владельца:
#   ssh deploy@<сервер> 'cd /srv/repracer && deploy/pilot/restore-check.sh [repracer-<ГГГГММДДTччммссZ>]' < "$HOME/.config/repracer/secrets/pilot-backup-private.asc"
# Без имени — последняя готовая копия. Отметка `repracer-<время>.restore-checked` — её требует deploy/pilot/smoke.sh у одной из хранимых копий: проверять
# не реже раза в 7 суток (срок хранения копий) и после каждой смены ключа.
set -euo pipefail
cd "$(dirname "$0")/../.."
set -a; . deploy/pilot/pilot.env; set +a
DIR="${REPRACER_BACKUP_DIR:?set REPRACER_BACKUP_DIR in pilot.env}"
[ -t 0 ] && { echo "закрытый ключ копий — на стандартный ввод (см. шапку скрипта)" >&2; exit 2; }
NAME="${1:-}"
[ -z "${NAME}" ] || [[ "${NAME}" =~ ^repracer-[0-9]{8}T[0-9]{6}Z$ ]] || { echo "имя копии — repracer-<ГГГГММДДTччммссZ>" >&2; exit 2; }
IMAGE="$(awk '/^  postgres:/{f=1} f && /image:/{print $2; exit}' deploy/pilot/compose.yaml)"
out="$(docker run --rm -i --network none --tmpfs /tmp -e REPRACER_PILOT_REGION="${REPRACER_PILOT_REGION:-US}" \
  -v "${PWD}":/repo:ro -v "${DIR}":/backups:ro "${IMAGE}" bash /repo/deploy/pilot/restore-check-inner.sh /backups "${NAME}")" \
  || { echo "RESTORE CHECK RED: восстановление копии не прошло — причина в строке выше" >&2; exit 1; }
line="$(tail -1 <<< "${out}")"
copy="$(sed -n 's/.*"copy":"\(repracer-[0-9]\{8\}T[0-9]\{6\}Z\)".*/\1/p' <<< "${line}")"
[ -n "${copy}" ] || { echo "RESTORE CHECK RED: проверка не назвала копию: ${line}" >&2; exit 1; }
printf '%s\n' "${line}" > "${DIR}/${copy}.restore-checked"
echo "RESTORE CHECK GREEN: ${line}"
