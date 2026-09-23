import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlertDeliveryStore, AlertRecipient, AlertRow } from '@repracer/pricing-store-pg';
import { createAlertDelivery } from '../src/index.ts';
import { FakeMail } from '../src/testing.ts';
import { createDryMailSender } from '@repracer/service-runtime';

/**
 * Р-156 (шаг 36): правило доставки — CRITICAL письмом немедленно, WARNING часовым дайджестом. Здесь проверяется само
 * правило на модели хранилища; на настоящей базе и настоящих событиях — `tests/contract/src/alert-delivery.pg.test.ts`.
 */

class MemoryAlertStore implements AlertDeliveryStore {
  readonly rows: AlertRow[] = [];
  readonly delivered = new Map<string, { kind: string; ref: string }>();
  readonly failures = new Map<string, string>();
  /** Имя, адрес владельца и язык тенанта, как их отдаёт база [Р-161]; тенанта, которого здесь нет, база не отдаёт */
  readonly tenants = new Map<string, AlertRecipient>([
    ['t-1', { name: 'Synthetischer Händler', email: 'inhaber@example.invalid', locale: 'de' }],
    ['platform-tenant', { name: 'repracer Betrieb', email: null, locale: 'de' }],
  ]);
  /** Сколько раз спрашивали получателей: заход доставки обязан укладываться в один запрос на уровень [Р-161] */
  recipientCalls = 0;

  add(row: Partial<AlertRow> & Pick<AlertRow, 'code' | 'severity' | 'raisedAt'>): AlertRow {
    const full: AlertRow = {
      tenantId: row.tenantId ?? 't-1', alertId: row.alertId ?? `a-${this.rows.length + 1}`, code: row.code, severity: row.severity,
      channelAccountId: row.channelAccountId ?? null, channel: row.channel ?? null, marketplaces: row.marketplaces ?? [],
      details: row.details ?? {}, raisedAt: row.raisedAt, deliveryAttempts: 0,
    };
    this.rows.push(full);
    return full;
  }

  async undelivered(severity: 'WARNING' | 'CRITICAL', limit: number, before: string): Promise<AlertRow[]> {
    return this.rows.filter((r) => r.severity === severity && !this.delivered.has(r.alertId) && r.raisedAt <= before)
      .sort((a, b) => a.raisedAt.localeCompare(b.raisedAt)).slice(0, limit);
  }

  async recipients(tenantIds: readonly string[]): Promise<Map<string, AlertRecipient>> {
    this.recipientCalls += 1;
    const out = new Map<string, AlertRecipient>();
    for (const id of tenantIds) {
      const known = this.tenants.get(id);
      if (known) out.set(id, { ...known });
    }
    return out;
  }

  async platformTenantId(): Promise<string> { return 'platform-tenant'; }

  async markDelivered(_tenantId: string, alertIds: readonly string[], kind: 'EMAIL_IMMEDIATE' | 'EMAIL_DIGEST', ref: string): Promise<number> {
    let n = 0;
    for (const id of alertIds) if (!this.delivered.has(id)) { this.delivered.set(id, { kind, ref }); n += 1; }
    return n;
  }

  async markFailed(_tenantId: string, alertIds: readonly string[], error: string): Promise<void> {
    for (const id of alertIds) this.failures.set(id, error);
  }
}

const NOW = '2026-09-23T12:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();

/**
 * Язык задаётся ТЕНАНТУ, а не доставке [Р-161]: `locale` доставке здесь не передаётся вовсе, и умолчание у неё
 * немецкое — значит английское письмо в прогоне ниже может взяться только из строки тенанта.
 */
function harness(tenantLocale: 'de' | 'en' = 'de') {
  const store = new MemoryAlertStore();
  store.tenants.set('t-1', { ...store.tenants.get('t-1')!, locale: tenantLocale });
  const mail = new FakeMail();
  const delivery = createAlertDelivery({ store, mail, now: () => NOW, digestSeconds: 3600, operatorEmail: 'betrieb@example.invalid' });
  return { store, mail, delivery };
}

test('Р-156: CRITICAL уходит письмом СРАЗУ, и письмо называет тенанта, канал, причину и первое действие', async () => {
  const h = harness();
  h.store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1), channel: 'KAUFLAND', marketplaces: ['de', 'at'] });
  const outcome = await h.delivery.deliver();

  assert.deepEqual([outcome.immediate, outcome.delivered, outcome.digests, outcome.failed], [1, 1, 0, 0]);
  assert.equal(h.mail.sent.length, 1);
  const letter = h.mail.sent[0]!;
  assert.equal(letter.to, 'inhaber@example.invalid');
  // Тенант — в теме и в теле: владелец нескольких аккаунтов должен понять, о каком речь
  assert.match(letter.subject, /Synthetischer Händler/);
  assert.match(letter.text, /Verkäuferkonto: Synthetischer Händler/);
  assert.match(letter.text, /Kanal: KAUFLAND \(de, at\)/);
  // Причина — человеческим языком, и рядом КОД события: им продавец ссылается на событие в поддержке [находка 4 ревью шага 36]
  assert.match(letter.text, /Die Preispflege wurde von einer Person gestoppt/);
  assert.match(letter.text, /Ereigniscode: PRICING_STOPPED_BY_PERSON \(bitte bei Rückfragen nennen\)/);
  // И первое действие: письмо без него заставляет искать, что делать
  assert.match(letter.text, /Erster Schritt: Waren Sie das nicht/);
});

