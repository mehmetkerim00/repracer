/**
 * Шаг 44 [Р-178]: вход продавца у поставщика identity — код авторизации с PKCE (S256), публичный клиент без секрета.
 * Один модуль для страницы и для живого прогона [Р-142]: прогон ходит к поставщику ТЕМ ЖЕ кодом, что браузер, и не
 * может послать то, чего страница не послала бы. Токен живёт в памяти вкладки; в хранилище вкладки — только одноразовые
 * `state` и `code_verifier` на время ухода к поставщику.
 */

export interface OidcClientConfig {
  issuer: string;
  clientId: string;
  scope: string;
}

export interface PendingLogin {
  state: string;
  verifier: string;
  redirectUri: string;
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function discovery(issuer: string, http: Fetch): Promise<{ authorization_endpoint: string; token_endpoint: string }> {
  const r = await http(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC_DISCOVERY_${r.status}`);
  const d = await r.json() as { authorization_endpoint?: string; token_endpoint?: string };
  if (!d.authorization_endpoint || !d.token_endpoint) throw new Error('OIDC_DISCOVERY_INCOMPLETE');
  return { authorization_endpoint: d.authorization_endpoint, token_endpoint: d.token_endpoint };
}

/** Адрес страницы входа поставщика и то, что нужно запомнить до возврата */
export async function beginLogin(cfg: OidcClientConfig, redirectUri: string, http: Fetch = fetch as unknown as Fetch): Promise<{ url: string; pending: PendingLogin }> {
  const d = await discovery(cfg.issuer, http);
  const verifier = random(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = random(16);
  const url = new URL(d.authorization_endpoint);
  for (const [k, v] of Object.entries({ client_id: cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: cfg.scope, state, code_challenge: challenge, code_challenge_method: 'S256' })) {
    url.searchParams.set(k, v);
  }
  return { url: url.toString(), pending: { state, verifier, redirectUri } };
}

/** Возврат от поставщика: `state` сверяется с запомненным, код меняется на токен доступа */
export async function finishLogin(cfg: OidcClientConfig, params: { code?: string | null; state?: string | null }, pending: PendingLogin, http: Fetch = fetch as unknown as Fetch): Promise<string> {
  if (!params.code || !params.state || params.state !== pending.state) throw new Error('OIDC_STATE_MISMATCH');
  const d = await discovery(cfg.issuer, http);
  const r = await http(d.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: params.code, redirect_uri: pending.redirectUri, client_id: cfg.clientId, code_verifier: pending.verifier }).toString(),
  });
  if (!r.ok) throw new Error(`OIDC_TOKEN_${r.status}`);
  const t = await r.json() as { access_token?: string };
  if (!t.access_token) throw new Error('OIDC_NO_ACCESS_TOKEN');
  return t.access_token;
}
