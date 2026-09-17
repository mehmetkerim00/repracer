import type { BASIS_MISMATCH_DIRECTIONS } from './reasons.ts';

/**
 * Р-116 (шаг 22): сверка базы цены при обратном чтении. Канал принял и применил запись, но покупатель видит цену, отличающуюся
 * от отправленной ровно на ставку налога: канал считает отправленную сумму нетто там, где мы отправили брутто (или наоборот).
 * Это тихий отказ того же класса, что испорченный вход [Р-42], только на выходе: каждая следующая запись будет неверной на ту же
 * долю, поэтому реакция — остановка витрины, а не повтор.
 *
 * Совпадение — с допуском в одну минимальную единицу на округление канала (проверить: правило округления Amazon и Kaufland
 * документацией не описано). Ставка — ставка товара [Р-53]; без ставки (режим sales tax, США) проверка не выполняется: доля налога
 * при покупке каналу неизвестна до адреса покупателя [Р-58].
 */
export type BasisMismatchDirection = (typeof BASIS_MISMATCH_DIRECTIONS)[number];

export const BASIS_MISMATCH_TOLERANCE_MINOR = 1;

export function priceBasisMismatch(sentMinor: number, observedMinor: number, vatRateBp: number | null): BasisMismatchDirection | null {
  if (vatRateBp === null || vatRateBp <= 0 || !Number.isSafeInteger(sentMinor) || !Number.isSafeInteger(observedMinor) || sentMinor <= 0) return null;
  if (observedMinor === sentMinor) return null;
  const added = Math.round((sentMinor * (10_000 + vatRateBp)) / 10_000);
  const removed = Math.round((sentMinor * 10_000) / (10_000 + vatRateBp));
  // Ставка меньше двух минимальных единиц от цены неотличима от округления — не признак базы
  if (added - sentMinor <= 2 * BASIS_MISMATCH_TOLERANCE_MINOR) return null;
  if (Math.abs(observedMinor - added) <= BASIS_MISMATCH_TOLERANCE_MINOR) return 'TAX_ADDED';
  if (Math.abs(observedMinor - removed) <= BASIS_MISMATCH_TOLERANCE_MINOR) return 'TAX_REMOVED';
  return null;
}
