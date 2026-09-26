import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BoundsView, DecisionTrace, ShadowView } from '@repracer/console-model';
import type { StandToken } from '../src/api-types.ts';
import { STAND_AUDIENCE, STAND_ISSUER, type LiveWorld } from '@repracer/contract-tests/stand';
import { amazonLiveWorld, VirtualClock, type AmazonLiveWorld } from '@repracer/contract-tests/live';
import { createAuthenticator, MemoryIdentityDirectory, staticJwks } from '@repracer/identity';
import { createTestIssuer } from '@repracer/identity/test-issuer';
import { createShadowDigest } from '@repracer/alert-delivery/shadow-digest';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { PgPricingStore, PgShadowDigestStore, PgShadowStore, PgStockStore, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { createStandApi, createStandServer } from '../server/stand-server.ts';

/**
 * Р-172, Р-173 (шаг 42): ВИТРИНА США живым прогоном через консоль [Р-136, Р-142].
 *
 * Что здесь проверяется и почему именно прогоном, а не тестом хранилища:
 *   1) продавец из ЕС торгует на amazon.com: цена в ДОЛЛАРАХ и НЕТТО [Р-58], себестоимость в ЕВРО, и пол маржи считается
 *      через курс ЕЦБ [Р-61]. Сценарий шага 9 был тестом хранилища; теперь он идёт через экраны;
 *   2) у amazon.com НЕ ИЗВЕСТНА граница суток [Р-65, A-03], поэтому боевой режим база не включает — а тень работает.
 *      Это и есть Р-172 в действии: неизвестное свойство держит запись, не показ;
 *   3) дайджест тени на английском несёт ДОЛЛАРЫ [Р-173] — суммы по каждой валюте отдельно [Р-71].
 *
 * Данные синтетические: модель порта Amazon [Р-113], конкуренты и товары сгенерированы.
 */

const WORLD = 'us/amazon';
/** amazon.com [Р-56]: идентификатор витрины подтверждён документацией SP-API (снимок 2026-09-16) */
const US_MARKETPLACE = 'ATVPDKIKX0DER';
const VIRTUAL_HOURS = Number(process.env.REPRACER_US_HOURS ?? 2);
const OFFERS = 40;
const SCREEN_LIMIT_SECONDS = 10;

let db: IsolatedDatabase;
let world: AmazonLiveWorld;
let clock: VirtualClock;
let server: Server;
let origin = '';
let owner: { authorization: string; cookie: string };
let observer: PgPool;
let deliveryPool: PgPool;
const mail = new FakeMail();
const measured: Array<{ operation: string; seconds: number; status: number }> = [];
const numbers: Record<string, unknown> = {};

const api = (screen: string, param?: string) => `/api/worlds/${encodeURIComponent(WORLD)}/${screen}${param ? `/${param}` : ''}`;

async function call<T>(operation: string, method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; body: T; seconds: number }> {
  const started = process.hrtime.bigint();
  const r = await fetch(`${origin}${url}`, {
    method,
    headers: { authorization: owner.authorization, cookie: owner.cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  const seconds = Math.round(Number(process.hrtime.bigint() - started) / 1e6) / 1000;
  measured.push({ operation, seconds, status: r.status });
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T, seconds };
}

async function signIn(): Promise<void> {
  const token = await fetch(`${origin}/api/stand-issuer/token?locale=en`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'OWNER' }) });
  owner = { authorization: `Bearer ${((await token.json()) as StandToken).accessToken}`, cookie: 'repracer_locale=en' };
}

/**
 * Ход мира. Решения на Amazon ведут УВЕДОМЛЕНИЯ, а не опрос: `getCompetitiveSummary` — 0,033 запроса в секунду с
 * всплеском 1 [док], поллинг конкурентов невозможен в принципе [Р-46, жёсткие ограничения Amazon]. Поэтому такт — это
 * `betweenTicks()`: приёмник разбирает снимки ANY_OFFER_CHANGED, срок доставки которых наступил, и каждый из них идёт
 * настоящим путём решения [Р-128].
 *
 * Рядом — ОДИН опрос на такт: он держит утверждение «тень читает канал по-настоящему» [Р-171] и не нарушает предел
 * канала (один вызов на пять виртуальных минут против разрешённых 0,033 в секунду).
 */
