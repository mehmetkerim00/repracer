import { can, holdsOwnerActions } from '@repracer/pricing-model';
import type { MarketplaceProperty, ShadowAccountRow, ShadowPage, ShadowSummary, ShadowWriteRow } from '@repracer/pricing-store-pg';
import { accountState, channelLimitText } from './connections.ts';
import type { Messages } from './i18n/index.ts';
import { monthDay, nameTag, zoneName } from './i18n/shape.ts';
import { pageInfo, type ListQuery, type PageInfo } from './page.ts';
import { gap, storefrontName, type Gap, type StandWorld } from './world.ts';
import { periodDays, periodPhrase, type Period, type PeriodRange } from './period.ts';

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
  /**
   * Шаг 79 (отложенное шага 76): аккаунт без доступа [Р-150] или с отозванным доступом писать не может ни в каком режиме —
   * поля «включить бой» у него нет, вместо него состояние доступа и куда идти
   */
  accessText: string | null;
  accessHint: string | null;
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
  /** Шаг 96 (аудит А4): строка людскими словами — что это, в каком состоянии и кто подтверждает */
  humanText: string;
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
  /** Шаг 96: фраза периода и признак отрезанного начала */
  phrase: string;
  clipped: boolean;
  /** Есть ли вообще теневой аккаунт: без него экран честно говорит, что показывать нечего */
  anyShadow: boolean;
  summary: ShadowSummary;
  summaryLines: string[];
  /** Шаг 84: сводка экрана списком «показатель — значение» и оговорки сноской — тот же смысл, что у `summaryLines` (их читает письмо) */
  summaryList: ShadowSummaryRow[];
  summaryNotes: string[];
  /** Шаг 82: график hero — решения тени по суткам в поясе продавца, последние `days` суток окна (последние — сегодня, неполные) */
  chart: ShadowChartView;
  accounts: ShadowAccountView[];
  /** Р-172: ревизия свойств витрин аккаунтов — она же объясняет, почему бой может быть закрыт */
  properties: MarketplacePropertyView[];
  liveBlockedText: string | null;
  /** Р-174: доставленные и недоставленные дайджесты периодов */
  digests: ShadowDigestView[];
  digestsTitle: string;
  propertiesTitle: string;
  /** Шаг 96 (А4): первой строкой блока — что от продавца ничего не нужно (свойства закрывают команда, первая запись или канал) */
  nothingNeeded: string | null;
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

export interface ShadowSummaryRow {
  label: string;
  value: string;
  hint: string | null;
}

/**
 * Шаг 84: строки сводки — списком «показатель — значение»; решения и изменения цены уже сказали плитки над ним, поэтому их здесь нет.
 * Оговорки («приблизительно», «не прогноз») — сноской под списком. Деньги — только когда пол действительно удерживал цену (Р-173)
 */
export function shadowSummaryList(summary: ShadowSummary, m: Messages): { rows: ShadowSummaryRow[]; notes: string[] } {
  const t = m.ui.shadow.list;
  const n = (v: number) => new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US').format(v);
  const approximate = summary.wouldSpendUnconfirmed > 0;
  const rows: ShadowSummaryRow[] = [
    { label: t.period, value: `${m.when(summary.since)} — ${m.when(summary.until)}`, hint: null },
    { label: t.floorHeld, value: t.times(summary.floorHeld), hint: t.floorHeldHint },
    { label: t.ceilingHeld, value: t.times(summary.ceilingHeld), hint: null },
    { label: t.held, value: t.heldSplit(summary.heldWrites, summary.heldPriceWrites, summary.heldQuantityWrites), hint: null },
    { label: t.budget, value: approximate ? t.about(summary.wouldSpendBudget) : n(summary.wouldSpendBudget), hint: null },
    ...(summary.floorSavings.length > 0
      ? [{ label: t.savings, value: summary.floorSavings.map((x) => m.money(x.minor, x.currency)).join(', '), hint: t.savingsHolds(summary.floorSavingsHolds) }]
      : []),
  ];
  const notes = [
    ...(approximate ? [t.budgetNote] : []),
    ...(summary.floorSavings.length > 0 ? [m.ui.shadow.summary.savingsNote] : []),
  ];
  return { rows, notes };
}

export interface ShadowChartView {
  title: string;
  /** Шаг 96.1 (решение владельца): последние сутки — сегодняшние, неполные: подпись «Today», подсказка «partial day», тон приглушённый */
  points: Array<{ day: string; label: string; value: number; title: string; partial: boolean }>;
}

