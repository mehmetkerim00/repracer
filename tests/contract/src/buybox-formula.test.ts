import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, AdapterDependencies } from '@repracer/channel-port';
import { WalmartAdapter, WALMART_US } from '@repracer/walmart-adapter';
import { AMAZON_DE, SimulatedAmazonPort } from './simulator/amazon-port.ts';
import { LANDED_CHANNEL_BONUS, rankForBuyBox, SYNTHETIC_SELLERS, type BuyBoxCandidate } from './simulator/buybox-rule.ts';
import { SimulatedKauflandChannel, type KauflandChannelModelSpec } from './simulator/kaufland-channel.ts';
import { SimulatedWalmartChannel } from './simulator/walmart-channel.ts';

/**
 * Шаг 97 [H]: победитель Buy Box в симуляторе — документированная формула, а не факт канала: score = landed − (исполняет канал ? 0,50 : 0),
 * минимальный score побеждает, при равенстве — прежний держатель, затем порядок продавца. Формула включается полем мира; без него модели
 * держат прежнее правило (минимальная цена с доставкой). Продавцы — вымышленные имена пула. Данные синтетические.
 */

const c = (key: string, landedMinor: number, channelFulfilled: boolean, order: number, self = false): BuyBoxCandidate => ({ key, self, landedMinor, channelFulfilled, order });

test('H: the formula — landed minus the channel-fulfilment bonus, the previous holder on a tie, then the seller order', () => {
  // FBA за $18.40 бьёт продавца за $18.00 (18.40 − 0.50 < 18.00), но не за $17.89
  assert.equal(rankForBuyBox([c('Pine & Co', 1800, false, 1), c('Harbor Goods', 1840, true, 0)], null, LANDED_CHANNEL_BONUS)[0]!.key, 'Harbor Goods');
  assert.equal(rankForBuyBox([c('Pine & Co', 1789, false, 1), c('Harbor Goods', 1840, true, 0)], null, LANDED_CHANNEL_BONUS)[0]!.key, 'Pine & Co');
  // равенство score — прежний держатель; без прежнего — порядок продавцов пула
  const tie = [c('Pine & Co', 1800, false, 1), c('Harbor Goods', 1850, true, 0)];
  assert.equal(rankForBuyBox(tie, 'Pine & Co', LANDED_CHANNEL_BONUS)[0]!.key, 'Pine & Co');
  assert.equal(rankForBuyBox(tie, null, LANDED_CHANNEL_BONUS)[0]!.key, 'Harbor Goods');
  // имена пула — вымышленные и разные, у каждого — признак исполнения каналом
  assert.equal(new Set(SYNTHETIC_SELLERS.map((s) => s.name)).size, SYNTHETIC_SELLERS.length);
  assert.ok(SYNTHETIC_SELLERS.some((s) => s.channelFulfilled) && SYNTHETIC_SELLERS.some((s) => !s.channelFulfilled));
});

const kaufland = (buyBox: boolean): SimulatedKauflandChannel => {
  const spec: KauflandChannelModelSpec = {
    seed: 97, webhookUrl: 'https://hooks.example.invalid/kaufland/wh_tok_synthetic_97',
    units: [{ idUnit: 970001, storefront: 'de', idOffer: 'SYN-OFFER-97', idProduct: 397_200_001, listingPriceMinor: 1800, amount: 5 }],
    competitors: [{ sellerRef: 'Harbor Goods', channelFulfilled: true, storefront: 'de', idProduct: 397_200_001, priceMinor: 1840, behaviour: { kind: 'SCHEDULE', points: [{ atOffsetMs: 60_000, priceMinor: 1860 }] } }],
    ...(buyBox ? { buyBox: LANDED_CHANNEL_BONUS } : {}),
  };
  return new SimulatedKauflandChannel(spec, '2026-10-16T10:00:00.000Z');
};

test('H: Kaufland model — with the formula the FBA-like offer wins and a change of holder is an event; without it the old rule stands', () => {
  const start = Date.parse('2026-10-16T10:00:00.000Z');
  const k = kaufland(true);
  k.advanceTo(start);
  // мы $18.00 продавцом, Harbor Goods $18.40 и его исполняет Kaufland: 18.40 − 0.50 = 17.90 < 18.00 — Buy Box у него
  assert.deepEqual([k.market('de', 397_200_001).selfWins, k.market('de', 397_200_001).buyboxMinor], [false, 1840]);
  const changes = k.stats.buyBoxChanges;
  k.advanceTo(start + 60_000);
  // он поднялся до $18.60: 18.10 > 18.00 — Buy Box наш, и это событие смены держателя
  assert.equal(k.market('de', 397_200_001).selfWins, true);
  assert.equal(k.stats.buyBoxChanges, changes + 1, 'a change of the holder is a Buy Box event');
  // без поля формулы — прежнее правило: минимальная цена с доставкой, признак исполнения не значит ничего
  const legacy = kaufland(false);
  legacy.advanceTo(start);
  assert.equal(legacy.market('de', 397_200_001).selfWins, true, 'the old rule: $18.00 beats $18.40');
});

