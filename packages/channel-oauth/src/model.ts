import { randomBytes } from 'node:crypto';
import type { Fetch } from './providers.ts';

/**
 * Р-175 (шаг 43): МОДЕЛЬ поставщика OAuth для прогонов — страница согласия, обмен кода, refresh и отзыв продавцом. Она
 * ведёт себя так, как говорят снимки первоисточников (vendor/amazon/lwa-authorization, vendor/ebay/oauth-client), и
 * строже там, где они молчат: код одноразовый и живёт пять минут (Amazon), `redirect_uri` обмена обязан совпасть с
 * зарегистрированным, ключи приложения сверяются, отозванный refresh-токен отвечает `invalid_grant` (допущение A-17/E-09).
 *
 * Токены правдоподобны по форме (`Atzr|…`, `Atza|…` — пример документации Amazon), и это важно: по ним прогон ищет
 * утечку токена в журналах, ответах консоли, письмах и в самой базе. Данные синтетические.
 */

export interface ModelProviderOptions {
  channel: 'AMAZON' | 'EBAY';
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * Шаг 125 (П6): log-in URI приложения Amazon — адрес, на который Amazon отправляет продавца после согласия (шаг 5 потока с сайта,
   * website-authorization-workflow, снимок vendor/amazon/lwa-authorization/2026-11-14). У Amazon обязателен: потока без него в документации нет
   */
  loginUri?: string;
  now: () => number;
  /** Срок кода согласия; у Amazon — пять минут (website-authorization-workflow) */
  codeTtlMs?: number;
}

interface Grant { sellerId: string; code: string; issuedAt: number; used: boolean }

/** Шаг 125 (П6): что Amazon помнит между согласием (шаг 4) и возвратом приложения на `amazon_callback_uri` (шаг 8) */
interface LoginVisit { sellerId: string; applicationId: string; draft: boolean; issuedAt: number; used: boolean }

/** Весь поток с сайта дольше десяти минут «may break» (website-authorization-workflow) — модель обрывает его ровно так */
const AMAZON_FLOW_MS = 10 * 60_000;

export class ModelOAuthProvider {
  readonly opts: ModelProviderOptions;
  readonly stats = { consents: 0, denials: 0, codeExchanges: 0, refreshes: 0, refused: 0, revocations: 0, identities: 0 };
  /** Все выданные токены — прогон ищет их потом там, где их быть не должно */
  readonly issuedTokens: string[] = [];
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, { sellerId: string; revoked: boolean }>();
  /** Шаг 47 (E-11): токен доступа → продавец — его называет Commerce Identity API модели eBay */
  private readonly accessTokens = new Map<string, string>();
  /** Шаг 125 (П6): `amazon_state` → визит на log-in URI, который ждёт возврата приложения */
  private readonly loginVisits = new Map<string, LoginVisit>();
  private platformBroken = false;

  constructor(opts: ModelProviderOptions) {
    if (opts.channel === 'AMAZON' && !opts.loginUri) throw new Error('MODEL_AMAZON_LOGIN_URI_REQUIRED');
    this.opts = opts;
  }

  private token(kind: 'refresh' | 'access'): string {
    const body = randomBytes(24).toString('base64url');
    const t = this.opts.channel === 'AMAZON' ? `${kind === 'refresh' ? 'Atzr' : 'Atza'}|${body}` : `v^1.1#i^1#${kind}#${body}`;
    this.issuedTokens.push(t);
    return t;
  }

