import { can } from '@repracer/pricing-model';
import type { MarketplaceProperty, ShadowAccountRow, ShadowPage, ShadowSummary, ShadowWriteRow } from '@repracer/pricing-store-pg';
import { channelLimitText } from './connections.ts';
import type { Messages } from './i18n/index.ts';
import { pageInfo, type ListQuery, type PageInfo } from './page.ts';
import { gap, storefrontName, type Gap, type StandWorld } from './world.ts';

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
  /** Шаг 49 [Р-190, E-21]: чего на этом канале в бою пока не видно — до кнопки «включить бой», словами */
  channelLimitText: string | null;
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
  /** Шаг 68 (K2): витрина словами — «amazon.com», а не «ATVPDKIKX0DER» */
  storefrontText: string;
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
  /**
   * Шаг 68 (K7): у демо — предпросмотр недельного письма за последние семь суток. Демо-тенанту письмо не отправляется (0167), а
   * показать его клиенту надо за десять минут; данные синтетические, и блок говорит это прямо
   */
  digestPreview: { title: string; synthetic: string; subject: string; text: string } | null;
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

/**
 * Шаг 68 (K2): отказ базы перевести аккаунт в бой — словами. База называет первое неизвестное свойство строкой
 * «витрина / СВОЙСТВО (вопрос)» [Р-172]; продавцу нужны витрина словами, что не подтверждено и кто это подтверждает (способ закрытия
 * свойства из ревизии витрин), а не идентификатор витрины и код нашего вопроса. Строку не той формы текст пересказывает общими словами,
 * а не показывает сырой
 */
export function liveRefusalText(channel: string, detail: string, properties: readonly MarketplaceProperty[], m: Messages): string {
  const t = m.ui.shadow;
  const parsed = /^(\S+) \/ (\S+)(?: \(([^)]*)\))?$/.exec(detail.trim());
  if (!parsed) return t.errors.liveClosedUnknown;
  const [, marketplace, property] = parsed as unknown as [string, string, string];
  const known = properties.find((p) => p.marketplace === marketplace && p.property === property);
  return t.errors.liveClosed(storefrontName(known?.channel ?? channel, marketplace, m), t.properties.names[property] ?? t.properties.someProperty,
    property === 'DAY_BOUNDARY' ? t.properties.dayBoundaryProcess
      : known ? t.properties.confirmWhere[known.closesBy] ?? t.properties.confirmWhereUnknown : t.properties.confirmWhereUnknown);
}

/** Числа письма-дайджеста: те же, что у экрана тени [Р-171], и то, кому оно */
export interface ShadowDigestLetterInput {
  tenantName: string;
  shadowAccounts: number;
  decisions: number;
  changes: number;
  floorHeld: number;
  ceilingHeld: number;
  heldWrites: number;
  heldPriceWrites: number;
  heldQuantityWrites: number;
  wouldSpendBudget: number;
  wouldSpendUnconfirmed: number;
  floorSavings: Array<{ currency: string; minor: number }>;
  floorSavingsHolds: number;
  /** Шаг 69 (K4): пояс продавца — неделя письма идёт в нём, и вступление его называет */
  timeZone?: string;
}

/**
 * Шаг 68 (K7): текст недельного письма тени — ОДНА функция у доставки (`packages/alert-delivery`) и у предпросмотра демо: показанное
 * клиенту письмо — то же письмо, а не его пересказ. `PREVIEW` меняет только вступление: письмо собрано за последние семь суток, а не за
 * прошлую неделю с понедельника
 */
export function shadowDigestLetter(input: ShadowDigestLetterInput, m: Messages, kind: 'WEEK' | 'PREVIEW' = 'WEEK'): { subject: string; lines: string[] } {
  const t = m.ui.shadow;
  return {
    subject: t.digest.subject(input.tenantName),
    lines: [
      kind === 'WEEK' ? t.digest.intro(input.tenantName, input.shadowAccounts, input.timeZone ?? 'UTC') : t.digest.previewIntro(input.tenantName, input.shadowAccounts),
      '',
      t.summary.decisions(input.decisions, input.changes),
      t.summary.floorHeld(input.floorHeld),
      t.summary.ceilingHeld(input.ceilingHeld),
      t.summary.held(input.heldWrites, input.heldPriceWrites, input.heldQuantityWrites),
      t.summary.budget(input.wouldSpendBudget, input.wouldSpendUnconfirmed > 0),
      /**
       * Р-173: деньги — только когда пол действительно удерживал цену. «На 0,00 € дешевле» приучает не читать письмо, и
       * рядом с числом стоит оговорка: это разница цен, а не прогноз выручки.
       */
      ...(input.floorSavings.length > 0
        ? [t.summary.savings(input.floorSavings.map((x) => m.money(x.minor, x.currency)).join(', '), input.floorSavingsHolds), t.summary.savingsNote]
        : []),
      '',
      t.digest.cta,
      '',
      t.cannot,
    ],
  };
}

