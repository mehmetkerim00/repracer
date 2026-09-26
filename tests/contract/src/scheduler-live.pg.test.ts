import strictAssert from 'node:assert/strict';
import { after, before, test } from 'node:test';

/**
 * OQ-204 (шаг 33): мета-проверка «каждая работа проверена» считала ЗАРЕГИСТРИРОВАННОЕ ИМЯ, а не выполненное утверждение:
 * пустой блок `observes(...)` проходил её так же, как проверяющий. Теперь считаются настоящие вызовы утверждений.
 */
let currentJob: string | null = null;
const assertionsOf = new Map<string, number>();
const digestMail = new FakeMail();
let shadowDigest: ReturnType<typeof createShadowDigest>;
const assert: typeof strictAssert = new Proxy(strictAssert, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver) as unknown;
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (currentJob !== null) assertionsOf.set(currentJob, (assertionsOf.get(currentJob) ?? 0) + 1);
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as typeof strictAssert;

import { createPool, PgAlertDeliveryStore, PgAlertSink, type PgPool } from '@repracer/pricing-store-pg';
import { createAlertDelivery } from '@repracer/alert-delivery';
import { createShadowDigest } from '@repracer/alert-delivery/shadow-digest';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { PgShadowDigestStore } from '@repracer/pricing-store-pg';
import { createScheduler, JOB_CATALOG, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { createIsolatedDatabase, requireEnv } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { amazonLiveWorld, type AmazonLiveWorld } from './live/amazon-world.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct, type ProductClass } from './live/kaufland-world.ts';

/**
 * Р-128 (шаг 26): периодические работы — в живом режиме, а не вызовом функции. Процесс планировщика (runScheduler, такт 30 с) работает
 * сутки виртуального времени на настоящей PostgreSQL (отдельная база): два аккаунта Kaufland поверх симулятора канала (без уведомлений
 * и с уведомлениями, которые теряются) и аккаунт Amazon поверх модели порта. Между тактами — приёмник уведомлений и диспетчер записей.
 * Утверждается наблюдаемое за сутки: запросы, дошедшие до канала, строки базы и события — а не вызовы функций.
 * Нужны REPRACER_PG_URL, REPRACER_PG_ADMIN_URL [Р-84]. Данные синтетические.
 */
const db = await createIsolatedDatabase('repracer_live');
const observerUrl = new URL(requireEnv('REPRACER_PG_ADMIN_URL'));
observerUrl.pathname = `/${db.name}`;
// Наблюдатель — суперпользователь стенда в отдельной базе: только чтение для утверждений теста
const observer: PgPool = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-live-observer' });
after(async () => { await observer.end(); await db.drop(); });

const HOUR = 3_600_000;
const TICK_MS = 30_000;
const walk = (everyMinutes: number, minMinor = 1400, maxMinor = 2400) => ({ kind: 'RANDOM_WALK' as const, everyMs: everyMinutes * 60_000, volatilityBp: 300, minMinor, maxMinor });
const scheduleAt = (hours: number[], price: (k: number) => number, shiftMinutes = 0) => ({ kind: 'SCHEDULE' as const, points: hours.map((h, k) => ({ atOffsetMs: h * HOUR + shiftMinutes * 60_000, priceMinor: price(k) })) });

const kaufland1: LiveProduct[] = [
  ...[1, 2, 3].map((i) => ({ cls: 'HOT' as const, idProduct: 362260100 + i, marketplace: 'de', behaviour: walk(5), pastMovesEveryMinutes: 10 })),
  // Тёплые — с движком цены: записи уходят в канал, история цен закрывается в сутки [Р-21]
  // Р-131 (шаг 27): движок без объявленной себестоимости база не включает — у тёплых товаров она объявлена
  ...[1, 2, 3].map((i) => ({ cls: 'WARM' as const, idProduct: 362260200 + i, marketplace: 'de', pastMovesEveryMinutes: 8 * 60, pricingMode: 'ENGINE' as const, costMinor: 1000,
    behaviour: scheduleAt([2, 10, 18], (k) => 1800 + (k + 1) * 10 * i, i) })),
  ...[1, 2, 3].map((i) => ({ cls: 'STATIC' as const, idProduct: 362260300 + i, marketplace: 'de', behaviour: { kind: 'STATIC' as const }, pastMovesEveryMinutes: 24 * 60, pastMoveBp: 10_000,
    // Продавец включил Smart Pricing в кабинете у одного товара [Р-12, Р-41]
    ...(i === 3 ? { channelMinimumPriceMinor: 1500 } : {}) })),
  ...[1, 2].map((i) => ({ cls: 'NEW_VOLATILE' as const, idProduct: 362260400 + i, marketplace: 'de', behaviour: walk(5), pastMovesEveryMinutes: null, costMinor: 1000 })),
  { cls: 'NEW_STATIC' as const, idProduct: 362260501, marketplace: 'de', behaviour: { kind: 'STATIC' as const }, pastMovesEveryMinutes: null, costMinor: 1000 },
  // Без себестоимости, EAN на другом канале и истории: якоря проверки входов нет (OQ-88)
  { cls: 'NEW_NO_ANCHOR' as const, idProduct: 362260601, marketplace: 'de', behaviour: walk(5), pastMovesEveryMinutes: null },
  // Наше предложение дешевле конкурента — Buy Box у нас; конкурент меняет цену выше нашей
  { cls: 'NEW_SELF_WINS' as const, idProduct: 362260701, marketplace: 'de', behaviour: walk(5, 1950, 2600), competitorStartMinor: 2200, pastMovesEveryMinutes: null, costMinor: 1000 },
  // Витрина at: одновременный сдвиг всех цен ×1,25 через 6 часов — массовый сдвиг, остановка витрины и снятие выборкой [Р-42, Р-50, Р-52]
  ...Array.from({ length: 12 }, (_, i) => ({ cls: 'SHIFT' as const, idProduct: 362260800 + i, marketplace: 'at', pastMovesEveryMinutes: 10,
    behaviour: scheduleAt([6], () => 2250) })),
];
const CLASSES = ['HOT', 'WARM', 'STATIC', 'NEW_VOLATILE', 'NEW_STATIC', 'NEW_NO_ANCHOR', 'NEW_SELF_WINS', 'SHIFT'] as const;
const kaufland2: LiveProduct[] = [1, 2, 3, 4].map((i) => ({ cls: 'HOT' as const, idProduct: 362261100 + i, marketplace: 'de', behaviour: walk(20), pastMovesEveryMinutes: 20 }));

interface Live {
  startMs: number; endMs: number; seconds: number; k1: KauflandLiveWorld; k2: KauflandLiveWorld; a1: AmazonLiveWorld;
  alerts: Array<{ code: string; severity: string; details: Record<string, unknown>; atMs: number }>;
  jobs: Array<{ job_name: string; runs: number; failed: number; items: number; max_lag: number }>;
  seededMovesBefore: number;
  polls(w: KauflandLiveWorld, cls: ProductClass): number[];
}
let live: Live;
/** Письма, перехваченные во время суток работы планировщика [Р-156] */
let mail: FakeMail;

before(async () => {
  /**
   * Виртуальные сутки заканчиваются раньше «сейчас»: часы базы (now() в значениях по умолчанию и проверках) всегда позже
   * виртуальных, иначе строки с моментом из будущего отклоняют проверки вроде pricing_halt_sample (observed_at <= recorded_at
   * + 5 минут).
   *
   * Отступ в два часа — из-за закрытия суток: база даёт час после полуночи витрины (`p_now < day_end + interval '1 hour'`), и
   * прогон, заканчивавшийся «сейчас», в интервале с 00:00 до 01:00 по Берлину не закрывал ни одних суток. Тест краснел час в
   * сутки — каждую ночь в CI (шаг 29).
   */
  const hours = Number(process.env.LIVE_HOURS ?? 24);
  /**
   * Окно суток заканчивается в 02:00 по Берлину — ближайшие прошедшие. Тогда прошлые местные сутки всегда уже закрываемы:
   * закрытию база даёт час после полуночи витрины, а 02:00 > 01:00. Раньше окно висело относительно «сейчас», и тест краснел
   * ночью — в CI (UTC) это каждый прогон после полуночи по Берлину (шаг 29). Длина окна прежняя: числа опросов от неё зависят.
   */
  const berlinHour = (ms: number) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false }).format(new Date(ms)));
  let endMs = Math.floor(Date.now() / HOUR) * HOUR;
  while (berlinHour(endMs) !== 2) endMs -= HOUR;
  const startMs = endMs - hours * HOUR;
  const clock = new VirtualClock(new Date(startMs).toISOString());
  const pools = { appPool: db.pool('svc_app', 4), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2) };
  // Шаг 35: у первого аккаунта Kaufland — остаток и спрос модели: работа `order-lines` ведёт резервации и записи остатка
  const k1 = await kauflandLiveWorld({ tag: 2601, clock, products: kaufland1, seed: 2601, ...pools, stock: { onHand: 30, bufferUnits: 1, stockPool: db.pool('svc_stock', 2) }, demand: { orderEveryMs: 20 * 60_000, shipAfterMs: 2 * 3_600_000, cancelShare: 0.2 } });
  const k2 = await kauflandLiveWorld({ tag: 2602, clock, products: kaufland2, seed: 2602, buyBoxChanged: { lossShare: 0.3, debounceMs: 60_000 }, ...pools });
  const a1 = await amazonLiveWorld({ tag: 2603, clock, offers: 40, seed: 2603, lossShare: 0.3, priceChangeEveryHours: 2, ...pools });
  const byAccount = new Map<string, { pipelineForDbIds(): ReturnType<KauflandLiveWorld['pipelineForDbIds']> }>([
    [k1.seeded.ids.dbId(k1.world.channelAccountId), k1], [k2.seeded.ids.dbId(k2.world.channelAccountId), k2],
    [a1.seeded.ids.dbId(`20000000-0000-4000-8000-000000002603`), a1],
  ]);
  const seededMovesBefore = Number((await observer.query(`SELECT count(*) AS n FROM channel_data.competitor_move WHERE evaluated_at < $1::timestamptz - interval '24 hours'`, [clock.iso()])).rows[0].n);
  const schedulerPool = db.pool('svc_scheduler', 3);
  const base = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 2), ingest: null as never, verifier: null as never,
    descriptorOf: (channel) => (channel === 'KAUFLAND' ? k1.adapter.descriptor : channel === 'AMAZON' ? a1.port.descriptor : null),
    pipelineFor: (a) => byAccount.get(a.channelAccountId)!.pipelineForDbIds(),
    // Р-121: сверка уведомлений — у аккаунта с доступом к уведомлениям (Kaufland 2602 — ранний доступ выдан) и у Amazon
    reconcileEnabled: (a) => a.channelAccountId !== k1.seeded.ids.dbId(k1.world.channelAccountId),
  });
  // Выгрузка в ClickHouse проверяется в CI (history-survives-stop): здесь ClickHouse нет — работа сообщает о провале и не держит слот
  const deps: JobDeps = {
    ...base, exportDay: async () => { throw new Error('CLICKHOUSE_NOT_IN_THIS_TEST'); },
    // Остатки есть только у k1; у остальных аккаунтов работа идёт и честно ничего не находит
    stock: { syncOrders: async (a, ctx, since) => (a.channelAccountId === k1.seeded.ids.dbId(k1.world.channelAccountId)
      ? k1.syncOrdersForDbIds(ctx, since)
      : { lines: 0, created: 0, consumed: 0, released: 0, unknownOffers: 0, writes: 0 }) },
  };
  const alerts: Live['alerts'] = [];
  /**
   * Шаг 36 [Р-156]: доставка алертов — работа планировщика, а не вызов из теста. Алерты пишутся в базу тем же
   * хранилищем, что в процессе, письма перехватывает модель провайдера, и о самой работе есть утверждение ниже.
   */
  mail = new FakeMail();
  const alertSink = new PgAlertSink(pools.appPool);
  const delivery = createAlertDelivery({
    store: new PgAlertDeliveryStore(db.pool('svc_alert_delivery', 2)), mail,
    /**
     * Часы доставки — НАСТОЯЩИЕ, а не виртуальные часы мира: время события ставит база (`raised_at := now()`), и
     * сравнивать его с виртуальными часами, которые идут в прошлом, значит не увидеть ни одного события. В процессе
     * обе стороны настоящие; расхождение живёт только в прогонах на виртуальных часах.
     */
    now: () => new Date().toISOString(),
    locale: 'de', operatorEmail: 'betrieb@example.invalid', digestSeconds: 3600,
  });
  deps.alertDelivery = delivery;
  /**
   * Шаг 41 [Р-171]: недельный дайджест тени — работа каталога, и появляется она вместе со своей зависимостью. В этом мире
   * ОБА аккаунта боевые, поэтому наблюдаемое поведение здесь отрицательное: писать некому. Положительное (письмо с
   * числами) утверждает свой прогон — apps/console/test/shadow-live.pg.test.ts.
   */
  shadowDigest = createShadowDigest({
    store: new PgShadowDigestStore(db.pool('svc_alert_delivery', 1)), mail: digestMail,
    now: () => new Date().toISOString(), log: () => undefined,
  });
  deps.shadowDigest = shadowDigest;
  const scheduler = createScheduler({ state: new PgSchedulerState(schedulerPool), source: jobSource(deps), owner: 'live-1', now: () => clock.iso(),
    alerts: { raise: async (a) => {
      alerts.push({ ...(a as unknown as Live["alerts"][number]), atMs: clock.nowMs() });
      // Алерт идёт И в журнал прогона, И в базу — как в процессе планировщика
      await alertSink.raise(a as never);
    } } });
  // Конец окна задан якорем выше; виртуальные часы идут от startMs до endMs
  const started = Date.now();
  const sleeps: number[] = [];
  const running = runScheduler(scheduler, {
    tickMs: TICK_MS, clockMs: () => clock.nowMs(), logger: { log: () => {} },
    sleep: async (ms) => { if (process.env.LIVE_DEBUG) sleeps.push(ms); clock.advance(ms); for (const w of [k1, k2, a1]) await w.betweenTicks(); },
    shouldStop: () => clock.nowMs() > endMs,
  });
  await running.finished;
  if (process.env.LIVE_DEBUG) {
    const bag: Record<number, number> = {};
    for (const x of sleeps) bag[x] = (bag[x] ?? 0) + 1;
    console.log(JSON.stringify({ ticks: sleeps.length, sleeps: bag, due: (await observer.query(`SELECT job_name, last_outcome, last_error FROM maintenance.scheduled_job WHERE last_error IS NOT NULL LIMIT 5`)).rows }));
  }
  const { rows: jobs } = await observer.query(
    `SELECT job_name, count(*)::int AS runs, count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed, coalesce(sum(items), 0)::int AS items, max(lag_seconds)::int AS max_lag
       FROM maintenance.scheduled_job_run GROUP BY 1 ORDER BY 1`);
  const polls = (w: KauflandLiveWorld, cls: ProductClass) => w.products.filter((p) => p.cls === cls).map((p) => (w.buyboxCalls.get(p.idProduct) ?? []).length);
  live = { startMs, endMs, seconds: Math.round((Date.now() - started) / 1000), k1, k2, a1, alerts, jobs, seededMovesBefore, polls };
  // Наблюдаемые числа суток — в доказательство шага (docs/evidence/step26-live-mode.md)
  console.log(JSON.stringify({
    seconds: live.seconds, jobs,
    k1polls: Object.fromEntries(CLASSES.map((c) => [c, polls(k1, c)])), k2polls: polls(k2, 'HOT'),
    k1requests: Object.fromEntries(k1.requests), k2notifications: k2.simulator.stats.notificationsScheduled, k2lost: k2.simulator.stats.notificationsLost,
    amazon: { summaryCalls: a1.port.stats.summaryCalls, rateLimited: a1.port.stats.summaryRateLimited, lost: a1.port.stats.eventsLost, comparedPerAsin: a1.asins.map((x) => (a1.comparedAt.get(x) ?? []).length) },
    halts: k1.events.filter((e) => /HALT/.test(e.code)).map((e) => ({ code: e.code, h: Math.round((e.atMs - startMs) / 36_000) / 100 })),
    alerts: [...new Set(alerts.map((a) => `${a.code}:${a.severity}`))],
  }));
});

