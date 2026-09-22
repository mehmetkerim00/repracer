import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createAlertDelivery } from '@repracer/alert-delivery';
import { FakeMail } from '@repracer/alert-delivery/testing';
import { createPool, PgAlertDeliveryStore, PgAlertSink, type PgPool } from '@repracer/pricing-store-pg';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { VirtualClock } from './harness/world.ts';
import { kauflandLiveWorld, type KauflandLiveWorld, type LiveProduct } from './live/kaufland-world.ts';

/**
 * Р-156 (шаг 36): алерт, который живёт только в базе, считается НЕдоставленным. Здесь проверяется ДОСТАВКА четырёх
 * событий: кому ушло письмо, о каком тенанте и канале, что в нём сказано человеческим языком и какое первое действие.
 * Письма перехватывает модель провайдера, как модель ClickHouse и модель очереди SQS.
 *
 * Честно о том, что здесь настоящее (находка 15 ревью шага 36): остановка человеком поднимается НАСТОЯЩИМ путём —
 * `pipeline.stopPricing`, тем же вызовом, что делает консоль. Остальные три события кладутся в хранилище алертов
 * вызовом — проверяется доставка, а не то, как они рождаются: рождение недоверия каналу проверяет
 * `write-queue.pg.test.ts`, блокировку единицы — `dispatcher-defects.pg.test.ts`, отставание выгрузки —
 * `scheduler-live.pg.test.ts`, где та же доставка идёт настоящей работой планировщика. Данные синтетические.
 */

/** Адрес владельца берётся из базы: мир засевает его со своим суффиксом, и выдумывать адрес нельзя */
let ownerEmail = '';
let db: IsolatedDatabase;
let k: KauflandLiveWorld;
let observer: PgPool;
let mail: FakeMail;
let delivery: ReturnType<typeof createAlertDelivery>;
let alertSink: PgAlertSink;

const products: LiveProduct[] = [1, 2].map((i) => ({
  cls: 'HOT' as const, idProduct: 362_500_000 + i, marketplace: 'de',
  behaviour: { kind: 'RANDOM_WALK' as const, everyMs: 30 * 60_000, volatilityBp: 100, minMinor: 1500, maxMinor: 2200 }, pastMovesEveryMinutes: 30, pricingMode: 'ENGINE' as const, costMinor: 900,
}));

before(async () => {
  db = await createIsolatedDatabase('alertdelivery');
  const clock = new VirtualClock(new Date(Date.now() - 4 * 3_600_000).toISOString());
  const pools = {
    appPool: db.pool('svc_app', 4), adminPool: db.pool('svc_admin', 2),
    provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 2),
  };
  alertSink = new PgAlertSink(pools.appPool);
  k = await kauflandLiveWorld({ tag: 3602, clock, products, seed: 3602, ...pools, alertSink });
  const url = new URL(process.env.REPRACER_PG_ADMIN_URL!); url.pathname = `/${db.name}`;
  observer = createPool(url.toString(), { max: 1, applicationName: 'repracer-alert-delivery-observer' });
  mail = new FakeMail();
  ownerEmail = String((await observer.query(
    `SELECT u.email FROM tenant_data.membership m JOIN platform.app_user u ON u.user_id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'OWNER' AND m.status = 'ACTIVE'`, [k.seeded.tenantId])).rows[0]!.email);
  delivery = createAlertDelivery({
    store: new PgAlertDeliveryStore(db.pool('svc_alert_delivery', 2)), mail, now: () => new Date().toISOString(),
    locale: 'de', operatorEmail: 'betrieb@example.invalid', digestSeconds: 3600,
  });
});

after(async () => {
  console.log(JSON.stringify({ letters: mail.sent.map((x) => ({ to: x.to, subject: x.subject })) }, null, 1));
  await observer?.end();
  await db?.drop();
});

