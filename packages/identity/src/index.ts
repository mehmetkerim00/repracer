import type { MemberRole } from '@repracer/pricing-model';
import { TokenError, verifyToken, type VerifyOptions } from './oidc.ts';

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
  amr: string[];
}

export function createAuthenticator(options: Omit<VerifyOptions, 'jwks'> & { jwks: VerifyOptions['jwks']; directory: IdentityDirectory }) {
  return {
    /**
     * Заголовок `Authorization: Bearer <token>` → пользователь с членствами; null — нет токена, токен недействителен или
     * пользователь не сопоставлен. Ошибки поставщика ключей и базы не глотаются: запрос завершается ошибкой, а не анонимно.
     */
    async authenticate(authorization: string | undefined): Promise<Principal | null> {
      const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '');
      if (!m) return null;
      let token;
      try {
        token = await verifyToken(m[1]!, options);
      } catch (error) {
        if (error instanceof TokenError) return null;
        throw error;
      }
      const user = await options.directory.resolve({ issuer: token.issuer, subject: token.subject });
      return user ? { ...user, issuer: token.issuer, subject: token.subject, email: token.email, amr: token.amr } : null;
    },
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
