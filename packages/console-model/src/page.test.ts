import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messagesFor } from './i18n/index.ts';
import { LIST_PAGE_DEFAULT, LIST_PAGE_MAX, pageOf, parseListQuery } from './page.ts';

/** Р-136 (шаг 29): страницы списков. Каталог целевого клиента в один ответ не помещается — экран отдаёт страницу. */

const m = messagesFor('de');
const items = Array.from({ length: 10_000 }, (_, i) => i);
const q = (search: string) => parseListQuery(new URLSearchParams(search));

test('Р-136: страница из запроса — только десятичные числа и не больше предела', () => {
  assert.deepEqual(q(''), { offset: 0, limit: LIST_PAGE_DEFAULT }, 'без параметров — первая страница по умолчанию');
  assert.deepEqual(q('offset=50&limit=25'), { offset: 50, limit: 25 });
  assert.equal(q(`limit=${LIST_PAGE_MAX + 1}`), null, 'страница больше предела — отказ, а не молчаливая выдача каталога');
  assert.equal(q('limit=0'), null);
  assert.equal(q('offset=-1'), null);
  // Ревью шага 29, находка 14: «0x10» и «1e3» — не номера страниц
  for (const bad of ['offset=0x10', 'limit=1e3', 'offset=1.5', 'limit=abc', 'offset= 1']) assert.equal(q(bad), null, bad);
});

test('Р-136: страница показывает свой кусок и говорит, сколько всего', () => {
  const first = pageOf(items, { offset: 0, limit: 50 }, m);
  assert.deepEqual([first.items[0], first.items.at(-1), first.items.length], [0, 49, 50]);
  assert.deepEqual([first.page.from, first.page.to, first.page.total, first.page.hasPrevious, first.page.hasNext], [1, 50, 10_000, false, true]);
  const second = pageOf(items, { offset: 50, limit: 50 }, m);
  assert.deepEqual([second.items[0], second.page.from, second.page.hasPrevious], [50, 51, true], 'вторая страница продолжает первую');
});

test('Р-136: страница за концом списка показывает последнюю, а не пустоту с кнопкой «назад»', () => {
  // Ревью шага 29, находка 13: было «10001–10000 из 10000» и активная кнопка «назад»
  const beyond = pageOf(items, { offset: 99_999, limit: 50 }, m);
  assert.deepEqual([beyond.items.length, beyond.page.from, beyond.page.to, beyond.page.hasNext], [50, 9951, 10_000, false]);
  const empty = pageOf([], { offset: 0, limit: 50 }, m);
  assert.deepEqual([empty.items.length, empty.page.from, empty.page.to, empty.page.total, empty.page.hasPrevious, empty.page.hasNext], [0, 0, 0, 0, false, false]);
  // Последняя страница неполного списка: 10 000 строк по 300 — остаток 100
  const tail = pageOf(items, { offset: 9_900, limit: 300 }, m);
  assert.deepEqual([tail.items.length, tail.page.from, tail.page.to], [100, 9901, 10_000]);
});
