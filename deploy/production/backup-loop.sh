#!/bin/bash
# Р-158 (шаг 36): суточная копия PostgreSQL и срок её хранения. Копия без ПРОВЕРЕННОГО восстановления — обещание,
# поэтому восстановление проверяется тестом сборки (packages/pricing-store-pg/test/backup-restore.pg.test.ts), а не абзацем в README.
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
  # Роли кластера копия базы не содержит: без них восстановление на ЧИСТОМ сервере не поднимет ни политик, ни прав
  # (находка 17 ревью шага 36). Пароли ролей не выгружаются — они и не наши: строки подключения лежат в секретах
  if pg_dump --dbname="$PGURL" --format=custom --file="$FILE.part" \
     && pg_dumpall --dbname="$PGURL" --globals-only --no-role-passwords --file="$FILE.globals.sql"; then
    mv "$FILE.part" "$FILE"
    sha256sum "$FILE" "$FILE.globals.sql" | awk '{print $1}' > "$FILE.sha256"
    echo "{\"event\":\"BACKUP_DONE\",\"file\":\"$(basename "$FILE")\",\"bytes\":$(stat -c %s "$FILE")}"
  else
    rm -f "$FILE.part" "$FILE.globals.sql"
    # Провал копии не молчит: строка журнала — то, что видит эксплуатация [Р-127 об остальном контроле]
    echo "{\"event\":\"BACKUP_FAILED\",\"at\":\"$STAMP\"}" >&2
  fi
  # Срок хранения копий ≤ 7 суток: иначе данные каналов переживут 18 месяцев в копиях (docs/data-retention.md, OQ-61)
  # `-mtime +N` удаляет файлы старше N ПОЛНЫХ суток, поэтому берётся на сутки меньше: заявлено «не больше 7»
  find "$OUT" -name 'repracer-*' -type f -mtime "+$((KEEP_DAYS - 1))" -delete
  sleep "$EVERY"
done
