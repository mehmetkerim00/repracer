import { createHash } from 'node:crypto';
import { isNeverWritten, type AdapterCallContext, type AdapterLogger, type BudgetCharge, type ChannelError, type ChannelWriteId, type DispatchBatch, type DispatchPlan, type FieldWrite, type VerifiedChannelAccount } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { BULK_UPDATE_MAX, MAX_QUANTITY, marketplaceInfo, OPERATION_BULK_UPDATE } from './descriptor.ts';
import { channelError } from './errors.ts';
import { budgetKeyOf, listingIdOf, offerIdOf } from './mapping.ts';

/**
 * Р-164: запись — только в листинг, который уже под Inventory API. Признак — идентификатор предложения eBay (offerId) в идентичности
 * записи: он появляется только у предложения Inventory API (создание или `bulk_migrate_listing`). Без него запись отклоняется ДО
 * обращения к каналу — ни миграции, ни записи по SKU «наугад» (песочница: запись по SKU старого листинга — 25604 «SKU not found»).
 */
export const NOT_MIGRATED_LOG_CODE = 'EBAY_R164_WRITE_TO_UNMIGRATED_LISTING';

export function validateWrite(write: FieldWrite, account: VerifiedChannelAccount, logger: AdapterLogger | null, ctx: AdapterCallContext | null): ChannelError | null {
  const { value, writeScope } = write;
  if (isNeverWritten('EBAY', value.field) || value.field === 'CHANNEL_MIN_PRICE') {
    return channelError('UNSUPPORTED', 'ITEM', 'eBay has no channel minimum price field in this adapter (Р-12 applies to Kaufland only)');
  }
  if (value.field !== writeScope.field) return channelError('VALIDATION', 'ITEM', `write value ${value.field} does not match write scope field ${writeScope.field}`);
  const identity = writeScope.identity;
  if (!offerIdOf(identity)) {
    logger?.log({
      level: 'WARN', code: NOT_MIGRATED_LOG_CODE, message: 'write refused before any eBay call: the listing is not under Inventory API (no offerId); migration only with owner consent (Р-164, Р-2)',
      ...(ctx ? { correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId } : {}),
      details: { channelWriteId: write.channelWriteId, listingId: identity.externalListingId ?? null },
    });
    return channelError('PRECONDITION_FAILED', 'ITEM', 'the eBay listing is not under Inventory API: no offerId in the write identity; it is written only after migration with owner consent (Р-164)');
  }
  if (!listingIdOf(identity)) return channelError('VALIDATION', 'ITEM', 'eBay write identity needs the listing id (ItemID): the edit budget is counted per listing (Р-19)');
  const marketplace = identity.marketplace;
  const info = marketplaceInfo(marketplace);
  {
    // Витрина — часть ключа и цены, и остатка: предложение (и его количество листинга) у SKU своё на каждой витрине
    if (!info) return channelError('VALIDATION', 'ITEM', `marketplace ${marketplace ?? '(none)'} is not an eBay storefront of Release 1.0`);
    if (!account.marketplaces.includes(marketplace!)) return channelError('PRECONDITION_FAILED', 'ITEM', `marketplace ${marketplace} is not enabled for the channel account`);
  }
  if (value.field === 'PRICE') {
    const { amountMinor, currency, basis } = value.price;
    if (currency !== info!.currency) {
      // Песочница приняла USD у предложения EBAY_DE молча — проверяем сами [EBAY_C03]
      if (logger && ctx) logConservative(logger, ctx, 'EBAY_C03_LOCAL_CURRENCY_AND_SCALE', { channelWriteId: write.channelWriteId, currency, marketplace: marketplace! });
      return channelError('VALIDATION', 'ITEM', `currency ${currency} is not the currency ${info!.currency} of ${marketplace}: eBay would store it silently (sandbox), refused locally`);
    }
    if (basis !== info!.basis) return channelError('VALIDATION', 'ITEM', `price basis ${basis} is not the basis ${info!.basis} of ${marketplace} (Р-58)`);
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) return channelError('VALIDATION', 'ITEM', 'price must be a positive whole number of minor units');
  } else if (!Number.isSafeInteger(value.quantity) || value.quantity < 0 || value.quantity > MAX_QUANTITY) {
    return channelError('VALIDATION', 'ITEM', `quantity ${value.quantity} is outside 0..${MAX_QUANTITY}`);
  }
  return null;
}

