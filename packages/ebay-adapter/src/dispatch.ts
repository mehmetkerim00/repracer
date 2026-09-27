import type { AdapterCallContext, ChannelError, DispatchBatch, DispatchResult, FieldWrite, WriteOutcome } from '@repracer/channel-port';
import { logConservative } from './conservative.ts';
import { BULK_UPDATE_MAX, BULK_UPDATE_PATH, OPERATION_BULK_UPDATE } from './descriptor.ts';
import { channelError, classifyHttpFailure, describeRestError, type EbayRestError, firstRestError } from './errors.ts';
import { formatMinor, listingIdOf, offerIdOf } from './mapping.ts';
import { validateWrite } from './planning.ts';
import { acquire, call, deadlinePassed, nowMs, openSession, type ResolvedOptions } from './session.ts';

function rejectAll(batch: DispatchBatch, error: ChannelError, attemptsMade = 0): DispatchResult {
  return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'REJECTED', error })), attemptsMade };
}

/** Тело bulk_update_price_quantity: по одному элементу requests[] на запись, в нём ровно одно предложение и одно поле [песочница] */
export function bulkUpdateBody(items: readonly FieldWrite[]): { requests: Array<{ offers: Array<Record<string, unknown>> }> } {
  return {
    requests: items.map((w) => {
      const offerId = offerIdOf(w.writeScope.identity)!;
      if (w.value.field === 'PRICE') {
        return { offers: [{ offerId, price: { value: formatMinor(w.value.price.amountMinor), currency: w.value.price.currency } }] };
      }
      if (w.value.field === 'QUANTITY') return { offers: [{ offerId, availableQuantity: w.value.quantity }] };
      throw new Error('CHANNEL_MIN_PRICE is never sent to eBay');
    }),
  };
}

interface ItemResponse { statusCode?: number; offerId?: string; sku?: string; errors?: EbayRestError[] }

/** Ответ по одному предложению [песочница]: 200 — принято; 25016 — ниже минимума витрины; 25604 — предложение или SKU не найдены */
function itemOutcome(options: ResolvedOptions, ctx: AdapterCallContext, w: FieldWrite, r: ItemResponse | undefined, httpStatus: number): WriteOutcome {
  if (!r) {
    return { channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN',
      error: channelError('UNKNOWN', 'ITEM', `eBay answered ${httpStatus} without a response for the offer`, { httpStatus, raiseAlert: true }) };
  }
  if (r.statusCode === 200) return { channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: false };
  const e = r.errors?.[0] ?? null;
  const extra = { ...(e?.errorId !== undefined ? { channelCode: String(e.errorId) } : {}), httpStatus: r.statusCode ?? httpStatus };
  const message = describeRestError(e, `item status ${r.statusCode ?? '?'}`);
  switch (e?.errorId) {
    case 25016:
      return { channelWriteId: w.channelWriteId, status: 'REJECTED', error: channelError('VALIDATION', 'ITEM', `price below the storefront minimum: ${message}`, extra) };
    case 25604:
      return { channelWriteId: w.channelWriteId, status: 'REJECTED', error: channelError('NOT_FOUND', 'ITEM', message, extra) };
    case 25004:
      if (w.value.field === 'QUANTITY' && w.value.quantity === 0) {
        // Песочница ответила ошибкой, но количество 0 применила — исход неизвестен, итог только обратным чтением [EBAY_C04]
        logConservative(options.deps.logger, ctx, 'EBAY_C04_QUANTITY_ZERO_OUTCOME_UNKNOWN', { channelWriteId: w.channelWriteId });
        return { channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error: channelError('UNKNOWN', 'ITEM', `quantity 0 answered with an error that the sandbox applied anyway: ${message}`, extra) };
      }
      return { channelWriteId: w.channelWriteId, status: 'REJECTED', error: channelError('VALIDATION', 'ITEM', message, extra) };
    default:
      return { channelWriteId: w.channelWriteId, status: 'REJECTED', error: channelError('UNKNOWN', 'ITEM', message, { ...extra, raiseAlert: true }) };
  }
}