test('Р-156: WARNING ждёт часа и уходит ОДНИМ дайджестом на тенанта, с числом событий каждого вида', async () => {
  const h = harness();
  // События платформы: их получатель — оператор, и дайджест у него свой
  const platform = { tenantId: 'platform-tenant' as const };
  // Два события часовой давности и одно свежее: дайджест уходит, когда самому старому исполнился час
  h.store.add({ ...platform, code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', raisedAt: ago(70) });
  h.store.add({ ...platform, code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', raisedAt: ago(65) });
  h.store.add({ ...platform, code: 'SCHEDULER_JOB_LAGGING', severity: 'WARNING', raisedAt: ago(61) });
  const outcome = await h.delivery.deliver();

  assert.deepEqual([outcome.digests, outcome.delivered, outcome.immediate], [1, 3, 0]);
  const letter = h.mail.sent[0]!;
  assert.match(letter.subject, /3 Ereignisse der letzten Stunde/);
  assert.match(letter.text, /Die Ausfuhr der Wettbewerbshistorie nach ClickHouse ist im Rückstand \(ANALYTICS_EXPORT_BACKLOG\) — 2-mal/);
  assert.match(letter.text, /Eine periodische Arbeit läuft ihrem Zeitplan hinterher \(SCHEDULER_JOB_LAGGING\) — 1-mal/);
});

test('Р-156: свежий WARNING письма не вызывает — иначе дайджест превращается в письмо на каждое событие', async () => {
  const h = harness();
  h.store.add({ code: 'NOTIFICATION_LATE', severity: 'WARNING', raisedAt: ago(5) });
  const outcome = await h.delivery.deliver();
  assert.deepEqual([outcome.digests, outcome.delivered, h.mail.sent.length], [0, 0, 0]);
  // И событие осталось НЕдоставленным: это видно запросом, а не на слово
  assert.equal((await h.store.undelivered('WARNING', 10, NOW)).length, 1);
});

test('Р-156: письмо, которое не ушло, доставленным не считается — попытка записана, событие остаётся в очереди', async () => {
  const h = harness();
  h.store.add({ code: 'PRICING_CHANNEL_DISTRUSTED', severity: 'CRITICAL', raisedAt: ago(1), channel: 'KAUFLAND', marketplaces: ['de'] });
  h.mail.failNext = 1;
  const first = await h.delivery.deliver();
  assert.deepEqual([first.delivered, first.failed, h.mail.sent.length], [0, 1, 0]);
  assert.equal([...h.store.failures.values()][0], 'MAIL_PROVIDER_UNAVAILABLE');

  // Следующий заход доставляет то же событие: очередь не потеряла его
  const second = await h.delivery.deliver();
  assert.deepEqual([second.immediate, second.delivered, second.failed], [1, 1, 0]);
  assert.match(h.mail.sent[0]!.text, /Der Kanal zeigt einen anderen Preis als den gesendeten/);
});

test('Р-156: тенант без активного владельца — письмо слать некому, и событие честно остаётся недоставленным', async () => {
  const h = harness();
  h.store.tenants.set('t-1', { ...h.store.tenants.get('t-1')!, email: null });
  h.store.add({ code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', raisedAt: ago(1) });
  const outcome = await h.delivery.deliver();
  assert.deepEqual([outcome.delivered, outcome.failed, h.mail.sent.length], [0, 1, 0]);
  assert.equal([...h.store.failures.values()][0], 'NO_OWNER_EMAIL');
});

test('Р-161: язык письма — язык ТЕНАНТА из базы, а не умолчание доставки', async () => {
  const h = harness('en');
  h.store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1) });
  await h.delivery.deliver();
  assert.match(h.mail.sent[0]!.text, /pricing is stopped by a person/);
  assert.match(h.mail.sent[0]!.text, /First step: If this was not you/);
  // И это именно ЯЗЫК, а не отдельный текст: немецкой фразы того же события в письме нет
  assert.ok(!h.mail.sent[0]!.text.includes('Die Preispflege wurde'), `письмо целиком на языке тенанта: ${h.mail.sent[0]!.text}`);
});

test('Р-161: язык, которого нет в словаре консоли, даёт умолчание, а не письмо из кодов', async () => {
  const h = harness();
  // База держит список языков ограничением (0124), но доставка не верит ему на слово: словарь — её собственность [Р-72]
  h.store.tenants.set('t-1', { ...h.store.tenants.get('t-1')!, locale: 'fr' });
  h.store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1) });
  await h.delivery.deliver();
  assert.match(h.mail.sent[0]!.text, /Die Preispflege wurde von einer Person gestoppt/);
});

