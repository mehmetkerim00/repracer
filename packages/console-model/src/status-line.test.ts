import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { ATTENTION_REASONS, attentionCounts, attentionReasons, freshnessLevel, statusLineView, type AttentionCounts, type StatusLineInput } from './status-line.ts';

/**
 * Шаг 146 (#34, ярус 1): строка состояния продавца на модели экранов (данные синтетические). Четыре части: режим цен, действующие остановки,
 * свежесть данных конкурентов по аккаунту, «требует внимания» по причинам. Каждое число ведёт ровно в ту выборку, из которой посчитано
 */

const en = messagesFor('en');
const NOW = '2026-11-17T12:00:00.000Z';
const NONE: AttentionCounts = { any: 0, byReason: { NO_UNIT_COST: 0, AUTOMATED_PRICING: 0, CHANNEL_BOUNDS: 0, NOT_BUYABLE: 0, TURNED_OFF: 0 } };
const acc = (id: string, writeMode: 'SHADOW' | 'LIVE', authStatus = 'ACTIVE', marketplaces = ['ATVPDKIKX0DER'], channel = 'AMAZON') => ({ channelAccountId: id, channel, marketplaces, authStatus, writeMode });
const input = (over: Partial<StatusLineInput> = {}): StatusLineInput => ({
  worldId: 'w', now: NOW, accounts: [acc('a1', 'SHADOW')], tenantStop: null, activeStops: 0, freshness: [], attention: NONE, ...over,
});
const ago = (seconds: number) => new Date(Date.parse(NOW) - seconds * 1000).toISOString();

test('step 146: the pricing state — stopped by a person, shadow, sending, mixed, nothing connected; each links to the screen that lists it', () => {
  const kinds = (i: StatusLineInput) => { const v = statusLineView(i, en).mode; return [v.kind, v.text, v.tone, v.target.join('/')]; };
  assert.deepEqual(kinds(input({ accounts: [] })), ['NONE', 'No channel account connected', 'off', 'channels']);
  // Аккаунт без доступа — не подключён: он ничего не отправляет и не решает
  assert.deepEqual(kinds(input({ accounts: [acc('a1', 'LIVE', 'AWAITING_ACCESS')] })), ['NONE', 'No channel account connected', 'off', 'channels']);
  assert.deepEqual(kinds(input({ accounts: [acc('a1', 'SHADOW'), acc('a2', 'SHADOW')] })), ['SHADOW', 'Shadow mode — prices are not sent', 'warn', 'shadow']);
  assert.deepEqual(kinds(input({ accounts: [acc('a1', 'LIVE')] })), ['SENDING', 'Sending prices', 'ok', 'channels']);
  assert.deepEqual(kinds(input({ accounts: [acc('a1', 'LIVE'), acc('a2', 'SHADOW'), acc('a3', 'SHADOW')] })),
    ['MIXED', 'Sending on 1 of 3 channel accounts; 2 in shadow mode', 'warn', 'channels']);
  // Остановка человеком всего пространства важнее режима аккаунтов: цены не уходят ни у кого
  const stopped = statusLineView(input({ accounts: [acc('a1', 'LIVE')], tenantStop: { by: 'Jamie Lee', stoppedAt: '2026-11-17T09:12:00.000Z' } }), en).mode;
  assert.deepEqual([stopped.kind, stopped.tone, stopped.target.join('/')], ['STOPPED', 'stop', 'stop']);
  assert.match(stopped.text, /^Repricing stopped by Jamie Lee since Nov 17, 2026, 09:12/);
});

test('step 146: active stops — the count of the three kinds Stop pricing lists as active, or a quiet «no active stops»', () => {
  const zero = statusLineView(input(), en).stops;
  assert.deepEqual([zero.count, zero.text, zero.tone, zero.target.join('/')], [0, 'No active stops', 'off', 'stop']);
  const one = statusLineView(input({ activeStops: 1 }), en).stops;
  assert.deepEqual([one.text, one.tone], ['1 active stop', 'stop']);
  assert.equal(statusLineView(input({ activeStops: 3 }), en).stops.text, '3 active stops');
});

