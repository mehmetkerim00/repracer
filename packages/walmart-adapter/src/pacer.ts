import { NEXT_REPLENISHMENT_HEADER, TOKEN_COUNT_HEADER } from './descriptor.ts';

/**
 * Шаг 89: корзина токенов Walmart — со слов владельца: каждый запрос тратит токен, корзина пополняется с фиксированной скоростью,
 * превышение — 429; в ответах заголовки `x-current-token-count` (сколько токенов осталось) и `x-next-replenishment-time` (когда
 * пополнение). Наш писатель не угадывает скорость, а читает её у канала: пока заголовки говорят «токенов нет», следующий запрос этой
 * корзины ждёт пополнения, а не уходит за 429. Корзины — по семейству операций (цена, инвентарь, товары, Buy Box): у Walmart они
 * разные (инвентарь «порядка 200 в минуту»), и одна общая держала бы цену, пока исчерпан инвентарь.
 */
export interface BucketState {
  /** Токены, которые канал назвал в последнем ответе; null — ответа с заголовком ещё не было */
  tokens: number | null;
  /** Момент пополнения, мс эпохи; null — канал его не назвал */
  replenishAtMs: number | null;
}

export interface PacerStats {
  requests: number;
  /** Сколько раз запрос ждал пополнения, и сколько миллисекунд всего */
  waits: number;
  waitedMs: number;
  /** Сколько раз канал всё же ответил 429 — цель писателя: ноль */
  throttled: number;
}

/** Время пополнения: мс эпохи числом или дата ISO — формат не подтверждён (W-07), читаются оба */
export function parseReplenishment(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    // Секунды эпохи (10 цифр) против миллисекунд (13): формат не подтверждён — оба
    return text.length <= 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

export function parseTokenCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\s*\d+\s*$/.test(value)) return null;
  return Number(value);
}

/** Без названного каналом времени пополнения после 429 — ждём минуту: консервативно (W-07) */
export const FALLBACK_REPLENISH_MS = 60_000;

export class WalmartTokenPacer {
  private readonly buckets = new Map<string, BucketState>();
  readonly stats: PacerStats = { requests: 0, waits: 0, waitedMs: 0, throttled: 0 };
  private readonly clock: { nowMs(): number; sleep(ms: number): Promise<void> };

  constructor(clock: { nowMs(): number; sleep(ms: number): Promise<void> }) {
    this.clock = clock;
  }

  state(bucket: string): BucketState {
    return { ...(this.buckets.get(bucket) ?? { tokens: null, replenishAtMs: null }) };
  }

  /** Сколько ждать перед запросом корзины: токенов нет и пополнение впереди — до пополнения; иначе ноль */
  delayMs(bucket: string): number {
    const s = this.buckets.get(bucket);
    if (!s || s.tokens === null || s.tokens > 0) return 0;
    const now = this.clock.nowMs();
    return s.replenishAtMs !== null && s.replenishAtMs > now ? s.replenishAtMs - now : 0;
  }

  async beforeRequest(bucket: string): Promise<void> {
    const wait = this.delayMs(bucket);
    if (wait > 0) {
      this.stats.waits += 1;
      this.stats.waitedMs += wait;
      await this.clock.sleep(wait);
      // Пополнение наступило: число токенов из прошлого ответа больше не правда, его скажет следующий ответ
      this.buckets.set(bucket, { tokens: null, replenishAtMs: null });
    }
    this.stats.requests += 1;
  }

  /** После ответа: заголовки корзины; 429 — токенов нет до названного пополнения (или минуту) */
  afterResponse(bucket: string, status: number, headers: { get(name: string): string | null }): void {
    const tokens = parseTokenCount(headers.get(TOKEN_COUNT_HEADER));
    const replenishAtMs = parseReplenishment(headers.get(NEXT_REPLENISHMENT_HEADER));
    if (status === 429) {
      this.stats.throttled += 1;
      this.buckets.set(bucket, { tokens: 0, replenishAtMs: replenishAtMs ?? this.clock.nowMs() + FALLBACK_REPLENISH_MS });
      return;
    }
    if (tokens !== null || replenishAtMs !== null) {
      const prev = this.buckets.get(bucket);
      this.buckets.set(bucket, { tokens: tokens ?? prev?.tokens ?? null, replenishAtMs: replenishAtMs ?? prev?.replenishAtMs ?? null });
    }
  }
}