async function advance(hours: number): Promise<void> {
  const pipeline = world.pipelineForDbIds();
  const endMs = clock.nowMs() + hours * 3_600_000;
  while (clock.nowMs() < endMs) {
    const ctx = { tenantId: world.seeded.tenantId, channelAccountId: world.seeded.channelAccountId, correlationId: 'us-shadow', deadline: clock.iso(120_000) };
    /**
     * Опрос идёт ПАКЕТОМ по всем предложениям: `getCompetitiveSummary` принимает до 20 ASIN в запросе (модель,
     * `CompetitiveSummaryRequestList.maxItems` — AMZ_C11), и ограничитель считает ЗАПРОСЫ, а не товары. Отказ
     * ограничителя — нормальный исход такта, а не ошибка прогона: он и есть жёсткое ограничение канала.
     */
    await pipeline.pollCompetitors(ctx as never,
      world.asins.map((asin) => ({ marketplace: US_MARKETPLACE, channelProductRef: asin, condition: 'new' })) as never,
      { delivery: 'POLL' } as never);
    await clock.sleep(5 * 60_000);
    await world.betweenTicks();
  }
}

before(async () => {
  db = await createIsolatedDatabase('usshadow');
  const appPool: PgPool = db.pool('svc_app', 4);
  const adminPool: PgPool = db.pool('svc_admin', 4);
  deliveryPool = db.pool('svc_alert_delivery', 1);
  clock = new VirtualClock(new Date(Date.now() - 3_600_000).toISOString());
  world = await amazonLiveWorld({
    // Конкурент двигает цену каждые 15 виртуальных минут: за час это даёт видимые предложения без единой записи
    tag: 4200, clock, offers: OFFERS, seed: 4200, lossShare: 0, priceChangeEveryHours: 0.25,
    us: true, engine: true, writeMode: 'SHADOW',
    appPool, adminPool, provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
    fxLoaderPool: db.pool('svc_fx_loader', 1),
  });
  const seeded = world.seeded;
  const store = new PgPricingStore(appPool, { adminPool, bulkWorkerPool: db.pool('svc_bulk_worker', 2) });
  const nowIso = () => clock.iso();
  const accounts = [{ channelAccountId: seeded.channelAccountId, channel: 'AMAZON', marketplaces: [US_MARKETPLACE], haltRelease: 'MANUAL_ONLY' as const }];
  const live: LiveWorld = {
    id: WORLD, title: 'amazon.com в тени', description: `${OFFERS} предложений в USD`, tenantId: seeded.tenantId,
    accounts, identityTenantId: seeded.tenantId, membershipAlias: (id) => id, failures: [],
    store: store as never, shadow: new PgShadowStore({ adminPool }),
    stock: new PgStockStore({ adminPool, stockPool: db.pool('svc_stock', 2) }),
    pipeline: world.pipelineForDbIds() as never, clock: { iso: nowIso, nowMs: () => clock.nowMs() } as never,
    callContext: (channelAccountId) => ({ tenantId: seeded.tenantId as never, channelAccountId: channelAccountId as never, correlationId: 'us-shadow', deadline: nowIso() }),
    view: async (viewer) => ({
      id: WORLD, title: 'amazon.com в тени', description: `${OFFERS} предложений в USD`, tenantId: seeded.tenantId, now: nowIso(),
      accounts, viewer: { ...viewer }, state: await store.readConsoleState(seeded.tenantId, nowIso() as never),
    }) as never,
  };
  const directory = new MemoryIdentityDirectory();
  directory.link({ issuer: STAND_ISSUER, subject: 'us-owner' }, seeded.userId);
  directory.addMembership(seeded.userId, { tenantId: seeded.tenantId, membershipId: seeded.ownerMembershipId, role: 'OWNER' });
  const issuer = createTestIssuer({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE });
  server = createStandServer(createStandApi([live], {
    authenticator: createAuthenticator({ issuer: STAND_ISSUER, audience: STAND_AUDIENCE, jwks: staticJwks(issuer.jwks), directory }),
    // Второй фактор ЕСТЬ: отказ включения боя должен приходить от свойства витрины, а не от отсутствия фактора [Р-99]
    simulator: { token: () => issuer.token('us-owner', { email: 'owner@example.invalid', amr: ['pwd', 'otp'] }), expiresInSeconds: 3600 },
  }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await signIn();
  // Язык тенанта — английский: письмо про доллары уходит по-английски [Р-161]
  await adminPool.query(`SELECT set_config('app.tenant_id', $1, false)`, [seeded.tenantId]);
  const observerUrl = new URL(process.env.REPRACER_PG_ADMIN_URL!); observerUrl.pathname = `/${db.name}`;
  const { createPool } = await import('@repracer/pricing-store-pg');
  observer = createPool(observerUrl.toString(), { max: 1, applicationName: 'repracer-us-shadow-observer' });
  await observer.query(`UPDATE tenant_data.tenant SET locale = 'en' WHERE tenant_id = $1`, [seeded.tenantId]);
});

after(async () => {
  console.log(JSON.stringify({ us: { virtualHours: VIRTUAL_HOURS, numbers, operations: measured } }, null, 1));
  server?.close();
  await observer?.end();
  await db?.drop();
});

test('Р-172: у amazon.com не известна граница суток — бой закрыт, тень работает', async () => {
  const screen = await call<ShadowView>('экран тени', 'GET', `${api('shadow')}?offset=0&limit=50`);
  assert.equal(screen.status, 200, JSON.stringify(screen.body));
  assert.ok(screen.seconds < SCREEN_LIMIT_SECONDS, `экран тени: ${screen.seconds} с`);

  const properties = screen.body.properties;
  const unknown = properties.filter((p) => p.blocksLive);
  Object.assign(numbers, {
    properties: properties.map((p) => ({ marketplace: p.marketplace, property: p.propertyText, value: p.valueText, status: p.statusText, closesBy: p.closesByText, question: p.question })),
  });
  assert.equal(properties.length, 3, 'экран называет все три свойства витрины (Р-172)');
  assert.equal(unknown.length, 1, `ровно одно свойство неизвестно: ${JSON.stringify(unknown.map((p) => p.propertyText))}`);
  assert.match(unknown[0]!.propertyText, /Day boundary/, 'неизвестна граница суток');
  assert.equal(unknown[0]!.question, 'A-03', 'вопрос назван кодом');
  assert.match(unknown[0]!.closesByText, /shadow closes it/, 'закрывает его ТЕНЬ: чтение канала без записи');
  assert.ok(screen.body.liveBlockedText !== null, 'экран говорит про закрытый бой ДО нажатия кнопки');

  // Включение боя владельцем со вторым фактором и верным подтверждением — отказ по свойству витрины
  const { rows: [acc] } = await observer.query(`SELECT external_account_id FROM tenant_data.channel_account WHERE channel_account_id = $1`, [world.seeded.channelAccountId]);
  const live = await call<{ error: { code: string; message: string } }>('включить бой на amazon.com', 'POST', api('shadow', 'mode'),
    { channelAccountId: world.seeded.channelAccountId, toMode: 'LIVE', typedConfirmation: acc!.external_account_id });
  assert.equal(live.status, 409, `бой на витрине с неизвестным свойством: ${JSON.stringify(live.body)}`);
  assert.equal(live.body.error.code, 'PROPERTY_UNKNOWN');
  assert.match(live.body.error.message, /Day boundary|day boundary/i, 'отказ называет СВОЙСТВО, а не «нельзя»');
  Object.assign(numbers, { liveRefusal: live.body.error.message });
});

test('Р-172, Р-61: движок работает в долларах, пол маржи — из себестоимости в евро через курс ЕЦБ', async () => {
  const started = Date.now();
  await advance(VIRTUAL_HOURS);
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  measured.push({ operation: `${VIRTUAL_HOURS} виртуальных часа в тени (amazon.com)`, seconds, status: 200 });

  const { rows: [d] } = await observer.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE shadow)::int AS shadowed,
            count(DISTINCT currency)::int AS currencies, min(currency) AS currency
       FROM channel_data.price_decision WHERE tenant_id = $1`, [world.seeded.tenantId]);
  Object.assign(numbers, { decisions: Number(d!.n), shadowDecisions: Number(d!.shadowed), currency: d!.currency, seconds,
    // Если решений нет — причина видна в журнале мира, а не в догадках: прогон печатает её сам
    worldLog: world.events.slice(0, 6), portStats: world.port.stats });
  assert.ok(Number(d!.n) > 0, `решений за ${VIRTUAL_HOURS} виртуальных часа: ${d!.n}`);
  assert.equal(Number(d!.shadowed), Number(d!.n), 'все решения витрины США помечены тенью');
  assert.equal(Number(d!.currencies), 1, 'валюта решений одна');
  assert.equal(d!.currency, 'USD', 'решения приняты в ДОЛЛАРАХ: валюта — свойство единицы записи [Р-57]');

  // К каналу за это время не ушло ни одного изменяющего запроса: тень [Р-169]
  const applied = await observer.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND final_status = 'APPLIED'`, [world.seeded.tenantId]);
  const held = await observer.query(
    `SELECT count(*)::int AS n FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND final_status = 'SHADOW_HELD'`, [world.seeded.tenantId]);
  Object.assign(numbers, { appliedWrites: Number(applied.rows[0]!.n), heldWrites: Number(held.rows[0]!.n), patchCalls: world.port.stats.patchCalls });
  assert.equal(Number(applied.rows[0]!.n), 0, 'ни одна запись не применена каналом');
  assert.equal(world.port.stats.patchCalls, 0, 'модель Amazon не получила НИ ОДНОГО patchListingsItem');
  // Тень ЧИТАЕТ по-настоящему [Р-171]: ноль чтений означал бы, что конвейер просто стоял
  Object.assign(numbers, { summaryCalls: world.port.stats.summaryCalls, eventsDelivered: world.port.stats.eventsDelivered });
  assert.ok(world.port.stats.summaryCalls > 0, `чтений конкурентов у канала: ${world.port.stats.summaryCalls}`);
  assert.ok(Number(held.rows[0]!.n) > 0, `записей удержано тенью: ${held.rows[0]!.n}`);

  // Экран границ: пол маржи посчитан из себестоимости в ЕВРО по курсу ЕЦБ, и показан В ДОЛЛАРАХ [Р-61, Р-71]
  const { rows: [scope] } = await observer.query(
    `SELECT write_scope_id FROM tenant_data.write_scope WHERE tenant_id = $1 AND field = 'PRICE' ORDER BY created_at LIMIT 1`, [world.seeded.tenantId]);
  const bounds = await call<BoundsView>('экран границ', 'GET', api('bounds', scope!.write_scope_id as string));
  assert.equal(bounds.status, 200, JSON.stringify(bounds.body));
  Object.assign(numbers, { marginFloor: bounds.body.marginFloor, effectiveFloor: bounds.body.effectiveFloor });
  assert.ok(bounds.body.marginFloor.amount !== null, `пол маржи посчитан: ${JSON.stringify(bounds.body.marginFloor)}`);
  assert.match(bounds.body.marginFloor.amount, /\$/, 'пол маржи показан в ДОЛЛАРАХ, хотя себестоимость в евро');

  // «Почему эта цена»: все шаги решения и суммы в долларах
  const { rows: [decision] } = await observer.query(
    `SELECT price_decision_id FROM channel_data.price_decision WHERE tenant_id = $1 AND outcome = 'APPROVED' ORDER BY decided_at DESC LIMIT 1`, [world.seeded.tenantId]);
  assert.ok(decision, 'есть решение, изменившее цену: иначе объяснять нечего');
  const why = await call<DecisionTrace>('почему эта цена', 'GET', api('decisions', decision!.price_decision_id as string));
  assert.equal(why.status, 200, JSON.stringify(why.body));
  const text = JSON.stringify(why.body);
  assert.match(text, /\$/, 'суммы объяснения — в долларах');
  /**
   * Евро в объяснении витрины США есть РОВНО в одном месте и это главное доказательство Р-61: себестоимость объявлена в
   * евро, и экран показывает сам перевод — «€5.00 → $5.50». Валюта не домыслена: обе названы [Р-71], и курс виден
   * продавцу, а не спрятан в решении.
   */
  const conversion = /€\s?[\d.,]+\s?→\s?\$\s?[\d.,]+/.exec(text.replaceAll('\\u20ac', '€'));
  assert.ok(conversion, `экран показывает перевод себестоимости курсом ЕЦБ: ${text.slice(0, 400)}`);
  Object.assign(numbers, { costConversion: conversion[0] });
  Object.assign(numbers, { whySteps: why.body.steps.length, whySeconds: why.seconds });
  assert.ok(why.body.steps.length >= 5, `шагов объяснения: ${why.body.steps.length}`);
});

