#!/usr/bin/env bash
# Шаг 131 (решение владельца 2026-11-15, п. 3.3): откат выкладки пилота к прежней версии. Процедура — deploy/pilot/README.md, «Откат».
#   на машине владельца:
#   ssh deploy@<сервер> 'cd /srv/repracer && deploy/pilot/rollback.sh [<SHA прежней версии>]' < "$HOME/.config/repracer/secrets/pilot-backup-private.asc"
# Без SHA — к версии, с которой ушла последняя выкладка (deploy/pilot/state/releases.log пишет deploy.sh).
#  - Между версиями нет миграций: откат — выкладка прежней версии (deploy.sh <SHA>), база не трогается, ничего не теряется.
#  - Есть миграции (база новее прежней версии — scripts/db/migrate.sh --check, код 3): процессы останавливаются, копия, снятая перед выкладкой
#    (deploy/pilot/pre-release-copy.sh), восстанавливается на место живой базы (deploy/pilot/rollback-inner.sh в одноразовом контейнере сервиса backup:
#    живая база переименовывается, не удаляется), затем — выкладка прежней версии. Теряется всё, что записано после копии.
# Закрытый ключ нужен только во втором случае; на диск сервера он не пишется.
set -euo pipefail
cd "$(dirname "$0")/../.."
C=deploy/pilot/compose.sh
set -a; . deploy/pilot/pilot.env; set +a
red() { echo "ROLLBACK RED: $*" >&2; exit 1; }
REF="${1:-}"
if [ -z "${REF}" ]; then
  [ -s deploy/pilot/state/releases.log ] || red "нет журнала выкладок deploy/pilot/state/releases.log — назовите SHA прежней версии"
  REF="$(tail -1 deploy/pilot/state/releases.log | awk '{print $2}')"
fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || red "в рабочей копии правки — откат переключает версию"
git fetch --quiet --tags origin
target="$(git rev-parse --verify "${REF}^{commit}")" || red "версии ${REF} нет в репозитории"
echo "== откат к ${target:0:12} (сейчас работает $(git rev-parse --short=12 HEAD))"

# План миграций прежней версии к живой базе — тем же scripts/db/migrate.sh --check, что у выкладки
plan="deploy/pilot/state/plan"
rm -rf "${plan}"
mkdir -p "${plan}"
git archive "${target}" migrations | tar -x -C "${plan}"
rc=0
out="$("${C}" exec -T -u postgres -e REPRACER_MIGRATIONS_DIR="/repo/${plan}/migrations" postgres bash /repo/scripts/db/migrate.sh "${REPRACER_PILOT_DB}" --check 2>&1)" || rc=$?
printf '%s\n' "${out}"
case "${rc}" in
  0) echo "== миграций между версиями нет — откат выкладкой прежней версии, база не трогается"
     exec deploy/pilot/deploy.sh "${target}" ;;
  3) ;;
  *) red "план миграций не получен (строка выше) — ничего не менялось" ;;
esac

[ ! -t 0 ] || red "база новее прежней версии: откат — восстановлением копии, снятой перед выкладкой, и нужен закрытый ключ копий на стандартном вводе (шапка скрипта)"
echo "== журналы по сей момент"
deploy/pilot/logs-archive.sh --until-now
echo "== остановка процессов (внешний контроль пришлёт письма о молчании — это ожидаемо)"
"${C}" ps --services --status running | grep -vx postgres | xargs -r "${C}" stop
echo "== восстановление копии перед выкладкой на место живой базы"
"${C}" run --rm -T --no-deps -v "${PWD}:/repo:ro" -e REPRACER_PILOT_DB="${REPRACER_PILOT_DB}" -e REPRACER_PILOT_REGION="${REPRACER_PILOT_REGION}" \
  -e REPRACER_RESTORE_SECRETS_DIR=/run/secrets --entrypoint bash backup /repo/deploy/pilot/rollback-inner.sh /backups "${target}" \
  || red "копия не восстановлена — строка ROLLBACK_FAILED выше; живая база на месте, процессы остановлены: deploy/pilot/compose.sh up -d --wait"
echo "== выкладка прежней версии"
deploy/pilot/deploy.sh "${target}"
echo "ROLLBACK GREEN: работает ${target:0:12}; прежняя база — рядом под именем <база>_rb_<время копии>: проверьте и удалите (README, «Откат»)"
