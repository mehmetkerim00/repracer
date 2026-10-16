import { useState } from 'react';
import { BUYBOX_SHARE_KEEP_DAYS, periodSearch, type CompetitionView, type CompetitorColumns, type Period } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, href, Load, NotFound, useMessages } from '../components.tsx';
import { PeriodPicker } from '../date-range.tsx';

/**
 * Шаг 97 [Р-219…Р-221]: таблица конкурентов — одна у страницы Competition и у квитанции «Why this price». Наша строка выделена; у квитанции
 * двигавшиеся помечены «было → стало». Колонки из одного значения — подписью под таблицей (правило таблиц шага 96.2)
 */
export interface CompetitorTableRow {
  seller: string; self: boolean; landed: string; landedKnown: boolean;
  shipping?: string | null; fulfilment: string | null; rating: string | null; buyBox: boolean | null;
  move?: 'UP' | 'DOWN' | 'APPEARED' | 'GONE' | null; was?: string | null;
}

export function CompetitorTable({ rows, columns, shipping = false, foot }: {
  rows: readonly CompetitorTableRow[]; columns: CompetitorColumns; shipping?: boolean; foot?: readonly string[];
}) {
  const m = useMessages();
  const c = m.ui.competition;
  const t = m.ui.trace.competitors;
  const notes = [...columns.uniform, ...(columns.landedKnown ? [] : [c.noShipping]), ...(foot ?? [])];
  return (
    <div className="table-wrap">
      <table className="competitors">
        <thead>
          <tr>
            <th>{c.columns.seller}</th>
            <th className="num">{columns.landedKnown ? c.columns.landed : c.columns.price}</th>
            {shipping ? <th className="num">{c.columns.shipping}</th> : null}
            {columns.fulfilment ? <th>{c.columns.fulfilment}</th> : null}
            {columns.rating ? <th>{c.columns.rating}</th> : null}
            {columns.buyBox ? <th>{c.columns.buyBox}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.seller}-${i}`} className={`${r.self ? 'self-row' : ''}${r.move === 'GONE' ? ' gone-row' : ''}`}>
              <td className="seller">{r.self ? <strong>{r.seller}</strong> : r.seller}</td>
              <td className="num cur landed">
                {r.move === 'UP' || r.move === 'DOWN'
                  ? <><span className="was">{r.was}</span> → <strong>{r.landed}</strong> <span className={`move move-${r.move.toLowerCase()}`} aria-label={t.moved[r.move]}>{r.move === 'DOWN' ? '↓' : '↑'}</span></>
                  : r.move === 'GONE' ? <><s>{r.landed}</s> <span className="move move-gone">{t.moved.GONE}</span></>
                    : r.move === 'APPEARED' ? <>{r.landed} <span className="move move-new">{t.moved.APPEARED}</span></>
                      : r.landed}
              </td>
              {shipping ? <td className="num cur">{r.shipping ?? '–'}</td> : null}
              {columns.fulfilment ? <td>{r.fulfilment ?? '–'}</td> : null}
              {columns.rating ? <td>{r.rating ?? '–'}</td> : null}
              {columns.buyBox ? <td>{r.buyBox ? <Badge tone="ok">{c.buyBoxBadge}</Badge> : '–'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 ? <p className="table-foot">{notes.join(' ')}</p> : null}
    </div>
  );
}

const HOLDER_TONE: Readonly<Record<string, string>> = { SELF: 'ok', OTHER: 'warn', NONE: 'off', UNKNOWN: 'unknown' };

export function CompetitionScreenView({ view, period, onPeriod }: { view: CompetitionView; period: Period; onPeriod: (p: Period) => void }) {
  const m = useMessages();
  const c = m.ui.competition;
  return (
    <section className="competition">
      <p className="back"><a href={href(view.worldId, 'products')}>{c.back}</a></p>
      <h2>{c.pageTitle}</h2>
      <p className="subtitle">{view.unit.label} · {c.subtitle}</p>
      {view.state === 'NO_COMPETITOR_DATA' ? <section className="card"><p className="notice">{view.stateText}</p></section> : <>
        {/* Нынешняя картина: держатель, наше место и разрыв до победителя */}
        <section className="card competition-now">
          <h3>{c.nowTitle}</h3>
          {view.state === 'NO_SNAPSHOT' ? <p className="muted empty">{view.stateText}</p> : <>
            <p className="holder"><Badge tone={HOLDER_TONE[view.holder?.kind ?? 'UNKNOWN'] ?? 'unknown'}>{view.holder?.text}</Badge></p>
            <ul className="plain facts">
              {view.holder?.why ? <li className="muted">{view.holder.why}</li> : null}
              {view.buyBoxPrice ? <li>{view.buyBoxPrice}</li> : null}
              {view.position ? <li>{view.position}</li> : null}
              {view.gap ? <li>{view.gap}</li> : null}
              {view.observed ? <li className="muted small">{c.observed} <span className="when" title={view.observed.at}>{view.observed.when}</span> · {view.observed.source}</li> : null}
            </ul>
            <CompetitorTable rows={view.rows} columns={view.columns} shipping={view.columns.shipping} />
          </>}
        </section>
        {/* Доля Buy Box за период — по снимкам, а не по продажам [Р-220]; глубже 45 суток отрезков нет — календарь это говорит */}
        <section className="card competition-share">
          <h3>{c.share.title}</h3>
          <div className="toolbar field-toolbar period-bar">
            <PeriodPicker value={period} onChange={onPeriod} maxDays={BUYBOX_SHARE_KEEP_DAYS} />
            {view.share.clipped ? <span className="filters-count">{c.share.limit}</span> : null}
          </div>
          {view.share.value !== null ? <p className="big">{view.share.value}</p> : null}
          <p>{view.share.note}</p>
          {view.share.coverage ? <p className="small muted">{view.share.coverage}</p> : null}
          <p className="note">{view.share.caption}</p>
        </section>
        {/* Почему не в Buy Box — только по данным, которые канал назвал; сноска — всегда */}
        {view.diagnosis ? (
          <section className="card competition-why">
            <h3>{c.why.title}</h3>
            {view.diagnosis.reasons.length > 0 ? <ul className="reasons-list">{view.diagnosis.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            <p className="note">{view.diagnosis.footnote}</p>
          </section>
        ) : null}
      </>}
    </section>
  );
}

export function CompetitionScreen({ worldId, writeScopeId }: { worldId: string; writeScopeId: string }) {
  const m = useMessages();
  const c = m.ui.competition;
  const [period, setPeriod] = useState<Period>({ preset: '7d' });
  const [resource, retry] = useResource<CompetitionView>(`${worldPath(worldId, 'competition', writeScopeId)}?${periodSearch(period)}`, m.locale);
  const missing = <NotFound title={c.missingTitle} text={c.missingText} back={c.back} href={href(worldId, 'products')} />;
  return <Load shape="cards" resource={resource} retry={retry} notFound={missing}>{(view) => <CompetitionScreenView view={view} period={period} onPeriod={setPeriod} />}</Load>;
}
