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

/**
 * Шаг 77: время в таблицах — по-человечески, «Oct 11, 03:57 · UTC−7» вторичным цветом; полное значение (с годом, как его отдаёт сервер,
 * шаг 78) — во всплывающей подсказке. Строка не того вида показывается как есть
 */
export function humanWhen(value: string, _locale: string): string {
  const en = /^([A-Z][a-z]{2}) (\d{1,2}), \d{4}, (\d{2}:\d{2}) (UTC.*)$/.exec(value);
  if (en) return `${en[1]} ${en[2]}, ${en[3]} · ${en[4]}`;
  const de = /^(\d{1,2})\. (\S+) \d{4}, (\d{2}:\d{2}) (UTC.*)$/.exec(value);
  if (de) return `${de[1]}. ${de[2]}, ${de[3]} · ${de[4]}`;
  return value;
}

/**
 * Шаг 78 (п. 13): вступление экрана — подзаголовком в одно предложение, остальное — по «Learn more». Тексты прежние и целиком в
 * разметке (скрытая часть — атрибутом hidden): вступление, важное юридически (Omnibus), не сокращается — сворачивается
 */
export function Intro({ text }: { text: string }) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const split = /^(.+?[.!?])\s+(\S[\s\S]*)$/.exec(text);
  if (!split || text.length <= 160) return <p className="subtitle">{text}</p>;
  return (
    <div className="intro">
      <p className="subtitle">{split[1]}{' '}
        <span hidden={!open}>{split[2]} </span>
        <button type="button" className="link" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? m.ui.common.showLess : m.ui.common.learnMore}</button>
      </p>
    </div>
  );
}

/**
 * Шаг 78 (п. 17): дата и время — на языке экрана, а не браузера. Родное поле `datetime-local` берёт формат и подсказку у браузера
 * («дд.мм.гггг» у русского Chrome на английском экране); здесь текстовое поле с форматом языка: EN «mm/dd/yyyy hh:mm», DE
 * «TT.MM.JJJJ hh:mm». Значение наружу — тот же вид, что у родного поля («2026-10-11T14:30», дата — «2026-10-11»), логика формы прежняя
 */
export function DateTimeField({ value, onChange, withTime = true }: { value: string; onChange: (value: string) => void; withTime?: boolean }) {
  const m = useMessages();
  const de = m.locale === 'de';
  const p2 = (n: number | string) => String(n).padStart(2, '0');
  const shown = (v: string): string => {
    const r = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(v);
    if (!r) return '';
    const day = de ? `${r[3]}.${r[2]}.${r[1]}` : `${r[2]}/${r[3]}/${r[1]}`;
    return withTime && r[4] ? `${day} ${r[4]}:${r[5]}` : day;
  };
  const [text, setText] = useState(shown(value));
  const [bad, setBad] = useState(false);
  const parse = (t: string): string | null => {
    const r = (de ? /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/ : /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,]+(\d{1,2}):(\d{2}))?$/).exec(t.trim());
    if (!r) return null;
    const [day, month] = de ? [Number(r[1]), Number(r[2])] : [Number(r[2]), Number(r[1])];
    const y = Number(r[3]);
    const probe = new Date(Date.UTC(y, month - 1, day));
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
    if (!withTime) return `${y}-${p2(month)}-${p2(day)}`;
    const h = Number(r[4] ?? 0); const mi = Number(r[5] ?? 0);
    if (h > 23 || mi > 59) return null;
    return `${y}-${p2(month)}-${p2(day)}T${p2(h)}:${p2(mi)}`;
  };
  const pattern = withTime ? m.ui.common.dateTimePattern : m.ui.common.datePattern;
  return (
    <span className="date-field">
      <input type="text" inputMode="numeric" value={text} placeholder={pattern} aria-invalid={bad}
        onChange={(e) => { const t = e.currentTarget.value; setText(t); const v = t.trim() === '' ? '' : parse(t); setBad(v === null); onChange(v ?? ''); }} />
      {bad ? <span className="small gap-note">{m.ui.common.formatHint(pattern)}</span> : null}
    </span>
  );
}

