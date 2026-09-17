import { can, omnibusVerdict, OMNIBUS_WINDOW_DAYS, type OmnibusPriorPrice, type OmnibusVerdict } from '@repracer/pricing-model';
import type { DiscountAnnouncementRow, PriceEvidenceDay } from '@repracer/pricing-pipeline';
import type { Messages } from './i18n/index.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Комплаенс-модуль Omnibus (шаг 24) [Р-123]: прежняя цена объявленной скидки не выше наименьшей цены оффера за 30 суток витрины до начала
 * скидки — по каждому каналу отдельно. Экран: проверка до объявления («эта скидка нарушит правило»), отчёт по объявленным скидкам с
 * повторной проверкой по текущей истории цен (исправления суточной свёртки, поздно пришедшие цены), выгрузка доказательной истории цен.
 */

const TONE: Record<OmnibusVerdict, Tone> = { COMPLIANT: 'ok', VIOLATION: 'stop', UNVERIFIED: 'warn' };

/**
 * Р-124 (шаг 25): модуль НЕ гарантирует соответствие — он проверяет по известной нам истории и показывает её глубину: «видим N дней истории
 * по этому офферу, проверка достоверна / неполная». Достоверна — только если цена к началу окна известна и цен мимо нас в окне не замечено;
 * и тогда — по нашей истории: цены, выставленные мимо repracer, не видны.
 */
export interface HistoryDepthView {
  days: number;
  since: string;
  complete: boolean;
  tone: Tone;
  /** «Видим 12 дней истории по этому офферу (с 05.09.2026)» */
  seen: string;
  /** «Проверка достоверна по известной нам истории» / «Проверка неполная: …» */
  reliability: string;
  externalChanges: string | null;
  /** Всегда: модуль не видит цен, выставленных мимо repracer */
  limit: string;
}

export function historyDepthView(check: OmnibusPriorPrice, m: Messages): HistoryDepthView {
  const c = m.ui.compliance.depth;
  const complete = check.status === 'OK';
  return {
    days: check.historyDays, since: check.historySince ? m.date(check.historySince) : m.ui.common.noValue, complete, tone: complete ? 'ok' : 'warn',
    seen: check.historySince ? c.seen(check.historyDays, m.date(check.historySince)) : c.none,
    reliability: complete ? c.reliable : c.incomplete[check.status as keyof typeof c.incomplete]?.(check.historyDays, OMNIBUS_WINDOW_DAYS) ?? c.incomplete.INCOMPLETE_HISTORY(check.historyDays, OMNIBUS_WINDOW_DAYS),
    externalChanges: check.externalChanges > 0 ? c.external(check.externalChanges) : null,
    limit: c.limit,
  };
}

export interface DiscountCheckView {
  unit: UnitRef;
  verdict: OmnibusVerdict;
  tone: Tone;
  headline: string;
  detail: string;
  lowest: string;
  window: string;
  depth: HistoryDepthView;
  /** Объявить можно, если нарушения нет и у зрителя есть право; не подтверждённое объявляется с отметкой */
  canAnnounce: boolean;
}

export function discountCheckView(world: StandWorld, writeScopeId: string, referencePriceMinor: number, check: OmnibusPriorPrice, m: Messages): DiscountCheckView | null {
  const scope = scopeById(world, writeScopeId);
  if (!scope) return null;
  const c = m.ui.compliance;
  const verdict = omnibusVerdict(check, referencePriceMinor);
  const money = (v: number | null) => m.money(v, scope.currency);
  const window = check.windowFrom && check.windowTo ? c.window(m.date(check.windowFrom), m.date(check.windowTo), check.timeZone ?? '') : c.windowUnknown;
  return {
    unit: unitOf(world, scope, m), verdict, tone: TONE[verdict],
    headline: verdict === 'VIOLATION' ? c.violation(money(referencePriceMinor), money(check.lowestMinor), OMNIBUS_WINDOW_DAYS)
      : verdict === 'COMPLIANT' ? c.compliant(money(referencePriceMinor), money(check.lowestMinor)) : c.unverified,
    detail: c.statuses[check.status](check.historySince ? m.when(check.historySince) : m.ui.common.noValue),
    lowest: money(check.lowestMinor), window, depth: historyDepthView(check, m),
    canAnnounce: verdict !== 'VIOLATION' && can(world.viewer.role, 'MANAGE_PRICING'),
  };
}

export interface ComplianceRow {
  announcementId: string;
  unit: UnitRef | null;
  reference: string;
  sale: string;
  period: string;
  atAnnouncement: { verdict: OmnibusVerdict; tone: Tone; text: string };
  now: { verdict: OmnibusVerdict; tone: Tone; text: string };
  /** Р-124: глубина истории при объявлении */
  depth: HistoryDepthView;
}

