import { useEffect, useState, type ReactNode } from 'react';
import type { ShadowChartView, ShadowView } from '@repracer/console-model';
import { useMessages } from '../components.tsx';

/**
 * Шаг 82 («Ink & Ledger»): hero экрана тени — единственное смелое место консоли. Чернильная панель: четыре метрики крупно цифрами
 * IBM Plex Mono, денежная «Without the floor» — самая крупная, изумрудом; под ними — решения тени по суткам, график от руки (inline SVG,
 * без библиотек). Одна оркестрованная анимация на загрузку: числа считаются вверх, линия прорисовывается слева направо — одним ходом
 * времени, один раз на рабочее пространство за жизнь страницы; при `prefers-reduced-motion` её нет вовсе. Тексты — прежние подписи
 * плиток шага 77, новая — только подпись графика.
 */

const DURATION_MS = 1200;
const played = new Set<string>();

function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

/** Ход анимации 0…1 (ease-out cubic); без анимации — сразу 1. Решение «играть ли» — чистое, отметка «сыграно» — в эффекте */
function useIntro(key: string): number {
  const [play] = useState(() => !played.has(key) && !reducedMotion());
  const [t, setT] = useState(play ? 0 : 1);
  useEffect(() => {
    played.add(key);
    if (!play) return;
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const x = Math.min(1, (now - start) / DURATION_MS);
      setT(1 - (1 - x) ** 3);
      if (x < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [key, play]);
  return t;
}

/**
 * Плавная линия через точки — монотонная кубическая (Фрич — Карлсон): между двумя точками кривая не выходит за их значения, то есть не
 * рисует провалов и пиков, которых в данных нет (Catmull-Rom проседал перед резким ростом ниже ровной недели)
 */
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
const H = 140;
const PAD_X = 2.5; // процентов ширины
const TOP = 10;
const BOTTOM = H - 4;

function DayChart({ chart, t }: { chart: ShadowChartView; t: number }) {
  const n = chart.points.length;
  // Запас сверху: ровная неделя не прилипает к краю панели и не выглядит упором в потолок
  const max = Math.max(1, ...chart.points.map((p) => p.value)) * 1.18;
  const xPct = (i: number) => (n === 1 ? 50 : PAD_X + (i / (n - 1)) * (100 - 2 * PAD_X));
  const yOf = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const pts = chart.points.map((p, i) => [(xPct(i) / 100) * W, yOf(p.value)] as const);
  const line = smoothPath(pts);
  const area = pts.length > 0 ? `${line} L${pts[pts.length - 1]![0].toFixed(2)},${H} L${pts[0]![0].toFixed(2)},${H} Z` : '';
  // У месяца подписи — через одну пятую, последняя (сегодня) — всегда
  const every = n > 10 ? Math.ceil(n / 6) : 1;
  return (
    <figure className="hero-chart" aria-label={chart.title}>
      <figcaption>{chart.title}</figcaption>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--accent-on-ink)" stopOpacity="0.34" />
              <stop offset="1" stopColor="var(--accent-on-ink)" stopOpacity="0" />
            </linearGradient>
            {/* Заливка проявляется вслед за линией: маска открывается слева направо тем же ходом времени */}
            <clipPath id="hero-reveal"><rect x="0" y="0" width={W * t} height={H} /></clipPath>
          </defs>
          {[0.25, 0.5, 0.75].map((f) => <line key={f} className="grid" x1="0" x2={W} y1={TOP + f * (BOTTOM - TOP)} y2={TOP + f * (BOTTOM - TOP)} vectorEffect="non-scaling-stroke" />)}
          <line className="base" x1="0" x2={W} y1={BOTTOM} y2={BOTTOM} vectorEffect="non-scaling-stroke" />
          <path className="area" d={area} fill="url(#hero-area)" clipPath="url(#hero-reveal)" />
          {/* Без non-scaling-stroke: вместе с pathLength он ломает штрих, и линия не дорисовывается до конца */}
          <path className="line" d={line} pathLength={1} strokeDasharray="1" strokeDashoffset={1 - t} />
        </svg>
        {/* Точки — поверх SVG разметкой: в растянутом SVG круг стал бы эллипсом; подсказка — дата и число решений */}
        {chart.points.map((p, i) => (
          <span key={p.day} className={`dot${i === n - 1 ? ' last' : ''}`} title={p.title}
            style={{ left: `${xPct(i)}%`, top: `${(yOf(p.value) / H) * 100}%`, opacity: xPct(i) / 100 <= t + 0.001 ? 1 : 0 }} />
        ))}
      </div>
      <div className="chart-days" aria-hidden="true">
        {chart.points.map((p, i) => (i % every === 0 || i === n - 1) && !(i !== n - 1 && n - 1 - i < every / 2)
          ? <span key={p.day} style={{ left: `${xPct(i)}%` }} className={i === n - 1 ? 'today' : undefined}>{p.label}</span> : null)}
      </div>
    </figure>
  );
}

function Metric({ label, value, sub, money }: { label: string; value: ReactNode; sub?: string; money?: boolean }) {
  return (
    <div className={`hero-metric${money ? ' hero-money' : ''}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function ShadowHero({ worldId, view, periods }: { worldId: string; view: ShadowView; periods: ReactNode }) {
  const m = useMessages();
  const st = m.ui.shadow.stats;
  const t = useIntro(worldId);
  const nf = new Intl.NumberFormat(m.locale === 'de' ? 'de-DE' : 'en-US');
  const count = (v: number) => nf.format(Math.round(v * t));
  const s = view.summary;
  return (
    <section className="shadow-hero">
      <div className="hero-head">{periods}</div>
      <div className={`hero-metrics${s.floorSavings.length > 0 ? ' with-money' : ''}`}>
        <Metric label={st.decisions} value={count(s.decisions)} />
        <Metric label={st.changes} value={count(s.changes)} />
        <Metric label={st.held} value={count(s.heldWrites)} />
        {s.floorSavings.length > 0 ? (
          <Metric money label={st.savings} sub={st.notForecast}
            value={s.floorSavings.map((f) => <span key={f.currency} className="money-line">{m.money(Math.round(f.minor * t), f.currency)}</span>)} />
        ) : null}
      </div>
      <DayChart chart={view.chart} t={t} />
    </section>
  );
}
