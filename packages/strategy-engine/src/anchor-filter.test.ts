import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot, CompetitorSourceDescriptor } from '@repracer/channel-port';
import { markAcceptedBySanity, type StrategyParams } from '@repracer/pricing-model';
import { runStrategy, strategyAvailability, type EngineInput, type EngineResult } from './index.ts';

/**
 * Шаг 101 [Р-226]: ориентир цены (Buy Box / самая низкая / меньшая из двух) и фильтр конкурентов «Compete with» (все / только FBA / только FBM).
 * Товар — как в демо: лоукостер исполняет заказ сам (FBM) и Buy Box не держит, Buy Box — у предложения FBA с ценой выше; у одного предложения
 * исполнение не названо. Фильтр — до расчёта; неизвестное исполнение при фильтре — исключено и посчитано; после фильтра никого — «без изменения»,
 * к «всем» фильтр не откатывается. Данные синтетические
 */

const NOW = '2026-10-18T10:00:00.000Z';
const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', basis: 'NET' as const });

interface Offer { seller: string; price: number; fulfillment?: 'AFN' | 'MFN'; buybox?: boolean; shipping?: number }

/** Лоукостер FBM $16.99, держатель Buy Box FBA $18.41, ещё FBA $18.99, исполнение не названо $17.50; наша цена $19.50 */
const MARKET: Offer[] = [
  { seller: 'Budget Bin (FBM)', price: 1699, fulfillment: 'MFN' },
  { seller: 'Prime Shelf (FBA)', price: 1841, fulfillment: 'AFN', buybox: true },
  { seller: 'North Ridge (FBA)', price: 1899, fulfillment: 'AFN' },
  { seller: 'Quiet Lane (?)', price: 1750 },
];

function snapshot(offers: Offer[], buybox: { price: number; holder: 'NAMED' | 'UNKNOWN' | 'SELF'; shipping?: number } | null, selfMinor = 1950): CompetitorSnapshot {
  const holder = offers.find((o) => o.buybox);
  return {
    marketplace: 'ATVPDKIKX0DER', channelProductRef: 'SYN-101', condition: 'new', source: 'SYN_SOURCE', observedAt: '2026-10-18T09:59:00.000Z',
    completeness: { kind: 'TOP_N', n: 20 },
    ...(buybox ? { buybox: {
      price: usd(buybox.price), isSelf: buybox.holder === 'UNKNOWN' ? null : buybox.holder === 'SELF',
      ...(buybox.holder === 'NAMED' && holder ? { sellerRef: holder.seller } : {}), ...(buybox.shipping !== undefined ? { shipping: usd(buybox.shipping) } : {}),
    } } : {}),
    offers: [
      ...offers.map((o, i): CompetitorOffer => ({
        rank: i + 1, sellerRef: o.seller, isSelf: false, price: usd(o.price), shipping: usd(o.shipping ?? 0),
        ...(o.fulfillment ? { fulfillment: o.fulfillment } : {}), ...(buybox?.holder === 'NAMED' && o.buybox ? { holdsBuyBox: true } : {}),
      })),
      { rank: offers.length + 1, isSelf: true, price: usd(selfMinor), shipping: usd(0), fulfillment: 'MFN' },
    ],
  };
}

