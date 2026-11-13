import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createLocalIssuer } from '@repracer/identity/test-issuer';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startOperatorPanel, type RunningPanel } from '../server/operator-service.ts';

/**
 * Шаг 123 [Р-245]: почтового провайдера нет (OQ-224), а приглашение владельца пилота уходит только письмом — в сухом режиме ссылка терялась. Под флагом
 * `REPRACER_INVITE_LINK_REVEAL=on` панель отдаёт ссылку оператору ОДИН раз — в ответе действия «пригласить владельца»: токен не хранится нигде, кроме
 * отпечатка в базе, и показать его второй раз нечем. Только со вторым фактором и с событием аудита — показ записывает база той же транзакцией, что выдачу.
 * Без флага ответ прежний: ссылки нет, события показа нет.
 *
 * Прогон — как браузер [Р-142]: настоящий процесс панели (`startOperatorPanel`) по HTTP. Две панели на одной базе — с флагом и без. Данные синтетические.
 */
const ISSUER = 'https://identity.repracer.invalid';
const AUDIENCE = 'repracer-operator';
const BASE_URL = 'https://app.repracer.invalid/invitation';
const OPERATOR_ID = randomUUID();
const SUBJECT = `operator-${randomUUID()}`;

let db: IsolatedDatabase;
let revealing: RunningPanel;
let silent: RunningPanel;
let issuer: ReturnType<typeof createLocalIssuer>;
let token = '';

const panelEnv = (key: string, reveal?: string): Record<string, string> => ({
  REPRACER_MODE: 'stand', REPRACER_OPERATOR_PORT: '0', REPRACER_OPERATOR_METRICS_PORT: '0', REPRACER_OPERATOR_PG_URL: db.url('svc_operator'),
  REPRACER_OPERATOR_OIDC_ISSUER: ISSUER, REPRACER_OPERATOR_OIDC_AUDIENCE: AUDIENCE, REPRACER_OPERATOR_OIDC_JWKS_URL: `${ISSUER}/keys`,
  REPRACER_OPERATOR_OIDC_CLIENT_ID: 'operator-panel', REPRACER_OPERATOR_STAND_KEY: key, REPRACER_OPERATOR_INVITATION_URL: BASE_URL,
  REPRACER_OPERATOR_HEARTBEAT: 'off', ...(reveal ? { REPRACER_INVITE_LINK_REVEAL: reveal } : {}),
});

before(async () => {
  db = await createIsolatedDatabase('invitereveal');
  await db.superuser(
    `INSERT INTO platform.platform_operator (operator_id, tenant_id, issuer, subject, display_name, active)
     VALUES ($1, security.platform_tenant_id(), $2, $3, 'Operator im Prüflauf', true)`, [OPERATOR_ID, ISSUER, SUBJECT]);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  issuer = createLocalIssuer({ issuer: ISSUER, audience: AUDIENCE, privateKeyPem: key });
  // Почта — сухой режим, как в работе без провайдера: письмо собирается и не уходит, ссылка в журнал не попадает
  revealing = await startOperatorPanel(panelEnv(key, 'on'));
  silent = await startOperatorPanel(panelEnv(key));
  token = issuer.token(SUBJECT, { email: 'operator@repracer.invalid', amr: ['pwd', 'otp'] });
});
after(async () => {
  await revealing?.close();
  await silent?.close();
  await db?.drop();
});

