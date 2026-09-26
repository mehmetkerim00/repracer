import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AlertSink, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import { convertMinor, storefrontPriceForMarginBp, type CostInputs } from '@repracer/pricing-model';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY, type ScopeDispatchReport } from '@repracer/write-dispatcher';
import { inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Р-83 на PostgreSQL: перед КАЖДОЙ отправкой цены в канал границы вычисляются заново, включая пол маржи. Между решением
 * и отправкой меняются себестоимость, курс ЕЦБ, ставка НДС, min_price — запись не уходит, поднимается алерт.
 * Путь — настоящий: фиксация решения хранилищем, запись в очереди за записью в полёте, диспетчер записей [Р-64] над
 * очередью PostgreSQL, канал-заглушка считает, что к нему пришло. Отдельная база: курс ЕЦБ — данные платформы.
 * Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000083';
const US_ACCOUNT = '20000000-0000-4000-8000-000000000084';
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 1600 }, deadbandMinor: 0 } as const;
const DAY_MS = 86_400_000;
const now = () => new Date().toISOString();
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);

// Пол маржи 10 % при комиссии 10 %: EUR, НДС 19 % — себестоимость 10,00 € → пол 15,24 €; 11,00 € → 16,76 €
const eurCost = (unitCostMinor: number, vatRateBp = 1900): CostInputs => ({
  currency: 'EUR', costProfileId: `cp-${unitCostMinor}-${vatRateBp}`, unitCostMinor, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp },
});

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(8300 + n),
    channelProductRef: `36283${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: FIXED,
    currentPriceMinor: 1500, minPrice: { amountMinor: 500, id: `min-${n}` }, maxPrice: { amountMinor: 10_000, id: `max-${n}` },
    cost: eurCost(1000), guardrails: { minMarginBp: 1000 }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
let queue: PgWriteQueueStore;
const sent: FieldWrite[] = [];
const alerts: Array<Parameters<AlertSink['raise']>[0]> = [];

before(async () => {
  db = await createIsolatedDatabase('r83');
  /**
   * Шаг 42 [Р-172]: боевой аккаунт на `amazon.com` база не принимает, пока не известна граница суток (A-03). Здесь
   * проверяется ПЕРЕСЧЁТ ПОЛА перед отправкой [Р-83] на витрине США, то есть нужна именно боевая запись, — поэтому
   * граница суток объявлена подтверждённой, КАК ЕСЛИ БЫ Amazon ответил. База изолированная: на другие прогоны это не
   * влияет, а сам факт «с ответом канала витрина США пишет» стоит проверить ровно один раз.
   */
  await db.superuser(`UPDATE platform.marketplace SET time_zone = 'America/Los_Angeles', time_zone_status = 'CONFIRMED',
                             time_zone_source = 'проба Р-83 на витрине США: граница суток объявлена подтверждённой, как если бы A-03 был закрыт'
                       WHERE marketplace = 'ATVPDKIKX0DER'`);
  pool = db.pool('svc_app');
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2),
    fixtureTenantId: '10000000-0000-4000-8000-000000000083', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    fxLoaderPool: db.pool('svc_fx_loader', 1),
    seed: {
      scopes: [
        scope(1), // себестоимость
        scope(2, { cost: eurCost(1000, 700) }), // ставка НДС: 7 % → пол 13,50 €
        scope(3, { guardrails: {} }), // min_price (ограничения маржи нет; себестоимость объявлена — без неё ENGINE не включается, Р-131)
        // курс: USD, налог с продаж, себестоимость 10,00 € по 1,10 → 11,00 $ → пол 13,75 $; по 1,20 → 15,00 $
        scope(4, {
          channelAccountId: US_ACCOUNT, marketplace: 'ATVPDKIKX0DER', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED',
          cost: { currency: 'EUR', costProfileId: 'cp-usd', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'SALES_TAX_EXCLUDED' } },
        }),
        scope(5), // контроль: ничего не меняется — запись уходит
        scope(6), // себестоимость выросла между чтением контекста и фиксацией
        scope(7), // повтор после временной ошибки — тоже отправка
      ],
      accounts: [{ channelAccountId: US_ACCOUNT, channel: 'AMAZON', region: 'NA', marketplaces: ['ATVPDKIKX0DER'] }],
      marketplaces: { ATVPDKIKX0DER: { currency: 'USD', basis: 'NET' } },
      fxRates: [{ source: 'ECB', rateDate: day(-1), base: 'EUR', quote: 'USD', rateMicros: 1_100_000, availableFrom: new Date(Date.now() - 3_600_000).toISOString() }],
    },
  });
  store = new PgPricingStore(pool);
  queue = new PgWriteQueueStore(pool);
});

after(async () => {
  await db?.drop();
});

const adapter = {
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(_ctx: unknown, batch: { batchId: string; items: FieldWrite[] }) {
    sent.push(...batch.items);
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  async readBack() {
    return { observations: [], failures: [] };
  },
} as unknown as ChannelAdapter;

function dispatcher(clock: () => string = now) {
  return createWriteDispatcher({ store: queue, adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a); } }, now: clock });
}

const ws = (n: number) => world.ids.dbId(`ws-${n}`);

/** Первая цена уходит при фиксации и остаётся в полёте; вторая ждёт в очереди за ней */
/** Черновик решения, как его отдал бы Gate: курс перевода себестоимости — в решении [Р-61] */
async function draft(n: number, amountMinor: number) {
  const ctx = await contextOf(store, world.tenantId, ws(n));
  const d = approved(ctx, amountMinor);
  d.decision.fx = ctx.cost?.fx ?? null;
  return d;
}

async function queueBehindInFlight(n: number, first: number, second: number): Promise<{ inFlight: FieldWrite; pendingWriteId: string }> {
  const r1 = await commit(store, world.tenantId, await draft(n, first));
  assert.ok(r1.status === 'COMMITTED' && r1.decisions[0]!.write, `ws-${n}: first write is dispatched at commit: ${JSON.stringify(r1)}`);
  const r2 = await commit(store, world.tenantId, await draft(n, second));
  assert.ok(r2.status === 'COMMITTED' && r2.decisions[0]!.pendingWriteId, `ws-${n}: second write waits behind the in-flight one: ${JSON.stringify(r2)}`);
  return { inFlight: r1.decisions[0]!.write!, pendingWriteId: r2.decisions[0]!.pendingWriteId! };
}

async function finishInFlight(write: FieldWrite): Promise<void> {
  await queue.recordOutcome(world.tenantId, write, { channelWriteId: write.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
}

async function writeRow(channelWriteId: string) {
  return inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT status, end_reason, end_params FROM tenant_data.channel_write WHERE tenant_id = $1 AND channel_write_id = $2
     UNION ALL
     SELECT final_status, end_reason, end_params FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND channel_write_id = $2`,
    [world.tenantId, channelWriteId])).rows[0]);
}

