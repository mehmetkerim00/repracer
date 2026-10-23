import { can, COMPETITOR_DERIVED_RULES, type BoundResolution, type StrategyDefinition } from '@repracer/pricing-model';
import { effectiveFloor } from './bounds.ts';
import { channelBoundsPill, channelPricingBlocks } from './channel-bounds.ts';
import type { Messages } from './i18n/index.ts';
import { listQuery, pageInfo, pageOf, type ListQuery, type PageInfo } from './page.ts';
import { gap, unitOf, type ConsoleScope, type ConsoleWrite, type Gap, type StandWorld, type StatusCell, type UnitRef } from './world.ts';
import type { ConsoleCatalogPage, ScopeDecisionStats } from '@repracer/pricing-pipeline';
import { storefrontChoices, type BuyboxCells, type OfferHolderFilterValue, type OfferSort } from './offer-buybox.ts';

/** Экран A: товары с явными статусами; действующий пол — главный, min_price — его составляющая (шаг 12, F) */

export interface StrategyLabel {
  label: string;
  detail: string;
  /** Цена из данных конкурентов: её останавливает системная остановка канала [Р-51] */
  competitorDerived: boolean;
}

export interface FloorCell {
  amount: string;
  minor: number | null;
  /** Из чего складывается: min_price и цена минимальной маржи */
  parts: string;
}

export interface ProductRow {
  unit: UnitRef;
  currentPrice: string;
  floor: FloorCell;
  minPrice: string;
  maxPrice: string;
  strategy: StrategyLabel;
  enabled: StatusCell;
  applying: StatusCell;
  lastChange: StatusCell;
  nextCheck: StatusCell;
  latestDecisionId: string | null;
  /** Решений в горячем буфере; null — статистика не запрашивалась (экран, которому она не нужна) */
  decisions: number | null;
  /** Можно ли включить репрайсинг (режим OFF и роль с правом включения) */
  canEnable: boolean;
  /** Шаг 23: что канал делает с оффером сам — правило автоматического ценообразования [Р-120], выбытие из Featured Offer (PRICING_HEALTH) */
  channelNotes: ChannelNote[];
  /** Шаг 102 [Р-227]: пилюля «Clearance» — у предложения включён режим распродажи (пол ниже безубыточности намеренно) */
  clearance: string | null;
  /** Шаг 102 [Р-227]: пол выше потолка — пилюля и «цены заморожены: поднимите потолок или включите распродажу» */
  frozen: string | null;
  /** Шаг 107 [Р-233]: конфликт с рамками цены канала — «Below the channel minimum» / «Above the channel maximum»; null — конфликта нет */
  channelBounds: string | null;
  /** Шаг 103 [Р-228]: правило умолчания аккаунта не назначило стратегию новому предложению — причина словами, иначе null */
  notAssigned: string | null;
  /** Шаг 105 [Р-230]: колонки Buy Box — только когда зритель их включил (их считают по снимку и отрезкам; выключенные — не нужны) */
  buybox?: BuyboxCells | null;
}

/** Шаг 105 [Р-230]: фильтр строки Offers — витрина, держатель Buy Box, поиск; без фильтра — весь каталог */
export interface OfferFilter {
  storefront: string | null;
  holder: OfferHolderFilterValue | null;
  q: string;
}

/** AUTOMATED_PRICING и CHANNEL_BOUNDS — стратегию не назначит база (0082, Р-120); PRICING_HEALTH — только предупреждение */
export type ChannelNote = StatusCell & {
  code: 'AUTOMATED_PRICING' | 'CHANNEL_BOUNDS' | 'PRICING_HEALTH' | 'WALMART_UNPUBLISHED';
  /** Шаг 96 (аудит А6): короткое «что делать» у пилюли — раскрывается по ссылке */
  whatToDo?: { label: string; text: string };
};

export interface ProductListView {
  worldId: string;
  now: string;
  totals: { total: number; enabled: number; applying: number; stopped: number; off: number };
  rows: ProductRow[];
  /** Р-136: страница показанных строк — каталог целевого клиента целиком в ответ не помещается */
  page: PageInfo;
  gaps: Gap[];
  /** Шаг 105 [Р-230]: фильтр строки и выбор витрин; сортировка по колонке Buy Box; сколько предложений прошли фильтр (без фильтра — null) */
  filters: OfferFilter & { storefronts: Array<{ value: string; label: string }> };
  sort: OfferSort | null;
  matched: number | null;
  buyboxShown: boolean;
}

