import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { seedPricingWorld, type PgPool, type SeededPricingWorld } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startDeletionProcess, type DeletionProcess } from '../src/main.ts';
import { notificationApiKeys } from '../src/verify.ts';

/**
 * Шаг 49 [Р-192]: живой прогон приёмника eBay Marketplace Account Deletion — настоящий HTTP-процесс, настоящая база, модель
 * eBay по HTTP (токен приложения и `getPublicKey` Notification API) со своей парой ключей ECDSA P-256. Подпись и ключ — в форме
 * официального SDK eBay (vendor/ebay/event-notification-sdk): заголовок base64 `{alg, kid, signature, digest}`, ключ PEM без
 * переводов строк. Данные синтетические; идентификаторы пользователей eBay — с приставкой `syn`.
 */

const ENDPOINT = 'https://deletion.repracer.test/ebay/account-deletion';
const TOKEN = 'syn_verification-token_49_0123456789abcdef';
const SELLER = 'syn_ebay_seller_49_a';
const OTHER = 'syn_ebay_seller_49_b';
const KID = 'syn-kid-49';

let db: IsolatedDatabase;
let world: SeededPricingWorld;
let proc: DeletionProcess;
let model: Server;
let modelBase: string;
let modelUp = true;
const modelCalls: Record<string, number> = {};
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const logLines: string[] = [];
const SEED_A = 'ebay-seller-a';
// Второй продавец — копия строки первого со своим идентификатором (посев даёт всем аккаунтам канала один внешний идентификатор)
const accountB = '20000000-0000-4000-8000-000000000492';
let accountA: string;

const sign = (message: object, privateKey = keys.privateKey) => Buffer.from(JSON.stringify({
  alg: 'ecdsa', kid: KID, signature: createSign('sha1').update(JSON.stringify(message)).sign(privateKey, 'base64'), digest: 'SHA1',
})).toString('base64');
const notice = (id: string, userId: string, attempt = 1) => ({
  metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION', schemaVersion: '1.0', deprecated: false },
  notification: { notificationId: id, eventDate: '2026-09-28T10:00:00.000Z', publishDate: '2026-09-28T10:00:01.000Z', publishAttemptCount: attempt,
    data: { username: `${userId}_name`, userId, eiasToken: 'syn-eias-token-49' } },
});
const post = async (message: object, header: string) => fetch(`http://127.0.0.1:${proc.port}/ebay/account-deletion`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-ebay-signature': header }, body: JSON.stringify(message),
});
// Итог читает суперпользователь прогона: журнал уведомлений — платформенная таблица, аккаунты — разных тенантов
let su: import('pg').Client;
const account = async (id: string) => (await su.query(
  `SELECT auth_status, credentials_ref, external_account_id, disconnected_at IS NOT NULL AS disconnected,
          (SELECT count(*)::int FROM tenant_data.channel_credential c WHERE c.channel_account_id = a.channel_account_id) AS credentials
     FROM tenant_data.channel_account a WHERE channel_account_id = $1`, [id])).rows[0];

