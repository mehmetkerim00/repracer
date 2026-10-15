import { systemClock } from '@repracer/channel-port';
import { US_STOREFRONTS } from '@repracer/console-model';
import type { LiveWorld } from '@repracer/contract-tests/stand';
import { addUsAccounts, channelPipeline, type DemoWorldPools } from './demo-world.ts';

/**
 * Шаг 91 (вид преп-центра): рядом с главным демо — два ЛЁГКИХ продавца с американскими именами. Зачем: на вопрос «как я увижу своих
 * продавцов?» отвечает экран «Your workspaces», а не слова. Продукт это уже умеет — рабочие пространства и одна роль на человека в
 * каждом [Р-9, Р-213]; шаг сеет данные, а не экраны и не права.
 *
 * Каждый продавец — своё пространство (тенант) с признаком демо [Р-151]: витрины amazon.com и ebay.com в ТЕНИ [Р-169], каталог —
 * функцией обнаружения, себестоимость, границы и стратегии — тем же модулем, что у главного демо (`demo-us.ts`). Владелец пространства —
 * синтетический продавец; владелец стенда (owner@stand) входит туда приглашением на роль: менеджером у одного, наблюдателем у
 * другого. Предложений у лёгких продавцов меньше, неделя тени — та же, что у главного демо: подготовка выросла на секунды (замер шага 91).
 * Данные синтетические.
 */

export interface DemoSellerSpec {
  /** Часть адреса мира: `demo/<key>` */
  key: string;
  /** Имя продавца — собственное имя, на всех языках одно */
  title: string;
  /** Слот членства стенда, через который владелец стенда входит в пространство, — и его роль (DEFAULT_MEMBERS) */
  slot: 'membership-manager' | 'membership-viewer';
  /** Предложений у каждого из двух аккаунтов (amazon.com, ebay.com) */
  offers: number;
  /** С какого номера синтетического названия товара начинаются предложения каналов */
  titles: { amazon: number; ebay: number };
}

/** Шаг 91: два лёгких продавца — Manager у одного, Viewer у другого (Р-213: одна роль на человека в пространстве) */
export const DEMO_SELLERS: readonly DemoSellerSpec[] = [
  { key: 'blue-ridge', title: 'Blue Ridge Trading', slot: 'membership-manager', offers: 6, titles: { amazon: 80, ebay: 90 } },
  { key: 'lakeside', title: 'Lakeside Home Goods', slot: 'membership-viewer', offers: 5, titles: { amazon: 120, ebay: 130 } },
];

/** Шаг 91: сколько суток тени прожать у лёгкого продавца — по умолчанию неделя, как у главного демо (недельное письмо и график полные) */
export const DEMO_SELLER_PRESS_DAYS = 7;

export interface RunningDemoSellers {
  worlds: LiveWorld[];
  /** Сколько секунд заняли посев и прожатие обоих продавцов */
  seconds: number;
  stop(): void;
}

