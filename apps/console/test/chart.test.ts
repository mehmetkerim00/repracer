import assert from 'node:assert/strict';
import { test } from 'node:test';
import { barValuesFit, dayLabelled, dayLabelStep } from '../src/chart.ts';

/**
 * Шаг 85 (адаптив): подписи дней графика тени не наезжают друг на друга на узком экране, а на широком — те же, что у шага 84
 */

const week = ['Oct 5', 'Oct 6', 'Oct 7', 'Oct 8', 'Oct 9', 'Oct 10', 'Oct 11'];
const month = Array.from({ length: 30 }, (_, i) => `Sep ${i + 1}`);

test('step 85: day labels thin out when the chart is narrow and stay as before on a wide screen', () => {
  // широкий экран (и неизмеренная ширина) — прежнее правило шага 84: у недели все подписи, у месяца — около шести
  assert.equal(dayLabelStep(week, 0), 1);
  assert.equal(dayLabelStep(week, 1000), 1);
  assert.equal(dayLabelStep(month, 0), 5);
  assert.equal(dayLabelStep(month, 1000), 5);
  // телефон: на неделю ~260px — каждая вторая подпись, и подписи с зазором помещаются в свои промежутки
  const every = dayLabelStep(week, 260);
  assert.equal(every, 2);
  const shown = week.map((_, i) => i).filter((i) => dayLabelled(i, week.length, every));
  assert.deepEqual(shown, [0, 2, 4, 6], 'every other day and today');
  assert.ok(shown.every((i, k) => k === 0 || (i - shown[k - 1]!) * (260 / week.length) >= 7 * 'Oct 10'.length + 12), 'labels do not overlap');
  // месяц на телефоне — реже прежних пяти
  assert.ok(dayLabelStep(month, 260) > 5);
  // сегодня подписано всегда
  assert.ok(dayLabelled(29, 30, dayLabelStep(month, 260)));
});

test('step 85: numbers above bars go to the tooltip when they do not fit their bar', () => {
  assert.equal(barValuesFit(['143', '151', '149', '140', '138', '144', '132'], 0), true, 'unmeasured — as in step 84');
  assert.equal(barValuesFit(['143', '151', '149', '140', '138', '144', '132'], 1000), true);
  assert.equal(barValuesFit(['1,243', '1,151', '1,149', '1,140', '1,138', '1,144', '1,132'], 260), false);
  assert.equal(barValuesFit(month, 2000), false, 'a month never shows numbers above bars');
});

/**
 * Красный полный CI шага 97.1 (38975402936, `full`, смоук шага 85): на 375px в окне 360px подписи «Oct 15» и «Today» стояли в СОСЕДНИХ
 * столбиках и раздвинули ряд до 411px. Восемь столбиков у «7 дней» бывают только в часть суток (неделя задевает восемь календарных
 * дней) — скрытый вход «время суток». Предпоследняя подпись не стоит ближе целого шага к последней
 */
test('step 97.4 (CI 97.1): with eight days on a phone the label before today is not in the neighbour slot of today', () => {
  const eight = ['Oct 9', 'Oct 10', 'Oct 11', 'Oct 12', 'Oct 13', 'Oct 14', 'Oct 15', 'Today'];
  const width = 300;
  const every = dayLabelStep(eight, width);
  assert.equal(every, 2);
  const shown = eight.map((_, i) => i).filter((i) => dayLabelled(i, eight.length, every));
  assert.ok(shown.includes(7), 'today is labelled');
  assert.ok(shown.every((i, k) => k === 0 || (i - shown[k - 1]!) * (width / eight.length) >= 7 * 'Oct 15'.length + 12),
    `labels do not overlap: ${shown.join(', ')}`);
});
