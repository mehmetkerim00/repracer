import { waitingForBudget } from '@repracer/channel-port';
import type { AdapterCallContext, ChannelAdapter, Instant, OrderLine } from '@repracer/channel-port';
import type { StockStore } from './store.ts';

export interface StockPipelineDeps {
  store: StockStore;
  now: () => Instant;
  /** Записи, созданные пересчётом, отправляет диспетчер [Р-64]; без него они ждут обхода */
  dispatchScope?: (tenantId: string, writeScopeId: string) => Promise<unknown>;
  /** Часы мира: на виртуальных часах ждать настоящими секундами нельзя [OQ-216] */
  sleep?: (ms: number) => Promise<void>;
}

export interface StockPipeline {
  /** Заказы канала за окно → резервации → пересчёт затронутых товаров → записи */
  syncOrders(ctx: AdapterCallContext, adapter: ChannelAdapter, since: Instant): Promise<{ lines: number; created: number; consumed: number; released: number; unknownOffers: number; writes: number }>;
  /** После изменения остатка (импорт, Inbound API): пересчёт названных товаров и отправка изменившихся единиц */
  propagate(tenantId: string, productIds: readonly string[] | null): Promise<{ writes: number; unchanged: number }>;
}

/**
 * Конвейер остатков [Р-6, Р-25]. Правило одно: остаток меняется в пуле, пересчёт считает публикуемое количество для каждой
 * единицы записи, изменившееся уходит записью. Канал здесь читается только за заказами; что канал показывает
 * ПОСЛЕ записи, проверяет диспетчер обратным чтением — и это единственное подтверждение, которое у экрана есть.
 */
export function createStockPipeline(deps: StockPipelineDeps): StockPipeline {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const dispatch = async (tenantId: string, writeScopeIds: string[]) => {
    if (!deps.dispatchScope) return;
    for (const id of writeScopeIds) await deps.dispatchScope(tenantId, id);
  };
  return {
    async syncOrders(ctx, adapter, since) {
      const lines: OrderLine[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 200; page++) {
        // OQ-216: бюджет канала делят опрос, записи и чтение заказов; не хватило — ждём до `retryAt`, а не роняем работу
        const result = await waitingForBudget(ctx, () => adapter.readOrderLines(ctx, { since, limit: 100, ...(cursor ? { cursor } : {}) }), { now: deps.now, sleep });
        lines.push(...result.items);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      const recorded = await deps.store.recordOrderLines(ctx.tenantId, ctx.channelAccountId, lines, deps.now());
      const recalculated = recorded.productIds.length > 0 ? await deps.store.recalculate(ctx.tenantId, recorded.productIds, deps.now()) : { writes: [], unchanged: 0 };
      await dispatch(ctx.tenantId, recalculated.writes.map((w) => w.writeScopeId));
      return { lines: lines.length, created: recorded.created, consumed: recorded.consumed, released: recorded.released, unknownOffers: recorded.unknownOffers, writes: recalculated.writes.length };
    },
    async propagate(tenantId, productIds) {
      const r = await deps.store.recalculate(tenantId, productIds, deps.now());
      await dispatch(tenantId, r.writes.map((w) => w.writeScopeId));
      return { writes: r.writes.length, unchanged: r.unchanged };
    },
  };
}
