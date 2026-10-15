import type { DangerousReportView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, commonZone, Gaps, href, Load, ReasonLine, useMessages, When, WhenHead } from '../components.tsx';

const PERIODS = [1, 7, 30] as const;
/** Шаг 84: причины удержания полом, которые говорят только то, что уже видно в колонках «Strategy wanted», «Floor», «Cheaper by» */
const STANDARD_FLOOR_HOLDS = new Set(['CAPPED_AT_MIN_PRICE', 'CAPPED_AT_MARGIN_FLOOR']);

/** Отчёт о работе границ за период: удержания полом [Р-117] и отклонения Gate больше 10 % [Р-73] */
/** Шаг 95 [Р-217]: отчёт — вкладка «Prevented by rules» страницы Protections (`embedded`); витрина «пол удержал» — сверху вкладки */
export function DangerousScreenView({ view, embedded = false }: { view: DangerousReportView; embedded?: boolean }) {
  const m = useMessages();
  const d = m.ui.dangerous;
  const c = d.columns;
  const holdZone = commonZone(view.floorHolds.items.map((i) => i.at));
  const gateZone = commonZone(view.items.map((i) => i.at));
  return (
    <section>
      {/* Шаг 86: заголовок страницы — тот же текст, что пункт меню; «что предотвратили границы» говорит подзаголовок */}
      {embedded ? null : <><h2>{m.ui.app.screens.dangerous}</h2><p className="subtitle">{m.ui.app.subtitles.dangerous}</p></>}
      <nav className="tabs small">
        {PERIODS.map((p) => <a key={p} href={href(view.worldId, 'protections', 'rules', String(p))} className={p === view.days ? 'active' : ''}>{d.period(p)}</a>)}
      </nav>
      {/* Шаг 79: итог периода — карточкой-сводкой */}
      <section className="card summary-card">
        <p className="headline">{view.headline}</p>
        <p className="muted small">{view.from} – {view.to}</p>
      </section>
      {view.truncated ? <p className="notice">{d.truncated}</p> : null}
      <h3>{d.floorTitle}</h3>
      {view.floorHolds.count === 0 ? <p className="muted empty">{d.none}</p> : (
        <div className="table-wrap">
          <table className="dense sticky-end cardify">
            <thead><tr><th><WhenHead label={d.floorColumns.when} zone={holdZone} /></th><th>{d.floorColumns.offer}</th><th>{d.floorColumns.kind}</th><th className="num">{d.floorColumns.target}</th><th className="num">{d.floorColumns.floor}</th><th className="num">{d.floorColumns.below}</th><th>{d.floorColumns.reason}</th><th /></tr></thead>
            <tbody>
              {view.floorHolds.items.map((i, n) => (
                <tr key={`${i.decisionId ?? 'hold'}-${n}`}>
                  <td className="nowrap" data-label={`${d.floorColumns.when}${holdZone ? ` · ${holdZone}` : ''}`}><When value={i.at} zone={!holdZone} /></td>
                  <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                  <td data-label={d.floorColumns.kind}>{d.floorKinds[i.kind]}</td>
                  <td className="num cur" data-label={d.floorColumns.target}>{i.target ?? m.ui.common.noValue}</td>
                  <td className="num money cur" data-label={d.floorColumns.floor}>{i.floor}</td>
                  <td className="num cur" data-label={d.floorColumns.below}>{i.below ?? m.ui.common.noValue}</td>
                  {/* Шаг 84: стандартная причина пересказывала бы колонки цели, пола и разницы — короткой формой; полный текст — подсказкой */}
                  <td data-label={d.floorColumns.reason}>{STANDARD_FLOOR_HOLDS.has(i.reason.code) ? <span className="reason" title={i.reason.text}>{i.reason.title}</span> : <ReasonLine reason={i.reason} />}</td>
                  <td className="nowrap card-action">{i.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3>{d.gateTitle}</h3>
      <p className="section-sub">{view.gateHeadline}</p>
      {view.count === 0 ? <p className="muted empty">{d.none}</p> : (
        <>
          <div className="cards">
            <div className="card emphasis"><h3>{d.prevented}</h3>{view.prevented.map((p) => <p key={p.currency} className="big">{p.amount}</p>)}</div>
            {view.worst ? <div className="card"><h3>{d.worst}</h3><p className="big">{view.worst.deviation}</p><p className="small muted">{view.worst.unit?.label} · {view.worst.proposed} / {view.worst.bound}</p></div> : null}
            <div className="card"><h3>{d.byBound}</h3><ul className="small">{view.byBound.map((b) => <li key={b.code}><Badge tone="stop">{b.count}</Badge> {b.title}</li>)}</ul></div>
          </div>
          <div className="table-wrap">
            <table className="dense sticky-end cardify">
              <thead><tr><th><WhenHead label={c.when} zone={gateZone} /></th><th>{c.offer}</th><th className="num">{c.proposed}</th><th className="num">{c.bound}</th><th className="num">{c.deviation}</th><th>{c.reason}</th><th /></tr></thead>
              <tbody>
                {view.items.map((i) => (
                  <tr key={i.decisionId} className="dangerous">
                    <td className="nowrap" data-label={`${c.when}${gateZone ? ` · ${gateZone}` : ''}`}><When value={i.at} zone={!gateZone} /></td>
                    <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                    <td className="num cur" data-label={c.proposed}>{i.proposed}</td>
                    <td className="num cur" data-label={c.bound}>{i.bound}</td>
                    <td className="num" data-label={c.deviation}>{i.deviation}</td>
                    <td data-label={c.reason}><ReasonLine reason={i.reason} /></td>
                    <td className="nowrap card-action"><a className="row-link" href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a></td>
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
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <DangerousScreenView view={view} embedded />}</Load>;
}
