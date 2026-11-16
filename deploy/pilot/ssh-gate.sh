#!/usr/bin/env bash
# Шаг 141 (QA-B, решение владельца 2026-11-16): что может тестировщик по SSH на машине QA-B — ровно три команды, без оболочки, как у QA-A
# (deploy/qa/ssh-gate.sh). Ключ Мердана — в authorized_keys пользователя выкладки одной строкой (README, §12):
#   command="/srv/repracer/deploy/pilot/ssh-gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… merdan
# Вызов: ssh deploy@<машина QA-B> logs | reset | version
# Ставится только на QA-B: сброс базы пилота не бывает никогда. Шлюз сам отказывает в сбросе, если pilot.env говорит не qa-b, ничего не запуская;
# дальше — reset.sh и db.sh со своими проверками отметки стенда.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
case "${SSH_ORIGINAL_COMMAND:-}" in
  logs)
    "${here}/compose.sh" logs --no-color --tail=500 console scheduler bulk-worker operator
    # Чем кончился последний сброс: после обрыва связи видно, нужен ли новый
    if [ -f "${here}/state/reset.log" ]; then
      echo "== последний сброс: $(if [ -f "${here}/state/reset.status" ]; then echo "завершён, код $(cat "${here}/state/reset.status")"; else echo "идёт или оборвался"; fi)"
      tail -n 30 "${here}/state/reset.log"
    fi
    ;;
  reset)
    stand="$(sed -n 's/^REPRACER_PILOT_STAND=//p' "${here}/pilot.env")"
    [ "${stand}" = qa-b ] || { echo "сброс — только QA-B: в pilot.env стенд «${stand:-pilot}»" >&2; exit 2; }
    # Сброс идёт в фоне под журналом и переживает обрыв SSH; повтор во время работы показывает её журнал, а не запускает вторую (шаг 121.3)
    QA_STATE_DIR="${here}/state" exec "${here}/../qa/detach.sh" reset "${here}/reset.sh"
    ;;
  version) exec sed -n -e 's/^REPRACER_BUILD_SHA=/sha /p' -e 's/^REPRACER_BUILD_AT=/at /p' "${here}/build.env" ;;
  *) echo "команды: logs | reset | version" >&2; exit 2 ;;
esac