export function strategyLabel(def: StrategyDefinition | null, currency: string, m: Messages): StrategyLabel {
  const s = m.ui.strategy;
  if (!def) return { label: s.none, detail: s.noneDetail, competitorDerived: false };
  const p = def.params;
  const money = (v: number) => m.money(v, currency);
  const tail = `${def.deadbandMinor > 0 ? `; ${s.deadband(money(def.deadbandMinor))}` : ''} (${s.version(def.version)})`;
  const atBound = (v: 'CAP' | 'HOLD') => (v === 'CAP' ? s.capAtBound : s.holdAtBound);
  // Р-91: подрез хранится 18 месяцев после замены версии стратегии; без него — «не хранится», а не «сравняться»
  const undercut = (u: number | undefined) => (u === undefined ? s.undercutNotKept : u > 0 ? s.undercut(money(u)) : s.match);
  const competitorDerived = COMPETITOR_DERIVED_RULES.has(p.type);
  /** Шаг 101 [Р-226]: ориентир и фильтр — в описании, только если они не по умолчанию типа (у прежних версий описание прежнее) */
  const choices = (anchor: string | undefined, fallback: string | null, competeWith: string | undefined): string => {
    const t = m.ui.strategies;
    const parts = [
      ...(anchor && fallback && anchor !== fallback ? [s.anchor(t.anchorsInline[anchor as keyof typeof t.anchorsInline] ?? anchor)] : []),
      ...(competeWith && competeWith !== 'ALL' ? [s.competeWith(t.competeWithInline[competeWith as keyof typeof t.competeWithInline] ?? competeWith)] : []),
    ];
    return parts.map((x) => `; ${x}`).join('');
  };
  switch (p.type) {
    case 'FIXED':
      return { label: s.fixed, detail: `${money(p.priceMinor)}${tail}`, competitorDerived };
    case 'TARGET_MARGIN':
      return { label: s.targetMargin, detail: `${s.marginOfNet(m.percentBp(p.targetMarginBp))}${tail}`, competitorDerived };
    case 'MATCH_BUYBOX':
      return {
        label: s.buybox,
        detail: `${undercut((p as { undercutMinor?: number }).undercutMinor)}${p.holdWhenWinning ? `; ${s.holdWhenWinning}` : ''}${choices(undefined, null, p.competeWith)}; ${atBound(p.atBound)}${tail}`,
        competitorDerived,
      };
    case 'BEAT_LOWEST':
      return {
        label: s.lowest,
        detail: `${undercut((p as { undercutMinor?: number }).undercutMinor)}, ${p.scope === 'MARKET' ? s.marketScope : s.visibleScope}${p.compareLanded ? `, ${s.landed}` : ''}${choices(p.anchor, 'LOWEST', p.competeWith)}; ${atBound(p.atBound)}${tail}`,
        competitorDerived,
      };
    // Шаг 97 [Р-219]: подрез и гандикап хранятся 18 месяцев после замены версии [Р-91]
    case 'WIN_BUYBOX': {
      const handicap = (p as { fulfillmentHandicapMinor?: number }).fulfillmentHandicapMinor;
      return {
        label: s.winBuybox,
        detail: `${undercut((p as { undercutMinor?: number }).undercutMinor)} ${s.winLanded}${handicap ? `, ${s.handicap(money(handicap))}` : ''}; `
          + `${p.creepUp ? s.creep(m.percentBp(p.creepStepBp)) : s.noCreep}${choices(p.anchor, 'BUYBOX', p.competeWith)}; ${atBound(p.atBound)}${tail}`,
        competitorDerived,
      };
    }
  }
}

/**
 * Шаг 103 [Р-228]: честная пометка «not assigned: …» — у предложения нет стратегии, и последнее слово о нём — правило умолчания аккаунта,
 * которое его не назначило (ценообразование канала, листинг без записи, стратегия недоступна на канале)
 */