/** Каждая работа планировщика утверждается в живом режиме: новая работа без утверждения — красная сборка (Р-128) */
const observes = (job: string, name: string, body: () => Promise<void> | void) => {
  test(`${job} — ${name}`, async () => {
    currentJob = job;
    try { await body(); } finally { currentJob = null; }
  });
};

const hoursOf = (ms: number) => Math.round(((ms - live.startMs) / HOUR) * 100) / 100;
/**
 * OQ-204 (шаг 33): заглушка `{runs: 0, failed: 0}` делала утверждение «провалов не было» ИСТИННЫМ для работы, которая за
 * сутки ни разу не запускалась, — то есть ровно для того случая, ради которого живой прогон и заведён. Теперь отсутствие
 * работы в журнале запусков — это провал с названным именем, а не молчаливый ноль.
 */
const jobOf = (name: string) => {
  const row = live.jobs.find((j) => j.job_name === name);
  strictAssert.ok(row, `работа ${name} за сутки не запускалась ни разу: в журнале запусков её нет`);
  return row;
};

observes('competitor-poll', 'Р-47: ярус товара виден в числе опросов за сутки; товар без движения цены не выпадает', () => {
  const gaps = (idProduct: number) => {
    const at = [live.startMs, ...(live.k1.buyboxCalls.get(idProduct) ?? []), live.endMs];
    return Math.max(...at.slice(1).map((t, i) => t - at[i]!)) / HOUR;
  };
  // Горячий ярус — 120 с: 720 слотов такта за сутки плюс первый опрос
  assert.deepEqual(live.polls(live.k1, 'HOT'), [721, 721, 721], 'горячие товары опрошены каждые 2 минуты');
  assert.deepEqual(live.polls(live.k1, 'WARM'), [25, 25, 25], 'тёплые — раз в час');
  assert.deepEqual(live.polls(live.k1, 'STATIC'), [2, 2, 2], 'холодные — раз в сутки');
  // Товар без движения цены опрашивается, но не чаще холодного яруса: разрыв не больше суток
  for (const p of kaufland1.filter((x) => x.cls === 'STATIC')) assert.ok(gaps(p.idProduct) <= 24 + 1 / 60, `товар без движения цены выпал из опроса: разрыв ${gaps(p.idProduct)} ч`);
  // Новый товар без истории: проба не реже тёплого яруса, волатильный поднимается в горячий ярус за сутки
  assert.deepEqual(live.polls(live.k1, 'NEW_STATIC'), [25], 'новый товар без движений — проба раз в час, пока волатильность неизвестна');
  for (const n of live.polls(live.k1, 'NEW_VOLATILE')) assert.ok(n > 400, `новый волатильный товар остался в пробе: ${n} опросов`);
  // Наш Buy Box: движения считаются по ценам конкурентов, а не по нашей цене
  for (const n of live.polls(live.k1, 'NEW_SELF_WINS')) assert.ok(n > 400, `товар, где Buy Box держим мы, остался холодным: ${n} опросов`);
  assert.ok(jobOf('competitor-poll').failed === 0 && jobOf('competitor-poll').runs > 2800, JSON.stringify(jobOf('competitor-poll')));
});

