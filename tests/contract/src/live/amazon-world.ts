import type { AdapterCallContext, AdapterDependencies, CompetitorQuery, InboundDelivery } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeed, type MemorySeedScope, type PricingPipeline } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgWriteQueueStore, seedPricingWorld, translateStore, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createWriteDispatcher, type WriteQueueStore } from '@repracer/write-dispatcher';
import type { Sink, VirtualClock } from '../harness/world.ts';
import { AMAZON_DE, SimulatedAmazonPort } from '../simulator/amazon-port.ts';
import { dbIdPipeline, stamped, type StampedEvent } from './common.ts';

/**
 * Р-128 (шаг 26): мир Amazon для проверки в живом режиме — модель порта Amazon [Р-113] с уведомлениями ANY_OFFER_CHANGED (задержка и
 * потери A-08) и getCompetitiveSummary (0.033 rps, burst 1 [док]); настоящая PostgreSQL. Наблюдение — вызовы getCompetitiveSummary по
 * товару и отказы ограничителя. Данные синтетические.
 */
export interface AmazonLiveWorld {
  channel: 'AMAZON';
  seeded: SeededPricingWorld;
  port: SimulatedAmazonPort;
  asins: string[];
  events: StampedEvent[];
  /** Сверка: моменты вызова getCompetitiveSummary по ASIN */
  summaryCalls: Map<string, number[]>;
  /** Сверка: моменты, когда канал ответил снимком по ASIN (без отказа ограничителя) */
  comparedAt: Map<string, number[]>;
  betweenTicks(): Promise<void>;
  pipelineForDbIds(): PricingPipeline;
  /** Приёмник уведомлений зовёт путь решения с идентификаторами базы в claimed */
  receiverPipeline(): { processInbound(delivery: InboundDelivery): Promise<{ inbound: { kind: string }; notification: 'RECORDED' | 'DUPLICATE' | 'NONE' }> };
}

