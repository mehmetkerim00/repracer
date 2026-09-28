import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelWriteId } from '@repracer/channel-port';
import { EBAY_DESCRIPTOR } from '@repracer/ebay-adapter';
import { coreError, DEFAULT_RETRY_POLICY, planOutcomeTransition, planReconciliationTransition, retryPolicyFor } from '@repracer/write-dispatcher';

const NOW = '2026-09-14T10:00:00.000Z';
const id = 'cw-1' as ChannelWriteId;

/**
 * Шаг 51, eBay Growth Check: правило канала — не больше двух повторов записи и только после сбоя инфраструктуры. Правило берётся из
 * описания адаптера eBay, а не пишется в тесте заново: ослабь описание — упадёт этот тест
 */
test('eBay write retry rule: at most two retries, only infrastructure failures; an eBay 4xx is never retried', () => {
  const policy = retryPolicyFor(DEFAULT_RETRY_POLICY, EBAY_DESCRIPTOR.writeRetry);
  const fail = (code: Parameters<typeof coreError>[0], httpStatus?: number) =>
    ({ channelWriteId: id, status: 'REJECTED' as const, error: { ...coreError(code, 'TRANSIENT', String(httpStatus ?? 'not sent')), ...(httpStatus !== undefined ? { httpStatus } : {}) } });
  // 5xx, таймаут, обрыв соединения: попытки 1 и 2 повторяются, третья — последняя
  for (const [code, status] of [['CHANNEL_UNAVAILABLE', 503], ['TIMEOUT', undefined], ['NETWORK', undefined]] as const) {
    assert.equal(planOutcomeTransition(fail(code, status), 1, NOW, policy).to, 'RETRY', `${code}: first retry`);
    assert.equal(planOutcomeTransition(fail(code, status), 2, NOW, policy).to, 'RETRY', `${code}: second retry`);
    const third = planOutcomeTransition(fail(code, status), 3, NOW, policy);
    assert.deepEqual(third.to === 'DISCARD' && third.reason, { code: 'WRITE_RETRIES_EXHAUSTED', params: { attempts: 3, code } }, `${code}: no third retry`);
  }
  // Ответ eBay 4xx на значение — отказ канала без повтора, даже если адаптер отнёс его к временным (429)
  const tooMany = planOutcomeTransition(fail('RATE_LIMITED', 429), 1, NOW, policy);
  assert.deepEqual(tooMany.to === 'DISCARD' && [tooMany.reason.code, tooMany.reason.params.httpStatus], ['WRITE_NOT_ACCEPTED_BY_CHANNEL', 429], '429: not retried');
  // Отказ ФОРМЫ пакета EBAY_C18 (Р-189): значение не оценено — переотправка по одному SKU, но в пределах тех же трёх попыток
  assert.equal(planOutcomeTransition(fail('ACTION_NOT_ALLOWED', 400), 1, NOW, policy).to, 'RETRY');
  assert.equal(planOutcomeTransition(fail('ACTION_NOT_ALLOWED', 400), 3, NOW, policy).to, 'DISCARD');
  // Отказ нашего клиентского бюджета или режима пакетов до отправки — в eBay запроса не было, повтор допустим
  assert.equal(planOutcomeTransition(fail('RATE_LIMITED'), 1, NOW, policy).to, 'RETRY');
  assert.equal(planOutcomeTransition(fail('ACTION_NOT_ALLOWED'), 1, NOW, policy).to, 'RETRY');
  // Сверка «не применено» тоже расходует попытку: после третьей повтора нет
  assert.equal(planReconciliationTransition('DISPATCHED', { kind: 'NOT_APPLIED', observedMinor: null }, 3, NOW, NOW, policy).to, 'DISCARD');
  // Прочие каналы — прежняя общая политика: 429 повторяется
  assert.equal(planOutcomeTransition(fail('RATE_LIMITED', 429), 1, NOW, DEFAULT_RETRY_POLICY).to, 'RETRY');
});

