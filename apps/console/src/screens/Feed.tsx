import type { PriceFeedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, Gaps, href, Load, ReasonLine, useMessages } from '../components.tsx';

/** Лента изменений цен (шаг 21): запись в канал от решения до итога, новые сверху */
export function FeedScreenView({ view }: { view: PriceFeedView }) {
  const m = useMessages();
  const f = m.ui.feed;
  const c = f.columns;
  return (
    <section>
      <h2>{f.pageTitle}</h2>
      <p className="muted">{f.counts(view.counts)}</p>
      {view.items.length === 0 ? <p className="muted">{f.empty}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.when}</th><th>{c.offer}</th><th>{c.from}</th><th>{c.to}</th><th>{c.change}</th><th>{c.status}</th><th>{c.source}</th><th>{c.reason}</th><th /></tr></thead>
            <tbody>
              {view.items.map((i, n) => (
                <tr key={n}>
                  <td className="nowrap">{i.at}</td>
                  <td>{i.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num">{i.from ?? '–'}</td>
                  <td className="num">{i.to}</td>
                  <td className="num">{i.change ?? '–'}</td>
                  <td><Badge tone={i.tone}>{i.status}</Badge></td>
                  <td>{i.source}</td>
                  <td>{i.reason ? <ReasonLine reason={i.reason} /> : null}</td>
                  <td>{i.decisionId ? <a href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a> : null}</td>
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

export function FeedScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<PriceFeedView>(worldPath(worldId, 'feed'), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <FeedScreenView view={view} />}</Load>;
}
