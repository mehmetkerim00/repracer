import { useState } from 'react';
import { parseAmountInput, parsePercentInput, type BoundAdjust, type BoundsDiffView, type BoundsEditRequest } from '@repracer/console-model';
import type { BoundsIndexItem, JobCreatedResponse } from '../api-types.ts';
import { requestJson, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, useMessages } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

/**
 * Массовая правка границ (шаги 21, 23): запрос → экран различий → применение с токеном этого экрана. Кнопки «применить» без экрана
 * различий нет; изменился запрос — экран сбрасывается. Сумма вводится в основных единицах, изменение — в процентах; без права
 * MANAGE_PRICING панели правки нет.
 */

type AdjustForm = { mode: 'KEEP' | 'SET' | 'PERCENT'; value: string };

/** undefined — без изменения; null — ввод не разобран */
export function adjustOf(f: AdjustForm): BoundAdjust | undefined | null {
  if (f.mode === 'KEEP') return undefined;
  if (f.mode === 'SET') {
    const minor = parseAmountInput(f.value);
    return minor === null ? null : { kind: 'SET', minor };
  }
  const bp = parsePercentInput(f.value);
  return bp === null ? null : { kind: 'PERCENT', bp };
}

export function BoundsDiffTable({ view }: { view: BoundsDiffView }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  const c = t.columns;
  return (
    <section className="diff">
      <p className="headline">{view.headline}</p>
      {view.mfaRequired ? <p className="notice">{t.mfa}</p> : null}
      <div className="table-wrap">
        <table>
          <thead><tr><th>{c.offer}</th><th>{c.minBefore}</th><th>{c.minAfter}</th><th>{c.maxBefore}</th><th>{c.maxAfter}</th><th>{c.price}</th><th>{c.notes}</th></tr></thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.unit.writeScopeId}>
                <td><Badge tone={r.tone}>{r.unit.label}</Badge></td>
                <td className="num">{r.minBefore}</td>
                <td className="num">{r.minAfter}{r.minChange ? <div className="small muted">{r.minChange}</div> : null}</td>
                <td className="num">{r.maxBefore}</td>
                <td className="num">{r.maxAfter}{r.maxChange ? <div className="small muted">{r.maxChange}</div> : null}</td>
                <td className="num">{r.currentPrice}</td>
                <td>{r.flags.length === 0 ? '–' : <ul className="small">{r.flags.map((f) => <li key={f.code}>{f.text}</li>)}</ul>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function BoundsEditPanel({ worldId, items, total, canEdit }: { worldId: string; items: readonly BoundsIndexItem[]; total: number; canEdit: boolean }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  if (!canEdit) return <section className="bounds-edit"><h3>{t.pageTitle}</h3><p className="notice">{t.noRight}</p></section>;
  return <BoundsEditForm worldId={worldId} items={items} total={total} />;
}

function BoundsEditForm({ worldId, items, total }: { worldId: string; items: readonly BoundsIndexItem[]; total: number }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  const [selected, setSelected] = useState<string[]>([]);
  const [min, setMin] = useState<AdjustForm>({ mode: 'KEEP', value: '' });
  const [max, setMax] = useState<AdjustForm>({ mode: 'KEEP', value: '' });
  const [diff, setDiff] = useState<{ view: BoundsDiffView; request: BoundsEditRequest } | null>(null);
  const [wholeCatalog, setWholeCatalog] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Р-139: применение идёт фоновым заданием — экран показывает его ход, а не ждёт ответа */
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setDiff(null); setMessage(null); setJobId(null); };

  const request = (): BoundsEditRequest | string => {
    const a = adjustOf(min);
    const b = adjustOf(max);
    if (a === null) return t.badInput(min.value);
    if (b === null) return t.badInput(max.value);
    // Р-136: «весь каталог» — это выбор, а не перечисление; список из 10 000 идентификаторов не проходит предел тела запроса
    return { ...(wholeCatalog ? { all: true, writeScopeIds: [] } : { writeScopeIds: selected }), ...(a ? { min: a } : {}), ...(b ? { max: b } : {}) };
  };
  const plan = async () => {
    setError(null); setMessage(null);
    const r = request();
    if (typeof r === 'string') return setError(r);
    setBusy(true);
    try {
      setDiff({ view: await requestJson<BoundsDiffView>(worldPath(worldId, 'bounds', 'plan'), { method: 'POST', body: { request: r }, locale: m.locale }), request: r });
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!diff) return;
    setBusy(true); setError(null);
    try {
      const r = await requestJson<JobCreatedResponse>(worldPath(worldId, 'bounds', 'apply'), { method: 'POST', body: { request: diff.request, planToken: diff.view.planToken, confirmed: true }, locale: m.locale });
      setMessage(r.message); setJobId(r.jobId); setDiff(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const adjust = (label: string, value: AdjustForm, onChange: (v: AdjustForm) => void) => (
    <label>{label}{' '}
      <select value={value.mode} onChange={(e) => { onChange({ ...value, mode: e.target.value as AdjustForm['mode'] }); reset(); }}>
        <option value="KEEP">{t.keep}</option><option value="SET">{t.set}</option><option value="PERCENT">{t.percent}</option>
      </select>
      {value.mode !== 'KEEP' ? <input inputMode="decimal" value={value.value} onChange={(e) => { onChange({ ...value, value: e.target.value }); reset(); }} /> : null}
    </label>
  );

  return (
    <section className="bounds-edit">
      <h3>{t.pageTitle}</h3>
      <h4>{t.select}</h4>
      <div className="buttons">
        <button type="button" disabled={busy} onClick={() => { setWholeCatalog(false); setSelected(items.map((i) => i.writeScopeId)); reset(); }}>{t.selectPage(items.length)}</button>
        <button type="button" disabled={busy} onClick={() => { setWholeCatalog(false); setSelected([]); reset(); }}>{t.selectNone}</button>
      </div>
      {/* Р-136: выбрать весь каталог, а не показанную страницу — раскрывает выбор сервер */}
      <label className="whole-catalog">
        <input type="checkbox" checked={wholeCatalog} disabled={busy}
          onChange={(e) => { setWholeCatalog(e.target.checked); setSelected([]); reset(); }} /> {t.selectAllCatalog(total)}
      </label>
      <ul className="index">
        {items.map((i) => (
          <li key={i.writeScopeId}><label><input type="checkbox" checked={selected.includes(i.writeScopeId)}
            onChange={(e) => { setSelected(e.target.checked ? [...selected, i.writeScopeId] : selected.filter((x) => x !== i.writeScopeId)); reset(); }} /> {i.label}</label>
            <span className="muted small"> {i.minPrice} – {i.maxPrice}</span></li>
        ))}
      </ul>
      <div className="form">{adjust(t.minPrice, min, setMin)}{adjust(t.maxPrice, max, setMax)}</div>
      <div className="buttons">
        {diff === null
          ? <button type="button" disabled={busy || (selected.length === 0 && !wholeCatalog)} onClick={() => void plan()}>{t.plan}</button>
          : <><button type="button" className="danger" disabled={busy} onClick={() => void apply()}>{t.apply}</button><button type="button" disabled={busy} onClick={reset}>{t.back}</button></>}
      </div>
      {diff ? <p className="small muted">{t.shownRows(diff.view.shown.rows, diff.view.shown.of)}</p> : null}
      {error ? <ErrorBox message={error} /> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {jobId ? <JobProgress worldId={worldId} jobId={jobId} /> : null}
      {diff ? <BoundsDiffTable view={diff.view} /> : null}
    </section>
  );
}
