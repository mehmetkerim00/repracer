#!/usr/bin/env bash
# Шаг 124 [Р-248]: секреты пилота — на машине владельца, в каталоге секретов вне репозитория (по умолчанию $HOME/.config/repracer/secrets/pilot), права 700/600.
# Создаются только недостающие файлы: пароли ролей, кольцо ключей токенов каналов, пароли ClickHouse, строки подключения процессов. Секрет клиента LWA и
# идентификаторы приложения Amazon берутся из файла ключей боевого приложения ($HOME/.config/repracer/secrets/amazon-production.env). Ни одно значение не
# печатается — вывод называет только имена файлов. На сервер их копирует deploy/pilot/push-secrets.sh. Токен туннеля (tunnel.env) кладёт владелец
# при создании туннеля (deploy/pilot/README.md, §3).
#   deploy/pilot/secrets.sh
# Переменные: REPRACER_PILOT_LOCAL_SECRETS (каталог), REPRACER_AMAZON_PRODUCTION_ENV (ключи приложения), REPRACER_PILOT_DB (имя базы, как в pilot.env).
set -euo pipefail
umask 077
OUT="${REPRACER_PILOT_LOCAL_SECRETS:-${HOME}/.config/repracer/secrets/pilot}"
AMAZON_ENV="${REPRACER_AMAZON_PRODUCTION_ENV:-${HOME}/.config/repracer/secrets/amazon-production.env}"
DB="${REPRACER_PILOT_DB:-repracer_pilot}"
[[ "${DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || { echo "REPRACER_PILOT_DB — имя базы из строчных букв, цифр и _" >&2; exit 2; }
command -v openssl > /dev/null || { echo "нужен openssl" >&2; exit 2; }
mkdir -p "${OUT}/channels"
chmod 700 "${OUT}" "${OUT}/channels"

# Роли подключения процессов пилота [Р-90]: по паролю на роль. Остальные роли входа (ретранслятор, приёмники) в пилоте не работают и пароля не получают —
# войти ими по сети нельзя
ROLES=(svc_app svc_admin svc_authenticator svc_onboarding svc_provisioning svc_dispatcher svc_stock svc_scheduler svc_exporter svc_fx_loader
  svc_bulk_worker svc_alert_delivery svc_credentials svc_operator)

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
for r in "${ROLES[@]}"; do [ -n "$(pw "$r")" ] || { echo "в pg_role_passwords нет роли $r — допишите строку «$r <пароль>» или удалите файл" >&2; exit 1; }; done
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
  # Подоболочка: переменные файла ключей не переживают её и не попадают ни в окружение, ни в вывод
  ( set -a; . "${AMAZON_ENV}"; set +a
    for v in AMAZON_PRODUCTION_APP_ID AMAZON_PRODUCTION_LWA_CLIENT_ID AMAZON_PRODUCTION_LWA_CLIENT_SECRET; do
      [ -n "${!v:-}" ] || { echo "в ${AMAZON_ENV} нет ${v}" >&2; exit 1; }
    done
    [ -e "${OUT}/amazon_lwa_client_secret" ] || printf '%s' "${AMAZON_PRODUCTION_LWA_CLIENT_SECRET}" > "${OUT}/amazon_lwa_client_secret"
    [ -e "${OUT}/amazon.env" ] \
      || printf 'REPRACER_AMAZON_APP_ID=%s\nREPRACER_AMAZON_LWA_CLIENT_ID=%s\n' "${AMAZON_PRODUCTION_APP_ID}" "${AMAZON_PRODUCTION_LWA_CLIENT_ID}" > "${OUT}/amazon.env" )
  chmod 600 "${OUT}/amazon_lwa_client_secret" "${OUT}/amazon.env"
  made+=("${amazon_missing[@]}")
fi

[ ${#made[@]} -eq 0 ] || echo "создано: $(printf '%s ' "${made[@]}" | sort -u | xargs)"
[ ${#kept[@]} -eq 0 ] || echo "оставлено как было: ${#kept[@]} файлов"
[ -e "${OUT}/tunnel.env" ] || echo "нет tunnel.env — токен туннеля кладёт владелец при создании туннеля (deploy/pilot/README.md, §3)"
echo "каталог секретов пилота: ${OUT}"
