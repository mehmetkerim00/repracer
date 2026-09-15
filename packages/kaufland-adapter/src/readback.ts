import type {
  AdapterCallContext,
  ChannelError,
  ConfirmationRequest,
  ConfirmationResult,
  IdentifiedObservation,
  ReadBackRequest,
  ReadBackResult,
  WriteScopeId,
} from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { KAUFLAND_LIMITS, KAUFLAND_STOREFRONTS } from './descriptor.ts';
import { channelError, classifyTransportFailure } from './errors.ts';
import { unitObservations, type KauflandUnit } from './mapping.ts';
import { acquireBudget, nowMs, openSession, type KauflandAdapterOptions, type Session } from './session.ts';

const DEFAULT_CONFIRMATION_WINDOW_MS = 10 * 60_000;

async function readUnit(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, session: Session, storefront: string, idUnit: number,
): Promise<{ ok: true; unit: KauflandUnit } | { ok: false; error: ChannelError }> {
  const budgetError = acquireBudget(options, ctx, session, 1);
  if (budgetError) return { ok: false, error: budgetError };
  const result = await session.client.request('get', '/units/{id_unit}', {
    path: { id_unit: idUnit },
    query: { storefront: storefront as 'de' },
  });
  if (!result.ok) return { ok: false, error: classifyTransportFailure(result, 'ITEM', nowMs(options)) };
  const unit = (result.data as { data?: KauflandUnit } | undefined)?.data;
  return unit ? { ok: true, unit } : { ok: false, error: channelError('UNKNOWN', 'ITEM', 'GET /units/{id_unit} returned no unit') };
}

/** Все unit с id_offer на витринах аккаунта — остаток общий для них [Р-35, KFL_C14] */
async function readOfferUnits(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, session: Session, idOffer: string,
): Promise<{ ok: true; units: KauflandUnit[] } | { ok: false; error: ChannelError }> {
  const units: KauflandUnit[] = [];
  for (const storefront of KAUFLAND_STOREFRONTS) {
    if (!session.account.marketplaces.includes(storefront)) continue;
    const budgetError = acquireBudget(options, ctx, session, 1);
    if (budgetError) return { ok: false, error: budgetError };
    const result = await session.client.request('get', '/units', {
      query: { storefront, id_offer: idOffer, limit: KAUFLAND_LIMITS.unitsPageMax },
    });
    if (!result.ok) return { ok: false, error: classifyTransportFailure(result, 'ITEM', nowMs(options)) };
    for (const unit of (result.data as { data?: KauflandUnit[] } | undefined)?.data ?? []) {
      units.push({ ...unit, storefront: unit.storefront ?? storefront });
    }
  }
  return { ok: true, units };
}

export async function readBackKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, requests: readonly ReadBackRequest[],
): Promise<ReadBackResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) {
    return { observations: [], failures: requests.map((r) => ({ writeScopeId: r.writeScope.writeScopeId, error: opened.error })) };
  }
  const { session } = opened;
  const observedAt = new Date(nowMs(options)).toISOString();
  const observations: IdentifiedObservation[] = [];
  const failures: Array<{ writeScopeId: WriteScopeId; error: ChannelError }> = [];

  for (const request of requests) {
    const { identity, field, writeScopeId } = request.writeScope;
    if (field === 'QUANTITY') {
      if (!identity.externalOfferId) {
        failures.push({ writeScopeId, error: channelError('PRECONDITION_FAILED', 'ITEM', 'quantity read-back needs id_offer (Р-35)') });
        continue;
      }
      const read = await readOfferUnits(options, ctx, session, identity.externalOfferId);
      if (!read.ok) { failures.push({ writeScopeId, error: read.error }); continue; }
      if (read.units.length === 0) {
        failures.push({ writeScopeId, error: channelError('NOT_FOUND', 'ITEM', `no Kaufland units with id_offer ${identity.externalOfferId}`) });
        continue;
      }
      const amounts = new Set(read.units.map((u) => u.amount));
      if (amounts.size > 1) {
        logConservative(options.deps.logger, ctx, 'KFL_C14_SHARED_QUANTITY_PROPAGATION', {
          idOffer: identity.externalOfferId, distinctAmounts: amounts.size,
        });
      }
      for (const unit of read.units) observations.push(...unitObservations(unit, 'READBACK', observedAt, { fields: ['QUANTITY'] }));
      continue;
    }

    const storefront = identity.marketplace;
    const idUnit = Number(identity.externalUnitId);
    if (!storefront || !Number.isSafeInteger(idUnit) || idUnit <= 0) {
      failures.push({ writeScopeId, error: channelError('VALIDATION', 'ITEM', 'price read-back needs storefront and id_unit') });
      continue;
    }
    const read = await readUnit(options, ctx, session, storefront, idUnit);
    if (!read.ok) { failures.push({ writeScopeId, error: read.error }); continue; }
    const fields = request.fields.filter((f): f is 'PRICE' | 'CHANNEL_MIN_PRICE' => f === 'PRICE' || f === 'CHANNEL_MIN_PRICE');
    observations.push(...unitObservations(read.unit, 'READBACK', observedAt, { storefront, fields }));
  }
  return { observations, failures };
}

