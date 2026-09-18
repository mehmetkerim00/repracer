import { convertMinor, marginBpAtPrice, storefrontPriceForMarginBp, type CostInputs, type FxApplied } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import { boundText } from './products.ts';
import { gap, scopeById, unitOf, type ConsoleScope, type Gap, type StandWorld, type UnitRef } from './world.ts';

/**
 * Экран D: min_price и max_price, пол по марже и разбивка цены до цента — налог, комиссии, себестоимость, курс.
 * Расчёт — те же функции, что у Gate (storefrontPriceForMarginBp, marginBpAtPrice) и хранилища (convertMinor, округление вверх).
 */

export interface MoneyLine {
  key: 'PRICE' | 'TAX' | 'NET' | 'FEE' | 'FIXED_FEE' | 'COST' | 'MARGIN';
  label: string;
  minor: number;
  amount: string;
  formula: string;
}

export interface PriceBreakdown {
  title: string;
  priceMinor: number;
  lines: MoneyLine[];
  marginExact: string;
  /** Налог + комиссии + себестоимость + маржа = цена, до цента */
  balanced: boolean;
  note: string;
}

export interface BoundsView {
  worldId: string;
  unit: UnitRef;
  currency: string;
  priceBasis: string;
  taxRegime: string;
  minPrice: { amount: string; minor: number | null; source: string };
  maxPrice: { amount: string; minor: number | null; source: string };
  marginFloor: { minMarginBp: string | null; amount: string | null; minor: number | null; unavailable: string | null };
  effectiveFloor: { amount: string; minor: number | null; source: string };
  cost: { lines: MoneyLine[]; fx: string | null; unavailable: string | null };
  /**
   * Р-138 (шаг 29): оценки комиссии с источниками. Когда число продавца и тарифная таблица расходятся, показываются ОБА, и
   * названо, по какому считается пол (по большему — заниженная комиссия опускала бы пол).
   */
  feeEstimates: Array<{ source: string; text: string; used: boolean }>;
  floorBreakdown: PriceBreakdown | null;
  currentBreakdown: PriceBreakdown | null;
  calculatorCheck: string[];
  gaps: Gap[];
}

const BP = 10_000n;
const divRound = (n: bigint, d: bigint): bigint => (n * 2n + d) / (2n * d);

export function fxText(fx: FxApplied, m: Messages): string {
  return m.ui.bounds.fxText(m.rate(fx.rateMicros), fx.quote, fx.rateDate, m.money(fx.sourceAmountMinor, fx.from), m.money(fx.convertedAmountMinor, fx.to), fx.rounding === 'UP');
}

export function priceBreakdown(title: string, cost: CostInputs, priceMinor: number, currency: string, m: Messages): PriceBreakdown | { unavailable: string } {
  const b = m.ui.bounds;
  if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) return { unavailable: b.noPrice };
  const vat = cost.tax.regime === 'VAT_INCLUDED' ? cost.tax.vatRateBp : 0;
  if (vat === null) return { unavailable: m.values.VAT_RATE_MISSING };
  const p = BigInt(priceMinor);
  const net = Number(divRound(p * BP, BP + BigInt(vat)));
  const tax = priceMinor - net;
  const fee = Number(divRound(p * BigInt(cost.feeRateBp), BP));
  const margin = net - fee - cost.fixedFeeMinor - cost.unitCostMinor;
  const money = (v: number) => m.money(v, currency);
  const gross = cost.tax.regime === 'VAT_INCLUDED';
  const lines: MoneyLine[] = [
    { key: 'PRICE', label: b.price, minor: priceMinor, amount: money(priceMinor), formula: gross ? b.priceGross : b.priceNet },
    gross
      ? { key: 'TAX', label: b.vat(m.percentBp(vat)), minor: tax, amount: money(tax), formula: b.vatFormula(money(priceMinor), m.decimal(1 + vat / 10_000, 4)) }
      : { key: 'TAX', label: b.salesTax, minor: 0, amount: money(0), formula: b.salesTaxFormula },
    { key: 'NET', label: b.net, minor: net, amount: money(net), formula: b.netFormula },
    { key: 'FEE', label: b.fee(m.percentBp(cost.feeRateBp)), minor: fee, amount: money(fee), formula: b.feeFormula(money(priceMinor), m.percentBp(cost.feeRateBp), gross) },
    { key: 'FIXED_FEE', label: b.fixedFee, minor: cost.fixedFeeMinor, amount: money(cost.fixedFeeMinor), formula: b.fixedFeeFormula },
    { key: 'COST', label: b.cost, minor: cost.unitCostMinor, amount: money(cost.unitCostMinor), formula: cost.fx ? fxText(cost.fx, m) : b.costFormula },
    { key: 'MARGIN', label: b.margin, minor: margin, amount: money(margin), formula: b.marginFormula(money(net), money(fee), money(cost.fixedFeeMinor), money(cost.unitCostMinor)) },
  ];
  const exact = marginBpAtPrice(cost, priceMinor);
  return {
    title, priceMinor, lines,
    marginExact: exact === null ? b.marginNotComputed : b.marginOfNet(m.percentBp(exact)),
    balanced: tax + fee + cost.fixedFeeMinor + cost.unitCostMinor + margin === priceMinor,
    note: b.roundingNote,
  };
}

