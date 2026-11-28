import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { canPickMore, MAX_PICKED, removeMatch, selectAllMatching, type ListQuery, type OfferFilterParams, type OfferSelection } from '@repracer/console-model';
import type { SelectionView } from '../api-types.ts';
import { requestJson, worldPath } from '../api.ts';
import { useMessages } from '../components.tsx';
import { offerParams, type OfferUiQuery } from './Products.tsx';

/**
 * Шаг 177 (#39, уточнение Р-140 2026-11-25): выбор для массовых операций переживает страницы и фильтры — только видимым. Невидимого выбора
 * не существует: постоянный счётчик «N selected · M outside current view», «Review selection» — только выбранное, «Select all matching» —
 * явное действие с бейджем фильтра. Числа считает сервер теми же выборками, что экран Offers
 */

/** Фильтр экрана — те же параметры, что у адреса Offers, без порядка и колонок */
export function filterOfUi(q: OfferUiQuery): OfferFilterParams {
  const { sort: _sort, dir: _dir, bb: _bb, ...rest } = offerParams(q, false) as Record<string, string>;
  return rest;
}

/** Фильтр словами — для бейджа «All matching: …» */
export function describeFilter(f: OfferFilterParams, storefronts: ReadonlyArray<{ value: string; label: string }>, m: ReturnType<typeof useMessages>): string {
  const t = m.ui.products.filters;
  const words = (map: unknown, key: string | undefined) => (key ? ((map as Record<string, string | undefined>)[key] ?? key) : null);
  const parts = [
    f.storefront ? `${t.storefront}${m.colon}${storefronts.find((x) => x.value === f.storefront)?.label ?? f.storefront}` : null,
    f.pricing ? `${t.pricing}${m.colon}${words(t.pricingValues, f.pricing)}` : null,
    f.attention ? `${t.attention}${m.colon}${words(t.attentionValues, f.attention)}` : null,
    f.setup ? `${t.setup}${m.colon}${words(t.setupValues, f.setup)}` : null,
    f.money ? `${t.money}${m.colon}${words(t.moneyValues, f.money)}` : null,
    f.holder ? `${t.holder}${m.colon}${words(t.holders, f.holder)}` : null,
    f.q ? `${t.search}${m.colon}“${f.q}”` : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? m.ui.selection.wholeCatalog : parts.join(' · ');
}

/** Сводка выбора с сервера — пересчитывается при каждом изменении выбора, фильтра, показанной страницы и «Review selection» */
export function useSelectionSummary(worldId: string, selection: OfferSelection, filter: OfferFilterParams, shown: readonly string[], review: ListQuery | null, refresh: number): SelectionView | null {
  const m = useMessages();
  const [summary, setSummary] = useState<SelectionView | null>(null);
  const key = JSON.stringify([selection, filter, shown, review, refresh]);
  useEffect(() => {
    let alive = true;
    requestJson<SelectionView>(worldPath(worldId, 'bounds', 'selection'), { method: 'POST', body: { selection, view: filter, shown, review }, locale: m.locale })
      .then((x) => { if (alive) setSummary(x); })
      .catch(() => { if (alive) setSummary(null); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldId, key, m.locale]);
  return summary;
}

/** Выбрана ли показанная строка: снятая — нет, отмеченная — да, иначе — как сказал сервер (выбрана фильтром) */
export function isPicked(selection: OfferSelection, summary: SelectionView | null, id: string): boolean {
  if (selection.except.includes(id)) return false;
  if (selection.ids.includes(id)) return true;
  return selection.matches.length > 0 && (summary?.shownSelected.includes(id) ?? false);
}

export function SelectionBar({ summary, selection, onSelection, filter, matching, storefronts, review, onReview, disabled = false }: {
  summary: SelectionView | null; selection: OfferSelection; onSelection: (s: OfferSelection) => void; filter: OfferFilterParams;
  /** Сколько предложений под текущим фильтром (без фильтра — весь каталог) */
  matching: number; storefronts: ReadonlyArray<{ value: string; label: string }>;
  review: boolean; onReview: (on: boolean) => void; disabled?: boolean;
}) {
  const m = useMessages();
  const t = m.ui.selection;
  const filtered = Object.keys(filter).length > 0;
  const selected = summary?.selected ?? 0;
  return (
    <div className="selection-bar">
      <p className="selection-count" role="status">{t.counter(selected, summary?.outsideView ?? 0)}</p>
      <div className="buttons">
        <button type="button" disabled={disabled || matching === 0} onClick={() => onSelection(selectAllMatching(selection, filter))}>
          {filtered ? t.selectAllMatching(matching) : t.selectAll(matching)}
        </button>
        <button type="button" disabled={disabled || (selected === 0 && !review)} onClick={() => onReview(!review)}>{review ? t.reviewBack : t.review}</button>
        <button type="button" disabled={disabled || selected === 0} onClick={() => { onSelection({ ids: [], matches: [], except: [] }); onReview(false); }}>{t.clear}</button>
      </div>
      {selection.matches.length > 0 ? (
        <ul className="selection-badges">
          {selection.matches.map((f) => (
            <li key={JSON.stringify(f)} className="badge-chip">
              <span>{t.badge(describeFilter(f, storefronts, m))}</span>
              <button type="button" className="link" disabled={disabled} onClick={() => onSelection(removeMatch(selection, f))}>{t.remove}</button>
            </li>
          ))}
        </ul>
      ) : null}
      {!canPickMore(selection) ? <p className="notice" role="note">{t.limit(MAX_PICKED)}</p> : null}
    </div>
  );
}

/**
 * Шаг 189 (#27, пункт 17 ретеста Мердана): строка выбора и таблица выбора — одним блоком; от 768 px строка держится под верхней панелью,
 * пока таблица на экране, и строки листаются под ней. Шапка таблицы, которая держится на экране (шаг 182), стоит под строкой: высоту строки
 * блок отдаёт стилям (`--selection-h`), замер — ResizeObserver (строка растёт, когда появляются бейджи фильтров). На телефоне строка —
 * на своём месте: закреплённая заняла бы пятую часть экрана
 */
export function SelectionScope({ line, children }: { line: ReactNode; children: ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);
  const sticky = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = scope.current;
    const el = sticky.current;
    if (!box || !el) return undefined;
    const measure = () => box.style.setProperty('--selection-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="selection-scope" ref={scope}>
      <div className="selection-sticky" ref={sticky}>{line}</div>
      {children}
    </div>
  );
}
