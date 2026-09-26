import type { AdapterCallContext, AdapterDependencies, CompetitorQuery, InboundDelivery } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeed, type MemorySeedScope, type PricingPipeline } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgWriteQueueStore, seedPricingWorld, translateStore, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createWriteDispatcher, type WriteQueueStore } from '@repracer/write-dispatcher';
import type { Sink, VirtualClock } from '../harness/world.ts';
import { AMAZON_DE, AMAZON_SIM_DESCRIPTOR_US, AMAZON_US, SimulatedAmazonPort } from '../simulator/amazon-port.ts';
import { dbIdPipeline, stamped, type StampedEvent } from './common.ts';

/**
 * Спуск конкурента на витрине США и возврат: каждый шаг — не больше 20 % от предыдущего, иначе снимок отвергает проверка
 * правдоподобия входов [Р-42]. Ниже 1000 (min_price предложений мира) цену держит пол — это и даёт числа Р-173.
 */
const US_COMPETITOR_RAMP = [1800, 1500, 1250, 1050, 900, 1050, 1250, 1500] as const;

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
  /**
   * Шаг 42 [Р-172]: витрина США. Отличие не в коде мира, а в ДАННЫХ: регион NA, доллары, цена нетто, себестоимость
   * остаётся в евро и переводится курсом ЕЦБ [Р-61], пояс суток не установлен. Режим записи — тень [Р-169]: бой на
   * amazon.com база не включит, пока граница суток неизвестна.
   */
  us?: boolean;
  /** Движок включён с самого начала: прогон смотрит на решения, а не на путь их включения */
  engine?: boolean;
  writeMode?: 'SHADOW' | 'LIVE';
  /** Роль загрузчика курсов: нужна, когда себестоимость в евро, а цена в долларах [Р-61] */
  fxLoaderPool?: PgPool;
}): Promise<AmazonLiveWorld> {
  const { clock } = input;
  const tenantFixture = `10000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const accountFixture = `20000000-0000-4000-8000-00000000${String(input.tag).padStart(4, '0')}`;
  const start = clock.nowMs();
  const asins = Array.from({ length: input.offers }, (_, i) => `B0LIVE${String(input.tag).padStart(2, '0')}${String(i).padStart(2, '0')}`);
  const us = input.us === true;
  const marketplace = us ? AMAZON_US : AMAZON_DE;
  const region = us ? 'NA' : 'EU';
  const currency = us ? 'USD' : 'EUR';
  const basis = us ? 'NET' : 'GROSS';
  /**
   * Витрина США: цена нетто, налог добавляется при покупке [Р-58], поэтому ставки НДС у товара нет. Себестоимость
   * остаётся в ЕВРО — так её и объявляет продавец из ЕС, торгующий в США, — и пол маржи считается через курс ЕЦБ [Р-61].
   */
  const tax = us ? { regime: 'SALES_TAX_EXCLUDED' as const } : { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 };
  /** Стратегия: подрезать самого дешёвого на один цент — в тени это даёт видимые предложения без единой записи */
  const strategy = input.engine === true
    ? { strategyId: 'st-amz-lowest', version: 1,
        params: { type: 'BEAT_LOWEST' as const, undercutMinor: 1, scope: 'VISIBLE_TOP_N' as const, compareLanded: false, atBound: 'CAP' as const },
        deadbandMinor: 0 }
    : null;
  const scopes: MemorySeedScope[] = asins.map((asin, i) => ({
    writeScopeId: `ws-amz-${asin}`, productId: `prod-amz-${asin}`, channelAccountId: accountFixture, marketplace, externalUnitId: `SYN-SKU-${asin}`,
    channelProductRef: asin, condition: 'new', currency, basis, taxRegime: tax.regime,
    pricingMode: input.engine === true ? 'ENGINE' : 'OFF', strategy, currentPriceMinor: 1850,
    /**
     * Витрина США: `min_price` 14,00 — ВЫШЕ трёх ступеней спуска конкурента (12,50, 10,50, 9,00). Так пол удерживает цену
     * не один раз за цикл, а трижды, и числа Р-173 в прогоне не зависят от того, попал ли такт в единственную низкую
     * ступень. У витрины ЕС граница прежняя.
     */
    minPrice: { amountMinor: us ? 1400 : 1000, id: `min-amz-${i}` }, maxPrice: { amountMinor: 5000, id: `max-amz-${i}` },
    cost: { currency: 'EUR', costProfileId: `cp-amz-${i}`, unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax },
    /**
     * Минимальная маржа 12 %: без неё пол — это только `min_price`, и перевод себестоимости из евро курсом ЕЦБ [Р-61]
     * не участвует вовсе. Именно пол МАРЖИ делает сценарий шага 9 наблюдаемым на экране границ.
     */
    guardrails: { minMarginBp: 1200 },
  }));
  const day = (offset: number): string => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
  const seed: MemorySeed = {
    scopes, marketplaces: { [marketplace]: { currency, basis } },
    competitorState: Object.fromEntries(asins.map((a) => [`${marketplace}|${a}|new`, { observedAt: new Date(start - 600_000).toISOString(), buyboxMinor: 1800, lowestMinor: 1800 }])),
    // Курс ЕЦБ вчерашнего дня: себестоимость в евро, цена в долларах — пол маржи без курса вычислить нечем [Р-61]
    ...(us ? { fxRates: [{ source: 'ECB' as const, rateDate: day(-1), base: 'EUR' as const, quote: 'USD' as const,
      rateMicros: 1_100_000, availableFrom: new Date(start - 3_600_000).toISOString() }] } : {}),
  };
  const seeded = await seedPricingWorld(input.appPool, {
    fixtureTenantId: tenantFixture, fixtureChannelAccountId: accountFixture, fixtureChannel: 'AMAZON', fixtureRegion: region, fixtureExternalAccountId: `A1SYNLIVE${input.tag}`,
    marketplaces: [marketplace], clock: clock.iso(), seed, provisioningPool: input.provisioningPool, adminPool: input.adminPool,
    ...(input.fxLoaderPool ? { fxLoaderPool: input.fxLoaderPool } : {}),
    ...(input.writeMode ? { writeMode: input.writeMode } : {}),
  });
  const sink: Sink = { logs: [], alerts: [] };
  const deps: AdapterDependencies = {
    accounts: { async verify(tenantId, channelAccountId) {
      if (channelAccountId !== accountFixture) return { ok: false, reason: 'NOT_FOUND' };
      if (tenantId !== tenantFixture) return { ok: false, reason: 'TENANT_MISMATCH' };
      return { ok: true, account: { tenantId, channelAccountId, channel: 'AMAZON', region, externalAccountId: `A1SYNLIVE${input.tag}`, marketplaces: [marketplace], credentialsRef: 'cred:amazon' } };
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
    ...(us ? { descriptor: AMAZON_SIM_DESCRIPTOR_US } : {}),
    skus: asins.map((asin) => ({ sku: `SYN-SKU-${asin}`, asin, marketplaces: [marketplace], priceMinor: 1850, quantity: 5 })),
    competitors: asins.map((asin, i) => ({
      sellerRef: `Synthetic Amazon Competitor ${i}`, marketplace, asin, priceMinor: 1800,
      /**
       * Витрина США: конкурент СПОЛЗАЕТ ниже пола и возвращается — шагами по 15–20 %, а не прыжком. Прыжок с 1800 на 900
       * проверка правдоподобия входов честно отвергает как испорченный снимок [Р-42], и первая редакция прогона получила
       * 245 уведомлений и 9 решений: движок работал, но почти всё, что ему приносили, он не принимал. Плавный спуск —
       * единственный способ увидеть Р-173 в прогоне: пол удерживает цену, когда стратегия хочет ниже него.
       * У витрины ЕС расписание прежнее — мелкие колебания вокруг 1800.
       */
      schedule: Array.from({ length: Math.floor(26 * 3_600_000 / every) }, (_, k) => ({
        atOffsetMs: (k + 1) * every + i * 60_000,
        priceMinor: us ? US_COMPETITOR_RAMP[k % US_COMPETITOR_RAMP.length]! : 1800 + ((k % 2 === 0) ? 20 : 0),
      })),
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
