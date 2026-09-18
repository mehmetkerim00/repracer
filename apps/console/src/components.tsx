import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { messagesFor, type Gap, type HumanReason, type ListQuery, type Messages, type PageInfo, type StatusCell, type UnitRef } from '@repracer/console-model';
import { ApiError, REQUEST_TIMEOUT_MS, requestJson, worldPath, type Resource } from './api.ts';

/** Словарь интерфейса текущего языка [Р-72]: все подписи экранов — отсюда */
export const MessagesContext = createContext<Messages>(messagesFor('de'));
export const useMessages = (): Messages => useContext(MessagesContext);

export const href = (worldId: string, ...parts: string[]) => `#/w/${[worldId, ...parts].map(encodeURIComponent).join('/')}`;

export function errorText(error: unknown, m: Messages): string {
  if (!(error instanceof ApiError)) return m.ui.app.unavailable(error instanceof Error ? error.message : String(error));
  const f = error.failure;
  switch (f.kind) {
    case 'TIMEOUT': return m.ui.app.timeout(f.seconds);
    case 'UNAVAILABLE': return m.ui.app.unavailable(f.detail);
    case 'BAD_RESPONSE': return m.ui.app.badResponse(f.status);
    case 'SERVER': return f.message;
  }
}

export function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function Cell({ cell }: { cell: StatusCell }) {
  return (
    <div className="cell">
      <Badge tone={cell.tone}>{cell.label}</Badge>
      <div className="muted small">{cell.detail}</div>
    </div>
  );
}

export function ReasonLine({ reason }: { reason: HumanReason }) {
  const m = useMessages();
  return (
    <div className="reason">
      <span>{reason.text}</span>
      {reason.limit ? <div className="gap-note small">{m.ui.trace.limitNote(reason.limit)}</div> : null}
      {reason.problems.length > 0 ? <div className="gap-note small">{reason.problems.join('; ')}</div> : null}
    </div>
  );
}

export function Gaps({ gaps }: { gaps: readonly Gap[] }) {
  const m = useMessages();
  if (gaps.length === 0) return null;
  return (
    <section className="gaps">
      <h3>{m.ui.app.gapsTitle}</h3>
      <ul>
        {gaps.map((g) => (
          <li key={g.code}><strong>{g.what}.</strong> {g.why}</li>
        ))}
      </ul>
    </section>
  );
}

/** Ожидание с обратным отсчётом до тайм-аута: после него — ошибка, не вечный спиннер */
export function Loading({ startedAt }: { startedAt: number }) {
  const m = useMessages();
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((startedAt + REQUEST_TIMEOUT_MS - now) / 1000));
  return <p className="loading" role="status">{m.ui.app.loading(left)}</p>;
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const m = useMessages();
  return (
    <div className="error" role="alert">
      <p>{message}</p>
      {onRetry ? <button type="button" onClick={onRetry}>{m.ui.app.retry}</button> : null}
    </div>
  );
}

export function Load<T>({ resource, retry, children }: { resource: Resource<T>; retry: () => void; children: (data: T) => ReactNode }) {
  const m = useMessages();
  if (resource.state === 'loading') return <Loading startedAt={resource.startedAt} />;
  if (resource.state === 'error') return <ErrorBox message={errorText(resource.error, m)} onRetry={retry} />;
  return <>{children(resource.data)}</>;
}

/** Подтверждение действия с заметкой: без заметки второе нажатие недоступно */
export function NoteConfirm(props: {
  title: string;
  text: string;
  list?: { title: string; items: readonly string[] };
  confirmLabel: string;
  note: string;
  noteMin: number;
  busy: boolean;
  error: string | null;
  onNote: (note: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const m = useMessages();
  const ready = props.note.trim().length >= props.noteMin && !props.busy;
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="confirm-title">
      <h3 id="confirm-title">{props.title}</h3>
      <p>{props.text}</p>
      {props.list && props.list.items.length > 0 ? (
        <>
          <p><strong>{props.list.title}</strong></p>
          <ul>{props.list.items.map((n) => <li key={n}>{n}</li>)}</ul>
        </>
      ) : null}
      <label>
        {m.ui.app.dialog.note(props.noteMin)}
        <textarea value={props.note} onChange={(e) => props.onNote(e.target.value)} rows={3} maxLength={2000} />
      </label>
      {props.error ? <ErrorBox message={props.error} /> : null}
      <div className="buttons">
        <button type="button" className="danger" disabled={!ready} onClick={props.onConfirm}>{props.busy ? m.ui.app.dialog.busy(REQUEST_TIMEOUT_MS / 1000) : props.confirmLabel}</button>
        <button type="button" onClick={props.onCancel} disabled={props.busy}>{m.ui.app.dialog.cancel}</button>
      </div>
    </div>
  );
}

/**
 * Р-136 (шаг 29): переключатель страниц списка. Экраны продавца отдают страницу, а не каталог: на 10 000 предложений список
 * товаров весил 10,2 МБ в одном ответе, а экран комплаенса считался 24,8 секунды.
 */
export function Pager({ page, query, onQuery }: { page: PageInfo; query: ListQuery; onQuery: (q: ListQuery) => void }) {
  const m = useMessages();
  const f = m.ui.feed;
  return (
    <div className="buttons">
      <span className="small muted">{page.text}</span>
      <button type="button" disabled={!page.hasPrevious} onClick={() => onQuery({ ...query, offset: Math.max(0, query.offset - query.limit) })}>{f.previous}</button>
      <button type="button" disabled={!page.hasNext} onClick={() => onQuery({ ...query, offset: query.offset + query.limit })}>{f.next}</button>
    </div>
  );
}

/**
 * Р-136 (ревью шага 29, находка 4): выбор предложения с поиском. Выпадающий список показывает первые несколько сотен, и без
 * поиска предложения за их пределами были недостижимы — а доказательство Omnibus [Р-123] и объявление скидки нужны по
 * КОНКРЕТНОМУ предложению.
 */
export function OfferPicker({ worldId, value, onChange, allowEmpty = false, emptyLabel = '' }: {
  worldId: string; value: string; onChange: (writeScopeId: string) => void; allowEmpty?: boolean; emptyLabel?: string;
}) {
  const m = useMessages();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ items: UnitRef[]; total: number; shown: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const cancel = new AbortController();
    const id = setTimeout(() => {
      requestJson<{ items: UnitRef[]; total: number; shown: number }>(`${worldPath(worldId, 'offers')}?q=${encodeURIComponent(query)}`,
        { signal: cancel.signal, locale: m.locale })
        .then((r) => { setFound(r); setError(null); }, (e: unknown) => { if (!cancel.signal.aborted) setError(errorText(e, m)); });
    }, 200);
    return () => { clearTimeout(id); cancel.abort(); };
  }, [worldId, query, m.locale]);
  const o = m.ui.offerPicker;
  return (
    <span className="offer-picker">
      <input type="search" value={query} placeholder={o.search} onChange={(e) => setQuery(e.target.value)} />
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {allowEmpty ? <option value="">{emptyLabel}</option> : null}
        {(found?.items ?? []).map((u) => <option key={u.writeScopeId} value={u.writeScopeId}>{u.label}</option>)}
      </select>
      {error ? <span className="small warn">{error}</span> : found && found.total > found.shown
        ? <span className="small muted">{o.narrow(found.shown, found.total)}</span>
        : found ? <span className="small muted">{o.found(found.total)}</span> : null}
    </span>
  );
}