export async function amazonLiveWorld(input: {
  tag: number; clock: VirtualClock; offers: number; seed: number; lossShare: number; priceChangeEveryHours: number;
  appPool: PgPool; adminPool: PgPool; provisioningPool: PgPool; dispatcherPool: PgPool;
}): Promise<AmazonLiveWorld> {
  const { clock } = input;
  const tenantFixture = `10000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const accountFixture = `20000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const start = clock.nowMs();
  const asins = Array.from({ length: input.offers }, (_, i) => `B0LIVE${String(input.tag).padStart(2, '0')}${String(i).padStart(2, '0')}`);
  const scopes: MemorySeedScope[] = asins.map((asin, i) => ({
    writeScopeId: `ws-amz-${asin}`, productId: `prod-amz-${asin}`, channelAccountId: accountFixture, marketplace: AMAZON_DE, externalUnitId: `SYN-SKU-${asin}`,
    channelProductRef: asin, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1850,
    minPrice: { amountMinor: 1000, id: `min-amz-${i}` }, maxPrice: { amountMinor: 5000, id: `max-amz-${i}` },
    cost: { currency: 'EUR', costProfileId: `cp-amz-${i}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } },
  }));
  const seed: MemorySeed = {
    scopes, marketplaces: { [AMAZON_DE]: { currency: 'EUR', basis: 'GROSS' } },
    competitorState: Object.fromEntries(asins.map((a) => [`${AMAZON_DE}|${a}|new`, { observedAt: new Date(start - 600_000).toISOString(), buyboxMinor: 1800, lowestMinor: 1800 }])),
  };
  const seeded = await seedPricingWorld(input.appPool, {
    fixtureTenantId: tenantFixture, fixtureChannelAccountId: accountFixture, fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: `A1SYNLIVE${input.tag}`,
    marketplaces: [AMAZON_DE], clock: clock.iso(), seed, provisioningPool: input.provisioningPool, adminPool: input.adminPool,
  });
  const sink: Sink = { logs: [], alerts: [] };
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== accountFixture) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== tenantFixture) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region: 'EU', externalAccountId: `A1SYNLIVE${input.tag}`, marketplaces: [AMAZON_DE], credentialsRef: 'cred:amazon' } };
    } },
    credentials: { async get() { return {}; } },
    alerts: { async raise(alert) { sink.alerts.push(alert); } },
    logger: { log(entry) { sink.logs.push(entry); } },
    now: () => clock.iso(),
  };
  // Цена конкурента меняется у каждого товара по расписанию со сдвигом по товарам: уведомление теряется с долей lossShare
  const every = input.priceChangeEveryHours * 3_600_000;
  const port = new SimulatedAmazonPort({
    seed: input.seed, params: { anyOfferChanged: { delayMs: 30_000, lossShare: input.lossShare } },
    skus: asins.map((asin) => ({ sku: `SYN-SKU-${asin}`, asin, marketplaces: [AMAZON_DE], priceMinor: 1850, quantity: 5 })),
    competitors: asins.map((asin, i) => ({
      sellerRef: `Synthetic Amazon Competitor ${i}`, marketplace: AMAZON_DE, asin, priceMinor: 1800,
      schedule: Array.from({ length: Math.floor(26 * 3_600_000 / every) }, (_, k) => ({ atOffsetMs: (k + 1) * every + i * 60_000, priceMinor: 1800 + ((k % 2 === 0) ? 20 : 0) })),
    })),
  }, deps);
  const summaryCalls = new Map<string, number[]>();
  const comparedAt = new Map<string, number[]>();
  const readCompetitors = port.readCompetitors.bind(port);
  port.readCompetitors = async (ctx: AdapterCallContext, queries: readonly CompetitorQuery[]) => {
    for (const q of queries) {
      const calls = summaryCalls.get(q.channelProductRef) ?? [];
      calls.push(clock.nowMs());
      summaryCalls.set(q.channelProductRef, calls);
    }
    const result = await readCompetitors(ctx, queries);
    for (const snapshot of result.snapshots) comparedAt.set(snapshot.channelProductRef, [...(comparedAt.get(snapshot.channelProductRef) ?? []), clock.nowMs()]);
    return result;
  };
  const store = translateStore(new PgPricingStore(input.appPool, { adminPool: input.adminPool }), seeded.ids);
  const writeQueue = new PgWriteQueueStore(input.appPool, { scanPool: input.dispatcherPool });
  const queue = translateStore<WriteQueueStore>({
    claimNext: writeQueue.claimNext.bind(writeQueue), recordOutcome: writeQueue.recordOutcome.bind(writeQueue),
    recordReconciliation: writeQueue.recordReconciliation.bind(writeQueue), checkPriceBasis: writeQueue.checkPriceBasis.bind(writeQueue),
    dueScopes: async (at, options) => (await writeQueue.dueScopes(at, options)).filter((d) => d.tenantId === seeded.tenantId),
  }, seeded.ids);
  const dispatcher = createWriteDispatcher({ store: queue, adapterFor: () => port, alerts: deps.alerts, now: () => clock.iso() });
  const pipeline = createPricingPipeline({ store, adapter: port, alerts: deps.alerts, logger: deps.logger, now: () => clock.iso(), dispatcher });
  const events = stamped(sink, clock);
  const ctx: AdapterCallContext = { tenantId: tenantFixture as AdapterCallContext['tenantId'], channelAccountId: accountFixture as AdapterCallContext['channelAccountId'], correlationId: 'live-amazon-receiver', deadline: clock.iso(60_000) };
  return {
    channel: 'AMAZON', seeded, port, asins, events: events.list, summaryCalls, comparedAt,
    async betweenTicks() {
      // Приёмник уведомлений: снимки ANY_OFFER_CHANGED, срок доставки которых наступил
      for (const snapshot of port.drainSnapshots()) await pipeline.processSnapshot({ ...ctx, deadline: clock.iso(60_000) }, snapshot);
      await dispatcher.sweep({ pendingMinAgeMs: 0 });
      events.stamp();
    },
    pipelineForDbIds: () => dbIdPipeline(pipeline, seeded),
    receiverPipeline: () => ({
      processInbound: (delivery: InboundDelivery) => pipeline.processInbound({ ...delivery, claimed: seeded.ids.fromDb(delivery.claimed) }),
    }),
  };
}
