import { exchangeCode, newState, sealToken, stateDigest, type Fetch, type Keyring, type OAuthProvider } from '@repracer/channel-oauth';
import type { ConnectableChannel } from '@repracer/console-model';
import type { ConnectionRow, ConnectOutcome, PendingRequestRow, PgChannelConnectStore } from '@repracer/pricing-store-pg';

/**
 * Р-175…Р-177 (шаг 43): подключение канала продавцом — серверная половина.
 *
 * Что здесь важно и почему:
 *  - `state` — случайный, в базу уходит только его SHA-256; сам `state` живёт в адресе согласия и возвращается браузером.
 *    Возврат сверяется с запросом ЭТОГО тенанта: чужой `state` — «не наш запрос», а не подключение к чужому тенанту;
 *  - код согласия меняется на токены ЗДЕСЬ, сразу, в пределах срока запроса (код Amazon живёт пять минут);
 *  - access-токен выбрасывается сразу: хранить его незачем, он живёт час. Refresh-токен шифруется ключом процесса
 *    (AES-256-GCM, связанные данные — тенант и аккаунт) и уходит в базу шифротекстом; консоль прочитать его не может [Р-177];
 *  - ни код, ни токен не попадают в ответ, в журнал и в ошибку: ответ называет только исход.
 */

export interface ConnectProvider {
  channel: 'AMAZON' | 'EBAY';
  /** Витрины, которые умеет приложение платформы; регион — свойство витрины */
  marketplaces: Array<{ id: string; region: 'EU' | 'NA' | null }>;
  /** Нет приложения — нечем подключать: коды того, чего не хватает платформе [Р-150] */
  platformMissing: string[];
  provider: OAuthProvider | null;
}

export interface ChannelConnectService {
  connectable(): ConnectableChannel[];
  connections(tenantId: string): Promise<{ accounts: ConnectionRow[]; pending: PendingRequestRow[] }>;
  start(tenantId: string, input: { channel: string; marketplaces: string[] }, actor: Actor): Promise<StartOutcome>;
  callback(tenantId: string, params: Record<string, string>, actor: Actor): Promise<CallbackOutcome>;
  cancel(tenantId: string, authorizationRequestId: string, actor: Actor): Promise<boolean>;
}

export interface Actor { membershipId: string; userId: string; mfa: boolean }

export type StartOutcome =
  | { status: 'STARTED'; consentUrl: string; expiresAt: string }
  | { status: 'UNAVAILABLE' }
  | { status: 'BAD_MARKETPLACES' }
  /** Находка 6 ревью шага 43: eBay не называет продавца (E-11) — второй аккаунт eBay был бы тем же продавцом дважды */
  | { status: 'IDENTITY_UNKNOWN' };

export type CallbackOutcome =
  | ConnectOutcome
  | { status: 'DENIED' }
  | { status: 'BAD_CALLBACK' }
  | { status: 'EXCHANGE_FAILED'; failure: 'REVOKED' | 'PLATFORM' | 'TRANSIENT' };

/** Срок запроса согласия: Amazon предупреждает, что поток дольше десяти минут ломается; база больше не примет */
export const CONSENT_TTL_SECONDS = 600;

