import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { fulfilmentKind, type CompeteWith } from './types.ts';

/**
 * Шаг 97 [Р-218]: картина рынка в квитанции решения и «кто подвинул цену». Дифф — против ПРЕДЫДУЩЕГО ПРИНЯТОГО снимка того же предложения
 * (отклонённые проверкой входов в сравнение не идут: их числа признаны испорченными). Только то, что канал назвал: нет поля — нет и в
 * картине; ничего не досчитывается. Чистая функция: тот же вход — та же картина, порядок предложений во входе не важен.
 */

export type CompetitorMove = 'UP' | 'DOWN' | 'APPEARED' | 'GONE';

export interface CompetitorViewRow {
  /** Продавец, как его назвал канал (псевдоним Kaufland, SellerId Amazon, продавец модели Walmart); у нашего предложения — null */
  seller: string | null;
  self: boolean;
  rank?: number;
  priceMinor: number;
  shippingMinor?: number | null;
  landedMinor?: number | null;
  fulfilment?: 'CHANNEL' | 'MERCHANT' | null;
  /** Канал назвал держателем Buy Box; нет поля — канал не сказал */
  holdsBuyBox?: boolean | null;
  ratingPct?: number;
  ratingCount?: number;
  move?: CompetitorMove;
  /** Прежняя цена (UP, DOWN) или последняя известная (GONE) */
  wasMinor?: number;
  /**
   * Шаг 101 [Р-226]: предложение не участвовало в расчёте — исключено фильтром «Compete with» (FILTER) или его исполнение неизвестно
   * (UNKNOWN). Строка остаётся в картине рынка: квитанция показывает её приглушённой, а не прячет
   */
  excluded?: CompetitorExclusion;
}

export interface CompetitorTrigger {
  seller: string | null;
  move: CompetitorMove;
  wasMinor?: number;
  nowMinor?: number;
}

export interface CompetitorView {
  currency: string;
  /** Кто подвинул цену; null — сравнивать не с чем (первый принятый снимок) или никто не двигался */
  trigger: CompetitorTrigger | null;
  offers: CompetitorViewRow[];
  /**
   * Шаг 101 [Р-226]: фильтр стратегии этого решения — по всему снимку, а не только по строкам картины: «considered 3 of 5 offers», и
   * отдельно — с неизвестным исполнением. Нет поля — стратегия соревнуется со всеми
   */
  filter?: CompetitorFilterSummary;
}

export type CompetitorExclusion = 'FILTER' | 'UNKNOWN';

export interface CompetitorFilterSummary {
  competeWith: Exclude<CompeteWith, 'ALL'>;
  /** Чужих предложений в снимке */
  total: number;
  /** Из них прошли фильтр и участвовали в расчёте */
  considered: number;
  /** Исключены, потому что канал не назвал исполнение */
  unknown: number;
}

/**
 * Шаг 101 [Р-226]: исключено ли предложение фильтром «Compete with». Исполнение — по значению канала (`fulfilmentKind`); неизвестное
 * исполнение при фильтре — исключение отдельного вида: молча не выкидывается и считается
 */
export function competitorExclusion(fulfillment: string | null | undefined, competeWith: CompeteWith | undefined): CompetitorExclusion | null {
  if (!competeWith || competeWith === 'ALL') return null;
  const kind = fulfilmentKind(fulfillment);
  if (kind === null) return 'UNKNOWN';
  return kind === competeWith ? null : 'FILTER';
}

/** Чужие предложения снимка, прошедшие фильтр, и счёт исключённых — один расчёт у движка и у картины рынка решения */
export function filterCompetitors<T extends Pick<CompetitorOffer, 'isSelf' | 'fulfillment'>>(offers: readonly T[], competeWith: CompeteWith | undefined): {
  eligible: T[]; total: number; unknown: number; filtered: number;
} {
  const others = offers.filter((o) => !o.isSelf);
  const eligible: T[] = [];
  let unknown = 0;
  let filtered = 0;
  for (const o of others) {
    const why = competitorExclusion(o.fulfillment, competeWith);
    if (why === null) eligible.push(o);
    else if (why === 'UNKNOWN') unknown += 1;
    else filtered += 1;
  }
  return { eligible, total: others.length, unknown, filtered };
}

