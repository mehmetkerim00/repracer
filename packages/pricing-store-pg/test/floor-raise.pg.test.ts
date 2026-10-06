import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, AlertSink, ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import type { CostInputs } from '@repracer/pricing-model';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createWriteDispatcher, DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import { inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { approved, commit, contextOf } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 73 на PostgreSQL — три решения владельца о подъёме к полу [Р-207], полный цикл настоящим путём решения и диспетчером:
 *  - Р-208: предел шага не снимается, подъём к полу идёт лестницей — каждая оценка (пересчёт по расписанию) ставит ступень на предел
 *    шага, пока цена не дойдёт до пола; ступень ниже пола база пропускает только выше нынешней цены, которую знает сама;
 *  - Р-209: отказ перепроверки пола перед отправкой по новому курсу — ожидаемый; за ним база ставит запрос на переоценку, пересчёт
 *    переоценивает единицу по новому курсу и поднимает цену до пола; версия не застревает;
 *  - Р-210: себестоимость выросла — запрос базы, подъём до пола сразу, без наблюдения конкурентов, «after cost update».
 * Канал — заглушка, которая принимает и применяет запись сразу. Данные синтетические.
 */

const ACCOUNT = '20000000-0000-4000-8000-000000000073';
const US_ACCOUNT = '20000000-0000-4000-8000-000000000173';
const DAY_MS = 86_400_000;
const now = () => new Date().toISOString();
const day = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
const MATCH = { strategyId: 'st-match', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 1, holdWhenWinning: true, atBound: 'CAP' }, deadbandMinor: 0 } as const;

// Пол маржи 10 % при комиссии 10 %, EUR, НДС 19 %: себестоимость 10,00 € → пол 15,24 €; 12,00 € → 18,29 €
const eurCost = (unitCostMinor: number): CostInputs => ({
  currency: 'EUR', costProfileId: `cp-${unitCostMinor}`, unitCostMinor, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 },
});

function scope(n: number, over: Partial<MemorySeedScope> = {}): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(7300 + n),
    channelProductRef: `37373${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: MATCH,
    currentPriceMinor: 1600, minPrice: { amountMinor: 500, id: `min-${n}` }, maxPrice: { amountMinor: 10_000, id: `max-${n}` },
    cost: eurCost(1000), guardrails: { minMarginBp: 1000 }, ...over,
  };
}

let db: IsolatedDatabase;
let pool: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;
const sent: FieldWrite[] = [];
const alerts: Array<Parameters<AlertSink['raise']>[0]> = [];

before(async () => {
  db = await createIsolatedDatabase('step73');
  // Витрина США пишет в бой: граница суток объявлена подтверждённой, КАК ЕСЛИ БЫ Amazon ответил (как write-recheck.pg.test.ts)
  await db.superuser(`UPDATE platform.marketplace SET time_zone = 'America/Los_Angeles', time_zone_status = 'CONFIRMED',
                             time_zone_source = 'проба шага 73 на витрине США: граница суток объявлена подтверждённой, как если бы A-03 был закрыт'
                       WHERE marketplace = 'ATVPDKIKX0DER'`);
  pool = db.pool('svc_app');
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2),
    fixtureTenantId: '10000000-0000-4000-8000-000000000073', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: now(),
    fxLoaderPool: db.pool('svc_fx_loader', 1),
    seed: {
      scopes: [
        scope(1, { currentPriceMinor: 1000, guardrails: { minMarginBp: 1000, maxStepChangeBp: 1000 } }), // Р-208: лестница 10,00 → 15,24 €
        scope(2), // Р-210: себестоимость вырастет, пол поднимется выше нынешней цены
        scope(4, { currentPriceMinor: 1000 }), // Р-208: обычное решение ниже пола, но выше нынешней цены — не ступень
        // Р-209: USD, себестоимость 10,00 € по 1,10 → 11,00 $ → пол 13,75 $; по 1,20 → 15,00 $
        scope(3, {
          channelAccountId: US_ACCOUNT, marketplace: 'ATVPDKIKX0DER', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', currentPriceMinor: 1400,
          cost: { currency: 'EUR', costProfileId: 'cp-usd', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'SALES_TAX_EXCLUDED' } },
        }),
      ],
      accounts: [{ channelAccountId: US_ACCOUNT, channel: 'AMAZON', region: 'NA', marketplaces: ['ATVPDKIKX0DER'] }],
      marketplaces: { ATVPDKIKX0DER: { currency: 'USD', basis: 'NET' } },
      fxRates: [{ source: 'ECB', rateDate: day(-1), base: 'EUR', quote: 'USD', rateMicros: 1_100_000, availableFrom: new Date(Date.now() - 3_600_000).toISOString() }],
    },
  });
  store = new PgPricingStore(pool);
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

const pipeline = () => createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { alerts.push(a); } }, logger: { log: () => undefined }, now: () => now() as never });
const ctxOf = (account: string): AdapterCallContext => ({ tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(account) as never, correlationId: 'step73', deadline: new Date(Date.now() + 60_000).toISOString() as never });
const ws = (n: number) => world.ids.dbId(`ws-${n}`);
const sentTo = (n: number) => sent.filter((w) => w.writeScope.writeScopeId === ws(n) && w.value.field === 'PRICE').map((w) => (w.value as { price: { amountMinor: number } }).price.amountMinor);

/** Намерения единицы по порядку: причина стратегии и её параметры — то, что стоит в объяснении */
async function intents(n: number): Promise<Array<{ code: string; params: Record<string, unknown>; proposed: number }>> {
  return inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT rationale -> 'reason' ->> 'code' AS code, rationale -> 'reason' -> 'params' AS params, proposed_amount_minor::int AS proposed
       FROM channel_data.price_intent WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY created_at, price_intent_id`, [world.tenantId, ws(n)])).rows);
}

