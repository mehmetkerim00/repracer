import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { ListingStatusObservation } from '@repracer/channel-port';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { inTenant, PgPricingStore, PgWriteQueueStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 114 в базе (0213): журнал сырья уведомлений — одна строка на уведомление, повтор доставки — REPEAT, не ошибка; наблюдение «статус
 * и проблемы листинга» — уведомление пишется всегда, опрос — только изменение, «перестало продаваться» — у включённого предложения и
 * один раз на переход. Формы держит база, каждая — своей проверкой с причиной отказа [Р-94, Р-99]. Данные синтетические.
 */
const ACCOUNT = '20000000-0000-4000-8000-000000001141';
const TENANT = '10000000-0000-4000-8000-000000001141';
const T0 = '2026-11-05T10:00:00.000Z';
const MATCH = { strategyId: 'strat-114', version: 1, params: { type: 'FIXED', priceMinor: 1900 }, deadbandMinor: 0 } as never;

let db: IsolatedDatabase;
let app: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

function scope(n: number, engine: boolean): MemorySeedScope {
  return {
    writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(11400 + n), channelProductRef: `11414${n}`,
    condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: engine ? 'ENGINE' : 'OFF', strategy: engine ? MATCH : null, ...(engine ? { cost: engineCost() } : {}),
    currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
  };
}

before(async () => {
  db = await createIsolatedDatabase('notify114');
  app = db.pool('svc_app', 3);
  world = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: T0, seed: { scopes: [scope(1, true), scope(2, false)] },
  });
  store = new PgPricingStore(app, { adminPool: db.pool('svc_admin', 2) });
});
after(async () => { await db?.drop(); });

const account = () => world.ids.dbId(ACCOUNT);
const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));
const raw = (id: string, over: Partial<{ envelope: string; type: string; body: string }> = {}) => outcome(inTenant(app, world.tenantId, (tx) => tx.query(
  `INSERT INTO channel_data.notification_journal (tenant_id, channel_account_id, channel, notification_id, notification_type, envelope, event_time, received_at, raw_body)
   VALUES ($1, $2, 'KAUFLAND', $3, $4, $5, now(), now(), $6)`, [world.tenantId, account(), id, over.type ?? 'LISTINGS_ITEM_STATUS_CHANGE', over.envelope ?? 'SQS', over.body ?? '{}'])));
