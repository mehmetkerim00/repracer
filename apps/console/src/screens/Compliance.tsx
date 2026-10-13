import { useState } from 'react';
import { LIST_PAGE_DEFAULT, type ComplianceView, type DiscountCheckView, type HistoryDepthView, type ListQuery } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import type { DiscountAnnounceResponse, JobCreatedResponse } from '../api-types.ts';
import { Badge, errorText, Gaps, Load, OfferPicker, Pager, useMessages, Intro, DateTimeField } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

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
      {/* Шаг 79: глубина истории — пилюлей со словом, а не значком «!» */}
      <p><Badge tone={depth.tone}>{depth.short}</Badge> {depth.seen} {depth.reliability}</p>
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
  /** OQ-202: файл готовит фоновое задание — экран показывает его ход и ссылку на готовое [Р-139] */
  const [evidenceJobId, setEvidenceJobId] = useState<string | null>(null);

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
    setBusy(true); setError(null); setEvidenceJobId(null);
    try {
      const r = await requestJson<JobCreatedResponse>(worldPath(worldId, 'compliance', 'evidence'), {
        method: 'POST',
        body: { from: evidence.from, to: evidence.to, ...(evidence.writeScopeId ? { writeScopeId: evidence.writeScopeId } : {}) },
        locale: m.locale,
      });
      setMessage(r.message); setEvidenceJobId(r.jobId);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  // Р-136 (ревью шага 29, находка 4): предложение выбирается поиском — их десять тысяч, список показывает первые
  return (
    <section>
      {/* Шаг 86: заголовок страницы — тот же текст, что пункт меню */}
      <h2>{m.ui.app.screens.compliance}</h2>
      <Intro text={c.intro} />
      <p className="notice" role="note">{view.notAGuarantee}</p>
      {message ? <p className="notice">{message}</p> : null}
      {error ? <p className="error">{error}</p> : null}

      <h3>{c.checkTitle}</h3>
      {/* Шаг 79: формы — карточками-панелями, итог отчёта — в шапке таблицы, «что не проверяется» — карточкой */}
      <div className="form toolbar">
        <label>{c.fields.offer} <OfferPicker worldId={worldId} value={form.writeScopeId} onChange={(writeScopeId) => edit({ writeScopeId })} /></label>
        <label>{c.fields.reference} <input inputMode="decimal" value={form.reference} onChange={(e) => edit({ reference: e.target.value })} /></label>
        <label>{c.fields.sale} <input inputMode="decimal" value={form.sale} onChange={(e) => edit({ sale: e.target.value })} /></label>
        <label>{c.fields.startsAt} <DateTimeField value={form.startsAt} onChange={(startsAt) => edit({ startsAt })} /></label>
        <label>{c.fields.endsAt} <DateTimeField value={form.endsAt} onChange={(endsAt) => edit({ endsAt })} /></label>
        <button type="button" className="primary" disabled={busy} onClick={runCheck}>{busy ? c.checking : c.check}</button>
      </div>
      {check ? (
        <div className={`card ${check.verdict === 'VIOLATION' ? 'dangerous' : ''}`} role="status">
          {/* Шаг 79: итог проверки — словом на пилюле; «соответствует» не пишем — модуль соответствия не гарантирует [Р-124] */}
          <p><Badge tone={check.tone}>{c.verdicts[check.verdict]}</Badge> <strong>{check.headline}</strong></p>
          <p className="small">{check.detail}</p>
          <p className="small muted">{c.lowest}: {check.lowest} · {check.window}</p>
          <DepthLine depth={check.depth} />
          {check.canAnnounce && !confirming ? <button type="button" disabled={busy} onClick={() => setConfirming(true)}>{c.announce}</button> : null}
          {confirming ? (
            <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="announce-title">
              <h3 id="announce-title">{c.announceTitle}</h3>
              <p>{c.announceConfirm}</p>
              <div className="buttons">
                <button type="button" className="primary" disabled={busy} onClick={announce}>{busy ? c.announcing : c.announce}</button>
                <button type="button" disabled={busy} onClick={() => setConfirming(false)}>{m.ui.strategies.cancel}</button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <h3>{c.depth.title}</h3>
      {view.depth.length === 0 ? <p className="muted empty">{c.depth.none}</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>{c.depth.columns.offer}</th><th>{c.depth.columns.seen}</th><th>{c.depth.columns.reliability}</th></tr></thead>
            <tbody>
              {view.depth.map((d) => (
                <tr key={d.unit.writeScopeId}>
                  <td className="offer">{d.unit.label}</td>
                  <td className="nowrap">{d.depth.seen}</td>
                  <td><Badge tone={d.depth.tone}>{d.depth.short}</Badge><div className="note">{d.depth.reliability}</div>{d.depth.externalChanges ? <div className="note">{d.depth.externalChanges}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3>{c.reportTitle}</h3>
      {view.rows.length === 0 ? <p className="muted empty">{view.headline} · {c.empty}</p> : (
        <div className="table-wrap">
          <div className="table-head"><strong>{view.headline}</strong></div>
          <table>
            <thead><tr><th>{c.columns.offer}</th><th>{c.columns.reference}</th><th>{c.columns.sale}</th><th>{c.columns.period}</th><th>{c.columns.atAnnouncement}</th><th>{c.columns.now}</th></tr></thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.announcementId} className={r.now.verdict === 'VIOLATION' ? 'dangerous' : ''}>
                  <td>{r.unit?.label ?? m.ui.common.noValue}</td>
                  <td className="num cur">{r.reference}</td>
                  <td className="num cur">{r.sale}</td>
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
      {/* OQ-202 (шаг 30): каталог целиком выгружается тоже — файл готовит задание, а не ответ экрана */}
      <p className="section-sub">{c.evidenceByOffer(view.offersTotal)} {c.evidenceHint}</p>
      <div className="form toolbar">
        <label>{c.evidenceFrom} <DateTimeField withTime={false} value={evidence.from} onChange={(from) => setEvidence({ ...evidence, from })} /></label>
        <label>{c.evidenceTo} <DateTimeField withTime={false} value={evidence.to} onChange={(to) => setEvidence({ ...evidence, to })} /></label>
        <label>{c.fields.offer} <OfferPicker worldId={worldId} value={evidence.writeScopeId} allowEmpty emptyLabel={c.evidenceAll}
          onChange={(writeScopeId) => setEvidence({ ...evidence, writeScopeId })} /></label>
        <button type="button" disabled={busy || !evidence.from || !evidence.to} onClick={loadEvidence}>{c.download}</button>
      </div>
      {evidenceJobId ? <JobProgress worldId={worldId} jobId={evidenceJobId} /> : null}

      <section className="card">
        <h3>{c.cannotCheckTitle}</h3>
        <ul className="small">{view.cannotCheck.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function ComplianceScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  // Р-136: глубина истории считается только у показанных предложений — раньше экран спрашивал базу по разу на каждое
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<ComplianceView>(`${worldPath(worldId, 'compliance')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
  return (
    <Load shape="table" resource={resource} retry={retry}>
      {(view) => (
        <>
          <ComplianceScreenView key={`${view.worldId}:${query.offset}`} worldId={worldId} initial={view} />
          <Pager page={view.page} query={query} onQuery={setQuery} />
        </>
      )}
    </Load>
  );
}
