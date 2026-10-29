import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { buyboxFacts, competitionSummaryView, couponLanded, type ShareSpan } from './competition.ts';
import { messagesFor } from './i18n/index.ts';

/**
 * Шаг 109 [Р-234, Р-235]: страница Competition и квитанция. Доля Buy Box Amazon считается по отрезкам, которые пишет сверка (держатель
 * большинства просмотров), хотя держатель в снимке уведомления по-прежнему неизвестен; последняя сводка показывает группы покупателей
 * «72% of views: Cedar Lane» и купоны «$17.15 ($16.29 with coupon)»; квитанция — купон, если он был в снимке решения. Данные синтетические
 */

const H = 3_600_000;
const T0 = Date.parse('2026-10-29T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * H).toISOString();
const usd = (v: number) => ({ amountMinor: v, currency: 'USD', basis: 'NET' as const });
const AMAZON = [
  { source: 'AMAZON_ANY_OFFER_CHANGED', role: 'PRIMARY', hasBuyboxWinner: false },
  { source: 'AMAZON_COMPETITIVE_SUMMARY', role: 'RECONCILIATION', hasBuyboxWinner: false, holderByViewShare: true },
];
const notification: CompetitorSnapshot = { marketplace: 'ATVPDKIKX0DER', channelProductRef: 'B0SYN00109', condition: 'new', source: 'AMAZON_ANY_OFFER_CHANGED', observedAt: at(10) as never,
  completeness: { kind: 'TOP_N', n: 20 }, buybox: { price: usd(1715), isSelf: null }, offers: [{ isSelf: false, sellerRef: 'Cedar Lane', price: usd(1715), shipping: usd(0) }] };

test('step 109 [Р-235]: Amazon — the holder of the notification stays unknown, yet the Buy Box share counts the spans of the summaries', () => {
  const spans: ShareSpan[] = [{ holder: 'OTHER', startedAt: at(0), lastSeenAt: at(4) }, { holder: 'SELF', startedAt: at(6), lastSeenAt: at(8) }];
  const input = { snapshot: { snapshot: notification, source: notification.source, observedAt: at(10) }, spans, range: { since: at(0), until: at(12) } };
  const facts = buyboxFacts({ ...input, sources: AMAZON });
  assert.equal(facts.holder, 'UNKNOWN', 'the notification still does not name the holder (A-29)');
  assert.equal(facts.shareNamed, true);
  assert.equal(facts.share?.shareBp, 5000, 'ours 6–12 h of the 12 h with a known holder');
  const without = buyboxFacts({ ...input, sources: [AMAZON[0]!] });
  assert.equal(without.share, null, 'no source names the holder — no share');
});

const summary = (segments: Array<[string | null, string, number]>, offers: CompetitorSnapshot['offers'] = []): { snapshot: CompetitorSnapshot; source: string; observedAt: string } => ({
  source: 'AMAZON_COMPETITIVE_SUMMARY', observedAt: at(9),
  snapshot: { marketplace: 'ATVPDKIKX0DER', channelProductRef: 'B0SYN00109', condition: 'new', source: 'AMAZON_COMPETITIVE_SUMMARY', observedAt: at(9) as never,
    completeness: { kind: 'TOP_N', n: 20 }, offers,
    buyboxSegments: segments.map(([seller, membership, viewSharePct]) => ({ ...(seller ? { sellerRef: seller } : {}), isSelf: seller === null, membership, viewSharePct })) },
});
const ctx = { channel: 'AMAZON', channelName: 'Amazon', marketplace: 'ATVPDKIKX0DER', demo: true, currency: 'USD' };

test('step 109 [Р-234, Р-235]: the summary block — «72% of views: Cedar Lane» per customer group, the majority holder and the coupons', () => {
  const m = messagesFor('en');
  const view = competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 72], ['Pine & Co', 'NON_PRIME', 18], ['Cedar Lane', 'PRIME', 10]], [
    { isSelf: false, sellerRef: 'Pine & Co', price: usd(1715), shipping: usd(250), totalPrice: usd(1965), couponPrice: usd(1629) },
    { isSelf: false, sellerRef: 'Cedar Lane', price: usd(1811), shipping: usd(250), totalPrice: usd(2061) },
  ]), ctx, m)!;
  assert.equal(view.title, 'Amazon competitive summary');
  assert.deepEqual(view.segments.map((s) => `${s.share}${m.colon}${s.seller} · ${s.group}`),
    ['72% of views: Cedar Lane · non-Prime customers', '18% of views: Pine & Co · non-Prime customers', '10% of views: Cedar Lane · Prime customers']);
  assert.equal(view.holder, 'Cedar Lane has most of the views (82%) and counts as the Buy Box holder in your share.', 'the shares of one seller add up');
  assert.deepEqual(view.coupons.map((c) => `${c.seller}${m.colon}${c.price} ${m.ui.competition.withCoupon(c.coupon)}`), ['Pine & Co: $19.65 ($18.79 with coupon)'],
    'the coupon is of the same kind as the price — with the same shipping');
  assert.ok(view.couponNote?.includes('base price'), 'the page says prices are decided on the base price');
  assert.equal(view.observed.at, at(9), 'the summary has its own moment');
});

