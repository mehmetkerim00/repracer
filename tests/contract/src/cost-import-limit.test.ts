import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COST_IMPORT_SECONDS, COST_IMPORT_TARGET_SECONDS } from './cost-import-limit.ts';
import { returnTicketFindings, type ReturnTicket } from './return-ticket.ts';

/** Шаг 110.5 (решение владельца): предел живого прогона импорта себестоимости временно выше цели — и держит обратный билет */
const TICKET: ReturnTicket = { limit: COST_IMPORT_SECONDS, target: COST_IMPORT_TARGET_SECONDS, topic: 'cost_profile', promise: `ВЕРНУТЬ предел к ${COST_IMPORT_TARGET_SECONDS} с` };

test('step 110.5: the cost import limit above its 60 s target holds its return ticket in docs/deferred.md', () => {
  const deferred = readFileSync(new URL('../../../docs/deferred.md', import.meta.url), 'utf8');
  assert.equal(COST_IMPORT_TARGET_SECONDS, 60);
  assert.deepEqual(returnTicketFindings(deferred, TICKET), []);
  // Зубы [Р-94]: без строки — находка; вернули предел к цели — билет не нужен
  assert.equal(returnTicketFindings(deferred.replaceAll('ВЕРНУТЬ предел к 60 с', 'вернуть когда-нибудь'), TICKET).length, 1);
  assert.deepEqual(returnTicketFindings('', { ...TICKET, limit: COST_IMPORT_TARGET_SECONDS }), []);
});
