#!/usr/bin/env bash
# Шаг 131 (решение владельца 2026-11-15, п. 3.3): внутренняя половина отката через миграцию (deploy/pilot/rollback.sh). На сервере идёт в одноразовом контейнере
# сервиса backup (образ базы: gpg, psql, pg_restore) и подключается к живому PostgreSQL пилота суперпользователем; закрытый ключ владельца — стандартный ввод.
#   rollback-inner.sh <каталог копий> <SHA версии, к которой откат | repracer-<время>>
# Что делает:
#   1) находит копию: по SHA — самую свежую с отметкой `.pre-release`, снятую при уходе с этой версии (deploy/pilot/pre-release-copy.sh); или копию по имени;
#   2) ДО того как тронуть живую базу — суммы копии и закрытый ключ (расшифровка ролей): чужой ключ или испорченная копия — отказ, база как была;
#   3) живую базу не удаляет, а переименовывает в `<база>_rb_<время копии>` — разобраться потом, что было записано после копии;
#   4) восстанавливает копию тем же deploy/production/restore.sh, что при беде: роли, база с настройками (регион, журнал миграций, страж боевых записей),
#      пароли ролей из строк подключения, секции;
#   5) проверяет регион, страж [Р-247] и журнал миграций (по отметке — та миграция, на которой база стояла до выкладки).
# Провал после переименования — частично восстановленная база удаляется, прежняя возвращается на место: «как было».
# Переменные: REPRACER_PILOT_DB, REPRACER_PILOT_REGION; REPRACER_ROLLBACK_ADMIN_URL — суперпользователь, база postgres (иначе выводится из PGURL_FILE сервиса
# backup); REPRACER_RESTORE_SECRETS_DIR — строки подключения ролей. Последняя строка — JSON ROLLBACK_RESTORED; отказ — ROLLBACK_FAILED с причиной и кодом 1.
set -euo pipefail
DIR="${1:?usage: rollback-inner.sh <backup dir> <target sha | repracer-STAMP>}"
WHAT="${2:?usage: rollback-inner.sh <backup dir> <target sha | repracer-STAMP>}"
here="$(cd "$(dirname "$0")" && pwd)"
DB="${REPRACER_PILOT_DB:?set REPRACER_PILOT_DB}"
REGION="${REPRACER_PILOT_REGION:-US}"
[[ "${DB}" =~ ^[a-z][a-z0-9_]{0,40}$ ]] || { echo '{"event":"ROLLBACK_FAILED","reason":"REPRACER_PILOT_DB — строчные буквы, цифры и _, до 41 знака"}' >&2; exit 2; }
fail() { echo "{\"event\":\"ROLLBACK_FAILED\",\"reason\":\"$*\"}" >&2; exit 1; }
ADMIN="${REPRACER_ROLLBACK_ADMIN_URL:-}"
if [ -z "${ADMIN}" ]; then
  [ -r "${PGURL_FILE:-}" ] || fail "нет REPRACER_ROLLBACK_ADMIN_URL и PGURL_FILE — подключение суперпользователя"
  url="$(tr -d '\r\n' < "${PGURL_FILE}")"
  ADMIN="${url%/*}/postgres"
fi
q() { psql -X -At -v ON_ERROR_STOP=1 -d "${ADMIN}" -c "$1"; }

export GNUPGHOME="$(mktemp -d)"
chmod 700 "${GNUPGHOME}"
WORK="$(mktemp -d)"
ASIDE=""
RESTORING=0
cleanup() {
  rm -rf "${GNUPGHOME}" "${WORK}"
  # Провал посреди восстановления — «как было»: частичная база уходит, прежняя возвращается на своё имя
  if [ "${RESTORING}" = 1 ] && [ -n "${ASIDE}" ]; then
    q "DROP DATABASE IF EXISTS ${DB} WITH (FORCE)" > /dev/null 2>&1 || true
    q "ALTER DATABASE ${ASIDE} RENAME TO ${DB}" > /dev/null 2>&1 \
      && echo "{\"event\":\"ROLLBACK_UNDONE\",\"database\":\"${DB}\",\"reason\":\"restore failed — the live database is back as it was\"}" >&2 \
      || echo "{\"event\":\"ROLLBACK_UNDONE_FAILED\",\"database\":\"${DB}\",\"aside\":\"${ASIDE}\",\"reason\":\"rename ${ASIDE} back to ${DB} by hand\"}" >&2
  fi
}
trap cleanup EXIT
gpg --batch --no-tty --quiet --import 2> /dev/null || fail "закрытый ключ не прочитан со стандартного ввода"
gpg --batch --no-tty --list-secret-keys 2> /dev/null | grep -q '^sec' || fail "на стандартном вводе нет закрытого ключа"

# 1) какая копия
MIG=""
if [[ "${WHAT}" =~ ^repracer-[0-9]{8}T[0-9]{6}Z$ ]]; then
  NAME="${WHAT}"
  [ ! -r "${DIR}/${NAME}.pre-release" ] || MIG="$(sed -n 's/.*"migrationsBefore":"\([0-9]\{4\}\)".*/\1/p' "${DIR}/${NAME}.pre-release")"
