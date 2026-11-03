/**
 * Шаг 112 [Р-238]: рабочее пространство стенда в памяти для браузерного смоука тихих чипов и цвета товара — 16 синтетических предложений
 * amazon.com, ebay.com и walmart.com (критерий владельца — «15 строк подряд не мигают»). Цвет — атрибутом товара, а не словом в названии:
 * известные слова (кружок-образец), незнакомое («multicolor») и без цвета. Данные синтетические. Не тест: модуль собирает мир
 */
import { InMemoryStockStore } from '@repracer/stock-sync';
import { createPricingPipeline, InMemoryPricingStore, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { KAUFLAND_DESCRIPTOR } from '@repracer/kaufland-adapter';
import type { LiveWorld } from '@repracer/contract-tests/stand';

export const COLORS_WORLD_ID = 'gallery/colors';

const ACCOUNTS = [
  { channelAccountId: 'colors-amazon', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] },
  { channelAccountId: 'colors-ebay', channel: 'EBAY', marketplaces: ['EBAY_US'] },
  { channelAccountId: 'colors-walmart', channel: 'WALMART', marketplaces: ['WALMART_US'] },
] as const;

/** Товар, витрина, цвет: у Walmart — размер в названии и без цвета, как у демо; «multicolor» — слово, которого нет в списке образцов */
const OFFERS: ReadonlyArray<[string, 0 | 1 | 2, string | null]> = [
  ['Travel mug', 0, 'green'], ['Desk lamp', 0, 'red'], ['Water bottle', 0, 'black'], ['Plant pot', 0, 'white'], ['Wall clock', 0, 'multicolor'], ['Yoga mat', 0, 'blue'],
  ['Travel mug', 1, 'grey'], ['Desk lamp', 1, 'Gray'], ['Kitchen scale', 1, 'gris'], ['Bike light', 1, null], ['Phone stand', 1, 'purple'],
  ['Laptop sleeve, small', 2, null], ['Desk lamp, large', 2, null], ['Water bottle, small', 2, null], ['Yoga mat, small', 2, null], ['Bike light, small', 2, null],
];

export function colorsWorld(clock: LiveWorld['clock'], tenantId = 'gallery-colors-tenant'): LiveWorld {
  const scopes: MemorySeedScope[] = OFFERS.map(([title, a, color], i) => ({
    writeScopeId: `colors-ws-${i}`, productId: `colors-product-${i}`, title, ...(color ? { color } : {}), channelAccountId: ACCOUNTS[a].channelAccountId,
    marketplace: ACCOUNTS[a].marketplaces[0], externalUnitId: `SYN-COLORS-${100 + i}`, channelProductRef: a === 0 ? `B0SYNCOL${10 + i}` : a === 2 ? `${70_000 + i}` : '',
    condition: 'new', currency: 'USD', basis: 'NET', pricingMode: 'OFF', strategy: null, currentPriceMinor: 1899 + i,
    minPrice: { amountMinor: 1200, id: `colors-min-${i}` }, maxPrice: { amountMinor: 4000, id: `colors-max-${i}` },
  }));
  const store = new InMemoryPricingStore({ scopes, channel: 'AMAZON', accounts: ACCOUNTS.map((x) => ({ ...x, marketplaces: [...x.marketplaces] })) as never },
    { tenantId, now: () => clock.iso() as never });
  const noChannel = new Proxy({ descriptor: KAUFLAND_DESCRIPTOR } as Record<string, unknown>, {
    get: (target, key) => (key in target ? target[key as string] : () => { throw new Error(`the colors workspace called a channel: ${String(key)}`); }),
  }) as never;
  const accounts = ACCOUNTS.map((x) => ({ ...x, marketplaces: [...x.marketplaces] })) as unknown as LiveWorld['accounts'];
  return {
    id: COLORS_WORLD_ID, title: 'Colors workspace', description: 'Sixteen synthetic offers with product colors', tenantId, accounts, identityTenantId: tenantId,
    membershipAlias: (id) => id, failures: [], store, stock: new InMemoryStockStore([], { tenantId, roleOf: () => 'OWNER' }),
    pipeline: createPricingPipeline({ store, adapter: noChannel, alerts: { raise: async () => undefined }, logger: { log: () => undefined }, now: (() => clock.iso()) as never }),
    clock,
    callContext: (channelAccountId) => ({ tenantId: tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'gallery-colors', deadline: clock.iso(60_000) }),
    view: async (viewer) => ({
      id: COLORS_WORLD_ID, title: 'Colors workspace', description: 'Sixteen synthetic offers with product colors', tenantId, now: clock.iso(), accounts,
      viewer: { ...viewer }, state: await store.readConsoleState(tenantId, clock.iso() as never),
    }),
  };
}
