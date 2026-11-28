import { useEffect, useState } from 'react';
import { canPickMore, LIST_PAGE_DEFAULT, MAX_PICKED, NO_SELECTION, parseAmountInput, parsePercentInput, toggleOffer, type ListQuery, type OfferSelection, type StrategyDraft, type StrategyListItem, type StrategyListView, type StrategyPreviewView } from '@repracer/console-model';
import type { JobCreatedResponse, StrategySaveResponse } from '../api-types.ts';
import type { BulkJobView } from '@repracer/console-model';
import { JobProgress } from './Jobs.tsx';
import { ImportPanel } from './Imports.tsx';
import { ApiError, requestJson, useResource, worldPath } from '../api.ts';
import { Badge, commonZone, ErrorBox, errorText, Gaps, Help, href, Load, Pager, ProductRef, ReasonLine, shortWhen, UnitName, useMessages, When, WhenHead } from '../components.tsx';
import { CheckField, Field, FieldGrid, FieldGroup, FormActions, RowCheck } from '../forms.tsx';
import { BoundsIndexView } from './Bounds.tsx';
import { NO_OFFER_QUERY, OfferFilterFields, type OfferUiQuery } from './Products.tsx';
import { filterOfUi, isPicked, SelectionBar, SelectionScope, useSelectionSummary } from './Selection.tsx';
import { takeHandover } from '../handover.ts';

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
  type: 'FIXED' | 'TARGET_MARGIN' | 'MATCH_BUYBOX' | 'BEAT_LOWEST' | 'WIN_BUYBOX';
  /** Суммы — в основных единицах валюты («19,99»), маржа — в процентах («12,5») */
  price: string;
  targetMargin: string;
  undercut: string;
  deadband: string;
  holdWhenWinning: boolean;
  atBound: 'CAP' | 'HOLD';
  scope: 'VISIBLE_TOP_N' | 'MARKET';
  compareLanded: boolean;
  /** Шаг 97 [Р-219]: Win the Buy Box — поправка на исполнение каналом, подъём при удержании (по умолчанию выключен) и его шаг в процентах */
  handicap: string;
  creepUp: boolean;
  creepStep: string;
  /** Шаг 101 [Р-226]: ориентир («» — умолчание типа) и фильтр «Compete with» */
  anchor: '' | 'BUYBOX' | 'LOWEST' | 'LOWER_OF_TWO';
  competeWith: 'ALL' | 'CHANNEL' | 'MERCHANT';
}

export const EMPTY_DRAFT: DraftForm = {
  strategyId: null, baseVersion: null, name: '', type: 'MATCH_BUYBOX', price: '', targetMargin: '20', undercut: '0.05', deadband: '0',
  holdWhenWinning: true, atBound: 'CAP', scope: 'VISIBLE_TOP_N', compareLanded: false, handicap: '0', creepUp: false, creepStep: '1',
  anchor: '', competeWith: 'ALL',
};
/** Шаг 101 [Р-226]: ориентир по умолчанию — прежнее поведение типа */
const anchorDefault = (type: DraftForm['type']): 'BUYBOX' | 'LOWEST' => (type === 'BEAT_LOWEST' ? 'LOWEST' : 'BUYBOX');

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
    handicap: amountText((p.fulfillmentHandicapMinor as number | undefined) ?? 0, locale), creepUp: p.creepUp === true,
    creepStep: percentText((p.creepStepBp as number | undefined) ?? 100, locale),
    anchor: (p.anchor as DraftForm['anchor'] | undefined) ?? '', competeWith: (p.competeWith as DraftForm['competeWith'] | undefined) ?? 'ALL',
  };
}

