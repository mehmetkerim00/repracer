/**
 * Пустое рабочее пространство стенда в памяти: ни предложений, ни аккаунтов канала — экраны отвечают пустыми состояниями с объяснением.
 * Шаг 79 завёл его в галерее экранов; шаг 87 вынес сюда — им пользуется и браузерный смоук профиля рынка (онбординг и подключение
 * предлагают каналы и витрины профиля). Не тест: модуль собирает мир
 */
import { InMemoryStockStore } from '@repracer/stock-sync';
import { createPricingPipeline, InMemoryPricingStore } from '@repracer/pricing-pipeline';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import type { LiveWorld } from '@repracer/contract-tests/stand';
import type { ChannelConnectService } from '../server/connect.ts';

export const EMPTY_WORLD_ID = 'gallery/empty';

export function emptyWorld(clock: LiveWorld['clock'], tenantId = 'gallery-empty-tenant'): LiveWorld {
  const store = new InMemoryPricingStore({ scopes: [] }, { tenantId, now: () => clock.iso() as never });
  const noChannel = new Proxy({ descriptor: KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`the empty workspace called a channel: ${String(key)}`); }),
  }) as never;
  return {
    id: EMPTY_WORLD_ID, title: 'Empty workspace', description: 'No offers and no channel account yet', tenantId, accounts: [], identityTenantId: tenantId,
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
      id: EMPTY_WORLD_ID, title: 'Empty workspace', description: 'No offers and no channel account yet', tenantId, now: clock.iso(), accounts: [],
      viewer: { ...viewer }, state: await store.readConsoleState(tenantId, clock.iso() as never),
    }),
  };
}

/** Подключение пустого пространства — как у сервера с настроенными приложениями каналов: витрины ЕС и США у Amazon и eBay */
export const emptyWorldConnect: ChannelConnectService = {
  connectable: () => [
    { channel: 'AMAZON', platformMissing: [], marketplaces: ['A1PA6795UKMFR9', 'ATVPDKIKX0DER'] },
    { channel: 'EBAY', platformMissing: [], marketplaces: ['EBAY_DE', 'EBAY_US'] },
    // Шаг 89: Walmart — подключение ждёт ключей платформы, как в работе до живого адаптера
    { channel: 'WALMART', platformMissing: ['WALMART_API_KEYS'], marketplaces: ['WALMART_US'] },
  ],
  connections: async () => ({ accounts: [], pending: [] }),
  start: async () => ({ status: 'UNAVAILABLE' }),
  callback: async () => ({ status: 'BAD_CALLBACK' }),
  cancel: async () => false,
};
