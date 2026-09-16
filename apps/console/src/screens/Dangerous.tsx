import type { DangerousReportView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, Gaps, href, Load, ReasonLine, useMessages } from '../components.tsx';

const PERIODS = [1, 7, 30] as const;

/** Отчёт «границы остановили N опасных изменений» [Р-73] за период */
export function DangerousScreenView({ view }: { view: DangerousReportView }) {
  const m = useMessages();
  const d = m.ui.dangerous;
  const c = d.columns;
  return (
    <section>
      <h2>{d.pageTitle}</h2>
      <nav className="tabs small">
        {PERIODS.map((p) => <a key={p} href={href(view.worldId, 'dangerous', String(p))} className={p === view.days ? 'active' : ''}>{d.period(p)}</a>)}
      </nav>
      <p className="headline">{view.headline}</p>
      <p className="muted small">{view.from} – {view.to}</p>
      {view.truncated ? <p className="notice">{d.truncated}</p> : null}
      {view.count === 0 ? <p className="muted">{d.none}</p> : (
        <>
          <div className="cards">
            <div className="card emphasis"><h3>{d.prevented}</h3>{view.prevented.map((p) => <p key={p.currency} className="big">{p.amount}</p>)}</div>
            {view.worst ? <div className="card"><h3>{d.worst}</h3><p className="big">{view.worst.deviation}</p><p className="small muted">{view.worst.unit?.label} · {view.worst.proposed} / {view.worst.bound}</p></div> : null}
            <div className="card"><h3>{d.byBound}</h3><ul className="small">{view.byBound.map((b) => <li key={b.code}><Badge tone="stop">{b.count}</Badge> {b.title}</li>)}</ul></div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>{c.when}</th><th>{c.offer}</th><th>{c.proposed}</th><th>{c.bound}</th><th>{c.deviation}</th><th>{c.reason}</th><th /></tr></thead>
              <tbody>
                {view.items.map((i) => (
                  <tr key={i.decisionId} className="dangerous">
                    <td className="nowrap">{i.at}</td>
                    <td>{i.unit?.label ?? m.ui.common.noValue}</td>
                    <td className="num">{i.proposed}</td>
                    <td className="num">{i.bound}</td>
                    <td className="num">{i.deviation}</td>
                    <td><ReasonLine reason={i.reason} /></td>
                    <td><a href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function DangerousScreen({ worldId, days }: { worldId: string; days: number }) {
  const m = useMessages();
  const [resource, retry] = useResource<DangerousReportView>(`${worldPath(worldId, 'dangerous')}?days=${days}`, m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <DangerousScreenView view={view} />}</Load>;
}
