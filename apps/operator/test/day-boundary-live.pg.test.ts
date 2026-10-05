import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { createLocalIssuer } from '@repracer/identity/test-issuer';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { PgShadowStore } from '@repracer/pricing-store-pg';
import { pgStandJoinMember, pgStandUsers, STAND_EMAILS } from '@repracer/contract-tests/stand';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startDemoWorld, type RunningDemoWorld } from '../../console/server/demo-world.ts';
import { startOperatorPanel, type RunningPanel } from '../server/operator-service.ts';

/**
 * Шаг 69 [Р-204]: процедура границы суток витрины — живым прогоном панели оператора по HTTP, как браузер [Р-136, Р-142].
 *
 * Клиентский тенант (не демо: демо доказательством не бывает, Р-151) с аккаунтами eBay EBAY_US и Amazon amazon.com в тени; неделя
 * тени прожата моделью США шага 68 (решения ложатся в прошлые сутки). Утверждается:
 *   1) панель показывает витрины с неподтверждённой границей и доказательство тени, которое считает база, — и худшее окно равно
 *      счёту по строкам удержанных записей, сделанному прогоном независимо;
 *   2) без второго фактора, с короткой заметкой и с аккаунтом чужой витрины действие отказано базой своей причиной;
 *   3) принятое худшее окно — строка журнала, событие аудита оператора, витрина CONSERVATIVE, и владелец переводит аккаунт в бой;
 *   4) второй раз ту же витрину принять нельзя: она больше не кандидат.
 */

const OPERATOR_ISSUER = 'https://identity.repracer.invalid';
const OPERATOR_AUDIENCE = 'repracer-operator';
const OPERATOR_ID = randomUUID();
const OPERATOR_SUBJECT = `operator-${randomUUID()}`;
/** Неделя тени и ещё сутки: критерий процедуры — не меньше семи суток с решениями */
const PRESS_DAYS = 8;
const EBAY_US = 'EBAY_US';
const AMAZON_US = 'ATVPDKIKX0DER';
const DAY_MS = 86_400_000;

let db: IsolatedDatabase;
let world: RunningDemoWorld | null = null;
let panel: RunningPanel;
let origin = '';
let issuer: ReturnType<typeof createLocalIssuer>;
let tenantId = '';
let ebayAccount = '';
let amazonAccount = '';

interface Candidate {
  channel: string; marketplace: string; status: string; question: string | null; tenant_id: string; tenant_name: string;
  channel_account_id: string; shadow_days: number; longest_gap_hours: number; shadow_since: string; decisions: string; held_writes: string; budget_writes: string;
  worst_window_max: string; budget_limit: number | null;
}
interface Acceptance { acceptance_id: string; channel: string; marketplace: string; time_zone: string; shadow_days: number; decisions: string; worst_window_max: string; budget_limit: number | null; operator: string; note: string }

