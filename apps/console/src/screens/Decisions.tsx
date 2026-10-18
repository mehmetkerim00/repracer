import type { DecisionListItem, DecisionTrace, StepStatus } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, commonZone, Gaps, href, Load, NotFound, ReasonLine, useMessages, When, WhenHead } from '../components.tsx';
import { Icon } from '../icons.tsx';
import { CompetitorTable } from './Competition.tsx';

const STATUS_TONE: Readonly<Record<StepStatus, string>> = { OK: 'ok', STOP: 'stop', WARN: 'warn', SKIPPED: 'off', UNKNOWN: 'unknown' };
/** Шаг 81: знак исхода в карточке итога — по тону решения */
const VERDICT_ICON: Readonly<Record<string, string>> = { ok: 'check', warn: 'shieldCheck', stop: 'x', off: 'equal', unknown: 'help', progress: 'activity' };

export function DecisionsView({ worldId, items }: { worldId: string; items: readonly DecisionListItem[] }) {
  const m = useMessages();
  const t = m.ui.trace;
  const zone = commonZone(items.map((d) => d.decidedAt));
  return (
    <section>
      {/* Шаг 95 [Р-217]: список решений — вид журнала Price changes (Kind: All decisions); заголовок страницы — у журнала */}
      {items.length === 0 ? <p className="muted empty">{t.noDecisions}</p> : (
        <div className="table-wrap">
          <table className="cardify clickable-rows">
            <thead><tr><th><WhenHead label={t.columns.when} zone={zone} /></th><th>{t.columns.unit}</th><th>{t.columns.outcome}</th><th className="num">{t.columns.price}</th><th>{t.columns.reason}</th><th /></tr></thead>
            <tbody>
              {items.map((d) => (
                // Шаг 96 (Б17): строка журнала ведёт на квитанцию решения целиком
                <tr key={d.decisionId} className="row-clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) window.location.hash = href(worldId, 'decisions', d.decisionId); }}>
                  <td data-label={`${t.columns.when}${zone ? ` · ${zone}` : ''}`}><When value={d.decidedAt} zone={!zone} /></td>
                  <td className="card-title">{d.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="card-status"><Badge tone={d.tone}>{d.outcome}</Badge>{d.dangerous ? <> <Badge tone="stop">{t.dangerousBadge}</Badge></> : null}</td>
                  <td className="money cur" data-label={t.columns.price}>{d.price}</td>
                  {/* Шаг 100 (E): решение, вызванное движением конкурента, называет его тем же чипом, что строка записи; полная фраза — подсказкой */}
                  <td data-label={t.columns.reason}>{d.reason}{d.trigger ? <div><span className="trigger-chip" title={d.trigger.full}>{d.trigger.chip}</span></div> : null}</td>
                  <td className="num card-action"><a className="row-link" href={href(worldId, 'decisions', d.decisionId)}>{t.why}</a></td>
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
  const competitors = trace.steps.find((s) => s.competitors)?.competitors ?? null;
  return (
    <article className="trace">
      <p className="back"><a href={href(trace.worldId, 'feed', 'decisions')}>{t.back}</a></p>
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
          {/* Шаг 97 [C]: кто подвинул цену — одной фразой сверху; таблица — в шаге снимка конкурентов */}
          {competitors?.trigger ? <p className="trigger-line">{competitors.trigger}</p> : null}
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
                    {item.value ? <span>{m.colon}{item.value}</span> : null}
                    {item.reason ? <ReasonLine reason={item.reason} /> : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {/* Шаг 97 [C]: шаг снимка раскрывается таблицей конкурентов того момента; срок хранения деталей — подписью */}
            {step.competitors ? (step.competitors.rows.length > 0 ? (
              <details className="competitors-at" open>
                <summary>{t.competitors.title} ({step.competitors.rows.length})</summary>
                {/* Шаг 101 [Р-226]: с кем стратегия соревновалась — по всему снимку; исключённые строки остаются в таблице приглушёнными */}
                {step.competitors.filter ? (
                  <p className="competitors-filter">{step.competitors.filter.head}{step.competitors.filter.unknown ? <span className="muted"> · {step.competitors.filter.unknown}</span> : null}</p>
                ) : null}
                <CompetitorTable rows={step.competitors.rows} columns={step.competitors.columns} foot={[step.competitors.note]} />
              </details>
            ) : <p className="note">{step.competitors.note}</p>) : null}
          </li>
        ))}
      </ol>
      </section>
      <Gaps gaps={trace.gaps} />
    </article>
  );
}

export function TraceScreen({ worldId, decisionId }: { worldId: string; decisionId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<DecisionTrace>(worldPath(worldId, 'decisions', decisionId), m.locale);
  const d = m.ui.trace;
  const missing = <NotFound title={d.missingTitle} text={d.missingText} back={d.back} href={href(worldId, 'feed', 'decisions')} />;
  return <Load shape="trace" resource={resource} retry={retry} notFound={missing}>{(trace) => <TraceView trace={trace} />}</Load>;
}
