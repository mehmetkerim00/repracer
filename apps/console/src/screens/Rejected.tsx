import type { RejectedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, Gaps, href, Load, ReasonLine, useMessages } from '../components.tsx';

/** Экран C: опасные изменения (отклонение от границы больше 10 %) отдельно от скорректированных [Р-73] */
export function RejectedScreenView({ view }: { view: RejectedView }) {
  const m = useMessages();
  const r = m.ui.rejected;
  const c = r.columns;
  return (
    <section>
      <h2>{r.pageTitle}</h2>
      <p className="headline">{view.headline}</p>
      <p className="muted">{r.summary(view.summary)}</p>
      {view.groups.length > 0 ? (
        <ul className="groups">
          {view.groups.map((g) => <li key={g.code}><Badge tone="off">{g.count}</Badge> {g.title}</li>)}
        </ul>
      ) : null}
      {view.items.length === 0 ? <p className="muted">{r.none}</p> : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>{c.when}</th><th>{c.where}</th><th>{c.kind}</th><th>{c.proposed}</th><th>{c.before}</th><th>{c.change}</th><th>{c.limit}</th><th>{c.deviation}</th><th>{c.reason}</th><th /></tr>
            </thead>
            <tbody>
              {view.items.map((item, i) => (
                <tr key={i} className={item.intervention === 'DANGEROUS' ? 'dangerous' : ''}>
                  <td className="nowrap">{item.at}</td>
                  <td>{item.unit?.label ?? item.productRef ?? m.ui.common.noValue}</td>
                  <td>
                    <Badge tone={item.tone}>{r.kinds[item.kind]}</Badge>
                    {item.intervention ? <div className="small"><Badge tone={item.intervention === 'DANGEROUS' ? 'stop' : 'progress'}>{r.interventions[item.intervention]}</Badge></div> : null}
                  </td>
                  <td className="num">{item.proposed ?? '–'}</td>
                  <td className="num">{item.current ?? '–'}</td>
                  <td className="num">{item.change ?? '–'}</td>
                  <td>{item.limit ?? '–'}</td>
                  <td className="num">{item.deviation ?? '–'}</td>
                  <td><ReasonLine reason={item.reason} /></td>
                  <td>{item.decisionId ? <a href={href(view.worldId, 'decisions', item.decisionId)}>{r.path}</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function RejectedScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<RejectedView>(worldPath(worldId, 'rejected'), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <RejectedScreenView view={view} />}</Load>;
}
