import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { createLocalIssuer } from '@repracer/identity/test-issuer';
import { PgIdentityDirectory } from '@repracer/identity/pg';
import { pgStandJoinMember, pgStandUsers, STAND_EMAILS } from '@repracer/contract-tests/stand';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { startDemoWorld, type RunningDemoWorld } from '../../console/server/demo-world.ts';
import { startOperatorPanel, type RunningPanel } from '../server/operator-service.ts';

/**
 * Р-165…Р-168 (шаг 40): панель оператора платформы живым прогоном — КАК БРАУЗЕР [Р-136, Р-142]. Поднимается тот же
 * процесс, который поднимает промышленный профиль (`startOperatorPanel`), и прогон ходит по нему по HTTP.
 *
 * Проверяются три вещи, и третья важнее первых двух:
 *   1) семь экранов чтения отвечают на ЖИВЫХ данных — демо-мир идёт своим ходом, пока прогон по ним ходит;
 *   2) путь «завести пилота» проходится целиком: тенант → приглашение → ПЕРЕХВАЧЕННОЕ письмо → владелец принял →
 *      онбординг начался с первого шага;
 *   3) чего оператор НЕ может: чужого токена нет, отозванной учётной записи нет, без второго фактора нет ни одного
 *      действия, а маршрутов «остановить цены», «поправить границы» и «назначить стратегию» в панели нет вовсе.
 *
 * Данные синтетические: демо-тенант на симуляторе Kaufland [Р-151].
 */

/** Предел ответа ЭКРАНА [шаг 29]: дольше — человек считает, что панель зависла */
const SCREEN_LIMIT_SECONDS = 10;
/** Сколько виртуальных часов живёт демо-мир под прогоном (правило скорости 1: короткий прогон, не сутки) */
const DEMO_HOURS = 2;
const OPERATOR_ISSUER = 'https://identity.repracer.invalid';
const OPERATOR_AUDIENCE = 'repracer-operator';

let db: IsolatedDatabase;
let demo: RunningDemoWorld | null = null;
let panel: RunningPanel;
let origin = '';
let issuer: ReturnType<typeof createLocalIssuer>;
/** Перехватчик писем: письмо владельцу пилота ЧИТАЕТСЯ прогоном, а не принимается на слово [Р-156, шаг 36] */
const mail = new FakeMail();
let operatorToken = '';
const OPERATOR_ID = randomUUID();
const OPERATOR_SUBJECT = `operator-${randomUUID()}`;
/** Путь «завести пилота»: шаги и секунды — отчёт шага берёт числа отсюда, а не пересказывает */
const journey: Array<{ step: string; method: string; url: string; seconds: number; status: number }> = [];
const screens: Array<{ screen: string; rows: number; seconds: number }> = [];

async function walk<T>(step: string, method: string, path: string, options: { token?: string | null; body?: unknown } = {}): Promise<{ status: number; body: T; text: string }> {
  const started = process.hrtime.bigint();
  const token = options.token === undefined ? operatorToken : options.token;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  journey.push({ step, method, url: path, seconds, status: response.status });
  let body: T = undefined as T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    // не JSON — это страница панели: она проверяется как текст
  }
  return { status: response.status, body, text };
}

