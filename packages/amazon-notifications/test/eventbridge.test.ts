import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { InboundDelivery } from '@repracer/channel-port';
import { createNotificationReceiver, type NotificationJournal, type NotificationLedger, type RawNotificationEntry, type SellerRoute } from '../src/receiver.ts';
import { createSqsClient } from '../src/sqs.ts';
import { FakeSqs } from '../src/testing.ts';

/**
 * Шаг 114: одна очередь — два конверта. ANY_OFFER_CHANGED и PRICING_HEALTH SP-API кладёт в очередь сам (тело — уведомление), уведомления
 * листингов приходят только через EventBridge: правило с целью-очередью кладёт в неё событие EventBridge, уведомление — в `detail`
 * (A-33: форма `detail` у SP-API не задокументирована — разбор строгий). Тела — формы примеров снимка (notification-type-values,
 * ListingsItemStatusChangeNotification.json), идентификаторы синтетические. Журнал сырья пишется до обработки; повтор доставки —
 * не ошибка и не дубль
 */
const QUEUE = 'https://sqs.us-east-1.amazonaws.com/000000000000/repracer-syn-notifications';
const APP = 'amzn1.sellerapps.app.syn0001';
const SELLER = 'A1SYNSELLER0001';
const SOURCE = `aws.partner/sellingpartnerapi.amazon.com/000000000000/${APP}`;

const meta = (id: string, at: string) => ({ ApplicationId: APP, SubscriptionId: 'syn-sub', PublishTime: at, NotificationId: id });

function statusChange(id: string, at: string, status: string[] = ['DISCOVERABLE']) {
  return {
    NotificationVersion: '1.0', NotificationType: 'LISTINGS_ITEM_STATUS_CHANGE', PayloadVersion: '1.0', EventTime: at,
    Payload: { SellerId: SELLER, MarketplaceId: 'ATVPDKIKX0DER', Asin: 'B0SYN00001', Sku: 'SYN-SKU-1', CreatedDate: '2026-09-01T10:00:00.000Z', Status: status },
    NotificationMetadata: meta(id, at),
  };
}

function issuesChange(id: string, at: string) {
  return {
    NotificationVersion: '1.0', NotificationType: 'LISTINGS_ITEM_ISSUES_CHANGE', PayloadVersion: '2023-12-13', EventTime: at,
    Payload: { SellerId: SELLER, MarketplaceId: 'ATVPDKIKX0DER', Asin: 'B0SYN00001', Sku: 'SYN-SKU-1', Severities: ['ERROR'], EnforcementActions: ['LISTING_SUPPRESSED'] },
    NotificationMetadata: meta(id, at),
  };
}

/** Событие EventBridge (AWS Events Reference, «Event structure»): метаданные события и уведомление в `detail` */
function eventBridge(notification: Record<string, unknown>, over: { detailType?: string; source?: string; detail?: unknown } = {}): string {
  return JSON.stringify({
    version: '0', id: `syn-event-${String(notification.NotificationMetadata && (notification.NotificationMetadata as { NotificationId: string }).NotificationId)}`,
    'detail-type': over.detailType ?? notification.NotificationType, source: over.source ?? SOURCE, account: '000000000000',
    time: notification.EventTime, region: 'us-east-1', resources: [], detail: 'detail' in over ? over.detail : notification,
  });
}

function aoc(id: string, at: string): string {
  return JSON.stringify({
    NotificationVersion: '1.0', NotificationType: 'ANY_OFFER_CHANGED', PayloadVersion: '1.0', EventTime: at,
    Payload: { AnyOfferChangedNotification: { SellerId: SELLER, OfferChangeTrigger: { MarketplaceId: 'ATVPDKIKX0DER', ASIN: 'B0SYN00001', ItemCondition: 'new', TimeOfOfferChange: at } } },
    NotificationMetadata: meta(id, at),
  });
}

