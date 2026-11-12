#!/usr/bin/env bash
# Шаг 121 (QA-A): сброс тестовых данных — база QA заново (scripts/qa-reset.sh внутри контейнера базы), процессы заново, демо сеет стенд при
# подъёме. Страховка — ДО остановки чего-либо: на базе без стража P0-09 (repracer.live_writes) сброс отказывает, и работающий стенд не
# трогается. После пересоздания страж ставится снова до того, как стенд подключится.
#   deploy/qa/reset.sh [--first-time]        (около 6 минут; Мердан — `ssh … reset`, deploy/qa/ssh-gate.sh)
#
# Шаг 121.3: сброс переживает обрыв SSH — идёт в фоне под журналом (deploy/qa/state/reset.log), один за раз (deploy/qa/detach.sh);
# этот вызов показывает журнал до конца и выходит кодом сброса. Повтор во время сброса показывает тот же журнал, а не запускает второй
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
[ "${QA_RESET_DETACHED:-}" = 1 ] || exec "${here}/detach.sh" reset env QA_RESET_DETACHED=1 "${here}/reset.sh" "$@"
C="${here}/compose.sh"
DB=repracer_qa
FIRST=()
[ "${1:-}" = "--first-time" ] && FIRST=(--first-time)
in_db() { "${C}" exec -T -e PGHOST=127.0.0.1 -e PGUSER=postgres "$@"; }
SECONDS=0
"${C}" up -d --wait postgres
echo "== проверка стража базы ${DB}"
in_db -e QA_RESET_CHECK_ONLY=1 postgres bash /repo/scripts/qa-reset.sh "${DB}" ${FIRST[@]+"${FIRST[@]}"}
"${C}" stop stand bulk-worker cloudflared
in_db postgres bash /repo/scripts/qa-reset.sh "${DB}" ${FIRST[@]+"${FIRST[@]}"}
echo "== стенд, исполнитель заданий, туннель (демо сеется при подъёме — минуты)"
"${C}" up -d --wait stand bulk-worker cloudflared
for _ in $(seq 1 120); do
  n="$("${C}" exec -T postgres psql -U postgres -d "${DB}" -Atc \
    "SELECT count(*) FROM channel_data.price_decision WHERE tenant_id IN (SELECT tenant_id FROM tenant_data.tenant WHERE demo)" 2> /dev/null || echo 0)"
  [ "${n:-0}" -gt 0 ] && break
  sleep 5
done
echo "сброс готов за ${SECONDS} с: база ${DB} заново и закрыта стражем, демо приняло ${n:-0} решений"