/** Запись не ушла в канал, завершена перепроверкой границ, алерт поднят */
async function assertBlocked(report: ScopeDispatchReport, channelWriteId: string, label: string): Promise<void> {
  assert.ok(!sent.some((w) => w.channelWriteId === channelWriteId), `${label}: the write reached the channel: ${JSON.stringify(report.steps)}`);
  const ended = report.steps.find((s) => s.action === 'ENDED' && s.channelWriteId === channelWriteId);
  assert.ok(ended && ended.action === 'ENDED' && ended.reason.code === 'WRITE_BLOCKED_BY_BOUND_RECHECK', `${label}: ${JSON.stringify(report.steps)}`);
  const row = await writeRow(channelWriteId);
  assert.deepEqual([row?.status, row?.end_reason, row?.end_params?.violated], ['DISCARDED_STALE', 'WRITE_BLOCKED_BY_BOUND_RECHECK', 'FLOOR'], `${label}: ${JSON.stringify(row)}`);
  assert.ok(alerts.some((a) => a.code === 'PRICE_WRITE_NOT_SENT' && a.details.channelWriteId === channelWriteId), `${label}: no alert`);
}

test('Р-83 control: with nothing changed the queued write goes out after the in-flight one', async () => {
  const { inFlight, pendingWriteId } = await queueBehindInFlight(5, 1600, 1610);
  await finishInFlight(inFlight);
  await dispatcher().dispatchScope(world.tenantId, ws(5));
  assert.ok(sent.some((w) => w.channelWriteId === pendingWriteId), 'the control write must be sent — otherwise the tests below prove nothing');
});

test('Р-83: the unit cost rose between decision and dispatch — the margin floor blocks the write', async () => {
  const { inFlight, pendingWriteId } = await queueBehindInFlight(1, 1600, 1610);
  await world.setCost('ws-1', eurCost(1100));
  await finishInFlight(inFlight);
  await assertBlocked(await dispatcher().dispatchScope(world.tenantId, ws(1)), pendingWriteId, 'cost');
});

test('Р-83: the VAT rate rose between decision and dispatch — the margin floor blocks the write', async () => {
  const { inFlight, pendingWriteId } = await queueBehindInFlight(2, 1400, 1410);
  await world.setCost('ws-2', eurCost(1000, 1900));
  await finishInFlight(inFlight);
  await assertBlocked(await dispatcher().dispatchScope(world.tenantId, ws(2)), pendingWriteId, 'VAT');
});

test('Р-83: the ECB rate changed between decision and dispatch — the converted cost blocks the write', async () => {
  const { inFlight, pendingWriteId } = await queueBehindInFlight(4, 1450, 1460);
  await db.pool('svc_fx_loader', 1).query(
    `INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, available_from, source_ref)
     VALUES ('ECB', $1, 'EUR', 'USD', 1.2, now(), 'r83 synthetic')`, [day(0)]);
  await finishInFlight(inFlight);
  await assertBlocked(await dispatcher().dispatchScope(world.tenantId, ws(4)), pendingWriteId, 'FX');
});

