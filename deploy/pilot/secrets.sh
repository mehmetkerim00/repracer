#!/usr/bin/env bash
# Шаг 124 [Р-248]: секреты пилота — на машине владельца, в каталоге секретов вне репозитория (по умолчанию $HOME/.config/repracer/secrets/pilot), права 700/600.
# Создаются только недостающие файлы: пароли ролей, кольцо ключей токенов каналов, пароли ClickHouse, строки подключения процессов. Секрет клиента LWA и
# идентификаторы приложения Amazon берутся из файла ключей боевого приложения ($HOME/.config/repracer/secrets/amazon-production.env). Ни одно значение не
# печатается — вывод называет только имена файлов. На сервер их копирует deploy/pilot/push-secrets.sh. Токен туннеля (tunnel.env) кладёт владелец
# при создании туннеля (deploy/pilot/README.md, §3).
#   deploy/pilot/secrets.sh
# Переменные: REPRACER_PILOT_LOCAL_SECRETS (каталог), REPRACER_AMAZON_PRODUCTION_ENV (ключи приложения), REPRACER_AMAZON_SANDBOX_ENV (ключи песочного
# приложения — только для сверки: ни один ключ боевого не равен ключу песочного, шаг 185), REPRACER_PILOT_DB (имя базы, как в pilot.env).
set -euo pipefail
umask 077
OUT="${REPRACER_PILOT_LOCAL_SECRETS:-${HOME}/.config/repracer/secrets/pilot}"
AMAZON_ENV="${REPRACER_AMAZON_PRODUCTION_ENV:-${HOME}/.config/repracer/secrets/amazon-production.env}"
SANDBOX_ENV="${REPRACER_AMAZON_SANDBOX_ENV:-${HOME}/.config/repracer/secrets/amazon-sandbox.env}"

