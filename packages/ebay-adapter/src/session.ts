import { createHash } from 'node:crypto';
import type { AdapterCallContext, AdapterDependencies, ChannelError, VerifiedChannelAccount } from '@repracer/channel-port';
import { EBAY_ENDPOINTS, ebayOAuth, refreshAccess, requestToken, type OAuthProvider } from '@repracer/channel-oauth';
import { type EbayRequestBudget, type EditAttemptLedger, RollingDayLedger, TokenBucket } from './budget.ts';
import { logConservative } from './conservative.ts';
import { APPLICATION_SCOPE, EBAY_HOSTS, EBAY_MARKETPLACES, type EbayEnvironment, marketplaceInfo, TOKEN_PATH, TRADING_COMPATIBILITY_LEVEL, TRADING_PATH } from './descriptor.ts';
import { channelError, tokenFailureError } from './errors.ts';
import { DEFAULT_READ_RETRY, type HttpResult, type RetryPolicy, send } from './http.ts';

export interface EbayAdapterOptions {
  deps: AdapterDependencies;
  /** Песочница или бой: хосты api./apiz. и сервер токенов */
  environment: EbayEnvironment;
  /**
   * Ссылка на ключи приложения eBay (clientId, clientSecret; redirectUri — для обмена кода, здесь не нужен) — платформенные,
   * общие для тенантов. refreshToken продавца — по credentialsRef аккаунта [Р-177].
   */
  applicationCredentialsRef: string;
  /** Scope обновления токена пользователя — те же, что при согласии (E-08; песочница: api_scope, sell.inventory, sell.account, commerce.identity.readonly) */
  scopes: readonly string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  readRetry?: Partial<RetryPolicy>;
  /**
   * Состояние адаптера: бюджет запросов, второй слой бюджета правок и кэш токенов. Не задано — создаётся ОДИН раз при создании
   * адаптера (resolveOptions) и живёт с ним; фабрика ebayAdapterFactory создаёт его один раз на фабрику, поэтому адаптеры одной
   * фабрики делят бюджеты и токены. Раньше состояние жило в WeakMap по объекту настроек, а фабрика создавала новый объект на каждый
   * вызов — каждый адаптер начинал с пустого бюджета правок.
   */
  requestBudget?: EbayRequestBudget;
  editLedger?: EditAttemptLedger;
  tokenCache?: EbayTokenCache;
  /** Окно подтверждения цены по живому листингу [EBAY_C05] */
  confirmationWindowMs?: number;
  /** Ревью шага 47, находка 4: аккаунты, о чьём НДС сверху уже сказано алертом в этом процессе (один алерт на аккаунт) */
  vatAlertedAccounts?: Set<string>;
  /** Шаг 49 [Р-190]: аккаунты, о которых в этом процессе уже записано «Browse в бою недоступен» (EBAY_C19 — один раз на аккаунт) */
  browseUnavailableLogged?: Set<string>;
}

export interface Session {
  account: VerifiedChannelAccount;
  sellerKey: string;
}

export function nowMs(options: EbayAdapterOptions): number {
  return Date.parse(options.deps.now());
}

/** Кэш токенов: ключ — хеш учётных данных, не сами секреты */
export type EbayTokenCache = Map<string, { token: string; expiresAtMs: number }>;
const TOKEN_EARLY_REFRESH_MS = 60_000;

/** Настройки с состоянием адаптера — внутри адаптера только такие */
export type ResolvedOptions = EbayAdapterOptions & {
  requestBudget: EbayRequestBudget; editLedger: EditAttemptLedger; tokenCache: EbayTokenCache; vatAlertedAccounts: Set<string>; browseUnavailableLogged: Set<string>;
};

export function resolveOptions(options: EbayAdapterOptions): ResolvedOptions {
  return { ...options, requestBudget: options.requestBudget ?? new TokenBucket(), editLedger: options.editLedger ?? new RollingDayLedger(), tokenCache: options.tokenCache ?? new Map(),
    vatAlertedAccounts: options.vatAlertedAccounts ?? new Set(), browseUnavailableLogged: options.browseUnavailableLogged ?? new Set() };
}

/**
 * Р-190 (E-21): Browse API — часть Buy API, и лицензия на неё для репрайсера не выяснена. В бою Browse считается НЕДОСТУПНЫМ и не
 * вызывается; в песочнице — доступен, как на шаге 39.
 */
export function browseAvailable(options: Pick<EbayAdapterOptions, 'environment'>): boolean {
  return options.environment !== 'PRODUCTION';
}

export function apiHost(options: EbayAdapterOptions): string {
  return EBAY_HOSTS[options.environment].api;
}

