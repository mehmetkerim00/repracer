import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { decisionItems } from './trace.ts';

/** Шаг 116 [Р-241]: повторы не пишутся строками журнала, поэтому строка сама называет их число и когда была последняя проверка. Данные синтетические */
const row = (over: Record<string, unknown>) => ({
  decisionId: 'd-1', intentId: 'i-1', writeScopeId: 'ws-1', decidedAt: '2026-11-07T11:00:00.000Z', outcome: 'NO_CHANGE', decisionClass: 'NO_OP', currency: 'USD', basis: 'NET', finalMinor: null,
  proposedMinor: 1900, rejectionReason: null, boundDeviationBp: null, noChangeReason: 'ALREADY_AT_TARGET', reason: { code: 'NO_CHANGE', params: {} }, explanation: null, checks: [], clearanceChangeId: null, ...over,
});
const world = { accounts: [], state: { scopes: [], explanationRulesets: [], strategies: [] } } as never;
const checks = (over: Record<string, unknown>, locale: (typeof LOCALES)[number] = 'en') => decisionItems(world, [row(over)] as never, messagesFor(locale))[0]!.checks;

test('step 116 [Р-241]: a journal row names the checks collapsed after it, or before it, and says nothing when there were none', () => {
  assert.equal(checks({}), null);
  assert.equal(checks({ repeatsBefore: 0, noChangeLive: { repeats: 0, lastEvaluatedAt: '2026-11-07T11:00:00.000Z' } }), null);
  assert.equal(checks({ repeatsBefore: 1 }), 'After 1 check with no change of state');
  assert.equal(checks({ repeatsBefore: 412 }), 'After 412 checks with no change of state');
  const live = checks({ repeatsBefore: 412, noChangeLive: { repeats: 41, lastEvaluatedAt: '2026-11-07T12:05:00.000Z' } });
  assert.match(live ?? '', /^Same state on 41 more checks, last .*12:05/, 'the live row speaks about the checks after it');
  assert.match(checks({ noChangeLive: { repeats: 1, lastEvaluatedAt: '2026-11-07T12:05:00.000Z' } }) ?? '', /^Same state on 1 more check, last /);
});

test('step 116 [Р-241]: the words are translated in every language and show no code', () => {
  const seen = new Set<string>();
  for (const locale of LOCALES) {
    const before = checks({ repeatsBefore: 3 }, locale)!;
    const live = checks({ noChangeLive: { repeats: 3, lastEvaluatedAt: '2026-11-07T12:05:00.000Z' } }, locale)!;
    for (const text of [before, live]) {
      assert.match(text, /3/, `${locale}: ${text}`);
      assert.doesNotMatch(text, /undefined|NaN|NO_CHANGE/, `${locale}: ${text}`);
      seen.add(text);
    }
  }
  assert.equal(seen.size, LOCALES.length * 2, 'every language has its own words');
});
