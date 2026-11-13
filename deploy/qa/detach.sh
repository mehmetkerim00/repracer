#!/usr/bin/env bash
# Шаг 121.3 (QA-A): долгая команда, которая переживает обрыв SSH. Работа идёт в фоне, в своём сеансе, под журналом; одновременно — одна
# работа с этим именем. Вызов показывает журнал до конца работы и выходит её кодом. Обрыв соединения убивает только показ — работа
# продолжается; повторный вызов во время работы показывает её журнал с начала и ждёт конца, а не запускает вторую.
# Шаг 121.4: пока работа идёт, показ раз в 30 с печатает «идёт, N с» — молчащее соединение режут NAT и VPN.
#   deploy/qa/detach.sh <имя> <команда> [аргументы…]      (журнал, замок и итог — в $QA_STATE_DIR, по умолчанию deploy/qa/state)
set -euo pipefail

if [ "${1:-}" = --worker ]; then
  dir="$2"; name="$3"; shift 3
  # Итог пишется всегда — и при отказе работы; замок снимается последним
  trap 'rc=$?; echo "${rc}" > "${dir}/${name}.status.tmp"; mv "${dir}/${name}.status.tmp" "${dir}/${name}.status"; rm -rf "${dir}/${name}.lock"' EXIT
  trap '' HUP INT
  echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) ${name}: начало"
  "$@"
  exit 0
fi

[ $# -ge 2 ] || { echo "использование: deploy/qa/detach.sh <имя> <команда> [аргументы…]" >&2; exit 2; }
name="$1"; shift
[[ "${name}" =~ ^[a-z0-9-]+$ ]] || { echo "имя работы — строчные латинские буквы, цифры и -: ${name}" >&2; exit 2; }
# Шаг 121.4: пульс показа — раз в столько секунд (в тесте — меньше)
pulse="${QA_DETACH_PULSE_SECONDS:-30}"
[[ "${pulse}" =~ ^[1-9][0-9]{0,3}$ ]] || { echo "QA_DETACH_PULSE_SECONDS — целое число секунд от 1 до 9999: ${pulse}" >&2; exit 2; }
dir="${QA_STATE_DIR:-$(cd "$(dirname "$0")" && pwd)/state}"
mkdir -p "${dir}"
lock="${dir}/${name}.lock"
log="${dir}/${name}.log"
status="${dir}/${name}.status"
self="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

alive() { [ -f "${lock}/pid" ] && kill -0 "$(cat "${lock}/pid" 2> /dev/null)" 2> /dev/null; }
take_lock() {
  mkdir "${lock}" 2> /dev/null && return 0
  # Замок есть: работа идёт — или её убили, не дав снять замок (kill -9, перезагрузка). Пид пишется сразу за замком — ждём его до 5 с
  for _ in 1 2 3 4 5; do [ -f "${lock}/pid" ] && break; sleep 1; done
  alive && return 1
  echo "== ${name}: прежняя работа оборвалась, не сняв замок — начинаю заново"
  rm -rf "${lock}"
  mkdir "${lock}"
}

if take_lock; then
  date +%s > "${lock}/started"
  rm -f "${status}"
  : > "${log}"
  # Свой сеанс (setsid) — сигналы соединения и его группы процессов работу не касаются; вывод — только в журнал
  nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or die "exec: $!\n"' "${self}" --worker "${dir}" "${name}" "$@" >> "${log}" 2>&1 < /dev/null &
  echo "$!" > "${lock}/pid" 2> /dev/null || true
  echo "== ${name}: идёт в фоне — обрыв соединения её не прервёт; журнал: ${log}"
else
  echo "== ${name}: уже идёт — журнал с начала, жду конца"
fi

# Показ журнала: новые байты раз в секунду, пока работа жива
shown=0
show() {
  local size
  size="$(wc -c < "${log}" | tr -d ' ')"
  if [ "${size}" -gt "${shown}" ]; then tail -c +"$((shown + 1))" "${log}" | head -c "$((size - shown))"; shown="${size}"; fi
}
# Шаг 121.4: пульс «идёт, N с» — соединение не молчит, пока журнал стоит (стенд поднимается минутами), и промежуточные звенья (NAT, VPN)
# его не режут. Только в показе — журнал работы не трогается; N — от начала работы, и у повторного вызова тоже
started="$(cat "${lock}/started" 2> /dev/null || date +%s)"
last="$(date +%s)"
while [ -d "${lock}" ]; do
  if [ -f "${lock}/pid" ] && ! alive; then break; fi
  show
  now="$(date +%s)"
  if [ $((now - last)) -ge "${pulse}" ]; then echo "== ${name}: идёт, $((now - started)) с"; last="${now}"; fi
  sleep 1
done
show
[ -f "${status}" ] || { echo "${name}: работа оборвалась без итога (журнал выше) — повторите команду" >&2; exit 1; }
rc="$(cat "${status}")"
echo "== ${name}: завершено, код ${rc}"
exit "${rc}"
