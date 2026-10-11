import { useState } from 'react';
import type { CostImportView } from '@repracer/console-model';
import type { BoundsIndexView } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import type { JobCreatedResponse } from '../api-types.ts';
import { JobProgress } from './Jobs.tsx';
import { ErrorBox, errorText, FileDrop, Load, useMessages } from '../components.tsx';

/**
 * Р-134 (шаг 28): экран массового импорта себестоимости. Продавец видит предпросмотр ДО применения — что применится, что не
 * сопоставилось и почему, и сколько офферов останутся без себестоимости (а значит, без репрайсинга, Р-131). Применение — целиком и
 * со вторым фактором [Р-135]: отдельной кнопки «применить, что получилось» нет.
 */


/**
 * Ревью шага 28, находка 7: `btoa(String.fromCharCode(...bytes))` раскладывает весь файл в аргументы вызова, и браузер на файле в
 * сотни килобайт падает `RangeError` ещё до отправки. Кодируем частями — ровно то, ради чего импорт и существует.
 */
function base64Of(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

export function CostImportPreview({ view, onMapping, onEncoding }: {
  view: CostImportView; onMapping?: (field: string, index: number | null) => void; onEncoding?: (encoding: string) => void;
}) {
  const m = useMessages();
  const t = m.ui.costImport;
  return (
    <section className={`import-preview ${view.tone}`}>
      {/* Шаг 79: предпросмотр — карточками: сводка и источник, выбор колонок, строки, пропущенное */}
      <div className="card summary-card">
      <p className="headline">{view.headline}</p>
      <p className="source">{t.sourceRead(view.source.format, view.source.delimiter)} · {view.source.name}</p>
      {view.source.encoding ? (
        <p className={`source ${view.source.encodingConfident ? '' : 'warn'}`}>
          {/* Шаг 79 (ревью): уверенно прочитанная кодировка — подписью у выбора, а не «UTF-8 [UTF-8 ▾]» дважды */}
          {onEncoding && view.source.encodingConfident ? null : t.encodingRead(view.source.encoding, view.source.encodingConfident)}
          {onEncoding ? (
            <label>{view.source.encodingConfident ? t.encodingLabel : null}{' '}
              <select value={view.source.encoding} onChange={(e) => onEncoding(e.currentTarget.value)}>
                {view.encodings.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
            </label>
          ) : null}
        </p>
      ) : null}
      {view.blocked ? <p className="notice warn">{view.blocked}</p> : null}
      </div>
      {view.columns.length > 0 || onMapping ? <div className="card">
      {view.columns.length > 0 ? (
        <>
          <h4>{t.columnsTitle}</h4>
          <ul className="columns">
            {view.columns.map((c) => <li key={c.field}>{c.field}: {c.column} — {c.reason}</li>)}
          </ul>
        </>
      ) : null}
      {onMapping ? (
        <ul className="column-choice">
          {view.fields.map((f) => (
            <li key={f.field}>
              <label>
                {f.label}{f.required ? ' *' : ''}
                <select
                  value={f.columnIndex === null ? '' : String(f.columnIndex)}
                  onChange={(e) => onMapping(f.field, e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
                >
                  <option value="">{m.ui.common.noValue}</option>
                  {view.fileColumns.map((c) => (
                    <option key={c.index} value={String(c.index)}>{t.columnOption(c.name, c.header, c.sample)}</option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      </div> : null}
      {view.rows.length > 0 ? (
        <>
          <div className="table-wrap">
          <div className="table-head"><strong>{t.rowsTitle(view.rows.length, view.summary.apply)}</strong></div>
          <table>
            <thead>
              <tr><th className="num">{t.columns.line}</th><th>{t.columns.offer}</th><th>{t.columns.key}</th><th className="num">{t.columns.cost}</th><th className="num">{t.columns.fee}</th></tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.line}>
                  <td className="num">{r.line}</td>
                  <td className="offer">{r.unit ? r.unit.label : m.ui.common.noValue}</td>
                  <td>{r.offerKey}</td>
                  <td className="num money">{r.cost}</td>
                  <td className="num">{r.fee ?? m.ui.common.noValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </>
      ) : null}
      {view.skipped.length > 0 ? (
        <div className="card">
          <h4>{t.skippedTitle}</h4>
          <ul className="skipped">
            {view.skipped.map((g) => (
              <li key={g.problem}>
                <strong>{g.rows}</strong> — {g.text}
                <ul>{g.examples.map((e) => <li key={e.line}>{t.skippedExample(e.line, e.offerKey, e.raw)}</li>)}</ul>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {view.stillWithoutCost > 0 ? <p className="notice">{t.stillWithoutCost(view.stillWithoutCost)}</p> : null}
      <p className="notice">{t.allOrNothing}</p>
      <p className="notice">{t.mfa}</p>
      <ul className="gaps">{view.gaps.map((g) => <li key={g.code}>{g.what}: {g.why}</li>)}</ul>
    </section>
  );
}

export function CostImportPanel({ worldId, canEdit, asPage = false }: { worldId: string; canEdit: boolean; asPage?: boolean }) {
  const m = useMessages();
  const t = m.ui.costImport;
  if (!canEdit) return <section className="cost-import">{asPage ? <h2>{t.pageTitle}</h2> : <h3>{t.pageTitle}</h3>}<p className="notice">{t.noRight}</p></section>;
  return <CostImportForm worldId={worldId} asPage={asPage} />;
}

function CostImportForm({ worldId, asPage }: { worldId: string; asPage: boolean }) {
  const m = useMessages();
  const t = m.ui.costImport;
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  // Шаг 79: сервер ждёт имя файла полем `fileName`; страница слала `name`, и предпросмотр, задание и отчёт звали любой файл «import»
  const wire = (f: { name: string; content: string }) => ({ fileName: f.name, content: f.content });
  const [view, setView] = useState<CostImportView | null>(null);
  // Ревью шага 28, находка 8: выбор продавца сильнее подсказки — он уходит на сервер и предпросмотр строится заново
  const [mapping, setMapping] = useState<Record<string, number | null> | null>(null);
  // OQ-200: кодировку выбирает продавец, если наша догадка не подошла — предпросмотр строится заново
  const [encoding, setEncoding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async (input: HTMLInputElement) => {
    const picked = input.files?.[0];
    setError(null); setMessage(null); setView(null); setMapping(null); setEncoding(null);
    if (!picked) return setFile(null);
    const buffer = await picked.arrayBuffer();
    // Файл уходит на сервер как есть: формат определяется по содержимому, а не по расширению
    setFile({ name: picked.name, content: base64Of(new Uint8Array(buffer)) });
  };
  const plan = async (override?: { mapping?: Record<string, number | null> | null; encoding?: string | null }) => {
    if (!file) return;
    setBusy(true); setError(null); setMessage(null);
    const chosenMapping = override?.mapping === undefined ? mapping : override.mapping;
    const chosenEncoding = override?.encoding === undefined ? encoding : override.encoding;
    try {
      setView(await requestJson<CostImportView>(worldPath(worldId, 'cost-import', 'plan'),
        { method: 'POST', body: { ...wire(file), ...(chosenMapping ? { mapping: chosenMapping } : {}), ...(chosenEncoding ? { encoding: chosenEncoding } : {}) }, locale: m.locale }));
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const changeMapping = (field: string, index: number | null) => {
    const next = { ...(mapping ?? {}), [field]: index };
    setMapping(next);
    void plan({ mapping: next });
  };
  const changeEncoding = (chosen: string) => {
    // Смена кодировки меняет и текст заголовков, поэтому сопоставление колонок предлагается заново
    setEncoding(chosen); setMapping(null);
    void plan({ encoding: chosen, mapping: null });
  };
  const apply = async () => {
    if (!file || !view) return;
    setBusy(true); setError(null);
    try {
      // Р-139: применение идёт фоновым заданием — дальше продавец смотрит на ход, а файл в браузере больше не нужен
      const r = await requestJson<JobCreatedResponse>(worldPath(worldId, 'cost-import', 'apply'),
        { method: 'POST', body: { ...wire(file), ...(mapping ? { mapping } : {}), ...(encoding ? { encoding } : {}), fingerprint: view.fingerprint, confirmed: true }, locale: m.locale });
      setMessage(r.message); setJobId(r.jobId); setView(null); setFile(null); setMapping(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  return (
    <section className="cost-import">
      {/* Шаг 79: на своём экране — заголовок страницы, внутри онбординга — заголовок раздела */}
      {asPage ? <h2>{t.pageTitle}</h2> : <h3>{t.pageTitle}</h3>}
      <p className="subtitle">{m.ui.app.subtitles['cost-import']}</p>
      {error ? <ErrorBox message={error} /> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {jobId ? <JobProgress worldId={worldId} jobId={jobId} /> : null}
      <FileDrop label={t.file} fileName={file ? file.name : null} disabled={busy} onChoose={(input) => void choose(input)} />
      <div className="buttons">
        <button type="button" className={file && !view ? 'primary' : ''} onClick={() => void plan()} disabled={busy || !file}>{t.plan}</button>
        {view && !view.blocked && view.summary.apply > 0
          ? <button type="button" className="primary" onClick={() => void apply()} disabled={busy}>{t.apply}</button>
          : null}
        {view ? <button type="button" onClick={() => { setView(null); setFile(null); setMapping(null); }} disabled={busy}>{t.back}</button> : null}
      </div>
      {view ? <CostImportPreview view={view} onMapping={changeMapping} onEncoding={changeEncoding} /> : null}
    </section>
  );
}

/** Экран целиком: право на импорт — то же, что на правку границ (менеджер цен); его сообщает сервер вместе с данными экрана */
export function CostImportScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<BoundsIndexView>(worldPath(worldId, 'bounds'), m.locale);
  return (
    <Load shape="cards" resource={resource} retry={retry}>
      {(view) => <CostImportPanel worldId={worldId} canEdit={view.canEdit} asPage />}
    </Load>
  );
}
