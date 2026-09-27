import { beginLogin, finishLogin, type OidcClientConfig, type PendingLogin } from './oidc.ts';

/**
 * Шаг 44 [Р-178, Р-179]: вход продавца у поставщика и ссылка приглашения — со стороны страницы. Адреса `/auth/callback`
 * (возврат от поставщика) и `/invite#<токен>` (ссылка из письма) запоминаются в хранилище вкладки ДО входа и сразу
 * стираются из адреса: одноразовый код и токен приглашения в истории браузера не живут.
 */

const PENDING_LOGIN = 'repracer.login.pending';
const PENDING_RETURN = 'repracer.login.return';
const PENDING_INVITE = 'repracer.invite';

const storage = (): Storage | null => {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
};

export function captureLoginReturns(): void {
  if (typeof window === 'undefined') return;
  const s = storage();
  if (window.location.pathname === '/auth/callback') {
    s?.setItem(PENDING_RETURN, JSON.stringify(Object.fromEntries(new URLSearchParams(window.location.search))));
    window.history.replaceState(null, '', '/');
  } else if (window.location.pathname === '/invite') {
    const token = window.location.hash.replace(/^#/, '');
    if (token) s?.setItem(PENDING_INVITE, token);
    window.history.replaceState(null, '', '/');
  }
}

export async function startLogin(cfg: OidcClientConfig): Promise<void> {
  const { url, pending } = await beginLogin(cfg, `${window.location.origin}/auth/callback`);
  storage()?.setItem(PENDING_LOGIN, JSON.stringify(pending));
  window.location.assign(url);
}

/** Возврат от поставщика, если он есть: токен доступа или null */
export async function completeLogin(cfg: OidcClientConfig | null): Promise<{ accessToken: string; idToken: string | null } | null> {
  const s = storage();
  const back = s?.getItem(PENDING_RETURN);
  const pending = s?.getItem(PENDING_LOGIN);
  if (!back || !pending || !cfg) return null;
  s?.removeItem(PENDING_RETURN);
  s?.removeItem(PENDING_LOGIN);
  return finishLogin(cfg, JSON.parse(back) as { code?: string; state?: string; error?: string }, JSON.parse(pending) as PendingLogin);
}

export function pendingInvitation(): string | null {
  return storage()?.getItem(PENDING_INVITE) ?? null;
}

export function forgetInvitation(): void {
  storage()?.removeItem(PENDING_INVITE);
}