test('Р-83: min_price rose between decision and dispatch — the absolute floor blocks the write', async () => {
  const { inFlight, pendingWriteId } = await queueBehindInFlight(3, 1600, 1610);
  await world.setBound('ws-3', 'min', { amountMinor: 1700, id: 'min-3-raised' });
  await finishInFlight(inFlight);
  await assertBlocked(await dispatcher().dispatchScope(world.tenantId, ws(3)), pendingWriteId, 'min_price');
});

test('Р-83: a retry is a dispatch too — the cost rose after a transient channel error, the retry does not go out', async () => {
  const r = await commit(store, world.tenantId, approved(await contextOf(store, world.tenantId, ws(7)), 1610));
  assert.ok(r.status === 'COMMITTED' && r.decisions[0]!.write, JSON.stringify(r));
  const write = r.decisions[0]!.write!;
  await queue.recordOutcome(world.tenantId, write, {
    channelWriteId: write.channelWriteId, status: 'REJECTED', error: { class: 'TRANSIENT', code: 'RATE_LIMITED', scope: 'ITEM', message: 'synthetic', raiseAlert: false },
  }, now(), DEFAULT_RETRY_POLICY);
  await world.setCost('ws-7', eurCost(1100));
  const later = () => new Date(Date.now() + 600_000).toISOString();
  await assertBlocked(await dispatcher(later).dispatchScope(world.tenantId, ws(7)), write.channelWriteId, 'retry');
});

test('Р-83: the cost rose between reading the context and the commit — the decision is not committed and nothing is sent', async () => {
  const ctx = await contextOf(store, world.tenantId, ws(6));
  await world.setCost('ws-6', eurCost(1100));
  const r = await commit(store, world.tenantId, approved(ctx, 1610));
  assert.notEqual(r.status, 'COMMITTED', `the database accepted a price below the new margin floor: ${JSON.stringify(r)}`);
  const writes = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(6)])).rows[0].n);
  assert.equal(writes, 0);
});

test('Р-83: the floor arithmetic in the database equals the code — margin price and cost conversion on 3000 random inputs each', async () => {
  let x = 83;
  const rnd = (n: number) => { x = (Math.imul(x ^ (x >>> 15), 2246822519) + 0x9e3779b9) >>> 0; return x % n; };
  const cases = Array.from({ length: 3000 }, () => ({
    cost: rnd(10) === 0 ? 0 : rnd(5_000_000), fee: rnd(10) === 0 ? 9999 : rnd(4000), tax: [0, 700, 1900, 2000, rnd(6000)][rnd(5)]!, margin: rnd(10) === 0 ? 9999 : rnd(9000),
  }));
  const { rows } = await pool.query(
    `SELECT tenant_data.price_for_margin_bp(c, f, t, m) AS price FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::int[]) WITH ORDINALITY u(c, f, t, m, i) ORDER BY i`,
    [cases.map((c) => c.cost), cases.map((c) => c.fee), cases.map((c) => c.tax), cases.map((c) => c.margin)]);
  let unattainable = 0;
  cases.forEach((c, i) => {
    const code = storefrontPriceForMarginBp({ currency: 'EUR', costProfileId: 'p', unitCostMinor: c.cost, fixedFeeMinor: 0, feeRateBp: c.fee, tax: { regime: 'VAT_INCLUDED', vatRateBp: c.tax } }, c.margin);
    const db = rows[i]!.price === null ? null : Number(rows[i]!.price);
    if (!code.ok) unattainable++;
    assert.equal(db, code.ok ? code.priceMinor : null, `case ${JSON.stringify(c)}`);
  });
  assert.ok(unattainable > 0 && unattainable < cases.length, `both outcomes are exercised (${unattainable} unattainable)`);

  const at = now();
  const fx = Array.from({ length: 3000 }, () => ({ amount: rnd(3_000_000), rate: 500_000 + rnd(1_500_000), toUsd: rnd(2) === 0 }));
  const { rows: converted } = await pool.query(
    `SELECT tenant_data.convert_cost_up(a, CASE WHEN u THEN 'EUR' ELSE 'USD' END, CASE WHEN u THEN 'USD' ELSE 'EUR' END, r) AS v
       FROM unnest($1::bigint[], $2::bigint[], $3::boolean[]) WITH ORDINALITY z(a, r, u, i) ORDER BY i`,
    [fx.map((f) => f.amount), fx.map((f) => f.rate), fx.map((f) => f.toUsd)]);
  fx.forEach((f, i) => {
    const quote = { source: 'ECB' as const, rateDate: at.slice(0, 10), base: 'EUR' as const, quote: 'USD', rateMicros: f.rate, availableFrom: at };
    const code = convertMinor(f.amount, f.toUsd ? 'EUR' : 'USD', f.toUsd ? 'USD' : 'EUR', [quote], at, 'UP');
    assert.ok(code.ok);
    assert.equal(Number(converted[i]!.v), code.amountMinor, `fx case ${JSON.stringify(f)}`);
  });
});
