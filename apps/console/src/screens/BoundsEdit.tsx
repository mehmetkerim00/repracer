import { useEffect, useState } from 'react';
import { LIST_PAGE_DEFAULT, parseAmountInput, parsePercentInput, type BoundAdjust, type BoundsDiffView, type ListQuery, type OfferSelection } from '@repracer/console-model';
import type { BoundsPlanRowsView, JobCreatedResponse } from '../api-types.ts';
import { requestJson, worldPath } from '../api.ts';
import { ErrorBox, errorText, Gaps, Pager, ProductRef, StickySummary, UnitName, useMessages } from '../components.tsx';
import { Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';
import type { BulkJobView } from '@repracer/console-model';
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

/**
 * Шаг 177 (уточнение Р-140, (г)): предпросмотр перечисляет ВСЕ затрагиваемые предложения — включая выбранные вне текущего фильтра:
 * первая страница — строки вида (с пометками первыми), следующие — из итога задания плана тем же порядком
 */
export function BoundsDiffTable({ view, worldId, planJobId }: { view: BoundsDiffView; worldId?: string; planJobId?: string | null }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  const c = t.columns;
  const [page, setPage] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [more, setMore] = useState<BoundsPlanRowsView | null>(null);
  const paged = Boolean(worldId && planJobId) && view.summary.scopes > view.rows.length;
  useEffect(() => {
    if (!paged || page.offset === 0) { setMore(null); return; }
    let alive = true;
    requestJson<BoundsPlanRowsView>(`${worldPath(worldId!, 'bounds', 'plan', planJobId!)}?offset=${page.offset}&limit=${page.limit}`, { locale: m.locale })
      .then((x) => { if (alive) setMore(x); }).catch(() => { if (alive) setMore(null); });
    return () => { alive = false; };
  }, [paged, worldId, planJobId, page.offset, page.limit, m.locale]);
  const rows = page.offset === 0 || !more ? view.rows : more.rows;
  const total = view.summary.scopes;
  const pageInfo = { from: total === 0 ? 0 : page.offset + 1, to: Math.min(page.offset + page.limit, total), total,
    text: m.ui.feed.page(total === 0 ? 0 : page.offset + 1, Math.min(page.offset + page.limit, total), total), hasPrevious: page.offset > 0, hasNext: page.offset + page.limit < total };
  return (
    <section className="diff">
      <h4>{m.ui.selection.planAll(total)}</h4>
      {/* Шаг 163 (#27): числа экрана различий — полосой, которая держится под шапкой, пока листаются строки; прежняя фраза — те же числа */}
      <StickySummary label={t.statsLabel} chips={([
        ['offers', view.summary.scopes, false], ['changed', view.summary.changed, true], ['unchanged', view.summary.unchanged, false],
        ['flagged', view.summary.flagged, true], ['pricesOutside', view.summary.pricesOutside, true],
      ] as const).map(([key, value, on]) => ({ key, label: t.stats[key], value, on }))} />
      {view.mfaRequired ? <p className="notice">{t.mfa}</p> : null}
      <div className="table-wrap">
        <table>
          {/* Шаг 189 (#27, пункт 3): подписи сумм — числовые, над своими числами (правило смоука NUM_ALIGN узнаёт колонку по ячейкам) */}
          <thead><tr><th>{c.offer}</th><th className="num">{c.minBefore}</th><th className="num">{c.minAfter}</th><th className="num">{c.maxBefore}</th><th className="num">{c.maxAfter}</th><th className="num">{c.price}</th><th>{c.notes}</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              // Шаг 167, шаг 168: строка с пометкой внимания — подсвечена целиком (класс строки, как на Offers и Inventory)
              <tr key={r.unit.writeScopeId} className={r.tone === 'warn' ? 'attention' : undefined}>
                {/* Шаг 79 (ревью): предложение — текстом; что именно требует внимания — в колонке пометок */}
                <td className="offer"><UnitName unit={r.unit} variant={false} /><ProductRef unit={r.unit} /></td>
                <td className="num cur">{r.minBefore}</td>
                <td className="num cur">{r.minAfter}{r.minChange ? <div className="small muted">{r.minChange}</div> : null}</td>
                <td className="num cur">{r.maxBefore}</td>
                <td className="num cur">{r.maxAfter}{r.maxChange ? <div className="small muted">{r.maxChange}</div> : null}</td>
                <td className="num cur">{r.currentPrice}</td>
                <td>{r.flags.length === 0 ? '–' : <ul className="small">{r.flags.map((f) => <li key={f.code}>{f.text}</li>)}</ul>}</td>
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

export function BoundsEditPanel({ worldId, selection, selected, canEdit, onApplied }: { worldId: string; selection: OfferSelection; selected: number; canEdit: boolean; onApplied?: () => void }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  if (!canEdit) return <section className="bounds-edit"><h3>{t.pageTitle}</h3><p className="notice">{t.noRight}</p></section>;
  return <BoundsEditForm worldId={worldId} selection={selection} selected={selected} onApplied={onApplied} />;
}

function BoundsEditForm({ worldId, selection, selected, onApplied }: { worldId: string; selection: OfferSelection; selected: number; onApplied?: () => void }) {
  const m = useMessages();
  const t = m.ui.boundsEdit;
  const [min, setMin] = useState<AdjustForm>({ mode: 'KEEP', value: '' });
  const [max, setMax] = useState<AdjustForm>({ mode: 'KEEP', value: '' });
  const [diff, setDiff] = useState<{ view: BoundsDiffView; planJobId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Шаг 174 (BUG-05): фраза запуска применения — в карточке задания, пока оно идёт (`JobProgress started`) */
  const [started, setStarted] = useState<string | null>(null);
  /** Р-139: применение идёт фоновым заданием — экран показывает его ход, а не ждёт ответа */
  const [jobId, setJobId] = useState<string | null>(null);
  const [planJobId, setPlanJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => { setDiff(null); setStarted(null); setJobId(null); setPlanJobId(null); };
  /**
   * Шаг 177 (#39, уточнение Р-140): выбор переживает страницы и фильтры и виден всегда счётчиком над таблицей; изменился выбор — экран
   * различий сброшен: применяется ровно то, что посчитано по нынешнему выбору
   */
  const selectionKey = JSON.stringify(selection);
  const [shownSelection, setShownSelection] = useState(selectionKey);
  if (shownSelection !== selectionKey) { setShownSelection(selectionKey); reset(); }

  const request = (): Record<string, unknown> | string => {
    const a = adjustOf(min);
    const b = adjustOf(max);
    if (a === null) return t.badInput(min.value);
    if (b === null) return t.badInput(max.value);
    // Шаг 177: выбор раскрывает сервер — отмеченные, «все подходящие» и снятые; перечень каталога в тело запроса не помещается (шаг 29)
    return { selection, ...(a ? { min: a } : {}), ...(b ? { max: b } : {}) };
  };
  /**
   * Задача D шага 31: экран различий считает фоновое задание — по всему выбору, а не по странице. Экран берёт готовый ответ из итога
   * задания, и он же ссылается на это задание при применении: применяется ровно посчитанное, без второго расчёта.
   */
  const plan = async () => {
    setError(null); setStarted(null); setDiff(null);
    const r = request();
    if (typeof r === 'string') return setError(r);
    setBusy(true);
    try {
      const created = await requestJson<JobCreatedResponse>(worldPath(worldId, 'bounds', 'plan'), { method: 'POST', body: { request: r }, locale: m.locale });
      setPlanJobId(created.jobId);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  const planReady = (job: BulkJobView) => {
    const result = job.result as { view?: BoundsDiffView } | null;
    // Шаг 174 (BUG-02): отказ задания называет карточка задания — второй раз формой он не повторяется
    if (job.status === 'SUCCEEDED' && result?.view && planJobId) setDiff({ view: result.view, planJobId });
  };
  const apply = async () => {
    if (!diff) return;
    setBusy(true); setError(null);
    try {
      const r = await requestJson<JobCreatedResponse>(worldPath(worldId, 'bounds', 'apply'), { method: 'POST', body: { planJobId: diff.planJobId, planToken: diff.view.planToken, confirmed: true }, locale: m.locale });
      // Задание экрана различий тоже забывается: иначе после применения различия вернутся и позовут применить ещё раз
      setStarted(r.message); setJobId(r.jobId); setDiff(null); setPlanJobId(null);
    } catch (e) { setError(errorText(e, m)); } finally { setBusy(false); }
  };
  // Шаг 94: граница — два поля стандарта: что сделать (подпись — имя границы) и значение (подпись — сумма или процент)
  const adjust = (label: string, value: AdjustForm, onChange: (v: AdjustForm) => void) => (
    <>
      <Field label={label}>
        <select value={value.mode} onChange={(e) => { onChange({ ...value, mode: e.target.value as AdjustForm['mode'] }); reset(); }}>
          <option value="KEEP">{t.keep}</option><option value="SET">{t.set}</option><option value="PERCENT">{t.percent}</option>
        </select>
      </Field>
      {value.mode !== 'KEEP' ? (
        <Field label={value.mode === 'SET' ? t.amountLabel : t.percentLabel}>
          <input inputMode="decimal" value={value.value} onChange={(e) => { onChange({ ...value, value: e.target.value }); reset(); }} />
        </Field>
      ) : <div aria-hidden="true" />}
    </>
  );

  return (
    <section className="bounds-edit">
      <h3>{t.pageTitle}</h3>
      {/* Шаг 177 (#39): что выбрано — счётчиком над таблицей; здесь — что сделать с выбранным */}
      <FieldGroup title={t.select}>
      <FieldGrid cols={4}>{adjust(t.minPrice, min, setMin)}{adjust(t.maxPrice, max, setMax)}</FieldGrid>
      {(() => {
        /**
         * Шаг 175 (QA-A Testing 2.0, этап 4): Preview и Apply неактивны, когда менять нечего, и говорят почему: не выбрано предложение, не выбрано,
         * что менять, или все выбранные уже с этими границами
         */
        const why = selected === 0 ? m.ui.forms.why.selectOffers
          : min.mode === 'KEEP' && max.mode === 'KEEP' ? t.problems.NOTHING_TO_CHANGE : null;
        const applyWhy = diff !== null && diff.view.summary.changed === 0 ? t.nothingWouldChange : null;
        return (
          <FormActions inline hint={diff === null ? why : applyWhy}>
            {diff === null
              ? <button type="button" className="primary" disabled={busy || why !== null} title={why ?? undefined} onClick={() => void plan()}>{t.plan}</button>
              : <><button type="button" className="primary" disabled={busy || applyWhy !== null} title={applyWhy ?? undefined} onClick={() => void apply()}>{t.apply}</button><button type="button" disabled={busy} onClick={reset}>{t.back}</button></>}
          </FormActions>
        );
      })()}
      </FieldGroup>
      {error ? <ErrorBox message={error} /> : null}
      {planJobId && !diff ? <JobProgress worldId={worldId} jobId={planJobId} onFinished={planReady} /> : null}
      {/* Шаг 174 (BUG-01): применение завершилось — таблица границ и список выбора перечитываются сами, без перезагрузки страницы */}
      {jobId ? <JobProgress worldId={worldId} jobId={jobId} started={started} onFinished={(job) => { if (job.status === 'SUCCEEDED') onApplied?.(); }} /> : null}
      {diff ? <BoundsDiffTable view={diff.view} worldId={worldId} planJobId={diff.planJobId} /> : null}
    </section>
  );
}