test('step 109 [Р-235]: no majority, our own majority, an unknown group and a summary with nothing to add', () => {
  const m = messagesFor('en');
  assert.equal(competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 50], ['Pine & Co', 'PRIME', 50]]), ctx, m)!.holder,
    'No seller has more than half of the views, so this reading is not counted in your share.');
  const own = competitionSummaryView(summary([[null, 'DEFAULT', 60], ['Pine & Co', 'SOMETHING_NEW', 40]]), ctx, m)!;
  assert.equal(own.holder, 'You have most of the views (60%), which counts as yours in your share.');
  assert.deepEqual(own.segments.map((s) => [s.seller, s.self, s.group]), [['You', true, 'Prime status unknown'], ['Pine & Co', false, 'other customers']],
    'a group the dictionary does not know is said in words, not as a code');
  assert.equal(competitionSummaryView(summary([], [{ isSelf: false, sellerRef: 'Pine & Co', price: usd(1715) }]), ctx, m), null, 'no groups and no coupons — no block');
  assert.equal(competitionSummaryView(null, ctx, m), null);
});

test('step 109 [Р-234]: every language says the summary in its own words', () => {
  for (const locale of ['de', 'es', 'fr'] as const) {
    const m = messagesFor(locale);
    const view = competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 72], ['Cedar Lane', 'PRIME', 10]], [{ isSelf: false, sellerRef: 'Pine & Co', price: usd(1715), couponPrice: usd(1629) }]), ctx, m)!;
    const en = messagesFor('en');
    assert.notEqual(view.title, competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 72]]), ctx, en)!.title, `${locale}: the title is translated`);
    assert.notEqual(view.holder, null);
    assert.ok(!/views|with coupon|base price/.test(`${view.holder} ${view.couponNote} ${view.segments[0]!.share} ${m.ui.competition.withCoupon('$1')}`), `${locale}: no English left`);
  }
});

test('step 109 [Р-234]: the coupon price — below the price, in its currency, with the same shipping as the price it stands next to', () => {
  assert.equal(couponLanded({ price: usd(1715), shipping: usd(250), totalPrice: usd(1965), couponPrice: usd(1629) }), 1879);
  assert.equal(couponLanded({ price: usd(1715), couponPrice: usd(1629) }), 1629, 'no shipping named — the coupon price alone, like the price');
  assert.equal(couponLanded({ price: usd(1715), couponPrice: usd(1715) }), null, 'not below the price — not a coupon');
  assert.equal(couponLanded({ price: usd(1715), couponPrice: { amountMinor: 1600, currency: 'EUR', basis: 'GROSS' } }), null, 'another currency — not a coupon');
  assert.equal(couponLanded({ price: usd(1715) }), null);
});

