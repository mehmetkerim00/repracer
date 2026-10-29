import type { BuyboxSegment } from '@repracer/channel-port';

/**
 * Шаг 109 [Р-235]: держатель Buy Box по сегментам покупателей. Amazon называет предложение в Buy Box не одно, а по сегментам (членство Prime,
 * место покупателя) с долей просмотров страницы товара (getCompetitiveSummary, `featuredBuyingOptions`). Решение владельца:
 *
 *   доли сегментов одного продавца складываются — одно и то же предложение в нескольких сегментах есть один держатель;
 *   держатель — продавец, у которого сумма больше половины всех просмотров (> 50 %); иначе держатель неизвестен и в долю не считается.
 *
 * Сегмент без названного продавца (не наш и без идентификатора) держателем стать не может, но его доля остаётся в знаменателе: просмотры
 * были, кому они достались — неизвестно.
 */

export interface SellerViewShare {
  /** Продавец, как его назвал канал; у нашего предложения и у неназванного продавца — null */
  sellerRef: string | null;
  isSelf: boolean;
  /** Сумма долей просмотров его сегментов, процентов */
  viewSharePct: number;
  /** Сегменты продавца: членство и доля, по убыванию доли */
  segments: Array<{ membership: string; viewSharePct: number }>;
}

export const VIEW_SHARE_MAJORITY_PCT = 50;

const valid = (s: BuyboxSegment) => Number.isFinite(s.viewSharePct) && s.viewSharePct >= 0 && s.viewSharePct <= 100;

/** Доли по продавцам: по убыванию суммы, при равенстве — наш первым, затем по имени продавца */
export function sellerViewShares(segments: readonly BuyboxSegment[]): SellerViewShare[] {
  const bySeller = new Map<string, SellerViewShare>();
  let unnamed = 0;
  for (const s of segments.filter(valid)) {
    const key = s.isSelf ? '\u0000self' : s.sellerRef ? `seller:${s.sellerRef}` : `\u0001unnamed:${unnamed++}`;
    const entry = bySeller.get(key) ?? { sellerRef: s.isSelf ? null : s.sellerRef ?? null, isSelf: s.isSelf, viewSharePct: 0, segments: [] };
    entry.viewSharePct += s.viewSharePct;
    entry.segments.push({ membership: s.membership, viewSharePct: s.viewSharePct });
    bySeller.set(key, entry);
  }
  for (const e of bySeller.values()) e.segments.sort((a, b) => b.viewSharePct - a.viewSharePct || a.membership.localeCompare(b.membership));
  return [...bySeller.values()].sort((a, b) => b.viewSharePct - a.viewSharePct || Number(b.isSelf) - Number(a.isSelf) || (a.sellerRef ?? '').localeCompare(b.sellerRef ?? ''));
}

/**
 * Держатель большинства просмотров: мы, другой продавец (с именем) или null — большинства нет, продавец не назван или сегментов нет.
 * Порог строгий: ровно половина — не большинство
 */
export function holderByViewShare(segments: readonly BuyboxSegment[]): { holder: 'SELF' | 'OTHER'; sellerRef: string | null; viewSharePct: number } | null {
  const top = sellerViewShares(segments)[0];
  if (!top || top.viewSharePct <= VIEW_SHARE_MAJORITY_PCT) return null;
  if (top.isSelf) return { holder: 'SELF', sellerRef: null, viewSharePct: top.viewSharePct };
  return top.sellerRef ? { holder: 'OTHER', sellerRef: top.sellerRef, viewSharePct: top.viewSharePct } : null;
}
