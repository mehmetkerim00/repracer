import { useState } from 'react';
import { LIST_PAGE_DEFAULT, parseAmountInput, parsePercentInput, type ListQuery, type StrategyDraft, type StrategyListItem, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import type { JobCreatedResponse, StrategySaveResponse } from '../api-types.ts';
import type { BulkJobView } from '@repracer/console-model';
import { JobProgress } from './Jobs.tsx';
import { ApiError, requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, href, Load, Pager, ReasonLine, useMessages } from '../components.tsx';

/**
 * Экран стратегий (шаги 21, 23): черновик или новая версия существующей стратегии → превью на выбранных офферах (движок и Gate на
 * последнем принятом снимке, без фиксации) → подтверждение → сохранение того же превью. Сервер пересчитывает превью и отказывает,
 * если итог изменился; тогда экран сам строит превью заново. Офферы, которые канал бепреисывает сам [Р-120], не выбираются.
 */

export interface DraftForm {
  /** null — новая стратегия; иначе — новая версия этой стратегии */
  strategyId: string | null;
  baseVersion: number | null;
  name: string;
  type: 'FIXED' | 'TARGET_MARGIN' | 'MATCH_BUYBOX' | 'BEAT_LOWEST';
  /** Суммы — в основных единицах валюты («19,99»), маржа — в процентах («12,5») */
  price: string;
  targetMargin: string;
  undercut: string;
  deadband: string;
  holdWhenWinning: boolean;
  atBound: 'CAP' | 'HOLD';
  scope: 'VISIBLE_TOP_N' | 'MARKET';
  compareLanded: boolean;
}

export const EMPTY_DRAFT: DraftForm = {
  strategyId: null, baseVersion: null, name: '', type: 'MATCH_BUYBOX', price: '', targetMargin: '20', undercut: '0.05', deadband: '0',
  holdWhenWinning: true, atBound: 'CAP', scope: 'VISIBLE_TOP_N', compareLanded: false,
};

const amountText = (minor: number | undefined) => (minor === undefined ? '' : (minor / 100).toFixed(2));
const percentText = (bp: number | undefined) => (bp === undefined ? '' : String(bp / 100));
/** Неразборчивый ввод уходит как есть — сервер назовёт поле и проблему */
const minorOf = (text: string): number | string => parseAmountInput(text) ?? text;
const bpOf = (text: string): number | string => parsePercentInput(text) ?? text;

/** Черновик новой версии: параметры последней версии стратегии */
export function formOf(item: StrategyListItem): DraftForm {
  const p = item.draft.params as unknown as Record<string, unknown>;
  const type = p.type as DraftForm['type'];
  return {
    ...EMPTY_DRAFT, strategyId: item.strategyId, baseVersion: item.version, name: item.draft.name, type,
    price: amountText(p.priceMinor as number | undefined), targetMargin: percentText(p.targetMarginBp as number | undefined),
    undercut: amountText(p.undercutMinor as number | undefined), deadband: amountText(item.draft.deadbandMinor),
    holdWhenWinning: p.holdWhenWinning === true, atBound: p.atBound === 'HOLD' ? 'HOLD' : 'CAP', scope: p.scope === 'MARKET' ? 'MARKET' : 'VISIBLE_TOP_N',
    compareLanded: p.compareLanded === true,
  };
}

export function draftOf(f: DraftForm): unknown {
  const params = f.type === 'FIXED' ? { type: f.type, priceMinor: minorOf(f.price) }
    : f.type === 'TARGET_MARGIN' ? { type: f.type, targetMarginBp: bpOf(f.targetMargin) }
      : f.type === 'MATCH_BUYBOX' ? { type: f.type, undercutMinor: minorOf(f.undercut), holdWhenWinning: f.holdWhenWinning, atBound: f.atBound }
        : { type: f.type, undercutMinor: minorOf(f.undercut), scope: f.scope, compareLanded: f.compareLanded, atBound: f.atBound };
  return { name: f.name, params, deadbandMinor: minorOf(f.deadband) } satisfies Record<keyof StrategyDraft, unknown>;
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
      {view.saveBlocked ? <p className="notice" role="alert">{view.saveBlocked}</p> : null}
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

/** Подтверждение сохранения: второе нажатие, отдельно от превью */
export function SaveConfirm({ offers, busy, onConfirm, onCancel, assign = false }: { offers: number; busy: boolean; onConfirm: () => void; onCancel: () => void; assign?: boolean }) {
  const m = useMessages();
  const t = m.ui.strategies;
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="strategy-confirm-title">
      <h3 id="strategy-confirm-title">{t.confirmTitle(offers)}</h3>
      <p>{assign ? t.assignConfirmText : t.confirmText}</p>
      <div className="buttons">
        <button type="button" className="danger" disabled={busy} onClick={onConfirm}>{t.confirmSave}</button>
        <button type="button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
      </div>
    </div>
  );
}

export function StrategiesScreenView({ view, worldId, initialPreview = null }: { view: StrategyListView; worldId: string; initialPreview?: StrategyPreviewView | null }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const assignable = view.scopes.filter((s) => s.assignable).map((s) => s.unit.writeScopeId);
  const [form, setForm] = useState<DraftForm>(EMPTY_DRAFT);
  /** OQ-169: назначается существующая версия — черновик не редактируется, превью и сохранение по её параметрам */
  const [assigning, setAssigning] = useState<StrategyListItem | null>(null);
  const [removing, setRemoving] = useState<StrategyListView['scopes'][number] | null>(null);
  const [selected, setSelected] = useState<string[]>(assignable);
  const [preview, setPreview] = useState<StrategyPreviewView | null>(initialPreview);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Р-136 (ревью шага 29, находка 3): выбор относится к ПОКАЗАННОЙ странице. Он сбрасывается при листании — иначе продавец,
   * ушедший на третью страницу, сохранял бы стратегию предложениям первой. Весь каталог выбирается отдельным флагом, и его
   * раскрывает сервер: перечислить 10 000 идентификаторов в теле запроса нельзя.
   */
  const [wholeCatalog, setWholeCatalog] = useState(false);
  const pageKey = `${view.page.from}:${view.page.to}`;
  const [shownPage, setShownPage] = useState(pageKey);
  if (shownPage !== pageKey) {
    // Р-140: выбор прежней страницы не переносится; предложения НОВОЙ страницы — умолчание, и число выбранных сказано рядом
    setShownPage(pageKey); setSelected(assignable); setWholeCatalog(false); setPreview(null); setPreviewJobId(null);
  }

  const changed = () => { setPreview(null); setPreviewJobId(null); setConfirming(false); };
  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => { setForm({ ...form, [key]: value }); changed(); };
  const pick = (ids: string[]) => { setSelected(ids); setWholeCatalog(false); changed(); };
  const scopeSelection = () => (wholeCatalog ? { all: true } : { writeScopeIds: selected });

  /**
   * OQ-201 (шаг 30): предпросмотр — фоновое задание по ВСЕМ выбранным предложениям, а не по выборке 500. Экран показывает его
   * ход и берёт готовый ответ из итога задания; идентификатор задания нужен и для сохранения — сервер сверяется именно с ним.
   */
  const run = async (notice: string | null = null) => {
    setBusy(true); setError(null); setMessage(notice); setPreview(null);
    try {
      const draft = assigning ? assigning.draft : draftOf(form);
      const created = await requestJson<JobCreatedResponse>(worldPath(worldId, 'strategies', 'preview'), { method: 'POST', body: { draft, ...scopeSelection() }, locale: m.locale });
      setPreviewJobId(created.jobId);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const previewReady = (job: BulkJobView) => {
    const result = job.result as { view?: StrategyPreviewView } | null;
    if (job.status === 'SUCCEEDED' && result?.view) setPreview(result.view);
    else if (job.status === 'FAILED') setError(job.error);
  };
  const save = async () => {
    if (!preview) return;
    setBusy(true); setError(null);
    try {
      // Р-139: назначение на каталог идёт фоновым заданием; предпросмотр уже сверен сервером с тем, что видел человек
      const r = assigning
        ? await requestJson<JobCreatedResponse>(worldPath(worldId, 'strategies', 'assign'), {
          method: 'POST', body: { strategyId: assigning.strategyId, version: assigning.version, ...scopeSelection(), previewJobId, previewToken: preview.previewToken, confirmed: true }, locale: m.locale,
        })
        : await requestJson<JobCreatedResponse>(worldPath(worldId, 'strategies'), {
          method: 'POST', body: { draft: draftOf(form), ...scopeSelection(), strategyId: form.strategyId, previewJobId, previewToken: preview.previewToken, confirmed: true }, locale: m.locale,
        });
      setMessage(r.message); setJobId(r.jobId); setPreview(null); setPreviewJobId(null); setConfirming(false); setBusy(false); setAssigning(null);
    } catch (e) {
      setConfirming(false); setBusy(false);
      // Офферы изменились после превью: показать новое превью, а не ошибку без выхода
      if (e instanceof ApiError && e.failure.kind === 'SERVER' && e.failure.code === 'PREVIEW_CHANGED') return void run(t.rePreviewed);
      setError(errorText(e, m));
    }
  };

  const unassign = async () => {
    if (!removing) return;
    setBusy(true); setError(null);
    try {
      const r = await requestJson<StrategySaveResponse>(worldPath(worldId, 'strategies', 'unassign'), {
        method: 'POST', body: { writeScopeIds: [removing.unit.writeScopeId], confirmed: true }, locale: m.locale,
      });
      setMessage(r.message); setRemoving(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  return (
    <section>
      <h2>{t.pageTitle}</h2>
      <h3>{t.inUse}</h3>
      {/* Задача D шага 34: новый тенант без стратегий и офферов видит объяснение, а не пустой список */}
      {view.strategies.length === 0 ? <p className="notice">{m.ui.onboarding.empty.strategies} <a href={href(view.worldId, 'onboarding')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      <ul className="index">
        {view.strategies.map((s) => (
          <li key={s.strategyId}>
            <strong>{s.name ?? t.unnamed}</strong> · {s.label} {t.versionShort(s.version)} <span className="small muted">{s.detail}</span>
            {/* Р-136: показаны примеры, а сколько всего — числом: у стратегии каталога предложений могут быть тысячи */}
            <div className="small">{s.scopeCount === 0 ? <span className="muted">{t.notUsed}</span> : (
              <>{s.scopes.map((u) => `${u.unit.label} (${t.versionShort(u.version)})`).join(', ')}
                {s.scopeCount > s.scopes.length ? <span className="muted"> {t.usedBy(s.scopeCount)}</span> : null}</>
            )}</div>
            <div className="small muted">{t.versionsTitle}: {s.versions.map((v) => t.versionLine(v.version, v.status, v.author, v.createdAt)).join('; ')}</div>
            {view.canEdit ? <button type="button" disabled={busy} onClick={() => { setAssigning(null); setForm(formOf(s)); changed(); setMessage(null); }}>{t.newVersion}</button> : null}
            {s.assignable ? <button type="button" disabled={busy} onClick={() => { setAssigning(s); changed(); setMessage(null); }}>{t.assignVersion}</button> : null}
          </li>
        ))}
      </ul>

      <h3>{t.channelPricingTitle}</h3>
      <p className="muted small">{t.channelPricingIntro}</p>
      {view.channelPricingOffers.length === 0 ? <p className="muted">{t.channelPricingNone}</p> : (
        <ul className="index">{view.channelPricingOffers.map((o) => <li key={o.label}><Badge tone={o.tone}>{o.label}</Badge> <span className="small">{o.detail}</span></li>)}</ul>
      )}

      <h3>{assigning ? t.assigning(assigning.draft.name, assigning.version) : form.strategyId ? t.editing(form.name, form.baseVersion ?? 0) : t.draftTitle}</h3>
      {!view.canEdit ? <p className="notice">{t.noRight}</p> : null}
      {form.strategyId || assigning ? <button type="button" disabled={busy} onClick={() => { setAssigning(null); setForm(EMPTY_DRAFT); changed(); }}>{t.newStrategy}</button> : null}
      {assigning ? <p className="small muted">{assigning.label} · {assigning.detail}</p> : null}
      <div className="form" hidden={assigning !== null}>
        <label>{t.name} <input value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} /></label>
        <label>{t.type} <select value={form.type} onChange={(e) => set('type', e.target.value as DraftForm['type'])}>
          {(Object.keys(t.types) as Array<keyof typeof t.types>).map((k) => <option key={k} value={k}>{t.types[k]}</option>)}
        </select></label>
        {form.type === 'FIXED' ? <label>{t.fields.priceMinor} <input inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} /></label> : null}
        {form.type === 'TARGET_MARGIN' ? <label>{t.fields.targetMarginBp} <input inputMode="decimal" value={form.targetMargin} onChange={(e) => set('targetMargin', e.target.value)} /></label> : null}
        {form.type === 'MATCH_BUYBOX' || form.type === 'BEAT_LOWEST' ? (
          <>
            <label>{t.fields.undercutMinor} <input inputMode="decimal" value={form.undercut} onChange={(e) => set('undercut', e.target.value)} /></label>
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
        <label>{t.fields.deadbandMinor} <input inputMode="decimal" value={form.deadband} onChange={(e) => set('deadband', e.target.value)} /></label>
      </div>

      <h4>{t.pick}</h4>
      {/* Р-140 (шаг 30): «всё» — это весь каталог, а не показанная страница; страница выбирается отдельной кнопкой, и так и названа */}
      <label className="whole-catalog">
        <input type="checkbox" checked={wholeCatalog} disabled={busy}
          onChange={(e) => { setWholeCatalog(e.target.checked); setSelected([]); changed(); }} /> {t.selectAllCatalog(view.page.total)}
      </label>
      <div className="buttons">
        <button type="button" disabled={busy || wholeCatalog} onClick={() => pick(assignable)}>{t.selectPage(assignable.length)}</button>
        <button type="button" disabled={busy || wholeCatalog} onClick={() => pick([])}>{t.selectNone}</button>
      </div>
      {/* Сколько выбрано — числом и всегда: без него «выбрано» читается как «то, что я вижу на этой странице» */}
      <p className="notice" role="status">
        {wholeCatalog ? t.selectionWhole(view.page.total) : selected.length === 0 ? t.selectionNone : t.selectionCount(selected.length, view.page.total)}
      </p>
      <p className="small muted">{t.selectionReset}</p>
      <ul className="index">
        {view.scopes.map((s) => (
          <li key={s.unit.writeScopeId}>
            <label><input type="checkbox" disabled={!s.assignable} checked={selected.includes(s.unit.writeScopeId)}
              onChange={(e) => pick(e.target.checked ? [...selected, s.unit.writeScopeId] : selected.filter((x) => x !== s.unit.writeScopeId))} /> {s.unit.label}</label>
            <span className="small muted"> · {s.strategy} · {s.mode}</span>
            {s.channelPricing ? <div className="small"><Badge tone={s.channelPricing.tone}>{t.notAssignable}</Badge> {s.channelPricing.detail}</div> : null}
            {s.canUnassign ? <button type="button" disabled={busy} onClick={() => { setRemoving(s); setMessage(null); }}>{t.unassign}</button> : null}
          </li>
        ))}
      </ul>
      <div className="buttons">
        <button type="button" disabled={busy || (selected.length === 0 && !wholeCatalog)} onClick={() => void run()}>{t.preview}</button>
        {view.canEdit
          ? <button type="button" className="danger" disabled={busy || !preview || preview.saveBlocked !== null || confirming} onClick={() => setConfirming(true)}>{t.save}</button>
          : null}
      </div>
      <p className="small muted">{t.saveHint}</p>
      {confirming && preview ? <SaveConfirm offers={preview.rows.length} busy={busy} assign={assigning !== null} onConfirm={() => void save()} onCancel={() => setConfirming(false)} /> : null}
      {removing ? (
        <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="strategy-remove-title">
          <h3 id="strategy-remove-title">{t.unassignTitle(removing.unit.label)}</h3>
          <p>{t.unassignText}</p>
          <div className="buttons">
            <button type="button" className="danger" disabled={busy} onClick={() => void unassign()}>{t.unassign}</button>
            <button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t.cancel}</button>
          </div>
        </div>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {previewJobId ? <JobProgress worldId={worldId} jobId={previewJobId} onFinished={previewReady} /> : null}
      {jobId ? <JobProgress worldId={worldId} jobId={jobId} /> : null}
      {preview ? <PreviewTable view={preview} /> : null}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function StrategiesScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<StrategyListView>(`${worldPath(worldId, 'strategies')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
  return (
    <Load resource={resource} retry={retry}>
      {(view) => <><StrategiesScreenView view={view} worldId={worldId} /><Pager page={view.page} query={query} onQuery={setQuery} /></>}
    </Load>
  );
}