/** Черновик решения, как его отдал бы Gate: курс перевода себестоимости — в решении [Р-61]; правило — не из данных конкурентов */
async function draft(n: number, amountMinor: number) {
  const ctx = await contextOf(store, world.tenantId, ws(n));
  const d = approved(ctx, amountMinor);
  d.decision.fx = ctx.cost?.fx ?? null;
  d.intent.ruleCode = 'FLOOR_RAISE';
  return d;
}

async function requests(n: number): Promise<string[]> {
  return inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT reason FROM tenant_data.floor_raise_request WHERE tenant_id = $1 AND write_scope_id = $2 ORDER BY reason`, [world.tenantId, ws(n)])).rows.map((r) => r.reason));
}

test('Р-208: a raise larger than the step limit climbs to the margin floor, one step per scheduled evaluation, and stops there', async () => {
  const p = pipeline();
  // Первая оценка — пересчёт единицы без снимка конкурентов: нынешняя 10,00 € ниже пола 15,24 €, предел шага 10 %
  const first = await p.recompute(ctxOf(ACCOUNT), ws(1), { type: 'SCHEDULE' });
  assert.equal(first.decision?.outcome, 'APPROVED', JSON.stringify(first));
  // Дальше лестницу ведёт пересчёт по расписанию: последнее решение — ступень, записи в полёте нет
  for (let pass = 0; pass < 10; pass += 1) {
    const r = await p.recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
    if (r.raised === 0) break;
  }
  assert.deepEqual(sentTo(1), [1100, 1210, 1331, 1464, 1524], 'each step is within the step limit, the last one is the floor');
  const steps = (await intents(1)).filter((i) => i.code === 'RAISED_TOWARD_FLOOR' || i.code === 'RAISED_TO_FLOOR');
  assert.deepEqual(steps.map((s) => [s.code, s.params.stepsLeft ?? null]),
    [['RAISED_TOWARD_FLOOR', 4], ['RAISED_TOWARD_FLOOR', 3], ['RAISED_TOWARD_FLOOR', 2], ['RAISED_TOWARD_FLOOR', 1], ['RAISED_TO_FLOOR', null]],
    'the explanation counts the steps left');
  // У каждой ступени ниже пола решение несёт цену, от которой она поднялась; у последней (на полу) — нет
  const ladder = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT final_amount_minor::int AS final, ladder_from_minor::int AS "from", effective_floor_minor::int AS floor
       FROM channel_data.price_decision WHERE tenant_id = $1 AND write_scope_id = $2 AND outcome = 'APPROVED' ORDER BY decided_at`, [world.tenantId, ws(1)])).rows);
  assert.deepEqual(ladder.map((d) => [d.final, d.from]), [[1100, 1000], [1210, 1100], [1331, 1210], [1464, 1331], [1524, null]]);
  assert.ok(ladder.every((d) => d.floor === 1524));
  // На полу лестница кончается: следующий заход пересчёта единицу не берёт
  const after = await p.recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.equal(after.raised, 0);
  assert.deepEqual(sentTo(1).length, 5);
});

