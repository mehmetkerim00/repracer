import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ShadowChartView, ShadowView } from '@repracer/console-model';
import { barValuesFit, dayLabelled, dayLabelStep } from '../chart.ts';
import { useMessages } from '../components.tsx';

/**
 * Шаг 82: сводка экрана тени — метрики и график решений по суткам. Шаг 83 (облик по Primer): без тёмной панели, градиентов и
 * анимаций — белые карточки-плитки с тонкой границей и крупным числом. Шаг 84: график — столбиками с осью значений.
 * Тексты — прежние подписи плиток; подпись графика — шага 82.
 */

/** Деления оси значений: 3–4 «круглых» шага (1, 2, 2,5, 5 × 10ⁿ) от нуля до значения не меньше наибольшего */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * pow).find((st) => st >= raw) ?? 10 * pow;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Math.round(i * step * 1000) / 1000);
}

/**
 * Шаг 84: решения по суткам — столбиками цвета успеха Primer (дневные счётчики дискретны, столбик читается лучше линии), ось значений с
 * делениями и линиями сетки цвета границы; у недели — число над столбиком, у месяца — только подсказкой. Без анимации
 */
function DayChart({ chart }: { chart: ShadowChartView }) {
  const m = useMessages();
  const nf = new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US');
  const n = chart.points.length;
  const ticks = axisTicks(Math.max(0, ...chart.points.map((p) => p.value)));
  const top = ticks[ticks.length - 1]!;
  // Шаг 85: ширина ряда подписей — измеряется; на узком экране подписи прореживаются, числа над столбиками уходят в подсказку
  const daysRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = daysRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  // У месяца подписи — около шести, последняя (сегодня) — всегда; при тесноте — реже
  const every = dayLabelStep(chart.points.map((p) => p.label), width);
  const labelled = (i: number) => dayLabelled(i, n, every);
  const values = barValuesFit(chart.points.map((p) => nf.format(p.value)), width);
  return (
    <figure className="card day-chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <div className="chart-body">
        <div className="chart-axis" aria-hidden="true">
          {ticks.map((t) => <span key={t} style={{ bottom: `${(t / top) * 100}%` }}>{nf.format(t)}</span>)}
        </div>
        <div className="chart-plot">
          {ticks.map((t) => <span key={t} className="chart-grid" style={{ bottom: `${(t / top) * 100}%` }} aria-hidden="true" />)}
          <div className="chart-bars">
            {chart.points.map((p, i) => (
              <div key={p.day} className={`chart-slot${p.partial ? ' today' : ''}`} title={p.title}>
                {values ? <span className="chart-value">{nf.format(p.value)}</span> : null}
                <span className="chart-bar" style={{ height: p.value > 0 ? `max(2px, ${(p.value / top) * 100}%)` : '0' }} />
              </div>
            ))}
          </div>
        </div>
        <div className="chart-days" aria-hidden="true" ref={daysRef}>
          {chart.points.map((p, i) => <span key={p.day} className={p.partial ? 'today' : undefined}>{labelled(i) ? p.label : ''}</span>)}
        </div>
      </div>
    </figure>
  );
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {/* Шаг 84: строка подписи — у каждой плитки (пустая — неразрывным пробелом): числа плиток стоят на одной высоте */}
      <div className="stat-sub">{sub ?? '\u00a0'}</div>
    </div>
  );
}

export function ShadowHero({ view, periods }: { view: ShadowView; periods: ReactNode }) {
  const m = useMessages();
  const st = m.ui.shadow.stats;
  const nf = new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US');
  const s = view.summary;
  return (
    <section className="shadow-summary">
      <div className="summary-head">{periods}</div>
      <div className="stats">
        {/* Шаг 96 (аудит А1–А3): у каждой плитки — подпись, что значит число; «удержано» — цены, которые мы НЕ отправили (остатки — в сводке ниже) */}
        <Metric label={st.decisions} value={nf.format(s.decisions)} sub={st.decisionsSub} />
        <Metric label={st.changes} value={nf.format(s.changes)} sub={st.changesSub} />
        <Metric label={st.held} value={nf.format(s.heldPriceWrites)} sub={st.heldSub} />
        {s.floorSavings.length > 0 ? (
          <Metric label={st.savings} sub={st.notForecast}
            value={s.floorSavings.map((f) => <span key={f.currency} className="money-line">{m.money(f.minor, f.currency)}</span>)} />
        ) : null}
      </div>
      <DayChart chart={view.chart} />
    </section>
  );
}
