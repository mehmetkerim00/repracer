#!/usr/bin/env bash
# Шаг 131 (решение владельца 2026-11-15, п. 3.3): копия базы пилота ПЕРЕД миграциями выкладки. Миграцию назад не откатить: код прежней версии к базе после
# миграции не подходит (scripts/db/migrate.sh отказывает «база новее кода»). Откат через миграцию — восстановление этой копии (шаг 132,
# deploy/pilot/README.md, «Откат»); теряется только то, что записано после неё. Без неё откат — суточной копией, то есть до суток потерь.
# Копию снимает ТОТ ЖЕ сервис backup одним проходом (REPRACER_BACKUP_ONCE=1: pg_dump → gpg открытым ключом, суммы, срок 7 суток). Рядом — отметка
# `repracer-<время>.pre-release`: какая версия работала, какая выкладывается и на какой миграции стояла база; по ней откат находит свою копию.
#   deploy/pilot/pre-release-copy.sh <SHA прежней версии> <SHA выкладки> <миграция базы до выкладки>
# Зовёт deploy.sh, когда план миграций не пуст. Провал — код 1: выкладка останавливается до миграций.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
BEFORE="${1:-}"; RELEASE="${2:-}"; AT="${3:-}"
[[ "${BEFORE}" =~ ^[0-9a-f]{40}(-dirty)?$ && "${RELEASE}" =~ ^[0-9a-f]{40}(-dirty)?$ && "${AT}" =~ ^[0-9]{4}$ ]] \
  || { echo "usage: deploy/pilot/pre-release-copy.sh <sha before> <sha of the release> <migration NNNN>" >&2; exit 2; }
set -a; . "${here}/pilot.env"; set +a
DIR="${REPRACER_BACKUP_DIR:?set REPRACER_BACKUP_DIR in pilot.env}"
red() { echo "PRE-RELEASE COPY RED: $*" >&2; exit 1; }
out="$("${here}/compose.sh" run --rm -T -e REPRACER_BACKUP_ONCE=1 backup)" \
  || red "копия базы перед миграциями не снялась — строка BACKUP_FAILED выше; выкладка остановлена до миграций: без копии откат через них невозможен"
stamp="$(sed -n 's/.*"event":"BACKUP_DONE","file":"repracer-\([0-9]\{8\}T[0-9]\{6\}Z\)\.dump\.gpg".*/\1/p' <<< "${out}" | tail -1)"
[ -n "${stamp}" ] && [ -s "${DIR}/repracer-${stamp}.sha256" ] || red "копия не назвала себя или её нет в ${DIR}: ${out}"
printf '{"before":"%s","release":"%s","migrationsBefore":"%s","at":"%s"}\n' "${BEFORE}" "${RELEASE}" "${AT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "${DIR}/repracer-${stamp}.pre-release"
echo "PRE-RELEASE COPY: repracer-${stamp} — база на миграции ${AT} до выкладки ${RELEASE:0:12} (была ${BEFORE:0:12})"
