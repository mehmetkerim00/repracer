import type { Messages } from './i18n/index.ts';
import { feedItemOf, type FeedQuery } from './price-feed.ts';
import type { FeedPageItem } from '@repracer/pricing-pipeline';
import { scopeById, unitOf, type StandWorld } from './world.ts';

/**
 * Р-142 (шаг 31): то, что продавец уносит ФАЙЛОМ. Экран показывает выдержку — первые строки и итоги; файл содержит всё, и
 * именно с ним продавец идёт работать: правит выгрузку поставщика, отвечает проверяющему, сверяет ленту цен за период.
 *
 * Файлы готовит фоновое задание [Р-139] и кладёт в базу: ответ экрана на десятки мегабайт бесполезен, а ссылка на адрес API
 * не работает вовсе — браузер по ней не шлёт токен [Р-142]. Забирает файл консольный клиент запросом с токеном.
 */

/**
 * Значение, начинающееся с = + - @ или табуляции, электронная таблица выполнит как формулу — префикс апострофом. Шаг 104 [Р-229]: кроме
 * числа без локали («-12.5»): формулой оно не бывает, а с апострофом стало бы текстом и не считалось бы
 */
const quote = (raw: string): string => {
  const v = /^[=+\-@\t\r]/.test(raw) && !/^-?\d+(\.\d+)?$/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const csv = (header: readonly string[], rows: readonly (readonly string[])[]): string =>
  `${[header.join(','), ...rows.map((r) => r.map(quote).join(','))].join('\n')}\n`;

/**
 * Выгрузка ленты цен [Р-136]: что мы отправляли каналу за период и что с этим стало. Экран отдаёт страницу не больше 200
 * записей — за 30 суток по каталогу их сотни тысяч, и по страницам их не читают. Строки — те же, что на экране, в том же
 * порядке: файл не должен расходиться с тем, что продавец видел.
 */
export function priceFeedRowsOf(world: StandWorld, m: Messages, items: readonly FeedPageItem[]): string[][] {
  // Р-154: страницы ленты обработчик берёт у хранилища по очереди; здесь — только строки из уже полученной страницы
  return items.map((item) => {
    const i = feedItemOf(world, m, item);
    return [
      i.at, i.unit?.channel ?? '', i.unit?.marketplace ?? '', i.unit?.externalUnitId ?? '',
      i.from ?? '', i.to, i.change ?? '', i.status, i.source,
      i.reason?.text ?? '', i.decisionId ?? '',
    ];
  });
}

export const PRICE_FEED_CSV_HEADER = ['at', 'channel', 'marketplace', 'offer', 'price_from', 'price_to', 'change', 'status', 'source', 'reason', 'decision_id'];

/**
 * Р-145 (шаг 32): ЕДИНСТВЕННОЕ место, где строки превращаются в файл. Звать его вправе только исполнитель заданий — то есть
 * один путь выгрузки на всю систему (`apps/console/test/console.test.ts`, правило «выгрузка идёт одним путём»).
 *
 * Своей сборки файла больше нет ни у одного обработчика: до шага 32 их было три, и они разошлись — выгрузка ленты собирала
 * файл целиком и квадратично, отчёт об импорте — целиком и синхронно, доказательство несло собственную копию экранирования
 * CSV. Обработчик теперь отдаёт СТРОКИ и не может собрать из них байты.
 */
export function csvOf(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return csv(header, rows);
}


/** Имя файла ленты: период и предложение видно, не открывая файл */
export function priceFeedFileName(world: StandWorld, m: Messages, query: FeedQuery): string {
  const scope = query.writeScopeId ? scopeById(world, query.writeScopeId) : undefined;
  const offer = scope ? unitOf(world, scope, m).externalUnitId : 'all-offers';
  return `price-feed_${query.days ?? 'all'}d_${offer}.csv`;
}
