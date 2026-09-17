import { useState } from 'react';
import type { ComplianceView, DiscountCheckView, HistoryDepthView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import type { DiscountAnnounceResponse, PriceEvidenceResponse } from '../api-types.ts';
import { Badge, errorText, Gaps, Load, useMessages } from '../components.tsx';

/** Сумма из поля ввода в минимальных единицах: «19,99» и «19.99»; неверное — null */
function minorOf(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [int, frac = ''] = t.split('.');
  return Number(int) * 100 + Number(frac.padEnd(2, '0'));
}

/** Р-124: глубина видимой истории — сколько дней видим, достоверна ли проверка, и всегда — чего модуль не видит */
export function DepthLine({ depth }: { depth: HistoryDepthView }) {
  return (
    <div className="small">
      <p><Badge tone={depth.tone}>{depth.complete ? '✓' : '!'}</Badge> {depth.seen} <strong>{depth.reliability}</strong></p>
      {depth.externalChanges ? <p className="notice">{depth.externalChanges}</p> : null}
      <p className="muted">{depth.limit}</p>
    </div>
  );
}

/** Комплаенс Omnibus [Р-123, Р-124]: проверка до объявления с глубиной истории, отчёт по объявленным скидкам, доказательная история цен */
export function ComplianceScreenView({ worldId, initial }: { worldId: string; initial: ComplianceView }) {
  const m = useMessages();
  const c = m.ui.compliance;
  const [view, setView] = useState(initial);
  const [form, setForm] = useState({ writeScopeId: initial.offers[0]?.writeScopeId ?? '', reference: '', sale: '', startsAt: '', endsAt: '' });
  const [check, setCheck] = useState<DiscountCheckView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [evidence, setEvidence] = useState({ from: '', to: '', writeScopeId: '' });
  const [download, setDownload] = useState<PriceEvidenceResponse | null>(null);

  const edit = (patch: Partial<typeof form>) => { setForm({ ...form, ...patch }); setCheck(null); setConfirming(false); setMessage(null); };
  const body = () => ({
    writeScopeId: form.writeScopeId, referencePriceMinor: minorOf(form.reference), salePriceMinor: minorOf(form.sale),
    startsAt: form.startsAt ? new Date(form.startsAt).toISOString() : null, endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
  });

  const runCheck = async () => {
    setBusy(true); setError(null);
    try {
      setCheck(await requestJson<DiscountCheckView>(worldPath(worldId, 'compliance', 'check'), { method: 'POST', body: body(), locale: m.locale }));
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  const announce = async () => {
    setBusy(true); setError(null);
    try {
      const r = await requestJson<DiscountAnnounceResponse>(worldPath(worldId, 'compliance', 'announce'), { method: 'POST', body: { ...body(), confirmed: true }, locale: m.locale });
      setMessage(r.message); setView(r.compliance); setCheck(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); setConfirming(false); }
  };

  const loadEvidence = async () => {
    setBusy(true); setError(null); setDownload(null);
    try {
      const q = new URLSearchParams({ from: evidence.from, to: evidence.to, ...(evidence.writeScopeId ? { writeScopeId: evidence.writeScopeId } : {}) });
      setDownload(await requestJson<PriceEvidenceResponse>(`${worldPath(worldId, 'compliance', 'evidence')}?${q}`, { locale: m.locale }));
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  const offers = view.offers.map((o) => <option key={o.writeScopeId} value={o.writeScopeId}>{o.label}</option>);
  return (
    <section>
      <h2>{c.pageTitle}</h2>
      <p className="notice" role="note">{view.notAGuarantee}</p>
      <p className="muted">{c.intro}</p>
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <h3>{c.checkTitle}</h3>
      <div className="form">
        <label>{c.fields.offer} <select value={form.writeScopeId} onChange={(e) => edit({ writeScopeId: e.target.value })}>{offers}</select></label>
        <label>{c.fields.reference} <input inputMode="decimal" value={form.reference} onChange={(e) => edit({ reference: e.target.value })} /></label>
        <label>{c.fields.sale} <input inputMode="decimal" value={form.sale} onChange={(e) => edit({ sale: e.target.value })} /></label>
        <label>{c.fields.startsAt} <input type="datetime-local" value={form.startsAt} onChange={(e) => edit({ startsAt: e.target.value })} /></label>
        <label>{c.fields.endsAt} <input type="datetime-local" value={form.endsAt} onChange={(e) => edit({ endsAt: e.target.value })} /></label>
        <button type="button" disabled={busy} onClick={runCheck}>{busy ? c.checking : c.check}</button>
      </div>
      {check ? (
        <div className={`card ${check.verdict === 'VIOLATION' ? 'dangerous' : ''}`} role="status">
          <p><Badge tone={check.tone}>{check.verdict === 'VIOLATION' ? '✕' : check.verdict === 'COMPLIANT' ? '✓' : '?'}</Badge> <strong>{check.headline}</strong></p>
          <p className="small">{check.detail}</p>
          <p className="small muted">{c.lowest}: {check.lowest} · {check.window}</p>
          <DepthLine depth={check.depth} />
          {check.canAnnounce && !confirming ? <button type="button" disabled={busy} onClick={() => setConfirming(true)}>{c.announce}</button> : null}
          {confirming ? (
            <div className="confirm" role="dialog" aria-modal="false">
              <p>{c.announceConfirm}</p>
              <button type="button" className="danger" disabled={busy} onClick={announce}>{busy ? c.announcing : c.announce}</button>
              <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{m.ui.strategies.cancel}</button>
            </div>
          ) : null}
        </div>
      ) : null}

      <h3>{c.depth.title}</h3>
      {view.depth.length === 0 ? <p className="muted">{c.depth.none}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.depth.columns.offer}</th><th>{c.depth.columns.seen}</th><th>{c.depth.columns.reliability}</th></tr></thead>
            <tbody>
              {view.depth.map((d) => (
                <tr key={d.unit.writeScopeId}>
                  <td>{d.unit.label}</td>
                  <td>{d.depth.seen}</td>
                  <td><Badge tone={d.depth.tone}>{d.depth.complete ? '✓' : '!'}</Badge> {d.depth.reliability}{d.depth.externalChanges ? ` ${d.depth.externalChanges}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{c.reportTitle}</h3>
      <p className="headline">{view.headline}</p>
      {view.rows.length === 0 ? <p className="muted">{c.empty}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.columns.offer}</th><th>{c.columns.reference}</th><th>{c.columns.sale}</th><th>{c.columns.period}</th><th>{c.columns.atAnnouncement}</th><th>{c.columns.now}</th></tr></thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.announcementId} className={r.now.verdict === 'VIOLATION' ? 'dangerous' : ''}>
                  <td>{r.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num">{r.reference}</td>
                  <td className="num">{r.sale}</td>
                  <td className="nowrap">{r.period}</td>
                  <td><Badge tone={r.atAnnouncement.tone}>{r.atAnnouncement.verdict}</Badge> <span className="small">{r.atAnnouncement.text}</span></td>
                  <td><Badge tone={r.now.tone}>{r.now.verdict}</Badge> <span className="small">{r.now.text}</span><DepthLine depth={r.depth} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{c.evidenceTitle}</h3>
      <p className="muted small">{c.evidenceHint}</p>
      <div className="form">
        <label>{c.evidenceFrom} <input type="date" value={evidence.from} onChange={(e) => setEvidence({ ...evidence, from: e.target.value })} /></label>
        <label>{c.evidenceTo} <input type="date" value={evidence.to} onChange={(e) => setEvidence({ ...evidence, to: e.target.value })} /></label>
        <label>{c.fields.offer} <select value={evidence.writeScopeId} onChange={(e) => setEvidence({ ...evidence, writeScopeId: e.target.value })}><option value="">{c.evidenceAll}</option>{offers}</select></label>
        <button type="button" disabled={busy || !evidence.from || !evidence.to} onClick={loadEvidence}>{c.download}</button>
      </div>
      {download ? (
        <p className="small">
          <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(download.csv)}`} download={download.filename}>{download.filename}</a> · SHA-256 <code>{download.sha256}</code>
        </p>
      ) : null}

      <h3>{c.cannotCheckTitle}</h3>
      <ul className="small">{view.cannotCheck.map((t) => <li key={t}>{t}</li>)}</ul>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function ComplianceScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<ComplianceView>(worldPath(worldId, 'compliance'), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <ComplianceScreenView key={view.worldId} worldId={worldId} initial={view} />}</Load>;
}
