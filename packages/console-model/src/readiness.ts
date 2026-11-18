import type { MarketplaceProperty } from '@repracer/pricing-store-pg';
import type { OfferSetupFilter, ReadinessFacts, ReadinessStorefrontFacts } from '@repracer/pricing-pipeline/store';
import type { Messages } from './i18n/index.ts';
import { attentionReasons, freshnessItems, type FreshnessRow } from './status-line.ts';
import { storefrontName, type ConsoleScope, type StandWorld } from './world.ts';

/**
 * Шаг 170 (#35, решение владельца 2026-11-18): чеклист готовности к бою — блоком на Shadow mode у каждого аккаунта в тени и тем же списком
 * в форме перевода в бой. Два класса раздельно:
 *  - «нельзя» (`BLOCKS`) — перевод откажет: те же правила, что у стража журнала режимов (закрытая для боевых записей база, неизвестное
 *    свойство витрины, включённые предложения с рамками Amazon без значений — число функции стража), доступ к каналу; в форме — ещё роль и
 *    второй фактор входа;
 *  - «не стоит» (`ADVISE`) — советуем, не блокируем: выключенные предложения, без себестоимости или комиссий, без стратегии, без границ,
 *    Automate Pricing, другой инструмент меняет цены (или вопрос без ответа), устаревшие данные конкурентов.
 * Каждый пункт ведёт в свою выборку: число пункта — правило той же выборки (на PostgreSQL — фрагменты фильтров Offers, без базы — правило
 * экрана); спецификация — docs/evidence/step170-shadow-readiness.md
 */

export type ReadinessClass = 'BLOCKS' | 'ADVISE';
export type ReadinessCode =
  | 'LIVE_WRITES_FORBIDDEN' | 'NO_ACCESS' | 'PROPERTY_UNKNOWN' | 'BOUNDS_UNREAD' | 'ROLE' | 'SECOND_FACTOR'
  | 'OFFERS_OFF' | 'NO_UNIT_COST' | 'NO_STRATEGY' | 'NO_BOUNDS' | 'AUTOMATED_PRICING' | 'OTHER_TOOL' | 'OTHER_TOOL_UNANSWERED' | 'STALE_DATA';

/** Проверки, которые продавец видит пройденными одной строкой — в порядке списка */
const CHECKS: readonly ReadinessCode[] = ['NO_ACCESS', 'PROPERTY_UNKNOWN', 'BOUNDS_UNREAD', 'OFFERS_OFF', 'NO_UNIT_COST', 'NO_STRATEGY', 'NO_BOUNDS', 'AUTOMATED_PRICING', 'OTHER_TOOL', 'STALE_DATA'];

/** Выборка пункта: части адреса экрана рабочего пространства (`href(worldId, ...target)`) и подпись ссылки, если ссылок несколько */
export interface ReadinessLink { label: string; target: string[]; count: number | null }

export interface ReadinessItem {
  code: ReadinessCode;
  cls: ReadinessClass;
  text: string;
  /** Число пункта (предложений); null — пункт не о предложениях (доступ, свойства, роль) */
  count: number | null;
  /** Одна витрина — одна ссылка на весь пункт; у аккаунта нескольких витрин — по ссылке на витрину; пусто — ведёт некуда (среда, роль) */
  links: ReadinessLink[];
}

export interface AccountReadiness {
  channelAccountId: string;
  /** Чеклист показывается у аккаунта в тени; у боевого — тот же расчёт, экран его не показывает */
  writeMode: 'SHADOW' | 'LIVE';
  account: string;
  headline: string;
  blocks: ReadinessItem[];
  advice: ReadinessItem[];
  /** «Checked and fine: …» — пройденные проверки словами; null — пройденных нет */
  fine: string | null;
  /** Перевод откажет — кнопка неактивна; причина — первым пунктом «нельзя» */
  canSwitch: boolean;
}

export interface ReadinessView {
  worldId: string;
  accounts: AccountReadiness[];
}

export interface ReadinessAccountInput {
  channelAccountId: string;
  channel: string;
  marketplaces: readonly string[];
  authStatus: string;
  writeMode: 'SHADOW' | 'LIVE';
  /** Ответ о других инструментах [Р-202]; undefined — экрану не известен (мир без подключений) */
  otherTools?: string | null;
}

export interface ReadinessInput {
  worldId: string;
  now: string;
  accounts: readonly ReadinessAccountInput[];
  facts: ReadinessFacts;
  properties: readonly MarketplaceProperty[];
  liveWritesRefused: boolean;
  freshness: readonly FreshnessRow[] | null;
  /** Только в форме перевода: может ли зритель переводить в бой и вошёл ли со вторым фактором; null — блок экрана, не форма */
  viewer: { canSwitch: boolean; secondFactor: boolean } | null;
}

/**
 * Шаг 170 (#35): чего предложению не хватает для включения — правило фильтра Setup без базы: стратегии нет или минимальная либо максимальная
 * цена не разрешается (как `SETUP_SQL` хранилища PostgreSQL)
 */
