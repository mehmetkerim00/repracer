import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { readinessView, type ReadinessInput } from './readiness.ts';

/**
 * Шаг 170 (#35, решение владельца): чеклист готовности к бою. «Нельзя» — то, на чём откажет страж перевода (закрытая база, доступ,
 * неизвестное свойство витрины, рамки Amazon включённых предложений — число стража); «не стоит» — советы со своими выборками Offers.
 * Данные синтетические
 */

const en = messagesFor('en');
const US = 'ATVPDKIKX0DER';
const account = { channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: [US], authStatus: 'ACTIVE', writeMode: 'SHADOW' as const, otherTools: 'NONE' };
const storefront = (over: Record<string, number> = {}) => ({ channelAccountId: 'acc-1', marketplace: US, offers: 12, off: 0, noUnitCost: 0, noStrategy: 0, noBounds: 0, automatedPricing: 0, boundsUnreadOn: 0, ...over });
const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  worldId: 'w', now: '2026-11-18T12:00:00.000Z', accounts: [account], facts: { storefronts: [storefront()], blockingBounds: [] }, properties: [],
  liveWritesRefused: false, freshness: [{ channelAccountId: 'acc-1', counted: 12, unread: 0, oldestAt: '2026-11-18T11:58:00.000Z' }], viewer: null, ...over,
});
const only = (over: Partial<ReadinessInput> = {}) => readinessView(input(over), en).accounts[0]!;
const decode = (target: string[]) => Object.fromEntries(new URLSearchParams(target[2]!));

test('step 170 (#35): a clean account — nothing stops the switch, nothing to fix, every check named as fine', () => {
  const a = only();
  assert.deepEqual([a.blocks.length, a.advice.length, a.canSwitch, a.headline], [0, 0, true, en.ui.readiness.headline.ready]);
  for (const check of ['access to the channel', 'unit cost and fees', 'strategies', 'minimum and maximum prices', 'no other tool changes prices', 'competitor data is fresh']) {
    assert.ok(a.fine?.includes(check), `${check}: ${a.fine}`);
  }
});

test('step 170 (#35): the switch refusals are «stops the switch» — the guard number of unread bounds, unknown storefront properties, access; the button is off', () => {
  const a = only({
    facts: { storefronts: [storefront({ boundsUnreadOn: 2 })], blockingBounds: [{ channelAccountId: 'acc-1', total: 2 }] },
    properties: [{ channel: 'AMAZON', marketplace: US, country: 'US', property: 'DAY_BOUNDARY', value: null, status: 'UNKNOWN', question: 'A-03', closesBy: 'SHADOW_READ', source: 'synthetic' }] as never,
    accounts: [{ ...account, authStatus: 'REVOKED' }],
  });
  assert.deepEqual(a.blocks.map((x) => x.code), ['NO_ACCESS', 'PROPERTY_UNKNOWN', 'BOUNDS_UNREAD']);
  assert.equal(a.canSwitch, false);
  assert.equal(a.blocks[2]!.text, en.ui.readiness.items.boundsUnread(2));
  assert.deepEqual(decode(a.blocks[2]!.links[0]!.target), { storefront: `acc-1|${US}`, pricing: 'ON', attention: 'CHANNEL_BOUNDS' }, 'the Offers selection of the same offers');
  assert.match(a.blocks[1]!.text, /amazon\.com · /, 'the storefront in words, not its id');
  assert.deepEqual(a.blocks[1]!.links[0]!.target, ['shadow', 'properties'], 'the store checks of the same screen, opened');
  const ebay = readinessView(input({ accounts: [{ ...account, channel: 'EBAY', marketplaces: ['EBAY_US'] }], facts: { storefronts: [{ ...storefront(), marketplace: 'EBAY_US' }], blockingBounds: [] } }), en).accounts[0]!;
  assert.ok(!/Amazon/.test(ebay.fine ?? ''), `no Amazon checks are «fine» on eBay: ${ebay.fine}`);
  assert.equal(a.headline, en.ui.readiness.headline.blocks(3));
});