test('step 146: data freshness — fresh up to 15 minutes, ageing up to an hour, then stale; an offer with no reading is stale; accounts without such offers are not shown', () => {
  assert.deepEqual([freshnessLevel(0, 0), freshnessLevel(900, 0), freshnessLevel(901, 0), freshnessLevel(3600, 0), freshnessLevel(3601, 0), freshnessLevel(60, 1), freshnessLevel(null, 2)],
    ['FRESH', 'FRESH', 'AGEING', 'AGEING', 'STALE', 'STALE', 'STALE']);
  const v = statusLineView(input({
    accounts: [acc('a1', 'SHADOW'), acc('a2', 'SHADOW', 'ACTIVE', ['WALMART_US'], 'WALMART'), acc('a3', 'SHADOW', 'ACTIVE', ['EBAY_US'], 'EBAY')],
    freshness: [
      { channelAccountId: 'a1', counted: 12, unread: 0, oldestAt: ago(4 * 60) },
      { channelAccountId: 'a2', counted: 5, unread: 3, oldestAt: ago(2 * 3600) },
      { channelAccountId: 'a3', counted: 0, unread: 0, oldestAt: null },
    ],
  }), en).freshness;
  assert.deepEqual(v.map((f) => [f.account, f.text, f.level, f.levelText, f.tone, f.target.join('/')]), [
    ['amazon.com', 'amazon.com · oldest reading 4 min', 'FRESH', 'fresh', 'ok', 'channels'],
    ['walmart.com', 'walmart.com · 3 offers not read yet', 'STALE', 'stale', 'stop', 'channels'],
  ]);
  const hours = statusLineView(input({ freshness: [{ channelAccountId: 'a1', counted: 1, unread: 0, oldestAt: ago(2 * 3600 + 120) }] }), en).freshness[0]!;
  assert.deepEqual([hours.text, hours.level], ['amazon.com · oldest reading 2 h 2 min', 'STALE']);
  const ageing = statusLineView(input({ freshness: [{ channelAccountId: 'a1', counted: 1, unread: 0, oldestAt: ago(26 * 60) }] }), en).freshness[0]!;
  assert.deepEqual([ageing.text, ageing.level, ageing.tone], ['amazon.com · oldest reading 26 min', 'AGEING', 'warn']);
});

test('step 146: «needs attention» — offers with at least one reason, every reason with its count and its own filtered list; zero says so quietly', () => {
  const zero = statusLineView(input(), en).attention;
  assert.deepEqual([zero.count, zero.text, zero.tone, zero.reasons.length], [0, 'Nothing needs attention', 'off', 0]);
  const a = statusLineView(input({ attention: { any: 5, byReason: { NO_UNIT_COST: 2, AUTOMATED_PRICING: 0, CHANNEL_BOUNDS: 2, NOT_BUYABLE: 1, TURNED_OFF: 0 } } }), en).attention;
  assert.deepEqual([a.count, a.text, a.tone, a.target.join('/')], [5, '5 offers need attention', 'warn', 'products/attention/ANY']);
  assert.deepEqual(a.reasons.map((r) => [r.code, r.count, r.text, r.target.join('/')]), [
    ['NO_UNIT_COST', 2, '2 no unit cost or fees', 'products/attention/NO_UNIT_COST'],
    ['CHANNEL_BOUNDS', 2, '2 Amazon bounds not read', 'products/attention/CHANNEL_BOUNDS'],
    ['NOT_BUYABLE', 1, '1 not buyable', 'products/attention/NOT_BUYABLE'],
  ]);
  assert.equal(statusLineView(input({ attention: { any: 1, byReason: { ...NONE.byReason, TURNED_OFF: 1 } } }), en).attention.text, '1 offer needs attention');
});

