import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useMessages } from './components.tsx';
import { Octicon } from './icons.tsx';

/**
 * Шаг 182 (#38): рамка широкой таблицы — Offers, Costs & floors, Price changes. Шапка таблицы остаётся на экране, пока листаются строки:
 * - таблица помещается в рамку — рамка ничего не обрезает (`fits`), шапка держится под верхней панелью при прокрутке страницы;
 * - шире рамки — рамка не выше окна, строки листаются в ней, шапка — у её верхнего края, первая колонка закреплена (шаг 85).
 * Какой случай — решает замер ширины таблицы и рамки, а не список экранов: колонки включаются, окно меняется.
 *
 * «Maximize the table» (экран от 1012 px) отдаёт таблице ширину окна: боковина — иконками, предел ширины содержимого снят. Ничего не
 * скрывается (Р-254): строка состояния, фильтры и переключатель страниц остаются на странице. Выбор помнит браузер по экрану
 */

/** Экран, чья таблица разворачивается; у одного экрана — одна память (записи и решения Price changes — один экран) */
export type TableScreen = 'products' | 'costs' | 'feed';

const maxKey = (screen: TableScreen) => `repracer.table-max:${screen}`;

/**
 * Шаг 183 (#38): таблица, чьи колонки меняют ширину; у каждой — своя память (записи и решения Price changes — разные колонки, список
 * границ на Costs & floors и список выбранного на Offers — одни)
 */
export type TableKey = 'offers' | 'bounds' | 'feed' | 'decisions';
/** Пределы ширины колонки и шаг клавиатуры; уже содержимого колонка не становится — раскладка таблицы прежняя, ширина — предпочтение */
export const COLUMN_MIN = 64;
export const COLUMN_MAX = 640;
export const COLUMN_STEP = 16;

const widthsKey = (table: TableKey) => `repracer.table-widths:${table}`;
type Widths = Readonly<Record<string, number>>;

function readWidths(table: TableKey): Widths {
  try {
    const raw = JSON.parse(localStorage.getItem(widthsKey(table)) ?? '{}') as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Чужое или испорченное в хранилище — не ширина: только числа в пределах
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && v >= COLUMN_MIN && v <= COLUMN_MAX)) as Widths;
  } catch {
    return {};
  }
}

interface ColumnWidths { widths: Widths; set: (col: string, px: number | null) => void }
const WidthsContext = createContext<ColumnWidths | null>(null);

function useColumnWidths(table: TableKey | undefined): ColumnWidths & { reset: () => void } {
  const [widths, setWidths] = useState<Widths>(() => (table ? readWidths(table) : {}));
  const set = useCallback((col: string, px: number | null) => setWidths((prev) => {
    const next = { ...prev };
    if (px === null) delete next[col]; else next[col] = Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, Math.round(px)));
    return next;
  }), []);
  const reset = useCallback(() => setWidths({}), []);
  useEffect(() => {
    if (!table) return;
    // Память ширин — удобство: без хранилища ширины живут до ухода с экрана
    try { if (Object.keys(widths).length > 0) localStorage.setItem(widthsKey(table), JSON.stringify(widths)); else localStorage.removeItem(widthsKey(table)); } catch { /* без хранилища */ }
  }, [table, widths]);
  return { widths, set, reset };
}

/**
 * Подпись колонки таблицы в рамке с памятью ширин: ширина — переменной `--col-w` (применяет CSS, только от 1012 px), ручка у правого края —
 * разделитель окна: мышью, ← и → по COLUMN_STEP, Home и End — пределы, двойной щелчок — по умолчанию. Вне такой рамки — обычная подпись
 */
export function ColHead({ col, label, className, sort, children }: {
  col: string; label: string; className?: string; sort?: 'ascending' | 'descending' | 'none'; children?: ReactNode;
}) {
  const ctx = useContext(WidthsContext);
  const width = ctx?.widths[col];
  return (
    <th data-col={col} className={className} aria-sort={sort} style={width ? ({ '--col-w': `${width}px` } as CSSProperties) : undefined}>
      {children ?? label}
      {ctx ? <ColGrip col={col} label={label} ctx={ctx} /> : null}
    </th>
  );
}

