import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { seedPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { loadConfig } from '../src/config.ts';
import { CAPABILITY_JOBS } from '../src/jobs.ts';
import { startScheduler, type SchedulerProcess } from '../src/main.ts';

/**
 * Шаг 57 (п. 2): производственный состав процесса планировщика — не правило о тексте `main.ts`, а запуск настоящего `startScheduler` в
 * промышленной конфигурации (почта, доставка алертов, приложение канала с кольцом ключей, роль остатков) на базе с аккаунтом канала.
 * Работа каждой необязательной возможности (`CAPABILITY_JOBS`) обязана оказаться заведённой: до шага 56 `order-lines` в процессе не
 * было вовсе, а живые прогоны, собирающие зависимости сами, этого не видели. Канал не вызывается: у аккаунта нет файла учётных данных,
 * адаптер отказывает до сети. Данные синтетические.
 */
let ACCOUNT = '';
let DEMO_ACCOUNT = '';
let db: IsolatedDatabase;
let proc: SchedulerProcess | null = null;

before(async () => {
  db = await createIsolatedDatabase('prodcomposition');
  ACCOUNT = (await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: '10000000-0000-4000-8000-000000005701',
    fixtureChannelAccountId: '20000000-0000-4000-8000-000000005701', marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [] },
  })).channelAccountId;
  // Ревью шага 56, находка 2: демо-тенант [Р-151] — его аккаунт процессу, ходящему в настоящие каналы, не принадлежит
  DEMO_ACCOUNT = (await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: '10000000-0000-4000-8000-000000005702',
    fixtureChannelAccountId: '20000000-0000-4000-8000-000000005702', marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [] }, demo: true,
  })).channelAccountId;
});

after(async () => {
  await proc?.stop();
  await db?.drop();
});

test('step 57: the production scheduler process registers the job of every optional capability — order-lines included', async () => {
  const config = loadConfig({
    REPRACER_MODE: 'stand',
    REPRACER_SCHEDULER_PG_URL: db.url('svc_scheduler'), REPRACER_APP_PG_URL: db.url('svc_app'), REPRACER_STOCK_PG_URL: db.url('svc_stock'),
    REPRACER_EXPORTER_PG_URL: db.url('svc_exporter'), REPRACER_ALERT_DELIVERY_PG_URL: db.url('svc_alert_delivery'), REPRACER_CREDENTIALS_PG_URL: db.url('svc_credentials'),
    // Адреса, по которым никто не отвечает: работам этого прогона они не нужны, процессу — нужны как конфигурация
    REPRACER_CH_URL: 'http://127.0.0.1:9', REPRACER_CH_INGEST_USER: 'syn-ingest', REPRACER_CH_INGEST_PASSWORD: 'syn-ingest',
    REPRACER_CH_VERIFIER_USER: 'syn-verifier', REPRACER_CH_VERIFIER_PASSWORD: 'syn-verifier',
    REPRACER_CHANNEL_SECRETS_DIR: '/nonexistent/repracer-channel-secrets', REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid',
    REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application', REPRACER_SCHEDULER_HEARTBEAT: 'off',
    REPRACER_MAIL_API_URL: 'https://mail.example.invalid/v3/send', REPRACER_MAIL_API_KEY: 'syn-mail-key', REPRACER_MAIL_FROM: 'alerts@example.invalid',
    REPRACER_OPERATOR_EMAIL: 'ops@example.invalid', REPRACER_SCHEDULER_METRICS_PORT: String(20_000 + Math.floor(Math.random() * 20_000)), REPRACER_SCHEDULER_TICK_MS: '1000',
    REPRACER_AMAZON_APP_ID: 'amzn1.sellerapps.app.syn-composition', REPRACER_AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.syn',
    REPRACER_AMAZON_LWA_CLIENT_SECRET: 'syn-client-secret', REPRACER_AMAZON_APP_DRAFT: 'on', REPRACER_CONNECT_REDIRECT_URL: 'https://app.example.invalid/connect/callback',
    REPRACER_CHANNEL_KEYRING: JSON.stringify({ current: 'k-syn', keys: { 'k-syn': Buffer.alloc(32, 57).toString('base64') } }),
  });
  proc = await startScheduler(config, () => undefined);
  const expected = Object.values(CAPABILITY_JOBS);
  const scheduler = db.pool('svc_scheduler', 1);
  let names: string[] = [];
  for (let i = 0; i < 60; i++) {
    names = (await scheduler.query('SELECT DISTINCT job_name FROM maintenance.scheduled_job')).rows.map((r) => String(r.job_name));
    if (expected.every((j) => names.includes(j))) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.deepEqual(expected.filter((j) => !names.includes(j)), [], `every capability job is registered by the production process: ${names.sort().join(', ')}`);
  const { rows: [demo] } = await scheduler.query('SELECT count(*)::int AS n FROM maintenance.scheduled_job WHERE job_key LIKE $1', [`%${DEMO_ACCOUNT}%`]);
  const { rows: [own] } = await scheduler.query('SELECT count(*)::int AS n FROM maintenance.scheduled_job WHERE job_key LIKE $1', [`%${ACCOUNT}%`]);
  const keys = (await scheduler.query('SELECT job_key FROM maintenance.scheduled_job ORDER BY 1')).rows.map((r) => String(r.job_key));
  assert.deepEqual([own.n > 0, demo.n], [true, 0], `the demo tenant account gets no job of the production scheduler: ${keys.join(', ')}`);
});
