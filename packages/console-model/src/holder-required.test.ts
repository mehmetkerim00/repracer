import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe } from './explain.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { decisionItems, decisionTrace } from './trace.ts';

/**
 * Шаг 115.2 (решение владельца по докладу 115): стратегия, которой нужен держатель Buy Box, без него цену не двигает, и причина видна там же, где у
 * NO_ELIGIBLE_COMPETITORS: заголовок в журнале цен и фраза в квитанции, на всех языках, без кодов. Данные синтетические
 */
const noMajority = { code: 'BUYBOX_HOLDER_REQUIRED', params: { buyboxHolder: 'NO_MAJORITY' } } as const;
const notNamed = { code: 'BUYBOX_HOLDER_REQUIRED', params: { buyboxHolder: 'NOT_NAMED' } } as const;

const decision = {
  decisionId: 'd-1', intentId: 'i-1', writeScopeId: 'ws-1', decidedAt: '2026-11-06T11:00:00.000Z', outcome: 'NO_CHANGE', decisionClass: 'NO_OP',
  currency: 'USD', basis: 'NET', finalMinor: null, proposedMinor: 1900, rejectionReason: null, boundDeviationBp: null, noChangeReason: 'BUYBOX_HOLDER_REQUIRED',
  reason: { code: 'NO_CHANGE', params: {} }, explanation: null, checks: [], clearanceChangeId: null,
};
const scope = {
  writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SYN-SKU-1152', channelProductRef: 'B0SYN1152',
  condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', productTitle: 'Plant pot', productSku: 'SYN-SKU-1152',
  pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1900, minMarginBp: null, cost: null, declaredCost: null, clearance: null, strategy: null,
  bounds: { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: ['m'] }, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['x'] } },
  feeEstimates: [], fees: [], channelNotes: [],
};
const world = {
  id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-11-06T12:00:00.000Z', viewer: { role: 'OWNER' }, people: {},
  accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
  state: { scopes: [scope], writes: [], strategies: [], explanationRulesets: [], fxRates: [], members: [], divergenceCases: [], offerChannelPricing: [], pricingHealth: [], halts: [] },
} as never;

test('step 115.2: the two causes read differently in every language, say the price stays, and show no code', () => {
  const titles = new Set<string>();
  for (const locale of LOCALES) {
    const m = messagesFor(locale);
    const title = (m.titles as Record<string, string>).BUYBOX_HOLDER_REQUIRED!;
    assert.ok(title && !title.includes('BUYBOX'), `${locale}: ${title}`);
    assert.ok(title.includes('Buy Box') || title.includes('Buy-Box'), `${locale}: Buy Box is not translated: ${title}`);
    titles.add(title);
    const majority = describe(noMajority, m).text;
    const named = describe(notNamed, m).text;
    assert.notEqual(majority, named, `${locale}: the causes read differently`);
    for (const text of [majority, named]) assert.doesNotMatch(text, /BUYBOX_|NO_MAJORITY|NOT_NAMED|undefined|Р-\d+/, `${locale}: ${text}`);
    assert.equal(decisionItems(world, [decision] as never, m)[0]!.reason, title, `${locale}: the price journal shows the title`);
  }
  assert.equal(titles.size, LOCALES.length, 'every language has its own title');
  const en = messagesFor('en');
  assert.equal((en.titles as Record<string, string>).BUYBOX_HOLDER_REQUIRED, 'No single Buy Box holder — kept');
  assert.equal(describe(noMajority, en).text, 'No seller has more than half of the views, so nobody counts as the Buy Box holder. Your strategy follows a named holder, so the price stays.');
  assert.equal(describe(notNamed, en).text, 'This channel did not say who holds the Buy Box. Your strategy follows a named holder, so the price stays.');
});

test('step 115.2: while the hot intent lives the receipt gives the sentence; older decisions keep the title', () => {
  const en = messagesFor('en');
  const strategyStep = (detail: unknown) => decisionTrace(world, detail as never, en).steps.find((s) => s.key === 'STRATEGY')!;
  const fresh = strategyStep({ decision, intent: { intentId: 'i-1', writeScopeId: 'ws-1', createdAt: decision.decidedAt, currency: 'USD', currentMinor: 1900, reason: noMajority, explanation: [noMajority] }, writes: [] });
  assert.equal(fresh.items[0]?.label, 'No single Buy Box holder — kept');
  assert.match(fresh.items[0]?.reason?.text ?? '', /No seller has more than half of the views/);
  assert.match(fresh.summary, /No single Buy Box holder/);
  const old = strategyStep({ decision, intent: null, writes: [] });
  assert.deepEqual(old.items, [], 'after three days only the code is kept [Р-74]');
  assert.match(old.summary, /No single Buy Box holder/, 'the title still names the reason');
});
