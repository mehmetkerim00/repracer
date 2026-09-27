import type { MemberRole } from '@repracer/pricing-model';
import { TokenError, verifyToken, type VerifiedToken, type VerifyOptions } from './oidc.ts';

export * from './oidc.ts';

/**
 * Сопоставление внешнего пользователя с нашими членствами (Р-78). Пароли, сессии, MFA, сброс и приглашения — у поставщика
 * identity (ADR-0013). Запрос несёт токен поставщика; мы проверяем его подпись и сроки, находим пользователя по паре
 * (издатель, subject) и читаем его членства и роли из базы при каждом запросе — изменение роли действует сразу.
 */

export interface ExternalSubject {
  issuer: string;
  subject: string;
}

export interface MembershipRecord {
  tenantId: string;
  membershipId: string;
  role: MemberRole;
}

export interface ResolvedUser {
  userId: string;
  memberships: MembershipRecord[];
}

/** Справочник сопоставлений; в PostgreSQL — platform.external_identity и функция роли входа (0048) */
export interface IdentityDirectory {
  resolve(subject: ExternalSubject): Promise<ResolvedUser | null>;
}

/**
 * Вход со вторым фактором по утверждению amr токена (RFC 8176) [Р-88]: явный `mfa` или фактор владения/биометрии рядом
 * с паролем, либо ключ владения (passkey). Значения amr у ZITADEL — (проверить) на настоящем токене (OQ-141).
 */
export function hasSecondFactor(amr: readonly string[]): boolean {
  if (amr.includes('mfa')) return true;
  const possession = amr.some((v) => ['otp', 'sms', 'hwk', 'swk', 'fpt', 'face', 'iris'].includes(v));
  return possession && (amr.includes('pwd') || amr.includes('pin') || amr.includes('hwk') || amr.includes('user'));
}

export interface Principal extends ResolvedUser, ExternalSubject {
  email: string | null;
  emailVerified: boolean;
  amr: string[];
}

/**
 * Шаг 45 [OQ-238, снимок `vendor/zitadel/2026-09-27/claims.html`]: у ZITADEL в токене ДОСТУПА нет ни `amr`, ни `email`,
 * ни `email_verified` — матрица утверждений даёт `amr` только в ID-токене, а адрес — в userinfo и introspection. Поэтому:
 *   - второй фактор берётся из ID-токена, который страница передаёт рядом с токеном доступа; он проверяется так же
 *     (подпись, издатель, сроки), аудитория — клиент страницы, и `sub` обязан совпасть с токеном доступа;
 *   - адрес и его подтверждение для приёма приглашения — из userinfo по токену доступа.
 * Утверждения в самом токене доступа (стенд, прочие поставщики) по-прежнему принимаются: их выдаёт тот же поставщик.
 */
