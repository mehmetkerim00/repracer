import strictAssert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

/**
 * OQ-204 (шаг 33): мета-проверка «у каждого механизма есть утверждение» считала ЗАРЕГИСТРИРОВАННОЕ ИМЯ, а не выполненное
 * утверждение: пустой блок `observes(...)` проходил её так же, как проверяющий. Теперь считаются настоящие вызовы
 * утверждений внутри блока — механизм, который ничего не проверил, называется поимённо.
 */
let currentMechanism: string | null = null;
const assertionsOf = new Map<string, number>();
const assert: typeof strictAssert = new Proxy(strictAssert, {
  get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver) as unknown;
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (currentMechanism !== null) assertionsOf.set(currentMechanism, (assertionsOf.get(currentMechanism) ?? 0) + 1);
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
}) as typeof strictAssert;

import { ClickHouseHttp } from '@repracer/analytics-export';
import { OutboxRelay, TOPICS, type KeyedMessage } from '@repracer/broker';
import { createNotificationReceiver, createSqsClient, pipelineSink, storeLedger, type NotificationReceiver } from '@repracer/amazon-notifications';
import { FakeSqs } from '@repracer/amazon-notifications/testing';
import { createPool, inTenant, PgPricingStore, type PgPool } from '@repracer/pricing-store-pg';
import { createScheduler, jobSource, PgSchedulerState, pgJobDeps, runScheduler, type JobDeps } from '@repracer/scheduler';
import { createIsolatedDatabase, requireEnv } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { amazonLiveWorld, type AmazonLiveWorld } from './live/amazon-world.ts';
import { startFakeClickHouse, type FakeClickHouse } from './live/fake-clickhouse.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct } from './live/kaufland-world.ts';

/**
 * Р-130 (шаг 27): живым прогоном проверяются все фоновые механизмы, а не только периодические работы: диспетчер записей [Р-64],
 * ретранслятор outbox [Р-34], путь решения за брокером, приёмник уведомлений Amazon [шаг 23], выгрузка в ClickHouse [Р-122] и удаление
 * по сроку. Процессы работают вместе на настоящей PostgreSQL (отдельная база) с моделями канала, очереди SQS, брокера и ClickHouse;
 * время виртуальное. Утверждается наблюдаемое за период: строки базы, запросы к каналу, сообщения очередей. Данные синтетические.
 */
const db = await createIsolatedDatabase('repracer_bg');
const observerUrl = (() => {
  const u = new URL(requireEnv('REPRACER_PG_ADMIN_URL'));
  u.pathname = `/${db.name}`;
  return u.toString();
})();
const observer: PgPool = createPool(observerUrl, { max: 1, applicationName: 'repracer-bg-observer' });

const HOUR = 3_600_000;
const QUEUE_URL = 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-live';
const TICK_MS = 15_000;
const walk = (everyMinutes: number) => ({ kind: 'RANDOM_WALK' as const, everyMs: everyMinutes * 60_000, volatilityBp: 400, minMinor: 1500, maxMinor: 2300 });

/** Товары с включённым движком: каждое изменение цены конкурента рождает запись в канал */
/**
 * Товары с включённым движком: цена конкурента меняется каждые две минуты, а канал подтверждает применение только через пять минут
 * (K-15) — значит вторая цена приходит, пока первая запись в полёте: она остаётся ждущей, её объявляет событие `scope.write.v1`,
 * и отправляет её процесс за брокером [Р-64, Р-34]. Именно этот путь и проверяется живым прогоном
 */
const products: LiveProduct[] = [1, 2, 3].map((i) => ({
  cls: 'HOT' as const, idProduct: 362270100 + i, marketplace: 'de', behaviour: walk(1), pastMovesEveryMinutes: 10,
  pricingMode: 'ENGINE' as const, costMinor: 900,
}));

let fakeClickHouse: FakeClickHouse | null = null;