before(async () => {
  db = await createIsolatedDatabase('operatorpanel');
  /**
   * Учётная запись оператора заводится СУПЕРПОЛЬЗОВАТЕЛЕМ стенда: заводить операторов панель не умеет и не должна
   * [Р-166] — четыре действия названы поимённо, и «завести себе коллегу» среди них нет.
   */
  await db.superuser(
    `INSERT INTO platform.platform_operator (operator_id, tenant_id, issuer, subject, display_name, active)
     VALUES ($1, security.platform_tenant_id(), $2, $3, 'Operator im Prüflauf', true)`, [OPERATOR_ID, OPERATOR_ISSUER, OPERATOR_SUBJECT]);

  // Демо-мир: живые работы планировщика, записи в канал и решения — по ним и ходят экраны панели
  const pools = {
    app: db.pool('svc_app', 4), admin: db.pool('svc_admin', 4), provisioning: db.pool('svc_provisioning'),
    dispatcher: db.pool('svc_dispatcher'), scheduler: db.pool('svc_scheduler'), exporter: db.pool('svc_exporter'),
    stock: db.pool('svc_stock'), bulkWorker: db.pool('svc_bulk_worker'),
  };
  const directory = new PgIdentityDirectory(db.pool('svc_authenticator') as never);
  const memberUsers = await pgStandUsers(directory as never, db.pool('svc_onboarding') as never);
  demo = await startDemoWorld({
    pools, pgUrl: db.url('svc_app'),
    pgUrlsByRole: { admin: db.url('svc_admin'), bulk_worker: db.url('svc_bulk_worker'), stock: db.url('svc_stock') },
    tag: 4000, memberUsers, memberEmails: STAND_EMAILS,
    joinMember: pgStandJoinMember(pools.admin as never, directory as never),
    hours: DEMO_HOURS, log: () => undefined,
  });

  /**
   * OQ-228 (шаг 41): экраны алертов и уведомлений в прогоне были ПУСТЫ — за два виртуальных часа демо-мира ни одного
   * события не поднимается, а уведомлений Amazon в нём нет вовсе. Экран, который всегда пуст, может неверно показывать
   * НЕпустое состояние, и заметит это человек, а не сборка. Поэтому события и уведомления сеет прогон — как их посеял бы
   * путь решения и приёмник: панель их не создаёт и создавать не может [Р-166].
   */
  const demoTenant = demo.tenantId;
  // Читается суперпользователем стенда: у административной роли строки видны только в контексте её тенанта (RLS)
  const [account] = await db.rows<{ channel_account_id: string; channel: string }>(
    `SELECT channel_account_id, channel FROM tenant_data.channel_account WHERE tenant_id = $1 LIMIT 1`, [demoTenant]);
  await db.superuser(
    `INSERT INTO tenant_data.alert (tenant_id, code, severity, channel_account_id, details)
     VALUES ($1, 'PRICE_WRITE_NOT_SENT', 'CRITICAL', $2, '{"synthetic": true}'::jsonb),
            ($1, 'NOTIFICATION_LATE', 'WARNING', $2, '{"synthetic": true}'::jsonb)`,
    [demoTenant, account!.channel_account_id]);
  await db.superuser(
    `INSERT INTO channel_data.inbound_notification (tenant_id, channel_account_id, channel, notification_id, notification_type, event_time, received_at, processed_at)
     VALUES ($1, $2, $3, 'syn-1', 'ANY_OFFER_CHANGED', now(), now(), now()),
            ($1, $2, $3, 'syn-2', 'ANY_OFFER_CHANGED', now(), now(), now())`,
    [demoTenant, account!.channel_account_id, account!.channel]);

  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  issuer = createLocalIssuer({ issuer: OPERATOR_ISSUER, audience: OPERATOR_AUDIENCE, privateKeyPem: key });
  panel = await startOperatorPanel({
    // Режим стенда: ключ входа приходит значением только здесь, в работе панель берёт ключи у поставщика по JWKS
    REPRACER_MODE: 'stand',
    REPRACER_OPERATOR_PORT: '0', REPRACER_OPERATOR_METRICS_PORT: '0',
    REPRACER_OPERATOR_PG_URL: db.url('svc_operator'),
    REPRACER_OPERATOR_OIDC_ISSUER: OPERATOR_ISSUER, REPRACER_OPERATOR_OIDC_AUDIENCE: OPERATOR_AUDIENCE,
    REPRACER_OPERATOR_OIDC_JWKS_URL: 'https://identity.repracer.invalid/keys',
    REPRACER_OPERATOR_STAND_KEY: key,
    REPRACER_OPERATOR_INVITATION_URL: 'https://app.repracer.invalid/invitation',
    // Р-127: отметку во внешнем сервисе прогон выключает ЯВНО — аккаунта сервиса у проекта нет (OQ-188)
    REPRACER_OPERATOR_HEARTBEAT: 'off',
  }, { mail });
  origin = `http://127.0.0.1:${panel.port}`;
  operatorToken = issuer.token(OPERATOR_SUBJECT, { email: 'operator@repracer.invalid', amr: ['pwd', 'otp'] });
});

after(async () => {
  demo?.stop();
  await panel?.close();
  await db?.drop();
  console.log(JSON.stringify({ panel: { screens, journey } }, null, 2));
});