  /**
   * Продавец на странице согласия нажал «разрешить». Адрес согласия модель читает так же, как канал, — `state` и `application_id`
   * берутся из него, а не передаются отдельно.
   *
   * eBay: браузер уходит на наш адрес возврата с кодом. Amazon (шаг 125, П6 — website-authorization-workflow, шаги 5–8): кода ещё нет —
   * Amazon отправляет продавца на log-in URI приложения с `amazon_callback_uri`, `amazon_state`, `selling_partner_id` и, у черновика
   * (`version=beta` в адресе согласия), `version=beta`. Код Amazon выдаёт только после возврата приложения на `amazon_callback_uri`
   * ({@link confirm}). До шага 125 модель отдавала код сразу — того шага в потоке подключения не было, и модель его тоже не делала.
   */
  approve(consentUrl: string, sellerId: string): string {
    this.stats.consents += 1;
    const consent = new URL(consentUrl);
    const state = consent.searchParams.get('state') ?? '';
    if (this.opts.channel === 'AMAZON') {
      const applicationId = consent.searchParams.get('application_id') ?? '';
      const draft = consent.searchParams.get('version') === 'beta';
      const amazonState = randomBytes(12).toString('base64url');
      this.loginVisits.set(amazonState, { sellerId, applicationId, draft, issuedAt: this.opts.now(), used: false });
      // Callback URI — на том же Seller Central, где продавец дал согласие; путь — как в примерах страницы: /apps/authorize/confirm/<application_id>
      const login = new URL(this.opts.loginUri!);
      login.searchParams.set('amazon_callback_uri', `${consent.origin}/apps/authorize/confirm/${applicationId}`);
      login.searchParams.set('amazon_state', amazonState);
      login.searchParams.set('selling_partner_id', sellerId);
      if (draft) login.searchParams.set('version', 'beta');
      return login.toString();
    }
    return this.grant(state, sellerId);
  }

  private grant(state: string, sellerId: string): string {
    const code = randomBytes(16).toString('base64url');
    this.grants.set(code, { sellerId, code, issuedAt: this.opts.now(), used: false });
    const back = new URL(this.opts.redirectUri);
    back.searchParams.set('state', state);
    if (this.opts.channel === 'AMAZON') {
      back.searchParams.set('selling_partner_id', sellerId);
      back.searchParams.set('spapi_oauth_code', code);
    } else {
      back.searchParams.set('code', code);
    }
    return back.toString();
  }

  /**
   * Шаг 125 (П6): приложение вернуло продавца на `amazon_callback_uri` (шаг 8) — Amazon показывает подтверждение и отправляет его на
   * redirect URI с `state`, `selling_partner_id` и `spapi_oauth_code` (шаги 9–10). Модель строже страницы там, где та молчит: путь
   * и `application_id` — те, что Amazon выдал на log-in URI, `amazon_state` — свой, одноразовый и не старше десяти минут, `version`
   * — тот же, что у согласия, `redirect_uri` — зарегистрированный (без него — первый зарегистрированный), `state` — обязателен.
   * Отказ — исключение с причиной: настоящий Amazon показал бы продавцу страницу ошибки, и до redirect URI браузер не дошёл бы.
   */
  confirm(callbackUrl: string): string {
    const url = new URL(callbackUrl);
    const refuse = (why: string): never => { throw new Error(`AMAZON_CONFIRM_REFUSED: ${why}`); };
    if (this.opts.channel !== 'AMAZON') refuse('NOT_AMAZON');
    const amazonState = url.searchParams.get('amazon_state') ?? '';
    const visit = this.loginVisits.get(amazonState);
    if (!visit || visit.used) refuse('AMAZON_STATE');
    if (this.opts.now() - visit!.issuedAt > AMAZON_FLOW_MS) refuse('FLOW_EXPIRED');
    if (url.protocol !== 'https:' || url.pathname !== `/apps/authorize/confirm/${visit!.applicationId}`) refuse('CALLBACK_PATH');
    if ((url.searchParams.get('version') === 'beta') !== visit!.draft) refuse('VERSION');
    const redirect = url.searchParams.get('redirect_uri');
    if (redirect !== null && redirect !== this.opts.redirectUri) refuse('REDIRECT_URI_NOT_REGISTERED');
    const state = url.searchParams.get('state') ?? '';
    if (state === '') refuse('STATE');
    visit!.used = true;
    return this.grant(state, visit!.sellerId);
  }

  /** Продавец отказал на странице согласия */
  deny(consentUrl: string): string {
    this.stats.denials += 1;
    const back = new URL(this.opts.redirectUri);
    back.searchParams.set('state', new URL(consentUrl).searchParams.get('state') ?? '');
    back.searchParams.set('error', 'access_denied');
    return back.toString();
  }

  /** Продавец отозвал авторизацию в кабинете канала (Amazon: Manage Your Apps → Disable authorization) */
  revoke(sellerId: string): void {
    this.stats.revocations += 1;
    for (const t of this.refreshTokens.values()) if (t.sellerId === sellerId) t.revoked = true;
  }

