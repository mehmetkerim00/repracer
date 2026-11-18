/**
 * Шаг 167 (решение владельца): эталон темы «Spruce Hybrid», утверждённый владельцем. Ключ — имя значения эталона; tokens.css помечает
 * значение `spruce: ключ` (светлая тема) или `spruce-dark: ключ` (тёмная), правило-тест сверяет его отсюда. Значения — дословно эталон,
 * записанный формой CSS: `rgba(255,255,255,.10)` эталона — `rgba(255, 255, 255, 0.1)`, 10.5px — 0.65625rem, 12px — 0.75rem, 8px — 0.5rem,
 * 32px — 2rem
 */
export const SPRUCE_LIGHT: Readonly<Record<string, string>> = {
  // Шапка и боковина
  chrome: '#0f2b1d',
  'sidebar-text': '#c3d2c7',
  'sidebar-muted': '#9fb5a6',
  'sidebar-section': '#7e937f',
  'section-tracking': '0.08em',
  'nav-active-bg': 'rgba(255, 255, 255, 0.1)',
  'nav-active-edge': '#6cc08b',
  'nav-active-text': '#ffffff',
  'logo-accent': '#6cc08b',
  // Контент
  canvas: '#f6f5f1',
  card: '#ffffff',
  'card-border': '#e4e1d8',
  'card-radius': '0.75rem',
  'card-shadow': '0 1px 2px rgba(15, 43, 29, 0.05)',
  'table-head': '#fbfaf6',
  'table-border': '#e9e6dc',
  'row-divider': '#f0ede4',
  // Текст
  text: '#1a1f1c',
  'text-secondary': '#5b635c',
  'text-weak': '#8b948c',
  label: '#6b7369',
  'label-size': '0.65625rem',
  // Акцент, успех, предупреждение, строка внимания, отрицательные деньги, демо
  accent: '#1f6f4a',
  'accent-hover': '#0f2b1d',
  'success-text': '#15593a',
  'success-bg': '#e8f3ec',
  'success-border': '#9cc7ab',
  'warning-text': '#8a5a06',
  'warning-bg': '#fbf2de',
  'warning-border': '#d9b36a',
  'attention-row-bg': '#fcf7eb',
  'attention-row-edge': '#d9a13b',
  negative: '#a03e12',
  'demo-bg': '#f3e9ce',
  'demo-text': '#5c4a12',
  'demo-pill-border': '#c9a94e',
  // Контролы
  'control-height': '2rem',
  'control-radius': '0.5rem',
  'control-border': '#d8d4c8',
  'primary-bg': '#0f2b1d',
  'primary-text': '#ffffff',
  // Шрифты
  'font-text': "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  'font-heading': "'Schibsted Grotesk', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
};

export const SPRUCE_DARK: Readonly<Record<string, string>> = {
  canvas: '#0c1410',
  header: '#112219',
  'header-border': '#22332a',
  sidebar: '#0a110d',
  'sidebar-text': '#aebdb2',
  card: '#13201a',
  'card-border': '#24382c',
  'table-head': '#0f1a14',
  'table-border': '#1d2e24',
  text: '#e6ede7',
  'text-secondary': '#aebdb2',
  'text-weak': '#7e8e82',
  label: '#90a094',
  accent: '#8fd3a8',
  'accent-hover': '#c4e8d0',
  'primary-bg': '#6cc08b',
  'primary-text': '#0a110d',
  'success-text': '#8fd3a8',
  'success-bg': '#16301f',
  'success-border': '#3f7a58',
  'warning-text': '#e0b45c',
  'warning-bg': '#2a2413',
  'warning-border': '#9a7a33',
  'attention-row-bg': '#1d1a10',
  'attention-row-edge': '#b98a2e',
  negative: '#e58a5a',
  'demo-bg': '#2a2413',
  'demo-text': '#e3c87a',
  'demo-pill-border': '#8a7637',
};

/**
 * Правило владельца: контраст каждой пары «текст — фон» не меньше 4,5:1, подписи 10.5px включительно; где эталон не проходит — темнее или
 * светлее в пределах оттенка. Расчёт (WCAG 2, относительная яркость) на худшем фоне пары — канве #f6f5f1
 */
export const CONTRAST_ADJUSTED: Readonly<Record<string, { spec: string; value: string; why: string }>> = {
  'text-weak': { spec: '#8b948c', value: '#687169', why: 'эталон на канве — 2,87:1; та же тон и насыщенность (126,7°, 4 %), светлота 56 % → 42,5 % — 4,63:1' },
  label: { spec: '#6b7369', value: '#6a7168', why: 'эталон на канве — 4,497:1, на волосок ниже 4,5; светлота 43,1 % → 42,5 % — 4,61:1 (тон 108° → 106,7° — округление до 8 бит)' },
};

/**
 * Тёмная пара светлого значения, у которой ключ эталона другой: эталон тёмной темы его не называет (берётся названный ключ тёмного эталона
 * или значение светлой темы — `light`) или делит одно светлое значение на два (рама — на шапку и боковину). Каждая замена — с причиной
 */
