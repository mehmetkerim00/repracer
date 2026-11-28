import { useEffect, useState, type ReactNode } from 'react';
import { canPickMore, NO_SELECTION, toggleOffer, type OfferSelection, ATTENTION_FILTERS, LIST_PAGE_DEFAULT, OFFER_HOLDER_FILTERS, OFFER_MONEY_FILTERS, OFFER_PRICING_FILTERS, OFFER_SETUP_FILTERS, type AttentionFilter, type BuyboxCells, type MissingSetup, type ListQuery, type OfferSort, type OfferSortKeyValue, type ProductListView, type ProductRow } from '@repracer/console-model';
import { PRICING_SWITCH_NOTE_MAX, type DisableRequest, type DisableResult, type EnableResult } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, Cell, ColorVariant, ErrorBox, errorText, Gaps, Help, href, Load, Pager, ProductRef, ReasonLine, SellerName, UnitName, useMessages } from '../components.tsx';
import { CheckField, Field, FormActions, RowCheck } from '../forms.tsx';
import { ExportControl, exportQuery } from '../export.tsx';
import { Octicon } from '../icons.tsx';
import { handOver } from '../handover.ts';
import { rememberKey, useRemembered } from '../remember.ts';
import { ColHead, TableFrame } from '../table-frame.tsx';
import { BoundsIndexView } from './Bounds.tsx';
import { filterOfUi, isPicked, SelectionBar, SelectionScope, useSelectionSummary } from './Selection.tsx';

/**
 * Шаг 79: колонки, которые продавец может скрыть; предложение, цена, пол, статус и действия — всегда. Шаг 105 [Р-230]: колонки Buy Box —
 * держатель, цена, разрыв, доля за 7 дней — по умолчанию выключены; включённые — сортируют весь каталог и попадают в выгрузку
 */
const OPTIONAL_COLUMNS = ['margin', 'ceiling', 'strategy', 'health', 'lastChange', 'nextCheck', 'bbHolder', 'bbPrice', 'bbGap', 'bbShare'] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
const BUYBOX_COLUMNS = ['bbHolder', 'bbPrice', 'bbGap', 'bbShare'] as const;
const SORT_OF: Record<(typeof BUYBOX_COLUMNS)[number], OfferSortKeyValue> = { bbHolder: 'holder', bbPrice: 'price', bbGap: 'gap', bbShare: 'share' };
const VIEW_KEY = 'repracer.products.view';

/** Шаг 105: фильтр строки и сортировка экрана Offers — то, что уходит в адрес экрана и в обе выгрузки */
// Шаг 170 (#35): `setup` — чего не хватает для включения (стратегии или границ)
// Шаг 171 (#34): `money` — финансовые исключения (распродажа, цена ниже безубыточности)
export interface OfferUiQuery { storefront: string; pricing: string; attention: string; setup: string; money: string; holder: string; q: string; sort: OfferSort | null }
export const NO_OFFER_QUERY: OfferUiQuery = { storefront: '', pricing: '', attention: '', setup: '', money: '', holder: '', q: '', sort: null };
/**
 * Шаг 170 (#35): выборка Offers из адреса — `products/filter/<параметры>` (пункт чеклиста готовности ведёт в свою выборку): витрина, автоцена,
 * причина внимания и setup; незнакомые значения отбрасывает сервер (400), здесь — только поля экрана
 */
export function offerQueryOfPath(part: string | null | undefined): OfferUiQuery | undefined {
  if (!part || !part.includes('=')) return undefined;
  const p = new URLSearchParams(part);
  // Шаг 181 (#38): адрес несёт всю выборку экрана — и держателя Buy Box, и поиск
  return { ...NO_OFFER_QUERY, storefront: p.get('storefront') ?? '', pricing: p.get('pricing') ?? '', attention: p.get('attention') ?? '', setup: p.get('setup') ?? '', money: p.get('money') ?? '',
    holder: p.get('holder') ?? '', q: p.get('q') ?? '' };
}
/** Шаг 148 (#27): один сигнал конкуренции по умолчанию — держатель Buy Box; остальные колонки Buy Box — за «Columns» */
const BUYBOX_DEFAULTS: Readonly<Record<(typeof BUYBOX_COLUMNS)[number], boolean>> = { bbHolder: true, bbPrice: false, bbGap: false, bbShare: false };
/** Включена ли хоть одна колонка Buy Box — по выбору зрителя в браузере, а без выбора — по умолчанию (до первого ответа экрана) */
export function storedBuyboxColumns(): boolean {
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_KEY);
    const parsed = raw ? (JSON.parse(raw) as { columns?: Partial<Record<OptionalColumn, boolean>> }) : null;
    return BUYBOX_COLUMNS.some((k) => parsed?.columns?.[k] ?? BUYBOX_DEFAULTS[k]);
  } catch { return BUYBOX_COLUMNS.some((k) => BUYBOX_DEFAULTS[k]); }
}
/** Адрес экрана и запрос выгрузки: пустые поля не передаются */
export function offerParams(q: OfferUiQuery, bb: boolean): Record<string, string> {
  return exportQuery(null, { storefront: q.storefront, pricing: q.pricing, attention: q.attention, setup: q.setup, money: q.money, holder: q.holder, q: q.q, sort: q.sort?.key, dir: q.sort?.dir, bb: bb ? '1' : undefined });
}
/**
 * Шаг 177 (#39): поля фильтра Offers — витрина, автоцена, «требует внимания», Setup, Money, держатель Buy Box и поиск. Одни у экрана Offers
 * и у таблицы выбора Costs & floors: фильтр — один, и выборку по нему делает сервер одним правилом
 */
