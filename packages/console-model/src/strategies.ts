import { COMPETE_WITH, COMPETITOR_ANCHORS, DANGEROUS_DEVIATION_BP, STRATEGY_TYPES, type CompeteWith, type CompetitorAnchor, type StrategyDefinition, type StrategyParams } from '@repracer/pricing-model';
import type { StrategyPreview } from '@repracer/pricing-pipeline';
import { describe, type HumanReason } from './explain.ts';
import type { Messages } from './i18n/index.ts';
import { catalogPageOf, listQuery, type ListQuery, type PageInfo } from './page.ts';
import { channelNotes, strategyLabel } from './products.ts';
import { catalogFirst, channelOf, gap, scopeById, storefrontName, unitOf, type ConsoleScope, type Gap, type StandWorld, type StatusCell, type Tone, type UnitRef } from './world.ts';

/**
 * Экран стратегий (шаг 21): черновик стратегии проверяется на реальных единицах записи до сохранения — те же движок и Gate, что
 * у оценки, на последнем принятом снимке товара. Сохранить можно только то, что показал экран: токен превью сверяет сервер.
 */

export interface StrategyDraft {
  name: string;
  params: StrategyParams;
  deadbandMinor: number;
}

export type DraftProblem = { field: string; code: 'REQUIRED' | 'NOT_A_WHOLE_AMOUNT' | 'OUT_OF_RANGE' | 'UNKNOWN_TYPE' | 'UNSUPPORTED_TYPE' };

const MAX_MINOR = 100_000_000;

