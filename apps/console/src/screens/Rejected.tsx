import type { RejectedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, Gaps, href, Load, ReasonLine, useMessages, When, WithAvatar } from '../components.tsx';

/** Экран C: опасные изменения (отклонение от границы больше 10 %) отдельно от скорректированных [Р-73] */
export function RejectedScreenView({ view }: { view: RejectedView }) {
  const m = useMessages();
  const r = m.ui.rejected;
  const c = r.columns;
  return (
    <section>
      <h2>{r.pageTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.rejected}</p>
      {/* Шаг 79: итог, сводка и группы — карточкой-сводкой, а не текстом на фоне страницы */}
      <section className="card summary-card">
        <p className="headline">{view.headline}</p>
        <p className="muted small">{r.summary(view.summary)}</p>
        {view.groups.length > 0 ? (
          <ul className="groups">
            {view.groups.map((g) => <li key={g.code}><Badge tone="off">{g.count}</Badge> {g.title}</li>)}
          </ul>
        ) : null}
      </section>
      {view.items.length === 0 ? <p className="muted empty">{r.none}</p> : (
        <div className="table-wrap">
          <table className="dense sticky-end">
            <thead>
              <tr><th>{c.when}</th><th>{c.where}</th><th>{c.kind}</th><th className="num">{c.proposed}</th><th className="num">{c.before}</th><th>{c.limit}</th><th className="num">{c.deviation}</th><th>{c.reason}</th><th /></tr>
            </thead>
            <tbody>
              {view.items.map((item, i) => (
                <tr key={i} className={item.intervention === 'DANGEROUS' ? 'dangerous' : ''}>
                  <td className="nowrap"><When value={item.at} /></td>
                  <td className="offer">{item.unit ? <WithAvatar label={item.unit.label}>{item.unit.label}</WithAvatar> : item.productRef ?? m.ui.common.noValue}</td>
                  <td className="pills">
                    <Badge tone={item.tone}>{r.kinds[item.kind]}</Badge>
                    {/* шаг 77: «скорректировано» — спокойным серым, опасное — красным; обе пилюли в строку */}
                    {item.intervention ? <Badge tone={item.intervention === 'DANGEROUS' ? 'stop' : 'off'}>{r.interventions[item.intervention]}</Badge> : null}
                  </td>
                  {/* Шаг 79 (ревью): изменение — подписью под предложенной ценой, а не своей колонкой: таблица помещается в окно */}
                  <td className="num money">{item.proposed ?? '–'}{item.change ? <div className="note">{item.change}</div> : null}</td>
                  <td className="num">{item.current ?? '–'}</td>
                  <td className="bound">{item.limit ?? '–'}</td>
                  <td className="num">{item.deviation ?? '–'}</td>
                  <td><ReasonLine reason={item.reason} /></td>
                  <td className="nowrap">{item.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', item.decisionId)}>{r.path}</a> : null}</td>
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
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <RejectedScreenView view={view} />}</Load>;
}
