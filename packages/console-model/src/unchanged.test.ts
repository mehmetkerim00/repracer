import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { unchangedView } from './unchanged.ts';

/**
 * Шаг 169 (#36, решение владельца): «Why didn't my price change?» — только из сохранённых причин решений, без причинности задним числом.
 * Фраза — заголовок квитанции последнего решения периода; «с какого времени» — цепочка последних решений с той же сохранённой причиной;
 * решений нет — честное «no decision was computed» и когда они появляются. Данные синтетические
 */

const en = messagesFor('en');
const scope = { writeScopeId: 'ws-1', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SKU-1', channelProductRef: 'B0SYN1', condition: 'new', gtin: null, title: 'Desk lamp', sku: 'SKU-1' };
const world = {
  id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-11-18T12:00:00.000Z', viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
  accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
  state: { scopes: [scope], explanationRulesets: [], strategies: [] },
} as never;
const row = (id: string, decidedAt: string, over: Record<string, unknown> = {}) => ({
  decisionId: id, intentId: `i-${id}`, writeScopeId: 'ws-1', decidedAt, outcome: 'NO_CHANGE', decisionClass: 'NO_OP', currency: 'USD', basis: 'NET', finalMinor: null,
  proposedMinor: 1900, rejectionReason: null, boundDeviationBp: null, noChangeReason: 'ALREADY_AT_TARGET', reason: { code: 'NO_CHANGE', params: {} }, explanation: null, checks: [],
  clearanceChangeId: null, ...over,
});
const trace = (decisionId: string, headline: string, code: string, label: string) =>
  ({ decisionId, headline, status: { code, label, tone: 'off' }, summary: {}, steps: [], gaps: [] }) as never;
const view = (items: unknown[], latest: unknown, total = items.length, m = en) =>
  unchangedView(world, scope as never, { items, total } as never, latest as never, m, { preset: '7d' }, false);

test('step 169 (#36): the latest decision kept the price — the receipt sentence, since when the same stored reason runs, the checks after it', () => {
  const items = [
    row('d-3', '2026-11-18T10:00:00.000Z', { noChangeLive: { repeats: 41, lastEvaluatedAt: '2026-11-18T11:55:00.000Z' } }),
    row('d-2', '2026-11-17T10:00:00.000Z'),
    row('d-1', '2026-11-16T09:00:00.000Z', { outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: 1850, noChangeReason: null, reason: { code: 'BEAT_LOWEST', params: {} } }),
  ];
  const v = view(items, trace('d-3', 'No change: the price is already at the target $19.00.', 'NO_CHANGE', 'No change'));
  assert.equal(v.state, 'UNCHANGED');
  assert.equal(v.headline, 'No change: the price is already at the target $19.00.', 'the same words as the receipt');
  assert.deepEqual([v.decisionId, v.status?.label], ['d-3', 'No change']);
  assert.equal(v.facts[0], en.ui.unchanged.since(en.when('2026-11-17T10:00:00.000Z')), 'the run of the same stored reason starts at the older row');
  assert.match(v.facts.join(' | '), /Same state on 41 more checks/, 'the checks collapsed after the latest row — the journal words');
  assert.ok(v.facts.some((f) => f === en.ui.unchanged.lastChange(v.history[2]!.price, en.when('2026-11-16T09:00:00.000Z'))), `the last price change of the period: ${v.facts.join(' | ')}`);
  assert.equal(v.history.length, 3);
});

test('step 169 (#36): a run that reaches the end of what the period holds is «at least since» — nothing older is guessed', () => {
  const items = [row('d-2', '2026-11-18T10:00:00.000Z'), row('d-1', '2026-11-17T10:00:00.000Z')];
  const v = view(items, trace('d-2', 'No change.', 'NO_CHANGE', 'No change'));
  assert.equal(v.facts[0], en.ui.unchanged.sinceAtLeast(en.when('2026-11-17T10:00:00.000Z')));
  const other = view([row('d-2', '2026-11-18T10:00:00.000Z'), row('d-1', '2026-11-17T10:00:00.000Z', { noChangeReason: 'BUYBOX_HOLDER_REQUIRED' })],
    trace('d-2', 'No change.', 'NO_CHANGE', 'No change'));
  assert.equal(other.facts[0], en.ui.unchanged.since(en.when('2026-11-18T10:00:00.000Z')), 'another stored reason ends the run');
});

test('step 169 (#36): a rejection and a shadow hold kept the price; an approved and sent decision changed it', () => {
  const rejected = view([row('d-1', '2026-11-18T10:00:00.000Z', { outcome: 'REJECTED', decisionClass: 'REJECTED_BY_GATE', noChangeReason: null, rejectionReason: 'BELOW_MIN_PRICE' })],
    trace('d-1', 'Rejected: $11.99 is below your minimum price $12.00 by 0.09%.', 'REJECTED', 'Rejected'));
  assert.deepEqual([rejected.state, rejected.lead], ['UNCHANGED', en.ui.unchanged.lead.UNCHANGED(en.ui.period.phrase['7d'])]);
  const held = view([row('d-1', '2026-11-18T10:00:00.000Z', { outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: 1850, noChangeReason: null, shadow: true })],
    trace('d-1', 'Held in shadow mode: $18.50 was not sent to your store.', 'HELD_IN_SHADOW', 'Held in shadow mode'));
  assert.equal(held.state, 'UNCHANGED', 'a price held by shadow mode did not reach the store');
  const sent = view([row('d-1', '2026-11-18T10:00:00.000Z', { outcome: 'APPROVED', decisionClass: 'CHANGED', finalMinor: 1850, noChangeReason: null, shadow: false })],
    trace('d-1', 'Approved: $18.50.', 'APPROVED_FOR_SENDING', 'Approved for sending'));
  assert.deepEqual([sent.state, sent.lead], ['CHANGED', en.ui.unchanged.lead.CHANGED(en.ui.period.phrase['7d'])]);
});

test('step 169 (#36): no decision in the period — the honest sentence and when decisions appear, in every language', () => {
  const v = view([], null);
  assert.deepEqual([v.state, v.headline, v.decisionId, v.evidence, v.history.length], ['NONE', en.ui.unchanged.none(en.ui.period.phrase['7d']), null, null, 0]);
  assert.equal(v.noneText, en.ui.unchanged.noneWhen);
  for (const locale of LOCALES) {
    const m = messagesFor(locale);
    const t = m.ui.unchanged;
    for (const text of [t.title, t.link, t.none(m.ui.period.phrase['7d']), t.noneWhen, t.lead.UNCHANGED('x'), t.lead.CHANGED('x'), t.since('x'), t.sinceAtLeast('x'), t.lastChange('$1', 'x'), t.evidence, t.history, t.openReceipt, t.pickOffer]) {
      assert.ok(text.trim() !== '' && !/undefined|NaN/.test(text), `${locale}: ${text}`);
    }
  }
});
