import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext } from '@repracer/channel-port';
import { createPool, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct } from './live/kaufland-world.ts';
import { LANDED_CHANNEL_BONUS } from './simulator/buybox-rule.ts';

/**
 * Шаг 97, I3 [Р-219]: «Win the Buy Box» на БОЕВОМ мире симулятора — настоящая PostgreSQL, адаптер Kaufland поверх модели канала с формулой
 * Buy Box (landed − 0,50 тому, кого исполняет канал), путь решения и диспетчер, режим аккаунта LIVE: запись применяется, и модель решает,
 * у кого Buy Box, по нашей НОВОЙ цене. Сценарий: взять Buy Box (цена победителя с доставкой − подрез − поправка на исполнение каналом) →
 * держать → подниматься по ступени не чаще планового периода → потерять → вернуться к последней выигрышной цене и стоять паузу 4 периода.
 * Всё — в границах предложения. Наблюдение — модель канала (наша цена и держатель) и строки базы (причины, отрезки держателя). Данные синтетические.
 */

const PRODUCT = 397_100_001;
const MIN = 1200;
const MAX = 3000;
const PERIOD_MS = 15 * 60_000;
const TICK_MS = 5 * 60_000;

let db: IsolatedDatabase;
let w: KauflandLiveWorld;
let observer: PgPool;
const timeline: Array<{ minute: number; ours: number; selfWins: boolean; competitor: number }> = [];

const product: LiveProduct = {
  cls: 'HOT', idProduct: PRODUCT, marketplace: 'de', title: 'Synthetic lamp', pricingMode: 'ENGINE', costMinor: 900, pastMovesEveryMinutes: null,
  // Конкурента исполняет Kaufland: в начале 18,00, через 10 минут — 19,00 (рынок поднялся — есть куда подниматься и нам)
  competitorName: 'Harbor Goods', competitorChannelFulfilled: true, competitorStartMinor: 1800,
  behaviour: { kind: 'SCHEDULE', points: [{ atOffsetMs: 10 * 60_000, priceMinor: 1900 }] },
  strategy: {
    name: 'Win the Buy Box',
    definition: { strategyId: 'st-win', version: 1, deadbandMinor: 0,
      params: { type: 'WIN_BUYBOX', undercutMinor: 1, fulfillmentHandicapMinor: 50, creepUp: true, creepStepBp: 100, atBound: 'CAP' } },
  },
};

before(async () => {
  db = await createIsolatedDatabase('winbuybox');
  const clock = new VirtualClock(new Date(Date.now() - 6 * 3_600_000).toISOString());
  w = await kauflandLiveWorld({
    tag: 3970, clock, products: [product], seed: 3970, writeMode: 'LIVE', buyBox: LANDED_CHANNEL_BONUS,
    appPool: db.pool('svc_app', 3), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 1),
    // Канал без сбоев и с применением сразу: проверяется стратегия, а не отказы записи (их проверяют другие прогоны, K-14, K-15)
    params: { faults: { writeTimeoutShare: 0, timeoutAppliedShare: 0, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, applyDelayMs: 0 },
  });
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-win-buybox-observer' });
});

after(async () => {
  console.log(JSON.stringify({ timeline }, null, 0));
  await observer?.end();
  await db?.drop();
});

const ctx = (): AdapterCallContext => ({
  tenantId: w.world.tenantId as never, channelAccountId: w.world.channelAccountId as never, correlationId: 'step97-i3', deadline: w.clock.iso(60_000) as never,
});

function market() {
  const m = w.simulator.market('de', PRODUCT);
  return { ours: m.offers.find((o) => o.self)!.priceMinor, competitor: m.offers.find((o) => !o.self)!.priceMinor, selfWins: m.selfWins };
}