/** Шаг 78: момент во вторичной строке — без года и пояса («Oct 11, 04:45»; версия стратегии, не таблица) */
export function shortWhen(value: string): string {
  const en = /^([A-Z][a-z]{2}) (\d{1,2}), \d{4}, (\d{2}:\d{2}) UTC.*$/.exec(value);
  if (en) return `${en[1]} ${en[2]}, ${en[3]}`;
  const de = /^(\d{1,2})\. (\S+) \d{4}, (\d{2}:\d{2}) UTC.*$/.exec(value);
  if (de) return `${de[1]}. ${de[2]}, ${de[3]}`;
  return value;
}

/**
 * Шаг 82: квадратик-аватар товара 28px — инициал и цвет из палитры по хэшу SKU (без SKU — по товарной части подписи). Детерминированно:
 * тот же товар — тот же цвет на всех экранах. Инициал рисуют стили (`data-initial`), в текст строки он не входит
 */
const AVATAR_TONES = 8;
export function productSeed(label: string, sku?: string | null): string {
  return sku ?? label.split(' · ')[0] ?? label;
}
export function Avatar({ label, sku }: { label: string; sku?: string | null }) {
  let h = 2166136261;
  for (const ch of productSeed(label, sku)) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619); }
  const initial = (label.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? '#').toUpperCase();
  return <span className={`avatar avatar-${(h >>> 0) % AVATAR_TONES}`} data-initial={initial} aria-hidden="true" />;
}

/** Ячейка товара: аватар слева, подпись и её подробности — справа */
export function WithAvatar({ label, sku, children }: { label: string; sku?: string | null; children: ReactNode }) {
  return <div className="with-avatar"><Avatar label={label} sku={sku} /><div className="with-avatar-body">{children}</div></div>;
}

export function When({ value }: { value: string | null | undefined }) {
  const m = useMessages();
  if (!value) return null;
  return <span className="when" title={value}>{humanWhen(value, m.locale)}</span>;
}

/** `symbol` — пилюля из одного знака (✓, !, ✕): без точки тона перед ним */
export function Badge({ tone, children, symbol }: { tone: string; children: ReactNode; symbol?: boolean }) {
  return <span className={`badge tone-${tone}${symbol ? ' symbol' : ''}`}>{children}</span>;
}

export function Cell({ cell }: { cell: StatusCell }) {
  return (
    <div className={`cell cell-${cell.tone}`} title={cell.detail}>
      <Badge tone={cell.tone}>{cell.label}</Badge>
      <div className="muted small cell-detail">{cell.detail}</div>
    </div>
  );
}

export function ReasonLine({ reason }: { reason: HumanReason }) {
  const m = useMessages();
  return (
    <div className="reason">
      <span title={reason.text}>{reason.text}</span>
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
/** Шаг 79: форма скелета загрузки — как у экрана, который придёт: таблица, карточки, таймлайн шагов, статистика тени */
export type SkeletonShape = 'table' | 'cards' | 'trace' | 'stats';

function Skeleton({ shape }: { shape: SkeletonShape }) {
  const bar = (w: string, key?: number) => <span key={key} className="sk-bar" style={{ width: w }} />;
  if (shape === 'table') {
    return (
      <div className="skeleton sk-table" aria-hidden="true">
        <div className="sk-row sk-head">{bar('18%')}{bar('12%')}{bar('12%')}{bar('16%')}{bar('10%')}</div>
        {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="sk-row">{bar('22%')}{bar('9%')}{bar('9%')}{bar('18%')}{bar('12%')}</div>)}
      </div>
    );
  }
  if (shape === 'stats') {
    return (
      <div className="skeleton" aria-hidden="true">
        <div className="sk-stats">{[0, 1, 2, 3].map((i) => <div key={i} className="sk-card">{bar('50%')}{bar('35%')}</div>)}</div>
        <div className="sk-card sk-wide">{bar('70%')}{bar('55%')}{bar('62%')}</div>
      </div>
    );
  }
  if (shape === 'trace') {
    return (
      <div className="skeleton sk-trace" aria-hidden="true">
        <div className="sk-card sk-wide">{bar('60%')}</div>
        {[0, 1, 2, 3].map((i) => <div key={i} className="sk-step"><span className="sk-dot" /><div className="sk-card">{bar('30%')}{bar('75%')}{bar('55%')}</div></div>)}
      </div>
    );
  }
  return <div className="skeleton sk-cards" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="sk-card">{bar('40%')}{bar('80%')}{bar('65%')}</div>)}</div>;
}

