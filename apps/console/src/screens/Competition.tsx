import { useState } from 'react';
import { BUYBOX_SHARE_KEEP_DAYS, periodSearch, type CompetitionView, type CompetitorColumns, type Period } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, href, Load, NotFound, SellerName, useMessages } from '../components.tsx';
import { PeriodPicker } from '../date-range.tsx';

/**
 * Шаг 97 [Р-219…Р-221]: таблица конкурентов — одна у страницы Competition и у квитанции «Why this price». Наша строка выделена; у квитанции
 * двигавшиеся помечены «было → стало». Колонки из одного значения — подписью под таблицей (правило таблиц шага 96.2)
 */
export interface CompetitorTableRow {
  seller: string; self: boolean; landed: string; landedKnown: boolean;
  /** Шаг 107 [Р-232]: страница продавца на площадке — только из идентификатора канала */
  sellerUrl?: string | null;
  shipping?: string | null; fulfilment: string | null; rating: string | null; buyBox: boolean | null;
  move?: 'UP' | 'DOWN' | 'APPEARED' | 'GONE' | null; was?: string | null;
  /** Шаг 101 [Р-226]: строка вне расчёта — приглушена, с пометкой словами */
  excluded?: string | null;
  /** Шаг 109 [Р-234]: цена с купоном того же вида, что цена строки — «$17.15 ($16.29 with coupon)» */
  coupon?: string | null;
}