export function notAssignedText(scope: { strategy: StrategyDefinition | null; assignment?: { outcome: string; reason: string | null } | null }, m: Messages): string | null {
  const a = scope.assignment;
  if (scope.strategy || !a || a.outcome !== 'NOT_ASSIGNED' || !a.reason) return null;
  const reasons = m.ui.connections.defaultStrategy.reasons as Record<string, string | undefined>;
  return m.ui.products.notAssigned(reasons[a.reason] ?? a.reason);
}

export function boundText(b: BoundResolution, currency: string, m: Messages): string {
  return b.status === 'RESOLVED' ? m.money(b.amountMinor, currency) : m.ui.common.boundUnresolved(m.values[b.cause]);
}

const ACTIVE_WRITE = new Set(['PENDING', 'DISPATCHED', 'FAILED', 'ACCEPTED', 'BLOCKED']);

export function enabledCell(scope: ConsoleScope, m: Messages): StatusCell {
  const e = m.ui.enabled;
  if (scope.pricingMode === 'OFF') return { tone: 'off', label: e.off, detail: e.offDetail };
  if (scope.pricingMode === 'KAUFLAND_SMART_PRICING') return { tone: 'off', label: e.smart, detail: e.smartDetail };
  // Р-69: остановка человеком — все цены, включая фиксированные и маржинальные
  if (scope.priceStop) return { tone: 'stop', label: e.stopped, detail: e.stoppedDetail(m.values[scope.priceStop.scope], m.when(scope.priceStop.stoppedAt)) };
  // Р-118: недоверие каналу — все цены, включая фиксированные и маржинальные, до снятия человеком
  if (scope.channelDistrust) return { tone: 'stop', label: e.distrusted, detail: e.distrustedDetail(m.when(scope.channelDistrust.detectedAt)) };
  if (scope.status !== 'ACTIVE') return { tone: 'stop', label: e.inactive(m.values[scope.status]), detail: e.inactiveDetail };
  if (scope.channelHalt && scope.strategy && COMPETITOR_DERIVED_RULES.has(scope.strategy.params.type)) {
    return { tone: 'stop', label: e.halted, detail: e.haltedDetail(m.when(scope.channelHalt.haltedAt)) };
  }
  if (scope.channelHalt) return { tone: 'ok', label: e.on, detail: e.haltedButWorks };
  return { tone: 'ok', label: e.on, detail: e.onDetail };
}

export function applyingCell(scope: ConsoleScope, writes: readonly ConsoleWrite[], m: Messages): StatusCell {
  const a = m.ui.applying;
  const w = writes.filter((x) => x.writeScopeId === scope.writeScopeId && ACTIVE_WRITE.has(x.status)).sort((x, y) => y.version - x.version)[0];
  const money = (v: number) => m.money(v, scope.currency);
  const error = (code: string | null) => (code ? (m.values as Record<string, string | undefined>)[code] ?? code : a.noErrorCode);
  if (!w) return { tone: 'ok', label: a.idle, detail: a.idleDetail };
  switch (w.status) {
    case 'PENDING': return { tone: 'progress', label: a.queued(money(w.amountMinor)), detail: a.queuedDetail(m.when(w.createdAt)) };
    case 'DISPATCHED': return { tone: 'progress', label: a.dispatching(money(w.amountMinor)), detail: a.dispatchingDetail(m.when(w.dispatchedAt)) };
    case 'ACCEPTED': return { tone: 'progress', label: a.accepted(money(w.amountMinor)), detail: a.acceptedDetail(m.when(w.acceptedAt)) };
    case 'FAILED':
      return w.nextAttemptAt
        ? { tone: 'warn', label: a.retry(money(w.amountMinor)), detail: a.retryDetail(error(w.lastErrorCode), w.attemptCount + 1, m.when(w.nextAttemptAt)) }
        : { tone: 'stop', label: a.blocked(money(w.amountMinor)), detail: a.blockedDetail(error(w.lastErrorCode)) };
    default: return { tone: 'stop', label: a.blocked(money(w.amountMinor)), detail: m.ui.writeStatus[w.status as keyof typeof m.ui.writeStatus] ?? w.status };
  }
}

