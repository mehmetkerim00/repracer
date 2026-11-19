import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionCause } from '@repracer/pricing-pipeline/store';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { overviewView, type OverviewInput } from './overview.ts';

/**
 * Шаг 171 (#34, ярус 2): Daily Overview — четыре вопроса из сохранённого. Причина решения — одна, первая подошедшая по порядку правил;
 * карточки — числа и ссылки в выборки того же окна. Данные синтетические
 */

const en = messagesFor('en');
const row = (over: Record<string, unknown> = {}) => ({ outcome: 'NO_CHANGE', noChangeReason: null, rejectionReason: null, ruleCode: 'BEAT_LOWEST', trigger: 'SCHEDULE',
  finalMinor: null, effectiveFloorMinor: 1200, strategyId: 's-1', strategyVersion: 1, ...over });
const same = { strategyId: 's-1', strategyVersion: 1 };

test('step 171 (#34): the cause of a decision — the first matching rule over its stored fields, nothing guessed', () => {
  assert.equal(decisionCause(row({ outcome: 'HELD', noChangeReason: 'COST_INPUTS_MISSING' }) as never, same), 'STOPS', 'a pause wins');
  assert.equal(decisionCause(row({ noChangeReason: 'COST_INPUTS_MISSING', trigger: 'COMPETITOR_CHANGE' }) as never, same), 'DATA_QUALITY');
  assert.equal(decisionCause(row({ outcome: 'APPROVED', finalMinor: 1200, trigger: 'COMPETITOR_CHANGE' }) as never, same), 'FLOOR_HOLDS', 'approved exactly at the floor');
  assert.equal(decisionCause(row({ outcome: 'REJECTED', rejectionReason: 'BELOW_MARGIN_FLOOR' }) as never, same), 'FLOOR_HOLDS');
  assert.equal(decisionCause(row({ outcome: 'REJECTED', rejectionReason: 'ABOVE_MAX_PRICE' }) as never, same), 'OTHER', 'a ceiling is not a floor');
  assert.equal(decisionCause(row({ ruleCode: 'FLOOR_RAISE', trigger: 'COST_CHANGE' }) as never, same), 'FLOOR_HOLDS', 'a raise to the floor');
  assert.equal(decisionCause(row({ trigger: 'COMPETITOR_CHANGE', strategyVersion: 2 }) as never, same), 'STRATEGY_CHANGE', 'another version than the decision before');
  assert.equal(decisionCause(row({ trigger: 'COMPETITOR_CHANGE' }) as never, null), 'COMPETITORS', 'the first decision of an offer is not a strategy change');
  assert.equal(decisionCause(row({ trigger: 'COST_CHANGE' }) as never, same), 'COST_CHANGE');
  assert.equal(decisionCause(row({ outcome: 'APPROVED', finalMinor: 1300 }) as never, same), 'OTHER');
});

const status = {
  worldId: 'w',
  mode: { kind: 'SHADOW', text: 'Shadow mode — prices are not sent', tone: 'warn', target: ['shadow'] },
  stops: { count: 0, text: 'No active stops', tone: 'off', target: ['stop'] },
  freshness: [{ channelAccountId: 'a', account: 'amazon.com', text: 'amazon.com · oldest reading 2 h 5 min', level: 'STALE', levelText: 'stale', tone: 'stop', target: ['channels'] }],
  attention: { count: 2, text: '2 offers need attention', tone: 'warn', target: ['products', 'attention', 'ANY'],
    reasons: [{ code: 'NO_UNIT_COST', count: 2, text: '2 no unit cost or fees', target: ['products', 'attention', 'NO_UNIT_COST'] }] },
};
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  worldId: 'w', period: { preset: '24h' }, status: status as never,
  causes: [{ cause: 'COMPETITORS', decisions: 40, offers: 12 }, { cause: 'FLOOR_HOLDS', decisions: 3, offers: 2 }],
  dangerous: 1, money: { CLEARANCE: 1, BELOW_BREAK_EVEN: 0 }, ...over,
});

