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

/**
 * База адресов API. В браузере она пустая: страница ходит к своему же источнику. Задаёт её только стенд, когда консольный
 * КЛИЕНТ работает вне браузера — в живом прогоне [Р-142]: прогон обязан ходить тем же кодом, которым ходит страница, иначе он
 * выдаёт себе заголовки, которых браузер не шлёт.
 */
let apiOrigin = '';
export function setApiOrigin(origin: string): void {
  apiOrigin = origin;
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
    const response = await fetch(`${apiOrigin}${withLocale(path, init.locale)}`, {
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


export interface FetchedFile {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Р-142, OQ-202 (находка 1 ревью шага 30): файл, подготовленный заданием, забирается ЗАПРОСОМ С ТОКЕНОМ, а не ссылкой. Через
 * `<a href download>` это не работает: токен поставщика живёт только в памяти страницы и уходит ЗАГОЛОВКОМ, а браузер по
 * ссылке его не шлёт — продавец получал бы 401 вместо CSV.
 *
 * Сам перенос байтов вынесен из работы с окном: живой прогон зовёт ИМЕННО ЭТУ функцию, поэтому не может послать заголовок,
 * которого не послала бы страница.
 */
export async function fetchFile(path: string, locale?: Locale): Promise<FetchedFile> {
  const response = await fetch(`${apiOrigin}${withLocale(path, locale)}`, {
    credentials: 'same-origin',
    headers: { ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
  });
  if (!response.ok) throw new ApiError({ kind: 'BAD_RESPONSE', status: response.status });
  const disposition = response.headers.get('content-disposition') ?? '';
  const named = /filename="([^"]+)"/.exec(disposition);
  return {
    fileName: named?.[1] ?? 'download',
    contentType: (response.headers.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim(),
    bytes: new Uint8Array(await response.arrayBuffer()),
  };
}

/** Отдать скачанный файл окну браузера. Переноса байтов здесь нет — он в fetchFile, и проверяется отдельно */
export async function downloadFile(path: string, fileName: string, locale?: Locale): Promise<void> {
  const file = await fetchFile(path, locale);
  const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.contentType }));
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