test('step 109 [Р-234]: the receipt shows the coupon of the decision snapshot next to the price of the row', async () => {
  const { traceCompetitors } = await import('./trace.ts');
  const m = messagesFor('en');
  const world = { accounts: [], state: { scopes: [], demo: false } } as never;
  const decision = { writeScopeId: 'ws-1', competitorView: { currency: 'USD', trigger: null, offers: [
    { seller: 'Harbor Goods', self: false, priceMinor: 1800, shippingMinor: 0, landedMinor: 1800, couponMinor: 1650, holdsBuyBox: true },
    { seller: null, self: true, priceMinor: 1900, shippingMinor: 250, landedMinor: 2150 },
  ] } } as never;
  const rows = traceCompetitors(decision, world, m).rows;
  assert.deepEqual(rows.map((r) => [r.seller, r.landed, r.coupon]), [['Harbor Goods', '$18.00', '$16.50'], ['You', '$21.50', null]]);
});

/**
 * Шаг 109.1 [Р-234, Р-71]: снимок сверки идёт мимо проверки входов (`CURRENCY_MISMATCH` — только у снимка решения), а журнал хранит валюту
 * каждого предложения. Блок печатал сумму предложения в чужой валюте значком витрины («€21.50» как «$21.50»); теперь суммы — только в валюте
 * витрины, остальные — честной строкой: одна валюта — названа («1 offer in EUR is not shown»), несколько — общая форма
 */
test('step 109.1 [Р-234]: the summary shows amounts only in the storefront currency; offers in another currency — an honest line naming it', () => {
  const m = messagesFor('en');
  const eur = (v: number) => ({ amountMinor: v, currency: 'EUR', basis: 'GROSS' as const });
  const gbp = (v: number) => ({ amountMinor: v, currency: 'GBP', basis: 'GROSS' as const });
  const pine = { isSelf: false, sellerRef: 'Pine & Co', price: usd(1715), shipping: usd(250), totalPrice: usd(1965), couponPrice: usd(1629) };
  const rhine = { isSelf: false, sellerRef: 'Rhine GmbH', price: eur(2000), shipping: eur(150), totalPrice: eur(2150), couponPrice: eur(1840) };
  const view = competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 72]], [pine, rhine]), ctx, m)!;
  assert.deepEqual(view.coupons.map((c) => `${c.seller}${m.colon}${c.price} ${m.ui.competition.withCoupon(c.coupon)}`), ['Pine & Co: $19.65 ($18.79 with coupon)'],
    'the euro offer is not printed with the dollar sign of the storefront');
  assert.equal(view.hidden, '1 offer in EUR is not shown', 'one currency — the line names it');
  assert.ok(!/€|\$21\.50|\$19\.90/.test(JSON.stringify(view)), 'no amount of the euro offer anywhere in the block');
  const two = competitionSummaryView(summary([], [rhine, { ...rhine, sellerRef: 'Moselle SA' }]), ctx, m)!;
  assert.ok(two, 'a summary whose only amounts are in another currency still says so');
  assert.deepEqual(two.coupons, []);
  assert.equal(two.hidden, '2 offers in EUR are not shown');
  assert.equal(two.couponNote, null, 'no coupon shown — no note about coupons');
  const mixed = competitionSummaryView(summary([], [rhine, { ...rhine, sellerRef: 'Thames Ltd', price: gbp(2000), shipping: gbp(150), totalPrice: gbp(2150), couponPrice: gbp(1840) }]), ctx, m)!;
  assert.equal(mixed.hidden, '2 offers in other currencies are not shown', 'several currencies — the general form');
  assert.equal(competitionSummaryView(summary([['Cedar Lane', 'NON_PRIME', 72]], [pine]), ctx, m)!.hidden, null, 'all in the storefront currency — no line');
  for (const lang of ['de', 'es', 'fr'] as const) {
    const l = messagesFor(lang);
    const one = competitionSummaryView(summary([], [rhine]), ctx, l)!;
    assert.ok(one.hidden && one.hidden.includes('EUR') && one.hidden !== '1 offer in EUR is not shown', `${lang}: the line is translated and names the currency`);
  }
});
