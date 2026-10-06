import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, AlertSink, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
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
// Шаг 74: свой аккаунт Kaufland — запросы посева его единиц не забирает пересчёт основного аккаунта в лестнице шага 73
const B_ACCOUNT = '20000000-0000-4000-8000-000000000273';
const DAY_MS = 86_400_000;
/** Шаг 74 [Р-212]: часы прогона — настоящие плюс сдвиг; лестница и пауза между ступенями идут сдвигом, а не ожиданием */
let skewMs = 0;
const now = () => new Date(Date.now() + skewMs).toISOString();
const MINUTE_MS = 60_000;
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
        // Р-211: курс ЕЦБ без записи в полёте — цена 15,00 $ на полу по 1,20; по 1,25 пол 15,63 $
        scope(6, {
          channelAccountId: US_ACCOUNT, marketplace: 'ATVPDKIKX0DER', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', currentPriceMinor: 1500,
          cost: { currency: 'EUR', costProfileId: 'cp-usd-6', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'SALES_TAX_EXCLUDED' } },
        }),
        // Р-212: лестница и наблюдение конкурента внутри паузы
        scope(5, { channelAccountId: B_ACCOUNT, currentPriceMinor: 1000, guardrails: { minMarginBp: 1000, maxStepChangeBp: 1000 } }),
        // Р-211: min_price, гардрейл и НДС товара — запросы базы и подъём без наблюдения конкурентов
        scope(7, { channelAccountId: B_ACCOUNT }),
        // Р-211: себестоимость в долларах у цены в евро — курс, понизивший пол, запроса не даёт
        scope(8, { cost: { currency: 'USD', costProfileId: 'cp-usd-8', unitCostMinor: 1000, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } } }),
      ],
      accounts: [{ channelAccountId: US_ACCOUNT, channel: 'AMAZON', region: 'NA', marketplaces: ['ATVPDKIKX0DER'] },
        { channelAccountId: B_ACCOUNT, channel: 'KAUFLAND', marketplaces: ['de'] }],
      marketplaces: { ATVPDKIKX0DER: { currency: 'USD', basis: 'NET' } },
      // Курсы — по суткам ЕЦБ: посев позавчерашний, Р-209 — вчерашний, Р-211 — сегодняшний (контекст берёт курс не позже сегодняшних суток)
      fxRates: [{ source: 'ECB', rateDate: day(-2), base: 'EUR', quote: 'USD', rateMicros: 1_100_000, availableFrom: new Date(Date.now() - 3_600_000).toISOString() }],
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

