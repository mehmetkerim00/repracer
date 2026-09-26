#!/usr/bin/env bash
# Шаг 28, D: развёртывания поднимаются по-настоящему. Каждый из трёх процессов (планировщик, путь решения за брокером, приёмник
# уведомлений) стартует своим compose-файлом, читает секреты из файлов и обязан ответить 200 на /healthz. Не ответил — красная
# сборка и логи контейнера в журнале.
#
# Использование (CI): PG_HOST=host.docker.internal scripts/deploy-smoke.sh
# Данные синтетические: секреты создаются здесь же, во временном каталоге, и удаляются в конце.
set -euo pipefail
cd "$(dirname "$0")/.."

PG_HOST="${PG_HOST:-host.docker.internal}"
PG_PORT="${PG_PORT:-5432}"
DB="${DB:-repracer_eu}"
KAFKA="${KAFKA:-host.docker.internal:19092}"
CH_URL="${CH_URL:-http://host.docker.internal:18123}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"

SECRETS="$(mktemp -d)"
trap 'rm -rf "$SECRETS"' EXIT
mkdir -p "$SECRETS/channels"
url() { printf 'postgres://%s@%s:%s/%s' "$1" "$PG_HOST" "$PG_PORT" "$DB" > "$SECRETS/$2"; }
url svc_scheduler scheduler_pg_url
url svc_app app_pg_url
url svc_exporter exporter_pg_url
url svc_dispatcher dispatcher_pg_url
url svc_relay relay_pg_url
url svc_inbound inbound_pg_url
# Шаг 37 [Р-159]: у консоли — по файлу на роль подключения (apps/console/server/config.ts, CONSOLE_ROLES)
for role in app admin authenticator onboarding provisioning dispatcher stock scheduler exporter fx_loader bulk_worker; do
  url "svc_${role}" "console_${role}_pg_url"
done
# Роль доставки алертов и ключ почты: их называет compose планировщика безусловно, и без файлов плоский профиль
# (без надстройки CI) не разбирается — находка 2 ревью шага 37
url svc_alert_delivery alert_delivery_pg_url
# Шаг 40 [Р-165]: роль панели оператора — свой файл, как у всех остальных
url svc_operator operator_pg_url
printf 'syn-mail-key' > "$SECRETS/mail_api_key"
# Адрес внешней отметки [Р-127]: синтетический, аккаунта сервиса у проекта нет (OQ-188). Нужен, чтобы РАЗБИРАЛАСЬ
# конфигурация плоского профиля; отметки при этом никто не шлёт — процессы CI поднимаются с выключателем
printf 'https://hc-ping.example.invalid/00000000-0000-4000-8000-000000000000' > "$SECRETS/heartbeat_url"
printf 'https://hc-ping.example.invalid/00000000-0000-4000-8000-000000000001' > "$SECRETS/console_heartbeat_url"
printf 'https://hc-ping.example.invalid/00000000-0000-4000-8000-000000000002' > "$SECRETS/worker_heartbeat_url"
printf 'https://hc-ping.example.invalid/00000000-0000-4000-8000-000000000003' > "$SECRETS/receiver_heartbeat_url"
printf 'https://hc-ping.example.invalid/00000000-0000-4000-8000-000000000004' > "$SECRETS/operator_heartbeat_url"
# Шаг 38: ключ гостевого издателя — файлом, как в работе. Синтетический, создаётся здесь же и уходит вместе с каталогом
openssl ecparam -name prime256v1 -genkey -noout 2>/dev/null | openssl pkcs8 -topk8 -nocrypt -out "$SECRETS/console_guest_key" 2>/dev/null
printf 'ci-synthetic-ingest' > "$SECRETS/ch_ingest_password"
printf 'ci-synthetic-verifier' > "$SECRETS/ch_verifier_password"
# Очередь и ключи AWS — синтетические: живой очереди нет (OQ-167), проверяется старт процесса, а не работа с очередью
printf 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-ci' > "$SECRETS/sqs_queue_url"
printf 'AKIASYNTHETIC0000001' > "$SECRETS/aws_access_key_id"
printf 'syn-aws-secret-access-key-0001' > "$SECRETS/aws_secret_access_key"
printf 'syn-aws-session-token-0001' > "$SECRETS/aws_session_token"
printf '{"clientKey":"syn-client","secretKey":"syn-secret"}' > "$SECRETS/channels/secret-ref_amazon-application"
# Процессы работают от uid 1000, а каталог mktemp принадлежит пользователю сборки с правами 0700: без этого файлы секретов
# контейнеру не видны (CONFIG_SECRET_UNREADABLE, прогон 35380553447). В работе каталог принадлежит служебному пользователю и
# открывать его так не нужно — это послабление ТОЛЬКО для синтетических секретов проверки
chmod -R a+rX "$SECRETS"