test('H: Amazon port — the Buy Box price by the formula, the holder not named (A-29), fulfilment and rating on the offers, no ranks', () => {
  const now = { ms: Date.parse('2026-10-16T10:00:00.000Z') };
  const deps = { now: () => new Date(now.ms).toISOString() } as unknown as AdapterDependencies;
  const port = new SimulatedAmazonPort({
    seed: 97, buyBox: LANDED_CHANNEL_BONUS,
    skus: [{ sku: 'SYN-SKU-97', asin: 'B0SYN00097', marketplaces: [AMAZON_DE], priceMinor: 1800, quantity: 5 }],
    competitors: [{ sellerRef: 'Cedar Lane Store', marketplace: AMAZON_DE, asin: 'B0SYN00097', priceMinor: 1830, channelFulfilled: true, rating: { positivePct: 99, count: 7020 },
      schedule: [{ atOffsetMs: 60_000, priceMinor: 1840 }] }],
  }, deps);
  now.ms += 10 * 60_000;
  const snapshot = port.drainSnapshots().at(-1)!;
  assert.ok(snapshot, 'a competitor change is an ANY_OFFER_CHANGED snapshot');
  // FBA за $18.40 → 17.90 < нашей $18.00 продавцом — цена Buy Box $18.40, а держатель не назван
  assert.equal(snapshot.buybox?.price.amountMinor, 1840);
  assert.equal(snapshot.buybox?.isSelf, null);
  assert.ok(snapshot.offers.every((o) => o.rank === undefined && o.holdsBuyBox === undefined), 'no rank and no holder flag — the notification has none');
  const cedar = snapshot.offers.find((o) => o.sellerRef === 'Cedar Lane Store')!;
  assert.deepEqual([cedar.fulfillment, cedar.rating], ['AFN', { positivePct: 99, count: 7020 }]);
  assert.equal(snapshot.offers.find((o) => o.isSelf)!.fulfillment, 'MFN');
});

test('H: Walmart named waves — named sellers, the winner is ranked first by the formula, the holder changes over a day', async () => {
  let now = Date.parse('2026-10-16T00:00:00.000Z');
  const clock = { nowMs: () => now, sleep: async (ms: number) => { now += ms; } };
  const channel = new SimulatedWalmartChannel({
    seed: 97, clientId: 'syn-client', clientSecret: 'syn-secret', nowMs: clock.nowMs, market: 'NAMED_WAVES', buyBox: LANDED_CHANNEL_BONUS,
    items: [{ sku: 'SYN-WMT-97', productName: 'Synthetic product 97', priceMinor: 1899, shippingMinor: 0, quantity: 10, otherMarketplacePriceMinor: null, competitorBaseMinor: 1900 }],
  });
  const deps: AdapterDependencies = {
    accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'WALMART', externalAccountId: 'syn-walmart', marketplaces: [WALMART_US], credentialsRef: 'secret-ref:synthetic' } }) },
    credentials: { get: async () => ({ clientId: 'syn-client', clientSecret: 'syn-secret' }) },
    alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => new Date(now).toISOString() as never,
  };
  const adapter = new WalmartAdapter(deps, { baseUrl: 'https://sandbox.walmartapis.com', fetch: channel.fetch, clock });
  const ctx: AdapterCallContext = { tenantId: 't-97' as never, channelAccountId: 'acc-walmart' as never, correlationId: 'step97-h', deadline: new Date(now + 86_400_000).toISOString() as never };
  const holders: string[] = [];
  const pool = new Set(SYNTHETIC_SELLERS.map((s) => s.name));
  for (let i = 0; i < 144; i++, now += 10 * 60_000) {
    const snap = (await adapter.readCompetitors(ctx, [{ marketplace: WALMART_US, channelProductRef: 'SYN-WMT-97', condition: 'new' }])).snapshots[0]!;
    const landed = snap.offers.map((o) => o.price.amountMinor + (o.shipping?.amountMinor ?? 0));
    // победитель — минимальная landed (у Walmart исполнения нет — W-05, бонус ни к кому не применяется) и он назван держателем
    const winner = snap.offers.find((o) => o.holdsBuyBox === true)!;
    assert.equal(winner.price.amountMinor + (winner.shipping?.amountMinor ?? 0), Math.min(...landed), `the winner has the lowest landed price at ${i}`);
    assert.equal(snap.buybox?.isSelf, winner.isSelf);
    assert.ok(snap.offers.filter((o) => !o.isSelf).every((o) => o.sellerRef && pool.has(o.sellerRef)), 'competitors are named sellers of the pool');
    holders.push(winner.isSelf ? 'SELF' : winner.sellerRef!);
  }
  const changes = holders.filter((h, i) => i > 0 && h !== holders[i - 1]).length;
  assert.ok(changes >= 4, `the Buy Box changes hands over a day with the waves (${changes} changes)`);
  assert.ok(holders.includes('SELF') && holders.some((h) => h !== 'SELF'), 'sometimes ours, sometimes not — a partial share');
});