async function attachNotLiveReasons(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, observations: IdentifiedObservation[],
): Promise<void> {
  const notLive = observations.filter((o) => o.liveness && !o.liveness.isLive && o.identity.externalUnitId && o.identity.marketplace);
  if (notLive.length === 0) return;
  logConservative(options.deps.logger, ctx, 'KFL_C16_UNITS_STATUS_ON_DEMAND', { units: notLive.length });
  const opened = await openSession(options, ctx);
  if (!opened.ok) return;
  const { session } = opened;
  for (const storefront of KAUFLAND_STOREFRONTS) {
    const ids = [...new Set(notLive.filter((o) => o.identity.marketplace === storefront).map((o) => Number(o.identity.externalUnitId)))];
    for (let i = 0; i < ids.length; i += KAUFLAND_LIMITS.unitsStatusMaxIds) {
      const chunk = ids.slice(i, i + KAUFLAND_LIMITS.unitsStatusMaxIds);
      if (acquireBudget(options, ctx, session, 1)) return;
      const result = await session.client.request('post', '/units/status', { query: { storefront }, body: { unit_ids: chunk } });
      if (!result.ok) return;
      const rows = (result.data as { data?: Array<{ id_unit?: number; reasons?: Array<{ reason?: string }> }> } | undefined)?.data ?? [];
      for (const row of rows) {
        const reasons = (row.reasons ?? []).map((r) => r.reason ?? 'unknown_reason');
        for (const o of notLive) {
          if (o.identity.marketplace === storefront && Number(o.identity.externalUnitId) === row.id_unit && o.liveness) {
            o.liveness = { isLive: false, reasons };
          }
        }
      }
    }
  }
}

/**
 * Подтверждение применения [KFL_C08]: сравнение значения в канале с отправленным.
 * Совпало — APPLIED; не совпало в пределах окна — PENDING; после окна — NOT_APPLIED.
 * Для остатка значение должно совпасть на всех unit id_offer [KFL_C14].
 */
export async function confirmKaufland(
  options: KauflandAdapterOptions, ctx: AdapterCallContext, requests: readonly ConfirmationRequest[],
): Promise<ConfirmationResult[]> {
  const windowMs = options.confirmationWindowMs ?? DEFAULT_CONFIRMATION_WINDOW_MS;
  const results: ConfirmationResult[] = [];

  for (const request of requests) {
    const fields = request.expected.field === 'QUANTITY' ? ['QUANTITY' as const] : ['PRICE' as const];
    const read = await readBackKaufland(options, ctx, [{ writeScope: request.writeScope, fields }]);
    if (read.failures.length > 0 || read.observations.length === 0) {
      results.push({
        channelWriteId: request.channelWriteId,
        status: 'UNKNOWN',
        error: read.failures[0]?.error ?? channelError('UNKNOWN', 'ITEM', 'no observation to confirm against'),
      });
      continue;
    }
    await attachNotLiveReasons(options, ctx, read.observations);

    const matches = read.observations.map((o) =>
      request.expected.field === 'PRICE' && o.value.field === 'PRICE' ? o.value.price.amountMinor === request.expected.price.amountMinor
      : request.expected.field === 'QUANTITY' && o.value.field === 'QUANTITY' ? o.value.quantity === request.expected.quantity
      : false);
    const representative = read.observations.find((_, i) => !matches[i]) ?? read.observations[0]!;

    if (matches.every(Boolean)) {
      results.push({ channelWriteId: request.channelWriteId, status: 'APPLIED', observation: read.observations[0]! });
      continue;
    }
    const elapsed = nowMs(options) - Date.parse(request.dispatchedAt);
    logConservative(options.deps.logger, ctx, 'KFL_C08_CONFIRM_TIME_GRANULARITY', { channelWriteId: request.channelWriteId, elapsedMs: elapsed });
    if (elapsed < windowMs) {
      results.push({
        channelWriteId: request.channelWriteId,
        status: 'PENDING',
        checkAfter: new Date(nowMs(options) + Math.min(30_000, windowMs - elapsed)).toISOString(),
      });
    } else {
      results.push({ channelWriteId: request.channelWriteId, status: 'NOT_APPLIED', observation: representative });
    }
  }
  return results;
}
