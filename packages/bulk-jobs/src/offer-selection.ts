import {
  catalogTotals, channelOf, competitionRowOffers, matchesHolder, orderedOffers, offerBuyboxCells, offerMatchesSearch, sortOffers, type BuyboxCells, type Messages, type OfferHolderFilterValue, type OfferSort,
  type StandWorld,
} from '@repracer/console-model';
import type { Instant } from '@repracer/channel-port';
import type { CompetitionData, CompetitionDataRow, ConsoleCatalogPage, PricingStore } from '@repracer/pricing-pipeline';

/**
 * Шаг 105 [Р-230]: какие предложения показывает Offers и в каком порядке — витрина, держатель Buy Box, поиск и сортировка по колонкам
 * Buy Box. ОДНА функция у экрана и у обеих выгрузок (Offers и конкуренты): что видишь, то и выгружаешь. На PostgreSQL фильтр и порядок по
 * всему каталогу считает база (`consoleCatalogPage`), без неё — правило экрана по снимку и отрезкам каждой единицы; равенство двух путей
 * держит тест на всех мирах стенда.
 */

/**
 * Что канал аккаунта говорит о конкурентах — из описания канала (консоль знает его, база — нет). Шаг 109 [Р-235]: `shares` — доля Buy Box
 * считается: держателя называет основной источник или сверка называет его долями просмотров (Amazon); нет поля — как `named`
 */
export interface AccountCompetitorInfo { channel: string; data: boolean; named: boolean; shares?: boolean }

export interface OfferQuery {
  storefront: { channelAccountId: string; marketplace: string } | null;
  holder: OfferHolderFilterValue | null;
  /** Поиск — в нижнем регистре и без пробелов по краям; пусто — без поиска */
  q: string;
  sort: OfferSort | null;
}

export interface OfferSelectionDeps {
  store: Pick<PricingStore, 'competitionData'> & Partial<Pick<PricingStore, 'consoleCatalogPage'>>;
  tenantId: string;
  now: string;
  /** Страницу и итоги выбирает база (PostgreSQL, экран по единицам); иначе — правило экрана по каталогу мира целиком */
  useDatabase: boolean;
  /** Мир каталога целиком — путь без базы */
  world(): Promise<StandWorld>;
  m: Messages;
  accounts: Readonly<Record<string, AccountCompetitorInfo>>;
  /** Окно доли Buy Box — те же 7 дней, что у страницы Competition */
  shareRange: { since: string; until: string };
}

/** Источники аккаунта для правила страницы: основной (называет ли держателя) и, если доля считается иначе, — источник долей просмотров */
export const competitorSourcesOf = (info: AccountCompetitorInfo | undefined) =>
  (info?.data ? [{ role: 'PRIMARY', hasBuyboxWinner: info.named }, ...(info.shares && !info.named ? [{ role: 'RECONCILIATION', hasBuyboxWinner: false, holderByViewShare: true }] : [])] : []);
const sourcesOf = competitorSourcesOf;

/** Колонки Buy Box единиц — правило страницы Competition по их снимку и отрезкам */
/** Пакет хранилища — по единице */
export const competitionDataById = (rows: readonly CompetitionDataRow[]): Map<string, CompetitionData> => new Map(rows.map(({ writeScopeId, ...d }) => [writeScopeId, d]));

export function buyboxCellsOf(world: StandWorld, rows: readonly CompetitionDataRow[], deps: Pick<OfferSelectionDeps, 'accounts' | 'shareRange' | 'now' | 'm'>, ids: readonly string[]): Map<string, BuyboxCells> {
  const data = competitionDataById(rows);
  const out = new Map<string, BuyboxCells>();
  for (const id of ids) {
    const scope = world.state.scopes.find((s) => s.writeScopeId === id);
    if (!scope) continue;
    const info = deps.accounts[scope.channelAccountId];
    const d = data.get(id) ?? { snapshot: null, spans: [] };
    out.set(id, offerBuyboxCells({ snapshot: d.snapshot, spans: d.spans, range: deps.shareRange, sources: sourcesOf(info) },
      { currency: scope.currency, channel: info?.channel ?? channelOf(world, scope.channelAccountId), marketplace: scope.marketplace, demo: world.state.demo, now: deps.now }, deps.m));
  }
  return out;
}