export function createChannelConnectService(o: {
  store: PgChannelConnectStore;
  keyring: Keyring;
  providers: readonly ConnectProvider[];
  http: Fetch;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): ChannelConnectService {
  const byChannel = (channel: string) => o.providers.find((p) => p.channel === channel) ?? null;
  return {
    connectable: () => o.providers.map((p) => ({
      channel: p.channel, platformMissing: [...p.platformMissing], marketplaces: p.marketplaces.map((m) => m.id),
    })),
    connections: (tenantId) => o.store.connections(tenantId),
    cancel: (tenantId, id, actor) => o.store.cancel(tenantId, id, actor),

    async start(tenantId, input, actor) {
      const p = byChannel(input.channel);
      if (!p || !p.provider || p.platformMissing.length > 0) return { status: 'UNAVAILABLE' };
      const chosen = p.marketplaces.filter((m) => input.marketplaces.includes(m.id));
      const regions = new Set(chosen.map((m) => m.region));
      // Витрины двух регионов одним согласием не авторизовать: у Amazon это разные Seller Central
      if (chosen.length === 0 || chosen.length !== input.marketplaces.length || regions.size !== 1) return { status: 'BAD_MARKETPLACES' };
      if (p.channel === 'EBAY' && await o.store.hasAccount(tenantId, 'EBAY')) return { status: 'IDENTITY_UNKNOWN' };
      const { state, stateSha256 } = newState();
      let consentUrl: string;
      try {
        consentUrl = p.provider.consentUrl({ state, marketplaces: chosen.map((m) => m.id) });
      } catch {
        return { status: 'BAD_MARKETPLACES' };
      }
      const started = await o.store.start(tenantId, {
        channel: p.channel, region: chosen[0]!.region, marketplaces: chosen.map((m) => m.id), stateSha256, ttlSeconds: CONSENT_TTL_SECONDS, ...actor,
      });
      return { status: 'STARTED', consentUrl, expiresAt: started.expiresAt };
    },

    async callback(tenantId, params, actor) {
      const state = typeof params.state === 'string' ? params.state : '';
      if (state.length < 16 || state.length > 128) return { status: 'BAD_CALLBACK' };
      const digest = stateDigest(state);
      /**
       * Находка 9 ревью шага 43: обмен ЗАХВАТЫВАЕТСЯ до обращения к каналу — одновременный второй возврат получает
       * «уже обменивается». Канал берётся из запроса этого тенанта, а не из вида параметров (находка 19): Amazon-запрос
       * с параметром `code` не уйдёт менять код к eBay.
       */
      const claim = await o.store.claim(tenantId, digest, actor);
      if (claim.status === 'UNKNOWN') return { status: 'UNKNOWN_STATE' };
      if (claim.status === 'EXPIRED') return { status: 'EXPIRED' };
      if (claim.status !== 'CLAIMED') return { status: 'ALREADY_DONE', requestStatus: 'DONE' };
      const provider = byChannel(claim.channel)?.provider;
      if (!provider) {
        await o.store.fail(tenantId, digest, 'FAILED', 'EXCHANGE_PLATFORM', actor);
        return { status: 'EXCHANGE_FAILED', failure: 'PLATFORM' };
      }
      const cb = provider.parseCallback(params);
      if (cb.state !== null && cb.state !== state) {
        await o.store.fail(tenantId, digest, 'FAILED', 'BAD_CALLBACK', actor);
        return { status: 'BAD_CALLBACK' };
      }
      if (cb.kind === 'DENIED') {
        await o.store.fail(tenantId, digest, 'DENIED', 'DENIED', actor);
        return { status: 'DENIED' };
      }
      const tokens = await exchangeCode(provider, cb.code, o.http);
      if (!tokens.ok) {
        await o.store.fail(tenantId, digest, 'FAILED', `EXCHANGE_${tokens.failure}`, actor);
        o.log?.('channel_connect_exchange_failed', { tenantId, failure: tokens.failure, code: tokens.code });
        return { status: 'EXCHANGE_FAILED', failure: tokens.failure };
      }
      const refresh = tokens.refreshToken!;
      const outcome = await o.store.complete(tenantId, {
        stateSha256: digest, externalAccountId: cb.sellerId ?? null,
        seal: (channelAccountId) => sealToken(o.keyring, refresh, { tenantId, channelAccountId }),
        refreshExpiresAt: tokens.refreshExpiresIn === null ? null : new Date(Date.now() + tokens.refreshExpiresIn * 1000).toISOString() as never,
        ...actor,
      });
      if (outcome.status === 'SELLER_TAKEN' || outcome.status === 'MFA_REQUIRED') await o.store.fail(tenantId, digest, 'FAILED', outcome.status, actor);
      o.log?.('channel_connect_callback', { tenantId, status: outcome.status, ...(outcome.status === 'CONNECTED' ? { channelAccountId: outcome.channelAccountId, reconnected: outcome.reconnected } : {}) });
      return outcome;
    },
  };
}
