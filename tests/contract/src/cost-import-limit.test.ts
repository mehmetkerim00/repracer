import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COST_IMPORT_SECONDS, COST_IMPORT_TARGET_SECONDS } from './cost-import-limit.ts';
import { returnTicketFindings, type ReturnTicket } from './return-ticket.ts';

/**
 * Шаг 110.5 (решение владельца): предел живого прогона импорта себестоимости выше цели — только с обратным билетом в docs/deferred.md.
 * Шаг 113: предел вернулся к цели, билет закрыт. Тест зелёный в обоих состояниях перехода — предел выше цели со строкой билета и предел,
 * равный цели, без неё; зубы проверяются на пределе выше цели, а не на действующем
 */
const TICKET: ReturnTicket = { limit: COST_IMPORT_SECONDS, target: COST_IMPORT_TARGET_SECONDS, topic: 'cost_profile', promise: `ВЕРНУТЬ предел к ${COST_IMPORT_TARGET_SECONDS} с` };

test('step 110.5, step 113: the cost import limit above its 60 s target holds its return ticket in docs/deferred.md; at the target it needs none', () => {
  const deferred = readFileSync(new URL('../../../docs/deferred.md', import.meta.url), 'utf8');
  assert.equal(COST_IMPORT_TARGET_SECONDS, 60);
  assert.ok(COST_IMPORT_SECONDS >= COST_IMPORT_TARGET_SECONDS, 'the limit is never below its target');
  assert.deepEqual(returnTicketFindings(deferred, TICKET), []);
  // Зубы [Р-94]: предел выше цели без строки — находка; со строкой, где названо обещание, — нет; предел, равный цели, билета не требует
  const raised: ReturnTicket = { ...TICKET, limit: COST_IMPORT_TARGET_SECONDS + 30 };
  assert.equal(returnTicketFindings(deferred.replaceAll('ВЕРНУТЬ предел к 60 с', 'вернуть когда-нибудь'), raised).length, 1);
  assert.deepEqual(returnTicketFindings('| 99 (импорты), 110.5 | cost_profile … ВЕРНУТЬ предел к 60 с |', raised), []);
  assert.deepEqual(returnTicketFindings('', { ...TICKET, limit: COST_IMPORT_TARGET_SECONDS }), []);
});
