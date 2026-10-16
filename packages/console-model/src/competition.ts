import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { fulfilmentKind } from '@repracer/pricing-model';
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

const landed = (o: CompetitorOffer) => o.totalPrice?.amountMinor ?? (o.shipping ? o.price.amountMinor + o.shipping.amountMinor : null);

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
// Экран
// ---------------------------------------------------------------------------

export interface CompetitionRow {
  seller: string;
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
}

export interface CompetitionInput {
  snapshot: { snapshot: CompetitorSnapshot; source: string; observedAt: string } | null;
  spans: readonly ShareSpan[];
  range: { since: string; until: string; clipped: boolean };
  /** Источники канала: называет ли какой-нибудь держателя; пусто — конкурентов канал не даёт */
  sources: ReadonlyArray<{ source: string; hasBuyboxWinner: boolean; role: string }>;
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
  const primary = input.sources.filter((s) => s.role === 'PRIMARY');
  const holderNamed = primary.some((s) => s.hasBuyboxWinner);
  const share = (): CompetitionView['share'] => {
    if (!holderNamed) return { available: false, value: null, coverage: null, note: c.share.unknown(channelName), caption: c.share.caption, clipped: input.range.clipped };
    const s = buyboxShare(input.spans, Date.parse(input.range.since), Date.parse(input.range.until));
    return {
      available: s.shareBp !== null, value: s.shareBp === null ? null : m.percentBp(s.shareBp), coverage: c.share.coverage(m.percentBp(s.coverageBp)),
      note: s.shareBp === null ? c.share.noData : c.share.of, caption: c.share.caption, clipped: input.range.clipped,
    };
  };
  if (primary.length === 0) {
    return { worldId: world.id, unit, state: 'NO_COMPETITOR_DATA', stateText: c.noCompetitorData(channelName), holder: null, observed: null, rows: [], columns: NO_COLUMNS, buyBoxPrice: null, position: null, gap: null,
      share: { available: false, value: null, coverage: null, note: c.noCompetitorData(channelName), caption: c.share.caption, clipped: false }, diagnosis: null };
  }
  if (!input.snapshot) {
    return { worldId: world.id, unit, state: 'NO_SNAPSHOT', stateText: c.noSnapshot, holder: null, observed: null, rows: [], columns: NO_COLUMNS, buyBoxPrice: null, position: null, gap: null, share: share(), diagnosis: null };
  }
  const snap = input.snapshot.snapshot;
  const currency = scope.currency;
  const money = (v: number) => m.money(v, currency);
  const ordered = [...snap.offers].sort((a, b) => (landed(a) ?? a.price.amountMinor) - (landed(b) ?? b.price.amountMinor) || (a.sellerRef ?? '').localeCompare(b.sellerRef ?? ''));
  const fulfilmentText = (o: CompetitorOffer) => {
    const k = fulfilmentKind(o.fulfillment);
    return k === null ? null : k === 'CHANNEL' ? c.fulfilment.channel(channelName) : c.fulfilment.merchant;
  };
  const rows: CompetitionRow[] = ordered.slice(0, 10).concat(ordered.slice(10).filter((o) => o.isSelf)).map((o) => ({
    seller: o.isSelf ? c.you : o.sellerRef ?? c.unnamedSeller,
    self: o.isSelf,
    landed: landed(o) !== null ? money(landed(o)!) : money(o.price.amountMinor),
    price: money(o.price.amountMinor),
    shipping: o.shipping ? money(o.shipping.amountMinor) : null,
    fulfilment: fulfilmentText(o),
    rating: o.rating ? c.rating(m.percentBp(Math.round(o.rating.positivePct * 100)), o.rating.count) : null,
    buyBox: o.holdsBuyBox === true ? true : holderNamed ? false : null,
    landedKnown: landed(o) !== null,
  }));
  const columns = { ...competitorColumns(rows, m), shipping: rows.some((r) => r.shipping !== null) };
  const bb = snap.buybox;
  const holder: CompetitionView['holder'] = !holderNamed || (bb && bb.isSelf === null)
    ? { kind: 'UNKNOWN', text: c.holderUnknown(channelName), why: c.holderUnknownWhy }
    : !bb ? { kind: 'NONE', text: c.holderNone, why: null }
      : bb.isSelf ? { kind: 'SELF', text: c.holderSelf, why: null }
        : { kind: 'OTHER', text: c.holderOther(bb.sellerRef ?? snap.offers.find((o) => o.holdsBuyBox && !o.isSelf)?.sellerRef ?? c.unnamedSeller), why: null };
  const ownIndex = ordered.findIndex((o) => o.isSelf);
  // Цена победителя с доставкой — доставка Buy Box, а если канал назвал её только у предложения-держателя — его landed (как у диагностики)
  const winnerOffer = snap.offers.find((o) => !o.isSelf && o.holdsBuyBox === true) ?? (bb?.sellerRef ? snap.offers.find((o) => !o.isSelf && o.sellerRef === bb.sellerRef) : undefined);
  const winnerLanded = bb ? (bb.shipping ? bb.price.amountMinor + bb.shipping.amountMinor : winnerOffer ? landed(winnerOffer) : null) : null;
  const self = ordered[ownIndex];
  const ownLanded = self ? landed(self) : null;
  const gap = holder.kind === 'OTHER' && winnerLanded !== null && ownLanded !== null
    ? ownLanded > winnerLanded ? c.gapAbove(money(ownLanded - winnerLanded)) : c.gapNone : null;
  const reasons = holder.kind === 'OTHER' ? buyboxDiagnosis(snap, input.floorMinor) : null;
  return {
    worldId: world.id, unit, state: 'OK', stateText: null, holder,
    observed: { at: input.snapshot.observedAt, when: m.when(input.snapshot.observedAt), source: input.sourceText(input.snapshot.source) },
    rows,
    columns,
    buyBoxPrice: holder.kind === 'UNKNOWN' && bb ? c.buyBoxPrice(money(bb.price.amountMinor + (bb.shipping?.amountMinor ?? 0))) : null,
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
  };
}
