#!/usr/bin/env bash
# Шаг 126: ключ копий пилота, когда на машине владельца нет GnuPG. Пара рождается в памяти одноразового контейнера (образ базы — в нём есть gpg), без сети;
# ОТКРЫТЫЙ ключ ложится в каталог секретов сервера (backup_public_key.asc), ЗАКРЫТЫЙ уходит в стандартный вывод — то есть по SSH на машину владельца. На
# диск сервера закрытый ключ не пишется. Есть GnuPG у владельца — лучше команды deploy/production/README.md («Шифрование копии»): ключ не бывает на сервере
# даже в памяти.
#   на машине владельца:
#   ssh deploy@<сервер> 'cd /srv/repracer && deploy/pilot/backup-key.sh' > "$HOME/.config/repracer/secrets/pilot-backup-private.asc"
#   ssh deploy@<сервер> 'cd /srv/repracer && deploy/pilot/backup-key.sh --public' < "$HOME/.config/repracer/secrets/pilot-backup-private.asc"
# --public — новый сервер со старым ключом: открытый выводится из закрытого (стандартный ввод), копии прежнего сервера читаются тем же ключом.
# Существующий открытый ключ не заменяется: копии, снятые им, читаются только своим закрытым. Заменить — --replace, осознанно.
set -euo pipefail
cd "$(dirname "$0")/../.."
MODE=new
REPLACE=0
for a in "$@"; do case "$a" in --public) MODE=public ;; --replace) REPLACE=1 ;; *) echo "usage: deploy/pilot/backup-key.sh [--public] [--replace]" >&2; exit 2 ;; esac; done
set -a; . deploy/pilot/pilot.env; set +a
OUT="${REPRACER_SECRETS_DIR:?set REPRACER_SECRETS_DIR in pilot.env}"
[ -d "${OUT}" ] || { echo "нет каталога секретов ${OUT} — сначала deploy/pilot/push-secrets.sh" >&2; exit 1; }
if [ -e "${OUT}/backup_public_key.asc" ] && [ "${REPLACE}" = 0 ]; then
  echo "открытый ключ копий уже есть (${OUT}/backup_public_key.asc): прежние копии читаются только его закрытым — заменить: --replace" >&2; exit 1
fi
if [ "${MODE}" = new ] && [ -t 1 ]; then echo "закрытый ключ печатается в стандартный вывод — перенаправьте его в файл на машине владельца (см. шапку скрипта)" >&2; exit 2; fi
if [ "${MODE}" = public ] && [ -t 0 ]; then echo "закрытый ключ — на стандартный ввод (см. шапку скрипта)" >&2; exit 2; fi
IMAGE="$(awk '/^  postgres:/{f=1} f && /image:/{print $2; exit}' deploy/pilot/compose.yaml)"
# Внутри: каталог ключей во временной памяти контейнера; открытый — в /out (каталог секретов), закрытый — в стандартный вывод
docker run --rm -i --network none -u "$(id -u):$(id -g)" -e HOME=/tmp --tmpfs /tmp -v "${OUT}":/out "${IMAGE}" bash -c '
  set -euo pipefail
  umask 077
  export GNUPGHOME="$(mktemp -d)"
  g() { gpg --batch --no-tty --quiet --pinentry-mode loopback --passphrase "" "$@"; }
  if [ "$0" = new ]; then
    g --quick-gen-key "tmprice pilot backup <backup@pilot.invalid>" default default never 2>/dev/null
    g --armor --export > /out/backup_public_key.asc.part
    g --armor --export-secret-keys
  else
    g --import 2>/dev/null
    g --armor --export > /out/backup_public_key.asc.part
  fi
  grep -q -- "-----BEGIN PGP PUBLIC KEY BLOCK-----" /out/backup_public_key.asc.part
  mv /out/backup_public_key.asc.part /out/backup_public_key.asc
' "${MODE}"
echo "открытый ключ копий: ${OUT}/backup_public_key.asc; сервис backup берёт его при следующем запуске (deploy/pilot/compose.sh up -d backup)" >&2