/** Алерты тенанта в базе: что поднято и что доставлено — глазами наблюдателя, а не того, что проверяем */
async function alerts(): Promise<Array<{ code: string; severity: string; delivered: boolean; kind: string | null }>> {
  const { rows } = await observer.query(
    `SELECT code, severity, delivered_at IS NOT NULL AS delivered, delivery_kind FROM tenant_data.alert ORDER BY raised_at, code`);
  return rows.map((r) => ({ code: r.code, severity: r.severity, delivered: r.delivered, kind: r.delivery_kind ?? null }));
}

const lettersFor = (part: string) => mail.sent.filter((x) => x.text.includes(part) || x.subject.includes(part));

test('Р-156, сценарий 1: остановка цен человеком — письмо владельцу сразу, с автором действия в первом шаге', async () => {
  // Тот же вызов, что делает консоль продавца (`stand-server`: live.pipeline.stopPricing), но в идентификаторах базы
  const ctx = { tenantId: k.seeded.tenantId as never, channelAccountId: k.seeded.channelAccountId as never, correlationId: 'alerts-1', deadline: k.clock.iso() as never };
  // Kill switch [Р-69]: останавливает ВСЕ изменения цен тенанта; алерт поднимает сам путь решения
  const stopped = await k.pipelineForDbIds().stopPricing(ctx, {
    scope: 'TENANT', stoppedAt: new Date().toISOString(), stoppedByMembershipId: k.seeded.ownerMembershipId,
    stoppedByUserId: k.seeded.userId, note: 'Синтетическая остановка для проверки доставки алертов',
  } as never);
  assert.equal((stopped as { status: string }).status, 'STOPPED', JSON.stringify(stopped));

  // Алерт лежит в базе НЕдоставленным: пока письмо не ушло, событие считается недоставленным
  const raised = (await alerts()).filter((a) => a.code === 'PRICING_STOPPED_BY_PERSON');
  assert.deepEqual(raised, [{ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', delivered: false, kind: null }]);

  const outcome = await delivery.deliver();
  assert.equal(outcome.immediate, 1, `одно письмо немедленно: ${JSON.stringify(outcome)}`);
  const letter = mail.sent.at(-1)!;
  assert.equal(letter.to, ownerEmail, 'письмо ушло владельцу тенанта, а не кому попало');
  assert.match(letter.text, /Die Preispflege wurde von einer Person gestoppt/);
  assert.match(letter.text, /Erster Schritt: Waren Sie das nicht/);
  // И отметка доставки в базе: вид доставки назван
  assert.deepEqual((await alerts()).filter((a) => a.code === 'PRICING_STOPPED_BY_PERSON'),
    [{ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', delivered: true, kind: 'EMAIL_IMMEDIATE' }]);
});

test('Р-156, сценарий 2: недоверие каналу — письмо называет канал и говорит сравнить цену в кабинете', async () => {
  const ctx = { tenantId: k.world.tenantId as never, channelAccountId: k.world.channelAccountId as never, correlationId: 'alerts-2', deadline: k.clock.iso() as never };
  // Р-118: недоверие ставит система; здесь оно поднимается тем же вызовом, что и в пути решения при расхождении базы цены
  await alertSink.raise({
    code: 'PRICING_CHANNEL_DISTRUSTED', severity: 'CRITICAL', tenantId: k.seeded.tenantId as never,
    channelAccountId: k.seeded.channelAccountId as never, correlationId: ctx.correlationId,
    details: { marketplace: 'de', reason: 'PRICE_BASIS_MISMATCH' },
  });

  const before = mail.sent.length;
  const outcome = await delivery.deliver();
  assert.equal(outcome.immediate, 1, JSON.stringify(outcome));
  const letter = mail.sent[before]!;
  assert.equal(letter.to, ownerEmail);
  // Канал назван: у продавца их несколько, и «где-то не так» — не сообщение
  assert.match(letter.text, /Kanal: KAUFLAND \(de\)/);
  assert.match(letter.text, /Der Kanal zeigt einen anderen Preis als den gesendeten/);
  assert.match(letter.text, /Vergleichen Sie unseren Preis mit dem Preis im Kanal-Konto/);
});

test('Р-156, сценарий 3: отставание выгрузки — письмо ОПЕРАТОРУ платформы дайджестом, а не продавцу', async () => {
  // У платформенного события тенанта нет: ANALYTICS_EXPORT_BACKLOG поднимает работа планировщика без тенанта
  await alertSink.raise({ code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', details: { days: 2, oldestHours: 30 } });
  const platform = (await observer.query(`SELECT a.tenant_id, t.kind FROM tenant_data.alert a JOIN tenant_data.tenant t ON t.tenant_id = a.tenant_id WHERE a.code = 'ANALYTICS_EXPORT_BACKLOG'`)).rows[0]!;
  assert.equal(platform.kind, 'PLATFORM', 'платформенное событие лежит у платформенного тенанта, а не у продавца');

  // Свежий WARNING письма не вызывает: дайджест ждёт часа
  const before = mail.sent.length;
  assert.equal((await delivery.deliver()).digests, 0, 'свежий WARNING ждёт дайджеста');
  assert.equal(mail.sent.length, before, 'письма не было');

  // Час прошёл: дайджест уходит оператору
  const hourly = createAlertDelivery({
    store: new PgAlertDeliveryStore(db.pool('svc_alert_delivery', 1)), mail,
    now: () => new Date(Date.now() + 2 * 3_600_000).toISOString(), locale: 'de', operatorEmail: 'betrieb@example.invalid', digestSeconds: 3600,
  });
  const outcome = await hourly.deliver();
  assert.equal(outcome.digests, 1, JSON.stringify(outcome));
  const letter = mail.sent.at(-1)!;
  assert.equal(letter.to, 'betrieb@example.invalid', 'отставание выгрузки — дело оператора платформы, а не продавца');
  assert.match(letter.text, /Der Export der Wettbewerbshistorie ist im Rückstand \(ANALYTICS_EXPORT_BACKLOG\) — 1-mal/);
  assert.equal(lettersFor('Rückstand').filter((x) => x.to === ownerEmail).length, 0, 'продавцу об этом не пишут');
});

test('Р-156, сценарий 4: запись без итога дольше часа — единица блокируется, и письмо говорит, что делать', async () => {
  /**
   * Итог записи неизвестен дольше часа [transitions: unresolvedOutcomeLimitMs] — сверка прекращается, единица
   * блокируется до разбора человеком и поднимается CRITICAL с кодом OUTCOME_UNRESOLVED. Здесь это событие поднимается
   * тем же вызовом, что и в диспетчере: живой прогон такого случая идёт в `background-live` на виртуальных сутках.
   */
  await alertSink.raise({
    code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', tenantId: k.seeded.tenantId as never,
    channelAccountId: k.seeded.channelAccountId as never,
    details: { writeScopeId: 'ws-synthetic', reason: 'WRITE_SCOPE_BLOCKED', code: 'OUTCOME_UNRESOLVED' },
  });
  const before = mail.sent.length;
  const outcome = await delivery.deliver();
  assert.equal(outcome.immediate, 1, JSON.stringify(outcome));
  const letter = mail.sent[before]!;
  assert.match(letter.text, /Ein Angebot ist blockiert: Seine Preisänderung ging nicht durch/);
  assert.match(letter.text, /Öffnen Sie das Angebot in der Konsole/);

  // Итог всех четырёх сценариев: доставлено всё, что поднято, и каждому — свой вид доставки
  const all = await alerts();
  assert.equal(all.filter((a) => !a.delivered).length, 0, `недоставленных не осталось: ${JSON.stringify(all)}`);
  assert.deepEqual(all.filter((a) => a.severity === 'WARNING').map((a) => a.kind), ['EMAIL_DIGEST']);
  assert.ok(all.filter((a) => a.severity === 'CRITICAL').every((a) => a.kind === 'EMAIL_IMMEDIATE'), JSON.stringify(all));
});
