import { effectiveFloor } from './bounds.ts';
import type { Messages } from './i18n/index.ts';
import { channelOf, type ConsoleScope, type StandWorld } from './world.ts';

/**
 * Шаг 107 [Р-233, Р-231]: рамки цены, заданные продавцом в самом канале (Amazon Min/Max на SKU), рядом с нашими границами. Мы их не пишем
 * [Р-111, Р-114]; канал называет их при обнаружении (Amazon — `purchasable_offer` в атрибутах листинга; настоящий адаптер до живого
 * аккаунта значений не читает, A-30). Рамки — без доставки, как наша цена записи: сравнение — с нашим полом и потолком.
 *
 * Четыре состояния, без домысла:
 *  - NOT_PROVIDED — канал о рамках ничего не сказал (Kaufland, eBay, Walmart такого понятия не отдают; у Amazon — наблюдения ещё нет);
 *  - NOT_SET — канал сказал «рамок нет» (свои оценённые рамки Amazon может применять, не показывая их — A-30);
 *  - NOT_READ — рамки есть, значений нет или они не в валюте предложения: в тени решения считаются, новая цена удержана (шаг 127, Р-250); у
 *    аккаунта в бою — блок предложения, как до шага 127 (шаг 128);
 *  - VALUES — значения есть; конфликт — ровно когда наш пол ниже Min канала или наш потолок выше Max канала.
 */

export type ChannelBoundsState = 'NOT_PROVIDED' | 'NOT_SET' | 'NOT_READ' | 'VALUES';

/** Наблюдение ценообразования канала у предложения (как строка состояния консоли) */
interface PricingObservation {
  automatedPricing: boolean;
  channelBounds: boolean;
  boundValues?: { minMinor: number | null; maxMinor: number | null; currency: string } | null;
  observedAt: string;
  /** Шаг 128: аккаунт сейчас в бою (строка состояния консоли несёт его режим) */
  accountLive?: boolean;
}

/**
 * Предложение целиком блокирует правило автоматического ценообразования канала (Automate Pricing) — всегда [Р-120]; рамки без значений в валюте
 * предложения — только у аккаунта в бою (шаг 128, решение владельца по П1): включение отказывает своей причиной, как до шага 127. В тени — не блок
 * (шаг 127, Р-250): решения считаются, а новая цена удержана. Как стражи базы (0231)
 */
export function channelPricingBlocks(o: Pick<PricingObservation, 'automatedPricing' | 'channelBounds' | 'boundValues' | 'accountLive'>, currency: string): boolean {
  return o.automatedPricing || (o.accountLive === true && channelBoundsUnread(o, currency));
}

/** Шаг 127 [Р-250]: рамки канала есть, а значений в валюте предложения нет — цену с ними не сравнить, и новая цена удержана (пометка, не блок) */
export function channelBoundsUnread(o: Pick<PricingObservation, 'automatedPricing' | 'channelBounds' | 'boundValues'>, currency: string): boolean {
  return !o.automatedPricing && o.channelBounds && o.boundValues?.currency !== currency;
}

export interface ChannelBoundsFacts {
  state: ChannelBoundsState;
  minMinor: number | null;
  maxMinor: number | null;
  observedAt: string | null;
  /** Шаг 128: у NOT_READ — аккаунт в бою, и рамки блокируют предложение */
  live?: boolean;
}

export function channelBoundsFacts(world: StandWorld, scope: ConsoleScope): ChannelBoundsFacts {
  const none: ChannelBoundsFacts = { state: 'NOT_PROVIDED', minMinor: null, maxMinor: null, observedAt: null };
  // Рамки на SKU — понятие Amazon; у остальных каналов наблюдений нет и быть не может
  if (channelOf(world, scope.channelAccountId) !== 'AMAZON') return none;
  const o = (world.state.offerChannelPricing as readonly (PricingObservation & { channelAccountId: string; marketplace: string; externalSku: string })[])
    .find((x) => x.channelAccountId === scope.channelAccountId && x.marketplace === scope.marketplace && x.externalSku === scope.externalUnitId);
  if (!o) return none;
  if (!o.channelBounds) return { state: 'NOT_SET', minMinor: null, maxMinor: null, observedAt: o.observedAt };
  if (!o.boundValues || o.boundValues.currency !== scope.currency) return { state: 'NOT_READ', minMinor: null, maxMinor: null, observedAt: o.observedAt, live: o.accountLive === true };
  return { state: 'VALUES', minMinor: o.boundValues.minMinor, maxMinor: o.boundValues.maxMinor, observedAt: o.observedAt };
}