function world() {
  const clock = { nowMs: Date.parse('2026-11-05T10:00:00.000Z') };
  const sqs = new FakeSqs(clock);
  const processed = new Set<string>();
  const ledger: NotificationLedger = {
    async wasProcessed(route, id) { return processed.has(`${route.tenantId}|${id}`); },
    async markProcessed(route, e) { processed.add(`${route.tenantId}|${e.notificationId}`); },
  };
  const journal: Array<RawNotificationEntry & { tenantId: string }> = [];
  const notificationJournal: NotificationJournal = {
    async record(route, entry) {
      if (journal.some((j) => j.tenantId === route.tenantId && j.notificationId === entry.notificationId)) return 'REPEAT';
      journal.push({ ...entry, tenantId: route.tenantId });
      return 'NEW';
    },
  };
  const delivered: Array<{ delivery: InboundDelivery; type: string; id: string }> = [];
  const alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }> = [];
  let failures = 0;
  const receiver = createNotificationReceiver({
    sqs: createSqsClient({ queueUrl: QUEUE, credentials: async () => ({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE' }), fetch: sqs.fetch, now: () => new Date(clock.nowMs) }),
    queueUrl: QUEUE, region: 'NA', applicationId: APP,
    router: { resolve: async (region, sellerId) => (region === 'NA' && sellerId === SELLER ? [{ tenantId: 't-1', channelAccountId: 'a-1' } satisfies SellerRoute] : []) },
    ledger, journal: notificationJournal,
    sink: { async deliver(_route, delivery, e) {
      if (failures > 0) { failures -= 1; throw new Error('database unavailable'); }
      delivered.push({ delivery, type: e.notificationType, id: e.notificationId });
      return 'ACCEPTED';
    } },
    alerts: { raise: async (a) => { alerts.push(a as never); } },
    logger: { log: () => {} },
    now: () => new Date(clock.nowMs),
    policy: { waitTimeSeconds: 0 },
  });
  return { clock, sqs, receiver, delivered, alerts, journal, failNext: (n: number) => { failures = n; } };
}

test('step 114: one queue, two envelopes — a listing notification inside an EventBridge event and ANY_OFFER_CHANGED put by SP-API itself are both delivered, by EventTime', async () => {
  const w = world();
  w.sqs.send(eventBridge(statusChange('syn-n-2', '2026-11-05T09:59:20.000Z')));
  w.sqs.send(aoc('syn-n-1', '2026-11-05T09:59:10.000Z'));
  w.sqs.send(eventBridge(issuesChange('syn-n-3', '2026-11-05T09:59:30.000Z')));
  const report = await w.receiver.pollOnce();
  assert.deepEqual(report.outcomes.map((o) => o.outcome), ['DELIVERED', 'DELIVERED', 'DELIVERED']);
  assert.deepEqual(w.delivered.map((d) => [d.id, d.type]), [['syn-n-1', 'ANY_OFFER_CHANGED'], ['syn-n-2', 'LISTINGS_ITEM_STATUS_CHANGE'], ['syn-n-3', 'LISTINGS_ITEM_ISSUES_CHANGE']]);
  // Путь решения получает уведомление SP-API, а не событие EventBridge: адаптер знает только формат SP-API
  const listing = JSON.parse(w.delivered[1]!.delivery.rawBody) as Record<string, unknown>;
  assert.equal(listing.NotificationType, 'LISTINGS_ITEM_STATUS_CHANGE');
  assert.equal('detail' in listing, false);
  assert.equal(w.delivered[1]!.delivery.headers['x-repracer-envelope'], 'EVENTBRIDGE');
  assert.equal(w.delivered[0]!.delivery.headers['x-repracer-envelope'], 'SQS');
  assert.equal(w.sqs.messages.length, 0);
});

test('step 114: the raw journal keeps the message body as it came from the queue, with its envelope, before the decision path sees it', async () => {
  const w = world();
  const body = eventBridge(statusChange('syn-n-1', '2026-11-05T09:59:00.000Z'));
  w.sqs.send(body);
  w.failNext(1);
  const first = await w.receiver.pollOnce();
  assert.deepEqual(first.outcomes.map((o) => o.outcome), ['RETRY']);
  // Обработка упала — сырьё уже в журнале, сообщение осталось в очереди
  assert.deepEqual(w.journal.map((j) => [j.notificationId, j.notificationType, j.envelope, j.rawBody === body]), [['syn-n-1', 'LISTINGS_ITEM_STATUS_CHANGE', 'EVENTBRIDGE', true]]);
  assert.equal(w.sqs.messages.length, 1);
  w.clock.nowMs += 60_000;
  const second = await w.receiver.pollOnce();
  assert.deepEqual(second.outcomes.map((o) => [o.outcome, o.journal]), [['DELIVERED', 'REPEAT']]);
  assert.equal(w.journal.length, 1, 'the second delivery is not a second row');
  assert.equal(w.delivered.length, 1);
});

test('step 114: a repeated delivery — in the same batch, in a later batch, in the other envelope — is neither an error nor a duplicate', async () => {
  const w = world();
  const n = statusChange('syn-n-1', '2026-11-05T09:59:00.000Z');
  w.sqs.send(eventBridge(n));
  w.sqs.send(eventBridge(n));
  const first = await w.receiver.pollOnce();
  assert.deepEqual(first.outcomes.map((o) => [o.outcome, o.journal]), [['DELIVERED', 'NEW'], ['DUPLICATE', 'REPEAT']]);
  w.sqs.send(JSON.stringify(n));
  const later = await w.receiver.pollOnce();
  assert.deepEqual(later.outcomes.map((o) => [o.outcome, o.journal]), [['DUPLICATE', 'REPEAT']]);
  assert.equal(w.journal.length, 1);
  assert.equal(w.delivered.length, 1);
  assert.equal(w.alerts.length, 0, 'a repeat raises nothing');
  assert.equal(w.sqs.messages.length, 0);
});

test('step 114 (A-33): an EventBridge event the receiver does not understand is refused with a critical alert naming the problem and the keys of detail — never guessed', async () => {
  const w = world();
  const n = statusChange('syn-n-1', '2026-11-05T09:59:00.000Z');
  w.sqs.send(eventBridge(n, { detailType: 'LISTINGS_ITEM_ISSUES_CHANGE' }));
  w.sqs.send(eventBridge(n, { source: 'aws.partner/other-partner.com/000000000000/x' }));
  w.sqs.send(eventBridge(n, { detail: { payload: { sku: 'SYN-SKU-1' }, kind: 'unknown' } }));
  w.sqs.send(eventBridge(n, { detail: 'not an object' }));
  const report = await w.receiver.pollOnce();
  assert.deepEqual(report.outcomes.map((o) => o.outcome), ['UNPARSEABLE', 'UNPARSEABLE', 'UNPARSEABLE', 'UNPARSEABLE']);
  assert.deepEqual(w.alerts.map((a) => [a.code, a.severity, a.details.problem]), [
    ['NOTIFICATION_UNPARSEABLE', 'CRITICAL', 'EVENTBRIDGE_TYPE_MISMATCH'],
    ['NOTIFICATION_UNPARSEABLE', 'CRITICAL', 'EVENTBRIDGE_FOREIGN_SOURCE'],
    ['NOTIFICATION_UNPARSEABLE', 'CRITICAL', 'NO_TYPE'],
    ['NOTIFICATION_UNPARSEABLE', 'CRITICAL', 'EVENTBRIDGE_NO_DETAIL'],
  ]);
  // Ключи `detail` — для разбора A-33 на живой очереди; значений в алерте нет
  assert.equal(w.alerts[2]!.details.detailKeys, 'kind,payload');
  assert.equal(JSON.stringify(w.alerts).includes('SYN-SKU-1'), false);
  assert.deepEqual([w.delivered.length, w.journal.length], [0, 0]);
});