# Конфигурации разбираются до поднятия контейнеров: так расхождение видно по имени переменной, а не по падению процесса в журнале
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/deploy-config-check.mjs "$SECRETS"

common_env=(
  "REPRACER_SECRETS_DIR=$SECRETS"
  "REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF=secret-ref:amazon-application"
  "REPRACER_KAUFLAND_FALLBACK_EMAIL=ops@example.invalid"
)

# Отметка во внешнем сервисе выключена явно — в надстройках CI (OQ-188, OQ-198). Здесь её задавать бесполезно: в контейнер попадает
# только то, что названо в `environment` самого развёртывания, и первый прогон задачи D этим и упал (CI 35370892895)
declare -a stacks=(
  "scheduler|deploy/scheduler/compose.yaml|deploy/ci/scheduler.override.yaml|9464|REPRACER_CH_URL=$CH_URL REPRACER_CH_INGEST_USER=repracer_ci_ingest REPRACER_CH_VERIFIER_USER=repracer_ci_verifier"
  "worker|deploy/worker/compose.yaml|deploy/ci/worker.override.yaml|9465|REPRACER_KAFKA_BROKERS=$KAFKA"
  "receiver|deploy/notification-receiver/compose.yaml|deploy/ci/receiver.override.yaml|9466|REPRACER_AMAZON_REGION=EU REPRACER_AMAZON_APPLICATION_ID=amzn1.sellerapps.app.00000000-0000-0000-0000-000000000000"
)

started=()
failed=0
for stack in "${stacks[@]}"; do
  IFS='|' read -r name compose override port extra <<< "$stack"
  echo "== $name"
  # shellcheck disable=SC2086
  env "${common_env[@]}" $extra docker compose -f "$compose" -f "$override" up -d
  started+=("$name|$compose|$override|$extra")
  ok=0
  for _ in $(seq 1 "$WAIT_SECONDS"); do
    if curl -sf "http://127.0.0.1:$port/healthz" > /dev/null; then ok=1; break; fi
    sleep 1
  done
  if [ "$ok" = 1 ]; then
    echo "   $name: /healthz ответил 200"
    curl -s "http://127.0.0.1:$port/metrics" | head -5
  else
    echo "   $name: /healthz не ответил за ${WAIT_SECONDS} с"
    # shellcheck disable=SC2086
    env "${common_env[@]}" $extra docker compose -f "$compose" -f "$override" logs --tail 80
    failed=1
  fi
done

# --------------------------------------------------------------------------- Р-159: профиль production целиком
# Поднимается ВЕСЬ профиль (прокси + консоль), и прогон ходит по нему как браузер: через прокси, без заголовков, которых
# не послала бы страница. До шага 37 прокси отвечал 503 — консоли как процесса не было (OQ-221)
# Интерфейс собирается ДО подъёма: контейнер видит репозиторий только на чтение и собрать себя не может [Р-159]
if [ ! -f apps/console/dist/index.html ]; then
  echo "== сборка интерфейса (apps/console/dist)"
  npm run build -w apps/console
fi
echo "== production (прокси + консоль)"
PROD=(-f deploy/production/compose.yaml -f deploy/ci/production.override.yaml)
prod_env=("REPRACER_SECRETS_DIR=$SECRETS" "REPRACER_BACKUP_DIR=$SECRETS" "REPRACER_DOMAIN=localhost" "REPRACER_ACME_EMAIL=ci@example.invalid"
  # Шаг 40 [Р-165]: панель оператора поднимается вместе с профилем — со своим входом и своим портом
  "REPRACER_OPERATOR_OIDC_ISSUER=https://identity.example.invalid" "REPRACER_OPERATOR_OIDC_AUDIENCE=repracer-operator"
  "REPRACER_OPERATOR_OIDC_JWKS_URL=https://identity.example.invalid/keys"
  "REPRACER_OPERATOR_INVITATION_URL=https://app.example.invalid/invitation")