interface Background {
  startMs: number;
  endMs: number;
  seconds: number;
  k: KauflandLiveWorld;
  a: AmazonLiveWorld;
  ch: FakeClickHouse;
  published: KeyedMessage[];
  sqs: FakeSqs;
  receiver: NotificationReceiver;
  notificationsSent: number;
  alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }>;
  relayGaps: number;
  ticks: number;
  oldPartition: string;
  oldSnapshots: number;
  exportedPartition: string;
  exportedSnapshots: number;
}
let bg: Background;

after(async () => {
  await observer.end();
  await fakeClickHouse?.close();
  await db.drop();
});

before(async () => {
  const ch = await startFakeClickHouse();
  fakeClickHouse = ch;
  // Прогон кончается «сейчас» и захватывает границу суток UTC: выгрузка суток идёт в 00:30
  /**
   * Окно трёх виртуальных часов не пересекает полночь UTC: секции журнала снимков — по суткам UTC, и при переходе через полночь
   * текущие сутки становились «завершёнными», а выгрузка уносила в аналитический слой снимки самого прогона (1779 строк вместо
   * трёх посеянных). Тест краснел в зависимости от часа запуска — в CI это каждый прогон после полуночи UTC (шаг 29).
   */
  let endMs = Math.floor(Date.now() / HOUR) * HOUR;
  while (new Date(endMs).getUTCHours() < 3) endMs -= HOUR;
  const startMs = endMs - 3 * HOUR;
  const clock = new VirtualClock(new Date(startMs).toISOString());
  const pools = { appPool: db.pool('svc_app', 6), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2) };
  // Топология работы: свою запись отправляет путь решения, ждущую за ней — процесс за брокером по событию ретранслятора [Р-64, Р-34]
  const k = await kauflandLiveWorld({
    tag: 2701, clock, products, seed: 2701, ...pools,
    // Сбои канала (K-14): часть записей отваливается тайм-аутом, половина из них применяется молча — диспетчер обязан довести каждую
    params: { faults: { writeTimeoutShare: 0.8, timeoutAppliedShare: 0.5, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 }, applyDelayMs: 3 * 60_000 },
  });
  const a = await amazonLiveWorld({ tag: 2702, clock, offers: 6, seed: 2702, lossShare: 0, priceChangeEveryHours: 0.25, ...pools });

  // Снимки суток трёхдневной давности: их выгружает отставание выгрузки, а удаление по сроку сносит секцию только после проверки
  // Сутки старше срока хранения (3 суток): секцию создаёт тест — в шаблоне базы секций дальше трёх суток назад нет
  const oldDay = new Date(startMs - 4 * 24 * HOUR);
  const oldPartition = `competitor_snapshot_log_d${oldDay.toISOString().slice(0, 10).replaceAll('-', '')}`;
  const oldSnapshots = 4;
  const dayStart = new Date(Date.UTC(oldDay.getUTCFullYear(), oldDay.getUTCMonth(), oldDay.getUTCDate())).toISOString();
  // Вторые сутки — двухдневной давности: их выгрузка приходится на время, когда ClickHouse уже поднялся, и строки доходят до слоя
  const exportedDay = new Date(startMs - 2 * 24 * HOUR);
  const exportedPartition = `competitor_snapshot_log_d${exportedDay.toISOString().slice(0, 10).replaceAll('-', '')}`;
  const exportedSnapshots = 3;
  const exportedDayStart = new Date(Date.UTC(exportedDay.getUTCFullYear(), exportedDay.getUTCMonth(), exportedDay.getUTCDate())).toISOString();
  // Слой не принимает часть с этими сутками: выгрузка именно этих суток обязана провалиться громко, а остальные — пройти
  ch.rejectInsertsContaining = oldDay.toISOString().slice(0, 10);
  // Секции создаёт работа планировщика — тем же способом, что в работе (права и политики строк ставит ensure_partitions)
  await db.pool('svc_scheduler', 1).query('SELECT maintenance.ensure_partitions($1)', [oldDay.toISOString()]);
  await inTenant(pools.appPool, k.seeded.tenantId, async (tx) => {
    for (let i = 0; i < oldSnapshots + exportedSnapshots; i++) {
      const at = i < oldSnapshots
        ? new Date(Date.parse(dayStart) + (10 + i) * HOUR).toISOString()
        : new Date(Date.parse(exportedDayStart) + (10 + i - oldSnapshots) * HOUR).toISOString();
      const snapshot = {
        marketplace: 'de', channelProductRef: String(products[0]!.idProduct), condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: at,
        completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: { amountMinor: 1800 + i, currency: 'EUR', basis: 'GROSS' }, isSelf: false },
        offers: [{ rank: 1, sellerRef: 'Synthetic Competitor', isSelf: false, price: { amountMinor: 1800 + i, currency: 'EUR', basis: 'GROSS' } }],
      };
      await tx.query(
        `INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace, channel_product_ref, condition, source, sanity_verdict, delivery, snapshot)
         VALUES ($1, gen_random_uuid(), $2, $2, $3, 'KAUFLAND', 'de', $4, 'new', 'KAUFLAND_BUYBOX', 'ACCEPT', 'POLL', $5::jsonb)`,
        [k.seeded.tenantId, at, k.seeded.ids.dbId(k.world.channelAccountId), String(products[0]!.idProduct), JSON.stringify(snapshot)]);
    }
  });

  // Брокер: продюсер в памяти. Порядок внутри ключа держит ретранслятор, доставку потребителю моделируем вызовом диспетчера
  const published: KeyedMessage[] = [];
  const relayPool: PgPool = db.pool('svc_relay', 2);
  const relay = new OutboxRelay({
    pool: relayPool as never, producer: { async send(messages) { published.push(...messages); }, async disconnect() {} },
    now: () => clock.nowMs(), gapTimeoutMs: 60_000,
  });
  let relayGaps = 0;
  const relayClient = await (relayPool as unknown as { connect(): Promise<never> }).connect();
  // Второй ретранслятор того же региона: активен тот, кто держит advisory lock [Р-34] — дублей публикации быть не должно
  const secondRelayPool: PgPool = db.pool('svc_relay', 1);
  const secondRelay = new OutboxRelay({
    pool: secondRelayPool as never, producer: { async send(messages) { published.push(...messages); }, async disconnect() {} },
    now: () => clock.nowMs(), gapTimeoutMs: 60_000,
  });
  const secondRelayClient = await (secondRelayPool as unknown as { connect(): Promise<never> }).connect();

  // Приёмник уведомлений Amazon: очередь SQS в памяти, уведомления кладёт модель порта
  const sqs = new FakeSqs({ get nowMs() { return clock.nowMs(); } } as never);
  let notificationsSent = 0;
  let ticks = 0;
  let lastNotification: string | null = null;
  const alerts: Background['alerts'] = [];
  const receiver = createNotificationReceiver({
    sqs: createSqsClient({ queueUrl: QUEUE_URL, fetch: sqs.fetch, credentials: async () => ({ accessKeyId: 'SYNTHETICKEYID00000', secretAccessKey: 'syn-secret-access-key', sessionToken: undefined }), now: () => new Date(clock.nowMs()) }),
    queueUrl: QUEUE_URL, region: 'EU',
    applicationId: 'amzn1.sellerapps.app.syn-live', router: { async resolve() { return [{ tenantId: a.seeded.tenantId, channelAccountId: a.seeded.ids.dbId('20000000-0000-4000-8000-000000002702') }]; } },
    ledger: storeLedger(new PgPricingStore(pools.appPool)), sink: pipelineSink(a.receiverPipeline()),
    alerts: { async raise(alert) { alerts.push(alert as never); } }, logger: { log: () => {} }, now: () => new Date(clock.nowMs()),
    sleep: async () => {},
  });

  const schedulerPool = db.pool('svc_scheduler', 3);
  const verifier = new ClickHouseHttp({ url: ch.url, user: 'syn-verifier', password: 'syn' });
  const deps: JobDeps = pgJobDeps({
    schedulerPool, exporterPool: db.pool('svc_exporter', 2), ingest: new ClickHouseHttp({ url: ch.url, user: 'syn-ingest', password: 'syn' }), verifier,
    descriptorOf: (channel) => (channel === 'KAUFLAND' ? k.adapter.descriptor : channel === 'AMAZON' ? a.port.descriptor : null),
    pipelineFor: (acc) => (acc.channelAccountId === k.seeded.ids.dbId(k.world.channelAccountId) ? k.pipelineForDbIds() : a.pipelineForDbIds()),
  });
  const scheduler = createScheduler({
    state: new PgSchedulerState(schedulerPool), source: jobSource(deps), owner: 'bg-1', now: () => clock.iso(),
    alerts: { raise: async (alert) => { alerts.push(alert as never); } },
  });

  const started = Date.now();
  const running = runScheduler(scheduler, {
    tickMs: TICK_MS, clockMs: () => clock.nowMs(), logger: { log: () => {} },
    shouldStop: () => clock.nowMs() > endMs,
    sleep: async (ms) => {
      clock.advance(ms);
      // Приёмник уведомлений: модель порта Amazon отдаёт снимки ANY_OFFER_CHANGED, они кладутся в очередь как сообщения SQS
      for (const snapshot of a.port.drainSnapshots()) {
        notificationsSent += 1;
        // Тело — уведомление SP-API как в снимке схемы (vendor/amazon/.../AnyOfferChangedNotification.json) и фикстурах приёмника
        const money = (minor: number) => ({ Amount: minor / 100, CurrencyCode: 'EUR' });
        const offers = snapshot.offers.map((o) => ({
          SellerId: o.isSelf ? 'A1SYNLIVE2702' : o.sellerRef ?? 'A2SYNCOMP', SubCondition: 'new',
          ListingPrice: money(o.price.amountMinor), Shipping: money(0), ShipsFrom: { Country: 'DE' },
          IsFulfilledByAmazon: false, IsBuyBoxWinner: o.rank === 1, IsFeaturedMerchant: true,
        }));
        const body = JSON.stringify({
          NotificationVersion: '1.0', NotificationType: 'ANY_OFFER_CHANGED', PayloadVersion: '1.0', EventTime: new Date(clock.nowMs()).toISOString(),
          NotificationMetadata: { ApplicationId: 'amzn1.sellerapps.app.syn-live', SubscriptionId: 'syn-subscription', PublishTime: new Date(clock.nowMs()).toISOString(), NotificationId: randomUUID() },
          Payload: { AnyOfferChangedNotification: {
            SellerId: 'A1SYNLIVE2702',
            OfferChangeTrigger: { MarketplaceId: snapshot.marketplace, ASIN: snapshot.channelProductRef, ItemCondition: 'new', TimeOfOfferChange: snapshot.observedAt, OfferChangeType: 'External' },
            Summary: {
              NumberOfOffers: [{ Condition: 'new', FulfillmentChannel: 'Merchant', OfferCount: offers.length }],
              LowestPrices: [], BuyBoxPrices: snapshot.buybox ? [{ Condition: 'new', LandedPrice: money(snapshot.buybox.price.amountMinor), ListingPrice: money(snapshot.buybox.price.amountMinor), Shipping: money(0) }] : [],
              TotalBuyBoxEligibleOffers: offers.length, SalesRankings: [], NumberOfBuyBoxEligibleOffers: [],
            },
            Offers: offers,
          } },
        });
        lastNotification = body;
        sqs.send(body);
      }
      // Повтор доставки и испорченное сообщение: очередь стандартная — дубли и мусор в ней норма
      if (ticks === 40) {
        sqs.send(lastNotification ?? '{}');
        sqs.send('{"NotificationType": "ANY_OFFER_CHANGED", "Payload": ');
      }
      ticks += 1;
      await receiver.pollOnce();
      // Диспетчер: обход-страховка; события ретранслятора доводят записи до канала раньше обхода
      await k.betweenTicks();
      await a.betweenTicks();
      // Активен тот ретранслятор, который держит блокировку региона [Р-34]: второй ждёт и не публикует
      const plan = (await relay.tryLock(relayClient)) ? (await relay.runOnce(relayClient)).plan : { publish: [], held: [] };
      relayGaps += plan.held.length;
      if (await secondRelay.tryLock(secondRelayClient)) await secondRelay.runOnce(secondRelayClient);
      // Потребитель scope.write.v1 — путь решения за брокером: событие о ждущей записи ведёт к её отправке [Р-64, ADR-0009]
      for (const row of plan.publish) {
        if (row.topic !== TOPICS.scopeWrite || !row.writeScopeId) continue;
        await k.dispatchScope(row.tenantId, row.writeScopeId);
      }
    },
  });
  await running.finished;
  (relayClient as unknown as { release(): void }).release();
  (secondRelayClient as unknown as { release(): void }).release();
  bg = { startMs, endMs, seconds: Math.round((Date.now() - started) / 1000), k, a, ch, published, sqs, receiver, notificationsSent, alerts, relayGaps, ticks, oldPartition, oldSnapshots, exportedPartition, exportedSnapshots };
  const { rows: jobs } = await observer.query(
    `SELECT job_name, count(*)::int AS runs, count(*) FILTER (WHERE outcome = 'FAILED')::int AS failed FROM maintenance.scheduled_job_run GROUP BY 1 ORDER BY 1`);
  const { rows: counts } = await observer.query(
    `SELECT 'price_history' AS t, count(*)::int AS n FROM tenant_data.price_history
     UNION ALL SELECT 'channel_write_history', count(*)::int FROM tenant_data.channel_write_history
     UNION ALL SELECT 'outbox_event', count(*)::int FROM tenant_data.outbox_event
     UNION ALL SELECT 'competitor_snapshot_log', count(*)::int FROM channel_data.competitor_snapshot_log
     UNION ALL SELECT 'inbound_notification', count(*)::int FROM channel_data.inbound_notification`);
  const { rows: sync } = await observer.query(`SELECT write_scope_id, in_flight_write_id IS NULL AS free FROM tenant_data.write_scope_sync_state LIMIT 5`);
  const { rows: parts } = await observer.query(`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = 'tenant_data.outbox_event'::regclass`);
  console.log(JSON.stringify({ counts, sync, outboxPartitions: parts[0] }));
  const { rows: retentionRuns } = await observer.query(`SELECT table_name, action, count(*)::int AS n FROM maintenance.retention_run GROUP BY 1,2 ORDER BY 1,2`);
  const { rows: queued } = await observer.query(
    `SELECT status, count(*)::int AS n, count(*) FILTER (WHERE next_attempt_at IS NOT NULL)::int AS with_retry,
            max(extract(epoch FROM ($1::timestamptz - created_at)))::int AS oldest_seconds
       FROM tenant_data.channel_write GROUP BY 1`, [new Date(endMs).toISOString()]);
  const { rows: exportRuns } = await observer.query(
    `SELECT slot_at, started_at, outcome, items FROM maintenance.scheduled_job_run WHERE job_name = 'analytics-export-day' ORDER BY started_at`);
  console.log(JSON.stringify({ retentionRuns, queued, exportRuns, startedAt: new Date(startMs).toISOString(), outageUntil: new Date(startMs + 60 * TICK_MS).toISOString() }));
  const { rows: exportsRows } = await observer.query(`SELECT parent_table, partition_name, target, exported_rows, verified_at IS NOT NULL AS verified FROM maintenance.partition_export ORDER BY partition_name`);
  console.log(JSON.stringify({ exportsRows }));
  const { rows: outboxRows } = await observer.query(`SELECT topic, count(*)::int AS n, min(scope_seq) AS min_seq, max(scope_seq) AS max_seq FROM tenant_data.outbox_event GROUP BY 1`);
  const { rows: relayState } = await observer.query(`SELECT * FROM maintenance.outbox_relay_state`);
  const { rows: writes } = await observer.query(`SELECT status, count(*)::int AS n FROM tenant_data.channel_write GROUP BY 1`);
  console.log(JSON.stringify({ outboxRows, relayState, writes }));
  console.log(JSON.stringify({
    seconds: bg.seconds, jobs, requests: Object.fromEntries(k.requests), clickHouse: { ...ch.requests, unknown: ch.unknown.slice(0, 3), tables: [...ch.rows].map(([t, r]) => [t, r.length]) },
    alertCodes: [...new Set(bg.alerts.map((x) => x.code))],
    outbox: published.length, notificationsSent, sqsLeft: sqs.messages.length, alerts: [...new Set(alerts.map((x) => `${x.code}:${x.severity}`))],
  }));
});

