import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ClickHouseHttp, exportDay } from '@repracer/analytics-export';
import { inTenant, seedPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type TestRole } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, type JobDeps } from '../src/index.ts';

/**
 * Р-126, Р-122 (шаг 25): планировщик остановлен на сутки — история снимков конкурентов НЕ теряется. Отдельная база (удаление секций по
 * сроку глобально) и настоящий ClickHouse (CI). Время — виртуальное: функции удаления, секций и закрытия суток принимают момент.
 *  1. Сутки D0 — снимки; планировщик стоит всю D1, пока пишутся снимки D1; возвращается в D2 01:00 и выгружает сутки D0 и D1 по очереди.
 *  2. D5 01:00 — удаление по сроку убирает секции D0 и D1 из PostgreSQL: они выгружены и проверены — в ClickHouse все 6 снимков.
 *  3. Негативный контроль: ClickHouse недоступен 16 суток, планировщик работает — выгрузка D6 проваливается каждые сутки, алерты
 *     SCHEDULER_JOB_FAILING и отставание CRITICAL идут с первых суток, а через 14 суток после конца D6 секция удаляется принудительно:
 *     снимки D6 потеряны. Потеря — только при провале выгрузки 14 суток подряд, не при остановке планировщика.
 * Нужны REPRACER_PG_URL, REPRACER_PG_ADMIN_URL, REPRACER_CH_URL и логины ClickHouse [Р-84]. Данные синтетические.
 */
const CH_URL = process.env.REPRACER_CH_URL;
const INGEST = { user: process.env.REPRACER_CH_INGEST_USER, password: process.env.REPRACER_CH_INGEST_PASSWORD };
const VERIFIER = { user: process.env.REPRACER_CH_VERIFIER_USER, password: process.env.REPRACER_CH_VERIFIER_PASSWORD };
if (!CH_URL || !INGEST.user || !INGEST.password || !VERIFIER.user || !VERIFIER.password) {
  throw new Error('REPRACER_CH_URL and the ClickHouse ingest and verifier logins are required: the test does not skip (Р-84)');
}

const db = await createIsolatedDatabase('repracer_sched_history');
after(async () => { await db.drop(); });
const role = (r: string) => db.pool(r as TestRole, 3);

const DAY = 86_400_000;
const ACCOUNT = '20000000-0000-4000-8000-000000002501';

