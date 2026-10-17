import { useEffect, useState, type ReactNode } from 'react';
import type { BulkJobView, ImportCheckView, ImportHistoryView, ImportKind } from '@repracer/console-model';
import { downloadFile, requestJson, worldPath } from '../api.ts';
import type { JobCreatedResponse } from '../api-types.ts';
import { Badge, ErrorBox, errorText, FileDrop, useMessages } from '../components.tsx';
import { Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';
import { JobProgress } from './Jobs.tsx';

/**
 * Шаг 99 [Р-224, Р-225]: импорт продавца — одним видом у всех четырёх (себестоимость, остатки, границы, стратегии) и на своей странице:
 * меню не растёт. Порядок обязателен: шаблон с текущими значениями → файл → примерка на сервере (сколько строк изменится, ошибки по
 * строкам) → «Apply» применяет ровно примерку или ничего. Ниже — журнал импортов этого вида.
 */

/**
 * Ревью шага 28, находка 7: `btoa(String.fromCharCode(...bytes))` раскладывает весь файл в аргументы вызова, и браузер на файле в
 * сотни килобайт падает `RangeError` ещё до отправки. Кодируем частями
 */
function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * Шаг 96.2 (решение владельца G2): колонка с одним значением у трёх и больше строк — фразой подписи над таблицей, а не колонкой. Так
 * таблица ошибок файла, где у всех строк одна причина, и журнал, где все запуски одного человека, не повторяют одно и то же в каждой строке
 */
/** `card` — роль ячейки, когда ниже 768px строка таблицы становится карточкой (шаг 85): заголовок карточки или пилюля состояния */
interface Column<T> { key: string; label: string; className?: string; card?: 'title' | 'status'; render: (row: T) => ReactNode; text: (row: T) => string }
function UniformTable<T>({ rows, columns, rowKey, className }: { rows: readonly T[]; columns: readonly Column<T>[]; rowKey: (row: T, i: number) => string; className?: string }) {
  const m = useMessages();
  const uniform = new Set(rows.length >= 3 ? columns.filter((c) => !c.className?.includes('num')).filter((c) => {
    const values = rows.map((r) => c.text(r));
    return values.every((v) => v !== '' && v === values[0]);
  }).map((c) => c.key) : []);
  const shown = columns.filter((c) => !uniform.has(c.key));
  return (
    <>
      {uniform.size > 0 ? (
        <p className="small muted uniform-caption">
          {columns.filter((c) => uniform.has(c.key)).map((c) => `${c.label}${m.colon}${c.text(rows[0]!)}`).join(' · ')}
        </p>
      ) : null}
      <div className="table-wrap">
        <table className={`cardify${className ? ` ${className}` : ''}`}>
          <thead><tr>{shown.map((c) => <th key={c.key} className={c.className}>{c.label}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={rowKey(r, i)}>{shown.map((c) => (
            <td key={c.key} className={[c.className, c.card ? `card-${c.card}` : null].filter(Boolean).join(' ') || undefined} data-label={c.card ? undefined : c.label}>{c.render(r)}</td>
          ))}</tr>)}</tbody>
        </table>
      </div>
    </>
  );
}

export function ImportCheck({ view, onMapping, onEncoding }: {
  view: ImportCheckView; onMapping?: (field: string, index: number | null) => void; onEncoding?: (encoding: string) => void;
}) {
  const m = useMessages();
  const t = m.ui.imports;
  const stats = (['total', 'changed', 'unchanged', 'rejected'] as const);
  return (
    <section className={`import-check ${view.tone}`}>
      <div className="card summary-card">
        <p className="headline">{view.headline}</p>
        <ul className="stat-chips" aria-label={t.statsLabel}>
          {stats.map((k) => <li key={k} className={`stat-chip${view.counts[k] > 0 && k !== 'total' && k !== 'unchanged' ? ' on' : ''}`}><span>{t.stats[k]}</span> <strong>{view.counts[k]}</strong></li>)}
        </ul>
        <p className="source small muted">{t.sourceRead(view.source.format, view.source.delimiter)} · {view.fileName}</p>
        {view.blocked ? <p className="notice warn">{view.blocked}</p> : null}
        {view.applyBlocked && !view.blocked ? <p className={`notice${view.counts.rejected > 0 ? ' warn' : ''}`}>{view.applyBlocked}</p> : null}
      </div>
      {view.errors.length > 0 ? (
        <section className="card import-errors">
          <h4>{t.errorsTitle(view.errors.length, view.counts.rejected)}</h4>
          <UniformTable rows={view.errors} rowKey={(e) => String(e.line)} className="import-errors-table" columns={[
            { key: 'line', label: t.errorColumns.line, className: 'num', render: (e) => e.line, text: (e) => String(e.line) },
            { key: 'key', label: t.errorColumns.key, card: 'title', render: (e) => e.key || m.ui.common.noValue, text: (e) => e.key },
            { key: 'column', label: t.errorColumns.column, render: (e) => e.field ?? m.ui.common.noValue, text: (e) => e.field ?? '' },
            { key: 'problem', label: t.errorColumns.problem, render: (e) => e.text, text: (e) => e.text },
          ]} />
        </section>
      ) : null}
      {view.changes.length > 0 ? (
        <section className="card import-changes">
          <h4>{t.changesTitle(new Set(view.changes.map((c) => c.line)).size, view.counts.changed)}</h4>
          <UniformTable rows={view.changes} rowKey={(c, i) => `${c.line}-${i}`} columns={[
            { key: 'line', label: t.changeColumns.line, className: 'num', render: (c) => c.line, text: (c) => String(c.line) },
            { key: 'offer', label: t.changeColumns.offer, className: 'offer', card: 'title', render: (c) => c.offer, text: (c) => c.offer },
            { key: 'field', label: t.changeColumns.field, render: (c) => c.field, text: (c) => c.field },
            { key: 'from', label: t.changeColumns.from, className: 'num money cur', render: (c) => c.from, text: (c) => c.from },
            { key: 'to', label: t.changeColumns.to, className: 'num money cur', render: (c) => <strong>{c.to}</strong>, text: (c) => c.to },
          ]} />
        </section>
      ) : null}
      {onMapping || onEncoding ? (
        <details className="card import-columns">
          <summary>{t.columnsTitle}</summary>
          <p className="field-caption">{t.columnsCaption}</p>
          <FieldGrid cols={2}>
            {onEncoding && view.source.encoding ? (
              <Field label={t.encodingLabel} caption={view.source.encodingConfident ? null : t.encodingRead(view.source.encoding, false)}>
                <select value={view.source.encoding} onChange={(e) => onEncoding(e.currentTarget.value)}>
                  {view.encodings.map((e) => <option key={e} value={e}>{e}</option>)}
                </select>
              </Field>
            ) : null}
            {onMapping ? view.fields.map((f) => (
              <Field key={f.field} label={f.label}>
                <select value={f.columnIndex === null ? '' : String(f.columnIndex)} onChange={(e) => onMapping(f.field, e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}>
                  <option value="">{m.ui.common.noValue}</option>
                  {view.fileColumns.map((c) => <option key={c.index} value={String(c.index)}>{t.columnOption(c.name, c.header, c.sample)}</option>)}
                </select>
              </Field>
            )) : null}
          </FieldGrid>
        </details>
      ) : null}
      <p className="notice">{t.allOrNothing}</p>
      {view.mfaRequired ? <p className="small muted">{t.mfa}</p> : null}
    </section>
  );
}

export function ImportHistory({ view }: { view: ImportHistoryView }) {
  const m = useMessages();
  const t = m.ui.imports;
  return (
    <section className="card import-history">
      <h4>{t.historyTitle}</h4>
      {view.items.length === 0 ? <p className="muted empty">{t.historyEmpty}</p> : (
        <UniformTable rows={view.items} rowKey={(r) => r.runId} className="import-history-table" columns={[
          { key: 'when', label: t.historyColumns.when, card: 'title', render: (r) => r.when, text: (r) => r.when },
          { key: 'who', label: t.historyColumns.who, render: (r) => r.who, text: (r) => r.who },
          { key: 'outcome', label: t.historyColumns.outcome, card: 'status', render: (r) => <><Badge tone={r.tone}>{r.outcome}</Badge>{r.reason ? <span className="small muted"> {r.reason}</span> : null}</>, text: (r) => `${r.outcome}${r.reason ? ` ${r.reason}` : ''}` },
          { key: 'file', label: t.historyColumns.file, render: (r) => <span title={t.checksum(r.sha256)}>{r.fileName} <span className="small muted mono">{r.shaShort}</span></span>, text: (r) => `${r.fileName} ${r.shaShort}` },
          { key: 'rows', label: t.historyColumns.rows, render: (r) => r.rows, text: (r) => r.rows },
          { key: 'time', label: t.historyColumns.time, className: 'num', render: (r) => r.duration, text: (r) => r.duration },
        ]} />
      )}
    </section>
  );
}

/**
 * Раздел импорта на своей странице. `stockSources` — у остатков: файл идёт в источник, который ведётся в PriceTrail. `canEdit` — право на
 * вид импорта; шаблон скачивает любой участник
 */
export function ImportPanel({ worldId, kind, canEdit, stockSources, onApplied, caption = null }: {
  worldId: string; kind: ImportKind; canEdit: boolean; stockSources?: ReadonlyArray<{ stockSourceId: string; name: string }>; onApplied?: () => void;
  /** Подпись файла своей страницы (у остатков — какие заголовки понимает разбор в профиле рынка) */
  caption?: string | null;
}) {
  const m = useMessages();
  const t = m.ui.imports;
  const [sourceId, setSourceId] = useState(stockSources?.[0]?.stockSourceId ?? '');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null> | null>(null);
  const [encoding, setEncoding] = useState<string | null>(null);
  const [templateJob, setTemplateJob] = useState<string | null>(null);
  const [checkJob, setCheckJob] = useState<string | null>(null);
  const [view, setView] = useState<{ jobId: string; view: ImportCheckView } | null>(null);
  const [applyJob, setApplyJob] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);
  const [history, setHistory] = useState<ImportHistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stock = kind === 'STOCK';
  const extra = stock ? { stockSourceId: sourceId } : {};

  const loadHistory = () => void requestJson<ImportHistoryView>(`${worldPath(worldId, 'imports')}?kind=${kind}`, { locale: m.locale })
    .then(setHistory).catch((e: unknown) => setError(errorText(e, m)));
  useEffect(loadHistory, [worldId, kind, m.locale]);

  const post = (path: string, body: Record<string, unknown>) => requestJson<JobCreatedResponse>(worldPath(worldId, 'imports', path), { method: 'POST', body: { kind, ...body }, locale: m.locale });
  const template = (format: 'csv' | 'xlsx') => {
    setError(null);
    void post('template', { format, ...extra }).then((r) => setTemplateJob(r.jobId)).catch((e: unknown) => setError(errorText(e, m)));
  };
  const choose = async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    setError(null); setView(null); setMapping(null); setEncoding(null); setApplied(null);
    if (!picked) return setFile(null);
    setFile({ name: picked.name, content: base64Of(new Uint8Array(await picked.arrayBuffer())) });
  };
  const check = (override?: { mapping?: Record<string, number | null> | null; encoding?: string | null }) => {
    if (!file) return;
    const chosenMapping = override?.mapping === undefined ? mapping : override.mapping;
    const chosenEncoding = override?.encoding === undefined ? encoding : override.encoding;
    setBusy(true); setError(null); setView(null); setApplied(null);
    void post('check', { fileName: file.name, content: file.content, ...extra, ...(chosenMapping ? { mapping: chosenMapping } : {}), ...(chosenEncoding ? { encoding: chosenEncoding } : {}) })
      .then((r) => setCheckJob(r.jobId)).catch((e: unknown) => { setError(errorText(e, m)); setBusy(false); });
  };
  const apply = () => {
    if (!view) return;
    setBusy(true); setError(null);
    void post('apply', { checkJobId: view.jobId, checkToken: view.view.token, confirmed: true })
      .then((r) => { setApplyJob(r.jobId); setView(null); setFile(null); setMapping(null); })
      .catch((e: unknown) => { setError(errorText(e, m)); setBusy(false); });
  };
  const checked = (job: BulkJobView) => {
    setCheckJob(null); setBusy(false);
    const result = job.result as { view?: ImportCheckView } | null;
    if (job.status === 'SUCCEEDED' && result?.view) setView({ jobId: job.jobId, view: result.view });
    else setError(job.error ?? job.headline);
    loadHistory();
  };
  const finishedApply = (job: BulkJobView) => {
    setApplyJob(null); setBusy(false);
    // Шаг 99 (E): скорость — лицом: «N строк применено за X с»
    if (job.status === 'SUCCEEDED') { setApplied(job.headline); onApplied?.(); } else setError(job.error ?? job.headline);
    loadHistory();
  };
  const downloaded = (job: BulkJobView) => {
    setTemplateJob(null);
    if (job.status === 'SUCCEEDED' && job.artifact) {
      void downloadFile(`${worldPath(worldId, 'jobs', job.jobId)}/artifact`, job.artifact.fileName, m.locale).catch((e: unknown) => setError(errorText(e, m)));
    } else setError(job.error ?? job.headline);
  };
  const noSource = stock && sourceId === '';
  const why = !canEdit ? t.noRight : noSource ? t.noStockSource : !file ? m.ui.forms.why.file : busy ? m.ui.forms.why.jobRunning : null;

  return (
    <section className={`import-panel import-${kind.toLowerCase()}`}>
      <h3>{t.titles[kind]}</h3>
      <p className="subtitle">{t.intros[kind]}</p>
      {caption ? <p className="field-caption">{caption}</p> : null}
      {stock ? (
        <FieldGroup>
          {stockSources && stockSources.length > 0 ? (
            <Field label={t.stockSource} caption={t.stockSourceCaption}>
              <select value={sourceId} onChange={(e) => setSourceId(e.currentTarget.value)}>
                {stockSources.map((s) => <option key={s.stockSourceId} value={s.stockSourceId}>{s.name}</option>)}
              </select>
            </Field>
          ) : <p className="notice">{t.noStockSource}</p>}
        </FieldGroup>
      ) : null}
      <FieldGroup caption={t.templateCaption}>
        <FormActions hint={noSource ? t.noStockSource : null}>
          <button type="button" onClick={() => template('csv')} disabled={noSource || templateJob !== null}>{t.templateCsv}</button>
          <button type="button" onClick={() => template('xlsx')} disabled={noSource || templateJob !== null}>{t.templateXlsx}</button>
        </FormActions>
        {templateJob ? <JobProgress worldId={worldId} jobId={templateJob} onFinished={downloaded} /> : null}
      </FieldGroup>
      {canEdit ? (
        <FieldGroup>
          <Field label={t.fileLabel} caption={t.fileCaption}><FileDrop label={t.file} fileName={file ? file.name : null} disabled={busy} onChoose={(input) => void choose(input)} /></Field>
          <FormActions hint={view?.view.applyBlocked ?? why}>
            {view && !view.view.applyBlocked ? <button type="button" className="primary" onClick={apply} disabled={busy}>{t.apply}</button> : null}
            <button type="button" className={file && !view ? 'primary' : ''} onClick={() => check()} disabled={why !== null} title={why ?? undefined}>{t.check}</button>
            {view ? <button type="button" onClick={() => { setView(null); setFile(null); setMapping(null); setEncoding(null); }} disabled={busy}>{t.back}</button> : null}
          </FormActions>
        </FieldGroup>
      ) : <p className="notice">{t.noRight}</p>}
      {error ? <ErrorBox message={error} /> : null}
      {applied ? <p className="notice ok import-applied" role="status">{applied}</p> : null}
      {checkJob ? <JobProgress worldId={worldId} jobId={checkJob} onFinished={checked} /> : null}
      {applyJob ? <JobProgress worldId={worldId} jobId={applyJob} onFinished={finishedApply} /> : null}
      {view ? (
        <ImportCheck view={view.view}
          onMapping={(field, index) => { const next = { ...(mapping ?? {}), [field]: index }; setMapping(next); check({ mapping: next }); }}
          onEncoding={(chosen) => { setEncoding(chosen); setMapping(null); check({ encoding: chosen, mapping: null }); }} />
      ) : null}
      {history ? <ImportHistory view={history} /> : null}
    </section>
  );
}
