import { de } from './de.ts';
import { en } from './en.ts';
import type { Locale } from './types.ts';

/** Словарь интерфейса [Р-72]: немецкий словарь обязан иметь ту же форму, что английский — пропуск ключа не компилируется */
export type Messages = typeof en;

export const LOCALES: readonly Locale[] = ['de', 'en'];

const DICTIONARIES: Readonly<Record<Locale, Messages>> = { de, en };

export function messagesFor(locale: Locale): Messages {
  return DICTIONARIES[locale];
}