/** Снимок конкурента единицы: Buy Box у чужого продавца по `buyboxMinor`, наблюдён сейчас по часам прогона */
function buybox(n: number, buyboxMinor: number): CompetitorSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  return {
    marketplace: 'de', channelProductRef: `37373${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never,
    completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(buyboxMinor), isSelf: false },
    offers: [{ rank: 1, sellerRef: 'synthetic-competitor', isSelf: false, price: money(buyboxMinor) }],
  };
}

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
  // Р-212 (шаг 74): заход пересчёта сразу после ступени — пауза, не вторая ступень
  await p.recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.deepEqual(sentTo(1), [1100], 'no second step within the pause');
  assert.equal((await intents(1)).at(-1)!.code, 'LADDER_PACED');
  // Дальше лестницу ведёт пересчёт по расписанию раз в период (15 минут): последнее одобренное изменение — ступень, записи в полёте нет
  for (let pass = 0; pass < 10; pass += 1) {
    skewMs += 16 * MINUTE_MS;
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
  skewMs += 16 * MINUTE_MS;
  const after = await p.recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.equal(after.raised, 0);
  assert.deepEqual(sentTo(1).length, 5);
  // Р-212: старт лестницы — уведомление владельцу один раз на лестницу, с суммами и числом ступеней
  const started = alerts.filter((a) => a.code === 'PRICE_LADDER_STARTED' && (a.details as { writeScopeId?: string }).writeScopeId === ws(1));
  assert.equal(started.length, 1, 'the ladder start is told once');
  assert.deepEqual([started[0]!.severity, started[0]!.details], ['WARNING', {
    writeScopeId: ws(1), offer: 'syn-prod-1', marketplace: 'de', currentMinor: 1000, floorMinor: 1524, steps: 5, stepLimitBp: 1000, paceMinutes: 15, currency: 'EUR',
  }]);
  // Вторая лестница тех же суток (ревью шага 74, находка 2): себестоимость 12,00 € поднимает пол до 18,29 € — ступень от 15,24 €, а не от
  // цены прошлой ступени, — новая лестница и новое уведомление
  await world.setCost('ws-1', eurCost(1200));
  skewMs += 16 * MINUTE_MS;
  await p.recomputeScheduled(ctxOf(ACCOUNT), { limit: 100 });
  assert.equal(sentTo(1).at(-1), 1676);
  const second = alerts.filter((a) => a.code === 'PRICE_LADDER_STARTED' && (a.details as { writeScopeId?: string }).writeScopeId === ws(1));
  assert.ok(second.length === 2 && (second[1]!.details as { currentMinor: number }).currentMinor === 1524, 'a second ladder of the same day is told again');
});

/**
 * Р-212 (шаг 74, OQ-255): ступень лестницы не чаще периода планового пересчёта, и наблюдения конкурентов её не ускоряют. Снимок конкурента
 * через минуту после ступени — «без изменения» паузы; через период — следующая ступень
 */
test('Р-212: a competitor observation within the pause does not make the next step; after the pause it does', async () => {
  const p = pipeline();
  const first = await p.recompute(ctxOf(B_ACCOUNT), ws(5), { type: 'SCHEDULE' });
  assert.equal(first.decision?.outcome, 'APPROVED', JSON.stringify(first));
  assert.deepEqual(sentTo(5), [1100]);
  skewMs += MINUTE_MS;
  await p.processSnapshot(ctxOf(B_ACCOUNT), buybox(5, 1300));
  const paced = (await intents(5)).at(-1)!;
  assert.ok(sentTo(5).length === 1 && paced.code === 'LADDER_PACED', `a competitor observation within the pause made no second step: ${JSON.stringify([sentTo(5), paced])}`);
  skewMs += 15 * MINUTE_MS;
  await p.processSnapshot(ctxOf(B_ACCOUNT), buybox(5, 1300));
  assert.deepEqual(sentTo(5), [1100, 1210], 'after the pause the observation makes the next step');
  assert.equal(alerts.filter((a) => a.code === 'PRICE_LADDER_STARTED' && (a.details as { writeScopeId?: string }).writeScopeId === ws(5)).length, 1,
    'one notification per ladder, not per step');
  // Ревью шага 74, находка 1: пауза лестницы — цена ниже пола по построению; алерта «текущая цена вне границ» она не поднимает
  assert.ok(!alerts.some((a) => a.code === 'CURRENT_PRICE_OUTSIDE_BOUNDS' && (a.details as { writeScopeId?: string }).writeScopeId === ws(5)),
    'the ladder pause raises no outside-bounds alert');
});

test('Р-208: below the floor the database lets a write through only as a step above the price it knows itself — not above a price the decision claims', async () => {
  // Нынешняя цена по базе — 16,76 € (последняя принятая каналом ступень второй лестницы). Решение «ступень от 11,00 €» на 12,00 € — неправда
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
  // Отрицательный контроль: перезапись той же оценки (повторный расчёт тарифа) — не изменение комиссии и не запрос
  await db.superuser(`WITH t AS (SELECT set_config('app.tenant_id', $1::text, true))
                      UPDATE channel_data.fee_estimate SET computed_at = computed_at
                       WHERE tenant_id = $1::uuid AND write_scope_id = $2::uuid AND (SELECT count(*) FROM t) = 1`, [world.tenantId, ws(2)]);
  const rewrite = await requests(2);
  assert.ok(rewrite.length === 0, 'a rewrite of the same fee estimate is not a request');
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
     VALUES ('ECB', $1, 'EUR', 'USD', 1.2, now(), 'step 73 synthetic')`, [day(-1)]);
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

/** Новая версия гардрейла или НДС товара — как их пишет административный сервис: от человека, в аудит */
async function adminInsert(sql: string, params: unknown[]): Promise<void> {
  await inTenant(db.pool('svc_admin', 1), world.tenantId, async (tx) => { await tx.query(sql, params); }, world.userId);
}

/**
 * Р-211 (шаг 74, OQ-254): любое изменение входов пола — запрос на переоценку, подъём не ждёт наблюдения конкурента. Единица 7: цена
 * 16,00 € над полом маржи 15,24 €; новая min_price 17,00 €, затем минимальная маржа 30 %, затем НДС товара 25 % — каждый раз запрос базы
 * и подъём на новый пол с поводом
 */
