import { sellerLink } from './seller-link.ts';
import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { fulfilmentKind, sellerViewShares, holderByViewShare } from '@repracer/pricing-model';
import type { Messages } from './i18n/index.ts';
import type { Period } from './period.ts';
import { scopeById, unitOf, type StandWorld, type UnitRef } from './world.ts';

/**
 * Шаг 97 [Р-218…Р-221]: страница Competition предложения — нынешняя картина рынка (кто держит Buy Box, топ предложений, наше место и
 * разрыв до победителя), доля Buy Box за период по снимкам и диагностика «почему не в Buy Box». Не пункт меню: ссылка из строки Offers.
 * Только то, что канал назвал: нет рейтинга — нет и строки о рейтинге; держатель не назван (Amazon, A-29) — так и сказано.
 */

// ---------------------------------------------------------------------------
// Доля Buy Box [Р-220]
// ---------------------------------------------------------------------------

export interface ShareSpan { holder: 'SELF' | 'OTHER' | 'NONE'; startedAt: string; lastSeenAt: string }

/** Горизонт отрезка: дыра между снимками длиннее — «нет данных» (как BUYBOX_SPAN_HORIZON_HOURS базы; самый редкий ярус опроса — сутки, Р-47) */
export const BUYBOX_SHARE_HORIZON_MS = 24 * 3_600_000;

/** Глубина доли Buy Box: отрезки держателя живут 45 суток (0188, решение владельца шага 97); свой диапазон глубже — отрезается и названо */
export const BUYBOX_SHARE_KEEP_DAYS = 45;

export interface BuyboxShare {
  /** Наше время в периоде, мс */
  ownMs: number;
  /** Время, когда держатель известен (наш, чужой или никто), мс */
  knownMs: number;
  totalMs: number;
  /** Доля Buy Box, б. п.: наше / известное; null — известного времени нет */
  shareBp: number | null;
  /** Покрытие периода снимками, б. п.: известное / весь период */
  coverageBp: number;
}

/**
 * Доля Buy Box по снимкам, а не по продажам:
 *
 *   состояние снимка действует от его момента до следующего снимка, но не дольше горизонта (24 ч); после горизонта — «нет данных»;
 *   отрезок держателя (`started_at` … `last_seen_at`) покрывает [начало, min(начало следующего отрезка, последний снимок + горизонт, «сейчас»)];
 *   доля = время, когда держатель — мы, / время, когда держатель известен (мы, другой продавец или никто) — внутри периода [from, to).
 *
 * Время без данных в долю не входит ни числителем, ни знаменателем — его показывает покрытие.
 */
export function buyboxShare(spans: readonly ShareSpan[], fromMs: number, toMs: number, horizonMs = BUYBOX_SHARE_HORIZON_MS): BuyboxShare {
  const sorted = [...spans].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  let ownMs = 0;
  let knownMs = 0;
  sorted.forEach((s, i) => {
    const start = Date.parse(s.startedAt);
    const next = i + 1 < sorted.length ? Date.parse(sorted[i + 1]!.startedAt) : Number.POSITIVE_INFINITY;
    const end = Math.min(next, Date.parse(s.lastSeenAt) + horizonMs, toMs);
    const overlap = Math.max(0, Math.min(end, toMs) - Math.max(start, fromMs));
    knownMs += overlap;
    if (s.holder === 'SELF') ownMs += overlap;
  });
  const totalMs = Math.max(0, toMs - fromMs);
  return {
    ownMs, knownMs, totalMs,
    shareBp: knownMs > 0 ? Math.round((ownMs * 10_000) / knownMs) : null,
    coverageBp: totalMs > 0 ? Math.round((knownMs * 10_000) / totalMs) : 0,
  };
}

// ---------------------------------------------------------------------------
// Почему не в Buy Box [F]
// ---------------------------------------------------------------------------

export type DiagnosisReason =
  | { kind: 'PRICE_GAP'; gapMinor: number }
  | { kind: 'PRICE_NOT_THE_REASON' }
  | { kind: 'FULFILMENT' }
  | { kind: 'RATING'; winnerPct: number; ownPct: number }
  | { kind: 'FLOOR'; floorMinor: number };

