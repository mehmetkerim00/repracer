import { useState } from 'react';
import { LIST_PAGE_DEFAULT, parseAmountInput, parsePercentInput, type ListQuery, type StrategyDraft, type StrategyListItem, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import type { JobCreatedResponse, StrategySaveResponse } from '../api-types.ts';
import type { BulkJobView } from '@repracer/console-model';
import { JobProgress } from './Jobs.tsx';
import { ApiError, requestJson, useResource, worldPath } from '../api.ts';
import { Badge, commonZone, ErrorBox, errorText, Gaps, href, Load, Pager, ReasonLine, shortWhen, useMessages, When, WhenHead } from '../components.tsx';
import { CheckField, Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';

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

// Шаг 79 (ревью): суммы черновика — в формате языка экрана («0,05» по-немецки); разбор принимает и запятую, и точку
const amountText = (minor: number | undefined, locale = 'en') => (minor === undefined ? '' : (minor / 100).toFixed(2).replace('.', locale === 'de' ? ',' : '.'));
const percentText = (bp: number | undefined, locale = 'en') => (bp === undefined ? '' : String(bp / 100).replace('.', locale === 'de' ? ',' : '.'));
/** Пустой черновик на языке экрана */
export const emptyDraft = (locale: string): DraftForm => ({ ...EMPTY_DRAFT, undercut: amountText(5, locale), deadband: '0' });
/** Неразборчивый ввод уходит как есть — сервер назовёт поле и проблему */
const minorOf = (text: string): number | string => parseAmountInput(text) ?? text;
const bpOf = (text: string): number | string => parsePercentInput(text) ?? text;

/** Черновик новой версии: параметры последней версии стратегии */
export function formOf(item: StrategyListItem, locale = 'en'): DraftForm {
  const p = item.draft.params as unknown as Record<string, unknown>;
  const type = p.type as DraftForm['type'];
  return {
    ...EMPTY_DRAFT, strategyId: item.strategyId, baseVersion: item.version, name: item.draft.name, type,
    price: amountText(p.priceMinor as number | undefined, locale), targetMargin: percentText(p.targetMarginBp as number | undefined, locale),
    undercut: amountText(p.undercutMinor as number | undefined, locale), deadband: amountText(item.draft.deadbandMinor, locale),
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
  const asOfZone = commonZone(view.rows.map((r) => r.asOf));
  return (
    <section className="preview">
      <h3>{view.draft.title}</h3>
      <p className="muted small">{view.draft.detail}</p>
      <p className="headline">{view.headline}</p>
      {view.saveBlocked ? <p className="notice" role="alert">{view.saveBlocked}</p> : null}
      {/* Шаг 79 (ревью): плотная таблица и переносимое «на момент» — колонка «почему» не уходит за край рамки */}
      <div className="table-wrap">
        <table className="dense cardify">
          <thead><tr><th>{c.offer}</th><th><WhenHead label={c.asOf} zone={asOfZone} /></th><th className="num">{c.current}</th><th className="num">{c.proposed}</th><th className="num">{c.final}</th><th className="num">{c.change}</th><th>{c.outcome}</th><th>{c.reason}</th></tr></thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.unit.writeScopeId} className={r.dangerous ? 'dangerous' : ''}>
                <td className="offer card-title">{r.unit.label}</td>
                <td className="small as-of" data-label={`${c.asOf}${asOfZone ? ` · ${asOfZone}` : ''}`}><When value={r.asOf} zone={!asOfZone} /></td>
                <td className="num cur" data-label={c.current}>{r.current}</td>
                <td className="num cur" data-label={c.proposed}>{r.proposed ?? '–'}</td>
                <td className="num cur" data-label={c.final}>{r.final ?? '–'}</td>
                <td className="num" data-label={c.change}>{r.change ?? '–'}</td>
                <td className="card-status"><Badge tone={r.tone}>{r.outcome}</Badge>{r.dangerous ? <div className="small"><Badge tone="stop">{t.dangerous}</Badge></div> : null}</td>
                <td className="reason-cell" data-label={c.reason}>{r.reason ? <ReasonLine reason={r.reason} /> : null}{r.unavailable ? <div className="gap-note small">{r.unavailable}</div> : null}</td>
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
      <FormActions dialog>
        <button type="button" disabled={busy} onClick={onCancel}>{t.cancel}</button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>{t.confirmSave}</button>
      </FormActions>
    </div>
  );
}

export function StrategiesScreenView({ view, worldId, initialPreview = null }: { view: StrategyListView; worldId: string; initialPreview?: StrategyPreviewView | null }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const assignable = view.scopes.filter((s) => s.assignable).map((s) => s.unit.writeScopeId);
  const [form, setForm] = useState<DraftForm>(() => emptyDraft(m.locale));
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
  // Шаг 78: список предложений стратегии раскрывается по ссылке «Show offers» — по умолчанию только сводка по витринам
  const [openOffers, setOpenOffers] = useState<string | null>(null);
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
      <p className="subtitle">{m.ui.app.subtitles.strategies}</p>
      <h3>{t.inUse}</h3>
      {/* Задача D шага 34: новый тенант без стратегий и офферов видит объяснение, а не пустой список */}
      {view.strategies.length === 0 ? <p className="notice">{m.ui.onboarding.empty.strategies} <a href={href(view.worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      <ul className="index strategy-cards">
        {view.strategies.map((s) => (
          <li key={s.strategyId} className="card">
            {/* Шаг 78: заголовок — имя для человека; тип — приглушённо и только если имя другое */}
            <div className="strategy-title"><strong>{s.name ?? s.label}</strong>{s.name && s.name !== s.label ? <span className="muted"> · {s.label}</span> : null}</div>
            <div className="small muted">{s.detail}</div>
            {/* Р-136, шаг 78: сводка — сколько и где; сами предложения (примеры, всего — числом) — по ссылке, а не стеной через запятую */}
            <div className="strategy-usage">{s.scopeCount === 0 ? <span className="muted">{t.notUsed}</span> : (
              <>
                <span>{t.offersOn(s.scopeCount, s.storefronts.length === 1 ? s.storefronts[0]!.label : s.storefronts.map((x) => `${x.label} ${x.count}`).join(' · '))}</span>
                {s.scopes.length > 0 ? <button type="button" className="link" aria-expanded={openOffers === s.strategyId}
                  onClick={() => setOpenOffers(openOffers === s.strategyId ? null : s.strategyId)}>{openOffers === s.strategyId ? t.hideOffers : t.showOffers}</button> : null}
              </>
            )}</div>
            {openOffers === s.strategyId ? (
              <ul className="offer-list small">
                {s.scopes.map((u) => <li key={u.unit.writeScopeId}>{u.unit.label}{u.version !== s.version ? <span className="muted"> · {t.versionShort(u.version)}</span> : null}</li>)}
                {s.scopeCount > s.scopes.length ? <li className="muted">{t.moreOffers(s.scopeCount - s.scopes.length)} — <a href={href(worldId, 'products')}>{m.ui.app.screens.products}</a></li> : null}
              </ul>
            ) : null}
            {/* Шаг 79: статус версии — пилюлей, а не словом в строке */}
            <ul className="versions small muted">{s.versions.map((v) => (
              <li key={v.version}>v{v.version} <Badge tone={v.tone}>{v.status}</Badge> {t.versionBy(v.author, shortWhen(v.createdAt))}</li>
            ))}</ul>
            <div className="buttons">
              {view.canEdit ? <button type="button" disabled={busy} onClick={() => { setAssigning(null); setForm(formOf(s, m.locale)); changed(); setMessage(null); }}>{t.newVersion}</button> : null}
              {s.assignable ? <button type="button" disabled={busy} onClick={() => { setAssigning(s); changed(); setMessage(null); }}>{t.assignVersion}</button> : null}
            </div>
          </li>
        ))}
      </ul>

      <h3>{t.channelPricingTitle}</h3>
      <p className="section-sub">{t.channelPricingIntro}</p>
      {view.channelPricingOffers.length === 0 ? <p className="muted empty">{t.channelPricingNone}</p> : (
        <ul className="index link-list">{view.channelPricingOffers.map((o) => <li key={o.label}><Badge tone={o.tone}>{o.label}</Badge> <span className="small">{o.detail}</span></li>)}</ul>
      )}
      {view.channelPricingOffersTotal > view.channelPricingOffers.length ? <p className="section-sub">{t.channelPricingMore(view.channelPricingOffersTotal - view.channelPricingOffers.length)}</p> : null}

      <h3>{assigning ? t.assigning(assigning.draft.name, assigning.version) : form.strategyId ? t.editing(form.name, form.baseVersion ?? 0) : t.draftTitle}</h3>
      {!view.canEdit ? <p className="notice">{t.noRight}</p> : null}
      {form.strategyId || assigning ? <button type="button" disabled={busy} onClick={() => { setAssigning(null); setForm(emptyDraft(m.locale)); changed(); }}>{t.newStrategy}</button> : null}
      {assigning ? <p className="small muted">{assigning.label} · {assigning.detail}</p> : null}
      {/*
        * Шаг 94: черновик — поля стандарта сеткой: имя и тип первой строкой, параметры типа второй (их столько, сколько колонок, —
        * ни одно не остаётся сиротой на новой строке), галочка — своей строкой: контрол слева, подпись справа, пояснение под ней
        */}
      {assigning === null ? (
        <FieldGroup className="draft-form">
          <FieldGrid cols={3}>
            <Field label={t.name} caption={t.captions.name} span={2}><input value={form.name} maxLength={80} onChange={(e) => set('name', e.target.value)} /></Field>
            <Field label={t.type}><select value={form.type} onChange={(e) => set('type', e.target.value as DraftForm['type'])}>
              {(Object.keys(t.types) as Array<keyof typeof t.types>).map((k) => <option key={k} value={k}>{t.types[k]}</option>)}
            </select></Field>
          </FieldGrid>
          <FieldGrid cols={form.type === 'BEAT_LOWEST' ? 4 : form.type === 'MATCH_BUYBOX' ? 3 : 2}>
            {form.type === 'FIXED' ? <Field label={t.fields.priceMinor} caption={t.captions.priceMinor}><input inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} /></Field> : null}
            {form.type === 'TARGET_MARGIN' ? <Field label={t.fields.targetMarginBp} caption={t.captions.targetMarginBp}><input inputMode="decimal" value={form.targetMargin} onChange={(e) => set('targetMargin', e.target.value)} /></Field> : null}
            {form.type === 'MATCH_BUYBOX' || form.type === 'BEAT_LOWEST' ? (
              <>
                <Field label={t.fields.undercutMinor} caption={t.captions.undercutMinor}><input inputMode="decimal" value={form.undercut} onChange={(e) => set('undercut', e.target.value)} /></Field>
                <Field label={t.fields.atBound} caption={t.captions.atBound}><select value={form.atBound} onChange={(e) => set('atBound', e.target.value as DraftForm['atBound'])}>
                  <option value="CAP">{t.atBound.CAP}</option><option value="HOLD">{t.atBound.HOLD}</option>
                </select></Field>
              </>
            ) : null}
            {form.type === 'BEAT_LOWEST' ? (
              <Field label={t.fields.scope} caption={t.captions.scope}><select value={form.scope} onChange={(e) => set('scope', e.target.value as DraftForm['scope'])}>
                <option value="VISIBLE_TOP_N">{t.scopes.VISIBLE_TOP_N}</option><option value="MARKET">{t.scopes.MARKET}</option>
              </select></Field>
            ) : null}
            <Field label={t.fields.deadbandMinor} caption={t.captions.deadbandMinor}><input inputMode="decimal" value={form.deadband} onChange={(e) => set('deadband', e.target.value)} /></Field>
          </FieldGrid>
          {form.type === 'MATCH_BUYBOX' ? <CheckField label={t.fields.holdWhenWinning} caption={t.captions.holdWhenWinning} checked={form.holdWhenWinning} onChange={(v) => set('holdWhenWinning', v)} /> : null}
          {form.type === 'BEAT_LOWEST' ? <CheckField label={t.fields.compareLanded} caption={t.captions.compareLanded} checked={form.compareLanded} onChange={(v) => set('compareLanded', v)} /> : null}
        </FieldGroup>
      ) : null}

      {/* Шаг 79: выбор предложений, предпросмотр и сохранение — одной карточкой; шаг 94: чекбоксы — поля стандарта, кнопки — рядом в конце */}
      <FieldGroup className="pick-card" title={t.pick}>
      {/* Шаг 79 (ревью): без предложений выбирать нечего — пустое состояние с путём, а не форма на ноль предложений */}
      {view.page.total === 0 ? <p className="muted empty">{t.noOffers} <a href={href(worldId, 'channels', 'accounts')}>{m.ui.app.connectChannel}</a></p> : <>
      {/* Р-140 (шаг 30): «всё» — это весь каталог, а не показанная страница; страница выбирается отдельной кнопкой, и так и названа */}
      <CheckField label={t.selectAllCatalog(view.page.total)} caption={t.selectionReset} checked={wholeCatalog} disabled={busy}
        onChange={(v) => { setWholeCatalog(v); setSelected([]); changed(); }} />
      <div className="buttons">
        <button type="button" disabled={busy || wholeCatalog} onClick={() => pick(assignable)}>{t.selectPage(assignable.length)}</button>
        <button type="button" disabled={busy || wholeCatalog} onClick={() => pick([])}>{t.selectNone}</button>
      </div>
      {/* Сколько выбрано — числом и всегда: без него «выбрано» читается как «то, что я вижу на этой странице» */}
      <p className="notice" role="status">
        {wholeCatalog ? t.selectionWhole(view.page.total) : selected.length === 0 ? t.selectionNone : t.selectionCount(selected.length, view.page.total)}
      </p>
      <ul className="index pick-list">
        {view.scopes.map((s) => (
          <li key={s.unit.writeScopeId}>
            <CheckField label={s.unit.label} caption={`${s.strategy} · ${s.mode}`} disabled={!s.assignable} checked={selected.includes(s.unit.writeScopeId)}
              {...(s.assignable ? {} : { title: t.notAssignable })}
              onChange={(v) => pick(v ? [...selected, s.unit.writeScopeId] : selected.filter((x) => x !== s.unit.writeScopeId))} />
            {s.channelPricing ? <div className="small pick-note"><Badge tone={s.channelPricing.tone}>{t.notAssignable}</Badge> {s.channelPricing.detail}</div> : null}
            {s.canUnassign ? <button type="button" className="pick-action" disabled={busy} onClick={() => { setRemoving(s); setMessage(null); }}>{t.unassign}</button> : null}
          </li>
        ))}
      </ul>
      {(() => {
        const nothing = selected.length === 0 && !wholeCatalog;
        const saveWhy = !preview ? m.ui.forms.why.previewFirst : preview.saveBlocked !== null ? preview.saveBlocked : null;
        const hint = nothing ? m.ui.forms.why.selectOffers : view.canEdit && !busy && saveWhy && !confirming ? saveWhy : null;
        return (
          <FormActions hint={hint}>
            {/* Шаг 96 (аудит Б14): главное действие — превью; «Save and assign» — второе и недоступно, пока превью нет */}
            <button type="button" className="primary" disabled={busy || nothing} title={nothing ? m.ui.forms.why.selectOffers : undefined} onClick={() => void run()}>{t.preview}</button>
            {view.canEdit
              ? <button type="button" disabled={busy || !preview || preview.saveBlocked !== null || confirming} title={saveWhy ?? undefined} onClick={() => setConfirming(true)}>{t.save}</button>
              : null}
          </FormActions>
        );
      })()}
      <p className="field-caption">{t.saveHint}</p>
      </>}
      </FieldGroup>
      {confirming && preview ? <SaveConfirm offers={preview.rows.length} busy={busy} assign={assigning !== null} onConfirm={() => void save()} onCancel={() => setConfirming(false)} /> : null}
      {removing ? (
        <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="strategy-remove-title">
          <h3 id="strategy-remove-title">{t.unassignTitle(removing.unit.label)}</h3>
          <p>{t.unassignText}</p>
          <FormActions dialog>
            <button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t.cancel}</button>
            <button type="button" className="danger" disabled={busy} onClick={() => void unassign()}>{t.unassign}</button>
          </FormActions>
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
    <Load shape="cards" resource={resource} retry={retry}>
      {(view) => <><StrategiesScreenView view={view} worldId={worldId} /><Pager page={view.page} query={query} onQuery={setQuery} /></>}
    </Load>
  );
}
