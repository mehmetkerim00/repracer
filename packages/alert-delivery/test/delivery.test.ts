import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AlertDeliveryStore, AlertRow } from '@repracer/pricing-store-pg';
import { createAlertDelivery } from '../src/index.ts';
import { FakeMail } from '../src/testing.ts';

/**
 * Р-156 (шаг 36): правило доставки — CRITICAL письмом немедленно, WARNING часовым дайджестом. Здесь проверяется само
 * правило на модели хранилища; на настоящей базе и настоящих событиях — `tests/contract/src/alert-delivery.pg.test.ts`.
 */

class MemoryAlertStore implements AlertDeliveryStore {
  readonly rows: AlertRow[] = [];
  readonly delivered = new Map<string, { kind: string; ref: string }>();
  readonly failures = new Map<string, string>();
  owner: string | null = 'inhaber@example.invalid';

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

  async ownerEmail(): Promise<string | null> { return this.owner; }
  async platformTenantId(): Promise<string> { return 'platform-tenant'; }
  async tenantName(): Promise<string> { return 'Synthetischer Händler'; }

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

function harness(locale: 'de' | 'en' = 'de') {
  const store = new MemoryAlertStore();
  const mail = new FakeMail();
  const delivery = createAlertDelivery({ store, mail, now: () => NOW, locale, digestSeconds: 3600 });
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
  // Причина — человеческим языком, без кода события в теле письма
  assert.match(letter.text, /Die Preispflege wurde von einer Person gestoppt/);
  assert.ok(!letter.text.includes('PRICING_STOPPED_BY_PERSON'), `код события в письме продавцу не нужен: ${letter.text}`);
  // И первое действие: письмо без него заставляет искать, что делать
  assert.match(letter.text, /Erster Schritt: Waren Sie das nicht/);
});

test('Р-156: WARNING ждёт часа и уходит ОДНИМ дайджестом на тенанта, с числом событий каждого вида', async () => {
  const h = harness();
  // Два события часовой давности и одно свежее: дайджест уходит, когда самому старому исполнился час
  h.store.add({ code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', raisedAt: ago(70) });
  h.store.add({ code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', raisedAt: ago(65) });
  h.store.add({ code: 'SCHEDULER_JOB_FAILING', severity: 'WARNING', raisedAt: ago(61) });
  const outcome = await h.delivery.deliver();

  assert.deepEqual([outcome.digests, outcome.delivered, outcome.immediate], [1, 3, 0]);
  const letter = h.mail.sent[0]!;
  assert.match(letter.subject, /3 Ereignisse der letzten Stunde/);
  assert.match(letter.text, /Der Export der Wettbewerbshistorie ist im Rückstand \(ANALYTICS_EXPORT_BACKLOG\) — 2-mal/);
  assert.match(letter.text, /Eine periodische Arbeit scheitert wiederholt \(SCHEDULER_JOB_FAILING\) — 1-mal/);
});

test('Р-156: свежий WARNING письма не вызывает — иначе дайджест превращается в письмо на каждое событие', async () => {
  const h = harness();
  h.store.add({ code: 'ANALYTICS_EXPORT_BACKLOG', severity: 'WARNING', raisedAt: ago(5) });
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
  h.store.owner = null;
  h.store.add({ code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', raisedAt: ago(1) });
  const outcome = await h.delivery.deliver();
  assert.deepEqual([outcome.delivered, outcome.failed, h.mail.sent.length], [0, 1, 0]);
  assert.equal([...h.store.failures.values()][0], 'NO_OWNER_EMAIL');
});

test('Р-156: язык письма — язык словаря консоли [Р-72]: то же событие по-английски', async () => {
  const h = harness('en');
  h.store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(1) });
  await h.delivery.deliver();
  assert.match(h.mail.sent[0]!.text, /pricing is stopped by a person/);
  assert.match(h.mail.sent[0]!.text, /First step: If this was not you/);
});

test('Р-156: событие ПЛАТФОРМЫ уходит оператору, а не владельцу продавца — у платформенного тенанта продавца нет', async () => {
  const store = new MemoryAlertStore();
  const mail = new FakeMail();
  const delivery = createAlertDelivery({ store, mail, now: () => NOW, locale: 'de', operatorEmail: 'betrieb@example.invalid' });
  store.add({ tenantId: 'platform-tenant', code: 'ANALYTICS_EXPORT_FAILED', severity: 'CRITICAL', raisedAt: ago(2) });
  store.add({ code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', raisedAt: ago(2) });
  const outcome = await delivery.deliver();

  assert.equal(outcome.immediate, 2, 'два письма: одно оператору, одно владельцу');
  assert.deepEqual(mail.sent.map((x) => x.to).sort(), ['betrieb@example.invalid', 'inhaber@example.invalid']);
  // И адресаты не перепутаны: платформенное событие — оператору
  assert.match(mail.sent.find((x) => x.to === 'betrieb@example.invalid')!.text, /ANALYTICS_EXPORT_FAILED|Export/);
});
