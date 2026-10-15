import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastAppliedWrite, oq220Drift, recognisedAsOq220, type AppliedAmountWrite, type ChannelOrder, type QuantityVersion } from './oq220.ts';

/**
 * Шаг 90 (OQ-220): класс «отмена, которую расчёт записи не видел» без хаоса — детерминированно, по двум красным прогонам CI.
 * Времена применения записей и заказов — из следа количества в сообщениях CI; моменты расчёта записи и чтения отмены те сообщения
 * не печатали — здесь они восстановлены (после шага 90 след их печатает). Данные синтетические.
 *
 * Детектор до шага 90 — отмены, которые канал сделал ПОСЛЕ ПРИМЕНЕНИЯ последней записи количества (`tsUpdated > применение`).
 */
const oldDrift = (applied: readonly AppliedAmountWrite[], orders: readonly ChannelOrder[]): number => {
  const lastWriteAt = applied.reduce((at, w) => Math.max(at, w.atMs), Number.NEGATIVE_INFINITY);
  return orders.filter((o) => o.status === 'cancelled' && o.tsUpdatedMs > lastWriteAt).length;
};
const at = (hms: string) => Date.parse(`2026-10-12T${hms}Z`);

/**
 * Полный CI шага 82, семя 823065306, раунд 2, предложение 100011: канал 6, наша цель и последнее применённое 7. Запись «7» посчитана
 * после чтения заказа 900031 и до чтения отмены 900013; канал отменил 900013 в 08:11:30.025 и применил «7» через 258 мс; затем заказ
 * 900045 — канал списал сам. Мы прочли отмену (+1) и 900045 (−1) одним заходом — цель осталась 7, новой записи нет
 */
const seed823065306 = {
  applied: [{ atMs: at('08:11:12.028'), amount: 8 }, { atMs: at('08:11:30.283'), amount: 7 }] as AppliedAmountWrite[],
  versions: [{ createdAtMs: at('08:11:11.500'), quantity: 8 }, { createdAtMs: at('08:11:28.900'), quantity: 7 }] as QuantityVersion[],
  orders: [
    { status: 'cancelled', tsUpdatedMs: at('08:11:30.025'), releasedAtMs: at('08:11:31.400') },
    { status: 'open', tsUpdatedMs: at('08:11:26.025'), releasedAtMs: null },
    { status: 'open', tsUpdatedMs: at('08:11:54.025'), releasedAtMs: null },
  ] as ChannelOrder[],
  ours: 7, channel: 6,
};

/**
 * Полный CI шага 84.1, семя 374308551, раунд 4, предложение 100010: канал 18, наша цель и последнее применённое 19. Канал отменил 900060
 * в 13:17:32.875 — за 10,7 с ДО применения «19» (13:17:43.615), а мы прочли отмену уже после расчёта «19»; заказ 900092 (13:17:56.875)
 * канал списал сам, мы его прочли (инвариант c раунда чист) — отмена и заказ одним заходом, цель осталась 19. Разбор шага 84.1 в
 * отложенном («заказ ещё не прочитан») был неверен: это тот же класс
 */
const seed374308551 = {
  applied: [{ atMs: at('13:17:35.361'), amount: 32 }, { atMs: at('13:17:43.615'), amount: 19 }] as AppliedAmountWrite[],
  versions: [{ createdAtMs: at('13:17:35.000'), quantity: 32 }, { createdAtMs: at('13:17:43.300'), quantity: 19 }] as QuantityVersion[],
  orders: [
    { status: 'cancelled', tsUpdatedMs: at('13:17:32.875'), releasedAtMs: at('13:17:47.100') },
    { status: 'sent', tsUpdatedMs: at('13:17:36.875'), releasedAtMs: null },
    { status: 'open', tsUpdatedMs: at('13:17:56.875'), releasedAtMs: null },
  ] as ChannelOrder[],
  ours: 19, channel: 18,
};

for (const [seed, h] of [['823065306', seed823065306], ['374308551', seed374308551]] as const) {
  test(`step 90 (OQ-220), seed ${seed}: a cancellation the computation of the last write did not see is counted — recognised`, () => {
    const drift = oq220Drift(h.applied, h.versions, h.orders);
    assert.equal(drift, 1);
    assert.equal(recognisedAsOq220(h.ours, h.channel, drift), true);
  });
  test(`step 90 (OQ-220), seed ${seed}: control — the detector before step 90 (cancelled after applying) calls it a divergence`, () => {
    const drift = oldDrift(h.applied, h.orders);
    assert.equal(drift, 0);
    assert.equal(recognisedAsOq220(h.ours, h.channel, drift), false, 'this is the red full CI run');
  });
}

test('step 90 (OQ-220): the channel time of a cancellation is not the sign — seed 374308551 was cancelled before the computation and read after it', () => {
  const h = seed374308551;
  const computedAt = lastAppliedWrite(h.applied, h.versions)!.computedAtMs;
  assert.ok(h.orders[0]!.tsUpdatedMs < computedAt, 'the channel cancelled before the write was computed');
  const byChannelTime = h.orders.filter((o) => o.status === 'cancelled' && o.tsUpdatedMs > computedAt).length;
  assert.equal(byChannelTime, 0, 'a window by the channel cancellation time would still miss it');
});

test('step 90 (OQ-220): the window is not wider than the class', () => {
  const h = seed823065306;
  // Отмену прочли ДО расчёта (или в той же транзакции) — расчёт её видел: не признаётся
  const seen: ChannelOrder[] = [{ status: 'cancelled', tsUpdatedMs: at('08:11:20.000'), releasedAtMs: at('08:11:28.900') }];
  assert.equal(oq220Drift(h.applied, h.versions, seen), 0);
  // Отмену не прочли вовсе: признаётся, только если канал отменил после расчёта
  assert.equal(oq220Drift(h.applied, h.versions, [{ status: 'cancelled', tsUpdatedMs: at('08:11:29.500') }]), 1);
  assert.equal(oq220Drift(h.applied, h.versions, [{ status: 'cancelled', tsUpdatedMs: at('08:11:20.000') }]), 0);
  // Разница не равна числу неучтённых отмен — расхождение; канал выше нашего — никогда не OQ-220
  const drift = oq220Drift(h.applied, h.versions, h.orders);
  assert.equal(recognisedAsOq220(7, 5, drift), false);
  assert.equal(recognisedAsOq220(7, 8, drift), false);
  // Момент расчёта: версия того же количества после применения — не расчёт этой записи; из нескольких до применения — самая поздняя
  assert.equal(lastAppliedWrite(h.applied, [...h.versions, { createdAtMs: at('08:11:40.000'), quantity: 7 }])!.computedAtMs, at('08:11:28.900'));
  assert.equal(lastAppliedWrite(h.applied, [...h.versions, { createdAtMs: at('08:11:30.100'), quantity: 7 }])!.computedAtMs, at('08:11:30.100'));
  // Версии записи нет — окно от применения
  assert.equal(lastAppliedWrite(h.applied, [])!.computedAtMs, at('08:11:30.283'));
});
