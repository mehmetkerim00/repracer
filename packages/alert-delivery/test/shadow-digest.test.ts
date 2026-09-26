import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ShadowDigestTarget } from '@repracer/pricing-store-pg';
import { createShadowDigest, shadowDigestMessage } from '../src/shadow-digest.ts';
import { FakeMail } from '../src/testing.ts';
import { messagesFor } from '@repracer/console-model';

/**
 * Р-171 (шаг 41), Р-173 и Р-174 (шаг 42): недельный дайджест теневого режима. Проверяется не «функция вызвана», а ТЕКСТ
 * письма: те же числа, что на экране, на языке ТЕНАНТА [Р-161], с деньгами по каждой валюте отдельно [Р-71] и без
 * обещания заработка; плюс отметка доставки — второе письмо за тот же период не уходит. Данные синтетические.
 */

/** Хранилище дайджеста в памяти: строка периода, отметка доставки и её провал — как в базе [Р-174] */
function memoryDigestStore(targets: ShadowDigestTarget[]) {
  const rows = new Map<string, { digestId: string; deliveredKind: string | null; ref: string | null; error: string | null; attempts: number }>();
  let seq = 0;
  return {
    rows,
    async targets() { return targets; },
    async record(t: ShadowDigestTarget) {
      const key = `${t.tenantId}|${t.periodStart}`;
      const existing = rows.get(key);
      // Р-174: «строка есть» и «письмо доставлено» — разные вещи; повтор смотрит на отметку, а не на строку
      if (existing) return { digestId: existing.digestId, alreadyRecorded: true, delivered: existing.deliveredKind !== null };
      seq += 1;
      const digestId = `digest-${seq}`;
      rows.set(key, { digestId, deliveredKind: null, ref: null, error: null, attempts: 0 });
      return { digestId, alreadyRecorded: false, delivered: false };
    },
    async markDelivered(_tenantId: string, digestId: string, delivery: { kind: 'EMAIL_DIGEST' | 'DRY_RUN'; ref: string | null }) {
      for (const row of rows.values()) {
        if (row.digestId === digestId) { row.deliveredKind = delivery.kind; row.ref = delivery.ref; row.attempts += 1; }
      }
    },
    async markFailed(_tenantId: string, digestId: string, error: string) {
      for (const row of rows.values()) {
        if (row.digestId === digestId) { row.error = error; row.attempts += 1; }
      }
    },
  };
}

const target = (over: Partial<ShadowDigestTarget> = {}): ShadowDigestTarget => ({
  tenantId: '00000000-0000-4000-8000-000000000001', tenantName: 'Händler Nord', locale: 'de',
  ownerEmail: 'owner@example.test', shadowAccounts: 1,
  decisions: 1440, changes: 212, floorHeld: 37, ceilingHeld: 4,
  heldWrites: 216, heldPriceWrites: 212, heldQuantityWrites: 4, wouldSpendBudget: 4,
  floorSavings: [{ currency: 'EUR', minor: 4500 }], floorSavingsHolds: 30,
  periodStart: '2026-09-19T09:00:00.000Z', periodEnd: '2026-09-26T09:00:00.000Z', ...over,
});

test('шаг 41: письмо несёт ТЕ ЖЕ числа, что экран, и ни одной цены', () => {
  const m = messagesFor('de');
  const letter = shadowDigestMessage(target(), 'owner@example.test', m);
  assert.match(letter.subject, /Händler Nord/, 'тема называет тенанта');
  for (const n of ['1440', '212', '37', '216']) {
    assert.ok(letter.text.includes(n), `в письме есть число ${n}`);
  }
  /**
   * Шаг 42 [Р-173]: деньги в письме ЕСТЬ — ровно одна сумма, разница цен по валюте. Цены предложений в нём по-прежнему
   * нет: роль доставки их не видит, и сумма приходит готовым агрегатом.
   */
  assert.match(letter.text, /45,00\s?€/, 'сумма «на сколько дешевле» названа с валютой [Р-71]');
  assert.equal(letter.text.match(/€/g)?.length, 1, 'в письме РОВНО одна сумма: цен предложений в нём нет');
  assert.doesNotMatch(letter.text, /verdient|Gewinn von|hätten Sie verdient/, 'заработка письмо не обещает');
  assert.match(letter.text, /keine Umsatzprognose/, 'рядом с числом стоит оговорка: это не прогноз выручки');
  assert.match(letter.text, /Schattenmodus/, 'письмо говорит, о каком режиме речь');
});

test('шаг 41: язык письма — язык ТЕНАНТА, и оба языка дают одни и те же числа', () => {
  const de = shadowDigestMessage(target({ locale: 'de' }), 'x@example.test', messagesFor('de'));
  const en = shadowDigestMessage(target({ locale: 'en' }), 'x@example.test', messagesFor('en'));
  assert.match(de.subject, /getan hätte/);
  assert.match(en.subject, /would have done/);
  const numbers = (text: string) => text.match(/\d+/g)?.join(',') ?? '';
  assert.equal(numbers(de.text), numbers(en.text), 'числа в обоих письмах одни и те же: перевод не считает заново');
});

