import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { strategiesView } from './strategies.ts';

/**
 * Шаг 150 (#27, часть 3; Р-254): Strategies таблицей на модели экранов (данные синтетические). У каждой стратегии — цель простыми словами
 * по её типу (следовать рынку, держать маржу, фиксированная цена) с пояснением; последняя версия — первой в списке версий
 */

const en = messagesFor('en');
const NOW = '2026-11-17T12:00:00.000Z';

const PARAMS = {
  FIXED: { type: 'FIXED', priceMinor: 1999 },
  TARGET_MARGIN: { type: 'TARGET_MARGIN', targetMarginBp: 1500, atBound: 'CAP' },
  MATCH_BUYBOX: { type: 'MATCH_BUYBOX', undercutMinor: 0, holdWhenWinning: true, atBound: 'CAP' },
  BEAT_LOWEST: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: true, atBound: 'CAP' },
  WIN_BUYBOX: { type: 'WIN_BUYBOX', undercutMinor: 1, creepUp: false, creepStepBp: 100, atBound: 'CAP' },
} as const;

function world() {
  const strategies = Object.entries(PARAMS).flatMap(([id, params]) => [1, 2].map((version) => ({ strategyId: id, version, params, deadbandMinor: 0 })));
  const strategyVersions = strategies.map((s) => ({
    strategyId: s.strategyId, version: s.version, name: `${s.strategyId} name`, status: s.version === 2 ? 'ACTIVE' : 'ARCHIVED',
    createdAt: s.version === 2 ? '2026-11-16T10:00:00.000Z' : '2026-11-01T10:00:00.000Z', createdByMembershipId: 'mb-owner',
  }));
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: NOW, viewer: { role: 'OWNER', membershipId: 'mb-owner' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
    state: {
      scopes: [], writes: [], strategies, strategyVersions, explanationRulesets: [], fxRates: [], divergenceCases: [], halts: [], stops: [], distrusts: [],
      offerChannelPricing: [], pricingHealth: [], listingStatus: [], members: [{ membershipId: 'mb-owner', role: 'OWNER' }],
    },
  } as never;
}

const byId = (m = en) => new Map(strategiesView(world(), m, true).strategies.map((s) => [s.strategyId, s]));

test('step 150 (#27): every strategy says its goal in plain words — follow the market, protect margin, or a fixed price', () => {
  const s = byId();
  assert.deepEqual(
    ['BEAT_LOWEST', 'MATCH_BUYBOX', 'WIN_BUYBOX', 'TARGET_MARGIN', 'FIXED'].map((id) => s.get(id)!.goal),
    ['FOLLOW_MARKET', 'FOLLOW_MARKET', 'FOLLOW_MARKET', 'PROTECT_MARGIN', 'FIXED_PRICE'],
  );
  assert.deepEqual([s.get('BEAT_LOWEST')!.goalText, s.get('TARGET_MARGIN')!.goalText, s.get('FIXED')!.goalText], ['Follow the market', 'Protect margin', 'Fixed price']);
  for (const l of LOCALES) {
    const m = messagesFor(l);
    for (const item of byId(m).values()) {
      assert.ok(item.goalText.trim() !== '' && item.goalHint.trim() !== '', `${l}: ${item.strategyId} has a goal and its hint`);
    }
  }
});

test('step 150 (#27): the last change is the newest version — first in the list, with its status, author and time', () => {
  const v = byId().get('FIXED')!.versions;
  assert.deepEqual(v.map((x) => [x.version, x.status, x.author]), [[2, 'active', 'you'], [1, 'archived', 'you']]);
  assert.match(v[0]!.createdAt ?? '', /Nov 16, 2026/);
});

test('step 150 (#27): a version without a recorded time has no time — null, not «no value» in the last-change cell', () => {
  const w = world() as unknown as { state: { strategyVersions: Array<{ strategyId: string }> } };
  w.state.strategyVersions = w.state.strategyVersions.filter((x) => x.strategyId !== 'FIXED');
  const v = new Map(strategiesView(w as never, en, true).strategies.map((s) => [s.strategyId, s])).get('FIXED')!.versions;
  assert.deepEqual(v.map((x) => [x.version, x.createdAt]), [[2, null], [1, null]]);
});
