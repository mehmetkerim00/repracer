import type {
  AdapterCallContext,
  ChannelError,
  DispatchBatch,
  DispatchResult,
  FieldWrite,
  WriteOutcome,
} from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { channelError, classifyBulkItem, classifyTransportFailure } from './errors.ts';
import { hasActiveMinimumPrice, unitObservations, type KauflandUnit } from './mapping.ts';
import { OPERATION_BULK_UNITS, OPERATION_PATCH_UNIT, unitTargetOf } from './planning.ts';
import { acquireBudget, deadlinePassed, nowMs, openSession, type KauflandAdapterOptions } from './session.ts';

interface BulkEntry {
  id_unit?: number;
  status_code?: number;
  unit?: KauflandUnit;
  message?: string;
  errors?: Array<{ field: string; message: string }>;
}

function unitData(write: FieldWrite): Record<string, number> {
  switch (write.value.field) {
    case 'PRICE':
      return { listing_price: write.value.price.amountMinor };
    case 'QUANTITY':
      // Без listing_price: иначе цена ушла бы мимо Price Gate [KFL_C03, K-13]
      return { amount: write.value.quantity };
    default:
      throw new Error('CHANNEL_MIN_PRICE must be rejected by planDispatch (Р-41)');
  }
}

function writtenValueMatches(write: FieldWrite, unit: KauflandUnit): boolean {
  return write.value.field === 'PRICE' ? unit.listing_price === write.value.price.amountMinor
    : write.value.field === 'QUANTITY' ? unit.amount === write.value.quantity
    : false;
}

function rejectAll(batch: DispatchBatch, error: ChannelError, attemptsMade = 0): DispatchResult {
  return {
    batchId: batch.batchId,
    outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'REJECTED', error })),
    attemptsMade,
  };
}

/** Отказ из-за listing_price в записи остатка — не обычная ошибка валидации [KFL_C03] */
function escalateListingPriceRequirement(
  options: KauflandAdapterOptions,
  ctx: AdapterCallContext,
  write: FieldWrite,
  error: ChannelError,
  errorText: string,
): ChannelError {
  if (write.value.field === 'QUANTITY' && error.code === 'VALIDATION' && /listing[_ ]price/i.test(errorText)) {
    logConservative(options.deps.logger, ctx, 'KFL_C03_QUANTITY_WITHOUT_LISTING_PRICE', { channelWriteId: write.channelWriteId });
    return channelError('PRECONDITION_FAILED', 'ITEM', `Kaufland requires listing_price with amount: ${error.message}`, {
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      class: 'REQUIRES_HUMAN',
    });
  }
  if (error.code === 'ACTION_NOT_ALLOWED') {
    logConservative(options.deps.logger, ctx, 'KFL_C11_NO_EDIT_BUDGET', { channelWriteId: write.channelWriteId, httpStatus: error.httpStatus ?? null });
    return { ...error, class: 'REQUIRES_HUMAN', raiseAlert: true };
  }
  return error;
}

async function alertSmartPricing(options: KauflandAdapterOptions, ctx: AdapterCallContext, unit: KauflandUnit): Promise<void> {
  if (!hasActiveMinimumPrice(unit)) return;
  logConservative(options.deps.logger, ctx, 'KFL_C05_MINIMUM_PRICE_OBSERVED', { idUnit: unit.id_unit ?? null });
  await options.deps.alerts.raise({
    code: 'KAUFLAND_SMART_PRICING_ACTIVE',
    severity: 'CRITICAL',
    tenantId: ctx.tenantId,
    channelAccountId: ctx.channelAccountId,
    correlationId: ctx.correlationId,
    details: { idUnit: unit.id_unit ?? 0, storefront: unit.storefront ?? '' },
  });
}

