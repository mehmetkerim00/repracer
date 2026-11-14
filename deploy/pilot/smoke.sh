#!/usr/bin/env bash
# Шаг 124 [Р-248]: проверка выкладки пилота — какая сборка работает у каждого процесса, страж боевых записей, ClickHouse, панель только на loopback, а снаружи —
# консоль через туннель. Красное — с причиной и кодом выхода 1.
#   deploy/pilot/smoke.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
C="${here}/compose.sh"
set -a; . "${here}/pilot.env"; set +a
want="$(sed -n 's/^REPRACER_BUILD_SHA=//p' "${here}/build.env")"
fail() { echo "PILOT SMOKE RED: $*" >&2; exit 1; }
health() { curl -sf "http://127.0.0.1:$1/healthz" || fail "$2 не отвечает на /healthz (порт $1)"; }
console="$(health 9467 консоль)"
grep -q "${want}" <<< "${console}" || fail "консоль работает не той сборкой: ${console}"
curl -sf http://127.0.0.1:4319/api/session | grep -q "\"sha\":\"${want}\"" || fail "сессия страницы называет другую сборку"
for p in "9464 планировщик" "9473 исполнитель-заданий" "9471 панель"; do
  set -- ${p}
  grep -q "^build ${want} " <<< "$(health "$1" "$2")" || fail "$2 работает не той сборкой"
done
# Панель — только loopback [Р-165]
if ss -ltn | awk '{print $4}' | grep -E ':(4327|9471)$' | grep -vq '^127\.0\.0\.1:'; then fail "панель слушает не только loopback"; fi
guard="$("${C}" exec -T -u postgres postgres psql -X -d "${REPRACER_PILOT_DB}" -Atc 'SELECT security.live_writes_forbidden()')"
case "${guard}" in
  t) echo "страж P0-09: боевые записи запрещены (Р-247)" ;;
  f) echo "ВНИМАНИЕ: боевые записи на базе пилота разрешены — страж снят по процедуре README, §6" ;;
  *) fail "страж базы не ответил: ${guard}" ;;
esac
# Шаг 126: копии базы — сервис идёт, первая копия снимается при его старте (ждём её до 5 минут, у R2 — и выноса), дальше — backup-state.sh: свежая
# копия, вынесена с сервера, одна из хранимых проверена восстановлением. Первая выкладка здесь красная, пока не сделаны вынос и проверка (README, «Копии базы»)
"${C}" ps --services --status running | grep -qx backup || fail "сервис копий backup не работает"
for _ in $(seq 1 60); do
  ls "${REPRACER_BACKUP_DIR}"/repracer-*.sha256 > /dev/null 2>&1 && { [ "${REPRACER_BACKUP_OFFSITE}" != r2 ] || ls "${REPRACER_BACKUP_DIR}"/repracer-*.offsite > /dev/null 2>&1; } && break
  sleep 5
done
"${here}/backup-state.sh" "${REPRACER_BACKUP_DIR}" "${REPRACER_BACKUP_OFFSITE}" || fail "копии базы не в порядке — строка BACKUP RED выше"
tables="$("${C}" exec -T clickhouse clickhouse-client --query "SELECT count() FROM system.tables WHERE database = 'repracer_analytics'")"
[ "${tables}" -gt 0 ] || fail "в ClickHouse нет таблиц repracer_analytics — DDL не применён"
"${C}" ps --services --status running | grep -qE '^(worker|redpanda|kafka)$' && fail "в пилоте поднят брокер или диспетчер — пилот в тени, их здесь нет"
code="$(curl -s -o /dev/null -w '%{http_code}' "https://${REPRACER_PILOT_HOST}/healthz")"
[ "${code}" = 200 ] || fail "https://${REPRACER_PILOT_HOST}/healthz снаружи отвечает ${code} — туннель или DNS (README, §3)"
echo "PILOT SMOKE GREEN: сборка ${want}, снаружи — https://${REPRACER_PILOT_HOST}"
