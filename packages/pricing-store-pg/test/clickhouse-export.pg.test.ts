import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { ClickHouseHttp, exportDecisionDay } from '@repracer/analytics-export';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';
import { approved, contextOf, explained } from './drafts.ts';

/**
 * Шаг 20 [Р-20]: выгрузка дневных секций PostgreSQL в ClickHouse на настоящем ClickHouse — впервые. Экспортёр PostgreSQL
 * (repracer_exporter) читает intent и решения дня, вставляет ролью repracer_ingest, проверяет число строк ролью с чтением
 * (repracer_retention) и только после совпадения ставит verified_at; повтор выгрузки той же секции не удваивает строки.
 * Нужны REPRACER_PG_URL и ClickHouse с логинами ролей (CI создаёт их после DDL schemas/clickhouse). Без них тест падает [Р-84].
 * Данные синтетические.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const CH_URL = process.env.REPRACER_CH_URL;
const INGEST = { user: process.env.REPRACER_CH_INGEST_USER, password: process.env.REPRACER_CH_INGEST_PASSWORD };
const VERIFIER = { user: process.env.REPRACER_CH_VERIFIER_USER, password: process.env.REPRACER_CH_VERIFIER_PASSWORD };
if (!PG_URL || !CH_URL || !INGEST.user || !INGEST.password || !VERIFIER.user || !VERIFIER.password) {
  throw new Error('REPRACER_PG_URL, REPRACER_CH_URL and the ClickHouse ingest and verifier logins are required: the test does not skip (Р-84)');
}

const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-ch-export-test' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-ch-export-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-ch-export-admin' });
const exporter = createPool(PG_URL.replace('svc_app@', 'svc_exporter@'), { max: 2, applicationName: 'repracer-ch-export-exporter' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
  await exporter.end();
});

const ACCOUNT = '20000000-0000-4000-8000-000000000200';
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 } as const;
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(2000 + n),
  channelProductRef: `36220${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED,
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${n}` }, maxPrice: { amountMinor: 2500, id: `max-${n}` },
});

test('Р-20: a day of intents and decisions is exported to ClickHouse, verified by count before verified_at, and a repeated export does not duplicate rows', async () => {
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000200', fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [scope(1), scope(2), scope(3)] },
  });
  const store = new PgPricingStore(pool, { adminPool: admin });
  for (const n of [1, 2, 3]) {
    const ctx = await contextOf(store, w.tenantId, w.ids.dbId(`ws-${n}`));
    const r = await store.commitEvaluation(w.tenantId, {
      key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition },
      now: new Date().toISOString(), decisions: [explained(approved(ctx, 1900 + n))],
    });
    assert.equal(r.status, 'COMMITTED', JSON.stringify(r));
  }
  // Шаг 20: решение NO_OP — его выгрузка идёт через материализованное представление почасового агрегата (060, 070)
  {
    const ctx = await contextOf(store, w.tenantId, w.ids.dbId('ws-3'));
    const base = approved(ctx, 1850);
    const intent: PriceIntentDraft = { ...base.intent, intentClass: 'NO_OP', reason: { code: 'ALREADY_AT_TARGET', params: {} } };
    const decision: PriceDecisionDraft = { ...base.decision, outcome: 'NO_CHANGE', decisionClass: 'NO_OP', finalMinor: null, reason: { code: 'NO_CHANGE', params: {} } };
    const r = await store.commitEvaluation(w.tenantId, {
      key: { channelAccountId: ctx.scope.channelAccountId, marketplace: ctx.scope.marketplace, channelProductRef: ctx.scope.channelProductRef, condition: ctx.scope.condition },
      now: new Date().toISOString(), decisions: [explained({ context: ctx, intent, decision })],
    });
    assert.equal(r.status, 'COMMITTED', JSON.stringify(r));
  }

  const ingest = new ClickHouseHttp({ url: CH_URL, user: INGEST.user!, password: INGEST.password! });
  const verifier = new ClickHouseHttp({ url: CH_URL, user: VERIFIER.user!, password: VERIFIER.password! });
  const day = new Date().toISOString().slice(0, 10);
  const range = { from: `${day}T00:00:00.000Z`, to: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString() };

  const first = await exportDecisionDay(exporter, ingest, verifier, range);
  const intents = first.find((p) => p.parentTable === 'channel_data.price_intent')!;
  const decisions = first.find((p) => p.parentTable === 'channel_data.price_decision')!;
  assert.ok(intents.byTable.price_intent! >= 3 && decisions.byTable.price_decision! >= 3, `the day carries the committed decisions: ${JSON.stringify(first)}`);
  assert.equal(intents.verified, true, `intents verified by count in ClickHouse: ${JSON.stringify(intents)}`);
  assert.equal(decisions.verified, true, `decisions verified by count in ClickHouse: ${JSON.stringify(decisions)}`);
  assert.ok(intents.byTable.price_intent_noop! >= 1, `the day carries a NO_OP intent: ${JSON.stringify(intents)}`);
  const [hourly] = await verifier.rows<{ n: number }>(
    `SELECT sum(intents) AS n FROM repracer_analytics.price_intent_noop_hourly WHERE tenant_id = '${w.tenantId}'`);
  assert.equal(Number(hourly!.n), 1, 'the NO_OP intent of the tenant reached the hourly aggregate through the materialized view (Р-81)');

  const { rows: marks } = await exporter.query(
    `SELECT partition_name, verified_at IS NOT NULL AS verified FROM maintenance.partition_export WHERE target = 'CLICKHOUSE' AND partition_name = ANY ($1)`,
    [[intents.partitionName, decisions.partitionName]]);
  assert.deepEqual(marks.map((m) => m.verified), [true, true], 'verified_at is set only after the count matched');

  // Роль вставки не читает (001): прочитать выгрузку она не может
  await assert.rejects(ingest.rows('SELECT count() FROM repracer_analytics.price_decision'), /ACCESS_DENIED|Not enough privileges/, 'the ingest role cannot read');

  // Повтор той же секции. Строки частей без FINAL — токены дедупликации; но параллельные тесты пакета добавляют решения того же дня,
  // состав частей меняется, и токены с ним — поэтому число строк тенанта сверяется и без FINAL (сырые части), и с FINAL
  const countOf = async (final: boolean) => Number((await verifier.rows<{ n: number }>(
    `SELECT count() AS n FROM repracer_analytics.price_decision${final ? ' FINAL' : ''} WHERE tenant_id = '${w.tenantId}'`))[0]!.n);
  assert.equal(await countOf(false), 3, 'the three decisions of the synthetic tenant are in ClickHouse');
  const second = await exportDecisionDay(exporter, ingest, verifier, range);
  assert.ok(second.every((p) => p.verified), JSON.stringify(second));
  assert.equal(await countOf(true), 3, 'a repeated export leaves one row per decision');
  const [hourlyAfter] = await verifier.rows<{ n: number }>(
    `SELECT sum(intents) AS n FROM repracer_analytics.price_intent_noop_hourly WHERE tenant_id = '${w.tenantId}'`);
  // Токен части — контрольная сумма её идентификаторов: если параллельные тесты пакета добавили NO_OP того же дня, часть другая и
  // вставляется снова — в агрегате это двойной счёт. В работе выгружается закрытый день, состав частей не меняется.
  const noopUnchanged = second.find((p) => p.parentTable === 'channel_data.price_intent')!.byTable.price_intent_noop === intents.byTable.price_intent_noop;
  if (noopUnchanged) {
    assert.equal(Number(hourlyAfter!.n), 1, 'a repeated export of an unchanged day does not count the NO_OP intent twice in the hourly aggregate');
  } else {
    console.log(`CH_EXPORT_NOOP_DAY_CHANGED between exports (parallel tests): hourly intents of the tenant ${hourlyAfter!.n}`);
  }
  console.log(`CH_EXPORT_REPEAT raw rows of the tenant after the repeat: ${await countOf(false)} (3 — the part token matched; more — chunks changed by parallel tests, merged by FINAL)`);
});