const listingRow = (cols: Record<string, unknown>) => {
  const all = { source: 'DISCOVERY', notification_id: null, buyable: true, discoverable: true, deleted: false, severities: null, enforcement_actions: null, external_sku: '11401', ...cols };
  const names = Object.keys(all);
  return outcome(inTenant(app, world.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.listing_status (tenant_id, channel_account_id, channel, marketplace, observed_at, ${names.join(', ')})
     VALUES ($1, $2, 'KAUFLAND', 'de', now(), ${names.map((_, i) => `$${i + 3}`).join(', ')})`, [world.tenantId, account(), ...Object.values(all)])));
};

const obs = (sku: string, over: Partial<ListingStatusObservation>): ListingStatusObservation => ({
  marketplace: 'de', externalSku: sku, channelProductRef: null, observedAt: T0, source: 'DISCOVERY', sourceEventId: null,
  status: { buyable: true, discoverable: true, deleted: false }, issues: null, ...over,
});
const rowsOf = (sku: string) => db.rows<{ source: string; buyable: boolean | null }>(
  `SELECT source, buyable FROM channel_data.listing_status WHERE tenant_id = $1 AND external_sku = $2 ORDER BY recorded_at, observed_at`, [world.tenantId, sku]);

test('step 114: the raw journal keeps one row per notification — a repeated delivery is REPEAT, not an error and not a second row', async () => {
  const entry = { channelAccountId: account(), notificationId: 'syn-n-114-1', notificationType: 'LISTINGS_ITEM_STATUS_CHANGE', envelope: 'EVENTBRIDGE' as const,
    eventTime: T0, receivedAt: T0, rawBody: '{"version":"0","detail":{}}' };
  assert.equal(await store.recordInboundNotification(world.tenantId, entry), 'NEW');
  assert.equal(await store.recordInboundNotification(world.tenantId, entry), 'REPEAT');
  assert.equal(await store.recordInboundNotification(world.tenantId, { ...entry, envelope: 'SQS', rawBody: '{}' }), 'REPEAT', 'the same notification in the other envelope');
  const rows = await db.rows<{ raw_body: string; envelope: string }>(`SELECT raw_body, envelope FROM channel_data.notification_journal WHERE notification_id = 'syn-n-114-1'`);
  assert.deepEqual(rows, [{ raw_body: entry.rawBody, envelope: 'EVENTBRIDGE' }], 'the body as it came, from the first delivery');
  const sources = await store.notificationSources(world.tenantId, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(sources.map((s) => [s.channelAccountId === account(), s.last24h]), [[true, [{ notificationType: 'LISTINGS_ITEM_STATUS_CHANGE', count: 1 }]]]);
});

test('step 114: the database keeps the form of the raw journal', async () => {
  assert.equal(await raw('syn-n-114-f1'), 'accepted');
  assert.match(await raw('syn-n-114-f1'), /notification_journal_once/, 'a second row of the same notification is refused');
  assert.match(await raw('syn-n-114-f2', { envelope: 'SNS' }), /notification_journal_envelope_known/, 'an unknown envelope is refused');
  assert.match(await raw('syn n 114 f3'), /notification_journal_ids_form/, 'a notification id outside the receiver form is refused');
  assert.match(await raw('syn-n-114-f4', { type: 'listings item' }), /notification_journal_ids_form/, 'a notification type that is not a channel word is refused');
  assert.match(await raw('syn-n-114-f5', { body: 'x'.repeat(1_048_577) }), /notification_journal_body_size/, 'a body over a megabyte is refused');
});

test('step 114: polling writes a listing status only when it changes; an enabled offer that stops selling is named once', async () => {
  const first = await store.recordListingStatus(world.tenantId, account(), [obs('11401', {}), obs('11402', {})]);
  assert.deepEqual([first.recorded, first.lostBuyable], [2, []]);
  const same = await store.recordListingStatus(world.tenantId, account(), [obs('11401', { observedAt: '2026-11-05T11:00:00.000Z' })]);
  assert.equal(same.recorded, 0, 'an unchanged status is not a second row');
  const gone = { status: { buyable: false, discoverable: true, deleted: false } };
  const lost = await store.recordListingStatus(world.tenantId, account(), [obs('11401', { ...gone, observedAt: '2026-11-05T12:00:00.000Z' }),
    obs('11402', { ...gone, observedAt: '2026-11-05T12:00:00.000Z' })]);
  assert.deepEqual(lost.lostBuyable, [{ marketplace: 'de', externalSku: '11401' }], 'only the enabled offer (ENGINE) is named');
  // Через диспетчер (обратное чтение) — то же правило: неизменное «не покупается» перехода не даёт
  const again = await new PgWriteQueueStore(app).recordListingStatus(world.tenantId, account(), [obs('11401', { ...gone, source: 'READBACK', observedAt: '2026-11-05T13:00:00.000Z' })]);
  assert.deepEqual(again.lostBuyable, []);
  assert.deepEqual((await rowsOf('11401')).map((r) => [r.source, r.buyable]), [['DISCOVERY', true], ['DISCOVERY', false]]);
});

test('step 114: a notification is always written, once — its repeat is a duplicate notification; a late one lies in the journal without a transition', async () => {
  const note = (id: string, observedAt: string, buyable: boolean): [ListingStatusObservation, { channelAccountId: string; notificationId: string; notificationType: string; eventTime: string; receivedAt: string }] => [
    obs('11401', { source: 'NOTIFICATION', sourceEventId: id, observedAt, status: { buyable, discoverable: true, deleted: false } }),
    { channelAccountId: account(), notificationId: id, notificationType: 'LISTINGS_ITEM_STATUS_CHANGE', eventTime: observedAt, receivedAt: '2026-11-05T14:00:00.000Z' },
  ];
  const [back, backEntry] = note('syn-n-114-s1', '2026-11-05T14:00:00.000Z', true);
  assert.deepEqual(await store.recordListingStatus(world.tenantId, account(), [back], backEntry), { recorded: 1, duplicateNotification: false, lostBuyable: [] });
  assert.deepEqual(await store.recordListingStatus(world.tenantId, account(), [back], backEntry), { recorded: 0, duplicateNotification: true, lostBuyable: [] });
  // Опоздавшее уведомление (старше записанного «покупается») — в журнал, перехода нет
  const [late, lateEntry] = note('syn-n-114-s2', '2026-11-05T13:30:00.000Z', false);
  assert.deepEqual(await store.recordListingStatus(world.tenantId, account(), [late], lateEntry), { recorded: 1, duplicateNotification: false, lostBuyable: [] });
  const [down, downEntry] = note('syn-n-114-s3', '2026-11-05T15:00:00.000Z', false);
  assert.deepEqual((await store.recordListingStatus(world.tenantId, account(), [down], downEntry)).lostBuyable, [{ marketplace: 'de', externalSku: '11401' }]);
  // Мир консоли — последнее по времени события
  const w = await store.readConsoleState(world.tenantId, '2026-11-05T16:00:00.000Z') as unknown as { listingStatus: Array<{ externalSku: string; buyable: boolean; source: string }> };
  assert.deepEqual(w.listingStatus.filter((l) => l.externalSku === '11401').map((l) => [l.buyable, l.source]), [[false, 'NOTIFICATION']]);
});

test('step 114: the database keeps the form of a listing status observation', async () => {
  assert.equal(await listingRow({}), 'accepted');
  assert.match(await listingRow({ source: 'REPORT' }), /listing_status_source_known/, 'an unknown source is refused');
  assert.match(await listingRow({ source: 'NOTIFICATION' }), /listing_status_notification_ref/, 'a notification observation without its notification id is refused');
  assert.match(await listingRow({ notification_id: 'syn-n-114-x' }), /listing_status_notification_ref/, 'a polled observation with a notification id is refused');
  assert.match(await listingRow({ deleted: null }), /listing_status_parts/, 'a status with a missing flag is refused');
  assert.match(await listingRow({ buyable: null, discoverable: null, deleted: null }), /listing_status_parts/, 'an observation with neither status nor issues is refused');
  assert.match(await listingRow({ severities: ['ERROR'] }), /listing_status_parts/, 'issues without their enforcement actions are refused');
  assert.match(await listingRow({ severities: ['FATAL'], enforcement_actions: [] }), /listing_status_issue_values/, 'an unknown severity is refused');
  assert.match(await listingRow({ severities: ['ERROR'], enforcement_actions: ['listing suppressed'] }), /listing_status_issue_values/, 'an enforcement action that is not a channel word is refused');
  assert.match(await listingRow({ external_sku: 'SKU\n1' }), /listing_status_sku_form/, 'a SKU with a control character is refused');
  assert.equal(await listingRow({ source: 'NOTIFICATION', notification_id: 'syn-n-114-u' }), 'accepted');
  assert.match(await listingRow({ source: 'NOTIFICATION', notification_id: 'syn-n-114-u' }), /listing_status_once_per_notification/, 'a second observation of the same notification is refused');
  const policy = await db.rows<{ table_name: string; retention: string }>(`SELECT table_name::text, retention::text FROM maintenance.retention_policy
    WHERE table_name::text IN ('channel_data.notification_journal', 'channel_data.listing_status') ORDER BY 1`);
  assert.deepEqual(policy, [{ table_name: 'channel_data.listing_status', retention: '1 year 6 mons' }, { table_name: 'channel_data.notification_journal', retention: '16 days' }]);
});
