import type { Money, OfferIdentity } from '@repracer/channel-port';
import { marketplaceInfo } from './descriptor.ts';

/**
 * Деньги eBay — строка десятичного числа `{value: "11.49", currency: "EUR"}` [песочница]. Запись: РОВНО два знака из целых минимальных
 * единиц — три знака песочница молча округлила вверх (11.999 → 12.0) [EBAY_C03]. Чтение: песочница отдаёт и «12.0», и «11.49».
 */
export function formatMinor(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) throw new RangeError(`price must be a non-negative whole number of minor units, got ${minor}`);
  return `${Math.trunc(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** Десятичная строка или число JSON → целые минимальные единицы; дробь мельче цента, знак и экспонента — null */
export function decimalToMinor(value: unknown): number | null {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : typeof value === 'string' ? value.trim() : '';
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  if (/[1-9]/.test(frac.slice(2))) return null;
  const minor = Number(m[1]) * 100 + Number(frac.slice(0, 2));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Деньги ответа eBay: валюта — как в ответе (песочница хранила USD у предложения EBAY_DE), база — по витрине */
export function moneyOf(value: { value?: unknown; currency?: unknown } | undefined, marketplace: string | undefined): Money | null {
  const minor = decimalToMinor(value?.value);
  const info = marketplaceInfo(marketplace);
  return minor === null || typeof value?.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) || !info
    ? null : { amountMinor: minor, currency: value.currency, basis: info.basis };
}

/** Идентификатор листинга eBay (ItemID) — цифры; предложение — цифры [песочница] */
export const LISTING_ID_RE = /^\d{6,19}$/;
export const OFFER_ID_RE = /^\d{1,19}$/;

export function offerIdOf(identity: OfferIdentity): string | null {
  return identity.externalOfferId && OFFER_ID_RE.test(identity.externalOfferId) ? identity.externalOfferId : null;
}

export function listingIdOf(identity: OfferIdentity): string | null {
  return identity.externalListingId && LISTING_ID_RE.test(identity.externalListingId) ? identity.externalListingId : null;
}

/** Ключ бюджета правок листинга [Р-163]: ключ ядра (edit_budget), иначе — идентификатор листинга */
export function budgetKeyOf(write: { writeScope: { budgetScopeKey?: string; identity: OfferIdentity } }): string | null {
  return write.writeScope.budgetScopeKey ?? listingIdOf(write.writeScope.identity);
}
