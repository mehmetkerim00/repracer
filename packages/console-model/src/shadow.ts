import { can } from '@repracer/pricing-model';
import type { MarketplaceProperty, ShadowAccountRow, ShadowPage, ShadowSummary, ShadowWriteRow } from '@repracer/pricing-store-pg';
import type { Messages } from './i18n/index.ts';
import { pageInfo, type ListQuery, type PageInfo } from './page.ts';
import { gap, type Gap, type StandWorld } from './world.ts';

/**
 * Р-169…Р-171 (шаг 41): экран «Теневой режим». Показывает то, чего продавец иначе не увидит: что движок СДЕЛАЛ БЫ, будь
 * канал боевым. Сводка за период — числами, список would-be изменений — страницей с ссылкой на «почему эта цена».
 *
 * Чего на экране НЕТ намеренно: обещания заработка. «Вы бы заработали X» — гадание о том, купил бы покупатель или нет, и
 * на экране, который должен убедить продавца включить бой, такое число было бы худшим из возможных [Р-124 по духу].
 */

export interface ShadowAccountView extends ShadowAccountRow {
  label: string;
  modeText: string;
  changedText: string | null;
  /** Что набрать, чтобы включить бой [Р-170] */
  confirmationHint: string;
  canGoLive: boolean;
  canGoShadow: boolean;
}

export interface ShadowWriteView extends ShadowWriteRow {
  label: string;
  valueText: string;
  budgetText: string | null;
  whenText: string;
}

/** Р-172: свойство витрины на экране — человеческим языком, с открытым вопросом и способом закрытия */
export interface MarketplacePropertyView {
  marketplace: string;
  propertyText: string;
  valueText: string;
  statusText: string;
  closesByText: string;
  question: string | null;
  /** Держит ли это свойство боевой режим: у UNKNOWN — да, и продавец видит это словами */
  blocksLive: boolean;
}

export interface ShadowDigestView {
  periodText: string;
  decisions: number;
  heldWrites: number;
  savingsText: string | null;
  deliveryText: string;
  delivered: boolean;
}

export interface ShadowPeriodChoice {
  days: number;
  label: string;
  active: boolean;
}

export interface ShadowView {
  worldId: string;
  demo: boolean;
  intro: string;
  /**
   * Находка 3 ревью шага 41: окно отчёта было параметром хранилища, которого не передавал никто, и ничем не ограниченным.
   * Теперь его выбирает продавец из НАЗВАННЫХ вариантов, и число дней не приходит из запроса свободным.
   */
  periods: ShadowPeriodChoice[];
  /** Есть ли вообще теневой аккаунт: без него экран честно говорит, что показывать нечего */
  anyShadow: boolean;
  summary: ShadowSummary;
  summaryLines: string[];
  accounts: ShadowAccountView[];
  /** Р-172: ревизия свойств витрин аккаунтов — она же объясняет, почему бой может быть закрыт */
  properties: MarketplacePropertyView[];
  liveBlockedText: string | null;
  /** Р-174: доставленные и недоставленные дайджесты периодов */
  digests: ShadowDigestView[];
  digestsTitle: string;
  propertiesTitle: string;
  rows: ShadowWriteView[];
  page: PageInfo;
  none: string;
  liveButton: string;
  shadowButton: string;
  mfaHint: string;
  cannot: string;
  gaps: Gap[];
}

const money = (m: Messages, minor: number | null, currency: string | null): string =>
  minor === null || currency === null ? '—' : m.money(minor, currency);

export function shadowSummaryLines(summary: ShadowSummary, m: Messages): string[] {
  const t = m.ui.shadow.summary;
  return [
    t.period(m.when(summary.since), m.when(summary.until)),
    t.decisions(summary.decisions, summary.changes),
    t.floorHeld(summary.floorHeld),
    t.ceilingHeld(summary.ceilingHeld),
    t.held(summary.heldWrites, summary.heldPriceWrites, summary.heldQuantityWrites),
    t.budget(summary.wouldSpendBudget),
    /**
     * Р-173: деньги. Строка появляется ТОЛЬКО когда пол действительно удерживал цену: «на 0,00 € дешевле» — шум, а
     * продавец, читающий такую строку каждую неделю, перестаёт читать письмо.
     */
    ...(summary.floorSavings.length > 0
      ? [t.savings(summary.floorSavings.map((x) => m.money(x.minor, x.currency)).join(', '), summary.floorSavingsHolds), t.savingsNote]
      : []),
  ];
}

