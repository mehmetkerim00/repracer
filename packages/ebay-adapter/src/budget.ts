import { EDIT_BUDGET } from './descriptor.ts';

/**
 * Клиентский бюджет запросов к eBay [EBAY_C01, E-04]. Лимиты Inventory API неизвестны: песочница отдаёт заглушку «api context test»
 * по 100 вызовов на 15 с (Р-162 — ничего не доказывает). Скорость выбрана нами. В памяти одного процесса (OQ-78).
 */
export interface EbayRequestBudget {
  tryAcquire(sellerKey: string, nowMs: number): { ok: true } | { ok: false; retryAtMs: number };
}

export const CONSERVATIVE_REQUEST_BUDGET = { ratePerSecond: 2, burst: 4 } as const;

export class TokenBucket implements EbayRequestBudget {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>();
  private readonly ratePerSecond: number;
  private readonly burst: number;

  constructor(config: { ratePerSecond: number; burst: number } = CONSERVATIVE_REQUEST_BUDGET) {
    this.ratePerSecond = config.ratePerSecond;
    this.burst = config.burst;
  }

  tryAcquire(sellerKey: string, nowMs: number): { ok: true } | { ok: false; retryAtMs: number } {
    const state = this.buckets.get(sellerKey) ?? { tokens: this.burst, updatedMs: nowMs };
    const tokens = Math.min(this.burst, state.tokens + (Math.max(0, nowMs - state.updatedMs) / 1000) * this.ratePerSecond);
    if (tokens < 1) return { ok: false, retryAtMs: nowMs + Math.ceil(((1 - tokens) / this.ratePerSecond) * 1000) };
    this.buckets.set(sellerKey, { tokens: tokens - 1, updatedMs: nowMs });
    return { ok: true };
  }
}

/**
 * Второй слой бюджета правок листинга [EBAY_C08, Р-163]. Первый — tenant_data.edit_budget в базе: ядро списывает budgetCharges плана
 * до отправки. Адаптер у себя считает КАЖДУЮ попытку отправки по листингу (Р-19: неуспешные тоже) и не отправляет запрос сверх лимита
 * за последние 24 часа. Скользящие 24 часа — худший случай неизвестной границы дня (E-02, Р-65): в любые календарные сутки любого
 * пояса попадёт не больше лимита попыток.
 *
 * Доли — как в базе (0008, edit_budget_price_limit): цена не больше limit − quantityReserve − unaccountedMargin (190 из 250), остаток
 * может использовать весь лимит — уменьшение опубликованного остатка никогда не блокируется ценой (инвариант 5). В отличие от базы
 * адаптер не знает, уменьшение ли это (прежнего значения у записи нет), поэтому весь лимит открыт любой записи остатка.
 * В памяти одного процесса: несколько процессов — только база (OQ-78).
 */
export type LedgerField = 'PRICE' | 'QUANTITY';

export interface EditAttemptLedger {
  /** Списать попытки поля по листингу или отказать, не списав ничего */
  tryCharge(charge: { listingKey: string; field: LedgerField; attempts: number }, nowMs: number):
    { ok: true } | { ok: false; retryAtMs: number; used: number; limit: number };
}

const DAY_MS = 24 * 3600_000;

export interface LedgerLimits { limit: number; quantityReserve?: number; unaccountedMargin?: number }

export class RollingDayLedger implements EditAttemptLedger {
  private readonly attempts = new Map<string, Array<{ at: number; field: LedgerField }>>();
  readonly totalLimit: number;
  readonly priceLimit: number;

  constructor(limits: LedgerLimits = EDIT_BUDGET) {
    this.totalLimit = limits.limit;
    this.priceLimit = limits.limit - (limits.quantityReserve ?? 0) - (limits.unaccountedMargin ?? 0);
    if (!(this.priceLimit > 0)) throw new RangeError('edit budget leaves no attempts for the price');
  }

  /** Попытки, сделанные раньше (стенд, восстановление после перезапуска из edit_budget) */
  preload(listingKey: string, count: number, atMs: number, field: LedgerField = 'PRICE'): void {
    const list = this.attempts.get(listingKey) ?? [];
    for (let i = 0; i < count; i++) list.push({ at: atMs, field });
    list.sort((a, b) => a.at - b.at);
    this.attempts.set(listingKey, list);
  }

  tryCharge(charge: { listingKey: string; field: LedgerField; attempts: number }, nowMs: number):
    { ok: true } | { ok: false; retryAtMs: number; used: number; limit: number } {
    const live = (this.attempts.get(charge.listingKey) ?? []).filter((a) => a.at > nowMs - DAY_MS);
    this.attempts.set(charge.listingKey, live);
    // Освободится, когда из окна выйдет столько старых попыток, сколько не хватает
    const freeAt = (pool: Array<{ at: number }>, limit: number): number | null => {
      const needed = pool.length + charge.attempts - limit;
      return needed <= 0 ? null : (pool[Math.min(needed, pool.length) - 1]?.at ?? nowMs) + DAY_MS;
    };
    const totalAt = freeAt(live, this.totalLimit);
    const prices = live.filter((a) => a.field === 'PRICE');
    const priceAt = charge.field === 'PRICE' ? freeAt(prices, this.priceLimit) : null;
    if (totalAt !== null || priceAt !== null) {
      const byPrice = priceAt !== null && (totalAt === null || priceAt >= totalAt);
      return { ok: false, retryAtMs: Math.max(totalAt ?? 0, priceAt ?? 0), used: byPrice ? prices.length : live.length, limit: byPrice ? this.priceLimit : this.totalLimit };
    }
    for (let i = 0; i < charge.attempts; i++) live.push({ at: nowMs, field: charge.field });
    return { ok: true };
  }
}
