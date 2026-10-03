import { de } from './de.ts';
import { en } from './en.ts';
import { zonedTimeFormat } from './shape.ts';
import type { Locale } from './types.ts';

/** Словарь интерфейса [Р-72]: немецкий словарь обязан иметь ту же форму, что английский — пропуск ключа не компилируется */
export type Messages = typeof en;

export const LOCALES: readonly Locale[] = ['de', 'en'];

const DICTIONARIES: Readonly<Record<Locale, Messages>> = { de, en };

const ZONED = new Map<string, Messages>();

/**
 * Шаг 69 (K1, K4): словарь языка, а время — в поясе продавца, если он назван и это не UTC. Словари не меняются: время подменяется
 * в копии, и всё, что форматирует время через `m.when` и `m.date` (экраны, тексты причин), видит пояс
 */
export function messagesFor(locale: Locale, options: { timeZone?: string | null } = {}): Messages {
  const tz = options.timeZone;
  if (!tz || tz === 'UTC') return DICTIONARIES[locale];
  const key = `${locale}|${tz}`;
  let m = ZONED.get(key);
  if (!m) {
    const base = DICTIONARIES[locale];
    /**
     * Ревью шага 69, находка 15: пояс, который знает PostgreSQL, но не знает ICU среды (старый браузер, переименованная зона), —
     * RangeError у Intl. Экран не падает: время показывается в UTC с подписью «UTC», как до K4
     */
    try {
      m = { ...base, ...zonedTimeFormat(locale, base.ui.common.noValue, tz) };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      m = base;
    }
    ZONED.set(key, m);
  }
  return m;
}