/** Р-124: глубина истории по каждому офферу — на экране до объявления скидки */
export interface OfferDepthRow { unit: UnitRef; depth: HistoryDepthView }

export interface ComplianceView {
  worldId: string;
  headline: string;
  counts: Record<OmnibusVerdict, number>;
  rows: ComplianceRow[];
  offers: UnitRef[];
  canAnnounce: boolean;
  /** Р-124: глубина видимой истории по каждому офферу к сегодняшнему дню */
  depth: OfferDepthRow[];
  /** Р-124: модуль не гарантирует соответствие — первой строкой экрана */
  notAGuarantee: string;
  /** Что модуль проверить не может — на экране, а не в документации */
  cannotCheck: string[];
  gaps: Gap[];
}

/** rechecks — проверка каждого объявления по текущей истории цен (хранилище, omnibusCheck) */
export function complianceView(world: StandWorld, announcements: readonly DiscountAnnouncementRow[], rechecks: ReadonlyMap<string, OmnibusPriorPrice>, m: Messages,
  depthToday: ReadonlyMap<string, OmnibusPriorPrice> = new Map()): ComplianceView {
  const c = m.ui.compliance;
  const counts: Record<OmnibusVerdict, number> = { COMPLIANT: 0, VIOLATION: 0, UNVERIFIED: 0 };
  const rows = announcements.map((a): ComplianceRow => {
    const scope = scopeById(world, a.writeScopeId);
    const money = (v: number | null) => m.money(v, a.currency);
    const cell = (check: OmnibusPriorPrice) => {
      const verdict = omnibusVerdict(check, a.referencePriceMinor);
      const text = verdict === 'VIOLATION' ? c.violation(money(a.referencePriceMinor), money(check.lowestMinor), OMNIBUS_WINDOW_DAYS)
        : verdict === 'COMPLIANT' ? c.compliant(money(a.referencePriceMinor), money(check.lowestMinor)) : c.unverified;
      return { verdict, tone: TONE[verdict], text };
    };
    const now = cell(rechecks.get(a.announcementId) ?? a.check);
    counts[now.verdict] += 1;
    return {
      announcementId: a.announcementId, unit: scope ? unitOf(world, scope, m) : null, reference: money(a.referencePriceMinor), sale: money(a.salePriceMinor),
      period: c.period(m.when(a.startsAt), a.endsAt ? m.when(a.endsAt) : null), atAnnouncement: cell(a.check), now, depth: historyDepthView(a.check, m),
    };
  });
  return {
    worldId: world.id, headline: c.headline(counts), counts, rows, offers: world.state.scopes.map((s) => unitOf(world, s, m)),
    canAnnounce: can(world.viewer.role, 'MANAGE_PRICING'), cannotCheck: c.cannotCheck, notAGuarantee: c.depth.notAGuarantee,
    depth: world.state.scopes.flatMap((s) => { const d = depthToday.get(s.writeScopeId); return d ? [{ unit: unitOf(world, s, m), depth: historyDepthView(d, m) }] : []; }),
    gaps: [gap(m, 'OMNIBUS_OUTSIDE_PRICES'), gap(m, 'OMNIBUS_TIME_ZONE_TO_VERIFY')],
  };
}

/** Р-123: доказательная история цен — CSV с суммами в основных единицах; контрольную сумму считает сервер */
export function priceEvidenceCsv(world: StandWorld, days: readonly PriceEvidenceDay[]): string {
  const header = ['channel', 'marketplace', 'offer', 'day', 'time_zone', 'currency', 'price_basis', 'min_price', 'max_price', 'first_price', 'last_price', 'changes', 'source', 'corrected', 'correction_reason'];
  const decimal = (minor: number) => `${Math.trunc(minor / 100)}.${String(Math.abs(minor % 100)).padStart(2, '0')}`;
  // Находка 12 ревью шага 24: значение, начинающееся с = + - @ или табуляции, электронная таблица выполнит как формулу — префикс апострофом
  const quote = (raw: string) => {
    const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const lines = days.map((d) => {
    const scope = scopeById(world, d.writeScopeId);
    const channel = scope ? world.accounts.find((a) => a.channelAccountId === scope.channelAccountId)?.channel ?? '' : '';
    return [channel, scope?.marketplace ?? '', scope?.externalUnitId ?? d.writeScopeId, d.day, d.timeZone, d.currency, d.basis, decimal(d.minMinor), decimal(d.maxMinor),
      decimal(d.firstMinor), decimal(d.lastMinor), String(d.changes), d.source, d.corrected ? 'yes' : 'no', d.correctionReason ?? ''].map(quote).join(',');
  });
  return `${[header.join(','), ...lines].join('\n')}\n`;
}
