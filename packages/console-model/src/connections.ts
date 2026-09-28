import { can, type MemberRole } from '@repracer/pricing-model';
import type { ConnectionRow, PendingRequestRow } from '@repracer/pricing-store-pg';
import type { Messages } from './i18n/index.ts';

/**
 * Р-175…Р-177 (шаг 43): экран «Подключение каналов». Продавец подключает канал САМ — кнопкой, согласием на стороне
 * канала и возвратом с кодом; токен до экрана не доходит никогда: экран видит только, ЕСТЬ ли действующая авторизация,
 * когда её получили и когда последний раз проверили.
 *
 * Состояние выводится из данных, а не хранится отдельным полем [Р-149]:
 *   NOT_CONNECTED      — у канала нет аккаунта и нет живого запроса согласия;
 *   AWAITING_CONSENT   — запрос согласия начат и не истёк: продавец на странице канала;
 *   AWAITING_PLATFORM  — у ПЛАТФОРМЫ нет приложения канала (ключей разработчика) [Р-150]: подключить нечем, и кнопки нет;
 *   AWAITING_ACCESS    — аккаунт есть, но ему не хватает названного доступа [Р-150];
 *   SHADOW             — аккаунт в тени [Р-170, Р-176]: «нашли N офферов, тень считает»;
 *   LIVE               — боевой режим;
 *   REVOKED            — продавец отозвал авторизацию у канала [Р-177]: записей нет, нужна новая авторизация.
 */

export type ConnectionState = 'NOT_CONNECTED' | 'AWAITING_CONSENT' | 'AWAITING_PLATFORM' | 'AWAITING_ACCESS' | 'SHADOW' | 'LIVE' | 'REVOKED';

/** Канал, который процесс умеет подключать: есть ли у платформы приложение и каких витрин оно касается */
export interface ConnectableChannel {
  channel: 'AMAZON' | 'EBAY';
  /** Пусто — приложение есть; иначе — коды того, чего не хватает платформе (E-01, регистрация приложения SP-API) */
  platformMissing: string[];
  marketplaces: string[];
}

export interface ConnectionAccountView {
  channelAccountId: string;
  channel: string;
  label: string;
  marketplaces: string[];
  state: ConnectionState;
  stateText: string;
  /** Р-176: что уже видно — офферы и решения тени */
  progressText: string | null;
  authorizationText: string;
  offers: number;
  /** Из них — вести нельзя: нет единицы записи цены (у eBay — немигрированные листинги и аукционы) */
  unmanagedOffers: number;
  shadowDecisions24h: number;
  /** Повторная авторизация: у отозванного — главное действие, у действующего — обновить доступ */
  canReconnect: boolean;
  reconnectLabel: string;
  /**
   * Шаг 49 [Р-190, E-21]: чего мы на этом канале в бою пока не видим — словами. У eBay: цену покупателя и правки других программ (Browse в
   * бою недоступен), подтверждение — по записи предложения, сверка базы цены ограничена. Окружение (песочница или бой) экран не знает,
   * поэтому текст — у любого аккаунта eBay: честнее сказать лишнее в песочнице, чем промолчать в бою.
   */
  channelLimitText: string | null;
}

export interface ConnectionChannelView {
  channel: 'AMAZON' | 'EBAY';
  state: ConnectionState;
  stateText: string;
  canConnect: boolean;
  connectLabel: string;
  marketplaces: Array<{ id: string; label: string }>;
  missingText: string | null;
  pendingText: string | null;
  /** Находка 17 ревью шага 43: ждущий запрос отменяется продавцом, а не держит кнопку десять минут */
  pendingRequestId: string | null;
  cancelLabel: string;
  /** Шаг 49 [Р-190]: то же ограничение канала — ещё до подключения, чтобы продавец знал его заранее */
  channelLimitText: string | null;
}

export interface ConnectionsView {
  worldId: string;
  title: string;
  intro: string;
  canManage: boolean;
  noRightText: string | null;
  channels: ConnectionChannelView[];
  accounts: ConnectionAccountView[];
  tokenNote: string;
}

/** Р-190 (E-21): ограничение боевого чтения канала словами; сейчас оно есть только у eBay */
export function channelLimitText(channel: string, m: Messages): string | null {
  return channel === 'EBAY' ? m.ui.connections.ebayLiveLimits : null;
}

export function accountState(a: Pick<ConnectionRow, 'authStatus' | 'writeMode'>): ConnectionState {
  if (a.authStatus === 'REVOKED') return 'REVOKED';
  if (a.authStatus === 'AWAITING_ACCESS') return 'AWAITING_ACCESS';
  return a.writeMode === 'LIVE' ? 'LIVE' : 'SHADOW';
}

