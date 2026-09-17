import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_REASON_CODES, SANITY_NOTE_CODES } from '@repracer/pricing-model';
import { describe, explainabilityCatalogue, FEED_PAGE_MAX, LOCALES, messagesFor, parseAmountInput, parseFeedQuery, parsePercentInput, REASON_LIMITS } from './index.ts';

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

test('Р-117: the report counts the floor holding a strategy, not Gate rejections; the amount is the distance from the kept price to the strategy target', async () => {
  const { dangerousReport } = await import('./index.ts');
  const scope = { writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'de', externalUnitId: '4101', channelProductRef: '3621', condition: 'new', gtin: null, currency: 'EUR' };
  const intent = (intentId: string, createdAt: string, reason: { code: string; params: Record<string, unknown> }, explanation: unknown[], currentMinor: number) => ({
    intentId, writeScopeId: 'ws-1', createdAt, currency: 'EUR', currentMinor, reason, explanation,
  });
  const world = {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-09-17T12:00:00.000Z', viewer: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'KAUFLAND', marketplaces: ['de'] }],
    state: {
      scopes: [scope], decisions: [], strategies: [], explanationRulesets: [],
      intents: [
        // Поставлена на пол: цель 11.95, пол 15.00 — без пола на 3.05 дешевле
        intent('i-1', '2026-09-17T10:00:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'BUYBOX_UNDERCUT', params: {} }, { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1195, minMinor: 1500, currency: 'EUR' } }], 1850),
        // Рынок ушёл вверх: пол не нужен — удержание закончилось
        intent('i-1b', '2026-09-17T10:30:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'BUYBOX_UNDERCUT', params: {} }], 1500),
        // Оставлена без изменения на 18.50: цель 14.00 ниже пола 15.00 — без пола на 4.50 дешевле
        intent('i-2', '2026-09-17T11:00:00.000Z', { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 1400, minMinor: 1500, maxMinor: 2500, currency: 'EUR' } }, [], 1850),
        // Удержание потолком — не работа пола
        intent('i-3', '2026-09-17T11:30:00.000Z', { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 2600, minMinor: 1500, maxMinor: 2500, currency: 'EUR' } }, [], 1850),
        // Вне периода одного дня
        intent('i-4', '2026-09-15T11:00:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1000, minMinor: 1500, currency: 'EUR' } }], 1850),
      ],
    },
  } as never;
  const en = messagesFor('en');
  const day = dangerousReport(world, 1, en);
  assert.equal(day.headline, 'The floor held the price 2 times in the last 1 day; without it you would have sold €7.55 cheaper');
  assert.deepEqual(day.floorHolds.items.map((i) => [i.kind, i.target, i.floor, i.below]), [['HELD', '€14.00', '€15.00', '€4.50'], ['CAPPED', '€11.95', '€15.00', '€3.05']]);
  assert.equal(day.gateHeadline, 'Your bounds stopped 0 dangerous changes in the last 1 day');
  // За 7 дней оценка 15.09 и 17.09 10:00 идут подряд без оценки вне пола — одно удержание; вместе с удержанием после 10:30 — два
  assert.equal(dangerousReport(world, 7, en).floorHolds.count, 2);
  // Ревью шага 22, находка 4: цена стоит на полу, стратегия оценивается 12 раз подряд — одно удержание, а не двенадцать
  const repeated = { ...(world as { state: object }), state: { ...(world as { state: object }).state, intents: Array.from({ length: 12 }, (_, n) =>
    intent(`r-${n}`, `2026-09-17T11:${String(n * 5).padStart(2, '0')}:00.000Z`, { code: 'ALREADY_AT_TARGET', params: {} }, [{ code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1195, minMinor: 1500, currency: 'EUR' } }], 1500)) } } as never;
  assert.equal(dangerousReport(repeated, 1, en).headline, 'The floor held the price 1 time in the last 1 day; without it you would have sold €3.05 cheaper');
  assert.equal(dangerousReport(world, 1, messagesFor('de')).headline, 'Die Untergrenze hat den Preis in den letzten 1 Tag 2-mal gehalten; ohne sie hätten Sie 7,55 € billiger verkauft');
});

test('step 23: a person enters amounts and percentages, not cents and basis points; anything else is refused, not guessed', () => {
  assert.deepEqual(['19,99', '19.9', ' 20 ', '0.05'].map(parseAmountInput), [1999, 1990, 2000, 5]);
  assert.deepEqual(['1.234,50', '19,999', '-5', 'x', ''].map(parseAmountInput), [null, null, null, null, null]);
  assert.deepEqual(['-5', '2,5', '−12.25', '+3', '12.5'].map(parsePercentInput), [-500, 250, -1225, 300, 1250]);
  assert.deepEqual(['*5', '5%', '1.234'].map(parsePercentInput), [null, null, null]);
});

test('step 23: the feed query is checked on the server — an unknown status, period or page size is a bad request, not “all”', () => {
  const q = (s: string) => parseFeedQuery(new URLSearchParams(s));
  assert.deepEqual(q('status=APPLIED&days=7&offset=50&limit=50'), { status: 'APPLIED', days: 7, offset: 50, limit: 50 });
  assert.deepEqual(q(''), {});
  for (const bad of ['status=ALL', 'days=5', 'limit=0', `limit=${FEED_PAGE_MAX + 1}`, 'offset=-1', 'offset=1e3']) assert.equal(q(bad), null, bad);
});

test('review of step 24, finding 12: the price evidence CSV neutralises spreadsheet formulas and quotes line breaks', async () => {
  const { priceEvidenceCsv } = await import('./compliance.ts');
  const world = { accounts: [], state: { scopes: [] } } as never;
  const csv = priceEvidenceCsv(world, [{ writeScopeId: '=HYPERLINK("x")', day: '2026-09-17', timeZone: 'Europe/Berlin', currency: 'EUR', basis: 'GROSS', minMinor: 1000, maxMinor: 1000,
    firstMinor: 1000, lastMinor: 1000, changes: 1, source: 'CLOSED', corrected: true, correctionReason: '+cmd\r|x' }]);
  const line = csv.split('\n')[1]!;
  assert.ok(line.includes(`"'=HYPERLINK(""x"")"`), line);
  assert.ok(line.includes(`"'+cmd\r|x"`), line);
});
