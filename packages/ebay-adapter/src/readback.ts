import type { AdapterCallContext, ChannelError, ConfirmationRequest, ConfirmationResult, IdentifiedObservation, OfferIdentity, ReadBackRequest, ReadBackResult, WriteScopeId } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { browseItemPath, INVENTORY_PATH, marketplaceInfo } from './descriptor.ts';
import { channelError, classifyHttpFailure } from './errors.ts';
import { listingIdOf, moneyOf, offerIdOf } from './mapping.ts';
import { call, nowMs, openSession, type ResolvedOptions, type Session } from './session.ts';

const DEFAULT_CONFIRMATION_WINDOW_MS = 10 * 60_000;

/** Предложение Inventory API — НАША запись о листинге [песочница] */
export interface EbayOffer {
  offerId?: string;
  sku?: string;
  marketplaceId?: string;
  format?: string;
  availableQuantity?: number;
  pricingSummary?: { price?: { value?: unknown; currency?: unknown } };
  listing?: { listingId?: string; listingStatus?: string; soldQuantity?: number };
  status?: string;
}

/** Browse API — живой листинг: цена, оценка доступного количества, счётчик правок продавца [песочница] */
interface BrowseItem {
  price?: { value?: unknown; currency?: unknown };
  /** [песочница, E-17] НДС сверху: {taxType: VAT, taxPercentage: 19.0, includedInPrice: true, ebayCollectAndRemitTax: true} */
  taxes?: Array<{ taxType?: string; taxPercentage?: unknown; includedInPrice?: unknown }>;
  sellerItemRevision?: string;
  estimatedAvailabilities?: Array<{ estimatedAvailableQuantity?: number }>;
}

type Read<T> = { ok: true; data: T } | { ok: false; error: ChannelError };

export async function getOffer(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, offerId: string): Promise<Read<EbayOffer>> {
  const r = await call(options, ctx, session, { auth: 'USER', method: 'GET', path: `${INVENTORY_PATH}/offer/${offerId}`, operation: 'getOffer' });
  if (r.kind === 'REFUSED') return { ok: false, error: r.error };
  if (!r.result.ok) return { ok: false, error: classifyHttpFailure(r.result.status, r.result.body, 'ITEM', nowMs(options)) };
  return { ok: true, data: (r.result.body ?? {}) as EbayOffer };
}

async function getLiveListing(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, listingId: string, marketplace: string): Promise<Read<BrowseItem>> {
  logConservative(options.deps.logger, ctx, 'EBAY_C06_BROWSE_APPLICATION_TOKEN', { listingId });
  const r = await call(options, ctx, session, {
    auth: 'APPLICATION', method: 'GET', path: browseItemPath(listingId), query: { fieldgroups: 'COMPACT' },
    headers: { 'x-ebay-c-marketplace-id': marketplace }, operation: 'getItem',
  });
  if (r.kind === 'REFUSED') return { ok: false, error: r.error };
  if (!r.result.ok) return { ok: false, error: classifyHttpFailure(r.result.status, r.result.body, 'ITEM', nowMs(options)) };
  return { ok: true, data: (r.result.body ?? {}) as BrowseItem };
}

/** НДС, включённый в цену покупателя Browse: ставка в сотых долях процента (19.0 → 1900) или null */
function vatIncludedBp(item: BrowseItem): number | null {
  const vat = (item.taxes ?? []).filter((t) => t.taxType === 'VAT' && t.includedInPrice === true);
  if (vat.length !== 1) return null;
  const p = Number(vat[0]!.taxPercentage);
  return Number.isFinite(p) && p > 0 && p < 100 ? Math.round(p * 100) : null;
}

/** Цена продавца плюс НДС, округление до цента половиной вверх (песочница: 13.49 × 1.19 = 16.0531 → 16.05, 11.31 → 13.46) */
export function withVat(minor: number, vatBp: number): number {
  return Math.floor((minor * (10_000 + vatBp) + 5_000) / 10_000);
}