/** Себестоимость в валюте единицы записи — как хранилище: курс ЕЦБ на момент, округление вверх [Р-61] */
export function costInScopeCurrency(scope: ConsoleScope, world: StandWorld): { cost: CostInputs } | { unavailableCause: string } {
  if (!scope.cost) return { unavailableCause: 'COST_PROFILE_MISSING' };
  const converted = convertMinor(scope.cost.unitCostMinor, scope.cost.currency, scope.currency, world.state.fxRates, world.now, 'UP');
  if (!converted.ok) return { unavailableCause: converted.cause };
  return { cost: { ...scope.cost, currency: scope.currency, unitCostMinor: converted.amountMinor, fx: converted.fx } };
}

export interface EffectiveFloor {
  /** max(min_price, цена минимальной маржи) — как пол Gate */
  minor: number | null;
  minMinor: number | null;
  marginFloorMinor: number | null;
  minMarginBp: number | null;
  /** Код причины, по которой пол по марже не вычисляется (Gate отклонит любую цену) */
  marginUnavailableCause: string | null;
}

export function effectiveFloor(scope: ConsoleScope, world: StandWorld): EffectiveFloor {
  const min = scope.bounds.min.status === 'RESOLVED' ? scope.bounds.min.amountMinor : null;
  const minMarginBp = scope.minMarginBp;
  if (minMarginBp === null) return { minor: min, minMinor: min, marginFloorMinor: null, minMarginBp: null, marginUnavailableCause: null };
  const converted = costInScopeCurrency(scope, world);
  if ('unavailableCause' in converted) return { minor: min, minMinor: min, marginFloorMinor: null, minMarginBp, marginUnavailableCause: converted.unavailableCause };
  const priced = storefrontPriceForMarginBp(converted.cost, minMarginBp);
  if (!priced.ok) return { minor: min, minMinor: min, marginFloorMinor: null, minMarginBp, marginUnavailableCause: priced.cause };
  return { minor: min === null ? null : Math.max(min, priced.priceMinor), minMinor: min, marginFloorMinor: priced.priceMinor, minMarginBp, marginUnavailableCause: null };
}