export interface AuthenticatorOptions extends Omit<VerifyOptions, 'jwks'> {
  jwks: VerifyOptions['jwks'];
  directory: IdentityDirectory;
  /** Аудитория ID-токена — клиент страницы; без неё ID-токен не принимается вовсе */
  idTokenAudience?: string;
  /** userinfo поставщика по токену доступа: адрес и его подтверждение */
  userinfo?: (accessToken: string) => Promise<{ email: string | null; emailVerified: boolean } | null>;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** ID-токен и токен доступа выпускает ОДИН ответ на обмен кода: их `iat` совпадают с точностью до этой разницы */
export const ID_TOKEN_IAT_SKEW_SECONDS = 10;

/**
 * Шаг 45 (находки 2 и 3 ревью): методы входа из ID-токена — одним правилом у консоли и у панели. ID-токен принимается,
 * только если он: подписан тем же поставщиком; выдан КЛИЕНТУ страницы (аудитория); того же субъекта; имеет форму
 * ID-токена; и выпущен тем же обменом кода, что токен доступа (`iat` в пределах {@link ID_TOKEN_IAT_SKEW_SECONDS}).
 * Последнее не даёт взять `amr` утреннего входа со вторым фактором к токену доступа позднего входа одним паролем:
 * `at_hash`, который привязал бы их точнее, снимок ZITADEL не называет. Иначе — «второго фактора нет», а не ошибка.
 */
export async function amrFromIdToken(idToken: string | undefined, access: VerifiedToken, options: VerifyOptions): Promise<string[]> {
  if (!idToken || !JWT.test(idToken)) return [];
  try {
    const id = await verifyToken(idToken, options);
    const sameExchange = id.issuedAt !== null && access.issuedAt !== null && Math.abs(id.issuedAt - access.issuedAt) <= ID_TOKEN_IAT_SKEW_SECONDS;
    return id.idTokenShaped && sameExchange && id.subject === access.subject && id.issuer === access.issuer ? id.amr : [];
  } catch (error) {
    if (error instanceof TokenError) return [];
    throw error;
  }
}

export function createAuthenticator(options: AuthenticatorOptions) {
  const verifyAccess = async (authorization: string | undefined) => {
    const m = BEARER.exec(authorization ?? '');
    if (!m) return null;
    try {
      const token = await verifyToken(m[1]!, options);
      // Находка 1 ревью шага 45: ID-токен — не пропуск. Его аудитория у ZITADEL включает проект, и без этой проверки
      // ID-токен, попавший в журнал, входил бы как токен доступа — со вторым фактором
      return token.idTokenShaped ? null : { raw: m[1]!, token };
    } catch (error) {
      if (error instanceof TokenError) return null;
      throw error;
    }
  };
  /** Методы входа: из ID-токена того же обмена кода, иначе — из самого токена доступа (стенд) */
  const amrOf = async (token: Awaited<ReturnType<typeof verifyToken>>, idToken: string | undefined): Promise<string[]> =>
    options.idTokenAudience ? [...new Set([...token.amr, ...await amrFromIdToken(idToken, token, { ...options, audience: options.idTokenAudience })])] : token.amr;
  return {
    /**
     * Заголовок `Authorization: Bearer <token>` → пользователь с членствами; null — нет токена, токен недействителен или
     * пользователь не сопоставлен. Ошибки поставщика ключей и базы не глотаются: запрос завершается ошибкой, а не анонимно.
     */
    async authenticate(authorization: string | undefined, idToken?: string): Promise<Principal | null> {
      const access = await verifyAccess(authorization);
      if (!access) return null;
      const { token } = access;
      const user = await options.directory.resolve({ issuer: token.issuer, subject: token.subject });
      return user ? { ...user, issuer: token.issuer, subject: token.subject, email: token.email, emailVerified: token.emailVerified, amr: await amrOf(token, idToken) } : null;
    },
    /**
     * Шаг 44 [Р-178]: проверенный токен БЕЗ сопоставления — только для приёма приглашения: новый владелец входит у
     * поставщика впервые, и пользователя у нас ещё нет. Адрес и его подтверждение — из userinfo, если в токене их нет.
     */
    async identify(authorization: string | undefined): Promise<Awaited<ReturnType<typeof verifyToken>> | null> {
      const access = await verifyAccess(authorization);
      if (!access) return null;
      if (access.token.email !== null || !options.userinfo) return access.token;
      const info = await options.userinfo(access.raw);
      return info ? { ...access.token, email: info.email, emailVerified: info.emailVerified } : access.token;
    },
  };
}

/**
 * Находка 10 ревью шага 45: недоступный поставщик — не «адрес не подтверждён». Сбой userinfo (сеть, тайм-аут, ответ не
 * 200) — ошибка {@link UserinfoUnavailable}, и продавец читает «поставщик входа не ответил», а не совет подтвердить адрес.
 */
export class UserinfoUnavailable extends Error {
  readonly code = 'USERINFO_UNAVAILABLE';
}
const USERINFO_TIMEOUT_MS = 5_000;

/** userinfo поставщика: адрес конечной точки — из документа обнаружения; ответ — только адрес и его подтверждение */
export function remoteUserinfo(issuer: string, doFetch: typeof fetch = fetch) {
  let endpoint: string | null = null;
  /**
   * Находки 16–17 ревью шага 46: 401/403 — не «поставщик недоступен», а «вход недействителен» (null: войдите снова);
   * тело разбирается ВНУТРИ защиты — обрыв по тайм-ауту или не-JSON — тоже «недоступен», а не 500.
   */
  const call = async (url: string, init?: RequestInit): Promise<Record<string, unknown> | null> => {
    try {
      const r = await doFetch(url, { ...init, signal: AbortSignal.timeout(USERINFO_TIMEOUT_MS) });
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) throw new UserinfoUnavailable(`userinfo: HTTP ${r.status}`);
      const body = await r.json() as unknown;
      if (!body || typeof body !== 'object') throw new UserinfoUnavailable('userinfo: not an object');
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UserinfoUnavailable) throw error;
      throw new UserinfoUnavailable(`userinfo: ${error instanceof Error ? error.name : 'failed'}`);
    }
  };
  return async (accessToken: string): Promise<{ email: string | null; emailVerified: boolean } | null> => {
    if (!endpoint) {
      const d = await call(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
      if (!d || typeof d.userinfo_endpoint !== 'string') return null;
      endpoint = d.userinfo_endpoint;
    }
    const u = await call(endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!u) return null;
    return { email: typeof u.email === 'string' ? u.email : null, emailVerified: u.email_verified === true };
  };
}

export type Authenticator = ReturnType<typeof createAuthenticator>;

/** Справочник в памяти — для стенда без базы и тестов */
export class MemoryIdentityDirectory implements IdentityDirectory {
  private readonly links = new Map<string, string>();
  private readonly rows: Array<MembershipRecord & { userId: string }> = [];

  link(subject: ExternalSubject, userId: string): void {
    const key = `${subject.issuer}\n${subject.subject}`;
    if (this.links.has(key)) throw new Error(`external identity ${subject.subject} is already linked`);
    this.links.set(key, userId);
  }

  addMembership(userId: string, membership: MembershipRecord): void {
    this.rows.push({ ...membership, userId });
  }

  setRole(userId: string, tenantId: string, role: MemberRole): void {
    const row = this.rows.find((r) => r.userId === userId && r.tenantId === tenantId);
    if (!row) throw new Error(`user ${userId} has no membership in ${tenantId}`);
    row.role = role;
  }

  async resolve(subject: ExternalSubject): Promise<ResolvedUser | null> {
    const userId = this.links.get(`${subject.issuer}\n${subject.subject}`);
    return userId ? { userId, memberships: this.rows.filter((r) => r.userId === userId).map(({ userId: _u, ...m }) => ({ ...m })) } : null;
  }
}
