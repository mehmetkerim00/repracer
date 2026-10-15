import { useState } from 'react';
import type { BulkJobView, EnableResultView, OnboardingView } from '@repracer/console-model';
import { requestJson, useResource, worldPath } from '../api.ts';
import { Badge, ErrorBox, errorText, href, Load, useMessages, Intro } from '../components.tsx';
import { JobProgress } from './Jobs.tsx';

/**
 * Р-149 (шаг 34): направляемый путь. Экран не делает шаги сам — он показывает, где продавец находится, и ведёт на экран,
 * где шаг делается; единственное, что он пишет, — сужение набора [Р-131]. Состояние шагов приходит
 * с сервера ВЫВЕДЕННЫМ из данных: галочек здесь нет.
 */
/**
 * Шаг 95 [Р-217]: отдельного пункта «Setup» нет — путь живёт верхним разделом Channels, пока не пройден (`embedded`): заголовок
 * раздела вместо заголовка страницы, без списка каналов (аккаунты — ниже на той же странице), пройденный путь не показывается вовсе
 */
export function OnboardingScreen({ worldId, embedded = false }: { worldId: string; embedded?: boolean }) {
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
  // Р-152: выбор пути — намерение продавца; хранится в базе, путь возобновляется с места остановки
  const choosePath = (path: 'STOCK' | 'STOCK_AND_PRICING') =>
    void requestJson<unknown>(worldPath(worldId, 'onboarding', 'path'), { method: 'POST', body: { path }, locale: m.locale })
      .then(() => { setError(null); retry(); })
      .catch((e: unknown) => setError(errorText(e, m)));

  return (
    <Load shape="cards" resource={view} retry={retry}>
      {(v) => embedded && v.resumeAt === 'DONE' && job === null && result === null && error === null ? null : (
        <>
          <OnboardingScreenView view={v} worldId={worldId} busy={job !== null} onNarrow={narrow} onEnable={enable} onChoosePath={choosePath} embedded={embedded} />
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
export function OnboardingScreenView({ view: v, worldId, busy, onNarrow, onEnable, onChoosePath, embedded = false }: {
  view: OnboardingView; worldId: string; busy: boolean; onNarrow: (widen: boolean) => void; onEnable: () => void; onChoosePath?: (path: 'STOCK' | 'STOCK_AND_PRICING') => void; embedded?: boolean;
}) {
  const m = useMessages();
  const t = m.ui.onboarding;
  return (
    <section className={`onboarding${embedded ? ' card setup-section' : ''}`}>
      {embedded ? <h3>{t.title}</h3> : <h2>{t.title}</h2>}
      <Intro text={v.intro} />
      <p className="notice resume"><strong>{v.resumeText}</strong></p>
      {v.choices.length > 0 ? (
        <div className="choices">
          {v.choices.map((c) => (
            <div key={c.path} className={`choice${c.selected ? ' selected' : ''}`}>
              {/* Шаг 77: путь — карточкой с иконкой: остатки — коробка, остатки и цены — коробка с ценником. Шаг 79: выбранный — отмечен */}
              <span className="choice-icon" aria-hidden="true">{c.path === 'STOCK' ? <BoxIcon /> : <TagIcon />}</span>
              <h3>{c.title}{c.selected ? <Badge tone="ok">{t.paths.selected}</Badge> : v.path === 'STOCK_AND_PRICING' && c.path === 'STOCK' ? <Badge tone="off">{t.paths.included}</Badge> : null}</h3>
              {c.detail ? <p className="small">{c.detail}</p> : null}
              {v.path === null && onChoosePath ? <button type="button" className="primary" onClick={() => onChoosePath(c.path)}>{t.paths.choose}</button> : null}
              {v.path === 'STOCK' && c.selected && v.canAddPricing && onChoosePath ? <button type="button" onClick={() => onChoosePath('STOCK_AND_PRICING')}>{t.paths.addPricing}</button> : null}
            </div>
          ))}
        </div>
      ) : null}
      {v.pathText ? <p className="section-sub">{v.pathText}</p> : null}
      {!v.canLead ? <p className="notice">{t.noRight}</p> : null}
      {!v.canEnable ? <p className="notice">{t.noRightEnable}</p> : null}
      <ol className="onboarding-steps">
        {v.steps.map((s) => (
          <li key={s.step} className={s.done ? 'done' : s.current ? 'current' : 'pending'} aria-current={s.current ? 'step' : undefined}>
            <h3>
              {/* Шаг 79: одна пилюля на шаг — «ждёт доступа» вместо «впереди», а у выполненного шага ожидание — строкой с объяснением */}
              {s.title} {s.done ? <Badge tone="ok">{t.done}</Badge> : s.awaiting ? <Badge tone="warn">{t.channels.status.AWAITING_ACCESS}</Badge>
                : <Badge tone={s.current ? 'progress' : 'off'}>{s.current ? t.current : t.pending}</Badge>}
            </h3>
            {s.done && s.awaiting ? <p className="small awaiting-note">{t.paths.awaitingNote}</p> : null}
            <p className="small muted">{s.hint}</p>
            {/* Шаг 79 (ревью): «0 of 0» ничего не говорит — счёт только там, где есть что считать */}
            {s.totalCount > 0 ? <p className="small">{s.progress}</p> : null}
            {s.goTo && !s.done ? <a className="row-link" href={href(worldId, s.goTo.screen, ...(s.goTo.param ? [s.goTo.param] : []))}>{s.goTo.label}</a> : null}
            {s.step === 'COSTS' && v.narrowing && v.canLead ? (
              <div className="narrowing">
                <p className="small">{v.narrowing.hint}</p>
                {v.narrowing.offered ? <button type="button" onClick={() => onNarrow(false)}>{t.narrow}</button> : null}
                {v.narrowing.narrowedTo !== null ? <button type="button" onClick={() => onNarrow(true)}>{t.widen}</button> : null}
              </div>
            ) : null}
            {/* Пока задание идёт, кнопка не нажимается: второе нажатие создало бы второе задание (ревью шага 34, находка 13) */}
            {s.step === 'ENABLE' && s.current && v.canEnable && v.enableCount > 0
              ? <button type="button" className="primary" disabled={busy} onClick={onEnable}>{t.enable(v.enableCount)}</button> : null}
          </li>
        ))}
      </ol>
      {embedded ? null : <h3>{t.channels.title}</h3>}
      {embedded ? null : v.channels.length === 0 ? <p className="notice">{t.channels.none} <a href={href(worldId, 'channels', 'accounts')}>{m.ui.app.connectChannel}</a></p> : (
        <ul className="channels">
          {v.channels.map((c) => (
            <li key={c.channelAccountId} className="card channel">
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

/** Шаг 77: иконки выбора пути — встроенный SVG, без внешних ресурсов */
function BoxIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 8l-9-5-9 5 9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
    </svg>
  );
}
function TagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.6 13.4l-7.2 7.2a2 2 0 01-2.8 0L3 13V3h10l7.6 7.6a2 2 0 010 2.8z" /><circle cx="7.5" cy="7.5" r="1.5" />
    </svg>
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