const beat = (over: Partial<Extract<StrategyParams, { type: 'BEAT_LOWEST' }>> = {}): StrategyParams =>
  ({ type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP', ...over });
const win = (over: Partial<Extract<StrategyParams, { type: 'WIN_BUYBOX' }>> = {}): StrategyParams =>
  ({ type: 'WIN_BUYBOX', undercutMinor: 1, fulfillmentHandicapMinor: 0, creepUp: false, creepStepBp: 100, atBound: 'CAP', ...over });
const match = (over: Partial<Extract<StrategyParams, { type: 'MATCH_BUYBOX' }>> = {}): StrategyParams =>
  ({ type: 'MATCH_BUYBOX', undercutMinor: 1, holdWhenWinning: true, atBound: 'CAP', ...over });

function run(params: StrategyParams, snap: CompetitorSnapshot, over: Partial<EngineInput> = {}): EngineResult {
  return runStrategy({
    writeScope: { writeScopeId: 'ws-101', currency: 'USD', basis: 'NET' },
    strategy: { strategyId: 'st-101', version: 1, params, deadbandMinor: 0 },
    snapshot: markAcceptedBySanity(snap, 'test'),
    cost: null,
    bounds: { minMinor: 1000, maxMinor: 3000 },
    currentPriceMinor: snap.offers.find((o) => o.isSelf)!.price.amountMinor,
    now: NOW,
    trigger: { type: 'COMPETITOR_CHANGE', sourceEventId: 'evt-101' },
    ...over,
  });
}

function intentOf(r: EngineResult) {
  assert.equal(r.kind, 'INTENT', JSON.stringify(r));
  return (r as Extract<EngineResult, { kind: 'INTENT' }>).intent;
}
const codes = (r: EngineResult) => intentOf(r).explanation.map((x) => x.code);

test('step 101 (1): on the demo product the anchor and the filter move the price predictably', () => {
  const named = snapshot(MARKET, { price: 1841, holder: 'NAMED' });
  // Прежние версии не меняются: «Beat the lowest» без ориентира — самая низкая, прежней причиной
  const lowest = intentOf(run(beat(), named));
  assert.equal(lowest.proposedMinor, 1698, 'the FBM low-cost seller minus a cent');
  assert.equal(lowest.reason.code, 'LOWEST_UNDERCUT', 'a version without an anchor keeps its reason');
  assert.deepEqual(intentOf(run(beat({ anchor: 'LOWEST' }), named)).proposedMinor, 1698, 'the explicit default is the same price');

  // Ориентир Buy Box: от цены Buy Box, а не от лоукостера
  const bb = intentOf(run(beat({ anchor: 'BUYBOX' }), named));
  assert.equal(bb.proposedMinor, 1840);
  assert.equal(bb.reason.code, 'ANCHOR_UNDERCUT');
  assert.deepEqual(bb.reason.params, { strategyType: 'BEAT_LOWEST', anchorSetting: 'BUYBOX', anchorUsed: 'BUYBOX', anchorMinor: 1841, undercutMinor: 1, targetMinor: 1840, currency: 'USD' });

  // Меньшая из двух без фильтра — лоукостер дешевле Buy Box: победила самая низкая, Buy Box назван рядом
  const lower = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), named));
  assert.equal(lower.proposedMinor, 1698);
  assert.equal(lower.reason.params.anchorUsed, 'LOWEST');
  assert.equal(lower.reason.params.otherAnchorMinor, 1841);

  // Только FBA: лоукостер FBM и предложение без исполнения не участвуют — самая низкая среди FBA $18.41
  const fba = run(beat({ competeWith: 'CHANNEL' }), named);
  assert.equal(intentOf(fba).proposedMinor, 1840, 'the cheapest FBA offer minus a cent');
  assert.deepEqual(codes(fba), ['COMPETITORS_FILTERED', 'LOWEST_UNDERCUT']);
  assert.deepEqual(intentOf(fba).explanation[0]!.params, { competeWith: 'CHANNEL', offersConsidered: 2, offersTotal: 4, offersUnknown: 1 });

  // Только FBM: остаётся лоукостер — $16.98
  const fbm = run(beat({ competeWith: 'MERCHANT' }), named);
  assert.equal(intentOf(fbm).proposedMinor, 1698);
  assert.deepEqual(intentOf(fbm).explanation[0]!.params, { competeWith: 'MERCHANT', offersConsidered: 1, offersTotal: 4, offersUnknown: 1 });

  // Меньшая из двух под фильтром FBA: держатель Buy Box — FBA, Buy Box $18.41 против самой низкой FBA $18.41 — одна цена
  const lowerFba = intentOf(run(beat({ anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), named));
  assert.equal(lowerFba.proposedMinor, 1840);

  // «Win the Buy Box» с ориентиром «самая низкая» под фильтром FBM: цель — от лоукостера с доставкой, а не от Buy Box
  const winLow = intentOf(run(win({ anchor: 'LOWEST', competeWith: 'MERCHANT' }), named));
  assert.equal(winLow.proposedMinor, 1698);
  assert.equal(winLow.reason.code, 'ANCHOR_UNDERCUT');
  assert.equal(winLow.reason.params.anchorUsed, 'LOWEST');
  // Без ориентира «Win the Buy Box» — прежняя причина и цель от Buy Box
  const winBb = intentOf(run(win(), named));
  assert.equal(winBb.proposedMinor, 1840);
  assert.equal(winBb.reason.code, 'BUYBOX_WIN_TARGET');
});