export function boundsView(world: StandWorld, writeScopeId: string, m: Messages): BoundsView | null {
  const scope = scopeById(world, writeScopeId);
  if (!scope) return null;
  const b = m.ui.bounds;
  const c = scope.currency;
  const money = (v: number | null) => m.money(v, c);
  const source = (r: ConsoleScope['bounds']['min']) => (r.status === 'RESOLVED' ? b.boundSource(r.sourceIds.join(', ')) : b.boundUnresolved);
  const floor = effectiveFloor(scope, world);
  const converted = costInScopeCurrency(scope, world);
  const cost = 'cost' in converted ? converted.cost : null;

  const marginFloor: BoundsView['marginFloor'] = {
    minMarginBp: floor.minMarginBp === null ? null : m.percentBp(floor.minMarginBp),
    amount: floor.marginFloorMinor === null ? null : money(floor.marginFloorMinor),
    minor: floor.marginFloorMinor,
    unavailable: floor.marginUnavailableCause ? b.marginUnavailable(m.values[floor.marginUnavailableCause as keyof typeof m.values] ?? floor.marginUnavailableCause) : null,
  };
  const floorSource = floor.minMinor === null ? b.floorNoMin
    : floor.marginFloorMinor !== null && floor.marginFloorMinor > floor.minMinor ? b.floorFromMargin(marginFloor.minMarginBp!, money(floor.minMinor))
      : b.floorFromMin;

  const breakdown = (title: string, price: number | null): PriceBreakdown | null => {
    if (!cost || price === null) return null;
    const r = priceBreakdown(title, cost, price, c, m);
    return 'unavailable' in r ? null : r;
  };

  return {
    worldId: world.id, unit: unitOf(world, scope, m), currency: c,
    priceBasis: m.values[scope.basis],
    taxRegime: m.values[scope.taxRegime],
    minPrice: { amount: boundText(scope.bounds.min, c, m), minor: floor.minMinor, source: source(scope.bounds.min) },
    maxPrice: { amount: boundText(scope.bounds.max, c, m), minor: scope.bounds.max.status === 'RESOLVED' ? scope.bounds.max.amountMinor : null, source: source(scope.bounds.max) },
    marginFloor,
    effectiveFloor: { amount: money(floor.minor), minor: floor.minor, source: floorSource },
    // Р-138: оценка продавца и тарифная таблица показываются рядом; помечена та, по которой считается пол
    feeEstimates: feeEstimatesView(scope, m),
    cost: {
      lines: cost
        ? [
            { key: 'COST', label: b.unitCost, minor: cost.unitCostMinor, amount: money(cost.unitCostMinor), formula: cost.fx ? fxText(cost.fx, m) : b.costProfile(cost.costProfileId) },
            { key: 'FEE', label: b.feeRate, minor: cost.feeRateBp, amount: m.percentBp(cost.feeRateBp), formula: b.feeOfPrice },
            { key: 'FIXED_FEE', label: b.fixedFee, minor: cost.fixedFeeMinor, amount: money(cost.fixedFeeMinor), formula: b.perSale },
          ]
        : [],
      fx: cost?.fx ? fxText(cost.fx, m) : null,
      unavailable: 'unavailableCause' in converted ? (m.values[converted.unavailableCause as keyof typeof m.values] ?? converted.unavailableCause) : null,
    },
    floorBreakdown: breakdown(b.floorBreakdown, floor.minor),
    currentBreakdown: breakdown(b.currentBreakdown, scope.currentPriceMinor),
    calculatorCheck: b.calculatorSteps(scope.taxRegime === 'VAT_INCLUDED'),
    gaps: [gap(m, 'COST_COMPONENTS'), gap(m, 'FEE_TARIFF')],
  };
}

/**
 * Р-138: действующие оценки комиссии с источниками — по какой считается пол, видно на экране. «Дороже» — это не «больше ставка»:
 * «0 % плюс 5 €» дороже «10 %» на цене ниже 50 € (ревью шага 29, находка 8). Поэтому считается пол по каждой оценке той же
 * формулой, что у базы, и помечается оценка с наибольшим полом. Неполные оценки база не берёт — их и экран не помечает.
 */
function feeEstimatesView(scope: ConsoleScope, m: Messages): Array<{ source: string; text: string; used: boolean }> {
  const estimates = scope.feeEstimates ?? [];
  if (estimates.length === 0) return [];
  const cost = scope.cost;
  const minMarginBp = scope.minMarginBp;
  const floorOf = (f: { feeRateBp: number | null; fixedFeeMinor: number | null }): number | null => {
    if (!cost || minMarginBp === null || f.feeRateBp === null || f.fixedFeeMinor === null) return null;
    const priced = storefrontPriceForMarginBp({ ...cost, feeRateBp: f.feeRateBp, fixedFeeMinor: f.fixedFeeMinor }, minMarginBp);
    return priced.ok ? priced.priceMinor : null;
  };
  const complete = estimates.filter((f) => floorOf(f) !== null);
  const strongest = complete.length === 0 ? null : [...complete].sort((a, b) => floorOf(b)! - floorOf(a)!)[0]!;
  return estimates.map((f) => ({
    source: f.source,
    text: m.ui.bounds.feeEstimate(m.values[f.source as keyof typeof m.values] ?? f.source, f.feeRateBp === null ? m.ui.common.noValue : m.percentBp(f.feeRateBp),
      f.fixedFeeMinor === null ? m.ui.common.noValue : m.money(f.fixedFeeMinor, scope.currency), f.scheduleVersion),
    used: f === strongest,
  }));
}
