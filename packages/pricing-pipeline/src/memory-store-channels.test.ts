import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSourceDescriptor } from '@repracer/channel-port';
import { InMemoryPricingStore, standUserOf, type MemorySeedScope } from './memory-store.ts';

/**
 * OQ-173 (ревью шага 23, находка 15): двойник хранилища проверяет доступность стратегии по каналу аккаунта каждой единицы записи,
 * как write_scope_strategy_guard в PostgreSQL, а не по каналу мира. Данные синтетические.
 */
const push: CompetitorSourceDescriptor = {
  source: 'SYN_PUSH', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 20 }, conditions: ['new'], hasBuyboxWinner: true, hasOwnRank: false, hasShipping: true,
  typicalStalenessSeconds: 60, availability: 'AVAILABLE', role: 'PRIMARY',
};
const scope = (id: string, account: string): MemorySeedScope => ({
  writeScopeId: id, productId: `p-${id}`, channelAccountId: account, marketplace: 'de', externalUnitId: id, channelProductRef: `ref-${id}`, condition: 'new',
  currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1850, minPrice: { amountMinor: 1000, id: `min-${id}` }, maxPrice: { amountMinor: 5000, id: `max-${id}` },
});

test('OQ-173: strategy availability follows the channel of each write scope, not the channel of the world', async () => {
  const store = new InMemoryPricingStore({
    scopes: [scope('ws-k', 'acc-kaufland'), scope('ws-e', 'acc-ebay')], channel: 'KAUFLAND', competitorSources: [push],
    competitorSourcesByChannel: { KAUFLAND: [push] },
    accounts: [{ channelAccountId: 'acc-ebay', channel: 'EBAY', marketplaces: ['EBAY_DE'] }],
  });
  const actor = { membershipId: 'membership-owner', userId: standUserOf('membership-owner'), mfa: true };
  const buybox = { type: 'MATCH_BUYBOX' as const, undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' as const };
  const saved = await store.saveStrategy('t', { strategyId: null, name: 'Buy Box', params: buybox, deadbandMinor: 0, assignTo: ['ws-k'] }, actor);
  assert.equal(saved.status, 'SAVED', 'a Buy Box strategy is available on the channel of the world');
  assert.deepEqual(await store.saveStrategy('t', { strategyId: null, name: 'Buy Box', params: buybox, deadbandMinor: 0, assignTo: ['ws-e'] }, actor),
    { status: 'INVALID', cause: 'STRATEGY_UNAVAILABLE', writeScopeId: 'ws-e' }, 'the same strategy is unavailable on a channel without competitor sources');
  const fixed = await store.saveStrategy('t', { strategyId: null, name: 'Fixed', params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0, assignTo: ['ws-e'] }, actor);
  assert.equal(fixed.status, 'SAVED', 'a fixed price needs no competitor data on any channel');
});