test('Р-173: недельный дайджест по-английски несёт ДОЛЛАРЫ и не обещает заработка', async () => {
  const digest = createShadowDigest({ store: new PgShadowDigestStore(deliveryPool), mail, now: () => clock.iso(), log: () => undefined });
  const outcome = await digest.send();
  Object.assign(numbers, { digest: outcome });
  assert.equal(outcome.letters, 1, `писем: ${JSON.stringify(outcome)}`);
  const letter = mail.sent[0]!;
  Object.assign(numbers, { digestSubject: letter.subject, digestText: letter.text });
  assert.match(letter.subject, /would have done/, 'письмо по-английски: язык — свойство тенанта [Р-161]');
  assert.doesNotMatch(letter.text, /€/, 'евро в письме витрины США нет');
  const savings = /\$\d+[.,]\d{2}/.exec(letter.text);
  assert.ok(savings, `в письме есть сумма в долларах: ${letter.text}`);
  assert.match(letter.text, /not a forecast of revenue/, 'рядом с суммой — оговорка: это не прогноз выручки');

  // Р-174: у письма есть отметка доставки, и второй раз оно не уходит
  const { rows: [row] } = await observer.query(
    `SELECT delivered_at, delivery_kind, floor_savings FROM tenant_data.shadow_digest WHERE tenant_id = $1`, [world.seeded.tenantId]);
  assert.ok(row?.delivered_at, 'отметка доставки стоит');
  Object.assign(numbers, { digestDelivery: { kind: row!.delivery_kind, savings: row!.floor_savings } });
  const again = await digest.send();
  assert.deepEqual([again.letters, again.alreadySent], [0, 1], 'второе письмо за тот же период не уходит [Р-174]');
});
