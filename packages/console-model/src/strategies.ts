import { DANGEROUS_DEVIATION_BP, STRATEGY_TYPES, type StrategyDefinition, type StrategyParams } from '@repracer/pricing-model';
import type { StrategyPreview } from '@repracer/pricing-pipeline';
import { describe, type HumanReason } from './explain.ts';
import type { Messages } from './i18n/index.ts';
import { channelNotes, strategyLabel } from './products.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type StatusCell, type Tone, type UnitRef } from './world.ts';

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
  let params: StrategyParams | null = null;
  if (!(STRATEGY_TYPES as readonly unknown[]).includes(type)) problems.push({ field: 'type', code: 'UNKNOWN_TYPE' });
  else if (type === 'FIXED') params = { type, priceMinor: minor('priceMinor', p.priceMinor, 1) };
  else if (type === 'TARGET_MARGIN') {
    const bp = minor('targetMarginBp', p.targetMarginBp, 0);
    if (bp >= 10_000) problems.push({ field: 'targetMarginBp', code: 'OUT_OF_RANGE' });
    params = { type, targetMarginBp: bp };
  } else if (type === 'MATCH_BUYBOX') {
    params = { type, undercutMinor: minor('undercutMinor', p.undercutMinor ?? 0, 0), holdWhenWinning: p.holdWhenWinning === true, atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP' };
  } else if (type === 'BEAT_LOWEST') {
    params = {
      type, undercutMinor: minor('undercutMinor', p.undercutMinor ?? 0, 0), scope: p.scope === 'MARKET' ? 'MARKET' : 'VISIBLE_TOP_N',
      compareLanded: p.compareLanded === true, atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP',
    };
  } else problems.push({ field: 'type', code: 'UNSUPPORTED_TYPE' });
  return problems.length > 0 || !params ? { ok: false, problems } : { ok: true, draft: { name, params, deadbandMinor } };
}

export interface StrategyListItem {
  strategyId: string;
  /** Последняя версия стратегии */
  version: number;
  /** Имя, данное человеком; у стратегий посева имени нет */
  name: string | null;
  label: string;
  detail: string;
  /** Офферы на любой версии этой стратегии: подпись оффера и версия */
  scopes: Array<{ unit: UnitRef; version: number }>;
  /** Черновик новой версии — параметры последней версии */
  draft: StrategyDraft;
  /** OQ-170 (шаг 24): версии с автором, моментом и статусом — от новой к старой; у стратегий посева в памяти — только номер */
  versions: Array<{ version: number; status: string; author: string; createdAt: string }>;
  /** OQ-169: последнюю версию можно назначить выбранным офферам без новой версии — только действующую */
  assignable: boolean;
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
}

export interface StrategyListView {
  worldId: string;
  strategies: StrategyListItem[];
  scopes: StrategyScopeItem[];
  /** Р-120: все офферы аккаунтов с правилом или границами канала, найденные при обнаружении, — до назначения стратегии */
  channelPricingOffers: Array<{ label: string; detail: string; tone: Tone }>;
  canEdit: boolean;
  gaps: Gap[];
}

