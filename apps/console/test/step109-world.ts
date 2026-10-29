import type { CompetitorSnapshot } from '@repracer/channel-port';
import type { LiveWorld } from '@repracer/contract-tests/stand';

/**
 * Шаг 109 [Р-234, Р-235]: последняя сводка конкурентов (снимок сверки Amazon) у предложения мира Amazon стенда — синтетические данные:
 * группы покупателей с долей просмотров (Cedar Lane — 72 % без Prime и 10 % с Prime, A2SYN1090000AA — 18 %) и купоны конкурентов. Снимок
 * записывается тем же методом хранилища, которым его пишет путь сверки; держатель большинства — Cedar Lane (82 %, правило
 * `holderByViewShare` проверяют тесты pricing-model и PostgreSQL шага)
 */
/**
 * Шаг 109.1: мир Amazon стенда с единицей amazon.com в долларах (сценарий курса: себестоимость в евро, витрина США) — для снимков и проверок
 * профиля us; блок с деньгами снимается в обоих профилях
 */
export const SELLER109_US = 'amazon/pipeline/fx-usd-floor-eur-cost';
export const SCOPE109_US = 'ws-price-us-4501';

/** Снимок часом раньше часов мира: отрезок держателя до «сейчас» — час, и доля Buy Box на странице считается (не «0 % периода») */
const HOUR_MS = 3_600_000;

/**
 * Шаг 109.1 [Р-71]: `foreign` — ещё одно предложение с купоном не в валюте витрины (снимок сверки идёт мимо проверки входов): блок его суммы
 * не печатает, а говорит строкой «1 offer in EUR is not shown»
 */
export async function prepareStep109(live: LiveWorld, writeScopeId: string, options: { foreign?: string } = {}): Promise<{ writeScopeId: string }> {
  type Scope = { writeScopeId: string; channelAccountId: string; marketplace: string; channelProductRef: string; condition: string; currency: string; basis?: 'GROSS' | 'NET' };
  const scopes = (await live.view({ membershipId: 'probe', role: 'OWNER', userId: 'probe' } as never)).state.scopes as unknown as Scope[];
  const sc = scopes.find((s) => s.writeScopeId === writeScopeId)!;
  const money = (amountMinor: number) => ({ amountMinor, currency: sc.currency, basis: sc.basis ?? 'GROSS' });
  const snapshot: CompetitorSnapshot = {
    marketplace: sc.marketplace, channelProductRef: sc.channelProductRef, condition: sc.condition, source: 'AMAZON_COMPETITIVE_SUMMARY', observedAt: live.clock.iso(-HOUR_MS) as never,
    completeness: { kind: 'TOP_N', n: 3 },
    offers: [
      { isSelf: false, sellerRef: 'A2SYN1090000AA', price: money(1715), shipping: money(250), totalPrice: money(1965), couponPrice: money(1629) },
      { isSelf: false, sellerRef: 'Cedar Lane', price: money(1811), shipping: money(250), totalPrice: money(2061) },
      { isSelf: true, price: money(1900), shipping: money(0), totalPrice: money(1900) },
      ...(options.foreign ? [{ isSelf: false, sellerRef: 'A2SYN109000FX1', price: { amountMinor: 2000, currency: options.foreign, basis: 'GROSS' as const },
        shipping: { amountMinor: 150, currency: options.foreign, basis: 'GROSS' as const }, totalPrice: { amountMinor: 2150, currency: options.foreign, basis: 'GROSS' as const },
        couponPrice: { amountMinor: 1840, currency: options.foreign, basis: 'GROSS' as const } }] : []),
    ],
    buyboxSegments: [
      { sellerRef: 'Cedar Lane', isSelf: false, membership: 'NON_PRIME', viewSharePct: 72 },
      { sellerRef: 'Cedar Lane', isSelf: false, membership: 'PRIME', viewSharePct: 10 },
      { sellerRef: 'A2SYN1090000AA', isSelf: false, membership: 'NON_PRIME', viewSharePct: 18 },
    ],
  };
  await live.store.recordReconciliationSnapshot(live.tenantId, { channelAccountId: sc.channelAccountId, competitorSnapshotId: '00000000-0000-4000-8000-000000010909',
    snapshot, receivedAt: live.clock.iso(-HOUR_MS) as never, buyboxHolder: { holder: 'OTHER', sellerRef: 'Cedar Lane' } });
  return { writeScopeId };
}
