import { useCallback, useEffect, useState } from 'react';
import type { Locale } from '@repracer/console-model';
import type { ApiErrorBody } from './api-types.ts';

/**
 * Запросы к стенду. Любое ожидание ограничено REQUEST_TIMEOUT_MS: по истечении — ошибка с кнопкой повтора, бесконечного спиннера нет.
 * Ошибки — коды; текст на языке интерфейса строит errorText [Р-72].
 */

export const REQUEST_TIMEOUT_MS = 8_000;

export type ApiFailure =
  | { kind: 'TIMEOUT'; seconds: number }
  | { kind: 'UNAVAILABLE'; detail: string }
  | { kind: 'BAD_RESPONSE'; status: number }
  | { kind: 'SERVER'; status: number; code: string; message: string };

export class ApiError extends Error {
  readonly failure: ApiFailure;
  constructor(failure: ApiFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

/**
 * Токен поставщика identity [Р-78] — только в памяти страницы: не в localStorage и не в cookie; перезагрузка страницы — новый вход.
 */
let accessToken: string | null = null;
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export type Resource<T> =
  | { state: 'loading'; startedAt: number }
  | { state: 'ready'; data: T }
  | { state: 'error'; error: unknown };

const withLocale = (path: string, locale?: Locale) => (locale ? `${path}${path.includes('?') ? '&' : '?'}locale=${locale}` : path);

export async function requestJson<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal; timeoutMs?: number; locale?: Locale } = {}): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const outer = init.signal;
  const forward = () => controller.abort();
  outer?.addEventListener('abort', forward, { once: true });
  try {
    const response = await fetch(withLocale(path, init.locale), {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new ApiError({ kind: 'BAD_RESPONSE', status: response.status });
    }
    if (!response.ok) {
      const error = (json as ApiErrorBody | null)?.error;
      throw error ? new ApiError({ kind: 'SERVER', status: response.status, code: error.code, message: error.message }) : new ApiError({ kind: 'BAD_RESPONSE', status: response.status });
    }
    return json as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError({ kind: 'TIMEOUT', seconds: timeoutMs / 1000 });
    throw new ApiError({ kind: 'UNAVAILABLE', detail: error instanceof Error ? error.message : String(error) });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', forward);
  }
}

export function useResource<T>(path: string, locale: Locale): [Resource<T>, () => void] {
  const [attempt, setAttempt] = useState(0);
  const [resource, setResource] = useState<Resource<T>>(() => ({ state: 'loading', startedAt: Date.now() }));
  useEffect(() => {
    const cancel = new AbortController();
    setResource({ state: 'loading', startedAt: Date.now() });
    requestJson<T>(path, { signal: cancel.signal, locale }).then(
      (data) => { if (!cancel.signal.aborted) setResource({ state: 'ready', data }); },
      (error: unknown) => { if (!cancel.signal.aborted) setResource({ state: 'error', error }); },
    );
    return () => cancel.abort();
  }, [path, locale, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return [resource, retry];
}

/**
 * Скачивание файла, подготовленного заданием [OQ-202, находка 1 ревью шага 30]. Через `<a href download>` это не работает:
 * токен поставщика живёт только в памяти страницы и уходит ЗАГОЛОВКОМ, а браузер по ссылке его не шлёт — продавец получал бы
 * 401 вместо CSV. Поэтому файл запрашивается тем же путём, что и всё остальное, и отдаётся браузеру как объект в памяти.
 */
export async function downloadFile(path: string, fileName: string, locale?: Locale): Promise<void> {
  const response = await fetch(withLocale(path, locale), {
    credentials: 'same-origin',
    headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  });
  if (!response.ok) throw new ApiError({ kind: 'BAD_RESPONSE', status: response.status });
  const url = URL.createObjectURL(await response.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Объект держит файл целиком в памяти вкладки: выгрузка каталога — 27 МБ, и отпустить его надо сразу
    URL.revokeObjectURL(url);
  }
}

export const worldPath = (worldId: string, ...parts: string[]) => `/api/worlds/${[worldId, ...parts].map(encodeURIComponent).join('/')}`;