export async function startDemoSellers(options: {
  pools: DemoWorldPools;
  pgUrl: string;
  pgUrlsByRole?: Readonly<Record<'admin' | 'bulk_worker' | 'stock', string>>;
  /** Номер первого посева: у каждого продавца свой тенант */
  tag: number;
  /** Пользователь владельца стенда и вход на роль слота — тем же путём, что у участника стенда (приглашение и приём) */
  standOwnerUserId: string;
  standOwnerEmail: string;
  joinAs: NonNullable<Parameters<typeof import('@repracer/pricing-store-pg').seedPricingWorld>[1]['joinMember']>;
  pressDays?: number;
  locale?: 'de' | 'en';
  timeZone?: string | null;
  log?: (message: string) => void;
}): Promise<RunningDemoSellers> {
  const log = options.log ?? ((m: string) => console.log(m));
  const started = systemClock.nowMs();
  const { randomUUID } = await import('node:crypto');
  const { seedPricingWorld, PgPricingStore, PgStockStore, PgShadowStore } = await import('@repracer/pricing-store-pg');
  const { createStockPipeline } = await import('@repracer/stock-sync');
  const { runConfiguredWorker } = await import('./bulk-worker.ts');
  const { startDemoUsMarket } = await import('./demo-us.ts');
  const { pools } = options;
  const AMAZON_US = US_STOREFRONTS.AMAZON![0]!;
  const { rows: [region] } = await pools.app.query(`SELECT current_setting('repracer.region', true) AS region`);
  const pressDays = options.pressDays ?? DEMO_SELLER_PRESS_DAYS;

  const worlds: LiveWorld[] = [];
  const markets: Array<{ stop(): void }> = [];
  const descriptors: Array<{ id: string; title: string; tenantId: string; accounts: unknown[]; description: string }> = [];
  for (const [i, spec] of DEMO_SELLERS.entries()) {
    const tag = options.tag + i;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    const seeded = await seedPricingWorld(pools.app, {
      fixtureTenantId: `10000000-0000-4000-8000-00000000${String(tag).padStart(4, '0')}`,
      fixtureChannelAccountId: `20000000-0000-4000-8000-00000000${String(tag).padStart(4, '0')}`,
      fixtureChannel: 'AMAZON', fixtureRegion: 'NA', fixtureExternalAccountId: `A1SYNSELLER${suffix.toUpperCase()}`,
      marketplaces: [AMAZON_US], clock: systemClock.now() as never, seed: { scopes: [], marketplaces: { [AMAZON_US]: { currency: 'USD', basis: 'NET' } } } as never,
      provisioningPool: pools.provisioning, adminPool: pools.admin, tenantRegion: region?.region === 'US' ? 'US' : 'EU',
      writeMode: 'SHADOW', demo: true,
      // Владелец пространства — синтетический продавец; владелец стенда входит на роль слота
      memberUsers: { [spec.slot]: options.standOwnerUserId }, memberEmails: { [spec.slot]: options.standOwnerEmail }, joinMember: options.joinAs,
    });
    const store = new PgPricingStore(pools.app, { adminPool: pools.admin, bulkWorkerPool: pools.bulkWorker });
    if (options.locale || options.timeZone) {
      const saved = await store.setTenantDisplay(seeded.tenantId, { ...(options.locale ? { locale: options.locale } : {}), ...(options.timeZone ? { timeZone: options.timeZone } : {}) },
        { userId: seeded.userId, mfa: true });
      if (saved.status !== 'SAVED') throw new Error(`demo seller display settings refused: ${saved.status}`);
    }
    const actor = { membershipId: seeded.ownerMembershipId, userId: seeded.userId, mfa: true };
    const pathSaved = await store.saveOnboardingProgress(seeded.tenantId, { path: 'STOCK_AND_PRICING' }, actor);
    if (pathSaved !== 'SAVED') throw new Error(`demo seller onboarding path refused: ${pathSaved}`);
    const us = await addUsAccounts(pools, seeded, store as never, seeded.channelAccountId, false, spec.offers);
    markets.push(await startDemoUsMarket({
      pools: { admin: pools.admin, scheduler: pools.scheduler }, store,
      accounts: { tenantId: seeded.tenantId, userId: seeded.userId, ownerMembershipId: seeded.ownerMembershipId, ebayAccountId: us.ebay, amazonAccountId: us.amazon, walmartAccountId: null },
      pressDays, log: (m) => log(`${spec.title}: ${m}`), titleOffsets: { ...spec.titles, walmart: 0 },
    }));
    const stock = new PgStockStore({ adminPool: pools.admin, stockPool: pools.stock });
    const nowIso = () => systemClock.now();
    const accounts = us.accounts;
    const descriptor = { id: `demo/${spec.key}`, title: spec.title, tenantId: seeded.tenantId, accounts, description: '', ownName: true };
    descriptors.push(descriptor);
    worlds.push({
      id: descriptor.id, title: descriptor.title, description: descriptor.description, ownName: true,
      tenantId: seeded.tenantId, accounts, identityTenantId: seeded.tenantId, membershipAlias: (id: string) => id, failures: [],
      landing: 'shadow' as const,
      store: store as never, stock, stockPipeline: createStockPipeline({ store: stock, now: () => systemClock.now() as never }),
      shadow: new PgShadowStore({ adminPool: pools.admin }),
      display: async () => {
        const d = await store.tenantDisplay(seeded.tenantId);
        return { locale: d.locale, timeZone: d.timeZone, timeZoneSet: d.timeZoneSet, followsRequestLocale: true };
      },
      pipeline: channelPipeline(null, accounts, store, nowIso) as never,
      clock: { iso: nowIso, nowMs: () => systemClock.nowMs() } as never,
      callContext: (channelAccountId: string) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'console-demo-seller', deadline: nowIso() }),
      view: async (viewer: unknown, viewOptions?: { scopeIds?: readonly string[] }) => ({
        ...descriptor, now: nowIso(), viewer: { ...(viewer as object) }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never, viewOptions),
      }) as never,
    } as unknown as LiveWorld);
  }

  // Массовые операции лёгких продавцов — одним исполнителем на оба пространства: менеджер Blue Ridge может их начать
  let stopped = false;
  let stopWorker = false;
  void runConfiguredWorker({
    pgUrl: options.pgUrl, idleMs: 500, worlds: descriptors.map((descriptor) => ({ descriptor: descriptor as never, now: 'WALL_CLOCK' as const })),
    ...(options.pgUrlsByRole ? { pgUrlsByRole: options.pgUrlsByRole } : {}),
  }, () => stopWorker).catch((error: unknown) => { if (!stopped) log(`demo sellers bulk worker stopped: ${error instanceof Error ? error.message : String(error)}`); });
  const seconds = Math.round((systemClock.nowMs() - started) / 100) / 10;
  log(`demo sellers ready: ${DEMO_SELLERS.map((s) => `${s.title} (${s.offers} offers each on amazon.com and ebay.com)`).join(', ')}, ${pressDays} days pressed, ${seconds} s`);
  return {
    worlds, seconds,
    stop() {
      stopped = true;
      for (const m of markets) m.stop();
      stopWorker = true;
    },
  };
}
