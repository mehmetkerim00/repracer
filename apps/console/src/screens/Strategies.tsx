import { useState } from 'react';
import type { StrategyListView, StrategyPreviewView } from '@repracer/console-model';
import type { StrategySaveResponse } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, Load, ReasonLine, useMessages } from '../components.tsx';

/**
 * Экран стратегий (шаг 21): черновик → превью на выбранных офферах (движок и Gate на последнем принятом снимке, без фиксации) →
 * сохранение того же превью. Сервер пересчитывает превью и отказывает, если итог изменился.
 */

export interface DraftForm {
  name: string;
  type: 'FIXED' | 'TARGET_MARGIN' | 'MATCH_BUYBOX' | 'BEAT_LOWEST';
  priceMinor: string;
  targetMarginBp: string;
  undercutMinor: string;
  deadbandMinor: string;
  holdWhenWinning: boolean;
  atBound: 'CAP' | 'HOLD';
  scope: 'VISIBLE_TOP_N' | 'MARKET';
  compareLanded: boolean;
}

const int = (v: string): number | string => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : v);

export function draftOf(f: DraftForm): unknown {
  const params = f.type === 'FIXED' ? { type: f.type, priceMinor: int(f.priceMinor) }
    : f.type === 'TARGET_MARGIN' ? { type: f.type, targetMarginBp: int(f.targetMarginBp) }
      : f.type === 'MATCH_BUYBOX' ? { type: f.type, undercutMinor: int(f.undercutMinor), holdWhenWinning: f.holdWhenWinning, atBound: f.atBound }
        : { type: f.type, undercutMinor: int(f.undercutMinor), scope: f.scope, compareLanded: f.compareLanded, atBound: f.atBound };
  return { name: f.name, params, deadbandMinor: int(f.deadbandMinor) };
}

