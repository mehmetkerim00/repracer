import type { ReactNode } from 'react';
import type { ShadowChartView, ShadowView } from '@repracer/console-model';
import { useMessages } from '../components.tsx';

/**
 * Шаг 82: сводка экрана тени — метрики и график решений по суткам. Шаг 83 (облик по Primer): без тёмной панели, градиентов и
 * анимаций — белые карточки-плитки с тонкой границей и крупным числом, график — тонкая линия цвета успеха Primer с однотонной заливкой 8%.
 * Тексты — прежние подписи плиток; подпись графика — шага 82.
 */

/** Монотонная кубическая (Фрич — Карлсон): между двумя точками кривая не выходит за их значения — провалов и пиков, которых нет в данных */
function smoothPath(points: ReadonlyArray<readonly [number, number]>): string {
  const n = points.length;
  if (n === 0) return '';
  if (n === 1) return `M${points[0]![0]},${points[0]![1]}`;
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  const h = xs.slice(1).map((x, i) => x - xs[i]!);
  const d = ys.slice(1).map((y, i) => (y - ys[i]!) / h[i]!);
  const t: number[] = [d[0]!, ...d.slice(1).map((di, i) => (d[i]! * di <= 0 ? 0 : (d[i]! + di) / 2)), d[n - 2]!];
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i]! / d[i]!; const b = t[i + 1]! / d[i]!; const r = a * a + b * b;
    if (r > 9) { const k = 3 / Math.sqrt(r); t[i] = k * a * d[i]!; t[i + 1] = k * b * d[i]!; }
  }
  let path = `M${xs[0]!.toFixed(2)},${ys[0]!.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const third = h[i]! / 3;
    path += ` C${(xs[i]! + third).toFixed(2)},${(ys[i]! + t[i]! * third).toFixed(2)} ${(xs[i + 1]! - third).toFixed(2)},${(ys[i + 1]! - t[i + 1]! * third).toFixed(2)} ${xs[i + 1]!.toFixed(2)},${ys[i + 1]!.toFixed(2)}`;
  }
  return path;
}

/** Поле графика в единицах viewBox; по краям — поля, чтобы крайние подписи дней не обрезались */
const W = 1000;
const H = 120;
const PAD_X = 2.5; // процентов ширины
const TOP = 8;
const BOTTOM = H - 2;

function DayChart({ chart }: { chart: ShadowChartView }) {
  const n = chart.points.length;
  // Запас сверху: ровная неделя не прилипает к краю карточки
  const max = Math.max(1, ...chart.points.map((p) => p.value)) * 1.18;
  const xPct = (i: number) => (n === 1 ? 50 : PAD_X + (i / (n - 1)) * (100 - 2 * PAD_X));
  const yOf = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const pts = chart.points.map((p, i) => [(xPct(i) / 100) * W, yOf(p.value)] as const);
  const line = smoothPath(pts);
  const area = pts.length > 0 ? `${line} L${pts[pts.length - 1]![0].toFixed(2)},${H} L${pts[0]![0].toFixed(2)},${H} Z` : '';
  // У месяца подписи — через одну пятую, последняя (сегодня) — всегда
  const every = n > 10 ? Math.ceil(n / 6) : 1;
  return (
    <figure className="card day-chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="base" x1="0" x2={W} y1={BOTTOM} y2={BOTTOM} vectorEffect="non-scaling-stroke" />
          <path className="area" d={area} />
          <path className="line" d={line} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* Точки — разметкой поверх SVG: в растянутом SVG круг стал бы эллипсом; подсказка — дата и число решений */}
        {chart.points.map((p, i) => (
          <span key={p.day} className={`dot${i === n - 1 ? ' last' : ''}`} title={p.title}
            style={{ left: `${xPct(i)}%`, top: `${(yOf(p.value) / H) * 100}%` }} />
        ))}
      </div>
      <div className="chart-days" aria-hidden="true">
        {chart.points.map((p, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2)
          ? <span key={p.day} style={{ left: `${xPct(i)}%` }} className={i === n - 1 ? 'today' : undefined}>{p.label}</span> : null)}
      </div>
    </figure>
  );
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: string }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
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
        <Metric label={st.decisions} value={nf.format(s.decisions)} />
        <Metric label={st.changes} value={nf.format(s.changes)} />
        <Metric label={st.held} value={nf.format(s.heldWrites)} />
        {s.floorSavings.length > 0 ? (
          <Metric label={st.savings} sub={st.notForecast}
            value={s.floorSavings.map((f) => <span key={f.currency} className="money-line">{m.money(f.minor, f.currency)}</span>)} />
        ) : null}
      </div>
      <DayChart chart={view.chart} />
    </section>
  );
}
