import {
  auditExportRows, buyboxFacts, competitorExportRows, dangerousReport, decisionExportRows, EXPORT_MAX_ROWS, FEED_PAGE_MAX, feedExportRows, HOT_DECISIONS_DAYS,
  importExportRows, LIST_PAGE_MAX, offerExportRows, productList, protectionExportRows, rejectedView, stockExportRows, unitOf, type ExportFormat, type ExportScreen, type Messages,
  type StandWorld,
} from '@repracer/console-model';
import { buyboxCellsOf, competitionDataById, competitorSourcesOf, selectOffers, type AccountCompetitorInfo, type OfferQuery } from './offer-selection.ts';
import type { Instant } from '@repracer/channel-port';
import type { DecisionPageQuery, FeedPageQuery, ImportKind, PricingStore } from '@repracer/pricing-pipeline';
import type { StockStore } from '@repracer/stock-sync';

/**
 * Шаг 104 [Р-229]: выгрузка экрана. Сервер переводит фильтры и период экрана в запрос к хранилищу — тот же, что строит сам экран, — и
 * кладёт его в параметры задания; исполнитель идёт по нему страницами подряд и собирает строки теми же моделями, что экран. Так файл
 * совпадает с экраном строка в строку при тех же фильтрах (это держит тест), а сервер может честно отказать до создания задания, если
 * строк больше 50 000.
 */

/** Запрос экрана к хранилищу — по одному на вид экрана; моменты — ISO UTC */
export interface ScreenExportQuery {
  feed?: Omit<FeedPageQuery, 'offset' | 'limit' | 'counts'>;
  decisions?: Omit<DecisionPageQuery, 'offset' | 'limit'>;
  /** Protections: окно отчёта и фильтр причины списка («Also stopped or corrected» или «Stopped by people») */
  protections?: { since: string; until: string; clipped: boolean; phrase: string; reason: string | null };
  stock?: { search?: string; withReservations?: boolean };
  imports?: { kind: ImportKind; since?: string; until?: string };
  audit?: { since?: string; until?: string };
  /**
   * Шаг 105 [Р-230]: Offers и конкуренты — фильтр и порядок экрана, что канал каждого аккаунта говорит о конкурентах (описание канала
   * знает консоль), окно доли Buy Box и включены ли колонки Buy Box
   */
  offers?: { query: OfferQuery; accounts: Record<string, AccountCompetitorInfo>; shareRange: { since: string; until: string }; buybox: boolean };
}

export interface ScreenExportParams {
  screen: ExportScreen;
  format: ExportFormat;
  /** Имя рабочего пространства — в имени файла и на листе «About this export» */
  workspace: string;
  /** Кто выгрузил — имя или адрес человека, как его назвал вход */
  exportedBy: string;
  /** Когда нажата кнопка (часы сервера, ISO UTC) */
  exportedAt: string;
  /** Часть имени файла: даты периода или дата выгрузки */
  periodPart: string;
  /** Период экрана; null — состояние на момент выгрузки (Offers, Inventory) */
  period: { since: string | null; until: string | null } | null;
  /** Фильтры экрана словами файла и события аудита */
  filters: Record<string, string>;
  query: ScreenExportQuery;
}

export interface ScreenExportDeps {
  store: Pick<PricingStore, 'feedPage' | 'decisionPage' | 'interventions' | 'importRunsPage' | 'auditPage' | 'competitionData'> & Partial<Pick<PricingStore, 'consoleCatalogPage'>>;
  stock?: Pick<StockStore, 'stockPage'>;
  tenantId: string;
  /** «Сейчас» мира — для запросов ленты, которым нужен момент */
  now: string;
  world(): Promise<StandWorld>;
  m: Messages;
  timeZone: string | null;
}

const PAGE = 200;

