import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  boundsDiffView, dangerousReport, expandBoundsEdit, LOCALES, messagesFor, parseStrategyDraft, priceFeed, strategiesView, strategyPreviewView, type Viewer,
} from '@repracer/console-model';
import { standUserOf } from '@repracer/pricing-pipeline';
import { buildStandWorlds, STAND_USERS, type LiveWorld } from './console/stand.ts';

/**
 * Шаг 21, C: экран стратегий с превью до сохранения, массовая правка границ с экраном различий, лента цен и отчёт об опасных
 * изменениях [Р-73] — на мирах стенда в памяти. Данные синтетические.
 */
let worlds: LiveWorld[] = [];
before(async () => { worlds = await buildStandWorlds(); });

const user = (role: Viewer['role']): Viewer => STAND_USERS.find((u) => u.role === role)!;
const en = messagesFor('en');
const live = (id: string) => { const w = worlds.find((x) => x.id === id); assert.ok(w, id); return w; };
const actor = (role: Viewer['role'], mfa = false) => ({ membershipId: user(role).membershipId, userId: standUserOf(user(role).membershipId), mfa });

test('step 21: strategies, price feed and the dangerous-changes report render in German and English for every world', async () => {
  for (const w of worlds) {
    const world = await w.view(user('OWNER'));
    for (const locale of LOCALES) {
      const m = messagesFor(locale);
      const json = JSON.stringify({ s: strategiesView(world, m, true), f: priceFeed(world, m), d: [1, 7, 30].map((days) => dangerousReport(world, days, m)) });
      for (const bad of ['undefined', 'NaN', '[object Object]', 'Infinity']) assert.ok(!json.includes(bad), `${w.id} ${locale}: "${bad}"`);
    }
  }
});