test('Р-208: below the floor the database lets a write through only as a step above the price it knows itself — not above a price the decision claims', async () => {
  // Нынешняя цена по базе — 15,24 € (последняя принятая каналом). Решение «ступень от 11,00 €» на 12,00 € — неправда о нынешней цене
  const lie = await draft(1, 1200);
  lie.decision.effectiveFloorMinor = 1524;
  lie.decision.ladderFromMinor = 1100;
  const r = await commit(store, world.tenantId, lie);
  assert.ok(r.status === 'CONTEXT_CHANGED' && r.reason.code === 'BELOW_MARGIN_FLOOR', `a step below the current price: ${JSON.stringify(r)}`);
  // Обычное решение (не ступень) ниже пола, но выше нынешней цены 10,00 € — тоже отказ: ниже пола пропускается только ступень
  const plain = await commit(store, world.tenantId, await draft(4, 1100));
  assert.ok(plain.status === 'CONTEXT_CHANGED' && plain.reason.code === 'BELOW_MARGIN_FLOOR', `a plain decision below the floor: ${JSON.stringify(plain)}`);
});

test('Р-210: the unit cost rose above the price — the database requests a re-evaluation and the price goes to the floor at once, without a competitor observation', async () => {
  // Нынешняя 16,00 € выше пола 15,24 €; себестоимость 12,00 € поднимает пол до 18,29 €
  await world.setCost('ws-2', eurCost(1200));
  const costRequest = await requests(2);
  assert.ok(costRequest.length === 1 && costRequest[0] === 'COST_UPDATE', 'a new cost version is a request, set by the database');
  await pipeline().recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.deepEqual(sentTo(2), [1829]);
  const raised = (await intents(2)).at(-1)!;
  assert.deepEqual([raised.code, raised.params.after, raised.params.floorMinor, raised.params.currentMinor], ['RAISED_TO_FLOOR', 'COST_UPDATE', 1829, 1600]);
  assert.deepEqual(await requests(2), [], 'the request is taken');
  // Отрицательный контроль: себестоимость снова изменилась, но пол ниже нынешней цены — переоценки без снимка нет, запрос всё равно снят
  await world.setCost('ws-2', eurCost(1100));
  await pipeline().recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.deepEqual(sentTo(2), [1829], 'no raise when the price is not below the floor');
  assert.deepEqual(await requests(2), []);
  // Оценка комиссии — часть себестоимости продажи: её изменение тоже ставит запрос
  // Изменение — в сессии тенанта, как у работы импорта комиссии: запрос ставится в границе тенанта (RLS)
  await db.superuser(`WITH t AS (SELECT set_config('app.tenant_id', $1::text, true))
                      UPDATE channel_data.fee_estimate SET fee_model = '{"feeRateBp": 1500, "fixedFeeMinor": 0}'::jsonb
                       WHERE tenant_id = $1::uuid AND write_scope_id = $2::uuid AND (SELECT count(*) FROM t) = 1`, [world.tenantId, ws(2)]);
  const feeChange = await requests(2);
  assert.ok(feeChange.length === 1 && feeChange[0] === 'COST_UPDATE', 'a fee estimate change is a request too');
  await pipeline().recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  // Ревью шага 73, находка 8: запрос изменения снят — следующая проверка видит только новый
  assert.deepEqual(await requests(2), [], 'the fee change request is taken');
  // Новая оценка комиссии (продавец объявил свою) — тоже повод
  await db.superuser(`WITH t AS (SELECT set_config('app.tenant_id', $1::text, true))
                      INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, computed_at, valid_until)
                      SELECT $1::uuid, $2::uuid, 'SELLER_DECLARED', '{"feeRateBp": 1200, "fixedFeeMinor": 0}'::jsonb, now(), now() + interval '30 days'
                       WHERE (SELECT count(*) FROM t) = 1`, [world.tenantId, ws(2)]);
  const feeNew = await requests(2);
  assert.ok(feeNew.length === 1 && feeNew[0] === 'COST_UPDATE', 'a new fee estimate is a request too');
});

