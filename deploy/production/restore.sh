#!/bin/bash
# Шаг 65: восстановление из зашифрованной копии на ЧИСТОМ сервере — команды docs/runbook-disaster.md одним скриптом. Скрипт гоняет и
# учение восстановления в сборке (packages/pricing-store-pg/test/disaster-recovery.pg.test.ts): команды, проверенные тестом, а не абзацем.
#
# Использование (на новом сервере, с закрытым ключом владельца в GNUPGHOME):
#   REPRACER_RESTORE_ADMIN_URL=postgres://<суперпользователь>@<хост>:5432/postgres \
#   REPRACER_RESTORE_SECRETS_DIR=/srv/repracer/secrets \
#   [REPRACER_RESTORE_LOGS_DIR=/srv/repracer/archive/platform=logs] \
#   deploy/production/restore.sh /путь/к/копиям repracer-<ГГГГММДДTччммссZ>
#
# Что делает, по шагам (каждый — со временем в отчёте):
#   1) сверяет SHA-256 обоих файлов копии с файлом сумм (порча или подмена при выносе — отказ до расшифровки);
#   2) расшифровывает копию и роли закрытым ключом во временный каталог (права 700, удаляется при любом выходе);
#   3) роли кластера — из копии ролей (без паролей); «уже существует» — не ошибка, любая другая — отказ;
#   4) базу — `pg_restore --create`: с именем, владельцем и НАСТРОЙКАМИ базы (регион `repracer.region` — без него база не заводит ни
#      одного тенанта); без `--no-owner`: владение функциями и FORCE RLS — часть модели прав;
#   5) пароли ролей — из строк подключения в файлах секретов (`*pg_url*`): копия ролей паролей не несёт, источник паролей — секреты;
#   6) секции на ближайшие сутки — копия до 7 суток старше, а запас секций — 3 суток;
#   7) проверяет регион базы и печатает отчёт строкой JSON;
#   8) если задан каталог месячных архивов журналов — сверяет их суммы, проверяет gzip и печатает удаления eBay из журналов (риск 36:
#      восстановление их откатывает, повторить — вручную по deploy/production/README.md §4).
# Пароли и строки подключения в вывод не попадают.
set -euo pipefail

DIR="${1:?usage: restore.sh <backup dir> <repracer-STAMP>}"
NAME="${2:?usage: restore.sh <backup dir> <repracer-STAMP>}"
ADMIN_URL="${REPRACER_RESTORE_ADMIN_URL:?set REPRACER_RESTORE_ADMIN_URL (superuser, database postgres)}"
# Параметры строки (`?sslmode=require` у управляемого хостинга) сохраняются: база — путь до `?`, параметры — после
ADMIN_BASE="${ADMIN_URL%%\?*}"
ADMIN_QUERY=""
[[ "$ADMIN_URL" == *\?* ]] && ADMIN_QUERY="?${ADMIN_URL#*\?}"
[[ "$ADMIN_BASE" == */postgres ]] || { echo '{"event":"RESTORE_FAILED","step":"config","reason":"REPRACER_RESTORE_ADMIN_URL must name the database postgres"}' >&2; exit 1; }
SECRETS="${REPRACER_RESTORE_SECRETS_DIR:-}"
LOGS="${REPRACER_RESTORE_LOGS_DIR:-}"
DUMP_GPG="$DIR/$NAME.dump.gpg"
GLOBALS_GPG="$DIR/$NAME.globals.sql.gpg"
SUMS="$DIR/$NAME.sha256"

WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
# Любой отказ — строкой RESTORE_FAILED с местом, а не молчаливым выходом `set -e` (ревью шага 65)
CURRENT_STEP=start
trap 'echo "{\"event\":\"RESTORE_FAILED\",\"step\":\"$CURRENT_STEP\",\"reason\":\"command failed at line $LINENO\"}" >&2' ERR
# Миллисекунды — perl: он есть и на сервере, и на машине владельца; `date +%N` у macOS нет, node на хосте может не быть
now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time * 1000'; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@" | awk '{print $1}'; else shasum -a 256 "$@" | awk '{print $1}'; fi; }
STEPS=""
step() { STEPS="$STEPS${STEPS:+,}\"$1\":$(( $(now_ms) - $2 ))"; }
fail() { trap - ERR; echo "{\"event\":\"RESTORE_FAILED\",\"step\":\"$1\",\"reason\":\"$2\"}" >&2; exit 1; }

