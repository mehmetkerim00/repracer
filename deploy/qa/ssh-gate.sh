#!/usr/bin/env bash
# Шаг 121 (QA-A): что может тестировщик по SSH — ровно три команды, без оболочки. Ключ Мердана в authorized_keys пользователя выкладки:
#   command="/srv/repracer/deploy/qa/ssh-gate.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA… merdan
# Вызов: ssh deploy@<сервер> logs | reset | version
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
case "${SSH_ORIGINAL_COMMAND:-}" in
  logs) exec "${here}/compose.sh" logs --no-color --tail=500 stand bulk-worker ;;
  reset) exec "${here}/reset.sh" ;;
  version) exec sed -n 's/^REPRACER_BUILD_\(SHA\|AT\)=/\L\1 /p' "${here}/build.env" ;;
  *) echo "команды: logs | reset | version" >&2; exit 2 ;;
esac