export function draftOf(f: DraftForm): unknown {
  const params = f.type === 'FIXED' ? { type: f.type, priceMinor: minorOf(f.price) }
    : f.type === 'TARGET_MARGIN' ? { type: f.type, targetMarginBp: bpOf(f.targetMargin) }
      : f.type === 'MATCH_BUYBOX' ? { type: f.type, undercutMinor: minorOf(f.undercut), holdWhenWinning: f.holdWhenWinning, atBound: f.atBound, competeWith: f.competeWith }
        : f.type === 'WIN_BUYBOX' ? { type: f.type, undercutMinor: minorOf(f.undercut), fulfillmentHandicapMinor: minorOf(f.handicap), creepUp: f.creepUp, creepStepBp: bpOf(f.creepStep), atBound: f.atBound,
          anchor: f.anchor || anchorDefault(f.type), competeWith: f.competeWith }
        : { type: f.type, undercutMinor: minorOf(f.undercut), scope: f.scope, compareLanded: f.compareLanded, atBound: f.atBound, anchor: f.anchor || anchorDefault(f.type), competeWith: f.competeWith };
  return { name: f.name, params, deadbandMinor: minorOf(f.deadband) } satisfies Record<keyof StrategyDraft, unknown>;
}

export function PreviewTable({ view, worldId, jobId }: { view: StrategyPreviewView; worldId?: string; jobId?: string | null }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const c = t.columns;
  /**
   * Шаг 178 (#39, уточнение Р-140, (г)): предпросмотр перечисляет ВСЕ предложения назначения — включая выбранные вне текущего фильтра:
   * первая страница — строки вида, следующие — из итога задания предпросмотра
   */
  const [page, setPage] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [more, setMore] = useState<StrategyPreviewView['rows'] | null>(null);
  const total = view.shown.of;
  const paged = Boolean(worldId && jobId) && total > view.rows.length;
  useEffect(() => {
    if (!paged || page.offset === 0) { setMore(null); return; }
    let alive = true;
    requestJson<{ rows: StrategyPreviewView['rows'] }>(`${worldPath(worldId!, 'strategies', 'preview', jobId!)}?offset=${page.offset}&limit=${page.limit}`, { locale: m.locale })
      .then((x) => { if (alive) setMore(x.rows); }).catch(() => { if (alive) setMore(null); });
    return () => { alive = false; };
  }, [paged, worldId, jobId, page.offset, page.limit, m.locale]);
  const rows = page.offset === 0 || !more ? view.rows : more;
  const pageInfo = { from: total === 0 ? 0 : page.offset + 1, to: Math.min(page.offset + page.limit, total), total,
    text: m.ui.feed.page(total === 0 ? 0 : page.offset + 1, Math.min(page.offset + page.limit, total), total), hasPrevious: page.offset > 0, hasNext: page.offset + page.limit < total };
  const asOfZone = commonZone(rows.map((r) => r.asOf));
  return (
    <section className="preview">
      <h3>{view.draft.title}</h3>
      <p className="muted small">{view.draft.detail}</p>
      {worldId && jobId ? <h4>{m.ui.selection.planAll(total)}</h4> : null}
      <p className="headline">{view.headline}</p>
      {view.saveBlocked ? <p className="notice" role="alert">{view.saveBlocked}</p> : null}
      {/* Шаг 79 (ревью): плотная таблица и переносимое «на момент» — колонка «почему» не уходит за край рамки */}
      <div className="table-wrap">
        <table className="dense cardify">
          <thead><tr><th>{c.offer}</th><th><WhenHead label={c.asOf} zone={asOfZone} /></th><th className="num">{c.current}</th><th className="num">{c.proposed}</th><th className="num">{c.final}</th><th className="num">{c.change}</th><th>{c.outcome}</th><th>{c.reason}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.unit.writeScopeId} className={r.dangerous ? 'dangerous' : ''}>
                <td className="offer card-title"><UnitName unit={r.unit} /></td>
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
      {paged ? <Pager page={pageInfo} query={page} onQuery={setPage} /> : null}
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

/** Шаг 178 (#39): фильтры Offers у списка назначения — витрины пространства, число прошедших фильтр и весь каталог */
export interface StrategyFilterInfo {
  filters: { storefronts: Array<{ value: string; label: string }> };
  matched: number | null;
  catalogTotal: number;
}

export function StrategiesScreenView({ view, worldId, initialPreview = null, onChanged, offerQuery, onOfferQuery, pageQuery, onPage }: { view: StrategyListView & Partial<StrategyFilterInfo>; worldId: string;
  initialPreview?: StrategyPreviewView | null; onChanged?: () => void; offerQuery?: OfferUiQuery; onOfferQuery?: (q: OfferUiQuery) => void; pageQuery?: ListQuery; onPage?: (q: ListQuery) => void }) {
  const m = useMessages();
  const t = m.ui.strategies;
  const assignable = view.scopes.filter((s) => s.assignable).map((s) => s.unit.writeScopeId);
  const [form, setForm] = useState<DraftForm>(() => emptyDraft(m.locale));
  /** OQ-169: назначается существующая версия — черновик не редактируется, превью и сохранение по её параметрам */
  const [assigning, setAssigning] = useState<StrategyListItem | null>(null);
  const [removing, setRemoving] = useState<StrategyListView['scopes'][number] | null>(null);
  /**
   * Шаг 178 (#39, уточнение Р-140): выбор переживает страницы и фильтры — только видимым. Начальный выбор — назначаемые предложения первой
   * страницы, отмеченные явно (как было); дальше листание и фильтр его не сбрасывают
   */
  // Шаг 179 (#39): выбор, переданный с Offers, — первым
  const [selection, setSelection] = useState<OfferSelection>(() => takeHandover(worldId) ?? { ...NO_SELECTION, ids: assignable });
  const [review, setReview] = useState<ListQuery | null>(null);
  const [search, setSearch] = useState(offerQuery?.q ?? '');
  const filter = offerQuery ? filterOfUi(offerQuery) : {};
  const summary = useSelectionSummary(worldId, selection, filter, view.scopes.map((sc) => sc.unit.writeScopeId), review, 0);
  const [preview, setPreview] = useState<StrategyPreviewView | null>(initialPreview);
  const [previewJobId, setPreviewJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  /** Шаг 174 (BUG-05): фраза запуска назначения — в карточке задания, пока оно идёт */
  const [started, setStarted] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Шаг 78: список предложений стратегии раскрывается по ссылке «Show offers» — по умолчанию только сводка по витринам
  const [openOffers, setOpenOffers] = useState<string | null>(null);
  const changed = () => { setPreview(null); setPreviewJobId(null); setConfirming(false); };
  const set = <K extends keyof DraftForm>(key: K, value: DraftForm[K]) => { setForm({ ...form, [key]: value }); changed(); };
  const onSelection = (next: OfferSelection) => { setSelection(next); changed(); };
  // Шаг 178: выбор раскрывает сервер — отмеченные, «все подходящие» и снятые
  const scopeSelection = () => ({ selection });
  const selectedCount = summary?.selected ?? selection.ids.length;

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
    // Шаг 174 (BUG-02): отказ задания называет карточка задания — второй раз формой он не повторяется
    if (job.status === 'SUCCEEDED' && result?.view) setPreview(result.view);
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
      setMessage(null); setStarted(r.message); setJobId(r.jobId); setPreview(null); setPreviewJobId(null); setConfirming(false); setBusy(false); setAssigning(null);
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
      setMessage(r.message); setRemoving(null); onChanged?.();
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };

  return (
    <section>
      <h2>{t.pageTitle}</h2>
      <p className="subtitle">{m.ui.app.subtitles.strategies}</p>
      {/* Шаг 99 [Р-225]: назначение стратегий файлом — разделом этой страницы, меню не растёт */}
      <p className="page-actions"><button type="button" onClick={() => document.getElementById('strategy-import')?.scrollIntoView({ block: 'start' })}>{t.importAction}</button></p>
      <h3>{t.inUse}</h3>
      {/* Задача D шага 34: новый тенант без стратегий и офферов видит объяснение, а не пустой список */}
      {view.strategies.length === 0 ? <p className="notice">{m.ui.onboarding.empty.strategies} <a href={href(view.worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      {/*
        * Шаг 150 (#27, Р-254): стратегии — таблицей, а не крупными карточками. На виду — имя и тип, цель простыми словами, сколько
        * предложений и где, последняя версия; параметры (подрез, ориентир, «Compete with», граница) и все версии — под «Details» строки
        */}
      {view.strategies.length > 0 ? (
        <div className="table-wrap">
        <table className="cardify strategies-table">
          <thead><tr><th>{t.table.strategy}</th><th>{t.table.goal}</th><th>{t.table.offers}</th><th>{t.table.lastChange}</th><th><span className="visually-hidden">{t.table.actions}</span></th></tr></thead>
          <tbody>
            {view.strategies.map((s) => {
              const last = s.versions[0];
              return (
                <tr key={s.strategyId}>
                  <td className="card-title strategy-cell">
                    {/* Шаг 78: заголовок — имя для человека; тип — приглушённо и только если имя другое */}
                    <div className="strategy-title"><strong>{s.name ?? s.label}</strong></div>
                    {s.name && s.name !== s.label ? <div className="small muted">{s.label}</div> : null}
                    {/* Шаг 103 [Р-228]: стратегия — умолчание новых предложений аккаунтов: одной строкой, без пилюли */}
                    {s.defaultFor ? <div className="small muted strategy-default">{s.defaultFor}</div> : null}
                    <details className="strategy-details small">
                      <summary>{t.details}</summary>
                      <div className="muted strategy-params">{s.detail}</div>
                      {/* Шаг 79: статус версии — пилюлей, а не словом в строке */}
                      <ul className="versions muted" aria-label={t.versionsTitle}>{s.versions.map((v) => (
                        <li key={v.version}>v{v.version} <Badge tone={v.tone}>{v.status}</Badge> {v.createdAt ? t.versionBy(v.author, shortWhen(v.createdAt)) : v.author}</li>
                      ))}</ul>
                    </details>
                  </td>
                  <td className="text-cell strategy-goal" data-label={t.table.goal}><div>{s.goalText}</div><div className="small muted">{s.goalHint}</div></td>
                  {/* Р-136, шаг 78: сводка — сколько и где; сами предложения (примеры, всего — числом) — по ссылке, а не стеной через запятую */}
                  <td className="text-cell" data-label={t.table.offers}>
                    <div className="strategy-usage">{s.scopeCount === 0 ? <span className="muted">{t.notUsed}</span> : (
                      <>
                        <span>{t.offersOn(s.scopeCount, s.storefronts.length === 1 ? s.storefronts[0]!.label : s.storefronts.map((x) => `${x.label} ${x.count}`).join(' · '))}</span>
                        {s.scopes.length > 0 ? <button type="button" className="link" aria-expanded={openOffers === s.strategyId}
                          onClick={() => setOpenOffers(openOffers === s.strategyId ? null : s.strategyId)}>{openOffers === s.strategyId ? t.hideOffers : t.showOffers}</button> : null}
                      </>
                    )}</div>
                    {openOffers === s.strategyId ? (
                      <ul className="offer-list small">
                        {s.scopes.map((u) => <li key={u.unit.writeScopeId}><UnitName unit={u.unit} />{u.version !== s.version ? <span className="muted"> · {t.versionShort(u.version)}</span> : null}</li>)}
                        {s.scopeCount > s.scopes.length ? <li className="muted">{t.moreOffers(s.scopeCount - s.scopes.length)} — <a href={href(worldId, 'products')}>{m.ui.app.screens.products}</a></li> : null}
                      </ul>
                    ) : null}
                  </td>
                  <td className="text-cell strategy-last" data-label={t.table.lastChange}>
                    {last ? <><div>v{last.version} <Badge tone={last.tone}>{last.status}</Badge></div><div className="small muted">{last.createdAt ? t.versionBy(last.author, shortWhen(last.createdAt)) : last.author}</div></> : null}
                  </td>
                  <td className="card-action">
                    <div className="buttons">
                      {view.canEdit ? <button type="button" disabled={busy} onClick={() => { setAssigning(null); setForm(formOf(s, m.locale)); changed(); setMessage(null); }}>{t.newVersion}</button> : null}
                      {s.assignable ? <button type="button" disabled={busy} onClick={() => { setAssigning(s); changed(); setMessage(null); }}>{t.assignVersion}</button> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      ) : null}

      <h3>{t.channelPricingTitle}</h3>
      <Help className="section-sub" text={t.channelPricingIntro} />
      {view.channelPricingOffers.length === 0 ? <p className="muted empty">{t.channelPricingNone}</p> : (
        <ul className="index link-list">{view.channelPricingOffers.map((o) => <li key={o.label}><Badge tone={o.tone}>{o.label}</Badge> <span className="small">{o.detail}</span></li>)}</ul>
      )}
      {view.channelPricingOffersTotal > view.channelPricingOffers.length ? <Help className="section-sub" text={t.channelPricingMore(view.channelPricingOffersTotal - view.channelPricingOffers.length)} /> : null}

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
          {/* Шаг 97 [G]: карточка типа — что делает «Win the Buy Box» и чего не обещает */}
          {form.type === 'WIN_BUYBOX' ? <p className="notice type-about">{t.winBuyboxAbout}</p> : null}
          <FieldGrid cols={form.type === 'BEAT_LOWEST' || form.type === 'WIN_BUYBOX' ? 4 : form.type === 'MATCH_BUYBOX' ? 3 : 2}>
            {form.type === 'FIXED' ? <Field label={t.fields.priceMinor} caption={t.captions.priceMinor}><input inputMode="decimal" value={form.price} onChange={(e) => set('price', e.target.value)} /></Field> : null}
            {form.type === 'TARGET_MARGIN' ? <Field label={t.fields.targetMarginBp} caption={t.captions.targetMarginBp}><input inputMode="decimal" value={form.targetMargin} onChange={(e) => set('targetMargin', e.target.value)} /></Field> : null}
            {form.type === 'MATCH_BUYBOX' || form.type === 'BEAT_LOWEST' || form.type === 'WIN_BUYBOX' ? (
              <>
                <Field label={t.fields.undercutMinor} caption={t.captions.undercutMinor}><input inputMode="decimal" value={form.undercut} onChange={(e) => set('undercut', e.target.value)} /></Field>
                <Field label={t.fields.atBound} caption={t.captions.atBound}><select value={form.atBound} onChange={(e) => set('atBound', e.target.value as DraftForm['atBound'])}>
                  <option value="CAP">{t.atBound.CAP}</option><option value="HOLD">{t.atBound.HOLD}</option>
                </select></Field>
              </>
            ) : null}
            {form.type === 'WIN_BUYBOX' ? <Field label={t.fields.fulfillmentHandicapMinor} caption={t.captions.fulfillmentHandicapMinor}><input inputMode="decimal" value={form.handicap} onChange={(e) => set('handicap', e.target.value)} /></Field> : null}
            {form.type === 'BEAT_LOWEST' ? (
              <Field label={t.fields.scope} caption={t.captions.scope}><select value={form.scope} onChange={(e) => set('scope', e.target.value as DraftForm['scope'])}>
                <option value="VISIBLE_TOP_N">{t.scopes.VISIBLE_TOP_N}</option><option value="MARKET">{t.scopes.MARKET}</option>
              </select></Field>
            ) : null}
            <Field label={t.fields.deadbandMinor} caption={t.captions.deadbandMinor}><input inputMode="decimal" value={form.deadband} onChange={(e) => set('deadband', e.target.value)} /></Field>
          </FieldGrid>
          {/* Шаг 101 [Р-226]: ориентир (у «Beat the lowest» и «Win the Buy Box») и фильтр «Compete with» (у всех трёх конкурентных) */}
          {form.type === 'MATCH_BUYBOX' || form.type === 'BEAT_LOWEST' || form.type === 'WIN_BUYBOX' ? (
            <FieldGrid cols={2}>
              {form.type !== 'MATCH_BUYBOX' ? (
                <Field label={t.fields.anchor} caption={t.captions.anchor}><select value={form.anchor || anchorDefault(form.type)} onChange={(e) => set('anchor', e.target.value as DraftForm['anchor'])}>
                  {(['BUYBOX', 'LOWEST', 'LOWER_OF_TWO'] as const).map((k) => <option key={k} value={k}>{t.anchors[k]}</option>)}
                </select></Field>
              ) : null}
              <Field label={t.fields.competeWith} caption={view.walmart ? `${t.captions.competeWith} ${t.captions.competeWithWalmart}` : t.captions.competeWith}><select value={form.competeWith} onChange={(e) => set('competeWith', e.target.value as DraftForm['competeWith'])}>
                {(['ALL', 'CHANNEL', 'MERCHANT'] as const).map((k) => <option key={k} value={k}>{t.competeWithOptions[k]}</option>)}
              </select></Field>
            </FieldGrid>
          ) : null}
          {form.type === 'MATCH_BUYBOX' ? <CheckField label={t.fields.holdWhenWinning} caption={t.captions.holdWhenWinning} checked={form.holdWhenWinning} onChange={(v) => set('holdWhenWinning', v)} /> : null}
          {form.type === 'BEAT_LOWEST' ? <CheckField label={t.fields.compareLanded} caption={t.captions.compareLanded} checked={form.compareLanded} onChange={(v) => set('compareLanded', v)} /> : null}
          {form.type === 'WIN_BUYBOX' ? <CheckField label={t.fields.creepUp} caption={t.captions.creepUp} checked={form.creepUp} onChange={(v) => set('creepUp', v)} /> : null}
          {form.type === 'WIN_BUYBOX' && form.creepUp ? (
            <FieldGrid cols={4}>
              <Field label={t.fields.creepStepBp} caption={t.captions.creepStepBp}><input inputMode="decimal" value={form.creepStep} onChange={(e) => set('creepStep', e.target.value)} /></Field>
            </FieldGrid>
          ) : null}
        </FieldGroup>
      ) : null}

      {/* Шаг 79: выбор предложений, предпросмотр и сохранение — одной карточкой; шаг 94: чекбоксы — поля стандарта, кнопки — рядом в конце */}
      <FieldGroup className="pick-card" title={t.pick}>
      {/* Шаг 79 (ревью): без предложений выбирать нечего — пустое состояние с путём, а не форма на ноль предложений */}
      {view.page.total === 0 ? <p className="muted empty">{t.noOffers} <a href={href(worldId, 'channels', 'accounts')}>{m.ui.app.connectChannel}</a></p> : <>
      {/*
        Шаг 178 (#39, уточнение Р-140): фильтры Offers, выбор, который переживает страницы и фильтры, и строка выбора — те же, что у правки
        границ; таблица — предложение, его стратегия и режим, снятие стратегии
      */}
      {onOfferQuery && offerQuery ? (
        <form className="filters toolbar field-toolbar" onSubmit={(e) => { e.preventDefault(); onOfferQuery({ ...offerQuery, q: search.trim() }); }}>
          <OfferFilterFields storefronts={view.filters?.storefronts ?? []} query={offerQuery} onQuery={onOfferQuery} search={search} onSearch={setSearch} holder={false} />
        </form>
      ) : null}
      {view.matched !== null && view.matched !== undefined && !review ? <Help className="section-sub" text={m.ui.products.filters.matched(view.matched, view.catalogTotal ?? view.page.total)} /> : null}
      {/* Шаг 189 (#27, пункт 17): строка выбора держится над списком, пока листаются его строки */}
      <SelectionScope line={<SelectionBar summary={summary} selection={selection} onSelection={onSelection} filter={filter} matching={view.matched ?? view.page.total} storefronts={view.filters?.storefronts ?? []}
        review={review !== null} onReview={(on) => setReview(on ? { offset: 0, limit: LIST_PAGE_DEFAULT } : null)} disabled={busy} />}>
      {review ? (
        <>
          <h4>{m.ui.selection.reviewTitle}</h4>
          <BoundsIndexView worldId={worldId} items={summary?.review?.items ?? []} embedded heading={false} filtered
            pick={{ picked: (id) => !selection.except.includes(id), onToggle: (id, on) => onSelection(toggleOffer(selection, id, on, true)), canPick: canPickMore(selection), disabled: busy }} />
          {summary?.review ? <Pager page={summary.review.page} query={review} onQuery={setReview} /> : null}
        </>
      ) : (
        <div className="table-wrap">
          <table className="cardify selectable strategy-picks">
            <thead><tr><th className="pick"><span className="visually-hidden">{t.columns.offer}</span></th><th>{t.columns.offer}</th><th>{t.pickColumns.strategy}</th><th /></tr></thead>
            <tbody>
              {view.scopes.map((sc) => {
                const id = sc.unit.writeScopeId;
                const on = isPicked(selection, summary, id);
                return (
                  <tr key={id} className={on ? 'picked' : undefined}>
                    <td className="pick">
                      <RowCheck label={m.ui.selection.pick(sc.unit.label)} checked={on} disabled={busy || !sc.assignable || (!on && !canPickMore(selection))}
                        title={!sc.assignable ? t.notAssignable : !on && !canPickMore(selection) ? m.ui.selection.limit(MAX_PICKED) : undefined}
                        onChange={(next) => onSelection(toggleOffer(selection, id, next, on))} />
                    </td>
                    {/* Шаг 175 (QA-A Testing 2.0, этап 4): в выборе — цвет и идентификатор: варианты одного товара различимы */}
                    <td className="offer card-title"><UnitName unit={sc.unit} variant={false} /><ProductRef unit={sc.unit} />
                      {sc.channelPricing ? <div className="small pick-note"><Badge tone={sc.channelPricing.tone}>{t.notAssignable}</Badge> {sc.channelPricing.detail}</div> : null}</td>
                    <td data-label={t.pickColumns.strategy}>{sc.strategy}<div className="muted small">{sc.mode}{sc.byDefaultRule ? ` · ${sc.byDefaultRule}` : ''}</div></td>
                    <td className="card-action">{sc.canUnassign ? <button type="button" className="pick-action" disabled={busy} onClick={() => { setRemoving(sc); setMessage(null); }}>{t.unassign}</button> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {review ? null : <Pager page={view.page} query={pageQuery ?? { offset: 0, limit: LIST_PAGE_DEFAULT }} onQuery={(q) => onPage?.(q)} />}
      </SelectionScope>
      {(() => {
        const nothing = selectedCount === 0;
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
      {/* Шаг 174 (BUG-01): назначение завершилось — список стратегий (число предложений, последнее изменение) перечитывается сам */}
      {jobId ? <JobProgress worldId={worldId} jobId={jobId} started={started} onFinished={(job) => { if (job.status === 'SUCCEEDED') onChanged?.(); }} /> : null}
      {preview ? <PreviewTable view={preview} worldId={worldId} jobId={previewJobId} /> : null}
      <Gaps gaps={view.gaps} />
      <span id="strategy-import" />
      <ImportPanel worldId={worldId} kind="STRATEGY" canEdit={view.canEdit} />
    </section>
  );
}

export function StrategiesScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  // Шаг 178 (#39): фильтры и поиск Offers у списка назначения — по всему каталогу
  const [offerQuery, setOfferQuery] = useState<OfferUiQuery>(NO_OFFER_QUERY);
  const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit), ...filterOfUi(offerQuery) });
  // Шаг 174: перечитывание после назначения держит прежний список на экране — редактор с итогом задания не размонтируется
  const [resource, retry] = useResource<StrategyListView & StrategyFilterInfo>(`${worldPath(worldId, 'strategies')}?${params.toString()}`, m.locale, { keepPrevious: true });
  return (
    <Load shape="cards" resource={resource} retry={retry}>
      {(view) => <StrategiesScreenView view={view} worldId={worldId} onChanged={retry} offerQuery={offerQuery}
        onOfferQuery={(q) => { setOfferQuery(q); setQuery({ ...query, offset: 0 }); }} pageQuery={query} onPage={setQuery} />}
    </Load>
  );
}