/**
 * Р-154: `writes` — только записи В ПОЛЁТЕ, применённая цена лежит в истории цен единицы (`scope.lastApplied`, по индексу).
 * Первая редакция шага 35 оставила здесь поиск APPLIED по записям в полёте — и столбец «последнее изменение» у всех
 * предложений навсегда показывал «нет» (ревью шага 35, находка 3).
 */
export function lastChangeCell(scope: ConsoleScope, writes: readonly ConsoleWrite[], m: Messages): StatusCell {
  const l = m.ui.lastChange;
  const accepted = writes
    .filter((x) => x.writeScopeId === scope.writeScopeId && x.status === 'ACCEPTED' && x.acceptedAt)
    .sort((x, y) => Date.parse(y.acceptedAt!) - Date.parse(x.acceptedAt!))[0];
  const applied = scope.lastApplied;
  // Принято каналом позже, чем применено: показываем принятое — оно новее, но применение ещё не подтверждено
  if (accepted && (!applied || Date.parse(accepted.acceptedAt!) > Date.parse(applied.acceptedAt))) {
    return { tone: 'progress', label: m.money(accepted.amountMinor, scope.currency), detail: l.acceptedOnly(m.when(accepted.acceptedAt)) };
  }
  if (!applied) return { tone: 'unknown', label: l.none, detail: l.noneDetail };
  return { tone: 'ok', label: m.money(applied.amountMinor, scope.currency), detail: l.applied(m.when(applied.acceptedAt)) };
}

/** Шаг 89: состояния публикации Walmart в журнале наблюдений канала (channel_data.offer_pricing_health) — коды проекта, не канала (W-10) */
export const WALMART_UNPUBLISHED = 'WALMART_UNPUBLISHED_UNCOMPETITIVE_PRICE';
export const WALMART_PUBLISHED = 'WALMART_PUBLISHED';

/** Шаг 23: наблюдения канала по офферу — последнее наблюдение ценообразования канала и последнее состояние PRICING_HEALTH */
export function channelNotes(world: StandWorld, scope: ConsoleScope, m: Messages): ChannelNote[] {
  const n = m.ui.channelNotes;
  const notes: ChannelNote[] = [];
  const pricing = world.state.offerChannelPricing.find((o) => o.channelAccountId === scope.channelAccountId && o.marketplace === scope.marketplace && o.externalSku === scope.externalUnitId);
  if (pricing?.automatedPricing) notes.push({ code: 'AUTOMATED_PRICING', tone: 'stop', label: n.automatedPricing, detail: n.automatedPricingDetail(m.when(pricing.observedAt)) });
  // Шаг 107 [Р-231]: рамки со значениями в валюте предложения — не блок; их конфликт — пилюля строки и блок страницы пола [Р-233]
  if (pricing?.channelBounds && !pricing.automatedPricing && channelPricingBlocks(pricing, scope.currency)) {
    notes.push({ code: 'CHANNEL_BOUNDS', tone: 'warn', label: n.channelBounds, detail: n.channelBoundsDetail(m.when(pricing.observedAt)) });
  }
  const health = world.state.pricingHealth.find((h) => h.channelAccountId === scope.channelAccountId && h.marketplace === scope.marketplace
    && h.channelProductRef === scope.channelProductRef && h.condition === scope.condition);
  /**
   * Шаг 89: Walmart снял листинг с публикации — правило неконкурентной цены (тот же товар заметно дешевле на другой площадке). Это
   * состояние предложения, а не просто заметка: на walmart.com его не видно. Движок цену за это не чинит — решение владельца; экран
   * говорит, что случилось и что сделать. Последняя строка «опубликован снова» снимает состояние
   */
  if (health?.issueType === WALMART_UNPUBLISHED) {
    const elsewhere = health.competitivePriceThreshold ? m.money(health.competitivePriceThreshold.amountMinor, health.competitivePriceThreshold.currency) : null;
    notes.push({
      code: 'WALMART_UNPUBLISHED', tone: 'stop', label: n.unpublished,
      detail: n.unpublishedDetail(m.when(health.occurredAt), elsewhere),
      short: n.unpublishedShort(m.when(health.occurredAt), elsewhere),
      whatToDo: { label: m.ui.products.whatToDo, text: m.ui.products.unpublishedWhatToDo(elsewhere) },
    });
  } else if (health && health.issueType !== WALMART_PUBLISHED) {
    notes.push({
      code: 'PRICING_HEALTH', tone: 'warn', label: n.pricingHealth(health.issueType),
      detail: n.pricingHealthDetail(m.when(health.occurredAt), health.competitivePriceThreshold ? m.money(health.competitivePriceThreshold.amountMinor, health.competitivePriceThreshold.currency) : null),
    });
  }
  return notes;
}