test('step 21: a strategy draft is previewed on a real offer through the engine and the Gate without committing anything', async () => {
  const w = live('kaufland/pipeline/happy-path');
  const before = await w.view(user('PRICING_MANAGER'));
  const parsed = parseStrategyDraft({ name: 'Undercut ten', params: { type: 'MATCH_BUYBOX', undercutMinor: 10, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 });
  assert.ok(parsed.ok);
  const preview = await w.pipeline.previewStrategy(w.callContext(before.accounts[0]!.channelAccountId), 'ws-price-de-4101', { strategyId: 'draft', version: 1, ...parsed.draft });
  assert.ok(preview);
  const view = strategyPreviewView(before, parsed.draft, [preview], en);
  const [row] = view.rows;
  // Последний принятый снимок мира — мы выигрываем Buy Box по 17.75; итог решает Gate в границах 15.00–25.00
  assert.equal(row!.current, '€17.75');
  assert.ok(row!.asOf.startsWith('snapshot of '), row!.asOf);
  assert.ok(['Approved', 'No change'].includes(row!.outcome), row!.outcome);
  assert.equal(view.previewToken, strategyPreviewView(before, parsed.draft, [preview], en).previewToken, 'the token is deterministic');
  const after = await w.view(user('PRICING_MANAGER'));
  assert.equal(after.state.decisions.length, before.state.decisions.length, 'the preview commits no decision');
  assert.equal(after.state.writes.length, before.state.writes.length, 'the preview sends nothing');

  const bad = parseStrategyDraft({ name: '', params: { type: 'POSITION' }, deadbandMinor: 1.5 });
  assert.deepEqual(bad.ok ? [] : bad.problems.map((p) => `${p.field}:${p.code}`).sort(), ['deadbandMinor:NOT_A_WHOLE_AMOUNT', 'name:REQUIRED', 'type:UNKNOWN_TYPE']);
});

test('step 21: a bounds edit shows the differences first; applying needs the right role, a second factor for more than one offer and fresh data', async () => {
  const w = live('kaufland/pipeline/happy-path');
  const world = await w.view(user('PRICING_MANAGER'));
  const { edits, problems } = expandBoundsEdit(world, { writeScopeIds: ['ws-price-de-4101'], min: { kind: 'SET', minor: 1900 }, max: { kind: 'PERCENT', bp: 1000 } });
  assert.deepEqual(problems, []);
  assert.deepEqual(edits, [{ writeScopeId: 'ws-price-de-4101', expected: { minMinor: 1500, maxMinor: 2500 }, minMinor: 1900, maxMinor: 2750 }]);
  assert.deepEqual(await w.store.editBounds(world.tenantId, edits, actor('OPERATOR'), 'PREVIEW'), { status: 'FORBIDDEN' });
  const preview = await w.store.editBounds(world.tenantId, edits, actor('PRICING_MANAGER'), 'PREVIEW');
  assert.equal(preview.status, 'PREVIEWED');
  if (preview.status !== 'PREVIEWED') return;
  const diff = boundsDiffView(world, edits, preview.rows, en);
  assert.deepEqual([diff.rows[0]!.minBefore, diff.rows[0]!.minAfter, diff.rows[0]!.maxAfter], ['€15.00', '€19.00', '€27.50']);
  assert.deepEqual(diff.rows[0]!.flags.map((f) => f.code), ['PRICE_BELOW_NEW_FLOOR', 'BIG_CHANGE']);
  assert.equal(diff.mfaRequired, false);
  const min = (await w.view(user('OWNER'))).state.scopes.find((s) => s.writeScopeId === 'ws-price-de-4101')!.bounds.min;
  assert.ok(min.status === 'RESOLVED' && min.amountMinor === 1500, 'the preview changed nothing');

  const multi = live('kaufland/pipeline/cold-start-cost-anchor');
  const multiWorld = await multi.view(user('PRICING_MANAGER'));
  const ids = multiWorld.state.scopes.map((s) => s.writeScopeId);
  assert.ok(ids.length > 1);
  const mass = expandBoundsEdit(multiWorld, { writeScopeIds: ids, min: { kind: 'PERCENT', bp: -500 } });
  assert.deepEqual(await multi.store.editBounds(multiWorld.tenantId, mass.edits, actor('PRICING_MANAGER'), 'APPLY'), { status: 'MFA_REQUIRED' });
  assert.equal((await multi.store.editBounds(multiWorld.tenantId, mass.edits, actor('PRICING_MANAGER', true), 'APPLY')).status, 'APPLIED');
  // Экран различий старше данных — применение отказывает
  assert.equal((await multi.store.editBounds(multiWorld.tenantId, mass.edits, actor('PRICING_MANAGER', true), 'APPLY')).status, 'CONFLICT');
});

test('step 21: the price feed shows the write with the price it started from and its source; the report counts dangerous changes by period (Р-73)', async () => {
  const happy = await live('kaufland/pipeline/happy-path').view(user('VIEWER'));
  const feed = priceFeed(happy, en);
  assert.deepEqual(feed.items.map((i) => [i.from, i.to, i.change, i.status, i.source]), [['€18.50', '€17.75', '−4.1%', 'Applied', 'Buy Box']]);
  assert.deepEqual(feed.counts, { applied: 1, inFlight: 0, notSent: 0 });

  const above = await live('kaufland/pipeline/above-max-price').view(user('VIEWER'));
  const report = dangerousReport(above, 30, en);
  // Р-117 (шаг 22): главное число — удержания полом; отклонения Gate — второй раздел
  assert.equal(report.headline, 'The floor did not have to hold a price in the last 30 days');
  assert.equal(report.gateHeadline, 'Your bounds stopped 1 dangerous change in the last 30 days');
  assert.deepEqual(report.prevented, [{ currency: 'EUR', minor: 1330, amount: '€13.30' }]);
  assert.equal(report.worst?.deviation, '53.2%');
  assert.equal(report.truncated, false);
  assert.equal(dangerousReport(above, 90, en).truncated, true);
  assert.equal(dangerousReport(above, 30, messagesFor('de')).gateHeadline, 'Ihre Grenzen haben in den letzten 30 Tagen 1 gefährliche Änderung gestoppt');
});
