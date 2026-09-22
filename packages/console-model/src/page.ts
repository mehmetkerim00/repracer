import type { Messages } from './i18n/index.ts';

/**
 * Р-136 (шаг 29): страницы списков — на сервере. Живой прогон через консоль на каталоге целевого клиента (10 000 предложений)
 * показал, что экраны, отдающие каталог целиком, продавцу не годятся: список товаров — 10,2 МБ в одном ответе, экран комплаенса —
 * 8,7 МБ и 24,8 секунды (проверка Omnibus шла по одному предложению). Порядок тот же, что у ленты цен с шага 23: `offset` и
 * `limit` в запросе, `page` в ответе; серверу остаётся считать только показанную страницу.
 */

/** Сколько строк показывает экран по умолчанию: столько продавец пролистывает глазами, не теряя место */
export const LIST_PAGE_DEFAULT = 50;
/** Больше этого за один ответ не отдаётся никогда: дальше браузер тратит на разбор больше, чем человек на чтение */
export const LIST_PAGE_MAX = 200;

export interface ListQuery {
  offset: number;
  limit: number;
}

export interface PageInfo {
  from: number;
  to: number;
  total: number;
  text: string;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Параметры страницы из запроса; неверные — отказ, а не молчаливое «покажем всё» */
export function parseListQuery(params: URLSearchParams): ListQuery | null {
  // Только десятичные цифры: «0x10» и «1e3» — не номер страницы, а опечатка или подбор (ревью шага 29, находка 14)
  const number = (name: string, fallback: number): number | null => {
    const raw = params.get(name);
    if (raw === null || raw === '') return fallback;
    if (!/^\d{1,9}$/.test(raw)) return null;
    return Number(raw);
  };
  const offset = number('offset', 0);
  const limit = number('limit', LIST_PAGE_DEFAULT);
  if (offset === null || limit === null || limit === 0 || limit > LIST_PAGE_MAX) return null;
  return { offset, limit };
}

export const listQuery = (query: ListQuery | undefined): ListQuery => query ?? { offset: 0, limit: LIST_PAGE_DEFAULT };

/**
 * Р-154: страница, которую отдала база (итог — агрегатом, строки — LIMIT/OFFSET). Смещение за концом подтягивается к последней
 * странице теми же правилами, что `pageOf`, — поэтому запрос к базе делается с уже подтянутым смещением (`clampOffset`).
 */
export function pageInfo(query: ListQuery, total: number, m: Messages): PageInfo {
  const from = clampOffset(query, total);
  const to = Math.min(from + query.limit, total);
  return { from: total === 0 ? 0 : from + 1, to, total, text: m.ui.feed.page(total === 0 ? 0 : from + 1, to, total), hasPrevious: from > 0, hasNext: to < total };
}

export function clampOffset(query: ListQuery, total: number): number {
  const lastStart = total === 0 ? 0 : Math.floor((total - 1) / query.limit) * query.limit;
  return Math.min(query.offset, lastStart);
}

/** Страница списка и то, что о ней сказать продавцу: «21–40 из 10 000» */
export function pageOf<T>(items: readonly T[], query: ListQuery, m: Messages): { items: T[]; page: PageInfo } {
  // Страница за концом списка: показывается последняя, а не «10001–10000 из 10000» с кнопкой «назад» (ревью шага 29, находка 13)
  const lastStart = items.length === 0 ? 0 : Math.floor((items.length - 1) / query.limit) * query.limit;
  const from = Math.min(query.offset, lastStart);
  const to = Math.min(from + query.limit, items.length);
  return {
    items: items.slice(from, to),
    page: {
      from: items.length === 0 ? 0 : from + 1, to, total: items.length,
      text: m.ui.feed.page(items.length === 0 ? 0 : from + 1, to, items.length),
      hasPrevious: from > 0, hasNext: to < items.length,
    },
  };
}

/**
 * Р-140 (шаг 30): что остаётся выбранным при листании. Ответ — ничего: выбранные строки другой страницы продавцу не видны, а
 * применяются к ним. Вынесено отдельной функцией не ради красоты: пока это была ветка внутри компонента, её нельзя было
 * проверить ничем, кроме наличия ФРАЗЫ о сбросе на экране (находка 13 ревью шага 30).
 */
export function selectionAfterPaging(selected: readonly string[], shownPageKey: string, pageKey: string): string[] {
  return shownPageKey === pageKey ? [...selected] : [];
}
