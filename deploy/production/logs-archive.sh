#!/bin/bash
# Шаг 54 (OWASP A09, DPP Amazon: журналы ≥ 12 месяцев). Решение руководителя: горячий хвост на сервере — сутки сжатым файлом,
# не меньше 30 суток; дальше — сжатые МЕСЯЧНЫЕ архивы рядом с архивом событий, тем же видом ключа, что у архива ядра
# (`tenant=<id>/<таблица>/<секция>.json.gz`, packages/analytics-export): `platform=logs/<проект compose>/<ГГГГ-ММ>.log.gz`.
# Вынос с сервера — вместе с резервной копией (README, 3в). Отдельного хранилища журналов не заводим до замеров пилота.
#
# Шаг 55 (ревью шага 54, находки 10–12): у каждого проекта — ОТМЕТКА «выгружено по» (`$HOT/<проект>/.until`). Заход выгружает всё от
# отметки до своего конца, сутками: пропущенные сутки догоняются, а не теряются. Журнал контейнера живёт, пока жив контейнер, и
# `docker compose up`, пересоздающий контейнер, уносит его — поэтому перед каждой выкладкой запускается `logs-archive.sh --until-now`
# (README, раздел 3): выгружается текущий день по сей момент, а ночной заход допишет остаток суток в тот же файл. Сбой одного проекта
# не останавливает остальные: он пишется строкой ALERT и файлом-отметкой `LOGS_ARCHIVE_FAILED`, код выхода — 1.
#
#   logs-archive.sh              — полные сутки UTC до сегодняшней полуночи (таймер systemd, 00:20 UTC)
#   logs-archive.sh --until-now  — по текущий момент (перед выкладкой)
#
# Время — REPRACER_LOGS_NOW (ISO UTC), если задано: так проверка не зависит от настоящих часов (шаг 55, п. 3); иначе часы хоста.
# Секретов здесь нет: процессы токены и тела запросов в журнал не пишут [Р-177], прокси убирает заголовок Authorization.
set -uo pipefail

HOT="${REPRACER_LOGS_HOT_DIR:?set REPRACER_LOGS_HOT_DIR}"
ARCHIVE="${REPRACER_ARCHIVE_DIR:?set REPRACER_ARCHIVE_DIR}"
HOT_DAYS="${REPRACER_LOGS_HOT_DAYS:-30}"
# ≥ 12 месяцев: месяц уходит, когда ему больше 13 — последний полный месяц срока не теряется на границе
KEEP_MONTHS="${REPRACER_LOGS_KEEP_MONTHS:-13}"
PROJECTS="${REPRACER_LOG_PROJECTS:-repracer-production repracer-scheduler repracer-worker repracer-notification-receiver}"
DOCKER="${REPRACER_DOCKER:-docker}"
NOW="${REPRACER_LOGS_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# Даты: GNU date на сервере, BSD date на машине разработчика (тест)
# BSD `-v` без знака УСТАНАВЛИВАЕТ поле (`-v1d` — первое число), а не прибавляет: знак ставится всегда (шаг 55 — сдвиг вперёд зацикливал заход)
signed() { [[ "$1" == -* || "$1" == +* ]] && echo "$1" || echo "+$1"; }
shift_day() { date -u -d "$1 $2 days" +%Y-%m-%d 2>/dev/null || date -u -j -v"$(signed "$2")"d -f %Y-%m-%d "$1" +%Y-%m-%d; }
shift_month() { date -u -d "$1-01 $2 months" +%Y-%m 2>/dev/null || date -u -j -v"$(signed "$2")"m -f %Y-%m-%d "$1-01" +%Y-%m; }
sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

[[ "$NOW" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "{\"event\":\"LOGS_ARCHIVE_BAD_NOW\",\"now\":\"$NOW\"}" >&2; exit 2; }
case "${1:-}" in
  --until-now) END="$NOW" ;;
  "") END="${NOW:0:10}T00:00:00Z" ;;
  *) echo "{\"event\":\"LOGS_ARCHIVE_BAD_ARGUMENT\",\"argument\":\"$1\"}" >&2; exit 2 ;;
esac
TODAY="${NOW:0:10}"
CUTOFF_MONTH="$(shift_day "$TODAY" "-$HOT_DAYS")"; CUTOFF_MONTH="${CUTOFF_MONTH:0:7}"
OLDEST_MONTH="$(shift_month "${TODAY:0:7}" "-$KEEP_MONTHS")"
FAILED=0

