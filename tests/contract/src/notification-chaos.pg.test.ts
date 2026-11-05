import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createAmazonAdapter, TwoLevelBudget } from '@repracer/amazon-adapter';
import { createNotificationReceiver, createSqsClient, pipelineSink, storeJournal, storeLedger, type NotificationReceiver } from '@repracer/amazon-notifications';
import { FakeSqs } from '@repracer/amazon-notifications/testing';
import type { AdapterDependencies } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgSellerRouter, seedPricingWorld, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';

/**
 * Шаг 114: хаос приёмника уведомлений — обработчик умирает посреди пачки. Настоящие приёмник, адаптер Amazon, путь решения и база;
 * очередь — модель стандартной очереди SQS (`FakeSqs`: скрытие на VisibilityTimeout, повторная доставка, удаление по ReceiptHandle).
 * Почему модель, а не localstack: образы Docker Hub на машине разработчика не скачиваются (OQ-114), а модель уже держит то, от чего
 * зависит свойство, — повтор сообщения после смерти получателя; живой AWS — часть Б.
 *
 * Смерть — на КАЖДОЙ границе ввода-вывода по очереди: обращение к очереди, к журналу сырья, к журналу обработанных и каждая транзакция
 * хранилища пути решения — до вызова (не случился) и после (случился, процесс не узнал). Умерший процесс больше ничего не делает:
 * все его следующие вызовы не возвращаются никогда. Транзакция внутри вызова неделима, поэтому смерть «посреди транзакции» — это
 * откат, то есть граница «до». Затем — новый процесс: другой экземпляр приёмника на той же очереди и базе, часы — за VisibilityTimeout.
 *
 * Свойство на каждой границе: очередь пуста; у каждого уведомления пачки — ровно одна строка журнала сырья, ровно одна строка журнала
 * обработанных и ровно одно его следствие (статус листинга — одна строка; ANY_OFFER_CHANGED — один снимок в журнале снимков). Повтор
 * доставки той же пачкой — тоже не дубль. Данные синтетические.
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001142';
const TENANT = '10000000-0000-4000-8000-000000001142';
const SELLER = 'A1SYNCHAOS114';
const APP = 'amzn1.sellerapps.app.syn-chaos-114';
const US = 'ATVPDKIKX0DER';
const QUEUE = 'https://sqs.us-east-1.amazonaws.com/000000000000/repracer-syn-chaos';
const VISIBILITY_SECONDS = 60;

let db: IsolatedDatabase;
let app: PgPool;
let inbound: PgPool;
let world: SeededPricingWorld;
let nowMs = Date.parse('2026-11-05T10:00:00.000Z');
const clock = { get nowMs() { return nowMs; } };

const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: US, externalUnitId: `SYN-CHAOS-${n}`, channelProductRef: `B0CHAOS00${n}`,
  condition: 'new', currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1900,
  minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
});

before(async () => {
  db = await createIsolatedDatabase('chaos114');
  app = db.pool('svc_app', 4);
  inbound = db.pool('svc_inbound', 2);
  world = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    fixtureChannel: 'AMAZON', fixtureRegion: 'NA', fixtureExternalAccountId: SELLER, marketplaces: [US], clock: new Date(nowMs).toISOString(), writeMode: 'SHADOW',
    seed: { scopes: [1, 2, 3].map(scope), marketplaces: { [US]: { currency: 'USD', basis: 'NET' } } } as never,
  });
});
after(async () => { await db?.drop(); });

const iso = () => new Date(nowMs).toISOString();
const meta = (id: string) => ({ ApplicationId: APP, SubscriptionId: 'syn-sub', PublishTime: iso(), NotificationId: id });
const statusChange = (id: string, n: number, status: string[]) => ({
  NotificationVersion: '1.0', NotificationType: 'LISTINGS_ITEM_STATUS_CHANGE', PayloadVersion: '1.0', EventTime: iso(),
  Payload: { SellerId: SELLER, MarketplaceId: US, Asin: `B0CHAOS00${n}`, Sku: `SYN-CHAOS-${n}`, CreatedDate: '2026-09-01T10:00:00.000Z', Status: status },
  NotificationMetadata: meta(id),
});
const eventBridge = (notification: { NotificationType: string; EventTime: string; NotificationMetadata: { NotificationId: string } }) => JSON.stringify({
  version: '0', id: `syn-event-${notification.NotificationMetadata.NotificationId}`, 'detail-type': notification.NotificationType,
  source: `aws.partner/sellingpartnerapi.amazon.com/000000000000/${APP}`, account: '000000000000', time: notification.EventTime, region: 'us-east-1', resources: [], detail: notification,
});
const money = (amount: number) => ({ Amount: amount, CurrencyCode: 'USD' });
const anyOfferChanged = (id: string, n: number) => JSON.stringify({
  NotificationVersion: '1.0', NotificationType: 'ANY_OFFER_CHANGED', PayloadVersion: '1.0', EventTime: iso(), NotificationMetadata: meta(id),
  Payload: { AnyOfferChangedNotification: {
    SellerId: SELLER, OfferChangeTrigger: { MarketplaceId: US, ASIN: `B0CHAOS00${n}`, ItemCondition: 'new', TimeOfOfferChange: iso(), OfferChangeType: 'External' },
    Summary: { NumberOfOffers: [{ Condition: 'new', FulfillmentChannel: 'Merchant', OfferCount: 1 }], LowestPrices: [],
      BuyBoxPrices: [{ Condition: 'new', LandedPrice: money(17.8), ListingPrice: money(17.8), Shipping: money(0) }], TotalBuyBoxEligibleOffers: 1, SalesRankings: [], NumberOfBuyBoxEligibleOffers: [] },
    Offers: [{ SellerId: 'A2SYNCOMP00114', SubCondition: 'new', SellerFeedbackRating: { FeedbackCount: 120, SellerPositiveFeedbackRating: 98 },
      ShippingTime: { MinimumHours: 24, MaximumHours: 48, AvailabilityType: 'NOW' }, ListingPrice: money(17.8), Shipping: money(0), IsFulfilledByAmazon: false,
      IsFeaturedMerchant: true, ShipsDomestically: true }],
  } },
});

/** Процесс с одной смертью: граница с номером `dieAt` (до или после вызова) — последняя; дальше вызовы не возвращаются никогда */
function mortal(dieAt: number) {
  let step = 0;
  let dead = false;
  const never = new Promise<never>(() => undefined);
  const guard = async <T>(call: () => Promise<T>): Promise<T> => {
    if (dead || ++step === dieAt) { dead = true; return never; }
    const result = await call();
    if (dead || ++step === dieAt) { dead = true; return never; }
    return result;
  };
  const wrap = <T extends object>(target: T): T => new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver) as unknown;
      return typeof value === 'function' ? (...args: unknown[]) => guard(() => Promise.resolve((value as (...a: unknown[]) => unknown).apply(t, args))) : value;
    },
  });
  return { wrap, guard, get steps() { return step; }, get dead() { return dead; } };
}