test('I3: Win the Buy Box on the live simulator world — take, hold, creep once per period until lost, step back and pause; all within bounds', async () => {
  const start = w.clock.nowMs();
  let lastSchedule = -Infinity;
  for (let t = 0; t <= 4 * 3_600_000; t += TICK_MS) {
    if (t > 0) w.clock.advance(TICK_MS);
    w.simulator.advanceTo(w.clock.nowMs());
    // Опрос Buy Box товара — как ярусный опрос планировщика; снимок идёт обычным путём решения
    const read = await w.adapter.readCompetitors(ctx(), [{ marketplace: 'de', channelProductRef: String(PRODUCT), condition: 'new' }]);
    assert.equal(read.failures.length, 0, JSON.stringify(read.failures));
    for (const snapshot of read.snapshots) await w.pipeline.processSnapshot(ctx(), snapshot);
    // Плановый пересчёт — таймер ступени подъёма (тот же период, что у лестницы)
    if (w.clock.nowMs() - lastSchedule >= PERIOD_MS) { lastSchedule = w.clock.nowMs(); await w.pipeline.recomputeScheduled(ctx(), { limit: 10 }); }
    await w.betweenTicks();
    w.simulator.advanceTo(w.clock.nowMs());
    timeline.push({ minute: Math.round((w.clock.nowMs() - start) / 60_000), ...market() });
  }

  // 1) взяли: цена победителя (18,00, исполняет канал) − подрез 0,01 − поправка 0,50 = 17,49 — и Buy Box наш по формуле модели
  assert.equal(timeline[0]!.ours, 1749, `take: ${JSON.stringify(timeline.slice(0, 3))}`);
  assert.equal(timeline[0]!.selfWins, true, 'the Buy Box is ours after the take');

  // 2) подъём: каждая ступень — +1 % (в центах вниз), не чаще периода, только пока Buy Box наш
  const prices = timeline.map((x) => x.ours);
  const rises: Array<{ i: number; from: number; to: number }> = [];
  for (let i = 1; i < timeline.length; i++) if (prices[i]! > prices[i - 1]!) rises.push({ i, from: prices[i - 1]!, to: prices[i]! });
  assert.ok(rises.length >= 3, `the price crept up step by step: ${JSON.stringify(rises)}`);
  for (const r of rises.slice(0, 5)) {
    assert.equal(r.to - r.from, Math.max(1, Math.floor((r.from * 100) / 10_000)), `one step of 1 %: ${JSON.stringify(r)}`);
    assert.equal(timeline[r.i - 1]!.selfWins, true, 'a raise only while holding the Buy Box');
  }
  for (let k = 1; k < rises.length; k++) {
    assert.ok((rises[k]!.i - rises[k - 1]!.i) * TICK_MS >= PERIOD_MS, `no more often than the scheduled period: ${JSON.stringify(rises)}`);
  }

  // 3) потеря и шаг назад: первая потеря — сразу после ступени; следующая оценка возвращает последнюю выигрышную цену, Buy Box снова наш
  const lost = timeline.findIndex((x, i) => i > 0 && !x.selfWins);
  assert.ok(lost > 0, `the creep lost the Buy Box at some step: ${JSON.stringify(timeline)}`);
  const lostAt = timeline[lost]!.ours;
  const lastWinning = rises.find((r) => r.to === lostAt)!.from;
  const back = timeline.findIndex((x, i) => i > lost && x.ours < lostAt);
  assert.ok(back > lost, 'after the loss the price went down');
  assert.equal(timeline[back]!.ours, lastWinning, `stepped back to the last winning price ${lastWinning}, not lower`);
  assert.equal(timeline[back]!.selfWins, true, 'the Buy Box is ours again');

  // 4) пауза 4 периода: цена потери — потолок, подъёма нет
  const pauseEnd = timeline.findIndex((x, i) => i > back && x.ours > lastWinning);
  const pausedMs = ((pauseEnd < 0 ? timeline.length : pauseEnd) - back) * TICK_MS;
  assert.ok(pausedMs >= 4 * PERIOD_MS - TICK_MS, `no raise during the pause of 4 periods (${pausedMs / 60_000} min)`);

  // 5) границы: ни одна наша цена не вышла за min и max; Gate не отклонил ни одного решения
  assert.ok(prices.every((p) => p >= MIN && p <= MAX), `within bounds: ${prices.join(',')}`);
  const { rows: decisions } = await observer.query(
    `SELECT outcome, rejection_reason, no_change_reason FROM channel_data.price_decision WHERE tenant_id = $1 ORDER BY decided_at`, [w.seeded.tenantId]);
  assert.deepEqual(decisions.filter((d) => d.rejection_reason !== null), [], 'Gate refused nothing');

  // 6) объяснение — своими кодами: цель победы, ступень, шаг назад и пауза — в базе, а не только в модели
  const { rows: [codes] } = await observer.query(
    `SELECT array_agg(DISTINCT e->>'code' ORDER BY e->>'code') AS codes FROM channel_data.price_intent i, jsonb_array_elements(i.rationale->'explanation') e WHERE i.tenant_id = $1`,
    [w.seeded.tenantId]);
  for (const code of ['BUYBOX_WIN_TARGET', 'CREEP_UP', 'CREEP_STEP_BACK']) assert.ok((codes.codes as string[]).includes(code), `${code} in the explanation: ${codes.codes}`);
  assert.ok(decisions.some((d) => d.no_change_reason === 'CREEP_PAUSED'), 'the pause is a recorded reason');

  // 7) отрезки держателя Buy Box в базе — чужой, наш, чужой (потеря), наш
  const { rows: spans } = await observer.query(
    `SELECT holder FROM channel_data.buybox_span WHERE tenant_id = $1 ORDER BY started_at`, [w.seeded.tenantId]);
  assert.deepEqual(spans.map((s) => s.holder).slice(0, 4), ['OTHER', 'SELF', 'OTHER', 'SELF'], `holder spans: ${spans.map((s) => s.holder).join(' → ')}`);
});

/**
 * Ревью шага 97, находка (в1): таймер ступени подъёма берёт единицу, только когда ступень возможна. Иначе — решение «без изменения» раз в
 * период без конца (96 в сутки на единицу): у максимума (CREEP_AT_MAX), в паузе после шага назад, в тени (предложение удержано и повторяется).
 * Состояния создают снимки; таймер вызывается там, где без исправления он взял бы единицу: решения не было период, снимок ещё свежий
 */