/**
 * Шаг 101 [Р-226]: картина рынка решения со стратегией под фильтром — строки, не участвовавшие в расчёте, помечены, счёт — по всему снимку.
 * Картина общая для товара (строится одна на снимок), фильтр — у стратегии каждого предложения: пометки — копия на решение
 */
export function withCompetitorFilter(view: CompetitorView | null, offers: readonly Pick<CompetitorOffer, 'isSelf' | 'fulfillment'>[], competeWith: CompeteWith | undefined): CompetitorView | null {
  if (!view || !competeWith || competeWith === 'ALL') return view;
  const counted = filterCompetitors(offers, competeWith);
  const marked = view.offers.map((r) => {
    if (r.self || r.move === 'GONE') return r;
    const why = competitorExclusion(r.fulfilment ?? null, competeWith);
    return why ? { ...r, excluded: why } : r;
  });
  /**
   * Повод — среди тех, с кем стратегия соревнуется (найдено снимком демо: «Triggered by» называл исключённого лоукостера FBM); двинулись
   * только исключённые — повод прежний: событие было, и квитанция не придумывает другого
   */
  const eligible = view.trigger ? triggerOf(marked.filter((r) => r.move !== 'GONE' && !r.excluded),
    marked.filter((r) => r.move === 'GONE' && competitorExclusion(r.fulfilment ?? null, competeWith) === null)) : null;
  return {
    ...view,
    trigger: eligible ?? view.trigger,
    offers: marked,
    filter: { competeWith, total: counted.total, considered: counted.eligible.length, unknown: counted.unknown },
  };
}

/** Сколько строк хранится: топ по рангу, наше предложение и все, кто подвинулся или ушёл (ограничение 0187 — не больше 21) */
export const COMPETITOR_VIEW_TOP = 10;
export const COMPETITOR_VIEW_MAX_ROWS = 21;

export interface PreviousOffers {
  offers: readonly CompetitorOffer[];
}

const keyOf = (o: CompetitorOffer) => (o.isSelf ? '\u0000self' : o.sellerRef ?? null);
const landedOf = (o: CompetitorOffer) => o.totalPrice?.amountMinor ?? (o.shipping ? o.price.amountMinor + o.shipping.amountMinor : null);
const order = (a: CompetitorOffer, b: CompetitorOffer) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
  || (landedOf(a) ?? a.price.amountMinor) - (landedOf(b) ?? b.price.amountMinor)
  || (keyOf(a) ?? '').localeCompare(keyOf(b) ?? '');

function rowOf(o: CompetitorOffer): CompetitorViewRow {
  const kind = fulfilmentKind(o.fulfillment);
  return {
    seller: o.isSelf ? null : o.sellerRef ?? null,
    self: o.isSelf,
    ...(o.rank !== undefined ? { rank: o.rank } : {}),
    priceMinor: o.price.amountMinor,
    ...(o.shipping ? { shippingMinor: o.shipping.amountMinor } : {}),
    ...(landedOf(o) !== null ? { landedMinor: landedOf(o)! } : {}),
    ...(kind ? { fulfilment: kind } : {}),
    ...(o.holdsBuyBox !== undefined ? { holdsBuyBox: o.holdsBuyBox } : {}),
    ...(o.rating ? { ratingPct: o.rating.positivePct, ratingCount: o.rating.count } : {}),
  };
}

