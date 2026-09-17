import type { AdapterCallContext, ChannelError, ConfirmationRequest, ConfirmationResult, IdentifiedObservation, ReadBackRequest, ReadBackResult, WriteScopeId } from '@repracer/channel-port';
import type { ListingsItem } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { marketplaceInfo } from './descriptor.ts';
import { channelError, classifyFailure } from './errors.ts';
import { channelOwnedPricing, hasDiscountedPrice, listingPath, merchantQuantity, ourPrice, purchasePrice } from './mapping.ts';
import { skuOf } from './planning.ts';
import { acquire, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions } from './session.ts';

const DEFAULT_CONFIRMATION_WINDOW_MS = 30 * 60_000;

/**
 * Обратное чтение getListingsItem: записанная цена (our_price), цена покупателя (offers — для сверки базы цены ядром, Р-116),
 * остаток MFN (DEFAULT, регион). Правило автоматического ценообразования или границы канала — отказ, требующий человека [Р-114, Р-115]:
 * изменения правил асинхронны, поэтому состояние читается при каждой сверке. Несколько витрин одного SKU — один запрос.
 */
export async function readBackAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, requests: readonly ReadBackRequest[]): Promise<ReadBackResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return { observations: [], failures: requests.map((r) => ({ writeScopeId: r.writeScope.writeScopeId, error: opened.error })) };
  const { session } = opened;
  const observations: IdentifiedObservation[] = [];
  const failures: Array<{ writeScopeId: WriteScopeId; error: ChannelError }> = [];
  const bySku = new Map<string, ReadBackRequest[]>();
  for (const r of requests) {
    const sku = skuOf(r);
    const info = marketplaceInfo(r.writeScope.identity.marketplace);
    if (!sku || !info) { failures.push({ writeScopeId: r.writeScope.writeScopeId, error: channelError('VALIDATION', 'ITEM', 'read-back needs a SKU and an Amazon marketplace') }); continue; }
    bySku.set(sku, [...(bySku.get(sku) ?? []), r]);
  }
  const observedAt = new Date(nowMs(options)).toISOString();
  for (const [sku, group] of bySku) {
    const marketplaces = [...new Set(group.map((r) => r.writeScope.identity.marketplace!))];
    const budget = acquire(options, ctx, session, 'getListingsItem');
    if (budget) { for (const r of group) failures.push({ writeScopeId: r.writeScope.writeScopeId, error: budget }); continue; }
    const read = await session.client.request<ListingsItem>('GET', listingPath(session.sellerId, sku), {
      query: { marketplaceIds: marketplaces, includedData: ['summaries', 'attributes', 'offers', 'fulfillmentAvailability', 'issues'] },
    });
    if (!read.ok) { const e = classifyFailure(read, 'ITEM', nowMs(options)); for (const r of group) failures.push({ writeScopeId: r.writeScope.writeScopeId, error: e }); continue; }
    observeRateLimit(options, ctx, session, 'getListingsItem', read.headers);
    const item = read.data;
    for (const r of group) {
      const marketplace = r.writeScope.identity.marketplace!;
      const summary = (item.summaries ?? []).find((s) => s.marketplaceId === marketplace);
      const identity = { region: session.region, marketplace, externalSku: sku, ...(summary?.asin ? { channelProductRef: summary.asin } : {}) };
      const liveness = summary?.status ? { isLive: summary.status.includes('BUYABLE'), reasons: summary.status.includes('BUYABLE') ? [] : ['NOT_BUYABLE'] } : undefined;
      if (r.writeScope.field === 'PRICE') {
        const owned = channelOwnedPricing(item, marketplace);
        if (owned.repricer || owned.bounds) {
          failures.push({ writeScopeId: r.writeScope.writeScopeId, error: owned.repricer
            ? channelError('CHANNEL_REPRICER_ACTIVE', 'ITEM', 'the offer is bound to an Amazon automated pricing rule (Р-115)')
            : channelError('CHANNEL_BOUNDS_PRESENT', 'ITEM', 'the offer has price bounds set in Amazon (Р-114)') });
          continue;
        }
        const price = ourPrice(item, marketplace);
        if (!price) { failures.push({ writeScopeId: r.writeScope.writeScopeId, error: channelError('NOT_FOUND', 'ITEM', `no our_price for ${marketplace}`) }); continue; }
        // Скидочная цена меняет цену покупателя — по ней базу цены не сверить [Р-116]
        const effective = hasDiscountedPrice(item, marketplace) ? null : purchasePrice(item, marketplace);
        logConservative(options.deps.logger, ctx, 'AMZ_C04_OUR_PRICE_VALUE_WITH_TAX', { marketplace });
        observations.push({ identity, field: 'PRICE', value: { field: 'PRICE', price }, observedAt, source: 'READBACK',
          ...(effective ? { effectivePrice: effective } : {}), ...(liveness ? { liveness } : {}) });
      } else {
        const quantity = merchantQuantity(item);
        if (quantity === null) { failures.push({ writeScopeId: r.writeScope.writeScopeId, error: channelError('NOT_FOUND', 'ITEM', 'no merchant fulfilled quantity (DEFAULT)') }); continue; }
        observations.push({ identity: { region: session.region, marketplace, externalSku: sku }, field: 'QUANTITY', value: { field: 'QUANTITY', quantity }, observedAt, source: 'READBACK' });
      }
    }
  }
  return { observations, failures };
}

/** Подтверждение [AMZ_C05]: совпало — APPLIED; нет — PENDING в окне, NOT_APPLIED после; отказ чтения — UNKNOWN с ошибкой */
export async function confirmAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, requests: readonly ConfirmationRequest[]): Promise<ConfirmationResult[]> {
  const windowMs = options.confirmationWindowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
  const out: ConfirmationResult[] = [];
  for (const r of requests) {
    const fields = r.expected.field === 'QUANTITY' ? ['QUANTITY' as const] : ['PRICE' as const];
    const read = await readBackAmazon(options, ctx, [{ writeScope: r.writeScope, fields }]);
    const obs = read.observations[0];
    if (!obs) { out.push({ channelWriteId: r.channelWriteId, status: 'UNKNOWN', error: read.failures[0]?.error ?? channelError('UNKNOWN', 'ITEM', 'no observation') }); continue; }
    const matches = r.expected.field === 'PRICE' && obs.value.field === 'PRICE' ? obs.value.price.amountMinor === r.expected.price.amountMinor
      : r.expected.field === 'QUANTITY' && obs.value.field === 'QUANTITY' ? obs.value.quantity === r.expected.quantity : false;
    if (matches) { out.push({ channelWriteId: r.channelWriteId, status: 'APPLIED', observation: obs }); continue; }
    const elapsed = nowMs(options) - Date.parse(r.dispatchedAt);
    logConservative(options.deps.logger, ctx, 'AMZ_C05_CONFIRMATION_WINDOW', { channelWriteId: r.channelWriteId, elapsedMs: elapsed });
    out.push(elapsed < windowMs
      ? { channelWriteId: r.channelWriteId, status: 'PENDING', checkAfter: new Date(nowMs(options) + Math.min(60_000, windowMs - elapsed)).toISOString() }
      : { channelWriteId: r.channelWriteId, status: 'NOT_APPLIED', observation: obs });
  }
  return out;
}