test('step 97 (review): the creep timer picks an offer only when a step is possible — not at the maximum, not in the pause, not in shadow mode', async () => {
  const clock = new VirtualClock(new Date(Date.now() - 6 * 3_600_000).toISOString());
  const pools = { appPool: db.pool('svc_app', 2), adminPool: db.pool('svc_admin', 1), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 1) };
  const params = { faults: { writeTimeoutShare: 0, timeoutAppliedShare: 0, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, applyDelayMs: 0 };
  const worldOf = async (tag: number, id: number, writeMode: 'LIVE' | 'SHADOW', over: Partial<LiveProduct>) => {
    const w = await kauflandLiveWorld({ tag, clock, seed: tag, writeMode, buyBox: LANDED_CHANNEL_BONUS, params, ...pools,
      products: [{ ...product, idProduct: id, behaviour: { kind: 'STATIC' }, ...over }] });
    const c = (): AdapterCallContext => ({ tenantId: w.world.tenantId as never, channelAccountId: w.world.channelAccountId as never, correlationId: 'step97-review', deadline: w.clock.iso(60_000) as never });
    return {
      snap: async () => {
        w.simulator.advanceTo(w.clock.nowMs());
        for (const s of (await w.adapter.readCompetitors(c(), [{ marketplace: 'de', channelProductRef: String(id), condition: 'new' }])).snapshots) await w.pipeline.processSnapshot(c(), s);
        await w.betweenTicks();
      },
      timer: async () => { w.simulator.advanceTo(w.clock.nowMs()); const r = await w.pipeline.recomputeScheduled(c(), { limit: 10 }); await w.betweenTicks(); return r.scopes; },
      ours: () => w.simulator.market('de', id).offers.find((o) => o.self)!.priceMinor,
    };
  };
  const minutes = (m: number) => clock.advance(m * 60_000);

  // У максимума: взятие 17,49 и есть максимум — следующая оценка «на максимуме», и таймер её не повторяет
  const atMax = await worldOf(3971, 397_100_002, 'LIVE', { maxPriceMinor: 1749 });
  await atMax.snap();
  assert.equal(atMax.ours(), 1749);
  minutes(5); await atMax.snap();
  minutes(15); assert.equal(await atMax.timer(), 0, 'at the maximum the timer does not pick the offer again');

  // Пауза: ступень → потеря → шаг назад → Buy Box снова наш; внутри паузы таймер молчит
  const pause = await worldOf(3972, 397_100_003, 'LIVE', {});
  await pause.snap();                                   // взятие 17,49
  minutes(5); await pause.snap();                       // темп от взятия
  minutes(10); await pause.snap();                      // ступень 17,66 — Buy Box уходит (17,66 > 18,00 − 0,50)
  assert.equal(pause.ours(), 1766);
  minutes(5); await pause.snap();                       // шаг назад
  assert.equal(pause.ours(), 1749, 'stepped back');
  minutes(5); await pause.snap();                       // Buy Box снова наш — пауза
  minutes(15); assert.equal(await pause.timer(), 0, 'inside the pause the timer does not pick the offer');

  // Тень: Buy Box наш с начала (конкурент дороже), предложение подъёма удержано и повторялось бы таймером без пользы
  const shadow = await worldOf(3973, 397_100_004, 'SHADOW', { competitorChannelFulfilled: false, competitorStartMinor: 1900 });
  await shadow.snap();
  minutes(15); assert.equal(await shadow.timer(), 0, 'in shadow mode the creep timer stays silent');

  // Решение владельца после шага 97.1 — тихий рынок: снимка 25 минут не было, Buy Box наш — ступень вверх по снимку до двух периодов
  const quiet = await worldOf(3975, 397_100_006, 'LIVE', { competitorChannelFulfilled: false, competitorStartMinor: 1950 });
  await quiet.snap();                                   // Buy Box наш с начала: ступень 18,50 → 18,68
  assert.equal(quiet.ours(), 1868);
  minutes(25); assert.equal(await quiet.timer(), 1, 'a quiet market: the timer picks the offer on a reading 25 minutes old');
  assert.equal(quiet.ours(), 1886, 'and steps up');
  minutes(40); assert.equal(await quiet.timer(), 0, 'a reading older than two periods: no step');

  // Положительный контроль: свежий снимок, Buy Box наш, ступень возможна — таймер берёт единицу и делает ступень
  const ok = await worldOf(3974, 397_100_005, 'LIVE', { competitorChannelFulfilled: false, competitorStartMinor: 1900 });
  await ok.snap();                                      // Buy Box наш с начала: ступень 18,50 → 18,68
  minutes(15); assert.equal(await ok.timer(), 1, 'a possible step: the timer picks the offer');
  assert.equal(ok.ours(), 1886, 'and steps up');
});
