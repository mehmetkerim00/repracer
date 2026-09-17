import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InboundDelivery } from '@repracer/channel-port';
import { createNotificationReceiver, type NotificationLedger, type SellerRoute } from '../src/receiver.ts';
import { createSqsClient } from '../src/sqs.ts';
import { FakeSqs } from '../src/testing.ts';

/** Приёмник на очереди в памяти: подлинность, дедупликация, порядок, потеря. Идентификаторы и тела — синтетические */
const QUEUE = 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-syn-notifications';
const APP = 'amzn1.sellerapps.app.syn0001';
const SELLER = 'A1SYNSELLER0001';

function aoc(id: string, eventTime: string, over: { app?: string; seller?: string } = {}): string {
  return JSON.stringify({
    NotificationVersion: '1.0', NotificationType: 'ANY_OFFER_CHANGED', PayloadVersion: '1.0', EventTime: eventTime,
    Payload: { AnyOfferChangedNotification: { SellerId: over.seller ?? SELLER, OfferChangeTrigger: { MarketplaceId: 'A1PA6795UKMFR9', ASIN: 'B000000001', ItemCondition: 'new', TimeOfOfferChange: eventTime } } },
    NotificationMetadata: { ApplicationId: over.app ?? APP, SubscriptionId: 'syn-sub', PublishTime: eventTime, NotificationId: id },
  });
}

function pricingHealth(id: string, eventTime: string): string {
  return JSON.stringify({
    notificationVersion: '1.0', notificationType: 'PRICING_HEALTH', payloadVersion: '1.0', eventTime,
    payload: { issueType: 'BuyBoxDisqualification', sellerId: SELLER, offerChangeTrigger: { marketplaceId: 'A1PA6795UKMFR9', asin: 'B000000001', itemCondition: 'new', timeOfOfferChange: eventTime } },
    notificationMetadata: { applicationId: APP, subscriptionId: 'syn-sub', publishTime: eventTime, notificationId: id },
  });
}

function world(routes: Record<string, SellerRoute[]> = { [SELLER]: [{ tenantId: 't-1', channelAccountId: 'a-1' }] }) {
  const clock = { nowMs: Date.parse('2026-09-17T10:00:00.000Z') };
  const sqs = new FakeSqs(clock);
  const processed = new Set<string>();
  const ledger: NotificationLedger = {
    async wasProcessed(route, id) { return processed.has(`${route.tenantId}|${id}`); },
    async markProcessed(route, e) { processed.add(`${route.tenantId}|${e.notificationId}`); },
  };
  const delivered: Array<{ route: SellerRoute; delivery: InboundDelivery; type: string; id: string }> = [];
  let failures = 0;
  const alerts: Array<{ code: string; severity: string; details: Record<string, unknown>; tenantId?: string }> = [];
  const receiver = createNotificationReceiver({
    sqs: createSqsClient({ queueUrl: QUEUE, credentials: async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE' }), fetch: sqs.fetch, now: () => new Date(clock.nowMs) }),
    queueUrl: QUEUE, region: 'EU', applicationId: APP,
    router: { resolve: async (region, sellerId) => (region === 'EU' ? routes[sellerId] ?? [] : []) },
    ledger,
    sink: { async deliver(route, delivery, e) {
      if (failures > 0) { failures -= 1; throw new Error('database unavailable'); }
      delivered.push({ route, delivery, type: e.notificationType, id: e.notificationId });
      return 'ACCEPTED';
    } },
    alerts: { raise: async (a) => { alerts.push(a as never); } },
    logger: { log: () => {} },
    now: () => new Date(clock.nowMs),
    policy: { waitTimeSeconds: 0 },
  });
  return { clock, sqs, receiver, delivered, alerts, failAfter: (n: number) => { failures = n; } };
}

test('a duplicate NotificationId in the same batch and in a later batch is processed once and deleted every time', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-1', '2026-09-17T09:59:00.000Z'));
  w.sqs.send(aoc('syn-n-1', '2026-09-17T09:59:00.000Z'));
  const first = await w.receiver.pollOnce();
  assert.deepEqual(first.outcomes.map((o) => o.outcome), ['DELIVERED', 'DUPLICATE']);
  w.sqs.send(aoc('syn-n-1', '2026-09-17T09:59:00.000Z'));
  const later = await w.receiver.pollOnce();
  assert.deepEqual(later.outcomes.map((o) => o.outcome), ['DUPLICATE']);
  assert.equal(w.delivered.length, 1);
  assert.equal(w.sqs.messages.length, 0, 'duplicates are removed from the queue');
});

test('a batch delivered out of order is processed by EventTime; ANY_OFFER_CHANGED and camelCase PRICING_HEALTH are both accepted', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-3', '2026-09-17T09:59:30.000Z'));
  w.sqs.send(pricingHealth('syn-n-2', '2026-09-17T09:59:10.000Z'));
  w.sqs.send(aoc('syn-n-1', '2026-09-17T09:58:50.000Z'));
  await w.receiver.pollOnce();
  assert.deepEqual(w.delivered.map((d) => [d.id, d.type]), [['syn-n-1', 'ANY_OFFER_CHANGED'], ['syn-n-2', 'PRICING_HEALTH'], ['syn-n-3', 'ANY_OFFER_CHANGED']]);
  assert.deepEqual(w.delivered[0]!.delivery.claimed, { tenantId: 't-1', channelAccountId: 'a-1' });
  assert.equal(w.delivered[0]!.delivery.method, 'SQS');
});

