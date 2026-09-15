import type { CostInputs } from './types.ts';

/**
 * Маржа считается от выручки без налога [Р-58]:
 *   VAT_INCLUDED (ЕС):        цена витрины брутто, net = price / (1 + vat);
 *   SALES_TAX_EXCLUDED (США): цена витрины нетто, net = price — налог с продаж добавляется при покупке и не является выручкой.
 *   profit = net − price·fee − fixedFee − unitCost;  margin = profit / net.
 * Цена для маржи m:  price = (fixedFee + unitCost) · (1 + t) / ((1 − m) − fee · (1 + t)), где t = vat или 0.
 * Комиссия — от цены витрины: в ЕС с НДС, в США без налога с продаж (проверить по тарифам каналов, Р-32).
 * Всё — целые базисные пункты и центы через BigInt; цена округляется вверх, маржа — вниз (консервативно).
 */

const BP = 10_000n;

export type MarginPriceResult =
  | { ok: true; priceMinor: number }
  | { ok: false; cause: 'VAT_UNKNOWN' | 'UNATTAINABLE' | 'INVALID_INPUT' };

function validCost(cost: CostInputs): boolean {
  return [cost.unitCostMinor, cost.fixedFeeMinor, cost.feeRateBp].every((v) => Number.isSafeInteger(v) && v >= 0)
    && cost.feeRateBp < 10_000;
}

/** Доля налога внутри цены витрины, базисные пункты */
function taxInPriceBp(cost: CostInputs): { ok: true; t: bigint } | { ok: false; cause: 'VAT_UNKNOWN' | 'INVALID_INPUT' } {
  if (cost.tax.regime === 'SALES_TAX_EXCLUDED') return { ok: true, t: 0n };
  if (cost.tax.regime !== 'VAT_INCLUDED') return { ok: false, cause: 'INVALID_INPUT' };
  if (cost.tax.vatRateBp === null) return { ok: false, cause: 'VAT_UNKNOWN' };
  if (!Number.isSafeInteger(cost.tax.vatRateBp) || cost.tax.vatRateBp < 0) return { ok: false, cause: 'INVALID_INPUT' };
  return { ok: true, t: BigInt(cost.tax.vatRateBp) };
}

/** Наименьшая цена витрины (в базе цены единицы записи), при которой маржа не ниже заданной */
export function storefrontPriceForMarginBp(cost: CostInputs, marginBp: number): MarginPriceResult {
  if (!validCost(cost) || !Number.isSafeInteger(marginBp) || marginBp < 0 || marginBp >= 10_000) return { ok: false, cause: 'INVALID_INPUT' };
  const tax = taxInPriceBp(cost);
  if (!tax.ok) return { ok: false, cause: tax.cause };
  const denominator = (BP - BigInt(marginBp)) * BP - BigInt(cost.feeRateBp) * (BP + tax.t);
  if (denominator <= 0n) return { ok: false, cause: 'UNATTAINABLE' };
  const numerator = BigInt(cost.fixedFeeMinor + cost.unitCostMinor) * (BP + tax.t) * BP;
  const price = (numerator + denominator - 1n) / denominator;
  if (price > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, cause: 'UNATTAINABLE' };
  return { ok: true, priceMinor: Math.max(1, Number(price)) };
}

/** Маржа при цене витрины, базисные пункты, округление вниз; null — не вычисляется */
export function marginBpAtPrice(cost: CostInputs, priceMinor: number): number | null {
  if (!validCost(cost) || !Number.isSafeInteger(priceMinor) || priceMinor <= 0) return null;
  const tax = taxInPriceBp(cost);
  if (!tax.ok) return null;
  const p = BigInt(priceMinor);
  // net·(BP+t)·BP = p·BP·BP;  масштаб S = (BP+t)·BP
  const netScaled = p * BP * BP;
  const feeScaled = p * BigInt(cost.feeRateBp) * (BP + tax.t);
  const fixedScaled = BigInt(cost.fixedFeeMinor + cost.unitCostMinor) * (BP + tax.t) * BP;
  const profitScaled = netScaled - feeScaled - fixedScaled;
  const bp = (profitScaled * BP) / netScaled;
  const floored = profitScaled < 0n && (profitScaled * BP) % netScaled !== 0n ? bp - 1n : bp;
  return Number(floored);
}