export async function dispatchEbay(options: ResolvedOptions, ctx: AdapterCallContext, batch: DispatchBatch): Promise<DispatchResult> {
  const opened = await openSession(options, ctx);
  if (!opened.ok) return rejectAll(batch, opened.error);
  const { session } = opened;
  const outcomes: WriteOutcome[] = [];
  let sendable: FieldWrite[] = [];
  // План мог быть собран другим процессом: предусловия проверяются заново ДО обращения к каналу (Р-164, EBAY_C03)
  for (const w of batch.items) {
    const error = validateWrite(w, session.account, options.deps.logger, ctx);
    if (error) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error });
    else sendable.push(w);
  }
  const offers = sendable.map((w) => offerIdOf(w.writeScope.identity));
  if (sendable.length > BULK_UPDATE_MAX || new Set(offers).size !== offers.length) {
    return rejectAll(batch, channelError('VALIDATION', 'BATCH', `a batch holds at most ${BULK_UPDATE_MAX} writes, one per offer (use planDispatch)`));
  }
  if (sendable.length === 0) return { batchId: batch.batchId, outcomes, attemptsMade: 0 };

  // Срок и бюджет запросов — до списания попытки правки: отказ клиентского бюджета не расходует 250 правок листинга
  const refused = deadlinePassed(options, ctx) ?? acquire(options, ctx, session, OPERATION_BULK_UPDATE);
  if (refused) {
    for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: refused });
    return { batchId: batch.batchId, outcomes, attemptsMade: 0 };
  }

  // Второй слой бюджета правок: каждая попытка по листингу, любые 24 часа [EBAY_C08, Р-163]
  const ledger = options.editLedger;
  // Цена и остаток считаются раздельно: цене — до 190 из 250, остатку — весь лимит (как edit_budget в базе, 0008)
  const byListing = new Map<string, { listingKey: string; field: 'PRICE' | 'QUANTITY'; writes: FieldWrite[] }>();
  for (const w of sendable) {
    const field = w.value.field === 'QUANTITY' ? 'QUANTITY' : 'PRICE';
    const listingKey = `${session.sellerKey}|${listingIdOf(w.writeScope.identity)!}`;
    const k = `${listingKey}\n${field}`;
    const cur = byListing.get(k) ?? { listingKey, field, writes: [] };
    cur.writes.push(w);
    byListing.set(k, cur);
  }
  const charged: FieldWrite[] = [];
  for (const { listingKey, field, writes } of byListing.values()) {
    const r = ledger.tryCharge({ listingKey, field, attempts: writes.length }, nowMs(options));
    if (r.ok) { charged.push(...writes); continue; }
    logConservative(options.deps.logger, ctx, 'EBAY_C08_EDIT_BUDGET_ROLLING_DAY', { listingId: listingKey.split('|')[1] ?? '', field, used: r.used, limit: r.limit });
    const error = channelError('EDIT_BUDGET_EXHAUSTED', 'ITEM',
      `${field === 'PRICE' ? 'price' : 'listing'} edits of the eBay listing within 24 hours are used (${r.used} of ${r.limit}); the write is not sent`,
      { retryAt: new Date(r.retryAtMs).toISOString() });
    for (const w of writes) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error });
  }
  sendable = batch.items.filter((w) => charged.includes(w));
  if (sendable.length === 0) return { batchId: batch.batchId, outcomes, attemptsMade: 0 };

  const sent = await call(options, ctx, session, { auth: 'USER', method: 'POST', path: BULK_UPDATE_PATH, body: bulkUpdateBody(sendable), idempotent: false, operation: OPERATION_BULK_UPDATE, preAcquired: true });
  if (sent.kind === 'REFUSED') {
    for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: sent.error });
    return { batchId: batch.batchId, outcomes, attemptsMade: sent.attempts };
  }
  const { result } = sent;
  const status = result.status;
  const responses = (result.body as { responses?: unknown } | undefined)?.responses;
  if (typeof status === 'number' && Array.isArray(responses) && (status === 200 || status === 207 || status === 400)) {
    // Ответ по элементам: 200 — все приняты, 207 — частично, 400 с responses[] — отказ по элементам [песочница]
    const list = responses as ItemResponse[];
    sendable.forEach((w, i) => {
      const offerId = offerIdOf(w.writeScope.identity);
      const r = list.find((x) => x?.offerId === offerId) ?? (list.length === sendable.length ? list[i] : undefined);
      outcomes.push(itemOutcome(options, ctx, w, r, status));
    });
    return { batchId: batch.batchId, outcomes, attemptsMade: result.attempts };
  }
  const error = classifyHttpFailure(status, result.body, 'BATCH', nowMs(options));
  if (result.outcomeUnknown) {
    // Обрыв «other side closed» в песочнице; повтор вслепую запрещён — ядро сверяет обратным чтением [EBAY_C02]
    logConservative(options.deps.logger, ctx, 'EBAY_C02_NO_TRANSPORT_RETRY_FOR_WRITES', { batchId: batch.batchId, status: String(status) });
    for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error });
  } else {
    if (status === 429) logConservative(options.deps.logger, ctx, 'EBAY_C01_REQUEST_BUDGET', { operation: OPERATION_BULK_UPDATE, status: 429 });
    // 400 без responses[] — отказ всего запроса (25709 неверное значение, 25712 больше 25) [песочница]
    for (const w of sendable) outcomes.push({ channelWriteId: w.channelWriteId, status: 'REJECTED', error: firstRestError(result.body)?.errorId === 25712
      ? channelError('VALIDATION', 'BATCH', error.message, { channelCode: '25712', httpStatus: 400, raiseAlert: true }) : error });
  }
  return { batchId: batch.batchId, outcomes, attemptsMade: result.attempts };
}

export { OPERATION_BULK_UPDATE };
