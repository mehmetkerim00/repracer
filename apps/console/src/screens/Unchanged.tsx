import { useState } from 'react';
import { HOT_DECISIONS_DAYS, periodSearch, type Period, type UnchangedView as UnchangedViewModel } from '@repracer/console-model';
import { useResource, worldPath } from '../api.ts';
import { Badge, href, Load, NotFound, useMessages } from '../components.tsx';
import { PeriodPicker } from '../date-range.tsx';
import { DecisionsView, TraceView } from './Decisions.tsx';

/**
 * Шаг 169 (#36, Р-254): «Why didn't my price change?» — ответ как квитанция: строка сути, фраза последнего сохранённого решения с пилюлей
 * статуса и факты из тех же строк; доказательства — квитанция этого решения и решения предложения за период — свёрнуты. Решений за период
 * нет — так и сказано, с объяснением, когда они появляются; причина не угадывается
 */
export function UnchangedView({ view, period, onPeriod }: { view: UnchangedViewModel; period: Period; onPeriod: (p: Period) => void }) {
  const m = useMessages();
  const t = m.ui.unchanged;
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <section className="unchanged">
      <p className="back"><a href={href(view.worldId, 'products')}>{m.ui.competition.back}</a></p>
      <h2>{t.title}</h2>
      <p className="subtitle">{view.unit.label} · <a href={href(view.worldId, 'bounds', view.unit.writeScopeId)}>{m.ui.products.bounds}</a> · {t.subtitle}</p>
      <div className="filters">
        <PeriodPicker value={period} onChange={onPeriod} maxDays={HOT_DECISIONS_DAYS} />
      </div>
      {view.clipped ? <p className="notice">{m.ui.period.clipped(HOT_DECISIONS_DAYS)}</p> : null}
      <section className={`card unchanged-answer unchanged-${view.state.toLowerCase()}`}>
        {view.lead ? <p className="unchanged-lead muted">{view.lead}</p> : null}
        <p className="headline">{view.status ? <><Badge tone={view.status.tone}>{view.status.label}</Badge> </> : null}{view.headline}</p>
        {view.facts.length > 0 ? <ul className="plain facts">{view.facts.map((f) => <li key={f}>{f}</li>)}</ul> : null}
        {view.noneText ? <p className="muted">{view.noneText}</p> : null}
        {view.decisionId ? <p><a className="row-link" href={href(view.worldId, 'decisions', view.decisionId)}>{t.openReceipt}</a></p> : null}
      </section>
      {view.evidence ? (
        <details className="card more-block" open={receiptOpen} onToggle={(e) => setReceiptOpen(e.currentTarget.open)}>
          <summary>{t.evidence}</summary>
          <TraceView trace={view.evidence} embedded />
        </details>
      ) : null}
      {view.history.length > 0 ? (
        <details className="card more-block" open={historyOpen} onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
          <summary>{t.history} ({view.total})</summary>
          <DecisionsView worldId={view.worldId} items={view.history} />
        </details>
      ) : null}
    </section>
  );
}

/**
 * Шаг 169 (#36): вход из пустой выборки журнала цен — с выбранным предложением ссылка на ответ этого предложения за тот же период; без него —
 * подсказка выбрать предложение (ответ — о предложении, а не о каталоге)
 */
export function UnchangedHint({ worldId, writeScopeId, period }: { worldId: string; writeScopeId: string | undefined; period: Period }) {
  const m = useMessages();
  return writeScopeId
    ? <p className="unchanged-hint"><a className="row-link" href={href(worldId, 'unchanged', writeScopeId, periodSearch(period))}>{m.ui.unchanged.link}</a></p>
    : <p className="unchanged-hint muted small">{m.ui.unchanged.pickOffer}</p>;
}

export function UnchangedScreen({ worldId, writeScopeId, initialPeriod }: { worldId: string; writeScopeId: string; initialPeriod?: Period }) {
  const m = useMessages();
  const c = m.ui.competition;
  // Период — из адреса (`unchanged/<предложение>/period=24h`: вход из пустого журнала цен несёт период выборки), иначе неделя
  const [period, setPeriod] = useState<Period>(initialPeriod ?? { preset: '7d' });
  const [resource, retry] = useResource<UnchangedViewModel>(`${worldPath(worldId, 'unchanged', writeScopeId)}?${periodSearch(period)}`, m.locale);
  const missing = <NotFound title={c.missingTitle} text={c.missingText} back={m.ui.app.screens.products} href={href(worldId, 'products')} />;
  return <Load shape="cards" resource={resource} retry={retry} notFound={missing}>{(view) => <UnchangedView view={view} period={period} onPeriod={setPeriod} />}</Load>;
}