/**
 * Шаг 82: сутки — в поясе продавца, тем же поясом, что у всех времён экрана (K4). Часы базы складываются в местные сутки; ряд —
 * ровно `days` суток, заканчивая сегодняшними, пустые сутки — нулём (провал на графике честнее, чем пропущенный день). Пояс, которого не
 * знает Intl среды, — UTC, как у `messagesFor`
 */
export function shadowChart(byHour: ShadowPage['decisionsByHour'], until: string, days: number, m: Messages, timeZone: string | null | undefined, now: string = until): ShadowChartView {
  const make = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  let fmt: Intl.DateTimeFormat;
  try { fmt = make(timeZone || 'UTC'); } catch (error) { if (!(error instanceof RangeError)) throw error; fmt = make('UTC'); }
  const localDay = (iso: string) => fmt.format(new Date(Date.parse(iso)));
  /**
   * Шаг 96.1: последний день окна — день его последнего мгновения. Свой диапазон кончается полуночью ПОСЛЕ последней даты, и график
   * «Oct 7 – Oct 13» рисовался со сдвигом на день (четверг…среда); «сегодня» — только если последний день окна и есть сегодняшний
   */
  const last = fmt.format(new Date(Date.parse(until) - 1));
  const today = localDay(now);
  const [y, mo, d] = last.split('-').map(Number) as [number, number, number];
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(Date.UTC(y, mo - 1, d - (days - 1 - i))).toISOString().slice(0, 10));
  const totals = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  for (const b of byHour) {
    const k = localDay(b.hour);
    if (totals.has(k)) totals.set(k, (totals.get(k) ?? 0) + b.decisions);
  }
  // Шаг 98 [Р-223]: названия дней и месяцев — на языке экрана, числа — прежним форматом (у ES и FR — американским)
  const weekday = new Intl.DateTimeFormat(nameTag(m.locale), { weekday: 'short', timeZone: 'UTC' });
  const label = { format: (d: Date) => days <= 7 ? weekday.format(d) : monthDay(m.locale, d.getUTCMonth() + 1, d.getUTCDate()) };
  const nf = new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US');
  return {
    title: m.ui.shadow.chartTitle,
    points: dayKeys.map((k, i) => {
      const value = totals.get(k) ?? 0;
      const partial = i === dayKeys.length - 1 && k === today;
      return { day: k, label: partial ? m.ui.shadow.chartToday : label.format(new Date(`${k}T00:00:00Z`)), value, partial,
        title: `${m.date(k)} · ${nf.format(value)}${partial ? ` · ${m.ui.shadow.chartPartialDay}` : ''}` };
    }),
  };
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

const propertyView = (p: MarketplaceProperty, m: Messages, now: string): MarketplacePropertyView => {
  const t = m.ui.shadow.properties;
  return {
    marketplace: p.marketplace,
    storefrontText: storefrontName(p.channel, p.marketplace, m),
    propertyText: t.names[p.property] ?? p.property,
    // Шаг 68 (K2): значение словами — «net, sales tax added at checkout», а не «NET / SALES_TAX_EXCLUDED»
    // Шаг 79: граница суток — пояс словами («Central European Time (UTC+2)»), а не код IANA
    valueText: p.value === null ? t.unknownValue : p.property === 'DAY_BOUNDARY' && p.value.includes('/') ? zoneName(m.locale, p.value, now) : t.valueWords[p.value] ?? p.value,
    statusText: t.statuses[p.status] ?? p.status,
    // Шаг 69 [Р-204]: неизвестная граница суток закрывается неделей тени и решением команды платформы — так экран и говорит
    closesByText: p.property === 'DAY_BOUNDARY' && p.status === 'UNKNOWN' ? t.dayBoundaryProcess : t.closesBy[p.closesBy] ?? p.closesBy,
    question: p.question,
    blocksLive: p.status === 'UNKNOWN',
    humanText: [t.human[p.property] ?? t.names[p.property] ?? p.property, t.humanStatus[p.status] ?? '', t.humanCloses[p.closesBy] ?? ''].filter(Boolean).join(' '),
  };
};

