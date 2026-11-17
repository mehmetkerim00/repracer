import { useState } from 'react';
import { LIST_PAGE_DEFAULT, parseAmountInput, type BoundsView, type ListQuery, type PriceBreakdown } from '@repracer/console-model';
import type { BoundsIndexItem, BoundsIndexView as BoundsIndexData } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, Cell, DateTimeField, errorText, Gaps, Help, href, Load, NotFound, Pager, SectionAnchor, UnitName, useMessages } from '../components.tsx';
import { CheckField, Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';
import { BoundsEditPanel } from './BoundsEdit.tsx';

/** Шаг 149 (#27, скрин владельца): пустое значение поля — нейтральный прочерк, а не «no value»; почему пусто — подписью поля */
const EMPTY = '–';

/**
 * Шаг 102 [Р-227]: режим распродажи — осознанная продажа ниже безубыточности. Форма считает убыток на штуку и общий при текущем
 * остатке по мере ввода (безубыточность − пол распродажи); включает база, если есть подтверждение, записка и второй фактор
 */
function ClearanceSection({ view, onChanged }: { view: BoundsView; onChanged: () => void }) {
  const m = useMessages();
  const t = m.ui.bounds.clearance;
  const c = view.clearance;
  const [floor, setFloor] = useState('');
  // Шаг 107 [Р-233]: галочка относится к тексту, который продавец видел, — появился конфликт с Min канала, и прежняя галочка не считается
  const [ackedLabel, setAckedLabel] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const floorMinor = parseAmountInput(floor);
  const loss = floorMinor !== null && c.breakEvenMinor !== null && c.breakEvenMinor > floorMinor ? c.breakEvenMinor - floorMinor : null;
  const money = (v: number) => m.money(v, c.currency);
  // Шаг 107 (G) [Р-233]: пол распродажи ниже Min, заданного продавцом в канале, — предупреждение до галочки; распродажа не блокируется
  const channelMin = view.channelBounds.channelMinMinor;
  const belowChannelMin = floorMinor !== null && channelMin !== null && floorMinor < channelMin;
  const ackLabel = belowChannelMin ? t.ackWithChannel(c.breakEven ?? m.ui.common.noValue, money(channelMin!)) : t.ack(c.breakEven ?? m.ui.common.noValue);
  const ack = ackedLabel === ackLabel;
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
  // Шаг 140 [Р-227]: без посчитанной безубыточности убыток не назвать — включение закрыто, путь к себестоимости и комиссии — ссылкой
  const noBreakEven = c.breakEvenMinor === null;
  const why = noBreakEven ? t.causes.BREAK_EVEN_UNKNOWN : floorMinor === null ? t.causes.FLOOR_INVALID : !ack ? t.causes.ACK_REQUIRED : note.trim() === '' ? t.causes.NOTE_REQUIRED : null;
  return (
    <section className="card clearance">
      <h3>{t.title}{c.pill ? <> <Badge tone="warn">{c.pill}</Badge></> : null}</h3>
      <Help className="section-sub" text={t.intro} />
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
            <Field label={t.breakEven} caption={c.breakEven === null ? t.breakEvenUnknown : null}><output className={`field-value${c.breakEven === null ? ' muted' : ''}`}>{c.breakEven ?? EMPTY}</output></Field>
            <Field label={t.lossPerUnit} caption={loss !== null ? (c.stockPieces !== null ? `${t.maxLoss}: −${money(loss * c.stockPieces)} ${t.stock(c.stockPieces)}` : t.stockUnknown) : null}>
              <output className={`field-value${floorMinor === null ? ' muted' : ''}`}>{floorMinor === null ? EMPTY : loss === null ? t.noLoss : `−${money(loss)}`}</output>
            </Field>
          </FieldGrid>
          {belowChannelMin ? <p className="notice warn channel-min-warning" role="alert">{t.channelMinWarning(money(floorMinor!), money(channelMin!))}</p> : null}
          <CheckField label={ackLabel} checked={ack} disabled={busy} onChange={(v) => setAckedLabel(v ? ackLabel : null)} />
          <FieldGrid cols={2}>
            <Field label={t.note} caption={t.noteHint}>
              <input type="text" value={note} placeholder={t.notePlaceholder} maxLength={500} disabled={busy} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field label={t.endsAt} caption={t.endsAtHint}><DateTimeField value={endsAt} onChange={setEndsAt} /></Field>
          </FieldGrid>
          <FormActions hint={why ?? t.mfaHint}>
            <button type="button" className="primary" disabled={busy || why !== null} title={why ?? undefined} onClick={enable}>{t.enable}</button>
            {noBreakEven ? <a className="break-even-fill" href={href(view.worldId, 'cost-import')}>{t.addCosts}</a> : null}
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

/**
 * Шаг 107 [Р-233, Р-231]: рамки цены, заданные продавцом в самом канале (Amazon Min/Max на SKU), рядом с нашими: значения и «без доставки»,
 * честное «not provided» без данных канала и предупреждение — ровно при конфликте (наш пол ниже Min канала, наш потолок выше Max канала)
 */
function ChannelBoundsSection({ view }: { view: BoundsView }) {
  const m = useMessages();
  const b = m.ui.bounds.channelBounds;
  const c = view.channelBounds;
  return (
    <section className="card channel-bounds">
      <h3>{c.title}</h3>
      <Help className="section-sub" text={c.lead} />
      {c.state === 'VALUES' ? (
        <>
          <ul className="plain channel-bounds-values">
            <li>{b.min}{m.colon}<strong className="cur">{c.min}</strong></li>
            <li>{b.max}{m.colon}<strong className="cur">{c.max}</strong></li>
          </ul>
          <p className="small muted">{c.text} {c.seen}</p>
        </>
      ) : <p className="muted">{c.text}</p>}
      {c.conflicts.map((x) => <p key={x.side} className="notice warn channel-bounds-conflict" role="status">{x.text}</p>)}
      {c.ok ? <p className="small">{c.ok}</p> : null}
    </section>
  );
}

/**
 * Шаг 153 (#29): как читать разбивку — один раз на странице: при двух разбивках (пол и текущая цена) сходимость и округление говорит
 * последняя (`foot`), первая — только точную маржу и, если не сошлось, это. Расхождение не прячется никогда
 */
export function BreakdownTable({ breakdown, currency, foot = true }: { breakdown: PriceBreakdown; currency: string; foot?: boolean }) {
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
        <p className="table-foot">{b.exactMargin(breakdown.marginExact)}{foot ? ` ${b.balance(breakdown.balanced)} ${breakdown.note}.` : breakdown.balanced ? '' : ` ${b.balance(false)}`}</p>
      </div>
    </div>
  );
}

export function BoundsScreenView({ view, onChanged = () => undefined }: { view: BoundsView; onChanged?: () => void }) {
  const m = useMessages();
  const b = m.ui.bounds;
  // Шаг 149: раскрытие — по модели (есть что объяснить), дальше — выбор зрителя на этой странице
  const [calcOpen, setCalcOpen] = useState(view.calculationOpen);
  return (
    <section>
      <p className="back"><a href={href(view.worldId, 'costs')}>{b.back}</a></p>
      <h2>{b.pageTitle}{view.clearance.pill ? <> <Badge tone="warn">{view.clearance.pill}</Badge></> : null}</h2>
      <p className="subtitle">{view.unit.label} · {view.currency}, {view.priceBasis} · {view.taxRegime}</p>
      {/* Шаг 96 (аудит В20): из разбивки пола — сразу в правку границ с этим предложением */}
      <p className="page-actions"><a className="button-link" href={href(view.worldId, 'costs', 'edit', view.unit.writeScopeId)}>{b.changeFloor}</a></p>
      {/* Шаг 102 [Р-227]: пол выше потолка — ни одна цена не проходит; продавцу видно, почему цены стоят, и что сделать */}
      {view.frozen ? <p className="notice frozen" role="status">{view.frozen}</p> : null}
      {/*
        Шаг 149 (#27, Р-254): сверху — главное: действующий пол, текущая цена, статус (тот же, что на Offers) и максимальная цена; рядом — рамки
        цены канала с их предупреждениями. На ≥ 1012 px — две колонки, ниже — одна
      */}
      <div className="floor-top">
        <section className="card floor-glance">
          <h3>{b.glance}</h3>
          <div className="verdict-price">{view.effectiveFloor.amount}</div>
          <p className="small muted">{b.effectiveFloor} · {view.effectiveFloor.source}</p>
          <dl className="receipt-summary">
            <div><dt>{m.ui.products.columns.current}</dt><dd className={view.current.missing ? 'muted' : 'cur'}>{view.current.amount}</dd></div>
            <div><dt>{m.ui.products.columns.status}</dt><dd><Cell cell={view.status} /></dd></div>
            <div><dt>{b.maxPrice}</dt><dd className={view.maxPrice.minor === null ? 'muted' : 'cur'}>{view.maxPrice.minor === null ? m.ui.products.notSet : view.maxPrice.amount}</dd></div>
          </dl>
          {/* Шаг 149 (шаг 142): распродажа без действующей оценки комиссии — подписанный убыток может быть устаревшим */}
          {view.feeExpired ? <p className="notice warn fee-expired" role="status">{view.feeExpired}</p> : null}
        </section>
        <ChannelBoundsSection view={view} />
      </div>

      <ClearanceSection view={view} onChanged={onChanged} />

      {/*
        Шаг 149: расчёт пола — составляющие (минимальная цена, минимальная маржа, себестоимость и комиссии, разбивки, калькулятор) — панелью.
        Свёрнута, кроме случаев, когда в ней есть что объяснить; содержимое свёрнутой — на странице
      */}
      <details className="card more-block calc" open={calcOpen} onToggle={(e) => setCalcOpen(e.currentTarget.open)}>
        <summary>{b.calculation}</summary>
        <div className="cards">
          <div className="card"><h3>{b.minPrice}</h3><p className="big">{view.minPrice.amount}</p><p className="small muted">{view.minPrice.source}</p></div>
          <div className="card">
            <h3>{b.minMargin}</h3>
            {view.marginFloor.minMarginBp === null
              ? <p className="muted">{b.marginNotSet}</p>
              : <><p className={view.marginFloor.amount === null ? 'big muted' : 'big'}>{view.marginFloor.amount ?? EMPTY}</p><p className="small muted">{b.marginAtLeast(view.marginFloor.minMarginBp)}{view.marginFloor.unavailable ? `: ${view.marginFloor.unavailable}` : ''}</p></>}
          </div>
        </div>

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

        {view.floorBreakdown ? <BreakdownTable breakdown={view.floorBreakdown} currency={view.currency} foot={!view.currentBreakdown} /> : null}
        {view.currentBreakdown ? <BreakdownTable breakdown={view.currentBreakdown} currency={view.currency} /> : null}

        <section className="card">
          <h3>{b.calculator}</h3>
          <ol>{view.calculatorCheck.map((c) => <li key={c}>{c}</li>)}</ol>
        </section>
      </details>
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
                  <td className="offer card-title"><a href={href(worldId, 'bounds', i.writeScopeId)}><UnitName unit={i} /></a></td>
                  {/* Шаг 152 (#27, UX-04): пустая граница — «Not set» словами, приглушённо и без моноширинного шрифта сумм */}
                  <td className={i.minPriceMissing ? 'num muted empty-value' : 'num money cur'} data-label={c.min}>{i.minPrice}</td>
                  <td className={i.maxPriceMissing ? 'num muted empty-value' : 'num money cur'} data-label={c.max}>{i.maxPrice}</td>
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
  return <Load shape="cards" resource={resource} retry={retry} notFound={missing}>{(view) => <BoundsScreenView key={view.unit.writeScopeId} view={view} onChanged={retry} />}</Load>;
}