test('шаг 41: тихому тенанту письмо не уходит, а тенант без владельца назван числом', async () => {
  const mail = new FakeMail();
  const store = memoryDigestStore([target(), target({ tenantId: 'quiet', decisions: 0, changes: 0, heldWrites: 0, heldPriceWrites: 0, heldQuantityWrites: 0, wouldSpendBudget: 0 }), target({ tenantId: 'orphan', ownerEmail: null })]);
  const digest = createShadowDigest({ store, mail, now: () => new Date().toISOString(), log: () => undefined });
  const outcome = await digest.send();
  assert.deepEqual(outcome, { letters: 1, quiet: 1, noRecipient: 1, failed: 0, alreadySent: 0 });
  assert.equal(mail.sent.length, 1, 'ушло одно письмо: тихий тенант и тенант без владельца писем не получают');
});

test('шаг 41: сбой провайдера считается провалом и не роняет работу', async () => {
  const mail = new FakeMail();
  mail.failNext = 1;
  const store = memoryDigestStore([target(), target({ tenantId: 'second' })]);
  const digest = createShadowDigest({ store, mail, now: () => new Date().toISOString(), log: () => undefined });
  const outcome = await digest.send();
  assert.equal(outcome.failed, 1, 'первый провал посчитан');
  assert.equal(outcome.letters, 1, 'второе письмо всё равно ушло: один сбой не отменяет отчёт остальным');
  // Р-174: у провалившегося письма отметки доставки НЕТ, а причина записана — «не ушло» видно запросом, а не по журналу
  const failed = [...store.rows.values()].find((r) => r.error !== null);
  assert.ok(failed, 'провал доставки записан строкой периода');
  assert.equal(failed.deliveredKind, null, 'письмо, которое не ушло, доставленным не считается');
});

test('шаг 42 [Р-174]: письмо, которое НЕ ушло, повторяется на следующем прогоне — строка есть, отметки нет', async () => {
  const mail = new FakeMail();
  mail.failNext = 1;
  const store = memoryDigestStore([target()]);
  const digest = createShadowDigest({ store, mail, now: () => new Date().toISOString(), log: () => undefined });
  const first = await digest.send();
  assert.deepEqual([first.letters, first.failed], [0, 1], 'первый прогон: провайдер отказал, письмо не ушло');
  const second = await digest.send();
  assert.deepEqual([second.letters, second.alreadySent], [1, 0], 'второй прогон ОТПРАВИЛ письмо: недельный отчёт не теряется');
  const row = [...store.rows.values()][0];
  assert.equal(row?.deliveredKind, 'EMAIL_DIGEST', 'отметка доставки стоит после успешной попытки');
  assert.equal(row?.attempts, 2, 'обе попытки посчитаны');
});

test('шаг 42 [Р-174]: второе письмо за тот же период не уходит — оно уже ДОСТАВЛЕНО', async () => {
  const mail = new FakeMail();
  const store = memoryDigestStore([target()]);
  const digest = createShadowDigest({ store, mail, now: () => new Date().toISOString(), log: () => undefined });
  const first = await digest.send();
  const second = await digest.send();
  assert.equal(first.letters, 1, 'первый прогон отправил письмо');
  assert.deepEqual([second.letters, second.alreadySent], [0, 1], 'второй прогон не отправил ничего и сказал это числом');
  assert.equal(mail.sent.length, 1, 'у провайдера ровно одно письмо');
});

test('шаг 42 [Р-174]: сухой режим отмечается ТРЕТЬИМ видом, а не «доставлено»', async () => {
  const mail = new FakeMail();
  mail.dry = true;
  const store = memoryDigestStore([target()]);
  const digest = createShadowDigest({ store, mail, now: () => new Date().toISOString(), log: () => undefined });
  await digest.send();
  const row = [...store.rows.values()][0];
  assert.equal(row?.deliveredKind, 'DRY_RUN', 'письмо собрано целиком и не ушло никуда: отметка говорит это прямо');
});

test('шаг 42 [Р-173]: без удержаний пола строки про деньги в письме нет', () => {
  const letter = shadowDigestMessage(target({ floorSavings: [] }), 'x@example.test', messagesFor('de'));
  assert.doesNotMatch(letter.text, /€/, '«на 0,00 € дешевле» не пишется: такая строка приучает не читать письмо');
});

test('шаг 42 [Р-71]: суммы двух валют не складываются', () => {
  const letter = shadowDigestMessage(target({ floorSavings: [{ currency: 'EUR', minor: 4500 }, { currency: 'USD', minor: 1200 }] }),
    'x@example.test', messagesFor('en'));
  assert.match(letter.text, /45\.00/, 'сумма в евро названа');
  assert.match(letter.text, /12\.00/, 'сумма в долларах названа отдельно');
});
