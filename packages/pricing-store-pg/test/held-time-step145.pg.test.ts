import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { AdapterCallContext, ChannelAdapter, CompetitorSnapshot, FieldWrite } from '@repracer/channel-port';
import { createPricingPipeline, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { PgPricingStore, PgShadowStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 145 (внешний аудит UX, корзина 1.2): «Held back» на экране тени и «Held by shadow mode» в журнале цен считают одни и те же
 * удержанные записи — по одному моменту. Было: тень относила удержанную запись к моменту её повода (шаг 96.1), журнал цен — к моменту,
 * когда база записала строку. В работе это одно и то же (одна транзакция), а на виртуальных часах — прожатая неделя демо, живые
 * прогоны — база ставит «сейчас», и на QA-A за 7 суток было 1 636 против 1 747. Теперь момент удержанной записи в журнале — её повод,
 * как у тени; клик по плитке открывает журнал с теми же периодом и группой. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000000145';
const HOUR = 3_600_000;
// Повод — 30 часов назад по часам приложения, строку база запишет «сейчас»: как прожатая неделя демо
const START = Date.now() - 30 * HOUR;
let clock = START;
const iso = (ms: number) => new Date(ms).toISOString();
const now = () => iso(clock);

const BEAT = { strategyId: 'st-beat', version: 1, params: { type: 'BEAT_LOWEST', undercutMinor: 1, scope: 'VISIBLE_TOP_N', compareLanded: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const scope = (n: number): MemorySeedScope => ({
  writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(14500 + n),
  channelProductRef: `14501${n}`, condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: BEAT, cost: engineCost(),
  currentPriceMinor: 1950, minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
});

let db: IsolatedDatabase;
let admin: PgPool;
let world: SeededPricingWorld;
let store: PgPricingStore;

before(async () => {
  requireEnv('REPRACER_PG_ADMIN_URL');
  db = await createIsolatedDatabase('step145');
  const pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  const scheduler = db.pool('svc_scheduler', 1);
  for (let ms = START - 24 * HOUR; ms <= Date.now() + 24 * HOUR; ms += 24 * HOUR) await scheduler.query('SELECT maintenance.ensure_partitions($1::timestamptz)', [iso(ms)]);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin, writeMode: 'SHADOW',
    fixtureTenantId: '10000000-0000-4000-8000-000000000145', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de'], clock: iso(START - HOUR),
    seed: { scopes: [scope(1), scope(2), scope(3)] } });
  store = new PgPricingStore(pool, { adminPool: admin });
  const adapter = {
    descriptor: { channel: 'KAUFLAND', scheduledRecomputeSeconds: 900, competitorSources: [{ source: 'KAUFLAND_BUYBOX', kind: 'PULL', completeness: { kind: 'TOP_N', n: 10 },
      conditions: ['new'], hasBuyboxWinner: true, hasBuyboxPrice: true, hasFulfilment: true, hasOwnRank: true, hasShipping: true, typicalStalenessSeconds: null, availability: 'AVAILABLE', role: 'PRIMARY' }] },
    async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
      return { batches: writes.map((w) => ({ batchId: `b:${w.channelWriteId}`, operation: 'TEST', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
    },
    async dispatch() { throw new Error('nothing is sent in shadow mode'); },
    async readBack() { return { observations: [], failures: [] }; },
  } as unknown as ChannelAdapter;
  const p = createPricingPipeline({ store, adapter, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: () => now() as never });
  const ctx: AdapterCallContext = { tenantId: world.tenantId as never, channelAccountId: world.ids.dbId(ACCOUNT) as never, correlationId: 'step145', deadline: iso(Date.now() + 60_000) as never };
  const eur = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
  const market = (n: number, competitor: number): CompetitorSnapshot => ({
    marketplace: 'de', channelProductRef: `14501${n}`, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt: now() as never, completeness: { kind: 'TOP_N', n: 10 },
    buybox: { price: eur(competitor), isSelf: false, shipping: eur(0), sellerRef: 'Harbor Goods' },
    offers: [{ rank: 1, sellerRef: 'Harbor Goods', isSelf: false, price: eur(competitor), shipping: eur(0), totalPrice: eur(competitor), holdsBuyBox: true },
      { rank: 2, isSelf: true, price: eur(1950), shipping: eur(0), totalPrice: eur(1950) }],
  });
  // Три предложения — три удержанные тенью цены с поводом 30 часов назад
  for (const n of [1, 2, 3]) {
    clock = START + n * 60_000;
    await p.processSnapshot(ctx, market(n, 1500));
  }
});
after(async () => { await db?.drop(); });

test('step 145: «Held back» on Shadow mode and «Held by shadow mode» in Price changes count the same held writes over the same period', async () => {
  const at = iso(Date.now());
  const shadow = (sinceDays: number) => new PgShadowStore({ adminPool: admin }).shadowPage(world.tenantId, at as never, { offset: 0, limit: 5, sinceDays });
  const feed = (sinceDays: number) => store.feedPage(world.tenantId, at as never, { sinceDays, offset: 0, limit: 50 });
  // 24 часа: поводы 30 часов назад вне окна у обоих экранов
  const day = [(await shadow(1)).summary.heldPriceWrites, (await feed(1)).counts.SHADOW_HELD];
  assert.equal(`${day[0]} = ${day[1]}`, '0 = 0', 'last 24 hours: the tile and the journal group are the same held writes');
  // 2 суток: все три у обоих
  const twoDays = [(await shadow(2)).summary.heldPriceWrites, (await feed(2)).counts.SHADOW_HELD];
  assert.equal(`${twoDays[0]} = ${twoDays[1]}`, '3 = 3', 'last 2 days: the same three held writes');
});

test('step 145: a held write is shown in Price changes at the moment of its trigger, not when the database wrote the row', async () => {
  const page = await store.feedPage(world.tenantId, iso(Date.now()) as never, { sinceDays: 2, offset: 0, limit: 50 });
  const shown = page.items.map((i) => i.at).sort();
  assert.deepEqual(shown, [1, 2, 3].map((n) => iso(START + n * 60_000)), 'the journal time of a held write is its trigger time');
});
