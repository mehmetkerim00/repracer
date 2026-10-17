/**
 * Словарь интерфейса [Р-72]: движок отдаёт коды и параметры, тексты — здесь: английский, испанский, французский и немецкий (шаг 98).
 * Шаблон причины получает форматтер параметров: суммы — только с валютой из параметров [Р-71], значения из данных канала,
 * не вошедшие в слепок объяснения [Р-68], — явной пометкой.
 */

/** Шаг 98 [Р-223]: испанский и французский — рядом с английским; немецкий — за профилем рынка ЕС [Р-214] */
export type Locale = 'de' | 'en' | 'es' | 'fr';

export interface Fmt {
  /** Параметр есть в причине (или вырезан из слепка как данные канала) */
  has(key: string): boolean;
  money(key: string): string;
  bp(key: string): string;
  ratio(key: string): string;
  count(key: string): string;
  seconds(key: string): string;
  minutes(key: string): string;
  when(key: string): string;
  date(key: string): string;
  /** Код значения (статус, режим, причина) — подпись из словаря */
  value(key: string): string;
  /** Список кодов через запятую */
  list(key: string): string;
  raw(key: string): string;
  /** Сырой параметр для ветвления шаблона */
  get(key: string): string | number | boolean | null | undefined;
}

export type Template = (f: Fmt) => string;
