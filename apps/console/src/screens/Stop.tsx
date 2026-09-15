import { useState } from 'react';
import type { HaltCard, StopCard, StopPlan, StopTarget, StopView, TargetCard } from '@repracer/console-model';
import { NOTE_MIN } from '../api-types.ts';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, Gaps, Load, NoteConfirm, useMessages } from '../components.tsx';

/**
 * Экран E — два разных действия [Р-69]: остановка человеком (все цены) и системная остановка витрины по испорченным данным
 * (только цены из данных конкурентов). Первое нажатие — последствия, второе — действие с заметкой. Кнопки — по роли [OQ-125].
 */

function TargetCardView({ card, onStop }: { card: TargetCard; onStop?: (target: StopTarget) => void }) {
  const m = useMessages();
  const s = m.ui.stop;
  return (
    <div className={`card ${card.coveredBy ? 'stopped' : ''}`}>
      <h3>{card.label}</h3>
      <p>{card.coveredBy ? <Badge tone="stop">{s.stopped}</Badge> : <Badge tone="ok">{s.running}</Badge>}</p>
      {card.coveredBy ? <p className="small">{s.coveredBy(card.coveredBy.scopeLabel, card.coveredBy.since)}</p> : null}
      <p className="small">{card.impact.text}</p>
      {card.canStop && onStop ? <button type="button" className="danger" onClick={() => onStop(card.target)}>{card.target.kind === 'TENANT' ? s.stopTenant : s.stopTarget}</button> : null}
    </div>
  );
}

function StopCardView({ stop, onResume }: { stop: StopCard; onResume?: (stop: StopCard) => void }) {
  const m = useMessages();
  const s = m.ui.stop;
  return (
    <div className={`card ${stop.released ? '' : 'stopped'}`}>
      <h3>{stop.scopeLabel}</h3>
      <p><Badge tone={stop.released ? 'off' : 'stop'}>{stop.released ? s.stopHistory : s.stopped}</Badge> {stop.since}</p>
      <p className="small">{s.by(stop.by)}</p>
      <p className="small">{s.noteLabel(stop.note)}</p>
      {stop.released ? <p className="small muted">{stop.released}</p> : null}
      {stop.canResume && onResume ? <button type="button" onClick={() => onResume(stop)}>{s.resume}</button> : null}
    </div>
  );
}

function HaltCardView({ halt, onRelease }: { halt: HaltCard; onRelease?: (halt: HaltCard) => void }) {
  const m = useMessages();
  return (
    <div className={`card ${halt.released ? '' : 'stopped'}`}>
      <h3>{halt.scopeLabel}</h3>
      <p><Badge tone={halt.released ? 'off' : 'warn'}>{halt.reason}</Badge> {halt.since}</p>
      <p className="small muted">{halt.released ?? halt.review}</p>
      {halt.canRelease && onRelease ? <button type="button" onClick={() => onRelease(halt)}>{m.ui.stop.release}</button> : null}
    </div>
  );
}

