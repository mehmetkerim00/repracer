import { can } from '@repracer/pricing-model';
import type { OrderReturnRow, StockChannelRow, StockDivergenceRow, StockPage, StockRow, StockSourceRow } from '@repracer/stock-sync';
import type { Messages } from './i18n/index.ts';
import { pageInfo, type ListQuery, type PageInfo } from './page.ts';
import { gap, storefrontName, type Gap, type StandWorld } from './world.ts';

/**
 * Р-153 (шаг 35): экран остатков. По товару — физический остаток, резервации, доступно; по каждому каналу — что мы
 * посчитали к публикации, что отправили и что канал ПОДТВЕРДИЛ; расхождения «у нас / в канале» — отдельным списком.
 * Ловушки каналов называются ДО записи — по возможности канала, а не по факту.
 */

export interface StockChannelCell {
  writeScopeId: string;
  channel: string;
  label: string;
  /** Одно значение на все эти витрины (Kaufland: id_offer; Amazon: регион) */
  sharedText: string | null;
  syncEnabled: boolean;
  published: number;
  sentText: string;
  confirmedText: string;
  /**
   * Шаг 96.1: в строке — только канал · витрина, пилюля и «N to publish»; что значит состояние и метка времени — ОДИН раз над таблицей
   * (`StockView.legend`, `asOfText`), прежнее полное предложение — подсказкой строки (`detailText`). «Канал показывает N» — только
   * когда подтверждённое канала отличается от посчитанного: это данные строки, а не служебный текст
   */
  toPublishText: string | null;
  differsText: string | null;
  detailText: string;
  /** Состояние — для общей строки-легенды над таблицей */
  state: 'off' | 'awaiting' | 'diverged' | 'shadow' | 'synced' | 'sending' | 'idle';
  /** Последний момент, о котором говорит строка (отправка или подтверждение) — для «as of» над таблицей */
  at: string | null;
  divergedText: string | null;
  awaitingAck: boolean;
  tone: 'ok' | 'progress' | 'stop' | 'off' | 'warn';
  /** Шаг 79: состояние словом для пилюли — «in sync», «held by shadow mode», «diverged»; подробности — строкой ниже */
  statusText: string;
}

export interface StockRowView {
  productId: string;
  /** Шаг 69 (K8, OQ-249): подпись строки — название товара, иначе SKU; SKU — рядом */
  label: string;
  sku: string;
  gtin: string | null;
  onHand: number;
  reserved: number;
  available: number;
  channels: StockChannelCell[];
  /**
   * Шаг 52: количество, которым управляет канал (Amazon FBA), — только для чтения [Р-6]. Шаг 96.1: в строке — коротко («Amazon ·
   * amazon.com — 12, managed by Amazon»), «only shown, we never change it» и время — один раз над таблицей и подсказкой строки
   */
  channelManaged: Array<{ text: string; detail: string }>;
}

export interface StockTrap {
  channel: string;
  channelAccountId: string;
  /** Шаг 94: плашка канала — заголовок (канал и витрины словами), суть в одну-две строки, подробности (`text`) — по раскрытию */
  title: string;
  summary: string;
  text: string;
  requiresAck: boolean;
  /** Шаг 96 (аудит А8): подпись галочки называет саму нагрузку канала («ONE stock number … North America»), а не «нагрузку» */
  acknowledgeLabel: string;
}

export interface StockView {
  worldId: string;
  demo: boolean;
  intro: string;
  summary: StockPage['summary'];
  summaryText: string;
  /** Шаг 96.1: что значат состояния каналов на этой странице — по строке на состояние, один раз над таблицей */
  legend: string[];
  /** Шаг 96.1: «Channel figures as of …» — самый поздний момент, о котором говорят строки страницы */
  asOfText: string | null;
  rows: StockRowView[];
  page: PageInfo;
  /** Шаг 69 (K8): поиск и фильтр, которыми построена страница; `matchedText` — только когда они заданы */
  filter: { search: string; withReservations: boolean; matchedText: string | null; noneText: string | null };
  sources: Array<StockSourceRow & { modeText: string; productsText: string }>;
  /** Ловушки каналов аккаунтов мира — до включения синхронизации */
  traps: StockTrap[];
  canManage: boolean;
  /** Что экран показать не может — честно, как у остальных экранов */
  cannot: string;
  gaps: Gap[];
}

