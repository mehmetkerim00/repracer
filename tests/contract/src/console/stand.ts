import { fileURLToPath } from 'node:url';
import { InMemoryStockStore, type MemoryStockOffer, type StockPipeline, type StockStore } from '@repracer/stock-sync';
import type { AdapterCallContext } from '@repracer/channel-port';
import type { StandAccount, StandWorld, Viewer } from '@repracer/console-model';
import { MemoryIdentityDirectory } from '@repracer/identity';
import { inviteMember, issueSignupInvitation, type PgIdentityDirectory } from '@repracer/identity/pg';
import { inTenant, type PgPool } from '@repracer/pricing-store-pg';
import { DEFAULT_MEMBERS, type PricingPipeline, type PricingStore } from '@repracer/pricing-pipeline';
import { AMAZON_DESCRIPTOR } from '@repracer/amazon-adapter';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { amazonUnderTest, kauflandUnderTest } from '../adapters.ts';
import { memoryStoreFactory, runScenario, type PricingStoreFactory } from '../harness/runner.ts';
import { loadScenarios, type Scenario } from '../harness/scenario.ts';
import type { VirtualClock } from '../harness/world.ts';

/**
 * Миры стенда для интерфейса [Р-67]: сценарии пути решения прогоняются на хранилище (в памяти или PostgreSQL), после шагов
 * хранилище остаётся живым — остановка и возобновление в интерфейсе работают на нём же. Экраны читают только порт
 * PricingStore.readConsoleState: объяснения — из слепков решений [Р-68], отчёты прогона не нужны. Каналы не подключаются.
 */

const FIXTURES = fileURLToPath(new URL('../../fixtures/kaufland/', import.meta.url));
/** Шаг 23: миры Amazon стенда — только сценарии с меткой console-stand (недоверие каналу, Automate Pricing, PRICING_HEALTH) */
const AMAZON_FIXTURES = fileURLToPath(new URL('../../fixtures/amazon/', import.meta.url));

/** Р-119: как снимается системная остановка — свойство канала из описания адаптера */
const haltReleaseOf = (channel: string) => (channel === 'AMAZON' ? AMAZON_DESCRIPTOR : KAUFLAND_DESCRIPTOR).haltRelease.kind;

/** Членства стенда [OQ-125, OQ-129]: одинаковые во всех мирах — псевдоним членства и роль */
export const STAND_USERS: readonly Viewer[] = DEFAULT_MEMBERS.map((m) => ({ ...m }));

/** Издатель и получатель токенов имитатора поставщика identity стенда [Р-78]; в работе — адрес поставщика (ADR-0013) */
export const STAND_ISSUER = 'https://identity.stand.repracer.test';
export const STAND_AUDIENCE = 'repracer-console-stand';

/**
 * Синтетические пользователи стенда: у каждого членства — свой пользователь и свой subject у имитатора поставщика.
 * userAlias совпадает с пользователем участника хранилища (DEFAULT_MEMBERS) — автор действия сверяется с ним (находка 4).
 */
export const STAND_ACCOUNTS: ReadonlyArray<{ membershipAlias: string; userAlias: string; role: Viewer['role']; subject: string; email: string; displayName: string }> = DEFAULT_MEMBERS.map((m) => ({
  membershipAlias: m.membershipId,
  userAlias: m.userId,
  role: m.role,
  subject: `stand-${m.userId}`,
  email: `${m.membershipId.slice('membership-'.length)}@stand.repracer.test`,
  displayName: `Stand ${m.role.toLowerCase().replace('_', ' ')}`,
}));

/** Адреса участников стенда (псевдоним членства → email): создание тенанта сверяет адрес существующего пользователя (находка 5, 0066) */
export const STAND_EMAILS: Readonly<Record<string, string>> = Object.fromEntries(STAND_ACCOUNTS.map((a) => [a.membershipAlias, a.email]));

/**
 * Вход участника стенда в новый мир: владелец со вторым фактором приглашает по адресу, участник принимает приглашение своим
 * входом у имитатора поставщика (находка 5 ревью шага 16 — существующий пользователь не присоединяется созданием тенанта).
 */
