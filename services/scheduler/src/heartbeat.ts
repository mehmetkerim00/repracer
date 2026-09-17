/**
 * Р-127 (шаг 26): работоспособность планировщика контролируется извне. Процесс отмечается во внешнем сервисе по методу «dead man's switch»:
 * успешный такт — отметка «жив», провал такта — отметка «сбой». Отсутствие отметки дольше периода и допуска внешний сервис превращает в
 * письмо владельцу; упавший процесс, остановленный контейнер и недоступный хост отметок не шлют — и о себе не сообщают сами (риск 29).
 *
 * Протокол — ping-адрес Healthchecks.io (vendor/healthchecks/2026-09-17/SOURCE.md): GET <адрес> — «жив», GET <адрес>/fail — «сбой»;
 * больше 5 отметок в минуту на проверку сервис может не записать — отметка не чаще minIntervalMs (по умолчанию 60 с).
 * Адрес содержит идентификатор проверки: в журнал не пишется.
 */
export interface HeartbeatOptions {
  url: string;
  fetch?: typeof fetch;
  minIntervalMs?: number;
  timeoutMs?: number;
  clockMs?: () => number;
}

export interface Heartbeat {
  /** Итог такта; возвращает, отправлена ли отметка */
  beat(tickOk: boolean): Promise<'SENT' | 'THROTTLED'>;
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const url = new URL(options.url);
  if (url.protocol !== 'https:') throw new Error('HEARTBEAT_URL_NOT_HTTPS: the external heartbeat address must be https');
  const doFetch = options.fetch ?? fetch;
  const minInterval = options.minIntervalMs ?? 60_000;
  const now = options.clockMs ?? Date.now;
  let lastSent: { at: number; ok: boolean } | null = null;
  return {
    async beat(tickOk) {
      const at = now();
      // Смена состояния (сбой после успеха и наоборот) — сразу; повтор того же — не чаще minIntervalMs
      if (lastSent && lastSent.ok === tickOk && at - lastSent.at < minInterval) return 'THROTTLED';
      const target = tickOk ? url.toString() : `${url.toString().replace(/\/$/, '')}/fail`;
      const response = await doFetch(target, { method: 'GET', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
      // Ответ 200 не подтверждает запись отметки (документация: «not found», «rate limited» — тоже 200); не-200 — сбой отметки
      if (!response.ok) throw new Error(`HEARTBEAT_REJECTED: external monitor answered ${response.status}`);
      lastSent = { at, ok: tickOk };
      return 'SENT';
    },
  };
}
