import { useState } from 'react';
import { LIST_PAGE_DEFAULT, type DecisionListItem, type DecisionListView, type DecisionTrace, type ListQuery, type StepStatus } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, Gaps, href, Load, Pager, ReasonLine, useMessages } from '../components.tsx';

const STATUS_TONE: Readonly<Record<StepStatus, string>> = { OK: 'ok', STOP: 'stop', WARN: 'warn', SKIPPED: 'off', UNKNOWN: 'unknown' };

export function DecisionsView({ worldId, items }: { worldId: string; items: readonly DecisionListItem[] }) {
  const m = useMessages();
  const t = m.ui.trace;
  return (
    <section>
      <h2>{t.listTitle}</h2>
      {items.length === 0 ? <p className="muted">{t.noDecisions}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{t.columns.when}</th><th>{t.columns.unit}</th><th>{t.columns.outcome}</th><th>{t.columns.price}</th><th>{t.columns.reason}</th><th /></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.decisionId}>
                  <td className="nowrap">{d.decidedAt}</td>
                  <td>{d.unit?.label ?? m.ui.common.noValue}</td>
                  <td><Badge tone={d.tone}>{d.outcome}</Badge>{d.dangerous ? <> <Badge tone="stop">{t.dangerousBadge}</Badge></> : null}</td>
                  <td className="num">{d.price}</td>
                  <td>{d.reason}</td>
                  <td><a href={href(worldId, 'decisions', d.decisionId)}>{t.why}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function TraceView({ trace }: { trace: DecisionTrace }) {
  const m = useMessages();
  const t = m.ui.trace;
  return (
    <article className="trace">
      <p><a href={href(trace.worldId, 'decisions')}>{t.back}</a></p>
      <h2>{t.pageTitle}</h2>
      <p className={`headline tone-${trace.tone}`}>{trace.headline}{trace.dangerous ? <> <Badge tone="stop">{t.dangerousBadge}</Badge></> : null}</p>
      <p className="muted">{t.meta(trace.unit?.label ?? m.ui.common.noValue, trace.decisionId, trace.decidedAt)}</p>
      <ol className="steps">
        {trace.steps.map((step) => (
          <li key={step.key} className={`step status-${step.status}`}>
            <div className="step-head">
              <h3>{step.title}</h3>
              <Badge tone={STATUS_TONE[step.status]}>{t.status[step.status]}</Badge>
            </div>
            <p>{step.summary}</p>
            {step.items.length > 0 ? (
              <ul className="items">
                {step.items.map((item, i) => (
                  <li key={i}>
                    <span className={`mark outcome-${item.outcome ?? 'INFO'}`}>{t.marks[item.outcome ?? 'INFO']}</span>{' '}
                    <span className="label">{item.label}</span>
                    {item.value ? <span>: {item.value}</span> : null}
                    {item.reason ? <ReasonLine reason={item.reason} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
      <Gaps gaps={trace.gaps} />
    </article>
  );
}

export function DecisionsScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<DecisionListView>(`${worldPath(worldId, 'decisions')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
  return (
    <Load resource={resource} retry={retry}>
      {(view) => (<><DecisionsView worldId={worldId} items={view.items} /><Pager page={view.page} query={query} onQuery={setQuery} /></>)}
    </Load>
  );
}

export function TraceScreen({ worldId, decisionId }: { worldId: string; decisionId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<DecisionTrace>(worldPath(worldId, 'decisions', decisionId), m.locale);
  return <Load resource={resource} retry={retry}>{(trace) => <TraceView trace={trace} />}</Load>;
}