/** Р-130: каждый фоновый механизм утверждается наблюдаемым за период */
const observes = (mechanism: string, name: string, body: () => Promise<void> | void) => {
  test(`${mechanism} — ${name}`, async () => {
    currentMechanism = mechanism;
    try { await body(); } finally { currentMechanism = null; }
  });
};

observes('write-dispatcher', 'Р-64: ждущая запись объявляется событием и доходит до канала; при сбоях канала ни одна не застревает', async () => {
  const { rows: [w] } = await observer.query(
    `SELECT (SELECT count(*)::int FROM tenant_data.channel_write) AS in_queue,
            (SELECT count(*)::int FROM tenant_data.channel_write_history WHERE final_status = 'APPLIED') AS applied,
            (SELECT count(*)::int FROM tenant_data.channel_write_history) AS finished,
            -- История цен пишется, когда канал ПРИНЯЛ запись (0019): принятые в очереди плюс завершённые принятыми
            (SELECT count(*)::int FROM tenant_data.channel_write WHERE status = 'ACCEPTED') AS accepted_in_queue,
            (SELECT count(*)::int FROM tenant_data.channel_write_history WHERE final_status IN ('APPLIED', 'NOT_APPLIED')) AS accepted_finished,
            (SELECT count(*)::int FROM tenant_data.price_history) AS prices,
            (SELECT count(*)::int FROM tenant_data.channel_write WHERE status = 'PENDING' AND created_at < $1::timestamptz - interval '10 minutes') AS stale_pending,
            (SELECT count(*)::int FROM tenant_data.channel_write WHERE status NOT IN ('ACCEPTED', 'PENDING', 'DISPATCHED') AND next_attempt_at IS NULL) AS without_plan`,
    [new Date(bg.endMs).toISOString()]);
  // Модель канала роняет пятую часть записей тайм-аутом (K-14) и применяет половину из них молча
  assert.ok(bg.k.simulator.stats.timeouts > 0, 'модель канала действительно роняла записи тайм-аутом');
  assert.equal(w.stale_pending, 0, 'ждущих записей старше 10 минут не осталось: о каждой объявлено событием');
  assert.equal(w.without_plan, 0, 'ни одной записи без плана продолжения (повтор, подтверждение или завершение с причиной)');
  assert.equal(w.prices, w.accepted_in_queue + w.accepted_finished, `каждая принятая каналом запись дала строку истории цен: ${JSON.stringify(w)}`);
  assert.ok(w.prices > 0 && w.finished >= w.applied, `записи доходят до канала: ${JSON.stringify(w)}`);
  const patches = bg.k.requests.get('PATCH /v2/units/{id}') ?? 0;
  assert.ok(patches >= w.applied, `канал получил не меньше запросов, чем применено записей: ${patches} против ${w.applied}`);
});