test('step 170 (#35): advice does not stop the switch — every item opens its Offers selection with the same number', () => {
  const a = only({ facts: { storefronts: [storefront({ off: 3, noUnitCost: 2, noStrategy: 1, noBounds: 1, automatedPricing: 1 })], blockingBounds: [] },
    accounts: [{ ...account, otherTools: 'STOCK_AND_PRICES' }],
    freshness: [{ channelAccountId: 'acc-1', counted: 12, unread: 4, oldestAt: null }] });
  assert.equal(a.canSwitch, true, 'advice never stops the switch');
  assert.deepEqual(a.advice.map((x) => x.code), ['OFFERS_OFF', 'NO_UNIT_COST', 'NO_STRATEGY', 'NO_BOUNDS', 'AUTOMATED_PRICING', 'OTHER_TOOL', 'STALE_DATA']);
  assert.deepEqual(a.advice.slice(0, 5).map((x) => decode(x.links[0]!.target)), [
    { storefront: `acc-1|${US}`, pricing: 'OFF' }, { storefront: `acc-1|${US}`, attention: 'NO_UNIT_COST' }, { storefront: `acc-1|${US}`, setup: 'NO_STRATEGY' },
    { storefront: `acc-1|${US}`, setup: 'NO_BOUNDS' }, { storefront: `acc-1|${US}`, attention: 'AUTOMATED_PRICING' },
  ]);
  assert.equal(a.advice[0]!.text, en.ui.readiness.items.offersOff(3, 12));
  assert.deepEqual(a.advice.slice(5).map((x) => x.links[0]!.target), [['channels', 'accounts'], ['channels']]);
  assert.equal(only({ accounts: [{ ...account, otherTools: null }] }).advice[0]!.code, 'OTHER_TOOL_UNANSWERED');
  assert.ok(!(only({ accounts: [{ ...account, otherTools: undefined }] }).fine ?? '').includes('no other tool'), 'without the connections the screen says nothing about other tools');
});

test('step 170 (#35): an account of two storefronts links each storefront with its own number; a live account is marked live', () => {
  const de = 'A1PA6795UKMFR9';
  const a = only({ accounts: [{ ...account, marketplaces: [US, de] }], facts: { storefronts: [storefront({ noUnitCost: 2 }), { ...storefront({ noUnitCost: 1 }), marketplace: de }], blockingBounds: [] } });
  const item = a.advice.find((x) => x.code === 'NO_UNIT_COST')!;
  assert.equal(item.text, en.ui.readiness.items.noUnitCost(3));
  assert.deepEqual(item.links.map((l) => l.label), ['amazon.com: 2', 'amazon.de: 1']);
  assert.equal(readinessView(input({ accounts: [{ ...account, writeMode: 'LIVE' }] }), en).accounts[0]!.writeMode, 'LIVE', 'a live account is computed alike; the screen shows the checklist only in shadow');
  assert.deepEqual([item.count, item.links.map((l) => l.count)], [3, [2, 1]]);
});

test('step 170 (#35): the switch moment adds the person — no right, no second factor; a QA database is the only reason', () => {
  assert.deepEqual(only({ viewer: { canSwitch: false, secondFactor: false } }).blocks.map((x) => x.code), ['ROLE']);
  assert.deepEqual(only({ viewer: { canSwitch: true, secondFactor: false } }).blocks.map((x) => x.code), ['SECOND_FACTOR']);
  const qa = only({ liveWritesRefused: true, accounts: [{ ...account, authStatus: 'REVOKED' }], facts: { storefronts: [storefront()], blockingBounds: [{ channelAccountId: 'acc-1', total: 1 }] } });
  assert.deepEqual([qa.blocks.map((x) => x.code), qa.fine], [['LIVE_WRITES_FORBIDDEN'], null]);
});

test('step 170 (#35): the texts in every language', () => {
  for (const locale of LOCALES) {
    const m = messagesFor(locale);
    const t = m.ui.readiness;
    for (const text of [t.title, t.headline.blocks(2), t.headline.advice(1), t.headline.ready, t.blocksTitle, t.adviceTitle, t.fine('x'), t.storefrontCount('x', 2), ...Object.values(t.checks),
      t.items.liveWritesForbidden, t.items.revoked, t.items.noAccess, t.items.propertyUnknown('x'), t.items.boundsUnread(1), t.items.offersOff(1, 2), t.items.noUnitCost(2), t.items.noStrategy(1), t.items.noBounds(2),
      t.items.automatedPricing(1), t.badge.blocks, t.badge.advice, t.badge.ready, t.switchBlocked, t.items.otherTool, t.items.otherToolUnanswered, t.items.staleData('x'), m.ui.products.filters.setup, ...Object.values(m.ui.products.filters.setupValues)]) {
      assert.ok(typeof text === 'string' && text.trim() !== '' && !/undefined|NaN/.test(text), `${locale}: ${text}`);
    }
  }
});