export function setupGaps(scope: ConsoleScope): OfferSetupFilter[] {
  const gaps: OfferSetupFilter[] = [];
  if (scope.strategy === null) gaps.push('NO_STRATEGY');
  if (scope.bounds.min.status !== 'RESOLVED' || scope.bounds.max.status !== 'RESOLVED') gaps.push('NO_BOUNDS');
  return gaps;
}

/** Факты готовности по каталогу мира — правило экрана; на PostgreSQL их считает база теми же правилами (`consoleCatalogFacts.readiness`) */
export function readinessFactsOf(world: StandWorld, m: Messages): ReadinessFacts {
  const byStorefront = new Map<string, ReadinessStorefrontFacts>();
  for (const scope of world.state.scopes) {
    const key = `${scope.channelAccountId}|${scope.marketplace}`;
    const f = byStorefront.get(key) ?? { channelAccountId: scope.channelAccountId, marketplace: scope.marketplace, offers: 0, off: 0, noUnitCost: 0, noStrategy: 0, noBounds: 0, automatedPricing: 0, boundsUnreadOn: 0 };
    const reasons = attentionReasons(world, scope, m);
    const gaps = setupGaps(scope);
    f.offers += 1;
    if (scope.pricingMode === 'OFF') f.off += 1;
    if (reasons.includes('NO_UNIT_COST')) f.noUnitCost += 1;
    if (gaps.includes('NO_STRATEGY')) f.noStrategy += 1;
    if (gaps.includes('NO_BOUNDS')) f.noBounds += 1;
    if (reasons.includes('AUTOMATED_PRICING')) f.automatedPricing += 1;
    if (reasons.includes('CHANNEL_BOUNDS') && scope.pricingMode === 'ENGINE') f.boundsUnreadOn += 1;
    byStorefront.set(key, f);
  }
  const storefronts = [...byStorefront.values()].sort((a, b) => a.channelAccountId.localeCompare(b.channelAccountId) || a.marketplace.localeCompare(b.marketplace));
  // Число стража без базы — то же правило: включённые предложения с рамками без значений
  const blocking = new Map<string, number>();
  for (const f of storefronts) if (f.boundsUnreadOn > 0) blocking.set(f.channelAccountId, (blocking.get(f.channelAccountId) ?? 0) + f.boundsUnreadOn);
  return { storefronts, blockingBounds: [...blocking].map(([channelAccountId, total]) => ({ channelAccountId, total })) };
}

/** Выборка Offers: `products/filter/<параметры>` — витрина и фильтры экрана (ряд фильтров Offers читает их из адреса) */
function offersTarget(f: ReadinessStorefrontFacts, filters: Record<string, string>): string[] {
  return ['products', 'filter', new URLSearchParams({ storefront: `${f.channelAccountId}|${f.marketplace}`, ...filters }).toString()];
}

