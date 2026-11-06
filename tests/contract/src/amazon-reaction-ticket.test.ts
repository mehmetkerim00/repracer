import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DEFAULT_JOB_CONFIG } from '@repracer/scheduler';
import { returnTicketFindings, type ReturnTicket } from './return-ticket.ts';

/**
 * Шаг 115.1 (решение владельца по докладу 115): на опросе [Р-240] цель Р-8 (p95 < 60 с на Amazon) не выполняется. Для пилота это временное
 * исключение, и разрыв записан явно: абзац в трёх документах и обратный билет в docs/deferred.md. Запись Р-8 не меняется: цель остаётся целью.
 * Цифры абзаца считаются из настоящего темпа работы `amazon-summary-poll`: другой темп — красная сборка, пока абзац не поправят. Когда уведомления
 * части Б дойдут и реакция будет замерена, AMAZON_REACTION_SECONDS станет целью: билет и абзац больше не нужны
 */
const { amazonBatch, amazonCallSeconds } = DEFAULT_JOB_CONFIG;
const roundSeconds = (offers: number) => Math.ceil(offers / amazonBatch) * amazonCallSeconds;
const roundMinutes = (offers: number) => Math.round(roundSeconds(offers) / 60);

const AMAZON_REACTION_TARGET_SECONDS = 60;
/** Поиск Amazon отдаёт не больше 1000 SKU (A-31): длиннее круг сейчас не бывает */
const AMAZON_REACTION_SECONDS = roundSeconds(1000);

const PROMISE = 'вернуть цель p95<60с после части Б';
const TICKET: ReturnTicket = { limit: AMAZON_REACTION_SECONDS, target: AMAZON_REACTION_TARGET_SECONDS, topic: 'Р-8/Amazon', promise: PROMISE };
const GAP = `реакция на движение конкурента на Amazon — в пределах круга опроса (~${roundMinutes(120)} мин на 120 предложений, ~${roundMinutes(1000)} мин на 1000); цель Р-8 возвращается с уведомлениями части Б`;

const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');

test('step 115.1 (owner decision): while Amazon reacts within the poll round, above the Р-8 target, the gap is written down and holds its return ticket', () => {
  assert.equal(AMAZON_REACTION_TARGET_SECONDS, 60);
  assert.ok(AMAZON_REACTION_SECONDS >= AMAZON_REACTION_TARGET_SECONDS, 'the reaction limit is never below its target');
  const deferred = read('docs/deferred.md');
  assert.deepEqual(returnTicketFindings(deferred, TICKET), []);
  if (AMAZON_REACTION_SECONDS > AMAZON_REACTION_TARGET_SECONDS) {
    for (const doc of ['docs/adr/0069-summary-poll-decides-amazon-prices.md', 'docs/channels/amazon.md', 'docs/pilot-readiness.md']) {
      assert.ok(read(doc).includes(GAP), `${doc} does not name the gap with the numbers of the current pace: «${GAP}»`);
    }
  }
  // Зубы [Р-94]: выше цели без строки — находка; строка с обещанием — нет; предел, равный цели, билета не требует
  assert.equal(returnTicketFindings(deferred.replaceAll(PROMISE, 'когда-нибудь'), TICKET).length, 1);
  assert.deepEqual(returnTicketFindings(`| 115.1 (Р-8/Amazon) | ${PROMISE} |`, TICKET), []);
  assert.deepEqual(returnTicketFindings('', { ...TICKET, limit: AMAZON_REACTION_TARGET_SECONDS }), []);
});
