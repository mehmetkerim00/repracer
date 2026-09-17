import { AMAZON_RATE_LIMITS, type AmazonOperation } from './descriptor.ts';

/**
 * Ограничитель запросов на двух уровнях [страница listings-items-api-rate-limits]: лимит пары аккаунт–приложение и лимит приложения;
 * запрос ограничивается тем порогом, который достигнут первым. Списание атомарно: либо со всех ключей, либо ни с одного.
 * Бюджет приложения общий для всех тенантов процесса — это не объединение данных тенантов, а счётчик запросов одного приложения.
 * В памяти одного процесса: несколько экземпляров требуют общего хранилища (OQ-78).
 */
export interface AmazonRequestBudget {
  tryAcquire(sellerId: string, operation: AmazonOperation, nowMs: number): { ok: true } | { ok: false; retryAtMs: number; level: 'PAIR' | 'APPLICATION' };
  /** Заголовок x-amzn-RateLimit-Limit — лимит пары для этой операции */
  observePairLimit(sellerId: string, operation: AmazonOperation, ratePerSecond: number): void;
}

interface Bucket { tokens: number; updatedMs: number; rate: number; burst: number }

export class TwoLevelBudget implements AmazonRequestBudget {
  private readonly buckets = new Map<string, Bucket>();
  private readonly applicationBurst: (operation: AmazonOperation) => number;
  private readonly otherLoad: () => number;

  /**
   * applicationBurst — burst уровня приложения: не документирован, по умолчанию равен burst пары [AMZ_C01, A-09];
   * applicationLoadRps — расход приложения другими процессами (для стенда и замера).
   */
  constructor(options: { applicationBurst?: (operation: AmazonOperation) => number; applicationLoadRps?: () => number } = {}) {
    this.applicationBurst = options.applicationBurst ?? ((op) => AMAZON_RATE_LIMITS[op].pair.burst);
    this.otherLoad = options.applicationLoadRps ?? (() => 0);
  }

  private bucket(key: string, rate: number, burst: number, nowMs: number): Bucket {
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: burst, updatedMs: nowMs, rate, burst }; this.buckets.set(key, b); }
    b.tokens = Math.min(b.burst, b.tokens + (Math.max(0, nowMs - b.updatedMs) / 1000) * b.rate);
    b.updatedMs = nowMs;
    return b;
  }

  tryAcquire(sellerId: string, operation: AmazonOperation, nowMs: number): { ok: true } | { ok: false; retryAtMs: number; level: 'PAIR' | 'APPLICATION' } {
    const limits = AMAZON_RATE_LIMITS[operation];
    const pair = this.bucket(`pair:${sellerId}:${operation}`, limits.pair.ratePerSecond, limits.pair.burst, nowMs);
    const appRate = Math.max(0, limits.application.ratePerSecond - this.otherLoad());
    // Запас приложения — доля burst, оставшаяся после расхода других продавцов: при полной нагрузке запаса нет
    // Пока приложение не исчерпано, хотя бы один запрос проходит: иначе при свободной доле меньше 1/burst запросы не шли вовсе
    // (ревью шага 22, находка 3)
    const appBurst = appRate > 0 ? Math.max(1, Math.floor(this.applicationBurst(operation) * (appRate / limits.application.ratePerSecond))) : 0;
    const app = this.bucket(`application:${operation}`, appRate, appBurst, nowMs);
    app.rate = appRate;
    app.burst = appBurst;
    app.tokens = Math.min(app.tokens, appBurst);
    const wait = (b: Bucket) => (b.rate > 0 ? Math.ceil(((1 - b.tokens) / b.rate) * 1000) : 60_000);
    if (pair.tokens < 1) return { ok: false, retryAtMs: nowMs + wait(pair), level: 'PAIR' };
    if (app.tokens < 1) return { ok: false, retryAtMs: nowMs + wait(app), level: 'APPLICATION' };
    pair.tokens -= 1;
    app.tokens -= 1;
    return { ok: true };
  }

  observePairLimit(sellerId: string, operation: AmazonOperation, ratePerSecond: number): void {
    if (!(ratePerSecond > 0) || !Number.isFinite(ratePerSecond)) return;
    const b = this.buckets.get(`pair:${sellerId}:${operation}`);
    if (b) b.rate = ratePerSecond;
    else this.buckets.set(`pair:${sellerId}:${operation}`, { tokens: AMAZON_RATE_LIMITS[operation].pair.burst, updatedMs: 0, rate: ratePerSecond, burst: AMAZON_RATE_LIMITS[operation].pair.burst });
  }
}