function receiverProcess(sqs: FakeSqs, dieAt: number): { receiver: NotificationReceiver; process: ReturnType<typeof mortal> } {
  const process = mortal(dieAt);
  const store = process.wrap(new PgPricingStore(app));
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'NA', externalAccountId: SELLER, marketplaces: [US], credentialsRef: 'cred:chaos' } };
    } },
    credentials: { async get() { return { refreshToken: 'syn-refresh', clientId: 'syn-client', clientSecret: 'syn-secret' }; } },
    alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => iso() as never,
  };
  // Сеть адаптеру не нужна: уведомление разбирается без обращений к SP-API; обращение — ошибка теста
  const adapter = createAmazonAdapter({ deps, userAgent: 'repracer-chaos/1.0', applicationCredentialsRef: 'cred:app', budget: new TwoLevelBudget(),
    fetch: (async () => { throw new Error('no network in the chaos run'); }) as typeof fetch, endpoints: { NA: 'https://sp-api.invalid' } });
  const pipeline = createPricingPipeline({ store, adapter, alerts: deps.alerts, logger: deps.logger, now: () => iso() as never });
  const fetchOf: typeof fetch = (input, init) => process.guard(() => sqs.fetch(input, init));
  const receiver = createNotificationReceiver({
    sqs: createSqsClient({ queueUrl: QUEUE, credentials: async () => ({ accessKeyId: 'AKIASYNTHETIC0000114', secretAccessKey: 'syn-aws-secret-access-key-0114' }), fetch: fetchOf, now: () => new Date(nowMs) }),
    queueUrl: QUEUE, region: 'NA', applicationId: APP, router: new PgSellerRouter(inbound), ledger: storeLedger(store), journal: storeJournal(store), sink: pipelineSink(pipeline),
    alerts: deps.alerts, logger: deps.logger, now: () => new Date(nowMs),
    policy: { waitTimeSeconds: 0, visibilityTimeoutSeconds: VISIBILITY_SECONDS, maxReceiveCount: 1_000 },
  });
  return { receiver, process };
}