export function pgStandJoinMember(adminPool: PgPool, directory: PgIdentityDirectory) {
  return async (input: { tenantId: string; ownerUserId: string; membershipAlias: string; role: string; email: string }) => {
    const account = STAND_ACCOUNTS.find((a) => a.membershipAlias === input.membershipAlias);
    if (!account) throw new Error(`unknown stand member ${input.membershipAlias}`);
    const invitation = await inTenant(adminPool, input.tenantId,
      (tx) => inviteMember(tx, { tenantId: input.tenantId, email: input.email, role: input.role as never }), input.ownerUserId, { mfa: true });
    const userId = await directory.acceptInvitation(invitation.token, { issuer: STAND_ISSUER, subject: account.subject }, input.email, true);
    return { userId, membershipId: invitation.membershipId };
  };
}

export interface LiveWorld {
  id: string;
  title: string;
  description: string;
  tenantId: string;
  accounts: StandAccount[];
  /** Тенант мира в справочнике identity: членства и роли зрителя читаются по нему [Р-78] */
  identityTenantId: string;
  /** Членство из справочника identity → псевдоним членства мира (как в состоянии хранилища) */
  membershipAlias(identityMembershipId: string): string;
  /** Расхождения прогона с ожиданиями сценария: мир показывается, но с пометкой */
  failures: string[];
  store: PricingStore;
  /** Шаг 35 [Р-152, Р-153]: остатки — своё хранилище; у миров сценариев оно в памяти, у живых миров — PostgreSQL */
  stock: StockStore;
  /** Конвейер остатков: пересчёт и отправка записей (заказы канала читает планировщик) */
  stockPipeline?: StockPipeline;
  pipeline: PricingPipeline;
  clock: VirtualClock;
  callContext(channelAccountId: string): AdapterCallContext;
  view(viewer: Viewer): Promise<StandWorld>;
}

function accountsOf(scenario: Scenario): StandAccount[] {
  const { world } = scenario;
  const channel = world.account.channel ?? 'KAUFLAND';
  const accounts: StandAccount[] = [{ channelAccountId: world.channelAccountId, channel, marketplaces: [...world.account.marketplaces], haltRelease: haltReleaseOf(channel) }];
  for (const a of world.pricing?.accounts ?? []) {
    if (!accounts.some((x) => x.channelAccountId === a.channelAccountId)) accounts.push({ channelAccountId: a.channelAccountId, channel: a.channel, marketplaces: [...a.marketplaces], haltRelease: haltReleaseOf(a.channel) });
  }
  return accounts;
}

export interface StandOptions {
  filter?: (s: Scenario) => boolean;
  /** По умолчанию — хранилище в памяти; PostgreSQL — pgStoreFactory (доказательство шага 12, A) */
  storeFactory?: PricingStoreFactory;
}


export async function buildStandWorlds(options: StandOptions = {}): Promise<LiveWorld[]> {
  const { filter = () => true, storeFactory = memoryStoreFactory } = options;
  const worlds: LiveWorld[] = [];
  const sources = [
    ...loadScenarios(FIXTURES).map(({ scenario }) => ({ scenario, adapter: kauflandUnderTest })),
    ...loadScenarios(AMAZON_FIXTURES).filter(({ scenario }) => scenario.tags.includes('console-stand')).map(({ scenario }) => ({ scenario, adapter: amazonUnderTest })),
  ];
  for (const { scenario, adapter } of sources) {
    if (!scenario.world.pricing || !filter(scenario)) continue;
    const holder: { captured: { store: PricingStore; pipeline: PricingPipeline; clock: VirtualClock; tenantId: string; identity: { tenantId: string; membershipAlias(id: string): string } } | null } = { captured: null };
    const report = await runScenario(scenario, adapter, undefined, storeFactory, {
      async onFinish({ store, pipeline, clock, scenario: rebased }) {
        const tenantId = rebased.world.tenantId;
        holder.captured = { store: store!.store, pipeline: pipeline!, clock, tenantId, identity: store!.identity ?? { tenantId, membershipAlias: (id) => id } };
      },
    });
    const c = holder.captured;
    if (!c) continue;
    const accounts = accountsOf(scenario);
    worlds.push({
      id: scenario.id, title: scenario.title, description: scenario.description, tenantId: c.tenantId, accounts, failures: report.failures,
      identityTenantId: c.identity.tenantId, membershipAlias: (id) => c.identity.membershipAlias(id),
      store: c.store, pipeline: c.pipeline, clock: c.clock,
      // Остатки мира сценария — в памяти, из его же предложений: экран остатков и путь «только остатки» показываются без базы
      stock: new InMemoryStockStore(stockOffersOf(scenario, accounts), { tenantId: c.tenantId }),
      callContext: (channelAccountId) => ({
        tenantId: c.tenantId as AdapterCallContext['tenantId'], channelAccountId: channelAccountId as AdapterCallContext['channelAccountId'],
        correlationId: `stand:${scenario.id}:${c.clock.nowMs()}`, deadline: c.clock.iso(60_000),
      }),
      view: async (viewer) => ({
        id: scenario.id, title: scenario.title, description: scenario.description, tenantId: c.tenantId, now: c.clock.iso(), accounts,
        viewer: { ...viewer }, state: await c.store.readConsoleState(c.tenantId, c.clock.iso() as never),
      }),
    });
  }
  return worlds;
}

