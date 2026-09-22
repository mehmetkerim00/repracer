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
