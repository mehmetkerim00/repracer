import { sellerLink } from './seller-link.ts';
import type { Messages } from './i18n/index.ts';
import { BUYBOX_SHARE_KEEP_DAYS, buyboxFacts, type BuyboxFacts, type BuyboxFactsInput } from './competition.ts';
import { storefrontName, type StandWorld } from './world.ts';

/**
 * Шаг 105 [Р-230]: сводка Buy Box на Offers — держатель, цена Buy Box, разрыв со знаком и доля за 7 дней у каждого предложения, фильтр
 * держателя и сортировка по этим колонкам по всему каталогу. Значения — правило страницы Competition (`buyboxFacts`): колонка не может
 * разойтись со страницей; на PostgreSQL фильтр и порядок считает база тем же правилом (`consoleCatalogPage`).
 *
 * Честность (D): eBay конкурентов не даёт — «нет данных»; Amazon называет цену Buy Box, но не держателя (A-29) — «неизвестен», и это не
 * «другой продавец»; Walmart не называет исполнения; пустое — прочерком, а не нулём.
 */

/** Группа держателя строки: четыре состояния страницы Competition и два «нет данных» */
export type OfferHolderKind = 'SELF' | 'OTHER' | 'NONE' | 'UNKNOWN' | 'NO_SNAPSHOT' | 'NO_DATA';
export const OFFER_HOLDER_FILTERS = ['SELF', 'OTHER', 'NONE', 'UNKNOWN', 'NO_DATA'] as const;
export type OfferHolderFilterValue = (typeof OFFER_HOLDER_FILTERS)[number];
export const OFFER_SORT_KEYS = ['holder', 'price', 'gap', 'share'] as const;
export type OfferSortKeyValue = (typeof OFFER_SORT_KEYS)[number];
export type OfferSort = { key: OfferSortKeyValue; dir: 'asc' | 'desc' };
/** Доля в колонке — за те же 7 дней, что страница Competition по умолчанию */
export const OFFER_SHARE_PERIOD = { preset: '7d' } as const;
export { BUYBOX_SHARE_KEEP_DAYS };

export interface BuyboxCells {
  holder: { kind: OfferHolderKind; text: string };
  /** Держатель — другой продавец: его имя; не назван — null */
  seller: string | null;
  /** Шаг 107 [Р-232]: страница держателя на площадке — только из идентификатора канала; иначе null */
  sellerUrl: string | null;
  currency: string;
  /** Цена Buy Box: с доставкой, если доставка известна, иначе цена с пометкой; нет — null (прочерк) */
  price: string | null;
  priceMinor: number | null;
  priceLanded: boolean | null;
  priceNote: string | null;
  /** Разрыв со знаком «наша − Buy Box» — где его называет страница Competition (держатель другой, обе цены с доставкой известны) */
  gap: string | null;
  gapMinor: number | null;
  /** Доля за 7 дней; канал не называет держателя или известного времени нет — null (прочерк) */
  share: string | null;
  shareBp: number | null;
  observedAt: string | null;
  /** Подсказка ячейки: момент и возраст снимка или почему данных нет */
  title: string;
}

export function offerHolderKind(f: BuyboxFacts): OfferHolderKind {
  return f.state === 'NO_COMPETITOR_DATA' ? 'NO_DATA' : f.state === 'NO_SNAPSHOT' ? 'NO_SNAPSHOT' : f.holder!;
}

/** Деньги со знаком: «+$0.50», «−$0.25», «$0.00» — знак минус типографский, как у процента изменения */
export function signedMoney(minor: number, currency: string, m: Messages): string {
  return minor > 0 ? `+${m.money(minor, currency)}` : minor < 0 ? `−${m.money(-minor, currency)}` : m.money(0, currency);
}

