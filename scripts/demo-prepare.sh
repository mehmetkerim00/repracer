#!/usr/bin/env bash
# Шаг 64: ОДНА команда подготовки демо-мира для показа клиенту (docs/demo-script.md).
#
# Что делает:
#   0. шаг 87 [Р-214]: профиль рынка `REPRACER_MARKET_PROFILE` (по умолчанию us) — в us демо — американский продавец: amazon.com и ebay.com,
#      доллары, склад «Warehouse Newark, DE», без Kaufland и витрин ЕС, по-английски, без Omnibus; база демо — региона US [Р-60];
#      `REPRACER_MARKET_PROFILE=eu` (или global) — прежнее демо на симуляторе Kaufland с витринами США рядом;
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
# Подготовка держит машину бодрствующей до Ctrl+C (caffeinate, шаг 80) и печатает время каждой фазы.
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
# Шаг 87 [Р-214]: профиль рынка показа; пояс по умолчанию — первого клиента (Делавэр, восточное время) в us, Западного побережья — иначе
MARKET="${REPRACER_MARKET_PROFILE:-us}"
case "${MARKET}" in us|eu|global) ;; *) echo "REPRACER_MARKET_PROFILE должен быть us, eu или global, а не ${MARKET}"; exit 1 ;; esac
if [ "${MARKET}" = us ]; then DEMO_TZ_DEFAULT=America/New_York; else DEMO_TZ_DEFAULT=America/Los_Angeles; fi
STAND_PORT="${STAND_PORT:-4318}"
export STAND_PORT
LOGS="${TMPDIR:-/tmp}"
LOGS="${LOGS%/}/repracer-demo"
mkdir -p "${LOGS}"

# Шаг 76 (предполётный прогон демо): чужой процесс на порту стенда — старый стенд прошлого запуска: проверка «стенд поднялся» ответила бы
# им, и показ шёл бы на старом мире. Интерфейс держит 127.0.0.1:5173 строго; чужое приложение на [::1]:5173 (другой проект на vite)
# забирает адрес «localhost:5173» — открывать только http://127.0.0.1:5173
command -v lsof > /dev/null || { echo "нужен lsof (проверка занятых портов): без него показ мог бы пойти на старом стенде"; exit 1; }
if lsof -nP -iTCP:"${STAND_PORT}" -sTCP:LISTEN > /dev/null 2>&1; then
  echo "порт стенда ${STAND_PORT} занят — остановите прошлый запуск (Ctrl+C в его терминале) или процесс:"; lsof -nP -iTCP:"${STAND_PORT}" -sTCP:LISTEN; exit 1
fi
if lsof -nP -iTCP:5173 -sTCP:LISTEN > /dev/null 2>&1; then
  if lsof -nP -iTCP@127.0.0.1:5173 -sTCP:LISTEN > /dev/null 2>&1; then
    echo "127.0.0.1:5173 занят — интерфейс демо не поднимется:"; lsof -nP -iTCP:5173 -sTCP:LISTEN; exit 1
  fi
  echo "ВНИМАНИЕ: на 5173 слушает другое приложение (не на 127.0.0.1) — адрес localhost:5173 откроет ЕГО. Открывайте только http://127.0.0.1:5173"
fi
# Код, который исполняет браузер, не импортирует модулей Node: иначе страница консоли пустая (шаг 76)
node scripts/browser-imports.mjs > "${LOGS}/browser-imports.log" 2>&1 || { echo "интерфейс тянет модули Node — страница будет пустой; см. ${LOGS}/browser-imports.log"; exit 1; }

# Шаг 80: машина не засыпает, пока работает подготовка и идёт показ (до Ctrl+C). Сон macOS остановил подготовку шага 79 на 34 минуты
# (журнал питания: «Sleep Service Back to Sleep» в 04:59:38 и 05:16:35 — миграции и прожатая неделя мерились вместе со сном), а посреди
# показа сон остановил бы часы демо-мира. caffeinate завершается вместе с этим скриптом (-w), крышку ноутбука закрывать всё равно нельзя
if command -v caffeinate > /dev/null; then
  caffeinate -dims -w $$ &
else
  echo "ВНИМАНИЕ: нет caffeinate — не дайте машине уснуть до конца показа, иначе подготовка и часы демо-мира остановятся"
fi
# Шаг 80: время каждой фазы — в итоге подготовки: медленный подъём (шаг 79 — 34 минуты вместо полутора) виден сразу и по фазам
SECONDS=0
mark=0
echo "== база ${DB} (миграции и смоук-проверки схемы, обычно меньше минуты)"
REPRACER_PG_TEMPLATE=repracer_demo_template scripts/db/prepare.sh "${DB}" > "${LOGS}/prepare.log" 2>&1 \
  || { echo "подготовка базы не прошла — см. ${LOGS}/prepare.log"; exit 1; }