observes('outbox-relay', 'Р-34, Р-24: каждое событие опубликовано один раз и в порядке версий единицы', async () => {
  const { rows } = await observer.query(`SELECT count(*)::int AS n FROM tenant_data.outbox_event`);
  // Канал в модели отвечает тайм-аутом на четыре записи из пяти (K-14): пока запись не разрешена, следующая цена ждёт — о ней и
  // объявляется событие. Порог 5 за три часа, а не «больше нуля»: утверждение не должно зеленеть от одного случайного совпадения
  assert.ok(rows[0].n >= 5, `события о ждущих записях создаются: ${rows[0].n}`);
  assert.equal(bg.published.length, rows[0].n, 'ретранслятор опубликовал каждое событие ровно один раз');
  const ids = bg.published.map((m) => String(m.headers?.['event-id'] ?? ''));
  assert.equal(new Set(ids).size, ids.length, 'дублей публикации нет');
  const seqByKey = new Map<string, number>();
  for (const message of bg.published) {
    const seq = Number(message.headers?.['scope-seq'] ?? 0);
    const previous = seqByKey.get(message.key) ?? 0;
    assert.ok(seq >= previous, `порядок внутри ключа ${message.key}: ${seq} после ${previous}`);
    seqByKey.set(message.key, seq);
  }
  assert.equal(bg.relayGaps, 0, 'пропусков номеров, ожидающих закрытия, к концу прогона не осталось');
});