const propertyView = (p: MarketplaceProperty, m: Messages): MarketplacePropertyView => {
  const t = m.ui.shadow.properties;
  return {
    marketplace: p.marketplace,
    propertyText: t.names[p.property] ?? p.property,
    valueText: p.value ?? t.unknownValue,
    statusText: t.statuses[p.status] ?? p.status,
    closesByText: t.closesBy[p.closesBy] ?? p.closesBy,
    question: p.question,
    blocksLive: p.status === 'UNKNOWN',
  };
};

function accountView(a: ShadowAccountRow, world: StandWorld, m: Messages): ShadowAccountView {
  const t = m.ui.shadow;
  const channelName = (m.values as Record<string, string | undefined>)[a.channel] ?? a.channel;
  return {
    ...a,
    label: `${channelName} · ${a.displayName ?? a.externalAccountId}`,
    modeText: a.writeMode === 'SHADOW' ? t.modes.SHADOW : t.modes.LIVE,
    changedText: a.changedAt === null ? null : t.changed(a.changedFrom === 'SHADOW' ? t.modes.SHADOW : t.modes.LIVE, m.when(a.changedAt)),
    confirmationHint: t.confirmationHint(a.externalAccountId),
    // Включить бой может только владелец [Р-170]; вернуть в тень — он же и администратор
    canGoLive: a.writeMode === 'SHADOW' && world.viewer.role === 'OWNER',
    canGoShadow: a.writeMode === 'LIVE' && can(world.viewer.role, 'MANAGE_TENANT'),
  };
}

/** Варианты окна отчёта: неделя — как у дайджеста [Р-171], месяц — чтобы решение о бое принималось не по одной неделе */
export const SHADOW_PERIOD_DAYS = [7, 30] as const;

export function shadowView(world: StandWorld, page: ShadowPage, query: ListQuery, m: Messages, days: number): ShadowView {
  const t = m.ui.shadow;
  const accounts = page.accounts.map((a) => accountView(a, world, m));
  return {
    worldId: world.id, demo: world.demo === true, intro: t.intro,
    periods: SHADOW_PERIOD_DAYS.map((d) => ({ days: d, label: t.period(d), active: d === days })),
    properties: page.properties.map((p) => propertyView(p, m)),
    /**
     * Р-172: если бой закрыт неизвестным свойством, экран говорит это ДО нажатия кнопки. Иначе продавец нажимает,
     * получает отказ базы и решает, что сломано.
     */
    liveBlockedText: page.properties.some((p) => p.status === 'UNKNOWN')
      ? t.properties.blocksLive(page.properties.filter((p) => p.status === 'UNKNOWN')
          .map((p) => `${p.marketplace} · ${t.properties.names[p.property] ?? p.property}`).join(', '))
      : null,
    propertiesTitle: t.properties.title,
    digestsTitle: t.digest.historyTitle,
    digests: page.digests.map((d) => ({
      periodText: `${m.when(d.periodStart)} — ${m.when(d.periodEnd)}`,
      decisions: d.decisions, heldWrites: d.heldWrites,
      savingsText: d.floorSavings.length > 0 ? d.floorSavings.map((x) => m.money(x.minor, x.currency)).join(', ') : null,
      deliveryText: d.deliveredAt === null ? t.digest.notDelivered : t.digest.delivered(m.when(d.deliveredAt), d.deliveryKind ?? ''),
      delivered: d.deliveredAt !== null,
    })),
    /**
     * Находка 11 ревью шага 41: аккаунт БЕЗ ДОСТУПОВ [Р-150] писать не может в принципе, и считать его теневым — врать
     * продавцу: тень ему ничего не запрещает. Экран «в тени», когда тень что-то ДЕРЖИТ.
     */
    anyShadow: accounts.some((a) => a.writeMode === 'SHADOW' && a.authStatus === 'ACTIVE'),
    summary: page.summary, summaryLines: shadowSummaryLines(page.summary, m),
    accounts,
    rows: page.rows.map((r): ShadowWriteView => ({
      ...r,
      label: r.sku ?? r.writeScopeId,
      valueText: r.field === 'QUANTITY' ? t.quantity(r.quantity ?? 0) : money(m, r.amountMinor, r.currency),
      budgetText: r.wouldSpendBudget ? t.wouldSpend : null,
      whenText: m.when(r.finishedAt),
    })),
    page: pageInfo(query, page.total, m),
    none: t.none, liveButton: t.liveButton, shadowButton: t.shadowButton, mfaHint: t.mfaHint, cannot: t.cannot,
    gaps: [gap(m, 'PRODUCT_TITLE')],
  };
}