export function CompetitorTable({ rows, columns, shipping = false, foot }: {
  rows: readonly CompetitorTableRow[]; columns: CompetitorColumns; shipping?: boolean; foot?: readonly string[];
}) {
  const m = useMessages();
  const c = m.ui.competition;
  const t = m.ui.trace.competitors;
  const notes = [...columns.uniform, ...(columns.landedKnown ? [] : [c.noShipping]), ...(foot ?? [])];
  return (
    <div className="table-wrap">
      <table className="competitors">
        <thead>
          <tr>
            <th>{c.columns.seller}</th>
            <th className="num">{columns.landedKnown ? c.columns.landed : c.columns.price}</th>
            {shipping ? <th className="num">{c.columns.shipping}</th> : null}
            {columns.fulfilment ? <th>{c.columns.fulfilment}</th> : null}
            {columns.rating ? <th>{c.columns.rating}</th> : null}
            {columns.buyBox ? <th>{c.columns.buyBox}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={`${r.seller}-${i}`} className={`${r.self ? 'self-row' : ''}${r.move === 'GONE' ? ' gone-row' : ''}${r.excluded ? ' excluded-row' : ''}`}>
              <td className="seller">{r.self ? <strong>{r.seller}</strong> : <SellerName name={r.seller} url={r.sellerUrl} />}{r.excluded ? <span className="excluded-note">{r.excluded}</span> : null}</td>
              <td className="num cur landed">
                {r.move === 'UP' || r.move === 'DOWN'
                  ? <><span className="was">{r.was}</span> → <strong>{r.landed}</strong> <span className={`move move-${r.move.toLowerCase()}`} aria-label={t.moved[r.move]}>{r.move === 'DOWN' ? '↓' : '↑'}</span></>
                  : r.move === 'GONE' ? <><s>{r.landed}</s> <span className="move move-gone">{t.moved.GONE}</span></>
                    : r.move === 'APPEARED' ? <>{r.landed} <span className="move move-new">{t.moved.APPEARED}</span></>
                      : r.landed}
                {r.coupon && r.move !== 'GONE' ? <span className="coupon"> {c.withCoupon(r.coupon)}</span> : null}
              </td>
              {shipping ? <td className="num cur">{r.shipping ?? '–'}</td> : null}
              {columns.fulfilment ? <td>{r.fulfilment ?? '–'}</td> : null}
              {columns.rating ? <td>{r.rating ?? '–'}</td> : null}
              {columns.buyBox ? <td>{r.buyBox ? <Badge tone="ok">{c.buyBoxBadge}</Badge> : '–'}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
      {notes.length > 0 ? <p className="table-foot">{notes.join(' ')}</p> : null}
    </div>
  );
}

const HOLDER_TONE: Readonly<Record<string, string>> = { SELF: 'ok', OTHER: 'warn', NONE: 'off', UNKNOWN: 'unknown' };

export function CompetitionScreenView({ view, period, onPeriod }: { view: CompetitionView; period: Period; onPeriod: (p: Period) => void }) {
  const m = useMessages();
  const c = m.ui.competition;
  return (
    <section className="competition">
      <p className="back"><a href={href(view.worldId, 'products')}>{c.back}</a></p>
      <h2>{c.pageTitle}</h2>
      <p className="subtitle">{view.unit.label} · {c.subtitle}</p>
      {view.state === 'NO_COMPETITOR_DATA' ? <section className="card"><p className="notice">{view.stateText}</p></section> : <>
        {/* Нынешняя картина: держатель, наше место и разрыв до победителя */}
        <section className="card competition-now">
          <h3>{c.nowTitle}</h3>
          {view.state === 'NO_SNAPSHOT' ? <p className="muted empty">{view.stateText}</p> : <>
            <p className="holder"><Badge tone={HOLDER_TONE[view.holder?.kind ?? 'UNKNOWN'] ?? 'unknown'}>{view.holder?.text}</Badge></p>
            <ul className="plain facts">
              {view.holder?.why ? <li className="muted">{view.holder.why}</li> : null}
              {view.buyBoxPrice ? <li>{view.buyBoxPrice}</li> : null}
              {view.position ? <li>{view.position}</li> : null}
              {view.gap ? <li>{view.gap}</li> : null}
              {view.observed ? <li className="muted small">{c.observed} <span className="when" title={view.observed.at}>{view.observed.when}</span> · {view.observed.source}</li> : null}
            </ul>
            <CompetitorTable rows={view.rows} columns={view.columns} shipping={view.columns.shipping} />
          </>}
        </section>
        {/*
          Шаг 109 [Р-234, Р-235]: последняя сводка конкурентов канала (сверка) со своим моментом — Buy Box по группам покупателей с долей
          просмотров, держатель большинства (он и считается в доле) и купоны конкурентов. Цены она не двигает
        */}
        {view.summary ? (
          <section className="card competition-summary">
            <h3>{view.summary.title}</h3>
            <p className="muted small">{c.summary.observed} <span className="when" title={view.summary.observed.at}>{view.summary.observed.when}</span></p>
            {view.summary.segments.length > 0 ? <>
              <h4>{c.summary.segmentsTitle}</h4>
              <ul className="plain facts segments">
                {view.summary.segments.map((s, i) => (
                  <li key={`${s.seller}-${s.group}-${i}`}>
                    <strong className="num">{s.share}</strong>{m.colon}{s.self ? <strong>{s.seller}</strong> : <SellerName name={s.seller} url={s.sellerUrl} />} <span className="muted">· {s.group}</span>
                  </li>
                ))}
              </ul>
              {view.summary.holder ? <p className="summary-holder">{view.summary.holder}</p> : null}
            </> : null}
            {view.summary.coupons.length > 0 || view.summary.hidden ? <>
              <h4>{c.summary.couponsTitle}</h4>
              {view.summary.coupons.length > 0 ? <ul className="plain facts coupons">
                {view.summary.coupons.map((x, i) => (
                  <li key={`${x.seller}-${i}`}>
                    {x.self ? <strong>{x.seller}</strong> : <SellerName name={x.seller} url={x.sellerUrl} />}{m.colon}<span className="cur">{x.price}</span> <span className="coupon">{c.withCoupon(x.coupon)}</span>
                  </li>
                ))}
              </ul> : null}
              {/* Шаг 109.1 [Р-71]: суммы не в валюте витрины не печатаются — строка говорит, сколько их и в какой валюте */}
              {view.summary.hidden ? <p className="summary-hidden">{view.summary.hidden}</p> : null}
              {view.summary.couponNote ? <p className="note">{view.summary.couponNote}</p> : null}
            </> : null}
            <p className="note">{view.summary.note}</p>
          </section>
        ) : null}
        {/* Доля Buy Box за период — по снимкам, а не по продажам [Р-220]; глубже 45 суток отрезков нет — календарь это говорит */}
        <section className="card competition-share">
          <h3>{c.share.title}</h3>
          <div className="toolbar field-toolbar period-bar">
            <PeriodPicker value={period} onChange={onPeriod} maxDays={BUYBOX_SHARE_KEEP_DAYS} />
            {view.share.clipped ? <span className="filters-count">{c.share.limit}</span> : null}
          </div>
          {view.share.value !== null ? <p className="big">{view.share.value}</p> : null}
          <p>{view.share.note}</p>
          {view.share.coverage ? <p className="small muted">{view.share.coverage}</p> : null}
          <p className="note">{view.share.caption}</p>
        </section>
        {/* Почему не в Buy Box — только по данным, которые канал назвал; сноска — всегда */}
        {view.diagnosis ? (
          <section className="card competition-why">
            <h3>{c.why.title}</h3>
            {view.diagnosis.reasons.length > 0 ? <ul className="reasons-list">{view.diagnosis.reasons.map((r) => <li key={r}>{r}</li>)}</ul> : null}
            <p className="note">{view.diagnosis.footnote}</p>
          </section>
        ) : null}
      </>}
    </section>
  );
}

export function CompetitionScreen({ worldId, writeScopeId }: { worldId: string; writeScopeId: string }) {
  const m = useMessages();
  const c = m.ui.competition;
  const [period, setPeriod] = useState<Period>({ preset: '7d' });
  const [resource, retry] = useResource<CompetitionView>(`${worldPath(worldId, 'competition', writeScopeId)}?${periodSearch(period)}`, m.locale);
  const missing = <NotFound title={c.missingTitle} text={c.missingText} back={c.back} href={href(worldId, 'products')} />;
  return <Load shape="cards" resource={resource} retry={retry} notFound={missing}>{(view) => <CompetitionScreenView view={view} period={period} onPeriod={setPeriod} />}</Load>;
}