/** Р-31: тенант и аккаунт из сообщения сверяются по каталогу до любого обращения к eBay */
export async function openSession(options: EbayAdapterOptions, ctx: Pick<AdapterCallContext, 'tenantId' | 'channelAccountId' | 'correlationId'>):
  Promise<{ ok: true; session: Session } | { ok: false; error: ChannelError }> {
  const { deps } = options;
  const verified = await deps.accounts.verify(ctx.tenantId, ctx.channelAccountId);
  if (!verified.ok) {
    const mismatch = verified.reason === 'TENANT_MISMATCH';
    await deps.alerts.raise({
      code: mismatch ? 'EBAY_TENANT_MISMATCH' : 'EBAY_ACCOUNT_UNAVAILABLE', severity: mismatch ? 'CRITICAL' : 'WARNING',
      tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId, details: { reason: verified.reason },
    });
    return { ok: false, error: mismatch
      ? channelError('TENANT_MISMATCH', 'ACCOUNT', 'channel account does not belong to the tenant in the message', { raiseAlert: true })
      : channelError('PRECONDITION_FAILED', 'ACCOUNT', `channel account is ${verified.reason}`) };
  }
  const account = verified.account;
  if (account.channel !== 'EBAY') return { ok: false, error: channelError('PRECONDITION_FAILED', 'ACCOUNT', `account channel ${account.channel} is not EBAY`) };
  return { ok: true, session: { account, sellerKey: `ebay:${account.channelAccountId}` } };
}

async function applicationKeys(options: EbayAdapterOptions): Promise<{ clientId: string; clientSecret: string; redirectUri: string } | null> {
  const app = await options.deps.credentials.get(options.applicationCredentialsRef);
  return app.clientId && app.clientSecret ? { clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: app.redirectUri ?? '' } : null;
}

function tokenUrl(options: EbayAdapterOptions): string {
  return `${apiHost(options)}${TOKEN_PATH}`;
}

/** Токен пользователя: обмен refresh-токена продавца модулем channel-oauth (тот же поставщик, что подключал канал, Р-175) */
async function userToken(options: ResolvedOptions, session: Session, fresh: boolean): Promise<{ ok: true; token: string } | { ok: false; error: ChannelError }> {
  const app = await applicationKeys(options);
  const seller = await options.deps.credentials.get(session.account.credentialsRef);
  if (!app || !seller.refreshToken) return { ok: false, error: channelError('AUTH_INVALID', 'ACCOUNT', 'eBay credentials are incomplete') };
  const key = `user:${createHash('sha256').update(`${app.clientId}\n${seller.refreshToken}`).digest('hex')}`;
  const cache = options.tokenCache;
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiresAtMs > nowMs(options)) return { ok: true, token: cached.token };
  const provider = ebayOAuth({
    environment: options.environment, clientId: app.clientId, clientSecret: app.clientSecret, redirectUri: app.redirectUri, scopes: options.scopes,
    endpoints: { authorize: EBAY_ENDPOINTS[options.environment].authorize, token: tokenUrl(options) },
  });
  const r = await refreshAccess(provider, seller.refreshToken, (options.fetch ?? fetch) as never);
  if (!r.ok) return { ok: false, error: tokenFailureError(r.failure, r.code) };
  cache.set(key, { token: r.accessToken, expiresAtMs: nowMs(options) + r.expiresIn * 1000 - TOKEN_EARLY_REFRESH_MS });
  return { ok: true, token: r.accessToken };
}

/**
 * Токен приложения (client_credentials, scope api_scope — официальный клиент eBay) — для Browse API [EBAY_C06]. Тот же разбор отказа,
 * что у токена пользователя: поставщик — одноразовый объект только с запросом токена (согласия у приложения нет).
 */
async function applicationToken(options: ResolvedOptions, fresh: boolean): Promise<{ ok: true; token: string } | { ok: false; error: ChannelError }> {
  const app = await applicationKeys(options);
  if (!app) return { ok: false, error: channelError('AUTH_INVALID', 'ACCOUNT', 'eBay application credentials are incomplete', { raiseAlert: true }) };
  const key = `app:${createHash('sha256').update(app.clientId).digest('hex')}`;
  const cache = options.tokenCache;
  const cached = cache.get(key);
  if (!fresh && cached && cached.expiresAtMs > nowMs(options)) return { ok: true, token: cached.token };
  const basic = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`, 'utf8').toString('base64')}`;
  const provider: OAuthProvider = {
    channel: 'EBAY',
    consentUrl: () => { throw new Error('application token has no consent'); },
    parseCallback: () => ({ kind: 'DENIED', state: null, error: 'NO_CONSENT' }),
    tokenRequest: () => ({
      url: tokenUrl(options), headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: APPLICATION_SCOPE }).toString(),
    }),
  };
  const r = await requestToken(provider, { kind: 'REFRESH', refreshToken: '' }, (options.fetch ?? fetch) as never);
  if (!r.ok) return { ok: false, error: tokenFailureError(r.failure === 'REVOKED' ? 'PLATFORM' : r.failure, r.code) };
  cache.set(key, { token: r.accessToken, expiresAtMs: nowMs(options) + r.expiresIn * 1000 - TOKEN_EARLY_REFRESH_MS });
  return { ok: true, token: r.accessToken };
}

export function deadlinePassed(options: EbayAdapterOptions, ctx: AdapterCallContext): ChannelError | null {
  return Date.parse(ctx.deadline) <= nowMs(options) ? channelError('TIMEOUT', 'BATCH', 'call deadline passed before the request to eBay was sent') : null;
}

