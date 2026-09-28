import type { AdapterCallContext, ChannelError, ConfirmationRequest, ConfirmationResult, IdentifiedObservation, Money, OfferIdentity, ReadBackRequest, ReadBackResult, WriteScopeId } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { browseItemPath, INVENTORY_PATH, marketplaceInfo } from './descriptor.ts';
import { channelError, classifyHttpFailure } from './errors.ts';
import { listingIdOf, moneyOf, offerIdOf } from './mapping.ts';
import { browseAvailable, call, nowMs, openSession, type ResolvedOptions, type Session } from './session.ts';

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

/** Обратное к withVat: цена продавца, из которой округлением получилась цена покупателя; неоднозначно или нет такой — null */
export function withoutVat(buyerMinor: number, vatBp: number): number | null {
  const guess = Math.floor((buyerMinor * 10_000) / (10_000 + vatBp));
  const hits = [guess - 1, guess, guess + 1].filter((s) => s > 0 && withVat(s, vatBp) === buyerMinor);
  return hits.length === 1 ? hits[0]! : null;
}

/** Р-190 (E-21): «Browse в бою недоступен» — в журнал один раз на аккаунт за процесс, а не на каждое чтение [EBAY_C19] */
function noteBrowseUnavailable(options: ResolvedOptions, ctx: AdapterCallContext, session: Session): void {
  const id = session.account.channelAccountId;
  if (options.browseUnavailableLogged.has(id)) return;
  options.browseUnavailableLogged.add(id);
  logConservative(options.deps.logger, ctx, 'EBAY_C19_BROWSE_UNAVAILABLE_IN_PRODUCTION', { environment: options.environment, writeMode: session.account.writeMode ?? null });
}

function livenessOf(offer: EbayOffer): IdentifiedObservation['liveness'] | undefined {
  const s = offer.listing?.listingStatus;
  return typeof s === 'string' ? { isLive: s === 'ACTIVE', reasons: s === 'ACTIVE' ? [] : [s] } : undefined;
}