# 1) суммы
CURRENT_STEP=sums
T="$(now_ms)"
[[ -r "$DUMP_GPG" && -r "$GLOBALS_GPG" && -r "$SUMS" ]] || fail sums "copy files are missing: $NAME.{dump.gpg,globals.sql.gpg,sha256}"
EXPECTED="$(tr -d ' \r' < "$SUMS")"
ACTUAL="$(sha "$DUMP_GPG" "$GLOBALS_GPG" | tr -d ' ')"
[[ "$EXPECTED" == "$ACTUAL" ]] || fail sums "SHA-256 of the copy does not match $NAME.sha256"
step sums "$T"

# 2) расшифровка закрытым ключом владельца
CURRENT_STEP=decrypt
T="$(now_ms)"
gpg --batch --no-tty --quiet --output "$WORK/db.dump" --decrypt "$DUMP_GPG" || fail decrypt "the copy does not decrypt with the key in GNUPGHOME"
gpg --batch --no-tty --quiet --output "$WORK/globals.sql" --decrypt "$GLOBALS_GPG" || fail decrypt "the roles copy does not decrypt"
[[ "$(head -c 5 "$WORK/db.dump")" == "PGDMP" ]] || fail decrypt "the decrypted copy is not a pg_dump archive"
step decrypt "$T"

# 3) роли кластера: ошибки «уже существует» — не ошибки (на сервере могут быть встроенные роли и роли прошлой попытки)
CURRENT_STEP=roles
T="$(now_ms)"
psql -X -q -d "$ADMIN_URL" -v ON_ERROR_STOP=0 -f "$WORK/globals.sql" > "$WORK/globals.out" 2> "$WORK/globals.err" || true
# В файл, а не `| grep -q`: ранний выход grep -q при pipefail сделал бы проверку ложной на большом выводе (ревью шага 65)
{ grep -E 'ERROR' "$WORK/globals.err" | grep -Ev 'already exists' > "$WORK/globals.bad"; } || true
[[ -s "$WORK/globals.bad" ]] && fail roles "$(head -1 "$WORK/globals.bad" | tr '"' "'")"
step roles "$T"

# 4) база: --create — с именем, владельцем и настройками базы (регион); без --no-owner
CURRENT_STEP=restore
T="$(now_ms)"
pg_restore --create --exit-on-error --dbname "$ADMIN_URL" "$WORK/db.dump" 2> "$WORK/restore.err" || fail restore "$(head -1 "$WORK/restore.err" | tr '"' "'")"
# awk читает оглавление целиком: ранний выход закрыл бы канал, pg_restore получил бы SIGPIPE, и pipefail уронил бы скрипт молча
DB="$(pg_restore --list "$WORK/db.dump" | awk -F': ' '/^; *dbname:/ && d == "" { d = $2 } END { print d }')"
[[ -n "$DB" ]] || fail restore "the database name is not in the copy"
DB_URL="${ADMIN_BASE%/postgres}/$DB$ADMIN_QUERY"
step restore "$T"