env "${prod_env[@]}" docker compose "${PROD[@]}" up -d
prod_ok=0
# Демо-тенант заводится при старте консоли: 200 предложений с конкурентами — это минуты, а не секунды
for _ in $(seq 1 "${CONSOLE_WAIT_SECONDS:-420}"); do
  if curl -sf "http://127.0.0.1:9467/healthz" > /dev/null; then prod_ok=1; break; fi
  sleep 1
done
if [ "$prod_ok" = 1 ]; then
  echo "   console: /healthz ответил 200"
  if node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/console-guest-walk.mjs http://127.0.0.1:8080; then
    echo "   production: путь гостя пройден через прокси"
  else
    echo "   production: путь гостя НЕ пройден"
    env "${prod_env[@]}" docker compose "${PROD[@]}" logs --tail 120
    failed=1
  fi
  # Шаг 40 [Р-165]: панель жива на СВОЁМ порту и недостижима через публичный прокси — иначе «не публичная» было бы словом
  op_ok=0
  for _ in $(seq 1 "${OPERATOR_WAIT_SECONDS:-90}"); do
    if curl -sf "http://127.0.0.1:9471/healthz" > /dev/null; then op_ok=1; break; fi
    sleep 1
  done
  if [ "$op_ok" = 1 ]; then
    echo "   operator: /healthz ответил 200"
    # Находка 2 ревью шага 40: кодом ответа это не проверяется — панель и БЕЗ токена отвечает 401, и «не 200» было бы
    # истинно даже стоя за прокси. Ищем ОТПЕЧАТОК самой панели: `NO_TOKEN` встречается в репозитории один раз
    # (apps/operator/server/panel.ts), а `operator panel` — только в её странице
    through_proxy="$(curl -s -i http://127.0.0.1:8080/api/operator/tenants || true)$(curl -s http://127.0.0.1:8080/ || true)"
    if printf '%s' "$through_proxy" | grep -qE 'NO_TOKEN|operator panel'; then
      echo "   operator: панель ОТВЕЧАЕТ через публичный прокси — этого быть не должно [Р-165]"
      failed=1
    else
      echo "   operator: через публичный прокси панели нет [Р-165]"
      # Положительный контроль к проверке выше: на СВОЁМ порту тот же адрес отвечает отпечатком панели
      if curl -s http://127.0.0.1:4327/api/operator/tenants | grep -q 'NO_TOKEN'; then
        echo "   operator: на своём порту отпечаток панели виден — проверка выше способна покраснеть"
      else
        echo "   operator: отпечаток панели не найден и на СВОЁМ порту — проверка непубличности ничего не значит"
        failed=1
      fi
    fi
  else
    echo "   operator: /healthz не ответил за ${OPERATOR_WAIT_SECONDS:-90} с"
    env "${prod_env[@]}" docker compose "${PROD[@]}" logs --tail 120 operator
    failed=1
  fi
else
  echo "   console: /healthz не ответил за ${CONSOLE_WAIT_SECONDS:-420} с"
  env "${prod_env[@]}" docker compose "${PROD[@]}" logs --tail 120
  failed=1
fi
env "${prod_env[@]}" docker compose "${PROD[@]}" down -v --remove-orphans > /dev/null 2>&1 || true

for stack in "${started[@]}"; do
  IFS='|' read -r name compose override extra <<< "$stack"
  # shellcheck disable=SC2086
  env "${common_env[@]}" $extra docker compose -f "$compose" -f "$override" down -v --remove-orphans > /dev/null 2>&1 || true
done

if [ "$failed" = 1 ]; then
  echo "DEPLOY SMOKE RED: не все процессы развёртывания поднялись"
  exit 1
fi
echo "DEPLOY SMOKE: три процесса и профиль production поднялись; гость прошёл путь через прокси"
