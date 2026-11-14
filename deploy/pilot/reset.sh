#!/usr/bin/env bash
# Шаг 132 (решение владельца 2026-11-15, п. 3.4): сброс базы QA-B одной командой. QA-B — тот же deploy/pilot на временной машине (README, §12); его база
# устроена как база пилота, и сброс отличает их отметкой стенда: работает только при REPRACER_PILOT_STAND=qa-b в pilot.env И отметке qa-b у самой базы
# (deploy/pilot/db.sh --reset-qa-b). На пилоте отказывает первой строкой, до любой команды Docker: живую базу пилота не пересоздаёт ничто.
#   ssh deploy@<машина QA-B> 'cd /srv/repracer && deploy/pilot/reset.sh'
# Порядок: журналы по сей момент → остановка процессов, кроме базы → копия перед сбросом (репетиция копий идёт целиком: ошибочный сброс
# восстанавливается, как беда) → новая база (сборка под `<база>_next` со стражем, затем замена) → процессы → проверка.
# ClickHouse не сбрасывается: в нём выгруженная история прежних тенантов; консоль и решение о цене его не читают [Р-22], срок — свой (18 месяцев).
set -euo pipefail
cd "$(dirname "$0")/../.."
C=deploy/pilot/compose.sh
set -a; . deploy/pilot/pilot.env; set +a
red() { echo "QA-B RESET RED: $*" >&2; exit 1; }
[ "${REPRACER_PILOT_STAND:-pilot}" = qa-b ] || red "сброс — только QA-B: в pilot.env стенд «${REPRACER_PILOT_STAND:-pilot}». База пилота живая, её не пересоздаёт ничто (README, §5)"
echo "== журналы по сей момент"
deploy/pilot/logs-archive.sh --until-now
echo "== остановка процессов, кроме базы (внешний контроль QA-B пришлёт письма о молчании — это ожидаемо)"
"${C}" ps --services --status running | grep -vx postgres | xargs -r "${C}" stop
echo "== копия базы перед сбросом"
"${C}" run --rm -T -e REPRACER_BACKUP_ONCE=1 backup || red "копия перед сбросом не снялась — сброс остановлен, база как была: deploy/pilot/compose.sh up -d --wait"
echo "== новая база QA-B"
"${C}" exec -T -u postgres -e REPRACER_PILOT_DB="${REPRACER_PILOT_DB}" -e REPRACER_PILOT_REGION="${REPRACER_PILOT_REGION}" -e REPRACER_PILOT_STAND=qa-b postgres \
  bash /repo/deploy/pilot/db.sh --reset-qa-b
echo "== процессы"
"${C}" up -d --wait --remove-orphans
deploy/pilot/logs-archive.sh --until-now
deploy/pilot/smoke.sh
echo "QA-B RESET GREEN: база ${REPRACER_PILOT_DB} новая; онбординг — заново (README, §12)"
