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
    pageLimit?: { pages: number; nextCursor: string };
    /** Шаг 59 [Р-199]: новых строк возврата */
    returns?: number;
    /** Шаг 59 [Р-200]: источники Inbound API, молчащие сутки после подтверждения отгруженного заказа (каждая резервация — один раз) */
    silentSources?: Array<{ stockSourceId: string; reservations: number; oldestConfirmedAt: Instant }> }>;
  /** После изменения остатка (импорт, Inbound API): пересчёт названных товаров и отправка изменившихся единиц */
  propagate(tenantId: string, productIds: readonly string[] | null, options?: { lockTimeoutMs?: number }): Promise<{ writes: number; unchanged: number }>;
}

/**
 * Конвейер остатков [Р-6, Р-25]. Правило одно: остаток меняется в пуле, пересчёт считает публикуемое количество для каждой
 * единицы записи, изменившееся уходит записью. Канал здесь читается только за заказами; что канал показывает
 * ПОСЛЕ записи, проверяет диспетчер обратным чтением — и это единственное подтверждение, которое у экрана есть.
 */
/**
 * Шаг 58 (ревью шага 57, находка 2): чтение заказов оборвалось посреди окна — прочитанные строки уже записаны; `cursor` — последний
 * курсор, который канал принял (продолжение с него), `undefined` — оборвалось на первой странице после начала окна
 */
export class OrderReadInterrupted extends Error {
  readonly code: string;
  readonly causeError: unknown;
  readonly cursor: string | undefined;
  readonly linesRecorded: number;
  constructor(causeError: unknown, cursor: string | undefined, linesRecorded: number) {
    const code = String((causeError as { error?: { code?: string }; code?: string })?.error?.code ?? (causeError as { code?: string })?.code ?? 'ORDER_READ_FAILED');
    super(`${/^[A-Z][A-Z0-9_]{2,}$/.test(code) ? code : 'ORDER_READ_FAILED'}: order lines read interrupted after ${linesRecorded} lines: ${String((causeError as Error)?.message ?? causeError).slice(0, 200)}`);
    this.code = code;
    this.causeError = causeError;
    this.cursor = cursor;
    this.linesRecorded = linesRecorded;
  }
}

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
        let result: Awaited<ReturnType<typeof adapter.readOrderLines>>;
        try {
          result = await waitingForBudget(ctx, () => adapter.readOrderLines(ctx, { since, limit: 100, ...(cursor ? { cursor } : {}) }), { now: deps.now, sleep });
        } catch (error) {
          /**
           * Шаг 58 (ревью шага 57, находка 2): отказ канала посреди чтения терял весь заход — строки записывались только после последней
           * страницы, и 150 прочитанных страниц читались снова. Прочитанное записывается, а наружу уходит отказ с последним ПРИНЯТЫМ
           * курсором: следующий заход продолжит с него. Отказ на первой странице захода — прежний отказ, курсора у него нет
           */
          if (lines.length === 0 && page === 0) throw error;
          const recorded = await deps.store.recordOrderLines(ctx.tenantId, ctx.channelAccountId, lines, deps.now());
          if (recorded.productIds.length > 0) {
            const r = await deps.store.recalculate(ctx.tenantId, recorded.productIds, deps.now());
            await dispatch(ctx.tenantId, r.writes.map((w) => w.writeScopeId));
          }
          throw new OrderReadInterrupted(error, cursor, lines.length);
        }
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
      // Шаг 59 [Р-200]: источник Inbound API, молчащий сутки после подтверждения отгруженного заказа, — наружу, алерт поднимает работа
      const silentSources = (await deps.store.markSilentInboundSources?.(ctx.tenantId)) ?? [];
      return { lines: lines.length, created: recorded.created, consumed: recorded.consumed, released: recorded.released, unknownOffers: recorded.unknownOffers, writes: recalculated.writes.length,
        returns: recorded.returns, ...(silentSources.length > 0 ? { silentSources } : {}),
        ...(cursorRepeated ? { cursorRepeated: true } : {}), ...(pageLimit ? { pageLimit } : {}) };
    },
    async propagate(tenantId, productIds, options = {}) {
      const r = await deps.store.recalculate(tenantId, productIds, deps.now(), options);
      await dispatch(tenantId, r.writes.map((w) => w.writeScopeId));
      return { writes: r.writes.length, unchanged: r.unchanged };
    },
  };
}
