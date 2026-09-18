import { useState } from 'react';
import { FEED_PERIODS_DAYS, FEED_STATUS_GROUPS, type FeedQuery, type PriceFeedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { OfferPicker, Badge, Gaps, href, Load, ReasonLine, useMessages } from '../components.tsx';

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

export function FeedScreenView({ view, onQuery }: { view: PriceFeedView; onQuery?: (q: FeedQuery) => void }) {
  const m = useMessages();
  const f = m.ui.feed;
  const c = f.columns;
  const q = view.query;
  const current: FeedQuery = {
    ...(q.writeScopeId ? { writeScopeId: q.writeScopeId } : {}), ...(q.status ? { status: q.status } : {}),
    ...(q.days ? { days: q.days as FeedQuery['days'] & number } : {}), limit: q.limit,
  };
  const change = (patch: Partial<FeedQuery>) => {
    const next: FeedQuery = { ...current, ...patch, offset: 0 };
    for (const key of Object.keys(patch) as Array<keyof FeedQuery>) if (patch[key] === undefined) delete next[key];
    onQuery?.(next);
  };
  return (
    <section>
      <h2>{f.pageTitle}</h2>
      <p className="muted">{f.counts(view.counts)}</p>
      {onQuery ? (
        <div className="form filters">
          <label>{f.filters.status} <select value={q.status ?? ''} onChange={(e) => change({ status: (e.target.value || undefined) as FeedQuery['status'] })}>
            <option value="">{f.filters.all}</option>
            {FEED_STATUS_GROUPS.map((g) => <option key={g} value={g}>{f.statusGroups[g]}</option>)}
          </select></label>
          {/* Р-136 (ревью шага 29, находка 4): предложение выбирается поиском — список показывает первые несколько сотен из каталога */}
          <label>{f.filters.offer} <OfferPicker worldId={view.worldId} value={q.writeScopeId ?? ''} allowEmpty emptyLabel={f.filters.all}
            onChange={(writeScopeId) => change({ writeScopeId: writeScopeId || undefined })} /></label>
          <label>{f.filters.period} <select value={q.days ?? ''} onChange={(e) => change({ days: (e.target.value ? Number(e.target.value) : undefined) as FeedQuery['days'] })}>
            <option value="">{f.filters.all}</option>
            {FEED_PERIODS_DAYS.map((d) => <option key={d} value={d}>{f.periodDays(d)}</option>)}
          </select></label>
        </div>
      ) : null}
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
      <div className="buttons">
        <span className="small muted">{view.page.text}</span>
        {onQuery ? (
          <>
            <button type="button" disabled={!view.page.hasPrevious} onClick={() => onQuery({ ...current, offset: Math.max(0, q.offset - q.limit) })}>{f.previous}</button>
            <button type="button" disabled={!view.page.hasNext} onClick={() => onQuery({ ...current, offset: q.offset + q.limit })}>{f.next}</button>
          </>
        ) : null}
      </div>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function FeedScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<FeedQuery>({});
  const [resource, retry] = useResource<PriceFeedView>(feedPath(worldId, query), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <FeedScreenView view={view} onQuery={setQuery} />}</Load>;
}
