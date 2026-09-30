import { can } from '@repracer/pricing-model';
import type { OrderReturnRow, StockChannelRow, StockDivergenceRow, StockPage, StockRow, StockSourceRow } from '@repracer/stock-sync';
import type { Messages } from './i18n/index.ts';
import { pageInfo, type ListQuery, type PageInfo } from './page.ts';
import { gap, type Gap, type StandWorld } from './world.ts';

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
  divergedText: string | null;
  awaitingAck: boolean;
  tone: 'ok' | 'progress' | 'stop' | 'off' | 'warn';
}

export interface StockRowView {
  productId: string;
  sku: string;
  gtin: string | null;
  onHand: number;
  reserved: number;
  available: number;
  channels: StockChannelCell[];
  /** Шаг 52: количество, которым управляет канал (Amazon FBA), — текстом «управляет Amazon», только для чтения [Р-6] */
  channelManaged: string[];
}

export interface StockTrap {
  channel: string;
  channelAccountId: string;
  text: string;
  requiresAck: boolean;
}

export interface StockView {
  worldId: string;
  demo: boolean;
  intro: string;
  summary: StockPage['summary'];
  summaryText: string;
  rows: StockRowView[];
  page: PageInfo;
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
  items: Array<StockDivergenceRow & { text: string }>;
  none: string;
  cannot: string;
}

/** Ловушка канала по его возможности; текст — словарь, код — канал [Р-153] */
export function stockTraps(world: StandWorld, m: Messages): StockTrap[] {
  const t = m.ui.stock.traps;
  return world.accounts.map((a) => ({
    channel: a.channel, channelAccountId: a.channelAccountId,
    text: a.channel === 'AMAZON' ? t.AMAZON : a.channel === 'KAUFLAND' ? t.KAUFLAND : t.generic(a.channel),
    requiresAck: a.channel === 'AMAZON',
  }));
}

export function channelCell(c: StockChannelRow, m: Messages): StockChannelCell {
  const s = m.ui.stock.channel;
  const channelName = (m.values as Record<string, string | undefined>)[c.channel] ?? c.channel;
  const awaitingAck = c.sideEffects.requiresAck && !c.sideEffects.acknowledged;
  const status = (v: string) => (m.ui.writeStatus as Record<string, string | undefined>)[v] ?? v;
  return {
    writeScopeId: c.writeScopeId, channel: c.channel, label: `${channelName} · ${c.marketplaces.join(', ')}`,
    sharedText: c.marketplaces.length > 1 ? s.shared(c.marketplaces.join(', ')) : null,
    syncEnabled: c.syncEnabled, published: c.published,
    sentText: c.sent ? s.sent(c.sent.quantity, status(c.sent.status), m.when(c.sent.at)) : s.notSent,
    // Р-190 (находка 9 ревью шага 49): подтверждение только нашей записью у канала названо словами
    confirmedText: c.confirmed ? `${s.confirmed(c.confirmed.quantity, m.when(c.confirmed.at))}${c.confirmed.ownRecordOnly ? ` — ${m.ui.ownRecordConfirmation}` : ''}` : s.notConfirmed,
    divergedText: c.divergence ? s.diverged(status(c.divergence.status), m.when(c.divergence.since)) : null,
    awaitingAck,
    tone: !c.syncEnabled ? (awaitingAck ? 'warn' : 'off') : c.divergence ? 'stop' : c.sent && c.confirmed && c.sent.quantity === c.confirmed.quantity ? 'ok' : c.sent ? 'progress' : 'off',
  };
}

export function stockView(world: StandWorld, page: StockPage, query: ListQuery, sources: readonly StockSourceRow[], m: Messages): StockView {
  const t = m.ui.stock;
  return {
    worldId: world.id, demo: world.demo === true, intro: t.intro, summary: page.summary, summaryText: t.summary(page.summary),
    rows: page.items.map((r: StockRow): StockRowView => ({ productId: r.productId, sku: r.sku, gtin: r.gtin, onHand: r.onHand, reserved: r.reserved, available: r.available, channels: r.channels.map((c) => channelCell(c, m)),
      channelManaged: (r.channelManaged ?? []).map((c) => t.channel.managedByChannel((m.values as Record<string, string | undefined>)[c.channel] ?? c.channel, c.marketplace, c.quantity, m.when(c.observedAt))) })),
    page: pageInfo(query, page.total, m),
    sources: sources.map((s) => ({ ...s, modeText: t.sources.modes[s.mode], productsText: t.sources.products(s.products) })),
    traps: stockTraps(world, m),
    canManage: can(world.viewer.role, 'MANAGE_CATALOG'),
    cannot: t.divergences.cannot,
    gaps: [gap(m, 'PRODUCT_TITLE'), gap(m, 'STOCK_CHANNEL_NOT_READ')],
  };
}

export function stockDivergencesView(world: StandWorld, rows: readonly StockDivergenceRow[], m: Messages): StockDivergencesView {
  const t = m.ui.stock.divergences;
  const status = (v: string) => (m.ui.writeStatus as Record<string, string | undefined>)[v] ?? v;
  return {
    worldId: world.id,
    items: rows.map((r) => ({ ...r, text: t.row(r.sent, r.confirmed === null ? '—' : String(r.confirmed), status(r.status), m.when(r.since)) })),
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
