import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CompetitorOffer, CompetitorSnapshot } from '@repracer/channel-port';
import { buyboxDiagnosis, buyboxShare, competitorColumns, type ShareSpan } from './competition.ts';
import { messagesFor } from './i18n/index.ts';

/**
 * Шаг 97, I2 и I4. I2 — доля Buy Box по снимкам с дырами: время без данных не входит ни в числитель, ни в знаменатель, его показывает
 * покрытие. I4 — диагностика «почему не в Buy Box» называет только то, что канал дал: нет рейтинга — нет строки о рейтинге, нет доставки
 * у обоих — нет разрыва «с доставкой», держатель неизвестен — диагностики нет вовсе. Данные синтетические.
 */

const H = 3_600_000;
const T0 = Date.parse('2026-10-05T00:00:00.000Z');
const at = (hours: number) => new Date(T0 + hours * H).toISOString();
const span = (holder: ShareSpan['holder'], from: number, seen: number): ShareSpan => ({ holder, startedAt: at(from), lastSeenAt: at(seen) });

test('I2: Buy Box share — each reading counts until the next one or 24 h, holes count neither way, coverage names them', () => {
  // наше 0–12 ч (до следующего отрезка); чужое 12 ч — до 18 ч + 24 ч = 42 ч (дальше дыра до 60 ч); наше 60–72 ч (конец периода)
  const spans = [span('SELF', 0, 6), span('OTHER', 12, 18), span('SELF', 60, 68)];
  const s = buyboxShare(spans, T0, T0 + 72 * H);
  assert.deepEqual(s, { ownMs: 24 * H, knownMs: 54 * H, totalMs: 72 * H, shareBp: Math.round((24 / 54) * 10_000), coverageBp: 7500 });
  // порядок отрезков на входе не важен
  assert.deepEqual(buyboxShare([...spans].reverse(), T0, T0 + 72 * H), s);
  // начало периода внутри первого отрезка — отрезок обрезается периодом
  assert.equal(buyboxShare(spans, T0 + 6 * H, T0 + 72 * H).ownMs, 18 * H);
  // «никто не держит» — время известное, но не наше
  const none = buyboxShare([span('NONE', 0, 10), span('SELF', 10, 10)], T0, T0 + 20 * H);
  assert.deepEqual([none.ownMs, none.knownMs, none.shareBp], [10 * H, 20 * H, 5000]);
  // снимков нет — доли нет (null), а не 0 %
  assert.deepEqual(buyboxShare([], T0, T0 + 24 * H), { ownMs: 0, knownMs: 0, totalMs: 24 * H, shareBp: null, coverageBp: 0 });
});

const money = (v: number) => ({ amountMinor: v, currency: 'USD', basis: 'NET' as const });
const offer = (o: Omit<Partial<CompetitorOffer>, 'price'> & { price: number }): CompetitorOffer => ({ isSelf: false, ...o, price: money(o.price) });
const snapshot = (offers: CompetitorSnapshot['offers'], buybox: CompetitorSnapshot['buybox']): CompetitorSnapshot => ({
  marketplace: 'walmart.com', channelProductRef: 'SYN-1', condition: 'NEW', source: 'SYN', observedAt: at(0) as never,
  completeness: { kind: 'TOP_N', n: 10 }, offers, ...(buybox ? { buybox } : {}),
});

test('I4: the diagnosis names only what the channel gave — no rating, no fulfilment, no shipping means no such reason', () => {
  // канал назвал держателя и цены, но не доставку, исполнение и рейтинг — ни одной причины не выдумано
  const bare = snapshot([offer({ sellerRef: 'Harbor Goods', holdsBuyBox: true, price: 1750 }), offer({ isSelf: true, price: 1899 })],
    { price: money(1750), isSelf: false, sellerRef: 'Harbor Goods' });
  assert.deepEqual(buyboxDiagnosis(bare, 1500), [], 'nothing named — nothing said');
  // всё названо: разрыв с доставкой, пол, исполнение каналом, рейтинг
  const full = snapshot([
    offer({ sellerRef: 'Harbor Goods', holdsBuyBox: true, price: 1750, shipping: money(0), fulfillment: 'AFN', rating: { positivePct: 97, count: 4210 } }),
    offer({ isSelf: true, price: 1899, shipping: money(0), fulfillment: 'MFN', rating: { positivePct: 92, count: 860 } }),
  ], { price: money(1750), isSelf: false, sellerRef: 'Harbor Goods', shipping: money(0) });
  assert.deepEqual(buyboxDiagnosis(full, 1899), [
    { kind: 'PRICE_GAP', gapMinor: 149 }, { kind: 'FLOOR', floorMinor: 1899 }, { kind: 'FULFILMENT' }, { kind: 'RATING', winnerPct: 97, ownPct: 92 },
  ]);
  // ниже пола цена не стоит — пол не называется; рейтинг одного только победителя — не сравнение
  const half = snapshot([
    offer({ sellerRef: 'Harbor Goods', holdsBuyBox: true, price: 1750, shipping: money(0), rating: { positivePct: 97, count: 4210 } }),
    offer({ isSelf: true, price: 1899, shipping: money(0) }),
  ], { price: money(1750), isSelf: false, sellerRef: 'Harbor Goods', shipping: money(0) });
  assert.deepEqual(buyboxDiagnosis(half, 1500), [{ kind: 'PRICE_GAP', gapMinor: 149 }]);
  // цена не причина: мы не дороже победителя с доставкой
  const cheaper = snapshot([offer({ sellerRef: 'Pine & Co', holdsBuyBox: true, price: 1800, shipping: money(399) }), offer({ isSelf: true, price: 1799, shipping: money(0) })],
    { price: money(1800), isSelf: false, sellerRef: 'Pine & Co', shipping: money(399) });
  assert.deepEqual(buyboxDiagnosis(cheaper, null), [{ kind: 'PRICE_NOT_THE_REASON' }]);
  // держатель неизвестен (Amazon, A-29) или Buy Box наш — диагностики нет
  assert.equal(buyboxDiagnosis(snapshot(full.offers, { price: money(1750), isSelf: null }), 1500), null);
  assert.equal(buyboxDiagnosis(snapshot(full.offers, { price: money(1899), isSelf: true }), 1500), null);
});

