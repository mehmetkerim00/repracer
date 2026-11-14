#!/usr/bin/env bash
# Шаг 126: внутренняя половина deploy/pilot/restore-check.sh — в контейнере образа базы (gpg, psql, pg_restore, initdb). Закрытый ключ — стандартный ввод.
#   restore-check-inner.sh <каталог копий> [repracer-<время>]
# Без REPRACER_RESTORE_CHECK_ADMIN_URL поднимает свой временный PostgreSQL в /tmp (только сокет, без сети) и восстанавливает в него; с ней — в названный
# кластер (так его гоняет тест сборки scripts/test/pilot-db.test.ts; восстановленную базу убирает тест). Последняя строка — JSON
# RESTORE_CHECK_DONE; отказ — строкой RESTORE_CHECK_FAILED с причиной и кодом 1.
set -euo pipefail
DIR="${1:?usage: restore-check-inner.sh <backup dir> [repracer-STAMP]}"
NAME="${2:-}"
here="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "{\"event\":\"RESTORE_CHECK_FAILED\",\"reason\":\"$*\"}" >&2; exit 1; }
export GNUPGHOME="$(mktemp -d)"
chmod 700 "${GNUPGHOME}"
trap 'rm -rf "${GNUPGHOME}"; [ -n "${OWN:-}" ] && gosu postgres pg_ctl -D /tmp/pg -m immediate stop > /dev/null 2>&1 || true' EXIT
gpg --batch --no-tty --quiet --import 2> /dev/null || fail "закрытый ключ не прочитан со стандартного ввода"
gpg --batch --no-tty --list-secret-keys 2> /dev/null | grep -q '^sec' || fail "на стандартном вводе нет закрытого ключа"

if [ -z "${NAME}" ]; then
  NAME="$(ls -1 "${DIR}" | sed -n 's/^\(repracer-[0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort | tail -1)"
  [ -n "${NAME}" ] || fail "в ${DIR} нет готовых копий"
fi

ADMIN="${REPRACER_RESTORE_CHECK_ADMIN_URL:-}"
if [ -z "${ADMIN}" ]; then
  OWN=1
  mkdir -p /tmp/pg && chown postgres /tmp/pg
  gosu postgres initdb -D /tmp/pg -U postgres --auth=trust -E UTF8 > /dev/null || fail "initdb временного кластера"
  gosu postgres pg_ctl -D /tmp/pg -o "-c listen_addresses='' -k /tmp" -l /tmp/pg.log -w start > /dev/null || fail "временный кластер не стартовал"
  ADMIN="postgresql://postgres@/postgres?host=/tmp"
fi

# Тот же скрипт, что при настоящей беде: суммы, расшифровка, роли, pg_restore --create с настройками базы, секции, регион
done_line="$(REPRACER_RESTORE_ADMIN_URL="${ADMIN}" bash "${here}/../production/restore.sh" "${DIR}" "${NAME}" | tail -1)" || fail "restore.sh не восстановил ${NAME}"
db="$(sed -n 's/.*"database":"\([a-z][a-z0-9_]*\)".*/\1/p' <<< "${done_line}")"
region="$(sed -n 's/.*"region":"\([A-Z]*\)".*/\1/p' <<< "${done_line}")"
[ -n "${db}" ] || fail "restore.sh не назвал базу: ${done_line}"
want="${REPRACER_PILOT_REGION:-US}"
[ "${region}" = "${want}" ] || fail "регион восстановленной базы ${region}, а у пилота ${want}"
base="${ADMIN%%\?*}"
query=""
[[ "${ADMIN}" == *\?* ]] && query="?${ADMIN#*\?}"
DB_URL="${base%/postgres}/${db}${query}"
q() { psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "$2"; }
# Страж боевых записей [Р-247] — настройка БАЗЫ: копия, потерявшая её, подняла бы пилот с разрешёнными боевыми записями
guard="$(q "${ADMIN}" "SELECT coalesce((SELECT substr(c, length('repracer.live_writes=') + 1) FROM pg_db_role_setting s CROSS JOIN LATERAL unnest(s.setconfig) c
  WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = '${db}') AND starts_with(c, 'repracer.live_writes=')), '')")"
case "${guard}" in
  forbidden|allowed) ;;
  *) fail "восстановленная база без явной настройки repracer.live_writes ('${guard}'): копия потеряла страж боевых записей (Р-247)" ;;
esac
[ "$(q "${DB_URL}" 'SELECT security.live_writes_forbidden()')" = "$([ "${guard}" = forbidden ] && echo t || echo f)" ] || fail "страж восстановленной базы отвечает не по своей настройке"
# Журнал миграций (scripts/db/migrate.sh) — тоже настройка базы: без него следующая выкладка не знала бы, что применено
journal="$(q "${DB_URL}" "SELECT current_setting('repracer.migrations', true)")"
[[ "${journal}" =~ ^[0-9]{4}: ]] || fail "у восстановленной базы нет журнала миграций repracer.migrations"
facts="$(q "${DB_URL}" "SELECT json_build_object('tenants', (SELECT count(*) FROM tenant_data.tenant), 'channelAccounts', (SELECT count(*) FROM tenant_data.channel_account),
  'offers', (SELECT count(*) FROM tenant_data.offer_mapping), 'credentials', (SELECT count(*) FROM tenant_data.channel_credential),
  'decisions', (SELECT count(*) FROM channel_data.price_decision), 'audit', (SELECT count(*) FROM audit.audit_event))")"
steps="$(sed -n 's/.*"stepsMs":\({[^}]*}\).*/\1/p' <<< "${done_line}")"
[ -n "${steps}" ] || steps='{}'
echo "{\"event\":\"RESTORE_CHECK_DONE\",\"copy\":\"${NAME}\",\"database\":\"${db}\",\"region\":\"${region}\",\"liveWrites\":\"${guard}\",\"migrationsThrough\":\"${journal%%:*}\",\"facts\":${facts},\"stepsMs\":${steps},\"checkedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
