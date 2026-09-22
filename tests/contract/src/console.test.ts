import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  boundsView, LOCALES, messagesFor, planStop, productList,
  type HumanReason, type Messages, type StandWorld, type Viewer,
} from '@repracer/console-model';
import { decisionsOf, rejectedOf, stopOf, traceOf } from './console/streams.ts';
import { buildStandWorlds, STAND_USERS, type LiveWorld } from './console/stand.ts';
import { standUserOf } from '@repracer/pricing-pipeline';

/**
 * Р-67, шаг 12: экраны строятся из состояния хранилища (readConsoleState) и слепков объяснения [Р-68], тексты — из словаря
 * DE/EN [Р-72]. Этот тест — на хранилище в памяти; то же на PostgreSQL — console.pg.test.ts.
 */

let worlds: LiveWorld[] = [];
before(async () => {
  worlds = await buildStandWorlds();
});

const user = (role: Viewer['role']): Viewer => STAND_USERS.find((u) => u.role === role)!;
const en = messagesFor('en');
const de = messagesFor('de');

const live = (id: string): LiveWorld => {
  const w = worlds.find((x) => x.id === id);
  assert.ok(w, `world ${id}`);
  return w;
};

// Р-154: потоки экранов — от хранилища (страницей, окном, агрегатом), как у сервера стенда
async function allViews(w: LiveWorld, world: StandWorld, m: Messages) {
  const decisions = await decisionsOf(w.store, world, m);
  return {
    products: productList(world, m),
    decisions,
    traces: await Promise.all(decisions.map((d) => traceOf(w.store, world, d.decisionId, m))),
    rejected: await rejectedOf(w.store, world, m),
    bounds: world.state.scopes.map((s) => boundsView(world, s.writeScopeId, m)),
    stop: await stopOf(w.store, world, m),
  };
}

export function reasonsIn(value: unknown, out: HumanReason[] = []): HumanReason[] {
  if (Array.isArray(value)) value.forEach((v) => reasonsIn(v, out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.code === 'string' && typeof o.text === 'string' && Array.isArray(o.problems)) out.push(o as unknown as HumanReason);
    else Object.values(o).forEach((v) => reasonsIn(v, out));
  }
  return out;
}

test('Р-67, Р-72: every pricing world renders all screens in German and English without invented or empty values', async () => {
  assert.ok(worlds.length >= 20, `stand worlds: ${worlds.length}`);
  for (const w of worlds) {
    assert.deepEqual(w.failures, [], `${w.id}: the scenario itself must pass`);
    const world = await w.view(user('OWNER'));
    for (const locale of LOCALES) {
      const m = messagesFor(locale);
      const views = await allViews(w, world, m);
      assert.equal(views.products.rows.length, world.state.scopes.length);
      assert.ok(views.traces.every((t) => t !== null), `${w.id}: every decision has a trace`);
      assert.ok(views.bounds.every((b) => b !== null));
      const json = JSON.stringify(views);
      for (const bad of ['undefined', 'NaN', '[object Object]', 'Infinity']) assert.ok(!json.includes(bad), `${w.id} ${locale}: "${bad}" on a screen`);
      for (const row of views.products.rows) assert.equal(row.nextCheck.label, m.ui.nextCheck.label, 'no schedule is stored — the cell says so');
    }
  }
});