observes('notification-loss-review', 'Р-121: потерянные уведомления получают вердикт до конца суток', async () => {
  const { rows: [r] } = await observer.query(
    `SELECT count(*) FILTER (WHERE v.verdict = 'LOSS_SUSPECTED')::int AS suspected, count(*) FILTER (WHERE v.verdict = 'DELAYED')::int AS delayed,
            count(*) FILTER (WHERE v.notification_loss_check_id IS NULL AND c.due_at < $1::timestamptz)::int AS overdue
       FROM channel_data.notification_loss_check c LEFT JOIN channel_data.notification_loss_verdict v USING (tenant_id, notification_loss_check_id)`,
    [new Date(live.endMs - 15 * 60_000).toISOString()]);
  assert.ok(live.k2.simulator.stats.notificationsLost > 0, 'модель канала потеряла уведомления');
  assert.ok(r.suspected > 0 && r.delayed > 0, `вердикты потерь и задержек: ${JSON.stringify(r)}`);
  assert.equal(r.overdue, 0, 'проверок с истёкшим сроком без вердикта не осталось');
  assert.equal(jobOf('notification-loss-review').failed, 0);
});

observes('amazon-reconcile-rotation', 'Р-121, A-15: круг сверки обходит все офферы, ограничитель канала не отклоняет вызовы', () => {
  const compared = live.a1.asins.map((a) => (live.a1.comparedAt.get(a) ?? []).length);
  assert.equal(live.a1.port.stats.summaryRateLimited, 0, 'вызовы getCompetitiveSummary не отклонены ограничителем 0.033 rps');
  assert.ok(Math.min(...compared) > 1000, `каждый оффер сверен за сутки: минимум ${Math.min(...compared)}`);
  const calls = [...live.a1.summaryCalls.values()].flat().sort((a, b) => a - b);
  const closest = Math.min(...calls.slice(1).map((t, i) => t - calls[i]!).filter((d) => d > 0));
  assert.ok(closest >= 31_000, `два вызова подряд ближе лимита: ${closest} мс`);
});