export interface StockDivergencesView {
  worldId: string;
  items: Array<StockDivergenceRow & { text: string; storefrontsText: string }>;
  none: string;
  cannot: string;
}

/** Ловушка канала по его возможности; текст — словарь, код — канал [Р-153] */
export function stockTraps(world: StandWorld, m: Messages): StockTrap[] {
  const t = m.ui.stock.traps;
  const name = (channel: string) => (m.values as Record<string, string | undefined>)[channel] ?? channel;
  return world.accounts.map((a) => ({
    channel: a.channel, channelAccountId: a.channelAccountId,
    title: `${name(a.channel)} · ${storefronts(a.channel, a.marketplaces, m)}`,
    summary: a.channel === 'AMAZON' ? (a.marketplaces.includes('ATVPDKIKX0DER') ? t.summary.AMAZON_NA : t.summary.AMAZON) : a.channel === 'KAUFLAND' ? t.summary.KAUFLAND
      : a.channel === 'WALMART' ? t.summary.WALMART : t.summary.generic,
    // Шаг 64: у amazon.com — регион Северная Америка, а не ЕС: продавцу из США нельзя называть amazon.fr, .it, .es
    text: a.channel === 'AMAZON' ? (a.marketplaces.includes('ATVPDKIKX0DER') ? t.AMAZON_NA : t.AMAZON) : a.channel === 'KAUFLAND' ? t.KAUFLAND
      : a.channel === 'WALMART' ? t.WALMART : t.generic((m.values as Record<string, string | undefined>)[a.channel] ?? a.channel),
    requiresAck: a.channel === 'AMAZON',
    acknowledgeLabel: (a.channel === 'AMAZON' ? m.ui.stock.enable.acknowledgeOf[a.marketplaces.includes('ATVPDKIKX0DER') ? 'AMAZON_NA' : 'AMAZON'] : undefined) ?? m.ui.stock.enable.acknowledge,
  }));
}

const storefronts = (channel: string, marketplaces: readonly string[], m: Messages): string =>
  marketplaces.map((mp) => storefrontName(channel, mp, m)).join(', ');

