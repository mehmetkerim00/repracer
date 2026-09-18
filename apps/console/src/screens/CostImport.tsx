import { useState } from 'react';
import type { CostImportView } from '@repracer/console-model';
import type { BoundsIndexView } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { ErrorBox, errorText, Load, useMessages } from '../components.tsx';

/**
 * Р-134 (шаг 28): экран массового импорта себестоимости. Продавец видит предпросмотр ДО применения — что применится, что не
 * сопоставилось и почему, и сколько офферов останутся без себестоимости (а значит, без репрайсинга, Р-131). Применение — целиком и
 * со вторым фактором [Р-135]: отдельной кнопки «применить, что получилось» нет.
 */

export interface CostImportApplied { message: string; rows: number; offers: number }

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
      <p className="headline">{view.headline}</p>
      <p className="source">{t.sourceRead(view.source.format, view.source.delimiter)} · {view.source.name}</p>
      {view.source.encoding ? (
        <p className={`source ${view.source.encodingConfident ? '' : 'warn'}`}>
          {t.encodingRead(view.source.encoding, view.source.encodingConfident)}
          {onEncoding ? (
            <select value={view.source.encoding} onChange={(e) => onEncoding(e.currentTarget.value)}>
              {view.encodings.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          ) : null}
        </p>
      ) : null}
      {view.blocked ? <p className="notice warn">{view.blocked}</p> : null}
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
      {view.rows.length > 0 ? (
        <>
          <h4>{t.rowsTitle(view.rows.length, view.summary.apply)}</h4>
          <table>
            <thead>
              <tr><th>{t.columns.line}</th><th>{t.columns.offer}</th><th>{t.columns.key}</th><th>{t.columns.cost}</th><th>{t.columns.fee}</th></tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.line}>
                  <td>{r.line}</td>
                  <td>{r.unit ? r.unit.label : m.ui.common.noValue}</td>
                  <td>{r.offerKey}</td>
                  <td>{r.cost}</td>
                  <td>{r.fee ?? m.ui.common.noValue}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {view.skipped.length > 0 ? (
        <>
          <h4>{t.skippedTitle}</h4>
          <ul className="skipped">
            {view.skipped.map((g) => (
              <li key={g.problem}>
                <strong>{g.rows}</strong> — {g.text}
                <ul>{g.examples.map((e) => <li key={e.line}>{t.skippedExample(e.line, e.offerKey, e.raw)}</li>)}</ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {view.stillWithoutCost > 0 ? <p className="notice">{t.stillWithoutCost(view.stillWithoutCost)}</p> : null}
      <p className="notice">{t.allOrNothing}</p>
      <p className="notice">{t.mfa}</p>
      <ul className="gaps">{view.gaps.map((g) => <li key={g.code}>{g.what}: {g.why}</li>)}</ul>
    </section>
  );
}

export function CostImportPanel({ worldId, canEdit }: { worldId: string; canEdit: boolean }) {
  const m = useMessages();
  const t = m.ui.costImport;
  if (!canEdit) return <section className="cost-import"><h3>{t.pageTitle}</h3><p className="notice">{t.noRight}</p></section>;
  return <CostImportForm worldId={worldId} />;
}

function CostImportForm({ worldId }: { worldId: string }) {
  const m = useMessages();
  const t = m.ui.costImport;
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [view, setView] = useState<CostImportView | null>(null);
  // Ревью шага 28, находка 8: выбор продавца сильнее подсказки — он уходит на сервер и предпросмотр строится заново
  const [mapping, setMapping] = useState<Record<string, number | null> | null>(null);
  // OQ-200: кодировку выбирает продавец, если наша догадка не подошла — предпросмотр строится заново
  const [encoding, setEncoding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
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
        { method: 'POST', body: { ...file, ...(chosenMapping ? { mapping: chosenMapping } : {}), ...(chosenEncoding ? { encoding: chosenEncoding } : {}) }, locale: m.locale }));
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
      const r = await requestJson<CostImportApplied>(worldPath(worldId, 'cost-import', 'apply'),
        { method: 'POST', body: { ...file, ...(mapping ? { mapping } : {}), ...(encoding ? { encoding } : {}), fingerprint: view.fingerprint, confirmed: true }, locale: m.locale });
      setMessage(r.message); setView(null); setFile(null); setMapping(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  return (
    <section className="cost-import">
      <h3>{t.pageTitle}</h3>
      {error ? <ErrorBox message={error} /> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      <label>
        {t.file}
        <input type="file" accept=".csv,.xlsx,text/csv" onChange={(e) => void choose(e.currentTarget)} disabled={busy} />
      </label>
      <div className="buttons">
        <button type="button" onClick={() => void plan()} disabled={busy || !file}>{t.plan}</button>
        {view && !view.blocked && view.summary.apply > 0
          ? <button type="button" className="danger" onClick={() => void apply()} disabled={busy}>{t.apply}</button>
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
    <Load resource={resource} retry={retry}>
      {(view) => <CostImportPanel worldId={worldId} canEdit={view.canEdit} />}
    </Load>
  );
}
