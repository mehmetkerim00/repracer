import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundsView } from './bounds.ts';
import { describe } from './explain.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { channelNotes, productList } from './products.ts';
import { decisionTrace } from './trace.ts';

/**
 * Шаг 107 [Р-233, Р-231] на модели экранов (данные синтетические): рамки цены, заданные продавцом в канале (Amazon Min/Max на SKU), рядом
 * с нашими. Без данных канала — честное «not provided»; рамки без прочитанных значений — блок, как прежде; со значениями — суммы и
 * предупреждение ровно при конфликте (наш пол ниже Min канала, наш потолок выше Max канала) на странице пола и пилюлей в Offers; квитанция
 * называет удержание вне рамок и конфликт распродажи
 */

const en = messagesFor('en');
const SEEN = '2026-10-23T09:00:00.000Z';
type Values = { minMinor: number | null; maxMinor: number | null; currency: string };

function world(pricing: { channelBounds: boolean; boundValues?: Values } | null, over: Record<string, unknown> = {}, channel = 'AMAZON') {
  const scope = {
    writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SYN-SKU-107', channelProductRef: 'B0SYN107',
    condition: 'new', gtin: null, currency: 'USD', basis: 'NET', taxRegime: 'SALES_TAX_EXCLUDED', productTitle: 'Plant pot, green', productSku: 'SYN-SKU-107',
    pricingMode: 'ENGINE', status: 'ACTIVE', currentPriceMinor: 1500, minMarginBp: null, cost: null, declaredCost: null, clearance: null, strategy: null,
    bounds: { currency: 'USD', basis: 'NET', min: { status: 'RESOLVED', amountMinor: 1000, sourceIds: ['m'] }, max: { status: 'RESOLVED', amountMinor: 5000, sourceIds: ['x'] } },
    feeEstimates: [], fees: [], channelNotes: [], ...over,
  };
  const offerChannelPricing = pricing ? [{ channelAccountId: 'acc-1', marketplace: 'ATVPDKIKX0DER', externalSku: 'SYN-SKU-107', automatedPricing: false, source: 'DISCOVERY', observedAt: SEEN, ...pricing }] : [];
  return {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-10-23T12:00:00.000Z', viewer: { role: 'OWNER' }, people: {},
    accounts: [{ channelAccountId: 'acc-1', channel, marketplaces: ['ATVPDKIKX0DER'] }],
    state: { scopes: [scope], writes: [], strategies: [], explanationRulesets: [], fxRates: [], members: [], divergenceCases: [], offerChannelPricing, pricingHealth: [], halts: [] },
  } as never;
}
const usd = (minMinor: number | null, maxMinor: number | null): Values => ({ minMinor, maxMinor, currency: 'USD' });
const block = (w: never, m = en) => boundsView(w, 'ws-1', m)!.channelBounds;

test('step 107 [Р-233]: without channel data the block says «not provided» honestly; bounds without values — «not read» (step 127: the price held, no block)', () => {
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const none = block(world(null), m);
    assert.deepEqual([none.state, none.text, none.min, none.max, none.conflicts.length], ['NOT_PROVIDED', m.ui.bounds.channelBounds.notProvided, null, null, 0], l);
  }
  // Канал без такого понятия — то же «not provided», даже если наблюдение есть
  assert.equal(block(world({ channelBounds: true, boundValues: usd(1200, null) }, {}, 'KAUFLAND')).state, 'NOT_PROVIDED');
  const notSet = block(world({ channelBounds: false }));
  assert.equal(notSet.state, 'NOT_SET');
  assert.match(notSet.text ?? '', /^None set in the channel \(seen .+\)\. The channel may still apply limits it does not show\.$/);
  const notRead = block(world({ channelBounds: true }));
  assert.equal(notRead.state, 'NOT_READ');
  assert.match(notRead.text ?? '', /values were not read\. Decisions are calculated; new prices for this offer are held and not sent/);
  // Значения в чужой валюте сравнивать не с чем — тоже «не прочитаны» (с шага 127 — пометка, а не блок)
  assert.equal(block(world({ channelBounds: true, boundValues: { minMinor: 1200, maxMinor: null, currency: 'EUR' } })).state, 'NOT_READ');
  assert.deepEqual(channelNotes(world({ channelBounds: true }), (world({ channelBounds: true }) as { state: { scopes: never[] } }).state.scopes[0]!, en).map((n) => n.code), ['CHANNEL_BOUNDS']);
});