/** Цена с доставкой: итог канала, иначе цена и доставка; доставку канал не назвал — неизвестна (null), а не «доставка 0» [Р-221] */
export const landedOf = (o: CompetitorOffer): number | null => o.totalPrice?.amountMinor ?? (o.shipping ? o.price.amountMinor + o.shipping.amountMinor : null);
const landed = landedOf;

/**
 * Причины по данным снимка, когда Buy Box не наш и держатель назван. Разрыв цены — с доставкой и только когда обе landed-цены известны;
 * исполнение — только когда канал назвал оба; рейтинг — только когда канал дал оба. Пол — когда наша цена уже на полу, а разрыв есть:
 * дальше мешает пол продавца, а не движок
 */
export function buyboxDiagnosis(snapshot: CompetitorSnapshot, floorMinor: number | null): DiagnosisReason[] | null {
  const bb = snapshot.buybox;
  if (!bb || bb.isSelf !== false) return null;
  const winner = snapshot.offers.find((o) => !o.isSelf && o.holdsBuyBox === true) ?? (bb.sellerRef ? snapshot.offers.find((o) => !o.isSelf && o.sellerRef === bb.sellerRef) : undefined);
  const self = snapshot.offers.find((o) => o.isSelf);
  const reasons: DiagnosisReason[] = [];
  const winnerLanded = bb.shipping ? bb.price.amountMinor + bb.shipping.amountMinor : winner ? landed(winner) : null;
  const ownLanded = self ? landed(self) : null;
  if (winnerLanded !== null && ownLanded !== null) {
    const gap = ownLanded - winnerLanded;
    reasons.push(gap > 0 ? { kind: 'PRICE_GAP', gapMinor: gap } : { kind: 'PRICE_NOT_THE_REASON' });
    if (gap > 0 && floorMinor !== null && self && self.price.amountMinor <= floorMinor) reasons.push({ kind: 'FLOOR', floorMinor });
  }
  if (winner && self && fulfilmentKind(winner.fulfillment) === 'CHANNEL' && fulfilmentKind(self.fulfillment) === 'MERCHANT') reasons.push({ kind: 'FULFILMENT' });
  if (winner?.rating && self?.rating && winner.rating.positivePct > self.rating.positivePct) {
    reasons.push({ kind: 'RATING', winnerPct: winner.rating.positivePct, ownPct: self.rating.positivePct });
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Колонки таблицы конкурентов [Р-146, правило 96.2]
// ---------------------------------------------------------------------------

export interface CompetitorColumns {
  /** Колонка показана: у неё есть разные значения или не одни прочерки */
  fulfilment: boolean;
  rating: boolean;
  /** Держатель назван хотя бы у одной строки; иначе о держателе говорит карточка над таблицей */
  buyBox: boolean;
  /** У каждой строки известна цена с доставкой; иначе колонка — «Price» и подпись */
  landedKnown: boolean;
  /** Колонки из одного значения — фразами подписи */
  uniform: string[];
}

/**
 * Правило таблиц шага 96.2: колонка, у которой на странице одно значение или одни прочерки, — не колонка. Одно значение у трёх и больше
 * строк — фраза подписи («Fulfilled by: Seller — every offer listed»); одни прочерки (канал поле не даёт) — колонки нет и ничего не
 * выдумывается; Buy Box — колонка только когда держатель назван у строки таблицы
 */
export function competitorColumns(rows: ReadonlyArray<{ fulfilment: string | null; rating: string | null; buyBox: boolean | null; landedKnown: boolean }>, m: Messages): CompetitorColumns {
  const c = m.ui.competition;
  const uniform: string[] = [];
  const plan = (label: string, values: ReadonlyArray<string | null>): boolean => {
    if (values.every((v) => v === null)) return false;
    if (values.length >= 3 && values.every((v) => v !== null) && new Set(values).size === 1) { uniform.push(c.uniform(label, values[0]!)); return false; }
    return true;
  };
  return {
    fulfilment: plan(c.columns.fulfilment, rows.map((r) => r.fulfilment)),
    rating: plan(c.columns.rating, rows.map((r) => r.rating)),
    buyBox: rows.some((r) => r.buyBox === true),
    landedKnown: rows.every((r) => r.landedKnown),
    uniform,
  };
}

// ---------------------------------------------------------------------------
// Факты Buy Box предложения [Р-230]: одни для страницы Competition и колонок Offers
// ---------------------------------------------------------------------------

/** Предложения снимка в порядке страницы: по цене с доставкой (неизвестна — по цене), при равенстве — по продавцу */
export function orderedOffers(snapshot: CompetitorSnapshot): CompetitorOffer[] {
  return [...snapshot.offers].sort((a, b) => (landed(a) ?? a.price.amountMinor) - (landed(b) ?? b.price.amountMinor) || (a.sellerRef ?? '').localeCompare(b.sellerRef ?? ''));
}

/** Строки таблицы страницы: первые 10 по цене с доставкой и наша строка, если она ниже десятой; у строки — её место в порядке */
export const COMPETITION_TOP_N = 10;
export function competitionRowOffers(ordered: readonly CompetitorOffer[]): Array<{ offer: CompetitorOffer; rank: number }> {
  return ordered.flatMap((offer, i) => (i < COMPETITION_TOP_N || offer.isSelf ? [{ offer, rank: i + 1 }] : []));
}

export type BuyboxHolderKind = 'SELF' | 'OTHER' | 'NONE' | 'UNKNOWN';

export interface BuyboxFacts {
  /** NO_COMPETITOR_DATA — канал конкурентов не даёт (eBay); NO_SNAPSHOT — снимков ещё нет */
  state: 'OK' | 'NO_COMPETITOR_DATA' | 'NO_SNAPSHOT';
  /** Канал называет держателя (основной источник с победителем Buy Box); нет — держатель «неизвестен» (A-29) */
  holderNamed: boolean;
  /**
   * Шаг 109 [Р-235]: доля Buy Box считается — держателя называет основной источник или источник сверки называет его долями просмотров
   * (Amazon getCompetitiveSummary: держатель большинства просмотров). Нынешний держатель на странице при этом может быть «неизвестен»
   */
  shareNamed: boolean;
  holder: BuyboxHolderKind | null;
  /** Держатель — другой продавец: его имя; канал имени не назвал — null */
  seller: string | null;
  /** Цена Buy Box: строки держателя на странице (с доставкой, если она известна), при неизвестном держателе — цена Buy Box канала */
  price: { minor: number; landed: boolean } | null;
  /** Разрыв «наша цена с доставкой − цена победителя с доставкой» — только где его называет страница: держатель другой, обе цены известны */
  gapMinor: number | null;
  /** Доля Buy Box за период; канал не называет держателя — null */
  share: BuyboxShare | null;
  observedAt: string | null;
}

export interface BuyboxFactsInput {
  snapshot: { snapshot: CompetitorSnapshot; source: string; observedAt: string } | null;
  spans: readonly ShareSpan[];
  range: { since: string; until: string };
  sources: ReadonlyArray<{ hasBuyboxWinner: boolean; role: string; holderByViewShare?: boolean }>;
}

/** Шаг 109 [Р-235]: доля Buy Box считается, если держателя называет основной источник или источник долей просмотров */
export function shareNamedBy(sources: ReadonlyArray<{ hasBuyboxWinner: boolean; role: string; holderByViewShare?: boolean }>): boolean {
  return sources.some((s) => (s.role === 'PRIMARY' && s.hasBuyboxWinner) || s.holderByViewShare === true);
}

/**
 * Правило держателя, цены, разрыва и доли — одно для страницы Competition и колонок Offers (шаг 105): колонка не может разойтись со
 * страницей. Поиск и сортировку по всему каталогу на PostgreSQL считает база тем же правилом (`consoleCatalogPage`), равенство с этой
 * функцией держит тест на демо США
 */
export function buyboxFacts(input: BuyboxFactsInput): BuyboxFacts {
  const primary = input.sources.filter((s) => s.role === 'PRIMARY');
  const holderNamed = primary.some((s) => s.hasBuyboxWinner);
  const shareNamed = shareNamedBy(input.sources);
  const share = shareNamed ? buyboxShare(input.spans, Date.parse(input.range.since), Date.parse(input.range.until)) : null;
  const none = { holder: null, seller: null, price: null, gapMinor: null, observedAt: null };
  if (primary.length === 0) return { state: 'NO_COMPETITOR_DATA', holderNamed: false, shareNamed: false, share: null, ...none };
  if (!input.snapshot) return { state: 'NO_SNAPSHOT', holderNamed, shareNamed, share, ...none };
  const snap = input.snapshot.snapshot;
  const bb = snap.buybox;
  const holder: BuyboxHolderKind = !holderNamed || (bb && bb.isSelf === null) ? 'UNKNOWN' : !bb ? 'NONE' : bb.isSelf ? 'SELF' : 'OTHER';
  const ordered = orderedOffers(snap);
  // Цена победителя с доставкой — доставка Buy Box, а если канал назвал её только у предложения-держателя — его landed (как у диагностики)
  const winnerOffer = snap.offers.find((o) => !o.isSelf && o.holdsBuyBox === true) ?? (bb?.sellerRef ? snap.offers.find((o) => !o.isSelf && o.sellerRef === bb.sellerRef) : undefined);
  const winnerLanded = bb ? (bb.shipping ? bb.price.amountMinor + bb.shipping.amountMinor : winnerOffer ? landed(winnerOffer) : null) : null;
  const self = ordered.find((o) => o.isSelf);
  const ownLanded = self ? landed(self) : null;
  const seller = holder === 'OTHER' ? bb?.sellerRef ?? snap.offers.find((o) => o.holdsBuyBox && !o.isSelf)?.sellerRef ?? null : null;
  const holderRow = competitionRowOffers(ordered).find((r) => r.offer.holdsBuyBox === true)?.offer;
  const price = holder === 'SELF' || holder === 'OTHER'
    ? holderRow
      ? { minor: landed(holderRow) ?? holderRow.price.amountMinor, landed: landed(holderRow) !== null }
      : bb ? { minor: bb.price.amountMinor + (bb.shipping?.amountMinor ?? 0), landed: bb.shipping !== undefined } : null
    : holder === 'UNKNOWN' && bb ? { minor: bb.price.amountMinor + (bb.shipping?.amountMinor ?? 0), landed: bb.shipping !== undefined } : null;
  const gapMinor = holder === 'OTHER' && winnerLanded !== null && ownLanded !== null ? ownLanded - winnerLanded : null;
  return { state: 'OK', holderNamed, shareNamed, holder, seller, price, gapMinor, share, observedAt: input.snapshot.observedAt };
}

// ---------------------------------------------------------------------------
// Экран
// ---------------------------------------------------------------------------

export interface CompetitionRow {
  seller: string;
  /** Шаг 107 [Р-232]: страница продавца на площадке — только из идентификатора, который дал канал; иначе null (имя текстом) */
  sellerUrl: string | null;
  self: boolean;
  /** Цена с доставкой; доставку канал не назвал — только цена и пометка */
  landed: string;
  price: string;
  shipping: string | null;
  fulfilment: string | null;
  rating: string | null;
  /** Канал назвал держателем; null — канал не говорит */
  buyBox: boolean | null;
  landedKnown: boolean;
  /** Шаг 109 [Р-234]: цена с купоном (с доставкой, если цена строки с доставкой), если канал её назвал; null — купона нет */
  coupon: string | null;
}

/**
 * Шаг 109 [Р-234, Р-235]: последняя сводка конкурентов канала (снимок сверки) на странице Competition — со своим моментом: предложения в
 * Buy Box по группам покупателей с долей просмотров, держатель большинства и купоны конкурентов. Цены она не двигает
 */
export interface CompetitionSummaryView {
  title: string;
  observed: { at: string; when: string };
  /** Группы покупателей по убыванию доли: «72% of views» · продавец · группа */
  segments: Array<{ share: string; seller: string; sellerUrl: string | null; self: boolean; group: string }>;
  /** Держатель большинства просмотров или «большинства нет»; null — канал групп не назвал */
  holder: string | null;
  coupons: Array<{ seller: string; sellerUrl: string | null; self: boolean; price: string; coupon: string }>;
  couponNote: string | null;
  note: string;
}

export interface CompetitionView {
  worldId: string;
  unit: UnitRef;
  /** NO_COMPETITOR_DATA — канал конкурентов не даёт (eBay); NO_SNAPSHOT — снимков ещё нет */
  state: 'OK' | 'NO_COMPETITOR_DATA' | 'NO_SNAPSHOT';
  stateText: string | null;
  /** Держатель Buy Box: фраза и тон; UNKNOWN — канал не называет держателя (A-29) */
  holder: { kind: 'SELF' | 'OTHER' | 'NONE' | 'UNKNOWN'; text: string; why: string | null } | null;
  /** Цена Buy Box с доставкой — когда держатель неизвестен, а цену канал дал (Amazon, A-29) */
  buyBoxPrice: string | null;
  /** Момент снимка: ISO и словами в поясе пространства */
  observed: { at: string; when: string; source: string } | null;
  rows: CompetitionRow[];
  columns: CompetitorColumns & { shipping: boolean };
  position: string | null;
  gap: string | null;
  share: { available: boolean; value: string | null; coverage: string | null; note: string; caption: string; clipped: boolean };
  diagnosis: { reasons: string[]; footnote: string } | null;
  summary: CompetitionSummaryView | null;
}

export interface CompetitionInput {
  snapshot: { snapshot: CompetitorSnapshot; source: string; observedAt: string } | null;
  spans: readonly ShareSpan[];
  range: { since: string; until: string; clipped: boolean };
  /** Источники канала: называет ли какой-нибудь держателя; пусто — конкурентов канал не даёт */
  sources: ReadonlyArray<{ source: string; hasBuyboxWinner: boolean; role: string; holderByViewShare?: boolean }>;
  /** Шаг 109 [Р-234, Р-235]: последняя сводка конкурентов (снимок сверки) товара; нет — блока нет */
  summary?: { snapshot: CompetitorSnapshot; source: string; observedAt: string } | null;
  floorMinor: number | null;
  period: Period;
  sourceText: (source: string) => string;
}

const NO_COLUMNS: CompetitionView['columns'] = { fulfilment: false, rating: false, buyBox: false, landedKnown: true, uniform: [], shipping: false };

export function competitionView(world: StandWorld, writeScopeId: string, input: CompetitionInput, m: Messages): CompetitionView | null {
  const scope = scopeById(world, writeScopeId);
  if (!scope) return null;
  const c = m.ui.competition;
  const unit = unitOf(world, scope, m);
  const channelName = (m.values as Record<string, string | undefined>)[unit.channel] ?? unit.channel;
  // Шаг 105 [Р-230]: держатель, цена, разрыв и доля — одним правилом с колонками Offers
  const facts = buyboxFacts(input);
  const share = (): CompetitionView['share'] => {
    if (!facts.shareNamed) return { available: false, value: null, coverage: null, note: c.share.unknown(channelName), caption: c.share.caption, clipped: input.range.clipped };
    const s = facts.share!;
    return {
      available: s.shareBp !== null, value: s.shareBp === null ? null : m.percentBp(s.shareBp), coverage: c.share.coverage(m.percentBp(s.coverageBp)),
      note: s.shareBp === null ? c.share.noData : c.share.of, caption: c.share.caption, clipped: input.range.clipped,
    };
  };
  if (facts.state === 'NO_COMPETITOR_DATA') {
    return { worldId: world.id, unit, state: 'NO_COMPETITOR_DATA', stateText: c.noCompetitorData(channelName), holder: null, observed: null, rows: [], columns: NO_COLUMNS, buyBoxPrice: null, position: null, gap: null,
      share: { available: false, value: null, coverage: null, note: c.noCompetitorData(channelName), caption: c.share.caption, clipped: false }, diagnosis: null, summary: null };
  }
  const summary = competitionSummaryView(input.summary ?? null, { channel: unit.channel, channelName, marketplace: unit.marketplace, demo: world.state.demo, currency: scope.currency }, m);
  if (facts.state === 'NO_SNAPSHOT' || !input.snapshot) {
    return { worldId: world.id, unit, state: 'NO_SNAPSHOT', stateText: c.noSnapshot, holder: null, observed: null, rows: [], columns: NO_COLUMNS, buyBoxPrice: null, position: null, gap: null, share: share(), diagnosis: null, summary };
  }
  const snap = input.snapshot.snapshot;
  const currency = scope.currency;
  const money = (v: number) => m.money(v, currency);
  const ordered = orderedOffers(snap);
  const fulfilmentText = (o: CompetitorOffer) => {
    const k = fulfilmentKind(o.fulfillment);
    return k === null ? null : k === 'CHANNEL' ? c.fulfilment.channel(channelName) : c.fulfilment.merchant;
  };
  const rows: CompetitionRow[] = competitionRowOffers(ordered).map(({ offer: o }) => ({
    seller: o.isSelf ? c.you : o.sellerRef ?? c.unnamedSeller,
    sellerUrl: sellerLink({ channel: unit.channel, marketplace: unit.marketplace, sellerRef: o.sellerRef, self: o.isSelf, demo: world.state.demo }),
    self: o.isSelf,
    landed: landed(o) !== null ? money(landed(o)!) : money(o.price.amountMinor),
    price: money(o.price.amountMinor),
    shipping: o.shipping ? money(o.shipping.amountMinor) : null,
    fulfilment: fulfilmentText(o),
    rating: o.rating ? c.rating(m.percentBp(Math.round(o.rating.positivePct * 100)), o.rating.count) : null,
    buyBox: o.holdsBuyBox === true ? true : facts.holderNamed ? false : null,
    landedKnown: landed(o) !== null,
    coupon: couponText(o, money),
  }));
  const columns = { ...competitorColumns(rows, m), shipping: rows.some((r) => r.shipping !== null) };
  const bb = snap.buybox;
  const holder: CompetitionView['holder'] = facts.holder === 'UNKNOWN'
    ? { kind: 'UNKNOWN', text: c.holderUnknown(channelName), why: c.holderUnknownWhy }
    : facts.holder === 'NONE' ? { kind: 'NONE', text: c.holderNone, why: null }
      : facts.holder === 'SELF' ? { kind: 'SELF', text: c.holderSelf, why: null }
        : { kind: 'OTHER', text: c.holderOther(facts.seller ?? c.unnamedSeller), why: null };
  const ownIndex = ordered.findIndex((o) => o.isSelf);
  const gap = facts.gapMinor === null ? null : facts.gapMinor > 0 ? c.gapAbove(money(facts.gapMinor)) : c.gapNone;
  const reasons = holder.kind === 'OTHER' ? buyboxDiagnosis(snap, input.floorMinor) : null;
  return {
    worldId: world.id, unit, state: 'OK', stateText: null, holder,
    observed: { at: input.snapshot.observedAt, when: m.when(input.snapshot.observedAt), source: input.sourceText(input.snapshot.source) },
    rows,
    columns,
    /**
     * Шаг 105 [Р-230]: доставку Buy Box канал не назвал — цена без доставки с пометкой, а не «с доставкой» и доставкой 0 (D, Р-221;
     * у PostgreSQL снимок доставку Buy Box не хранит вовсе — в отложенном)
     */
    buyBoxPrice: holder.kind === 'UNKNOWN' && bb ? (bb.shipping ? c.buyBoxPrice(money(bb.price.amountMinor + bb.shipping.amountMinor)) : c.buyBoxPriceNoShipping(money(bb.price.amountMinor))) : null,
    position: ownIndex >= 0 ? c.position(ownIndex + 1, ordered.length) : c.notListed,
    gap,
    share: share(),
    diagnosis: reasons ? {
      reasons: reasons.map((r) => r.kind === 'PRICE_GAP' ? c.why.priceGap(money(r.gapMinor))
        : r.kind === 'PRICE_NOT_THE_REASON' ? c.why.priceNotTheReason
          : r.kind === 'FULFILMENT' ? c.why.fulfilment(channelName)
            : r.kind === 'RATING' ? c.why.rating(m.percentBp(Math.round(r.winnerPct * 100)), m.percentBp(Math.round(r.ownPct * 100)))
              : c.why.floor(money(r.floorMinor))),
      footnote: c.why.footnote,
    } : null,
    summary,
  };
}

/**
 * Шаг 109 [Р-234]: цена с купоном рядом с ценой строки — того же вида: у цены с доставкой — купон плюс та же доставка. Купон в чужой валюте
 * или не дешевле цены — не купон
 */
export function couponLanded(o: Pick<CompetitorOffer, 'price' | 'shipping' | 'totalPrice' | 'couponPrice'>): number | null {
  const c = o.couponPrice;
  if (!c || c.currency !== o.price.currency || c.amountMinor >= o.price.amountMinor) return null;
  const shipping = o.totalPrice ? o.totalPrice.amountMinor - o.price.amountMinor : o.shipping ? o.shipping.amountMinor : null;
  return landed(o as CompetitorOffer) !== null && shipping !== null ? c.amountMinor + shipping : c.amountMinor;
}

const couponText = (o: CompetitorOffer, money: (v: number) => string): string | null => {
  const v = couponLanded(o);
  return v === null ? null : money(v);
};

/** Шаг 109 [Р-234, Р-235]: блок последней сводки конкурентов — только когда в ней есть группы покупателей или купоны */
export function competitionSummaryView(summary: { snapshot: CompetitorSnapshot; source: string; observedAt: string } | null,
  ctx: { channel: string; channelName: string; marketplace: string; demo: boolean; currency: string }, m: Messages): CompetitionSummaryView | null {
  if (!summary) return null;
  const c = m.ui.competition;
  const t = c.summary;
  const snap = summary.snapshot;
  const segments = snap.buyboxSegments ?? [];
  const money = (v: number) => m.money(v, ctx.currency);
  const groupOf = (membership: string) => (t.group as Record<string, string | undefined>)[membership] ?? t.group.OTHER;
  const link = (sellerRef: string | null | undefined, self: boolean) => sellerLink({ channel: ctx.channel, marketplace: ctx.marketplace, sellerRef, self, demo: ctx.demo });
  const pct = (v: number) => m.percentBp(Math.round(v * 100));
  const rows = segments.filter((s) => Number.isFinite(s.viewSharePct) && s.viewSharePct >= 0 && s.viewSharePct <= 100)
    .map((s) => ({ s, seller: s.isSelf ? c.you : s.sellerRef ?? c.unnamedSeller }))
    .sort((a, b) => b.s.viewSharePct - a.s.viewSharePct || a.seller.localeCompare(b.seller));
  const majority = holderByViewShare(segments);
  const top = sellerViewShares(segments)[0];
  const holder = segments.length === 0 ? null
    : majority?.holder === 'SELF' ? t.majoritySelf(pct(majority.viewSharePct))
      : majority ? t.majority(majority.sellerRef ?? c.unnamedSeller, pct(majority.viewSharePct))
        : top ? t.noMajority : null;
  const coupons = orderedOffers(snap).flatMap((o) => {
    const v = couponLanded(o);
    return v === null ? [] : [{ seller: o.isSelf ? c.you : o.sellerRef ?? c.unnamedSeller, sellerUrl: link(o.sellerRef, o.isSelf), self: o.isSelf,
      price: money(landed(o) ?? o.price.amountMinor), coupon: money(v) }];
  });
  if (rows.length === 0 && coupons.length === 0) return null;
  return {
    title: t.title(ctx.channelName),
    observed: { at: summary.observedAt, when: m.when(summary.observedAt) },
    segments: rows.map(({ s, seller }) => ({ share: t.viewsOf(pct(s.viewSharePct)), seller, sellerUrl: link(s.sellerRef, s.isSelf), self: s.isSelf, group: groupOf(s.membership) })),
    holder,
    coupons,
    couponNote: coupons.length > 0 ? t.couponNote : null,
    note: t.note(ctx.channelName),
  };
}
