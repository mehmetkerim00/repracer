import { useState } from 'react';
import { periodPhrase, periodSearch, type Messages, type Period, type RejectedItem, type RejectedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, collapseRepeats, commonZone, Gaps, href, Load, LocalPager, REPORT_PAGE_SIZE, useMessages, When, WhenHead } from '../components.tsx';
import { rangeText } from '../date-range.tsx';

/** Шаг 96.2: короткая подпись периода — в чипе повторов «×11 · 7d» */
export function periodShort(period: Period, m: Messages): string {
  return 'preset' in period ? m.ui.period.short[period.preset] : rangeText(period.from, period.to, m.locale);
}

/**
 * Шаг 96.2 (решение владельца по G2): колонка, у которой на странице одно значение у трёх и больше строк, — не колонка, а фраза подписи
 * таблицы (как «Held how» в пункте D); у двух строк и меньше колонка остаётся
 */
export function uniformOf<T>(rows: readonly T[], key: (row: T) => string): string | null {
  if (rows.length < 3) return null;
  const first = key(rows[0]!);
  return rows.every((r) => key(r) === first) ? first : null;
}

/**
 * Шаг 96.2 (B): причина в строке — короткая категория (заголовок причины) и чип «×N · период»; полное предложение — только на
 * квитанции решения (Decision path) и подсказкой ячейки. Прежде каждая строка повторяла длинное предложение почти без изменений.
 * Одна категория у всей страницы — в подписи (`ReasonPlan.caption`), в строке остаётся чип; один и тот же чип — тоже в подписи, и
 * колонки нет
 */
export interface ReasonPlan { column: boolean; category: boolean; caption: string | null }
export function reasonPlan(rows: ReadonlyArray<{ title: string; count: number }>, period: Period, m: Messages): ReasonPlan {
  const chip = (n: number) => (n > 1 ? m.ui.rejected.repeat(n, periodShort(period, m)) : '');
  const category = uniformOf(rows, (r) => r.title);
  const chips = uniformOf(rows, (r) => chip(r.count));
  if (category === null) return { column: true, category: true, caption: null };
  const each = chips !== null && chips !== '' ? ` — ${m.ui.rejected.eachRepeat(chips)}` : '';
  return { column: chips === null, category: false, caption: `${m.ui.rejected.uniformReason(category)}${chips !== null ? each : ''}` };
}
export function ShortReason({ title, count, period, category = true }: { title: string; count: number; period: Period; category?: boolean }) {
  const m = useMessages();
  return <>{category ? <span className="reason-category">{title}</span> : null}{count > 1 ? <span className="repeat-chip">{m.ui.rejected.repeat(count, periodShort(period, m))}</span> : null}</>;
}

/**
 * Шаг 96.2 (A): одна история цены строки — «было → хотела стратегия → стало»: отвергнутая цель зачёркнута и приглушена, итог — полужирный.
 * Подпись «was → wanted → set» — один раз в шапке колонки
 */
function PriceHistory({ item }: { item: RejectedItem }) {
  const parts = [
    item.current ? <span key="was">{item.current}</span> : null,
    item.proposed ? <s key="wanted" title={item.change ?? undefined}>{item.proposed}</s> : null,
    item.set ? <strong key="set">{item.set}</strong> : null,
  ].filter((x) => x !== null);
  if (parts.length === 0) return <>–</>;
  return <>{parts.flatMap((x, i) => (i === 0 ? [x] : [' → ', x]))}</>;
}

/** Шаг 96.2 (E): счётчики периода — по чипу на категорию; ненулевые — акцентом, нулевые — приглушённо, но видны все */
const STAT_KEYS = ['dangerous', 'corrected', 'unresolvable', 'limiterHolds', 'stops', 'inputRejects', 'halts'] as const;

/**
 * Экран C: опасные изменения (отклонение от границы больше 10 %) отдельно от скорректированных [Р-73].
 * Шаг 95 [Р-217]: страницы «Stopped changes» нет — список делится вкладками Protections: `only="STOP"` — то, что остановил человек,
 * `only="RULES"` — всё остальное (границы, проверка входов, перепроверка при отправке, остановка витрины). Окно — та же неделя целиком
 * (список не постраничный), поэтому деление на экране ничего не теряет.
 * Шаг 96.2: одна пилюля состояния на строку (corrected / dangerous / stopped), история цены одной колонкой, «Beyond bound» — только если в
 * периоде есть опасный случай, причина — категорией и чипом «×N»; группы причин — фильтры таблицы (новый период сбрасывает фильтр:
 * компонент пересоздаётся по ключу периода)
 */