test('step 107 [Р-233]: the warning appears exactly at a conflict — on the floor page and as a pill in Offers', () => {
  // Min $12.00 выше нашего пола $10.00, Max $40.00 ниже нашего потолка $50.00 — оба конфликта
  const both = block(world({ channelBounds: true, boundValues: usd(1200, 4000) }));
  assert.deepEqual([both.state, both.min, both.max], ['VALUES', '$12.00', '$40.00']);
  assert.deepEqual(both.conflicts.map((c) => c.text), [
    'Below the channel\'s own minimum — the channel will deactivate this offer. Your floor $10.00 is below the channel minimum $12.00; prices below $12.00 are not sent.',
    'Above the channel\'s own maximum — the channel will deactivate this offer. Your maximum price $50.00 is above the channel maximum $40.00; prices above $40.00 are not sent.',
  ]);
  assert.equal(both.text, 'Without shipping — compared with your floor and maximum price, which are without shipping too.');
  const row = (w: never) => productList(w, en).rows[0]!.channelBounds;
  assert.equal(row(world({ channelBounds: true, boundValues: usd(1200, 4000) })), 'Below the channel minimum · Above the channel maximum');
  // Рамки не сужают наш диапазон (равенство — не конфликт): ни предупреждения, ни пилюли, ни блока
  const fits = world({ channelBounds: true, boundValues: usd(1000, 5000) });
  assert.deepEqual([block(fits).conflicts.length, block(fits).ok, row(fits)], [0, 'Your floor and maximum price are inside the channel bounds.', null]);
  assert.deepEqual(channelNotes(fits, (fits as { state: { scopes: never[] } }).state.scopes[0]!, en), [], 'known bounds are not a channel block any more (Р-231)');
  // Одна сторона: Min ниже пола — конфликта нет; Max не задан — «not set»
  const half = block(world({ channelBounds: true, boundValues: usd(900, null) }));
  assert.deepEqual([half.min, half.max, half.conflicts.length], ['$9.00', 'not set', 0]);
  assert.equal(row(world({ channelBounds: true, boundValues: usd(null, 4000) })), 'Above the channel maximum');
  // Распродажа ниже Min канала — тот же конфликт, но «цены уходят, как вы подтвердили»
  const clearance = { changeId: 'c', floorMinor: 800, currency: 'USD', endsAt: null, note: 'n', enabledAt: SEEN, enabledByMembershipId: null };
  assert.deepEqual(block(world({ channelBounds: true, boundValues: usd(1200, null) }, { clearance })).conflicts.map((c) => c.text), [
    'Below the channel\'s own minimum — the channel will deactivate this offer. Your clearance floor $8.00 is below the channel minimum $12.00; prices below $12.00 are sent, as you confirmed when you enabled clearance.',
  ]);
  // Без данных канала — ни конфликта, ни пилюли
  assert.equal(row(world(null)), null);
});

