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
  syncOrders(ctx: AdapterCallContext, adapter: ChannelAdapter, since: Instant, options?: { cursor?: string; maxPages?: number }): Promise<{ lines: number; created: number; consumed: number; released: number; unknownOffers: number; writes: number;
    /** Шаг 53: канал вернул уже виденный курсор — чтение остановлено, прочитанное записано */
    cursorRepeated?: boolean;
    /**
     * Шаг 56 (ревью шага 54, находка 8): чтение упёрлось в предел страниц захода, а канал отдал курсор дальше — прочитанное записано,
     * следующий заход продолжит с `nextCursor` при том же начале окна. Раньше хвост окна терялся молча
     */
    pageLimit?: { pages: number; nextCursor: string } }>;
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
    async syncOrders(ctx, adapter, since, options = {}) {
      const lines: OrderLine[] = [];
      let cursor: string | undefined = options.cursor;
      const maxPages = Math.max(1, options.maxPages ?? 200);
      let pageLimit: { pages: number; nextCursor: string } | undefined;
      // Шаг 53 (ревью шага 52, находка 6): все виденные курсоры — ловится и A→B→A; на повторе прочитанное не теряется
      const seen = new Set<string>();
      let cursorRepeated = false;
      for (let page = 0; ; page++) {
        if (page >= maxPages) { pageLimit = { pages: page, nextCursor: cursor! }; break; }
        // OQ-216: бюджет канала делят опрос, записи и чтение заказов; не хватило — ждём до `retryAt`, а не роняем работу
        const result = await waitingForBudget(ctx, () => adapter.readOrderLines(ctx, { since, limit: 100, ...(cursor ? { cursor } : {}) }), { now: deps.now, sleep });
        lines.push(...result.items);
        if (!result.nextCursor) break;
        // Канал вернул уже виденный курсор — продвинуться нечем: чтение останавливается, прочитанное записывается ниже, алерт — у работы
        if (seen.has(result.nextCursor) || result.nextCursor === cursor) { cursorRepeated = true; break; }
        seen.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      const recorded = await deps.store.recordOrderLines(ctx.tenantId, ctx.channelAccountId, lines, deps.now());
      // Шаг 52 (п. 8): и товары, чья запись упёрлась в бюджет правок прошлого дня, — после смены суток значение уходит снова
      const rolledOver = (await deps.store.budgetRolledOverProducts?.(ctx.tenantId, ctx.channelAccountId)) ?? [];
      const products = [...new Set([...recorded.productIds, ...rolledOver])];
      const recalculated = products.length > 0 ? await deps.store.recalculate(ctx.tenantId, products, deps.now()) : { writes: [], unchanged: 0 };
      await dispatch(ctx.tenantId, recalculated.writes.map((w) => w.writeScopeId));
      return { lines: lines.length, created: recorded.created, consumed: recorded.consumed, released: recorded.released, unknownOffers: recorded.unknownOffers, writes: recalculated.writes.length,
        ...(cursorRepeated ? { cursorRepeated: true } : {}), ...(pageLimit ? { pageLimit } : {}) };
    },
    async propagate(tenantId, productIds) {
      const r = await deps.store.recalculate(tenantId, productIds, deps.now());
      await dispatch(tenantId, r.writes.map((w) => w.writeScopeId));
      return { writes: r.writes.length, unchanged: r.unchanged };
    },
  };
}