test('Р-168: семь экранов панели отвечают на живых данных и укладываются в предел экрана', async () => {
  const page = await walk<unknown>('открыть панель', 'GET', '/', { token: null });
  assert.equal(page.status, 200, 'страница панели отдаётся без токена: войти в неё надо чем-то');
  assert.match(page.text, /operator panel/, 'это страница панели, а не пустой ответ');
  /**
   * Находка 3 ревью шага 40: страница показывала семь таблиц и не умела НИ ОДНОГО действия — четыре операции Р-166
   * существовали только как адреса, и выполнить их человек мог лишь curl'ом. Проверяется не разметка, а то, что на
   * странице есть путь каждого действия: иначе «через консоль как браузер» [Р-142] снова станет словом.
   */
  for (const action of ["path: 'tenants'", "'/invite'", "'/acknowledge'", "'/resolve'"]) {
    assert.ok(page.text.includes(action), `страница панели умеет действие ${action}`);
  }
  assert.ok(page.text.includes("method: 'POST'"), 'действия страницы идут запросом POST, а не ссылкой');

  const session = await walk<{ displayName: string; secondFactor: boolean }>('кто я', 'GET', '/api/operator/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.displayName, 'Operator im Prüflauf', 'панель называет оператора по учётной записи БАЗЫ, а не по токену');
  assert.equal(session.body.secondFactor, true, 'второй фактор виден из amr токена');

  const list: Array<[string, string]> = [
    ['tenants', 'tenants'], ['jobs', 'jobs'], ['alerts', 'alerts'], ['write-queue', 'queue'],
    ['notifications', 'notifications'], ['snapshot-skips', 'skips'], ['actions', 'actions'],
  ];
  for (const [screen, key] of list) {
    const started = process.hrtime.bigint();
    const answer = await walk<Record<string, unknown[]>>(`экран ${screen}`, 'GET', `/api/operator/${screen}`);
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    assert.equal(answer.status, 200, `экран ${screen} отвечает`);
    const rows = answer.body[key];
    assert.ok(Array.isArray(rows), `экран ${screen} отдаёт список ${key}`);
    assert.ok(seconds < SCREEN_LIMIT_SECONDS, `экран ${screen} ответил за ${seconds.toFixed(2)} с при пределе ${SCREEN_LIMIT_SECONDS} с`);
    screens.push({ screen, rows: rows.length, seconds: Math.round(seconds * 1000) / 1000 });
  }

  // Экраны не пустые: демо-мир идёт, и это видно числами, а не словом «отвечает»
  const tenants = await walk<{ tenants: Array<{ name: string; demo: boolean; offers: number; repricing_on: number }> }>('обзор тенантов', 'GET', '/api/operator/tenants');
  const demoRow = tenants.body.tenants.find((t) => t.demo);
  assert.ok(demoRow, 'демо-тенант виден в списке тенантов и помечен демо [Р-151]');
  assert.ok(demoRow.offers > 0, `у демо-тенанта видны предложения, их ${demoRow.offers}`);

  /**
   * Демо-миру дают поработать: экран, отвечающий на пустой базе, не доказывает ничего. Ждём, пока в очереди записей
   * появятся строки, — это и значит «панель смотрит на живой фон», а не на посев.
   */
  const waited = process.hrtime.bigint();
  let queued = 0;
  for (let i = 0; i < 60 && queued === 0; i += 1) {
    const q = await walk<{ queue: Array<{ writes: number }> }>('очередь записей', 'GET', '/api/operator/write-queue');
    queued = q.body.queue.reduce((sum, row) => sum + row.writes, 0);
    if (queued === 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  assert.ok(queued > 0, `в очереди диспетчера ${queued} записей через ${(Number(process.hrtime.bigint() - waited) / 1e9).toFixed(0)} с работы демо-мира`);

  /**
   * OQ-228 закрыт: экраны алертов и уведомлений наполнены, и это утверждается числами, а не «экран отвечает». Доставка
   * алерта видна отдельным полем — событие в базе без отметки доставки считается НЕдоставленным [Р-156].
   */
  const alerts = await walk<{ alerts: Array<{ code: string; severity: string; delivered_at: string | null }> }>('алерты', 'GET', '/api/operator/alerts');
  assert.ok(alerts.body.alerts.length >= 2, `на экране алертов ${alerts.body.alerts.length} событий`);
  assert.ok(alerts.body.alerts.some((a) => a.severity === 'CRITICAL') && alerts.body.alerts.some((a) => a.severity === 'WARNING'),
    'видны события обоих уровней: панель не фильтрует их молча');
  assert.ok(alerts.body.alerts.every((a) => a.delivered_at === null), 'все события пока недоставлены — доставку ведёт планировщик, а не панель');
  const notifications = await walk<{ notifications: Array<{ channel: string; notification_type: string; received: number; last_received_at: string }> }>('уведомления', 'GET', '/api/operator/notifications');
  assert.ok(notifications.body.notifications.length >= 1, 'на экране приёмника есть строки');
  const row = notifications.body.notifications[0]!;
  assert.ok(row.received >= 2 && row.last_received_at !== null,
    `приёмник показывает принятые уведомления по каналу и виду: получено ${row.received}`);
  /**
   * Столбца «разобрано» на экране нет намеренно (шаг 41, задача E): таблица приёмника хранит только разобранные
   * уведомления, и такой счётчик был бы равен «получено» всегда — тавтология на экране [Р-94].
   */
  assert.ok(!Object.hasOwn(row, 'processed'), 'экран не показывает счётчик, равный другому счётчику по определению');

  const jobs = await walk<{ jobs: Array<{ job_key: string; runs_completed: number }> }>('работы планировщика', 'GET', '/api/operator/jobs');
  assert.ok(jobs.body.jobs.length >= 8, `в каталоге работ ${jobs.body.jobs.length} строк — работы планировщика видны все, а не выборкой`);
  assert.ok(jobs.body.jobs.some((j) => j.runs_completed > 0), 'хотя бы одна работа уже отработала: экран показывает живой фон, а не пустую таблицу');
});

test('Р-168: остановленный планировщик виден на экране числом, а не уровнем отставания прошлого такта', async () => {
  // Планировщик демо останавливается — дальше мир не двигается, и панель обязана это показать
  demo?.stop();
  demo = null;

  /**
   * Работа, срок которой прошёл пять минут назад, и уровень отставания у неё — `OK`. Это НЕ выдумка: уровень ставит сам
   * планировщик в такте (0094), и у остановленного процесса он остаётся тем, каким был в последний раз. Экран, который
   * показывает только его, скажет «всё в порядке» ровно в том случае, ради которого панель и нужна.
   */
  await db.superuser(
    `INSERT INTO maintenance.scheduled_job (job_key, job_name, catch_up, interval_seconds, next_due_at, runs_completed, last_outcome, last_finished_at)
     VALUES ('snapshot-export-check', 'Snapshot export (Prüflauf)', 'LATEST', 60, now() - interval '5 minutes', 12, 'SUCCEEDED', now() - interval '6 minutes')`);

  const first = await walk<{ jobs: Array<{ job_key: string; overdue_seconds: number; lag_level: string }> }>('работы при остановленном планировщике', 'GET', '/api/operator/jobs');
  const worst = first.body.jobs[0]!;
  assert.equal(worst.job_key, 'snapshot-export-check', 'самая просроченная работа стоит первой: оператор видит её, не листая');
  assert.ok(worst.overdue_seconds >= 290, `экран называет просрочку числом: ${worst.overdue_seconds} с`);
  assert.equal(worst.lag_level, 'OK', 'а уровень отставания у неё по-прежнему OK — его ставит процесс, которого больше нет');

  // Число растёт по часам БАЗЫ, а не по отметке процесса: пока никто не работает, оно увеличивается само
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const second = await walk<{ jobs: Array<{ job_key: string; overdue_seconds: number }> }>('работы ещё через три секунды', 'GET', '/api/operator/jobs');
  const again = second.body.jobs.find((j) => j.job_key === 'snapshot-export-check')!;
  assert.ok(again.overdue_seconds > worst.overdue_seconds,
    `просрочка выросла с ${worst.overdue_seconds} до ${again.overdue_seconds} с: остановленный процесс виден по часам базы`);
});

test('Р-167: путь «завести пилота» — тенант, приглашение, письмо, приём, онбординг', async () => {
  const ownerEmail = `pilot-${randomUUID()}@example.test`;
  /**
   * Язык пилота называет ОПЕРАТОР [Р-161, находка 6 ревью шага 40]: до исправления у каждого пилота был немецкий, и
   * утверждение о языке письма проходило бы и у кода, который язык тенанта не читает вовсе. Здесь пилот английский.
   */
  const created = await walk<{ tenantId: string; locale: string }>('создать тенанта пилота', 'POST', '/api/operator/tenants',
    { body: { name: 'Pilot Händler GmbH', region: 'EU', ownerEmail, locale: 'en' } });
  assert.equal(created.status, 201, 'тенант создан');
  const tenantId = created.body.tenantId;

  const invited = await walk<{ invitationId: string; dryRun: boolean; mailRef: string }>('пригласить владельца', 'POST', `/api/operator/tenants/${tenantId}/invite`,
    { body: { email: ownerEmail } });
  assert.equal(invited.status, 201, 'приглашение выдано');
  /**
   * В прогоне письмо ПЕРЕХВАЧЕНО (`FakeMail`), поэтому сухого режима здесь нет и быть не должно: сухой режим — это
   * умолчание РАБОТЫ, где провайдера у проекта нет [OQ-224], и он проверяется конфигурацией процесса отдельно.
   */
  assert.equal(invited.body.dryRun, false, 'письмо ушло перехватчику прогона, а не в сухой режим');
  assert.match(invited.body.mailRef, /^fake-mail-/, 'у письма есть идентификатор отправки — доказательство, что оно СОБРАНО и отдано отправителю');

  /**
   * Письмо перехватывается не у отправителя, а у АУДИТА и базы: ни токена, ни текста письма панель не возвращает.
   * Поэтому проверяется то, что проверяемо снаружи: приглашение существует, оно на этот адрес, и его отпечаток — не
   * пустой. Само письмо собирается словарём и проверено отдельно (packages/alert-delivery).
   */
  /**
   * Приглашения читаются суперпользователем СТЕНДА: у административной роли прав на `platform.identity_invitation` нет
   * (их нет ни у кого, кроме роли входа), и это правильно — прогон смотрит на таблицу извне, как смотрел бы человек
   * с доступом к базе, а не притворяется, что панель их показывает.
   */
  const invitations = await db.rows<{ email: string; accepted_at: string | null }>(
    `SELECT u.email, i.accepted_at FROM platform.identity_invitation i JOIN platform.app_user u ON u.user_id = i.user_id
      WHERE i.invitation_id = $1`, [invited.body.invitationId]);
  assert.equal(invitations[0]?.email, ownerEmail, 'приглашение выдано на адрес владельца, а не на чей-то ещё');
  assert.equal(invitations[0]?.accepted_at, null, 'пока не принято');

  /**
   * Письмо ПЕРЕХВАЧЕНО и прочитано: тема называет тенанта, тело — ссылку приёма и срок. Токен живёт только здесь — ни
   * в ответе панели, ни в журнале, ни в базе (там его отпечаток).
   */
  const letters = mail.matching('Pilot Händler GmbH');
  assert.equal(letters.length, 1, 'ушло ровно одно письмо приглашения');
  const letter = letters[0]!;
  assert.equal(letter.to, ownerEmail, 'письмо адресовано владельцу пилота');
  assert.match(letter.subject, /invited as the owner/, 'письмо на английском: это язык ТЕНАНТА, названный при создании пилота [Р-161]');
  assert.doesNotMatch(letter.subject, /Einladung/, 'немецкого умолчания в письме нет: язык взят из базы, а не из константы');
  const link = /https:\/\/app\.repracer\.invalid\/invitation#([A-Za-z0-9_-]+)/.exec(letter.text);
  assert.ok(link, 'в письме есть ссылка приёма приглашения');
  const invitationToken = link[1]!;
  const fingerprint = await db.rows<{ same: boolean }>(
    'SELECT token_sha256 = $2 AS same FROM platform.identity_invitation WHERE invitation_id = $1',
    [invited.body.invitationId, createHash('sha256').update(invitationToken).digest()]);
  assert.equal(fingerprint[0]?.same, true, 'в базе лежит ОТПЕЧАТОК токена из письма, а не сам токен');

  /**
   * Владелец принимает приглашение у поставщика — это НЕ действие панели: панель приглашает, входит продавец сам
   * [Р-98]. Здесь начинается его собственный путь [Р-149], и панель в нём больше не участвует.
   */
  const acceptStarted = process.hrtime.bigint();
  // Приглашение принимает роль ВХОДА (`svc_authenticator`): привязку (издатель, субъект) создаёт только она [Р-98]
  const directory = new PgIdentityDirectory(db.pool('svc_authenticator') as never);
  const ownerSubject = `pilot-owner-${randomUUID()}`;
  const ownerUserId = await directory.acceptInvitation(invitationToken, { issuer: OPERATOR_ISSUER, subject: ownerSubject }, ownerEmail, true);
  journey.push({ step: 'владелец принял приглашение', method: 'IDP', url: 'security.accept_identity_invitation',
    seconds: Math.round(Number(process.hrtime.bigint() - acceptStarted) / 1e6) / 1000, status: 200 });
  assert.ok(ownerUserId, 'привязка входа владельца создана приёмом приглашения');
  const accepted = await db.rows<{ accepted_at: string | null }>(
    'SELECT accepted_at FROM platform.identity_invitation WHERE invitation_id = $1', [invited.body.invitationId]);
  assert.ok(accepted[0]?.accepted_at, 'приглашение отмечено принятым');

  const check = await db.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM tenant_data.membership m JOIN platform.external_identity e ON e.user_id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE' AND e.subject = $2`, [tenantId, ownerSubject]);
  assert.equal(check[0]?.n, 1, 'владелец пилота — активное членство с ПРИВЯЗАННЫМ входом: дальше он идёт своим онбордингом [Р-149]');

  /**
   * Второго приглашения тому же владельцу панель не выдаёт [Р-98, находка 7 ревью шага 40]: вход уже привязан, и это
   * перепривязка, а не заведение пилота. Отказ приходит от базы.
   */
  const again = await walk<{ code: string; message: string }>('пригласить владельца второй раз', 'POST', `/api/operator/tenants/${tenantId}/invite`,
    { body: { email: ownerEmail } });
  assert.equal(again.status, 403, 'повторное приглашение владельцу с привязанным входом отклонено');
  assert.match(again.body.message, /already has a linked sign-in/);

  const steps = await db.rows<{ step: string; done: boolean }>(
    'SELECT step, done FROM tenant_data.onboarding_status($1)', [tenantId]);
  assert.ok(steps.length > 0, 'онбординг пилота начат: шаги выведены из данных функцией базы [Р-149]');
  assert.ok(steps.some((s) => !s.done), 'первый незавершённый шаг у пилота есть: путь продавца только начинается');

  // Действия оператора видны в журнале панели [OQ-191] — с именем учётной записи, а не «система»
  const log = await walk<{ actions: Array<{ action: string; operator_id: string }> }>('журнал действий', 'GET', '/api/operator/actions');
  const mine = log.body.actions.filter((a) => a.operator_id === OPERATOR_ID);
  assert.ok(mine.some((a) => a.action === 'operator.tenant_created'), 'создание тенанта записано в аудит');
  assert.ok(mine.some((a) => a.action === 'operator.owner_invited'), 'приглашение владельца записано в аудит');
});

test('Р-166: две оставшиеся операции — алерт увиден и пропуск снимка разобран', async () => {
  const tenants = await walk<{ tenants: Array<{ tenant_id: string; demo: boolean }> }>('тенанты', 'GET', '/api/operator/tenants');
  const tenantId = tenants.body.tenants.find((t) => t.demo)!.tenant_id;

  /**
   * Событие поднимает ПРОЦЕСС, а не панель [Р-156], и завести его себе панель не может — здесь его вставляет
   * суперпользователь стенда, как это сделал бы путь решения. Пропуск снимка — так же: его пишет выгрузка.
   */
  // Событие берётся посеянное в `before` — панель события не создаёт [Р-166]
  const { alerts } = (await walk<{ alerts: Array<{ alert_id: string; acknowledged_at: string | null }> }>('алерты до отметки', 'GET', '/api/operator/alerts')).body;
  const alertId = alerts.find((a) => a.acknowledged_at === null)!.alert_id;
  const skipId = randomUUID();
  await db.superuser(
    `INSERT INTO maintenance.snapshot_export_skip (subject_tenant_id, competitor_snapshot_id, partition_name, received_at, reason)
     VALUES ($1, $2, 'competitor_snapshot_2026_09_26', now(), 'NO_PRICES')`, [tenantId, skipId]);


  const ack = await walk<{ acknowledged: string }>('отметить алерт увиденным', 'POST', `/api/operator/alerts/${alertId}/acknowledge`, { body: { tenantId } });
  assert.equal(ack.status, 200, 'алерт отмечен увиденным');
  const again = await walk<{ code: string; message: string }>('отметить его же второй раз', 'POST', `/api/operator/alerts/${alertId}/acknowledge`, { body: { tenantId } });
  assert.equal(again.status, 409, 'второй раз — отказ: «увидено» остаётся событием, а не счётчиком');
  assert.match(again.body.message, /already acknowledged/);

  const resolved = await walk<{ resolution: string }>('разобрать пропуск снимка', 'POST', `/api/operator/snapshot-skips/${skipId}/resolve`,
    { body: { resolution: 'LOSS_ACCEPTED', note: 'Синтетический пропуск прогона: снимок без цен, потеря принята' } });
  assert.equal(resolved.status, 200, 'пропуск разобран с заметкой [OQ-181]');

  const skips = await walk<{ skips: Array<{ competitor_snapshot_id: string; resolution: string | null; note: string | null }> }>('пропуски снимков', 'GET', '/api/operator/snapshot-skips');
  const skip = skips.body.skips.find((x) => x.competitor_snapshot_id === skipId);
  assert.equal(skip?.resolution, 'LOSS_ACCEPTED', 'экран показывает разбор рядом с пропуском');
  assert.match(skip?.note ?? '', /потеря принята/, 'заметка человека сохранена целиком');

  const log = await walk<{ actions: Array<{ action: string; entity_id: string }> }>('журнал после действий', 'GET', '/api/operator/actions');
  assert.ok(log.body.actions.some((a) => a.action === 'operator.alert_acknowledged' && a.entity_id === alertId), 'отметка алерта в аудите');
  assert.ok(log.body.actions.some((a) => a.action === 'operator.snapshot_skip_resolved' && a.entity_id === skipId), 'разбор пропуска в аудите');
});

test('Р-165, Р-166: чего панель не может — отказ приходит от базы, а не от интерфейса', async () => {
  const anonymous = await walk<{ code: string }>('без токена', 'GET', '/api/operator/tenants', { token: null });
  assert.equal(anonymous.status, 401, 'без входа панель не отвечает данными');

  // Настоящий токен настоящего человека, у которого НЕТ учётной записи оператора
  const stranger = issuer.token(`someone-${randomUUID()}`, { email: 'seller@example.test', amr: ['pwd', 'otp'] });
  const strangerAnswer = await walk<{ code: string }>('чужой вход', 'GET', '/api/operator/tenants', { token: stranger });
  assert.equal(strangerAnswer.status, 403, 'вход у поставщика — не пропуск в панель');
  assert.equal(strangerAnswer.body.code, 'NOT_AN_OPERATOR');

  // Тот же оператор, но без второго фактора: отказывает БАЗА, и её причина видна в ответе
  const single = issuer.token(OPERATOR_SUBJECT, { email: 'operator@repracer.invalid', amr: ['pwd'] });
  const weak = await walk<{ code: string; message: string }>('действие без второго фактора', 'POST', '/api/operator/tenants',
    { token: single, body: { name: 'Ohne zweiten Faktor', region: 'EU', ownerEmail: 'nobody@example.test' } });
  assert.equal(weak.status, 403);
  assert.match(weak.body.message, /needs a second factor/, 'причина — от стража базы [Р-94]');
  const notCreated = await db.rows<{ n: number }>(
    `SELECT count(*)::int AS n FROM tenant_data.tenant WHERE name = 'Ohne zweiten Faktor'`);
  assert.equal(notCreated[0]?.n, 0, 'тенант не создан: отказ — это отказ, а не предупреждение');

  /**
   * Задача D шага 40: цен, границ и остановок чужих тенантов в панели НЕТ. Это проверяется двумя способами сразу:
   * маршрутов не существует (здесь), а прав на таблицы нет у самой роли (tests/db/smoke_operator.sql) — второе
   * держит свойство даже если завтра кто-то допишет маршрут.
   */
  for (const path of ['/api/operator/price-stops', '/api/operator/bounds', '/api/operator/strategies']) {
    const answer = await walk<{ code: string }>(`маршрута ${path} нет`, 'POST', path, { body: { tenantId: randomUUID() } });
    assert.equal(answer.status, 404, `в панели нет маршрута ${path}: цены и границы продавца — не её дело [Р-166]`);
  }
});