export function Loading({ startedAt, shape = 'cards' }: { startedAt: number; shape?: SkeletonShape }) {
  const m = useMessages();
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((startedAt + REQUEST_TIMEOUT_MS - now) / 1000));
  return (
    <div className="loading-block">
      <p className="loading" role="status">{m.ui.app.loading(left)}</p>
      <Skeleton shape={shape} />
    </div>
  );
}

export function ErrorBox({ message, onRetry, title }: { message: string; onRetry?: () => void; title?: string }) {
  const m = useMessages();
  return (
    <div className={`error${title ? ' load-error' : ''}`} role="alert">
      {title ? <h3>{title}</h3> : null}
      <p>{message}</p>
      {onRetry ? <button type="button" onClick={onRetry}>{m.ui.app.retry}</button> : null}
    </div>
  );
}

export function Load<T>({ resource, retry, children, shape, notFound }: {
  resource: Resource<T>; retry: () => void; children: (data: T) => ReactNode; shape?: SkeletonShape;
  /** Что показать, если сервер ответил 404: «не найдено» с путём назад, а не «не загрузилось» с бесполезным повтором */
  notFound?: ReactNode;
}) {
  const m = useMessages();
  if (resource.state === 'loading') return <Loading startedAt={resource.startedAt} {...(shape ? { shape } : {})} />;
  if (resource.state === 'error') {
    const failure = resource.error instanceof ApiError ? resource.error.failure : null;
    const status = failure && 'status' in failure ? failure.status : null;
    if (status === 404 && notFound) return <>{notFound}</>;
    // Шаг 79: экран, который не загрузился, — карточкой с заголовком и причиной; повтор — только там, где он может помочь (сеть, 5xx)
    const retryable = status === null || status >= 500;
    return <ErrorBox title={m.ui.app.loadFailedTitle} message={errorText(resource.error, m)} {...(retryable ? { onRetry: retry } : {})} />;
  }
  return <>{children(resource.data)}</>;
}

/**
 * Шаг 77, 79: своё поле выбора файла — кнопка браузера говорит на языке БРАУЗЕРА («Выберите файл»), а не консоли. Одна площадка у
 * импорта себестоимости и у файла остатков
 */
export function FileDrop({ label, fileName, disabled = false, onChoose }: { label: string; fileName: string | null; disabled?: boolean; onChoose: (input: HTMLInputElement) => void }) {
  return (
    <label className={`file-drop${disabled ? ' disabled' : ''}`}>
      <input type="file" className="visually-hidden" accept=".csv,.xlsx,text/csv" onChange={(e) => onChoose(e.currentTarget)} disabled={disabled} />
      <svg className="file-drop-icon" viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M12 17v-6" /><path d="m9.5 13.5 2.5-2.5 2.5 2.5" />
      </svg>
      <span className="file-drop-label">{label}</span>
      {fileName ? <span className="file-drop-name">{fileName}</span> : null}
    </label>
  );
}

/** Шаг 79: «не найдено» — карточкой с заголовком, пояснением и путём назад (мир, экран, решение) */
export function NotFound({ title, text, back, href: to = '#/' }: { title: string; text: string; back: string; href?: string }) {
  return (
    <section className="card not-found">
      <h2>{title}</h2>
      <p className="subtitle">{text}</p>
      <p className="back"><a href={to}>{back}</a></p>
    </section>
  );
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
  // Шаг 79: под пустым списком листать нечего — переключатель страниц не показывается
  if (page.total === 0) return null;
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
