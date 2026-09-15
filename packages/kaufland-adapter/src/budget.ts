/**
 * Клиентский бюджет запросов к Kaufland [KFL_C01, K-04].
 * Документация: 111 запросов в секунду на продавца на все эндпоинты. Для технологического партнёра неизвестно,
 * считается ли лимит на продавца или на партнёра, поэтому бюджет двухуровневый: на продавца и общий на партнёра.
 * Реализация в памяти — на один процесс. Несколько экземпляров адаптера требуют общего хранилища бюджета (OQ-78).
 */
export interface RequestBudget {
  /** Атомарно списать cost токенов со всех ключей или ничего; при нехватке — момент, когда хватит */
  tryAcquire(keys: readonly string[], cost: number, nowMs: number): { ok: true } | { ok: false; retryAtMs: number; exhaustedKey: string };
}

export interface BucketConfig {
  ratePerSecond: number;
  burst: number;
}

/** Консервативные значения до ответа K-04: четверть документированного лимита на продавца, общий потолок партнёра ниже 111 */
export const CONSERVATIVE_BUDGET: { seller: BucketConfig; partner: BucketConfig } = {
  seller: { ratePerSecond: 25, burst: 25 },
  partner: { ratePerSecond: 100, burst: 100 },
};

export function budgetKeys(externalAccountId: string, hasPartner: boolean): string[] {
  return hasPartner ? [`kaufland:seller:${externalAccountId}`, 'kaufland:partner'] : [`kaufland:seller:${externalAccountId}`];
}

export class TokenBucketBudget implements RequestBudget {
  private readonly buckets = new Map<string, { tokens: number; updatedMs: number }>();
  private readonly configFor: (key: string) => BucketConfig;

  // Без свойств-параметров конструктора: код исполняется Node с --experimental-strip-types
  constructor(configFor: (key: string) => BucketConfig) {
    this.configFor = configFor;
  }

  tryAcquire(keys: readonly string[], cost: number, nowMs: number): { ok: true } | { ok: false; retryAtMs: number; exhaustedKey: string } {
    const states = keys.map((key) => {
      const config = this.configFor(key);
      const state = this.buckets.get(key) ?? { tokens: config.burst, updatedMs: nowMs };
      const elapsed = Math.max(0, nowMs - state.updatedMs) / 1000;
      const tokens = Math.min(config.burst, state.tokens + elapsed * config.ratePerSecond);
      return { key, config, tokens };
    });
    for (const s of states) {
      if (s.tokens < cost) {
        const waitMs = Math.ceil(((cost - s.tokens) / s.config.ratePerSecond) * 1000);
        return { ok: false, retryAtMs: nowMs + waitMs, exhaustedKey: s.key };
      }
    }
    for (const s of states) {
      this.buckets.set(s.key, { tokens: s.tokens - cost, updatedMs: nowMs });
    }
    return { ok: true };
  }
}

export function conservativeBudget(): TokenBucketBudget {
  return new TokenBucketBudget((key) => (key === 'kaufland:partner' ? CONSERVATIVE_BUDGET.partner : CONSERVATIVE_BUDGET.seller));
}
