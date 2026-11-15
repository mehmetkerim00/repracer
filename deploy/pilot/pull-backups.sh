#!/usr/bin/env bash
# Шаг 126: вынос копий базы пилота НА МАШИНУ ОПЕРАТОРА — вторая бесплатная цель (REPRACER_BACKUP_OFFSITE=pull), когда R2 не выбран. Запускается на машине
# оператора раз в сутки (launchd или cron — deploy/pilot/README.md, «Копии базы»), тянет с сервера по SSH готовые копии, которых здесь ещё нет:
#   deploy/pilot/pull-backups.sh <пользователь@сервер> [<каталог здесь>]
# Готовая копия — та, у которой есть файл сумм (backup-loop пишет его последним). Каждая копия сверяется по SHA-256 ДО того, как её примут: порча при
# переносе — отказ, частей не остаётся. Копии здесь живут столько же, сколько на сервере (REPRACER_BACKUP_KEEP_DAYS, 7 суток): старше — удаляются по
# времени в имени. После прохода на сервер уходит отметка OFFSITE_PULLED с последней принятой копией — её проверяет deploy/pilot/smoke.sh.
# Копии зашифрованы открытым ключом владельца: здесь лежит шифротекст. Параметры сервера в репозитории не зашиваются — адрес аргументом.
#
# Шаг 133 (решение владельца 2026-11-15: «требование DPP «12 месяцев» не должно умирать вместе с сервером»): тем же проходом — журналы пилота
# (deploy/pilot/logs-archive.sh, README §10) в <каталог здесь>/logs:
#   - месячные архивы `platform=logs/repracer-pilot/<ГГГГ-ММ>.log.gz` — со своей суммой SHA-256 (её пишет logs-archive.sh), 13 месяцев, как на сервере;
#   - ЗАКОНЧЕННЫЕ сутки горячего хвоста (раньше суток отметки «выгружено по»: их файл больше не меняется) — сумма считается на сервере. Сутки месяца,
#     который пришёл архивом, здесь удаляются: архив содержит их целиком.
# Каждый файл сверяется ДО того, как его примут. После прохода на сервере — отметка LOGS_PULLED («вынесено всё до …», когда, под контролем ли) —
# её проверяет deploy/pilot/logs-state.sh. Копии базы выносятся первыми: провал журналов их не задерживает, но проход красный.
set -euo pipefail
DEST="${1:-}"
[ -n "${DEST}" ] || { echo "usage: deploy/pilot/pull-backups.sh <user@server> [<local dir>]" >&2; exit 2; }
LOCAL="${2:-${REPRACER_PILOT_BACKUP_PULL_DIR:-${HOME}/.config/repracer/backups/pilot}}"
REMOTE="${REPRACER_PILOT_REMOTE_BACKUP_DIR:-/srv/repracer-pilot/backups}"
KEEP_DAYS="${REPRACER_BACKUP_KEEP_DAYS:-7}"
# Каталоги журналов на сервере — REPRACER_LOGS_HOT_DIR и REPRACER_ARCHIVE_DIR из pilot.env (умолчания — как в pilot.env.example)
RLOGS="${REPRACER_PILOT_REMOTE_LOGS_DIR:-/srv/repracer-pilot/logs}"
RARCH="${REPRACER_PILOT_REMOTE_ARCHIVE_DIR:-/srv/repracer-pilot/archive}"
KEEP_MONTHS="${REPRACER_LOGS_KEEP_MONTHS:-13}"
for d in "${REMOTE}" "${RLOGS}" "${RARCH}"; do
  [[ "${d}" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "каталог на сервере — абсолютный путь без пробелов и кавычек: ${d}" >&2; exit 2; }
done
[[ "${KEEP_DAYS}" =~ ^[1-9][0-9]*$ ]] || { echo "REPRACER_BACKUP_KEEP_DAYS — целое число суток" >&2; exit 2; }
[[ "${KEEP_MONTHS}" =~ ^[1-9][0-9]*$ ]] || { echo "REPRACER_LOGS_KEEP_MONTHS — целое число месяцев" >&2; exit 2; }
umask 077
# Шаг 129 [Р-127]: отметка выноса во внешнем сервисе — «жив» после каждого зелёного прохода, «сбой» после красного. Машина оператора выключена,
# спит или без сети — отметок нет, и внешняя проверка (сутки + 2 часа) пишет письмо. Адрес кладёт scripts/setup-heartbeats.mjs --stand pilot
# (deploy/pilot/README.md, §9) — сюда, а не в каталог секретов, который уходит на сервер. Без адреса копии всё равно забираются (копии важнее),
# но отметка OFFSITE_PULLED говорит «не под контролем», и смоук это называет
HB_FILE="${REPRACER_PILOT_PULL_HEARTBEAT_URL_FILE:-${HOME}/.config/repracer/secrets/pilot-pull-heartbeat-url}"
monitored=false
if [ -e "${HB_FILE}" ]; then
  [ "$(head -c 8 "${HB_FILE}")" = "https://" ] || { echo "PULL RED: ${HB_FILE} — не адрес https (scripts/setup-heartbeats.mjs кладёт ping_url проверки)" >&2; exit 2; }
  command -v curl > /dev/null || { echo "PULL RED: нужен curl — им уходит отметка выноса" >&2; exit 2; }
  monitored=true
fi
# Адрес — секрет: не аргументом curl (аргументы процесса видны в ps), а его конфигурацией со стандартного ввода; printf — встроенная команда
beat() { [ "${monitored}" = true ] || return 0; printf 'url = "%s%s"\n' "$(head -n 1 "${HB_FILE}" | tr -d '\r\n')" "$1" | curl -fsS -m 10 --retry 2 -o /dev/null --config - 2> /dev/null; }
trap 'rc=$?; if [ "${rc}" -ne 0 ]; then beat /fail || true; fi' EXIT
mkdir -p "${LOCAL}"
chmod 700 "${LOCAL}"
sha() { if command -v sha256sum > /dev/null; then sha256sum "$@" | awk '{print $1}'; else shasum -a 256 "$@" | awk '{print $1}'; fi; }
# Время в имени копии — UTC; perl есть и у macOS, и у Linux (date у них разный)
cutoff="$(perl -MPOSIX -e "print strftime('%Y%m%dT%H%M%SZ', gmtime(time - ${KEEP_DAYS} * 86400))")"
fail() { echo "PULL RED: $*" >&2; exit 1; }

stamps="$(ssh "${DEST}" "cd '${REMOTE}' && ls -1" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort)" || fail "сервер не отдал список копий (${REMOTE})"
pulled=0
bad=()
for s in ${stamps}; do
  [[ "${s}" < "${cutoff}" ]] && continue
  [ -e "${LOCAL}/repracer-${s}.sha256" ] && continue
  ok=1
  for part in dump.gpg globals.sql.gpg sha256; do
    ssh "${DEST}" "cat '${REMOTE}/repracer-${s}.${part}'" > "${LOCAL}/repracer-${s}.${part}.part" || { ok=0; break; }
  done
  # Те же суммы, что сверяет restore.sh: две строки — копия и роли
  if [ "${ok}" = 1 ] && [ "$(tr -d ' \r' < "${LOCAL}/repracer-${s}.sha256.part")" = "$(sha "${LOCAL}/repracer-${s}.dump.gpg.part" "${LOCAL}/repracer-${s}.globals.sql.gpg.part" | tr -d ' ')" ]; then
    for part in dump.gpg globals.sql.gpg sha256; do mv "${LOCAL}/repracer-${s}.${part}.part" "${LOCAL}/repracer-${s}.${part}"; done
    pulled=$((pulled + 1))
  else
    rm -f "${LOCAL}/repracer-${s}".*.part
    bad+=("${s}")
  fi
done

# Срок здесь — как на сервере: старше среза — удаляются (данные каналов не переживают свой срок в копиях, docs/data-retention.md)
for f in "${LOCAL}"/repracer-*; do
  [ -e "${f}" ] || continue
  s="$(basename "${f}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\..*$/\1/p')"
  [ -n "${s}" ] && [[ "${s}" < "${cutoff}" ]] && rm -f "${f}"
done

newest="$(ls -1 "${LOCAL}" | sed -n 's/^repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.sha256$/\1/p' | sort | tail -1)"
[ ${#bad[@]} -eq 0 ] || fail "копия не сошлась по SHA-256 и не принята: ${bad[*]} — повторите; повторится — копия на сервере испорчена"
[ -n "${newest}" ] || fail "на сервере нет ни одной готовой копии — смотрите сервис backup (deploy/pilot/compose.sh logs backup)"
now="$(date -u +%Y%m%dT%H%M%SZ)"
ssh "${DEST}" "printf '%s\n' '{\"pulledThrough\":\"${newest}\",\"at\":\"${now}\",\"monitored\":${monitored}}' > '${REMOTE}/OFFSITE_PULLED.part' && mv '${REMOTE}/OFFSITE_PULLED.part' '${REMOTE}/OFFSITE_PULLED'" \
  || fail "копии приняты, но отметка на сервер не записалась — смоук назовёт их невынесенными"

# Шаг 133: журналы пилота — проект compose repracer-pilot (его называет deploy/pilot/logs-archive.sh)
P=repracer-pilot
LOGS="${LOCAL}/logs"
mkdir -p "${LOGS}"
chmod 700 "${LOGS}"
until_mark="$(ssh "${DEST}" "cat '${RLOGS}/${P}/.until'" 2> /dev/null)" \
  || fail "журналы пилота на сервере ещё не выгружались (${RLOGS}/${P}/.until) — на сервере: deploy/pilot/logs-archive.sh --until-now"
[[ "${until_mark}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "отметка «выгружено по» на сервере не по форме: ${until_mark}"
# Сутки раньше суток отметки законченные: logs-archive.sh дописывает только сутки от отметки и дальше
before="${until_mark:0:10}"
# Срок здесь — как на сервере: месяц старше KEEP_MONTHS от текущего уходит (logs-archive.sh, шаг 3)
oldest="$(perl -e "my @t = gmtime; my \$m = (\$t[5] + 1900) * 12 + \$t[4] - ${KEEP_MONTHS}; printf '%04d-%02d', int(\$m / 12), \$m % 12 + 1")"
months="$(ssh "${DEST}" "ls -1 '${RARCH}/platform=logs/${P}'" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}\)\.log\.gz$/\1/p' | sort)" \
  || fail "сервер не отдал список месячных архивов журналов (${RARCH}/platform=logs/${P})"
# Суммы суток — одним заходом на сервере; файлы оборванного захода (.new, .part) под шаблон суток не подходят
days="$(ssh "${DEST}" "cd '${RLOGS}/${P}' || exit 1; set -- ????-??-??.log.gz; [ -e \"\$1\" ] || exit 0; if command -v sha256sum > /dev/null; then sha256sum \"\$@\"; else shasum -a 256 \"\$@\"; fi")" \
  || fail "сервер не отдал суммы суток журналов (${RLOGS}/${P})"
new_months=0
new_days=0
bad_logs=()
for m in ${months}; do
  [[ "${m}" < "${oldest}" ]] && continue
  [ -e "${LOGS}/${m}.log.gz" ] && continue
  if ssh "${DEST}" "cat '${RARCH}/platform=logs/${P}/${m}.log.gz.sha256'" > "${LOGS}/${m}.log.gz.sha256.part" \
     && ssh "${DEST}" "cat '${RARCH}/platform=logs/${P}/${m}.log.gz'" > "${LOGS}/${m}.log.gz.part" \
     && [ "$(tr -d ' \r\n' < "${LOGS}/${m}.log.gz.sha256.part")" = "$(sha "${LOGS}/${m}.log.gz.part")" ]; then
    mv "${LOGS}/${m}.log.gz.part" "${LOGS}/${m}.log.gz"
    mv "${LOGS}/${m}.log.gz.sha256.part" "${LOGS}/${m}.log.gz.sha256"
    new_months=$((new_months + 1))
  else
    rm -f "${LOGS}/${m}".log.gz*.part
    bad_logs+=("${m}")
  fi
done
while read -r sum name; do
  d="$(printf '%s' "${name:-}" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\)\.log\.gz$/\1/p')"
  [ -n "${d}" ] || continue
  [[ "${d}" < "${before}" ]] || continue
  [[ "${d:0:7}" < "${oldest}" ]] && continue
  [ -e "${LOGS}/${d}.log.gz" ] || [ -e "${LOGS}/${d:0:7}.log.gz" ] && continue
  # </dev/null: ssh читает стандартный ввод до конца и съел бы строки цикла
  if ssh "${DEST}" "cat '${RLOGS}/${P}/${d}.log.gz'" < /dev/null > "${LOGS}/${d}.log.gz.part" && [ "$(sha "${LOGS}/${d}.log.gz.part")" = "${sum}" ]; then
    mv "${LOGS}/${d}.log.gz.part" "${LOGS}/${d}.log.gz"
    new_days=$((new_days + 1))
  else
    rm -f "${LOGS}/${d}.log.gz.part"
    bad_logs+=("${d}")
  fi
done <<< "${days}"
# Сутки месяца, который здесь есть архивом, и всё старше срока — уходят
for f in "${LOGS}"/*.log.gz "${LOGS}"/*.log.gz.sha256; do
  [ -e "${f}" ] || continue
  b="$(basename "${f}")"
  m="${b:0:7}"
  [[ "${m}" =~ ^[0-9]{4}-[0-9]{2}$ ]] || continue
  if [[ "${m}" < "${oldest}" ]]; then rm -f "${f}"
  elif [[ "${b}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.log\.gz$ ]] && [ -e "${LOGS}/${m}.log.gz" ]; then rm -f "${f}"; fi
done
[ ${#bad_logs[@]} -eq 0 ] || fail "журнал не сошёлся по SHA-256 и не принят: ${bad_logs[*]} — повторите; повторится — файл на сервере испорчен"
ssh "${DEST}" "printf '%s\n' '{\"pulledBefore\":\"${before}T00:00:00Z\",\"at\":\"${now}\",\"monitored\":${monitored}}' > '${RLOGS}/LOGS_PULLED.part' && mv '${RLOGS}/LOGS_PULLED.part' '${RLOGS}/LOGS_PULLED'" \
  || fail "журналы приняты, но отметка на сервер не записалась — смоук назовёт их невынесенными"

if [ "${monitored}" = true ]; then
  beat "" || echo "внимание: отметка выноса не ушла во внешний сервис (сеть?) — будет так дольше суток, придёт письмо о пропущенном выносе" >&2
else
  echo "внимание: отметки выноса нет (${HB_FILE}) — смоук назовёт вынос неподконтрольным; scripts/setup-heartbeats.mjs --stand pilot (deploy/pilot/README.md, §9)" >&2
fi
echo "PULL GREEN: новых копий ${pulled}, последняя repracer-${newest}, здесь — $(ls -1 "${LOCAL}" | grep -c '\.sha256$') копий в ${LOCAL}; журналы: новых месяцев ${new_months}, суток ${new_days}, всё до ${before} — в ${LOGS}"
