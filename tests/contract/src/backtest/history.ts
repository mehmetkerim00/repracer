import type { CompetitorSnapshot } from '@repracer/channel-port';
import { SeededRandom } from '../simulator/random.ts';

/**
 * Синтетическая история снимков конкурентов для бэктеста (шаг 21). Реальной истории нет: писателя competitor_snapshot в ClickHouse
 * в системе ещё нет, а данных продавцов в репозитории быть не может. Генератор задаёт рынок явно, чтобы было видно, что он умеет и
 * чего не умеет. Данные синтетические.
 */

export interface SyntheticProduct {
  channelProductRef: string;
  /** Наша цена в истории: продавец без репрайсера держал её неизменной */
  historicalSelfPriceMinor: number;
  /** Опорная цена рынка в начале периода */
  marketPriceMinor: number;
}

export interface SyntheticMarket {
  seed: number;
  marketplace: string;
  currency: string;
  from: string;
  to: string;
  /** Интервал снимков, мс (опрос или уведомления в среднем) */
  everyMs: number;
  products: SyntheticProduct[];
  /** Дневная волатильность цены «блуждающего» конкурента, б. п. */
  dailyVolatilityBp: number;
  /** Акция конкурента: раз в promoEveryDays дней на promoDays дней скидка promoDiscountBp; день старта сдвинут по товарам */
  promo: { everyDays: number; days: number; discountBp: number };
  /** Доля снимков, где цена конкурента испорчена разбором ×0.01 (центы как основные единицы) — для проверки входов */
  corruptShare: number;
}

export interface RecordedHistory {
  market: SyntheticMarket;
  snapshots: CompetitorSnapshot[];
}

const DAY = 86_400_000;

/** История: три конкурента на товар — блуждающий, акционный и статичный дорогой; наша историческая цена — в снимке как isSelf */
export function syntheticHistory(market: SyntheticMarket): RecordedHistory {
  return { market, snapshots: [...syntheticSnapshots(market)] };
}

/**
 * Шаг 24 (OQ-161): та же история потоком, по времени — бэктест по каталогу за 18 месяцев не держит все снимки в памяти.
 * При равном зерне генератор выдаёт те же снимки, что syntheticHistory.
 */
export function* syntheticSnapshots(market: SyntheticMarket): Generator<CompetitorSnapshot> {
  const rng = new SeededRandom(market.seed);
  const from = Date.parse(market.from);
  const to = Date.parse(market.to);
  const walkers = market.products.map((p) => p.marketPriceMinor);
  let lastStepDay = -1;
  for (let t = from; t < to; t += market.everyMs) {
    const day = Math.floor((t - from) / DAY);
    if (day !== lastStepDay) {
      lastStepDay = day;
      market.products.forEach((p, i) => {
        const moved = Math.round(walkers[i]! * (1 + (rng.normal() * market.dailyVolatilityBp) / 10_000));
        // Рынок не уходит дальше ±35 % от опорной цены
        walkers[i] = Math.min(Math.round(p.marketPriceMinor * 1.35), Math.max(Math.round(p.marketPriceMinor * 0.65), moved));
      });
    }
    for (let i = 0; i < market.products.length; i++) {
      const p = market.products[i]!;
      const promoPhase = (day + i * 3) % market.promo.everyDays;
      const promoPrice = promoPhase < market.promo.days
        ? Math.round(p.marketPriceMinor * (1 - market.promo.discountBp / 10_000)) : Math.round(p.marketPriceMinor * 1.04);
      const corrupt = rng.chance(market.corruptShare);
      const money = (amountMinor: number) => ({ amountMinor, currency: market.currency, basis: 'GROSS' as const });
      const offers = [
        { isSelf: false, sellerRef: 'Synthetic Walker', minor: corrupt ? Math.max(1, Math.round(walkers[i]! / 100)) : walkers[i]! },
        { isSelf: false, sellerRef: 'Synthetic Promo', minor: promoPrice },
        { isSelf: false, sellerRef: 'Synthetic Premium', minor: Math.round(p.marketPriceMinor * 1.2) },
        { isSelf: true, sellerRef: 'self', minor: p.historicalSelfPriceMinor },
      ].sort((a, b) => a.minor - b.minor || Number(a.isSelf) - Number(b.isSelf));
      yield {
        marketplace: market.marketplace, channelProductRef: p.channelProductRef, condition: 'new', source: 'KAUFLAND_BUY_BOX_CHANGED',
        sourceEventId: `syn-${p.channelProductRef}-${t}`, observedAt: new Date(t).toISOString(), completeness: { kind: 'TOP_N', n: 10 },
        buybox: { price: money(offers[0]!.minor), isSelf: offers[0]!.isSelf },
        offers: offers.map((o, rank) => ({ rank: rank + 1, sellerRef: o.sellerRef, isSelf: o.isSelf, price: money(o.minor), shipping: money(0), totalPrice: money(o.minor), deliveryDays: { min: 1, max: 3 } })),
      };
    }
  }
}
