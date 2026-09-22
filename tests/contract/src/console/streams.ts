import {
  dangerousReport, decisionItems, decisionListView, decisionTrace, feedPageQuery, priceFeed, rejectedView, stopView, REJECTED_WINDOW_DAYS,
  type DangerousReportView, type DecisionListItem, type DecisionTrace, type FeedQuery, type Messages, type PriceFeedView, type RejectedView, type StandWorld, type StopView,
} from '@repracer/console-model';
import type { PricingStore } from '@repracer/pricing-pipeline';

/**
 * Р-154 (шаг 35): экраны, которым нужны потоки (решения, лента, вмешательства, аудит), получают их от хранилища — страницей,
 * окном или агрегатом, — как это делает сервер стенда. Тесты, звавшие модели напрямую с полным состоянием, идут через эти
 * помощники: тот же путь, что у продавца, а не второй, тестовый.
 */
export async function feedOf(store: PricingStore, world: StandWorld, m: Messages, query: FeedQuery = {}): Promise<PriceFeedView> {
  const probe = await store.feedPage(world.tenantId, world.now as never, feedPageQuery({ ...query, offset: 0, limit: 1 }));
  const q = feedPageQuery(query, probe.total);
  return priceFeed(world, m, query, await store.feedPage(world.tenantId, world.now as never, q), q);
}

export async function dangerousOf(store: PricingStore, world: StandWorld, days: number, m: Messages): Promise<DangerousReportView> {
  const from = new Date(Date.parse(world.now) - days * 86_400_000).toISOString();
  return dangerousReport(world, await store.interventions(world.tenantId, from as never, world.now as never), days, m);
}

export async function rejectedOf(store: PricingStore, world: StandWorld, m: Messages): Promise<RejectedView> {
  const from = new Date(Date.parse(world.now) - REJECTED_WINDOW_DAYS * 86_400_000).toISOString();
  return rejectedView(world, await store.interventions(world.tenantId, from as never, world.now as never), m);
}

export async function traceOf(store: PricingStore, world: StandWorld, decisionId: string, m: Messages): Promise<DecisionTrace | null> {
  const detail = await store.decisionDetail(world.tenantId, decisionId);
  return detail ? decisionTrace(world, detail, m) : null;
}

/** Свежие первыми, не больше 200 — как первая страница списка */
export async function decisionsOf(store: PricingStore, world: StandWorld, m: Messages): Promise<DecisionListItem[]> {
  const page = await store.decisionPage(world.tenantId, { offset: 0, limit: 200 });
  return decisionItems(world, page.items, m);
}

export async function decisionsTotal(store: PricingStore, world: StandWorld): Promise<number> {
  return (await store.decisionPage(world.tenantId, { offset: 0, limit: 1 })).total;
}

export async function feedTotal(store: PricingStore, world: StandWorld): Promise<number> {
  return (await store.feedPage(world.tenantId, world.now as never, { offset: 0, limit: 1 })).total;
}

export async function stopOf(store: PricingStore, world: StandWorld, m: Messages): Promise<StopView> {
  return stopView(world, await store.auditRecent(world.tenantId, 200), m);
}

export { decisionListView };