export function channelCell(c: StockChannelRow, m: Messages): StockChannelCell {
  const s = m.ui.stock.channel;
  const channelName = (m.values as Record<string, string | undefined>)[c.channel] ?? c.channel;
  const awaitingAck = c.sideEffects.requiresAck && !c.sideEffects.acknowledged;
  const status = (v: string) => (m.ui.writeStatus as Record<string, string | undefined>)[v] ?? v;
  const sentText = !c.sent ? s.notSent : c.sent.status === 'SHADOW_HELD' ? s.heldInShadow(c.sent.quantity, m.when(c.sent.at)) : s.sent(c.sent.quantity, status(c.sent.status), m.when(c.sent.at));
  const confirmedText = c.confirmed ? `${s.confirmed(c.confirmed.quantity, m.when(c.confirmed.at))}${c.confirmed.ownRecordOnly ? ` — ${m.ui.ownRecordConfirmation}` : ''}` : s.notConfirmed;
  const sharedText = c.marketplaces.length > 1 ? s.shared(storefronts(c.channel, c.marketplaces, m)) : null;
  const state: StockChannelCell['state'] = !c.syncEnabled ? (awaitingAck ? 'awaiting' : 'off') : c.divergence ? 'diverged' : c.sent?.status === 'SHADOW_HELD' ? 'shadow'
    : c.sent && c.confirmed && c.sent.quantity === c.confirmed.quantity ? 'synced' : c.sent ? 'sending' : 'idle';
  const times = [c.sent?.at, c.confirmed?.at].filter((t): t is NonNullable<typeof t> => !!t).map(String).sort();
  return {
    // Шаг 69 (K10, K9): витрины — словами, как в подписи предложения, а не кодами (ATVPDKIKX0DER, EBAY_US)
    writeScopeId: c.writeScopeId, channel: c.channel, label: `${channelName} · ${storefronts(c.channel, c.marketplaces, m)}`,
    sharedText,
    syncEnabled: c.syncEnabled, published: c.published,
    // Шаг 64: удержанное тенью не «отправлено» — в канал ничего не ушло [Р-169]
    sentText,
    // Р-190 (находка 9 ревью шага 49): подтверждение только нашей записью у канала названо словами
    confirmedText,
    toPublishText: c.syncEnabled ? s.toPublish(c.published) : null,
    differsText: c.syncEnabled && c.confirmed && c.confirmed.quantity !== c.published ? s.channelShows(c.confirmed.quantity) : null,
    detailText: [sharedText, c.syncEnabled ? `${s.published(c.published)}; ${sentText}; ${confirmedText}` : awaitingAck ? s.awaitingAck : s.off].filter(Boolean).join('; '),
    state, at: times.at(-1) ?? null,
    divergedText: c.divergence ? s.diverged(status(c.divergence.status), m.when(c.divergence.since)) : null,
    awaitingAck,
    // Шаг 79: удержанное тенью — янтарным, как тень на всех экранах
    tone: !c.syncEnabled ? (awaitingAck ? 'warn' : 'off') : c.divergence ? 'stop' : c.sent?.status === 'SHADOW_HELD' ? 'warn'
      : c.sent && c.confirmed && c.sent.quantity === c.confirmed.quantity ? 'ok' : c.sent ? 'progress' : 'off',
    statusText: !c.syncEnabled ? (awaitingAck ? s.states.awaiting : s.states.off) : c.divergence ? s.states.diverged : c.sent?.status === 'SHADOW_HELD' ? s.states.shadow
      : c.sent && c.confirmed && c.sent.quantity === c.confirmed.quantity ? s.states.synced : c.sent ? s.states.sending : s.states.idle,
  };
}

export function stockView(world: StandWorld, page: StockPage, query: ListQuery, sources: readonly StockSourceRow[], m: Messages,
  filter: { search?: string | null; withReservations?: boolean } = {}): StockView {
  const t = m.ui.stock;
  const search = filter.search?.trim() ?? '';
  const filtered = search !== '' || filter.withReservations === true;
  const channelName = (channel: string) => (m.values as Record<string, string | undefined>)[channel] ?? channel;
  const rows = page.items.map((r: StockRow): StockRowView => ({ productId: r.productId, label: r.title ?? r.sku, sku: r.sku, gtin: r.gtin, onHand: r.onHand, reserved: r.reserved, available: r.available, channels: r.channels.map((c) => channelCell(c, m)),
    channelManaged: (r.channelManaged ?? []).map((c) => ({
      text: t.channel.managedShort(channelName(c.channel), storefrontName(c.channel, c.marketplace, m), c.quantity),
      detail: t.channel.managedByChannel(channelName(c.channel), storefrontName(c.channel, c.marketplace, m), c.quantity, m.when(c.observedAt)),
    })) }));
  return {
    worldId: world.id, demo: world.demo === true, intro: t.intro, summary: page.summary, summaryText: t.summary(page.summary),
    ...stockLegend(page, rows, m),
    filter: {
      search, withReservations: filter.withReservations === true,
      matchedText: filtered ? t.filter.matched(page.total, page.summary.products) : null,
      noneText: filtered && page.total === 0 ? t.filter.none : null,
    },
    rows,
    page: pageInfo(query, page.total, m),
    sources: sources.map((s) => ({ ...s, modeText: t.sources.modes[s.mode], productsText: t.sources.products(s.products) })),
    traps: stockTraps(world, m),
    canManage: can(world.viewer.role, 'MANAGE_CATALOG'),
    cannot: t.divergences.cannot,
    gaps: [gap(m, 'STOCK_CHANNEL_NOT_READ')],
  };
}

/**
 * Шаг 96.1: что значат состояния каналов страницы и на какой момент — один раз над таблицей. Прежде каждая строка повторяла одно и то же
 * служебное предложение («to publish: N; held by shadow mode: N would be sent (…) — nothing was sent; channel has not confirmed yet»);
 * теперь строка говорит только своё, а класс держит правило браузерного смоука «служебное предложение не повторяется в строках»
 */
