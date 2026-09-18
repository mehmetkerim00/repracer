import { useState } from 'react';
import { LIST_PAGE_DEFAULT, type ListQuery, type ProductListView, type ProductRow } from '@repracer/console-model';
import type { EnableResult } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, Cell, ErrorBox, errorText, Gaps, href, Load, Pager, ReasonLine, useMessages } from '../components.tsx';

/** Экран A: действующий пол — главная цифра, min_price — его составляющая (шаг 12, F) */
export function ProductsView({ view, onEnable, query, onQuery }: {
  view: ProductListView; onEnable?: (row: ProductRow) => void; query?: ListQuery; onQuery?: (q: ListQuery) => void;
}) {
  const m = useMessages();
  const p = m.ui.products;
  const c = p.columns;
  return (
    <section>
      <h2>{p.title}</h2>
      <p className="muted">{p.totals(view.totals)} {p.clock(view.now)}</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{c.unit}</th><th>{c.current}</th><th>{c.floor}</th><th>{c.ceiling}</th><th>{c.strategy}</th>
              <th>{c.enabled}</th><th>{c.applying}</th><th>{c.lastChange}</th><th>{c.nextCheck}</th><th>{c.channel}</th><th />
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.unit.writeScopeId}>
                <td>
                  <strong>{r.unit.label}</strong>
                  <div className="muted small">{p.productRef(r.unit.channelProductRef, r.unit.condition, r.unit.gtin)}</div>
                </td>
                <td className="num">{r.currentPrice}</td>
                <td className="num floor">
                  <strong>{r.floor.amount}</strong>
                  <div className="muted small">{r.floor.parts}</div>
                </td>
                <td className="num">{r.maxPrice}</td>
                <td>
                  {r.strategy.label} {r.strategy.competitorDerived ? <Badge tone="progress">{p.competitorBadge}</Badge> : null}
                  <div className="muted small">{r.strategy.detail}</div>
                </td>
                <td><Cell cell={r.enabled} /></td>
                <td><Cell cell={r.applying} /></td>
                <td><Cell cell={r.lastChange} /></td>
                <td><Cell cell={r.nextCheck} /></td>
                <td>{r.channelNotes.length === 0 ? '–' : r.channelNotes.map((n) => <Cell key={n.code} cell={n} />)}</td>
                <td className="actions">
                  {r.latestDecisionId
                    ? <a href={href(view.worldId, 'decisions', r.latestDecisionId)}>{p.why}</a>
                    : <span className="muted small">{p.noDecisions}</span>}
                  <a href={href(view.worldId, 'bounds', r.unit.writeScopeId)}>{p.bounds}</a>
                  {r.canEnable && onEnable ? <button type="button" onClick={() => onEnable(r)}>{p.enable}</button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {query && onQuery ? <Pager page={view.page} query={query} onQuery={onQuery} /> : null}
      <Gaps gaps={view.gaps} />
    </section>
  );
}

/** Итог попытки включения: отказы, предупреждения и явное «всё равно включить» (шаг 12, G) */
export function EnableResultView(props: { unit: string; result: EnableResult | null; busy: boolean; error: string | null; onAcknowledge: () => void; onClose: () => void }) {
  const m = useMessages();
  const d = m.ui.app.dialog;
  const { result } = props;
  return (
    <div className="confirm" role="dialog" aria-modal="false" aria-labelledby="enable-title">
      <h3 id="enable-title">{d.enableTitle(props.unit)}</h3>
      {props.error ? <ErrorBox message={props.error} /> : null}
      {!result ? <p className="loading" role="status">{d.busy(8)}</p> : null}
      {result?.enabled ? <p className="notice" role="status">{d.enabled}</p> : null}
      {result && result.problems.length > 0 ? (
        <>
          <p><strong>{d.enableProblems}</strong></p>
          <ul>{result.problems.map((r) => <li key={r.code}><ReasonLine reason={r} /></li>)}</ul>
        </>
      ) : null}
      {result && !result.enabled && result.problems.length === 0 && result.warnings.length > 0 ? (
        <>
          <p><strong>{d.enableWarnings}</strong></p>
          <ul>{result.warnings.map((r) => <li key={r.code}><ReasonLine reason={r} /></li>)}</ul>
        </>
      ) : null}
      <div className="buttons">
        {result && !result.enabled && result.problems.length === 0 && result.warnings.length > 0
          ? <button type="button" className="danger" disabled={props.busy} onClick={props.onAcknowledge}>{d.enableAnyway}</button>
          : null}
        <button type="button" onClick={props.onClose} disabled={props.busy}>{d.cancel}</button>
      </div>
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
      {row ? <EnableResultView unit={row.unit.label} result={result} busy={busy} error={error} onAcknowledge={() => void enable(row, true)} onClose={close} /> : null}
      <Load resource={resource} retry={retry}>
        {(view) => <ProductsView view={view} query={query} onQuery={setQuery} onEnable={(r) => { setRow(r); setResult(null); void enable(r, false); }} />}
      </Load>
    </>
  );
}