test('step 107 [Р-233, Р-227]: the receipt names the hold outside the channel bounds and the clearance conflict — both amounts, every language', () => {
  const hold = { code: 'CHANNEL_BOUNDS_HOLD', params: { targetMinor: 1099, side: 'MIN', channelMinMinor: 1200, currency: 'USD' } };
  const note = { code: 'CLEARANCE_BELOW_CHANNEL_MIN', params: { floorMinor: 800, channelMinMinor: 1200, currency: 'USD' } };
  assert.equal(describe(hold, en).text, 'Price $10.99 is below the channel\'s own minimum $12.00 — the channel would deactivate this offer, so the price was not sent.');
  assert.equal(describe({ code: 'CHANNEL_BOUNDS_HOLD', params: { targetMinor: 4599, side: 'MAX', channelMaxMinor: 4000, currency: 'USD' } }, en).text,
    'Price $45.99 is above the channel\'s own maximum $40.00 — the channel would deactivate this offer, so the price was not sent.');
  assert.equal(describe(note, en).text,
    'Your clearance floor $8.00 is below the channel\'s own minimum $12.00: prices below it are sent, as you confirmed, and the channel may deactivate this offer.');
  for (const l of LOCALES) {
    const m = messagesFor(l);
    for (const r of [hold, note]) {
      const text = describe(r, m).text;
      assert.ok([1200, r.code === 'CHANNEL_BOUNDS_HOLD' ? 1099 : 800].every((v) => text.includes(m.money(v, 'USD'))), `${l} ${r.code}: ${text}`);
    }
  }
  // Квитанция решения «без изменения» с удержанием вне рамок канала: фраза удержания с обеими суммами
  const detail = {
    decision: {
      decisionId: 'd-1', intentId: 'i-1', writeScopeId: 'ws-1', decidedAt: '2026-10-23T11:00:00.000Z', outcome: 'NO_CHANGE', decisionClass: 'NO_OP',
      currency: 'USD', basis: 'NET', finalMinor: null, proposedMinor: null, rejectionReason: null, boundDeviationBp: null, noChangeReason: 'CHANNEL_BOUNDS_HOLD',
      reason: { code: 'NO_CHANGE', params: {} }, explanation: null, checks: [], clearanceChangeId: null,
    },
    intent: { intentId: 'i-1', writeScopeId: 'ws-1', createdAt: '2026-10-23T11:00:00.000Z', currency: 'USD', currentMinor: 1500, reason: hold,
      explanation: [{ code: 'LOWEST_UNDERCUT', params: { lowestMinor: 1100, undercutMinor: 1, scope: 'VISIBLE_TOP_N', targetMinor: 1099, currency: 'USD' } }, hold] },
    writes: [],
  } as never;
  const receipt = JSON.stringify(decisionTrace(world(null), detail, en));
  assert.ok(receipt.includes('Price $10.99 is below the channel\'s own minimum $12.00'), receipt);
});

test('step 127 [Р-250] (П1): Amazon bounds whose values we did not read — no block: the offer can be enabled and take a strategy; the note says the price is held, in four languages; the receipt says it too', () => {
  // Шаг 128: так — у аккаунта в тени; в бою — отказ включения (тест ниже)
  const w = world({ channelBounds: true, accountLive: false } as never, { pricingMode: 'OFF', strategy: { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2100 }, deadbandMinor: 0 } });
  const scope = (w as { state: { scopes: never[] } }).state.scopes[0]!;
  for (const l of LOCALES) {
    const m = messagesFor(l);
    const notes = channelNotes(w, scope, m);
    assert.deepEqual(notes.map((n) => [n.code, n.tone, n.label, n.detail]),
      [['CHANNEL_BOUNDS', 'warn', m.ui.channelNotes.channelBounds, m.ui.channelNotes.channelBoundsDetail(m.when(SEEN))]], l);
  }
  const [note] = channelNotes(w, scope, en);
  assert.equal(note!.label, 'Price held: Amazon bounds');
  assert.match(note!.detail, /Decisions are calculated and shown, but a new price for this offer is held and not sent — in live too/);
  assert.equal(productList(w, en).rows[0]!.canEnable, true, 'unread bounds no longer block enabling — as the database (0230)');
  // Контроль: правило автоматического ценообразования канала — по-прежнему блок
  const repricer = world({ channelBounds: false, automatedPricing: true } as never, { pricingMode: 'OFF' });
  assert.equal(productList(repricer, en).rows[0]!.canEnable, false, 'Automate Pricing still blocks [Р-120]');

  // Квитанция одобренного решения: цена удержана и в бою — у шага записи пометка рамок
  const detail = {
    decision: {
      decisionId: 'd-2', intentId: 'i-2', writeScopeId: 'ws-1', decidedAt: '2026-10-23T11:00:00.000Z', outcome: 'APPROVED', decisionClass: 'CHANGED',
      currency: 'USD', basis: 'NET', finalMinor: 2100, proposedMinor: 2100, rejectionReason: null, boundDeviationBp: null, noChangeReason: null,
      reason: { code: 'FIXED_PRICE', params: { priceMinor: 2100, currency: 'USD' } }, explanation: null, checks: [], clearanceChangeId: null,
    },
    intent: null,
    writes: [{ channelWriteId: 'cw-1', writeScopeId: 'ws-1', field: 'PRICE', version: 1, amountMinor: 2100, status: 'SHADOW_HELD', attemptCount: 0, dispatchedAt: null, acceptedAt: null, endReason: null, endParams: {} }],
  } as never;
  const write = decisionTrace(w, detail, en).steps.find((s) => s.key === 'WRITE')!;
  assert.deepEqual(write.items[0], { label: 'Amazon price bounds',
    value: `Amazon minimum/maximum prices are set on this offer (seen ${en.when(SEEN)}), and we could not read their values: this price is held and not sent — in live too, not only in the shadow.` });
  assert.equal(write.status, 'WARN');
  // Контроль: без рамок у шага записи пометки нет
  assert.ok(!JSON.stringify(decisionTrace(world(null, { strategy: null }), detail, en)).includes('Amazon price bounds'), 'no bounds — no note');
});

