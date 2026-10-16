import { useState } from 'react';
import { periodPhrase, periodSearch, type Period, type RejectedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, collapseRepeats, commonZone, Gaps, href, Load, LocalPager, ReasonLine, REPORT_PAGE_SIZE, useMessages, When, WhenHead } from '../components.tsx';

/**
 * Экран C: опасные изменения (отклонение от границы больше 10 %) отдельно от скорректированных [Р-73].
 * Шаг 95 [Р-217]: страницы «Stopped changes» нет — список делится вкладками Protections: `only="STOP"` — то, что остановил человек,
 * `only="RULES"` — всё остальное (границы, проверка входов, перепроверка при отправке, остановка витрины). Окно — та же неделя целиком
 * (список не постраничный), поэтому деление на экране ничего не теряет
 */
export function RejectedScreenView({ view, only = null, period = { preset: '7d' } }: { view: RejectedView; only?: 'STOP' | 'RULES' | null; period?: Period }) {
  const m = useMessages();
  const r = m.ui.rejected;
  const p = m.ui.protections;
  const c = r.columns;
  const phrase = periodPhrase(period, m);
  const items = only === 'STOP' ? view.items.filter((i) => i.kind === 'STOP') : only === 'RULES' ? view.items.filter((i) => i.kind !== 'STOP') : view.items;
  // Шаг 96 (Б12): повторы — строкой «×N» (то же предложение, тот же вид, та же причина), страницы по 50
  const groups = collapseRepeats(items, (i) => `${i.unit?.writeScopeId ?? i.productRef ?? ''}|${i.kind}|${i.reason.code}|${i.intervention ?? ''}`);
  const [offset, setOffset] = useState(0);
  const shown = groups.slice(offset, offset + REPORT_PAGE_SIZE);
  const zone = commonZone(shown.map((g) => g.item.at));
  return (
    <section>
      {only === null ? <><h2>{r.pageTitle}</h2><p className="subtitle">{m.ui.app.subtitles.rejected}</p></> : only === 'RULES' ? <h3>{p.otherTitle(phrase)}</h3> : null}
      {/* Шаг 79: итог, сводка и группы — карточкой-сводкой, а не текстом на фоне страницы */}
      {only === 'STOP' ? (
        <section className="card summary-card">
          <p className="headline">{p.peopleHeadline(items.length, phrase)}</p>
          <p className="small"><a href={href(view.worldId, 'stop')}>{p.whoStopped}</a></p>
        </section>
      ) : (
        <section className="card summary-card">
          <p className="headline">{view.headline}</p>
          <p className="muted small">{r.summary(view.summary)}</p>
          {view.groups.length > 0 ? (
            <ul className="groups">
              {view.groups.map((g) => <li key={g.code}><Badge tone="off">{g.count}</Badge> {g.title}</li>)}
            </ul>
          ) : null}
        </section>
      )}
      {items.length === 0 ? <p className="muted empty">{only === 'STOP' ? p.peopleNone : only === 'RULES' ? p.rulesNone(phrase) : r.none}</p> : (
        <div className="table-wrap">
          <table className="dense sticky-end cardify">
            <thead>
              <tr><th><WhenHead label={c.when} zone={zone} /></th><th>{c.where}</th><th>{c.kind}</th><th className="num">{c.proposed}</th><th className="num">{c.before}</th><th>{c.limit}</th><th className="num">{c.deviation}</th><th>{c.reason}</th><th /></tr>
            </thead>
            <tbody>
              {shown.map(({ item, count }, i) => (
                <tr key={i} className={item.intervention === 'DANGEROUS' ? 'dangerous' : ''}>
                  <td className="nowrap" data-label={`${c.when}${zone ? ` · ${zone}` : ''}`}><When value={item.at} zone={!zone} /></td>
                  <td className="offer card-title">{item.unit?.label ?? item.productRef ?? m.ui.common.noValue}</td>
                  <td className="pills card-status">
                    <Badge tone={item.tone}>{r.kinds[item.kind]}</Badge>
                    {/* шаг 77: «скорректировано» — спокойным серым, опасное — красным; обе пилюли в строку */}
                    {item.intervention ? <Badge tone={item.intervention === 'DANGEROUS' ? 'stop' : 'off'}>{r.interventions[item.intervention]}</Badge> : null}
                  </td>
                  {/* Шаг 79 (ревью): изменение — подписью под предложенной ценой, а не своей колонкой: таблица помещается в окно */}
                  <td className="num money cur" data-label={c.proposed}>{item.proposed ?? '–'}{item.change ? <div className="note">{item.change}</div> : null}</td>
                  <td className="num cur" data-label={c.before}>{item.current ?? '–'}</td>
                  <td className="bound" data-label={c.limit}>{item.limit ?? '–'}</td>
                  <td className="num" data-label={c.deviation}>{item.deviation ?? '–'}</td>
                  <td data-label={c.reason}><ReasonLine reason={item.reason} />{count > 1 ? <span className="repeat-count">{m.ui.dangerous.repeated(count, phrase)}</span> : null}</td>
                  <td className="nowrap card-action">{item.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', item.decisionId)}>{r.path}</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <LocalPager total={groups.length} offset={offset} onOffset={setOffset} />
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function RejectedScreen({ worldId, only, period }: { worldId: string; only: 'STOP' | 'RULES'; period: Period }) {
  const m = useMessages();
  const [resource, retry] = useResource<RejectedView>(`${worldPath(worldId, 'rejected')}?${periodSearch(period)}`, m.locale);
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <RejectedScreenView view={view} only={only} period={period} />}</Load>;
}