function stockLegend(page: StockPage, rows: readonly StockRowView[], m: Messages): { legend: string[]; asOfText: string | null } {
  const l = m.ui.stock.channel.legend;
  const cells = rows.flatMap((r) => r.channels);
  const order: Array<StockChannelCell['state']> = ['shadow', 'synced', 'sending', 'idle', 'diverged', 'awaiting', 'off'];
  const present = new Set(cells.map((c) => c.state));
  const legend = order.filter((st) => present.has(st)).map((st) => l[st]);
  const managedAt = page.items.flatMap((r) => (r.channelManaged ?? []).map((c) => String(c.observedAt)));
  if (managedAt.length > 0) legend.push(l.managed);
  const latest = [...cells.map((c) => c.at).filter((t): t is string => t !== null), ...managedAt].sort().at(-1);
  return { legend, asOfText: latest ? m.ui.stock.channel.asOf(m.when(latest)) : null };
}

export function stockDivergencesView(world: StandWorld, rows: readonly StockDivergenceRow[], m: Messages): StockDivergencesView {
  const t = m.ui.stock.divergences;
  const status = (v: string) => (m.ui.writeStatus as Record<string, string | undefined>)[v] ?? v;
  return {
    worldId: world.id,
    items: rows.map((r) => ({ ...r, storefrontsText: storefronts(r.channel, r.marketplaces, m), text: t.row(r.sent, r.confirmed === null ? '—' : String(r.confirmed), status(r.status), m.when(r.since)) })),
    none: t.none, cannot: t.cannot,
  };
}

/**
 * Шаг 59 [Р-199]: возвраты. Возврат по отгруженной резервации сам в пул не попадает: товар мог вернуться повреждённым,
 * и на полку его ставит человек. У внутреннего пула строка ждёт решения («принять на склад» / «не принимать»); у источника
 * Inbound API — только сведения: остаток ведёт система продавца [Р-6], и возврат придёт от неё новым значением.
 */
export interface StockReturnItem {
  orderReturnId: string;
  productId: string;
  sku: string;
  channel: string;
  channelOrderLineRef: string;
  quantity: number;
  status: OrderReturnRow['status'];
  statusText: string;
  /** Строка ждёт решения человека — у неё две кнопки */
  pending: boolean;
  /** Только сведения: остаток ведёт источник продавца */
  infoOnly: boolean;
  /** Пояснение строки: что ждёт, кто решил и что это значит для остатка */
  text: string;
  note: string | null;
}

export interface StockReturnsView {
  worldId: string;
  intro: string;
  items: StockReturnItem[];
  pendingCount: number;
  pendingText: string;
  none: string;
  canDecide: boolean;
}

export function stockReturnsView(world: StandWorld, rows: readonly OrderReturnRow[], m: Messages): StockReturnsView {
  const t = m.ui.stock.returns;
  const channelName = (c: string) => (m.values as Record<string, string | undefined>)[c] ?? c;
  const items = rows.map((r): StockReturnItem => ({
    orderReturnId: r.orderReturnId, productId: r.productId, sku: r.sku, channel: channelName(r.channel), channelOrderLineRef: r.channelOrderLineRef, quantity: r.quantity,
    status: r.status, statusText: t.status[r.status], pending: r.status === 'PENDING', infoOnly: r.status === 'INFO_ONLY',
    text: r.status === 'PENDING' ? t.awaiting(r.quantity, m.when(r.reportedAt))
      : r.status === 'INFO_ONLY' ? t.infoOnly(r.quantity, m.when(r.reportedAt))
      : r.status === 'ACCEPTED' ? t.accepted(r.quantity, m.when(r.decidedAt))
      : t.dismissed(r.quantity, m.when(r.decidedAt)),
    note: r.note,
  }));
  const pendingCount = items.filter((x) => x.pending).length;
  return {
    worldId: world.id, intro: t.intro, items, pendingCount, pendingText: t.pendingCount(pendingCount), none: t.none,
    canDecide: can(world.viewer.role, 'MANAGE_CATALOG'),
  };
}
