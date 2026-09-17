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
  /** Наименьший промежуток между любыми отметками: сервис не записывает больше 5 отметок в минуту [док] */
  minGapMs?: number;
  timeoutMs?: number;
  clockMs?: () => number;
}

export interface Heartbeat {
  /** Итог такта; возвращает, отправлена ли отметка */
  beat(tickOk: boolean): Promise<'SENT' | 'THROTTLED'>;
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  // Адрес — секрет (в нём идентификатор проверки): ошибка разбора не должна его показывать (ревью шага 26, находка 13.9)
  let url: URL;
  try {
    url = new URL(options.url);
  } catch {
    throw new Error('HEARTBEAT_URL_INVALID: the external heartbeat address is not a URL');
  }
  if (url.protocol !== 'https:') throw new Error('HEARTBEAT_URL_NOT_HTTPS: the external heartbeat address must be https');
  const doFetch = options.fetch ?? fetch;
  const minInterval = options.minIntervalMs ?? 60_000;
  // 5 отметок в минуту — предел сервиса [док]; между любыми отметками держим 12 с, иначе «мигающий» планировщик теряет отметки о сбое
  const minGap = options.minGapMs ?? 12_000;
  const now = options.clockMs ?? Date.now;
  let lastSent: { at: number; ok: boolean } | null = null;
  return {
    async beat(tickOk) {
      const at = now();
      // Смена состояния (сбой после успеха и наоборот) — сразу, но не чаще minGap; повтор того же — не чаще minIntervalMs
      if (lastSent && at - lastSent.at < (lastSent.ok === tickOk ? minInterval : minGap)) return 'THROTTLED';
      const target = tickOk ? url.toString() : `${url.toString().replace(/\/$/, '')}/fail`;
      const response = await doFetch(target, { method: 'GET', signal: AbortSignal.timeout(options.timeoutMs ?? 10_000) });
      // Ответ 200 не подтверждает запись отметки (документация: «not found», «rate limited» — тоже 200); не-200 — сбой отметки
      if (!response.ok) throw new Error(`HEARTBEAT_REJECTED: external monitor answered ${response.status}`);
      lastSent = { at, ok: tickOk };
      return 'SENT';
    },
  };
}
