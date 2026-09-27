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
  now: () => number;
  /** Срок кода согласия; у Amazon — пять минут (website-authorization-workflow) */
  codeTtlMs?: number;
}

interface Grant { sellerId: string; code: string; issuedAt: number; used: boolean }

export class ModelOAuthProvider {
  readonly opts: ModelProviderOptions;
  readonly stats = { consents: 0, denials: 0, codeExchanges: 0, refreshes: 0, refused: 0, revocations: 0 };
  /** Все выданные токены — прогон ищет их потом там, где их быть не должно */
  readonly issuedTokens: string[] = [];
  private readonly grants = new Map<string, Grant>();
  private readonly refreshTokens = new Map<string, { sellerId: string; revoked: boolean }>();
  private platformBroken = false;

  constructor(opts: ModelProviderOptions) {
    this.opts = opts;
  }

  private token(kind: 'refresh' | 'access'): string {
    const body = randomBytes(24).toString('base64url');
    const t = this.opts.channel === 'AMAZON' ? `${kind === 'refresh' ? 'Atzr' : 'Atza'}|${body}` : `v^1.1#i^1#${kind}#${body}`;
    this.issuedTokens.push(t);
    return t;
  }

  /**
   * Продавец на странице согласия нажал «разрешить»: браузер уходит на наш адрес возврата с кодом. Адрес согласия
   * модель читает так же, как канал, — `state` берётся из него, а не передаётся отдельно.
   */
  approve(consentUrl: string, sellerId: string): string {
    this.stats.consents += 1;
    const state = new URL(consentUrl).searchParams.get('state') ?? '';
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

  /** Конечная точка токенов — транспорт `fetch` для клиента */
  readonly fetch: Fetch = async (_url, init) => {
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
      return this.reply(200, { access_token: this.token('access'), token_type: 'bearer', expires_in: 3600, refresh_token: refresh });
    }
    if (grantType === 'refresh_token') {
      this.stats.refreshes += 1;
      const known = this.refreshTokens.get(form.get('refresh_token') ?? '');
      if (!known || known.revoked) {
        this.stats.refused += 1;
        return this.reply(400, { error: 'invalid_grant', error_description: 'refresh token is invalid, expired or revoked' });
      }
      return this.reply(200, { access_token: this.token('access'), token_type: 'bearer', expires_in: 3600 });
    }
    this.stats.refused += 1;
    return this.reply(400, { error: 'unsupported_grant_type' });
  };
}
