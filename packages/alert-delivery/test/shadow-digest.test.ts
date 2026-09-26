import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ShadowDigestTarget } from '@repracer/pricing-store-pg';
import { createShadowDigest, shadowDigestMessage } from '../src/shadow-digest.ts';
import { FakeMail } from '../src/testing.ts';
import { messagesFor } from '@repracer/console-model';

/**
 * Р-171 (шаг 41): недельный дайджест теневого режима. Проверяется не «функция вызвана», а ТЕКСТ письма: те же числа, что
 * на экране, на языке ТЕНАНТА [Р-161], без единой цены и без обещания заработка. Данные синтетические.
 */

const target = (over: Partial<ShadowDigestTarget> = {}): ShadowDigestTarget => ({
  tenantId: '00000000-0000-4000-8000-000000000001', tenantName: 'Händler Nord', locale: 'de',
  ownerEmail: 'owner@example.test', shadowAccounts: 1,
  decisions: 1440, changes: 212, floorHeld: 37, ceilingHeld: 4,
  heldWrites: 216, heldPriceWrites: 212, heldQuantityWrites: 4, wouldSpendBudget: 4, ...over,
});

test('шаг 41: письмо несёт ТЕ ЖЕ числа, что экран, и ни одной цены', () => {
  const m = messagesFor('de');
  const letter = shadowDigestMessage(target(), 'owner@example.test', m);
  assert.match(letter.subject, /Händler Nord/, 'тема называет тенанта');
  for (const n of ['1440', '212', '37', '216']) {
    assert.ok(letter.text.includes(n), `в письме есть число ${n}`);
  }
  assert.doesNotMatch(letter.text, /€|EUR|\d+,\d{2}\s?€/, 'цен в письме нет: роль доставки их не видит');
  assert.doesNotMatch(letter.text, /verdient|Gewinn von|hätten Sie verdient/, 'заработка письмо не обещает');
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
  const digest = createShadowDigest({
    store: { async targets() { return [target(), target({ tenantId: 'quiet', decisions: 0, changes: 0, heldWrites: 0, heldPriceWrites: 0, heldQuantityWrites: 0, wouldSpendBudget: 0 }), target({ tenantId: 'orphan', ownerEmail: null })]; } },
    mail, now: () => new Date().toISOString(), log: () => undefined,
  });
  const outcome = await digest.send();
  assert.deepEqual(outcome, { letters: 1, quiet: 1, noRecipient: 1, failed: 0 });
  assert.equal(mail.sent.length, 1, 'ушло одно письмо: тихий тенант и тенант без владельца писем не получают');
});

test('шаг 41: сбой провайдера считается провалом и не роняет работу', async () => {
  const mail = new FakeMail();
  mail.failNext = 1;
  const digest = createShadowDigest({
    store: { async targets() { return [target(), target({ tenantId: 'second' })]; } },
    mail, now: () => new Date().toISOString(), log: () => undefined,
  });
  const outcome = await digest.send();
  assert.equal(outcome.failed, 1, 'первый провал посчитан');
  assert.equal(outcome.letters, 1, 'второе письмо всё равно ушло: один сбой не отменяет отчёт остальным');
});
