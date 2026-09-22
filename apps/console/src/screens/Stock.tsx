import { useState } from 'react';
import type { BulkJobView, StockDivergencesView, StockView } from '@repracer/console-model';
import type { ListQuery } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, href, Load, Pager, useMessages } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

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
  const [view, retry] = useResource<StockView>(`${worldPath(worldId, 'stock')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
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
  const enable = (channelAccountId: string) => void post<{ message: string }>('enable', {
    channelAccountId, bufferUnits: Number(buffer), maxQuantity: maxQuantity === '' ? null : Number(maxQuantity), minQuantityToList: Number(minToList), acknowledgeSideEffects: ack,
  }).then((r) => { setError(null); setMessage(r.message); refresh(); }).catch((e: unknown) => setError(errorText(e, m)));

  return (
    <Load resource={view} retry={retry}>
      {(v) => (
        <>
          <StockScreenView view={v} worldId={worldId} query={query} onQuery={setQuery} />
          {v.canManage ? (
            <section className="card">
              <h3>{m.ui.stock.sources.title}</h3>
              <label>{m.ui.stock.sources.name} <input value={sourceName} onChange={(e) => setSourceName(e.currentTarget.value)} /></label>
              <select value={sourceMode} onChange={(e) => setSourceMode(e.currentTarget.value as 'INTERNAL_POOL' | 'INBOUND_API')}>
                <option value="INTERNAL_POOL">{m.ui.stock.sources.modes.INTERNAL_POOL}</option>
                <option value="INBOUND_API">{m.ui.stock.sources.modes.INBOUND_API}</option>
              </select>
              <button type="button" onClick={createSource} disabled={sourceName.trim() === ''}>{m.ui.stock.sources.create}</button>
              {apiKey ? <p className="notice"><strong>{m.ui.stock.sources.keyOnce}</strong> <code>{apiKey}</code><br /><span className="small muted">{m.ui.stock.sources.keyHint(window.location.origin)}</span></p> : null}
              <h3>{m.ui.stock.importFile.title}</h3>
              <p className="small muted">{m.ui.stock.importFile.hint}</p>
              <select value={sourceId} onChange={(e) => setSourceId(e.currentTarget.value)}>
                <option value="">—</option>
                {v.sources.filter((s) => s.mode === 'INTERNAL_POOL').map((s) => <option key={s.stockSourceId} value={s.stockSourceId}>{s.name}</option>)}
              </select>
              <input type="file" accept=".csv,.xlsx,text/csv" onChange={(e) => void choose(e.currentTarget)} />
              <button type="button" onClick={importFile} disabled={!file || sourceId === '' || job !== null}>{m.ui.stock.importFile.submit}</button>
              {job ? <JobProgress worldId={worldId} jobId={job.jobId} onFinished={() => { setJob(null); refresh(); }} /> : null}
              <h3>{m.ui.stock.enable.title}</h3>
              <label>{m.ui.stock.enable.buffer} <input value={buffer} onChange={(e) => setBuffer(e.currentTarget.value)} /></label>
              <label>{m.ui.stock.enable.maxQuantity} <input value={maxQuantity} onChange={(e) => setMaxQuantity(e.currentTarget.value)} /></label>
              <label>{m.ui.stock.enable.minToList} <input value={minToList} onChange={(e) => setMinToList(e.currentTarget.value)} /></label>
              {v.traps.map((t) => (
                <div key={t.channelAccountId} className="notice">
                  <p><Badge tone="warn">{m.ui.stock.traps.title}</Badge> {t.text}</p>
                  {t.requiresAck ? <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.currentTarget.checked)} /> {m.ui.stock.enable.acknowledge}</label> : null}
                  <button type="button" onClick={() => enable(t.channelAccountId)} disabled={t.requiresAck && !ack}>{m.ui.stock.enable.submit}</button>
                </div>
              ))}
            </section>
          ) : <p className="muted">{m.ui.stock.noRight}</p>}
          <Load resource={divergences} retry={retryDivergences}>{(d) => <StockDivergences view={d} />}</Load>
          {message ? <p className="notice" role="status">{message}</p> : null}
          {error ? <ErrorBox message={error} onRetry={refresh} /> : null}
        </>
      )}
    </Load>
  );
}

/** Экран без запросов — то, что отрисовывает тест из ответа сервера */
export function StockScreenView({ view: v, worldId, query, onQuery }: { view: StockView; worldId: string; query: ListQuery; onQuery: (q: ListQuery) => void }) {
  const m = useMessages();
  const t = m.ui.stock;
  return (
    <section className="stock">
      <h2>{t.title}</h2>
      {v.demo ? <p className="notice"><Badge tone="warn">{m.ui.app.demoBadge}</Badge> {m.ui.app.demoBanner}</p> : null}
      <p className="muted">{v.intro}</p>
      <p><strong>{v.summaryText}</strong></p>
      {v.sources.length === 0 ? <p className="notice">{m.ui.onboarding.empty.stock} <a href={href(worldId, 'onboarding')}>{m.ui.onboarding.empty.startHere}</a></p>
        : <ul className="small">{v.sources.map((s) => <li key={s.stockSourceId}>{s.name} — {s.modeText}; {s.productsText}{s.hasKey ? `; ${t.sources.keyPresent}` : ''}</li>)}</ul>}
      {v.rows.length > 0 ? (
        <table>
          <thead><tr><th>{t.columns.product}</th><th>{t.columns.onHand}</th><th>{t.columns.reserved}</th><th>{t.columns.available}</th><th>{t.columns.channels}</th></tr></thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.productId}>
                <td>{r.sku}{r.gtin ? <span className="small muted"> · {r.gtin}</span> : null}</td>
                <td>{r.onHand}</td><td>{r.reserved}</td><td>{r.available}</td>
                <td>
                  {r.channels.length === 0 ? <span className="muted">—</span> : (
                    <ul className="small">
                      {r.channels.map((c) => (
                        <li key={c.writeScopeId}>
                          <Badge tone={c.tone}>{c.label}</Badge> {c.sharedText ? <em>{c.sharedText}; </em> : null}
                          {c.syncEnabled ? <>{t.channel.published(c.published)}; {c.sentText}; {c.confirmedText}</> : c.awaitingAck ? t.channel.awaitingAck : t.channel.off}
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
      ) : null}
      <Pager page={v.page} query={query} onQuery={onQuery} />
      <p className="small muted">{v.cannot}</p>
      <Gaps gaps={v.gaps} />
    </section>
  );
}

export function StockDivergences({ view }: { view: StockDivergencesView }) {
  const m = useMessages();
  return (
    <section className="card">
      <h3>{m.ui.stock.divergences.title}</h3>
      {view.items.length === 0 ? <p className="muted">{view.none}</p> : (
        <ul className="small">{view.items.map((d) => <li key={d.writeScopeId}><strong>{d.sku}</strong> · {(m.values as Record<string, string | undefined>)[d.channel] ?? d.channel} {d.marketplaces.join(', ')}: {d.text}</li>)}</ul>
      )}
    </section>
  );
}
