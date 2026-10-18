import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { buildCompetitorView, withCompetitorFilter } from '@repracer/pricing-model';
import { describe } from './explain.ts';
import { LOCALES, messagesFor } from './i18n/index.ts';
import { traceCompetitors } from './trace.ts';

/**
 * Шаг 101 (4) [Р-226]: квитанция «Why this price» честно показывает фильтр и ориентир. Отфильтрованные предложения остаются в таблице
 * конкурентов приглушёнными с пометкой, шапка — «considered N of M offers» по всему снимку, неизвестное исполнение — отдельным счётом;
 * строка стратегии называет победивший ориентир: «Anchor: Buy Box $18.41 (lower than lowest $18.99)». Данные синтетические
 */

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });
const offer = (seller: string | null, price: number, fulfillment?: string, holdsBuyBox?: boolean): CompetitorOffer => ({
  isSelf: seller === null, ...(seller ? { sellerRef: seller } : {}), price: usd(price), shipping: usd(0),
  ...(fulfillment ? { fulfillment } : {}), ...(holdsBuyBox ? { holdsBuyBox } : {}),
});
const snapshot: CompetitorSnapshot = {
  marketplace: 'ATVPDKIKX0DER', channelProductRef: 'SYN-101', condition: 'new', source: 'SYN', observedAt: '2026-10-18T10:00:00.000Z' as never,
  completeness: { kind: 'TOP_N', n: 20 }, buybox: { price: usd(1841), isSelf: false, sellerRef: 'Prime Shelf' },
  offers: [offer('Budget Bin', 1699, 'MFN'), offer('Quiet Lane', 1750), offer('Prime Shelf', 1841, 'AFN', true), offer('North Ridge', 1899, 'AFN'), offer(null, 1950, 'MFN')],
};
const world = { accounts: [], state: { scopes: [] } } as never;

test('step 101 (4): the receipt shows the excluded offers dimmed and named, the filter head, and the anchor that won', () => {
  const m = messagesFor('en');
  const view = withCompetitorFilter(buildCompetitorView(snapshot, null), snapshot.offers, 'CHANNEL');
  const receipt = traceCompetitors({ writeScopeId: 'ws-1', competitorView: view } as never, world, m);
  assert.deepEqual(receipt.filter, { head: 'Compete with: FBA only — considered 2 of 4 offers', unknown: '1 excluded: fulfillment unknown' });
  assert.deepEqual(receipt.rows.map((r) => [r.seller, r.excluded]), [
    ['Budget Bin', 'excluded by your filter'], ['Quiet Lane', 'fulfillment unknown — excluded'], ['Prime Shelf', null], ['North Ridge', null], ['You', null],
  ], 'the excluded offers stay in the table with a mark, they are not hidden');
  // Без фильтра — ни шапки, ни пометок: прежние решения выглядят прежними
  const plain = traceCompetitors({ writeScopeId: 'ws-1', competitorView: buildCompetitorView(snapshot, null) } as never, world, m);
  assert.equal(plain.filter, null);
  assert.ok(plain.rows.every((r) => r.excluded === null));

  // Победивший ориентир — словами, с ценой второго
  const anchor = (params: Record<string, string | number>, lm = m) => describe({ code: 'ANCHOR_UNDERCUT', params: { strategyType: 'BEAT_LOWEST', anchorSetting: 'LOWER_OF_TWO', undercutMinor: 1, currency: 'USD', ...params } }, lm);
  const bb = anchor({ anchorUsed: 'BUYBOX', anchorMinor: 1841, otherAnchorMinor: 1899, targetMinor: 1840 });
  assert.equal(bb.text, 'Anchor: Buy Box $18.41 (lower than lowest $18.99); $0.01 below it: $18.40.');
  assert.deepEqual(bb.problems, []);
  assert.equal(anchor({ anchorUsed: 'LOWEST', anchorMinor: 1699, otherAnchorMinor: 1841, targetMinor: 1698 }).text, 'Anchor: lowest $16.99 (lower than Buy Box $18.41); $0.01 below it: $16.98.');
  assert.equal(anchor({ anchorUsed: 'LOWEST', anchorMinor: 1841, buyboxUnused: 'EXCLUDED', targetMinor: 1840 }).text,
    'Anchor: lowest $18.41 (Buy Box not used: its holder is excluded by your filter); $0.01 below it: $18.40.');
  const filtered = describe({ code: 'COMPETITORS_FILTERED', params: { competeWith: 'CHANNEL', offersConsidered: 2, offersTotal: 4, offersUnknown: 1 } }, m);
  assert.equal(filtered.text, 'Compete with: FBA only — considered 2 of 4 offers; 1 excluded: fulfillment unknown.');
  const none = describe({ code: 'NO_ELIGIBLE_COMPETITORS', params: { competeWith: 'MERCHANT', offersTotal: 3, offersUnknown: 0 } }, m);
  assert.match(none.text, /^Compete with: FBM only — no competitor passes your filter \(3 offers\)\. The price stays: your filter is kept, not widened to all competitors\.$/);

  // Каждый язык: шапка, пометки и ориентир — свои слова, без кодов
  for (const locale of LOCALES) {
    const lm = messagesFor(locale);
    const r = traceCompetitors({ writeScopeId: 'ws-1', competitorView: view } as never, world, lm);
    const text = JSON.stringify([r.filter, r.rows.map((x) => x.excluded), anchor({ anchorUsed: 'BUYBOX', anchorMinor: 1841, otherAnchorMinor: 1899, targetMinor: 1840 }, lm).text]);
    for (const code of ['CHANNEL', 'MERCHANT', 'FILTER', 'UNKNOWN', 'BUYBOX', 'LOWEST', 'undefined']) assert.ok(!text.includes(`"${code}"`) && !text.includes(` ${code} `), `${locale}: no code ${code} on the receipt — ${text}`);
    if (locale !== 'en') assert.notEqual(r.filter!.head, receipt.filter!.head, `${locale}: the filter head is translated`);
  }
});

