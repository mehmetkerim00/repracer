#!/bin/bash
# Р-158 (шаг 36): суточная копия PostgreSQL и срок её хранения. Копия без ПРОВЕРЕННОГО восстановления — обещание,
# поэтому восстановление проверяется тестом сборки (scripts/backup-restore-check.mjs), а не абзацем в README.
#
# Пароль базы здесь не появляется: строка подключения читается из файла секретов (как во всех процессах).
set -euo pipefail

PGURL="$(cat "${PGURL_FILE:?set PGURL_FILE}")"
KEEP_DAYS="${REPRACER_BACKUP_KEEP_DAYS:-7}"
EVERY="${REPRACER_BACKUP_EVERY_SECONDS:-86400}"
OUT=/backups

while true; do
  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  FILE="$OUT/repracer-$STAMP.dump"
  # -Fc: формат с оглавлением, восстанавливается pg_restore целиком или по таблицам
  if pg_dump --dbname="$PGURL" --format=custom --file="$FILE.part"; then
    mv "$FILE.part" "$FILE"
    sha256sum "$FILE" | awk '{print $1}' > "$FILE.sha256"
    echo "{\"event\":\"BACKUP_DONE\",\"file\":\"$(basename "$FILE")\",\"bytes\":$(stat -c %s "$FILE")}"
  else
    rm -f "$FILE.part"
    # Провал копии не молчит: строка журнала — то, что видит эксплуатация [Р-127 об остальном контроле]
    echo "{\"event\":\"BACKUP_FAILED\",\"at\":\"$STAMP\"}" >&2
  fi
  # Срок хранения копий ≤ 7 суток: иначе данные каналов переживут 18 месяцев в копиях (docs/data-retention.md, OQ-61)
  find "$OUT" -name 'repracer-*.dump*' -type f -mtime "+$KEEP_DAYS" -delete
  sleep "$EVERY"
done