# 5) пароли ролей — из строк подключения в секретах; значение в psql передаётся переменной, не текстом команды
CURRENT_STEP=passwords
T="$(now_ms)"
# Переменные psql подставляются в SQL из ФАЙЛА, а не из `-c` (там текст уходит серверу как есть — ревью шага 65, находка 1)
printf '%s\n' "ALTER ROLE :\"role\" PASSWORD :'pw';" > "$WORK/password.sql"
ROLES_SET=0
if [[ -n "$SECRETS" ]]; then
  for f in "$SECRETS"/*pg_url*; do
    [[ -f "$f" ]] || continue
    URL="$(tr -d '\r\n' < "$f")"
    [[ "$URL" =~ ^postgres(ql)?://([^:@/]+):([^@]+)@ ]] || continue
    ROLE="${BASH_REMATCH[2]}"
    # Пароль в строке подключения может быть закодирован процентами — раскодируется до передачи в psql
    PASS="$(printf '%b' "${BASH_REMATCH[3]//%/\\x}")"
    [[ "$ROLE" =~ ^[a-z_][a-z0-9_]*$ ]] || fail passwords "unexpected role name in $(basename "$f")"
    printf '%s' "$PASS" | psql -X -q -d "$ADMIN_URL" -v ON_ERROR_STOP=1 -v role="$ROLE" -c '\set pw `cat`' -f "$WORK/password.sql" > /dev/null \
      || fail passwords "ALTER ROLE failed for $ROLE"
    ROLES_SET=$((ROLES_SET + 1))
  done
fi
step passwords "$T"

# 6) секции на ближайшие сутки — ролью планировщика, как это делает его работа `partitions`
CURRENT_STEP=partitions
T="$(now_ms)"
psql -X -q -d "$DB_URL" -v ON_ERROR_STOP=1 -c 'SET ROLE svc_scheduler' -c 'SELECT maintenance.ensure_partitions(now())' > /dev/null || fail partitions "ensure_partitions failed"
step partitions "$T"

# 7) регион базы: без него `tenant_region_guard` отказывает при создании любого тенанта
CURRENT_STEP=region
REGION="$(psql -X -At -d "$DB_URL" -c "SELECT current_setting('repracer.region', true)")" || fail region "the restored database does not answer"
[[ "$REGION" == "EU" || "$REGION" == "US" ]] || fail region "repracer.region is '$REGION' after the restore"

# 8) месячные архивы журналов: суммы, целостность gzip, удаления eBay — повторить вручную (риск 36)
ARCHIVES=0
DELETIONS=0
# Повторять — только удаления ПОСЛЕ снятия копии: строки журнала несут время (`--timestamps` у logs-archive.sh); строка без времени — тоже
STAMP_ISO="$(echo "$NAME" | sed -E 's/^repracer-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3T\4:\5:\6/')"
if [[ -n "$LOGS" && -d "$LOGS" ]]; then
  CURRENT_STEP=logs
  T="$(now_ms)"
  while IFS= read -r -d '' gz; do
    [[ -r "$gz.sha256" ]] || fail logs "no SHA-256 for $(basename "$gz")"
    [[ "$(tr -d ' \r\n' < "$gz.sha256" | cut -c1-64)" == "$(sha "$gz")" ]] || fail logs "SHA-256 mismatch: $(basename "$gz")"
    gzip -t "$gz" || fail logs "broken archive: $(basename "$gz")"
    ARCHIVES=$((ARCHIVES + 1))
    # В файл, а не `| grep -q`: при pipefail ранний выход grep -q отдаёт gzip SIGPIPE, и удаления терялись молча (ревью шага 65, находка 5)
    { gzip -dc "$gz" | grep 'EBAY_DELETION_APPLIED' > "$WORK/deletions"; } || true
    awk -v since="$STAMP_ISO" 'match($0, /[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/) { if (substr($0, RSTART, RLENGTH) < since) next } { print }' \
      "$WORK/deletions" > "$WORK/deletions.after"
    if [[ -s "$WORK/deletions.after" ]]; then
      DELETIONS=$((DELETIONS + $(wc -l < "$WORK/deletions.after" | tr -d ' ')))
      cat "$WORK/deletions.after" >&2
    fi
  done < <(find "$LOGS" -name '*.log.gz' -type f -print0)
  step logs "$T"
fi

# Копия ролей паролей не несёт: без строк подключения с паролями роли входа остались без паролей — сказать это прямо
CURRENT_STEP=done
WARN=""
[[ "$ROLES_SET" -eq 0 ]] && WARN=",\"warning\":\"no role password was set: the roles copy has none, give REPRACER_RESTORE_SECRETS_DIR with connection strings\""
echo "{\"event\":\"RESTORE_DONE\",\"database\":\"$DB\",\"region\":\"$REGION\",\"rolesWithPassword\":$ROLES_SET,\"logArchives\":$ARCHIVES,\"ebayDeletionsToRedo\":$DELETIONS,\"stepsMs\":{$STEPS}$WARN}"