test('Р-211: a new min_price, guardrail or product VAT is a request and the price goes to the new floor without a competitor observation', async () => {
  const p = pipeline();
  // Запросы посева (себестоимость, границы, гардрейл) снимает первый заход: цена 16,00 € не ниже пола — без изменения
  await p.recomputeScheduled(ctxOf(B_ACCOUNT), { limit: 100 });
  assert.deepEqual(await requests(7), []);
  await world.setBound('ws-7', 'min', { amountMinor: 1700, id: 'min-7-v2' });
  assert.ok((await requests(7)).includes('BOUNDS_UPDATE'), 'a new min_price version is a request, set by the database');
  await p.recomputeScheduled(ctxOf(B_ACCOUNT), { limit: 100 });
  const byMin = (await intents(7)).at(-1)!;
  assert.deepEqual([sentTo(7), byMin.code, byMin.params.bound, byMin.params.after], [[1700], 'RAISED_TO_FLOOR', 'min', 'BOUNDS_UPDATE']);
  // Минимальная маржа 30 %: пол маржи выше min_price
  await adminInsert(`INSERT INTO tenant_data.guardrail (tenant_id, scope_type, write_scope_id, min_margin_bp, on_violation, version, created_by_membership_id)
                     SELECT $1, 'WRITE_SCOPE', $2, 3000, 'HOLD', coalesce(max(version), 0) + 1, $3 FROM tenant_data.guardrail
                      WHERE tenant_id = $1 AND scope_type = 'WRITE_SCOPE' AND write_scope_id = $2`, [world.tenantId, ws(7), world.ownerMembershipId]);
  assert.ok((await requests(7)).includes('GUARDRAIL_UPDATE'), 'a new guardrail version is a request, set by the database');
  await p.recomputeScheduled(ctxOf(B_ACCOUNT), { limit: 100 });
  const byMargin = (await intents(7)).at(-1)!;
  assert.deepEqual([byMargin.code, byMargin.params.bound, byMargin.params.after], ['RAISED_TO_FLOOR', 'margin_floor', 'GUARDRAIL_UPDATE']);
  const marginFloor = byMargin.params.floorMinor as number;
  assert.ok(marginFloor > 1700 && sentTo(7).at(-1) === marginFloor, JSON.stringify(sentTo(7)));
  // НДС товара 25 %: цена брутто — пол маржи растёт
  await adminInsert(`INSERT INTO tenant_data.product_vat_rate (tenant_id, product_id, country, rate_bp, version, created_by_membership_id)
                     SELECT $1, s.product_id, 'DE', 2500, coalesce((SELECT max(v.version) FROM tenant_data.product_vat_rate v
                                                                     WHERE v.tenant_id = $1 AND v.product_id = s.product_id AND v.country = 'DE'), 0) + 1, $3
                       FROM tenant_data.write_scope s WHERE s.tenant_id = $1 AND s.write_scope_id = $2`, [world.tenantId, ws(7), world.ownerMembershipId]);
  assert.ok((await requests(7)).includes('VAT_UPDATE'), 'a new VAT rate of the product is a request, set by the database');
  await p.recomputeScheduled(ctxOf(B_ACCOUNT), { limit: 100 });
  const byVat = (await intents(7)).at(-1)!;
  assert.deepEqual([byVat.code, byVat.params.bound, byVat.params.after], ['RAISED_TO_FLOOR', 'margin_floor', 'VAT_UPDATE']);
  assert.ok((byVat.params.floorMinor as number) > marginFloor);
  assert.deepEqual(await requests(7), [], 'every request is taken');
  // max_price — тоже вход пола: пол маржи действует, только пока он не выше max_price (ревью шага 74, находка 1 по Р-211)
  await world.setBound('ws-7', 'max', { amountMinor: 12_000, id: 'max-7-v2' });
  assert.ok((await requests(7)).includes('BOUNDS_UPDATE'), 'a new max_price version is a request too');
  await p.recomputeScheduled(ctxOf(B_ACCOUNT), { limit: 100 });
});

/**
 * Р-211: курс ЕЦБ — данные платформы. Цена 15,00 $ стоит на полу по 1,20 и записи в полёте нет: отказа перепроверки не будет, а пол по
 * 1,25 — 15,63 $. Запрос ставит функция базы в границе тенанта, отметка аккаунта не даёт поставить его дважды
 */
