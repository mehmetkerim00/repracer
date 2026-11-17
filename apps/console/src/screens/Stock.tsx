import { useContext, useState } from 'react';
import type { BulkJobView, StockDivergencesView, StockReturnsView, StockView } from '@repracer/console-model';
import type { ListQuery } from '@repracer/console-model';
import { syncPreview } from '@repracer/console-model';
import { ApiError, requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, Help, href, Intro, Load, MarketContext, Pager, StorefrontTag, useMessages, useOpenBlocks } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';
import { ImportPanel } from './Imports.tsx';
import { Banner, CheckField, Field, FieldGrid, FieldGroup, FormActions } from '../forms.tsx';
import { ExportControl, exportQuery } from '../export.tsx';

/**
 * Р-153 (шаг 35): экран остатков. По товару — физический остаток, резервации, доступно; по каналу — что посчитано,
 * что отправлено и что канал ПОДТВЕРДИЛ; расхождения — отдельным списком; ловушки каналов — до первой записи.
 * Экран честно говорит, чего не показывает: между записями канал не читается.
 */

export function StockScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  // Шаг 96.2: профиль рынка — о немецких заголовках файла говорим только там, где немецкий есть (eu, global)
  const market = useContext(MarketContext);
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: 50 });
  // Шаг 69 (K8): поиск и фильтр — параметры запроса; новая выборка начинается с первой страницы
  const [filter, setFilter] = useState<StockFilter>(NO_FILTER);
  const filterParams = stockFilterParams(filter);
  const [view, retry] = useResource<StockView>(`${worldPath(worldId, 'stock')}?offset=${query.offset}&limit=${query.limit}${filterParams}`, m.locale);
  const [divergences, retryDivergences] = useResource<StockDivergencesView>(worldPath(worldId, 'stock', 'divergences'), m.locale);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [job, setJob] = useState<BulkJobView | null>(null);
  const [sourceName, setSourceName] = useState('');
  const [sourceMode, setSourceMode] = useState<'INTERNAL_POOL' | 'INBOUND_API'>('INTERNAL_POOL');
  const [buffer, setBuffer] = useState('0');
  const [maxQuantity, setMaxQuantity] = useState('');
  const [minToList, setMinToList] = useState('0');
  const [ack, setAck] = useState(false);
  /** Шаг 60 [Р-202]: запись количества не подтверждена владельцем — отказ ведёт на экран подключений */
  const [toConnections, setToConnections] = useState(false);
  const refresh = () => { retry(); retryDivergences(); };
  const blocks = useOpenBlocks('inventory');
  const post = <T,>(path: string, body: Record<string, unknown>) => requestJson<T>(worldPath(worldId, 'stock', path), { method: 'POST', body, locale: m.locale });

  const createSource = () => void post<{ stockSourceId: string; apiKey: string | null }>('sources', { mode: sourceMode, name: sourceName })
    .then((r) => { setError(null); setApiKey(r.apiKey); refresh(); })
    .catch((e: unknown) => setError(errorText(e, m)));
  // Р-139: включение — задание; ход виден, итог приходит с заданием
  const enable = (channelAccountId: string) => void post<{ jobId: string; job?: BulkJobView; message: string }>('enable', {
    channelAccountId, bufferUnits: Number(buffer), maxQuantity: maxQuantity === '' ? null : Number(maxQuantity), minQuantityToList: Number(minToList), acknowledgeSideEffects: ack,
  }).then((r) => { setError(null); setToConnections(false); setMessage(r.message); if (r.job) setJob(r.job); }).catch((e: unknown) => {
    setToConnections(e instanceof ApiError && e.failure.kind === 'SERVER' && e.failure.code === 'QUANTITY_WRITES_NOT_CONFIRMED');
    setError(errorText(e, m));
  });

  return (
    <Load shape="table" resource={view} retry={retry}>
      {(v) => (
        <>
          <StockScreenView view={v} worldId={worldId} query={query} onQuery={setQuery} onFilter={(f) => { setFilter(f); setQuery({ ...query, offset: 0 }); }} />
          {/* Шаг 158 (#26, Р-254): сразу под таблицей — расхождения «у нас / в канале»; пусто — «сходятся» и момент чтения канала */}
          <Load shape="table" resource={divergences} retry={retryDivergences}>{(d) => <StockDivergences view={d} asOf={v.asOfText} />}</Load>
          {v.canManage ? (
            <>
              <FieldGroup title={m.ui.stock.enable.title} className="stock-sync">
                <FieldGrid cols={3}>
                  <Field label={m.ui.stock.enable.buffer} caption={m.ui.stock.enable.bufferCaption}><input inputMode="numeric" value={buffer} onChange={(e) => setBuffer(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.enable.maxQuantity} caption={m.ui.stock.enable.maxQuantityCaption}><input inputMode="numeric" value={maxQuantity} onChange={(e) => setMaxQuantity(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.enable.minToList} caption={m.ui.stock.enable.minToListCaption}><input inputMode="numeric" value={minToList} onChange={(e) => setMinToList(e.currentTarget.value)} /></Field>
                </FieldGrid>
                {/* Шаг 160 (#26): до включения — что получит канал при введённых значениях, той же фразой расчёта, что строка таблицы */}
                {(() => {
                  const preview = syncPreview(v.rows, { buffer, maxQuantity, minToList }, m);
                  return preview ? (
                    <div className="sync-preview" aria-live="polite">
                      <p className="field-caption"><strong>{m.ui.stock.enable.previewTitle}</strong></p>
                      <ul className="small plain">{preview.lines.map((l) => <li key={l}>{l}</li>)}</ul>
                      <p className="small muted">{preview.summary}</p>
                    </div>
                  ) : null;
                })()}
                {/* Ловушки каналов — плашкой: канал и пилюля, суть в одну-две строки, подробности — по раскрытию [Р-153] */}
                {v.traps.map((t) => {
                  const why = t.requiresAck && !ack ? m.ui.forms.why.confirmSideEffect : job !== null ? m.ui.forms.why.jobRunning : null;
                  return (
                    <Banner key={t.channelAccountId} title={t.title} badge={<Badge tone="warn">{m.ui.stock.traps.title}</Badge>} summary={t.summary} details={t.text}>
                      {t.requiresAck ? <CheckField label={t.acknowledgeLabel} caption={m.ui.stock.enable.acknowledgeCaption} checked={ack} onChange={setAck} /> : null}
                      <FormActions hint={why}>
                        <button type="button" onClick={() => enable(t.channelAccountId)} disabled={why !== null} title={why ?? undefined}>{m.ui.stock.enable.submit}</button>
                      </FormActions>
                    </Banner>
                  );
                })}
              </FieldGroup>
              {/*
                * Шаг 158 (#26): редкое — раскрываемыми разделами под синхронизацией: источники (раскрыты, пока их нет), файл остатков, возвраты
                * (раскрыты, пока ждут решения). Раскрытие помнит браузер
                */}
              <details className="card more-block stock-sources" open={blocks.isOpen('sources', v.sources.length === 0)} onToggle={blocks.toggle('sources')}>
                <summary>{m.ui.stock.sources.title}</summary>
              <FieldGroup>
                <FieldGrid cols={2}>
                  <Field label={m.ui.stock.sources.name} caption={m.ui.stock.sources.nameCaption}><input value={sourceName} onChange={(e) => setSourceName(e.currentTarget.value)} /></Field>
                  <Field label={m.ui.stock.sources.mode}><select value={sourceMode} onChange={(e) => setSourceMode(e.currentTarget.value as 'INTERNAL_POOL' | 'INBOUND_API')}>
                    <option value="INTERNAL_POOL">{m.ui.stock.sources.modes.INTERNAL_POOL}</option>
                    <option value="INBOUND_API">{m.ui.stock.sources.modes.INBOUND_API}</option>
                  </select></Field>
                </FieldGrid>
                <FormActions hint={sourceName.trim() === '' ? m.ui.forms.why.name : null}>
                  <button type="button" onClick={createSource} disabled={sourceName.trim() === ''} title={sourceName.trim() === '' ? m.ui.forms.why.name : undefined}>{m.ui.stock.sources.create}</button>
                </FormActions>
                {apiKey ? <p className="notice"><strong>{m.ui.stock.sources.keyOnce}</strong> <code>{apiKey}</code><br /><span className="small muted">{m.ui.stock.sources.keyHint(window.location.origin)}</span></p> : null}
              </FieldGroup>
              </details>
              <details className="card more-block stock-import" open={blocks.isOpen('import')} onToggle={blocks.toggle('import')}>
                <summary>{m.ui.imports.titles.STOCK}</summary>
              {/* Шаг 99 [Р-224]: файл остатков — тем же путём, что остальные импорты: шаблон, примерка, применение ровно примерки, журнал */}
              <ImportPanel worldId={worldId} kind="STOCK" canEdit={v.canManage} onApplied={refresh} exportNote={false} heading={false}
                caption={market.locales.includes('de') ? m.ui.stock.importFile.hintBilingual : m.ui.stock.importFile.hint}
                stockSources={v.sources.filter((s) => s.mode === 'INTERNAL_POOL').map((s) => ({ stockSourceId: s.stockSourceId, name: s.name }))} />
              </details>
            </>
          ) : <p className="notice">{m.ui.stock.noRight}</p>}
          <StockReturns worldId={worldId} onDecided={refresh} />
          {message ? <p className="notice" role="status">{message}</p> : null}
          {error ? <ErrorBox message={error} onRetry={refresh} /> : null}
          {error && toConnections ? <p className="back"><a href={href(worldId, 'channels', 'accounts')}>{m.ui.app.screens.channels}</a></p> : null}
        </>
      )}
    </Load>
  );
}

/** Экран без запросов — то, что отрисовывает тест из ответа сервера */
/** Шаг 159 (#26): фильтр экрана остатков — поиск, «с резервами», канал предложения, «требует внимания», порядок; параметры — одни у экрана и выгрузки */
export interface StockFilter { search: string; withReservations: boolean; channel: string | null; attention: boolean; sort: 'AVAILABLE' | 'RESERVED' }
const NO_FILTER: StockFilter = { search: '', withReservations: false, channel: null, attention: false, sort: 'AVAILABLE' };
function stockFilterParams(f: StockFilter): string {
  return `${f.search ? `&q=${encodeURIComponent(f.search)}` : ''}${f.withReservations ? '&reserved=1' : ''}${f.channel ? `&channel=${encodeURIComponent(f.channel)}` : ''}`
    + `${f.attention ? '&attention=1' : ''}${f.sort === 'RESERVED' ? '&sort=reserved' : ''}`;
}

export function StockScreenView({ view: v, worldId, query, onQuery, onFilter }: {
  view: StockView; worldId: string; query: ListQuery; onQuery: (q: ListQuery) => void;
  onFilter?: (f: StockFilter) => void;
}) {
  const m = useMessages();
  const t = m.ui.stock;
  const [search, setSearch] = useState(v.filter.search);
  const [withReservations, setWithReservations] = useState(v.filter.withReservations);
  // Шаг 159 (#26): канал, «требует внимания» и порядок применяются сразу; поиск — кнопкой, как прежде
  const current = (over: Partial<StockFilter> = {}): StockFilter => ({ search: search.trim(), withReservations, channel: v.filter.channel, attention: v.filter.attention, sort: v.filter.sort, ...over });
  return (
    <section className="stock">
      {/* Шаг 96 (В19): страница остатков — Inventory; заголовок — тот же текст, что пункт меню */}
      <h2>{m.ui.app.screens.inventory}</h2>
      {/* Шаг 77: пометку демо даёт полоса под шапкой на каждом экране мира [Р-151] — второй баннер на экране не нужен */}
      <Intro text={v.intro} />
      {/* Шаг 64: у пустого экрана — не строка нулей, а объяснение ниже */}
      {v.sources.length === 0 ? <p className="notice">{m.ui.onboarding.empty.stock} <a href={href(worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : (
        // Шаг 79: итоги и источники — карточкой над таблицей, а не текстом на фоне страницы
        <div className="toolbar stock-summary">
          {v.rows.length > 0 ? <strong>{v.summaryText}</strong> : null}
          {/* Шаг 96.1: что значат состояния каналов и на какой момент — строкой при сводке, один раз, а не в каждой строке таблицы */}
          {v.rows.length > 0 && (v.asOfText || v.legend.length > 0) ? (
            <p className="small stock-legend">{v.asOfText ? <span className="muted">{v.asOfText} </span> : null}{v.legend.join(' ')}</p>
          ) : null}
          <ul className="small plain">{v.sources.map((s) => <li key={s.stockSourceId}>{s.name} — {s.modeText}; {s.productsText}{s.hasKey ? `; ${t.sources.keyPresent}` : ''}</li>)}</ul>
        </div>
      )}
      {onFilter && (v.rows.length > 0 || v.filter.matchedText) ? (
        // Шаг 94: фильтр — поле стандарта с подписью над ним, галочка — своей ячейкой, кнопки — в конце ряда
        <form className="filters toolbar field-toolbar" onSubmit={(e) => { e.preventDefault(); onFilter(current()); }}>
          <Field label={t.filter.searchLabel}><input type="search" value={search} placeholder={t.filter.search} onChange={(e) => setSearch(e.currentTarget.value)} /></Field>
          {/* Шаг 159 (#26): канал предложения и порядок — по всему каталогу запросом базы */}
          <Field label={t.filter.channelLabel}>
            <select value={v.filter.channel ?? ''} onChange={(e) => onFilter(current({ channel: e.currentTarget.value === '' ? null : e.currentTarget.value }))}>
              <option value="">{t.filter.allChannels}</option>
              {v.filter.channelOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label={t.filter.sortLabel}>
            <select value={v.filter.sort} onChange={(e) => onFilter(current({ sort: e.currentTarget.value as StockFilter['sort'] }))}>
              <option value="AVAILABLE">{t.filter.sorts.AVAILABLE}</option>
              <option value="RESERVED">{t.filter.sorts.RESERVED}</option>
            </select>
          </Field>
          <CheckField label={t.filter.withReservations} checked={withReservations} onChange={(on) => { setWithReservations(on); onFilter(current({ withReservations: on })); }} />
          <CheckField label={t.filter.attention} caption={t.filter.attentionCaption} checked={v.filter.attention} onChange={(on) => onFilter(current({ attention: on }))} />
          <div className="form-actions-row">
            <button type="submit">{t.filter.apply}</button>
            {v.filter.matchedText ? <button type="button" onClick={() => { setSearch(''); setWithReservations(false); onFilter(NO_FILTER); }}>{t.filter.reset}</button> : null}
          </div>
          {/* Шаг 104 [Р-229]: выгрузка — по ПРИМЕНЁННОМУ фильтру: тем товарам, что в таблице; шаг 159 — и по каналу, вниманию, порядку */}
          <ExportControl worldId={worldId} screen="inventory" query={exportQuery(null, { q: v.filter.search, reserved: v.filter.withReservations ? '1' : undefined,
            channel: v.filter.channel ?? undefined, attention: v.filter.attention ? '1' : undefined, sort: v.filter.sort === 'RESERVED' ? 'reserved' : undefined })} empty={v.rows.length === 0} />
        </form>
      ) : null}
      {v.filter.matchedText ? <Help className="section-sub" text={v.filter.matchedText} /> : null}
      {v.filter.noneText ? <p className="notice">{v.filter.noneText}</p> : null}
      {v.rows.length > 0 ? (
        <div className="table-wrap">
        <table className="stock-table cardify">
          <thead><tr><th>{t.columns.product}</th><th className="num">{t.columns.onHand}</th><th className="num">{t.columns.reserved}</th><th className="num">{t.columns.available}</th><th>{t.columns.channels}</th></tr></thead>
          <tbody>
            {v.rows.map((r) => (
              <tr key={r.productId}>
                <td className="product card-title">{r.label}{r.label !== r.sku ? <span className="small muted nowrap"> · {r.sku}</span> : null}{r.gtin ? <span className="small muted nowrap"> · {r.gtin}</span> : null}</td>
                <td className="num" data-label={t.columns.onHand}>{r.onHand}</td><td className="num" data-label={t.columns.reserved}>{r.reserved}</td><td className="num money" data-label={t.columns.available}>{r.available}</td>
                <td className="text-cell" data-label={t.columns.channels}>
                  {r.channelManaged.length > 0 ? <ul className="small muted plain">{r.channelManaged.map((x, i) => <li key={i} title={x.detail}>{x.text}</li>)}</ul> : null}
                  {r.channels.length === 0 ? (r.channelManaged.length > 0 ? null : <span className="muted">—</span>) : (
                    <ul className="small plain stock-channels">
                      {r.channels.map((c) => (
                        <li key={c.writeScopeId} title={c.detailText}>
                          {/* Шаг 96.1: в строке — канал · витрина, пилюля и «N to publish»; что значит состояние — один раз над таблицей,
                              полное предложение — подсказкой строки */}
                          {/* Шаг 111 [Р-237]: витрины — чипами, «канал · витрина» словами — подсказкой */}
                          <span className="channel-name" title={c.label}>{c.chips.map((chip) => <StorefrontTag key={chip.full} chip={chip} />)}</span> <Badge tone={c.tone}>{c.statusText}</Badge>
                          {c.toPublishText ? <span className="nowrap"> {c.toPublishText}</span> : null}
                          {c.differsText ? <span className="muted nowrap"> · {c.differsText}</span> : null}
                          {c.divergedText ? <p className="error">{c.divergedText}</p> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Шаг 79: чего экран не видит — подвалом таблицы, а не текстом на фоне страницы */}
        <Help className="table-foot" text={v.cannot} />
        </div>
      ) : <p className="notice">{v.cannot}</p>}
      <Pager page={v.page} query={query} onQuery={onQuery} />
      <Gaps gaps={v.gaps} />
    </section>
  );
}

export function StockDivergences({ view, asOf = null }: { view: StockDivergencesView; asOf?: string | null }) {
  const m = useMessages();
  return (
    <section className="card stock-divergences">
      <h3>{m.ui.stock.divergences.title}</h3>
      {/* Шаг 158 (#26): пусто — «наши цифры и канал сходятся» и на какой момент канал прочитан */}
      {view.items.length === 0 ? <p className="muted empty">{m.ui.stock.divergences.agree}{asOf ? ` ${asOf}` : ''}</p> : (
        <ul className="small">{view.items.map((d) => <li key={d.writeScopeId}><strong>{d.sku}</strong> · {(m.values as Record<string, string | undefined>)[d.channel] ?? d.channel} · {d.storefrontsText}: {d.text}</li>)}</ul>
      )}
    </section>
  );
}

/**
 * Шаг 59 [Р-199]: возвраты. У ждущей строки внутреннего пула — две кнопки и заметка; у источника Inbound API — пояснение,
 * что остаток ведёт система продавца. После решения список и экран остатков перезагружаются
 */
export function StockReturns({ worldId, onDecided }: { worldId: string; onDecided: () => void }) {
  const m = useMessages();
  const [view, retry] = useResource<StockReturnsView>(worldPath(worldId, 'stock', 'returns'), m.locale);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const decide = (orderReturnId: string, accept: boolean) => {
    setBusy(orderReturnId);
    void requestJson<{ message: string }>(worldPath(worldId, 'stock', 'returns'), { method: 'POST', body: { orderReturnId, accept, note: notes[orderReturnId] ?? '' }, locale: m.locale })
      .then((r) => { setError(null); setMessage(r.message); })
      .catch((e: unknown) => { setMessage(null); setError(errorText(e, m)); })
      .finally(() => { setBusy(null); retry(); onDecided(); });
  };
  return (
    <Load shape="table" resource={view} retry={retry}>
      {(v) => <StockReturnsList view={v} notes={notes} busy={busy} onNote={(id, text) => setNotes((n) => ({ ...n, [id]: text }))} onDecide={decide} message={message} error={error} onRetry={retry} />}
    </Load>
  );
}

/** Список возвратов без запросов — то, что отрисовывает тест из ответа сервера */
export function StockReturnsList({ view: v, notes, busy, onNote, onDecide, message, error, onRetry }: {
  view: StockReturnsView; notes: Record<string, string>; busy: string | null; onNote: (id: string, text: string) => void; onDecide: (id: string, accept: boolean) => void;
  message: string | null; error: string | null; onRetry: () => void;
}) {
  const m = useMessages();
  const t = m.ui.stock.returns;
  // Шаг 158 (#26): возвраты — раскрываемым разделом, раскрыт, пока ждут решения; своё хранилище раскрытия (два хука одного ключа затирали бы друг друга)
  const blocks = useOpenBlocks('inventory-returns');
  return (
    <details className="card more-block stock-returns" open={blocks.isOpen('returns', v.pendingCount > 0)} onToggle={blocks.toggle('returns')}>
      <summary>{t.title}{v.pendingCount > 0 ? <> <Badge tone="warn">{v.pendingCount}</Badge></> : null}</summary>
      <p className="small muted">{v.intro}</p>
      <p><strong>{v.pendingText}</strong></p>
      {v.items.length === 0 ? <p className="muted empty">{v.none}</p> : (
        <ul className="small">
          {v.items.map((r) => (
            <li key={r.orderReturnId}>
              <Badge tone={r.pending ? 'warn' : r.infoOnly ? 'off' : 'ok'}>{r.statusText}</Badge> <strong>{r.sku}</strong> · {r.channel} · {r.channelOrderLineRef}: {r.text}
              {r.note ? <em> — {r.note}</em> : null}
              {r.pending && v.canDecide ? (
                <div className="return-decision">
                  <Field label={t.note}><input value={notes[r.orderReturnId] ?? ''} onChange={(e) => onNote(r.orderReturnId, e.currentTarget.value)} maxLength={500} /></Field>
                  <FormActions>
                    <button type="button" className="primary" onClick={() => onDecide(r.orderReturnId, true)} disabled={busy !== null}>{t.accept}</button>
                    <button type="button" onClick={() => onDecide(r.orderReturnId, false)} disabled={busy !== null}>{t.dismiss}</button>
                  </FormActions>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!v.canDecide && v.pendingCount > 0 ? <p className="muted">{m.ui.stock.noRight}</p> : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <ErrorBox message={error} onRetry={onRetry} /> : null}
    </details>
  );
}