function ColGrip({ col, label, ctx }: { col: string; label: string; ctx: ColumnWidths }) {
  const m = useMessages();
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<number | null>(null);
  const measured = () => Math.round(ref.current?.closest('th')?.getBoundingClientRect().width ?? 0);
  // Значение разделителя — ширина, которую видно (уже содержимого колонка не становится): сверяется после каждой отрисовки
  useLayoutEffect(() => { const w = measured(); if (w > 0 && w !== shown) setShown(w); });
  return (
    <span ref={ref} className="col-grip" role="separator" aria-orientation="vertical" tabIndex={0} aria-label={m.ui.app.resizeColumn(label)} title={m.ui.app.resizeColumn(label)}
      aria-valuemin={COLUMN_MIN} aria-valuemax={COLUMN_MAX} aria-valuenow={shown ?? ctx.widths[col] ?? COLUMN_MIN}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const el = e.currentTarget;
        const start = measured();
        const x0 = e.clientX;
        el.setPointerCapture(e.pointerId);
        const move = (ev: PointerEvent) => ctx.set(col, start + ev.clientX - x0);
        // Отпускание ставит ширину по своей точке: последнее движение браузер сливает с ним и может не прислать отдельно
        const done = (ev: PointerEvent) => {
          if (ev.type === 'pointerup') move(ev);
          el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', done); el.removeEventListener('pointercancel', done);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', done);
        el.addEventListener('pointercancel', done);
      }}
      onDoubleClick={() => ctx.set(col, null)}
      onKeyDown={(e) => {
        // Образец WAI-ARIA «разделитель окна»: стрелки — шаг, Home и End — наименьшая и наибольшая; по умолчанию — двойной щелчок или
        // «Reset column widths»
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); ctx.set(col, measured() + (e.key === 'ArrowRight' ? COLUMN_STEP : -COLUMN_STEP)); }
        else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); ctx.set(col, e.key === 'Home' ? COLUMN_MIN : COLUMN_MAX); }
      }} />
  );
}

function useMaximized(screen: TableScreen | undefined): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    if (!screen) return false;
    try { return localStorage.getItem(maxKey(screen)) === 'on'; } catch { return false; }
  });
  const set = (next: boolean) => {
    setOn(next);
    if (!screen) return;
    // Память вида — удобство: без хранилища таблица разворачивается до ухода с экрана
    try { if (next) localStorage.setItem(maxKey(screen), 'on'); else localStorage.removeItem(maxKey(screen)); } catch { /* без хранилища */ }
  };
  return [on, set];
}

export function TableFrame({ screen, table, lead, actions, notes, children }: {
  /** Без экрана — только закреплённая шапка, без кнопки разворота (список выбранного на Strategies, ответ «Why didn't my price change?») */
  screen?: TableScreen;
  /** Шаг 183: таблица, чьи колонки (`ColHead`) меняют ширину и помнят её; без неё — подписи без ручек */
  table?: TableKey;
  /** Левая часть шапки рамки — итоги и счётчики */
  lead?: ReactNode;
  /** Правая часть шапки — действия над таблицей; кнопка разворота — последней */
  actions?: ReactNode;
  /** Строки во всю ширину шапки — общие для многих строк причины (шаг 84) */
  notes?: ReactNode;
  children: ReactNode;
}) {
  const m = useMessages();
  const ref = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(false);
  const [maximized, setMaximized] = useMaximized(screen);
  const columns = useColumnWidths(table);
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const measure = () => {
      const table = wrap.querySelector(':scope > table');
      if (table) setFits(table.getBoundingClientRect().width <= wrap.clientWidth + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    const table = wrap.querySelector(':scope > table');
    if (table) observer.observe(table);
    return () => observer.disconnect();
  }, []);
  const toggle = () => {
    const next = !maximized;
    setMaximized(next);
    // Развёрнутая таблица — к верху окна: окно отдано ей; прежний вид — там, где человек был
    if (next) requestAnimationFrame(() => ref.current?.scrollIntoView({ block: 'start' }));
  };
  const label = maximized ? m.ui.app.restoreTable : m.ui.app.maximizeTable;
  const button = screen ? (
    <button type="button" className="ghost table-max" aria-pressed={maximized} aria-label={label} title={label} onClick={toggle}>
      <Octicon name={maximized ? 'screen-normal' : 'screen-full'} size={20} />
    </button>
  ) : null;
  const reset = table && Object.keys(columns.widths).length > 0
    ? <button type="button" className="link reset-widths" onClick={columns.reset}>{m.ui.app.resetColumns}</button> : null;
  const controls = reset || button ? <>{reset}{button}</> : null;
  const head = lead || actions || notes || controls;
  return (
    <div ref={ref} className={`table-wrap framed${fits ? ' fits' : ''}${maximized ? ' maximized' : ''}`}>
      {head ? (
        // Шапка из одних кнопок вида (разворот, сброс ширин) — только там, где они действуют: от 1012 px
        <div className={`table-head${lead || actions || notes ? '' : ' controls-only'}`}>
          {lead}
          {actions || controls ? <span className="table-actions">{actions}{controls}</span> : null}
          {notes}
        </div>
      ) : null}
      <WidthsContext.Provider value={table ? columns : null}>{children}</WidthsContext.Provider>
    </div>
  );
}