export function RejectedScreenView({ view, only = null, period = { preset: '7d' } }: { view: RejectedView; only?: 'STOP' | 'RULES' | null; period?: Period }) {
  const m = useMessages();
  const r = m.ui.rejected;
  const p = m.ui.protections;
  const c = r.columns;
  const phrase = periodPhrase(period, m);
  const items = only === 'STOP' ? view.items.filter((i) => i.kind === 'STOP') : only === 'RULES' ? view.items.filter((i) => i.kind !== 'STOP') : view.items;
  const [filter, setFilter] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const choose = (code: string | null) => { setFilter(code); setOffset(0); };
  const filtered = filter ? items.filter((i) => i.reason.code === filter) : items;
  // Шаг 96 (Б12): повторы — строкой «×N» (то же предложение, тот же вид, та же причина), страницы по 50
  const groups = collapseRepeats(filtered, (i) => `${i.unit?.writeScopeId ?? i.productRef ?? ''}|${i.kind}|${i.reason.code}|${i.intervention ?? ''}`);
  const shown = groups.slice(offset, offset + REPORT_PAGE_SIZE);
  const zone = commonZone(shown.map((g) => g.item.at));
  // A: колонка «Beyond bound» — только когда в периоде есть хотя бы один опасный случай
  const beyond = items.some((i) => i.intervention === 'DANGEROUS');
  const state = (i: RejectedItem): [string, string] => i.intervention === 'DANGEROUS' ? ['stop', r.interventions.DANGEROUS]
    : i.intervention === 'CORRECTED' ? ['warn', r.interventions.CORRECTED] : ['off', r.stateStopped];
  // решение по G2: одно состояние у всей страницы — пилюлей в подписи; одна причина — фразой в подписи
  const oneState = uniformOf(shown, (g) => state(g.item)[1]);
  const stateOf = oneState === null ? null : state(shown[0]!.item);
  const reasons = reasonPlan(shown.map((g) => ({ title: g.item.reason.title, count: g.count })), period, m);
  return (
    <section>
      {only === null ? <><h2>{r.pageTitle}</h2><p className="subtitle">{m.ui.app.subtitles.rejected}</p></> : only === 'RULES' ? <h3>{p.otherTitle(phrase)}</h3> : null}
      {/* Шаг 79: итог, сводка и группы — карточкой-сводкой, а не текстом на фоне страницы */}
      {only === 'STOP' ? (
        <section className="card summary-card">
          <p className="headline">{p.peopleHeadline(items.length, phrase)}</p>
          <p className="small"><a href={href(view.worldId, 'stop')}>{p.whoStopped}</a></p>
        </section>
      ) : (
        <section className="card summary-card">
          <p className="headline">{view.headline}</p>
          <ul className="stat-chips" aria-label={r.statsLabel}>
            {STAT_KEYS.map((k) => (
              <li key={k} className={`stat-chip${view.summary[k] > 0 ? ' on' : ''}`}><span>{r.stats[k]}</span> <strong>{view.summary[k]}</strong></li>
            ))}
          </ul>
          {view.groups.length > 0 ? (
            <div className="reason-filters" role="group" aria-label={r.filters.label}>
              {view.groups.map((g) => (
                <button key={g.code} type="button" className={`reason-filter${filter === g.code ? ' on' : ''}`} aria-pressed={filter === g.code}
                  onClick={() => choose(filter === g.code ? null : g.code)}><span className="count">{g.count}</span> {g.title}</button>
              ))}
              {filter ? <button type="button" className="clear-filter" aria-label={r.filters.clear} title={r.filters.clear} onClick={() => choose(null)}>×</button> : null}
            </div>
          ) : null}
        </section>
      )}
      {items.length === 0 ? <p className="muted empty">{only === 'STOP' ? p.peopleNone : only === 'RULES' ? p.rulesNone(phrase) : r.none}</p> : (
        <>
        {stateOf || reasons.caption ? (
          <p className="section-sub uniform-caption also-caption">
            {stateOf ? <span className="uniform-state">{r.uniformState} <Badge tone={stateOf[0]}>{stateOf[1]}</Badge></span> : null}
            {reasons.caption ? <span className="uniform-reason">{reasons.caption}</span> : null}
          </p>
        ) : null}
        <div className="table-wrap">
          <table className="dense sticky-end cardify also-stopped">
            <thead>
              <tr>
                <th><WhenHead label={c.when} zone={zone} /></th><th>{c.where}</th>{stateOf ? null : <th>{r.stateColumn}</th>}
                <th className="num">{r.historyColumn}<span className="legend">{r.historyLegend}</span></th>
                {beyond ? <th className="num">{c.deviation}</th> : null}
                {reasons.column ? <th>{c.reason}</th> : null}<th />
              </tr>
            </thead>
            <tbody>
              {shown.map(({ item, count }, i) => {
                const [tone, text] = state(item);
                return (
                  <tr key={i} className={item.intervention === 'DANGEROUS' ? 'dangerous' : ''}>
                    <td className="nowrap" data-label={`${c.when}${zone ? ` · ${zone}` : ''}`}><When value={item.at} zone={!zone} /></td>
                    <td className="offer card-title">{item.unit?.label ?? item.productRef ?? m.ui.common.noValue}</td>
                    {stateOf ? null : <td className="state card-status"><Badge tone={tone}>{text}</Badge></td>}
                    <td className="num money cur history" data-label={`${r.historyColumn} · ${r.historyLegend}`}><PriceHistory item={item} /></td>
                    {beyond ? <td className="num" data-label={c.deviation}>{item.deviation ?? '–'}</td> : null}
                    {reasons.column ? <td className="reason-cell" data-label={c.reason} title={item.reason.text}><ShortReason title={item.reason.title} count={count} period={period} category={reasons.category} /></td> : null}
                    <td className="nowrap card-action">{item.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', item.decisionId)}>{r.path}</a> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
      <LocalPager total={groups.length} offset={offset} onOffset={setOffset} />
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function RejectedScreen({ worldId, only, period }: { worldId: string; only: 'STOP' | 'RULES'; period: Period }) {
  const m = useMessages();
  const [resource, retry] = useResource<RejectedView>(`${worldPath(worldId, 'rejected')}?${periodSearch(period)}`, m.locale);
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <RejectedScreenView view={view} only={only} period={period} />}</Load>;
}
