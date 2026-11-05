import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAccountId, InboundDelivery, TenantId } from '@repracer/channel-port';
import { createAmazonAdapter } from '../src/index.ts';

/**
 * Шаг 114: одно наблюдение «статус и проблемы листинга» из трёх источников — уведомление (LISTINGS_ITEM_STATUS_CHANGE 1.0,
 * LISTINGS_ITEM_ISSUES_CHANGE 2023-12-13), обратное чтение (getListingsItem: сводка витрины и issues) и обнаружение (searchListingsItems:
 * сводка витрины). Тела — формы примеров снимка (notification-type-values, ListingsItemStatusChangeNotification.json, модель
 * listingsItems_2021-08-01), идентификаторы синтетические
 */
const US = 'ATVPDKIKX0DER';
const CA = 'A2EUQ1WTGCTBG2';
const NOW = '2026-11-05T10:00:00.000Z';
const SELLER = 'SYN_SELLER';
const ctx = { tenantId: '10000000-0000-4000-8000-000000000001' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000001' as ChannelAccountId, correlationId: 'unit', deadline: '2026-11-05T10:05:00.000Z' };

function harness(reply: (path: string) => unknown = () => ({})) {
  const alerts: string[] = [];
  let ticks = 0;
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === '/auth/o2/token') return new Response(JSON.stringify({ access_token: 'syn-lwa-access-token', expires_in: 3600 }), { status: 200 });
    return new Response(JSON.stringify(reply(url.pathname)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createAmazonAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', externalAccountId: SELLER, region: 'NA', marketplaces: [US], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (ref): Promise<Record<string, string>> => (ref === 'cred:seller' ? { refreshToken: 'syn-refresh' } : { clientId: 'syn-client', clientSecret: 'syn-secret' }) },
      alerts: { raise: async (a) => { alerts.push(`${a.code}:${a.severity}`); } },
      logger: { log: () => {} },
      now: () => new Date(Date.parse(NOW) + (ticks += 1_000)).toISOString(),
    },
    userAgent: 'repracer-test/1.0', applicationCredentialsRef: 'cred:app', fetch: fetchFn, endpoints: { NA: 'https://sp-api.invalid' }, timeoutMs: 1000,
  });
  return { adapter, alerts };
}

const meta = (id: string) => ({ ApplicationId: 'amzn1.sellerapps.app.syn0001', SubscriptionId: 'syn-sub', PublishTime: '2026-11-05T09:59:30.194Z', NotificationId: id });
const status = (id: string, values: unknown, over: Record<string, unknown> = {}) => ({
  NotificationVersion: '1.0', NotificationType: 'LISTINGS_ITEM_STATUS_CHANGE', PayloadVersion: '1.0', EventTime: '2026-11-05T09:59:30.194Z',
  Payload: { SellerId: SELLER, MarketplaceId: US, Asin: 'B0SYN00114', Sku: 'SYN-SKU-114', CreatedDate: '2026-09-01T10:00:00.000Z', Status: values, ...over },
  NotificationMetadata: meta(id),
});
const issues = (id: string, payloadVersion = '2023-12-13') => ({
  NotificationVersion: '1.0', NotificationType: 'LISTINGS_ITEM_ISSUES_CHANGE', PayloadVersion: payloadVersion, EventTime: '2026-11-05T09:59:40.000Z',
  Payload: { SellerId: SELLER, MarketplaceId: US, Asin: 'B0SYN00114', Sku: 'SYN-SKU-114', Severities: ['ERROR', 'WARNING'], EnforcementActions: ['LISTING_SUPPRESSED', 'SEARCH_SUPPRESSED'] },
  NotificationMetadata: meta(id),
});
const delivery = (body: unknown): InboundDelivery => ({
  claimed: { tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId }, method: 'SQS', url: 'https://sqs.us-east-1.amazonaws.com/000000000000/q',
  headers: {}, rawBody: JSON.stringify(body), receivedAt: NOW,
});

test('step 114: LISTINGS_ITEM_STATUS_CHANGE becomes a listing status observation — no BUYABLE means not buyable; both spellings of the type', async () => {
  const { adapter } = harness();
  const buyable = await adapter.handleInbound(delivery(status('syn-n-1', ['BUYABLE', 'DISCOVERABLE'])));
  assert.equal(buyable.kind, 'EVENTS');
  assert.deepEqual(buyable.kind === 'EVENTS' ? buyable.events : null, [{ kind: 'LISTING_STATUS', listing: {
    marketplace: US, externalSku: 'SYN-SKU-114', channelProductRef: 'B0SYN00114', observedAt: '2026-11-05T09:59:30.194Z', source: 'NOTIFICATION', sourceEventId: 'syn-n-1',
    status: { buyable: true, discoverable: true, deleted: false }, issues: null,
  } }]);
  // Схема снимка перечисляет тип как LISTINGS_ITEM_STATUS_CHANGED — тот же тип
  const notBuyable = await adapter.handleInbound(delivery({ ...status('syn-n-2', ['DISCOVERABLE']), NotificationType: 'LISTINGS_ITEM_STATUS_CHANGED' }));
  assert.deepEqual(notBuyable.kind === 'EVENTS' && notBuyable.events[0]?.kind === 'LISTING_STATUS' ? notBuyable.events[0].listing.status : null, { buyable: false, discoverable: true, deleted: false });
  const deleted = await adapter.handleInbound(delivery(status('syn-n-3', ['DELETED'])));
  assert.deepEqual(deleted.kind === 'EVENTS' && deleted.events[0]?.kind === 'LISTING_STATUS' ? deleted.events[0].listing.status : null, { buyable: false, discoverable: false, deleted: true });
});

