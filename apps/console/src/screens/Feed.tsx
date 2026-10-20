import { useState } from 'react';
import { FEED_MAX_DAYS, FEED_STATUS_GROUPS, LIST_PAGE_DEFAULT, periodSearch, type DecisionListView, type FeedQuery, type ListQuery, type Period, type PriceFeedView } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { DecisionsView } from './Decisions.tsx';
import { Badge, commonZone, Gaps, href, Load, OfferPicker, Pager, ReasonLine, useMessages, When, WhenHead } from '../components.tsx';
import { Field } from '../forms.tsx';
import { PeriodPicker } from '../date-range.tsx';
import { ExportControl, exportQuery } from '../export.tsx';

/**
 * Шаг 95 [Р-217]: Price changes — единственный журнал цен. «Kind» выбирает, что в нём: записи в канал (как было) или все решения —
 * с записью и без (прежний список «Why this price»).
 *
 * Шаг 96: у обоих видов — период (пресет или свой диапазон дат в поясе пространства) и поиск, который фильтрует саму таблицу по мере
 * ввода (аудит Б11); у решений — ещё исход (вариант шага 95 принят). Статус — только у записей: у решения статуса записи нет, и экран
 * говорит это строкой. Ряд фильтров стоит ВНЕ перезагружаемой части: поле поиска не теряет ввод и фокус, пока таблица обновляется
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

/** Параметры адреса ленты — та же форма, что разбирает сервер (`parseFeedQuery`) */
export function feedPath(worldId: string, q: FeedQuery): string {
  const params = new URLSearchParams();
  if (q.writeScopeId) params.set('writeScopeId', q.writeScopeId);
  if (q.status) params.set('status', q.status);
  if (q.q) params.set('q', q.q);
  if (q.days) params.set('days', String(q.days));
  if (q.offset) params.set('offset', String(q.offset));
  if (q.limit) params.set('limit', String(q.limit));
  const query = [params.toString(), q.period ? periodSearch(q.period) : ''].filter(Boolean).join('&');
  return `${worldPath(worldId, 'feed')}${query ? `?${query}` : ''}`;
}