test('step 101 (C): the one-line strategy description names the anchor and the filter only when they are not the default', async () => {
  const { strategyLabel } = await import('./products.ts');
  const { parseStrategyDraft } = await import('./strategies.ts');
  const m = messagesFor('en');
  const def = (params: Record<string, unknown>) => ({ strategyId: 's', version: 1, deadbandMinor: 0, params: { undercutMinor: 1, atBound: 'CAP', ...params } }) as never;
  const beat = { type: 'BEAT_LOWEST', scope: 'VISIBLE_TOP_N', compareLanded: false };
  assert.equal(strategyLabel(def(beat), 'USD', m).detail, 'undercut by $0.01, against visible offers; outside bounds — use the bound (version 1)', 'a version without the fields reads as before');
  assert.equal(strategyLabel(def({ ...beat, anchor: 'LOWEST', competeWith: 'ALL' }), 'USD', m).detail, strategyLabel(def(beat), 'USD', m).detail, 'the explicit defaults are not named');
  assert.equal(strategyLabel(def({ ...beat, anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), 'USD', m).detail,
    'undercut by $0.01, against visible offers; anchor: lower of the two; compete with: FBA only; outside bounds — use the bound (version 1)');
  assert.match(strategyLabel(def({ type: 'WIN_BUYBOX', fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, anchor: 'LOWEST' }), 'USD', m).detail, /; anchor: lowest price; /);
  assert.match(strategyLabel(def({ type: 'MATCH_BUYBOX', holdWhenWinning: true, competeWith: 'MERCHANT' }), 'USD', m).detail, /; compete with: FBM only; /);
  // Черновик: умолчание типа не хранится, неизвестное значение — ошибка поля
  const draft = (params: Record<string, unknown>) => parseStrategyDraft({ name: 'x', deadbandMinor: 0, params: { ...beat, undercutMinor: 1, atBound: 'CAP', ...params } });
  assert.deepEqual((draft({ anchor: 'LOWEST', competeWith: 'ALL' }) as { draft: { params: object } }).draft.params, { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' });
  assert.deepEqual((draft({ anchor: 'BUYBOX', competeWith: 'MERCHANT' }) as { draft: { params: Record<string, unknown> } }).draft.params.anchor, 'BUYBOX');
  assert.deepEqual(draft({ competeWith: 'FBA' }), { ok: false, problems: [{ field: 'competeWith', code: 'OUT_OF_RANGE' }] });
});

test('step 101: counts read right in every language — one offer is singular, the option is lower case inside a sentence', () => {
  const head = (locale: (typeof LOCALES)[number], considered: number, total: number) => {
    const lm = messagesFor(locale);
    return lm.ui.trace.competitors.filterHead(lm.ui.strategies.competeWithInline.CHANNEL, considered, total);
  };
  assert.equal(head('en', 1, 1), 'Compete with: FBA only — considered 1 of 1 offer');
  assert.equal(head('es', 1, 2), 'Competir con: solo FBA — se consideró 1 de 2 ofertas');
  assert.equal(head('es', 2, 3), 'Competir con: solo FBA — se consideraron 2 de 3 ofertas');
  assert.equal(head('fr', 1, 2), 'Concurrence avec : FBA uniquement — 1 offre prise en compte sur 2');
  assert.equal(head('de', 1, 2), 'Wettbewerb mit: nur FBA — 1 von 2 Angeboten berücksichtigt');
  assert.equal(messagesFor('es').ui.trace.competitors.filterUnknown(1), '1 excluida: logística desconocida');
  assert.equal(messagesFor('fr').ui.trace.competitors.filterUnknown(1), '1 exclue : mode d’expédition inconnu');
  const fr = describe({ code: 'NO_ELIGIBLE_COMPETITORS', params: { competeWith: 'CHANNEL', offersTotal: 1, offersUnknown: 0 } }, messagesFor('fr'));
  assert.match(fr.text, /\(1 offre\)/);
});