test('I4: the competitor table shows no column the channel did not give and turns a one-value column into a caption (96.2 rule)', () => {
  const m = messagesFor('en');
  const row = (fulfilment: string | null, rating: string | null, buyBox: boolean | null) => ({ fulfilment, rating, buyBox, landedKnown: true });
  // Walmart: исполнения и рейтинга нет — колонок нет, подписи о них тоже
  assert.deepEqual(competitorColumns([row(null, null, true), row(null, null, false), row(null, null, false)], m),
    { fulfilment: false, rating: false, buyBox: true, landedKnown: true, uniform: [] });
  // одно значение у трёх строк — фраза подписи, а не колонка
  const uniform = competitorColumns([row('Seller', null, null), row('Seller', null, null), row('Seller', null, null)], m);
  assert.deepEqual([uniform.fulfilment, uniform.buyBox, uniform.uniform], [false, false, [m.ui.competition.uniform(m.ui.competition.columns.fulfilment, 'Seller')]]);
  // разные значения — колонка
  assert.equal(competitorColumns([row('Seller', null, null), row('Amazon (FBA)', null, null), row('Seller', null, null)], m).fulfilment, true);
  // цена с доставкой известна не у всех — колонка называется «Price», подпись говорит почему
  assert.equal(competitorColumns([{ ...row(null, null, null), landedKnown: false }], m).landedKnown, false);
});

/** Решение владельца после шага 97.1: возраст снимка — в квитанции решения; старше свежести — сказано, почему так можно */
test('step 97.3: the receipt names the age of the reading; an older one says it served only a raise step while the Buy Box was ours', async () => {
  const { readingAgeText } = await import('./trace.ts');
  const m = messagesFor('en');
  assert.equal(readingAgeText('2026-10-17T10:00:00.000Z', '2026-10-17T10:04:30.000Z', m), m.ui.trace.ageValue(4));
  assert.equal(readingAgeText('2026-10-17T10:00:00.000Z', '2026-10-17T10:00:20.000Z', m), m.ui.trace.ageValue(0));
  assert.equal(readingAgeText('2026-10-17T10:00:00.000Z', '2026-10-17T10:22:00.000Z', m), m.ui.trace.ageQuiet(22));
});

/**
 * Шаг 100 (E, вопрос владельца по скринам): чип «кто подвинул цену» шаг 97 поставил в журнал цен — но только в вид записей в канал.
 * Вид «все решения» (Kind: All decisions) показывал в колонке Reason одну фразу Gate. Строка решения, вызванного движением конкурента,
 * несёт тот же короткий чип; полная фраза — подсказкой и на квитанции
 */
test('step 100 (E): a decision row names the competitor move with the same short chip as a write row', async () => {
  const { decisionItems, triggerPhrase } = await import('./trace.ts');
  const m = messagesFor('en');
  const world = { state: { scopes: [], explanationRulesets: [], strategies: [] } } as never;
  const view = { currency: 'USD', trigger: { seller: 'North Ridge Supply', move: 'DOWN' as const, wasMinor: 1800, nowMinor: 1757 }, offers: [] };
  const decision = (competitorView: unknown) => ({
    decisionId: 'd-1', writeScopeId: 'ws-1', outcome: 'APPROVED', explanation: null, noChangeReason: null, reason: { code: 'APPROVED', params: {} },
    currency: 'USD', finalMinor: 1756, proposedMinor: 1756, decidedAt: '2026-10-17T21:21:00Z', boundDeviationBp: null, competitorView,
  }) as never;
  const [moved, quiet] = decisionItems(world, [decision(view), decision(null)], m);
  assert.deepEqual(moved!.trigger, { chip: 'North Ridge Supply ↓ $17.57', full: triggerPhrase(view, 'USD', m) });
  assert.equal(quiet!.trigger, null, 'no competitor move — no chip');
});