elif [[ "${WHAT}" =~ ^[0-9a-f]{40}$ ]]; then
  NAME=""
  for m in $(ls -1 "${DIR}" | grep -E '^repracer-[0-9]{8}T[0-9]{6}Z\.pre-release$' | sort -r); do
    grep -q "\"before\":\"${WHAT}\"" "${DIR}/${m}" || continue
    NAME="${m%.pre-release}"
    MIG="$(sed -n 's/.*"migrationsBefore":"\([0-9]\{4\}\)".*/\1/p' "${DIR}/${m}")"
    break
  done
  [ -n "${NAME}" ] || fail "нет копии перед выкладкой, снятой при уходе с версии ${WHAT:0:12}: назовите копию явно (repracer-<время>) — потеряется всё после неё"
else
  fail "откат — к SHA версии (40 знаков) или к копии repracer-<время>"
fi
[ -s "${DIR}/${NAME}.sha256" ] || fail "копии ${NAME} нет в ${DIR} (срок хранения — 7 суток)"

# 2) копия и ключ — до того, как тронуть живую базу
sha() { if command -v sha256sum > /dev/null; then sha256sum "$@" | awk '{print $1}'; else shasum -a 256 "$@" | awk '{print $1}'; fi; }
[ "$(tr -d ' \r' < "${DIR}/${NAME}.sha256")" = "$(sha "${DIR}/${NAME}.dump.gpg" "${DIR}/${NAME}.globals.sql.gpg" | tr -d ' ')" ] \
  || fail "суммы копии ${NAME} не сходятся — живая база не тронута"
gpg --batch --no-tty --quiet --output "${WORK}/globals.sql" --decrypt "${DIR}/${NAME}.globals.sql.gpg" 2> /dev/null \
  || fail "копия ${NAME} не открывается этим ключом — живая база не тронута"
[ "$(q "SELECT count(*) FROM pg_database WHERE datname = '${DB}'")" = 1 ] || fail "живой базы ${DB} нет — это не откат, а восстановление после беды (docs/runbook-disaster.md)"

# 3) живая база — в сторону, под своим именем с временем копии
stamp="$(tr 'TZ' 'tz' <<< "${NAME#repracer-}")"
ASIDE="${DB}_rb_${stamp}"
[ "$(q "SELECT count(*) FROM pg_database WHERE datname = '${ASIDE}'")" = 0 ] || fail "база ${ASIDE} уже есть — прежний откат к этой копии не разобран: удалите её или переименуйте"
q "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB}' AND pid <> pg_backend_pid()" > /dev/null
q "ALTER DATABASE ${DB} RENAME TO ${ASIDE}" > /dev/null || fail "живая база ${DB} не переименована (к ней подключены?) — ничего не менялось"
# Только ПОСЛЕ удавшегося переименования: уборка удаляет базу под именем ${DB}, и до этой строки это была бы живая база
RESTORING=1

# 4) копия — тем же скриптом, что при беде
done_line="$(REPRACER_RESTORE_ADMIN_URL="${ADMIN}" bash "${here}/../production/restore.sh" "${DIR}" "${NAME}" | tail -1)" || fail "restore.sh не восстановил ${NAME}"
restored="$(sed -n 's/.*"database":"\([a-z][a-z0-9_]*\)".*/\1/p' <<< "${done_line}")"
[ "${restored}" = "${DB}" ] || fail "копия ${NAME} — другой базы (${restored}), а откат — базы ${DB}"

# 5) что восстановлено: регион, страж, журнал
base="${ADMIN%%\?*}"
query=""
[[ "${ADMIN}" == *\?* ]] && query="?${ADMIN#*\?}"
DB_URL="${base%/postgres}/${DB}${query}"
region="$(psql -X -At -d "${DB_URL}" -c "SELECT current_setting('repracer.region', true)")"
[ "${region}" = "${REGION}" ] || fail "регион восстановленной базы ${region}, а у пилота ${REGION}"
guard="$(q "SELECT coalesce((SELECT substr(c, length('repracer.live_writes=') + 1) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
  WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '${DB}') AND starts_with(c, 'repracer.live_writes=')), '')")"
case "${guard}" in forbidden|allowed) ;; *) fail "восстановленная база без явной настройки repracer.live_writes ('${guard}') — страж боевых записей потерян (Р-247)" ;; esac
journal="$(psql -X -At -d "${DB_URL}" -c "SELECT current_setting('repracer.migrations', true)")"
[[ "${journal}" =~ ^[0-9]{4}: ]] || fail "у восстановленной базы нет журнала миграций"
[ -z "${MIG}" ] || [ "${journal%%:*}" = "${MIG}" ] || fail "журнал восстановленной базы — ${journal%%:*}, а отметка копии называет ${MIG}"
RESTORING=0
echo "{\"event\":\"ROLLBACK_RESTORED\",\"copy\":\"${NAME}\",\"database\":\"${DB}\",\"aside\":\"${ASIDE}\",\"region\":\"${region}\",\"liveWrites\":\"${guard}\",\"migrationsThrough\":\"${journal%%:*}\"}"