function batchIdOf(items: readonly FieldWrite[]): string {
  const hash = createHash('sha256');
  for (const id of items.map((w) => w.channelWriteId).sort()) hash.update(`${id}\n`);
  return `ebay:${hash.digest('hex').slice(0, 16)}`;
}

/**
 * Р-163: расход бюджета правок — по листингу, КАЖДАЯ попытка (Р-19): одна запись в вызове — одна попытка её поля. Ядро списывает
 * это в edit_budget до отправки; граница дня — у ядра (Р-65), адаптер только считает.
 *
 * Это расход ПЛАНА — одной HTTP-попытки на запись. Если канал ответил 401 и сессия повторила вызов с новым токеном (session.call),
 * ушла вторая попытка той же записи: адаптер списывает её во второй слой (RollingDayLedger.recordSent) и возвращает её в attemptsMade
 * результата отправки. База (edit_budget) считает попытки по attempt_count записи — одна на захват — и эту вторую попытку не видит
 * (ревью шага 39, находка 14): она остаётся в запасе unaccounted_margin (10 правок).
 */
export function budgetChargesOf(items: readonly FieldWrite[]): BudgetCharge[] {
  const byKey = new Map<string, BudgetCharge>();
  for (const w of items) {
    const key = budgetKeyOf(w)!;
    const k = `${key}\n${w.value.field}`;
    const cur = byKey.get(k);
    if (cur) cur.attempts += 1;
    else byKey.set(k, { budgetScopeKey: key, field: w.value.field, attempts: 1 });
  }
  return [...byKey.values()];
}

/**
 * План без обращения к каналу: проверка значений и предусловия Р-164; одна запись на единицу записи — старшая версия (INV-03);
 * пакет — одна витрина, не больше 25 записей и не больше одной записи на предложение [EBAY_C09]; каждая отправка — один запрос.
 */
export function planEbayDispatch(ctx: AdapterCallContext, account: VerifiedChannelAccount, writes: readonly FieldWrite[], logger: AdapterLogger): DispatchPlan {
  const rejected: Array<{ channelWriteId: ChannelWriteId; error: ChannelError }> = [];
  const valid: FieldWrite[] = [];
  for (const w of writes) {
    const error = validateWrite(w, account, logger, ctx);
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
  // Пакеты по витрине; предложение входит в пакет не больше одного раза (цена и количество одного предложения — разные вызовы)
  const byMarketplace = new Map<string, FieldWrite[][]>();
  for (const w of selected) {
    const key = w.writeScope.identity.marketplace ?? '';
    const groups = byMarketplace.get(key) ?? [];
    const offerId = offerIdOf(w.writeScope.identity)!;
    let group = groups.find((g) => g.length < BULK_UPDATE_MAX && !g.some((x) => offerIdOf(x.writeScope.identity) === offerId));
    if (!group) { group = []; groups.push(group); }
    group.push(w);
    byMarketplace.set(key, groups);
  }
  const batches: DispatchBatch[] = [];
  for (const groups of byMarketplace.values()) {
    for (const items of groups) batches.push({ batchId: batchIdOf(items), operation: OPERATION_BULK_UPDATE, items, budgetCharges: budgetChargesOf(items), requestCount: 1 });
  }
  if (selected.length > BULK_UPDATE_MAX) logConservative(logger, ctx, 'EBAY_C09_BATCH_MAX_25', { writes: selected.length, batches: batches.length });
  return { batches, rejected };
}
