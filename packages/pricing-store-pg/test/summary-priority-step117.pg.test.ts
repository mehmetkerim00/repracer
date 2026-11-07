import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { prioritizedWindow, summaryRounds, type MemorySeedScope } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { PgPricingStore, seedPricingWorld, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 117 (P0-16, решение владельца 2026-11-07): в круге опроса сводки первыми читаются предложения, чью цену решает конкурент; выключенные и с фиксированной
 * ценой — по остатку. На PostgreSQL признак считает запрос окна (движок включён и стратегия из данных конкурентов); остальным — своя доля мест окна, не меньше
 * одного: конкурентное, прочитанное час назад, идёт раньше выключенного, прочитанного шесть часов назад, и выключенное не голодает. Данные синтетические
 */
const TENANT = '10000000-0000-4000-8000-000000001171';
const ACCOUNT = '20000000-0000-4000-8000-000000001171';
const COST: CostInputs = { currency: 'EUR', costProfileId: 'cp-1171', unitCostMinor: 500, fixedFeeMinor: 0, feeRateBp: 1500, tax: { regime: 'VAT_INCLUDED', vatRateBp: 1900 } };
const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const FIXED = { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2400 }, deadbandMinor: 0 } as const;
const scope = (n: number, mode: 'ENGINE' | 'OFF', strategy: MemorySeedScope['strategy']): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(11700 + n),
  externalOfferId: `SYN-OFFER-117-${n}`, channelProductRef: `11710${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: mode, strategy,
  currentPriceMinor: 2400, cost: COST, minPrice: { amountMinor: 1800, id: `min-${n}` }, maxPrice: { amountMinor: 5000, id: `max-${n}` },
});

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  db = await createIsolatedDatabase('summaryprio');
  world = await seedPricingWorld(db.pool('svc_app', 2), {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2), fixtureTenantId: TENANT, fixtureChannelAccountId: ACCOUNT,
    marketplaces: ['de'], clock: new Date().toISOString(),
    // 1 и 4 — цена от конкурента; 2 — выключено; 3 — фиксированная цена движком
    seed: { scopes: [scope(1, 'ENGINE', BEAT), scope(2, 'OFF', null), scope(3, 'ENGINE', FIXED), scope(4, 'ENGINE', BEAT)] },
  });
  store = new PgPricingStore(db.pool('svc_app', 2));
});

after(async () => { await db?.drop(); });

test('step 117 (P0-16): on PostgreSQL the summary window reads offers priced from competitors first — an hour old beats six hours old', async () => {
  const account = world.ids.dbId(ACCOUNT);
  const q = (n: number) => ({ marketplace: 'de', channelProductRef: `11710${n}`, condition: 'new' as const });
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString() as never;
  await store.markPolled(world.tenantId, account, [q(1)], ago(60));
  await store.markPolled(world.tenantId, account, [q(2)], ago(360));
  await store.markPolled(world.tenantId, account, [q(3)], ago(180));
  await store.markPolled(world.tenantId, account, [q(4)], ago(10));
  const { queries, total, competitive } = await store.pickRotationWindow(world.tenantId, account, 2, 0);
  assert.deepEqual([total, competitive], [4, 2], 'two of four offers are priced from competitors');
  // Окно 2: одно место конкурентным (самое давнее — 1), одно остальным (самое давнее — 2)
  assert.deepEqual(queries.map((x) => x.channelProductRef), ['117101', '117102'], 'the stalest competitive, then the stalest of the rest');
  const all = await store.pickRotationWindow(world.tenantId, account, 4, 0);
  assert.deepEqual(all.queries.map((x) => x.channelProductRef), ['117101', '117104', '117102', '117103'], 'competitive first; the free places go to the rest');
});

test('step 117 (P0-16): never read comes first, competitive before the rest; the rest is never starved — the two rounds are the formula of the paragraph', () => {
  const q = (n: number) => ({ marketplace: 'de', channelProductRef: `r${n}`, condition: 'new' as const });
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  const window = prioritizedWindow([
    { query: q(1), lastSeenMs: now - 60_000, competitive: true }, { query: q(2), lastSeenMs: null, competitive: false }, { query: q(3), lastSeenMs: null, competitive: true },
  ], 3, 0);
  assert.deepEqual(window.map((x) => x.channelProductRef), ['r3', 'r1', 'r2']);
  // 1 000 конкурентных из 10 000: остальным 5 мест из 20 (доля с весом 1/24) — конкурентный круг 67 окон (~35 мин), полный — 1 800 окон (~15,5 ч)
  assert.deepEqual(summaryRounds({ competitive: 1000, other: 9000, batch: 20, intervalSeconds: 31 }), { competitiveSeconds: 67 * 31, fullSeconds: 1800 * 31 });
  assert.deepEqual(summaryRounds({ competitive: 1000, other: 0, batch: 20, intervalSeconds: 31 }), { competitiveSeconds: 50 * 31, fullSeconds: 50 * 31 });
  assert.deepEqual(summaryRounds({ competitive: 0, other: 10_000, batch: 20, intervalSeconds: 31 }), { competitiveSeconds: 0, fullSeconds: 500 * 31 });
  // Без голодания: смоделированный круг на 1 000 + 9 000 читает каждое предложение, а конкурентное — не реже раза в конкурентный круг
  const items = Array.from({ length: 200 }, (_, i) => ({ query: q(i), lastSeenMs: null as number | null, competitive: i < 20 }));
  const reads = new Map<string, number[]>();
  for (let cycle = 0; cycle < 400; cycle++) {
    const at = now + cycle * 31_000;
    for (const x of prioritizedWindow(items, 20, cycle)) {
      reads.set(x.channelProductRef, [...(reads.get(x.channelProductRef) ?? []), at]);
      items.find((it) => it.query === x)!.lastSeenMs = at;
    }
  }
  assert.equal(reads.size, 200, 'every offer is read');
  const { competitiveSeconds, fullSeconds } = summaryRounds({ competitive: 20, other: 180, batch: 20, intervalSeconds: 31 });
  const longestGap = (ref: string) => Math.max(...(reads.get(ref) ?? []).slice(-6).slice(1).map((t, i, a) => t - (i === 0 ? reads.get(ref)!.slice(-6)[0]! : a[i - 1]!)));
  assert.ok(longestGap('r0') <= (competitiveSeconds + 31) * 1000, `a competitive offer waits ${longestGap('r0') / 1000} s, the round is ${competitiveSeconds} s`);
  assert.ok(longestGap('r150') <= (fullSeconds + 31) * 1000, `the rest waits ${longestGap('r150') / 1000} s, the full round is ${fullSeconds} s`);
});