export function PreviewTable({ view }: { view: StrategyPreviewView }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const c = t.columns;
  return (
    <section className="preview">
      <h3>{view.draft.title}</h3>
      <p className="muted small">{view.draft.detail}</p>
      <p className="headline">{view.headline}</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{c.offer}</th><th>{c.asOf}</th><th>{c.current}</th><th>{c.proposed}</th><th>{c.final}</th><th>{c.change}</th><th>{c.outcome}</th><th>{c.reason}</th></tr></thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.unit.writeScopeId} className={r.dangerous ? 'dangerous' : ''}>
                <td>{r.unit.label}</td>
                <td className="small nowrap">{r.asOf}</td>
                <td className="num">{r.current}</td>
                <td className="num">{r.proposed ?? '–'}</td>
                <td className="num">{r.final ?? '–'}</td>
                <td className="num">{r.change ?? '–'}</td>
                <td><Badge tone={r.tone}>{r.outcome}</Badge>{r.dangerous ? <div className="small"><Badge tone="stop">{t.dangerous}</Badge></div> : null}</td>
                <td>{r.reason ? <ReasonLine reason={r.reason} /> : null}{r.unavailable ? <div className="gap-note small">{r.unavailable}</div> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function StrategiesScreenView({ view, worldId }: { view: StrategyListView; worldId: string }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const [form, setForm] = useState<DraftForm>({ name: '', type: 'MATCH_BUYBOX', priceMinor: '', targetMarginBp: '2000', undercutMinor: '5', deadbandMinor: '0', holdWhenWinning: true, atBound: 'CAP', scope: 'VISIBLE_TOP_N', compareLanded: false });
  const [selected, setSelected] = useState<string[]>(() => view.scopes.map((s) => s.unit.writeScopeId));
  const [preview, setPreview] = useState<StrategyPreviewView | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => { setForm({ ...form, [key]: value }); setPreview(null); };

  const run = async () => {
    setBusy(true); setError(null); setMessage(null);
    try {
      setPreview(await requestJson<StrategyPreviewView>(worldPath(worldId, 'strategies', 'preview'), { method: 'POST', body: { draft: draftOf(form), writeScopeIds: selected }, locale: m.locale }));
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      const r = await requestJson<StrategySaveResponse>(worldPath(worldId, 'strategies'), {
        method: 'POST', body: { draft: draftOf(form), writeScopeIds: selected, strategyId: null, previewToken: preview.previewToken, confirmed: true }, locale: m.locale,
      });
      setMessage(r.message); setPreview(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  return (
    <section>
      <h2>{t.pageTitle}</h2>
      <h3>{t.inUse}</h3>
      <ul className="index">
        {view.strategies.map((s) => <li key={`${s.strategyId}@${s.version}`}><strong>{s.label}</strong> <span className="small muted">{s.detail}</span> · {s.scopes.map((u) => u.label).join(', ')}</li>)}
      </ul>
      <h3>{t.draftTitle}</h3>
      {!view.canEdit ? <p className="notice">{t.noRight}</p> : null}
      <div className="form">
        <label>{t.name} <input value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} /></label>
        <label>{t.type} <select value={form.type} onChange={(e) => set('type', e.target.value as DraftForm['type'])}>
          {(Object.keys(t.types) as Array<keyof typeof t.types>).map((k) => <option key={k} value={k}>{t.types[k]}</option>)}
        </select></label>
        {form.type === 'FIXED' ? <label>{t.fields.priceMinor} <input inputMode="numeric" value={form.priceMinor} onChange={(e) => set('priceMinor', e.target.value)} /></label> : null}
        {form.type === 'TARGET_MARGIN' ? <label>{t.fields.targetMarginBp} <input inputMode="numeric" value={form.targetMarginBp} onChange={(e) => set('targetMarginBp', e.target.value)} /></label> : null}
        {form.type === 'MATCH_BUYBOX' || form.type === 'BEAT_LOWEST' ? (
          <>
            <label>{t.fields.undercutMinor} <input inputMode="numeric" value={form.undercutMinor} onChange={(e) => set('undercutMinor', e.target.value)} /></label>
            <label>{t.fields.atBound} <select value={form.atBound} onChange={(e) => set('atBound', e.target.value as DraftForm['atBound'])}>
              <option value="CAP">{t.atBound.CAP}</option><option value="HOLD">{t.atBound.HOLD}</option>
            </select></label>
          </>
        ) : null}
        {form.type === 'MATCH_BUYBOX' ? <label><input type="checkbox" checked={form.holdWhenWinning} onChange={(e) => set('holdWhenWinning', e.target.checked)} /> {t.fields.holdWhenWinning}</label> : null}
        {form.type === 'BEAT_LOWEST' ? (
          <>
            <label>{t.fields.scope} <select value={form.scope} onChange={(e) => set('scope', e.target.value as DraftForm['scope'])}>
              <option value="VISIBLE_TOP_N">{t.scopes.VISIBLE_TOP_N}</option><option value="MARKET">{t.scopes.MARKET}</option>
            </select></label>
            <label><input type="checkbox" checked={form.compareLanded} onChange={(e) => set('compareLanded', e.target.checked)} /> {t.fields.compareLanded}</label>
          </>
        ) : null}
        <label>{t.fields.deadbandMinor} <input inputMode="numeric" value={form.deadbandMinor} onChange={(e) => set('deadbandMinor', e.target.value)} /></label>
      </div>
      <h4>{t.pick}</h4>
      <ul className="index">
        {view.scopes.map((s) => (
          <li key={s.unit.writeScopeId}>
            <label><input type="checkbox" checked={selected.includes(s.unit.writeScopeId)}
              onChange={(e) => { setSelected(e.target.checked ? [...selected, s.unit.writeScopeId] : selected.filter((x) => x !== s.unit.writeScopeId)); setPreview(null); }} /> {s.unit.label}</label>
            <span className="small muted"> · {s.strategy} · {s.mode}</span>
          </li>
        ))}
      </ul>
      <div className="buttons">
        <button type="button" disabled={busy || selected.length === 0} onClick={() => void run()}>{t.preview}</button>
        {view.canEdit ? <button type="button" className="danger" disabled={busy || !preview} onClick={() => void save()}>{t.save}</button> : null}
      </div>
      <p className="small muted">{t.saveHint}</p>
      {error ? <ErrorBox message={error} /> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {preview ? <PreviewTable view={preview} /> : null}
    </section>
  );
}

export function StrategiesScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<StrategyListView>(worldPath(worldId, 'strategies'), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <StrategiesScreenView view={view} worldId={worldId} />}</Load>;
}
