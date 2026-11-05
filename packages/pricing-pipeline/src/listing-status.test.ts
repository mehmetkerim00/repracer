import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAdapter, InboundDelivery, ListingStatusFacts } from '@repracer/channel-port';
import { listingStatusStep } from './listing-status.ts';
import { InMemoryPricingStore, type MemorySeedScope } from './memory-store.ts';
import { createPricingPipeline } from './pipeline.ts';

/**
 * Шаг 114: уведомление листинга становится тем же внутренним событием, что даёт опрос. Обнаружение каталога и уведомление о том же
 * состоянии пишут одно и то же наблюдение одним путём (recordListingStatus) и поднимают один и тот же CRITICAL; путь решения о цене
 * не меняется — ни одного решения. Хранилище в памяти, данные синтетические
 */
const ACCOUNT = 'acc-amazon';
const NOW = '2026-11-05T10:00:00.000Z';
const scope = (n: number, engine: boolean): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'ATVPDKIKX0DER', externalUnitId: `SYN-SKU-${n}`, channelProductRef: `B0SYN0000${n}`,
  condition: 'new', currency: 'USD', basis: 'NET', pricingMode: engine ? 'ENGINE' : 'OFF',
  strategy: engine ? { strategyId: 'st', version: 1, params: { type: 'FIXED', priceMinor: 1900 }, deadbandMinor: 0 } as never : null,
  currentPriceMinor: 1900, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
});
const NOT_BUYABLE: ListingStatusFacts = { status: { buyable: false, discoverable: true, deleted: false }, issues: null };

function harness(listingStatus: ListingStatusFacts) {
  const store = new InMemoryPricingStore({ channel: 'AMAZON', region: 'NA', scopes: [scope(1, true), scope(2, false)] } as never);
  const alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }> = [];
  const adapter = {
    descriptor: { channel: 'AMAZON' },
    async discoverOffers() {
      return { items: [1, 2].map((n) => ({ identity: { region: 'NA', marketplace: 'ATVPDKIKX0DER', externalSku: `SYN-SKU-${n}`, channelProductRef: `B0SYN0000${n}` },
        gtins: [], condition: 'new', fulfillment: 'MERCHANT', listingStatus })) };
    },
    async handleInbound(d: InboundDelivery) {
      const sku = JSON.parse(d.rawBody).sku as string;
      return { kind: 'EVENTS', deliveryId: d.notification!.notificationId, acknowledgeStatus: 200, events: [{ kind: 'LISTING_STATUS', listing: {
        marketplace: 'ATVPDKIKX0DER', externalSku: sku, channelProductRef: null, observedAt: NOW, source: 'NOTIFICATION', sourceEventId: d.notification!.notificationId, ...listingStatus,
      } }] };
    },
  } as unknown as ChannelAdapter;
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { alerts.push(a as never); } }, logger: { log: () => undefined }, now: () => NOW as never });
  const ctx = { tenantId: 't' as never, channelAccountId: ACCOUNT as never, correlationId: 'step114', deadline: '2026-11-05T10:05:00.000Z' as never };
  const notify = (id: string, sku: string) => pipeline.processInbound({
    claimed: { tenantId: 't' as never, channelAccountId: ACCOUNT as never }, method: 'SQS', url: 'q', headers: {}, rawBody: JSON.stringify({ sku }), receivedAt: NOW,
    notification: { notificationId: id, notificationType: 'LISTINGS_ITEM_STATUS_CHANGE', eventTime: NOW },
  });
  return { store, alerts, pipeline, ctx, notify };
}

const critical = (alerts: Array<{ code: string; severity: string; details: Record<string, unknown> }>) =>
  alerts.filter((a) => a.code === 'LISTING_NOT_BUYABLE').map((a) => [a.severity, a.details.externalSku]);

test('step 114: polling and a notification about the same state write the same observation and raise the same alert — only for the enabled offer, once', async () => {
  const polled = harness(NOT_BUYABLE);
  await polled.pipeline.discoverOffers(polled.ctx, { pageLimit: 20 });
  await polled.pipeline.discoverOffers(polled.ctx, { pageLimit: 20 });
  assert.deepEqual(critical(polled.alerts), [['CRITICAL', 'SYN-SKU-1']], 'the second scan of an unchanged state raises nothing');
  assert.equal(polled.store.listingStatus.length, 2, 'two offers, one row each — the second scan writes nothing');

  const pushed = harness(NOT_BUYABLE);
  const first = await pushed.notify('syn-n-1', 'SYN-SKU-1');
  assert.deepEqual([first.notification, first.listingStatus], ['RECORDED', 1]);
  assert.equal((await pushed.notify('syn-n-1', 'SYN-SKU-1')).notification, 'DUPLICATE', 'a repeated notification is not a second observation');
  await pushed.notify('syn-n-2', 'SYN-SKU-2');
  assert.deepEqual(critical(pushed.alerts), critical(polled.alerts), 'the same alert from either source');
  const shape = (s: InMemoryPricingStore) => s.listingStatus.map(({ source: _s, sourceEventId: _e, observedAt: _o, channelProductRef: _r, ...rest }) => rest);
  assert.deepEqual(shape(pushed.store), shape(polled.store), 'the same observation, whatever the source');
  // Путь решения о цене не тронут: статус листинга решений не рождает
  assert.equal((await pushed.store.dump() as { decisions?: unknown[] }).decisions?.length ?? 0, 0);
});

test('step 114: the rule — polling writes only a change, a notification always; a late status gives no transition', () => {
  const at = (t: string) => ({ value: { buyable: true, discoverable: true, deleted: false }, observedAt: t });
  const o = (source: 'DISCOVERY' | 'NOTIFICATION', buyable: boolean, observedAt = NOW) => ({ marketplace: 'm', externalSku: 's', channelProductRef: null, observedAt, source,
    sourceEventId: source === 'NOTIFICATION' ? 'n' : null, status: { buyable, discoverable: true, deleted: false }, issues: null });
  assert.deepEqual(listingStatusStep(o('DISCOVERY', true), { status: at(NOW), issues: null }), { write: false, lostBuyable: false });
  assert.deepEqual(listingStatusStep(o('NOTIFICATION', true), { status: at(NOW), issues: null }), { write: true, lostBuyable: false });
  assert.deepEqual(listingStatusStep(o('DISCOVERY', false), { status: at(NOW), issues: null }), { write: true, lostBuyable: true });
  assert.deepEqual(listingStatusStep(o('DISCOVERY', false), { status: null, issues: null }), { write: true, lostBuyable: true }, 'no known status — the first not buyable is a loss');
  assert.deepEqual(listingStatusStep(o('NOTIFICATION', false, '2026-11-05T09:00:00.000Z'), { status: at(NOW), issues: null }), { write: true, lostBuyable: false }, 'late');
  assert.deepEqual(listingStatusStep({ ...o('DISCOVERY', true), status: null, issues: { severities: ['NONE'], enforcementActions: [] } },
    { status: at(NOW), issues: { value: { severities: ['NONE'], enforcementActions: [] }, observedAt: NOW } }), { write: false, lostBuyable: false });
});