test('Р-161: у каждого тенанта СВОЙ язык в одном заходе, и получатели читаются одним запросом', async () => {
  const h = harness();
  // Два продавца, два языка: если бы язык брался у доставки, оба письма были бы одинаковыми
  h.store.tenants.set('t-2', { name: 'Synthetic Trader', email: 'owner@example.invalid', locale: 'en' });
  h.store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(2) });
  h.store.add({ tenantId: 't-2', code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1) });
  const before = h.store.recipientCalls;
  const outcome = await h.delivery.deliver();

  assert.deepEqual([outcome.immediate, outcome.delivered, outcome.failed], [2, 2, 0]);
  const de = h.mail.sent.find((x) => x.to === 'inhaber@example.invalid')!;
  const en = h.mail.sent.find((x) => x.to === 'owner@example.invalid')!;
  assert.match(de.text, /Verkäuferkonto: Synthetischer Händler/);
  assert.match(de.text, /Die Preispflege wurde von einer Person gestoppt/);
  assert.match(en.text, /Seller account: Synthetic Trader/);
  assert.match(en.text, /pricing is stopped by a person/);
  // Р-161: получателей спрашивают один раз на уровень важности, а не по разу на тенанта и тем более не на событие
  assert.equal(h.store.recipientCalls - before, 2, 'два запроса получателей: CRITICAL и WARNING, независимо от числа тенантов');
});

test('Р-156: событие ПЛАТФОРМЫ уходит оператору, а не владельцу продавца — у платформенного тенанта продавца нет', async () => {
  const store = new MemoryAlertStore();
  const mail = new FakeMail();
  const delivery = createAlertDelivery({ store, mail, now: () => NOW, operatorEmail: 'betrieb@example.invalid' });
  store.add({ tenantId: 'platform-tenant', code: 'ANALYTICS_EXPORT_FAILED', severity: 'CRITICAL', raisedAt: ago(2) });
  store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(2) });
  const outcome = await delivery.deliver();

  assert.equal(outcome.immediate, 2, 'два письма: одно оператору, одно владельцу');
  assert.deepEqual(mail.sent.map((x) => x.to).sort(), ['betrieb@example.invalid', 'inhaber@example.invalid']);
  /**
   * И адресаты не перепутаны: у каждого письма СВОЙ код события. Первая редакция принимала любое из двух совпадений
   * (`match(/ANALYTICS_EXPORT_FAILED|Export/)`) — такое утверждение зеленеет, даже если письмо вообще о другом
   * (находка 10 ревью шага 36); теперь ожидание одно, и оно проверяет обе стороны обмена.
   */
  const toOperator = mail.sent.find((x) => x.to === 'betrieb@example.invalid')!;
  const toOwner = mail.sent.find((x) => x.to === 'inhaber@example.invalid')!;
  assert.match(toOperator.text, /Ereigniscode: ANALYTICS_EXPORT_FAILED \(bitte bei Rückfragen nennen\)/);
  assert.match(toOwner.text, /Ereigniscode: PRICING_STOPPED_BY_PERSON \(bitte bei Rückfragen nennen\)/);
  assert.ok(!toOwner.text.includes('ANALYTICS_EXPORT_FAILED'), `платформенное событие владельцу продавца не уходит: ${toOwner.text}`);
  /**
   * И письмо оператора написано ЕГО голосом [находка 3 ревью шага 36]: первое действие — то, что делает оператор, а не
   * «от вас пока ничего не требуется, мы тоже это видим», адресованное человеку, который как раз и есть «мы».
   */
  assert.match(toOperator.text, /Erster Schritt: Prüfen Sie zuerst die Erreichbarkeit von ClickHouse/);
  assert.ok(!/Von Ihnen ist/.test(toOperator.text), `платформенный текст написан голосом продавца: ${toOperator.text}`);
});

/**
 * Шаг 37, задача D (OQ-224): провайдера нет — письмо СОБИРАЕТСЯ и не уходит. Это третье состояние, и оно названо в
 * базе своим видом: не «доставлено» (неправда) и не «недоставлено» (потеряли бы то, что событие разобрано).
 */
test('сухой режим: письмо собрано, не отправлено, и отметка говорит это прямо (OQ-224)', async () => {
  const store = new MemoryAlertStore();
  store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1) });
  const lines: string[] = [];
  const delivery = createAlertDelivery({ store, mail: createDryMailSender((line) => lines.push(line)), now: () => NOW, operatorEmail: 'betrieb@example.invalid' });
  const outcome = await delivery.deliver();

  assert.equal(outcome.delivered, 1, 'событие разобрано и отмечено');
  assert.deepEqual([...store.delivered.values()].map((d) => d.kind), ['DRY_RUN'], 'вид отметки — сухой прогон, а не письмо');
  assert.equal(lines.length, 1, 'о каждом несостоявшемся письме остаётся строка журнала');
  const logged = JSON.parse(lines[0]!) as { code: string; details: Record<string, number> };
  assert.equal(logged.code, 'MAIL_DRY_RUN');
  assert.ok(logged.details.textLength > 100, `текст письма СОБРАН целиком: ${logged.details.textLength} знаков`);
  // Ни получателя, ни тела в журнале: всухую они такие же настоящие, как в работе
  assert.doesNotMatch(lines[0]!, /@/, 'адрес получателя в журнал не попадает');
});
