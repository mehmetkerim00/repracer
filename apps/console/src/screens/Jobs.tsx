import { useEffect, useState } from 'react';
import type { BulkJobView, BulkJobsView } from '@repracer/console-model';
import { downloadFile, requestJson, worldPath } from '../api.ts';
import { ErrorBox, errorText, useMessages } from '../components.tsx';

/**
 * Р-139 (шаг 30): экран массовой операции. Продавец нажал «применить» — и с этого момента смотрит на ХОД, а не ждёт ответа.
 *
 * Перезагрузка страницы ничего не теряет: состояние задания в базе, а не в браузере. Идентификатор задания лежит в адресе, и
 * экран собирается заново тем же запросом. Строка «что в базе» есть всегда, в том числе пока идёт применение: она отвечает на
 * единственный вопрос, который у продавца возникает при сбое, — прошло ли наполовину.
 */

const POLL_MS = 500;

export function JobProgress({ worldId, jobId, onFinished }: { worldId: string; jobId: string; onFinished?: (job: BulkJobView) => void }) {
  const m = useMessages();
  const t = m.ui.jobs;
  const [job, setJob] = useState<BulkJobView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await requestJson<BulkJobView>(worldPath(worldId, 'jobs', jobId), { locale: m.locale });
        if (!alive) return;
        setJob(next);
        setError(null);
        // Опрос прекращается, как только задание завершилось: экран не крутится впустую
        if (next.active) timer = setTimeout(() => void poll(), POLL_MS);
        else onFinished?.(next);
      } catch (e) {
        if (!alive) return;
        setError(errorText(e, m));
        timer = setTimeout(() => void poll(), POLL_MS * 4);
      }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [worldId, jobId, m.locale]);

  if (error && !job) return <ErrorBox message={error} />;
  if (!job) return <p className="notice" role="status">{t.queued}</p>;
  return (
    <section className="job" aria-live="polite">
      <h4>{job.title}</h4>
      <p className="headline">{job.headline}</p>
      {job.progress === null ? null : (
        <progress value={job.done} max={job.total ?? job.done} aria-label={job.headline}>{Math.round(job.progress * 100)}%</progress>
      )}
      <p className="small muted">{job.effect}</p>
      {job.attempts > 1 ? <p className="small muted">{t.attempts(job.attempts)}</p> : null}
      {job.artifact ? (
        <p>
          {/* Файл запрашивается с токеном и отдаётся браузеру объектом: по обычной ссылке заголовок авторизации не уходит */}
          <button type="button" onClick={() => void downloadFile(`${worldPath(worldId, 'jobs', jobId)}/artifact`, job.artifact!.fileName, m.locale)
            .catch((e: unknown) => setError(errorText(e, m)))}>{t.download}</button>{' '}
          <span className="small muted">{t.checksum(job.artifact.sha256)}</span>
        </p>
      ) : null}
      {job.error ? <ErrorBox message={job.error} /> : null}
      {error ? <p className="small muted">{error}</p> : null}
    </section>
  );
}

/** История массовых операций тенанта: что делалось, чем кончилось и что осталось в базе */
export function JobHistory({ worldId }: { worldId: string }) {
  const m = useMessages();
  const t = m.ui.jobs;
  const [view, setView] = useState<BulkJobsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const next = await requestJson<BulkJobsView>(worldPath(worldId, 'jobs'), { locale: m.locale });
        if (!alive) return;
        setView(next);
        setError(null);
        // Пока есть идущие задания, список обновляется; иначе — не обновляется вовсе
        if (next.active > 0) timer = setTimeout(() => void poll(), POLL_MS * 2);
      } catch (e) {
        if (!alive) return;
        setError(errorText(e, m));
      }
    };
    void poll();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [worldId, m.locale]);

  if (error) return <ErrorBox message={error} />;
  if (!view) return null;
  return (
    <section className="jobs">
      <h3>{t.historyTitle}</h3>
      {view.items.length === 0 ? <p className="muted">{t.none}</p> : (
        <ul className="index">
          {view.items.map((j) => (
            <li key={j.jobId}>
              <strong>{j.title}</strong> — {j.headline}
              <div className="small muted">{j.effect}{j.finishedAt ? ` · ${m.when(j.finishedAt)}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