export function OfferFilterFields({ storefronts, query, onQuery, search, onSearch, holder = true }: { storefronts: ReadonlyArray<{ value: string; label: string }>;
  query: OfferUiQuery; onQuery: (q: OfferUiQuery) => void; search: string; onSearch: (q: string) => void; holder?: boolean }) {
  const m = useMessages();
  const f = m.ui.products.filters;
  return (
    <>
            <Field label={f.storefront}>
              <select value={query.storefront} onChange={(e) => onQuery({ ...query, storefront: e.currentTarget.value })}>
                <option value="">{f.allStorefronts}</option>
                {storefronts.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
              </select>
            </Field>
            {/* Шаг 118: автоцена включена или выключена — по всему каталогу, как остальные фильтры */}
            <Field label={f.pricing}>
              <select value={query.pricing} onChange={(e) => onQuery({ ...query, pricing: e.currentTarget.value })}>
                <option value="">{f.anyPricing}</option>
                {OFFER_PRICING_FILTERS.map((v) => <option key={v} value={v}>{f.pricingValues[v]}</option>)}
              </select>
            </Field>
            {/* Шаг 146 (#34): «требует внимания» — та же выборка, что число строки состояния; любая причина или одна */}
            <Field label={f.attention}>
              <select value={query.attention} onChange={(e) => onQuery({ ...query, attention: e.currentTarget.value })}>
                <option value="">{f.anyAttention}</option>
                {ATTENTION_FILTERS.map((v) => <option key={v} value={v}>{f.attentionValues[v]}</option>)}
              </select>
            </Field>
            {/* Шаг 170 (#35): чего не хватает для включения — выборка пунктов «без стратегии» и «без границ» чеклиста готовности */}
            <Field label={f.setup}>
              <select value={query.setup} onChange={(e) => onQuery({ ...query, setup: e.currentTarget.value })}>
                <option value="">{f.anySetup}</option>
                {OFFER_SETUP_FILTERS.map((v) => <option key={v} value={v}>{f.setupValues[v]}</option>)}
              </select>
            </Field>
            {/* Шаг 171 (#34): финансовые исключения — выборка очереди «What needs action» Daily Overview */}
            <Field label={f.money}>
              <select value={query.money} onChange={(e) => onQuery({ ...query, money: e.currentTarget.value })}>
                <option value="">{f.anyMoney}</option>
                {OFFER_MONEY_FILTERS.map((v) => <option key={v} value={v}>{f.moneyValues[v]}</option>)}
              </select>
            </Field>
            {holder ? <Field label={f.holder}>
              <select value={query.holder} onChange={(e) => onQuery({ ...query, holder: e.currentTarget.value })}>
                <option value="">{f.anyHolder}</option>
                {OFFER_HOLDER_FILTERS.map((h) => <option key={h} value={h}>{f.holders[h]}</option>)}
              </select>
            </Field> : null}
            <Field label={f.search}><input type="search" value={search} placeholder={f.searchPlaceholder} onChange={(e) => onSearch(e.currentTarget.value)} /></Field>
    </>
  );
}

/**
 * «Следующая проверка» у всех предложений сейчас одна и та же («нет данных») — по умолчанию скрыта; «Канал сообщает» — когда есть что
 * сообщить. «Последнее изменение» по умолчанию скрыто: оно есть на «Why this price» и в ленте цен, а таблица должна помещаться в окно 1440
 * без прокрутки под закреплённую колонку действий (визуальное ревью шага 79); включается в «Columns»
 */
function defaultColumns(view: ProductListView): Record<OptionalColumn, boolean> {
  // Шаг 148 (#27): по умолчанию — предложение, статус, цена, держатель Buy Box, пол, стратегия; максимальная цена — за «Columns» (её
  // называют окно включения, страница пола и выгрузка)
  // Шаг 162 (#27): маржа при текущей цене — по умолчанию; Health (с заметками канала — прежней колонкой «Issues from the channel») — когда на
  // странице есть что сказать: колонка из прочерков — находка шага 96.2
  return { margin: true, ceiling: false, strategy: true, health: view.rows.some((r) => r.health !== null), lastChange: false, nextCheck: false, ...BUYBOX_DEFAULTS };
}
/** Выбор колонок и плотность — удобство одного зрителя: браузерное хранилище, без него — умолчания (шаг 79) */
/** Шаг 175 (QA-A Testing 2.0, этап 4): компактные строки — постоянный стандарт; выбора плотности больше нет */
function readView(view: ProductListView): { columns: Record<OptionalColumn, boolean> } {
  const fallback = { columns: defaultColumns(view) };
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { columns?: Partial<Record<OptionalColumn, boolean>> };
    return { columns: { ...fallback.columns, ...(parsed.columns ?? {}) } };
  } catch { return fallback; }
}