export function readinessView(input: ReadinessInput, m: Messages): ReadinessView {
  const t = m.ui.readiness;
  const fresh = freshnessItems({ now: input.now, accounts: input.accounts, freshness: input.freshness }, m);
  const accounts = input.accounts.map((a): AccountReadiness => {
    const name = (id: string) => storefrontName(a.channel, id, m);
    const account = a.marketplaces.map(name).join(', ');
    const sf = input.facts.storefronts.filter((f) => f.channelAccountId === a.channelAccountId);
    const multi = sf.length > 1;
    // Пункт витрин: сумма по витринам аккаунта; одна витрина — ссылка на весь пункт, несколько — ссылка на каждую витрину с её числом
    const perStorefront = (code: ReadinessCode, cls: ReadinessClass, count: (f: ReadinessStorefrontFacts) => number, text: (n: number) => string, filters: Record<string, string>, total?: number): ReadinessItem | null => {
      const parts = sf.filter((f) => count(f) > 0);
      const n = total ?? parts.reduce((s, f) => s + count(f), 0);
      if (n === 0) return null;
      return { code, cls, text: text(n), count: n, links: parts.map((f) => ({ label: multi ? t.storefrontCount(name(f.marketplace), count(f)) : '', target: offersTarget(f, filters), count: count(f) })) };
    };
    const blocks: ReadinessItem[] = [];
    const advice: ReadinessItem[] = [];
    // Закрытая база — единственная причина: остальное бой здесь не откроет всё равно (как у экрана тени, шаг 120)
    if (input.liveWritesRefused) blocks.push({ code: 'LIVE_WRITES_FORBIDDEN', cls: 'BLOCKS', text: t.items.liveWritesForbidden, count: null, links: [] });
    else {
      if (a.authStatus !== 'ACTIVE') blocks.push({ code: 'NO_ACCESS', cls: 'BLOCKS', text: a.authStatus === 'REVOKED' ? t.items.revoked : t.items.noAccess, count: null, links: [{ label: '', target: ['channels', 'accounts'], count: null }] });
      const unknown = input.properties.filter((p) => p.status === 'UNKNOWN' && a.marketplaces.includes(p.marketplace) && p.channel === a.channel);
      if (unknown.length > 0) {
        // Ссылка — на блок «что мы ещё проверяем о магазинах» этого же экрана: адрес `shadow/properties` раскрывает его и ведёт к нему
        blocks.push({ code: 'PROPERTY_UNKNOWN', cls: 'BLOCKS', count: null, links: [{ label: '', target: ['shadow', 'properties'], count: null }],
          text: t.items.propertyUnknown(unknown.map((p) => `${name(p.marketplace)} · ${m.ui.shadow.properties.names[p.property] ?? m.ui.shadow.properties.someProperty}`).join(', ')) });
      }
      const guard = input.facts.blockingBounds.find((b) => b.channelAccountId === a.channelAccountId)?.total ?? 0;
      const bounds = perStorefront('BOUNDS_UNREAD', 'BLOCKS', (f) => f.boundsUnreadOn, t.items.boundsUnread, { pricing: 'ON', attention: 'CHANNEL_BOUNDS' }, guard);
      if (bounds) blocks.push(bounds);
      if (input.viewer && !input.viewer.canSwitch) blocks.push({ code: 'ROLE', cls: 'BLOCKS', text: m.ui.shadow.errors.notOwner, count: null, links: [] });
      if (input.viewer && input.viewer.canSwitch && !input.viewer.secondFactor) blocks.push({ code: 'SECOND_FACTOR', cls: 'BLOCKS', text: m.ui.shadow.errors.mfa, count: null, links: [] });
    }
    for (const item of [
      perStorefront('OFFERS_OFF', 'ADVISE', (f) => f.off, (n) => t.items.offersOff(n, sf.reduce((s, f) => s + f.offers, 0)), { pricing: 'OFF' }),
      perStorefront('NO_UNIT_COST', 'ADVISE', (f) => f.noUnitCost, t.items.noUnitCost, { attention: 'NO_UNIT_COST' }),
      perStorefront('NO_STRATEGY', 'ADVISE', (f) => f.noStrategy, t.items.noStrategy, { setup: 'NO_STRATEGY' }),
      perStorefront('NO_BOUNDS', 'ADVISE', (f) => f.noBounds, t.items.noBounds, { setup: 'NO_BOUNDS' }),
      perStorefront('AUTOMATED_PRICING', 'ADVISE', (f) => f.automatedPricing, t.items.automatedPricing, { attention: 'AUTOMATED_PRICING' }),
    ]) if (item) advice.push(item);
    // Другой инструмент [Р-202]: два репрайсера на одном канале — совет; ответа нет — совет ответить. Экран без подключений — без пункта
    if (a.otherTools === 'PRICES' || a.otherTools === 'STOCK_AND_PRICES') advice.push({ code: 'OTHER_TOOL', cls: 'ADVISE', text: t.items.otherTool, count: null, links: [{ label: '', target: ['channels', 'accounts'], count: null }] });
    else if (a.otherTools === null) advice.push({ code: 'OTHER_TOOL_UNANSWERED', cls: 'ADVISE', text: t.items.otherToolUnanswered, count: null, links: [{ label: '', target: ['channels', 'accounts'], count: null }] });
    const freshness = fresh.find((f) => f.channelAccountId === a.channelAccountId);
    if (freshness?.level === 'STALE') advice.push({ code: 'STALE_DATA', cls: 'ADVISE', text: t.items.staleData(freshness.text), count: null, links: [{ label: '', target: freshness.target, count: null }] });
    const failed = new Set<ReadinessCode>([...blocks, ...advice].map((x) => x.code === 'OTHER_TOOL_UNANSWERED' ? 'OTHER_TOOL' : x.code));
    // Пройденные: только проверки, о которых экран знает (о другом инструменте без подключений и о свежести без стратегий из данных — молчим)
    // Рамки Amazon и Automate Pricing — проверки Amazon: у других каналов их нет, и «пройдены» они там не бывают
    const fine = input.liveWritesRefused ? [] : CHECKS.filter((c) => !failed.has(c)
      && (c !== 'OTHER_TOOL' || a.otherTools !== undefined) && (c !== 'STALE_DATA' || freshness !== undefined)
      && ((c !== 'BOUNDS_UNREAD' && c !== 'AUTOMATED_PRICING') || a.channel === 'AMAZON'));
    return {
      channelAccountId: a.channelAccountId, writeMode: a.writeMode, account,
      headline: blocks.length > 0 ? t.headline.blocks(blocks.length) : advice.length > 0 ? t.headline.advice(advice.length) : t.headline.ready,
      blocks, advice, fine: fine.length > 0 ? t.fine(fine.map((c) => t.checks[c as keyof typeof t.checks]).join(', ')) : null,
      canSwitch: blocks.length === 0,
    };
  });
  return { worldId: input.worldId, accounts };
}