  /** Ключи НАШЕГО приложения испорчены — так проверяется класс PLATFORM */
  breakPlatformCredentials(broken = true): void {
    this.platformBroken = broken;
  }

  private reply(status: number, body: unknown) {
    return { status, text: async () => JSON.stringify(body) };
  }

  /** Токен доступа продавца; у eBay ответ несёт срок refresh-токена полем refresh_token_expires_in [песочница, E-10] */
  private access(sellerId: string): string {
    const t = this.token('access');
    this.accessTokens.set(t, sellerId);
    return t;
  }

  /** Конечная точка токенов (и у eBay — Commerce Identity API) — транспорт `fetch` для клиента */
  readonly fetch: Fetch = async (url, init) => {
    // Шаг 47, E-11 [песочница]: `GET https://apiz…/commerce/identity/v1/user/` токеном продавца — userId
    if (this.opts.channel === 'EBAY' && /\/commerce\/identity\/v1\/user\/?$/.test(new URL(url, 'http://model.invalid').pathname)) {
      const bearer = (init.headers.authorization ?? init.headers.Authorization ?? '').replace(/^Bearer /, '');
      const sellerId = this.accessTokens.get(bearer);
      if (!sellerId) return this.reply(401, { errors: [{ errorId: 1001, message: 'Invalid access token' }] });
      this.stats.identities += 1;
      return this.reply(200, { userId: sellerId, username: `syn_${sellerId.slice(0, 12)}`, accountType: 'INDIVIDUAL', registrationMarketplaceId: 'EBAY_DE' });
    }
    const form = new URLSearchParams(init.body);
    // Ключи приложения: у Amazon — в форме, у eBay — Basic (src/request.js)
    const basic = init.headers.authorization ?? init.headers.Authorization;
    const [clientId, clientSecret] = basic
      ? Buffer.from(basic.replace(/^Basic /, ''), 'base64').toString('utf8').split(':')
      : [form.get('client_id'), form.get('client_secret')];
    if (this.platformBroken || clientId !== this.opts.clientId || clientSecret !== this.opts.clientSecret) {
      this.stats.refused += 1;
      return this.reply(401, { error: 'invalid_client', error_description: 'client authentication failed' });
    }
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      this.stats.codeExchanges += 1;
      const grant = this.grants.get(form.get('code') ?? '');
      const ttl = this.opts.codeTtlMs ?? 5 * 60_000;
      if (!grant || grant.used || this.opts.now() - grant.issuedAt > ttl || form.get('redirect_uri') !== this.opts.redirectUri) {
        this.stats.refused += 1;
        return this.reply(400, { error: 'invalid_grant', error_description: 'authorization code is invalid or expired' });
      }
      grant.used = true;
      const refresh = this.token('refresh');
      this.refreshTokens.set(refresh, { sellerId: grant.sellerId, revoked: false });
      return this.reply(200, this.opts.channel === 'EBAY'
        ? { access_token: this.access(grant.sellerId), expires_in: 7200, refresh_token: refresh, refresh_token_expires_in: 47_304_000, token_type: 'User Access Token' }
        : { access_token: this.access(grant.sellerId), token_type: 'bearer', expires_in: 3600, refresh_token: refresh });
    }
    if (grantType === 'refresh_token') {
      this.stats.refreshes += 1;
      const known = this.refreshTokens.get(form.get('refresh_token') ?? '');
      if (!known || known.revoked) {
        this.stats.refused += 1;
        return this.reply(400, { error: 'invalid_grant', error_description: 'refresh token is invalid, expired or revoked' });
      }
      // eBay: обновление нового refresh-токена не выдаёт [песочница]. Amazon (шаг 70, песочница SP-API): LWA возвращает тот же
      // refresh-токен без изменений — два обмена подряд, прежний работает и после них (docs/evidence/step70-amazon-sandbox.md)
      return this.reply(200, this.opts.channel === 'EBAY'
        ? { access_token: this.access(known.sellerId), expires_in: 7200, token_type: 'User Access Token' }
        : { access_token: this.access(known.sellerId), refresh_token: form.get('refresh_token'), token_type: 'bearer', expires_in: 3600 });
    }
    this.stats.refused += 1;
    return this.reply(400, { error: 'unsupported_grant_type' });
  };
}
