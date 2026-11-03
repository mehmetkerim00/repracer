/**
 * Шаг 112 [Р-238]: «чип тихий» числами — общий расчёт у правила токенов (`design-tokens.test.ts`, значения tokens.css во всех темах) и у
 * браузерного смоука (цвета, которые браузер на деле нарисовал в таблице): контраст WCAG и цветовое расстояние ΔE76 в Lab
 */
export const CHIP_PLATFORMS = ['amazon', 'walmart', 'ebay', 'kaufland', 'other'] as const;
const linear = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const rgbOf = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const luminance = (hex: string) => { const [r, g, b] = rgbOf(hex).map(linear) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]; return (x + 0.05) / (y + 0.05); };
function labOf(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map(linear) as [number, number, number];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
export const deltaE = (a: string, b: string) => Math.hypot(...labOf(a).map((v, i) => v - labOf(b)[i]!));

/** Чип каждой площадки в одной теме: подложка, буква и токены Primer, из которых они взяты */
export interface ChipTheme { surface: string; danger: string; chips: Record<string, { bg: string; fg: string; sources: string[] }> }

export function chipProblems(theme: string, t: ChipTheme): string[] {
  const out: string[] = [];
  for (const [p, c] of Object.entries(t.chips)) {
    if (contrast(c.bg, t.surface) > 1.3) out.push(`${theme} ${p}: loud — the chip stands out of the row (${contrast(c.bg, t.surface).toFixed(2)}:1 against the surface)`);
    if (contrast(c.fg, c.bg) < 4.5) out.push(`${theme} ${p}: the letter is hard to read (${contrast(c.fg, c.bg).toFixed(2)}:1)`);
    const mark = contrast(c.bg, t.surface) > contrast(c.fg, t.surface) ? c.bg : c.fg;
    if (deltaE(mark, t.danger) < 25) out.push(`${theme} ${p}: reads as an error — ΔE ${deltaE(mark, t.danger).toFixed(1)} from the danger color`);
  }
  const names = Object.keys(t.chips);
  for (let i = 0; i < names.length; i++) for (const q of names.slice(i + 1)) {
    const d = deltaE(t.chips[names[i]!]!.fg, t.chips[q]!.fg);
    if (d < 15) out.push(`${theme} ${names[i]} and ${q}: hard to tell apart (ΔE ${d.toFixed(1)})`);
  }
  if (t.chips.ebay?.sources.some((s) => /--display-(red|coral)-/.test(s))) out.push(`${theme} ebay: a red family of Primer — the color of errors (coral is red in the dark theme)`);
  return out;
}

