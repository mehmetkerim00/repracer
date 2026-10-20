import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DefaultStrategyRow } from '@repracer/pricing-pipeline';
import { defaultStrategyView, type DefaultStrategyInput } from './connections.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { notAssignedText } from './products.ts';
import { assignedByDefaultRule } from './strategies.ts';

/**
 * Шаг 103 [Р-228] на модели экранов (данные синтетические): карточка аккаунта называет умолчание одной строкой с автором и что правило
 * сделало; в выборе — «None» первой и активные стратегии, недоступная на канале — с причиной словами и не выбирается [Р-39]; Offers —
 * честное «not assigned: …»; «by default rule» — только пока нынешнюю стратегию назначило правило
 */

const row = (over: Partial<DefaultStrategyRow> = {}): DefaultStrategyRow => ({
  channelAccountId: 'acc-1', strategyId: 'st-beat', strategyName: 'Beat the lowest by 1 cent', setAt: '2026-10-20T09:30:00.000Z',
  setByMembershipId: 'mb-1', setByName: null, setByEmail: 'alex@example.test', assigned: 2, notAssigned: [{ reason: 'CHANNEL_PRICING', count: 1 }], ...over,
});
const input = (rows: DefaultStrategyRow[]): DefaultStrategyInput => ({
  rows, canEdit: true, people: { 'alex@example.test': 'Alex Porter' },
  strategies: [
    { strategyId: 'st-beat', name: 'Beat the lowest by 1 cent', params: { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' } as never },
    { strategyId: 'st-win', name: 'Win the Buy Box', params: { type: 'WIN_BUYBOX', creepUp: false, creepStepBp: 100, atBound: 'CAP' } as never },
  ],
  // Amazon не называет держателя Buy Box (A-29): «Win the Buy Box» недоступна — как у превью; служебные коды источника в причину не идут
  availability: (_channel, params) => (params.type === 'WIN_BUYBOX'
    ? { available: false, unmet: { AMAZON_ANY_OFFER_CHANGED: ['BUYBOX_WINNER'], AMAZON_COMPETITIVE_SUMMARY: ['RECONCILIATION_ONLY', 'BUYBOX_WINNER'] } }
    : { available: true }),
});
const account = { channelAccountId: 'acc-1', channel: 'AMAZON' };

test('step 103 [Р-228, Р-39]: the account card says the default in one line with who set it, what the rule did, and offers only what the channel allows', () => {
  const en = messagesFor('en', { timeZone: 'America/New_York' });
  const v = defaultStrategyView(account, input([row()]), en);
  assert.match(v.line, /^Default strategy for new offers: Beat the lowest by 1 cent · set by Alex Porter, Oct 20, 2026, 05:30 /);
  assert.equal(v.results, 'Assigned to 2 new offers so far · not assigned to 1: the channel prices the offer itself');
  assert.equal(JSON.stringify(v.options.map((o) => [o.strategyId, o.disabled, o.label])), JSON.stringify([
    [null, false, 'None — assign manually'],
    ['st-beat', false, 'Beat the lowest by 1 cent'],
    ['st-win', true, 'Win the Buy Box — not available on this channel: needs the Buy Box winner'],
  ]));
  assert.equal(v.current, 'st-beat');
  // «None» — поведение до шага: строка говорит это, и «что сделало правило» не выдумывается
  const none = defaultStrategyView(account, input([row({ strategyId: null, strategyName: null, assigned: 0, notAssigned: [] })]), en);
  assert.equal(JSON.stringify([none.line.startsWith('Default strategy for new offers: None — assign manually · set by Alex Porter'), none.results, none.current]),
    JSON.stringify([true, null, null]));
  // Умолчания не задавали никогда — «None» без автора
  assert.equal(defaultStrategyView(account, input([]), en).line, 'Default strategy for new offers: None — assign manually');
  // Только что заданное умолчание: новичков ещё не было — ноль, а не пустота
  assert.equal(defaultStrategyView(account, input([row({ assigned: 0, notAssigned: [] })]), en).results, 'Assigned to 0 new offers so far');
});

test('step 103 [Р-223]: the default strategy texts exist in every language and ES/FR are not English', () => {
  const lines = Object.fromEntries(LOCALES.map((l) => [l, defaultStrategyView(account, input([row()]), messagesFor(l))]));
  for (const l of ['es', 'fr'] as const) {
    assert.notEqual(lines[l]!.line.split(':')[0], lines.en!.line.split(':')[0], `${l}: the line is translated`);
    assert.notEqual(lines[l]!.hint, lines.en!.hint, `${l}: the hint is translated`);
    assert.notEqual(lines[l]!.options[0]!.label, lines.en!.options[0]!.label, `${l}: «None» is translated`);
  }
});

test('step 103 [Р-228, Р-120]: an offer the default rule did not assign says why on Offers; «by default rule» holds only while the rule\'s strategy stays', () => {
  const en = messagesFor('en');
  const notAssigned = { outcome: 'NOT_ASSIGNED', reason: 'CHANNEL_PRICING' };
  assert.equal(notAssignedText({ strategy: null, assignment: notAssigned }, en), 'Not assigned: the channel prices the offer itself');
  assert.equal(notAssignedText({ strategy: null, assignment: { outcome: 'NOT_ASSIGNED', reason: 'NOT_WRITABLE' } }, en),
    'Not assigned: we cannot send prices to the eBay listing (auction or not migrated)');
  // Человек назначил стратегию после правила — пометки нет; без строки журнала — тоже
  assert.equal(notAssignedText({ strategy: { strategyId: 's', version: 1, params: { type: 'FIXED', priceMinor: 100 }, deadbandMinor: 0 }, assignment: notAssigned }, en), null);
  assert.equal(notAssignedText({ strategy: null, assignment: null }, en), null);
  const scope = (assignment: unknown, version = 2) => ({ strategy: { strategyId: 'st-beat', version, params: { type: 'FIXED', priceMinor: 100 }, deadbandMinor: 0 }, assignment }) as never;
  const byRule = { outcome: 'ASSIGNED', source: 'DEFAULT_RULE', strategyId: 'st-beat', version: 2 };
  assert.equal(JSON.stringify([
    assignedByDefaultRule(scope(byRule)),
    assignedByDefaultRule(scope({ ...byRule, source: 'PERSON' })),
    assignedByDefaultRule(scope(byRule, 3)),
    assignedByDefaultRule(scope(null)),
  ]), JSON.stringify([true, false, false, false]));
});
