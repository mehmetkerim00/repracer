import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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

export function TableFrame({ screen, lead, actions, notes, children }: {
  /** Без экрана — только закреплённая шапка, без кнопки разворота (список выбранного на Strategies, ответ «Why didn't my price change?») */
  screen?: TableScreen;
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
  const head = lead || actions || notes || button;
  return (
    <div ref={ref} className={`table-wrap framed${fits ? ' fits' : ''}${maximized ? ' maximized' : ''}`}>
      {head ? (
        <div className={`table-head${lead || actions || notes ? '' : ' only-max'}`}>
          {lead}
          {actions || button ? <span className="table-actions">{actions}{button}</span> : null}
          {notes}
        </div>
      ) : null}
      {children}
    </div>
  );
}
