/**
 * Шаг 177 (#39, уточнение Р-140 2026-11-25): выбор предложений для массовых операций переживает страницы и фильтры — только видимым.
 * Выбор — это отмеченные строки (`ids`), «все подходящие под фильтр» (`matches` — явное действие с видимым бейджем, раскрывает сервер,
 * как «весь каталог» с шага 29) и строки, снятые вручную из подходящих (`except`). Невидимого выбора нет: число выбранного и сколько из
 * него вне текущего вида считает сервер теми же выборками, что экран Offers (база = правило экрана), а «Review selection» показывает
 * только выбранное.
 *
 * Отмеченных и снятых строк вместе — не больше MAX_PICKED: запрос несёт их перечнем, а предел тела запроса — 64 КБ (шаг 29: 10 000 идентификаторов —
 * 413). Больше — фильтром и «Select all matching»: его раскрывает сервер.
 */
export const MAX_PICKED = 1000;
/** Фильтров «все подходящие» в одном выборе — сколько бейджей продавец ещё читает */
export const MAX_MATCHES = 10;

/** Параметры фильтра экрана Offers — те же ключи, что в адресе экрана (`storefront`, `pricing`, `attention`, `setup`, `money`, `holder`, `q`) */
export type OfferFilterParams = Record<string, string>;

export interface OfferSelection {
  ids: string[];
  matches: OfferFilterParams[];
  except: string[];
}

export const NO_SELECTION: OfferSelection = { ids: [], matches: [], except: [] };

export const FILTER_KEYS = ['storefront', 'pricing', 'attention', 'setup', 'money', 'holder', 'q'] as const;

const strings = (raw: unknown, max: number): string[] | null =>
  Array.isArray(raw) && raw.length <= max && raw.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100) ? [...new Set(raw as string[])] : null;

/** Фильтр — только известные ключи со строковыми значениями; пустые значения отбрасываются (пустой фильтр — весь каталог) */
export function filterParamsOf(raw: unknown): OfferFilterParams | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const out: OfferFilterParams = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(FILTER_KEYS as readonly string[]).includes(k) || typeof v !== 'string' || v.length > 200) return null;
    if (v !== '') out[k] = v;
  }
  return out;
}

/** Разбор выбора из запроса; неверная форма или больше пределов — null (маршрут отвечает 400) */
export function parseOfferSelection(raw: unknown): OfferSelection | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const ids = strings(r.ids ?? [], MAX_PICKED);
  const except = strings(r.except ?? [], MAX_PICKED);
  // Отмеченные и снятые вместе — не больше MAX_PICKED: обе группы едут в теле запроса
  if (!ids || !except || ids.length + except.length > MAX_PICKED || !Array.isArray(r.matches ?? []) || ((r.matches ?? []) as unknown[]).length > MAX_MATCHES) return null;
  const matches: OfferFilterParams[] = [];
  for (const x of (r.matches ?? []) as unknown[]) {
    const f = filterParamsOf(x);
    if (!f) return null;
    if (!matches.some((y) => sameFilter(y, f))) matches.push(f);
  }
  return { ids, matches, except };
}

export function sameFilter(a: OfferFilterParams, b: OfferFilterParams): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

export function selectionEmpty(s: OfferSelection): boolean {
  return s.ids.length === 0 && s.matches.length === 0;
}

/**
 * Отметить или снять строку. `inSelection` — строка сейчас выбрана (так её показал сервер): снятая строка, выбранная фильтром, уходит в
 * `except`, а отмеченная вручную — из `ids`; отмеченная строка, снятая раньше из подходящих, возвращается
 */
export function toggleOffer(s: OfferSelection, id: string, on: boolean, inSelection: boolean): OfferSelection {
  if (on) {
    if (s.except.includes(id)) return { ...s, except: s.except.filter((x) => x !== id) };
    return s.ids.includes(id) ? s : { ...s, ids: [...s.ids, id] };
  }
  if (s.ids.includes(id)) return { ...s, ids: s.ids.filter((x) => x !== id) };
  return inSelection && !s.except.includes(id) ? { ...s, except: [...s.except, id] } : s;
}

/** «Select all matching»: фильтр добавляется бейджем; строки, снятые раньше, снова выбраны — продавец выбрал «все» */
export function selectAllMatching(s: OfferSelection, filter: OfferFilterParams): OfferSelection {
  return { ids: s.ids, matches: s.matches.some((x) => sameFilter(x, filter)) ? s.matches : [...s.matches, filter], except: [] };
}

export function removeMatch(s: OfferSelection, filter: OfferFilterParams): OfferSelection {
  return { ...s, matches: s.matches.filter((x) => !sameFilter(x, filter)) };
}

/** Отметить ещё строку можно, пока отмеченных и снятых вместе меньше MAX_PICKED */
export function canPickMore(s: OfferSelection): boolean {
  return s.ids.length + s.except.length < MAX_PICKED;
}
