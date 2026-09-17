import type { AdapterCallContext, ChannelError, DispatchBatch, DispatchResult, FieldWrite, WriteOutcome } from '@repracer/channel-port';
import type { ListingsItem, ListingsItemPatchRequest, ListingsItemSubmissionResponse } from '@repracer/amazon-client';
import { logConservative } from './conservative.ts';
import { marketplaceInfo } from './descriptor.ts';
import { channelError, classifyFailure, classifyIssue } from './errors.ts';
import { channelOwnedPricing, listingPath, minorToDecimal, productTypeOf } from './mapping.ts';
import { skuOf } from './planning.ts';
import { acquire, deadlinePassed, nowMs, observeRateLimit, openSession, type AmazonAdapterOptions } from './session.ts';

function rejectAll(batch: DispatchBatch, error: ChannelError, attemptsMade = 0): DispatchResult {
  return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'REJECTED', error })), attemptsMade };
}

/** Тело PATCH. Только our_price и fulfillment_availability: атрибутов Р-114 в теле нет по построению (проверяет контрактный стенд) */
export function patchBody(productType: string, items: readonly FieldWrite[]): ListingsItemPatchRequest {
  const first = items[0]!;
  if (first.value.field === 'QUANTITY') {
    return { productType, patches: [{ op: 'merge', path: '/attributes/fulfillment_availability',
      value: [{ fulfillment_channel_code: 'DEFAULT', quantity: first.value.quantity }] }] };
  }
  return {
    productType,
    patches: [{
      op: 'merge', path: '/attributes/purchasable_offer',
      value: items.map((w) => {
        const marketplace = w.writeScope.identity.marketplace!;
        const price = w.value.field === 'PRICE' ? w.value.price : null;
        return { marketplace_id: marketplace, currency: marketplaceInfo(marketplace)!.currency, audience: 'ALL',
          our_price: [{ schedule: [{ value_with_tax: minorToDecimal(price!.amountMinor) }] }] };
      }),
    }],
  };
}

export async function dispatchAmazon(options: AmazonAdapterOptions, ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return rejectAll(batch, opened.error);
  const { session } = opened;
  const skus = new Set(batch.items.map((w) => skuOf(w)));
  const fields = new Set(batch.items.map((w) => w.value.field));
  if (batch.items.length === 0 || skus.size !== 1 || fields.size !== 1 || fields.has('CHANNEL_MIN_PRICE')) {
    return rejectAll(batch, channelError('VALIDATION', 'BATCH', 'a batch holds writes of one SKU and one field (use planDispatch)'));
  }
  const sku = [...skus][0]!;
  const quantity = fields.has('QUANTITY');
  const marketplaces = [...new Set(batch.items.map((w) => w.writeScope.identity.marketplace!))];
  const late = deadlinePassed(options, ctx);
  if (late) return rejectAll(batch, late);

  // Чтение перед записью: тип товара и собственное ценообразование канала [AMZ_C03, AMZ_C09, Р-115]
  const readBudget = acquire(options, ctx, session, 'getListingsItem');
  if (readBudget) return rejectAll(batch, readBudget);
  const read = await session.client.request<ListingsItem>('GET', listingPath(session.sellerId, sku), {
    query: { marketplaceIds: marketplaces, includedData: ['summaries', 'attributes'] }, ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!read.ok) return rejectAll(batch, classifyFailure(read, 'ITEM', nowMs(options)), read.attempts.length);
  observeRateLimit(options, ctx, session, 'getListingsItem', read.headers);
  const productType = productTypeOf(read.data, marketplaces[0]!);
  if (!productType) return rejectAll(batch, channelError('NOT_FOUND', 'ITEM', 'listing has no summary with a product type in the requested stores'), read.attempts.length);
  logConservative(options.deps.logger, ctx, 'AMZ_C09_PRODUCT_TYPE_FROM_SUMMARIES', { marketplaces: marketplaces.length });

  const outcomes: WriteOutcome[] = [];
  let sendable = batch.items;
  if (!quantity) {
    sendable = [];
    for (const w of batch.items) {
      const owned = channelOwnedPricing(read.data, w.writeScope.identity.marketplace!);
      if (owned.repricer || owned.bounds) {
        logConservative(options.deps.logger, ctx, 'AMZ_C03_READ_BEFORE_PRICE_WRITE', { channelWriteId: w.channelWriteId, repricer: owned.repricer, bounds: owned.bounds });
        outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: owned.repricer
          ? channelError('CHANNEL_REPRICER_ACTIVE', 'ITEM', 'the offer is bound to an Amazon automated pricing rule: our engine does not write its price (Р-115)')
          : channelError('CHANNEL_BOUNDS_PRESENT', 'ITEM', 'the offer has minimum or maximum seller allowed price set in Amazon: our bounds must be the only ones (Р-114)') });
      } else {
        sendable.push(w);
      }
    }
    if (sendable.length === 0) return { batchId: batch.batchId, outcomes, attemptsMade: read.attempts.length };
  }

  const writeBudget = acquire(options, ctx, session, 'patchListingsItem');
  if (writeBudget) {
    for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: writeBudget });
    return { batchId: batch.batchId, outcomes, attemptsMade: read.attempts.length };
  }
  const sendMarketplaces = [...new Set(sendable.map((w) => w.writeScope.identity.marketplace!))];
  const patched = await session.client.request<ListingsItemSubmissionResponse>('PATCH', listingPath(session.sellerId, sku), {
    query: { marketplaceIds: quantity ? [sendMarketplaces[0]!] : sendMarketplaces, includedData: ['issues'] },
    body: patchBody(productType, sendable), idempotent: false, ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const attemptsMade = read.attempts.length + patched.attempts.length;

  if (!patched.ok) {
    const error = classifyFailure(patched, 'ITEM', nowMs(options));
    if (patched.outcomeUnknown) {
      logConservative(options.deps.logger, ctx, 'AMZ_C02_NO_TRANSPORT_RETRY_FOR_WRITES', { batchId: batch.batchId, status: String(patched.status) });
      for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error });
    } else {
      for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error });
    }
    return { batchId: batch.batchId, outcomes, attemptsMade };
  }
  observeRateLimit(options, ctx, session, 'patchListingsItem', patched.headers);
  const submission = patched.data;
  const errors = (submission.issues ?? []).filter((i) => i.severity === 'ERROR');
  if (sendable.length > 1) logConservative(options.deps.logger, ctx, 'AMZ_C06_MULTI_MARKETPLACE_ISSUES', { marketplaces: sendable.length, errors: errors.length });
  for (const w of sendable) {
    const marketplace = w.writeScope.identity.marketplace!;
    const issue = errors.find((i) => !i.marketplaceIds || i.marketplaceIds.length === 0 || i.marketplaceIds.includes(marketplace));
    if (submission.status === 'ACCEPTED' && !issue) {
      outcomes.push({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: false, submissionRef: submission.submissionId });
    } else {
      outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED',
        error: issue ? classifyIssue(issue) : channelError('VALIDATION', 'ITEM', `submission ${submission.status} without an issue for ${marketplace}`, { raiseAlert: true }) });
    }
  }
  return { batchId: batch.batchId, outcomes, attemptsMade };
}
