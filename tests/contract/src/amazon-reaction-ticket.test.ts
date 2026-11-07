import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { summaryRounds } from '@repracer/pricing-pipeline';
import { DEFAULT_JOB_CONFIG } from '@repracer/scheduler';
import { returnTicketFindings, type ReturnTicket } from './return-ticket.ts';

/**
 * Шаг 115.1 (решение владельца по докладу 115): на опросе [Р-240] цель Р-8 (p95 < 60 с на Amazon) не выполняется. Для пилота это временное
 * исключение, и разрыв записан явно: абзац в трёх документах и обратный билет в docs/deferred.md. Запись Р-8 не меняется: цель остаётся целью.
 * Цифры абзаца считаются из настоящего темпа работы `amazon-summary-poll`: другой темп — красная сборка, пока абзац не поправят. Когда уведомления
 * части Б дойдут и реакция будет замерена, AMAZON_REACTION_SECONDS станет целью: билет и абзац больше не нужны.
 *
 * Шаг 117 (P0-16, решение владельца 2026-11-07): каталог обнаруживается отчётом, предела в 1 000 SKU больше нет — и исключение сформулировано заново. Часы
 * допустимы только для предложений, которым данные конкурента не нужны; метрика — круг КОНКУРЕНТНОЙ части; абзац называет обе цифры — круг конкурентной
 * части и полный круг — по формуле окна опроса (`summaryRounds`). Предел реакции — порог WARNING конкурентного круга: дольше — стоп-доклад
 */
const { amazonBatch, amazonCallSeconds, amazonRoundWarnMinutes } = DEFAULT_JOB_CONFIG;
const rounds = (competitive: number, other: number) => summaryRounds({ competitive, other, batch: amazonBatch, intervalSeconds: amazonCallSeconds });
const minutes = (seconds: number) => Math.round(seconds / 60);

const AMAZON_REACTION_TARGET_SECONDS = 60;
/** Цель пилота — конкурентная часть в пределах часа (порог AMAZON_SUMMARY_ROUND_SLOW); сильно больше — стоп-доклад владельцу */
const AMAZON_REACTION_SECONDS = amazonRoundWarnMinutes * 60;

const PROMISE = 'вернуть цель p95<60с после части Б';
const TICKET: ReturnTicket = { limit: AMAZON_REACTION_SECONDS, target: AMAZON_REACTION_TARGET_SECONDS, topic: 'Р-8/Amazon', promise: PROMISE };
const GAP = `реакция на движение конкурента на Amazon — в пределах круга конкурентной части опроса: предложения, чью цену решает конкурент, читаются первыми, остальным — малая доля каждого окна `
  + `(~${minutes(rounds(1000, 0).competitiveSeconds)} мин на 1000 таких, ~${minutes(rounds(1000, 9000).competitiveSeconds)} мин, если рядом ещё 9000 остальных); `
  + `часы — только у предложений, которым данные конкурента не нужны (полный круг такого каталога — ~${Math.round(rounds(1000, 9000).fullSeconds / 3600)} ч); `
  + `цель пилота — конкурентная часть в пределах ~${amazonRoundWarnMinutes} мин, сильно больше — стоп-доклад; цель Р-8 возвращается с уведомлениями части Б`;

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