/** Таблица ленты, выгрузка и страницы. Шаг 96 (Б17): строка ведёт на квитанцию решения целиком, а не только ссылкой в конце */
export function FeedScreenView({ view, onQuery, query = {} }: { view: PriceFeedView; onQuery?: (q: FeedQuery) => void; query?: FeedQuery }) {
  const m = useMessages();
  const f = m.ui.feed;
  const c = f.columns;
  const q = view.query;
  const current: FeedQuery = { ...query, ...(q.writeScopeId ? { writeScopeId: q.writeScopeId } : {}), ...(q.status ? { status: q.status } : {}), limit: q.limit };
  const zone = commonZone(view.items.map((i) => i.at));
  /**
   * Шаг 84: одинаковая причина у многих строк (у тени — «Not sent: this channel account is in shadow mode…») — один раз строкой при полосе
   * итогов; в строке остаётся основание решения («Buy Box»). Причина, своя у строки, остаётся в строке; полный текст — в «Decision path»
   */
  const reasonCount = new Map<string, number>();
  for (const i of view.items) if (i.reason) reasonCount.set(i.reason.text, (reasonCount.get(i.reason.text) ?? 0) + 1);
  const shared = [...reasonCount].filter(([, n]) => n > 1).map(([text]) => text);
  // Шаг 96 (А5): в тени нули сводки объясняет фраза над ней — цены посчитаны, в магазины не ушло ничего
  const counts = view.counts;
  const trialWeek = counts.shadowHeld > 0 && counts.applied + counts.inFlight + counts.notSent + counts.superseded === 0;
  const open = (decisionId: string | null) => { if (decisionId) window.location.hash = href(view.worldId, 'decisions', decisionId); };
  return (
    <section className="journal-table">
      {onQuery ? null : <><h2>{f.pageTitle}</h2><p className="subtitle">{m.ui.app.subtitles.feed}</p></>}
      {view.clipped ? <p className="notice">{m.ui.period.clipped(90)}</p> : null}
      {view.search && view.search.total > view.search.shown ? <p className="notice">{f.searchLimited(view.search.shown, view.search.total)}</p> : null}
      {trialWeek ? <p className="notice trial-week">{f.trialWeek}</p> : null}
      {view.items.length === 0 ? <p className="muted empty">{f.empty}</p> : (
        <div className="table-wrap">
          {/* Шаг 104 [Р-229]: выгрузка — кнопкой «Export» в ряду фильтров (прежняя «All N entries as a file» заменена) */}
          <div className="table-head"><span>{f.counts(view.counts)}</span>
            {shared.map((text) => <span key={text} className="head-note">{text}</span>)}</div>
          <table className="feed dense sticky-end cardify clickable-rows">
            <thead><tr><th><WhenHead label={c.when} zone={zone} /></th><th>{c.offer}</th><th className="num">{c.from}</th><th className="num">{c.to}</th><th className="num">{c.change}</th><th>{c.status}</th><th>{c.reason}</th><th /></tr></thead>
            <tbody>
              {view.items.map((i, n) => (
                <tr key={n} className={i.decisionId ? 'row-clickable' : undefined} onClick={(e) => { if (!(e.target as HTMLElement).closest('a, button')) open(i.decisionId); }}>
                  <td className="nowrap" data-label={`${c.when}${zone ? ` · ${zone}` : ''}`}><When value={i.at} zone={!zone} /></td>
                  <td className="offer card-title">{i.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num cur" data-label={c.from}>{i.from ?? '–'}</td>
                  <td className="num money cur" data-label={c.to}>{i.to}</td>
                  <td className="num" data-label={c.change}>{i.change ?? '–'}</td>
                  <td className="card-status"><Badge tone={i.tone}>{i.status}</Badge>{i.confirmation ? <div className="note">{i.confirmation}</div> : null}</td>
                  {/* Шаг 79 (ревью): источник — подписью над причиной, а не своей колонкой: таблица помещается в окно */}
                  <td data-label={c.reason}>{i.reason && shared.includes(i.reason.text) ? <span className="basis">{i.source}</span>
                    : <><div className="note">{i.source}</div>{i.reason ? <ReasonLine reason={i.reason} /> : null}</>}
                    {/* Шаг 97 [D]: кто подвинул цену — коротким чипом; полная фраза — подсказкой и на квитанции */}
                    {i.trigger ? <span className="trigger-chip" title={i.trigger.full}>{i.trigger.chip}</span> : null}</td>
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
  const m = useMessages();
  const f = m.ui.feed;
  // Шаг 96: период и поиск — общие для обоих видов журнала: переключение вида их не сбрасывает
  const [period, setPeriod] = useState<Period>({ preset: '7d' });
  const [search, setSearch] = useState('');
  const onKind = (next: FeedKind) => { window.location.hash = next === 'decisions' ? href(worldId, 'feed', 'decisions') : href(worldId, 'feed'); };
  return (
    <section>
      <h2>{f.pageTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.feed}</p>
      {kind === 'decisions'
        ? <DecisionJournal worldId={worldId} onKind={onKind} period={period} onPeriod={setPeriod} search={search} onSearch={setSearch} />
        : <WriteJournal worldId={worldId} onKind={onKind} period={period} onPeriod={setPeriod} search={search} onSearch={setSearch} />}
    </section>
  );
}

interface JournalProps {
  worldId: string;
  onKind: (kind: FeedKind) => void;
  period: Period;
  onPeriod: (period: Period) => void;
  search: string;
  onSearch: (text: string) => void;
}

function WriteJournal({ worldId, onKind, period, onPeriod, search, onSearch }: JournalProps) {
  const m = useMessages();
  const f = m.ui.feed;
  const [query, setQuery] = useState<FeedQuery>({});
  const [pickerCount, setPickerCount] = useState<string | null>(null);
  const full: FeedQuery = { ...query, period, ...(search ? { q: search } : {}) };
  const [resource, retry] = useResource<PriceFeedView>(feedPath(worldId, full), m.locale);
  const change = (patch: Partial<FeedQuery>) => {
    const next: FeedQuery = { ...query, ...patch, offset: 0 };
    for (const key of Object.keys(patch) as Array<keyof FeedQuery>) if (patch[key] === undefined) delete next[key];
    setQuery(next);
  };
  return (
    <>
      <div className="filters toolbar field-toolbar">
        <KindField kind="writes" onKind={onKind} />
        <PeriodPicker value={period} maxDays={FEED_MAX_DAYS} onChange={(p) => { onPeriod(p); change({}); }} />
        {/* Р-136: предложение выбирается поиском; шаг 96 (Б11) — поиск по мере ввода фильтрует и саму таблицу */}
        <Field label={f.filters.offer}><OfferPicker worldId={worldId} value={query.writeScopeId ?? ''} allowEmpty emptyLabel={f.filters.all} search={search}
          onSearch={(text) => { onSearch(text); change({}); }} onChange={(writeScopeId) => change({ writeScopeId: writeScopeId || undefined })} onCounter={setPickerCount} /></Field>
        <Field label={f.filters.status}><select value={query.status ?? ''} onChange={(e) => change({ status: (e.target.value || undefined) as FeedQuery['status'] })}>
          <option value="">{f.filters.all}</option>
          {FEED_STATUS_GROUPS.map((g) => <option key={g} value={g}>{f.statusGroups[g]}</option>)}
        </select></Field>
        {pickerCount ? <span className="filters-count">{pickerCount}</span> : null}
        {/* Шаг 104 [Р-229]: что видишь — то и выгружаешь: те же период, предложение, статус и поиск */}
        <ExportControl worldId={worldId} screen="price-changes" query={exportQuery(period, { writeScopeId: query.writeScopeId, status: query.status, q: search })} />
      </div>
      <Load shape="table" resource={resource} retry={retry}>{(view) => <FeedScreenView view={view} onQuery={setQuery} query={full} />}</Load>
    </>
  );
}

type DecisionQuery = ListQuery & { writeScopeId?: string; outcome?: 'CHANGED' | 'NO_CHANGE' | 'REJECTED' };

/** Все решения журнала — страницами базы [Р-154]; строка ведёт на квитанцию решения «Why this price» */
function DecisionJournal({ worldId, onKind, period, onPeriod, search, onSearch }: JournalProps) {
  const m = useMessages();
  const f = m.ui.feed;
  const [query, setQuery] = useState<DecisionQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [pickerCount, setPickerCount] = useState<string | null>(null);
  const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit) });
  if (query.writeScopeId) params.set('writeScopeId', query.writeScopeId);
  if (query.outcome) params.set('outcome', query.outcome);
  if (search) params.set('q', search);
  const [resource, retry] = useResource<DecisionListView>(`${worldPath(worldId, 'decisions')}?${params.toString()}&${periodSearch(period)}`, m.locale);
  const reset = (patch: Partial<DecisionQuery>) => setQuery({ ...query, ...patch, offset: 0 });
  return (
    <>
      <div className="filters toolbar field-toolbar">
        <KindField kind="decisions" onKind={onKind} />
        <PeriodPicker value={period} onChange={(p) => { onPeriod(p); reset({}); }} />
        <Field label={f.filters.offer}><OfferPicker worldId={worldId} value={query.writeScopeId ?? ''} allowEmpty emptyLabel={f.filters.all} search={search}
          onSearch={(text) => { onSearch(text); reset({}); }}
          onChange={(writeScopeId) => setQuery({ offset: 0, limit: query.limit, ...(query.outcome ? { outcome: query.outcome } : {}), ...(writeScopeId ? { writeScopeId } : {}) })} onCounter={setPickerCount} /></Field>
        <Field label={f.outcome.label}><select value={query.outcome ?? ''} onChange={(e) => {
          const outcome = (e.target.value || undefined) as DecisionQuery['outcome'];
          setQuery({ offset: 0, limit: query.limit, ...(query.writeScopeId ? { writeScopeId: query.writeScopeId } : {}), ...(outcome ? { outcome } : {}) });
        }}>
          <option value="">{f.outcome.all}</option>
          {(['CHANGED', 'NO_CHANGE', 'REJECTED'] as const).map((o) => <option key={o} value={o}>{f.outcome[o]}</option>)}
        </select></Field>
        {pickerCount ? <span className="filters-count">{pickerCount}</span> : null}
        <ExportControl worldId={worldId} screen="decisions" query={exportQuery(period, { writeScopeId: query.writeScopeId, outcome: query.outcome, q: search })} />
      </div>
      <p className="section-sub">{f.kind.decisionsCaption}</p>
      <Load shape="table" resource={resource} retry={retry}>
        {(view) => (
          <>
            {view.clipped ? <p className="notice">{m.ui.period.clipped(30)}</p> : null}
            {view.search && view.search.total > view.search.shown ? <p className="notice">{f.searchLimited(view.search.shown, view.search.total)}</p> : null}
            <DecisionsView worldId={worldId} items={view.items} />
            <Pager page={view.page} query={query} onQuery={(q) => setQuery({ ...query, ...q })} />
          </>
        )}
      </Load>
    </>
  );
}