/** Пачка раунда: два статуса листинга событием EventBridge, ANY_OFFER_CHANGED сообщением SP-API и повтор первого статуса */
function sendBatch(sqs: FakeSqs, round: number): string[] {
  const ids = [`syn-c${round}-s1`, `syn-c${round}-s2`, `syn-c${round}-a1`];
  const first = eventBridge(statusChange(ids[0]!, 1, round % 2 === 0 ? ['BUYABLE', 'DISCOVERABLE'] : ['DISCOVERABLE']));
  sqs.send(first);
  sqs.send(eventBridge(statusChange(ids[1]!, 2, ['BUYABLE'])));
  sqs.send(anyOfferChanged(ids[2]!, 3));
  sqs.send(first);
  return ids;
}

async function counts(ids: string[]) {
  const [journal, processed, listings, snapshots] = await Promise.all([
    db.rows<{ notification_id: string; n: number }>(`SELECT notification_id, count(*)::int AS n FROM channel_data.notification_journal WHERE notification_id = ANY($1) GROUP BY 1`, [ids]),
    db.rows<{ notification_id: string; n: number }>(`SELECT notification_id, count(*)::int AS n FROM channel_data.inbound_notification WHERE notification_id = ANY($1) GROUP BY 1`, [ids]),
    db.rows<{ notification_id: string; n: number }>(`SELECT notification_id, count(*)::int AS n FROM channel_data.listing_status WHERE notification_id = ANY($1) GROUP BY 1`, [ids]),
    db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM channel_data.competitor_snapshot_log WHERE tenant_id = $1 AND source_event_id = $2`, [world.tenantId, ids[2]]),
  ]);
  const by = (rows: Array<{ notification_id: string; n: number }>) => Object.fromEntries(ids.map((id) => [id, rows.find((r) => r.notification_id === id)?.n ?? 0]));
  return { journal: by(journal), processed: by(processed), listings: by(listings), snapshots: snapshots[0]?.n ?? 0 };
}

async function drain(sqs: FakeSqs) {
  const { receiver } = receiverProcess(sqs, Number.POSITIVE_INFINITY);
  for (let i = 0; i < 10 && sqs.messages.length > 0; i += 1) {
    nowMs += (VISIBILITY_SECONDS + 1) * 1000;
    await receiver.pollOnce();
  }
}

test('step 114: chaos — the receiver dies at every boundary of a batch in turn; after a restart nothing is lost and nothing is doubled', async () => {
  const sqs = new FakeSqs(clock);
  // Раунд без смерти — сколько границ у пачки и каково правильное следствие
  const clean = receiverProcess(sqs, Number.POSITIVE_INFINITY);
  const cleanIds = sendBatch(sqs, 0);
  await clean.receiver.pollOnce();
  const boundaries = clean.process.steps;
  const once = { journal: Object.fromEntries(cleanIds.map((id) => [id, 1])), processed: Object.fromEntries(cleanIds.map((id) => [id, 1])),
    listings: { [cleanIds[0]!]: 1, [cleanIds[1]!]: 1, [cleanIds[2]!]: 0 }, snapshots: 1 };
  assert.deepEqual(await counts(cleanIds), once, 'the batch without a death');
  assert.equal(sqs.messages.length, 0);
  assert.ok(boundaries >= 20, `a batch crosses many boundaries: ${boundaries}`);
  console.log(`chaos 114: a batch of ${cleanIds.length + 1} messages crosses ${boundaries} boundaries; the receiver dies at each in turn`);

  const deaths: number[] = [];
  for (let dieAt = 1; dieAt <= boundaries; dieAt += 1) {
    nowMs += 1_000;
    const ids = sendBatch(sqs, dieAt);
    const dying = receiverProcess(sqs, dieAt);
    void dying.receiver.pollOnce();
    // Умерший процесс дальше не делает ничего: ждём, пока его последний вызов вернётся в «никогда»
    for (let i = 0; i < 200 && !dying.process.dead; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.equal(dying.process.dead, true, `the process died at boundary ${dieAt}`);
    deaths.push(dieAt);
    await drain(sqs);
    const listed = { [ids[0]!]: 1, [ids[1]!]: 1, [ids[2]!]: 0 };
    assert.deepEqual(await counts(ids), { journal: Object.fromEntries(ids.map((id) => [id, 1])), processed: Object.fromEntries(ids.map((id) => [id, 1])), listings: listed, snapshots: 1 },
      `death at boundary ${dieAt} of ${boundaries}: one row and one effect per notification`);
    assert.equal(sqs.messages.length, 0, `death at boundary ${dieAt}: the queue is drained`);
  }
  assert.equal(deaths.length, boundaries);
});

/**
 * Шаг 114: честная деградация. Приёмник выключен, очередь недоступна или пуста — опрос работает как сейчас: обнаружение каталога
 * настоящим адаптером (searchListingsItems через модель ответа) пишет статус листинга тем же путём; уведомления, пришедшие в очередь
 * без приёмника, ждут в ней и доходят, когда он вернулся; отказ очереди — не потеря. Откуда данные — видно: «только опрос», пока
 * уведомлений за сутки нет, и уведомления по видам — когда они дошли
 */
test('step 114: the receiver off, the queue down or empty — polling keeps the listing status, nothing waiting in the queue is lost, and the source is named', async () => {
  const { dataSourceText, messagesFor } = await import('@repracer/console-model');
  const en = messagesFor('en');
  const store = new PgPricingStore(app);
  const sqs = new FakeSqs(clock);
  const sources = async () => dataSourceText((await store.notificationSources(world.tenantId, iso())).find((x) => x.channelAccountId === world.ids.dbId(ACCOUNT)), en);
  // Приёмник выключен: уведомление ждёт в очереди
  nowMs += 2 * 86_400_000;
  const waiting = statusChange('syn-d-1', 2, ['DISCOVERABLE']);
  sqs.send(eventBridge(waiting));
  assert.equal(await sources(), en.ui.connections.dataSource.polling, 'nothing reached us in 24 hours — polling only');

  // Опрос работает как сейчас: обнаружение настоящим адаптером записывает статус листинга без единого уведомления
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) { return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'NA', externalAccountId: SELLER, marketplaces: [US], credentialsRef: 'cred:chaos' } }; } },
    credentials: { async get() { return { refreshToken: 'syn-refresh', clientId: 'syn-client', clientSecret: 'syn-secret' }; } },
    alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => iso() as never,
  };
  const searched = { numberOfResults: 1, items: [{ sku: 'SYN-CHAOS-3', summaries: [{ marketplaceId: US, asin: 'B0CHAOS003', productType: 'SYN_TYPE', status: ['DISCOVERABLE'], createdDate: iso(), lastUpdatedDate: iso() }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 2 }] }] };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = url.pathname === '/auth/o2/token' ? { access_token: 'syn-lwa-access-token', expires_in: 3600 } : searched;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({ deps, userAgent: 'repracer-chaos/1.0', applicationCredentialsRef: 'cred:app', budget: new TwoLevelBudget(), fetch: fetchFn, endpoints: { NA: 'https://sp-api.invalid' } });
  const pipeline = createPricingPipeline({ store, adapter, alerts: deps.alerts, logger: deps.logger, now: () => iso() as never });
  const ctx = { tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'degrade-114', deadline: new Date(nowMs + 60_000).toISOString() as never };
  await pipeline.discoverOffers(ctx, { pageLimit: 20 });
  const polled = await db.rows<{ source: string; buyable: boolean }>(`SELECT source, buyable FROM channel_data.listing_status WHERE tenant_id = $1 AND external_sku = 'SYN-CHAOS-3' ORDER BY recorded_at`, [world.tenantId]);
  assert.deepEqual(polled, [{ source: 'DISCOVERY', buyable: false }], 'the catalog scan records the status without the queue');

  // Очередь недоступна: отказ — не потеря, сообщение остаётся
  const { receiver } = receiverProcess(sqs, Number.POSITIVE_INFINITY);
  sqs.failNextReceive = 503;
  const down = await receiver.pollOnce();
  assert.deepEqual([down.received, typeof down.queueError, sqs.messages.length], [0, 'string', 1]);
  // Приёмник вернулся — ждавшее уведомление дошло; источник назван уведомлениями
  const back = await receiver.pollOnce();
  assert.deepEqual(back.outcomes.map((o) => o.outcome), ['DELIVERED']);
  assert.equal((await counts(['syn-d-1', 'x', 'y'])).listings['syn-d-1'], 1);
  assert.match(await sources(), /^Data source: Amazon notifications, the last one .+; in 24 hours: 1 offer status change\./);
  // Пустая очередь — не ошибка и ничего не меняет
  const empty = await receiver.pollOnce();
  assert.deepEqual([empty.received, empty.queueError], [0, undefined]);
});
