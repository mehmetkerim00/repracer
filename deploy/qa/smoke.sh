#!/usr/bin/env bash
# Шаг 121 (QA-A): проверка выкладки — какая сборка работает, страница и API, исполнитель заданий, страж базы, демо, а снаружи — что без входа
# Access консоль не отдаёт. Красное — с причиной и кодом выхода 1.
#   deploy/qa/smoke.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
C="${here}/compose.sh"
set -a; . "${here}/qa.env"; set +a
want="$(sed -n 's/^REPRACER_BUILD_SHA=//p' "${here}/build.env")"
fail() { echo "SMOKE RED: $*" >&2; exit 1; }
base=http://127.0.0.1:4318
health="$(curl -sf "${base}/healthz")" || fail "стенд не отвечает на /healthz"
grep -q "\"sha\":\"${want}\"" <<< "${health}" || fail "стенд работает не той сборкой: ${health}"
curl -sf "${base}/" | grep -q 'id="root"' || fail "стенд не отдаёт собранную страницу (deploy/qa/deploy.sh собирает её)"
curl -sf "${base}/api/session" | grep -q "\"sha\":\"${want}\"" || fail "сессия страницы называет другую сборку"
bulk="$("${C}" exec -T bulk-worker node -e "fetch('http://127.0.0.1:9473/healthz').then(r => r.text()).then((t) => process.stdout.write(t))")" \
  || fail "исполнитель заданий не отвечает"
grep -q "^build ${want} " <<< "${bulk}" || fail "исполнитель заданий работает не той сборкой: ${bulk}"
guard="$("${C}" exec -T postgres psql -U postgres -d repracer_qa -Atc 'SELECT security.live_writes_forbidden()')"
[ "${guard}" = t ] || fail "база QA не закрыта стражем P0-09 — deploy/production/README.md §4б"
# Демо: вход имитатором владельцем — три рабочих пространства, все с пометкой демо. Токен в вывод не попадает
token="$(curl -sf -X POST -H 'content-type: application/json' -d '{"role":"OWNER"}' "${base}/api/stand-issuer/token" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
[ -n "${token}" ] || fail "вход имитатором не выдал токен"
demos="$(curl -sf -H "authorization: Bearer ${token}" "${base}/api/worlds" | grep -o '"demo":true' | wc -l | tr -d ' ')"
[ "${demos}" -ge 3 ] || fail "демо-пространств ${demos}, ждали 3"
# Снаружи: без входа Access уводит на свою страницу входа, а не отдаёт консоль
if [ -n "${QA_PUBLIC_URL:-}" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "${QA_PUBLIC_URL}/")"
  where="$(curl -sI "${QA_PUBLIC_URL}/" | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')"
  case "${code}" in
    302|303) grep -q 'cloudflareaccess.com' <<< "${where}" || fail "${QA_PUBLIC_URL} уводит не на вход Access: ${where}" ;;
    *) fail "${QA_PUBLIC_URL} без входа отвечает ${code} — Access не закрывает страницу" ;;
  esac
  echo "снаружи: ${QA_PUBLIC_URL} без входа — на страницу входа Access"
else
  echo "QA_PUBLIC_URL не задан в qa.env — проверка снаружи пропущена"
fi
echo "SMOKE GREEN: сборка ${want}, страж P0-09 стоит, демо-пространств ${demos}"