test('step 171 (#34): four questions — working from the status line, causes with decisions and offers, risk, action with money', () => {
  const v = overviewView(input(), en);
  assert.deepEqual(v.working.map((x) => x.target), [['shadow'], ['stop'], ['channels']], 'the status line parts with their links');
  assert.deepEqual(v.changed.groups.map((g) => [g.cause, g.text, g.target]), [
    ['FLOOR_HOLDS', en.ui.overview.counted(3, 2), ['feed', 'decisions', 'period=24h', 'FLOOR_HOLDS']],
    ['COMPETITORS', en.ui.overview.counted(40, 12), ['feed', 'decisions', 'period=24h', 'COMPETITORS']],
  ], 'in the order of the rules, each opening the journal of the same window and cause');
  assert.equal(v.changed.lead, en.ui.overview.changedShadow(en.ui.period.phrase['24h']), 'in shadow: nothing was sent');
  assert.deepEqual(v.risk.items.map((x) => x.target), [['protections', 'rules', 'period=24h'], ['channels']]);
  assert.deepEqual(v.action.items.map((x) => x.target), [['products', 'attention', 'NO_UNIT_COST'], ['products', 'filter', 'money=CLEARANCE']]);
  assert.equal(v.action.items[1]!.text, en.ui.overview.money.CLEARANCE(1));
  assert.deepEqual([v.layout, v.liveNote, v.windowText], ['SHADOW', null, en.ui.overview.window(en.ui.period.phrase['24h'])]);
});

test('step 171 (#34): empty cards say so; a live workspace gets the note that its layout is not built yet', () => {
  const quiet = { ...status, freshness: [], attention: { ...status.attention, count: 0, reasons: [] }, mode: { ...status.mode, kind: 'SENDING' } };
  const v = overviewView(input({ status: quiet as never, causes: [], dangerous: 0, money: { CLEARANCE: 0, BELOW_BREAK_EVEN: 0 } }), en);
  assert.deepEqual([v.changed.empty, v.risk.empty, v.action.empty], [en.ui.overview.noChanges(en.ui.period.phrase['24h']), en.ui.overview.noRisk(en.ui.period.phrase['24h']), en.ui.overview.noAction]);
  assert.deepEqual([v.layout, v.liveNote], ['LIVE', en.ui.overview.liveNote]);
});

test('step 171 (#34): the texts in every language', () => {
  for (const locale of LOCALES) {
    const m = messagesFor(locale);
    const t = m.ui.overview;
    for (const text of [...Object.values(t.questions), t.window('x'), t.windowNote, t.liveNote, t.changedShadow('x'), t.changedLive('x'), t.counted(1, 2), ...Object.values(t.causes),
      t.noChanges('x'), t.risk.dangerous(2), t.risk.stale('x'), t.noRisk('x'), t.money.CLEARANCE(1), t.money.BELOW_BREAK_EVEN(2), t.noAction, m.ui.app.screens.overview, m.ui.app.subtitles.overview,
      m.ui.products.filters.money, ...Object.values(m.ui.products.filters.moneyValues), m.ui.feed.cause.label, m.ui.feed.cause.all]) {
      assert.ok(typeof text === 'string' && text.trim() !== '' && !/undefined|NaN/.test(text), `${locale}: ${text}`);
    }
  }
});

test('step 172 (#34): the window since the last visit — the phrase, the note and every link carry the same moment', async () => {
  const { parsePeriod, periodRange, periodSearch } = await import('./period.ts');
  const since = '2026-11-18T08:52:00.000Z';
  assert.deepEqual(parsePeriod(new URLSearchParams(`since=${since}`)), { since });
  for (const bad of ['since=2026-11-18', `since=${since}&period=24h`, 'since=2026-13-01T00:00:00.000Z']) assert.equal(parsePeriod(new URLSearchParams(bad)), null, bad);
  assert.equal(periodSearch({ since }), `since=${since}`);
  assert.deepEqual(periodRange({ since }, '2026-11-18T12:00:00.000Z', 'UTC', 30), { since, until: '2026-11-18T12:00:00.000Z', clipped: false, maxDays: 30 });
  const v = overviewView(input({ period: { since } }), en);
  assert.equal(v.windowNote, en.ui.overview.windowSinceNote);
  assert.equal(v.windowText, en.ui.overview.window(en.ui.period.since(en.when(since))));
  assert.deepEqual(v.changed.groups.map((g) => g.target[2]), [`since=${since}`, `since=${since}`], 'the journal of the same window');
  assert.equal(overviewView(input(), en).windowNote, en.ui.overview.windowNote, 'no earlier visit — the honest 24 hours');
});