function livenessOf(offer: EbayOffer): IdentifiedObservation['liveness'] | undefined {
  const s = offer.listing?.listingStatus;
  return typeof s === 'string' ? { isLive: s === 'ACTIVE', reasons: s === 'ACTIVE' ? [] : [s] } : undefined;
}

/**
 * Обратное чтение. Цена — живой листинг из Browse API: GET offer показывает НАШУ запись, и после правки листинга через Trading API
 * она осталась прежней [песочница, EBAY_C05]; поэтому читаются оба, и расхождение «предложение ↔ листинг» — предупреждение (C10).
 * Количество — availableQuantity предложения (количество листинга) и его статус (OUT_OF_STOCK) [EBAY_C07].
 */
export async function readBackEbay(options: ResolvedOptions, ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { observations: [], failures: requests.map((r) => ({ writeScopeId: r.writeScope.writeScopeId, error: opened.error })) };
  const { session } = opened;
  const observations: IdentifiedObservation[] = [];
  const failures: Array<{ writeScopeId: WriteScopeId; error: ChannelError }> = [];
  const offers = new Map<string, Read<EbayOffer>>();
  const observedAt = new Date(nowMs(options)).toISOString();
  for (const r of requests) {
    const id = r.writeScope.identity;
    const offerId = offerIdOf(id);
    const fail = (error: ChannelError) => failures.push({ writeScopeId: r.writeScope.writeScopeId, error });
    if (!offerId) { fail(channelError('PRECONDITION_FAILED', 'ITEM', 'read-back needs the eBay offerId: the listing is not under Inventory API (Р-164)')); continue; }
    let offer = offers.get(offerId);
    if (!offer) { offer = await getOffer(options, ctx, session, offerId); offers.set(offerId, offer); }
    if (!offer.ok) { fail(offer.error); continue; }
    const o = offer.data;
    const marketplace = o.marketplaceId ?? id.marketplace;
    const listingId = o.listing?.listingId ?? listingIdOf(id);
    const identity: OfferIdentity = {
      ...(marketplace ? { marketplace } : {}), ...((o.sku ?? id.externalSku) ? { externalSku: (o.sku ?? id.externalSku)! } : {}),
      externalOfferId: offerId, ...(listingId ? { externalListingId: listingId } : {}),
    };
    const liveness = livenessOf(o);
    if (r.writeScope.field === 'QUANTITY') {
      if (!Number.isSafeInteger(o.availableQuantity)) {
        // Песочница: у мигрированного предложения availableQuantity не было — не угадываем [EBAY_C07]
        logConservative(options.deps.logger, ctx, 'EBAY_C07_QUANTITY_LEVEL_OFFER', { offerId, availableQuantity: null });
        fail(channelError('NOT_FOUND', 'ITEM', 'the eBay offer carries no availableQuantity: the listing quantity is not read from another level'));
        continue;
      }
      // Запись предложения — наша; у активного листинга сверяется с оценкой Browse, расхождение — предупреждение [EBAY_C13]
      if (listingId && marketplace && marketplaceInfo(marketplace) && o.listing?.listingStatus === 'ACTIVE') {
        const live = await getLiveListing(options, ctx, session, listingId, marketplace);
        const estimated = live.ok ? live.data.estimatedAvailabilities?.find((e) => Number.isSafeInteger(e.estimatedAvailableQuantity))?.estimatedAvailableQuantity : undefined;
        logConservative(options.deps.logger, ctx, 'EBAY_C13_QUANTITY_READBACK_OFFER_RECORD', {
          offerId, availableQuantity: o.availableQuantity!, estimatedAvailableQuantity: estimated ?? null,
          mismatch: estimated !== undefined && estimated !== o.availableQuantity, browse: live.ok ? 'OK' : live.error.code,
        });
      }
      observations.push({ identity, field: 'QUANTITY', value: { field: 'QUANTITY', quantity: o.availableQuantity! }, observedAt, source: 'READBACK', ...(liveness ? { liveness } : {}) });
      continue;
    }
    const recorded = moneyOf(o.pricingSummary?.price, marketplace);
    if (!recorded) { fail(channelError('NOT_FOUND', 'ITEM', 'the eBay offer carries no readable seller price')); continue; }
    if (!listingId || !marketplace || !marketplaceInfo(marketplace)) { fail(channelError('NOT_FOUND', 'ITEM', 'the eBay offer is not published: no listing to read the live price from')); continue; }
    const live = await getLiveListing(options, ctx, session, listingId, marketplace);
    if (!live.ok) { fail(live.error); continue; }
    const buyerPrice = moneyOf(live.data.price, marketplace);
    if (!buyerPrice) { fail(channelError('NOT_FOUND', 'ITEM', 'the live eBay listing carries no readable price')); continue; }
    if (buyerPrice.amountMinor !== recorded.amountMinor || buyerPrice.currency !== recorded.currency) {
      const vatBp = vatIncludedBp(live.data);
      if (vatBp !== null && buyerPrice.currency === recorded.currency && buyerPrice.amountMinor === withVat(recorded.amountMinor, vatBp)) {
        // Цена покупателя — цена продавца плюс НДС из taxes: не другой инструмент; базу цены решает Р-116 пути решения [EBAY_C14]
        logConservative(options.deps.logger, ctx, 'EBAY_C14_BROWSE_PRICE_WITH_VAT', { listingId, offerId, vatBasisPoints: vatBp });
      } else {
        logConservative(options.deps.logger, ctx, 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', { listingId, offerId, divergence: true, sellerItemRevision: live.data.sellerItemRevision ?? null });
        await options.deps.alerts.raise({
          code: 'EBAY_OFFER_LISTING_DIVERGENCE', severity: 'WARNING', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId,
          details: { listingId, offerId, reason: 'the live listing price differs from the Inventory API offer by more than the VAT: another tool edits the listing (preflight C10)' },
        });
      }
    } else {
      logConservative(options.deps.logger, ctx, 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', { listingId, offerId, divergence: false });
    }
    observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price: recorded }, effectivePrice: buyerPrice, observedAt, source: 'READBACK', ...(liveness ? { liveness } : {}) });
  }
  return { observations, failures };
}

