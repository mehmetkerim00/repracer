import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { ClickHouseHttp, competitorSnapshotRow, exportCompetitorSnapshotsDay, exportDecisionDay, listSnapshotExportSkips, readCompetitorHistory, resolveSnapshotExportSkip, verifySnapshotExportSkips } from '@repracer/analytics-export';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import type { PriceDecisionDraft, PriceIntentDraft } from '@repracer/pricing-model';
import { approved, contextOf, explained } from './drafts.ts';
import { requireEnv } from './isolated-db.ts';

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
// Шаг 21: логин шлюза аналитики (repracer_tenant_reader) — чтение истории конкурентов для бэктеста
const READER = { user: process.env.REPRACER_CH_READER_USER, password: process.env.REPRACER_CH_READER_PASSWORD };
if (!PG_URL || !CH_URL || !INGEST.user || !INGEST.password || !VERIFIER.user || !VERIFIER.password || !READER.user || !READER.password) {
  throw new Error('REPRACER_PG_URL, REPRACER_CH_URL and the ClickHouse ingest, verifier and reader logins are required: the test does not skip (Р-84)');
}

const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-ch-export-test' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-ch-export-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-ch-export-admin' });
// Учётные записи операторов платформы заводит владелец (0095): в тесте — суперпользователь стенда в той же базе
const superuserUrl = (() => {
  // База берётся из адреса пути решения, пользователь и хост — из адреса суперпользователя стенда: у схемы postgres: нет origin
  const u = new URL(requireEnv('REPRACER_PG_ADMIN_URL'));
  u.pathname = new URL(PG_URL).pathname;
  return u.toString();
})();
const superuser = createPool(superuserUrl, { max: 1, applicationName: 'repracer-ch-export-superuser' });
const exporter = createPool(PG_URL.replace('svc_app@', 'svc_exporter@'), { max: 2, applicationName: 'repracer-ch-export-exporter' });
// Ревью шага 25, находка 9: пропуски разбирает отдельная роль — выгрузка не отмечает разобранными свои же пропуски
const triage = createPool(PG_URL.replace('svc_app@', 'svc_export_triage@'), { max: 1, applicationName: 'repracer-ch-export-triage' });
after(async () => {
  await pool.end();
  await provisioning.end();
  await admin.end();
  await exporter.end();
  await triage.end();
  await superuser.end();
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

test('Р-38, Р-23: the backtest reads the competitor history of one tenant through the tenant reader role and its row policy', async () => {
  const ingest = new ClickHouseHttp({ url: CH_URL, user: INGEST.user!, password: INGEST.password! });
  const reader = new ClickHouseHttp({ url: CH_URL, user: READER.user!, password: READER.password! });
  const now = new Date();
  const tenants = ['10000000-0000-4000-8000-000000002101', '10000000-0000-4000-8000-000000002102'];
  const account = '20000000-0000-4000-8000-000000002101';
  const rows = tenants.flatMap((tenant, t) => [0, 1, 2].map((i) => competitorSnapshotRow(tenant, account, 'KAUFLAND', `30000000-0000-4000-8000-00000000${2100 + t * 10 + i}`, {
    marketplace: 'de', channelProductRef: '362002101', condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED', sourceEventId: `syn-${t}-${i}`,
    observedAt: new Date(now.getTime() - (3 - i) * 3_600_000).toISOString(), completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: { amountMinor: 1780 + t * 100 + i, currency: 'EUR', basis: 'GROSS' }, isSelf: false },
    offers: [{ rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: { amountMinor: 1780 + t * 100 + i, currency: 'EUR', basis: 'GROSS' }, deliveryDays: { min: 1, max: 2 } }],
  }, now.toISOString())));
  await ingest.insert('repracer_analytics.competitor_snapshot', rows, `step21-history-${now.getTime()}`);

  const window = { from: new Date(now.getTime() - 86_400_000).toISOString(), to: now.toISOString() };
  const history = await readCompetitorHistory(reader, tenants[0]!, account, window, now.toISOString());
  assert.deepEqual(history.map((h) => h.buybox?.price.amountMinor), [1780, 1781, 1782], 'three snapshots of the tenant, in time order');
  // Политика строк: при SQL_tenant_id другого тенанта явный фильтр не помогает — строк нет
  const foreign = await reader.rows<{ n: number }>(`SELECT count() AS n FROM repracer_analytics.competitor_snapshot WHERE tenant_id = '${tenants[1]}'`, { SQL_tenant_id: tenants[0]! });
  assert.equal(Number(foreign[0]!.n), 0, 'the row policy hides the other tenant');
  await assert.rejects(reader.rows('SELECT count() FROM repracer_analytics.competitor_snapshot'), /CANNOT_PARSE|Cannot parse|UUID/i, 'without SQL_tenant_id the reader gets nothing');
  await assert.rejects(readCompetitorHistory(reader, tenants[0]!, account, { from: '2020-01-01T00:00:00.000Z', to: window.to }, now.toISOString()), /18 months/);
});

test('Р-122, step 24: a day of the competitor snapshot log is exported to ClickHouse with its sanity verdict, verified by count; a row ClickHouse would refuse is skipped with a reason; a repeated export does not duplicate rows', async () => {
  const ingest = new ClickHouseHttp({ url: CH_URL, user: INGEST.user!, password: INGEST.password! });
  const verifier = new ClickHouseHttp({ url: CH_URL, user: VERIFIER.user!, password: VERIFIER.password! });
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000002400', fixtureChannelAccountId: '20000000-0000-4000-8000-000000002400',
    marketplaces: ['de'], clock: new Date().toISOString(), seed: { scopes: [] },
  });
  const account = w.ids.dbId('20000000-0000-4000-8000-000000002400');
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const range = { from: dayStart.toISOString(), to: new Date(dayStart.getTime() + 86_400_000).toISOString() };
  const money = (amountMinor: number, currency = 'EUR') => ({ amountMinor, currency, basis: 'GROSS' });
  const snapshot = (minor: number, currency: string) => ({
    marketplace: 'de', channelProductRef: '362002400', condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED', observedAt: new Date(dayStart.getTime() + 60_000).toISOString(),
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(minor, currency), isSelf: false },
    offers: [{ rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: money(minor, currency), deliveryDays: { min: 1, max: 2 } }],
  });
  const logged = [
    { id: crypto.randomUUID(), s: snapshot(1780, 'EUR'), verdict: 'ACCEPT' },
    { id: crypto.randomUUID(), s: snapshot(17, 'EUR'), verdict: 'REJECT' },
    { id: crypto.randomUUID(), s: snapshot(1780, 'GBP'), verdict: 'REJECT' },
  ];
  // Путь решения пишет журнал в транзакции снимка (0086); здесь — та же роль и тот же оператор вставки
  await inTenant(pool, w.tenantId, async (tx) => {
    for (const [i, l] of logged.entries()) {
      await tx.query(
        `INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
         VALUES ($1, $2, $3, $4, $5, 'KAUFLAND', 'de', '362002400', 'new', 'KAUFLAND_BUY_BOX_CHANGED', $6, $8, $7::jsonb)`,
        [w.tenantId, l.id, new Date(dayStart.getTime() + 120_000 + i * 1000).toISOString(), l.s.observedAt, account, l.verdict, JSON.stringify(l.s), i === 1 ? 'POLL' : 'PUSH']);
    }
  });
  await assert.rejects(pool.query('SELECT count(*) FROM channel_data.competitor_snapshot_log'), /permission denied/, 'the decision path writes the log but does not read it (Р-22)');

  const first = await exportCompetitorSnapshotsDay(exporter, ingest, verifier, range);
  // Ревью шага 24, находка 5: снимок, пропущенный выгрузкой (GBP), в ClickHouse не попал — сутки не проверены и по сроку не удалятся
  assert.equal(first.verified, false, JSON.stringify(first));
  assert.ok(first.byTable.competitor_snapshot! >= 2);
  assert.ok((first.skipped.CURRENCY_UNSUPPORTED ?? 0) >= 1, JSON.stringify(first.skipped));
  const count = async () => Number((await verifier.rows<{ n: number }>(
    `SELECT count() AS n FROM repracer_analytics.competitor_snapshot FINAL WHERE tenant_id = '${w.tenantId}'`))[0]!.n);
  assert.equal(await count(), 2, 'two snapshots of the tenant, the GBP one is skipped');
  const verdicts = await verifier.rows<{ v: string; d: string }>(`SELECT sanity_verdict AS v, delivery AS d FROM repracer_analytics.competitor_snapshot FINAL WHERE tenant_id = '${w.tenantId}' ORDER BY received_at`);
  assert.deepEqual(verdicts.map((r) => [r.v, r.d]), [['ACCEPT', 'PUSH'], ['REJECT', 'POLL']], 'the rejected snapshot is history too, with its verdict and delivery (Р-121)');
  const second = await exportCompetitorSnapshotsDay(exporter, ingest, verifier, range);
  assert.equal(second.verified, false, 'the skipped snapshot still blocks verification');
  assert.equal(await count(), 2, 'a repeated export does not duplicate rows');
  const { rows: [mark] } = await exporter.query(`SELECT verified_at FROM maintenance.partition_export WHERE parent_table = 'channel_data.competitor_snapshot_log' AND partition_name = $1 AND target = 'CLICKHOUSE'`, [first.partitionName]);
  assert.equal(mark?.verified_at ?? null, null, 'with a skipped snapshot the partition is not marked verified: retention keeps it until a person resolves the skip');
  // OQ-181 (шаг 25), OQ-182 (шаг 26): пропуск записан; оператор платформы со вторым фактором принимает потерю с заметкой —
  // повторная выгрузка отмечает сутки проверенными. Учётная запись оператора — платформенная (0095)
  const operatorId = randomUUID();
  // Учётную запись оператора платформы заводит владелец (0095): в тесте — суперпользователь стенда
  await superuser.query(`INSERT INTO platform.platform_operator (operator_id, issuer, subject, display_name)
    VALUES ($1, 'https://identity.example.invalid/repracer', $2, 'Synthetic Export Operator')`, [operatorId, `syn-op-${operatorId.slice(0, 8)}`]);
  const by = { resolvedBy: 'ops-synthetic', operatorId, mfa: true };
  const skips = (await listSnapshotExportSkips(exporter, { unresolvedOnly: true })).filter((k) => k.subjectTenantId === w.tenantId);
  assert.deepEqual(skips.map((k) => [k.competitorSnapshotId, k.reason]), [[logged[2]!.id, 'CURRENCY_UNSUPPORTED']]);
  await assert.rejects(resolveSnapshotExportSkip(exporter, { competitorSnapshotId: logged[2]!.id, resolution: 'LOSS_ACCEPTED', note: 'Synthetic GBP snapshot: loss accepted', ...by }),
    /permission denied/, 'the exporter cannot resolve its own skips');
  await assert.rejects(resolveSnapshotExportSkip(triage, { competitorSnapshotId: logged[2]!.id, resolution: 'LOSS_ACCEPTED', note: 'ok', ...by }), /snapshot_export_skip_resolution_note/);
  await assert.rejects(resolveSnapshotExportSkip(triage, { competitorSnapshotId: logged[2]!.id, resolution: 'LOSS_ACCEPTED', note: 'Synthetic GBP snapshot: loss accepted', ...by, mfa: false }),
    /needs the second factor/, 'разбор без второго фактора оператора отклоняет база (OQ-182)');
  await resolveSnapshotExportSkip(triage, { competitorSnapshotId: logged[2]!.id, resolution: 'LOSS_ACCEPTED', note: 'Synthetic GBP snapshot: loss accepted', ...by });
  // Другие тесты той же базы могли оставить неразобранные пропуски этих суток — разбираем и их, чтобы проверить отметку секции
  for (const k of (await listSnapshotExportSkips(triage, { unresolvedOnly: true })).filter((x) => x.partitionName === first.partitionName)) {
    await resolveSnapshotExportSkip(triage, { competitorSnapshotId: k.competitorSnapshotId, resolution: 'LOSS_ACCEPTED', note: 'Synthetic skip of another test', ...by });
  }
  const third = await exportCompetitorSnapshotsDay(exporter, ingest, verifier, range);
  assert.equal(third.verified, true, JSON.stringify(third));
  // OQ-182 (шаг 26): разбор «выгружен после исправления» засчитывается только после сверки с ClickHouse, а не по слову оператора
  const partitionName = `oq182_synthetic_${randomUUID().slice(0, 8)}`;
  const missing = randomUUID();
  for (const [id, reason] of [[logged[0]!.id, 'CURRENCY_UNSUPPORTED'], [missing, 'SOURCE_UNKNOWN']] as const) {
    await exporter.query(
      `INSERT INTO maintenance.snapshot_export_skip (subject_tenant_id, competitor_snapshot_id, partition_name, received_at, reason) VALUES ($1, $2, $3, now(), $4)`,
      [w.tenantId, id, partitionName, reason]);
    await resolveSnapshotExportSkip(triage, { competitorSnapshotId: id, resolution: 'EXPORTED_AFTER_FIX', note: 'Synthetic: exported after the fix', ...by });
  }
  assert.equal(await verifySnapshotExportSkips(exporter, verifier, { partitionName }), 1, 'подтверждается только снимок, который есть в ClickHouse');
  await assert.rejects(exporter.query(
    `INSERT INTO maintenance.partition_export (parent_table, partition_name, target, exported_rows, verified_at) VALUES ('channel_data.competitor_snapshot_log', $1, 'CLICKHOUSE', 1, now())`, [partitionName]),
    /without a resolution/, 'секция с неподтверждённым «выгружен после исправления» проверенной не становится (OQ-182)');
  assert.equal(await count(), 2, 'resolving does not export the skipped snapshot');
});


