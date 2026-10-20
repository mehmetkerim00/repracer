import { useState } from 'react';
import { LIST_PAGE_DEFAULT, type ListQuery, type ProductListView, type ProductRow } from '@repracer/console-model';
import type { EnableResult } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, Cell, ErrorBox, errorText, Gaps, href, Load, Pager, ReasonLine, useMessages } from '../components.tsx';
import { CheckField, FormActions } from '../forms.tsx';

/** Шаг 79: колонки, которые продавец может скрыть; предложение, цена, пол, статус и действия — всегда */
const OPTIONAL_COLUMNS = ['ceiling', 'strategy', 'lastChange', 'nextCheck', 'channel'] as const;
type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];
const VIEW_KEY = 'repracer.products.view';
/**
 * «Следующая проверка» у всех предложений сейчас одна и та же («нет данных») — по умолчанию скрыта; «Канал сообщает» — когда есть что
 * сообщить. «Последнее изменение» по умолчанию скрыто: оно есть на «Why this price» и в ленте цен, а таблица должна помещаться в окно 1440
 * без прокрутки под закреплённую колонку действий (визуальное ревью шага 79); включается в «Columns»
 */
function defaultColumns(view: ProductListView): Record<OptionalColumn, boolean> {
  return { ceiling: true, strategy: true, lastChange: false, nextCheck: false, channel: view.rows.some((r) => r.channelNotes.length > 0) };
}
/** Выбор колонок и плотность — удобство одного зрителя: браузерное хранилище, без него — умолчания (шаг 79) */
function readView(view: ProductListView): { columns: Record<OptionalColumn, boolean>; compact: boolean } {
  const fallback = { columns: defaultColumns(view), compact: false };
  try {
    const raw = globalThis.localStorage?.getItem(VIEW_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { columns?: Partial<Record<OptionalColumn, boolean>>; compact?: boolean };
    return { columns: { ...fallback.columns, ...(parsed.columns ?? {}) }, compact: parsed.compact === true };
  } catch { return fallback; }
}

/** Экран A: действующий пол — главная цифра, min_price — его составляющая (шаг 12, F) */
export function ProductsView({ view, onEnable, query, onQuery }: {
  view: ProductListView; onEnable?: (row: ProductRow) => void; query?: ListQuery; onQuery?: (q: ListQuery) => void;
}) {
  const m = useMessages();
  const p = m.ui.products;
  const c = p.columns;
  const [shown, setShown] = useState(() => readView(view));
  const update = (next: typeof shown) => {
    setShown(next);
    try { globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(next)); } catch { /* без хранилища — до перезагрузки страницы */ }
  };
  const col = shown.columns;
  return (
    <section>
      <h2>{p.title}</h2>
      <p className="subtitle">{m.ui.app.subtitles.products}</p>
      {/* Задача D шага 34: новый тенант без данных видит, ПОЧЕМУ пусто и куда идти, а не пустую таблицу */}
      {view.rows.length === 0 ? <p className="notice">{m.ui.onboarding.empty.products} <a href={href(view.worldId, 'channels')}>{m.ui.onboarding.empty.startHere}</a></p> : null}
      {view.rows.length > 0 ? <div className="table-wrap">
        {/* Шаг 79: итоги и вид таблицы — в её шапке; колонки выбираются, строки бывают компактными */}
        <div className="table-head">
          <span>{p.totals(view.totals)}</span>
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
            <CheckField label={p.viewOptions.compact} checked={shown.compact} onChange={(on) => update({ ...shown, compact: on })} />
          </span>
        </div>
        <table className={`products sticky-end${shown.compact ? ' compact' : ''}${col.channel ? ' with-channel' : ''}`}>
          <thead>
            <tr>
              {/* Шаг 79 (ревью): статус — сразу после предложения: широкая таблица листается под закреплённой колонкой действий, и статус не прячется */}
              <th>{c.unit}</th><th>{c.status}</th><th className="num">{c.current}</th><th className="num">{c.floor}</th>{col.ceiling ? <th className="num">{c.ceiling}</th> : null}
              {col.strategy ? <th>{c.strategy}</th> : null}{col.lastChange ? <th>{c.lastChange}</th> : null}
              {col.nextCheck ? <th>{c.nextCheck}</th> : null}{col.channel ? <th>{c.channel}</th> : null}<th />
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.unit.writeScopeId}>
                <td className="offer">
                  <strong>{r.unit.label}</strong>
                  {/* Шаг 102 [Р-227]: режим распродажи — пилюлей attention у названия */}
                  {r.clearance ? <> <Badge tone="warn">{r.clearance}</Badge></> : null}
                  {/* Шаг 102: пол выше потолка — цены заморожены законно, но не молча */}
                  {r.frozen ? <> <Badge tone="stop">{r.frozen}</Badge></> : null}
                  {/* Шаг 78: номер товара канала — приглушённо, состояние — отдельной пилюлей */}
                  {/* Шаг 79: «новый» — обычное состояние, пилюлю не показываем; иное — словами на языке экрана, а не кодом канала */}
                  <div className="product-ref">{p.productId(r.unit.channelProductRef, r.unit.gtin)} {r.unit.condition && r.unit.condition.toLowerCase() !== 'new'
                    ? <Badge tone="off">{(p.conditions as Record<string, string | undefined>)[r.unit.condition.toLowerCase()] ?? r.unit.condition}</Badge> : null}</div>
                </td>
                {/* Шаг 79: «On» и «In progress» — одна колонка: включённость всегда, ход — только когда что-то идёт */}
                <td className="status-cell"><Cell cell={r.enabled} />{r.applying.tone !== 'ok' ? <Cell cell={r.applying} /> : null}</td>
                <td className="num money cur">{r.currentPrice}</td>
                <td className="num cur floor">
                  <strong>{r.floor.amount}</strong>
                  <div className="muted small floor-parts">{r.floor.parts}</div>
                </td>
                {col.ceiling ? <td className="num cur">{r.maxPrice}</td> : null}
                {/* Шаг 78: источник пилюлей и короткое имя; подробности стратегии — подсказкой и на «Why this price» */}
                {col.strategy ? <td className="strategy" title={r.strategy.detail}>
                  {r.strategy.competitorDerived ? <Badge tone="progress">{p.competitorBadge}</Badge> : null} <span className="strategy-name">{r.strategy.label}</span>
                  {/* Шаг 103 [Р-228]: правило умолчания аккаунта не назначило стратегию — причина словами под именем */}
                  {r.notAssigned ? <div className="muted small">{r.notAssigned}</div> : null}
                </td> : null}
                {col.lastChange ? <td><Cell cell={r.lastChange} /></td> : null}
                {col.nextCheck ? <td><Cell cell={r.nextCheck} /></td> : null}
                {col.channel ? <td className="channel-says">{r.channelNotes.length === 0 ? '–' : r.channelNotes.map((n) => (
                  <div key={n.code}>
                    <Cell cell={n} />
                    {/* Шаг 96 (А6): у пилюли — короткое «что делать», раскрывается на месте */}
                    {n.whatToDo ? <details className="what-to-do"><summary>{n.whatToDo.label}</summary><p>{n.whatToDo.text}</p></details> : null}
                  </div>
                ))}</td> : null}
                {/* Шаг 78: одна колонка действий — основная «Why this price», под ней мелкая вторичная «Bounds» */}
                <td className="actions">
                  {r.latestDecisionId
                    ? <a className="row-link" href={href(view.worldId, 'decisions', r.latestDecisionId)}>{p.why}</a>
                    : <span className="muted small">{p.noDecisions}</span>}
                  <a className="secondary-link" href={href(view.worldId, 'bounds', r.unit.writeScopeId)}>{m.ui.app.screens.bounds}</a>
                  {/* Шаг 97 [E]: страница конкурентов предложения — ссылкой из строки, не пунктом меню */}
                  <a className="secondary-link" href={href(view.worldId, 'competition', r.unit.writeScopeId)}>{m.ui.competition.link}</a>
                  {r.canEnable && onEnable ? <button type="button" onClick={() => onEnable(r)}>{p.enable}</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div> : null}
      {query && onQuery && view.rows.length > 0 ? <Pager page={view.page} query={query} onQuery={onQuery} /> : null}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

/** Итог попытки включения: отказы, предупреждения и явное «всё равно включить» (шаг 12, G) */
export function EnableResultView(props: { unit: string; worldId?: string; result: EnableResult | null; busy: boolean; error: string | null; onAcknowledge: () => void; onClose: () => void }) {
  const m = useMessages();
  const d = m.ui.app.dialog;
  const { result } = props;
  // Шаг 79 (ревью): заголовок говорит исход, а не повторяет вопрос после отказа; отказ — красной пилюлей
  const refused = result !== null && !result.enabled && result.problems.length > 0;
  const title = result?.enabled ? d.enabledTitle(props.unit) : refused ? d.refusedTitle(props.unit) : d.enableTitle(props.unit);
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="enable-title">
      <h3 id="enable-title">{title}{refused ? <> <Badge tone="stop">{d.refused}</Badge></> : result?.enabled ? <> <Badge tone="ok">{d.enabledBadge}</Badge></> : null}</h3>
      {props.error ? <ErrorBox message={props.error} /> : null}
      {!result ? <p className="loading" role="status">{d.busy(8)}</p> : null}
      {result?.enabled ? <p className="notice" role="status">{d.enabled}</p> : null}
      {result && result.problems.length > 0 ? (
        <>
          <p><strong>{d.enableProblems}</strong></p>
          <ul className="problems">{result.problems.map((r) => <li key={r.code}><ReasonLine reason={r} /></li>)}</ul>
          {props.worldId && result.problems.some((r) => r.code === 'COST_REQUIRED')
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

export function ProductsScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  // Р-136: экран просит страницу; переключение страницы — новый запрос, как у ленты цен
  const [query, setQuery] = useState<ListQuery>({ offset: 0, limit: LIST_PAGE_DEFAULT });
  const [resource, retry] = useResource<ProductListView>(`${worldPath(worldId, 'products')}?offset=${query.offset}&limit=${query.limit}`, m.locale);
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

  return (
    <>
      {row ? <EnableResultView unit={row.unit.label} worldId={worldId} result={result} busy={busy} error={error} onAcknowledge={() => void enable(row, true)} onClose={close} /> : null}
      <Load shape="table" resource={resource} retry={retry}>
        {(view) => <ProductsView view={view} query={query} onQuery={setQuery} onEnable={(r) => { setRow(r); setResult(null); void enable(r, false); }} />}
      </Load>
    </>
  );
}
