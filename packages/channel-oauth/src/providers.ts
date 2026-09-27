/**
 * Р-175 (шаг 43): поставщики OAuth каналов. Каждый факт — из снимка первоисточника, и где он взят, сказано у поля:
 *   Amazon LWA — vendor/amazon/lwa-authorization/2026-09-26/SOURCE.md (страницы документации SP-API и LWA);
 *   eBay        — vendor/ebay/oauth-client/SOURCE.md (официальный клиент eBay, коммит 28215678…).
 * Чего источники не говорят, то не угадывается: значения из конфигурации и вопросы A-17, A-18, E-08…E-11.
 *
 * Модуль не ходит в сеть сам: транспорт передаётся (`fetch` или модель поставщика). Секреты не попадают ни в адрес, ни
 * в сообщения ошибок, ни в результат, кроме полей токенов, которые вызывающий обязан сразу зашифровать.
 */

export type OAuthChannel = 'AMAZON' | 'EBAY';
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

export interface ConsentRequest {
  state: string;
  /** Amazon: витрины продавца определяют адрес Seller Central; eBay: не используется */
  marketplaces: readonly string[];
}

/** Что приходит на наш адрес возврата: либо код, либо отказ продавца / ошибка канала */
export type ConsentCallback =
  | { kind: 'CODE'; state: string; code: string; sellerId: string | null }
  | { kind: 'DENIED'; state: string | null; error: string };

export interface OAuthProvider {
  channel: OAuthChannel;
  /** Адрес страницы согласия, на которую уходит браузер продавца */
  consentUrl(request: ConsentRequest): string;
  /** Разбор параметров возврата; `state` сверяет вызывающий — по отпечатку в базе */
  parseCallback(query: Readonly<Record<string, string | undefined>>): ConsentCallback;
  tokenRequest(grant: { kind: 'CODE'; code: string } | { kind: 'REFRESH'; refreshToken: string }): { url: string; headers: Record<string, string>; body: string };
}

// ---------------------------------------------------------------------------------------------------- Amazon LWA
/** LWA: `POST https://api.amazon.com/auth/o2/token` — website-authorization-workflow, connecting-to-the-selling-partner-api */
export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

/**
 * Seller Central по витрине — seller-central-urls: Германия (и Франция, Италия, Испания, Великобритания) —
 * `sellercentral-europe.amazon.com`, США — `sellercentral.amazon.com`. Здесь только витрины, которые знает справочник
 * продукта; неизвестная витрина — отказ, а не догадка.
 */
export const AMAZON_SELLER_CENTRAL: Readonly<Record<string, string>> = {
  A1PA6795UKMFR9: 'https://sellercentral-europe.amazon.com',
  ATVPDKIKX0DER: 'https://sellercentral.amazon.com',
};

export interface AmazonLwaConfig {
  /** `application_id` приложения SP-API (`amzn1.sellerapps.app.…`) */
  applicationId: string;
  clientId: string;
  clientSecret: string;
  /** Должен совпадать с зарегистрированным у приложения — иначе обмен кода откажет */
  redirectUri: string;
  /** Приложение в состоянии Draft: `version=beta` — website-authorization-workflow */
  draft: boolean;
  /** Адрес Seller Central и LWA подменяются ТОЛЬКО моделью поставщика в прогонах */
  sellerCentral?: Readonly<Record<string, string>>;
  tokenUrl?: string;
}