# Шаг 87 [Р-60]: данные американского продавца — в базе региона US; регион нужен только при создании тенанта, смоук-мир базы его не задевает
if [ "${MARKET}" = us ]; then psql -v ON_ERROR_STOP=1 -q -d postgres -c "ALTER DATABASE ${DB} SET repracer.region = 'US'"; fi
t_db=$((SECONDS - mark)); mark=${SECONDS}

pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2> /dev/null || true; done; }
trap cleanup EXIT INT TERM

echo "== стенд с демо-тенантом (профиль ${MARKET}, тень, витрины США) на 127.0.0.1:${STAND_PORT}"
STAND_IDENTITY=simulator REPRACER_PG_URL="postgres://svc_app@${PGHOST}:${PGPORT}/${DB}" REPRACER_MARKET_PROFILE="${MARKET}" \
  REPRACER_DEMO=on REPRACER_DEMO_ONLY=on REPRACER_DEMO_SHADOW=on REPRACER_DEMO_US=on REPRACER_DEMO_PRESS_DAYS="${REPRACER_DEMO_PRESS_DAYS:-7}" \
  REPRACER_DEMO_LOCALE="${REPRACER_DEMO_LOCALE:-en}" REPRACER_DEMO_TIME_ZONE="${REPRACER_DEMO_TIME_ZONE:-${DEMO_TZ_DEFAULT}}" \
  REPRACER_CONSOLE_LOCALE="${REPRACER_DEMO_LOCALE:-en}" REPRACER_STAND_TOKEN_SECONDS="${REPRACER_STAND_TOKEN_SECONDS:-43200}" \
  npm run stand -w @repracer/console > "${LOGS}/stand.log" 2>&1 &
pids+=($!)

# Подъём ждёт и прожатую неделю США: на нагруженной машине — до нескольких минут
for _ in $(seq 1 600); do
  curl -sf "http://127.0.0.1:${STAND_PORT}/api/session" > /dev/null 2>&1 && break
  sleep 1
done
curl -sf "http://127.0.0.1:${STAND_PORT}/api/session" > /dev/null || { echo "стенд не поднялся — см. ${LOGS}/stand.log"; exit 1; }
t_stand=$((SECONDS - mark)); mark=${SECONDS}

echo "== интерфейс консоли на 127.0.0.1:5173"
npm run dev -w @repracer/console > "${LOGS}/ui.log" 2>&1 &
pids+=($!)
# Отвечает именно наш интерфейс (его страница грузит /src/main.tsx), а не чужое приложение на том же порту (ревью шага 76, находка 11)
ours() { curl -sf "http://127.0.0.1:5173/" 2> /dev/null | grep -q '/src/main.tsx'; }
for _ in $(seq 1 60); do
  ours && break
  sleep 1
done
ours || { echo "интерфейс консоли не отвечает на 127.0.0.1:5173 — см. ${LOGS}/ui.log"; exit 1; }
t_ui=$((SECONDS - mark)); mark=${SECONDS}

# Первые решения демо-мира: доказательство тени считает то, что уже случилось
DEMO_TENANT="(SELECT tenant_id FROM tenant_data.tenant WHERE demo)"
echo "== ждём первые решения демо-мира"
for _ in $(seq 1 120); do
  n=$(psql -d "${DB}" -Atq -c "SELECT count(*) FROM channel_data.price_decision WHERE tenant_id IN ${DEMO_TENANT}" 2> /dev/null || echo 0)
  [ "${n:-0}" -gt 0 ] && break
  sleep 5
done
t_first=$((SECONDS - mark)); mark=${SECONDS}
# Прожатие недели США стенд печатает сам («demo US week pressed: … N s»)
pressed=$(grep -o 'demo US week pressed: .*' "${LOGS}/stand.log" | grep -oE '[0-9.]+ s$' || true)

cat << EOF

Демо готово: http://127.0.0.1:5173 — профиль ${MARKET}, подготовка ${SECONDS} с: база ${t_db} с, стенд ${t_stand} с (из них неделя США ${pressed:-?}), интерфейс ${t_ui} с, первые решения ${t_first} с
  - вход: «Owner» (владелец); в профиле us язык один — английский, переключателя нет;
  - мир: «Demo» с пометкой DEMO; сценарий показа — docs/demo-script.md;
  - неделя тени США (ebay.com, amazon.com, доллары) прожата; недельное письмо — экран «Shadow mode», блок «Weekly email — preview».
Доказательство тени из базы (шаг «а» сценария) — записи демо-тенанта: удержано тенью и отправлено в канал:
  psql -d ${DB} -c "SELECT final_status, count(*) AS writes, count(dispatched_at) AS sent_to_channel FROM tenant_data.channel_write_history WHERE tenant_id IN ${DEMO_TENANT} GROUP BY 1"
Журналы: ${LOGS}/stand.log, ${LOGS}/ui.log. Ctrl+C — остановить.
EOF
wait
