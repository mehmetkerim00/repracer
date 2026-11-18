import type { StockRow } from './store.ts';
/** Буфер канала над общим пулом [Р-6]: последняя версия для аккаунта, переопределение — для единицы записи */
export interface StockAllocation {
  bufferUnits: number;
  maxQuantity: number | null;
  minQuantityToList: number;
}

/**
 * Доступный остаток товара: все пулы товара минус открытые резервации [Р-25]. Отрицательным не бывает — заказы,
 * пришедшие раньше остатка, не делают остаток долгом; они делают его нулём.
 */
export function availableOf(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}

/**
 * Публикуемое количество единицы записи (docs/domain-model.md §3.27):
 *   q = max(0, available − buffer); q = min(q, max_quantity); q < min_quantity_to_list ⇒ q = 0.
 * Одно правило на все каналы: у Amazon EU оно даёт одно значение на весь регион [Р-1], у Kaufland — на id_offer [Р-35];
 * поэтому буфер применяется к ОБЩЕМУ значению, а не к витрине.
 */
export function publishedQuantity(available: number, allocation: StockAllocation): number {
  let q = Math.max(0, available - allocation.bufferUnits);
  if (allocation.maxQuantity !== null) q = Math.min(q, allocation.maxQuantity);
  if (q < allocation.minQuantityToList) q = 0;
  return q;
}

/**
 * Шаг 159 (#26): есть что опубликовать (после буфера и потолка), но меньше порога выставления — канал покажет ноль. Одно правило у фильтра
 * «требует внимания» (stock-sync, SQL хранилища) и у превью синхронизации экрана (шаг 160)
 */
export function belowMinimumToList(available: number, a: StockAllocation): boolean {
  const q = Math.min(a.maxQuantity ?? Number.MAX_SAFE_INTEGER, Math.max(0, available - a.bufferUnits));
  return a.minQuantityToList > 0 && q > 0 && q < a.minQuantityToList;
}

/**
 * Шаг 159 (#26): товар требует внимания, если хотя бы одно из трёх:
 *  - количество в канале расходится с нашим (последняя запись не применена, `divergence`);
 *  - остатком у канала управляет сам канал (FBA, FBK — `channelManaged`);
 *  - у включённой синхронизации есть что опубликовать, но это меньше порога выставления — канал покажет ноль.
 * Одно правило у хранилища в памяти, у экрана (фильтр и подсветка строки, шаг 168) и у теста равенства с запросом PostgreSQL
 */
export function stockNeedsAttention(row: Pick<StockRow, 'available' | 'channels' | 'channelManaged'>): boolean {
  if ((row.channelManaged ?? []).length > 0) return true;
  return row.channels.some((c) => c.divergence !== null || (c.syncEnabled && c.allocation != null && belowMinimumToList(row.available, c.allocation)));
}
