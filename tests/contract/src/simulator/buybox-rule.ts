/**
 * Шаг 97 [H]: победитель Buy Box в симуляторе — простая документированная формула, а не факт канала (ни Kaufland, ни Amazon, ни Walmart
 * свой алгоритм не публикуют):
 *
 *   score = landed − (предложение исполняет канал ? бонус : 0)       landed = цена + доставка; бонус по умолчанию 0,50 в валюте витрины
 *   побеждает минимальный score; при равенстве — прежний держатель, затем ранг (порядок продавца в пуле; у нашего — после чужих)
 *
 * Победитель — ранг 1 ответа модели: так проверка входов не видит «Buy Box не у ранга 1» (BUYBOX_NOT_RANK_ONE_PRICE). Формула включается
 * полем спецификации мира (`buyBox`); без него модели работают по прежним правилам — прежние сценарии и их ожидания не меняются
 * (решение владельца шага 97). Данные синтетические.
 */

export interface BuyBoxRuleSpec {
  kind: 'LANDED_CHANNEL_BONUS';
  /** Бонус предложению, которое исполняет канал (Amazon FBA, Kaufland), в центах валюты витрины */
  channelFulfilmentBonusMinor: number;
}

export const DEFAULT_CHANNEL_FULFILMENT_BONUS_MINOR = 50;
export const LANDED_CHANNEL_BONUS: BuyBoxRuleSpec = { kind: 'LANDED_CHANNEL_BONUS', channelFulfilmentBonusMinor: DEFAULT_CHANNEL_FULFILMENT_BONUS_MINOR };

export interface BuyBoxCandidate {
  /** Продавец; у нашего предложения — свой ключ модели */
  key: string;
  self: boolean;
  landedMinor: number;
  channelFulfilled: boolean;
  /** Ранг продавца для равенства: порядок в пуле; наше — после чужих */
  order: number;
}

export function buyBoxScore(c: BuyBoxCandidate, rule: BuyBoxRuleSpec): number {
  return c.landedMinor - (c.channelFulfilled ? rule.channelFulfilmentBonusMinor : 0);
}

/** Предложения в порядке Buy Box: первое — победитель (ранг 1) */
export function rankForBuyBox<T extends BuyBoxCandidate>(offers: readonly T[], previousKey: string | null, rule: BuyBoxRuleSpec): T[] {
  return [...offers].sort((a, b) => buyBoxScore(a, rule) - buyBoxScore(b, rule)
    || Number(b.key === previousKey) - Number(a.key === previousKey)
    || a.order - b.order);
}

/**
 * Синтетические продавцы — вымышленные имена (не названия настоящих компаний), признак «исполняет канал» и рейтинг (рейтинг отдаёт только
 * модель Amazon — как SellerFeedbackRating; у Kaufland и Walmart его нет). Один продавец появляется у многих товаров, как на настоящей
 * площадке; волны цен у каждого товара — со своей фазой и размахом, чтобы проверка массового сдвига [Р-50] не видела у них одного
 * коэффициента
 */
export interface SyntheticSeller { name: string; channelFulfilled: boolean; ratingPct: number; ratingCount: number }

export const SYNTHETIC_SELLERS: readonly SyntheticSeller[] = [
  { name: 'Harbor Goods', channelFulfilled: true, ratingPct: 97, ratingCount: 4210 },
  { name: 'Pine & Co', channelFulfilled: false, ratingPct: 92, ratingCount: 860 },
  { name: 'North Ridge Supply', channelFulfilled: true, ratingPct: 95, ratingCount: 2390 },
  { name: 'Old Mill Trading', channelFulfilled: false, ratingPct: 88, ratingCount: 310 },
  { name: 'Bluebird Outlet', channelFulfilled: false, ratingPct: 94, ratingCount: 1540 },
  { name: 'Cedar Lane Store', channelFulfilled: true, ratingPct: 99, ratingCount: 7020 },
  { name: 'Lumen Home', channelFulfilled: false, ratingPct: 90, ratingCount: 520 },
  { name: 'Granite Peak Deals', channelFulfilled: false, ratingPct: 86, ratingCount: 140 },
];

/** Продавцы товара: детерминированно по номеру товара — у соседних товаров разные тройки */
export function sellersFor(productIndex: number, count = 3): SyntheticSeller[] {
  return Array.from({ length: count }, (_, i) => SYNTHETIC_SELLERS[(productIndex * 3 + i * 2) % SYNTHETIC_SELLERS.length]!);
}
