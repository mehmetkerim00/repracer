/**
 * Шаг 85 (адаптив): график решений по суткам на узком экране. Подписи дней и числа над столбиками не наезжают друг на друга — при
 * тесноте подписи прореживаются (каждая k-я, последняя — «сегодня» — всегда), а числа над столбиками уходят в подсказку столбика.
 * Ширина подписи оценивается по длине текста мелким шрифтом (12px: ~7px на знак) с зазором; пока ширина не измерена (0) — прежнее
 * правило шага 84: у недели подписи все, у месяца — примерно шесть
 */

/** Ширина подписи мелким шрифтом, px: ~7px на знак и зазор */
export function smallTextPx(text: string): number {
  return 7 * text.length + 12;
}

/** Шаг подписей дней: каждая k-я. Не реже, чем у шага 84 (месяц — около шести подписей), и не теснее, чем помещается самая длинная подпись */
export function dayLabelStep(labels: readonly string[], widthPx: number): number {
  const n = labels.length;
  if (n <= 1) return 1;
  const base = n > 10 ? Math.ceil(n / 6) : 1;
  if (!(widthPx > 0)) return base;
  const widest = Math.max(...labels.map(smallTextPx));
  return Math.max(base, Math.ceil(widest / (widthPx / n)));
}

/**
 * Подписан ли день i при шаге every: каждый every-й и последний; предпоследняя подпись не подходит к последней ближе целого шага.
 * Шаг 97.4 (красный полный CI 97.1): прежнее «не ближе полушага» при шаге 2 ставило подписи в соседние столбики — «Oct 15» и «Today»
 * раздвигали ряд на телефоне (восемь дней у «7 дней» бывают только в часть суток)
 */
export function dayLabelled(i: number, n: number, every: number): boolean {
  return (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every);
}

/** Числа над столбиками: только у недели (как у шага 84) и только если самое длинное число помещается над своим столбиком */
export function barValuesFit(values: readonly string[], widthPx: number): boolean {
  if (values.length > 7) return false;
  if (!(widthPx > 0)) return true;
  return Math.max(0, ...values.map(smallTextPx)) <= widthPx / Math.max(1, values.length);
}