/** Экран A: действующий пол — главная цифра, min_price — его составляющая (шаг 12, F) */
export function ProductsView({ view, onEnable, onDisable, query, onQuery, offerQuery = NO_OFFER_QUERY, onOfferQuery, onBuyboxColumns, pick, selectionUi, reviewList }: {
  view: ProductListView; onEnable?: (row: ProductRow) => void; onDisable?: (row: ProductRow) => void; query?: ListQuery; onQuery?: (q: ListQuery) => void;
  /** Шаг 105: фильтр и сортировка — у экрана; без обработчика (тесты экранов) — без ряда фильтров */
  offerQuery?: OfferUiQuery; onOfferQuery?: (q: OfferUiQuery) => void; onBuyboxColumns?: (on: boolean) => void;
  /** Шаг 179 (#39): выбор для массовых операций — галочка в ячейке предложения, строка выбора и «Review selection» вместо таблицы */
  pick?: { picked: (id: string) => boolean; onToggle: (id: string, on: boolean) => void; canPick: boolean }; selectionUi?: ReactNode; reviewList?: ReactNode;
}) {
  const m = useMessages();
  const p = m.ui.products;
  const c = p.columns;
  const f = p.filters;
  const [shown, setShown] = useState(() => readView(view));
  const [search, setSearch] = useState(offerQuery.q);
  const update = (next: typeof shown) => {
    setShown(next);
    try { globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* без хранилища — до перезагрузки страницы */ }
    const bb = BUYBOX_COLUMNS.some((k) => next.columns[k]);
    if (bb !== BUYBOX_COLUMNS.some((k) => shown.columns[k])) onBuyboxColumns?.(bb);
    // Сортировка по скрытой колонке не остаётся: продавец не видит, по чему упорядочено
    const sorted = offerQuery.sort ? BUYBOX_COLUMNS.find((k) => SORT_OF[k] === offerQuery.sort!.key) : undefined;
    if (sorted && !next.columns[sorted]) onOfferQuery?.({ ...offerQuery, sort: null });
  };
  const col = shown.columns;
  const bbOn = BUYBOX_COLUMNS.some((k) => col[k]);
  const filtered = offerQuery.storefront !== '' || offerQuery.pricing !== '' || offerQuery.attention !== '' || offerQuery.holder !== '' || offerQuery.q !== '';
  /** Заголовок колонки Buy Box — кнопка сортировки по всему каталогу: первое нажатие — по возрастанию, второе — по убыванию */
  const sortHead = (k: (typeof BUYBOX_COLUMNS)[number], numeric: boolean) => {
    const key = SORT_OF[k];
    const dir = offerQuery.sort?.key === key ? offerQuery.sort.dir : null;
    return (
      <ColHead key={k} col={k} label={c[k]} {...(numeric ? { className: 'num' } : {})} sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}>
        {onOfferQuery ? (
          <button type="button" className="sort-head" title={p.buybox.sortBy(c[k])} onClick={() => onOfferQuery({ ...offerQuery, sort: { key, dir: dir === 'asc' ? 'desc' : 'asc' } })}>
            {c[k]}{dir ? <Octicon name={dir === 'asc' ? 'triangle-up' : 'triangle-down'} size={16} /> : null}
          </button>
        ) : c[k]}
      </ColHead>
    );
  };
  const dash = <span className="muted">–</span>;
  const bbCells = (b: BuyboxCells | null | undefined) => (
    <>
      {col.bbHolder ? <td className="bb-holder" title={b?.title}>{b ? (b.holder.kind === 'NO_DATA' || b.holder.kind === 'NO_SNAPSHOT' ? dash : b.holder.kind === 'OTHER' ? <SellerName name={b.holder.text} url={b.sellerUrl} /> : b.holder.text) : dash}</td> : null}
      {col.bbPrice ? <td className="num cur" title={b?.title}>{b?.price ? <>{b.price}{b.priceNote ? <div className="muted small">{b.priceNote}</div> : null}</> : dash}</td> : null}
      {col.bbGap ? <td className="num cur" title={b?.title}>{b?.gap ?? dash}</td> : null}
      {col.bbShare ? <td className="num" title={b?.title}>{b?.share ?? dash}</td> : null}
    </>
  );
  return (
    <section>
      <h2>{p.title}</h2>
      <p className="subtitle">{m.ui.app.subtitles.products}</p>
      {/* Задача D шага 34: новый тенант без данных видит, ПОЧЕМУ пусто и куда идти, а не пустую таблицу */}
      {view.rows.length === 0 && !filtered ? <p className="notice">{m.ui.onboarding.empty.products} <a href={href(view.worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      {/*
        Шаг 105 [Р-230]: ряд фильтров — витрина, держатель Buy Box, поиск; выбор применяется сразу, поиск — по Enter или кнопке. Обе выгрузки —
        по фильтру и порядку экрана (шаг 104: «что видишь, то и выгружаешь»), у выгрузки Offers — с колонками Buy Box, если они включены
      */}
      {view.rows.length > 0 || filtered ? (
        <form className="filters toolbar field-toolbar export-bar" onSubmit={(e) => { e.preventDefault(); onOfferQuery?.({ ...offerQuery, q: search.trim() }); }}>
          {onOfferQuery ? <OfferFilterFields storefronts={view.filters.storefronts} query={offerQuery} onQuery={onOfferQuery} search={search} onSearch={setSearch} /> : null}
          {/* Строка «заголовки — по-английски» — одна, после обеих выгрузок */}
          <ExportControl worldId={view.worldId} screen="offers" note={false} query={offerParams(offerQuery, bbOn)} empty={view.rows.length === 0} />
          <ExportControl worldId={view.worldId} screen="offer-competitors" label={m.ui.export.competitors} query={offerParams(offerQuery, false)} empty={view.rows.length === 0} />
        </form>
      ) : null}
      {view.matched !== null ? <Help className="section-sub" text={f.matched(view.matched, view.totals.total)} /> : null}
      {/* Шаг 189 (#27, пункт 17): строка выбора держится над таблицей, пока листаются её строки */}
      {withSelection(selectionUi, <>
      {/* Шаг 79: итоги и вид таблицы — в её шапке; колонки выбираются, строки бывают компактными. Шаг 182 (#38): шапка таблицы — на экране, таблица разворачивается */}
      {reviewList ? reviewList : view.rows.length > 0 ? <TableFrame screen="products" table="offers" lead={<span>{p.totals(view.totals)}</span>} actions={(
          <span className="view-options">
            {/* Шаг 95 [Р-217]: массовые операции — кнопкой с Offers; своего пункта меню у них нет */}
            <a className="button-link" href={href(view.worldId, 'products', 'bulk')}>{p.bulkEdit}</a>
            <details className="column-picker">
              <summary>{p.viewOptions.columns}</summary>
              <div className="menu">
                {OPTIONAL_COLUMNS.map((k) => (
                  <CheckField key={k} label={c[k]} checked={col[k]} onChange={(on) => update({ ...shown, columns: { ...col, [k]: on } })} />
                ))}
              </div>
            </details>
          </span>
        )}>
        <table className={`products sticky-end compact${col.health ? ' with-health' : ''}`}>
          <thead>
            <tr>
              {/* Шаг 79 (ревью): статус — сразу после предложения: широкая таблица листается под закреплённой колонкой действий, и статус не прячется */}
              {/* Шаг 183 (#38): у каждой подписанной колонки — ручка ширины; память ширин — браузера */}
              <ColHead col="unit" label={c.unit} /><ColHead col="status" label={c.status} /><ColHead col="current" label={c.current} className="num" />
              {/* Шаг 105: колонки Buy Box — рядом с текущей ценой (разрыв — наша цена минус Buy Box): включённые видны без прокрутки таблицы */}
              {col.bbHolder ? sortHead('bbHolder', false) : null}{col.bbPrice ? sortHead('bbPrice', true) : null}{col.bbGap ? sortHead('bbGap', true) : null}{col.bbShare ? sortHead('bbShare', true) : null}
              {col.margin ? <ColHead col="margin" label={c.margin} className="num" /> : null}
              <ColHead col="floor" label={c.floor} className="num" />{col.ceiling ? <ColHead col="ceiling" label={c.ceiling} className="num" /> : null}
              {col.strategy ? <ColHead col="strategy" label={c.strategy} /> : null}{col.health ? <ColHead col="health" label={c.health} /> : null}{col.lastChange ? <ColHead col="lastChange" label={c.lastChange} /> : null}
              {/* Шаг 188 (§2): у колонки действий — заголовок, как у остальных; ручки ширины у неё нет */}
              {col.nextCheck ? <ColHead col="nextCheck" label={c.nextCheck} /> : null}<th className="actions-head">{c.actions}</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              // Шаг 168: строка с причиной «требует внимания» (та же, что считает строка состояния) — подсвечена
              <tr key={r.unit.writeScopeId} className={r.attention.length > 0 ? 'attention' : undefined}>
                <td className="offer">
                  {/* Шаг 179 (#39): галочка выбора — в ячейке предложения: колонки и закреплённая первая колонка таблицы прежние */}
                  {pick ? <RowCheck label={m.ui.selection.pick(r.unit.label)} checked={pick.picked(r.unit.writeScopeId)}
                    disabled={!pick.picked(r.unit.writeScopeId) && !pick.canPick} onChange={(on) => pick.onToggle(r.unit.writeScopeId, on)} /> : null}
                  <strong><UnitName unit={r.unit} variant={false} /></strong>
                  {/*
                    * Шаг 162 (#27): пометки строки (распродажа — шаг 102, истёкшая комиссия — шаг 142, пол выше потолка — шаг 102, рамки канала —
                    * шаг 107) переехали в колонку Health: важнейшая первой, остальные — «+N». Колонка скрыта — пометки остаются у названия
                    */}
                  {!col.health ? [r.frozen, r.channelBounds, r.feeExpired, r.clearance].map((x, i) => (x ? <span key={i}> <Badge tone={i === 0 ? 'stop' : 'warn'}>{x}</Badge></span> : null)) : null}
                  {/* Шаг 78: номер товара канала — приглушённо, состояние — отдельной пилюлей */}
                  {/* Шаг 79: «новый» — обычное состояние, пилюлю не показываем; иное — словами на языке экрана, а не кодом канала */}
                  {/* Шаг 112 [Р-238]: вторая строка — цвет товара (кружок и слово), затем идентификатор товара в канале его именем (ASIN,
                      Item ID); пустой идентификатор не показывается — прежде у eBay висело голое «product». В компактных строках — только цвет */}
                  <ProductRef unit={r.unit} />
                </td>
                {/* Шаг 79: «On» и «In progress» — одна колонка: включённость всегда, ход — только когда что-то идёт */}
                <td className="status-cell"><Cell cell={r.enabled} />{r.applying.tone !== 'ok' ? <Cell cell={r.applying} /> : null}</td>
                {/* Шаг 148 (#27, UX-04): пустое — словами и обычным шрифтом; моноширинный — только у сумм */}
                <td className={`num money${r.currentPriceMissing ? ' muted empty-value' : ' cur'}`}>{r.currentPrice}</td>
                {bbOn ? bbCells(r.buybox) : null}
                {/* Шаг 162 (#27): маржа при текущей цене — функцией Gate; пусто — словами и обычным шрифтом */}
                {col.margin ? <td className={`num margin${r.margin.missing ? ' muted empty-value' : r.margin.bp !== null && r.margin.bp < 0 ? ' negative' : ''}`}>{r.margin.text}</td> : null}
                {/* Шаг 188 (§2): незаданный пол — одно «Not set», причина — подсказкой (вторая строка повторяла «not set») */}
                <td className={`num floor${r.floor.missing ? '' : ' cur'}`}>
                  {r.floor.missing ? <span className="muted empty-value" title={r.floor.parts}>{r.floor.amount}</span>
                    : <><strong>{r.floor.amount}</strong><div className="muted small floor-parts">{r.floor.parts}</div></>}
                </td>
                {col.ceiling ? <td className={`num${r.maxPriceMissing ? ' muted empty-value' : ' cur'}`}>{r.maxPrice}</td> : null}
                {/* Шаг 78: источник пилюлей и короткое имя; подробности стратегии — подсказкой и на «Why this price» */}
                {col.strategy ? <td className="strategy" title={r.strategy.detail}>
                  {r.strategy.competitorDerived ? <Badge tone="progress">{p.competitorBadge}</Badge> : null} <span className="strategy-name">{r.strategy.label}</span>
                  {/* Шаг 103 [Р-228]: правило умолчания аккаунта не назначило стратегию — причина словами под именем */}
                  {r.notAssigned ? <div className="muted small">{r.notAssigned}</div> : null}
                </td> : null}
                {/*
                  * Шаг 162 (#27): Health — важнейшее первым, с пояснением и «что делать» (шаг 96); остальное — «+N» с тем же содержимым. Колонка
                  * «Issues from the channel» влилась сюда: заметки канала — ошибки и блокировки предложения
                  */}
                {col.health ? <td className="health">{r.health ? <>
                  <Cell cell={{ tone: r.health.tone, label: r.health.text, detail: r.health.detail ?? '', ...(r.health.short ? { short: r.health.short } : {}) }} />
                  {r.health.whatToDo ? <details className="what-to-do"><summary>{r.health.whatToDo.label}</summary><p>{r.health.whatToDo.text}</p><WhatToDoLink worldId={view.worldId} link={r.health.whatToDo.link} /></details> : null}
                  {r.health.more.length > 0 ? (
                    <details className="what-to-do health-more"><summary>+{r.health.more.length}</summary>
                      <ul className="plain">{r.health.more.map((x) => (
                        <li key={x.text}><Cell cell={{ tone: x.tone, label: x.text, detail: x.detail ?? '', ...(x.short ? { short: x.short } : {}) }} />{x.whatToDo ? <><p className="small">{x.whatToDo.label}: {x.whatToDo.text}</p><WhatToDoLink worldId={view.worldId} link={x.whatToDo.link} /></> : null}</li>
                      ))}</ul>
                    </details>
                  ) : null}
                </> : <span className="muted">–</span>}</td> : null}
                {col.lastChange ? <td><Cell cell={r.lastChange} /></td> : null}
                {col.nextCheck ? <td><Cell cell={r.nextCheck} /></td> : null}
                {/*
                  * Шаг 78: одна колонка действий — основная «Why this price», под ней вторичные. Шаг 188 (§2): «No decisions yet» — пилюлей с
                  * заглавной; вторичные ссылки (границы, конкуренты, «почему не менялась») — под раскрытием «⋯», кнопки включения — на виду
                  */}
                <td className="actions">
                  {r.latestDecisionId
                    ? <a className="row-link" href={href(view.worldId, 'decisions', r.latestDecisionId)}>{p.why}</a>
                    : <Badge tone="off">{p.noDecisions}</Badge>}
                  <details className="row-more"><summary aria-label={p.moreActions} title={p.moreActions}>⋯</summary><div className="row-more-links">
                    <a className="secondary-link" href={href(view.worldId, 'bounds', r.unit.writeScopeId)}>{m.ui.app.screens.bounds}</a>
                    {/* Шаг 97 [E]: страница конкурентов предложения — ссылкой из строки, не пунктом меню */}
                    <a className="secondary-link" href={href(view.worldId, 'competition', r.unit.writeScopeId)}>{m.ui.competition.link}</a>
                    {/* Шаг 169 (#36): ответ из сохранённых решений предложения — почему цена не менялась */}
                    <a className="secondary-link wrap-link" href={href(view.worldId, 'unchanged', r.unit.writeScopeId)}>{m.ui.unchanged.link}</a>
                  </div></details>
                  {r.canEnable && onEnable ? <button type="button" onClick={() => onEnable(r)}>{p.enable}</button> : null}
                  {/* Шаг 118: «этот SKU не трогай» — выключение автоцены одного предложения, обратно — «Enable» */}
                  {r.canDisable && onDisable ? <button type="button" onClick={() => onDisable(r)}>{m.ui.enabled.disable.button}</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame> : null}
      {query && onQuery && view.rows.length > 0 ? <Pager page={view.page} query={query} onQuery={onQuery} /> : null}
      </>)}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

/** Шаг 189: строка выбора и таблица — блоком `SelectionScope`; функция, а не компонент в отрисовке — таблица не монтируется заново */
function withSelection(line: ReactNode | undefined, rows: ReactNode): ReactNode {
  return line ? <SelectionScope line={line}>{rows}</SelectionScope> : rows;
}

/** Шаг 188 (§2): ссылка «что делать» туда, где это задают, — у «нет себестоимости» страница предложения с полем ввода (шаг 187) */
function WhatToDoLink({ worldId, link }: { worldId: string; link: { label: string; writeScopeId: string } | undefined }) {
  return link ? <p><a className="row-link" href={href(worldId, 'bounds', link.writeScopeId)}>{link.label}</a></p> : null;
}

/** Шаг 188 (§2): причина отказа, которую окно называет пунктом «что добавить» со ссылкой, второй раз строкой не повторяется */
const SETUP_OF: Readonly<Record<string, MissingSetup>> = { COST_REQUIRED: 'UNIT_COST', MIN_PRICE_MISSING: 'MIN_PRICE', MAX_PRICE_MISSING: 'MAX_PRICE' };

/** Итог попытки включения: отказы, предупреждения и явное «всё равно включить» (шаг 12, G) */
/** Шаг 175: у причины отказа снимается приставка, которую уже сказал заголовок окна; первая буква остатка — заглавная */
function withoutPrefix<T extends { text: string }>(reason: T, prefix: string): T {
  if (prefix === '' || !reason.text.startsWith(prefix)) return reason;
  const rest = reason.text.slice(prefix.length);
  return { ...reason, text: rest.charAt(0).toLocaleUpperCase() + rest.slice(1) };
}

export function EnableResultView(props: { unit: string; worldId?: string; result: EnableResult | null; busy: boolean; error: string | null; onAcknowledge: () => void; onClose: () => void;
  /** Шаг 148 (#27, UX-05): что добавить для включения — каждое со ссылкой туда, где это задают */
  missing?: { writeScopeId: string; items: readonly MissingSetup[] } }) {
  const m = useMessages();
  const d = m.ui.app.dialog;
  const { result } = props;
  // Шаг 79 (ревью): заголовок говорит исход, а не повторяет вопрос после отказа; отказ — красной пилюлей
  const refused = result !== null && !result.enabled && result.problems.length > 0;
  const title = result?.enabled ? d.enabledTitle(props.unit) : refused ? d.refusedTitle(props.unit) : d.enableTitle(props.unit);
  /**
   * Шаг 188 (письмо Мердана 28.11, §2): причина, которую называет пункт «что добавить», строкой выше не повторяется (было трижды: заголовок,
   * причина, пункт); отказ, которому не хватает только настройки, — «Setup required» янтарной пилюлей, иной — прежний красный «Refused»
   */
  const listed = new Set(props.worldId && props.missing ? props.missing.items : []);
  const covered = (code: string) => SETUP_OF[code] !== undefined && listed.has(SETUP_OF[code]!);
  const problems = result ? result.problems.filter((r) => !covered(r.code)) : [];
  const setupOnly = refused && problems.length === 0;
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="enable-title">
      <h3 id="enable-title">{title}{setupOnly ? <> <Badge tone="warn">{d.setupRequired}</Badge></> : refused ? <> <Badge tone="stop">{d.refused}</Badge></> : result?.enabled ? <> <Badge tone="ok">{d.enabledBadge}</Badge></> : null}</h3>
      {props.error ? <ErrorBox message={props.error} /> : null}
      {!result ? <p className="loading" role="status">{d.busy(8)}</p> : null}
      {result?.enabled ? <p className="notice" role="status">{d.enabled}</p> : null}
      {result && result.problems.length > 0 ? (
        <>
          {/* Шаг 175 (QA-A Testing 2.0, этап 4): заголовок уже сказал «Repricing not enabled» — причины его не повторяют */}
          {problems.length > 0 ? <>
            <p><strong>{d.enableProblems}</strong></p>
            <ul className="problems">{problems.map((r) => <li key={r.code}><ReasonLine reason={withoutPrefix(r, d.refusedTitle(''))} /></li>)}</ul>
          </> : null}
          {props.worldId && props.missing && props.missing.items.length > 0 ? (
            <>
              <p><strong>{m.ui.products.missingTitle}</strong></p>
              <ul className="missing-setup">
                {props.missing.items.map((item) => (
                  <li key={item} data-missing={item}>
                    {/* Шаг 188: себестоимость одного предложения вводится на его странице (шаг 187); границы — правкой с ним выбранным */}
                    <a className="row-link" href={item === 'UNIT_COST' ? href(props.worldId!, 'bounds', props.missing!.writeScopeId) : href(props.worldId!, 'costs', 'edit', props.missing!.writeScopeId)}>{m.ui.products.missingItems[item]}</a>
                  </li>
                ))}
              </ul>
            </>
          ) : props.worldId && result.problems.some((r) => r.code === 'COST_REQUIRED')
            ? <p><a className="row-link" href={href(props.worldId, 'costs', 'import')}>{d.addCost}</a></p> : null}
        </>
      ) : null}
      {result && !result.enabled && result.problems.length === 0 && result.warnings.length > 0 ? (
        <>
          <p><strong>{d.enableWarnings}</strong></p>
          <ul>{result.warnings.map((r) => <li key={r.code}><ReasonLine reason={r} /></li>)}</ul>
        </>
      ) : null}
      {/* Шаг 94: ряд кнопок окна — справа, «Отмена»/«Закрыть» перед главным действием (Primer Dialog) */}
      <FormActions dialog>
        <button type="button" onClick={props.onClose} disabled={props.busy}>{result ? d.close : d.cancel}</button>
        {result && !result.enabled && result.problems.length === 0 && result.warnings.length > 0
          ? <button type="button" className="danger" disabled={props.busy} onClick={props.onAcknowledge}>{d.enableAnyway}</button>
          : null}
      </FormActions>
    </div>
  );
}

/**
 * Шаг 118: выключение автоцены одного предложения — без второго фактора (забор не двигается, Р-225), записка по желанию. Окно говорит, что будет
 * с ценой и с записями в очереди, и закрывается итогом; ошибка — словами сервера
 */
export function DisableView(props: { unit: string; done: boolean; busy: boolean; error: string | null; onConfirm: (note: string) => void; onClose: () => void }) {
  const m = useMessages();
  const d = m.ui.enabled.disable;
  const [note, setNote] = useState('');
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="disable-title">
      <h3 id="disable-title">{props.done ? d.done(props.unit) : d.title(props.unit)}{props.done ? <> <Badge tone="off">{d.doneBadge}</Badge></> : null}</h3>
      {props.error ? <ErrorBox message={props.error} /> : null}
      {props.done ? null : <>
        <p>{d.body}</p>
        <Field label={d.note} caption={d.noteHint}>
          <textarea value={note} maxLength={PRICING_SWITCH_NOTE_MAX} rows={2} onChange={(e) => setNote(e.currentTarget.value)} />
        </Field>
      </>}
      <FormActions dialog>
        <button type="button" onClick={props.onClose} disabled={props.busy}>{props.done ? d.close : d.cancel}</button>
        {props.done ? null : <button type="button" className="primary" disabled={props.busy} onClick={() => props.onConfirm(note)}>{d.confirm}</button>}
      </FormActions>
    </div>
  );
}

/** Шаг 112 [Р-238]: вторая строка предложения на Offers — цвет товара, идентификатор товара в канале и состояние, если оно не «новое» */

/**
 * Шаг 179 (#39): массовые операции с Offers — галочки строк, строка выбора («N selected · M outside current view», «Select all matching»,
 * «Review selection») и переход в правку границ или назначение стратегии с этим выбором (передача — `handover.ts`)
 */
function OffersWithSelection(props: Parameters<typeof ProductsView>[0] & { worldId: string; selection: OfferSelection; onSelection: (s: OfferSelection) => void;
  review: ListQuery | null; onReview: (q: ListQuery | null) => void }) {
  const { view, worldId, selection, onSelection, review, onReview, offerQuery = NO_OFFER_QUERY } = props;
  const m = useMessages();
  const filter = filterOfUi(offerQuery);
  const summary = useSelectionSummary(worldId, selection, filter, view.rows.map((r) => r.unit.writeScopeId), review, 0);
  const t = m.ui.selection;
  const go = (screen: 'costs' | 'strategies') => {
    handOver(worldId, selection);
    location.hash = screen === 'costs' ? href(worldId, 'costs', 'edit') : href(worldId, 'strategies');
  };
  const selectionUi = (
    <div className="offers-selection">
      <SelectionBar summary={summary} selection={selection} onSelection={onSelection} filter={filter} matching={view.matched ?? view.totals.total} storefronts={view.filters.storefronts}
        review={review !== null} onReview={(on) => onReview(on ? { offset: 0, limit: LIST_PAGE_DEFAULT } : null)} />
      <div className="buttons">
        <button type="button" disabled={(summary?.selected ?? 0) === 0} onClick={() => go('costs')}>{t.toBounds}</button>
        <button type="button" disabled={(summary?.selected ?? 0) === 0} onClick={() => go('strategies')}>{t.toStrategy}</button>
      </div>
    </div>
  );
  const reviewList = review ? (
    <>
      <h4>{t.reviewTitle}</h4>
      <BoundsIndexView worldId={worldId} items={summary?.review?.items ?? []} embedded heading={false} filtered frame="products"
        pick={{ picked: (id) => !selection.except.includes(id), onToggle: (id, on) => onSelection(toggleOffer(selection, id, on, true)), canPick: canPickMore(selection) }} />
      {summary?.review ? <Pager page={summary.review.page} query={review} onQuery={onReview} /> : null}
    </>
  ) : null;
  return <ProductsView {...props} pick={{ picked: (id) => isPicked(selection, summary, id), onToggle: (id, on) => onSelection(toggleOffer(selection, id, on, isPicked(selection, summary, id))), canPick: canPickMore(selection) }}
    selectionUi={selectionUi} reviewList={reviewList} />;
}

export function ProductsScreen({ worldId, initialAttention, initialQuery }: { worldId: string; initialAttention?: AttentionFilter; initialQuery?: OfferUiQuery }) {
  const m = useMessages();
  // Р-136: экран просит страницу; переключение страницы — новый запрос, как у ленты цен
  // Шаг 181 (#38): фильтр и страница переживают навигацию (память вкладки); выборка из ссылки — важнее запомненной
  const explicit = initialQuery ?? (initialAttention ? { ...NO_OFFER_QUERY, attention: initialAttention } : undefined);
  const [query, setQuery] = useRemembered<ListQuery>(rememberKey(worldId, 'offers.page'), { offset: 0, limit: LIST_PAGE_DEFAULT }, explicit ? { offset: 0, limit: LIST_PAGE_DEFAULT } : undefined);
  // Шаг 105: фильтр, порядок и включённые колонки Buy Box — в адресе экрана; новый фильтр или порядок — с первой страницы.
  // Шаг 146 (#34): `products/attention/<причина>` — клик по строке состояния открывает Offers с этой выборкой
  // Шаг 170 (#35): `products/filter/<параметры>` — пункт чеклиста готовности открывает Offers со своей выборкой
  const [offerQuery, setOfferQuery] = useRemembered<OfferUiQuery>(rememberKey(worldId, 'offers.filter'), NO_OFFER_QUERY, explicit);
  // Шаг 181 (#38): выборка — и в адресе (`products/filter/<параметры>`): ссылка несёт её, «назад» с квитанции возвращает её
  useEffect(() => {
    const f = { ...filterOfUi(offerQuery) } as Record<string, string>;
    const path = Object.keys(f).length === 0 ? href(worldId, 'products') : href(worldId, 'products', 'filter', new URLSearchParams(f).toString());
    try { if (location.hash !== path) history.replaceState(history.state, '', path); } catch { /* адрес — удобство */ }
  }, [worldId, offerQuery]);
  // Шаг 179 (#39, уточнение Р-140): выбор для массовых операций — переживает страницы и фильтры, виден строкой выбора
  const [selection, setSelection] = useState<OfferSelection>(NO_SELECTION);
  const [review, setReview] = useState<ListQuery | null>(null);
  const [bb, setBb] = useState(storedBuyboxColumns);
  const params = new URLSearchParams({ offset: String(query.offset), limit: String(query.limit), ...offerParams(offerQuery, bb) });
  const [resource, retry] = useResource<ProductListView>(`${worldPath(worldId, 'products')}?${params}`, m.locale);
  const [row, setRow] = useState<ProductRow | null>(null);
  const [result, setResult] = useState<EnableResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enable = async (target: ProductRow, acknowledgeWarnings: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await requestJson<EnableResult>(worldPath(worldId, 'scopes', target.unit.writeScopeId, 'enable'), { method: 'POST', body: { acknowledgeWarnings }, locale: m.locale });
      setResult(r);
      if (r.enabled) retry();
    } catch (e) {
      setError(errorText(e, m));
    } finally {
      setBusy(false);
    }
  };
  const close = () => { setRow(null); setResult(null); setError(null); };
  // Шаг 118: выключение автоцены — своё окно; после итога экран перечитывается
  const [off, setOff] = useState<{ row: ProductRow; done: boolean } | null>(null);
  const disable = async (target: ProductRow, note: string) => {
    setBusy(true);
    setError(null);
    try {
      await requestJson<DisableResult>(worldPath(worldId, 'scopes', target.unit.writeScopeId, 'disable'),
        { method: 'POST', body: { note: note.trim() === '' ? null : note.trim() } satisfies DisableRequest, locale: m.locale });
      setOff({ row: target, done: true });
      retry();
    } catch (e) {
      setError(errorText(e, m));
    } finally {
      setBusy(false);
    }
  };
  const closeOff = () => { setOff(null); setError(null); };

  return (
    <>
      {row ? <EnableResultView unit={row.unit.label} worldId={worldId} result={result} busy={busy} error={error} onAcknowledge={() => void enable(row, true)} onClose={close}
        missing={{ writeScopeId: row.unit.writeScopeId, items: row.missing }} /> : null}
      {off ? <DisableView unit={off.row.unit.label} done={off.done} busy={busy} error={error} onConfirm={(note) => void disable(off.row, note)} onClose={closeOff} /> : null}
      <Load shape="table" resource={resource} retry={retry}>
        {(view) => <OffersWithSelection view={view} worldId={worldId} query={query} onQuery={setQuery} onEnable={(r) => { setRow(r); setResult(null); void enable(r, false); }}
          onDisable={(r) => { setRow(null); setError(null); setOff({ row: r, done: false }); }} selection={selection} onSelection={setSelection} review={review} onReview={setReview}
          offerQuery={offerQuery} onOfferQuery={(q) => { setOfferQuery(q); setQuery({ ...query, offset: 0 }); }} onBuyboxColumns={setBb} />}
      </Load>
    </>
  );
}