export function amazonLwa(cfg: AmazonLwaConfig): OAuthProvider {
  const central = cfg.sellerCentral ?? AMAZON_SELLER_CENTRAL;
  return {
    channel: 'AMAZON',
    consentUrl({ state, marketplaces }) {
      const hosts = new Set(marketplaces.map((m) => central[m]));
      if (marketplaces.length === 0 || hosts.has(undefined) || hosts.size !== 1) {
        // Разные регионы — разные Seller Central: одно согласие на две витрины разных регионов не выдать
        throw new Error('AMAZON_CONSENT_MARKETPLACES_UNSUPPORTED');
      }
      const url = new URL(`${[...hosts][0]}/apps/authorize/consent`);
      url.searchParams.set('application_id', cfg.applicationId);
      url.searchParams.set('state', state);
      if (cfg.draft) url.searchParams.set('version', 'beta');
      return url.toString();
    },
    parseCallback(q) {
      // Возврат: `state`, `selling_partner_id`, `spapi_oauth_code` (website-authorization-workflow)
      if (q.spapi_oauth_code && q.state) {
        return { kind: 'CODE', state: q.state, code: q.spapi_oauth_code, sellerId: q.selling_partner_id ?? null };
      }
      return { kind: 'DENIED', state: q.state ?? null, error: q.error ?? 'NO_CODE' };
    },
    tokenRequest(grant) {
      const form = grant.kind === 'CODE'
        ? new URLSearchParams({ grant_type: 'authorization_code', code: grant.code, redirect_uri: cfg.redirectUri, client_id: cfg.clientId, client_secret: cfg.clientSecret })
        : new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret });
      return { url: cfg.tokenUrl ?? LWA_TOKEN_URL, headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: form.toString() };
    },
  };
}

// ---------------------------------------------------------------------------------------------------- eBay
/** src/constants.js официального клиента eBay */
export const EBAY_ENDPOINTS = {
  PRODUCTION: { authorize: 'https://auth.ebay.com/oauth2/authorize', token: 'https://api.ebay.com/identity/v1/oauth2/token' },
  SANDBOX: { authorize: 'https://auth.sandbox.ebay.com/oauth2/authorize', token: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token' },
} as const;

export interface EbayOAuthConfig {
  environment: 'SANDBOX' | 'PRODUCTION';
  clientId: string;
  clientSecret: string;
  /** `redirect_uri` клиента eBay — зарегистрированное имя адреса возврата приложения */
  redirectUri: string;
  /**
   * Scope Inventory API в снимке НЕТ (там только scope приложения) — значение приходит конфигурацией и проверяется
   * первым живым потоком шага 39 (вопрос E-08). Пустой список — отказ: eBay без scope согласия не спросит.
   */
  scopes: readonly string[];
  /** Подмена конечных точек — ТОЛЬКО для модели поставщика */
  endpoints?: { authorize: string; token: string };
}

export function ebayOAuth(cfg: EbayOAuthConfig): OAuthProvider {
  if (cfg.scopes.length === 0) throw new Error('EBAY_SCOPES_REQUIRED');
  const endpoints = cfg.endpoints ?? EBAY_ENDPOINTS[cfg.environment];
  // Basic base64(client_id:client_secret) — src/request.js
  const basic = `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, 'utf8').toString('base64')}`;
  return {
    channel: 'EBAY',
    consentUrl({ state }) {
      // client_id, redirect_uri, response_type=code, scope через пробел, state — src/index.js generateUserAuthorizationUrl
      const url = new URL(endpoints.authorize);
      url.searchParams.set('client_id', cfg.clientId);
      url.searchParams.set('redirect_uri', cfg.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', cfg.scopes.join(' '));
      url.searchParams.set('state', state);
      return url.toString();
    },
    parseCallback(q) {
      if (q.code && q.state) return { kind: 'CODE', state: q.state, code: q.code, sellerId: null };
      return { kind: 'DENIED', state: q.state ?? null, error: q.error ?? 'NO_CODE' };
    },
    tokenRequest(grant) {
      const form = grant.kind === 'CODE'
        ? new URLSearchParams({ grant_type: 'authorization_code', code: grant.code, redirect_uri: cfg.redirectUri })
        : new URLSearchParams({ grant_type: 'refresh_token', refresh_token: grant.refreshToken, scope: cfg.scopes.join(' ') });
      return { url: endpoints.token, headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic }, body: form.toString() };
    },
  };
}
