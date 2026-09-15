import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_REASON_CODES, SANITY_NOTE_CODES } from '@repracer/pricing-model';
import { describe, explainabilityCatalogue, LOCALES, messagesFor, REASON_LIMITS } from './index.ts';

/** Р-71, Р-72: словарь DE/EN полон, суммы — только с валютой, значения канала вне слепка помечаются */

function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [path];
  if (Array.isArray(value)) return [path];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k)).sort();
  return [path];
}

test('Р-72: the German and English dictionaries have the same keys, and every reason code has a title and a text', () => {
  const [de, en] = LOCALES.map((l) => messagesFor(l));
  assert.deepEqual(shape(de), shape(en));
  for (const m of [de!, en!]) {
    for (const code of ALL_REASON_CODES) {
      assert.equal(typeof m.titles[code], 'string', `${m.locale} title ${code}`);
      assert.equal(typeof m.reasons[code], 'function', `${m.locale} text ${code}`);
    }
    for (const code of SANITY_NOTE_CODES) assert.equal(typeof m.notes[code], 'function', `${m.locale} note ${code}`);
  }
});

test('Р-71: an amount is formatted only with the currency of the reason; without it the screen says so', () => {
  const en = messagesFor('en');
  const de = messagesFor('de');
  const reason = { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 900, minMinor: 1000, deviationBp: 1000, currency: 'USD' } };
  const r = describe(reason, en);
  assert.deepEqual([r.text, r.problems], ['Rejected: $9.00 is below min_price $10.00 by 10%.', []]);
  assert.equal(describe(reason, de).text, 'Abgelehnt: 9,00 $ liegt unter min_price 10,00 $ um 10 %.');
  const noCurrency = describe({ code: 'BELOW_MIN_PRICE', params: { proposedMinor: 900, minMinor: 1000 } }, en);
  assert.ok(noCurrency.problems.includes('AMOUNT_WITHOUT_CURRENCY'));
  assert.match(noCurrency.text, /900 \(currency missing\)/);
});

test('Р-68: a channel value withheld from the explanation is marked, not invented', () => {
  const r = describe({ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, targetMinor: 1775, currency: 'EUR' }, withheld: ['buyboxMinor'] }, messagesFor('en'));
  assert.equal(r.text, 'Undercut the Buy Box channel value not kept by €0.05: €17.75.');
  assert.deepEqual([r.problems, r.withheld], [[], ['buyboxMinor']]);
});

test('D: four codes stay limited, each with the reason a parameter is impossible', () => {
  for (const locale of LOCALES) {
    const rows = explainabilityCatalogue(messagesFor(locale));
    assert.equal(rows.length, ALL_REASON_CODES.length);
    const limited = rows.filter((r) => r.verdict === 'LIMITED');
    assert.deepEqual(limited.map((r) => r.code).sort(), Object.keys(REASON_LIMITS).sort());
    assert.equal(limited.length, 4);
    assert.ok(limited.every((r) => (r.note ?? '').length > 40));
  }
});

test('unknown codes and optional parameters: problems only where the registry is violated', () => {
  const en = messagesFor('en');
  assert.deepEqual(describe({ code: 'NOT_A_CODE', params: {} }, en).problems.filter((p) => p === 'UNKNOWN_CODE'), ['UNKNOWN_CODE']);
  const optional = describe({ code: 'SCOPE_NOT_ACTIVE', params: { status: 'HELD', mode: 'ENGINE', blockedByErrorCode: null, blockedSince: null, action: null } }, en);
  assert.deepEqual([optional.text, optional.problems], ['Held: the offer is held with pricing mode automatic.', []]);
});
