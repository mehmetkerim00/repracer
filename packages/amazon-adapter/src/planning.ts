import { createHash } from 'node:crypto';
import { isNeverWritten, type AdapterCallContext, type AdapterLogger, type ChannelError, type ChannelWriteId, type DispatchBatch, type DispatchPlan, type FieldWrite, type VerifiedChannelAccount } from '@repracer/channel-port';
import { MAX_QUANTITY, marketplaceInfo } from './descriptor.ts';
import { channelError } from './errors.ts';

export const OPERATION_PATCH = 'patchListingsItem';

/** SKU единицы записи: external_sku (очередь записей) или externalUnitId (путь решения переносит SKU туда, store.ts 345) */
/** SKU — только `externalSku` идентичности (OQ-165: одно определение, `offerIdentityOf`); unit Kaufland сюда не подставляется */
export function skuOf(write: { writeScope: { identity: { externalSku?: string } } }): string | null {
  const sku = write.writeScope.identity.externalSku;
  return sku && sku.length <= 40 ? sku : null;
}

function validate(write: FieldWrite, account: VerifiedChannelAccount): ChannelError | null {
  const { value, writeScope } = write;
  if (isNeverWritten('AMAZON', value.field) || value.field === 'CHANNEL_MIN_PRICE') {
    return channelError('UNSUPPORTED', 'ITEM', 'Amazon minimum_seller_allowed_price is never written: it creates a second set of bounds in the channel (Р-111, Р-114)');
  }
  if (value.field !== writeScope.field) return channelError('VALIDATION', 'ITEM', `write value ${value.field} does not match write scope field ${writeScope.field}`);
  if (!skuOf(write)) return channelError('VALIDATION', 'ITEM', 'Amazon write scope identity needs a SKU of at most 40 characters');
  const marketplace = writeScope.identity.marketplace;
  const info = marketplaceInfo(marketplace);
  if (!info) return channelError('VALIDATION', 'ITEM', `marketplace ${marketplace ?? '(none)'} is not an Amazon store of Release 1.0`);
  if (!account.marketplaces.includes(marketplace!)) return channelError('PRECONDITION_FAILED', 'ITEM', `marketplace ${marketplace} is not enabled for the channel account`);
  // Многомаркетплейсный PATCH работает только внутри региона: аккаунт SP-API — один регион
  if (info.region !== account.region) return channelError('PRECONDITION_FAILED', 'ITEM', `marketplace ${marketplace} is outside the account region ${account.region ?? '(none)'}`);
  if (writeScope.identity.region && writeScope.identity.region !== info.region) return channelError('VALIDATION', 'ITEM', 'write scope region does not match its marketplace');
  if (value.field === 'PRICE') {
    const { amountMinor, currency, basis } = value.price;
    if (currency !== info.currency) return channelError('VALIDATION', 'ITEM', `currency ${currency} is not the currency ${info.currency} of ${marketplace}`);
    if (basis !== info.basis) return channelError('VALIDATION', 'ITEM', `price basis ${basis} is not the basis ${info.basis} of ${marketplace} (Р-58)`);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) return channelError('VALIDATION', 'ITEM', 'price must be a positive whole number of minor units');
  } else if (!Number.isSafeInteger(value.quantity) || value.quantity < 0 || value.quantity > MAX_QUANTITY) {
    return channelError('VALIDATION', 'ITEM', `quantity ${value.quantity} is outside 0..${MAX_QUANTITY}`);
  }
  return null;
}

function batchId(items: readonly FieldWrite[]): string {
  const hash = createHash('sha256');
  for (const id of items.map((w) => w.channelWriteId).sort()) hash.update(`${id}\n`);
  return `amz:${hash.digest('hex').slice(0, 16)}`;
}

/**
 * План без обращения к каналу: проверка значений; одна запись на единицу записи — старшая версия (INV-03); цены одного SKU на
 * разных витринах региона — один PATCH (marketplaceIds — массив в модели); остаток — отдельный PATCH на SKU (одно значение на регион).
 * Каждая отправка — два запроса: чтение оффера перед записью [AMZ_C03, AMZ_C09] и PATCH.
 */
export function planAmazonDispatch(_ctx: AdapterCallContext, account: VerifiedChannelAccount, writes: readonly FieldWrite[], _logger: AdapterLogger): DispatchPlan {
  const rejected: Array<{ channelWriteId: ChannelWriteId; error: ChannelError }> = [];
  const valid: FieldWrite[] = [];
  for (const w of writes) {
    const error = validate(w, account);
    if (error) rejected.push({ channelWriteId: w.channelWriteId, error });
    else valid.push(w);
  }
  const newest = new Map<string, FieldWrite>();
  for (const w of valid) {
    const cur = newest.get(w.writeScope.writeScopeId);
    if (!cur || w.version > cur.version) newest.set(w.writeScope.writeScopeId, w);
  }
  const selected: FieldWrite[] = [];
  for (const w of valid) {
    const top = newest.get(w.writeScope.writeScopeId)!;
    if (top === w) selected.push(w);
    else rejected.push({ channelWriteId: w.channelWriteId, error: top.version === w.version
      ? channelError('DUPLICATE_ACTION', 'ITEM', `duplicate write of version ${w.version} for the same write scope`)
      : channelError('STALE_VERSION', 'ITEM', `version ${w.version} is older than version ${top.version} in the same plan`) });
  }
  const batches: DispatchBatch[] = [];
  const priceGroups = new Map<string, FieldWrite[]>();
  for (const w of selected) {
    if (w.value.field === 'QUANTITY') {
      // Две единицы остатка одного SKU в регионе невозможны: ключ — аккаунт + регион + SKU
      batches.push({ batchId: batchId([w]), operation: OPERATION_PATCH, items: [w], budgetCharges: [], requestCount: 2 });
      continue;
    }
    const key = skuOf(w)!;
    const group = priceGroups.get(key) ?? [];
    if (group.some((g) => g.writeScope.identity.marketplace === w.writeScope.identity.marketplace)) {
      batches.push({ batchId: batchId([w]), operation: OPERATION_PATCH, items: [w], budgetCharges: [], requestCount: 2 });
    } else {
      group.push(w);
      priceGroups.set(key, group);
    }
  }
  for (const group of priceGroups.values()) batches.push({ batchId: batchId(group), operation: OPERATION_PATCH, items: group, budgetCharges: [], requestCount: 2 });
  return { batches, rejected };
}
