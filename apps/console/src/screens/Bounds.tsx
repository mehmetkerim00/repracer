import type { BoundsView, PriceBreakdown } from '@repracer/console-model';
import type { BoundsIndexItem } from '../api-types.ts';
import { useResource, worldPath } from '../api.ts';
import { Gaps, href, Load, useMessages } from '../components.tsx';

export function BreakdownTable({ breakdown, currency }: { breakdown: PriceBreakdown; currency: string }) {
  const m = useMessages();
  const b = m.ui.bounds;
  return (
    <div className="breakdown">
      <h3>{breakdown.title}</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{b.columns.part}</th><th>{b.columns.amount(currency)}</th><th>{b.columns.formula}</th></tr></thead>
          <tbody>
            {breakdown.lines.map((l) => (
              <tr key={l.key} className={`line-${l.key}`}>
                <td>{l.label}</td>
                <td className="num">{l.amount}</td>
                <td className="small">{l.formula}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small">{b.exactMargin(breakdown.marginExact)} {b.balance(breakdown.balanced)} {breakdown.note}.</p>
    </div>
  );
}

export function BoundsScreenView({ view }: { view: BoundsView }) {
  const m = useMessages();
  const b = m.ui.bounds;
  return (
    <section>
      <p><a href={href(view.worldId, 'bounds')}>{b.back}</a></p>
      <h2>{b.pageTitle}</h2>
      <p className="muted">{view.unit.label} · {view.currency}, {view.priceBasis} · {view.taxRegime}</p>
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

      <h3>{b.costAndFees}</h3>
      {view.cost.unavailable ? <p className="gap-note">{view.cost.unavailable}</p> : (
        <ul>
          {view.cost.lines.map((l) => <li key={l.key}>{l.label}: <strong>{l.amount}</strong> <span className="small muted">({l.formula})</span></li>)}
        </ul>
      )}

      {view.floorBreakdown ? <BreakdownTable breakdown={view.floorBreakdown} currency={view.currency} /> : null}
      {view.currentBreakdown ? <BreakdownTable breakdown={view.currentBreakdown} currency={view.currency} /> : null}

      <h3>{b.calculator}</h3>
      <ol>{view.calculatorCheck.map((c) => <li key={c}>{c}</li>)}</ol>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

export function BoundsIndexView({ worldId, items }: { worldId: string; items: readonly BoundsIndexItem[] }) {
  const m = useMessages();
  return (
    <section>
      <h2>{m.ui.bounds.indexTitle}</h2>
      <ul className="index">
        {items.map((i) => (
          <li key={i.writeScopeId}><a href={href(worldId, 'bounds', i.writeScopeId)}>{i.label}</a> <span className="muted small">{i.minPrice} – {i.maxPrice}</span></li>
        ))}
      </ul>
    </section>
  );
}

export function BoundsScreen({ worldId, writeScopeId }: { worldId: string; writeScopeId: string | null }) {
  return writeScopeId === null ? <BoundsIndex worldId={worldId} /> : <BoundsDetail worldId={worldId} writeScopeId={writeScopeId} />;
}

function BoundsIndex({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<BoundsIndexItem[]>(worldPath(worldId, 'bounds'), m.locale);
  return <Load resource={resource} retry={retry}>{(items) => <BoundsIndexView worldId={worldId} items={items} />}</Load>;
}

function BoundsDetail({ worldId, writeScopeId }: { worldId: string; writeScopeId: string }) {
  const m = useMessages();
  const [resource, retry] = useResource<BoundsView>(worldPath(worldId, 'bounds', writeScopeId), m.locale);
  return <Load resource={resource} retry={retry}>{(view) => <BoundsScreenView view={view} />}</Load>;
}