observes('notification-receiver', 'шаг 23: каждое уведомление обработано один раз, очередь пуста, повтор доставки — дубль', async () => {
  const { rows: [n] } = await observer.query(`SELECT count(*)::int AS processed, count(DISTINCT notification_id)::int AS unique_ids FROM channel_data.inbound_notification`);
  assert.equal(bg.sqs.messages.length, 0, 'в очереди не осталось сообщений');
  assert.equal(n.processed, n.unique_ids, 'каждое уведомление в журнале один раз');
  assert.ok(bg.notificationsSent > 10, `модель канала действительно слала уведомления: ${bg.notificationsSent}`);
  assert.equal(n.processed, bg.notificationsSent, `обработаны все уведомления: ${n.processed} из ${bg.notificationsSent}`);
  // Повтор доставки того же уведомления журнал отсекает: второй записи нет (OQ-171)
  assert.ok(bg.alerts.some((x) => x.code === 'NOTIFICATION_UNPARSEABLE'), 'испорченное сообщение очереди замечено алертом, а не тишиной');
});

observes('analytics-export', 'Р-122: сутки журнала снимков выгружены и проверены; сутки, выгрузка которых провалилась, не отмечены', async () => {
  const exported = bg.ch.rows.get('repracer_analytics.competitor_snapshot') ?? [];
  // Модель ClickHouse понимает ровно то, что шлёт выгрузка: непонятый запрос выглядел бы отказом слоя (ревью шага 27, находка 7)
  assert.deepEqual(bg.ch.unknown, [], 'модель ClickHouse поняла все запросы выгрузки');
  // Первые 15 минут прогона ClickHouse недоступен: выгрузка обязана провалиться громко
  assert.ok(bg.alerts.some((x) => x.code === 'ANALYTICS_EXPORT_FAILED' && x.severity === 'CRITICAL'), 'недоступный ClickHouse — CRITICAL, а не тишина');
  // Сутки, выгрузка которых пришлась на недоступность: ни строки partition_export, ни отметки проверки
  const { rows: mark } = await observer.query(
    `SELECT exported_rows, verified_at IS NOT NULL AS verified FROM maintenance.partition_export WHERE partition_name = $1 AND target = 'CLICKHOUSE'`, [`channel_data.${bg.oldPartition}`]);
  assert.equal(mark.length, 0, `провалившаяся выгрузка не отмечает секцию: ${JSON.stringify(mark)}`);
  // Сутки, выгрузка которых пришлась на восстановившийся ClickHouse: строки дошли до слоя и отмечены проверенными
  const { rows: [good] } = await observer.query(
    `SELECT coalesce(sum(exported_rows), 0)::int AS rows, count(*) FILTER (WHERE verified_at IS NOT NULL)::int AS verified
       FROM maintenance.partition_export WHERE partition_name = $1 AND target = 'CLICKHOUSE'`, [`channel_data.${bg.exportedPartition}`]);
  assert.equal(good.rows, bg.exportedSnapshots, `выгружены все снимки суток: ${good.rows} из ${bg.exportedSnapshots}`);
  assert.equal(good.verified, 1, 'выгруженные сутки отмечены проверенными (сверка числа строк в ClickHouse)');
  assert.equal(exported.length, bg.exportedSnapshots, `в аналитическом слое ровно снимки выгруженных суток: ${exported.length}`);
  // Повтор той же части с тем же токеном данные не удваивает (окно дедупликации таблицы, 050)
  assert.ok(bg.ch.requests.inserts > 0, 'вставки в ClickHouse были');
  const before = exported.length;
  await bg.ch.replayLastInsert();
  assert.equal((bg.ch.rows.get('repracer_analytics.competitor_snapshot') ?? []).length, before, 'повтор вставки строк не удваивает');
});

