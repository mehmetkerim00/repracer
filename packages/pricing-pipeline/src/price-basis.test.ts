import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, DispatchBatch, FieldWrite } from '@repracer/channel-port';
import { InMemoryPricingStore } from './memory-store.ts';
import { createPricingPipeline } from './pipeline.ts';

/**
 * Ревью шага 22, находка 1 [Р-116]: синхронный канал применяет первую отправку пути решения сразу — сверки диспетчером не будет,
 * поэтому база цены сверяется на пути решения. Канал сообщает цену покупателя 23.79 при отправленной 19.99 (×1.19). Данные синтетические.
 */
const NOW = '2026-09-17T10:00:00.000Z';
const scope = (n: number, priceMinor: number) => ({
  writeScopeId: `ws-${n}`, productId: `p-${n}`, channelAccountId: 'acc-1', marketplace: 'de', externalUnitId: String(9100 + n), channelProductRef: `3629${n}`,
  condition: 'new', currency: 'EUR', basis: 'GROSS' as const, pricingMode: 'ENGINE' as const,
  strategy: { strategyId: `st-${n}`, version: 1, params: { type: 'FIXED' as const, priceMinor }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
});

test('finding 1 of the step 22 review: a synchronous first dispatch whose buyer price differs by the VAT rate distrusts the channel on the decision path (Р-118)', async () => {
  const store = new InMemoryPricingStore({ scopes: [scope(1, 1999), scope(2, 2100)] });
  const sent: string[] = [];
  const adapter = {
    descriptor: { channel: 'KAUFLAND', competitorSources: [] },
    async planDispatch(_ctx: AdapterCallContext, writes: readonly FieldWrite[]) {
      return { batches: writes.map((w) => ({ batchId: w.channelWriteId, operation: 'test', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch(_ctx: AdapterCallContext, batch: DispatchBatch) {
      return { batchId: batch.batchId, attemptsMade: 1, outcomes: batch.items.map((w) => {
        sent.push(w.writeScope.writeScopeId);
        const price = w.value.field === 'PRICE' ? w.value.price : null;
        return { channelWriteId: w.channelWriteId, status: 'ACCEPTED' as const, appliedImmediately: true, observation: {
          identity: w.writeScope.identity, field: 'PRICE' as const, value: w.value, observedAt: NOW, source: 'SYNC_RESPONSE' as const,
          effectivePrice: { ...price!, amountMinor: Math.round(price!.amountMinor * 1.19) },
        } };
      }) };
    },
  } as unknown as ChannelAdapter;
  const alerts: string[] = [];
  const pipeline = createPricingPipeline({ store, adapter, alerts: { raise: async (a) => { alerts.push(a.code); } }, logger: { log: () => {} }, now: () => NOW });
  const ctx = { tenantId: 'memory-tenant', channelAccountId: 'acc-1', correlationId: 't', deadline: '2026-09-17T10:01:00.000Z' } as AdapterCallContext;

  const first = await pipeline.recompute(ctx, 'ws-1', { type: 'COST_CHANGE' });
  assert.ok(first.stages.some((s) => s.outcome === 'CHANNEL_DISTRUSTED'), JSON.stringify(first.stages));
  assert.deepEqual(store.halts, [], 'Р-118: not a storefront halt of Р-51');
  assert.deepEqual(store.distrusts.map((d) => [d.reasonCode, d.marketplace]), [['PRICE_BASIS_MISMATCH', 'de']]);
  assert.equal('observedMinor' in store.distrusts[0]!.details, false, 'finding 10: the buyer price read from the channel is not kept in the distrust');
  assert.ok(alerts.includes('PRICING_CHANNEL_DISTRUSTED'));
  // Фиксированная цена второго товара витрины удерживается, в канал не уходит
  const second = await pipeline.recompute(ctx, 'ws-2', { type: 'COST_CHANGE' });
  assert.equal(second.decision?.rejectionReason, 'CHANNEL_DISTRUSTED');
  assert.deepEqual(sent, ['ws-1']);
});