export function buildCompetitorView(current: CompetitorSnapshot, previous: PreviousOffers | null): CompetitorView | null {
  // Ревью шага 97, находка (г2): снимок без предложений — картины нет (null), а не пустой список: база требует от 1 до 21 строки, и пустая
  // картина откатила бы фиксацию снимка и всех решений товара; «все ушли» по снимку без предложений — сбой канала, а не рынок
  if (current.offers.length === 0) return null;
  const currency = current.buybox?.price.currency ?? current.offers[0]?.price.currency;
  if (!currency) return null;
  const sorted = [...current.offers].sort(order);
  const before = new Map<string, CompetitorOffer>();
  for (const o of previous?.offers ?? []) {
    const k = keyOf(o);
    if (k !== null && !before.has(k)) before.set(k, o);
  }
  const rows = sorted.map((o) => {
    const row = rowOf(o);
    const k = keyOf(o);
    if (previous && k !== null && !o.isSelf) {
      const was = before.get(k);
      if (!was) row.move = 'APPEARED';
      else if (was.price.amountMinor !== o.price.amountMinor) {
        row.move = o.price.amountMinor < was.price.amountMinor ? 'DOWN' : 'UP';
        row.wasMinor = was.price.amountMinor;
      }
    }
    return row;
  });
  const present = new Set(current.offers.map(keyOf).filter((k): k is string => k !== null));
  const gone: CompetitorViewRow[] = previous
    ? [...before.entries()].filter(([k, o]) => !present.has(k) && !o.isSelf).sort(([a], [b]) => a.localeCompare(b))
      // У ушедшего — последняя известная цена; ранг и держатель прежнего снимка к нынешнему рынку не относятся
      .map(([, o]) => { const { rank: _rank, holdsBuyBox: _holds, ...r } = rowOf(o); return { ...r, move: 'GONE' as const, wasMinor: o.price.amountMinor }; })
    : [];

  // Хранится: топ по рангу, наше предложение, все подвинувшиеся и ушедшие — не больше предела; первыми — подвинувшиеся и наше
  const keep = new Set<CompetitorViewRow>();
  for (const r of rows) if (r.self || r.move) keep.add(r);
  for (const r of gone) keep.add(r);
  for (const r of rows.slice(0, COMPETITOR_VIEW_TOP)) keep.add(r);
  const all = [...rows, ...gone].filter((r) => keep.has(r));
  const offers = all.length <= COMPETITOR_VIEW_MAX_ROWS ? all
    : [...all.filter((r) => r.self || r.move), ...all.filter((r) => !(r.self || r.move))].slice(0, COMPETITOR_VIEW_MAX_ROWS)
      .sort((a, b) => all.indexOf(a) - all.indexOf(b));
  return { currency, trigger: previous ? triggerOf(rows, gone) : null, offers };
}

/**
 * Кто подвинул цену: из чужих предложений, которые изменились, — держатель Buy Box, если двинулся он; иначе самое дешёвое из
 * подвинувшихся (появившееся или изменившее цену); иначе ушедшее. При равенстве — большее изменение, затем имя продавца
 */
function triggerOf(rows: readonly CompetitorViewRow[], gone: readonly CompetitorViewRow[]): CompetitorTrigger | null {
  const moved = rows.filter((r) => !r.self && r.move);
  const delta = (r: CompetitorViewRow) => Math.abs(r.priceMinor - (r.wasMinor ?? r.priceMinor));
  const byPrice = (a: CompetitorViewRow, b: CompetitorViewRow) =>
    (a.landedMinor ?? a.priceMinor) - (b.landedMinor ?? b.priceMinor) || delta(b) - delta(a) || (a.seller ?? '').localeCompare(b.seller ?? '');
  const pick = moved.find((r) => r.holdsBuyBox === true) ?? [...moved].sort(byPrice)[0]
    ?? [...gone].sort((a, b) => (a.wasMinor ?? 0) - (b.wasMinor ?? 0) || (a.seller ?? '').localeCompare(b.seller ?? ''))[0];
  if (!pick) return null;
  return {
    seller: pick.seller, move: pick.move!,
    ...(pick.wasMinor !== undefined ? { wasMinor: pick.wasMinor } : {}),
    ...(pick.move !== 'GONE' ? { nowMinor: pick.priceMinor } : {}),
  };
}