observes('retention', 'секция снимков удаляется по сроку только после проверенной выгрузки', async () => {
  const { rows } = await observer.query(
    `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = 'channel_data.competitor_snapshot_log'::regclass AND c.relname = $1`, [bg.oldPartition]);
  // Выгрузка этих суток провалилась (ClickHouse лежал) — секция старше срока хранения остаётся: удаление ждёт проверенной выгрузки
  assert.equal(rows.length, 1, `секция ${bg.oldPartition} без проверенной выгрузки не удалена`);
  const { rows: [mark] } = await observer.query(
    `SELECT count(*)::int AS n FROM maintenance.partition_export WHERE partition_name = $1 AND verified_at IS NOT NULL`, [`channel_data.${bg.oldPartition}`]);
  assert.equal(mark.n, 0, 'непроверенная секция и не отмечена проверенной');
  const { rows: [forced] } = await observer.query(`SELECT count(*)::int AS n FROM maintenance.retention_run WHERE action = 'PARTITION_FORCE_DROPPED'`);
  assert.equal(forced.n, 0, 'принудительных удалений невыгруженных секций не было');
  // Секции, выгрузка которых проверена, удаляются: за прогон удалена хотя бы одна, и все удалённые — из проверенных
  const { rows: [dropped] } = await observer.query(
    `SELECT count(*)::int AS n FROM maintenance.retention_run WHERE action = 'PARTITION_DROPPED' AND table_name = 'channel_data.competitor_snapshot_log'`);
  const { rows: [verified] } = await observer.query(
    `SELECT count(*)::int AS n FROM maintenance.partition_export WHERE parent_table = 'channel_data.competitor_snapshot_log' AND verified_at IS NOT NULL`);
  assert.ok(dropped.n > 0, `удаление по сроку сняло хотя бы одну проверенную секцию: ${dropped.n}`);
  assert.ok(dropped.n <= verified.n, `удалено секций не больше, чем проверено выгрузкой: ${dropped.n} из ${verified.n}`);
});

test('Р-130: каждый проверяемый фоновый механизм утверждается — и утверждение ВЫПОЛНЯЕТСЯ', () => {
  const MECHANISMS = ['write-dispatcher', 'outbox-relay', 'notification-receiver', 'analytics-export', 'retention'];
  const silent = MECHANISMS.filter((m) => (assertionsOf.get(m) ?? 0) === 0);
  assert.deepEqual(silent, [], 'механизм назван, но ни одного утверждения о нём не выполнилось [OQ-204]');
  assert.ok([...assertionsOf.values()].reduce((a, b) => a + b, 0) > MECHANISMS.length,
    `утверждений больше, чем механизмов: ${JSON.stringify([...assertionsOf])}`);
});
