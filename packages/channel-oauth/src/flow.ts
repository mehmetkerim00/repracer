import type { Fetch, OAuthProvider } from './providers.ts';

/**
 * Р-175, Р-177 (шаг 43): обмен кода и refresh-токена и КЛАССИФИКАЦИЯ отказа.
 *
 * Классы отказа — то, что решает судьбу аккаунта, и ошибиться здесь дорого в обе стороны:
 *   REVOKED   — `invalid_grant`: «код или токен недействителен, истёк, ОТОЗВАН» (LWA, authorization-code-grant). Нужна
 *               новая авторизация продавцом; аккаунт переходит в понятное состояние с письмом владельцу. Что именно
 *               отвечает обмен refresh-токена после отзыва, документация прямо не говорит (A-17, E-09) — консервативно
 *               любой `invalid_grant` значит «авторизации больше нет»;
 *   PLATFORM  — `invalid_client`, `unauthorized_client`, `unsupported_grant_type`: сломаны НАШИ ключи приложения. Продавец
 *               не виноват, и объявлять ему «вы отозвали доступ» было бы ложью — алерт уходит оператору платформы;
 *   TRANSIENT — сеть, 5xx, `ServerError`, неизвестный ответ: повтор; аккаунт не трогается, после трёх подряд — WARNING.
 *
 * Неизвестный 4xx — TRANSIENT, а не REVOKED: объявить отзыв по ответу, которого мы не понимаем, значит остановить
 * продавцу канал из-за нашей неосведомлённости.
 */

/** Срок одного обмена токена: дольше — это сеть, а не ответ канала (класс TRANSIENT) */
export const TOKEN_TIMEOUT_MS = 15_000;

export type TokenFailure = 'REVOKED' | 'PLATFORM' | 'TRANSIENT';

export type TokenResult =
  | { ok: true; accessToken: string; expiresIn: number; refreshToken: string | null; refreshExpiresIn: number | null }
  | { ok: false; failure: TokenFailure; code: string };

const REVOKED_CODES = new Set(['invalid_grant']);
const PLATFORM_CODES = new Set(['invalid_client', 'unauthorized_client', 'unsupported_grant_type']);

export function classifyTokenError(status: number, error: string | null): TokenFailure {
  if (error && REVOKED_CODES.has(error)) return 'REVOKED';
  if (error && PLATFORM_CODES.has(error)) return 'PLATFORM';
  if (status === 401) return 'PLATFORM';
  return 'TRANSIENT';
}

/**
 * Код ошибки для журнала и базы — только код, без текста ответа: описание ошибки канала может повторять присланный
 * нами параметр, а среди них — токен.
 */
const safeCode = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z_]{1,64}$/.test(value) ? value : null);

export async function requestToken(provider: OAuthProvider, grant: Parameters<OAuthProvider['tokenRequest']>[0], http: Fetch): Promise<TokenResult> {
  const req = provider.tokenRequest(grant);
  let status: number;
  let text: string;
  try {
    // Находка 16 ревью шага 43: обмен без срока держал бы аренду работы проверки до её конца
    const res = await http(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    status = res.status;
    text = await res.text();
  } catch {
    return { ok: false, failure: 'TRANSIENT', code: 'NETWORK' };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, failure: status >= 500 ? 'TRANSIENT' : 'TRANSIENT', code: `HTTP_${status}` };
  }
  if (status >= 200 && status < 300 && typeof body.access_token === 'string') {
    return {
      ok: true,
      accessToken: body.access_token,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      // eBay: срок refresh-токена, если приходит (E-10); у Amazon в ответе его нет — «авторизовать заново раз в год»
      refreshExpiresIn: typeof body.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : null,
    };
  }
  const code = safeCode(body.error) ?? `HTTP_${status}`;
  return { ok: false, failure: classifyTokenError(status, safeCode(body.error)), code };
}

/** Обмен кода согласия: без refresh-токена в ответе подключение не состоялось — хранить нечего */
export async function exchangeCode(provider: OAuthProvider, code: string, http: Fetch): Promise<TokenResult> {
  const r = await requestToken(provider, { kind: 'CODE', code }, http);
  if (r.ok && r.refreshToken === null) return { ok: false, failure: 'PLATFORM', code: 'NO_REFRESH_TOKEN' };
  return r;
}

export const refreshAccess = (provider: OAuthProvider, refreshToken: string, http: Fetch): Promise<TokenResult> =>
  requestToken(provider, { kind: 'REFRESH', refreshToken }, http);