export function buyboxCells(f: BuyboxFacts, ctx: { currency: string; channel: string; marketplace: string; demo: boolean; now: string }, m: Messages): BuyboxCells {
  const b = m.ui.products.buybox;
  const channelName = (m.values as Record<string, string | undefined>)[ctx.channel] ?? ctx.channel;
  const kind = offerHolderKind(f);
  const text = kind === 'SELF' ? b.you : kind === 'OTHER' ? f.seller ?? m.ui.competition.unnamedSeller : kind === 'NONE' ? b.none : kind === 'UNKNOWN' ? b.unknown : '–';
  const age = f.observedAt ? Math.max(0, Math.floor((Date.parse(ctx.now) - Date.parse(f.observedAt)) / 60_000)) : null;
  const title = kind === 'NO_DATA' ? b.noData(channelName)
    : kind === 'NO_SNAPSHOT' || !f.observedAt ? b.noSnapshot
      : `${b.asOf(m.when(f.observedAt), b.age(age!))}${f.shareNamed ? '' : `. ${b.shareUnknown(channelName)}`}`;
  return {
    holder: { kind, text },
    seller: kind === 'OTHER' ? f.seller : null,
    sellerUrl: kind === 'OTHER' ? sellerLink({ channel: ctx.channel, marketplace: ctx.marketplace, sellerRef: f.seller, self: false, demo: ctx.demo }) : null,
    currency: ctx.currency,
    price: f.price ? m.money(f.price.minor, ctx.currency) : null,
    priceMinor: f.price?.minor ?? null,
    priceLanded: f.price ? f.price.landed : null,
    priceNote: f.price && !f.price.landed ? b.noShipping : null,
    gap: f.gapMinor === null ? null : signedMoney(f.gapMinor, ctx.currency, m),
    gapMinor: f.gapMinor,
    share: f.share?.shareBp == null ? null : m.percentBp(f.share.shareBp),
    shareBp: f.share?.shareBp ?? null,
    observedAt: f.observedAt,
    title,
  };
}

/** Фильтр держателя: «нет данных» — и канал без конкурентов, и ещё нет снимка; «неизвестен» — не «другой продавец» (E4) */
export function matchesHolder(kind: OfferHolderKind, filter: OfferHolderFilterValue): boolean {
  return filter === 'NO_DATA' ? kind === 'NO_DATA' || kind === 'NO_SNAPSHOT' : kind === filter;
}

const HOLDER_RANK: Partial<Record<OfferHolderKind, number>> = { SELF: 0, OTHER: 1, NONE: 2, UNKNOWN: 3 };

/** Ключ сортировки колонки; нет значения — null: такие строки в конце в обе стороны */
export function offerSortValue(c: BuyboxCells, key: OfferSortKeyValue): number | null {
  return key === 'holder' ? HOLDER_RANK[c.holder.kind] ?? null : key === 'price' ? c.priceMinor : key === 'gap' ? c.gapMinor : c.shareBp;
}

/**
 * Порядок Offers по колонке Buy Box: по значению в выбранную сторону, без значения — в конце, при равенстве — порядок каталога. Тот же
 * порядок база даёт запросом (`ORDER BY … NULLS LAST, created_at, write_scope_id`); `items` — в порядке каталога
 */
export function sortOffers<T extends { cells: BuyboxCells }>(items: readonly T[], sort: OfferSort): T[] {
  return items.map((item, i) => ({ item, i, v: offerSortValue(item.cells, sort.key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? a.i - b.i : a.v === null ? 1 : -1;
      return (sort.dir === 'asc' ? a.v - b.v : b.v - a.v) || a.i - b.i;
    })
    .map((x) => x.item);
}

/** Ячейки Buy Box единицы по её снимку и отрезкам — правило страницы Competition */
export function offerBuyboxCells(input: BuyboxFactsInput, ctx: { currency: string; channel: string; marketplace: string; demo: boolean; now: string }, m: Messages): BuyboxCells {
  return buyboxCells(buyboxFacts(input), ctx, m);
}

/** Выбор витрины фильтра Offers: аккаунт и витрина — значение, витрина словами — подпись; одинаковые подписи различает канал */
export function storefrontChoices(world: StandWorld, m: Messages): Array<{ value: string; label: string }> {
  const out = world.accounts.flatMap((a) => a.marketplaces.map((mk) => ({ value: `${a.channelAccountId}|${mk}`, label: storefrontName(a.channel, mk, m), channel: a.channel })));
  return out.map((x) => ({
    value: x.value,
    label: out.filter((y) => y.label === x.label).length > 1 ? `${x.label} · ${(m.values as Record<string, string | undefined>)[x.channel] ?? x.channel}` : x.label,
  }));
}