export function connectionsView(
  input: { worldId: string; role: MemberRole; now: string },
  rows: { accounts: ConnectionRow[]; pending: PendingRequestRow[] },
  connectable: readonly ConnectableChannel[],
  m: Messages,
): ConnectionsView {
  const t = m.ui.connections;
  const canManage = can(input.role, 'MANAGE_TENANT');
  const nowMs = Date.parse(input.now);
  const accounts = rows.accounts.map((a): ConnectionAccountView => {
    const state = accountState(a);
    const found = state === 'SHADOW'
      ? (a.offers === 0 ? t.progress.discovering : a.shadowDecisions24h === 0 ? t.progress.shadowWaiting(a.offers) : t.progress.shadow(a.offers, a.shadowDecisions24h))
      : state === 'LIVE' ? t.progress.live(a.offers) : state === 'AWAITING_ACCESS' ? t.progress.awaitingAccess(a.accessBlockers.join(', ')) : null;
    // Хвост шага 47: «нашли N» называет и те, что вести нельзя (немигрированные листинги и аукционы eBay, Р-164)
    const progressText = found !== null && (state === 'SHADOW' || state === 'LIVE') && a.offers > 0 && a.unmanagedOffers > 0
      ? `${found} ${t.progress.unmanaged(a.unmanagedOffers, a.offers - a.unmanagedOffers)}` : found;
    // Находка 18 ревью шага 43: у отозванного — «доступ отозван», а не «последний раз подтверждён»
    const authorizationText = !a.oauth ? t.authorization.external
      : state === 'REVOKED' ? t.authorization.revoked
      : a.credentialVerifiedAt ? t.authorization.verified(a.credentialVerifiedAt, a.credentialCheckFailures)
        : t.authorization.obtained(a.credentialObtainedAt ?? a.connectedAt);
    return {
      channelAccountId: a.channelAccountId, channel: a.channel, label: `${a.channel} · ${a.externalAccountId} · ${a.marketplaces.join(', ')}`, marketplaces: [...a.marketplaces],
      state, stateText: t.states[state] ?? state, progressText, authorizationText, offers: a.offers, unmanagedOffers: a.unmanagedOffers, shadowDecisions24h: a.shadowDecisions24h,
      // eBay не называет продавца (E-11): повторное согласие создало бы второй аккаунт того же продавца (находка 6 ревью шага 43)
      canReconnect: canManage && a.channel === 'AMAZON' && a.oauth,
      reconnectLabel: state === 'REVOKED' ? t.reconnectRevoked : t.reconnect,
      channelLimitText: channelLimitText(a.channel, m),
    };
  });
  const channels = connectable.map((c): ConnectionChannelView => {
    const pending = rows.pending.find((p) => p.channel === c.channel && p.status === 'PENDING' && Date.parse(p.expiresAt) > nowMs) ?? null;
    // Находка 18: состояние канала — по НОВЕЙШЕМУ аккаунту, а не по первому в списке
    const newest = rows.accounts.filter((a) => a.channel === c.channel).sort((x, y) => Date.parse(y.connectedAt) - Date.parse(x.connectedAt))[0] ?? null;
    const state: ConnectionState = c.platformMissing.length > 0 ? 'AWAITING_PLATFORM' : pending ? 'AWAITING_CONSENT' : newest ? accountState(newest) : 'NOT_CONNECTED';
    // Провал показывается, только если он новее последнего удавшегося подключения канала (запросы идут новейшими первыми)
    const latest = rows.pending.find((p) => p.channel === c.channel && p.status !== 'PENDING') ?? null;
    const failed = latest && latest.status !== 'COMPLETED' && latest.failureCode !== 'CANCELLED' ? latest : null;
    const has = newest !== null;
    return {
      channel: c.channel, state, stateText: t.states[state] ?? state,
      canConnect: canManage && c.platformMissing.length === 0 && pending === null,
      connectLabel: has ? t.connectAnother(c.channel) : t.connect(c.channel),
      marketplaces: c.marketplaces.map((id) => ({ id, label: t.marketplaces[id] ?? id })),
      missingText: c.platformMissing.length > 0 ? t.platformMissing(c.platformMissing.map((code) => t.missing[code] ?? code).join('; ')) : null,
      pendingText: pending ? t.pending(pending.expiresAt) : failed ? t.failed(t.failures[failed.failureCode ?? failed.status] ?? failed.failureCode ?? failed.status) : null,
      pendingRequestId: pending && canManage ? pending.authorizationRequestId : null,
      cancelLabel: t.cancel,
      channelLimitText: channelLimitText(c.channel, m),
    };
  });
  return {
    worldId: input.worldId, title: t.title, intro: t.intro, canManage, noRightText: canManage ? null : t.noRight,
    channels, accounts, tokenNote: t.tokenNote,
  };
}