/** Сколько строк будет в файле — тем же запросом, что строки; Offers считает сервер по каталогу, Protections ограничен срезом */
export async function screenExportCount(p: ScreenExportParams, deps: ScreenExportDeps): Promise<number> {
  const { store, tenantId } = deps;
  const q = p.query;
  switch (p.screen) {
    case 'price-changes': return (await store.feedPage(tenantId, deps.now as Instant, { ...q.feed, offset: 0, limit: 1 })).total;
    case 'decisions': return (await store.decisionPage(tenantId, { ...q.decisions, offset: 0, limit: 1 })).total;
    case 'inventory': {
      if (!deps.stock) throw Object.assign(new Error('no stock store'), { cause: 'BAD_REQUEST' });
      return (await deps.stock.stockPage(tenantId, { offset: 0, limit: 1, ...(q.stock?.search ? { search: q.stock.search } : {}), ...(q.stock?.withReservations ? { withReservations: true } : {}) })).total;
    }
    case 'imports': return (await store.importRunsPage(tenantId, { ...importsQuery(p), offset: 0, limit: 1 })).total;
    case 'audit-log': return (await store.auditPage(tenantId, { ...auditQuery(p), offset: 0, limit: 1 })).total;
    case 'offers': return (await selectOffers(selectionDeps(p, deps), offersOf(p).query, { offset: 0, limit: 1 })).matched;
    case 'offer-competitors': return (await selectOffers(selectionDeps(p, deps), offersOf(p).query, { offset: 0, limit: 1 }, { countCompetitorRows: true })).competitorRows ?? 0;
    case 'stopped-by-people':
    case 'prevented-by-rules': return (await screenExportRows(p, deps)).length;
  }
}

/** Шаг 105: Offers без запроса фильтра (прежние задания шага 104) — весь каталог в порядке каталога, без колонок Buy Box */
const offersOf = (p: ScreenExportParams): NonNullable<ScreenExportQuery['offers']> =>
  p.query.offers ?? { query: { storefront: null, holder: null, q: '', sort: null }, accounts: {}, shareRange: { since: p.exportedAt, until: p.exportedAt }, buybox: false };
const selectionDeps = (p: ScreenExportParams, deps: ScreenExportDeps) => {
  const o = offersOf(p);
  return { store: deps.store, tenantId: deps.tenantId, now: deps.now, useDatabase: Boolean(deps.store.consoleCatalogPage), world: deps.world, m: deps.m,
    accounts: o.accounts, shareRange: o.shareRange };
};
/** Единицы выгрузки Offers в порядке экрана — все сразу (их не больше потолка: число проверено до строк) */
async function offerIds(p: ScreenExportParams, deps: ScreenExportDeps): Promise<string[]> {
  return (await selectOffers(selectionDeps(p, deps), offersOf(p).query, { offset: 0, limit: EXPORT_MAX_ROWS })).scopeIds;
}

const importsQuery = (p: ScreenExportParams) => {
  const q = p.query.imports;
  if (!q) throw Object.assign(new Error('no import kind'), { cause: 'BAD_REQUEST' });
  return { kind: q.kind, ...(q.since ? { since: q.since as Instant } : {}), ...(q.until ? { until: q.until as Instant } : {}) };
};
const auditQuery = (p: ScreenExportParams) => ({
  ...(p.query.audit?.since ? { since: p.query.audit.since as Instant } : {}), ...(p.query.audit?.until ? { until: p.query.audit.until as Instant } : {}),
});

