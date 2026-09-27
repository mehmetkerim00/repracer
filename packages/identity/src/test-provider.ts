import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalIssuer } from './test-issuer.ts';

/**
 * Шаг 44 [Р-178, Р-179]: МОДЕЛЬ поставщика identity по HTTP — вход кодом авторизации с PKCE, как у ZITADEL (адреса
 * `/oauth/v2/authorize`, `/oauth/v2/token`, `/oauth/v2/keys` и документ обнаружения `/.well-known/openid-configuration`).
 * Прогон ходит к ней так же, как браузер ходит к настоящему поставщику: консоль и панель проверяют токены по её ключам,
 * полученным по сети, — подмены проверки нет.
 *
 * Строже настоящего там, где это дёшево: код одноразовый и живёт минуту, `redirect_uri` и `client_id` сверяются, PKCE
 * обязателен (S256). «Кто вошёл» задаёт прогон — это страница входа поставщика, которую человек проходит у него, а не у нас.
 * Данные синтетические.
 */

export interface ModelUser {
  subject: string;
  email: string;
  /** Методы входа (RFC 8176): `['pwd', 'otp']` — пароль и второй фактор */
  amr: string[];
}

interface Grant { user: ModelUser; clientId: string; redirectUri: string; challenge: string; audience: string; issuedAt: number; used: boolean }

export interface ModelIdentityProvider {
  /** Имя издателя в токенах (https, как у настоящего поставщика: база принимает только https-издателей) */
  issuer: string;
  /** Где модель слушает на самом деле */
  origin: string;
  /** Транспорт «браузера» прогона: имя издателя разрешается в адрес модели — как DNS, остальное — обычный fetch */
  fetch: typeof fetch;
  jwksUrl: string;
  /** Кто вошёл на странице поставщика в «браузере» прогона */
  signInAs(user: ModelUser | null): void;
  stats: { authorizations: number; tokens: number; refused: number };
  close(): Promise<void>;
}

export async function startModelIdentityProvider(options: {
  /** Клиенты (приложения) у поставщика: идентификатор → разрешённые адреса возврата и аудитория токена */
  clients: Record<string, { redirectUris: string[]; audience: string }>;
  issuer?: string;
}): Promise<ModelIdentityProvider> {
  let origin = '';
  let issuerName = '';
  let current: ModelUser | null = null;
  const grants = new Map<string, Grant>();
  const stats = { authorizations: 0, tokens: 0, refused: 0 };
  const issuers = new Map<string, ReturnType<typeof createLocalIssuer>>();
  const issuerFor = (audience: string) => {
    let i = issuers.get(audience);
    if (!i) {
      // Один ключ на поставщика: издатели по аудитории делят его, иначе ключей в наборе было бы несколько
      i = createLocalIssuer({ issuer: issuerName, audience, privateKeyPem: shared });
      issuers.set(audience, i);
    }
    return i;
  };
  let shared = '';
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', origin);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST' });
      res.end();
      return;
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      json(200, { issuer: issuerName, authorization_endpoint: `${origin}/oauth/v2/authorize`, token_endpoint: `${origin}/oauth/v2/token`,
        jwks_uri: `${origin}/oauth/v2/keys`, code_challenge_methods_supported: ['S256'], response_types_supported: ['code'] });
      return;
    }
    if (url.pathname === '/oauth/v2/keys') {
      json(200, { keys: issuerFor(Object.values(options.clients)[0]!.audience).jwks });
      return;
    }
    if (url.pathname === '/oauth/v2/authorize') {
      const p = url.searchParams;
      const client = options.clients[p.get('client_id') ?? ''];
      const redirectUri = p.get('redirect_uri') ?? '';
      if (!client || !client.redirectUris.includes(redirectUri) || p.get('response_type') !== 'code'
          || p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge') || !current) {
        stats.refused += 1;
        json(400, { error: 'invalid_request' });
        return;
      }
      stats.authorizations += 1;
      const code = randomBytes(16).toString('base64url');
      grants.set(code, { user: current, clientId: p.get('client_id')!, redirectUri, challenge: p.get('code_challenge')!, audience: client.audience, issuedAt: Date.now(), used: false });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      if (p.get('state')) back.searchParams.set('state', p.get('state')!);
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === '/oauth/v2/token' && req.method === 'POST') {
      const form = new URLSearchParams(await body(req));
      const g = grants.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (form.get('grant_type') !== 'authorization_code' || !g || g.used || Date.now() - g.issuedAt > 60_000 || g.clientId !== form.get('client_id')
          || g.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== g.challenge) {
        stats.refused += 1;
        json(400, { error: 'invalid_grant' });
        return;
      }
      g.used = true;
      stats.tokens += 1;
      const accessToken = issuerFor(g.audience).token(g.user.subject, { email: g.user.email, amr: g.user.amr, expiresInSeconds: 3600, extra: { email_verified: true } });
      json(200, { access_token: accessToken, token_type: 'Bearer', expires_in: 3600 });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  issuerName = options.issuer ?? origin;
  // Общий ключ издателей по аудитории — из первого ключа
  const { generateKeyPairSync } = await import('node:crypto');
  shared = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  issuers.clear();
  for (const c of Object.values(options.clients)) issuers.set(c.audience, createLocalIssuer({ issuer: issuerName, audience: c.audience, privateKeyPem: shared }));
  const resolve = (input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return u.startsWith(issuerName) ? origin + u.slice(issuerName.length) : u;
  };
  return {
    issuer: issuerName,
    origin,
    fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(resolve(input), init)) as typeof fetch,
    jwksUrl: `${origin}/oauth/v2/keys`,
    signInAs(user) { current = user; },
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