async function call<T>(method: string, path: string, options: { body?: unknown; mfa?: boolean } = {}): Promise<{ status: number; body: T }> {
  const token = issuer.token(OPERATOR_SUBJECT, { email: 'operator@repracer.invalid', amr: options.mfa === false ? ['pwd'] : ['pwd', 'otp'] });
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

before(async () => {
  db = await createIsolatedDatabase('dayboundary');
  // Учётная запись оператора заводится суперпользователем стенда: заводить операторов панель не умеет [Р-166]
  await db.superuser(
    `INSERT INTO platform.platform_operator (operator_id, tenant_id, issuer, subject, display_name, active)
     VALUES ($1, security.platform_tenant_id(), $2, $3, 'Operator im Prüflauf', true)`, [OPERATOR_ID, OPERATOR_ISSUER, OPERATOR_SUBJECT]);
  const pools = {
    app: db.pool('svc_app', 4), admin: db.pool('svc_admin', 4), provisioning: db.pool('svc_provisioning'),
    dispatcher: db.pool('svc_dispatcher'), scheduler: db.pool('svc_scheduler'), exporter: db.pool('svc_exporter'),
    stock: db.pool('svc_stock'), bulkWorker: db.pool('svc_bulk_worker'),
  };
  const directory = new PgIdentityDirectory(db.pool('svc_authenticator') as never);
  const memberUsers = await pgStandUsers(directory as never, db.pool('svc_onboarding') as never);
  world = await startDemoWorld({
    pools, pgUrl: db.url('svc_app'),
    pgUrlsByRole: { admin: db.url('svc_admin'), bulk_worker: db.url('svc_bulk_worker'), stock: db.url('svc_stock') },
    tag: 6900, memberUsers, memberEmails: STAND_EMAILS,
    joinMember: pgStandJoinMember(pools.admin as never, directory as never),
    hours: 1, usAccounts: true, usPressDays: PRESS_DAYS, customerTenant: true, log: () => undefined,
  });
  tenantId = world.tenantId;
  const accounts = await db.rows<{ channel_account_id: string; channel: string }>(
    `SELECT channel_account_id, channel FROM tenant_data.channel_account WHERE tenant_id = $1 AND channel IN ('EBAY', 'AMAZON')`, [tenantId]);
  ebayAccount = accounts.find((a) => a.channel === 'EBAY')!.channel_account_id;
  amazonAccount = accounts.find((a) => a.channel === 'AMAZON')!.channel_account_id;

  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  issuer = createLocalIssuer({ issuer: OPERATOR_ISSUER, audience: OPERATOR_AUDIENCE, privateKeyPem: key });
  panel = await startOperatorPanel({
    REPRACER_MODE: 'stand',
    REPRACER_OPERATOR_PORT: '0', REPRACER_OPERATOR_METRICS_PORT: '0',
    REPRACER_OPERATOR_PG_URL: db.url('svc_operator'),
    REPRACER_OPERATOR_OIDC_ISSUER: OPERATOR_ISSUER, REPRACER_OPERATOR_OIDC_AUDIENCE: OPERATOR_AUDIENCE,
    REPRACER_OPERATOR_OIDC_JWKS_URL: 'https://identity.repracer.invalid/keys',
    REPRACER_OPERATOR_OIDC_CLIENT_ID: 'operator-panel',
    REPRACER_OPERATOR_STAND_KEY: key,
    REPRACER_OPERATOR_INVITATION_URL: 'https://app.repracer.invalid/invitation',
    REPRACER_OPERATOR_HEARTBEAT: 'off',
  }, { mail: new FakeMail() });
  origin = `http://127.0.0.1:${panel.port}`;
});

after(async () => {
  world?.stop();
  await panel?.close();
  await db?.drop();
});

/** Худшее окно, посчитанное прогоном по строкам: наибольшее число «потратило бы» по одному ключу бюджета в любые 24 часа [Р-163] */
async function worstWindowByRows(channelAccountId: string, marketplace: string): Promise<{ worst: number; writes: number }> {
  const rows = await db.rows<{ k: string; at: string }>(
    `SELECT coalesce(h.budget_scope_key, h.write_scope_id::text) AS k, h.finished_at AS at
       FROM tenant_data.channel_write_history h
       JOIN tenant_data.offer_mapping om ON om.tenant_id = h.tenant_id AND h.write_scope_id IN (om.price_write_scope_id, om.quantity_write_scope_id)
      WHERE h.tenant_id = $1 AND om.channel_account_id = $2 AND om.marketplace = $3 AND h.final_status = 'SHADOW_HELD' AND h.would_spend_budget`,
    [tenantId, channelAccountId, marketplace]);
  const byKey = new Map<string, number[]>();
  for (const r of rows) byKey.set(r.k, [...(byKey.get(r.k) ?? []), Date.parse(String(r.at))]);
  let worst = 0;
  for (const times of byKey.values()) {
    for (const t of times) worst = Math.max(worst, times.filter((u) => u <= t && u >= t - DAY_MS).length);
  }
  return { worst, writes: rows.length };
}

test('Р-204: панель показывает витрины с неподтверждённой границей и доказательство тени — худшее окно равно счёту по строкам', async () => {
  const screen = await call<{ candidates: Candidate[]; acceptances: Acceptance[] }>('GET', '/api/operator/day-boundaries');
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  const mine = screen.body.candidates.filter((c) => c.tenant_id === tenantId);
  const ebay = mine.find((c) => c.marketplace === EBAY_US);
  const amazon = mine.find((c) => c.marketplace === AMAZON_US);
  assert.ok(ebay && amazon, `обе витрины США — кандидаты: ${JSON.stringify(mine)}`);
  assert.equal(ebay.channel_account_id, ebayAccount);
  assert.equal(ebay.status, 'UNKNOWN', 'граница суток EBAY_US держит бой');
  assert.ok(ebay.shadow_days >= 7, `неделя тени прожата: ${ebay.shadow_days} суток от первого решения до последнего`);
  assert.ok(Number(ebay.decisions) > 0 && Number(amazon.decisions) > 0, `решения тени есть у обеих витрин: ${ebay.decisions}, ${amazon.decisions}`);
  assert.equal(ebay.budget_limit, 250, 'лимит правок eBay — из возможностей канала');
  assert.equal(amazon.budget_limit, null, 'у amazon.com бюджета правок нет');

  // Независимый счёт: те же удержанные записи, окно считает прогон, а не база
  const byRows = await worstWindowByRows(ebayAccount, EBAY_US);
  assert.ok(byRows.writes > 0, `положительный контроль: у eBay есть записи «потратило бы бюджет» — ${byRows.writes}`);
  assert.equal(Number(ebay.budget_writes), byRows.writes, 'записей «потратило бы» столько же, сколько строк');
  assert.equal(Number(ebay.worst_window_max), byRows.worst, `худшее окно базы равно счёту по строкам: ${ebay.worst_window_max} и ${byRows.worst}`);
  assert.ok(byRows.worst > 0 && byRows.worst <= 250, `худшее окно в пределе бюджета: ${byRows.worst}`);
  /**
   * Ревью шага 69, находка 3: сутки тени — ДЛИТЕЛЬНОСТЬ от первого до последнего теневого решения в целых сутках, а «подряд» — самый
   * длинный перерыв между соседними решениями (не больше 36 часов). Прогон считает обе величины по строкам решений сам.
   * Полный CI шага 69 (прогон с 19:00 UTC): первая редакция требовала решения в каждую дату UTC — пересчёт eBay раз в сутки сдвигался на
   * такт за сутки, перешагнул полночь, и одна дата осталась пустой при непрерывной тени: «доказательство» отказывало честной неделе
   */
  const decided = (await db.rows<{ at: string }>(
    `SELECT pd.decided_at AS at
       FROM channel_data.price_decision pd JOIN tenant_data.offer_mapping om ON om.tenant_id = pd.tenant_id AND om.price_write_scope_id = pd.write_scope_id
      WHERE pd.tenant_id = $1 AND pd.shadow AND om.channel_account_id = $2 AND pd.decided_at >= now() - interval '14 days'`, [tenantId, ebayAccount]))
    .map((r) => Date.parse(String(r.at)));
  const first = Math.min(...decided);
  const last = Math.max(...decided);
  const span = Math.floor((last - first) / DAY_MS);
  const sorted = [...decided].sort((a, b) => a - b);
  const gapMs = sorted.slice(1).reduce((g, t, i) => Math.max(g, t - sorted[i]!), 0);
  assert.equal(ebay.shadow_days, span, `сутки тени — длительность по строкам решений: ${ebay.shadow_days} и ${span}`);
  assert.ok(span >= 7, `неделя тени по длительности: ${span}`);
  assert.equal(ebay.longest_gap_hours, Math.ceil(gapMs / 3_600_000), 'самый длинный перерыв — тот же, что по строкам');
  assert.ok(ebay.longest_gap_hours > 0 && ebay.longest_gap_hours <= 36, `тень подряд: самый длинный перерыв ${ebay.longest_gap_hours} ч`);
  console.log(JSON.stringify({ dayBoundaryEvidence: mine.map((c) => ({ storefront: `${c.channel} ${c.marketplace}`, shadowDays: c.shadow_days, longestGapHours: c.longest_gap_hours, decisions: c.decisions,
    heldWrites: c.held_writes, budgetWrites: c.budget_writes, worstWindow: c.worst_window_max, limit: c.budget_limit })), byRows }));
});

test('Р-204: принять худшее окно — отказы базы своей причиной; принятое ложится в журнал и аудит, витрина CONSERVATIVE, бой открывается', async () => {
  const accept = (overrides: Record<string, unknown> = {}, mfa = true) => call<{ code?: string; message?: string; acceptanceId?: string }>('POST', '/api/operator/day-boundaries/accept', {
    mfa,
    body: {
      channel: 'EBAY', marketplace: EBAY_US, timeZone: 'America/Los_Angeles', tenantId, channelAccountId: ebayAccount,
      note: 'Pacific time — the latest calendar day of the storefront; 8 shadow days, no budget alerts', ...overrides,
    },
  });
  const noMfa = await accept({}, false);
  assert.equal(noMfa.status, 403, `без второго фактора — отказ: ${JSON.stringify(noMfa.body)}`);
  assert.match(noMfa.body.message ?? '', /second factor/i, 'причина — второй фактор, её даёт база');
  const shortNote = await accept({ note: 'ok' });
  assert.equal(shortNote.status, 409, JSON.stringify(shortNote.body));
  assert.match(shortNote.body.message ?? '', /day_boundary_acceptance_note_present/, 'причина — заметка');
  const wrongAccount = await accept({ channelAccountId: amazonAccount });
  assert.equal(wrongAccount.status, 400, `аккаунт другой витрины — не доказательство: ${JSON.stringify(wrongAccount.body)}`);
  assert.match(wrongAccount.body.message ?? '', /is not a shadow account of a customer tenant on storefront EBAY EBAY_US/);
  const badZone = await accept({ timeZone: 'Pacific/Nowhere' });
  assert.equal(badZone.status, 409, JSON.stringify(badZone.body));
  assert.match(badZone.body.message ?? '', /day_boundary_acceptance_time_zone_known/);
  // Ни один отказ ничего не записал
  const [none] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM platform.day_boundary_acceptance`);
  assert.equal(none!.n, 0, 'отказанные попытки строк журнала не оставили');

  const ok = await accept();
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const [readiness] = await db.rows<{ status: string; value: string | null; question: string | null }>(
    `SELECT status, value, question FROM platform.marketplace_readiness() WHERE channel = 'EBAY' AND marketplace = $1 AND property = 'DAY_BOUNDARY'`, [EBAY_US]);
  assert.equal(readiness!.status, 'CONSERVATIVE', 'граница принята худшим окном — консервативно, а не подтверждена');
  assert.equal(readiness!.value, 'America/Los_Angeles');
  assert.equal(readiness!.question, 'OQ-112', 'вопрос каналу остаётся открытым');

  const screen = await call<{ candidates: Candidate[]; acceptances: Acceptance[] }>('GET', '/api/operator/day-boundaries');
  assert.ok(!screen.body.candidates.some((c) => c.marketplace === EBAY_US), 'EBAY_US больше не кандидат');
  assert.ok(screen.body.candidates.some((c) => c.marketplace === AMAZON_US && c.tenant_id === tenantId), 'amazon.com — по-прежнему кандидат');
  const row = screen.body.acceptances.find((a) => a.acceptance_id === ok.body.acceptanceId);
  assert.ok(row, 'принятое — в журнале экрана');
  assert.equal(row.operator, 'Operator im Prüflauf');
  assert.ok(row.shadow_days >= 7 && Number(row.decisions) > 0 && row.budget_limit === 250, `доказательство записано базой: ${JSON.stringify(row)}`);
  const audit = await call<{ actions: Array<{ action: string; detail?: unknown }> }>('GET', '/api/operator/actions?action=operator.day_boundary_accepted');
  assert.equal(audit.status, 200);
  assert.equal(audit.body.actions.length, 1, `событие аудита оператора: ${JSON.stringify(audit.body)}`);

  const again = await accept();
  assert.equal(again.status, 400, `ту же витрину второй раз не принять: ${JSON.stringify(again.body)}`);

  // Владелец переводит аккаунт eBay US в бой — ровно то, что граница держала [Р-170, Р-172]
  const [owner] = await db.rows<{ membership_id: string; user_id: string }>(
    `SELECT membership_id, user_id FROM tenant_data.membership WHERE tenant_id = $1 AND role = 'OWNER' AND revoked_at IS NULL LIMIT 1`, [tenantId]);
  const [acc] = await db.rows<{ external_account_id: string }>(`SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [ebayAccount]);
  const shadow = new PgShadowStore({ adminPool: db.pool('svc_admin') as never });
  const switched = await shadow.switchWriteMode(tenantId, {
    channelAccountId: ebayAccount, toMode: 'LIVE', membershipId: owner!.membership_id, userId: owner!.user_id, mfa: true,
    typedConfirmation: acc!.external_account_id,
  } as never);
  assert.equal(switched.status, 'SWITCHED', `бой на EBAY_US открыт принятым худшим окном: ${JSON.stringify(switched)}`);
});