test('authenticity: a foreign application, an unknown seller and an unparseable body never reach the decision path and are removed with an alert', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-f', '2026-09-17T09:59:00.000Z', { app: 'amzn1.sellerapps.app.someone-else' }));
  w.sqs.send(aoc('syn-n-u', '2026-09-17T09:59:00.000Z', { seller: 'A9UNKNOWNSELLER' }));
  w.sqs.send('not json');
  w.sqs.send(JSON.stringify({ NotificationType: 'ORDER_CHANGE', NotificationMetadata: { NotificationId: 'syn-n-o', ApplicationId: APP } }));
  const r = await w.receiver.pollOnce();
  assert.deepEqual(r.outcomes.map((o) => o.outcome).sort(), ['FOREIGN_APPLICATION', 'UNKNOWN_SELLER', 'UNPARSEABLE', 'UNSUPPORTED_TYPE']);
  assert.equal(w.delivered.length, 0);
  assert.equal(w.sqs.messages.length, 0);
  assert.deepEqual(w.alerts.map((a) => [a.code, a.severity]).sort(), [['NOTIFICATION_FOREIGN_APPLICATION', 'CRITICAL'], ['NOTIFICATION_UNKNOWN_SELLER', 'WARNING'], ['NOTIFICATION_UNPARSEABLE', 'CRITICAL']]);
  assert.ok(!JSON.stringify(w.alerts).includes('A9UNKNOWNSELLER'), 'the seller identifier of an unknown seller is not written to alerts');
});

test('a body corrupted in transit (MD5OfBody) is not deleted and comes back', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-c', '2026-09-17T09:59:00.000Z'), { corruptMd5: true });
  const r = await w.receiver.pollOnce();
  assert.deepEqual(r.outcomes.map((o) => o.outcome), ['CORRUPT']);
  assert.equal(w.sqs.messages.length, 1);
  assert.equal(w.delivered.length, 0);
});

test('loss: a processing failure keeps the message with a growing pause; after maxReceiveCount the receiver gives up with a critical alert', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-r', '2026-09-17T09:59:00.000Z'));
  w.failAfter(10);
  const pauses: number[] = [];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await w.receiver.pollOnce();
    assert.equal(r.outcomes[0]!.outcome, attempt < 5 ? 'RETRY' : 'GIVEN_UP', `attempt ${attempt}`);
    const m = w.sqs.messages[0]!;
    pauses.push(Math.round((m.visibleAtMs - w.clock.nowMs) / 1000));
    w.clock.nowMs = m.visibleAtMs;
  }
  assert.deepEqual(pauses.slice(0, 4), [30, 60, 120, 240], 'the pause doubles from retryBaseSeconds');
  assert.deepEqual(w.alerts.map((a) => a.code), ['NOTIFICATION_GIVING_UP']);
  assert.equal(w.delivered.length, 0);
});

test('loss of a delete: the message comes back after the visibility timeout and the ledger prevents a second processing', async () => {
  const w = world();
  w.sqs.send(aoc('syn-n-d', '2026-09-17T09:59:00.000Z'));
  w.sqs.failNextDelete = true;
  const first = await w.receiver.pollOnce();
  assert.deepEqual([first.outcomes[0]!.outcome, first.deleted, first.deleteFailed], ['DELIVERED', 0, 1]);
  w.clock.nowMs += 61_000;
  const again = await w.receiver.pollOnce();
  assert.deepEqual([again.outcomes[0]!.outcome, again.deleted], ['DUPLICATE', 1]);
  assert.equal(w.delivered.length, 1);
});

test('loss detection: a silent queue raises one warning per silence; a late notification is delivered with a warning for its tenant', async () => {
  const w = world();
  w.clock.nowMs += 31 * 60_000;
  assert.equal(await w.receiver.checkSilence(), true);
  assert.equal(await w.receiver.checkSilence(), false, 'one alert per silence');
  w.sqs.send(aoc('syn-n-l', '2026-09-17T10:00:00.000Z'), { sentMs: w.clock.nowMs - 20 * 60_000 });
  const r = await w.receiver.pollOnce();
  assert.deepEqual([r.outcomes[0]!.outcome, r.outcomes[0]!.late], ['DELIVERED', true]);
  assert.deepEqual(w.alerts.map((a) => [a.code, a.tenantId ?? null]), [['NOTIFICATION_QUEUE_SILENT', null], ['NOTIFICATION_LATE', 't-1']]);
  w.clock.nowMs += 31 * 60_000;
  assert.equal(await w.receiver.checkSilence(), true, 'a new silence after a message is alerted again');
});

test('a seller connected in two tenants receives the notification in each tenant separately; the ledger is per tenant', async () => {
  const w = world({ [SELLER]: [{ tenantId: 't-1', channelAccountId: 'a-1' }, { tenantId: 't-2', channelAccountId: 'a-2' }] });
  w.sqs.send(aoc('syn-n-2t', '2026-09-17T09:59:00.000Z'));
  await w.receiver.pollOnce();
  assert.deepEqual(w.delivered.map((d) => d.route.tenantId), ['t-1', 't-2']);
});

test('a queue error is reported without its message text and does not stop the receiver', async () => {
  const w = world();
  w.sqs.failNextReceive = 403;
  const r = await w.receiver.pollOnce();
  assert.equal(r.queueError, '403 OverLimit');
  w.sqs.send(aoc('syn-n-ok', '2026-09-17T09:59:00.000Z'));
  assert.equal((await w.receiver.pollOnce()).outcomes[0]!.outcome, 'DELIVERED');
});