/** Клиентский бюджет запросов [EBAY_C01]: при нехватке запрос не отправляется, RATE_LIMITED с retryAt */
export function acquire(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, operation: string): ChannelError | null {
  const r = options.requestBudget.tryAcquire(session.sellerKey, nowMs(options));
  if (r.ok) return null;
  logConservative(options.deps.logger, ctx, 'EBAY_C01_REQUEST_BUDGET', { operation });
  return channelError('RATE_LIMITED', 'BATCH', `client-side eBay request budget exhausted for ${operation}`, { retryAt: new Date(r.retryAtMs).toISOString() });
}

export type Auth = 'USER' | 'APPLICATION';

export interface CallSpec {
  auth: Auth;
  method: 'GET' | 'POST';
  /** Путь с запросом; хост — по окружению */
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  idempotent?: boolean;
  /** Trading API: имя вызова и сайт — токен пользователя идёт в X-EBAY-API-IAF-TOKEN */
  trading?: { callName: string; siteId: number };
  operation: string;
  /** Срок и бюджет запросов уже проверены вызывающим (запись: до списания попытки правки листинга) */
  preAcquired?: boolean;
  /**
   * Ревью шага 49, находка 10: при отказе КЛИЕНТСКОГО бюджета запросов ждать до retryAt в пределах срока вызова, а не отказывать. Безопасно
   * для любого вызова: при таком отказе запрос не отправлялся. Нужен предполётной проверке и миграции — они делают несколько чтений подряд.
   */
  waitForBudget?: boolean;
}

export type CallOutcome = { kind: 'HTTP'; result: HttpResult } | { kind: 'REFUSED'; error: ChannelError; attempts: number };

function queryString(query: CallSpec['query']): string {
  const p = Object.entries(query ?? {}).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length > 0 ? `?${p.join('&')}` : '';
}

/**
 * Один вызов eBay: срок, бюджет запросов, токен нужного вида, запрос. 401 — токен устарел раньше срока: один повтор с новым токеном
 * (запрос не обработан); иных повторов записи нет [EBAY_C02].
 */
export async function call(options: ResolvedOptions, ctx: AdapterCallContext, session: Session, spec: CallSpec): Promise<CallOutcome> {
  if (!spec.preAcquired) {
    let refused = deadlinePassed(options, ctx) ?? acquire(options, ctx, session, spec.operation);
    for (let waits = 0; refused && spec.waitForBudget && refused.code === 'RATE_LIMITED' && refused.retryAt
      && Date.parse(refused.retryAt) <= Date.parse(ctx.deadline) && waits < 20; waits++) {
      await (options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))))(Math.max(1, Date.parse(refused.retryAt) - nowMs(options)));
      refused = deadlinePassed(options, ctx) ?? acquire(options, ctx, session, spec.operation);
    }
    if (refused) return { kind: 'REFUSED', error: refused, attempts: 0 };
  }
  let attempts = 0;
  for (let fresh = false; ; fresh = true) {
    const token = spec.auth === 'USER' ? await userToken(options, session, fresh) : await applicationToken(options, fresh);
    if (!token.ok) return { kind: 'REFUSED', error: token.error, attempts };
    const body = spec.body === undefined ? undefined : typeof spec.body === 'string' ? spec.body : JSON.stringify(spec.body);
    const headers: Record<string, string> = spec.trading
      ? {
        'content-type': 'text/xml', 'x-ebay-api-call-name': spec.trading.callName, 'x-ebay-api-siteid': String(spec.trading.siteId),
        'x-ebay-api-compatibility-level': TRADING_COMPATIBILITY_LEVEL, 'x-ebay-api-iaf-token': token.token,
      }
      // Шаг 50: без Accept-Language живая песочница отвергает GET inventory_item (400 25709); язык — по первой витрине аккаунта
      : { accept: 'application/json', 'accept-language': acceptLanguageOf(session), authorization: `Bearer ${token.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
    const result = await send({
      fetch: options.fetch ?? fetch, sleep: options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      timeoutMs: options.timeoutMs ?? 30_000, retry: { ...DEFAULT_READ_RETRY, ...options.readRetry },
    }, {
      method: spec.method, url: `${apiHost(options)}${spec.trading ? TRADING_PATH : spec.path}${queryString(spec.query)}`,
      headers: { ...headers, ...spec.headers }, ...(body === undefined ? {} : { body }),
      ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    attempts += result.attempts;
    if (result.status === 401 && !fresh) continue;
    return { kind: 'HTTP', result: { ...result, attempts } };
  }
}

/** Шаг 50 (E-23): язык REST-вызовов — по первой витрине eBay аккаунта; витрина вне справочника — язык EBAY_DE */
function acceptLanguageOf(session: Session): string {
  const first = session.account.marketplaces.find((m) => marketplaceInfo(m));
  return first ? marketplaceInfo(first)!.acceptLanguage : EBAY_MARKETPLACES.EBAY_DE.acceptLanguage;
}
