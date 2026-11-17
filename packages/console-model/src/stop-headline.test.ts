import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { stopView } from './stop.ts';

/**
 * Шаг 157 (#28, Р-254): Stop pricing начинается одной строкой состояния — работает или что остановлено, кем, когда и с какой запиской; рядом —
 * системные остановки и недоверие, если они есть. Данные синтетические
 */

const NOW = '2026-11-17T12:00:00.000Z';
const ACC = 'acc-1';
function world(stops: unknown[] = [], halts: unknown[] = [], distrusts: unknown[] = []) {
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb-owner' }, people: {},
    accounts: [{ channelAccountId: ACC, channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes: [], writes: [], strategies: [], strategyVersions: [], explanationRulesets: [], fxRates: [], divergenceCases: [], stops, halts, distrusts, haltReviews: [],
      offerChannelPricing: [], pricingHealth: [], listingStatus: [], members: [{ membershipId: 'mb-owner', role: 'OWNER' }, { membershipId: 'mb-manager', role: 'MANAGER' }] },
  } as never;
}
const stop = (over: Record<string, unknown>) => ({ stopId: 's1', scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: '2026-11-17T09:12:00.000Z',
  stoppedByMembershipId: 'mb-manager', note: 'Supplier price talks', releasedAt: null, releasedByMembershipId: null, releaseNote: null, ...over });
const halt = { haltId: 'h1', channelAccountId: ACC, marketplace: 'ATVPDKIKX0DER', reasonCode: 'MASS_SHIFT', haltedAt: NOW, nextReviewAt: NOW, releasedAt: null, releasedKind: null };

test('step 157 (#28): the stop screen leads with one status line — running, or what is stopped, by whom, when and with which note — four languages', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const h = m.ui.stop.headline;
    assert.deepEqual(stopView(world(), [], m).headline, { tone: 'ok', text: h.running }, `${l}: running`);
    const tenant = stopView(world([stop({}), stop({ stopId: 's2', scope: 'STOREFRONT', channelAccountId: ACC, marketplace: 'ATVPDKIKX0DER' })]), [], m).headline;
    assert.equal(tenant.tone, 'stop', `${l}: stopped`);
    assert.ok(tenant.text.startsWith(h.stopped(m.ui.stop.wholeTenant, m.values.MANAGER, m.when('2026-11-17T09:12:00.000Z'), 'Supplier price talks')), `${l}: the whole workspace first, who, when, the note — ${tenant.text}`);
    assert.ok(tenant.text.endsWith(h.more(1)), `${l}: one more stop — ${tenant.text}`);
    const system = stopView(world([], [halt]), [], m).headline;
    assert.deepEqual(system, { tone: 'warn', text: `${h.running} · ${h.halts(1)}` }, `${l}: a system halt next to running`);
  }
});

test('step 157 (#28): the system sections are one line while there is nothing of them — no active and no released halts or distrusts', () => {
  const m = messagesFor('en');
  assert.equal(stopView(world(), [], m).systemQuiet, true);
  assert.equal(stopView(world([], [{ ...halt, releasedAt: NOW, releasedKind: 'AUTO' }]), [], m).systemQuiet, false, 'a released halt keeps its history visible');
});
