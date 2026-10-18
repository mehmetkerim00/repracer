import { useState } from 'react';
import { LIST_PAGE_DEFAULT, parseAmountInput, type BoundsView, type ListQuery, type PriceBreakdown } from '@repracer/console-model';
import type { BoundsIndexItem, BoundsIndexView as BoundsIndexData } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, DateTimeField, errorText, Gaps, href, Load, NotFound, Pager, SectionAnchor, useMessages } from '../components.tsx';
import { CheckField, Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';
import { BoundsEditPanel } from './BoundsEdit.tsx';

/**
 * Шаг 102 [Р-227]: режим распродажи — осознанная продажа ниже безубыточности. Форма считает убыток на штуку и общий при текущем
 * остатке по мере ввода (безубыточность − пол распродажи); включает база, если есть подтверждение, записка и второй фактор
 */
function ClearanceSection({ view, onChanged }: { view: BoundsView; onChanged: () => void }) {
  const m = useMessages();
  const t = m.ui.bounds.clearance;
  const c = view.clearance;
  const [floor, setFloor] = useState('');
  const [ack, setAck] = useState(false);
  const [note, setNote] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const floorMinor = parseAmountInput(floor);
  const loss = floorMinor !== null && c.breakEvenMinor !== null && c.breakEvenMinor > floorMinor ? c.breakEvenMinor - floorMinor : null;
  const money = (v: number) => m.money(v, c.currency);
  const post = async (path: string[], body: Record<string, unknown>) => {
    setBusy(true); setError(null); setMessage(null);
    try {
      const r = await requestJson<{ message: string }>(worldPath(view.worldId, 'bounds', view.unit.writeScopeId, ...path), { method: 'POST', body, locale: m.locale });
      setMessage(r.message);
      onChanged();
    } catch (e) {
      setError(errorText(e, m));
    } finally {
      setBusy(false);
    }
  };
  const enable = () => void post(['clearance'], {
    floorMinor, acknowledged: ack, note, endsAt: endsAt === '' ? null : new Date(endsAt).toISOString(),
  });
  const why = floorMinor === null ? t.causes.FLOOR_INVALID : !ack ? t.causes.ACK_REQUIRED : note.trim() === '' ? t.causes.NOTE_REQUIRED : null;
  return (
    <section className="card clearance">
      <h3>{t.title}{c.pill ? <> <Badge tone="warn">{c.pill}</Badge></> : null}</h3>
      <p className="section-sub">{t.intro}</p>
      {c.active ? (
        <>
          <ul className="plain clearance-state">
            <li><strong>{t.on}: {c.active.floor}</strong></li>
            <li>{t.breakEven}{m.colon}{c.breakEven ?? t.breakEvenUnknown}</li>
            <li>{t.lossPerUnit}{m.colon}<strong>{c.active.lossPerUnit ? `−${c.active.lossPerUnit}` : t.noLoss}</strong></li>
            {c.active.lossPerUnit ? <li>{t.maxLoss}{m.colon}{c.active.maxLoss ? <><strong>−{c.active.maxLoss}</strong> <span className="muted small">({t.stock(c.stockPieces ?? 0)})</span></> : <span className="muted">{t.stockUnknown}</span>}</li> : null}
            <li>{c.active.by}</li>
            <li>{t.onNote(c.active.note)}</li>
            {c.active.endsAt ? <li>{t.onEnds(c.active.endsAt)}</li> : null}
          </ul>
          {c.canManage ? (
            <FormActions hint={c.returns}>
              <button type="button" disabled={busy} onClick={() => void post(['clearance', 'disable'], {})}>{t.disable}</button>
            </FormActions>
          ) : null}
        </>
      ) : c.canManage ? (
        <FieldGroup>
          <FieldGrid cols={3}>
            <Field label={`${t.floor} (${c.currency})`} caption={t.floorHint}>
              <input type="text" inputMode="decimal" value={floor} disabled={busy} onChange={(e) => setFloor(e.target.value)} />
            </Field>
            <Field label={t.breakEven} caption={c.breakEven === null ? t.breakEvenUnknown : null}><output className="field-value">{c.breakEven ?? m.ui.common.noValue}</output></Field>
            <Field label={t.lossPerUnit} caption={loss !== null ? (c.stockPieces !== null ? `${t.maxLoss}: −${money(loss * c.stockPieces)} ${t.stock(c.stockPieces)}` : t.stockUnknown) : null}>
              <output className="field-value">{floorMinor === null ? m.ui.common.noValue : loss === null ? t.noLoss : `−${money(loss)}`}</output>
            </Field>
          </FieldGrid>
          <CheckField label={t.ack(c.breakEven ?? m.ui.common.noValue)} checked={ack} disabled={busy} onChange={setAck} />
          <FieldGrid cols={2}>
            <Field label={t.note} caption={t.noteHint}>
              <input type="text" value={note} placeholder={t.notePlaceholder} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field label={t.endsAt} caption={t.endsAtHint}><DateTimeField value={endsAt} onChange={setEndsAt} /></Field>
          </FieldGrid>
          <FormActions hint={why ?? t.mfaHint}>
            <button type="button" className="primary" disabled={busy || why !== null} title={why ?? undefined} onClick={enable}>{t.enable}</button>
          </FormActions>
        </FieldGroup>
      ) : <p className="muted">{t.readOnly}</p>}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {c.history.length > 0 ? (
        <details className="clearance-history">
          <summary>{t.history}</summary>
          <div className="table-wrap">
            <table className="dense cardify">
              <thead><tr><th>{t.columns.when}</th><th>{t.columns.what}</th><th>{t.columns.who}</th><th>{t.columns.note}</th></tr></thead>
              <tbody>
                {c.history.map((h, n) => (
                  <tr key={n}>
                    <td className="nowrap card-title">{h.at}</td>
                    <td data-label={t.columns.what}>{h.what}</td>
                    <td data-label={t.columns.who}>{h.who}</td>
                    <td data-label={t.columns.note}>{h.note ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

export function BreakdownTable({ breakdown, currency }: { breakdown: PriceBreakdown; currency: string }) {
  const m = useMessages();
  const b = m.ui.bounds;
  return (
    <div className="breakdown">
      <h3>{breakdown.title}</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{b.columns.part}</th><th className="num">{b.columns.amount(currency)}</th><th>{b.columns.formula}</th></tr></thead>
          <tbody>
            {breakdown.lines.map((l) => (
              <tr key={l.key} className={`line-${l.key}`}>
                <td>{l.label}</td>
                <td className="num cur">{l.amount}</td>
                <td className="small">{l.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Шаг 79: как читать разбивку — подвалом таблицы */}
        <p className="table-foot">{b.exactMargin(breakdown.marginExact)} {b.balance(breakdown.balanced)} {breakdown.note}.</p>
      </div>
    </div>
  );
}

export function BoundsScreenView({ view, onChanged = () => undefined }: { view: BoundsView; onChanged?: () => void }) {
  const m = useMessages();
  const b = m.ui.bounds;
  return (
    <section>
      <p className="back"><a href={href(view.worldId, 'costs')}>{b.back}</a></p>
      <h2>{b.pageTitle}{view.clearance.pill ? <> <Badge tone="warn">{view.clearance.pill}</Badge></> : null}</h2>
      <p className="subtitle">{view.unit.label} · {view.currency}, {view.priceBasis} · {view.taxRegime}</p>
      {/* Шаг 96 (аудит В20): из разбивки пола — сразу в правку границ с этим предложением */}
      <p className="page-actions"><a className="button-link" href={href(view.worldId, 'costs', 'edit', view.unit.writeScopeId)}>{b.changeFloor}</a></p>
      {/* Шаг 102 [Р-227]: пол выше потолка — ни одна цена не проходит; продавцу видно, почему цены стоят, и что сделать */}
      {view.frozen ? <p className="notice frozen" role="status">{view.frozen}</p> : null}
      <div className="cards">
        <div className="card emphasis"><h3>{b.effectiveFloor}</h3><p className="big">{view.effectiveFloor.amount}</p><p className="small muted">{view.effectiveFloor.source}</p></div>
        <div className="card"><h3>{b.minPrice}</h3><p className="big">{view.minPrice.amount}</p><p className="small muted">{view.minPrice.source}</p></div>
        <div className="card">
          <h3>{b.minMargin}</h3>
          {view.marginFloor.minMarginBp === null
            ? <p className="muted">{b.marginNotSet}</p>
            : <><p className="big">{view.marginFloor.amount ?? m.ui.common.noValue}</p><p className="small muted">{b.marginAtLeast(view.marginFloor.minMarginBp)}{view.marginFloor.unavailable ? `: ${view.marginFloor.unavailable}` : ''}</p></>}
        </div>
        <div className="card"><h3>{b.maxPrice}</h3><p className="big">{view.maxPrice.amount}</p><p className="small muted">{view.maxPrice.source}</p></div>
      </div>

      <ClearanceSection view={view} onChanged={onChanged} />

      {/* Шаг 79: себестоимость и комиссии — карточкой */}
      <section className="card">
        <h3>{b.costAndFees}</h3>
        {view.cost.unavailable ? <p className="gap-note">{view.cost.unavailable}</p> : (
          <ul className="plain cost-lines">
            {view.cost.lines.map((l) => <li key={l.key}>{l.label}{m.colon}<strong>{l.amount}</strong> <span className="small muted">({l.formula})</span></li>)}
          </ul>
        )}
        {view.feeEstimates.length > 0 ? (
          <ul className="fee-estimates plain">
            {/* Р-138: число продавца и тарифная таблица — рядом; помечено то, по которому считается пол */}
            {view.feeEstimates.map((f) => (
              <li key={f.source} className={f.used ? 'used' : 'muted'}>{f.text}{f.used ? ` — ${b.feeUsed}` : ''}</li>
            ))}
          </ul>
        ) : null}
      </section>

      {view.floorBreakdown ? <BreakdownTable breakdown={view.floorBreakdown} currency={view.currency} /> : null}
      {view.currentBreakdown ? <BreakdownTable breakdown={view.currentBreakdown} currency={view.currency} /> : null}

      <section className="card">
        <h3>{b.calculator}</h3>
        <ol>{view.calculatorCheck.map((c) => <li key={c}>{c}</li>)}</ol>
      </section>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function BoundsIndexView({ worldId, items, embedded = false }: { worldId: string; items: readonly BoundsIndexItem[]; embedded?: boolean }) {
  const m = useMessages();
  const c = m.ui.bounds.indexColumns;
  return (
    <section>
      {/* Шаг 86: заголовок страницы — тот же текст, что пункт меню; шаг 95 [Р-217] — список границ разделом Costs & floors */}
      {embedded ? <h3>{m.ui.costs.boundsTitle}</h3> : <h2>{m.ui.app.screens.bounds}</h2>}
      <p className={embedded ? 'section-sub' : 'subtitle'}>{m.ui.app.subtitles.bounds}</p>
      {/* Задача D шага 34: пустой тенант видит, почему пусто и куда идти */}
      {items.length === 0 ? <p className="notice">{m.ui.onboarding.empty.bounds} <a href={href(worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      {/* Шаг 79 (ревью): список границ — таблицей с шапкой и зеброй; суммы — вправо, ссылка на разбивку пола — в своей колонке */}
      {items.length === 0 ? null : (
        <div className="table-wrap">
          <table className="cardify">
            <thead><tr><th>{c.offer}</th><th className="num">{c.min}</th><th className="num">{c.max}</th><th /></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.writeScopeId}>
                  <td className="offer card-title"><a href={href(worldId, 'bounds', i.writeScopeId)}>{i.label}</a></td>
                  <td className="num money cur" data-label={c.min}>{i.minPrice}</td>
                  <td className="num money cur" data-label={c.max}>{i.maxPrice}</td>
                  <td className="num card-action"><a className="row-link" href={href(worldId, 'bounds', i.writeScopeId)}>{c.floor}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Шаг 95 [Р-217]: страница одного предложения «Bounds and price floor» — своим адресом; список границ — раздел Costs & floors */
export function BoundsScreen({ worldId, writeScopeId }: { worldId: string; writeScopeId: string }) {
  return <BoundsDetail worldId={worldId} writeScopeId={writeScopeId} />;
}

export function BoundsIndex({ worldId, preselect = null, focusEdit = false }: { worldId: string; preselect?: string | null; focusEdit?: boolean }) {
  const m = useMessages();
  // Р-136: страница списка; массовая правка применяется к показанной странице — выбор продавца всегда виден на экране
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<BoundsIndexData>(`${worldPath(worldId, 'bounds')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
  return (
    <Load shape="table" resource={resource} retry={retry}>
      {(view) => (
        <>
          <BoundsIndexView worldId={worldId} items={view.items} embedded />
          <Pager page={view.page} query={query} onQuery={setQuery} />
          {/* Шаг 79 (ревью): массовая правка на ноль предложений — не форма, её просто нет */}
          {view.page.total === 0 ? null : <><SectionAnchor id="bounds-edit" focus={focusEdit} /><BoundsEditPanel worldId={worldId} items={view.items} total={view.page.total} canEdit={view.canEdit} preselect={preselect} /></>}
        </>
      )}
    </Load>
  );
}

function BoundsDetail({ worldId, writeScopeId }: { worldId: string; writeScopeId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<BoundsView>(worldPath(worldId, 'bounds', writeScopeId), m.locale);
  const missing = <NotFound title={m.ui.bounds.missingTitle} text={m.ui.bounds.missingText} back={m.ui.bounds.back} href={href(worldId, 'costs')} />;
  return <Load shape="cards" resource={resource} retry={retry} notFound={missing}>{(view) => <BoundsScreenView view={view} onChanged={retry} />}</Load>;
}