before(async () => {
  db = await createIsolatedDatabase('ebaydeletion49');
  const app: PgPool = db.pool('svc_app', 2);
  world = await seedPricingWorld(app, {
    provisioningPool: db.pool('svc_provisioning', 1), adminPool: db.pool('svc_admin', 2),
    fixtureTenantId: '10000000-0000-4000-8000-000000000049', fixtureChannelAccountId: '20000000-0000-4000-8000-000000000490', marketplaces: ['de'],
    clock: new Date().toISOString(),
    seed: { scopes: [], accounts: [
      // В тени: бой на EBAY_DE закрыт неподтверждённой границей суток [Р-188]; для удаления режим записи не важен
      { channelAccountId: SEED_A, channel: 'EBAY', marketplaces: ['EBAY_DE'], writeMode: 'SHADOW' },
    ] },
  } as never);
  accountA = world.ids.dbId(SEED_A);
  const superuserUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!);
  superuserUrl.pathname = new URL(db.url('svc_app')).pathname;
  su = new (await import('pg')).default.Client({ connectionString: superuserUrl.toString() });
  await su.connect();
  // Продавцы eBay — те, кого назвал бы Commerce Identity (`userId`), с зашифрованными токенами (шифротекст синтетический)
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO tenant_data.channel_account SELECT (jsonb_populate_record(a, jsonb_build_object('channel_account_id', '${accountB}', 'external_account_id', '${OTHER}'))).*
      FROM tenant_data.channel_account a WHERE channel_account_id = '${accountA}';
    UPDATE tenant_data.channel_account SET external_account_id = CASE channel_account_id WHEN '${accountA}' THEN '${SELLER}' ELSE '${OTHER}' END,
           credentials_ref = 'db:' || channel_account_id::text WHERE channel_account_id IN ('${accountA}', '${accountB}');
    -- Две версии токена: вытесненная и действующая — удаление обязано стереть обе
    INSERT INTO tenant_data.channel_credential (tenant_id, channel_account_id, version, superseded_at, key_id, iv, auth_tag, ciphertext)
    SELECT tenant_id, channel_account_id, v, CASE WHEN v = 1 THEN now() END, 'syn-key', '\\x000102030405060708090a0b', '\\x000102030405060708090a0b0c0d0e0f', '\\x73796e2d636970686572746578742d3031'
      FROM tenant_data.channel_account, generate_series(1, 2) v WHERE channel_account_id IN ('${accountA}', '${accountB}');
    SET session_replication_role = origin;`);

  const publicPem = (keys.publicKey.export({ type: 'spki', format: 'pem' }) as string).replace(/\n/g, '');
  model = createServer((req, res) => {
    const route = `${req.method} ${(req.url ?? '').replace(/public_key\/.*/, 'public_key/{kid}')}`;
    modelCalls[route] = (modelCalls[route] ?? 0) + 1;
    if (!modelUp) { res.writeHead(503).end(); return; }
    if (req.method === 'POST' && req.url === '/identity/v1/oauth2/token') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'syn-app-token-49', expires_in: 7200, token_type: 'Application Access Token' }));
      return;
    }
    if (req.method === 'GET' && req.url === `/commerce/notification/v1/public_key/${KID}`) {
      assert.equal(req.headers.authorization, 'Bearer syn-app-token-49');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ key: publicPem, algorithm: 'ECDSA', digest: 'SHA1' }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
  modelBase = `http://127.0.0.1:${(model.address() as { port: number }).port}`;

  // Журнал процесса перехватывается: в нём не должно быть ни одного идентификатора пользователя eBay
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logLines.push(String(chunk));
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;

  proc = await startDeletionProcess({
    endpoint: ENDPOINT, verificationToken: TOKEN, port: 0, metricsPort: 0, pgUrl: db.url('svc_ebay_deletion'),
    apiBase: modelBase, clientId: 'syn-client-49', clientSecret: 'syn-secret-49', heartbeatUrl: null,
  }, { keys: notificationApiKeys({ apiBase: modelBase, clientId: 'syn-client-49', clientSecret: 'syn-secret-49' }) });
});

after(async () => {
  await su?.end();
  await proc?.stop();
  await new Promise<void>((resolve) => (model ? model.close(() => resolve()) : resolve()));
  await db?.drop();
});