export function shadowSummaryLines(summary: ShadowSummary, m: Messages): string[] {
  const t = m.ui.shadow.summary;
  return [
    t.period(m.when(summary.since), m.when(summary.until)),
    t.decisions(summary.decisions, summary.changes),
    t.floorHeld(summary.floorHeld),
    t.ceilingHeld(summary.ceilingHeld),
    t.held(summary.heldWrites, summary.heldPriceWrites, summary.heldQuantityWrites),
    // Р-188: без подтверждённой границы суток бюджет по дням не делится — число помечено приблизительным
    t.budget(summary.wouldSpendBudget, summary.wouldSpendUnconfirmed > 0),
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
    storefrontText: storefrontName(p.channel, p.marketplace, m),
    propertyText: t.names[p.property] ?? p.property,
    // Шаг 68 (K2): значение словами — «net, sales tax added at checkout», а не «NET / SALES_TAX_EXCLUDED»
    valueText: p.value === null ? t.unknownValue : t.valueWords[p.value] ?? p.value,
    statusText: t.statuses[p.status] ?? p.status,
    // Шаг 69 [Р-204]: неизвестная граница суток закрывается неделей тени и решением команды платформы — так экран и говорит
    closesByText: p.property === 'DAY_BOUNDARY' && p.status === 'UNKNOWN' ? t.dayBoundaryProcess : t.closesBy[p.closesBy] ?? p.closesBy,
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
    channelLimitText: channelLimitText(a.channel, m),
  };
}

/** Варианты окна отчёта: неделя — как у дайджеста [Р-171], месяц — чтобы решение о бое принималось не по одной неделе */
export const SHADOW_PERIOD_DAYS = [7, 30] as const;

function digestPreview(world: StandWorld, page: ShadowPage, accounts: readonly ShadowAccountView[], m: Messages): ShadowView['digestPreview'] {
  const s = page.summary;
  const letter = shadowDigestLetter({
    tenantName: world.title, shadowAccounts: accounts.filter((a) => a.writeMode === 'SHADOW' && a.authStatus === 'ACTIVE').length,
    decisions: s.decisions, changes: s.changes, floorHeld: s.floorHeld, ceilingHeld: s.ceilingHeld, heldWrites: s.heldWrites,
    heldPriceWrites: s.heldPriceWrites, heldQuantityWrites: s.heldQuantityWrites, wouldSpendBudget: s.wouldSpendBudget,
    wouldSpendUnconfirmed: s.wouldSpendUnconfirmed, floorSavings: s.floorSavings, floorSavingsHolds: s.floorSavingsHolds,
  }, m, 'PREVIEW');
  return { title: m.ui.shadow.digest.previewTitle, synthetic: m.ui.shadow.digest.previewSynthetic, subject: letter.subject, text: letter.lines.join('\n') };
}

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
          .map((p) => `${storefrontName(p.channel, p.marketplace, m)} · ${t.properties.names[p.property] ?? p.property}`).join(', '))
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
    digestPreview: world.demo === true && days === 7 ? digestPreview(world, page, accounts, m) : null,
    accounts,
    rows: page.rows.map((r): ShadowWriteView => ({
      ...r,
      // Ревью шага 68, находка 3: подпись — как у остальных экранов (название или SKU и витрина словами), не идентификатор единицы
      label: m.ui.common.unitLabel(r.title ?? r.sku ?? m.ui.common.unitRef(r.writeScopeId.slice(0, 8)),
        r.marketplace === null ? (m.values as Record<string, string | undefined>)[r.channel] ?? r.channel : storefrontName(r.channel, r.marketplace, m)),
      valueText: r.field === 'QUANTITY' ? t.quantity(r.quantity ?? 0) : money(m, r.amountMinor, r.currency),
      budgetText: r.wouldSpendBudget ? t.wouldSpend : null,
      whenText: m.when(r.finishedAt),
    })),
    page: pageInfo(query, page.total, m),
    none: t.none, liveButton: t.liveButton, shadowButton: t.shadowButton, mfaHint: t.mfaHint, cannot: t.cannot,
    gaps: [],
  };
}