/** Разбор черновика из запроса: суммы — целые центы, маржа — базисные пункты; POSITION движком не считается */
export function parseStrategyDraft(raw: unknown): { ok: true; draft: StrategyDraft } | { ok: false; problems: DraftProblem[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = (r.params ?? {}) as Record<string, unknown>;
  const problems: DraftProblem[] = [];
  const minor = (field: string, value: unknown, min: number): number => {
    if (value === undefined || value === null || value === '') { problems.push({ field, code: 'REQUIRED' }); return 0; }
    if (!Number.isSafeInteger(value)) { problems.push({ field, code: 'NOT_A_WHOLE_AMOUNT' }); return 0; }
    if ((value as number) < min || (value as number) > MAX_MINOR) problems.push({ field, code: 'OUT_OF_RANGE' });
    return value as number;
  };
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name.length === 0 || name.length > 80) problems.push({ field: 'name', code: name.length === 0 ? 'REQUIRED' : 'OUT_OF_RANGE' });
  const deadbandMinor = minor('deadbandMinor', r.deadbandMinor ?? 0, 0);
  const type = p.type;
  /**
   * Шаг 101 [Р-226]: ориентир и фильтр «Compete with». Умолчание типа не хранится — у версии без поля поведение прежнее; неизвестное
   * значение — ошибка поля, а не молчаливое умолчание
   */
  const choice = <T extends string>(field: string, values: readonly T[], fallback: T): { [k: string]: T } => {
    const v = p[field];
    if (v === undefined || v === null || v === '' || v === fallback) return {};
    if (!(values as readonly unknown[]).includes(v)) { problems.push({ field, code: 'OUT_OF_RANGE' }); return {}; }
    return { [field]: v as T };
  };
  const competeWith = () => choice<CompeteWith>('competeWith', COMPETE_WITH, 'ALL') as { competeWith?: CompeteWith };
  const anchor = (fallback: CompetitorAnchor) => choice<CompetitorAnchor>('anchor', COMPETITOR_ANCHORS, fallback) as { anchor?: CompetitorAnchor };
  let params: StrategyParams | null = null;
  if (!(STRATEGY_TYPES as readonly unknown[]).includes(type)) problems.push({ field: 'type', code: 'UNKNOWN_TYPE' });
  else if (type === 'FIXED') params = { type, priceMinor: minor('priceMinor', p.priceMinor, 1) };
  else if (type === 'TARGET_MARGIN') {
    const bp = minor('targetMarginBp', p.targetMarginBp, 0);
    if (bp >= 10_000) problems.push({ field: 'targetMarginBp', code: 'OUT_OF_RANGE' });
    params = { type, targetMarginBp: bp };
  } else if (type === 'MATCH_BUYBOX') {
    params = { type, undercutMinor: minor('undercutMinor', p.undercutMinor ?? 0, 0), holdWhenWinning: p.holdWhenWinning === true, atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP', ...competeWith() };
  } else if (type === 'BEAT_LOWEST') {
    params = {
      type, undercutMinor: minor('undercutMinor', p.undercutMinor ?? 0, 0), scope: p.scope === 'MARKET' ? 'MARKET' : 'VISIBLE_TOP_N',
      compareLanded: p.compareLanded === true, atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP', ...anchor('LOWEST'), ...competeWith(),
    };
  } else if (type === 'WIN_BUYBOX') {
    // Шаг 97 [Р-219]: подъём по умолчанию выключен; его шаг — базисные пункты, не больше 10 % (больший шаг урежет предел шага Gate)
    const creepUp = p.creepUp === true;
    const creepStepBp = creepUp ? minor('creepStepBp', p.creepStepBp, 1) : (Number.isSafeInteger(p.creepStepBp) ? (p.creepStepBp as number) : 100);
    if (creepUp && creepStepBp > 1000) problems.push({ field: 'creepStepBp', code: 'OUT_OF_RANGE' });
    params = {
      type, undercutMinor: minor('undercutMinor', p.undercutMinor ?? 0, 0), fulfillmentHandicapMinor: minor('fulfillmentHandicapMinor', p.fulfillmentHandicapMinor ?? 0, 0),
      creepUp, creepStepBp: Math.max(1, Math.min(1000, creepStepBp)), atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP', ...anchor('BUYBOX'), ...competeWith(),
    };
  } else problems.push({ field: 'type', code: 'UNSUPPORTED_TYPE' });
  return problems.length > 0 || !params ? { ok: false, problems } : { ok: true, draft: { name, params, deadbandMinor } };
}

/** Сколько предложений показать у стратегии в списке: остальное — числом */
export const STRATEGY_SCOPE_EXAMPLES = 10;

export interface StrategyListItem {
  strategyId: string;
  /** Последняя версия стратегии */
  version: number;
  /** Имя, данное человеком; у стратегий посева имени нет */
  name: string | null;
  label: string;
  detail: string;
  /** Офферы на любой версии этой стратегии: подпись оффера и версия */
  /** Примеры предложений, где стратегия назначена (не весь список: его может быть десять тысяч) */
  scopes: Array<{ unit: UnitRef; version: number }>;
  /** Сколько предложений пользуются стратегией всего */
  scopeCount: number;
  /** Шаг 78: сколько их на каждой витрине — сводка карточки («200 offers · kaufland.de») вместо стены подписей через запятую */
  storefronts: Array<{ label: string; count: number }>;
  /** Черновик новой версии — параметры последней версии */
  draft: StrategyDraft;
  /** OQ-170 (шаг 24): версии с автором, моментом и статусом — от новой к старой; у стратегий посева в памяти — только номер */
  versions: Array<{ version: number; status: string; tone: Tone; author: string; createdAt: string }>;
  /** OQ-169: последнюю версию можно назначить выбранным офферам без новой версии — только действующую */
  assignable: boolean;
  /** Шаг 103 [Р-228]: для каких аккаунтов стратегия — умолчание новых предложений («Default for new offers on: …»), иначе null */
  defaultFor: string | null;
}

export interface StrategyScopeItem {
  unit: UnitRef;
  strategy: string;
  mode: string;
  /** Р-120: у оффера действует собственное ценообразование канала — стратегию не назначит база */
  channelPricing: StatusCell | null;
  assignable: boolean;
  /** Стратегия единицы — для назначения и снятия (OQ-169) */
  strategyId: string | null;
  version: number | null;
  /** OQ-169: стратегию можно снять — она есть, репрайсинг выключен, у зрителя есть право */
  canUnassign: boolean;
  /** Шаг 103 [Р-228]: нынешнюю стратегию назначило правило умолчания аккаунта — «by default rule», иначе null */
  byDefaultRule: string | null;
}

/** Шаг 66 (ревью, находка 7): сколько предложений с ценообразованием канала экран стратегий называет поимённо */
export const CHANNEL_PRICING_SHOWN = 200;

export interface StrategyListView {
  worldId: string;
  strategies: StrategyListItem[];
  scopes: StrategyScopeItem[];
  /** Р-136: страница предложений — каталог целевого клиента в один ответ не помещается */
  page: PageInfo;
  /** Р-120: все офферы аккаунтов с правилом или границами канала, найденные при обнаружении, — до назначения стратегии */
  channelPricingOffers: Array<{ label: string; detail: string; tone: Tone }>;
  /** Шаг 66 (ревью, находка 7): сколько таких предложений всего — список ограничен, у мигрирующего продавца Amazon их тысячи */
  channelPricingOffersTotal: number;
  canEdit: boolean;
  gaps: Gap[];
}

export function strategiesView(world: StandWorld, m: Messages, canEdit: boolean, query?: ListQuery): StrategyListView {
  const latest = new Map<string, StrategyDefinition>();
  for (const d of [...world.state.strategies, ...world.state.scopes.flatMap((s) => (s.strategy ? [s.strategy] : []))]) {
    const known = latest.get(d.strategyId);
    if (!known || d.version > known.version) latest.set(d.strategyId, d);
  }
  /**
   * Шаг 67 (OQ-248): у мира выбранных единиц использование стратегий — фактами базы (сколько предложений и первые из них), а не
   * проходом по каталогу целиком
   */
  const usage = world.catalogFacts?.strategyUsage ?? null;
  // Витрины — одним правилом на оба пути (факты базы и каталог мира): по числу предложений, затем по подписи
  const storefrontsOf = (rows: Array<{ channel: string; marketplace: string; count: number }>) => {
    const byLabel = new Map<string, number>();
    for (const r of rows) { const label = storefrontName(r.channel, r.marketplace, m); byLabel.set(label, (byLabel.get(label) ?? 0) + r.count); }
    return [...byLabel].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };
  const usageOf = (strategyId: string): { count: number; examples: ConsoleScope[]; firstCurrency: string | undefined; storefronts: Array<{ label: string; count: number }> } => {
    if (!usage) {
      const using = world.state.scopes.filter((s) => s.strategy?.strategyId === strategyId);
      return {
        count: using.length, examples: using.slice(0, STRATEGY_SCOPE_EXAMPLES), firstCurrency: using[0]?.currency,
        storefronts: storefrontsOf(using.map((s) => ({ channel: channelOf(world, s.channelAccountId), marketplace: s.marketplace, count: 1 }))),
      };
    }
    const u = usage.find((x) => x.strategyId === strategyId);
    return {
      count: u?.count ?? 0, firstCurrency: u?.firstCurrency, storefronts: storefrontsOf(u?.storefronts ?? []),
      examples: (u?.exampleIds ?? []).slice(0, STRATEGY_SCOPE_EXAMPLES).flatMap((id) => { const sc = scopeById(world, id); return sc ? [sc] : []; }),
    };
  };
  const strategies = [...latest.values()].map((d): StrategyListItem => {
    const using = usageOf(d.strategyId);
    const label = strategyLabel(d, using.firstCurrency ?? catalogFirst(world, 1)[0]?.currency ?? '', m);
    const versions = world.state.strategyVersions.filter((x) => x.strategyId === d.strategyId);
    const name = versions.find((x) => x.version === d.version)?.name ?? versions.at(-1)?.name ?? null;
    const member = (id: string | null) => {
      if (!id) return m.ui.strategies.authorUnknown;
      const role = world.state.members.find((x) => x.membershipId === id)?.role;
      const label = role ? m.values[role] : m.ui.strategies.authorUnknown;
      // Шаг 78: автор версии — «you», а не «Owner (you)»: строка версии короткая
      return id === world.viewer.membershipId ? m.ui.strategies.you : label;
    };
    const allVersions = [...new Set([...versions.map((x) => x.version), ...world.state.strategies.filter((x) => x.strategyId === d.strategyId).map((x) => x.version), d.version])]
      .sort((a, b) => b - a)
      .map((version) => {
        const meta = versions.find((x) => x.version === version);
        return {
          version, status: meta ? m.ui.strategies.statuses[meta.status] : m.ui.strategies.statusUnknown,
          // Шаг 79: статус версии — пилюлей: действующая зелёная, черновик янтарный, остальное серым
          tone: (meta?.status === 'ACTIVE' ? 'ok' : meta?.status === 'DRAFT' ? 'warn' : 'off') as Tone,
          author: meta ? member(meta.createdByMembershipId) : m.ui.strategies.authorUnknown, createdAt: meta?.createdAt ? m.when(meta.createdAt) : m.ui.common.noValue,
        };
      });
    const latestMeta = versions.find((x) => x.version === d.version);
    return {
      strategyId: d.strategyId, version: d.version, name, label: label.label, detail: label.detail,
      scopes: using.examples.map((s) => ({ unit: unitOf(world, s, m), version: s.strategy!.version })),
      scopeCount: using.count, storefronts: using.storefronts,
      draft: { name: name ?? label.label, params: { ...d.params }, deadbandMinor: d.deadbandMinor },
      versions: allVersions,
      assignable: canEdit && (latestMeta?.status ?? 'ACTIVE') === 'ACTIVE',
      defaultFor: defaultForOf(world, d.strategyId, m),
    };
  }).sort((a, b) => b.scopeCount - a.scopeCount || a.strategyId.localeCompare(b.strategyId));
  // Р-136: список предложений — страницей; ответ экрана на каталоге целевого клиента был 3,7 МБ
  const { items: shownScopes, page } = catalogPageOf(world, listQuery(query), m);
  const scopes = shownScopes.map((s): StrategyScopeItem => {
    const notes = channelNotes(world, s, m).filter((n) => n.code !== 'PRICING_HEALTH');
    return {
      unit: unitOf(world, s, m), mode: m.values[s.pricingMode], strategy: strategyLabel(s.strategy, s.currency, m).label,
      channelPricing: notes[0] ?? null, assignable: notes.length === 0,
      strategyId: s.strategy?.strategyId ?? null, version: s.strategy?.version ?? null,
      canUnassign: canEdit && s.strategy !== null && s.pricingMode !== 'ENGINE',
      byDefaultRule: assignedByDefaultRule(s) ? m.ui.strategies.byDefaultRule : null,
    };
  });
  /**
   * Список — первые CHANNEL_PRICING_SHOWN и общее число: ответ экрана не растёт с каталогом [Р-136]. Шаг 67 (п. 3): у мира выбранных
   * единиц наблюдения ценообразования канала — только этих единиц, и список по всему каталогу приходит фактами базы: первые на аккаунт
   * и сколько их у аккаунта
   */
  const factsPricing = world.catalogFacts?.channelPricing ?? null;
  let channelPricingTotal = 0;
  const channelPricingOffers = world.accounts.flatMap((a) => {
    const channel = m.values[a.channel as keyof typeof m.values] ?? a.channel;
    let flagged: Array<(typeof world.state.offerChannelPricing)[number]>;
    if (factsPricing) {
      const f = factsPricing.find((x) => x.channelAccountId === a.channelAccountId);
      flagged = f?.rows ?? [];
      channelPricingTotal += f?.total ?? 0;
    } else {
      const newest = new Map<string, (typeof world.state.offerChannelPricing)[number]>();
      for (const o of world.state.offerChannelPricing.filter((x) => x.channelAccountId === a.channelAccountId)) newest.set(`${o.marketplace}|${o.externalSku}`, o);
      flagged = [...newest.values()].filter((o) => o.automatedPricing || o.channelBounds);
      channelPricingTotal += flagged.length;
    }
    return flagged.map((o) => ({
      label: m.ui.common.unitLabel(o.externalSku, storefrontName(a.channel, o.marketplace, m)),
      detail: o.automatedPricing ? m.ui.channelNotes.automatedPricingDetail(m.when(o.observedAt)) : m.ui.channelNotes.channelBoundsDetail(m.when(o.observedAt)),
      tone: (o.automatedPricing ? 'stop' : 'warn') as Tone,
    }));
  });
  return {
    worldId: world.id, strategies, scopes, page, canEdit,
    channelPricingOffers: channelPricingOffers.slice(0, CHANNEL_PRICING_SHOWN), channelPricingOffersTotal: channelPricingTotal,
    gaps: [
      gap(m, 'POSITION_STRATEGY'),
      ...(channelPricingTotal > 0 ? [gap(m, 'CHANNEL_PRICING_OFFERS_WITHOUT_SCOPE')] : []),
    ],
  };
}

export interface PreviewRow {
  unit: UnitRef;
  tone: Tone;
  asOf: string;
  current: string;
  proposed: string | null;
  final: string | null;
  change: string | null;
  outcome: string;
  dangerous: boolean;
  reason: HumanReason | null;
  unavailable: string | null;
}

export interface StrategyPreviewView {
  worldId: string;
  draft: { title: string; detail: string };
  rows: PreviewRow[];
  summary: { changes: number; unchanged: number; rejected: number; dangerous: number; notEvaluated: number };
  headline: string;
  /** Сохранение принимается только с этим токеном: черновик и итог превью те же, что видел человек */
  previewToken: string;
  /** Почему сохранить нельзя (канал не даёт данных стратегии [Р-39], у оффера ценообразование канала [Р-120]); null — можно */
  saveBlocked: string | null;
  /**
   * Р-136 (шаг 29): у предпросмотра своя цена — решение считается по каждому предложению. На каталоге целевого клиента он идёт по
   * ВЫБОРКЕ, а назначается стратегия на все выбранные: об этом сказано на экране, а не подразумевается [Р-125].
   */
  sample: { shown: number; total: number; text: string | null };
  /** Показано строк из скольких посчитанных [OQ-201]: итоги и запрет сохранения — по всем, на экране — первые */
  shown: { rows: number; of: number };
  gaps: Gap[];
}

/**
 * Отпечаток того, что видел человек (FNV-1a, две ветви): не секрет и не подпись — сервер пересчитывает его сам и сравнивает.
 *
 * Порядок ключей объекта на отпечаток не влияет [шаг 30]. Это не украшение: параметры и итоги заданий лежат в jsonb, а он
 * хранит ключи в своём порядке. Отпечаток, чувствительный к порядку, у всего, что прошло через базу, не совпадал бы никогда —
 * и сохранение отказывало бы «предпросмотр изменился», хотя не изменилось ничего.
 */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value, (_key, v) => (
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v));
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/** Текущая стратегия единиц превью — то, что сохранение заменит (находка 4 ревью шага 21) */
/**
 * Шаг 103 [Р-228]: нынешнюю стратегию единицы назначило правило умолчания — последняя строка журнала назначений единицы — строка правила
 * с этой же стратегией и версией (ручная смена после неё — уже строка человека)
 */