/** Подтверждение: совпало — APPLIED; нет — PENDING в окне (Browse может отставать), NOT_APPLIED после [EBAY_C05] */
export async function confirmEbay(options: ResolvedOptions, ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]> {
  const windowMs = options.confirmationWindowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
  const out: ConfirmationResult[] = [];
  for (const r of requests) {
    const fields = r.expected.field === 'QUANTITY' ? ['QUANTITY' as const] : ['PRICE' as const];
    const read = await readBackEbay(options, ctx, [{ writeScope: r.writeScope, fields }]);
    const obs = read.observations[0];
    if (!obs) { out.push({ channelWriteId: r.channelWriteId, status: 'UNKNOWN', error: read.failures[0]?.error ?? channelError('UNKNOWN', 'ITEM', 'no observation') }); continue; }
    const matches = r.expected.field === 'PRICE' && obs.value.field === 'PRICE'
      ? obs.value.price.amountMinor === r.expected.price.amountMinor && obs.value.price.currency === r.expected.price.currency
      : r.expected.field === 'QUANTITY' && obs.value.field === 'QUANTITY' ? obs.value.quantity === r.expected.quantity : false;
    if (matches) { out.push({ channelWriteId: r.channelWriteId, status: 'APPLIED', observation: obs }); continue; }
    const elapsed = nowMs(options) - Date.parse(r.dispatchedAt);
    out.push(elapsed < windowMs
      ? { channelWriteId: r.channelWriteId, status: 'PENDING', checkAfter: new Date(nowMs(options) + Math.min(60_000, windowMs - elapsed)).toISOString() }
      : { channelWriteId: r.channelWriteId, status: 'NOT_APPLIED', observation: obs });
  }
  return out;
}
