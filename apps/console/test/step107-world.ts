import assert from 'node:assert/strict';
import type { StrategyPreviewView } from '@repracer/console-model';
import type { LiveWorld } from '@repracer/contract-tests/stand';
import type { JobCreatedResponse } from '../src/api-types.ts';
import type { createStandApi } from '../server/stand-server.ts';
import { runJob } from './run-jobs.ts';

/**
 * Шаг 107 [Р-232, Р-233]: мир Amazon стенда для теста консоли и браузерного смоука — синтетические данные:
 *  - первой единице назначается «Match the Buy Box» тем же путём, что у продавца (предпросмотр и сохранение), и приходит снимок Amazon,
 *    где часть продавцов названа SellerId (латинские заглавные и цифры), часть — именем с пробелами, как у симулятора; наша строка — «You».
 *    Ссылка на страницу продавца — только у SellerId;
 *  - у второй единицы — рамки цены канала с Min на нашем потолке: наш пол ниже Min канала — конфликт; у третьей — рамки шире наших.
 */

export const SELLER107 = 'amazon/pipeline/console-channel-trust';
export const SELLER_ID_107 = ['A2SYN1070000AA', 'A2SYN1070000AB'] as const;

export interface Step107World {
  writeScopeId: string;
  marketplace: string;
  /** Рамки канала сужают наш диапазон: Min канала выше нашего пола */
  conflictScopeId: string;
  /** Рамки канала шире наших */
  insideScopeId: string;
}

type Scope = { writeScopeId: string; channelAccountId: string; marketplace: string; externalUnitId: string; channelProductRef: string; condition: string;
  currency: string; currentPriceMinor: number | null; bounds: { min: { amountMinor?: number }; max: { amountMinor?: number } } };

export async function prepareStep107(live: LiveWorld, handle: ReturnType<typeof createStandApi>, auth: { authorization: string; cookie: string }): Promise<Step107World> {
  const api = (...parts: string[]) => `/api/worlds/${[live.id, ...parts].map(encodeURIComponent).join('/')}`;
  const scopes = (await live.view({ membershipId: 'probe', role: 'OWNER', userId: 'probe' } as never)).state.scopes as unknown as Scope[];
  assert.ok(scopes.length >= 3, `the Amazon stand world has three offers: ${scopes.length}`);
  const [sc, conflict, inside] = scopes as [Scope, Scope, Scope];
  const draft = { name: 'Synthetic match the Buy Box 107', params: { type: 'MATCH_BUYBOX', undercutMinor: 1, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 };
  const job = async (r: { status: number; body: unknown }) => {
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const done = await runJob(live, (r.body as JobCreatedResponse).jobId, 'en');
    assert.equal(done.status, 'SUCCEEDED', done.error ?? done.headline);
    return done;
  };
  const preview = await handle({ method: 'POST', url: api('strategies', 'preview'), body: { draft, writeScopeIds: [sc.writeScopeId] }, ...auth });
  const previewJobId = (preview.body as JobCreatedResponse).jobId;
  const previewToken = ((await job(preview)).result as { view: StrategyPreviewView }).view.previewToken;
  await job(await handle({ method: 'POST', url: api('strategies'), body: { draft, writeScopeIds: [sc.writeScopeId], strategyId: null, previewJobId, previewToken, confirmed: true }, ...auth }));
  const current = sc.currentPriceMinor ?? 2000;
  const money = (amountMinor: number) => ({ amountMinor, currency: sc.currency, basis: 'GROSS' });
  const offer = (sellerRef: string, price: number) => ({ sellerRef, isSelf: false, price: money(price), shipping: money(0), totalPrice: money(price), fulfillment: 'MFN' });
  await live.pipeline.processSnapshot(live.callContext(live.accounts[0]!.channelAccountId), {
    marketplace: sc.marketplace, channelProductRef: sc.channelProductRef, condition: sc.condition, source: 'AMAZON_ANY_OFFER_CHANGED',
    sourceEventId: 'seller-107', observedAt: live.clock.iso(), completeness: { kind: 'TOP_N', n: 20 },
    buybox: { price: money(current - 50), isSelf: null, shipping: money(0) },
    offers: [offer(SELLER_ID_107[0], current - 50), offer('Simulated competitor 2', current - 40), offer(SELLER_ID_107[1], current - 30),
      { sellerRef: 'Synthetic Seller', isSelf: true, price: money(current), shipping: money(0), totalPrice: money(current), fulfillment: 'MFN' }],
  } as never);
  // Рамки канала — наблюдением обнаружения со значениями, как их назовёт живое чтение (A-30)
  const max = (s: Scope) => s.bounds.max.amountMinor!;
  const min = (s: Scope) => s.bounds.min.amountMinor!;
  await live.store.recordOfferChannelPricing(live.tenantId, conflict.channelAccountId, [
    { marketplace: conflict.marketplace, externalSku: conflict.externalUnitId, automatedPricing: false, channelBounds: true,
      boundValues: { minMinor: max(conflict), maxMinor: null, currency: conflict.currency }, source: 'DISCOVERY', observedAt: live.clock.iso() as never },
    { marketplace: inside.marketplace, externalSku: inside.externalUnitId, automatedPricing: false, channelBounds: true,
      boundValues: { minMinor: Math.max(1, min(inside) - 100), maxMinor: max(inside) + 1000, currency: inside.currency }, source: 'DISCOVERY', observedAt: live.clock.iso() as never },
  ]);
  return { writeScopeId: sc.writeScopeId, marketplace: sc.marketplace, conflictScopeId: conflict.writeScopeId, insideScopeId: inside.writeScopeId };
}
