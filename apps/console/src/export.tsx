import { createContext, useContext, useState } from 'react';
import { EXPORT_FORMATS, periodSearch, type ExportFormat, type ExportScreen, type Period } from '@repracer/console-model';
import { requestJson, worldPath } from './api.ts';
import type { JobCreatedResponse } from './api-types.ts';
import { ErrorBox, errorText, useMessages } from './components.tsx';
import { Field } from './forms.tsx';
import { JobProgress } from './screens/Jobs.tsx';

/** Шаг 104 [Р-229]: может ли зритель выгружать; гость публичного демо — нет: заданий у него нет вовсе (страж 0124, Р-160) */
export const ExportContext = createContext<boolean>(true);

/** Параметры экрана для выгрузки — те же, что адрес GET экрана: период, фильтры, поиск; пустые не передаются */
export function exportQuery(period: Period | null, rest: Readonly<Record<string, string | undefined | null | false>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) if (typeof v === 'string' && v !== '') out[k] = v;
  if (period) for (const [k, v] of new URLSearchParams(periodSearch(period))) out[k] = v;
  return out;
}

/**
 * Шаг 104 [Р-229]: «Export» — CSV или XLSX того, что показывает экран: те же фильтры и период. Поле ряда фильтров; подпись «заголовки
 * всегда на английском» и ход задания — своими строками во всю ширину панели, чтобы ряд фильтров оставался одним рядом (правила шага
 * 96.2). Файл готовит фоновое задание единственным путём выгрузки [Р-145]; скачивание — запросом с токеном [Р-142]. У гостя демо кнопка
 * видна, но отключена — с причиной
 */
export function ExportControl({ worldId, screen, query, empty = false }: {
  worldId: string; screen: ExportScreen; query: Readonly<Record<string, string>>;
  /** Экран не показывает ни одной строки — выгружать нечего */
  empty?: boolean;
}) {
  const m = useMessages();
  const x = m.ui.export;
  const allowed = useContext(ExportContext);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async (format: ExportFormat) => {
    setError(null);
    setJobId(null);
    setBusy(true);
    try {
      const created = await requestJson<JobCreatedResponse>(worldPath(worldId, 'exports'), { method: 'POST', body: { screen, format, query }, locale: m.locale });
      setJobId(created.jobId);
    } catch (e) {
      setError(errorText(e, m));
    } finally {
      setBusy(false);
    }
  };
  const why = !allowed ? x.guest : empty ? x.empty : undefined;
  return (
    <>
      <Field group label={x.button}>
        <div className="buttons export-formats" data-export={screen}>
          {EXPORT_FORMATS.map((f) => (
            <button key={f} type="button" disabled={why !== undefined || busy} title={why} aria-label={`${x.button} ${x[f]}`} onClick={() => void start(f)}>{x[f]}</button>
          ))}
        </div>
      </Field>
      <p className={`export-note${allowed ? '' : ' export-blocked'}`}>{allowed ? x.headerNote : x.guest}</p>
      {error ? <div className="export-progress"><ErrorBox message={error} /></div> : null}
      {jobId ? <div className="export-progress"><JobProgress worldId={worldId} jobId={jobId} /></div> : null}
    </>
  );
}
