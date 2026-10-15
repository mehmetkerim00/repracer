import { useState } from 'react';
import type { BulkJobView, StockDivergencesView, StockReturnsView, StockView } from '@repracer/console-model';
import type { ListQuery } from '@repracer/console-model';
import { ApiError, requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, FileDrop, Gaps, href, Intro, Load, Pager, useMessages } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';
import { Banner, CheckField, Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';

/**
 * Р-153 (шаг 35): экран остатков. По товару — физический остаток, резервации, доступно; по каналу — что посчитано,
 * что отправлено и что канал ПОДТВЕРДИЛ; расхождения — отдельным списком; ловушки каналов — до первой записи.
 * Экран честно говорит, чего не показывает: между записями канал не читается.
 */

function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function StockScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: 50 });
  // Шаг 69 (K8): поиск и фильтр — параметры запроса; новая выборка начинается с первой страницы
  const [filter, setFilter] = useState<{ search: string; withReservations: boolean }>({ search: '', withReservations: false });
  const filterParams = `${filter.search ? `&q=${encodeURIComponent(filter.search)}` : ''}${filter.withReservations ? '&reserved=1' : ''}`;
  const [view, retry] = useResource<StockView>(`${worldPath(worldId, 'stock')}?offset=${query.offset}&limit=${query.limit}${filterParams}`, m.locale);
  const [divergences, retryDivergences] = useResource<StockDivergencesView>(worldPath(worldId, 'stock', 'divergences'), m.locale);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [job, setJob] = useState<BulkJobView | null>(null);
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [sourceMode, setSourceMode] = useState<'INTERNAL_POOL' | 'INBOUND_API'>('INTERNAL_POOL');
  const [sourceId, setSourceId] = useState('');
  const [buffer, setBuffer] = useState('0');
  const [maxQuantity, setMaxQuantity] = useState('');
  const [minToList, setMinToList] = useState('0');
  const [ack, setAck] = useState(false);
  /** Шаг 60 [Р-202]: запись количества не подтверждена владельцем — отказ ведёт на экран подключений */
  const [toConnections, setToConnections] = useState(false);
  const refresh = () => { retry(); retryDivergences(); };
  const post = <T,>(path: string, body: Record<string, unknown>) => requestJson<T>(worldPath(worldId, 'stock', path), { method: 'POST', body, locale: m.locale });

  const createSource = () => void post<{ stockSourceId: string; apiKey: string | null }>('sources', { mode: sourceMode, name: sourceName })
    .then((r) => { setError(null); setApiKey(r.apiKey); setSourceId(r.stockSourceId); refresh(); })
    .catch((e: unknown) => setError(errorText(e, m)));
  const choose = async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    if (!picked) return setFile(null);
    setFile({ name: picked.name, content: base64Of(new Uint8Array(await picked.arrayBuffer())) });
  };
  const importFile = () => { if (file) void post<{ jobId: string; job?: BulkJobView; message: string }>('import', { ...file, fileName: file.name, stockSourceId: sourceId })
    .then((r) => { setError(null); setMessage(r.message); if (r.job) setJob(r.job); })
    .catch((e: unknown) => setError(errorText(e, m))); };
  // Р-139: включение — задание; ход виден, итог приходит с заданием
  const enable = (channelAccountId: string) => void post<{ jobId: string; job?: BulkJobView; message: string }>('enable', {
    channelAccountId, bufferUnits: Number(buffer), maxQuantity: maxQuantity === '' ? null : Number(maxQuantity), minQuantityToList: Number(minToList), acknowledgeSideEffects: ack,
  }).then((r) => { setError(null); setToConnections(false); setMessage(r.message); if (r.job) setJob(r.job); }).catch((e: unknown) => {
    setToConnections(e instanceof ApiError && e.failure.kind === 'SERVER' && e.failure.code === 'QUANTITY_WRITES_NOT_CONFIRMED');
    setError(errorText(e, m));
  });

  return (
    <Load shape="table" resource={view} retry={retry}>
      {(v) => (
        <>
          <StockScreenView view={v} worldId={worldId} query={query} onQuery={setQuery} onFilter={(f) => { setFilter(f); setQuery({ ...query, offset: 0 }); }} />
          {v.canManage ? (
            <>
              {/* Шаг 94: управление остатками — три группы полей стандарта; подпись над полем, пояснение под ним, кнопка — в конце группы */}
              <FieldGroup title={m.ui.stock.sources.title}>
                <FieldGrid cols={2}>
                  <Field label={m.ui.stock.sources.name} caption={m.ui.stock.sources.nameCaption}><input value={sourceName} onChange={(e) => setSourceName(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.sources.mode}><select value={sourceMode} onChange={(e) => setSourceMode(e.currentTarget.value as 'INTERNAL_POOL' | 'INBOUND_API')}>
                    <option value="INTERNAL_POOL">{m.ui.stock.sources.modes.INTERNAL_POOL}</option>
                    <option value="INBOUND_API">{m.ui.stock.sources.modes.INBOUND_API}</option>
                  </select></Field>
                </FieldGrid>
                <FormActions hint={sourceName.trim() === '' ? m.ui.forms.why.name : null}>
                  <button type="button" onClick={createSource} disabled={sourceName.trim() === ''} title={sourceName.trim() === '' ? m.ui.forms.why.name : undefined}>{m.ui.stock.sources.create}</button>
                </FormActions>
                {apiKey ? <p className="notice"><strong>{m.ui.stock.sources.keyOnce}</strong> <code>{apiKey}</code><br /><span className="small muted">{m.ui.stock.sources.keyHint(window.location.origin)}</span></p> : null}
              </FieldGroup>
              <FieldGroup title={m.ui.stock.importFile.title} caption={m.ui.stock.importFile.hint}>
                <FieldGrid cols={2}>
                  <Field label={m.ui.stock.importFile.source} caption={m.ui.stock.importFile.sourceCaption}><select value={sourceId} onChange={(e) => setSourceId(e.currentTarget.value)}>
                    <option value="">—</option>
                    {v.sources.filter((s) => s.mode === 'INTERNAL_POOL').map((s) => <option key={s.stockSourceId} value={s.stockSourceId}>{s.name}</option>)}
                  </select></Field>
                  <Field label={m.ui.stock.importFile.file}><FileDrop label={m.ui.stock.importFile.chooseFile} fileName={file ? file.name : null} onChoose={(input) => void choose(input)} /></Field>
                </FieldGrid>
                {(() => {
                  const why = sourceId === '' ? m.ui.forms.why.source : !file ? m.ui.forms.why.file : job !== null ? m.ui.forms.why.jobRunning : null;
                  return (
                    <FormActions hint={why}>
                      <button type="button" className="primary" onClick={importFile} disabled={why !== null} title={why ?? undefined}>{m.ui.stock.importFile.submit}</button>
                    </FormActions>
                  );
                })()}
                {job ? <JobProgress worldId={worldId} jobId={job.jobId} onFinished={() => { setJob(null); refresh(); }} /> : null}
              </FieldGroup>
              <FieldGroup title={m.ui.stock.enable.title}>
                <FieldGrid cols={3}>
                  <Field label={m.ui.stock.enable.buffer} caption={m.ui.stock.enable.bufferCaption}><input inputMode="numeric" value={buffer} onChange={(e) => setBuffer(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.enable.maxQuantity} caption={m.ui.stock.enable.maxQuantityCaption}><input inputMode="numeric" value={maxQuantity} onChange={(e) => setMaxQuantity(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.enable.minToList} caption={m.ui.stock.enable.minToListCaption}><input inputMode="numeric" value={minToList} onChange={(e) => setMinToList(e.currentTarget.value)} /></Field>
                </FieldGrid>
                {/* Ловушки каналов — плашкой: канал и пилюля, суть в одну-две строки, подробности — по раскрытию [Р-153] */}
                {v.traps.map((t) => {
                  const why = t.requiresAck && !ack ? m.ui.forms.why.confirmSideEffect : job !== null ? m.ui.forms.why.jobRunning : null;
                  return (
                    <Banner key={t.channelAccountId} title={t.title} badge={<Badge tone="warn">{m.ui.stock.traps.title}</Badge>} summary={t.summary} details={t.text}>
                      {t.requiresAck ? <CheckField label={m.ui.stock.enable.acknowledge} caption={m.ui.stock.enable.acknowledgeCaption} checked={ack} onChange={setAck} /> : null}
                      <FormActions hint={why}>
                        <button type="button" onClick={() => enable(t.channelAccountId)} disabled={why !== null} title={why ?? undefined}>{m.ui.stock.enable.submit}</button>
                      </FormActions>
                    </Banner>
                  );
                })}
              </FieldGroup>
            </>
          ) : <p className="notice">{m.ui.stock.noRight}</p>}
          <Load shape="table" resource={divergences} retry={retryDivergences}>{(d) => <StockDivergences view={d} />}</Load>
          <StockReturns worldId={worldId} onDecided={refresh} />
          {message ? <p className="notice" role="status">{message}</p> : null}
          {error ? <ErrorBox message={error} onRetry={refresh} /> : null}
          {error && toConnections ? <p className="back"><a href={href(worldId, 'connections')}>{m.ui.app.screens.connections}</a></p> : null}
        </>
      )}
    </Load>
  );
}

/** Экран без запросов — то, что отрисовывает тест из ответа сервера */
export function StockScreenView({ view: v, worldId, query, onQuery, onFilter }: {
  view: StockView; worldId: string; query: ListQuery; onQuery: (q: ListQuery) => void;
  onFilter?: (f: { search: string; withReservations: boolean }) => void;
}) {
  const m = useMessages();
  const t = m.ui.stock;
  const [search, setSearch] = useState(v.filter.search);
  const [withReservations, setWithReservations] = useState(v.filter.withReservations);
  return (
    <section className="stock">
      <h2>{t.title}</h2>
      {/* Шаг 77: пометку демо даёт полоса под шапкой на каждом экране мира [Р-151] — второй баннер на экране не нужен */}
      <Intro text={v.intro} />
      {/* Шаг 64: у пустого экрана — не строка нулей, а объяснение ниже */}
      {v.sources.length === 0 ? <p className="notice">{m.ui.onboarding.empty.stock} <a href={href(worldId, 'onboarding')}>{m.ui.onboarding.empty.startHere}</a></p> : (
        // Шаг 79: итоги и источники — карточкой над таблицей, а не текстом на фоне страницы
        <div className="toolbar stock-summary">
          {v.rows.length > 0 ? <strong>{v.summaryText}</strong> : null}
          <ul className="small plain">{v.sources.map((s) => <li key={s.stockSourceId}>{s.name} — {s.modeText}; {s.productsText}{s.hasKey ? `; ${t.sources.keyPresent}` : ''}</li>)}</ul>
        </div>
      )}
      {onFilter && (v.rows.length > 0 || v.filter.matchedText) ? (
        // Шаг 94: фильтр — поле стандарта с подписью над ним, галочка — своей ячейкой, кнопки — в конце ряда
        <form className="filters toolbar field-toolbar" onSubmit={(e) => { e.preventDefault(); onFilter({ search: search.trim(), withReservations }); }}>
          <Field label={t.filter.searchLabel}><input type="search" value={search} placeholder={t.filter.search} onChange={(e) => setSearch(e.currentTarget.value)} /></Field>
          <CheckField label={t.filter.withReservations} checked={withReservations} onChange={(on) => { setWithReservations(on); onFilter({ search: search.trim(), withReservations: on }); }} />
          <div className="form-actions-row">
            <button type="submit">{t.filter.apply}</button>
            {v.filter.matchedText ? <button type="button" onClick={() => { setSearch(''); setWithReservations(false); onFilter({ search: '', withReservations: false }); }}>{t.filter.reset}</button> : null}
          </div>
        </form>
      ) : null}
      {v.filter.matchedText ? <p className="section-sub">{v.filter.matchedText}</p> : null}
      {v.filter.noneText ? <p className="notice">{v.filter.noneText}</p> : null}
      {v.rows.length > 0 ? (
        <div className="table-wrap">
        <table className="stock-table cardify">
          <thead><tr><th>{t.columns.product}</th><th className="num">{t.columns.onHand}</th><th className="num">{t.columns.reserved}</th><th className="num">{t.columns.available}</th><th>{t.columns.channels}</th></tr></thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.productId}>
                <td className="product card-title">{r.label}{r.label !== r.sku ? <span className="small muted nowrap"> · {r.sku}</span> : null}{r.gtin ? <span className="small muted nowrap"> · {r.gtin}</span> : null}</td>
                <td className="num" data-label={t.columns.onHand}>{r.onHand}</td><td className="num" data-label={t.columns.reserved}>{r.reserved}</td><td className="num money" data-label={t.columns.available}>{r.available}</td>
                <td className="text-cell" data-label={t.columns.channels}>
                  {r.channelManaged.length > 0 ? <ul className="small muted plain">{r.channelManaged.map((text, i) => <li key={i}>{text}</li>)}</ul> : null}
                  {r.channels.length === 0 ? (r.channelManaged.length > 0 ? null : <span className="muted">—</span>) : (
                    <ul className="small plain stock-channels">
                      {r.channels.map((c) => (
                        <li key={c.writeScopeId}>
                          {/* Шаг 79 (ревью): витрина — текстом, состояние — пилюлей своего цвета; подробности — строкой ниже */}
                          <span className="channel-name">{c.label}</span> <Badge tone={c.tone}>{c.statusText}</Badge>
                          <div className="muted">{c.sharedText ? <em>{c.sharedText}; </em> : null}
                            {c.syncEnabled ? <>{t.channel.published(c.published)}; {c.sentText}; {c.confirmedText}</> : c.awaitingAck ? t.channel.awaitingAck : t.channel.off}</div>
                          {c.divergedText ? <p className="error">{c.divergedText}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Шаг 79: чего экран не видит — подвалом таблицы, а не текстом на фоне страницы */}
        <p className="table-foot">{v.cannot}</p>
        </div>
      ) : <p className="notice">{v.cannot}</p>}
      <Pager page={v.page} query={query} onQuery={onQuery} />
      <Gaps gaps={v.gaps} />
    </section>
  );
}

export function StockDivergences({ view }: { view: StockDivergencesView }) {
  const m = useMessages();
  return (
    <section className="card">
      <h3>{m.ui.stock.divergences.title}</h3>
      {view.items.length === 0 ? <p className="muted empty">{view.none}</p> : (
        <ul className="small">{view.items.map((d) => <li key={d.writeScopeId}><strong>{d.sku}</strong> · {(m.values as Record<string, string | undefined>)[d.channel] ?? d.channel} · {d.storefrontsText}: {d.text}</li>)}</ul>
      )}
    </section>
  );
}

/**
 * Шаг 59 [Р-199]: возвраты. У ждущей строки внутреннего пула — две кнопки и заметка; у источника Inbound API — пояснение,
 * что остаток ведёт система продавца. После решения список и экран остатков перезагружаются
 */
export function StockReturns({ worldId, onDecided }: { worldId: string; onDecided: () => void }) {
  const m = useMessages();
  const [view, retry] = useResource<StockReturnsView>(worldPath(worldId, 'stock', 'returns'), m.locale);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = (orderReturnId: string, accept: boolean) => {
    setBusy(orderReturnId);
    void requestJson<{ message: string }>(worldPath(worldId, 'stock', 'returns'), { method: 'POST', body: { orderReturnId, accept, note: notes[orderReturnId] ?? '' }, locale: m.locale })
      .then((r) => { setError(null); setMessage(r.message); })
      .catch((e: unknown) => { setMessage(null); setError(errorText(e, m)); })
      .finally(() => { setBusy(null); retry(); onDecided(); });
  };
  return (
    <Load shape="table" resource={view} retry={retry}>
      {(v) => <StockReturnsList view={v} notes={notes} busy={busy} onNote={(id, text) => setNotes((n) => ({ ...n, [id]: text }))} onDecide={decide} message={message} error={error} onRetry={retry} />}
    </Load>
  );
}

/** Список возвратов без запросов — то, что отрисовывает тест из ответа сервера */
export function StockReturnsList({ view: v, notes, busy, onNote, onDecide, message, error, onRetry }: {
  view: StockReturnsView; notes: Record<string, string>; busy: string | null; onNote: (id: string, text: string) => void; onDecide: (id: string, accept: boolean) => void;
  message: string | null; error: string | null; onRetry: () => void;
}) {
  const m = useMessages();
  const t = m.ui.stock.returns;
  return (
    <section className="card">
      <h3>{t.title}</h3>
      <p className="small muted">{v.intro}</p>
      <p><strong>{v.pendingText}</strong></p>
      {v.items.length === 0 ? <p className="muted empty">{v.none}</p> : (
        <ul className="small">
          {v.items.map((r) => (
            <li key={r.orderReturnId}>
              <Badge tone={r.pending ? 'warn' : r.infoOnly ? 'off' : 'ok'}>{r.statusText}</Badge> <strong>{r.sku}</strong> · {r.channel} · {r.channelOrderLineRef}: {r.text}
              {r.note ? <em> — {r.note}</em> : null}
              {r.pending && v.canDecide ? (
                <div className="return-decision">
                  <Field label={t.note}><input value={notes[r.orderReturnId] ?? ''} onChange={(e) => onNote(r.orderReturnId, e.currentTarget.value)} maxLength={500} /></Field>
                  <FormActions>
                    <button type="button" className="primary" onClick={() => onDecide(r.orderReturnId, true)} disabled={busy !== null}>{t.accept}</button>
                    <button type="button" onClick={() => onDecide(r.orderReturnId, false)} disabled={busy !== null}>{t.dismiss}</button>
                  </FormActions>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!v.canDecide && v.pendingCount > 0 ? <p className="muted">{m.ui.stock.noRight}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <ErrorBox message={error} onRetry={onRetry} /> : null}
    </section>
  );
}