# Значение строки KEY= файла ключей — как текст (шаг 185, отложенное «134»): `source` исполнял весь файл, и значение с `|` (так начинаются
# токены LWA) bash принимал за конвейер и печатал остаток. Нет строки — пусто; строк больше одной — отказ; кавычки вокруг значения снимаются
key_line() {
  local n
  n=$(grep -c "^$2=" "$1" || true)
  [ "${n}" -le 1 ] || { echo "в $1 строк $2=: ${n}, нужна одна" >&2; return 1; }
  sed -n "s/^$2=//p" "$1" | tr -d '\r' | sed -E "s/^\"(.*)\"\$/\\1/; s/^'(.*)'\$/\\1/"
}
DB="${REPRACER_PILOT_DB:-repracer_pilot}"
[[ "${DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "REPRACER_PILOT_DB — имя базы из строчных букв, цифр и _" >&2; exit 2; }
command -v openssl > /dev/null || { echo "нужен openssl" >&2; exit 2; }
mkdir -p "${OUT}/channels"
chmod 700 "${OUT}" "${OUT}/channels"

# Роли подключения процессов пилота [Р-90]: по паролю на роль. Остальные роли входа (приёмники) в пилоте не работают и пароля не получают —
# войти ими по сети нельзя. Шаг 141: svc_relay — ретранслятор outbox процесса пути решения (путь записи, профиль live)
ROLES=(svc_app svc_admin svc_authenticator svc_onboarding svc_provisioning svc_dispatcher svc_stock svc_scheduler svc_exporter svc_fx_loader
  svc_bulk_worker svc_alert_delivery svc_credentials svc_operator svc_relay)

made=()
kept=()
put() { # имя файла, значение — со стандартного ввода; существующий не трогается
  if [ -e "${OUT}/$1" ]; then kept+=("$1"); cat > /dev/null; return; fi
  cat > "${OUT}/$1"
  chmod 600 "${OUT}/$1"
  made+=("$1")
}
secret() { openssl rand -hex 24; }

secret | tr -d '\n' | put postgres_password
if [ ! -e "${OUT}/pg_role_passwords" ]; then
  for r in "${ROLES[@]}"; do printf '%s %s\n' "$r" "$(secret)"; done | put pg_role_passwords
else
  kept+=(pg_role_passwords)
fi
pw() { awk -v r="$1" '$1 == r { print $2 }' "${OUT}/pg_role_passwords"; }
# Шаг 141: роль, которой не было, когда файл создавался (новая версия пилота), дописывается своим паролем; прежние пароли не меняются.
# db.sh задаёт пароли ролей при каждой выкладке, поэтому новая роль начинает работать со следующей
added=()
for r in "${ROLES[@]}"; do
  [ -n "$(pw "$r")" ] && continue
  printf '%s %s
' "$r" "$(secret)" >> "${OUT}/pg_role_passwords"
  added+=("$r")
done
[ ${#added[@]} -eq 0 ] || echo "добавлены роли: ${added[*]} (пароль — в pg_role_passwords; на сервер — push-secrets.sh, задаст выкладка)"
url() { printf 'postgres://%s:%s@postgres:5432/%s' "$1" "$(pw "$1")" "${DB}"; }
# Консоль: файл на роль (apps/console/server/config.ts, CONSOLE_ROLES)
for role in app admin authenticator onboarding provisioning dispatcher stock scheduler exporter fx_loader bulk_worker; do
  url "svc_${role}" | put "console_${role}_pg_url"
done
# Планировщик (deploy/scheduler/compose.yaml) и панель (deploy/operator/compose.yaml) — свои имена файлов
url svc_scheduler | put scheduler_pg_url
url svc_app | put app_pg_url
url svc_stock | put stock_pg_url
url svc_exporter | put exporter_pg_url
url svc_alert_delivery | put alert_delivery_pg_url
url svc_credentials | put credentials_pg_url
url svc_operator | put operator_pg_url
# Шаг 141: процесс пути решения (deploy/worker, профиль live) — диспетчер записей и ретранслятор outbox; svc_app — тот же app_pg_url
url svc_dispatcher | put dispatcher_pg_url
url svc_relay | put relay_pg_url
# Шаг 126: копия базы — суперпользователем (pg_dump всей базы под FORCE RLS и роли кластера без паролей, deploy/production/backup-loop.sh)
printf 'postgres://postgres:%s@postgres:5432/%s' "$(cat "${OUT}/postgres_password")" "${DB}" | put backup_pg_url

# ClickHouse: администратор кластера пилота (образ заводит его при первом старте) и логины ролей выгрузки
if [ ! -e "${OUT}/clickhouse.env" ]; then
  admin="$(secret)"
  printf 'CLICKHOUSE_USER=pilot_admin\nCLICKHOUSE_PASSWORD=%s\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\nREPRACER_CH_USER=pilot_admin\nREPRACER_CH_PASSWORD=%s\n' "${admin}" "${admin}" | put clickhouse.env
else
  kept+=(clickhouse.env)
fi
secret | tr -d '\n' | put ch_ingest_password
secret | tr -d '\n' | put ch_verifier_password

# Кольцо ключей токенов каналов [Р-177]: 32 случайных байта; без него токен продавца не записать
printf '{"current":"k1","keys":{"k1":"%s"}}' "$(openssl rand -base64 32)" | put channel_keyring.json

# Приложение Amazon — из файла ключей боевого приложения. Значения не печатаются; нет файла или переменной — отказ с именем переменной
amazon_missing=()
for f in amazon_lwa_client_secret amazon.env; do if [ -e "${OUT}/$f" ]; then kept+=("$f"); else amazon_missing+=("$f"); fi; done
if [ ${#amazon_missing[@]} -gt 0 ]; then
  [ -r "${AMAZON_ENV}" ] || { echo "нет файла ключей боевого приложения Amazon: ${AMAZON_ENV}" >&2; exit 1; }
  # Подоболочка: значения ключей не переживают её, не экспортируются и не попадают в вывод. Файл не исполняется (шаг 185, отложенное «134»):
  # строки KEY= читаются как текст, и строка с другим ключом ничего не делает
  ( for k in APP_ID LWA_CLIENT_ID LWA_CLIENT_SECRET; do
      v="AMAZON_PRODUCTION_${k}"
      printf -v "${v}" '%s' "$(key_line "${AMAZON_ENV}" "${v}")"
      [ -n "${!v}" ] || { echo "в ${AMAZON_ENV} нет ${v}" >&2; exit 1; }
      # Шаг 185: 2026-11-26 в файле ключей боевого приложения нашлись ключи песочного — пилот подключился бы к песочному приложению молча
      if [ -r "${SANDBOX_ENV}" ] && [ "${!v}" = "$(key_line "${SANDBOX_ENV}" "AMAZON_SANDBOX_${k}")" ]; then
        echo "${v} в ${AMAZON_ENV} совпадает с AMAZON_SANDBOX_${k} в ${SANDBOX_ENV}: это ключ песочного приложения, а не боевого" >&2; exit 1
      fi
    done
    [ -e "${OUT}/amazon_lwa_client_secret" ] || printf '%s' "${AMAZON_PRODUCTION_LWA_CLIENT_SECRET}" > "${OUT}/amazon_lwa_client_secret"
    [ -e "${OUT}/amazon.env" ] \
      || printf 'REPRACER_AMAZON_APP_ID=%s\nREPRACER_AMAZON_LWA_CLIENT_ID=%s\n' "${AMAZON_PRODUCTION_APP_ID}" "${AMAZON_PRODUCTION_LWA_CLIENT_ID}" > "${OUT}/amazon.env" )
  chmod 600 "${OUT}/amazon_lwa_client_secret" "${OUT}/amazon.env"
  made+=("${amazon_missing[@]}")
fi

[ ${#made[@]} -eq 0 ] || echo "создано: $(printf '%s ' "${made[@]}" | sort -u | xargs)"
[ ${#kept[@]} -eq 0 ] || echo "оставлено как было: ${#kept[@]} файлов"
[ -e "${OUT}/backup_public_key.asc" ] || echo "нет backup_public_key.asc — открытый ключ копий (deploy/pilot/README.md, «Копии базы»); без него выкладки нет"
[ -e "${OUT}/tunnel.env" ] || echo "нет tunnel.env — токен туннеля кладёт владелец при создании туннеля (deploy/pilot/README.md, §3)"
# Шаг 129 [Р-127]: адреса отметок кладёт не этот скрипт, а scripts/setup-heartbeats.mjs (их выдаёт внешний сервис); без них выкладки нет
[ -e "${OUT}/scheduler_heartbeat_url" ] || echo "нет *_heartbeat_url — адреса отметок внешнего контроля: scripts/setup-heartbeats.mjs --stand pilot (deploy/pilot/README.md, §9); без них выкладки нет"
echo "каталог секретов пилота: ${OUT}"
