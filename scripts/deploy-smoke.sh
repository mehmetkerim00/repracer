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
printf 'ci-synthetic-ingest' > "$SECRETS/ch_ingest_password"
printf 'ci-synthetic-verifier' > "$SECRETS/ch_verifier_password"
# Очередь и ключи AWS — синтетические: живой очереди нет (OQ-167), проверяется старт процесса, а не работа с очередью
printf 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-ci' > "$SECRETS/sqs_queue_url"
printf 'AKIASYNTHETIC0000001' > "$SECRETS/aws_access_key_id"
printf 'syn-aws-secret-access-key-0001' > "$SECRETS/aws_secret_access_key"
printf '{"clientKey":"syn-client","secretKey":"syn-secret"}' > "$SECRETS/channels/secret-ref_amazon-application"

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

for stack in "${started[@]}"; do
  IFS='|' read -r name compose override extra <<< "$stack"
  # shellcheck disable=SC2086
  env "${common_env[@]}" $extra docker compose -f "$compose" -f "$override" down -v --remove-orphans > /dev/null 2>&1 || true
done

if [ "$failed" = 1 ]; then
  echo "DEPLOY SMOKE RED: не все процессы развёртывания поднялись"
  exit 1
fi
echo "DEPLOY SMOKE: все три процесса поднялись и ответили на /healthz"