test('step 101 (2): lower of the two — one anchor missing, the other is used; both missing — the existing safeguard', () => {
  // Buy Box в снимке нет — самая низкая, причина названа
  const noBb = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), snapshot(MARKET, null)));
  assert.equal(noBb.proposedMinor, 1698);
  assert.equal(noBb.reason.params.anchorUsed, 'LOWEST');
  assert.equal(noBb.reason.params.buyboxUnused, 'ABSENT');
  assert.equal(noBb.reason.params.otherAnchorMinor, undefined);

  // Buy Box наш — от своей цены не считаем: самая низкая
  const own = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), snapshot(MARKET, { price: 1950, holder: 'SELF' })));
  assert.equal(own.reason.params.buyboxUnused, 'SELF');
  assert.equal(own.proposedMinor, 1698);

  // Под фильтром держатель не назван (Amazon, A-29) — исполнение Buy Box неизвестно: самая низкая среди FBA
  const unknownHolder = intentOf(run(beat({ anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), snapshot(MARKET, { price: 1841, holder: 'UNKNOWN' })));
  assert.equal(unknownHolder.reason.params.buyboxUnused, 'UNKNOWN');
  assert.equal(unknownHolder.proposedMinor, 1840);

  // Держатель вне фильтра: Buy Box у лоукостера FBM, фильтр FBA — Buy Box не ориентир, самая низкая среди FBA $18.41
  const fbmHolder: Offer[] = MARKET.map((o) => ({ ...o, buybox: o.seller.startsWith('Budget') }));
  const excluded = intentOf(run(beat({ anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), snapshot(fbmHolder, { price: 1699, holder: 'NAMED' })));
  assert.equal(excluded.reason.params.buyboxUnused, 'EXCLUDED');
  assert.equal(excluded.proposedMinor, 1840);

  // Самой низкой нет (в снимке только мы), Buy Box чужой — ориентир Buy Box, пары нет
  const onlyBb = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), snapshot([], { price: 1841, holder: 'UNKNOWN' })));
  assert.equal(onlyBb.reason.code, 'ANCHOR_UNDERCUT');
  assert.equal(onlyBb.reason.params.anchorUsed, 'BUYBOX');
  assert.equal(onlyBb.proposedMinor, 1840);
  assert.equal(onlyBb.reason.params.otherAnchorMinor, undefined);

  // Нет ни того, ни другого — прежняя страховка «канал не дал данных»: цена держится
  const none = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), snapshot([], null)));
  assert.equal(none.intentClass, 'NO_OP');
  assert.equal(none.reason.code, 'NO_COMPETITOR_OFFERS');

  // Buy Box дешевле самой низкой видимой (держатель вне видимых предложений, Amazon) — победил Buy Box, самая низкая названа рядом
  const cheapBb = intentOf(run(beat({ anchor: 'LOWER_OF_TWO' }), snapshot(MARKET.filter((o) => !o.buybox), { price: 1650, holder: 'UNKNOWN' })));
  assert.equal(cheapBb.reason.params.anchorUsed, 'BUYBOX');
  assert.equal(cheapBb.reason.params.anchorMinor, 1650);
  assert.equal(cheapBb.reason.params.otherAnchorMinor, 1699);
  assert.equal(cheapBb.proposedMinor, 1649);

  // Держатель Buy Box и есть самая низкая — цены равны: ориентир — Buy Box, самая низкая той же цены названа рядом
  const tie = intentOf(run(win({ anchor: 'LOWER_OF_TWO' }), snapshot(MARKET.map((o) => (o.buybox ? { ...o, price: 1650 } : o)), { price: 1650, holder: 'NAMED' })));
  assert.equal(tie.reason.params.anchorUsed, 'BUYBOX');
  assert.equal(tie.reason.params.otherAnchorMinor, 1650);
  assert.equal(tie.proposedMinor, 1649);
});