async function call<T>(panel: RunningPanel, path: string, body: unknown, bearer = token): Promise<{ status: number; body: T; cache: string | null }> {
  const r = await fetch(`http://127.0.0.1:${panel.port}/api/operator/${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as T, cache: r.headers.get('cache-control') };
}
const pilot = async (panel: RunningPanel) => {
  const ownerEmail = `pilot-${randomUUID()}@example.test`;
  const created = await call<{ tenantId: string }>(panel, 'tenants', { name: `Pilot ${randomUUID().slice(0, 8)}`, region: 'EU', ownerEmail, locale: 'en' });
  assert.equal(created.status, 201);
  return { tenantId: created.body.tenantId, ownerEmail };
};
type Invited = { invitationId: string; dryRun: boolean; expiresAt: string; invitationUrl?: string; message?: string };
const revealed = (invitationId: string) => db.rows<{ n: number }>(
  `SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'operator.invitation_link_revealed' AND entity_id = $1 AND actor_user_id = $2`, [invitationId, OPERATOR_ID]);

test('step 123 [Р-245]: with the flag on, the operator gets the invitation link once — the link of the invitation the database issued, and the reveal is audited', async () => {
  const { tenantId, ownerEmail } = await pilot(revealing);
  const invited = await call<Invited>(revealing, `tenants/${tenantId}/invite`, { email: ownerEmail });
  assert.equal(invited.status, 201);
  assert.equal(invited.body.dryRun, true, 'no mail provider: the letter is built and goes nowhere');
  assert.equal(invited.cache, 'no-store', 'the answer with a sign-in link is not cached');
  const url = invited.body.invitationUrl ?? '';
  assert.ok(url.startsWith(`${BASE_URL}#`), `the link leads to the invitation page with the token in the fragment: ${url.slice(0, BASE_URL.length + 1)}…`);
  const [row] = await db.rows<{ token_sha256: Buffer }>('SELECT token_sha256 FROM platform.identity_invitation WHERE invitation_id = $1', [invited.body.invitationId]);
  assert.ok(row && Buffer.from(createHash('sha256').update(url.slice(BASE_URL.length + 1)).digest()).equals(row.token_sha256),
    'the token of the link is the one whose fingerprint the database keeps — the owner can accept it');
  assert.deepEqual((await revealed(invited.body.invitationId))[0], { n: 1 }, 'the reveal is an audit event of the operator');
});

test('step 123 [Р-245]: without the flag the answer is as before — no link, no reveal event', async () => {
  const { tenantId, ownerEmail } = await pilot(silent);
  const invited = await call<Invited>(silent, `tenants/${tenantId}/invite`, { email: ownerEmail });
  assert.equal(invited.status, 201);
  assert.equal('invitationUrl' in invited.body, false, 'the token of the invitation does not leave the panel');
  assert.deepEqual((await revealed(invited.body.invitationId))[0], { n: 0 });
});

test('step 123 [Р-245]: without a second factor nothing is issued and nothing is revealed — the database refuses', async () => {
  const { tenantId, ownerEmail } = await pilot(revealing);
  const single = issuer.token(SUBJECT, { email: 'operator@repracer.invalid', amr: ['pwd'] });
  const refused = await call<Invited>(revealing, `tenants/${tenantId}/invite`, { email: ownerEmail }, single);
  assert.equal(refused.status, 403);
  assert.match(refused.body.message ?? '', /needs a second factor/, 'the reason comes from the database guard [Р-94]');
  assert.equal('invitationUrl' in refused.body, false);
});

/** Показ держит база: только приглашение, выданное этой же транзакцией этим оператором, и только один раз — своей причиной отказа [Р-94] */
test('step 123 [Р-245]: the database keeps the reveal honest — in the issuing transaction only, once only', async () => {
  const { tenantId, ownerEmail } = await pilot(revealing);
  const operator = db.pool('svc_operator', 1);
  const outcome = (p: Promise<unknown>) => p.then(() => 'accepted', (e: unknown) => String(e instanceof Error ? e.message : e));
  const invite = (q: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }>) => q(
    "SELECT security.operator_invite_owner($1, $2, $3, $4, interval '1 day') AS id", [OPERATOR_ID, tenantId, ownerEmail, createHash('sha256').update(randomUUID()).digest()]);
  const reveal = 'SELECT security.operator_reveal_invitation_link($1, $2, $3)';
  const withMfa = async <T>(run: (q: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ id: string }> }>) => Promise<T>): Promise<T> => {
    const client = await operator.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.auth_mfa', 'on', true)");
      const value = await run((sql, params) => client.query(sql, params) as never);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
  const issued = await withMfa(async (q) => (await invite(q)).rows[0]!.id);
  assert.match(await outcome(withMfa((q) => q(reveal, [OPERATOR_ID, tenantId, issued]))), /only in the transaction that issued it/,
    'a reveal outside the issuing transaction is refused');
  assert.match(await outcome(withMfa(async (q) => {
    const id = (await invite(q)).rows[0]!.id;
    await q(reveal, [OPERATOR_ID, tenantId, id]);
    await q(reveal, [OPERATOR_ID, tenantId, id]);
  })), /already shown/, 'a second reveal is refused');
  assert.match(await outcome(withMfa(async (q) => {
    const id = (await invite(q)).rows[0]!.id;
    await q(reveal, [OPERATOR_ID, randomUUID(), id]);
  })), /only in the transaction that issued it/, 'a reveal named for another tenant is refused');
  assert.equal(await outcome(withMfa(async (q) => {
    const id = (await invite(q)).rows[0]!.id;
    await q(reveal, [OPERATOR_ID, tenantId, id]);
  })), 'accepted');
});