/** Строк выгрузки конкурентов у единицы — строки страницы Competition: первые 10 снимка и наша строка ниже десятой; нет снимка — 0 */
export function competitorRowCount(cells: BuyboxCells | undefined, data: CompetitionData | undefined): number {
  if (!cells || !data?.snapshot || cells.holder.kind === 'NO_DATA' || cells.holder.kind === 'NO_SNAPSHOT') return 0;
  return competitionRowOffers(orderedOffers(data.snapshot.snapshot)).length;
}

/**
 * Страница Offers: единицы страницы в порядке экрана, итоги каталога целиком и число прошедших фильтр; по запросу — строк выгрузки
 * конкурентов. Без базы мир — каталог целиком, и колонки Buy Box считаются у тех, кому они нужны для фильтра и порядка
 */
export async function selectOffers(deps: OfferSelectionDeps, query: OfferQuery, page: { offset: number; limit: number }, options: { countCompetitorRows?: boolean } = {}): Promise<ConsoleCatalogPage> {
  const { m } = deps;
  const accounts = Object.entries(deps.accounts);
  if (deps.useDatabase && deps.store.consoleCatalogPage) {
    const channelNames = Object.fromEntries(accounts.map(([, a]) => [a.channel, (m.values as Record<string, string | undefined>)[a.channel] ?? a.channel]));
    return deps.store.consoleCatalogPage(deps.tenantId, deps.now as Instant, {
      offset: page.offset, limit: page.limit,
      offers: {
        ...(query.storefront ? { storefront: query.storefront } : {}),
        ...(query.holder ? { holder: query.holder } : {}),
        ...(query.q !== '' ? { search: { q: query.q, labelTemplate: m.ui.common.unitLabel('{p}', '{s}'), marketplaceWords: m.ui.connections.marketplaces as Readonly<Record<string, string>>, channelNames,
          unknownChannel: (m.values as Record<string, string | undefined>).UNKNOWN_CHANNEL ?? 'UNKNOWN_CHANNEL' } } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        buybox: { since: deps.shareRange.since as Instant, until: deps.shareRange.until as Instant,
          noDataAccounts: accounts.filter(([, a]) => !a.data).map(([id]) => id), namedAccounts: accounts.filter(([, a]) => a.data && a.named).map(([id]) => id),
          shareAccounts: accounts.filter(([, a]) => a.data && (a.shares ?? a.named)).map(([id]) => id) },
        ...(options.countCompetitorRows ? { countCompetitorRows: true } : {}),
      },
    });
  }
  const world = await deps.world();
  let scopes = world.state.scopes;
  if (query.storefront) scopes = scopes.filter((s) => s.channelAccountId === query.storefront!.channelAccountId && s.marketplace === query.storefront!.marketplace);
  if (query.q !== '') scopes = scopes.filter((s) => offerMatchesSearch(world, s, query.q, m));
  let competitorRows: number | undefined;
  if (query.holder || query.sort || options.countCompetitorRows) {
    const ids = scopes.map((s) => s.writeScopeId);
    const rows = await deps.store.competitionData(deps.tenantId, ids, deps.shareRange.since as Instant, deps.shareRange.until as Instant);
    const data = competitionDataById(rows);
    const cells = buyboxCellsOf(world, rows, deps, ids);
    let items = scopes.map((s) => ({ scope: s, cells: cells.get(s.writeScopeId)! }));
    if (query.holder) items = items.filter((x) => matchesHolder(x.cells.holder.kind, query.holder!));
    if (query.sort) items = sortOffers(items, query.sort);
    scopes = items.map((x) => x.scope);
    if (options.countCompetitorRows) competitorRows = items.reduce((n, x) => n + competitorRowCount(x.cells, data.get(x.scope.writeScopeId)), 0);
  }
  const matched = scopes.length;
  // Страница за концом списка — последняя, как у базы и `pageOf` (ревью шага 29, находка 13)
  const lastStart = matched === 0 ? 0 : Math.floor((matched - 1) / page.limit) * page.limit;
  const offset = Math.min(page.offset, lastStart);
  const totals = catalogTotals(world, m);
  return {
    scopeIds: scopes.slice(offset, offset + page.limit).map((s) => s.writeScopeId), offset, total: totals.total, matched,
    enabled: totals.enabled, stopped: totals.stopped, off: totals.off, applying: totals.applying, pricingHealthIssues: world.state.pricingHealth.length > 0,
    ...(competitorRows !== undefined ? { competitorRows } : {}),
  };
}