/** Строки файла — страницами подряд; больше потолка — отказ, а не обрезанный файл */
export async function screenExportRows(p: ScreenExportParams, deps: ScreenExportDeps, progress: (done: number) => Promise<void> = async () => undefined): Promise<string[][]> {
  const { store, tenantId, m, timeZone } = deps;
  const q = p.query;
  const rows: string[][] = [];
  const add = async (more: readonly string[][]) => {
    rows.push(...more);
    if (rows.length > EXPORT_MAX_ROWS) throw Object.assign(new Error('too many rows'), { cause: p.screen === 'offers' || p.screen === 'offer-competitors' ? 'TOO_MANY_ROWS_FILTER' : 'TOO_MANY_ROWS' });
    await progress(rows.length);
  };
  switch (p.screen) {
    case 'price-changes': {
      const world = await deps.world();
      const total = (await store.feedPage(tenantId, deps.now as Instant, { ...q.feed, offset: 0, limit: 1 })).total;
      // `counts: false`: счётчики групп — подсчёт по всей ленте на каждой странице (ревью шага 35, находка 8)
      for (let offset = 0; offset < total; offset += FEED_PAGE_MAX) {
        await add(feedExportRows(world, m, timeZone, (await store.feedPage(tenantId, deps.now as Instant, { ...q.feed, offset, limit: FEED_PAGE_MAX, counts: false })).items));
      }
      return rows;
    }
    case 'decisions': {
      const world = await deps.world();
      for (let offset = 0, total = 1; offset < total; offset += LIST_PAGE_MAX) {
        const page = await store.decisionPage(tenantId, { ...q.decisions, offset, limit: LIST_PAGE_MAX });
        total = page.total;
        await add(decisionExportRows(world, m, timeZone, page.items));
      }
      return rows;
    }
    case 'stopped-by-people':
    case 'prevented-by-rules': {
      const w = q.protections;
      if (!w) throw Object.assign(new Error('no window'), { cause: 'BAD_REQUEST' });
      const world = await deps.world();
      const slice = await store.interventions(tenantId, w.since as Instant, w.until as Instant);
      const stops = p.screen === 'stopped-by-people';
      // Список вкладки — как на экране: своя часть отчёта и фильтр причины, выбранный продавцом
      const rejected = rejectedView(world, slice, m, { refs: true }).items
        .filter((i) => (stops ? i.kind === 'STOP' : i.kind !== 'STOP'))
        .filter((i) => w.reason === null || i.reason.code === w.reason);
      if (stops) {
        await add(protectionExportRows(m, timeZone, { rejected }));
        return rows;
      }
      const report = dangerousReport(world, slice, { since: w.since, until: w.until, clipped: w.clipped, maxDays: HOT_DECISIONS_DAYS }, w.phrase, m, { refs: true });
      await add(protectionExportRows(m, timeZone, { floorHolds: report.floorHolds.items, dangerous: report.items, rejected }));
      return rows;
    }
    case 'offers': {
      // Шаг 105: фильтр, порядок и колонки Buy Box экрана — та же выборка, что у экрана (`selectOffers`)
      const world = await deps.world();
      const o = offersOf(p);
      const ids = await offerIds(p, deps);
      for (let at = 0; at < ids.length; at += LIST_PAGE_MAX) {
        const chunk = ids.slice(at, at + LIST_PAGE_MAX);
        const cells = o.buybox
          ? buyboxCellsOf(world, await store.competitionData(tenantId, chunk, o.shareRange.since as Instant, o.shareRange.until as Instant), { ...selectionDeps(p, deps) }, chunk)
          : null;
        const view = productList(world, m, { offset: 0, limit: chunk.length }, undefined,
          { scopeIds: chunk, offset: 0, total: chunk.length, matched: chunk.length, enabled: 0, stopped: 0, off: 0, applying: 0, pricingHealthIssues: false }, { buybox: cells });
        await add(offerExportRows(world, m, view.rows, { buybox: o.buybox, timeZone }));
      }
      return rows;
    }
    case 'offer-competitors': {
      const world = await deps.world();
      const o = offersOf(p);
      const ids = await offerIds(p, deps);
      for (let at = 0; at < ids.length; at += LIST_PAGE_MAX) {
        const chunk = ids.slice(at, at + LIST_PAGE_MAX);
        const data = competitionDataById(await store.competitionData(tenantId, chunk, o.shareRange.since as Instant, o.shareRange.until as Instant));
        await add(competitorExportRows(m, timeZone, chunk.flatMap((id) => {
          const scope = world.state.scopes.find((sc) => sc.writeScopeId === id);
          if (!scope) return [];
          const info = o.accounts[scope.channelAccountId];
          const d = data.get(id) ?? { snapshot: null, spans: [] };
          const facts = buyboxFacts({ snapshot: d.snapshot, spans: d.spans, range: o.shareRange, sources: competitorSourcesOf(info) });
          return [{ unit: unitOf(world, scope, m), snapshot: d.snapshot, holderNamed: facts.holderNamed, state: facts.state }];
        }), world.state.demo));
      }
      return rows;
    }
    case 'inventory': {
      if (!deps.stock) throw Object.assign(new Error('no stock store'), { cause: 'BAD_REQUEST' });
      for (let offset = 0, total = 1; offset < total; offset += PAGE) {
        const page = await deps.stock.stockPage(tenantId, { offset, limit: PAGE, ...(q.stock?.search ? { search: q.stock.search } : {}),
          ...(q.stock?.withReservations ? { withReservations: true } : {}) });
        total = page.total;
        await add(stockExportRows(m, page.items));
      }
      return rows;
    }
    case 'imports': {
      const world = await deps.world();
      const iq = importsQuery(p);
      for (let offset = 0, total = 1; offset < total; offset += PAGE) {
        const page = await store.importRunsPage(tenantId, { ...iq, offset, limit: PAGE });
        total = page.total;
        await add(importExportRows(world, m, timeZone, iq.kind, page.items));
      }
      return rows;
    }
    case 'audit-log': {
      const world = await deps.world();
      for (let offset = 0, total = 1; offset < total; offset += PAGE) {
        const page = await store.auditPage(tenantId, { ...auditQuery(p), offset, limit: PAGE });
        total = page.total;
        await add(auditExportRows(world, m, timeZone, page.items));
      }
      return rows;
    }
  }
}
