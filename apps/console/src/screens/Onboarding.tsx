import { useState } from 'react';
import type { BulkJobView, OnboardingView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, href, Load, useMessages } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

/**
 * Р-149 (шаг 34): направляемый путь. Экран не делает шаги сам — он показывает, где продавец находится, и ведёт на экран,
 * где шаг делается; единственное, что он пишет, — сужение набора [Р-131] и отметку последнего шага. Состояние шагов приходит
 * с сервера ВЫВЕДЕННЫМ из данных: галочек здесь нет.
 */
export function OnboardingScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const t = m.ui.onboarding;
  const [view, retry] = useResource<OnboardingView>(worldPath(worldId, 'onboarding'), m.locale);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<BulkJobView | null>(null);

  const post = (path: string, body: Record<string, unknown> = {}) =>
    requestJson<unknown>(worldPath(worldId, 'onboarding', path), { method: 'POST', body, locale: m.locale })
      .then(() => { setError(null); retry(); })
      .catch((e: unknown) => setError(errorText(e, m)));

  return (
    <Load resource={view} retry={retry}>
      {(v) => (
        <section className="onboarding">
          <h2>{t.title}</h2>
          {v.demo ? <p className="notice"><Badge tone="warn">{m.ui.app.demoBadge}</Badge> {m.ui.app.demoBanner}</p> : null}
          <p className="muted">{v.intro}</p>
          <p className="notice"><strong>{v.resumeText}</strong></p>
          {!v.canLead ? <p className="muted">{t.noRight}</p> : null}
          <ol className="steps">
            {v.steps.map((s) => (
              <li key={s.step} className={s.done ? 'done' : s.current ? 'current' : 'pending'} aria-current={s.current ? 'step' : undefined}>
                <h3>
                  {s.title} <Badge tone={s.done ? 'ok' : s.current ? 'warn' : 'muted'}>{s.done ? t.done : s.current ? t.current : t.pending}</Badge>
                  {s.awaiting ? <> <Badge tone="warn">{t.channels.status.AWAITING_ACCESS}</Badge></> : null}
                </h3>
                <p className="small muted">{s.hint}</p>
                <p className="small">{s.progress}</p>
                {s.goTo && !s.done ? <a href={href(worldId, s.goTo.screen)}>{s.goTo.label}</a> : null}
                {s.step === 'COSTS' && v.narrowing && v.canLead ? (
                  <div className="narrowing">
                    <p className="small">{v.narrowing.hint}</p>
                    {v.narrowing.offered ? <button type="button" onClick={() => void post('narrow', { toOffersWithCost: true })}>{t.narrow}</button> : null}
                    {v.narrowing.narrowedTo !== null ? <button type="button" onClick={() => void post('narrow', { widen: true })}>{t.widen}</button> : null}
                  </div>
                ) : null}
                {s.step === 'ENABLE' && s.current && v.canLead && v.enableCount > 0 ? (
                  <button type="button" onClick={() => void requestJson<{ jobId: string; job?: BulkJobView }>(worldPath(worldId, 'onboarding', 'enable'), { method: 'POST', body: {}, locale: m.locale })
                    .then((r) => { setError(null); if (r.job) setJob(r.job); })
                    .catch((e: unknown) => setError(errorText(e, m)))}>{t.enable(v.enableCount)}</button>
                ) : null}
              </li>
            ))}
          </ol>
          {job ? <JobProgress worldId={worldId} jobId={job.jobId} onFinished={() => { setJob(null); retry(); }} /> : null}
          <h3>{t.channels.title}</h3>
          {v.channels.length === 0 ? <p className="notice">{t.channels.none}</p> : (
            <ul className="channels">
              {v.channels.map((c) => (
                <li key={c.channelAccountId} className="card">
                  <strong>{c.label}</strong> <Badge tone={c.status === 'ACTIVE' ? 'ok' : 'warn'}>{c.statusText}</Badge>
                  {c.awaitingHint ? <p className="small muted">{c.awaitingHint}</p> : null}
                  {c.blockers.length > 0 ? <ul className="small">{c.blockers.map((b) => <li key={b}>{b}</li>)}</ul> : null}
                </li>
              ))}
            </ul>
          )}
          {error ? <ErrorBox message={error} onRetry={retry} /> : null}
        </section>
      )}
    </Load>
  );
}
