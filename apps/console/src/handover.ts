import type { OfferSelection } from '@repracer/console-model';

/**
 * Шаг 179 (#39): массовые операции с Offers — выбор Offers переходит на экран правки границ или назначения стратегии. Передача — в памяти
 * страницы и один раз: экран, открытый следом, забирает выбор и показывает его своей строкой выбора; перезагрузка страницы выбор не
 * переносит (невидимого выбора нет — Р-140 уточнён)
 */
const pending = new Map<string, OfferSelection>();

export function handOver(worldId: string, selection: OfferSelection): void {
  pending.set(worldId, selection);
}

/** Забрать выбор: удаляется следующим тиком — двойной вызов инициализатора состояния (строгий режим React) получает тот же выбор */
export function takeHandover(worldId: string): OfferSelection | null {
  const s = pending.get(worldId) ?? null;
  if (s) setTimeout(() => { if (pending.get(worldId) === s) pending.delete(worldId); }, 0);
  return s;
}
