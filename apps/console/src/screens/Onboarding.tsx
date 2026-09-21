import { useState } from 'react';
import type { BulkJobView, EnableResultView, OnboardingView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, href, Load, useMessages } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

/**
 * Р-149 (шаг 34): направляемый путь. Экран не делает шаги сам — он показывает, где продавец находится, и ведёт на экран,
 * где шаг делается; единственное, что он пишет, — сужение набора [Р-131]. Состояние шагов приходит
 * с сервера ВЫВЕДЕННЫМ из данных: галочек здесь нет.
 */
export function OnboardingScreen({ worldId }: { worldId: string }) {
  const m = useMessages();
  const [view, retry] = useResource<OnboardingView>(worldPath(worldId, 'onboarding'), m.locale);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<BulkJobView | null>(null);
  /** Итог включения остаётся на экране, пока продавец его не уберёт: «не включено 50» без списка ничего не говорит */
  const [result, setResult] = useState<EnableResultView | null>(null);

  const narrow = (widen: boolean) =>
    void requestJson<unknown>(worldPath(worldId, 'onboarding', 'narrow'), { method: 'POST', body: widen ? { widen: true } : {}, locale: m.locale })
      .then(() => { setError(null); retry(); })
      .catch((e: unknown) => setError(errorText(e, m)));
  const enable = () =>
    void requestJson<{ jobId: string; job?: BulkJobView }>(worldPath(worldId, 'onboarding', 'enable'), { method: 'POST', body: {}, locale: m.locale })
      .then((r) => { setError(null); setResult(null); if (r.job) setJob(r.job); })
      .catch((e: unknown) => setError(errorText(e, m)));

  return (
    <Load resource={view} retry={retry}>
      {(v) => (
        <>
          <OnboardingScreenView view={v} worldId={worldId} busy={job !== null} onNarrow={narrow} onEnable={enable} />
          {job ? <JobProgress worldId={worldId} jobId={job.jobId} onFinished={(done) => {
            setJob(null);
            setResult((done.result?.view ?? null) as EnableResultView | null);
            retry();
          }} /> : null}
          {result ? <EnableResult result={result} onDismiss={() => setResult(null)} /> : null}
          {error ? <ErrorBox message={error} onRetry={retry} /> : null}
        </>
      )}
    </Load>
  );
}

/** Экран без запросов: то, что отрисовывает тест из ответа сервера, — как у остальных экранов консоли */
export function OnboardingScreenView({ view: v, worldId, busy, onNarrow, onEnable }: {
  view: OnboardingView; worldId: string; busy: boolean; onNarrow: (widen: boolean) => void; onEnable: () => void;
}) {
  const m = useMessages();
  const t = m.ui.onboarding;
  return (
    <section className="onboarding">
      <h2>{t.title}</h2>
      {v.demo ? <p className="notice"><Badge tone="warn">{m.ui.app.demoBadge}</Badge> {m.ui.app.demoBanner}</p> : null}
      <p className="muted">{v.intro}</p>
      <p className="notice"><strong>{v.resumeText}</strong></p>
      {!v.canLead ? <p className="muted">{t.noRight}</p> : null}
      {!v.canEnable ? <p className="muted">{t.noRightEnable}</p> : null}
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
                {v.narrowing.offered ? <button type="button" onClick={() => onNarrow(false)}>{t.narrow}</button> : null}
                {v.narrowing.narrowedTo !== null ? <button type="button" onClick={() => onNarrow(true)}>{t.widen}</button> : null}
              </div>
            ) : null}
            {/* Пока задание идёт, кнопка не нажимается: второе нажатие создало бы второе задание (ревью шага 34, находка 13) */}
            {s.step === 'ENABLE' && s.current && v.canEnable && v.enableCount > 0
              ? <button type="button" disabled={busy} onClick={onEnable}>{t.enable(v.enableCount)}</button> : null}
          </li>
        ))}
      </ol>
      <h3>{t.channels.title}</h3>
      {v.channels.length === 0 ? <p className="notice">{t.channels.none}</p> : (
        <ul className="channels">
          {v.channels.map((c) => (
            <li key={c.channelAccountId} className="card">
              <strong>{c.label}</strong> <Badge tone={c.status === 'ACTIVE' ? 'ok' : 'warn'}>{c.statusText}</Badge>
              {c.awaitingHint ? <p className="small muted">{c.awaitingHint}</p> : null}
              {c.blockers.length > 0 ? <ul className="small">{c.blockers.map((b) => <li key={b.code}>{b.text}</li>)}</ul> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Итог включения: сколько включено и — поимённо, с причиной словами — что не включилось (ревью шага 34, находка 3) */
export function EnableResult({ result, onDismiss }: { result: EnableResultView; onDismiss?: () => void }) {
  const m = useMessages();
  const t = m.ui.onboarding.result;
  return (
    <section className="card enable-result" aria-label={t.title}>
      <h3>{t.title}</h3>
      <p>{t.enabled(result.enabled, result.already)}</p>
      {result.skipped > 0 ? (
        <>
          <p className="notice">{t.skipped(result.skipped)}</p>
          <ul className="small">{result.byCode.map((c) => <li key={c.code}><strong>{c.title}</strong> — {c.count}</li>)}</ul>
          <ul className="small">
            {result.examples.map((e) => <li key={e.writeScopeId}><strong>{e.label}</strong>: {e.reasons.join(' ')}</li>)}
          </ul>
          {result.skipped > result.examples.length ? <p className="small muted">{t.more(result.skipped - result.examples.length)}</p> : null}
        </>
      ) : null}
      {onDismiss ? <button type="button" onClick={onDismiss}>{t.dismiss}</button> : null}
    </section>
  );
}