test('Р-192, живой прогон: challenge, настоящее уведомление, повтор, подделка, незнакомый пользователь, недоступный ключ', async () => {
  const seen: Record<string, unknown> = {};

  // 1. Challenge: 200, application/json, тело — JSON без BOM, хэш кода, токена и адреса
  const ch = await fetch(`http://127.0.0.1:${proc.port}/ebay/account-deletion?challenge_code=syn-challenge-49`);
  const raw = Buffer.from(await ch.arrayBuffer());
  assert.equal(ch.status, 200);
  assert.equal(ch.headers.get('content-type'), 'application/json');
  assert.equal(raw[0], '{'.charCodeAt(0), 'тело начинается с «{» — без BOM (страница снимка предупреждает о нём отдельно)');
  const expected = createHash('sha256').update('syn-challenge-49' + TOKEN + ENDPOINT).digest('hex');
  assert.deepEqual(JSON.parse(raw.toString('utf8')), { challengeResponse: expected });
  seen.challenge = { status: ch.status, contentType: ch.headers.get('content-type'), body: raw.toString('utf8') };

  // 2. Настоящее уведомление о продавце A: 204, токены удалены, аккаунт отключён, идентификатор стёрт
  const a1 = notice('syn-0049-0001-seller-a', SELLER);
  const r1 = await post(a1, sign(a1));
  assert.equal(r1.status, 204);
  assert.equal(await r1.text(), '');
  assert.deepEqual(await account(accountA), { auth_status: 'DISCONNECTED', credentials_ref: null, external_account_id: `deleted:${accountA}`, disconnected: true, credentials: 0 });
  seen.notice = { status: r1.status, body: '' };

  // 3. Повтор того же уведомления (eBay повторяет до подтверждения): 204, второй раз ничего не делается
  const a2 = notice('syn-0049-0001-seller-a', SELLER, 2);
  assert.equal((await post(a2, sign(a2))).status, 204);

  // 4. Подделка — о продавце B, подписанная чужим ключом: 412, у B не изменилось ничего
  const b1 = notice('syn-0049-0002-forged-b', OTHER);
  const forged = await post(b1, sign(b1, stranger.privateKey));
  assert.equal(forged.status, 412);
  assert.deepEqual(await account(accountB), { auth_status: 'ACTIVE', credentials_ref: `db:${accountB}`, external_account_id: OTHER, disconnected: false, credentials: 2 });
  seen.forged = { status: forged.status };

  // 5. Подлинное уведомление, подменённое по дороге (userId другой): подпись не сходится — 412
  const tampered = { ...a1, notification: { ...a1.notification, notificationId: 'syn-0049-0003-tampered', data: { ...a1.notification.data, userId: OTHER } } };
  assert.equal((await post(tampered, sign(a1))).status, 412);

  // 6. Незнакомый пользователь (покупатель, или продавец, которого у нас нет): 204, удалено 0, в журнале — ничего
  const u1 = notice('syn-0049-0004-unknown', 'syn_ebay_user_we_never_saw');
  assert.equal((await post(u1, sign(u1))).status, 204);

  // 7. Ключ сейчас не получить (кэш ключа — час, поэтому новый процесс): 500 — eBay повторит
  modelUp = false;
  const cold = await startDeletionProcess({
    endpoint: ENDPOINT, verificationToken: TOKEN, port: 0, metricsPort: 0, pgUrl: db.url('svc_ebay_deletion'),
    apiBase: modelBase, clientId: 'syn-client-49', clientSecret: 'syn-secret-49', heartbeatUrl: null,
  });
  const b2 = notice('syn-0049-0005-key-down', OTHER);
  const down = await fetch(`http://127.0.0.1:${cold.port}/ebay/account-deletion`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ebay-signature': sign(b2) }, body: JSON.stringify(b2) });
  await cold.stop();
  modelUp = true;
  assert.equal(down.status, 500);
  assert.equal((await account(accountB)).auth_status, 'ACTIVE', 'непроверенное уведомление ничего не удаляет');

  // База: журнал уведомлений хранит хэш, а не идентификатор; владелец извещён один раз; удаление — в аудите
  const admin = su;
  const { rows: notices } = await su.query(`SELECT notification_id, encode(user_id_sha256, 'hex') AS h, accounts_deleted FROM platform.ebay_account_deletion_notice ORDER BY notification_id`);
  // Находка 3 ревью: журнал — только исполненные удаления; о пользователе, которого у нас не было, не хранится даже хэш
  assert.deepEqual(notices.map((n) => [n.notification_id, n.accounts_deleted]), [['syn-0049-0001-seller-a', 1]]);
  assert.equal(notices[0].h, createHash('sha256').update(SELLER).digest('hex'), 'журнал хранит SHA-256 идентификатора');
  const { rows: [al] } = await admin.query(`SELECT count(*)::int AS n FROM tenant_data.alert WHERE code = 'EBAY_ACCOUNT_DELETED_BY_USER' AND channel_account_id = $1`, [accountA]);
  assert.equal(al.n, 1, 'владелец извещён ровно один раз, повтор уведомления второго алерта не даёт');
  const { rows: [au] } = await admin.query(`SELECT count(*)::int AS n FROM audit.audit_event WHERE action = 'channel.ebay_account_deleted_by_user' AND entity_id = $1`, [accountA]);
  assert.equal(au.n, 1, 'удаление — событие аудита тенанта');

  // Модель eBay: токен приложения и ключ — по разу за процесс (ключ кэшируется, страница снимка советует час)
  assert.equal(modelCalls['GET /commerce/notification/v1/public_key/{kid}'], 1);

  // Журнал процесса не несёт идентификаторов пользователей eBay
  const log = logLines.join('');
  for (const id of [SELLER, OTHER, `${SELLER}_name`, 'syn-eias-token-49', 'syn_ebay_user_we_never_saw']) assert.ok(!log.includes(id), `идентификатор ${id} в журнале`);
  // …но НАШ идентификатор удалённого аккаунта в журнале есть: по нему удаление повторяется после восстановления базы (риск 36)
  assert.ok(log.split('\n').some((l) => l.includes('EBAY_DELETION_APPLIED') && l.includes(accountA)), 'журнал называет удалённый аккаунт нашим идентификатором');
  console.log(JSON.stringify({ ebayAccountDeletion: seen, modelCalls }, null, 1));
});