observes('halt-review', 'Р-42, Р-52: массовый сдвиг останавливает витрину, выборка снимает остановку', () => {
  const at = (code: string) => live.k1.events.find((e) => e.code === code);
  const halted = at('INPUT_SANITY_HALT_CHANNEL');
  const released = at('HALT_AUTO_RELEASED');
  assert.ok(halted && hoursOf(halted.atMs) >= 6 && hoursOf(halted.atMs) <= 6.1, `витрина остановлена сразу после сдвига: ${halted && hoursOf(halted.atMs)} ч`);
  assert.ok(released && hoursOf(released.atMs) - hoursOf(halted!.atMs) <= 0.6, `остановка снята выборкой после окна: ${released && hoursOf(released.atMs)} ч`);
  assert.equal(jobOf('halt-review').failed, 0);
});

observes('order-lines', 'Р-25, Р-152 (шаг 35): заказы канала становятся резервациями, отгрузка списывает пул, доступный остаток уходит в канал записью', async () => {
  const job = jobOf('order-lines');
  // Интервал 5 минут; такты с другими работами сдвигают запуски — не реже раза в 10 минут у каждого из трёх аккаунтов
  assert.ok(job.runs >= 3 * 24 * 6, `работа шла у каждого из трёх аккаунтов не реже раза в десять минут: ${job.runs}`);
  const failures = (await observer.query(`SELECT error_code, count(*)::int AS n FROM maintenance.scheduled_job_run WHERE job_name = 'order-lines' AND outcome = 'FAILED' GROUP BY 1`)).rows;
  assert.equal(job.failed, 0, `ни одного провала: чтение заказов у симулятора не падает: ${JSON.stringify(failures)}`);
  const stats = live.k1.simulator.stats;
  assert.ok(stats.ordersPlaced >= 60 && stats.ordersShipped >= 40, `спрос модели: заказов ${stats.ordersPlaced}, отгружено ${stats.ordersShipped}, отменено ${stats.ordersCancelled}`);
  const [r] = (await observer.query(
    `SELECT count(*)::int AS reservations, count(*) FILTER (WHERE status = 'CONSUMED')::int AS consumed, count(*) FILTER (WHERE status = 'RELEASED')::int AS released
       FROM channel_data.reservation WHERE tenant_id = $1`, [live.k1.seeded.tenantId])).rows;
  // Каждый заказ модели — резервация; отгруженные списаны, отменённые освобождены (границы окна: последние могут ещё не закрыться)
  assert.equal(Number(r.reservations), stats.ordersPlaced, 'резервация на каждую строку заказа канала');
  assert.ok(Number(r.consumed) >= stats.ordersShipped - 3 && Number(r.released) >= stats.ordersCancelled - 3, `списано ${r.consumed} из ${stats.ordersShipped}, освобождено ${r.released} из ${stats.ordersCancelled}`);
  const [m] = (await observer.query(`SELECT count(*)::int AS n, coalesce(-sum(delta), 0)::int AS shipped FROM tenant_data.stock_movement WHERE tenant_id = $1 AND reason = 'ORDER_SHIPPED'`, [live.k1.seeded.tenantId])).rows;
  assert.equal(Number(m.shipped), Number(r.consumed), 'каждая отгрузка списала ровно одну единицу пула движением базы');
  // Уменьшение доступного дошло до канала: записи остатка применены, и у единицы в симуляторе — наш остаток минус буфер
  const [w] = (await observer.query(`SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND field = 'QUANTITY' AND final_status = 'APPLIED'`, [live.k1.seeded.tenantId])).rows;
  assert.ok(Number(w.n) > stats.ordersPlaced / 2, `записей остатка, применённых каналом: ${w.n} при ${stats.ordersPlaced} заказах`);
});

