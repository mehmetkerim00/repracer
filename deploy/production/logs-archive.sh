#!/bin/bash
# Шаг 54 (OWASP A09, DPP Amazon: журналы ≥ 12 месяцев). Решение руководителя: горячий хвост на сервере — сутки сжатым файлом,
# не меньше 30 суток; дальше — сжатые МЕСЯЧНЫЕ архивы рядом с архивом событий, тем же видом ключа, что у архива ядра
# (`tenant=<id>/<таблица>/<секция>.json.gz`, packages/analytics-export): `platform=logs/<проект compose>/<ГГГГ-ММ>.log.gz`.
# Вынос с сервера — вместе с резервной копией (README, «Вынос с сервера»). Отдельного хранилища журналов не заводим до замеров пилота.
#
# Запускается НА ХОСТЕ раз в сутки таймером systemd (deploy/production/systemd): журналы контейнеров видит только docker.
#   logs-archive.sh            — вчерашние сутки UTC
#   logs-archive.sh 2026-09-28 — названные сутки (повторный запуск тех же суток перезаписывает их файл — безвредно)
#
# Секретов здесь нет: процессы токены и тела запросов в журнал не пишут [Р-177], прокси убирает заголовок Authorization.
set -euo pipefail

HOT="${REPRACER_LOGS_HOT_DIR:?set REPRACER_LOGS_HOT_DIR}"
ARCHIVE="${REPRACER_ARCHIVE_DIR:?set REPRACER_ARCHIVE_DIR}"
HOT_DAYS="${REPRACER_LOGS_HOT_DAYS:-30}"
# ≥ 12 месяцев: месяц уходит, когда ему больше 13 — последний полный месяц срока не теряется на границе
KEEP_MONTHS="${REPRACER_LOGS_KEEP_MONTHS:-13}"
PROJECTS="${REPRACER_LOG_PROJECTS:-repracer-production repracer-scheduler repracer-worker repracer-notification-receiver}"
DOCKER="${REPRACER_DOCKER:-docker}"

# Даты: GNU date на сервере, BSD date на машине разработчика (тест)
shift_day() { date -u -d "$1 $2 days" +%Y-%m-%d 2>/dev/null || date -u -j -v"$2"d -f %Y-%m-%d "$1" +%Y-%m-%d; }
shift_month() { date -u -d "$1-01 $2 months" +%Y-%m 2>/dev/null || date -u -j -v"$2"m -f %Y-%m-%d "$1-01" +%Y-%m; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

DAY="${1:-$(shift_day "$(date -u +%Y-%m-%d)" -1)}"
[[ "$DAY" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { echo "{\"event\":\"LOGS_ARCHIVE_BAD_DAY\",\"day\":\"$DAY\"}" >&2; exit 2; }
CUTOFF_DAY="$(shift_day "$DAY" "-$HOT_DAYS")"
CUTOFF_MONTH="${CUTOFF_DAY:0:7}"
OLDEST_MONTH="$(shift_month "${DAY:0:7}" "-$KEEP_MONTHS")"

for P in $PROJECTS; do
  mkdir -p "$HOT/$P" "$ARCHIVE/platform=logs/$P"
  # 1. Сутки — одним сжатым файлом. Сначала .part: оборванная выгрузка не выдаёт себя за сутки
  OUT="$HOT/$P/$DAY.log.gz"
  "$DOCKER" compose -p "$P" logs --no-color --timestamps --since "${DAY}T00:00:00Z" --until "${DAY}T23:59:59.999999999Z" | gzip -9 > "$OUT.part"
  mv "$OUT.part" "$OUT"

  # 2. Месяц, целиком вышедший из горячего окна (все его сутки старше CUTOFF_DAY), становится одним архивом. Горячий хвост поэтому
  #    от 30 до 61 суток. Архив собирается ТОЛЬКО пока его нет: если процесс упал после сборки и до удаления суток, следующий запуск
  #    лишь доудалит сутки — архив уже собран из полного набора, пересборка из остатка потеряла бы удалённое
  for M in $(ls "$HOT/$P" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}\)-[0-9]\{2\}\.log\.gz$/\1/p' | sort -u); do
    [[ "$M" < "$CUTOFF_MONTH" ]] || continue
    DEST="$ARCHIVE/platform=logs/$P/$M.log.gz"
    if [[ ! -f "$DEST" ]]; then
      # Сжатые файлы суток склеиваются как есть: цепочка gzip-членов — корректный gzip
      cat $(ls "$HOT/$P/$M"-*.log.gz | sort) > "$DEST.part"
      sha "$DEST.part" > "$DEST.sha256"
      mv "$DEST.part" "$DEST"
      echo "{\"event\":\"LOGS_MONTH_ARCHIVED\",\"project\":\"$P\",\"month\":\"$M\"}"
    fi
    rm -f "$HOT/$P/$M"-*.log.gz
  done

  # 3. Месячные архивы старше срока уходят (≥ 12 месяцев хранятся всегда)
  for F in "$ARCHIVE/platform=logs/$P"/*.log.gz; do
    [[ -e "$F" ]] || continue
    M="$(basename "$F" .log.gz)"
    if [[ "$M" < "$OLDEST_MONTH" ]]; then rm -f "$F" "$F.sha256"; echo "{\"event\":\"LOGS_MONTH_EXPIRED\",\"project\":\"$P\",\"month\":\"$M\"}"; fi
  done
done
echo "{\"event\":\"LOGS_DAY_DONE\",\"day\":\"$DAY\"}"
