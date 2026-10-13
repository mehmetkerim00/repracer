import { useState } from 'react';
import { LIST_PAGE_DEFAULT, type DecisionListItem, type DecisionListView, type DecisionTrace, type ListQuery, type StepStatus } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, commonZone, Gaps, href, Load, NotFound, Pager, ReasonLine, useMessages, When, WhenHead } from '../components.tsx';
import { Icon } from '../icons.tsx';

const STATUS_TONE: Readonly<Record<StepStatus, string>> = { OK: 'ok', STOP: 'stop', WARN: 'warn', SKIPPED: 'off', UNKNOWN: 'unknown' };
/** Шаг 81: знак исхода в карточке итога — по тону решения */
const VERDICT_ICON: Readonly<Record<string, string>> = { ok: 'check', warn: 'shieldCheck', stop: 'x', off: 'equal', unknown: 'help', progress: 'activity' };

export function DecisionsView({ worldId, items }: { worldId: string; items: readonly DecisionListItem[] }) {
  const m = useMessages();
  const t = m.ui.trace;
  const zone = commonZone(items.map((d) => d.decidedAt));
  return (
    <section>
      <h2>{t.listTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.decisions}</p>
      {items.length === 0 ? <p className="muted empty">{t.noDecisions}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th><WhenHead label={t.columns.when} zone={zone} /></th><th>{t.columns.unit}</th><th>{t.columns.outcome}</th><th className="num">{t.columns.price}</th><th>{t.columns.reason}</th><th /></tr></thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.decisionId}>
                  <td><When value={d.decidedAt} zone={!zone} /></td>
                  <td>{d.unit?.label ?? m.ui.common.noValue}</td>
                  <td><Badge tone={d.tone}>{d.outcome}</Badge>{d.dangerous ? <> <Badge tone="stop">{t.dangerousBadge}</Badge></> : null}</td>
                  <td className="money cur">{d.price}</td>
                  <td>{d.reason}</td>
                  <td className="num"><a className="row-link" href={href(worldId, 'decisions', d.decisionId)}>{t.why}</a></td>
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
      <p className="back"><a href={href(trace.worldId, 'decisions')}>{t.back}</a></p>
      <h2>{t.pageTitle}</h2>
      <p className="subtitle">{t.meta(trace.unit?.label ?? m.ui.common.noValue, trace.decisionId, trace.decidedAt)}
        {/* Шаг 76 (предполётный прогон демо): от решения — к границам и разбивке пола этого же предложения. Без ссылки вопрос «что
            помешает продать ниже себестоимости» вёл на экран товаров без поиска, где нужное предложение — на пятой странице */}
        {trace.unit ? <> · <a href={href(trace.worldId, 'bounds', trace.unit.writeScopeId)}>{m.ui.products.bounds}</a></> : null}</p>
      {/* Шаг 81: итог — карточкой своего тона: знак исхода, итоговая цена крупно (та же сумма, что во фразе), фраза итога под ней */}
      <section className={`verdict verdict-${trace.tone}`}>
        <span className="verdict-icon"><Icon name={VERDICT_ICON[trace.tone] ?? 'help'} size={22} /></span>
        <div className="verdict-body">
          {trace.headlinePrice ? <div className="verdict-price">{trace.headlinePrice}</div> : null}
          <p className="headline">{trace.headline}{trace.dangerous ? <> <Badge tone="stop">{t.dangerousBadge}</Badge></> : null}</p>
        </div>
      </section>
      {/* Шаг 79 (ревью): шаги расчёта — в карточке, а не на сером фоне страницы */}
      <section className="card trace-card">
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
      </section>
      <Gaps gaps={trace.gaps} />
    </article>
  );
}

export function DecisionsScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<DecisionListView>(`${worldPath(worldId, 'decisions')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
  return (
    <Load shape="table" resource={resource} retry={retry}>
      {(view) => (<><DecisionsView worldId={worldId} items={view.items} /><Pager page={view.page} query={query} onQuery={setQuery} /></>)}
    </Load>
  );
}

export function TraceScreen({ worldId, decisionId }: { worldId: string; decisionId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<DecisionTrace>(worldPath(worldId, 'decisions', decisionId), m.locale);
  const d = m.ui.trace;
  const missing = <NotFound title={d.missingTitle} text={d.missingText} back={d.back} href={href(worldId, 'decisions')} />;
  return <Load shape="trace" resource={resource} retry={retry} notFound={missing}>{(trace) => <TraceView trace={trace} />}</Load>;
}