test('step 146: every text of the status line exists in every language', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const v = statusLineView(input({
      accounts: [acc('a1', 'LIVE'), acc('a2', 'SHADOW')], activeStops: 2, freshness: [{ channelAccountId: 'a1', counted: 3, unread: 1, oldestAt: ago(30) }],
      attention: { any: 5, byReason: { NO_UNIT_COST: 1, AUTOMATED_PRICING: 1, CHANNEL_BOUNDS: 1, NOT_BUYABLE: 1, TURNED_OFF: 1 } },
    }), m);
    const texts = [v.mode.text, v.stops.text, ...v.freshness.flatMap((f) => [f.text, f.levelText]), v.attention.text, ...v.attention.reasons.map((r) => r.text), m.ui.statusLine.label, m.ui.statusLine.unavailable];
    for (const t of texts) assert.ok(typeof t === 'string' && t.trim() !== '' && !t.includes('undefined'), `${l}: ${t}`);
    assert.equal(v.attention.reasons.length, ATTENTION_REASONS.length, l);
    for (const r of ATTENTION_REASONS) assert.ok(m.ui.statusLine.reasonNames[r].trim() !== '', `${l}: ${r}`);
  }
});

/** Правило экрана без базы: причины одного предложения — те же наблюдения, что пилюли Offers (`channelNotes`), себестоимость и выключение */
test('step 146: the reasons of one offer on the screen rule — unit cost, Amazon repricer, unread bounds, not buyable (Amazon or Walmart), turned off by a person', () => {
  const SEEN = '2026-11-17T10:00:00.000Z';
  const scope = (id: string, over: Record<string, unknown> = {}) => ({
    writeScopeId: id, productId: `p-${id}`, channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: `SKU-${id}`, channelProductRef: `REF-${id}`,
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', productTitle: `Offer ${id}`, productSku: `SKU-${id}`,
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1500, minMarginBp: null, cost: { unitCostMinor: 500 }, declaredCost: null, clearance: null, strategy: null,
    bounds: { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: [] }, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: [] } },
    feeEstimates: [], fees: [], pricingSwitch: null, ...over,
  });
  const scopes = [
    scope('ok'),
    scope('cost', { cost: null }),
    scope('repricer'),
    scope('bounds'),
    scope('listing'),
    scope('walmart', { channelAccountId: 'acc-w', marketplace: 'WALMART_US' }),
    scope('off', { pricingMode: 'OFF', pricingSwitch: { action: 'OFF', at: SEEN, membershipId: 'mb', note: null, byName: 'Jamie Lee', byEmail: null } }),
    // Выключено, но никто его не выключал (не включали) — это не «turned off»
    scope('never', { pricingMode: 'OFF' }),
  ];
  const w = {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }, { channelAccountId: 'acc-w', channel: 'WALMART', marketplaces: ['WALMART_US'] }],
    state: {
      scopes, writes: [], strategies: [], explanationRulesets: [], fxRates: [], members: [], divergenceCases: [], halts: [],
      offerChannelPricing: [
        { channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalSku: 'SKU-repricer', automatedPricing: true, channelBounds: false, source: 'DISCOVERY', observedAt: SEEN },
        { channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalSku: 'SKU-bounds', automatedPricing: false, channelBounds: true, source: 'DISCOVERY', observedAt: SEEN, accountLive: false },
      ],
      pricingHealth: [{ channelAccountId: 'acc-w', marketplace: 'WALMART_US', channelProductRef: 'REF-walmart', condition: 'new', issueType: 'WALMART_UNPUBLISHED_UNCOMPETITIVE_PRICE', occurredAt: SEEN, competitivePriceThreshold: null }],
      listingStatus: [{ channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalSku: 'SKU-listing', buyable: false, deleted: false, source: 'NOTIFICATION', observedAt: SEEN, enforcementActions: null }],
    },
  } as never;
  const reasons = Object.fromEntries((scopes as Array<{ writeScopeId: string }>).map((s) => [s.writeScopeId, attentionReasons(w, s as never, en)]));
  assert.deepEqual(reasons, {
    ok: [], cost: ['NO_UNIT_COST'], repricer: ['AUTOMATED_PRICING'], bounds: ['CHANNEL_BOUNDS'], listing: ['NOT_BUYABLE'], walmart: ['NOT_BUYABLE'], off: ['TURNED_OFF'], never: [],
  });
  assert.deepEqual(attentionCounts(w, en), { any: 6, byReason: { NO_UNIT_COST: 1, AUTOMATED_PRICING: 1, CHANNEL_BOUNDS: 1, NOT_BUYABLE: 2, TURNED_OFF: 1 } });
});