test('step 114: LISTINGS_ITEM_ISSUES_CHANGE 2023-12-13 becomes the issues part of the same observation; payload 1.0 is refused (we subscribe to 2023-12-13)', async () => {
  const { adapter } = harness();
  const r = await adapter.handleInbound(delivery(issues('syn-n-4')));
  assert.deepEqual(r.kind === 'EVENTS' && r.events[0]?.kind === 'LISTING_STATUS' ? r.events[0].listing : null, {
    marketplace: US, externalSku: 'SYN-SKU-114', channelProductRef: 'B0SYN00114', observedAt: '2026-11-05T09:59:40.000Z', source: 'NOTIFICATION', sourceEventId: 'syn-n-4',
    status: null, issues: { severities: ['ERROR', 'WARNING'], enforcementActions: ['LISTING_SUPPRESSED', 'SEARCH_SUPPRESSED'] },
  });
  assert.equal((await adapter.handleInbound(delivery(issues('syn-n-5', '1.0')))).kind, 'REJECTED');
});

test('step 114: a listing notification of another seller is refused with a critical alert [Р-31]; a storefront not on the account is ignored; a malformed one is refused', async () => {
  const { adapter, alerts } = harness();
  const foreign = await adapter.handleInbound(delivery(status('syn-n-6', ['BUYABLE'], { SellerId: 'A1OTHERSELLER' })));
  assert.equal(foreign.kind, 'REJECTED');
  assert.deepEqual(alerts, ['AMAZON_NOTIFICATION_SELLER_MISMATCH:CRITICAL']);
  const elsewhere = await adapter.handleInbound(delivery(status('syn-n-7', ['BUYABLE'], { MarketplaceId: CA })));
  assert.deepEqual(elsewhere.kind === 'EVENTS' ? elsewhere.events : null, []);
  for (const bad of [status('syn-n-8', ['BUYABLE'], { Sku: undefined }), status('syn-n-9', 'BUYABLE'), status('syn-n-10', ['buyable now!'])]) {
    assert.equal((await adapter.handleInbound(delivery(bad))).kind, 'REJECTED', JSON.stringify(bad.Payload));
  }
});

test('step 114: readback after a write and discovery carry the listing status of the storefront — readback with its issues, discovery without', async () => {
  const listing = {
    sku: 'SYN-SKU-114',
    summaries: [{ marketplaceId: US, asin: 'B0SYN00114', productType: 'SYN_TYPE', status: ['DISCOVERABLE'], createdDate: NOW, lastUpdatedDate: NOW }],
    attributes: { purchasable_offer: [{ marketplace_id: US, currency: 'USD', audience: 'ALL', our_price: [{ schedule: [{ value_with_tax: 12.99 }] }] }] },
    offers: [{ marketplaceId: US, offerType: 'B2C', price: { currencyCode: 'USD', amount: '12.99' } }],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'DEFAULT', quantity: 4 }],
    issues: [
      { code: '90220', message: 'synthetic', severity: 'ERROR', categories: ['INVALID_PRICE'], marketplaceIds: [US], enforcements: { actions: [{ action: 'LISTING_SUPPRESSED' }], exemption: { status: 'NOT_EXEMPT' } } },
      { code: '18027', message: 'synthetic', severity: 'WARNING', categories: [], marketplaceIds: [CA], enforcements: { actions: [{ action: 'SEARCH_SUPPRESSED' }], exemption: { status: 'NOT_EXEMPT' } } },
    ],
  };
  const { adapter } = harness((path) => (path.endsWith('/SYN-SKU-114') ? listing : { numberOfResults: 1, items: [listing] }));
  const scope = { writeScopeId: 'ws-1' as never, field: 'PRICE' as const, scopeKey: 'syn|PRICE', identity: { region: 'NA', marketplace: US, externalSku: 'SYN-SKU-114' } };
  const read = await adapter.readBack(ctx, [{ writeScope: scope, fields: ['PRICE'] }]);
  assert.deepEqual(read.observations[0]?.listingStatus, {
    status: { buyable: false, discoverable: true, deleted: false },
    // Только проблемы своей витрины: SEARCH_SUPPRESSED — у Канады
    issues: { severities: ['ERROR'], enforcementActions: ['LISTING_SUPPRESSED'] },
  });
  const page = await adapter.discoverOffers(ctx, { limit: 20 });
  assert.deepEqual(page.items[0]?.listingStatus, { status: { buyable: false, discoverable: true, deleted: false }, issues: null });
  // Без проблем у своей витрины — NONE, как у уведомления
  const clean = harness(() => ({ ...listing, summaries: [{ ...listing.summaries[0], status: ['BUYABLE', 'DISCOVERABLE'] }], issues: [] }));
  const ok = await clean.adapter.readBack(ctx, [{ writeScope: scope, fields: ['PRICE'] }]);
  assert.deepEqual(ok.observations[0]?.listingStatus, { status: { buyable: true, discoverable: true, deleted: false }, issues: { severities: ['NONE'], enforcementActions: [] } });
});