export function assignedByDefaultRule(s: ConsoleScope): boolean {
  const a = s.assignment;
  return !!a && a.source === 'DEFAULT_RULE' && a.outcome === 'ASSIGNED' && s.strategy !== null && a.strategyId === s.strategy.strategyId && a.version === s.strategy.version;
}

/** Шаг 103 [Р-228]: аккаунты, для которых стратегия — умолчание новых предложений, подписью «канал · аккаунт · витрины» */
function defaultForOf(world: StandWorld, strategyId: string, m: Messages): string | null {
  const accounts = (world.defaultStrategies ?? []).filter((d) => d.strategyId === strategyId)
    .flatMap((d) => { const a = world.accounts.find((x) => x.channelAccountId === d.channelAccountId); return a ? [accountLabel(a, m)] : []; });
  return accounts.length > 0 ? m.ui.strategies.defaultFor(accounts.join('; ')) : null;
}

/** Подпись аккаунта канала словами: «Amazon · A1SYN… · amazon.com» */
export function accountLabel(a: { channel: string; externalAccountId?: string; marketplaces: readonly string[] }, m: Messages): string {
  const channel = (m.values as Record<string, string | undefined>)[a.channel] ?? a.channel;
  return [channel, ...(a.externalAccountId ? [a.externalAccountId] : []), a.marketplaces.map((id) => storefrontName(a.channel, id, m)).join(', ')].filter((x) => x !== '').join(' · ');
}

