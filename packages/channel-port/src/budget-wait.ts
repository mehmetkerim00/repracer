import type { AdapterCallContext } from './primitives.ts';

/**
 * OQ-216 (шаг 35): «подождите до retryAt» — не провал работы. Клиентский бюджет адаптера (у Kaufland — 25 запросов в
 * секунду, K-04) делят все, кто ходит в канал в этом такте: опрос конкурентов, записи, чтение заказов, обход
 * предложений. Тот, кому бюджета не хватило, ЖДЁТ ровно до `retryAt`, если он внутри срока вызова; за сроком —
 * та же ошибка наружу, как любая другая, и работу повторяет планировщик с растущей паузой [Р-132].
 *
 * Правило одно на всех, кто ходит в канал: путь решения и конвейер остатков зовут эту функцию, а не пишут свой повтор
 * (первая редакция шага 35 закрыла только обход предложений, и прогон суток нашёл ту же ошибку у чтения заказов).
 */
export interface BudgetWaitDeps {
  now: () => string;
  sleep: (ms: number) => Promise<void>;
  /** Сколько раз ждать в одном вызове: дальше — ошибка наружу */
  maxWaits?: number;
}

function channelErrorOf(error: unknown): { code: string; retryAt?: string } | null {
  const e = (error as { error?: { code?: unknown; retryAt?: unknown } } | null)?.error;
  return e && typeof e.code === 'string' ? { code: e.code, ...(typeof e.retryAt === 'string' ? { retryAt: e.retryAt } : {}) } : null;
}

export async function waitingForBudget<T>(ctx: AdapterCallContext, call: () => Promise<T>, deps: BudgetWaitDeps): Promise<T> {
  const maxWaits = deps.maxWaits ?? 10;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const e = channelErrorOf(error);
      if (!e || e.code !== 'RATE_LIMITED' || !e.retryAt || attempt >= maxWaits) throw error;
      if (Date.parse(e.retryAt) > Date.parse(ctx.deadline)) throw error;
      await deps.sleep(Math.max(1, Date.parse(e.retryAt) - Date.parse(deps.now())));
    }
  }
}