export async function dispatchKaufland(
  options: KauflandAdapterOptions,
  ctx: AdapterCallContext,
  batch: DispatchBatch,
): Promise<DispatchResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return rejectAll(batch, opened.error);
  const { session } = opened;

  const targets = batch.items.map(unitTargetOf);
  const storefront = targets[0]?.storefront;
  if (!storefront || targets.some((t) => !t || t.storefront !== storefront)
      || new Set(targets.map((t) => t!.idUnit)).size !== targets.length
      || batch.items.length > 150) {
    return rejectAll(batch, channelError('VALIDATION', 'BATCH', 'batch must contain unique units of one storefront, at most 150 (use planDispatch)'));
  }

  const late = deadlinePassed(options, ctx);
  if (late) return rejectAll(batch, late);
  const budgetError = acquireBudget(options, ctx, session, batch.requestCount);
  if (budgetError) return rejectAll(batch, budgetError);

  const now = new Date(nowMs(options)).toISOString();
  const single = batch.items.length === 1 && batch.operation === OPERATION_PATCH_UNIT;

  const result = single
    ? await session.client.request('patch', '/units/{id_unit}', {
        path: { id_unit: targets[0]!.idUnit },
        query: { storefront },
        body: unitData(batch.items[0]!) as never,
        idempotent: false,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    : await session.client.request('post', '/units/bulk', {
        query: { storefront },
        body: batch.items.map((w, i) => ({ id_unit: targets[i]!.idUnit, unit_data: unitData(w) })) as never,
        idempotent: false,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

  const attemptsMade = result.attempts.length;

  if (!result.ok) {
    const error = classifyTransportFailure(result, 'BATCH', nowMs(options));
    if (result.outcomeUnknown) {
      logConservative(options.deps.logger, ctx, 'KFL_C02_NO_TRANSPORT_RETRY_FOR_WRITES', {
        batchId: batch.batchId, status: String(result.status), operation: single ? OPERATION_PATCH_UNIT : OPERATION_BULK_UNITS,
      });
      return {
        batchId: batch.batchId,
        outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error })),
        attemptsMade,
      };
    }
    const text = `${result.problem?.message ?? ''} ${(result.problem?.errors ?? []).map((e) => `${e.field} ${e.message}`).join(' ')}`;
    return {
      batchId: batch.batchId,
      outcomes: batch.items.map((w) => ({
        channelWriteId: w.channelWriteId,
        status: 'REJECTED',
        error: escalateListingPriceRequirement(options, ctx, w, error, text),
      })),
      attemptsMade,
    };
  }

  const outcomes: WriteOutcome[] = [];

  if (single) {
    const write = batch.items[0]!;
    const unit = (result.data as { data?: KauflandUnit } | undefined)?.data;
    if (!unit) {
      outcomes.push({ channelWriteId: write.channelWriteId, status: 'ACCEPTED', appliedImmediately: false });
    } else {
      await alertSmartPricing(options, ctx, unit);
      const [observation] = unitObservations(unit, 'SYNC_RESPONSE', now, { storefront, fields: [write.value.field as 'PRICE' | 'QUANTITY'] });
      outcomes.push({
        channelWriteId: write.channelWriteId,
        status: 'ACCEPTED',
        appliedImmediately: writtenValueMatches(write, unit),
        ...(observation ? { observation } : {}),
      });
    }
    return { batchId: batch.batchId, outcomes, attemptsMade };
  }

  const entries = ((result.data as { data?: BulkEntry[] } | undefined)?.data ?? []);
  const byUnit = new Map<number, BulkEntry>();
  for (const entry of entries) if (typeof entry.id_unit === 'number') byUnit.set(entry.id_unit, entry);

  for (let i = 0; i < batch.items.length; i++) {
    const write = batch.items[i]!;
    const entry = byUnit.get(targets[i]!.idUnit);
    if (!entry || typeof entry.status_code !== 'number') {
      logConservative(options.deps.logger, ctx, 'KFL_C09_BULK_ITEM_MISSING', { batchId: batch.batchId, idUnit: targets[i]!.idUnit });
      outcomes.push({
        channelWriteId: write.channelWriteId,
        status: 'OUTCOME_UNKNOWN',
        error: channelError('UNKNOWN', 'ITEM', '207 response has no entry for this unit', { raiseAlert: true }),
      });
      continue;
    }
    if (entry.status_code >= 200 && entry.status_code < 300) {
      const unit = entry.unit;
      if (unit) await alertSmartPricing(options, ctx, unit);
      const [observation] = unit ? unitObservations(unit, 'SYNC_RESPONSE', now, { storefront, fields: [write.value.field as 'PRICE' | 'QUANTITY'] }) : [];
      outcomes.push({
        channelWriteId: write.channelWriteId,
        status: 'ACCEPTED',
        appliedImmediately: unit ? writtenValueMatches(write, unit) : false,
        ...(observation ? { observation } : {}),
      });
      continue;
    }
    const itemError = classifyBulkItem(entry.status_code, entry.message, entry.errors ?? []);
    const text = `${entry.message ?? ''} ${(entry.errors ?? []).map((e) => `${e.field} ${e.message}`).join(' ')}`;
    outcomes.push({
      channelWriteId: write.channelWriteId,
      status: 'REJECTED',
      error: escalateListingPriceRequirement(options, ctx, write, itemError, text),
    });
  }
  return { batchId: batch.batchId, outcomes, attemptsMade };
}