/**
 * Обратное чтение. В бою (PRODUCTION) Browse не вызывается [Р-190, EBAY_C19]: цена и количество — запись предложения, помеченная
 * ownRecordOnly. В песочнице — как на шаге 47:
 * Цена — живой листинг из Browse API: GET offer показывает НАШУ запись, и после правки листинга через Trading API
 * она осталась прежней [песочница, EBAY_C05, Р-186]; поэтому читаются оба: значение наблюдения — живая цена продавца, цена покупателя
 * Browse — buyerPrice, расхождение «предложение ↔ листинг» не на ставку НДС — предупреждение (C10).
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
        /**
         * Песочница (шаги 39 и 50): у мигрированного предложения availableQuantity нет, а Browse показывает у листинга 4 [EBAY_C07].
         * Шаг 51: пустое поле — «нет данных», а не ноль и не «не найдено». Наблюдения нет (ни 0, ни значение другого уровня); отказ —
         * UNKNOWN с кодом канала OFFER_QUANTITY_ABSENT: сверка записи остаётся «итог неизвестен» (не NOT_APPLIED — повторной отправки
         * нет, не расхождение с нашим значением) до предела неизвестного итога, дальше — разбор человеком, как любой неизвестный итог
         */
        logConservative(options.deps.logger, ctx, 'EBAY_C07_QUANTITY_LEVEL_OFFER', { offerId, availableQuantity: null });
        fail(channelError('UNKNOWN', 'ITEM', 'the eBay offer carries no availableQuantity: no data, not zero; the listing quantity is not read from another level',
          { channelCode: 'OFFER_QUANTITY_ABSENT' }));
        continue;
      }
      // Запись предложения — наша; у активного листинга сверяется с оценкой Browse, расхождение — предупреждение [EBAY_C13]
      if (!browseAvailable(options)) noteBrowseUnavailable(options, ctx, session);
      else if (listingId && marketplace && marketplaceInfo(marketplace) && o.listing?.listingStatus === 'ACTIVE') {
        const live = await getLiveListing(options, ctx, session, listingId, marketplace);
        const estimated = live.ok ? live.data.estimatedAvailabilities?.find((e) => Number.isSafeInteger(e.estimatedAvailableQuantity))?.estimatedAvailableQuantity : undefined;
        logConservative(options.deps.logger, ctx, 'EBAY_C13_QUANTITY_READBACK_OFFER_RECORD', {
          offerId, availableQuantity: o.availableQuantity!, estimatedAvailableQuantity: estimated ?? null,
          mismatch: estimated !== undefined && estimated !== o.availableQuantity, browse: live.ok ? 'OK' : live.error.code,
        });
      }
      observations.push({ identity, field: 'QUANTITY', value: { field: 'QUANTITY', quantity: o.availableQuantity! }, observedAt, source: 'READBACK',
        ...(browseAvailable(options) ? {} : { ownRecordOnly: true }), ...(liveness ? { liveness } : {}) });
      continue;
    }
    const recorded = moneyOf(o.pricingSummary?.price, marketplace);
    if (!recorded) { fail(channelError('NOT_FOUND', 'ITEM', 'the eBay offer carries no readable seller price')); continue; }
    if (!listingId || !marketplace || !marketplaceInfo(marketplace)) { fail(channelError('NOT_FOUND', 'ITEM', 'the eBay offer is not published: no listing to read the live price from')); continue; }
    if (!browseAvailable(options)) {
      /**
       * Р-190 (E-21): в бою Browse не вызывается, пока лицензия Buy API не выяснена. Подтверждение — НАША запись предложения: цены
       * покупателя нет (buyerPrice не заполняется), правку листинга другой программой (C10, EBAY_OFFER_LISTING_DIVERGENCE) это чтение
       * не видит, а сверка Р-116 сравнивает отправленное с нашей же записью — она ограничена, и наблюдение помечено ownRecordOnly.
       */
      noteBrowseUnavailable(options, ctx, session);
      observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price: recorded }, observedAt, source: 'READBACK', ownRecordOnly: true, ...(liveness ? { liveness } : {}) });
      continue;
    }
    const live = await getLiveListing(options, ctx, session, listingId, marketplace);
    if (!live.ok) { fail(live.error); continue; }
    const buyerPrice = moneyOf(live.data.price, marketplace);
    if (!buyerPrice) { fail(channelError('NOT_FOUND', 'ITEM', 'the live eBay listing carries no readable price')); continue; }
    /**
     * Р-186: живая цена — из Browse, GET offer отдаёт только НАШУ запись. Цена продавца наблюдения — живая цена листинга; цена
     * покупателя (Browse как есть) — отдельным полем buyerPrice, которое сверка базы цены Р-116 не читает: НДС, добавленный eBay
     * сверху (E-17), — не наша неверная база, а свойство продавца, которое решит бой.
     */
    let sellerPrice: Money = recorded;
    const vatBp = vatIncludedBp(live.data);
    if (buyerPrice.amountMinor === recorded.amountMinor && buyerPrice.currency === recorded.currency) {
      logConservative(options.deps.logger, ctx, 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', { listingId, offerId, divergence: false });
    } else if (vatBp !== null && buyerPrice.currency === recorded.currency && buyerPrice.amountMinor === withVat(recorded.amountMinor, vatBp)) {
      // Цена покупателя — цена продавца плюс НДС из taxes: листинг не правили, живая цена продавца — наша запись [EBAY_C14]
      logConservative(options.deps.logger, ctx, 'EBAY_C14_BROWSE_PRICE_WITH_VAT', { listingId, offerId, vatBasisPoints: vatBp });
      /**
       * Ревью шага 47, находка 4: покупатели платят на ставку НДС больше нашей цены — продавец должен это увидеть. Один WARNING на
       * аккаунт за процесс (не на каждое чтение), со ставкой; в тени — тоже, с пометкой режима: решение о базе цены принимается до боя.
       */
      if (!options.vatAlertedAccounts.has(session.account.channelAccountId)) {
        options.vatAlertedAccounts.add(session.account.channelAccountId);
        await options.deps.alerts.raise({
          code: 'EBAY_BUYER_PRICE_VAT_ON_TOP', severity: 'WARNING', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId,
          details: { marketplace, vatBasisPoints: vatBp, writeMode: session.account.writeMode ?? 'UNKNOWN', shadow: session.account.writeMode === 'SHADOW',
            note: session.account.writeMode === 'SHADOW' ? 'в тени: покупатели увидят цену с НДС сверху, когда аккаунт перейдёт в бой' : 'покупатели платят цену с НДС сверху' },
        });
      }
    } else {
      // Листинг правит другой инструмент (или Browse ещё не видит нашу правку): живая цена продавца — из Browse, без НДС сверху
      const net = vatBp !== null && buyerPrice.currency === recorded.currency ? withoutVat(buyerPrice.amountMinor, vatBp) : null;
      sellerPrice = { amountMinor: net ?? buyerPrice.amountMinor, currency: buyerPrice.currency, basis: recorded.basis };
      logConservative(options.deps.logger, ctx, 'EBAY_C05_PRICE_READBACK_LIVE_LISTING', { listingId, offerId, divergence: true, sellerItemRevision: live.data.sellerItemRevision ?? null });
      await options.deps.alerts.raise({
        code: 'EBAY_OFFER_LISTING_DIVERGENCE', severity: 'WARNING', tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId,
        details: { listingId, offerId, reason: 'the live listing price differs from the Inventory API offer by more than the VAT: another tool edits the listing (preflight C10)' },
      });
    }
    // effectivePrice у eBay не заполняется: цена покупателя не входит в проверку Р-116 [Р-186]
    observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price: sellerPrice }, buyerPrice, observedAt, source: 'READBACK', ...(liveness ? { liveness } : {}) });
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