test('Р-68, Р-74: decisions that change or reject a price carry an explanation; a NO_OP decision keeps only its reason code and says so', async () => {
  let noOps = 0;
  let explained = 0;
  for (const w of worlds) {
    const world = await w.view(user('OWNER'));
    for (const d of (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items) {
      const trace = (await traceOf(w.store, world, d.decisionId, en))!;
      if (d.decisionClass === 'NO_OP') {
        noOps += 1;
        assert.equal(d.explanation ?? null, null, `${w.id}: a NO_OP decision keeps no explanation (Р-74)`);
        assert.ok(d.noChangeReason, `${w.id}: a NO_OP decision keeps its reason code`);
        assert.ok(trace.gaps.some((g) => g.code === 'NO_OP_NOT_EXPLAINED'), `${w.id}: the screen names why the steps are missing`);
        assert.equal(trace.steps.find((s) => s.key === 'STRATEGY')!.summary, `Keep the price: ${(en.titles as Record<string, string>)[d.noChangeReason!]}`);
        continue;
      }
      explained += 1;
      assert.ok(d.explanation, `${w.id}: decision ${d.decisionId} has no explanation`);
      assert.ok(!trace.gaps.some((g) => g.code === 'NO_EXPLANATION' || g.code === 'EXPLANATION_DICTIONARY_MISSING'), `${w.id}: ${JSON.stringify(trace.gaps)}`);
      for (const key of ['STRATEGY', 'GATE'] as const) assert.notEqual(trace.steps.find((s) => s.key === key)?.status, 'UNKNOWN', `${w.id}: ${key}`);
    }
  }
  assert.ok(noOps > 0 && explained > 0, `NO_OP ${noOps}, explained ${explained}`);
});

test('Р-71, Р-72: every reason the stand shows is fully explained in both languages, or its limit is named', async (t) => {
  const codes = new Set<string>();
  const problems: string[] = [];
  for (const w of worlds) {
    const world = await w.view(user('OWNER'));
    for (const locale of LOCALES) {
      for (const r of reasonsIn(await allViews(w, world, messagesFor(locale)))) {
        codes.add(r.code);
        if (r.problems.length > 0) problems.push(`${w.id} ${locale} ${r.code}: ${r.problems.join('; ')} :: ${r.text}`);
      }
    }
  }
  t.diagnostic(`reason codes seen on stand screens: ${codes.size}`);
  assert.deepEqual([...new Set(problems)], []);
  assert.ok(codes.size >= 25);
});

test('B: the happy path decision shows the whole way from snapshot to channel confirmation, in both languages', async () => {
  const w = live('kaufland/pipeline/happy-path');
  const world = await w.view(user('OWNER'));
  const decisions = (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items;
  const approved = decisions.find((d) => d.outcome === 'APPROVED')!;
  const trace = (await traceOf(w.store, world, approved.decisionId, en))!;
  assert.deepEqual(trace.steps.map((s) => s.key), ['SNAPSHOT', 'SANITY', 'ANCHORS', 'STRATEGY', 'GATE', 'WRITE', 'CHANNEL']);
  assert.deepEqual(trace.steps.map((s) => s.status), ['OK', 'OK', 'OK', 'OK', 'OK', 'OK', 'OK']);
  assert.equal(trace.headline, 'The price €17.75 was set and applied by the channel');
  assert.equal((await traceOf(w.store, world, approved.decisionId, de))!.headline, 'Der Preis 17,75 € wurde gesetzt und vom Kanal übernommen');
  const gate = trace.steps.find((s) => s.key === 'GATE')!;
  assert.equal(gate.summary, 'Price €17.75 approved within €15.00–€25.00.');
  assert.ok(['LOWER_BOUND', 'UPPER_BOUND'].every((c) => gate.items.some((i) => i.outcome === 'PASS' && i.label === en.ui.gateChecks[c as 'LOWER_BOUND'])));
  const strategy = trace.steps.find((s) => s.key === 'STRATEGY')!;
  // Buy Box — цена конкурента, данные канала: в вечном слепке её нет [Р-68]
  // Р-85: цель «Buy Box минус подрез» выводит цену конкурента — в слепке её нет, экран так и говорит; предложенная цена — из решения
  assert.match(strategy.summary, /^Proposed €17\.75 \(.+\): Undercut the Buy Box channel value not kept by €0\.05: channel value not kept\.$/);
  assert.ok(trace.gaps.some((g) => g.code === 'CHANNEL_VALUES_WITHHELD'));
  assert.ok(trace.gaps.some((g) => g.code === 'CONFIRMATION_SOURCE'));
  const anchors = trace.steps.find((s) => s.key === 'ANCHORS')!;
  assert.ok(anchors.items.some((i) => i.outcome === 'PASS'), 'at least one anchor was used');
  const noChange = decisions.find((d) => d.outcome === 'NO_CHANGE')!;
  assert.match((await traceOf(w.store, world, noChange.decisionId, en))!.headline, /^The price stayed: /);
});

test('Р-73, C: a Gate rejection more than 10 % beyond the bound is dangerous; the screen counts it with the limit and the deviation', async () => {
  const w = live('kaufland/pipeline/above-max-price');
  const world = await w.view(user('OWNER'));
  const view = await rejectedOf(w.store, world, en);
  const item = view.items.find((i) => i.kind === 'GATE')!;
  assert.deepEqual([item.proposed, item.limit, item.intervention], ['€38.30', 'max_price €25.00', 'DANGEROUS']);
  assert.equal(view.summary.dangerous, 1);
  assert.match(view.headline, /^Your bounds stopped 1 dangerous change and corrected \d+$/);
  assert.equal(item.deviation, '53.2%');
  assert.equal((await rejectedOf(w.store, world, de)).items.find((i) => i.kind === 'GATE')!.deviation, '53,2 %');
  const shiftWorld = live('kaufland/pipeline/mass-shift-halt');
  const shift = await rejectedOf(shiftWorld.store, await shiftWorld.view(user('OWNER')), en);
  assert.ok(shift.items.some((i) => i.kind === 'HALT' && i.reason.code === 'CHANNEL_MASS_SHIFT'));
  assert.equal(shift.summary.dangerous, 0, 'a channel halt is not a bound intervention');
});

test('D, F: the product list shows the effective floor with min_price as its part; the floor is broken down to the cent and matches the Gate', async () => {
  const w = live('kaufland/pipeline/fx-usd-floor-eur-cost');
  const world = await w.view(user('OWNER'));
  const decisions = (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items;
  const rows = productList(world, en).rows;
  const deRow = rows.find((r) => r.unit.writeScopeId === 'ws-price-de-4501')!;
  assert.deepEqual([deRow.floor.amount, deRow.floor.parts, deRow.minPrice], ['€19.15', '= minimum margin 20% → €19.15; min_price €10.00', '€10.00']);
  assert.equal(productList(world, de).rows.find((r) => r.unit.writeScopeId === 'ws-price-de-4501')!.floor.amount, '19,15 €');
  for (const scope of world.state.scopes) {
    const view = boundsView(world, scope.writeScopeId, en)!;
    const rejected = decisions.find((d) => d.writeScopeId === scope.writeScopeId && d.rejectionReason === 'BELOW_MARGIN_FLOOR')!;
    assert.equal(view.effectiveFloor.minor, rejected.reason.params.floorMinor, 'the screen floor is the Gate floor');
    assert.equal(rows.find((r) => r.unit.writeScopeId === scope.writeScopeId)!.floor.minor, view.effectiveFloor.minor);
    const b = view.floorBreakdown!;
    assert.equal(b.balanced, true);
    assert.equal(b.lines[0]!.minor, view.effectiveFloor.minor);
    if (scope.currency === 'USD') {
      assert.equal(b.lines.find((l) => l.key === 'TAX')!.minor, 0);
      assert.match(b.lines.find((l) => l.key === 'COST')!.formula, /^1 EUR = 1\.1551 USD \(ECB rate of \d{4}-\d{2}-\d{2}\): €10\.00 → \$11\.56, rounded up$/);
    } else {
      assert.equal(b.lines.find((l) => l.key === 'TAX')!.label, 'VAT 19%');
    }
  }
});

test('Р-69, Р-70, OQ-125: the kill switch stops every price of the tenant; only the owner resumes a tenant stop', async () => {
  const w = live('kaufland/pipeline/happy-path');
  const viewer = await w.view(user('VIEWER'));
  assert.deepEqual((await stopOf(w.store, viewer, en)).permissions, { canStop: false, canResumeTenant: false, canResumeChannel: false, canReleaseHalt: false, canReleaseDistrust: false });
  assert.equal(productList(viewer, en).rows.some((r) => r.canEnable), false);

  const operatorWorld = await w.view(user('OPERATOR'));
  const plan = planStop(operatorWorld, { kind: 'TENANT' }, en);
  assert.equal(plan.alreadyActive, false);
  assert.match(plan.confirmText, /Only the owner can resume it\.$/);
  const ctx = w.callContext(operatorWorld.accounts[0]!.channelAccountId);
  const stopped = await w.pipeline.stopPricing(ctx, {
    scope: 'TENANT', channelAccountId: null, marketplace: null, stoppedAt: w.clock.iso(), stoppedByMembershipId: user('OPERATOR').membershipId,
    stoppedByUserId: standUserOf(user('OPERATOR').membershipId), note: 'Synthetic kill switch check',
  });
  assert.equal(stopped.status, 'STOPPED');

  const after = await w.view(user('OPERATOR'));
  assert.ok(productList(after, en).rows.every((r) => r.enabled.label === 'Stopped'), 'all prices, not only competitor-derived ones');
  const view = await stopOf(w.store, after, en);
  assert.equal(view.tenant.coveredBy?.by, 'Operator (you)');
  assert.ok(view.storefronts.every((s) => s.coveredBy?.scope === 'TENANT' && !s.canStop), 'a tenant stop covers every storefront');
  assert.equal(view.stops.active[0]!.canResume, false, 'an operator may not resume a tenant stop');
  assert.equal(planStop(after, { kind: 'TENANT' }, en).alreadyActive, true);
  const stopId = view.stops.active[0]!.stopId;
  assert.equal((await w.pipeline.resumePricing(ctx, stopId, { membershipId: user('OPERATOR').membershipId, userId: standUserOf(user('OPERATOR').membershipId), mfa: true, note: 'Operator tries to resume', at: w.clock.iso() })).status, 'FORBIDDEN');

  const owner = await w.view(user('OWNER'));
  assert.equal((await stopOf(w.store, owner, de)).stops.active[0]!.canResume, true);
  assert.equal((await w.pipeline.resumePricing(ctx, stopId, { membershipId: user('OWNER').membershipId, userId: standUserOf(user('OWNER').membershipId), mfa: true, note: 'Kill switch checked, resuming', at: w.clock.iso() })).status, 'RELEASED');
  const resumed = await stopOf(w.store, await w.view(user('OWNER')), en);
  assert.equal(resumed.stops.active.length, 0);
  assert.match(resumed.stops.history[0]!.released!, /by Owner \(you\): “Kill switch checked, resuming”$/);
});

test('Р-69: the kill-switch world holds a fixed price with PRICING_STOPPED; a system halt is shown separately and never blocks fixed prices', async () => {
  const w = live('kaufland/pipeline/kill-switch-tenant-stop');
  const world = await w.view(user('OWNER'));
  const held = (await w.store.decisionPage(world.tenantId, { offset: 0, limit: 200 })).items.find((d) => d.rejectionReason === 'PRICING_STOPPED')!;
  const trace = (await traceOf(w.store, world, held.decisionId, en))!;
  const gate = trace.steps.find((s) => s.key === 'GATE')!;
  assert.equal(gate.status, 'WARN');
  assert.ok(gate.items.some((i) => i.label === en.ui.gateChecks.PRICE_STOP && i.outcome === 'FAIL'));
  assert.ok(gate.items.some((i) => i.label === en.ui.trace.priceStop && i.value?.startsWith('the whole account group since ')));
  assert.equal(trace.steps[0]!.status, 'SKIPPED', 'a fixed price uses no competitor snapshot');
  assert.ok((await rejectedOf(w.store, world, en)).items.some((i) => i.kind === 'STOP' && i.reason.code === 'PRICING_STOPPED'));

  const haltedWorld = live('kaufland/pipeline/mass-shift-halt');
  const halted = await haltedWorld.view(user('OPERATOR'));
  const view = await stopOf(haltedWorld.store, halted, en);
  assert.ok(view.halts.active.length + view.halts.history.length > 0);
  assert.equal(view.stops.active.length, 0, 'a system halt is not a human stop');
});
