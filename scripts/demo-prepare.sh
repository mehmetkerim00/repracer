#!/usr/bin/env bash
# Шаг 64: ОДНА команда подготовки демо-мира для показа клиенту (docs/demo-script.md).
#
# Что делает:
#   1. своя база `repracer_demo` (и свой шаблон) — тестовую базу `repracer_eu` и шаблон тестов не трогает;
#   2. стенд с демо-тенантом [Р-151] в ТЕНИ [Р-169] и с витринами США (eBay EBAY_US, Amazon amazon.com, USD) — `REPRACER_DEMO_US`;
#      шаг 68: витрины США СЧИТАЮТ тень (себестоимость, границы и стратегии в долларах), и неделя их тени ПРОЖИМАЕТСЯ при подъёме
#      (`REPRACER_DEMO_PRESS_DAYS`, по умолчанию 7): недельное письмо тени показуемо сразу, а не через неделю;
#    - шаг 69 (K1, K4): демо-тенант по-английски и в поясе клиента из США (`REPRACER_DEMO_LOCALE`, по умолчанию en;
#      `REPRACER_DEMO_TIME_ZONE`, по умолчанию America/Los_Angeles) — язык и пояс принадлежат тенанту, а не браузеру;
#   3. интерфейс консоли (vite) на 127.0.0.1:5173, API стенда — на 127.0.0.1:4318;
#   4. ждёт, пока демо-мир примет первые решения, и печатает, куда идти.
#
# Время демо-мира — НАСТОЯЩЕЕ (ревью шага 34, находка 9). Kaufland считает с момента запуска; витрины США — прожатая неделя до запуска
# (виртуальные часы прошлой недели, решения ложатся в прошлые сутки) и дальше настоящее время. Данные синтетические и так помечены.
# Запускайте заранее: прожатая неделя — около минуты, первые изменения цен Kaufland — через ~20 минут; база переживает перезапуск стенда
# только пересевом (новый тенант).
#
# Использование: PGHOST=127.0.0.1 PGPORT=5432 PGUSER=<суперпользователь> scripts/demo-prepare.sh
# Остановить: Ctrl+C (останавливает стенд и интерфейс). Данные синтетические, ключей каналов не нужно.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGUSER:=postgres}"
export PGHOST PGPORT PGUSER
DB=repracer_demo
STAND_PORT="${STAND_PORT:-4318}"
export STAND_PORT
LOGS="${TMPDIR:-/tmp}"
LOGS="${LOGS%/}/repracer-demo"
mkdir -p "${LOGS}"

echo "== база ${DB} (миграции и смоук-проверки схемы, несколько минут)"
REPRACER_PG_TEMPLATE=repracer_demo_template scripts/db/prepare.sh "${DB}" > "${LOGS}/prepare.log" 2>&1 \
  || { echo "подготовка базы не прошла — см. ${LOGS}/prepare.log"; exit 1; }

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2> /dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "== стенд с демо-тенантом (тень, витрины США) на 127.0.0.1:${STAND_PORT}"
STAND_IDENTITY=simulator REPRACER_PG_URL="postgres://svc_app@${PGHOST}:${PGPORT}/${DB}" \
  REPRACER_DEMO=on REPRACER_DEMO_SHADOW=on REPRACER_DEMO_US=on REPRACER_DEMO_PRESS_DAYS="${REPRACER_DEMO_PRESS_DAYS:-7}" \
  REPRACER_DEMO_LOCALE="${REPRACER_DEMO_LOCALE:-en}" REPRACER_DEMO_TIME_ZONE="${REPRACER_DEMO_TIME_ZONE:-America/Los_Angeles}" \
  npm run stand -w @repracer/console > "${LOGS}/stand.log" 2>&1 &
pids+=($!)

# Подъём ждёт и прожатую неделю США: на нагруженной машине — до нескольких минут
for _ in $(seq 1 600); do
  curl -sf "http://127.0.0.1:${STAND_PORT}/api/session" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:${STAND_PORT}/api/session" > /dev/null || { echo "стенд не поднялся — см. ${LOGS}/stand.log"; exit 1; }

echo "== интерфейс консоли на 127.0.0.1:5173"
npm run dev -w @repracer/console > "${LOGS}/ui.log" 2>&1 &
pids+=($!)

# Первые решения демо-мира: доказательство тени считает то, что уже случилось
DEMO_TENANT="(SELECT tenant_id FROM tenant_data.tenant WHERE demo)"
echo "== ждём первые решения демо-мира"
for _ in $(seq 1 120); do
  n=$(psql -d "${DB}" -Atq -c "SELECT count(*) FROM channel_data.price_decision WHERE tenant_id IN ${DEMO_TENANT}" 2> /dev/null || echo 0)
  [ "${n:-0}" -gt 0 ] && break
  sleep 5
done

cat << EOF

Демо готово: http://127.0.0.1:5173
  - вход: «Owner» (владелец), язык — English в правом верхнем углу;
  - мир: «Demo» с пометкой DEMO; сценарий показа — docs/demo-script.md;
  - неделя тени США (ebay.com, amazon.com, доллары) прожата; недельное письмо — экран «Shadow mode», блок «Weekly email — preview».
Доказательство тени из базы (шаг «а» сценария) — записи демо-тенанта: удержано тенью и отправлено в канал:
  psql -d ${DB} -c "SELECT final_status, count(*) AS writes, count(dispatched_at) AS sent_to_channel FROM tenant_data.channel_write_history WHERE tenant_id IN ${DEMO_TENANT} GROUP BY 1"
Журналы: ${LOGS}/stand.log, ${LOGS}/ui.log. Ctrl+C — остановить.
EOF
wait