test('Р-126: the scheduler stopped for a day loses no competitor snapshot history; only an export failing for 14 days does', async () => {
  const app = role('svc_app');
  const w = await seedPricingWorld(app, {
    provisioningPool: role('svc_provisioning'), adminPool: role('svc_admin'), fixtureTenantId: '10000000-0000-4000-8000-000000002501', fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(),
    seed: { scopes: [{ writeScopeId: 'ws-2501', productId: 'prod-2501', channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: '2501', channelProductRef: '362002501',
      condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1850, minPrice: { amountMinor: 1000, id: 'min-2501' }, maxPrice: { amountMinor: 3000, id: 'max-2501' } }] },
  });
  const scheduler = role('svc_scheduler');
  const exporter = role('svc_exporter');
  const ingest = new ClickHouseHttp({ url: CH_URL, user: INGEST.user!, password: INGEST.password! });
  const verifier = new ClickHouseHttp({ url: CH_URL, user: VERIFIER.user!, password: VERIFIER.password! });
  const D0 = Math.floor(Date.now() / DAY) * DAY;
  const at = (days: number, hours = 0) => new Date(D0 + days * DAY + hours * 3_600_000).toISOString();

  let now = at(0, 1);
  let clickHouseDown = false;
  const alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }> = [];
  const base = pgJobDeps({ schedulerPool: scheduler, exporterPool: exporter, ingest, verifier, descriptorOf: () => null, pipelineFor: () => { throw new Error('no account jobs'); } });
  const deps: JobDeps = {
    ...base, accounts: async () => [],
    exportDay: async (range) => {
      if (clickHouseDown) throw new Error('CLICKHOUSE_UNAVAILABLE: synthetic outage');
      return exportDay(exporter, ingest, verifier, range);
    },
  };
  const s = createScheduler({ state: new PgSchedulerState(scheduler), source: jobSource(deps), owner: 'scheduler-1', now: () => now,
    alerts: { raise: async (a) => { alerts.push(a as never); } } });

  const writeSnapshots = async (day: number, n: number) => {
    await inTenant(app, w.tenantId, async (tx) => {
      for (let i = 0; i < n; i++) {
        const snapshot = { marketplace: 'de', channelProductRef: '362002501', condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: at(day, 2 + i),
          completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: { amountMinor: 1780 + i, currency: 'EUR', basis: 'GROSS' }, isSelf: false },
          offers: [{ rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: { amountMinor: 1780 + i, currency: 'EUR', basis: 'GROSS' } }] };
        await tx.query(
          `INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
           VALUES ($1, gen_random_uuid(), $2, $2, $3, 'KAUFLAND', 'de', '362002501', 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'POLL', $4::jsonb)`,
          [w.tenantId, at(day, 2 + i), w.channelAccountId, JSON.stringify(snapshot)]);
      }
    });
  };
  const inClickHouse = async (fromDay: number, toDay: number) => Number((await verifier.rows<{ n: number }>(
    `SELECT count() AS n FROM repracer_analytics.competitor_snapshot FINAL WHERE tenant_id = '${w.tenantId}'
       AND received_at >= parseDateTime64BestEffort('${at(fromDay)}', 3) AND received_at < parseDateTime64BestEffort('${at(toDay)}', 3)`))[0]?.n ?? 0);
  const partitions = async () => (await db.pool('svc_exporter' as TestRole, 1).query(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'channel_data.competitor_snapshot_log'::regclass ORDER BY 1`)).rows.map((r) => r.relname as string);
  const partitionOf = (day: number) => `competitor_snapshot_log_d${at(day).slice(0, 10).replaceAll('-', '')}`;

  // 1. Сутки D0 — планировщик работает; D1 — стоит, снимки пишутся
  await s.tick();
  await writeSnapshots(0, 3);
  now = at(0, 23);
  await s.tick();
  await writeSnapshots(1, 3);
  now = at(2, 1);
  const back = await s.tick();
  const exportRuns = back.runs.filter((r) => r.jobName === 'analytics-export-day');
  assert.deepEqual(exportRuns.map((r) => [r.slotAt, r.outcome]), [[at(1, 0.5), 'SUCCEEDED'], [at(2, 0.5), 'SUCCEEDED']], 'the missed day and the current one, in order');
  assert.equal(await inClickHouse(0, 2), 6, 'both days are in ClickHouse after the scheduler returns');

  // 2. Удаление по сроку — только выгруженных и проверенных секций
  now = at(5, 1);
  await s.tick();
  const afterRetention = await partitions();
  assert.ok(!afterRetention.includes(partitionOf(0)) && !afterRetention.includes(partitionOf(1)), `D0 and D1 dropped from PostgreSQL: ${afterRetention.join(',')}`);
  assert.equal(await inClickHouse(0, 2), 6, 'no snapshot of D0 and D1 is lost');

  // 3. Негативный контроль: ClickHouse недоступен, планировщик работает каждые сутки
  await writeSnapshots(6, 2);
  clickHouseDown = true;
  const firstFailing = alerts.length;
  for (let day = 6; day <= 22; day++) {
    now = at(day, 1);
    await s.tick();
  }
  const raised = alerts.slice(firstFailing);
  assert.ok(raised.some((a) => a.code === 'SCHEDULER_JOB_FAILING' && a.details.job === 'analytics-export-day'), 'failing export is alerted');
  assert.ok(raised.some((a) => a.code === 'SCHEDULER_JOB_LAGGING' && a.severity === 'CRITICAL' && a.details.job === 'analytics-export-day'), 'lag is CRITICAL before the loss');
  assert.ok(!(await partitions()).includes(partitionOf(6)), 'after 14 days the unexported partition is force-dropped');
  clickHouseDown = false;
  now = at(23, 1);
  const recovered = await s.tick();
  assert.equal(await inClickHouse(6, 7), 0, 'the snapshots of D6 are lost: the only way history disappears');
  assert.ok(alerts.some((a) => a.code === 'ANALYTICS_EXPORT_PARTITION_MISSING' && String(a.details.partitions).includes('competitor_snapshot_log')), JSON.stringify(recovered.runs.slice(0, 3)));
});
