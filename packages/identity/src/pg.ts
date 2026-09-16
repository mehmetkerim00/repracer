import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { MemberRole } from '@repracer/pricing-model';
import type { ExternalSubject, IdentityDirectory, ResolvedUser } from './index.ts';

/**
 * Сопоставление внешнего пользователя на PostgreSQL. Чтение — функцией SECURITY DEFINER роли входа
 * (security.resolve_external_identity, 0048), роли — из tenant_data.membership. Привязка (издатель, subject) → пользователь
 * создаётся ТОЛЬКО приёмом приглашения [Р-88, 0053]: у приложения нет вставки в platform.external_identity.
 * Р-90 (0058): пул — роли входа repracer_authenticator; у роли пути решения этих функций нет.
 */

const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** Одноразовый токен приглашения: в письмо — сам токен, в базу — только SHA-256 */
export function newInvitationToken(): { token: string; sha256: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, sha256: hashToken(token) };
}

export class PgIdentityDirectory implements IdentityDirectory {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async resolve(subject: ExternalSubject): Promise<ResolvedUser | null> {
    const { rows } = await this.pool.query(
      'SELECT user_id, tenant_id, membership_id, role FROM security.resolve_external_identity($1, $2) ORDER BY tenant_id', [subject.issuer, subject.subject]);
    if (rows.length === 0) return null;
    return {
      userId: rows[0].user_id,
      memberships: rows.filter((r) => r.tenant_id !== null).map((r) => ({ tenantId: r.tenant_id, membershipId: r.membership_id, role: r.role as MemberRole })),
    };
  }

  /**
   * Приём приглашения: subject, email и email_verified — из ПРОВЕРЕННОГО токена поставщика; email подтверждён поставщиком и
   * совпадает с адресом приглашения (находка 11). Вход, уже привязанный к пользователю, принимает приглашение в другой тенант
   * (находка 10, Р-9). Возвращает пользователя; членство приглашения становится действующим.
   */
  async acceptInvitation(token: string, subject: ExternalSubject, email: string | null, emailVerified: boolean): Promise<string> {
    const { rows: [row] } = await this.pool.query('SELECT security.accept_identity_invitation($1, $2, $3, $4, $5) AS user_id',
      [hashToken(token), subject.issuer, subject.subject, email, emailVerified]);
    return row.user_id;
  }
}

/**
 * Регистрация владельца нового тенанта — роль онбординга платформы (repracer_onboarding), не приложение.
 * Письмо с токеном отправляет поставщик identity (ADR-0013); здесь — только запись приглашения.
 */
export async function issueSignupInvitation(onboardingPool: pg.Pool, email: string, ttlSeconds = 7 * 86_400): Promise<{ invitationId: string; token: string }> {
  const { token, sha256 } = newInvitationToken();
  const { rows: [row] } = await onboardingPool.query('SELECT security.issue_signup_invitation($1, $2, make_interval(secs => $3)) AS id', [email, sha256, ttlSeconds]);
  return { invitationId: row.id, token };
}

/**
 * Р-98: перепривязка входа участника — только приглашением владельца тенанта со вторым фактором (транзакция пула администратора
 * в сессии владельца). Приём приглашения новым входом того же поставщика отзывает прежнюю привязку; автоматической перепривязки нет.
 */
export async function inviteRelink(
  tx: { query: pg.Pool['query'] }, input: { tenantId: string; userId: string; ttlSeconds?: number },
): Promise<{ invitationId: string; token: string }> {
  const { token, sha256 } = newInvitationToken();
  const { rows: [row] } = await tx.query('SELECT security.invite_relink($1, $2, $3, make_interval(secs => $4)) AS id',
    [input.tenantId, input.userId, sha256, input.ttlSeconds ?? 7 * 86_400]);
  return { invitationId: row.id, token };
}

/** Приглашение участника тенанта — в сессии владельца или администратора со вторым фактором; транзакция пула административного сервиса (Р-90) */
export async function inviteMember(
  tx: { query: pg.Pool['query'] }, input: { tenantId: string; email: string; role: MemberRole; ttlSeconds?: number },
): Promise<{ invitationId: string; userId: string; membershipId: string; token: string }> {
  const { token, sha256 } = newInvitationToken();
  const { rows: [row] } = await tx.query('SELECT * FROM security.invite_member($1, $2, $3, $4, make_interval(secs => $5))',
    [input.tenantId, input.email, input.role, sha256, input.ttlSeconds ?? 7 * 86_400]);
  return { invitationId: row.invitation_id, userId: row.user_id, membershipId: row.membership_id, token };
}