export function StopScreenView({ view, onStop, onResume, onRelease }: {
  view: StopView;
  onStop?: (target: StopTarget) => void;
  onResume?: (stop: StopCard) => void;
  onRelease?: (halt: HaltCard) => void;
}) {
  const m = useMessages();
  const s = m.ui.stop;
  return (
    <section>
      <h2>{s.pageTitle}</h2>

      <section className="stop-human">
        <h3>{s.humanTitle}</h3>
        <p className="muted">{s.humanIntro}</p>
        {!view.permissions.canStop ? <p className="notice">{s.noRight}</p> : null}
        <h4>{s.tenantTitle}</h4>
        <div className="cards"><TargetCardView card={view.tenant} {...(onStop ? { onStop } : {})} /></div>
        <h4>{s.accountsTitle}</h4>
        <div className="cards">{view.accounts.map((c) => <TargetCardView key={c.label} card={c} {...(onStop ? { onStop } : {})} />)}</div>
        <h4>{s.storefrontsTitle}</h4>
        <div className="cards">{view.storefronts.map((c) => <TargetCardView key={c.label} card={c} {...(onStop ? { onStop } : {})} />)}</div>
        <p><strong>{s.notStoppedTitle}</strong></p>
        <ul>{view.notStopped.map((n) => <li key={n}>{n}</li>)}</ul>
        <h4>{s.activeStops}</h4>
        {view.stops.active.length === 0 ? <p className="muted">{s.none}</p>
          : <div className="cards">{view.stops.active.map((st) => <StopCardView key={st.stopId} stop={st} {...(onResume ? { onResume } : {})} />)}</div>}
        {view.stops.history.length > 0 ? (
          <>
            <h4>{s.stopHistory}</h4>
            <div className="cards">{view.stops.history.map((st) => <StopCardView key={st.stopId} stop={st} />)}</div>
          </>
        ) : null}
      </section>

      <section className="stop-system">
        <h3>{s.systemTitle}</h3>
        <p className="muted">{s.systemIntro}</p>
        <h4>{s.activeHalts}</h4>
        {view.halts.active.length === 0 ? <p className="muted">{s.none}</p>
          : <div className="cards">{view.halts.active.map((h) => <HaltCardView key={h.haltId} halt={h} {...(onRelease ? { onRelease } : {})} />)}</div>}
        {view.halts.history.length > 0 ? (
          <>
            <h4>{s.haltHistory}</h4>
            <div className="cards">{view.halts.history.map((h) => <HaltCardView key={h.haltId} halt={h} />)}</div>
          </>
        ) : null}
      </section>
      <section className="stop-audit">
        <h3>{s.auditTitle}</h3>
        {view.audit.length === 0 ? <p className="muted">{s.auditEmpty}</p> : (
          <div className="table-wrap">
            <table>
              <tbody>
                {view.audit.map((a, i) => (
                  <tr key={i}>
                    <td className="nowrap">{a.at}</td>
                    <td>{a.action}</td>
                    <td>{a.actor}</td>
                    <td>{a.scope}</td>
                    <td>{a.note ? s.noteLabel(a.note) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Gaps gaps={view.gaps} />
    </section>
  );
}

type Pending =
  | { kind: 'stop'; target: StopTarget; plan: StopPlan | null }
  | { kind: 'resume'; stop: StopCard }
  | { kind: 'release'; halt: HaltCard }
  | null;

export function StopScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const d = m.ui.app.dialog;
  const [resource, retry] = useResource<StopView>(worldPath(worldId, 'stop'), m.locale);
  const [pending, setPending] = useState<Pending>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reset = () => { setPending(null); setNote(''); setError(null); setBusy(false); };

  // Нажатие 1: последствия считает сервер по тому же миру
  const askStop = async (target: StopTarget) => {
    reset();
    setMessage(null);
    setPending({ kind: 'stop', target, plan: null });
    try {
      const plan = await requestJson<StopPlan>(worldPath(worldId, 'stop', 'plan'), { method: 'POST', body: { target }, locale: m.locale });
      setPending({ kind: 'stop', target, plan });
    } catch (e) {
      setError(errorText(e, m));
    }
  };

  // Нажатие 2: выполнить
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(null);
    const body = { note, confirmed: true };
    try {
      const result = pending.kind === 'stop'
        ? await requestJson<{ message: string }>(worldPath(worldId, 'stop'), { method: 'POST', body: { ...body, target: pending.target }, locale: m.locale })
        : pending.kind === 'resume'
          ? await requestJson<{ message: string }>(worldPath(worldId, 'stops', pending.stop.stopId, 'resume'), { method: 'POST', body, locale: m.locale })
          : await requestJson<{ message: string }>(worldPath(worldId, 'halts', pending.halt.haltId, 'release'), { method: 'POST', body, locale: m.locale });
      reset();
      setMessage(result.message);
      retry();
    } catch (e) {
      setBusy(false);
      setError(errorText(e, m));
    }
  };

  const dialog = { note, noteMin: NOTE_MIN, busy, error, onNote: setNote, onConfirm: () => void confirm(), onCancel: reset };
  return (
    <>
      {message ? <p className="notice" role="status">{message}</p> : null}
      {pending?.kind === 'stop' && !pending.plan ? (
        error ? <ErrorBox message={error} onRetry={() => void askStop(pending.target)} /> : <p className="loading" role="status">{d.busy(8)}</p>
      ) : null}
      {pending?.kind === 'stop' && pending.plan ? (
        pending.plan.alreadyActive
          ? <ErrorBox message={m.ui.server.alreadyStopped} onRetry={reset} />
          : <NoteConfirm {...dialog} title={pending.plan.confirmTitle} text={pending.plan.confirmText} confirmLabel={d.confirmStop}
              list={{ title: m.ui.stop.notStoppedTitle, items: resource.state === 'ready' ? resource.data.notStopped : [] }} />
      ) : null}
      {pending?.kind === 'resume' ? <NoteConfirm {...dialog} title={d.resumeTitle(pending.stop.scopeLabel)} text={d.resumeText} confirmLabel={d.confirmResume} /> : null}
      {pending?.kind === 'release' ? <NoteConfirm {...dialog} title={d.releaseTitle(pending.halt.scopeLabel)} text={d.releaseText} confirmLabel={d.confirmRelease} /> : null}
      <Load resource={resource} retry={retry}>
        {(view) => (
          <StopScreenView
            view={view}
            onStop={(t) => void askStop(t)}
            onResume={(stop) => { reset(); setMessage(null); setPending({ kind: 'resume', stop }); }}
            onRelease={(halt) => { reset(); setMessage(null); setPending({ kind: 'release', halt }); }}
          />
        )}
      </Load>
    </>
  );
}
