#!/bin/bash
# Р-158 (шаг 36): суточная копия PostgreSQL и срок её хранения. Копия без ПРОВЕРЕННОГО восстановления — обещание,
# поэтому восстановление проверяется тестом сборки (packages/pricing-store-pg/test/backup-restore.pg.test.ts), а не абзацем в README.
#
# Пароль базы здесь не появляется: строка подключения читается из файла секретов (как во всех процессах).
set -euo pipefail

PGURL="$(cat "${PGURL_FILE:?set PGURL_FILE}")"
KEEP_DAYS="${REPRACER_BACKUP_KEEP_DAYS:-7}"
EVERY="${REPRACER_BACKUP_EVERY_SECONDS:-86400}"
# Провалившаяся копия ждёт не сутки, а этот срок: сутки молчания означают сутки без копии [находка 8 ревью шага 36]
RETRY="${REPRACER_BACKUP_RETRY_SECONDS:-900}"
OUT="${REPRACER_BACKUP_OUT:-/backups}"
# Шаг 54 (OWASP A02): копия ШИФРУЕТСЯ открытым ключом GnuPG — он есть в образе postgres (официальный Dockerfile ставит gnupg и не
# удаляет). На сервере лежит только ОТКРЫТЫЙ ключ, файлом рядом с остальными секретами; закрытый — вне сервера, у владельца: копия,
# вынесенная с сервера или украденная с него, без закрытого ключа не читается. Незашифрованной копии на диске не бывает ни на миг —
# выгрузка идёт в gpg потоком. Нет ключа — копия проваливается с алертом, а не пишется открытой (fail-closed)
PUBLIC_KEY="${REPRACER_BACKUP_PUBLIC_KEY_FILE:-/run/secrets/backup_public_key.asc}"
# Одна итерация и выход с кодом — так тест сборки гоняет ТОТ ЖЕ скрипт (packages/pricing-store-pg/test/backup-restore.pg.test.ts)
ONCE="${REPRACER_BACKUP_ONCE:-0}"
export GNUPGHOME="$(mktemp -d)"
# Ревью шага 54, находка 13: временный каталог ключей и недописанные части убираются при любом выходе, в том числе по SIGTERM
trap 'rm -rf "$GNUPGHOME"; rm -f "$OUT"/repracer-*.part' EXIT
trap 'exit 143' TERM INT
encrypt() { gpg --batch --no-tty --quiet --trust-model always --recipient-file "$PUBLIC_KEY" --encrypt --output "$1"; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$@" | awk '{print $1}'; else shasum -a 256 "$@" | awk '{print $1}'; fi; }
# Отметка провала: файл живёт, пока копия не удалась, и исчезает с первой удавшейся. Внешний контроль видит её файлом,
# а не чтением журнала — контейнеру копии наш код и база недоступны, и поднять алерт в `tenant_data.alert` ему нечем
FAILED_MARK="$OUT/BACKUP_FAILED"
FAILURES=0

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  FILE="$OUT/repracer-$STAMP.dump.gpg"
  GLOBALS="$OUT/repracer-$STAMP.globals.sql.gpg"
  # -Fc: формат с оглавлением, восстанавливается pg_restore целиком или по таблицам (после расшифровки закрытым ключом, README)
  # Роли кластера копия базы не содержит: без них восстановление на ЧИСТОМ сервере не поднимет ни политик, ни прав
  # (находка 17 ревью шага 36). Пароли ролей не выгружаются — они и не наши: строки подключения лежат в секретах
  # pipefail: провал pg_dump проваливает и конвейер — зашифрованный обрывок за копию не выдаётся
  if [[ -r "$PUBLIC_KEY" ]] \
     && pg_dump --dbname="$PGURL" --format=custom | encrypt "$FILE.part" \
     && pg_dumpall --dbname="$PGURL" --globals-only --no-role-passwords | encrypt "$GLOBALS.part"; then
    mv "$FILE.part" "$FILE"
    mv "$GLOBALS.part" "$GLOBALS"
    sha "$FILE" "$GLOBALS" > "$OUT/repracer-$STAMP.sha256"
    echo "{\"event\":\"BACKUP_DONE\",\"file\":\"$(basename "$FILE")\",\"bytes\":$(wc -c < "$FILE" | tr -d ' '),\"encrypted\":true}"
    FAILURES=0
    rm -f "$FAILED_MARK"
    NEXT="$EVERY"
  else
    rm -f "$FILE.part" "$GLOBALS.part"
    FAILURES=$((FAILURES + 1))
    # Провал копии НЕ засыпает молча на сутки: строка алерта в stderr — одним кодом, как у алертов в базе [Р-156],
    # и отметка файлом. Довести это до владельца обязан внешний контроль [Р-127]: доставка алертов ходит в базу
    # (`tenant_data.alert`, миграция 0120), а контейнер копии в базу не ходит и нашего кода в себе не несёт.
    echo "{\"event\":\"ALERT\",\"code\":\"BACKUP_FAILED\",\"severity\":\"CRITICAL\",\"at\":\"$STAMP\",\"consecutive\":$FAILURES}" >&2
    printf '{"code":"BACKUP_FAILED","at":"%s","consecutive":%s}\n' "$STAMP" "$FAILURES" > "$FAILED_MARK"
    NEXT="$RETRY"
  fi
  # Срок хранения копий ≤ 7 суток: иначе данные каналов переживут 18 месяцев в копиях (docs/data-retention.md, OQ-61)
  # `-mtime +N` удаляет файлы старше N ПОЛНЫХ суток, поэтому берётся на сутки меньше: заявлено «не больше 7»
  find "$OUT" -name 'repracer-*' -type f -mtime "+$((KEEP_DAYS - 1))" -delete
  if [[ "$ONCE" == 1 ]]; then [[ "$FAILURES" -eq 0 ]] && exit 0 || exit 1; fi
  sleep "$NEXT"
done