function accountView(a: ShadowAccountRow, world: StandWorld, m: Messages): ShadowAccountView {
  const t = m.ui.shadow;
  const channelName = (m.values as Record<string, string | undefined>)[a.channel] ?? a.channel;
  const state = accountState(a);
  const noAccess = state === 'AWAITING_ACCESS' || state === 'REVOKED' ? state : null;
  return {
    ...a,
    label: `${channelName} · ${a.displayName ?? a.externalAccountId}`,
    modeText: a.writeMode === 'SHADOW' ? t.modes.SHADOW : t.modes.LIVE,
    changedText: a.changedAt === null ? null : t.changed(a.changedFrom === 'SHADOW' ? t.modes.SHADOW : t.modes.LIVE, m.when(a.changedAt)),
    confirmationHint: t.confirmationHint(a.externalAccountId),
    // Включить бой может только владелец [Р-170]; вернуть в тень — он же и администратор
    canGoLive: noAccess === null && a.writeMode === 'SHADOW' && holdsOwnerActions(world.viewer.role),
    // Шаг 89 (ADR-0054): обратно в тень — безопасная сторона, своё право матрицы (у менеджера тоже)
    canGoShadow: a.writeMode === 'LIVE' && can(world.viewer.role, 'RETURN_TO_SHADOW'),
    channelLimitText: channelLimitText(a.channel, m),
    accessText: noAccess === null ? null : m.ui.connections.states[noAccess] ?? null,
    accessHint: noAccess === null ? null : t.noAccess[noAccess],
  };
}

/** Варианты окна отчёта: неделя — как у дайджеста [Р-171], месяц — чтобы решение о бое принималось не по одной неделе */
export const SHADOW_PERIOD_DAYS = [7, 30] as const;

function digestPreview(world: StandWorld, page: ShadowPage, accounts: readonly ShadowAccountView[], m: Messages): ShadowView['digestPreview'] {
  const s = page.summary;
  const letter = shadowDigestLetter({
    // Шаг 76 (предполётный прогон демо): имя демо — то же, что у карточки в списке миров («Demo store (simulator)»), а не служебный
    // заголовок мира стенда
    tenantName: world.demo === true && world.ownName !== true ? m.ui.app.demoWorldTitle : world.title, shadowAccounts: accounts.filter((a) => a.writeMode === 'SHADOW' && a.authStatus === 'ACTIVE').length,
    decisions: s.decisions, changes: s.changes, floorHeld: s.floorHeld, ceilingHeld: s.ceilingHeld, heldWrites: s.heldWrites,
    heldPriceWrites: s.heldPriceWrites, heldQuantityWrites: s.heldQuantityWrites, wouldSpendBudget: s.wouldSpendBudget,
    wouldSpendUnconfirmed: s.wouldSpendUnconfirmed, floorSavings: s.floorSavings, floorSavingsHolds: s.floorSavingsHolds,
  }, m, 'PREVIEW');
  return { title: m.ui.shadow.digest.previewTitle, synthetic: m.ui.shadow.digest.previewSynthetic, subject: letter.subject, text: letter.lines.join('\n') };
}

export function shadowView(world: StandWorld, page: ShadowPage, query: ListQuery, m: Messages, period: Period, range: PeriodRange, timeZone?: string | null): ShadowView {
  const t = m.ui.shadow;
  const accounts = page.accounts.map((a) => accountView(a, world, m));
  return {
    worldId: world.id, demo: world.demo === true, intro: t.intro,
    // Шаг 96: период — пресетом или своим диапазоном дат (общее правило экранов); фраза — для заголовков, `clipped` — что отрезано
    phrase: periodPhrase(period, m), clipped: range.clipped,
    properties: page.properties.map((p) => propertyView(p, m, world.now)),
    /**
     * Р-172: если бой закрыт неизвестным свойством, экран говорит это ДО нажатия кнопки. Иначе продавец нажимает,
     * получает отказ базы и решает, что сломано.
     */
    liveBlockedText: page.properties.some((p) => p.status === 'UNKNOWN')
      ? t.properties.blocksLive(page.properties.filter((p) => p.status === 'UNKNOWN')
          .map((p) => `${storefrontName(p.channel, p.marketplace, m)} · ${t.properties.names[p.property] ?? p.property}`).join(', '))
      : null,
    propertiesTitle: t.properties.title,
    // Ни одно свойство не закрывает продавец: подтверждают команда платформы, первая настоящая отправка или сам канал
    nothingNeeded: page.properties.length > 0 ? t.properties.nothingNeeded : null,
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
    ...(() => { const l = shadowSummaryList(page.summary, m); return { summaryList: l.rows, summaryNotes: l.notes }; })(),
    chart: shadowChart(page.decisionsByHour, page.summary.until, periodDays(range, timeZone), m, timeZone, world.now),
    // Превью недельного письма — у недели: письмо считает семь суток
    digestPreview: world.demo === true && 'preset' in period && period.preset === '7d' ? digestPreview(world, page, accounts, m) : null,
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