test('step 101 (3): nobody left after the filter — NO_ELIGIBLE_COMPETITORS, never a fallback to all competitors', () => {
  const onlyFbm: Offer[] = [{ seller: 'Budget Bin (FBM)', price: 1699, fulfillment: 'MFN', buybox: true }, { seller: 'Quiet Lane (?)', price: 1750 }];
  const snap = snapshot(onlyFbm, { price: 1699, holder: 'NAMED' });
  for (const params of [beat({ competeWith: 'CHANNEL' }), beat({ anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), win({ competeWith: 'CHANNEL' }), match({ competeWith: 'CHANNEL' })]) {
    const held = intentOf(run(params, snap));
    assert.equal(held.intentClass, 'NO_OP', `${params.type}: no change`);
    assert.equal(held.proposedMinor, 1950, `${params.type}: the price is held, not undercut to $16.98`);
    assert.equal(held.reason.code, 'NO_ELIGIBLE_COMPETITORS');
    assert.equal(held.reason.params.competeWith, 'CHANNEL');
    assert.equal(held.reason.params.offersTotal, 2);
    assert.equal(held.reason.params.offersUnknown, 1, `${params.type}: the unknown fulfilment is counted, not dropped silently`);
  }
  // Ориентир — только Buy Box, а его держатель вне фильтра (FBA есть, но Buy Box у FBM): не с чем сравнивать — тоже «без изменения»
  const fbmHolder: Offer[] = MARKET.map((o) => ({ ...o, buybox: o.seller.startsWith('Budget') }));
  const winBb = intentOf(run(win({ competeWith: 'CHANNEL' }), snapshot(fbmHolder, { price: 1699, holder: 'NAMED' })));
  assert.equal(winBb.reason.code, 'NO_ELIGIBLE_COMPETITORS');
  assert.equal(winBb.reason.params.buyboxHolder, 'EXCLUDED');
  const matchBb = intentOf(run(match({ competeWith: 'CHANNEL' }), snapshot(fbmHolder, { price: 1699, holder: 'NAMED' })));
  assert.equal(matchBb.reason.code, 'NO_ELIGIBLE_COMPETITORS');
  assert.equal(matchBb.reason.params.buyboxHolder, 'EXCLUDED');

  // Пол без исключений: цена ниже пола поднимается к полу и при «никого после фильтра»
  const low = intentOf(run(beat({ competeWith: 'CHANNEL' }), snapshot(onlyFbm, null, 900)));
  assert.equal(low.intentClass, 'CHANGED');
  assert.equal(low.proposedMinor, 1000);
  assert.deepEqual(low.explanation.map((x) => x.code), ['NO_ELIGIBLE_COMPETITORS', 'RAISED_TO_FLOOR']);
});

test('step 101 [Р-39]: the filter needs a source that names fulfilment; a Buy Box anchor under a filter needs the holder', () => {
  const amazon: CompetitorSourceDescriptor = { source: 'AMAZON_ANY_OFFER_CHANGED', kind: 'PUSH', completeness: { kind: 'TOP_N', n: 20 }, conditions: ['new'],
    hasBuyboxWinner: false, hasBuyboxPrice: true, hasOwnRank: false, hasShipping: true, hasFulfilment: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' };
  const walmart: CompetitorSourceDescriptor = { ...amazon, source: 'WALMART_BUY_BOX', kind: 'PULL', hasBuyboxWinner: true, hasFulfilment: false };
  assert.deepEqual(strategyAvailability(beat({ competeWith: 'CHANNEL' }), [amazon]), { available: true, via: 'AMAZON_ANY_OFFER_CHANGED' });
  assert.deepEqual(strategyAvailability(beat({ anchor: 'LOWER_OF_TWO', competeWith: 'CHANNEL' }), [amazon]), { available: true, via: 'AMAZON_ANY_OFFER_CHANGED' });
  assert.deepEqual(strategyAvailability(beat({ anchor: 'BUYBOX' }), [amazon]), { available: true, via: 'AMAZON_ANY_OFFER_CHANGED' });
  assert.deepEqual(strategyAvailability(beat({ anchor: 'BUYBOX', competeWith: 'CHANNEL' }), [amazon]), { available: false, unmet: { AMAZON_ANY_OFFER_CHANGED: ['BUYBOX_WINNER'] } });
  assert.deepEqual(strategyAvailability(match({ competeWith: 'MERCHANT' }), [amazon]), { available: false, unmet: { AMAZON_ANY_OFFER_CHANGED: ['BUYBOX_WINNER'] } });
  // Walmart не называет исполнение (W-05): фильтр недоступен, без фильтра стратегия доступна
  assert.deepEqual(strategyAvailability(win({ competeWith: 'CHANNEL' }), [walmart]), { available: false, unmet: { WALMART_BUY_BOX: ['FULFILMENT'] } });
  assert.deepEqual(strategyAvailability(win(), [walmart]), { available: true, via: 'WALMART_BUY_BOX' });
});
