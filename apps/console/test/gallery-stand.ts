/**
 * Шаг 79: галерея экранов для проверки дизайна — стенд в памяти со всеми мирами сценариев и ПУСТЫМ рабочим пространством (без
 * предложений и каналов), плюс Vite с прокси на него. Демо-стенд показывает один настроенный мир; пустые состояния, «не найдено»
 * и экраны миров сценариев видны только здесь. Не тест и не часть сборки: запускается руками, держит порты, пока не прерван.
 *
 * Использование: node --experimental-strip-types apps/console/test/gallery-stand.ts [порт стенда] [порт интерфейса]
 * (по умолчанию 4329 и 5183, только 127.0.0.1)
 */
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { InMemoryStockStore } from '@repracer/stock-sync';
import { createPricingPipeline, InMemoryPricingStore } from '@repracer/pricing-pipeline';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import { buildStandWorlds, memoryStandDirectory, STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { createAuthenticator, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

const standPort = Number(process.argv[2] ?? 4329);
const uiPort = Number(process.argv[3] ?? 5183);
const root = fileURLToPath(new URL('..', import.meta.url));

const worlds = await buildStandWorlds();
const clock = worlds[0]!.clock;
// Пустое рабочее пространство: ни предложений, ни аккаунтов канала — экраны отвечают пустыми состояниями с объяснением
const tenantId = 'gallery-empty-tenant';
const store = new InMemoryPricingStore({ scopes: [] }, { tenantId, now: () => clock.iso() as never });
const noChannel = new Proxy({ descriptor: KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
  get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`the empty workspace called a channel: ${String(key)}`); }),
}) as never;
const empty: LiveWorld = {
  id: 'gallery/empty', title: 'Empty workspace', description: 'No offers and no channel account yet', tenantId, accounts: [], identityTenantId: tenantId,
  membershipAlias: (id) => id, failures: [], store, stock: new InMemoryStockStore([], { tenantId, roleOf: () => 'OWNER' }),
  pipeline: createPricingPipeline({ store, adapter: noChannel, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: (() => clock.iso()) as never }),
  clock,
  // Как у мира настоящего тенанта (`tenant-worlds.ts`): хранилище тени есть всегда, у пустого workspace оно отвечает нулями
  shadow: {
    shadowPage: async (_tenantId, now) => ({
      summary: { since: now, until: now, decisions: 0, changes: 0, floorHeld: 0, ceilingHeld: 0, heldWrites: 0, heldPriceWrites: 0,
        heldQuantityWrites: 0, wouldSpendBudget: 0, wouldSpendUnconfirmed: 0, floorSavings: [], floorSavingsHolds: 0 },
      rows: [], total: 0, accounts: [], properties: [], digests: [], decisionsByHour: [],
    }) as never,
    switchWriteMode: async () => { throw new Error('the empty workspace has no channel account to switch'); },
  },
  callContext: (channelAccountId) => ({ tenantId: tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'gallery-empty', deadline: clock.iso(60_000) }),
  view: async (viewer) => ({
    id: 'gallery/empty', title: 'Empty workspace', description: 'No offers and no channel account yet', tenantId, now: clock.iso(), accounts: [],
    viewer: { ...viewer }, state: await store.readConsoleState(tenantId, clock.iso() as never),
  }),
};
const all = [empty, ...worlds];
const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
const handle = createStandApi(all, {
  authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory: memoryStandDirectory(all) }),
  simulator: { token: (a) => issuer.token(a.subject, { email: a.email }), expiresInSeconds: 8 * 3600 },
}, {
  defaultLocale: 'en',
  // Как у сервера с настроенными приложениями каналов: пустое рабочее пространство видит кнопки подключения Amazon и eBay
  connect: (worldId) => (worldId !== 'gallery/empty' ? null : {
    connectable: () => [
      { channel: 'AMAZON', platformMissing: [], marketplaces: ['A1PA6795UKMFR9', 'ATVPDKIKX0DER'] },
      { channel: 'EBAY', platformMissing: [], marketplaces: ['EBAY_DE', 'EBAY_US'] },
    ],
    connections: async () => ({ accounts: [], pending: [] }),
    start: async () => ({ status: 'UNAVAILABLE' }),
    callback: async () => ({ status: 'BAD_CALLBACK' }),
    cancel: async () => false,
  }),
});
const stand = createStandServer(handle);
await new Promise<void>((resolve) => stand.listen(standPort, '127.0.0.1', resolve));
const vite = await createServer({
  root, configFile: `${root}vite.config.ts`, logLevel: 'silent',
  server: { host: '127.0.0.1', port: uiPort, strictPort: true, hmr: false, proxy: { '/api': `http://127.0.0.1:${standPort}` } },
});
await vite.listen();
console.log(`gallery: ${all.length} workspaces (one empty) — http://127.0.0.1:${uiPort}/`);