observes('offer-discovery', 'Р-120, Р-12: обход офферов раз в сутки находит Smart Pricing продавца', () => {
  assert.equal(jobOf('offer-discovery').runs, 6, 'по два обхода на каждый из трёх аккаунтов за сутки');
  assert.ok(live.k1.events.some((e) => e.code === 'KAUFLAND_SMART_PRICING_ACTIVE'), 'оффер с minimum_price в кабинете канала найден обходом');
});

observes('price-days-close', 'Р-21: сутки цен закрываются в свёртку', async () => {
  const { rows } = await observer.query(
    `SELECT count(*)::int AS days, coalesce(sum(change_count), 0)::int AS changes FROM tenant_data.price_daily WHERE price_day < $1::date`, [new Date(live.endMs).toISOString().slice(0, 10)]);
  assert.ok(rows[0].days > 0 && rows[0].changes > 0, `суточная свёртка цен закрыта: ${JSON.stringify(rows[0])}`);
  assert.equal(jobOf('price-days-close').failed, 0);
});

observes('partitions', 'секции созданы на трое суток вперёд от конца суток работы', async () => {
  const day = new Date(live.endMs + 3 * 86_400_000).toISOString().slice(0, 10).replaceAll('-', '');
  const { rows } = await observer.query(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'channel_data.competitor_snapshot_log'::regclass AND c.relname LIKE $1`, [`%${day}`]);
  assert.equal(rows.length, 1, `секция журнала снимков на ${day} создана работой: ${rows.length}`);
});

observes('retention', 'удаление по сроку убирает движения конкурентов старше двух суток', async () => {
  const { rows: [r] } = await observer.query(
    `SELECT count(*)::int AS n FROM channel_data.competitor_move WHERE evaluated_at < $1::timestamptz - interval '2 days'`, [new Date(live.endMs).toISOString()]);
  assert.ok(live.seededMovesBefore > 0, 'до суток работы движения старше срока были');
  assert.equal(r.n, 0, 'движения старше срока удалены');
  assert.ok(jobOf('retention').items > 0);
});

observes('analytics-export-day', 'провал выгрузки сообщается и не держит слот работы', () => {
  assert.ok(live.alerts.some((a) => a.code === 'ANALYTICS_EXPORT_FAILED' && a.severity === 'CRITICAL'), 'провал выгрузки — CRITICAL');
  const job = jobOf('analytics-export-day');
  assert.ok(job.runs >= 1 && job.failed === 0, `слот выгрузки продвигается при провале суток: ${JSON.stringify(job)}`);
});

observes('alerts-deliver', 'Р-156 (шаг 36): алерты суток доставлены письмами, и недоставленных не осталось', async () => {
  const job = jobOf('alerts-deliver');
  assert.ok(job.runs > 0, `работа доставки запускалась: ${JSON.stringify(job)}`);
  assert.equal(job.failed, 0, 'ни один заход доставки не провалился');
  const [a] = (await observer.query(
    `SELECT count(*)::int AS raised, count(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
            count(*) FILTER (WHERE severity = 'CRITICAL' AND delivery_kind <> 'EMAIL_IMMEDIATE')::int AS wrong_kind
       FROM tenant_data.alert`)).rows;
  assert.ok(Number(a.raised) > 0, 'за сутки работы поднялся хотя бы один алерт — иначе доставлять нечего');
  assert.equal(Number(a.wrong_kind), 0, 'CRITICAL доставляется письмом немедленно, а не дайджестом');
  // Письма — настоящие по содержанию: у каждого есть получатель, тема и тело, и их столько же, сколько отмеченных доставок
  assert.ok(mail.sent.length > 0, `писем за сутки: ${mail.sent.length}`);
  assert.ok(mail.sent.every((x) => x.to.includes('@') && x.subject.includes('repracer') && x.text.length > 40),
    `каждое письмо названо и не пусто: ${JSON.stringify(mail.sent[0])}`);
  console.log(JSON.stringify({ alerts: a, letters: mail.sent.length, subjects: [...new Set(mail.sent.map((x) => x.subject.slice(0, 60)))].slice(0, 5) }));
});

observes('shadow-digest', 'Р-171 (шаг 41): в мире без теневых аккаунтов дайджест не пишет никому, и работа не проваливается', async () => {
  const job = jobOf('shadow-digest');
  assert.ok(job.runs > 0, `работа дайджеста запускалась: ${JSON.stringify(job)}`);
  assert.equal(job.failed, 0, 'ни один заход дайджеста не провалился');
  // Оба аккаунта мира боевые — целей у дайджеста нет, и это ВИДНО числом, а не отсутствием письма
  const [m] = (await observer.query(`SELECT count(*)::int AS shadowed FROM tenant_data.channel_account WHERE write_mode = 'SHADOW'`)).rows;
  assert.equal(Number(m.shadowed), 0, 'в мире прогона нет теневых аккаунтов');
  const outcome = await shadowDigest.send();
  assert.deepEqual(outcome, { letters: 0, quiet: 0, noRecipient: 0, failed: 0 }, `дайджест в боевом мире: ${JSON.stringify(outcome)}`);
  assert.equal(digestMail.sent.length, 0, 'писем дайджеста не было: писать некому');
  console.log(JSON.stringify({ shadowDigest: { runs: job.runs, failed: job.failed, letters: digestMail.sent.length } }));
});

test('Р-128: о каждой работе планировщика ВЫПОЛНЯЕТСЯ хотя бы одно утверждение', () => {
  /**
   * Источник правды — сам каталог работ, а не список внутри проверки. Чего проверка НЕ делает (находка 5 ревью шага 33):
   * счётчик считает ВЫЗОВ утверждения, а не исход, поэтому тавтологию она не отличит от настоящей проверки. Она
   * закрывает ровно одну дыру — блок без единого утверждения.
   */
  const silent = JOB_CATALOG.map((j) => j.name).filter((n) => (assertionsOf.get(n) ?? 0) === 0);
  assert.deepEqual(silent, [], 'работа названа, но ни одного утверждения о её наблюдаемом поведении не выполнилось [OQ-204]');
});
