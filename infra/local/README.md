# infra/local — локальный стенд инфраструктуры (шаг 10)

Брокер Redpanda и аналитический слой ClickHouse для теста порядка за брокером и выгрузки в ClickHouse. Только синтетические
данные, только 127.0.0.1. Версии закреплены в `compose.yaml`: Redpanda v26.2.2, ClickHouse 26.8.4.11.

```sh
export REPRACER_CH_PASSWORD=<любой локальный пароль>
docker compose -f infra/local/compose.yaml up -d
node infra/local/apply-clickhouse.mjs      # DDL 001…050, затем 099_verify.sql — каждый запрос проверки должен вернуть 0 строк

# Порядок внутри единицы записи при трёх экземплярах пути решения (services/pricing-worker)
REPRACER_KAFKA_BROKERS=127.0.0.1:19092 \
REPRACER_PG_URL=postgres://svc_app@127.0.0.1:55432/repracer_eu \
REPRACER_PG_ADMIN_URL=postgres://postgres@127.0.0.1:55432/repracer_eu \
npm test -w @repracer/pricing-worker

# Выгрузка PostgreSQL → ClickHouse и замер сжатия (packages/analytics-export)
REPRACER_CH_URL=http://127.0.0.1:18123 REPRACER_CH_USER=repracer_local_admin \
REPRACER_PG_URL=postgres://svc_app@127.0.0.1:55432/repracer_eu \
npm run bench -w @repracer/analytics-export -- --out=compression.json
```

База PostgreSQL — одноразовый кластер со всеми миграциями и `packages/pricing-store-pg/test/setup.sql`
(логины `svc_app`, `svc_dispatcher`, `svc_relay`, `svc_fx_loader`, `svc_scheduler`).

Образы тянутся из Docker Hub. Если Docker Desktop не может скачать образ через свой прокси (EOF от `auth.docker.io`),
стенд не поднимется — это состояние машины, а не проекта; проверьте Settings → Resources → Proxies.