/** Показанная страница каталога — те же правила, что у списка: по ней запрашивается статистика решений [Р-154] */
export function productPage(world: StandWorld, m: Messages, query?: ListQuery): { shown: ConsoleScope[]; page: PageInfo } {
  const { items: shown, page } = pageOf(world.state.scopes, listQuery(query), m);
  return { shown, page };
}

/**
 * Шаг 66 (ревью шага, находка 2): строки страницы — ровно те единицы, что выбрала база, и в её порядке. Мир, проигнорировавший список
 * единиц, отдал бы весь каталог, и «страница» стала бы каталогом целиком
 */
export function catalogRows(scopes: readonly ConsoleScope[], catalog: ConsoleCatalogPage): ConsoleScope[] {
  const byId = new Map(scopes.map((sc) => [sc.writeScopeId, sc]));
  return catalog.scopeIds.flatMap((id) => { const sc = byId.get(id); return sc ? [sc] : []; });
}

/**
 * Р-154: статистика решений — только для ПОКАЗАННЫХ строк, запросом по индексу единицы; каталог целиком её не несёт.
 * Экрану без неё (границы) передавать нечего — тогда столбец решений честно пуст, а не «0».
 */
export function productList(world: StandWorld, m: Messages, query?: ListQuery, stats?: readonly ScopeDecisionStats[], catalog?: ConsoleCatalogPage,
  options: { filter?: OfferFilter; sort?: OfferSort | null; buybox?: ReadonlyMap<string, BuyboxCells> | null } = {}): ProductListView {
  const { state } = world;
  const p = m.ui.products;
  /**
   * Р-136: строится только показанная страница. Шаг 66 (OQ-248): страницу и итоги может выбрать база — тогда в состоянии мира только
   * единицы страницы (в порядке каталога), а итоги по всему каталогу пришли числами
   */
  // Шаг 105: листается то, что прошло фильтр (`matched`); итоги — по всему каталогу
  const { shown, page } = catalog ? { shown: catalogRows(state.scopes, catalog), page: pageInfo({ ...listQuery(query), offset: catalog.offset }, catalog.matched ?? catalog.total, m) } : productPage(world, m, query);
  const statsById = new Map((stats ?? []).map((s) => [s.writeScopeId, s]));
  // «Применяется сейчас» считается по записям в полёте: они есть у немногих офферов, и это дешевле перебора каталога
  const scopesWithWrites = new Set(state.writes.map((w) => w.writeScopeId));
  const shownApplying = state.scopes.filter((sc) => scopesWithWrites.has(sc.writeScopeId))
    .filter((sc) => ['progress', 'warn'].includes(applyingCell(sc, state.writes, m).tone)).length;
  const rows = shown.map((scope): ProductRow => {
    const stat = statsById.get(scope.writeScopeId) ?? null;
    const floor = effectiveFloor(scope, world);
    const money = (v: number | null) => m.money(v, scope.currency);
    // Шаг 102 [Р-227]: источник пола — распродажа, безубыточность, минимальная маржа или минимальная цена
    const parts = floor.aboveCeiling ? p.frozenDetail
      : floor.source === 'CLEARANCE' ? p.floorFromClearance
      : floor.minMinor === null ? p.floorNoMin
        : floor.marginUnavailableCause ? p.floorMarginUnavailable(money(floor.minMinor), m.values[floor.marginUnavailableCause as keyof typeof m.values] ?? floor.marginUnavailableCause)
          : floor.source === 'BREAK_EVEN' ? p.floorFromBreakEven(money(floor.minMinor))
            : floor.source === 'MARGIN' ? p.floorFromMargin(m.percentBp(floor.minMarginBp!), money(floor.marginFloorMinor), money(floor.minMinor))
              : p.floorFromMin(money(floor.minMinor));
    return {
      unit: unitOf(world, scope, m),
      currentPrice: money(scope.currentPriceMinor),
      floor: { amount: money(floor.minor), minor: floor.minor, parts },
      minPrice: boundText(scope.bounds.min, scope.currency, m),
      maxPrice: boundText(scope.bounds.max, scope.currency, m),
      strategy: strategyLabel(scope.strategy, scope.currency, m),
      enabled: enabledCell(scope, m),
      applying: applyingCell(scope, state.writes, m),
      lastChange: lastChangeCell(scope, state.writes, m),
      nextCheck: { tone: 'unknown', label: m.ui.nextCheck.label, detail: m.ui.nextCheck.detail },
      latestDecisionId: stat?.latestDecisionId ?? null,
      decisions: stat ? stat.decisions : null,
      // Р-120 (ревью шага 23, находка 1): у предложения ценообразование канала — включение отклонит база, кнопки нет
      canEnable: scope.pricingMode === 'OFF' && can(world.viewer.role, 'ENABLE_REPRICING') && !channelNotes(world, scope, m).some((n) => n.code !== 'PRICING_HEALTH'),
      channelNotes: channelNotes(world, scope, m),
      clearance: scope.clearance ? p.clearancePill : null,
      frozen: floor.aboveCeiling ? p.floorAboveCeiling : null,
      channelBounds: channelBoundsPill(world, scope, m),
      notAssigned: notAssignedText(scope, m),
      ...(options.buybox ? { buybox: options.buybox.get(scope.writeScopeId) ?? null } : {}),
    };
  });
  return {
    worldId: world.id,
    now: m.when(world.now),
    // Итоги — по ВСЕМУ каталогу, а не по показанной странице: «включено 3 из 10 000» продавец читает как состояние дел
    totals: catalog
      ? { total: catalog.total, enabled: catalog.enabled, applying: catalog.applying, stopped: catalog.stopped, off: catalog.off }
      : { ...catalogTotals(world, m), applying: shownApplying },
    rows,
    page,
    gaps: [...((catalog ? catalog.pricingHealthIssues : state.pricingHealth.length > 0) ? [gap(m, 'PRICING_HEALTH_ISSUES')] : [])],
    filters: { ...(options.filter ?? NO_FILTER), storefronts: storefrontChoices(world, m) },
    sort: options.sort ?? null,
    matched: options.filter && filterActive(options.filter) && catalog ? catalog.matched : null,
    buyboxShown: Boolean(options.buybox),
  };
}