test('Р-211: a new ECB rate is a request for offers priced from a cost in another currency, once per rate', async () => {
  const usId = world.ids.dbId(US_ACCOUNT);
  const euId = world.ids.dbId(ACCOUNT);
  await store.requestFloorRaiseForPlatformInputs(world.tenantId, usId, now());
  // У предложения 8 себестоимость в долларах, цена в евро: доллар дешевеет (1,10 → 1,20 → 1,25 за евро) — пол в евро только опускается
  await store.requestFloorRaiseForPlatformInputs(world.tenantId, euId, now());
  skewMs += MINUTE_MS;
  await db.pool('svc_fx_loader', 1).query(
    `INSERT INTO platform.fx_rate (source, rate_date, base_currency, quote_currency, rate, available_from, source_ref)
     VALUES ('ECB', $1, 'EUR', 'USD', 1.25, $2, 'step 74 synthetic')`, [day(0), now()]);
  skewMs += MINUTE_MS;
  const n = await store.requestFloorRaiseForPlatformInputs(world.tenantId, usId, now());
  assert.ok(n >= 1 && (await requests(6)).includes('FX_UPDATE'), 'a new ECB rate is a request for an offer priced from a cost in another currency');
  await store.requestFloorRaiseForPlatformInputs(world.tenantId, euId, now());
  assert.ok(!(await requests(8)).includes('FX_UPDATE'), 'a rate that lowers the floor is not a request');
  skewMs += MINUTE_MS;
  const again = await store.requestFloorRaiseForPlatformInputs(world.tenantId, usId, now());
  assert.ok(again === 0, 'the same rate is not requested twice');
  await pipeline().recomputeScheduled(ctxOf(US_ACCOUNT), { limit: 100 });
  const raised = (await intents(6)).at(-1)!;
  assert.deepEqual([sentTo(6), raised.code, raised.params.after, raised.params.currentMinor], [[1563], 'RAISED_TO_FLOOR', 'FX_UPDATE', 1500]);
  assert.deepEqual(await requests(6), []);
});

/** Р-211: ставка НДС по умолчанию страны витрины, вступившая в силу, — запрос для предложений с НДС в цене (данные платформы) */
test('Р-211: a default VAT rate of the storefront country coming into force is a request for offers with VAT in the price', async () => {
  const accountId = world.ids.dbId(ACCOUNT);
  await store.requestFloorRaiseForPlatformInputs(world.tenantId, accountId, now());
  // Ставка вступает в силу через двое суток по часам ПРОГОНА (не по настоящим: часы прогона сдвинуты, и около полуночи UTC «завтра»
  // настоящих часов уже было бы «видено» отметкой). Заход до неё запроса не ставит, заход после — ставит
  const validFrom = new Date(Date.parse(now()) + 2 * DAY_MS).toISOString().slice(0, 10);
  await db.superuser(`INSERT INTO platform.vat_rate_default (tenant_id, country, rate_bp, valid_from, source)
                      VALUES (security.platform_tenant_id(), 'DE', 2000, $1::date, 'step 74 synthetic')`, [validFrom]);
  assert.equal(await store.requestFloorRaiseForPlatformInputs(world.tenantId, accountId, now()), 0);
  await store.requestFloorRaiseForPlatformInputs(world.tenantId, accountId, `${validFrom}T01:00:00.000Z`);
  assert.ok((await requests(2)).includes('VAT_UPDATE'), 'a default VAT rate coming into force is a request for offers with VAT in the price');
  // Предложение без НДС в цене (витрина США) запроса не получает
  assert.ok(!(await requests(6)).includes('VAT_UPDATE'));
});

/**
 * Ревью шага 73, находка 1: суточная свёртка (вечно, Р-21) и закрытие суток держат «цена суток не ниже пола суток»; ступени лестницы
 * выше — сутки с ними закрываются, строка называет число ступеней, а пол суток остаётся настоящим полом. Последний тест файла: закрывает
 * сутки всей базы
 */
