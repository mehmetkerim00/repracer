import type { ImportPreview } from '@repracer/cost-import';
import type { Messages } from './i18n/index.ts';
import { FEED_PAGE_MAX, priceFeed } from './price-feed.ts';
import type { FeedQuery } from './price-feed.ts';
import { scopeById, unitOf, type StandWorld } from './world.ts';

/**
 * Р-142 (шаг 31): то, что продавец уносит ФАЙЛОМ. Экран показывает выдержку — первые строки и итоги; файл содержит всё, и
 * именно с ним продавец идёт работать: правит выгрузку поставщика, отвечает проверяющему, сверяет ленту цен за период.
 *
 * Файлы готовит фоновое задание [Р-139] и кладёт в базу: ответ экрана на десятки мегабайт бесполезен, а ссылка на адрес API
 * не работает вовсе — браузер по ней не шлёт токен [Р-142]. Забирает файл консольный клиент запросом с токеном.
 */

/** Значение, начинающееся с = + - @ или табуляции, электронная таблица выполнит как формулу — префикс апострофом */
const quote = (raw: string): string => {
  const v = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  `${[header.join(','), ...rows.map((r) => r.map(quote).join(','))].join('\n')}\n`;

/**
 * Отчёт об импорте себестоимости [Р-134]: КАЖДАЯ строка, которая не применилась, с её причиной. Экран показывает по пять
 * примеров на причину — на выгрузке в 10 000 строк с 1430 несопоставленными (замер шага 28) продавец по экрану не поймёт,
 * какие именно строки чинить. Причина названа на языке продавца, номер строки — как в его файле.
 */
export function costImportReportCsv(preview: ImportPreview, m: Messages): string {
  const t = m.ui.costImport;
  const header = ['line', 'offer_key', 'raw_value', 'problem', 'problem_text'];
  const rows: string[][] = preview.skipped.map((r) => [
    String(r.line), r.offerKey, r.raw ?? '', r.problem ?? '',
    (r.problem ? t.problems[r.problem as keyof typeof t.problems] : undefined) ?? r.problem ?? '',
  ]);
  return csv(header, rows);
}

/**
 * Выгрузка ленты цен [Р-136]: что мы отправляли каналу за период и что с этим стало. Экран отдаёт страницу не больше 200
 * записей — за 30 суток по каталогу их сотни тысяч, и по страницам их не читают. Строки — те же, что на экране, в том же
 * порядке: файл не должен расходиться с тем, что продавец видел.
 */
export function priceFeedRowsOf(world: StandWorld, m: Messages, query: FeedQuery): string[][] {
  const total = priceFeed(world, m, { ...query, offset: 0, limit: 1 }).page.total;
  const rows: string[][] = [];
  /**
   * Лента отдаётся страницами и здесь — но страницы берутся ОДНИМ проходом, а не пересчётом ленты на каждую. `priceFeed`
   * фильтрует и сортирует всю ленту при каждом вызове: спрашивать у него тысячу страниц значит отсортировать ленту тысячу раз
   * (находка 1 ревью шага 31).
   */
  for (let offset = 0; offset < total; offset += FEED_PAGE_MAX) {
    for (const i of priceFeed(world, m, { ...query, offset, limit: FEED_PAGE_MAX }).items) {
      rows.push([
        i.at, i.unit?.channel ?? '', i.unit?.marketplace ?? '', i.unit?.externalUnitId ?? '',
        i.from ?? '', i.to, i.change ?? '', i.status, i.source,
        i.reason?.text ?? '', i.decisionId ?? '',
      ]);
    }
  }
  return rows;
}

export const PRICE_FEED_CSV_HEADER = ['at', 'channel', 'marketplace', 'offer', 'price_from', 'price_to', 'change', 'status', 'source', 'reason', 'decision_id'];

/**
 * Выгрузка ленты цен [Р-136]: что мы отправляли каналу за период и что с этим стало. Экран отдаёт страницу не больше 200
 * записей — за 30 суток по каталогу их сотни тысяч, и по страницам их не читают. Строки — те же, что на экране, в том же
 * порядке: файл не должен расходиться с тем, что продавец видел.
 */
export function priceFeedCsv(world: StandWorld, m: Messages, query: FeedQuery): string {
  return csv(PRICE_FEED_CSV_HEADER, priceFeedRowsOf(world, m, query));
}

/** Готовые строки в CSV — для сборки файла частями, с отдачей цикла событий между ними */
export function csvOf(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return csv(header, rows);
}

/** Сколько строк в выгрузке ленты — чтобы задание назвало объём, не собирая файл дважды */
export function priceFeedRows(world: StandWorld, m: Messages, query: FeedQuery): number {
  return priceFeed(world, m, { ...query, offset: 0, limit: 1 }).page.total;
}

/** Имя файла ленты: период и предложение видно, не открывая файл */
export function priceFeedFileName(world: StandWorld, m: Messages, query: FeedQuery): string {
  const scope = query.writeScopeId ? scopeById(world, query.writeScopeId) : undefined;
  const offer = scope ? unitOf(world, scope, m).externalUnitId : 'all-offers';
  return `price-feed_${query.days ?? 'all'}d_${offer}.csv`;
}
