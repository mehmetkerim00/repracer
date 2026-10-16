import { useState } from 'react';
import { periodSearch, type DangerousReportView, type Period } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, collapseRepeats, commonZone, Gaps, href, Load, LocalPager, REPORT_PAGE_SIZE, useMessages, When, WhenHead } from '../components.tsx';
import { reasonPlan, ShortReason } from './Rejected.tsx';

/** Отчёт о работе границ за период: удержания полом [Р-117] и отклонения Gate больше 10 % [Р-73] */
/** Шаг 95 [Р-217]: отчёт — вкладка «Prevented by rules» страницы Protections (`embedded`); витрина «пол удержал» — сверху вкладки */
export function DangerousScreenView({ view, embedded = false, period = { preset: '7d' } }: { view: DangerousReportView; embedded?: boolean; period?: Period }) {
  const m = useMessages();
  const d = m.ui.dangerous;
  const c = d.columns;
  // Шаг 96 (Б12): повторы одного удержания — строкой «×N», страницы по 50
  const holds = collapseRepeats(view.floorHolds.items, (i) => `${i.unit?.writeScopeId ?? ''}|${i.kind}|${i.reason.code}|${i.floor}`);
  const [holdOffset, setHoldOffset] = useState(0);
  const shownHolds = holds.slice(holdOffset, holdOffset + REPORT_PAGE_SIZE);
  const holdZone = commonZone(shownHolds.map((g) => g.item.at));
  /**
   * Шаг 96.2 (D): «как удержано» — свойство секции, одной фразой в подписи; строка отмечает «kept unchanged» только когда в периоде есть
   * оба вида удержания (прежде каждая строка говорила «set to the floor»)
   */
  const kinds = new Set(view.floorHolds.items.map((i) => i.kind));
  const mixed = kinds.size > 1;
  const caption = mixed ? d.floorCaption.MIXED : kinds.has('HELD') ? d.floorCaption.HELD : d.floorCaption.CAPPED;
  // решение по G2: одна причина у всей страницы — фразой в подписи, а не колонкой
  const holdReasons = reasonPlan(shownHolds.map((g) => ({ title: g.item.reason.title, count: g.count })), period, m);
  const gateReasons = reasonPlan(view.items.map((i) => ({ title: i.reason.title, count: 1 })), period, m);
  const gateZone = commonZone(view.items.map((i) => i.at));
  return (
    <section>
      {/* Шаг 86: заголовок страницы — тот же текст, что пункт меню; «что предотвратили границы» говорит подзаголовок */}
      {embedded ? null : <><h2>{m.ui.app.screens.dangerous}</h2><p className="subtitle">{m.ui.app.subtitles.dangerous}</p></>}
      {/* Шаг 79: итог периода — карточкой-сводкой */}
      <section className="card summary-card">
        <p className="headline">{view.headline}</p>
        <p className="muted small">{view.from} – {view.to}</p>
      </section>
      {view.clipped ? <p className="notice">{m.ui.period.clipped(30)}</p> : null}
      {view.truncated ? <p className="notice">{d.truncated}</p> : null}
      <h3>{d.floorTitle}</h3>
      {view.floorHolds.count === 0 ? <p className="muted empty">{d.none}</p> : (
        <>
        <p className="section-sub floor-caption">{caption}{holdReasons.caption ? <span className="uniform-reason"> {holdReasons.caption}</span> : null}</p>
        <div className="table-wrap">
          <table className="dense sticky-end cardify floor-holds">
            <thead><tr><th><WhenHead label={d.floorColumns.when} zone={holdZone} /></th><th>{d.floorColumns.offer}</th><th className="num">{d.floorColumns.target}</th><th className="num">{d.floorColumns.floor}</th><th className="num">{d.floorColumns.below}</th>{holdReasons.column ? <th>{d.floorColumns.reason}</th> : null}<th /></tr></thead>
            <tbody>
              {shownHolds.map(({ item: i, count }, n) => (
                <tr key={`${i.decisionId ?? 'hold'}-${n}`}>
                  <td className="nowrap" data-label={`${d.floorColumns.when}${holdZone ? ` · ${holdZone}` : ''}`}><When value={i.at} zone={!holdZone} /></td>
                  <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num cur" data-label={d.floorColumns.target}>{i.target ?? m.ui.common.noValue}</td>
                  <td className="num money cur" data-label={d.floorColumns.floor}>{i.floor}</td>
                  <td className="num cur" data-label={d.floorColumns.below}>{i.below ?? m.ui.common.noValue}</td>
                  {/* Шаг 96.2 (B): категория и чип «×N»; полный текст — подсказкой и на квитанции решения */}
                  {holdReasons.column ? <td className="reason-cell" data-label={d.floorColumns.reason} title={i.reason.text}><ShortReason title={i.reason.title} count={count} period={period} category={holdReasons.category} />
                    {mixed && i.kind === 'HELD' ? <span className="muted small"> · {d.floorKinds.HELD}</span> : null}</td> : null}
                  <td className="nowrap card-action">{i.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      <LocalPager total={holds.length} offset={holdOffset} onOffset={setHoldOffset} />
      <h3>{d.gateTitle}</h3>
      <p className="section-sub">{view.gateHeadline}{view.count > 0 && gateReasons.caption ? <span className="uniform-reason"> {gateReasons.caption}</span> : null}</p>
      {view.count === 0 ? <p className="muted empty">{d.none}</p> : (
        <>
          <div className="cards">
            <div className="card emphasis"><h3>{d.prevented}</h3>{view.prevented.map((p) => <p key={p.currency} className="big">{p.amount}</p>)}</div>
            {view.worst ? <div className="card"><h3>{d.worst}</h3><p className="big">{view.worst.deviation}</p><p className="small muted">{view.worst.unit?.label} · {view.worst.proposed} / {view.worst.bound}</p></div> : null}
            <div className="card"><h3>{d.byBound}</h3><ul className="small">{view.byBound.map((b) => <li key={b.code}><Badge tone="stop">{b.count}</Badge> {b.title}</li>)}</ul></div>
          </div>
          <div className="table-wrap">
            <table className="dense sticky-end cardify">
              <thead><tr><th><WhenHead label={c.when} zone={gateZone} /></th><th>{c.offer}</th><th className="num">{c.proposed}</th><th className="num">{c.bound}</th><th className="num">{c.deviation}</th>{gateReasons.column ? <th>{c.reason}</th> : null}<th /></tr></thead>
              <tbody>
                {view.items.map((i) => (
                  <tr key={i.decisionId} className="dangerous">
                    <td className="nowrap" data-label={`${c.when}${gateZone ? ` · ${gateZone}` : ''}`}><When value={i.at} zone={!gateZone} /></td>
                    <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                    <td className="num cur" data-label={c.proposed}>{i.proposed}</td>
                    <td className="num cur" data-label={c.bound}>{i.bound}</td>
                    <td className="num" data-label={c.deviation}>{i.deviation}</td>
                    {gateReasons.column ? <td className="reason-cell" data-label={c.reason} title={i.reason.text}><ShortReason title={i.reason.title} count={1} period={period} category={gateReasons.category} /></td> : null}
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

export function DangerousScreen({ worldId, period }: { worldId: string; period: Period }) {
  const m = useMessages();
  const [resource, retry] = useResource<DangerousReportView>(`${worldPath(worldId, 'dangerous')}?${periodSearch(period)}`, m.locale);
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <DangerousScreenView view={view} embedded period={period} />}</Load>;
}
