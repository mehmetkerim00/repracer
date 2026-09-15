import type { CompetitorQuery, Instant } from '@repracer/channel-port';

/**
 * Р-47: опрос конкурентов ярусный по волатильности. Целевая задержка (Р-8) относится только к горячему ярусу;
 * длинный хвост опрашивается раз в сутки — заявленное ограничение продукта.
 * Бюджет запросов — вход (лимит канала на продавца или партнёра не подтверждён, K-04); функция его не выдумывает.
 */

export type PollTier = 'HOT' | 'WARM' | 'COLD';

export interface PollItem {
  key: string;
  /** Изменений принятой цены конкурентов за 30 дней (competitor_price_daily / competitor_move) */
  changesLast30Days: number;
}

export interface TierConfig {
  hot: { minChangesPerDay: number; intervalSeconds: number };
  warm: { minChangesPerDay: number; intervalSeconds: number };
  cold: { intervalSeconds: number };
}

export const DEFAULT_TIERS: TierConfig = {
  // 120 с — целевая задержка Kaufland (Р-8)
  hot: { minChangesPerDay: 4, intervalSeconds: 120 },
  warm: { minChangesPerDay: 0.5, intervalSeconds: 3600 },
  cold: { intervalSeconds: 86_400 },
};

export interface PollingPlan {
  assignments: Array<{ key: string; tier: PollTier; intervalSeconds: number }>;
  requiredRequestsPerSecond: number;
  budgetRequestsPerSecond: number;
  /** Понижены из-за бюджета, в порядке понижения */
  demoted: Array<{ key: string; from: PollTier; to: PollTier }>;
  /** Даже суточный опрос всех не помещается в бюджет */
  coldTierExceedsBudget: boolean;
}

export function planPollingTiers(items: readonly PollItem[], budgetRequestsPerSecond: number, cfg: TierConfig = DEFAULT_TIERS): PollingPlan {
  const interval = (tier: PollTier) => (tier === 'HOT' ? cfg.hot.intervalSeconds : tier === 'WARM' ? cfg.warm.intervalSeconds : cfg.cold.intervalSeconds);
  const byVolatility = [...items].sort((a, b) => b.changesLast30Days - a.changesLast30Days || a.key.localeCompare(b.key));
  const tiers = new Map<string, PollTier>();
  for (const item of byVolatility) {
    const perDay = item.changesLast30Days / 30;
    tiers.set(item.key, perDay >= cfg.hot.minChangesPerDay ? 'HOT' : perDay >= cfg.warm.minChangesPerDay ? 'WARM' : 'COLD');
  }
  const rps = () => [...tiers.values()].reduce((sum, t) => sum + 1 / interval(t), 0);
  const demoted: PollingPlan['demoted'] = [];
  // Понижаем наименее волатильные сначала: горячий → тёплый, затем тёплый → холодный
  for (const [from, to] of [['HOT', 'WARM'], ['WARM', 'COLD']] as const) {
    for (const item of [...byVolatility].reverse()) {
      if (rps() <= budgetRequestsPerSecond) break;
      if (tiers.get(item.key) === from) {
        tiers.set(item.key, to);
        demoted.push({ key: item.key, from, to });
      }
    }
  }
  const required = rps();
  return {
    assignments: byVolatility.map((i) => ({ key: i.key, tier: tiers.get(i.key)!, intervalSeconds: interval(tiers.get(i.key)!) })),
    requiredRequestsPerSecond: required,
    budgetRequestsPerSecond,
    demoted,
    coldTierExceedsBudget: required > budgetRequestsPerSecond,
  };
}

// ---------------------------------------------------------------------------
// Р-48: потеря подписки — автовосстановление и обязательный догон состояния опросом
// ---------------------------------------------------------------------------

export type CatchUpTask =
  | { kind: 'ENSURE_SUBSCRIPTIONS'; priority: number }
  | { kind: 'READ_ORDER_LINES'; since: Instant; priority: number }
  | { kind: 'READBACK_UNIT'; marketplace: string; externalUnitId: string; priority: number }
  | { kind: 'POLL_COMPETITORS'; query: CompetitorQuery; tier: PollTier; priority: number }
  | { kind: 'RECONCILE_REPORT'; marketplace: string; priority: number };

export interface CatchUpInput {
  lostAt: Instant;
  restoredAt: Instant;
  marketplaces: string[];
  units: Array<{ marketplace: string; externalUnitId: string }>;
  products: Array<CompetitorQuery & { tier: PollTier }>;
  /** Запас назад от момента потери: уведомления приходят с задержкой */
  safetyMarginSeconds?: number;
}

/**
 * Порядок догона: подписки → заказы (остаток важнее цены) → наши unit → конкуренты по ярусам → отчёт сверки.
 * События за время отключения подписки канал не повторяет (push-notifications): без догона они потеряны.
 */
export function planSubscriptionCatchUp(input: CatchUpInput): CatchUpTask[] {
  const since = new Date(Date.parse(input.lostAt) - (input.safetyMarginSeconds ?? 900) * 1000).toISOString();
  const tierPriority: Record<PollTier, number> = { HOT: 3, WARM: 4, COLD: 5 };
  const tasks: CatchUpTask[] = [
    { kind: 'ENSURE_SUBSCRIPTIONS', priority: 0 },
    { kind: 'READ_ORDER_LINES', since, priority: 1 },
    ...input.units.map((u): CatchUpTask => ({ kind: 'READBACK_UNIT', marketplace: u.marketplace, externalUnitId: u.externalUnitId, priority: 2 })),
    ...input.products.map(({ tier, ...query }): CatchUpTask => ({ kind: 'POLL_COMPETITORS', query, tier, priority: tierPriority[tier] })),
    ...input.marketplaces.map((m): CatchUpTask => ({ kind: 'RECONCILE_REPORT', marketplace: m, priority: 6 })),
  ];
  return tasks.sort((a, b) => a.priority - b.priority);
}
