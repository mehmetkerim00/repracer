import { useState } from 'react';
import { FEED_PERIODS_DAYS, FEED_STATUS_GROUPS, LIST_PAGE_DEFAULT, type DecisionListView, type FeedQuery, type ListQuery, type PriceFeedView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import type { JobCreatedResponse } from '../api-types.ts';
import { JobProgress } from './Jobs.tsx';
import { DecisionsView } from './Decisions.tsx';
import { Badge, commonZone, ErrorBox, errorText, Gaps, href, Load, OfferPicker, Pager, ReasonLine, useMessages, When, WhenHead } from '../components.tsx';
import { Field } from '../forms.tsx';

/**
 * Шаг 95 [Р-217]: Price changes — единственный журнал цен. «Kind» выбирает, что в нём: записи в канал (как было) или все решения —
 * с записью и без (прежний список «Why this price»). Фильтры двух видов не совмещаются без потери смысла: статус записи и период есть
 * только у записей, у решений — только предложение; поэтому у вида решений из фильтров остаётся предложение, и экран говорит это строкой
 */
export type FeedKind = 'writes' | 'decisions';

function KindField({ kind, onKind }: { kind: FeedKind; onKind: (kind: FeedKind) => void }) {
  const k = useMessages().ui.feed.kind;
  return (
    <Field label={k.label}>
      <select value={kind} onChange={(e) => onKind(e.currentTarget.value as FeedKind)}>
        <option value="writes">{k.writes}</option>
        <option value="decisions">{k.decisions}</option>
      </select>
    </Field>
  );
}

/**
 * Лента изменений цен (шаги 21, 23): запись в канал от решения до итога, новые сверху. Фильтры по статусу, офферу и периоду и
 * страницы считает сервер по всему окну ленты — экран не фильтрует уже отданную страницу.
 */

export function feedPath(worldId: string, q: FeedQuery): string {
  const params = new URLSearchParams();
  if (q.writeScopeId) params.set('writeScopeId', q.writeScopeId);
  if (q.status) params.set('status', q.status);
  if (q.days) params.set('days', String(q.days));
  if (q.offset) params.set('offset', String(q.offset));
  if (q.limit) params.set('limit', String(q.limit));
  const query = params.toString();
  return `${worldPath(worldId, 'feed')}${query ? `?${query}` : ''}`;
}

export function FeedScreenView({ view, onQuery, onKind }: { view: PriceFeedView; onQuery?: (q: FeedQuery) => void; onKind?: (kind: FeedKind) => void }) {
  const m = useMessages();
  const f = m.ui.feed;
  const c = f.columns;
  const q = view.query;
  const current: FeedQuery = {
    ...(q.writeScopeId ? { writeScopeId: q.writeScopeId } : {}), ...(q.status ? { status: q.status } : {}),
    ...(q.days ? { days: q.days as FeedQuery['days'] & number } : {}), limit: q.limit,
  };
  /**
   * Р-142 (шаг 31): всю ленту за период продавец уносит ФАЙЛОМ — экран отдаёт страницу не больше 200 записей, а за 30 суток
   * по каталогу их сотни тысяч. Готовит файл фоновое задание [Р-139] по тому же фильтру, что сейчас на экране.
   */
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const exportFeed = async () => {
    setExportError(null);
    try {
      const created = await requestJson<JobCreatedResponse>(`${worldPath(view.worldId, 'feed', 'export')}`, {
        method: 'POST',
        body: { query: { ...(q.writeScopeId ? { writeScopeId: q.writeScopeId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.days ? { days: String(q.days) } : {}) } },
        locale: m.locale,
      });
      setExportJobId(created.jobId);
    } catch (e) { setExportError(errorText(e, m)); }
  };

  const zone = commonZone(view.items.map((i) => i.at));
  const [pickerCount, setPickerCount] = useState<string | null>(null);
  /**
   * Шаг 84: одинаковая причина у многих строк (у тени — «Not sent: this channel account is in shadow mode…») — один раз строкой при полосе
   * итогов; в строке остаётся основание решения («Buy Box»). Причина, своя у строки, остаётся в строке; полный текст — в «Decision path»
   */
  const reasonCount = new Map<string, number>();
  for (const i of view.items) if (i.reason) reasonCount.set(i.reason.text, (reasonCount.get(i.reason.text) ?? 0) + 1);
  const shared = [...reasonCount].filter(([, n]) => n > 1).map(([text]) => text);
  const change = (patch: Partial<FeedQuery>) => {
    const next: FeedQuery = { ...current, ...patch, offset: 0 };
    for (const key of Object.keys(patch) as Array<keyof FeedQuery>) if (patch[key] === undefined) delete next[key];
    onQuery?.(next);
  };
  return (
    <section>
      <h2>{f.pageTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.feed}</p>
      {/* Шаг 79: фильтры и выгрузка — карточкой-панелью; счётчики групп — в шапке таблицы */}
      {onQuery ? (
        <div className="filters toolbar field-toolbar">
          {onKind ? <KindField kind="writes" onKind={onKind} /> : null}
          {/* Шаг 94: фильтры — поля стандарта: подпись над выбором */}
          <Field label={f.filters.status}><select value={q.status ?? ''} onChange={(e) => change({ status: (e.target.value || undefined) as FeedQuery['status'] })}>
            <option value="">{f.filters.all}</option>
            {FEED_STATUS_GROUPS.map((g) => <option key={g} value={g}>{f.statusGroups[g]}</option>)}
          </select></Field>
          {/* Р-136 (ревью шага 29, находка 4): предложение выбирается поиском — список показывает первые несколько сотен из каталога */}
          <Field label={f.filters.offer}><OfferPicker worldId={view.worldId} value={q.writeScopeId ?? ''} allowEmpty emptyLabel={f.filters.all}
            onChange={(writeScopeId) => change({ writeScopeId: writeScopeId || undefined })} onCounter={setPickerCount} /></Field>
          <Field label={f.filters.period}><select value={q.days ?? ''} onChange={(e) => change({ days: (e.target.value ? Number(e.target.value) : undefined) as FeedQuery['days'] })}>
            <option value="">{f.filters.all}</option>
            {FEED_PERIODS_DAYS.map((d) => <option key={d} value={d}>{f.periodDays(d)}</option>)}
          </select></Field>
          {pickerCount ? <span className="filters-count">{pickerCount}</span> : null}
        </div>
      ) : null}
      {exportError ? <ErrorBox message={exportError} /> : null}
      {exportJobId ? <JobProgress worldId={view.worldId} jobId={exportJobId} /> : null}
      {view.items.length === 0 ? <p className="muted empty">{f.empty}</p> : (
        <div className="table-wrap">
          {/* Шаг 84: выгрузка — действие над таблицей, в её полосе итогов; ряд фильтров остаётся одним рядом */}
          <div className="table-head"><span>{f.counts(view.counts)}</span>
            {onQuery ? <button type="button" disabled={view.page.total === 0} onClick={() => void exportFeed()}>{f.exportAll(view.page.total)}</button> : null}
            {shared.map((text) => <span key={text} className="head-note">{text}</span>)}</div>
          <table className="feed dense sticky-end cardify">
            <thead><tr><th><WhenHead label={c.when} zone={zone} /></th><th>{c.offer}</th><th className="num">{c.from}</th><th className="num">{c.to}</th><th className="num">{c.change}</th><th>{c.status}</th><th>{c.reason}</th><th /></tr></thead>
            <tbody>
              {view.items.map((i, n) => (
                <tr key={n}>
                  <td className="nowrap" data-label={`${c.when}${zone ? ` · ${zone}` : ''}`}><When value={i.at} zone={!zone} /></td>
                  <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num cur" data-label={c.from}>{i.from ?? '–'}</td>
                  <td className="num money cur" data-label={c.to}>{i.to}</td>
                  <td className="num" data-label={c.change}>{i.change ?? '–'}</td>
                  <td className="card-status"><Badge tone={i.tone}>{i.status}</Badge>{i.confirmation ? <div className="note">{i.confirmation}</div> : null}</td>
                  {/* Шаг 79 (ревью): источник — подписью над причиной, а не своей колонкой: таблица помещается в окно */}
                  <td data-label={c.reason}>{i.reason && shared.includes(i.reason.text) ? <span className="basis">{i.source}</span>
                    : <><div className="note">{i.source}</div>{i.reason ? <ReasonLine reason={i.reason} /> : null}</>}</td>
                  <td className="nowrap card-action">{i.decisionId ? <a className="row-link" href={href(view.worldId, 'decisions', i.decisionId)}>{m.ui.rejected.path}</a> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.page.total === 0 ? null : <div className="buttons">
        <span className="small muted">{view.page.text}</span>
        {onQuery ? (
          <>
            <button type="button" disabled={!view.page.hasPrevious} onClick={() => onQuery({ ...current, offset: Math.max(0, q.offset - q.limit) })}>{f.previous}</button>
            <button type="button" disabled={!view.page.hasNext} onClick={() => onQuery({ ...current, offset: q.offset + q.limit })}>{f.next}</button>
          </>
        ) : null}
      </div>}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function FeedScreen({ worldId, kind }: { worldId: string; kind: FeedKind }) {
  const onKind = (next: FeedKind) => { window.location.hash = next === 'decisions' ? href(worldId, 'feed', 'decisions') : href(worldId, 'feed'); };
  return kind === 'decisions' ? <DecisionJournal worldId={worldId} onKind={onKind} /> : <WriteJournal worldId={worldId} onKind={onKind} />;
}

function WriteJournal({ worldId, onKind }: { worldId: string; onKind: (kind: FeedKind) => void }) {
  const m = useMessages();
  const [query, setQuery] = useState<FeedQuery>({});
  const [resource, retry] = useResource<PriceFeedView>(feedPath(worldId, query), m.locale);
  return <Load shape="table" resource={resource} retry={retry}>{(view) => <FeedScreenView view={view} onQuery={setQuery} onKind={onKind} />}</Load>;
}

/** Все решения журнала — страницами базы [Р-154]; строка ведёт на квитанцию решения «Why this price» */
function DecisionJournal({ worldId, onKind }: { worldId: string; onKind: (kind: FeedKind) => void }) {
  const m = useMessages();
  const f = m.ui.feed;
  const [query, setQuery] = useState<ListQuery & { writeScopeId?: string }>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [pickerCount, setPickerCount] = useState<string | null>(null);
  const path = `${worldPath(worldId, 'decisions')}?offset=${query.offset}&limit=${query.limit}${query.writeScopeId ? `&writeScopeId=${encodeURIComponent(query.writeScopeId)}` : ''}`;
  const [resource, retry] = useResource<DecisionListView>(path, m.locale);
  return (
    <section>
      <h2>{f.pageTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.feed}</p>
      <div className="filters toolbar field-toolbar">
        <KindField kind="decisions" onKind={onKind} />
        <Field label={f.filters.offer}><OfferPicker worldId={worldId} value={query.writeScopeId ?? ''} allowEmpty emptyLabel={f.filters.all}
          onChange={(writeScopeId) => setQuery({ offset: 0, limit: query.limit, ...(writeScopeId ? { writeScopeId } : {}) })} onCounter={setPickerCount} /></Field>
        {pickerCount ? <span className="filters-count">{pickerCount}</span> : null}
      </div>
      <p className="section-sub">{f.kind.decisionsCaption}</p>
      <Load shape="table" resource={resource} retry={retry}>
        {(view) => (<><DecisionsView worldId={worldId} items={view.items} /><Pager page={view.page} query={query} onQuery={(q) => setQuery({ ...query, ...q })} /></>)}
      </Load>
    </section>
  );
}
