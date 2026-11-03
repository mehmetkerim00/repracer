/**
 * Шаг 112 [Р-238]: цвет товара — слово продавца из импорта «Product details». Кружок-образец рисуется только у ИЗВЕСТНОГО слова из
 * этого списка; незнакомое слово («multicolor», «dark grey», «sand») — только текстом: интерфейс цвет не домысливает, и из названия
 * товара его не выводит. Кружок — рядом со словом, а не вместо него (доступность и слова, которые кружком не нарисовать).
 *
 * Слова — английские и самые частые немецкие, испанские и французские (файл продавца бывает на его языке). Образец — токен Primer
 * `--swatch-*` (tokens.css): у оттенков — ступень 5 шкалы display, единственная, что почти не меняется между светлой и тёмной темой
 * (у остальных ступеней тёмная тема переворачивает светлоту — «чёрный» стал бы светло-серым); чёрный и белый — `--bgColor-black` и
 * `--bgColor-white`, одинаковые в обеих темах
 */
export const SWATCHES = ['black', 'white', 'grey', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown', 'teal'] as const;
export type Swatch = (typeof SWATCHES)[number];

const WORDS: Readonly<Record<Swatch, readonly string[]>> = {
  black: ['black', 'schwarz', 'negro', 'noir'],
  white: ['white', 'weiß', 'weiss', 'blanco', 'blanc'],
  grey: ['grey', 'gray', 'grau', 'gris'],
  red: ['red', 'rot', 'rojo', 'rouge'],
  green: ['green', 'grün', 'gruen', 'verde', 'vert'],
  blue: ['blue', 'blau', 'azul', 'bleu'],
  yellow: ['yellow', 'gelb', 'amarillo', 'jaune'],
  orange: ['orange', 'naranja'],
  purple: ['purple', 'violet', 'violett', 'lila', 'morado'],
  pink: ['pink', 'rosa', 'rose'],
  brown: ['brown', 'braun', 'marrón', 'marron', 'brun'],
  teal: ['teal'],
};

const BY_WORD: ReadonlyMap<string, Swatch> = new Map(SWATCHES.flatMap((s) => WORDS[s].map((w) => [w, s] as const)));

/** Образец для слова цвета: известное слово целиком (без регистра) — кружок; иначе null — только текст */
export function swatchOf(color: string | null | undefined): Swatch | null {
  if (!color) return null;
  return BY_WORD.get(color.trim().normalize('NFC').toLocaleLowerCase('en')) ?? null;
}