test('Р-209: a write refused by the floor recheck at the new ECB rate is followed by a re-evaluation at that rate and a raise; the version does not get stuck', async () => {
  // Запись 14,00 $ в полёте, за ней ждёт 13,75 $ (пол по курсу 1,10)
  const first = await commit(store, world.tenantId, await draft(3, 1400));
  assert.ok(first.status === 'COMMITTED' && first.decisions[0]!.write, JSON.stringify(first));
  const second = await commit(store, world.tenantId, await draft(3, 1375));
  assert.ok(second.status === 'COMMITTED' && second.decisions[0]!.pendingWriteId, JSON.stringify(second));
  const queue = new PgWriteQueueStore(pool);
  await queue.recordOutcome(world.tenantId, first.decisions[0]!.write!, { channelWriteId: first.decisions[0]!.write!.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  // ЕЦБ опубликовал 1,20: пол — 15,00 $. Перед отправкой база отказывает ждущей записи по ТЕКУЩЕМУ курсу — это ожидаемо [Р-83]
  await db.pool('svc_fx_loader', 1).query(
    `INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, available_from, source_ref)
     VALUES ('ECB', $1, 'EUR', 'USD', 1.2, now(), 'step 73 synthetic')`, [day(0)]);
  const dispatcher = createWriteDispatcher({ store: queue, adapterFor: () => adapter, alerts: { raise: async (a) => { alerts.push(a); } }, now });
  const report = await dispatcher.dispatchScope(world.tenantId, ws(3));
  assert.ok(report.steps.some((s) => s.action === 'ENDED' && s.reason.code === 'WRITE_BLOCKED_BY_BOUND_RECHECK'), JSON.stringify(report.steps));
  assert.ok(!sentTo(3).includes(1375), 'the write below the new floor did not reach the channel');
  // За отказом — запрос на переоценку, его ставит база
  const refused = await requests(3);
  assert.ok(refused.length === 1 && refused[0] === 'FLOOR_RECHECK', 'a write refused by the floor recheck is a request for a re-evaluation');
  // Переоценка по новому курсу: нынешняя 14,00 $ ниже пола 15,00 $ — подъём до пола
  await pipeline().recomputeScheduled(ctxOf(US_ACCOUNT), { limit: 100 });
  assert.deepEqual(sentTo(3), [1500], 'only the re-evaluated price at the new floor reached the channel');
  const raised = (await intents(3)).at(-1)!;
  assert.deepEqual([raised.code, raised.params.after, raised.params.floorMinor, raised.params.currentMinor], ['RAISED_TO_FLOOR', 'FLOOR_RECHECK', 1500, 1400]);
  // Версия не застряла: ни одной записи в очереди или в полёте, последняя принятая — подъём, запрос снят
  const state = await inTenant(pool, world.tenantId, async (tx) => (await tx.query(
    `SELECT ss.in_flight_write_id, ss.last_sent_amount_minor::int AS last_sent, ss.latest_version_accepted = ss.latest_version_created AS settled,
            (SELECT count(*)::int FROM tenant_data.channel_write w WHERE w.tenant_id = ss.tenant_id AND w.write_scope_id = ss.write_scope_id
                AND w.status IN ('PENDING', 'DISPATCHED', 'FAILED', 'BLOCKED')) AS open
       FROM tenant_data.write_scope_sync_state ss WHERE ss.tenant_id = $1 AND ss.write_scope_id = $2`, [world.tenantId, ws(3)])).rows[0]);
  assert.deepEqual(state, { in_flight_write_id: null, last_sent: 1500, settled: true, open: 0 });
  assert.deepEqual(await requests(3), []);
});

/**
 * Ревью шага 73, находка 3: витрина разошлась с отправленным — продавец поднял цену в кабинете канала (Р-55). Ступень выше нашей последней
 * отправки, но ниже цены на витрине СНИЗИЛА бы видимую цену и всё равно осталась бы ниже пола — база её не пропускает
 */
test('Р-208: after an external edit above our last price a step must be above the storefront price too', async () => {
  // Нынешняя 16,00 € принята каналом; себестоимость 12,00 € поднимает пол до 18,29 €
  const sentFirst = await commit(store, world.tenantId, await draft(4, 1600));
  assert.ok(sentFirst.status === 'COMMITTED' && sentFirst.decisions[0]!.write, JSON.stringify(sentFirst));
  const queue = new PgWriteQueueStore(pool);
  await queue.recordOutcome(world.tenantId, sentFirst.decisions[0]!.write!, { channelWriteId: sentFirst.decisions[0]!.write!.channelWriteId, status: 'ACCEPTED', appliedImmediately: true }, now(), DEFAULT_RETRY_POLICY);
  await world.setCost('ws-4', eurCost(1200));
  // Продавец поставил 17,50 € в кабинете: наблюдение расходится с отправленным
  await db.superuser(`UPDATE channel_data.observed_channel_state SET observed_amount_minor = 1750, sync_status = 'DIVERGED', divergence_cause = 'EXTERNAL_CHANGE',
                             diverged_since = now(), observed_at = now(), received_at = now()
                       WHERE tenant_id = $1 AND write_scope_id = $2 AND field = 'PRICE'`, [world.tenantId, ws(4)]);
  const rung = async (amountMinor: number) => {
    const d = await draft(4, amountMinor);
    d.decision.effectiveFloorMinor = 1829;
    d.decision.ladderFromMinor = 1600;
    return commit(store, world.tenantId, d);
  };
  const below = await rung(1700);
  assert.ok(below.status === 'CONTEXT_CHANGED' && below.reason.code === 'BELOW_MARGIN_FLOOR', `a step below the storefront price after an external edit: ${JSON.stringify(below)}`);
  // Положительный контроль: ступень выше цены на витрине (и ниже пола) база пропускает — отказ выше дала именно витрина
  const above = await rung(1800);
  assert.equal(above.status, 'COMMITTED', JSON.stringify(above));
});

/**
 * Ревью шага 73, находка 1: суточная свёртка (вечно, Р-21) и закрытие суток держат «цена суток не ниже пола суток»; ступени лестницы
 * выше — сутки с ними закрываются, строка называет число ступеней, а пол суток остаётся настоящим полом. Последний тест файла: закрывает
 * сутки всей базы
 */
test('Р-208: a day with ladder steps closes — the daily row counts the steps and keeps the real floor', async () => {
  await db.superuser(`SELECT maintenance.close_price_days(now() + interval '3 days', 10)`);
  await db.superuser(`SELECT maintenance.correct_closed_price_days(now() + interval '3 days')`);
  const [row] = await db.rows(
    `SELECT min_amount_minor::int AS min, min_floor_minor::int AS floor, ladder_steps AS steps, change_count AS changes
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(1)]);
  assert.deepEqual(row, { min: 1100, floor: 1524, steps: 4, changes: 5 }, 'the ladder day is closed with its four steps below the floor');
  // Сутки без ступеней по-прежнему держат цену не ниже пола: строка ниже пола без ступеней — отказ того же ограничения
  await assert.rejects(db.superuser(
    `INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor,
            max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
     SELECT tenant_id, write_scope_id, price_type, price_day - 30, day_tz, currency, price_basis, 1100, 1524, 1100, first_accepted_at, 1524,
            last_accepted_at, 2, 1524
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(1)]), /price_daily_check3/);
});