/**
 * Шаг 103 [Р-228]: стратегии, которые могут быть умолчанием, — последняя АКТИВНАЯ версия каждой (OQ-169), по имени. У версии без строки
 * метаданных (стратегии посева в памяти) статус — действующая, как у «Assign»; имени нет — подпись типа
 */
export function activeStrategyChoices(world: StandWorld, m: Messages): Array<{ strategyId: string; version: number; name: string; params: StrategyParams }> {
  const meta = (d: StrategyDefinition) => world.state.strategyVersions.find((v) => v.strategyId === d.strategyId && v.version === d.version);
  const latest = new Map<string, StrategyDefinition>();
  for (const d of world.state.strategies) {
    if ((meta(d)?.status ?? 'ACTIVE') !== 'ACTIVE') continue;
    if ((latest.get(d.strategyId)?.version ?? 0) < d.version) latest.set(d.strategyId, d);
  }
  return [...latest.values()].map((d) => ({ strategyId: d.strategyId, version: d.version, name: meta(d)?.name ?? strategyLabel(d, '', m).label, params: d.params }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.strategyId.localeCompare(b.strategyId));
}

export function currentStrategies(world: StandWorld, writeScopeIds: readonly string[]): Array<{ writeScopeId: string; strategyId: string | null; version: number | null }> {
  return writeScopeIds.map((id) => {
    const s = scopeById(world, id)?.strategy ?? null;
    return { writeScopeId: id, strategyId: s?.strategyId ?? null, version: s?.version ?? null };
  });
}

export function previewToken(draft: StrategyDraft, previews: readonly StrategyPreview[], world: StandWorld): string {
  return fingerprint([draft, currentStrategies(world, previews.map((p) => p.writeScopeId)),
    previews.map((p) => [p.writeScopeId, p.availability.available, p.stages.map((s) => `${s.stage}:${s.outcome}`).join('>'), p.decision?.finalMinor ?? null, p.intent?.proposedMinor ?? null])]);
}

/**
 * Сколько строк предпросмотра показывать [OQ-201, шаг 30]: как у экрана различий границ. Считается решение по КАЖДОМУ
 * предложению каталога — но 10 000 строк в ответе никто не читает, а браузер их разбирает секундами. Итоги при этом по всем.
 */
export const STRATEGY_PREVIEW_ROWS_SHOWN = 50;

/**
 * Невыполненные требования стратегии по источникам — текстом словаря. Ревью шага 47, находка 11: у канала без источников
 * конкурентов (eBay, Р-39) база и движок называют причину ключом '*' — «источник» не называется, причина — словом, а не кодом.
 */
export function unmetText(unmet: Readonly<Record<string, readonly string[]>>, m: Messages): string {
  return Object.entries(unmet)
    .map(([source, codes]) => {
      const words = codes.map((c) => m.values[c as keyof typeof m.values] ?? c).join(', ');
      return source === '*' ? words : `${source}${m.colon}${words}`;
    })
    .join('; ');
}

export function strategyPreviewView(world: StandWorld, draft: StrategyDraft, previews: readonly StrategyPreview[], m: Messages,
  total = previews.length, shownRows = previews.length): StrategyPreviewView {
  const t = m.ui.strategies;
  const summary = { changes: 0, unchanged: 0, rejected: 0, dangerous: 0, notEvaluated: 0 };
  const rows = previews.map((p): PreviewRow => {
    const scope = scopeById(world, p.writeScopeId)!;
    const money = (v: number | null | undefined) => m.money(v ?? null, p.currency);
    const strategy = p.stages.find((s) => s.stage === 'STRATEGY');
    const unavailable = p.availability.available ? null : t.unavailable(unmetText(p.availability.unmet, m));
    const d = p.decision;
    const dangerous = d?.outcome === 'REJECTED' && d.boundDeviationBp !== null && d.boundDeviationBp > DANGEROUS_DEVIATION_BP;
    let tone: Tone = 'unknown';
    if (!d) summary.notEvaluated += 1;
    else if (d.outcome === 'APPROVED') { summary.changes += 1; tone = 'progress'; }
    // Шаг 79 (ревью): «без изменения» — спокойным серым, как в ленте и в «почему эта цена», а не зелёным успехом
    else if (d.outcome === 'NO_CHANGE') { summary.unchanged += 1; tone = 'off'; }
    else { summary.rejected += 1; tone = dangerous ? 'stop' : 'warn'; }
    if (dangerous) summary.dangerous += 1;
    const reason = d ? describe(d.reason, m) : strategy?.reason ? describe(strategy.reason, m) : null;
    return {
      unit: unitOf(world, scope, m), tone, asOf: p.snapshotObservedAt ? t.asOfSnapshot(m.when(p.snapshotObservedAt)) : t.asOfNow(m.when(p.evaluatedAt)),
      current: money(p.currentPriceMinor), proposed: p.intent ? money(p.intent.proposedMinor) : null,
      final: d?.finalMinor !== undefined && d.finalMinor !== null ? money(d.finalMinor) : null,
      change: d?.outcome === 'APPROVED' ? m.change(p.currentPriceMinor, d.finalMinor) : null,
      outcome: d ? m.ui.outcomes[d.outcome] : t.notEvaluated, dangerous, reason, unavailable,
    };
  });
  const label = strategyLabel({ strategyId: 'draft', version: 1, params: draft.params, deadbandMinor: draft.deadbandMinor }, previews[0]?.currency ?? '', m);
  const channelPriced = rows.filter((r) => { const scope = scopeById(world, r.unit.writeScopeId); return scope ? channelNotes(world, scope, m).some((n) => n.code !== 'PRICING_HEALTH') : false; });
  // Запрет сохранения считается по ВСЕМ предложениям, а не по показанным: иначе он зависел бы от длины страницы
  const saveBlocked = rows.some((r) => r.unavailable !== null) ? t.blockedUnavailable
    : channelPriced.length > 0 ? t.blockedChannelPricing(channelPriced.slice(0, 5).map((r) => r.unit.label).join(', ')) : null;
  return {
    worldId: world.id, draft: { title: draft.name === label.label ? draft.name : `${draft.name} · ${label.label}`, detail: label.detail }, rows: rows.slice(0, shownRows), summary, saveBlocked,
    shown: { rows: Math.min(rows.length, shownRows), of: rows.length },
    sample: { shown: previews.length, total, text: total > previews.length ? t.sample(previews.length, total) : null },
    headline: t.headline(summary), previewToken: previewToken(draft, previews, world),
    gaps: [gap(m, 'PREVIEW_LAST_SNAPSHOT'), gap(m, 'PREVIEW_CURRENT_BOUNDS')],
  };
}