export const NO_FILTER: OfferFilter = { storefront: null, holder: null, q: '' };
export const filterActive = (f: OfferFilter): boolean => f.storefront !== null || f.holder !== null || f.q !== '';

/** Итоги каталога целиком — правило экрана Offers без базы; на PostgreSQL их считает база (`consoleCatalogPage`) */
export function catalogTotals(world: StandWorld, m: Messages): { total: number; enabled: number; applying: number; stopped: number; off: number } {
  const { state } = world;
  const scopesWithWrites = new Set(state.writes.map((w) => w.writeScopeId));
  return {
    total: state.scopes.length,
    enabled: state.scopes.filter((sc) => enabledCell(sc, m).tone === 'ok').length,
    applying: state.scopes.filter((sc) => scopesWithWrites.has(sc.writeScopeId)).filter((sc) => ['progress', 'warn'].includes(applyingCell(sc, state.writes, m).tone)).length,
    stopped: state.scopes.filter((sc) => enabledCell(sc, m).tone === 'stop').length,
    off: state.scopes.filter((sc) => enabledCell(sc, m).tone === 'off').length,
  };
}

/**
 * Поиск предложения по подписи экрана, номеру единицы, ключу канала и EAN — правило без базы; на PostgreSQL то же правило — запросом
 * (`consoleCatalogFacts.search`, страница каталога шага 105). `q` — уже в нижнем регистре и без пробелов по краям
 */
export function offerMatchesSearch(world: StandWorld, scope: ConsoleScope, q: string, m: Messages): boolean {
  if (q === '') return true;
  const unit = unitOf(world, scope, m);
  return [unit.label, scope.externalUnitId, scope.channelProductRef, scope.gtin ?? ''].some((v) => String(v).toLowerCase().includes(q));
}
