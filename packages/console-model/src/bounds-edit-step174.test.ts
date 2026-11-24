import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsProblemsText, expandBoundsEdit, PROBLEM_OFFERS_SHOWN } from './bounds-edit.ts';
import { messagesFor } from './i18n/index.ts';
import type { Locale } from './i18n/types.ts';
import { bulkJobView } from './jobs.ts';

/**
 * Шаг 174 (QA-A Testing 2.0, BUG-02): массовая правка границ, у которой минимум встал бы выше максимума, отказывала ТРИ раза одним кодом
 * («unexpected error (code MIN_ABOVE_MAX)» — заголовок карточки задания, её плашка и плашка формы) и только у первого предложения. Теперь
 * проверка — до задания, по действующим границам, у всех предложений; текст — один, словами: какие предложения (подписью) и какие суммы,
 * «ничего не изменено». Причины задания — словами без кода. Данные синтетические
 */

const resolved = (amountMinor: number) => ({ status: 'RESOLVED', amountMinor, sourceIds: ['x'] });
function scope(n: number) {
  return {
    writeScopeId: `ws-${n}`, productId: `p-${n}`, channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${n}`, channelProductRef: `REF-${n}`,
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', title: `Desk lamp ${n}`, sku: `SKU-${n}`,
    pricingMode: 'OFF', status: 'ACTIVE', currentPriceMinor: 1500, minMarginBp: null, cost: null, declaredCost: null,
    clearance: null, strategy: null, priceStop: null, channelHalt: null, channelDistrust: null, pricingSwitch: null,
    bounds: { currency: 'USD', basis: 'NET', min: resolved(1000), max: resolved(2000) }, feeEstimates: [], fees: [],
  };
}
function world(count: number) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-11-25T12:00:00.000Z', viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes: Array.from({ length: count }, (_, i) => scope(i + 1)), writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [],
      divergenceCases: [], halts: [], stops: [], distrusts: [], members: [{ membershipId: 'mb', role: 'OWNER' }], offerChannelPricing: [], pricingHealth: [], listingStatus: [] },
  } as never;
}
const ids = (n: number) => Array.from({ length: n }, (_, i) => `ws-${i + 1}`);

test('step 174 (BUG-02): min above max is found before the job — min only, max only, min and max — for every offer, with the amounts it would get', () => {
  const w = world(3);
  const crossed = (request: object) => expandBoundsEdit(w, { writeScopeIds: ids(3), ...request }).problems.map((p) => p.code === 'MIN_ABOVE_MAX' ? [p.writeScopeId, p.minMinor, p.maxMinor] : [p.code]);
  assert.deepEqual(crossed({ min: { kind: 'SET', minor: 2500 } }), [['ws-1', 2500, 2000], ['ws-2', 2500, 2000], ['ws-3', 2500, 2000]], 'min only');
  assert.deepEqual(crossed({ max: { kind: 'SET', minor: 500 } }), [['ws-1', 1000, 500], ['ws-2', 1000, 500], ['ws-3', 1000, 500]], 'max only');
  assert.deepEqual(crossed({ min: { kind: 'SET', minor: 3000 }, max: { kind: 'SET', minor: 2500 } }), [['ws-1', 3000, 2500], ['ws-2', 3000, 2500], ['ws-3', 3000, 2500]], 'min and max');
  // Контроль: правка в пределах — проблем нет; минимум, равный максимуму, — не нарушение
  assert.deepEqual(crossed({ min: { kind: 'SET', minor: 1200 }, max: { kind: 'SET', minor: 1900 } }), []);
  assert.deepEqual(crossed({ min: { kind: 'SET', minor: 2000 } }), []);
});

test('step 174 (BUG-02): the refusal is one text in words — offers by their label, amounts with the currency, «nothing was changed»; no code, no internal ID', () => {
  for (const l of ['en', 'de', 'es', 'fr'] as Locale[]) {
    const m = messagesFor(l);
    const w = world(PROBLEM_OFFERS_SHOWN + 2);
    const { problems } = expandBoundsEdit(w, { writeScopeIds: ids(PROBLEM_OFFERS_SHOWN + 2), min: { kind: 'SET', minor: 2500 } });
    const text = boundsProblemsText(w, problems, m);
    for (let n = 1; n <= PROBLEM_OFFERS_SHOWN; n++) assert.ok(text.includes(`Desk lamp ${n} · amazon.com`), `${l}: offer ${n} by its label — ${text}`);
    assert.ok(!text.includes(`Desk lamp ${PROBLEM_OFFERS_SHOWN + 1} ·`), `${l}: the rest is a number`);
    assert.ok(text.includes(m.money(2500, 'USD')) && text.includes(m.money(2000, 'USD')), `${l}: the amounts`);
    assert.ok(text.endsWith(m.ui.boundsEdit.problems.nothingChanged), `${l}: nothing was changed`);
    assert.deepEqual([/MIN_ABOVE_MAX|_price|ws-\d/.test(text), text.split(m.ui.boundsEdit.problems.nothingChanged).length - 1], [false, 1], `${l}: one text, no code or ID — ${text}`);
  }
});

test('step 174 (BUG-02): every cause a bounds job can end with is words — no code reaches the seller, not even an unknown one', () => {
  const causes = ['BAD_REQUEST', 'BAD_EDIT', 'PLAN_CHANGED', 'MIN_ABOVE_MAX', 'SCOPE_NOT_FOUND', 'CONFLICT', 'FORBIDDEN', 'MFA_REQUIRED', 'MFA_REQUIRED_WINDOW', 'SOMETHING_NEW_42'];
  for (const l of ['en', 'de', 'es', 'fr'] as Locale[]) {
    const m = messagesFor(l);
    for (const code of causes) {
      const job = { jobId: 'j', kind: 'BOUNDS_PLAN', status: 'FAILED', phase: null, totalItems: 3, doneItems: 0, params: {}, result: null, errorCode: code,
        createdAt: '2026-11-25T12:00:00.000Z', startedAt: null, finishedAt: null, attempts: 1, leaseExpired: false, createdByMembershipId: 'mb' };
      const v = bulkJobView(job as never, m);
      assert.ok(v.error !== null && !v.error.includes(code) && !v.headline.includes(code), `${l}: ${code} → ${v.error}`);
      if (code !== 'SOMETHING_NEW_42') assert.notEqual(v.error, m.ui.jobs.errorUnknown(code), `${l}: ${code} has its own words`);
    }
  }
});