export interface ChannelBoundsConflict {
  side: 'MIN' | 'MAX';
  /** Наш пол (в распродаже — пол распродажи) или наш потолок */
  ourMinor: number;
  channelMinor: number;
  clearance: boolean;
}

/** Конфликт — ровно когда наш пол ниже Min канала или наш потолок выше Max канала; равенство — не конфликт */
export function channelBoundsConflicts(world: StandWorld, scope: ConsoleScope, facts = channelBoundsFacts(world, scope)): ChannelBoundsConflict[] {
  if (facts.state !== 'VALUES') return [];
  const out: ChannelBoundsConflict[] = [];
  const floor = effectiveFloor(scope, world).minor;
  if (facts.minMinor !== null && floor !== null && floor < facts.minMinor) {
    out.push({ side: 'MIN', ourMinor: floor, channelMinor: facts.minMinor, clearance: scope.clearance != null });
  }
  const max = scope.bounds.max.status === 'RESOLVED' ? scope.bounds.max.amountMinor : null;
  if (facts.maxMinor !== null && max !== null && max > facts.maxMinor) out.push({ side: 'MAX', ourMinor: max, channelMinor: facts.maxMinor, clearance: false });
  return out;
}

export interface ChannelBoundsView {
  title: string;
  lead: string;
  state: ChannelBoundsState;
  min: string | null;
  max: string | null;
  /** Пояснение состояния: «not provided», «none set», «not read» или «без доставки» рядом со значениями */
  text: string;
  seen: string | null;
  /** Значения есть, конфликта нет */
  ok: string | null;
  conflicts: Array<{ side: 'MIN' | 'MAX'; text: string }>;
  /** Шаг 107 (G): Min канала — окну распродажи, чтобы предупредить до галочки; null — Min не назван */
  channelMinMinor: number | null;
}

export function channelBoundsView(world: StandWorld, scope: ConsoleScope, m: Messages): ChannelBoundsView {
  const c = m.ui.bounds.channelBounds;
  const money = (v: number) => m.money(v, scope.currency);
  const facts = channelBoundsFacts(world, scope);
  const when = facts.observedAt ? m.when(facts.observedAt) : '';
  const conflicts = channelBoundsConflicts(world, scope, facts).map((x) => ({
    side: x.side,
    text: x.side === 'MAX' ? c.aboveMax(money(x.ourMinor), money(x.channelMinor))
      : x.clearance ? c.belowMinClearance(money(x.ourMinor), money(x.channelMinor)) : c.belowMin(money(x.ourMinor), money(x.channelMinor)),
  }));
  const values = facts.state === 'VALUES';
  return {
    title: c.title, lead: c.lead, state: facts.state,
    min: values ? (facts.minMinor === null ? c.notSetSide : money(facts.minMinor)) : null,
    max: values ? (facts.maxMinor === null ? c.notSetSide : money(facts.maxMinor)) : null,
    text: facts.state === 'NOT_PROVIDED' ? c.notProvided : facts.state === 'NOT_SET' ? c.notSet(when) : facts.state === 'NOT_READ' ? (facts.live ? c.notReadLive(when) : c.notRead(when)) : c.withoutShipping,
    seen: values ? c.seen(when) : null,
    ok: values && conflicts.length === 0 ? c.inside : null,
    conflicts,
    channelMinMinor: values ? facts.minMinor : null,
  };
}

/** Пилюля Offers: конфликт с рамками канала — коротко; null — конфликта нет */
export function channelBoundsPill(world: StandWorld, scope: ConsoleScope, m: Messages): string | null {
  const conflicts = channelBoundsConflicts(world, scope);
  if (conflicts.length === 0) return null;
  const p = m.ui.products;
  return conflicts.map((x) => (x.side === 'MIN' ? p.belowChannelMin : p.aboveChannelMax)).join(' · ');
}
