import { createContext, useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { PERIOD_PRESETS, type Period } from '@repracer/console-model';
import { useMessages } from './components.tsx';
import { Field, FormActions } from './forms.tsx';
import { Octicon } from './icons.tsx';

/**
 * Шаг 96.1 (решение владельца): выбор периода «по-взрослому» — один контрол диапазона вместо родных полей дат. Кнопка показывает
 * диапазон («Oct 10 – Oct 16, 2026»); по нажатию — календарь: на широком экране два месяца рядом, на телефоне — лист во весь экран;
 * диапазон — двумя нажатиями, слева пресеты, внизу Apply / Cancel. Дни — в поясе пространства (`ZoneContext`): сервер считает окно в
 * нём же. Конец не раньше начала — живой подсказкой (`aria-live`), а не молча. Клавиатура: стрелки — день и неделя, Home / End — край
 * недели, PageUp / PageDown — месяц, Enter / пробел — выбрать, Esc — закрыть. Один компонент у Shadow mode, Protections и Price changes
 */

/** Пояс рабочего пространства; без него (миры сценариев стенда) — пояс браузера */
export const ZoneContext = createContext<string | null>(null);

type Day = string; // YYYY-MM-DD

const dayOfUtc = (ms: number): Day => new Date(ms).toISOString().slice(0, 10);
const utcOf = (day: Day): number => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: Day, n: number): Day => dayOfUtc(utcOf(day) + n * 86_400_000);
const monthOf = (day: Day): Day => `${day.slice(0, 7)}-01`;
const addMonths = (month: Day, n: number): Day => {
  const d = new Date(utcOf(month));
  return dayOfUtc(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
};
const clampDay = (day: Day, min: Day, max: Day): Day => (day < min ? min : day > max ? max : day);
/** Тот же день месяца в другом месяце, но не дальше его последнего дня (31 марта → 30 апреля) */
const sameDayIn = (month: Day, day: Day): Day => clampDay(addDays(month, Number(day.slice(8)) - 1), month, addDays(addMonths(month, 1), -1));

/** Дата момента в поясе; неизвестный пояс — пояс браузера */
export function dayIn(ms: number, timeZone: string | null): Day {
  const make = (tz: string | undefined) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  try { return make(timeZone ?? undefined).format(new Date(ms)); } catch { return make(undefined).format(new Date(ms)); }
}

/** Дни пресета — те же, что у сервера (`periodRange`): от «сейчас минус N» до сегодня, в поясе пространства */
export function presetDays(preset: (typeof PERIOD_PRESETS)[number], nowMs: number, timeZone: string | null): { from: Day; to: Day } {
  const hours = preset === '24h' ? 24 : preset === '7d' ? 7 * 24 : 30 * 24;
  return { from: dayIn(nowMs - hours * 3_600_000, timeZone), to: dayIn(nowMs, timeZone) };
}

/** «Oct 10 – Oct 16, 2026»: год один раз, если он общий; один день — одной датой */
export function rangeText(from: Day, to: Day, locale: string): string {
  const intl = locale === 'de' ? 'de-DE' : 'en-US';
  const short = new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const full = new Intl.DateTimeFormat(intl, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  if (from === to) return full.format(utcOf(to));
  return `${from.slice(0, 4) === to.slice(0, 4) ? short.format(utcOf(from)) : full.format(utcOf(from))} – ${full.format(utcOf(to))}`;
}

type Draft = { preset: (typeof PERIOD_PRESETS)[number] | null; from: Day | null; to: Day | null };

export function DateRangePicker({ id, value, onChange, maxDays = 30, 'aria-describedby': describedBy }: {
  id?: string; value: Period; onChange: (period: Period) => void; maxDays?: number; 'aria-describedby'?: string;
}) {
  const m = useMessages();
  const t = m.ui.period;
  const zone = useContext(ZoneContext);
  const own = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ preset: null, from: null, to: null });
  const [focus, setFocus] = useState<Day>('');
  const [anchor, setAnchor] = useState<Day>('');
  const [hover, setHover] = useState<Day | null>(null);
  const [hint, setHint] = useState('');
  const [wide, setWide] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);

  const now = Date.now(); // real-clock: календарь продавца: «сегодня» — по часам браузера в поясе пространства
  const today = dayIn(now, zone);
  const min = addDays(today, -(maxDays - 1));
  const current = 'preset' in value ? { preset: value.preset, ...presetDays(value.preset, now, zone) } : { preset: null, from: value.from, to: value.to };
  const label = rangeText(current.from, current.to, m.locale);

  const close = (restore = true) => {
    setOpen(false);
    setHover(null);
    if (restore) triggerRef.current?.focus();
  };
  const show = () => {
    const end = clampDay(current.to, min, today);
    setDraft({ preset: current.preset, from: current.from, to: current.to });
    setFocus(end);
    // правый месяц — месяц конца; на телефоне виден один месяц — тот же
    setAnchor(monthOf(end));
    setHint(t.chosen(label));
    setWide(!window.matchMedia('(width < 48rem)').matches);
    wantFocus.current = true;
    setOpen(true);
  };

  // фокус — на выбранный день сетки, когда календарь открыт или фокус сменил день
  useEffect(() => {
    if (!open || !focus || !wantFocus.current) return;
    wantFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`button[data-day="${focus}"]`)?.focus();
  }, [open, focus, anchor]);
  // нажатие мимо календаря закрывает его без изменений
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  });

  // месяцы — только у открытого календаря: до открытия месяц не задан
  const months = !open || !anchor ? [] : wide ? [addMonths(anchor, -1), anchor] : [anchor];
  const intl = m.locale === 'de' ? 'de-DE' : 'en-US';
  const weekStart = m.locale === 'de' ? 1 : 0;
  const monthTitle = new Intl.DateTimeFormat(intl, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const dayLong = new Intl.DateTimeFormat(intl, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const weekdayShort = new Intl.DateTimeFormat(intl, { weekday: 'short', timeZone: 'UTC' });
  const weekdayLong = new Intl.DateTimeFormat(intl, { weekday: 'long', timeZone: 'UTC' });
  // 2026-10-04 — воскресенье: от него — дни недели в порядке недели языка
  const weekdays = Array.from({ length: 7 }, (_, i) => addDays('2026-10-04', (i + weekStart) % 7));

  const fmt = (day: Day) => rangeText(day, day, m.locale);
  const reveal = (day: Day) => {
    const first = months[0]!;
    const last = months[months.length - 1]!;
    if (day < first) setAnchor(wide ? addMonths(monthOf(day), 1) : monthOf(day));
    else if (day >= addMonths(last, 1)) setAnchor(monthOf(day));
  };
  const moveTo = (day: Day) => {
    const next = clampDay(day, min, today);
    reveal(next);
    wantFocus.current = true;
    setFocus(next);
  };
  const pick = (day: Day) => {
    if (day < min || day > today) return;
    setFocus(day);
    if (draft.from !== null && draft.to === null) {
      // конец не раньше начала — словами, а не молча
      if (day < draft.from) { setHint(t.endBeforeStart(fmt(draft.from))); return; }
      setDraft({ preset: null, from: draft.from, to: day });
      setHint(t.chosen(rangeText(draft.from, day, m.locale)));
      return;
    }
    setDraft({ preset: null, from: day, to: null });
    setHint(t.pickEnd(fmt(day)));
  };
  const choosePreset = (p: (typeof PERIOD_PRESETS)[number]) => {
    const days = presetDays(p, now, zone);
    setDraft({ preset: p, ...days });
    setHint(t.chosen(rangeText(days.from, days.to, m.locale)));
    setAnchor(monthOf(days.to));
    setFocus(days.to);
  };
  const apply = () => {
    if (draft.preset) onChange({ preset: draft.preset });
    else if (draft.from && draft.to) onChange({ from: draft.from, to: draft.to });
    close();
  };
  const onDayKey = (e: KeyboardEvent<HTMLButtonElement>, day: Day) => {
    const dow = (new Date(utcOf(day)).getUTCDay() - weekStart + 7) % 7;
    const step: Record<string, () => Day> = {
      ArrowLeft: () => addDays(day, -1), ArrowRight: () => addDays(day, 1), ArrowUp: () => addDays(day, -7), ArrowDown: () => addDays(day, 7),
      Home: () => addDays(day, -dow), End: () => addDays(day, 6 - dow),
      PageUp: () => sameDayIn(addMonths(monthOf(day), -1), day), PageDown: () => sameDayIn(addMonths(monthOf(day), 1), day),
    };
    const go = step[e.key];
    if (!go) return;
    e.preventDefault();
    moveTo(go());
  };
  const shown = hover && draft.from && !draft.to && hover >= draft.from ? { from: draft.from, to: hover } : draft.from ? { from: draft.from, to: draft.to ?? draft.from } : null;

  const month = (start: Day, index: number) => {
    const lead = (new Date(utcOf(start)).getUTCDay() - weekStart + 7) % 7;
    const end = addDays(addMonths(start, 1), -1);
    const cells: Array<Day | null> = [...Array.from({ length: lead }, () => null), ...Array.from({ length: Number(end.slice(8)) }, (_, i) => addDays(start, i))];
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
    const titleId = `${own}-month-${index}`;
    return (
      <div className="drp-month" key={start}>
        <div className="drp-month-title" id={titleId}>{monthTitle.format(utcOf(start))}</div>
        <table role="grid" aria-labelledby={titleId}>
          <thead><tr>{weekdays.map((w) => <th key={w} scope="col" abbr={weekdayLong.format(utcOf(w))}>{weekdayShort.format(utcOf(w))}</th>)}</tr></thead>
          <tbody>
            {weeks.map((week, w) => (
              <tr key={w}>
                {week.map((day, d) => {
                  if (!day) return <td key={`e${d}`} role="gridcell" />;
                  const disabled = day < min || day > today;
                  const edge = !!shown && (day === shown.from || day === shown.to);
                  const inside = !!shown && day > shown.from && day < shown.to;
                  const cls = ['drp-day', edge ? 'edge' : '', inside ? 'inside' : '', day === today ? 'today' : '', disabled ? 'disabled' : ''].filter(Boolean).join(' ');
                  return (
                    <td key={day} role="gridcell" aria-selected={edge || inside}>
                      <button type="button" className={cls} data-day={day} tabIndex={day === focus ? 0 : -1} aria-disabled={disabled || undefined}
                        aria-label={dayLong.format(utcOf(day))} aria-current={day === today ? 'date' : undefined}
                        onClick={() => pick(day)} onKeyDown={(e) => onDayKey(e, day)} onMouseEnter={() => setHover(day)} onMouseLeave={() => setHover(null)}>
                        {Number(day.slice(8))}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="drp" ref={rootRef}>
      <button type="button" id={id} ref={triggerRef} className="drp-trigger" aria-haspopup="dialog" aria-expanded={open} aria-describedby={describedBy}
        onClick={() => (open ? close() : show())}>
        <Octicon name="calendar" size={16} />
        {current.preset ? <span className="drp-preset">{t.presetsLong[current.preset]} · </span> : null}
        <span className="drp-range">{label}</span>
      </button>
      {open ? (
        <div className={`drp-pop${wide ? '' : ' sheet'}`} role="dialog" aria-modal={wide ? undefined : true} aria-label={t.dialog}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
          {/* на телефоне лист во весь экран — со своим заголовком; на широком экране карточка стоит под полем «Period» и заголовок не нужен */}
          <div className="drp-title" aria-hidden="true">{t.dialog}</div>
          <div className="drp-body">
            <div className="drp-presets" role="group" aria-label={t.label}>
              {PERIOD_PRESETS.map((p) => (
                <button key={p} type="button" className={draft.preset === p ? 'on' : undefined} aria-pressed={draft.preset === p} onClick={() => choosePreset(p)}>{t.presetsLong[p]}</button>
              ))}
            </div>
            <div className="drp-calendar">
              <div className="drp-nav">
                <button type="button" className="ghost" aria-label={t.prevMonth} disabled={months[0]! <= monthOf(min)} onClick={() => setAnchor(addMonths(anchor, -1))}><Octicon name="chevron-left" size={16} /></button>
                <button type="button" className="ghost" aria-label={t.nextMonth} disabled={anchor >= monthOf(today)} onClick={() => setAnchor(addMonths(anchor, 1))}><Octicon name="chevron-right" size={16} /></button>
              </div>
              <div className="drp-months" ref={gridRef}>{months.map((start, i) => month(start, i))}</div>
            </div>
          </div>
          <div className="drp-foot">
            <p className="drp-hint" aria-live="polite">{hint} <span className="muted">{t.limit(maxDays)}</span></p>
            <FormActions dialog>
              <button type="button" onClick={() => close()}>{t.cancel}</button>
              <button type="button" className="primary" disabled={!(draft.from && draft.to)} onClick={apply}>{t.applyRange}</button>
            </FormActions>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Шаг 96 (аудит, II), шаг 96.1: период экрана — одно правило на Shadow mode, Protections и Price changes: поле «Period» с контролом
 * диапазона внутри (стандарт Field — подпись над контролом)
 */
export function PeriodPicker({ value, onChange, maxDays = 30 }: { value: Period; onChange: (period: Period) => void; maxDays?: number }) {
  const m = useMessages();
  return (
    <Field label={m.ui.period.label}>
      <DateRangePicker value={value} onChange={onChange} maxDays={maxDays} />
    </Field>
  );
}