/** Предложения мира сценария глазами остатков: товар, артикул, id_offer (Kaufland) или SKU (Amazon) */
function stockOffersOf(scenario: Scenario, accounts: StandAccount[]): MemoryStockOffer[] {
  const byId = new Map(accounts.map((a) => [a.channelAccountId, a]));
  return (scenario.world.pricing?.scopes ?? []).map((s) => {
    const account = byId.get(s.channelAccountId);
    const channel = account?.channel ?? 'KAUFLAND';
    return {
      productId: s.productId, sku: s.externalUnitId, gtin: s.gtin ?? null, channelAccountId: s.channelAccountId, channel,
      marketplaces: account?.marketplaces ?? [s.marketplace],
      externalOfferId: s.externalOfferId ?? (channel === 'AMAZON' ? s.externalUnitId : `offer-${s.externalUnitId}`),
      ...(channel === 'AMAZON' ? { requiresSideEffectsAck: true, sideEffectsText: 'остаток MFN — одно значение на SKU во всех маркетплейсах региона [Р-1]' } : { sideEffectsText: 'unit с одинаковым id_offer на разных витринах имеют общие количество и склад [Р-35]' }),
    };
  });
}

/** Сопоставление стенда без базы: subject имитатора → пользователь участника и его членства в каждом мире [Р-78] */
export function memoryStandDirectory(worlds: readonly LiveWorld[]): MemoryIdentityDirectory {
  const directory = new MemoryIdentityDirectory();
  const tenants = [...new Set(worlds.map((w) => w.identityTenantId))];
  for (const account of STAND_ACCOUNTS) {
    directory.link({ issuer: STAND_ISSUER, subject: account.subject }, account.userAlias);
    for (const tenantId of tenants) directory.addMembership(account.userAlias, { tenantId, membershipId: account.membershipAlias, role: account.role });
  }
  return directory;
}

/**
 * Пользователи стенда на PostgreSQL: как у рабочего клиента — приглашение роли онбординга и его приём с subject имитатора
 * [Р-88]; уже привязанные — как есть. Членства в мирах создаёт посев.
 */
export async function pgStandUsers(directory: PgIdentityDirectory, onboardingPool: PgPool): Promise<Record<string, string>> {
  const users: Record<string, string> = {};
  for (const account of STAND_ACCOUNTS) {
    const subject = { issuer: STAND_ISSUER, subject: account.subject };
    const existing = await directory.resolve(subject);
    if (existing) {
      users[account.membershipAlias] = existing.userId;
      continue;
    }
    const { token } = await issueSignupInvitation(onboardingPool as never, account.email);
    // Имитатор поставщика выдаёт синтетический адрес стенда как подтверждённый (email_verified); настоящий поставщик — ADR-0013
    users[account.membershipAlias] = await directory.acceptInvitation(token, subject, account.email, true);
  }
  return users;
}