export function strategiesView(world: StandWorld, m: Messages, canEdit: boolean): StrategyListView {
  const latest = new Map<string, StrategyDefinition>();
  for (const d of [...world.state.strategies, ...world.state.scopes.flatMap((s) => (s.strategy ? [s.strategy] : []))]) {
    const known = latest.get(d.strategyId);
    if (!known || d.version > known.version) latest.set(d.strategyId, d);
  }
  const strategies = [...latest.values()].map((d): StrategyListItem => {
    const using = world.state.scopes.filter((s) => s.strategy?.strategyId === d.strategyId);
    const label = strategyLabel(d, using[0]?.currency ?? world.state.scopes[0]?.currency ?? '', m);
    const versions = world.state.strategyVersions.filter((x) => x.strategyId === d.strategyId);
    const name = versions.find((x) => x.version === d.version)?.name ?? versions.at(-1)?.name ?? null;
    const member = (id: string | null) => {
      if (!id) return m.ui.strategies.authorUnknown;
      const role = world.state.members.find((x) => x.membershipId === id)?.role;
      const label = role ? m.values[role] : m.ui.strategies.authorUnknown;
      return id === world.viewer.membershipId ? m.ui.stop.you(label) : label;
    };
    const allVersions = [...new Set([...versions.map((x) => x.version), ...world.state.strategies.filter((x) => x.strategyId === d.strategyId).map((x) => x.version), d.version])]
      .sort((a, b) => b - a)
      .map((version) => {
        const meta = versions.find((x) => x.version === version);
        return {
          version, status: meta ? m.ui.strategies.statuses[meta.status] : m.ui.strategies.statusUnknown,
          author: meta ? member(meta.createdByMembershipId) : m.ui.strategies.authorUnknown, createdAt: meta?.createdAt ? m.when(meta.createdAt) : m.ui.common.noValue,
        };
      });
    const latestMeta = versions.find((x) => x.version === d.version);
    return {
      strategyId: d.strategyId, version: d.version, name, label: label.label, detail: label.detail,
      scopes: using.map((s) => ({ unit: unitOf(world, s, m), version: s.strategy!.version })),
      draft: { name: name ?? label.label, params: { ...d.params }, deadbandMinor: d.deadbandMinor },
      versions: allVersions,
      assignable: canEdit && (latestMeta?.status ?? 'ACTIVE') === 'ACTIVE',
    };
  }).sort((a, b) => b.scopes.length - a.scopes.length || a.strategyId.localeCompare(b.strategyId));
  const scopes = world.state.scopes.map((s): StrategyScopeItem => {
    const notes = channelNotes(world, s, m).filter((n) => n.code !== 'PRICING_HEALTH');
    return {
      unit: unitOf(world, s, m), mode: m.values[s.pricingMode], strategy: strategyLabel(s.strategy, s.currency, m).label,
      channelPricing: notes[0] ?? null, assignable: notes.length === 0,
      strategyId: s.strategy?.strategyId ?? null, version: s.strategy?.version ?? null,
      canUnassign: canEdit && s.strategy !== null && s.pricingMode !== 'ENGINE',
    };
  });
  const channelPricingOffers = world.accounts.flatMap((a) => {
    const channel = m.values[a.channel as keyof typeof m.values] ?? a.channel;
    const newest = new Map<string, (typeof world.state.offerChannelPricing)[number]>();
    for (const o of world.state.offerChannelPricing.filter((x) => x.channelAccountId === a.channelAccountId)) newest.set(`${o.marketplace}|${o.externalSku}`, o);
    return [...newest.values()].filter((o) => o.automatedPricing || o.channelBounds).map((o) => ({
      label: m.ui.common.unitLabel(channel, o.marketplace, o.externalSku),
      detail: o.automatedPricing ? m.ui.channelNotes.automatedPricingDetail(m.when(o.observedAt)) : m.ui.channelNotes.channelBoundsDetail(m.when(o.observedAt)),
      tone: (o.automatedPricing ? 'stop' : 'warn') as Tone,
    }));
  });
  return {
    worldId: world.id, strategies, scopes, channelPricingOffers, canEdit,
    gaps: [
      gap(m, 'POSITION_STRATEGY'),
      ...(channelPricingOffers.length > 0 ? [gap(m, 'CHANNEL_PRICING_OFFERS_WITHOUT_SCOPE')] : []),
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
  gaps: Gap[];
}

/** Отпечаток того, что видел человек (FNV-1a, две ветви): не секрет и не подпись — сервер пересчитывает его сам и сравнивает */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
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

export function strategyPreviewView(world: StandWorld, draft: StrategyDraft, previews: readonly StrategyPreview[], m: Messages): StrategyPreviewView {
  const t = m.ui.strategies;
  const summary = { changes: 0, unchanged: 0, rejected: 0, dangerous: 0, notEvaluated: 0 };
  const rows = previews.map((p): PreviewRow => {
    const scope = scopeById(world, p.writeScopeId)!;
    const money = (v: number | null | undefined) => m.money(v ?? null, p.currency);
    const strategy = p.stages.find((s) => s.stage === 'STRATEGY');
    const unavailable = p.availability.available ? null
      : t.unavailable(Object.entries(p.availability.unmet).map(([source, codes]) => `${source}: ${codes.map((c) => m.values[c as keyof typeof m.values] ?? c).join(', ')}`).join('; '));
    const d = p.decision;
    const dangerous = d?.outcome === 'REJECTED' && d.boundDeviationBp !== null && d.boundDeviationBp > DANGEROUS_DEVIATION_BP;
    let tone: Tone = 'unknown';
    if (!d) summary.notEvaluated += 1;
    else if (d.outcome === 'APPROVED') { summary.changes += 1; tone = 'progress'; }
    else if (d.outcome === 'NO_CHANGE') { summary.unchanged += 1; tone = 'ok'; }
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
  const saveBlocked = rows.some((r) => r.unavailable !== null) ? t.blockedUnavailable
    : channelPriced.length > 0 ? t.blockedChannelPricing(channelPriced.map((r) => r.unit.label).join(', ')) : null;
  return {
    worldId: world.id, draft: { title: `${draft.name} · ${label.label}`, detail: label.detail }, rows, summary, saveBlocked,
    headline: t.headline(summary), previewToken: previewToken(draft, previews, world),
    gaps: [gap(m, 'PREVIEW_LAST_SNAPSHOT'), gap(m, 'PREVIEW_CURRENT_BOUNDS')],
  };
}