export const DARK_SUBSTITUTES: Readonly<Record<string, { key: string; light?: true; why: string }>> = {
  '--divider': { key: 'table-border', why: 'разделители строк в тёмной теме — «внутритабличные» эталона: одна рамка и линии' },
  '--control-bg-active': { key: 'table-border', why: 'нажатый контрол — светлого эталона «разделитель строк», тёмного — внутритабличная линия' },
  '--control-border': { key: 'card-border', why: 'рамку контрола в тёмной теме эталон не называет — рамка карточки' },
  '--success-strong': { key: 'accent', light: true, why: 'заливка успеха под белым текстом (кружок статуса, столбики графика): светлый акцент держит 6:1 с белым, тёмный (#8fd3a8) — нет' },
  '--warning-strong': { key: 'warning-text', light: true, why: 'заливка внимания под белым текстом: светлый янтарь держит 5,9:1 с белым, тёмный (#e0b45c) — нет' },
  '--header-bg': { key: 'header', why: 'в тёмной теме эталон делит раму: шапка #112219, боковина #0a110d' },
  '--header-fg-logo': { key: 'text', why: 'бренд в тёмной шапке — основной текст тёмной темы' },
  '--header-mark-end': { key: 'logo-accent', light: true, why: 'акцент знака в тёмной теме эталон не называет — тот же #6cc08b (им же залита главная кнопка тёмной темы)' },
  '--header-divider': { key: 'label', why: 'разделитель в шапке — цвет подписей тёмной темы' },
  '--header-edge': { key: 'header-border', why: 'край шапки: в светлой теме цветом самой шапки (не виден), в тёмной — рамка шапки эталона' },
  '--sidebar-bg': { key: 'sidebar', why: 'в тёмной теме эталон делит раму: шапка #112219, боковина #0a110d' },
  '--sidebar-muted': { key: 'text-weak', why: 'приглушённый текст боковины тёмной темы эталон не называет — слабый текст тёмной темы' },
  '--sidebar-section': { key: 'label', why: 'секции боковины тёмной темы эталон не называет — подписи тёмной темы' },
  '--sidebar-divider': { key: 'nav-active-bg', light: true, why: 'линии боковины — подложка выбранного пункта, как в светлой' },
  '--nav-hover': { key: 'nav-active-bg', light: true, why: 'выбранный пункт тёмной темы эталон не называет — как в светлой' },
  '--nav-selected': { key: 'nav-active-bg', light: true, why: 'выбранный пункт тёмной темы эталон не называет — как в светлой' },
  '--nav-active-edge': { key: 'nav-active-edge', light: true, why: 'выбранный пункт тёмной темы эталон не называет — как в светлой' },
  '--nav-active-fg': { key: 'nav-active-text', light: true, why: 'выбранный пункт тёмной темы эталон не называет — как в светлой' },
};

/**
 * Пары «текст — фон» консоли: токен текста и фоны, на которых он стоит. `A@B` — полупрозрачный фон A поверх B. Контраст — на ХУДШЕМ фоне
 * пары, в каждой теме
 */
export const CONTRAST_PAIRS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--text', ['--bg', '--surface', '--surface-muted', '--attention-row-bg']],
  ['--text-2', ['--bg', '--surface', '--surface-muted']],
  ['--text-3', ['--bg', '--surface', '--surface-muted']],
  ['--label', ['--bg', '--surface', '--surface-muted']],
  ['--accent', ['--bg', '--surface', '--surface-muted', '--accent-soft']],
  ['--accent-hover', ['--bg', '--surface']],
  ['--money-negative', ['--surface', '--surface-muted', '--attention-row-bg']],
  ['--success', ['--success-soft', '--surface']],
  ['--warning', ['--warning-soft', '--attention-row-bg', '--surface']],
  ['--danger', ['--danger-soft@--surface', '--surface']],
  ['--demo-fg', ['--demo-bg']],
  ['--on-primary', ['--primary', '--primary-hover']],
  ['--on-emphasis', ['--success-strong', '--warning-strong', '--danger-strong']],
  ['--control-fg', ['--control-bg', '--control-bg-hover']],
  ['--header-fg', ['--header-bg']],
  ['--header-fg-logo', ['--header-bg']],
  ['--sidebar-fg', ['--sidebar-bg', '--nav-hover@--sidebar-bg']],
  ['--sidebar-muted', ['--sidebar-bg']],
  ['--sidebar-section', ['--sidebar-bg']],
  ['--nav-active-fg', ['--nav-selected@--sidebar-bg']],
];

/** Цвет CSS (#rgb, #rrggbb, #rrggbbaa, rgba()) → [r, g, b, a] */
export function parseColor(value: string): [number, number, number, number] {
  const v = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return [parseInt(m[1]!.slice(0, 2), 16), parseInt(m[1]!.slice(2, 4), 16), parseInt(m[1]!.slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error(`not a colour: ${value}`);
}

/** Полупрозрачный цвет поверх непрозрачного */
export function over(top: [number, number, number, number], under: [number, number, number, number]): [number, number, number, number] {
  return [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])) as unknown as [number, number, number, number];
}

const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c: readonly number[]) => 0.2126 * channel(c[0]!) + 0.7152 * channel(c[1]!) + 0.0722 * channel(c[2]!);

/** Контраст WCAG 2 двух непрозрачных цветов */
export function contrast(a: readonly number[], b: readonly number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

/** Тон цвета в градусах (HSL) */
export function hue(c: readonly number[]): number {
  const [r, g, b] = c.slice(0, 3).map((x) => x / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}