test('Р-208: a day with ladder steps closes — the daily row counts the steps and keeps the real floor', async () => {
  await db.superuser(`SELECT maintenance.close_price_days(now() + interval '3 days', 10)`);
  await db.superuser(`SELECT maintenance.correct_closed_price_days(now() + interval '3 days')`);
  // Сутки — по поясу витрины: лестница (5 ступеней по 16 минут часов прогона) может лечь на двое суток — утверждается сумма по суткам
  const [row] = await db.rows(
    `SELECT min(min_amount_minor)::int AS min, min(min_floor_minor)::int AS floor, sum(ladder_steps)::int AS steps, sum(change_count)::int AS changes
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(1)]);
  // Сверка — с журналом наших цен той же единицы: число цен, число ступеней и наименьшая цена суток (две лестницы и их продолжения)
  const [journal] = await db.rows(
    `SELECT min(amount_minor)::int AS min, count(*) FILTER (WHERE ladder_from_minor IS NOT NULL)::int AS steps, count(*)::int AS changes
       FROM tenant_data.price_history WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(1)]);
  assert.deepEqual(row, { ...journal as object, floor: 1524 }, 'the ladder days are closed with their steps below the floor');
  assert.ok((journal as { steps: number }).steps >= 5, JSON.stringify(journal));
  // Ревью шага 73 (отложенное): ручная поправка закрытых суток знает ступени — без них цена ниже пола отклоняется, с ними принимается,
  // и итог суток несёт число ступеней поправки
  const correction = (steps: number) => db.superuser(
    `INSERT INTO tenant_data.price_daily_correction (tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor, first_amount_minor,
            first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor, reason, created_by_membership_id, ladder_steps)
     SELECT tenant_id, write_scope_id, price_type, price_day, min_amount_minor, max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor,
            last_accepted_at, change_count, min_floor_minor, 'Synthetic correction of a day with ladder steps', $3, $4
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2 AND ladder_steps > 0 ORDER BY price_day LIMIT 1`,
    [world.tenantId, ws(1), world.ownerMembershipId, steps]);
  await assert.rejects(correction(0), /price_daily_correction_check3/, 'a human correction below the floor without ladder steps');
  // Число ступеней поправки — заведомо не число ступеней суток (их меньше десяти): итог суток берёт его у поправки, а не у свёртки
  await correction(17);
  const [effective] = await db.rows(
    `SELECT ladder_steps AS steps, corrected_by AS who FROM tenant_data.price_daily_effective
      WHERE tenant_id = $1 AND write_scope_id = $2 AND corrected ORDER BY price_day LIMIT 1`, [world.tenantId, ws(1)]);
  assert.deepEqual(effective, { steps: 17, who: 'HUMAN' }, 'the effective day carries the ladder steps of the human correction');
  // Сутки без ступеней по-прежнему держат цену не ниже пола: строка ниже пола без ступеней — отказ того же ограничения
  await assert.rejects(db.superuser(
    `INSERT INTO tenant_data.price_daily (tenant_id, write_scope_id, price_type, price_day, day_tz, currency, price_basis, min_amount_minor,
            max_amount_minor, first_amount_minor, first_accepted_at, last_amount_minor, last_accepted_at, change_count, min_floor_minor)
     SELECT tenant_id, write_scope_id, price_type, price_day - 30, day_tz, currency, price_basis, 1100, 1524, 1100, first_accepted_at, 1524,
            last_accepted_at, 2, 1524
       FROM tenant_data.price_daily WHERE tenant_id = $1 AND write_scope_id = $2`, [world.tenantId, ws(1)]), /price_daily_check3/);
});

/**
 * Шаг 75 (ревью шага 75, находка 2): подпись предложения в событии алерта — название ПРОДАВЦА. Название, прочитанное из канала, живёт
 * 18 месяцев [Р-3], а событие алерта — до закрытия тенанта: вместо него в подписи SKU продавца
 */
test('step 75: the offer label of an alert is the seller title, never a title read from the channel', async () => {
  const label = async () => {
    const c = await contextOf(store, world.tenantId, ws(2));
    return [c.scope.productTitle ?? null, c.scope.productSku ?? null];
  };
  const setTitle = (title: string | null, readFromChannel: boolean) => db.superuser(
    `UPDATE tenant_data.product p SET title = $1, title_channel_read_at = CASE WHEN $2::boolean THEN now() END
       FROM tenant_data.write_scope s WHERE s.tenant_id = p.tenant_id AND s.product_id = p.product_id AND s.write_scope_id = $3`, [title, readFromChannel, ws(2)]);
  await setTitle('Plant pot, green', false);
  assert.deepEqual(await label(), ['Plant pot, green', 'syn-prod-2'], 'a title given by the seller labels the offer');
  await setTitle('Channel catalog title', true);
  assert.deepEqual(await label(), [null, 'syn-prod-2'], 'a title read from the channel does not go into the alert: the seller SKU does');
  await setTitle(null, false);
});