archive_project() {
  local P="$1" mark from day seg_end out pend_end pend_out
  mkdir -p "$HOT/$P" "$ARCHIVE/platform=logs/$P"
  mark="$HOT/$P/.until"
  # Шаг 59 (ревью шага 58, находка 5): процесс, убитый между заменой файла суток и сдвигом отметки, выгрузил бы отрезок повторно — строки
  # задвоились бы. Отметка-кандидат (`.until.pending`: конец отрезка и файл суток) пишется ДО замены файла: осталась без `<сутки>.new` —
  # замена случилась, кандидат становится отметкой; осталась рядом с `.new` — замены не было, оба убираются и отрезок выгружается снова
  if [[ -f "$mark.pending" ]]; then
    read -r pend_end pend_out < "$mark.pending" || true
    if [[ -n "${pend_out:-}" && -f "$pend_out.new" ]]; then rm -f "$pend_out.new" "$mark.pending"
    else mv "$mark.pending" "$mark.part" && printf '%s' "$pend_end" > "$mark.part" && mv "$mark.part" "$mark"; fi
  fi
  # Первый заход проекта — со вчерашней полуночи: раньше выгрузки не было и отмечать нечего
  from="$(cat "$mark" 2>/dev/null || echo "$(shift_day "$TODAY" -1)T00:00:00Z")"
  # 1. От отметки до конца захода — по суткам UTC; каждый отрезок дописывается к файлу своих суток (цепочка gzip-членов — корректный gzip)
  while [[ "$from" < "$END" ]]; do
    day="${from:0:10}"
    seg_end="$(shift_day "$day" 1)T00:00:00Z"
    [[ "$from" < "$seg_end" ]] || { echo "{\"event\":\"LOGS_ARCHIVE_CLOCK_BROKEN\",\"from\":\"$from\"}" >&2; return 1; }
    [[ "$seg_end" < "$END" ]] || seg_end="$END"
    out="$HOT/$P/$day.log.gz"
    if ! "$DOCKER" compose -p "$P" logs --no-color --timestamps --since "$from" --until "$seg_end" | gzip -9 > "$out.part"; then
      rm -f "$out.part"
      echo "{\"event\":\"ALERT\",\"code\":\"LOGS_ARCHIVE_FAILED\",\"severity\":\"WARNING\",\"project\":\"$P\",\"from\":\"$from\"}" >&2
      return 1
    fi
    # Ревью шага 55, находка 5: каждая запись проверяется — дописывание, упавшее на полном диске, не двигает отметку и не теряет отрезок.
    # Шаг 58 (ревью шага 56, находка 11): дописывание на месте (`>>`), оборвавшееся посреди, оставляло в файле суток недописанный член gzip —
    # его находил лишь `gzip -t` архива в конце месяца. Сутки собираются в новый файл, проверяются и только тогда заменяют прежний
    parts=("$out.part"); if [[ -f "$out" ]]; then parts=("$out" "$out.part"); fi
    if ! { cat "${parts[@]}" > "$out.new" && gzip -t "$out.new" && printf '%s %s' "$seg_end" "$out" > "$mark.pending" \
           && mv "$out.new" "$out" && rm -f "$out.part" && printf '%s' "$seg_end" > "$mark.part" && mv "$mark.part" "$mark" && rm -f "$mark.pending"; }; then
      # Кандидат отметки убирается, только если замены не было; иначе его подхватит следующий заход (см. восстановление выше)
      if [[ -f "$out.new" ]]; then rm -f "$out.new" "$mark.pending"; fi
      echo "{\"event\":\"ALERT\",\"code\":\"LOGS_ARCHIVE_FAILED\",\"severity\":\"WARNING\",\"project\":\"$P\",\"from\":\"$from\",\"stage\":\"append\"}" >&2
      return 1
    fi
    # Отметка — после того, как отрезок записан: оборванный заход повторит отрезок, а не пропустит
    from="$seg_end"
  done

  # 2. Месяц, целиком вышедший из горячего окна, становится одним архивом. Горячий хвост поэтому от 30 до 61 суток. Архив собирается
  #    ТОЛЬКО пока его нет: если процесс упал после сборки и до удаления суток, следующий заход лишь доудалит сутки
  for M in $(ls "$HOT/$P" | sed -n 's/^\([0-9]\{4\}-[0-9]\{2\}\)-[0-9]\{2\}\.log\.gz$/\1/p' | sort -u); do
    [[ "$M" < "$CUTOFF_MONTH" ]] || continue
    DEST="$ARCHIVE/platform=logs/$P/$M.log.gz"
    if [[ ! -f "$DEST" ]]; then
      # Ревью шага 55, находка 5: урезанный архив (полный диск) не получает суммы и не заменяет сутки — сутки остаются, заход — провал
      if ! { cat $(ls "$HOT/$P/$M"-*.log.gz | sort) > "$DEST.part" && gzip -t "$DEST.part" && sha "$DEST.part" > "$DEST.sha256" && mv "$DEST.part" "$DEST"; }; then
        rm -f "$DEST.part" "$DEST.sha256"
        echo "{\"event\":\"ALERT\",\"code\":\"LOGS_ARCHIVE_FAILED\",\"severity\":\"WARNING\",\"project\":\"$P\",\"month\":\"$M\",\"stage\":\"month\"}" >&2
        return 1
      fi
      echo "{\"event\":\"LOGS_MONTH_ARCHIVED\",\"project\":\"$P\",\"month\":\"$M\"}"
    fi
    # Сутки удаляются только за целым архивом месяца
    gzip -t "$DEST" || { echo "{\"event\":\"ALERT\",\"code\":\"LOGS_ARCHIVE_FAILED\",\"severity\":\"WARNING\",\"project\":\"$P\",\"month\":\"$M\",\"stage\":\"verify\"}" >&2; return 1; }
    rm -f "$HOT/$P/$M"-*.log.gz
  done

  # 3. Месячные архивы старше срока уходят (≥ 12 месяцев хранятся всегда)
  for F in "$ARCHIVE/platform=logs/$P"/*.log.gz; do
    [[ -e "$F" ]] || continue
    M="$(basename "$F" .log.gz)"
    if [[ "$M" < "$OLDEST_MONTH" ]]; then rm -f "$F" "$F.sha256"; echo "{\"event\":\"LOGS_MONTH_EXPIRED\",\"project\":\"$P\",\"month\":\"$M\"}"; fi
  done
}

for P in $PROJECTS; do archive_project "$P" || FAILED=1; done
# Отметка провала для внешнего контроля — как у копии базы (BACKUP_FAILED): живёт, пока заход не удался целиком
if [[ "$FAILED" == 1 ]]; then
  printf '{"code":"LOGS_ARCHIVE_FAILED","at":"%s"}\n' "$NOW" > "$HOT/LOGS_ARCHIVE_FAILED"
  exit 1
fi
rm -f "$HOT/LOGS_ARCHIVE_FAILED"
echo "{\"event\":\"LOGS_ARCHIVE_DONE\",\"until\":\"$END\"}"
