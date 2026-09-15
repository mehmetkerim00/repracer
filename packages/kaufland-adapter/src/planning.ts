import { createHash } from 'node:crypto';
import type {
  AdapterCallContext,
  AdapterLogger,
  ChannelError,
  ChannelWriteId,
  DispatchBatch,
  DispatchPlan,
  FieldWrite,
  VerifiedChannelAccount,
} from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { KAUFLAND_LIMITS, KAUFLAND_STOREFRONTS, type KauflandStorefront } from './descriptor.ts';
import { channelError } from './errors.ts';

export const OPERATION_PATCH_UNIT = 'PATCH /units/{id_unit}';
export const OPERATION_BULK_UNITS = 'POST /units/bulk';

type Rejection = { channelWriteId: ChannelWriteId; error: ChannelError };

/** Unit, в который физически уходит запись. Для остатка — unit-носитель id_offer [Р-35]. */
export interface UnitTarget {
  storefront: KauflandStorefront;
  idUnit: number;
}

export function unitTargetOf(write: FieldWrite): UnitTarget | null {
  const storefront = write.writeScope.identity.marketplace;
  const idUnitRaw = write.writeScope.identity.externalUnitId;
  if (!storefront || !(KAUFLAND_STOREFRONTS as readonly string[]).includes(storefront)) return null;
  if (!idUnitRaw || !/^[1-9][0-9]{0,18}$/.test(idUnitRaw)) return null;
  const idUnit = Number(idUnitRaw);
  if (!Number.isSafeInteger(idUnit)) return null;
  return { storefront: storefront as KauflandStorefront, idUnit };
}

function validate(write: FieldWrite, account: VerifiedChannelAccount): ChannelError | null {
  const { value, writeScope } = write;

  if (value.field === 'CHANNEL_MIN_PRICE') {
    return channelError('UNSUPPORTED', 'ITEM', 'CHANNEL_MIN_PRICE is never written to Kaufland until Smart Pricing is verified (Р-41, K-07)');
  }
  if (value.field !== writeScope.field) {
    return channelError('VALIDATION', 'ITEM', `write value ${value.field} does not match write scope field ${writeScope.field}`);
  }

  const target = unitTargetOf(write);
  if (!target) {
    return channelError('VALIDATION', 'ITEM', 'write scope identity must carry storefront de|at and a numeric external_unit_id');
  }
  if (!account.marketplaces.includes(target.storefront)) {
    return channelError('PRECONDITION_FAILED', 'ITEM', `storefront ${target.storefront} is not enabled for the channel account`);
  }

  if (value.field === 'PRICE') {
    const { amountMinor, currency, basis } = value.price;
    if (currency !== 'EUR') return channelError('VALIDATION', 'ITEM', `currency ${currency} is not supported on Kaufland storefronts de/at (Р-26 applies to Kaufland only, Р-56)`);
    if (basis !== 'GROSS') return channelError('VALIDATION', 'ITEM', 'Kaufland prices are handled as GROSS until K-12 is answered');
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1 || amountMinor > KAUFLAND_LIMITS.maxListingPriceMinorEur) {
      return channelError('VALIDATION', 'ITEM', `listing_price ${amountMinor} is outside 1..${KAUFLAND_LIMITS.maxListingPriceMinorEur} cents`);
    }
  } else {
    if (!writeScope.identity.externalOfferId) {
      return channelError('PRECONDITION_FAILED', 'ITEM', 'Kaufland quantity write scope requires id_offer (Р-35)');
    }
    if (!Number.isSafeInteger(value.quantity) || value.quantity < 0 || value.quantity > KAUFLAND_LIMITS.maxAmount) {
      return channelError('VALIDATION', 'ITEM', `amount ${value.quantity} is outside 0..${KAUFLAND_LIMITS.maxAmount}`);
    }
  }
  return null;
}

function batchId(storefront: string, items: readonly FieldWrite[]): string {
  const hash = createHash('sha256');
  for (const id of items.map((w) => w.channelWriteId).sort()) hash.update(`${id}\n`);
  return `kfl:${storefront}:${hash.digest('hex').slice(0, 16)}`;
}

/**
 * План отправки без обращения к каналу:
 * 1) проверка значений и предусловий; 2) одна запись на единицу записи — старшая версия (INV-03);
 * 3) группировка по витрине; 4) пакеты до 150 unit без повтора id_unit (требование POST /units/bulk).
 * Бюджет правок не объявлен (K-05), budgetCharges пусты.
 */
export function planKauflandDispatch(
  ctx: AdapterCallContext,
  account: VerifiedChannelAccount,
  writes: readonly FieldWrite[],
  logger: AdapterLogger,
): DispatchPlan {
  const rejected: Rejection[] = [];
  const valid: FieldWrite[] = [];

  for (const write of writes) {
    const error = validate(write, account);
    if (error) {
      if (write.value.field === 'CHANNEL_MIN_PRICE') {
        logConservative(logger, ctx, 'KFL_C04_SMART_PRICING_REFUSED', { channelWriteId: write.channelWriteId });
      }
      rejected.push({ channelWriteId: write.channelWriteId, error });
    } else {
      valid.push(write);
    }
  }

  // INV-03: для каждой единицы записи отправляется только старшая версия
  const newestByScope = new Map<string, FieldWrite>();
  for (const write of valid) {
    const current = newestByScope.get(write.writeScope.writeScopeId);
    if (!current || write.version > current.version) newestByScope.set(write.writeScope.writeScopeId, write);
  }
  const selected: FieldWrite[] = [];
  for (const write of valid) {
    const newest = newestByScope.get(write.writeScope.writeScopeId);
    if (newest === write) {
      selected.push(write);
    } else if (newest && newest.version === write.version) {
      rejected.push({ channelWriteId: write.channelWriteId,
        error: channelError('DUPLICATE_ACTION', 'ITEM', `duplicate write of version ${write.version} for the same write scope`) });
    } else {
      rejected.push({ channelWriteId: write.channelWriteId,
        error: channelError('STALE_VERSION', 'ITEM', `version ${write.version} is older than version ${newest?.version} in the same plan`) });
    }
  }

  const batches: DispatchBatch[] = [];
  for (const storefront of KAUFLAND_STOREFRONTS) {
    const open: Array<{ items: FieldWrite[]; units: Set<number> }> = [];
    for (const write of selected) {
      const target = unitTargetOf(write)!;
      if (target.storefront !== storefront) continue;
      let slot = open.find((b) => b.items.length < KAUFLAND_LIMITS.bulkMaxUnits && !b.units.has(target.idUnit));
      if (!slot) {
        slot = { items: [], units: new Set() };
        open.push(slot);
      }
      slot.items.push(write);
      slot.units.add(target.idUnit);
    }
    for (const slot of open) {
      batches.push({
        batchId: batchId(storefront, slot.items),
        operation: slot.items.length === 1 ? OPERATION_PATCH_UNIT : OPERATION_BULK_UNITS,
        items: slot.items,
        budgetCharges: [],
        requestCount: 1,
      });
    }
  }

  if (selected.some((w) => w.value.field === 'PRICE')) {
    logConservative(logger, ctx, 'KFL_C10_PRICE_BASIS_GROSS_ASSUMED', { priceWrites: selected.filter((w) => w.value.field === 'PRICE').length });
  }
  return { batches, rejected };
}