test('step 128 [Р-250] (решение владельца по П1): on a LIVE account unread Amazon bounds refuse enabling with an honest reason, as before step 127; the shadow keeps the step 127 note', () => {
  const strategy = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2100 }, deadbandMinor: 0 };
  const live = world({ channelBounds: true, accountLive: true } as never, { pricingMode: 'OFF', strategy });
  const scope = (live as { state: { scopes: never[] } }).state.scopes[0]!;
  for (const l of LOCALES) {
    const m = messagesFor(l);
    assert.deepEqual(channelNotes(live, scope, m).map((n) => [n.code, n.tone, n.label, n.detail]),
      [['CHANNEL_BOUNDS_LIVE', 'stop', m.ui.channelNotes.channelBoundsLive, m.ui.channelNotes.channelBoundsLiveDetail(m.when(SEEN))]], l);
    assert.equal(block(live, m).text, m.ui.bounds.channelBounds.notReadLive(m.when(SEEN)), `${l}: the floor page says why`);
  }
  const [note] = channelNotes(live, scope, en);
  assert.equal(note!.label, 'Blocked: Amazon bounds');
  assert.match(note!.detail, /On a live account repricing cannot be turned on for this offer/);
  assert.match(block(live).text ?? '', /On a live account repricing for this offer cannot be turned on/);
  assert.equal(productList(live, en).rows[0]!.canEnable, false, 'live: enabling is refused — as the database (0231)');
  // Значения в чужой валюте — сравнить не с чем: в бою тоже отказ
  const otherCurrency = world({ channelBounds: true, accountLive: true, boundValues: { minMinor: 1200, maxMinor: null, currency: 'EUR' } } as never, { pricingMode: 'OFF', strategy });
  assert.equal(productList(otherCurrency, en).rows[0]!.canEnable, false, 'live: values in another currency — refused too');
  // Контроли: в тени — пометка шага 127 и включение; в бою значения в валюте предложения — не блок (Р-231)
  const shadow = world({ channelBounds: true, accountLive: false } as never, { pricingMode: 'OFF', strategy });
  assert.deepEqual([channelNotes(shadow, scope, en).map((n) => n.code), productList(shadow, en).rows[0]!.canEnable], [['CHANNEL_BOUNDS'], true]);
  const known = world({ channelBounds: true, accountLive: true, boundValues: usd(900, 6000) } as never, { pricingMode: 'OFF', strategy });
  assert.equal(productList(known, en).rows[0]!.canEnable, true, 'live, values read in the offer currency — no block [Р-231]');
});
