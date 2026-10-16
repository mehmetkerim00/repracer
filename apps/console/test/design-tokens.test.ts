import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Шаг 83: правило «ничего не изобретать» [Р-146]. Облик консоли берёт каждое значение из дизайн-системы GitHub Primer
 * (@primer/primitives, MIT): у значения в tokens.css — пометка `primer: --имя`, и значение обязано совпадать с токеном пакета;
 * непомеченное — только составное из других токенов или названное исключение. В styles.css цвета, размеры шрифта, радиусы и шрифтовые
 * стеки — только токенами: свой цвет или размер в стилях — красная сборка.
 */

const here = dirname(fileURLToPath(import.meta.url));
const consoleDir = join(here, '..');
const primerDir = join(consoleDir, '..', '..', 'node_modules', '@primer', 'primitives', 'dist', 'css');

/** Непомеченные значения tokens.css, которые не из Primer, — с причиной */
const EXCEPTIONS: Readonly<Record<string, string>> = {
  '--font-mono': 'IBM Plex Mono — только денежные колонки таблиц, решение владельца шага 83',
  '--topbar-h': 'высота шапки — размер раскладки консоли, не значение дизайн-системы',
  '--sidebar-w': 'ширина боковой панели — размер раскладки консоли, не значение дизайн-системы',
};

/**
 * Шаг 92 [Р-216]: тема пакета, с которой сверяется значение. Консоль — светлая тема Primer с тёмной шапкой; знак в шапке берёт зелёный,
 * которого в светлой теме нет, — такое значение помечается `primer-dark: --имя` и сверяется с тёмной темой
 */
function primerTokens(theme: 'light' | 'dark' = 'light'): Map<string, string> {
  const files = [
    join(primerDir, 'functional', 'themes', `${theme}.css`),
    ...['functional/size', 'functional/typography', 'base/size', 'base/typography'].flatMap((d) =>
      readdirSync(join(primerDir, d)).filter((f) => f.endsWith('.css')).map((f) => join(primerDir, d, f))),
  ];
  const raw = new Map<string, string>();
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/(--[A-Za-z0-9-]+)\s*:\s*([^;]+);/g)) if (!raw.has(m[1]!)) raw.set(m[1]!, m[2]!.trim());
  }
  const resolve = (value: string, depth = 0): string => {
    if (depth > 20) throw new Error(`primer token cycle at ${value}`);
    return value.replace(/var\((--[A-Za-z0-9-]+)\)/g, (_, name: string) => {
      const v = raw.get(name);
      if (v === undefined) throw new Error(`primer token ${name} is not in the package`);
      return resolve(v, depth + 1);
    });
  };
  return new Map([...raw].map(([k, v]) => [k, resolve(v)]));
}

const norm = (v: string) => v.replace(/\s+/g, ' ').trim().toLowerCase();

/** Проблемы tokens.css: значение не равно токену Primer, непомеченное значение, ссылка на токен, которого в пакете нет */
export function tokenProblems(tokensCss: string, primer: ReadonlyMap<string, string>, primerDark: ReadonlyMap<string, string> = primerTokens('dark')): string[] {
  const problems: string[] = [];
  const body = tokensCss.replace(/\/\*(?!\s*primer(?:-dark)?:)[\s\S]*?\*\//g, '');
  for (const line of body.split('\n')) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*(.+?);\s*(?:\/\*\s*primer(-dark)?:\s*(--[A-Za-z0-9-]+)\s*\*\/)?\s*$/.exec(line);
    if (!m) continue;
    const [, name, value, dark, source] = m as unknown as [string, string, string, string | undefined, string | undefined];
    if (source !== undefined) {
      const expected = (dark ? primerDark : primer).get(source);
      if (expected === undefined) problems.push(`${name}: primer token ${source} is not in the package`);
      else if (norm(value) !== norm(expected)) problems.push(`${name}: ${value} is not primer ${source} (${expected})`);
    } else if (!(name in EXCEPTIONS) && !/^(?:\s|,|\b0\b|var\(--[A-Za-z0-9-]+\))+$/.test(value)) {
      problems.push(`${name}: ${value} has no primer source and is not composed of tokens`);
    }
  }
  return problems;
}

const NAMED_COLORS = ['white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow', 'purple', 'pink', 'silver', 'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia'];

/** Проблемы styles.css: цвет, размер шрифта, радиус или шрифтовой стек значением, а не токеном */
export function styleProblems(stylesCss: string): string[] {
  const problems: string[] = [];
  const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of css.matchAll(/\{([^{}]*)\}/g)) {
    for (const decl of block[1]!.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      const value = decl.slice(i + 1).trim();
      const v = value.toLowerCase();
      if (/#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/.test(v) || NAMED_COLORS.some((c) => new RegExp(`(^|[\\s,(])${c}($|[\\s,)])`).test(v))) {
        problems.push(`${prop}: ${value} — colour as a literal`);
      }
      if (prop === 'font-size' && !/^var\(--[a-z0-9-]+\)$/.test(v) && v !== 'inherit') problems.push(`font-size: ${value} — size as a literal`);
      if (prop === 'font-family' && !/^var\(--[a-z0-9-]+\)$/.test(v) && v !== 'inherit') problems.push(`font-family: ${value} — font stack as a literal`);
      if (prop === 'border-radius' && !/^(?:var\(--[a-z0-9-]+\)|0|50%|inherit)$/.test(v)) problems.push(`border-radius: ${value} — radius as a literal`);
    }
  }
  return problems;
}

/** Имена токенов САМОЙ темы Primer (functional/themes) — значения, зависящие от темы; размеры и шрифты к ним не относятся */
function themeTokenNames(): Set<string> {
  return new Set([...readFileSync(join(primerDir, 'functional', 'themes', 'light.css'), 'utf8').matchAll(/(--[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]!));
}

/** Строки «токен → (значение, источник)» блока tokens.css по селектору */
function tokenLines(block: string): Map<string, { value: string; source: string; dark: boolean }> {
  const out = new Map<string, { value: string; source: string; dark: boolean }>();
  for (const m of block.matchAll(/^\s*(--[A-Za-z0-9-]+)\s*:\s*(.+?);\s*\/\*\s*primer(-dark)?:\s*(--[A-Za-z0-9-]+)\s*\*\//gm)) {
    out.set(m[1]!, { value: m[2]!, source: m[4]!, dark: m[3] !== undefined });
  }
  return out;
}

/**
 * Шаг 93: тёмная тема — целиком. Каждое значение светлого `:root`, взятое из темы Primer, имеет в ОБОИХ тёмных блоках (системная тема и
 * ручной выбор) пару с тем же токеном и пометкой `primer-dark`; блоки одинаковы. Значения пар сверяет `tokenProblems` с тёмной темой пакета
 */
/**
 * Шаг 93: исключения правила пар — токен, у которого тёмная тема берёт ДРУГОЕ имя Primer, названное здесь с причиной. Значение по-прежнему
 * сверяется с пакетом (tokenProblems); правило проверяет, что тёмная пара — ровно названная
 */
export const THEME_EXCEPTIONS: Readonly<Record<string, { dark: string; why: string }>> = {
  '--header-edge': {
    dark: '--borderColor-muted',
    why: 'нижний край шапки: в светлой теме цветом самой шапки (не виден), в тёмной шапка (--header-bgColor) того же цвета, что канва (--bgColor-muted), и край её отделяет',
  },
};

export function themeProblems(tokensCss: string, themed: ReadonlySet<string>, exceptions: Readonly<Record<string, { dark: string }>> = THEME_EXCEPTIONS): string[] {
  const problems: string[] = [];
  const blockOf = (open: RegExp): string | null => {
    const m = open.exec(tokensCss);
    if (!m) return null;
    let depth = 0;
    for (let i = m.index + m[0].length - 1; i < tokensCss.length; i++) {
      if (tokensCss[i] === '{') depth++;
      if (tokensCss[i] === '}' && --depth === 0) return tokensCss.slice(m.index, i + 1);
    }
    return null;
  };
  const light = blockOf(/^:root \{/m);
  const media = blockOf(/@media \(prefers-color-scheme: dark\) \{/);
  const manual = blockOf(/^:root\[data-theme="dark"\] \{/m);
  if (!light || !media || !manual) return [`tokens.css: a theme block is missing (light ${!!light}, system dark ${!!media}, manual dark ${!!manual})`];
  const lightTokens = [...tokenLines(light)].filter(([, t]) => !t.dark && themed.has(t.source));
  for (const [where, block] of [['system dark', media], ['manual dark', manual]] as const) {
    const darkTokens = tokenLines(block);
    for (const [name, t] of lightTokens) {
      const d = darkTokens.get(name);
      if (!d) problems.push(`${where}: ${name} has no dark value`);
      else if (!d.dark || d.source !== (exceptions[name]?.dark ?? t.source)) problems.push(`${where}: ${name} takes ${d.source} instead of the dark ${exceptions[name]?.dark ?? t.source}`);
    }
  }
  const norm2 = (b: string) => [...tokenLines(b)].map(([k, v]) => `${k}=${v.value}`).sort().join('\n');
  if (norm2(media) !== norm2(manual)) problems.push('the system dark block and the manual dark block differ');
  return problems;
}

/**
 * Шаг 93: отступы — только шкала Primer. `padding`, `margin`, `gap` (и их стороны) в styles.css — токены (`var(--…)`, а токены сверены с
 * пакетом выше), `0`, `auto` и выражения из токенов; число с единицей — красная сборка. Исключения — списком с причиной
 */
export const SPACING_EXCEPTIONS: Readonly<Record<string, string>> = {};

export function spacingProblems(stylesCss: string): string[] {
  const problems: string[] = [];
  const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = block[1]!.trim();
    for (const decl of block[2]!.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim().toLowerCase();
      if (!/^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?$/.test(prop)) continue;
      const value = decl.slice(i + 1).trim();
      const literal = value.replace(/var\(--[A-Za-z0-9-]+\)/g, '').match(/\d*\.?\d+(?:px|rem|em|%|vh|vw|ch)\b/);
      if (literal && !(`${selector} ${prop}` in SPACING_EXCEPTIONS)) problems.push(`${selector} { ${prop}: ${value} } — ${literal[0]} is not on the Primer spacing scale`);
    }
  }
  return problems;
}

/**
 * Шаг 85: брейкпоинты адаптива — только со шкалы Primer (`--breakpoint-*`: 544 / 768 / 1012 / 1280 и края шкалы). В условии `@media`
 * каждая длина — значение токена пакета в rem, а не своё число: «960px» или «1100px» — красная сборка
 */
export function mediaProblems(stylesCss: string, primer: ReadonlyMap<string, string>): string[] {
  const allowed = new Set([...primer].filter(([k]) => k.startsWith('--breakpoint-')).map(([, v]) => norm(v)));
  if (allowed.size === 0) throw new Error('primer breakpoints are not in the package');
  const problems: string[] = [];
  const css = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const media of css.matchAll(/@media([^{]*)\{/g)) {
    for (const length of media[1]!.matchAll(/(\d+(?:\.\d+)?)(px|rem|em)\b/g)) {
      if (!allowed.has(norm(length[0]))) problems.push(`@media${media[1]!.trimEnd()}: ${length[0]} is not a primer breakpoint`);
    }
  }
  return problems;
}

test('step 83: every value in tokens.css is the GitHub Primer token it names — nothing invented', () => {
  const primer = primerTokens();
  const tokensCss = readFileSync(join(consoleDir, 'src', 'tokens.css'), 'utf8');
  assert.deepEqual(tokenProblems(tokensCss, primer), []);
  // Положительные контроли: чужое значение под пометкой, непомеченное значение и выдуманный токен краснеют [Р-94]
  assert.match(tokenProblems('  --text: #123456; /* primer: --fgColor-default */', primer).join(), /is not primer --fgColor-default/);
  assert.match(tokenProblems('  --brand: #0B7A62;', primer).join(), /has no primer source/);
  assert.match(tokenProblems('  --x: #ffffff; /* primer: --fgColor-madeUp */', primer).join(), /is not in the package/);
  assert.deepEqual(tokenProblems('  --ring: 0 0 0 var(--focus-width) var(--focus-color);', primer), [], 'a value composed of tokens needs no source');
  // Шаг 92: пометка тёмной темы сверяется с тёмной темой — и только с ней
  assert.deepEqual(tokenProblems('  --x: #2ea043; /* primer-dark: --contribution-default-bgColor-3 */', primer), []);
  assert.match(tokenProblems('  --x: #2ea043; /* primer: --contribution-default-bgColor-3 */', primer).join(), /is not primer --contribution-default-bgColor-3/, 'the light theme has another value');
  assert.match(tokenProblems('  --x: #123456; /* primer-dark: --contribution-default-bgColor-3 */', primer).join(), /is not primer --contribution-default-bgColor-3/);
  // Пометок не меньше, чем значений Primer в файле: правило не зеленеет на пустом файле
  assert.ok((tokensCss.match(/primer: --/g) ?? []).length >= 60, 'tokens.css names its primer sources');
});

test('step 83: styles.css takes colours, font sizes, radii and font stacks only from tokens', () => {
  const stylesCss = readFileSync(join(consoleDir, 'src', 'styles.css'), 'utf8');
  assert.deepEqual(styleProblems(stylesCss), []);
  assert.match(styleProblems('.a { color: #0b7a62; }').join(), /colour as a literal/);
  assert.match(styleProblems('.a { box-shadow: 0 1px 2px rgba(16, 24, 40, 0.05); }').join(), /colour as a literal/);
  assert.match(styleProblems('.a { background: white; }').join(), /colour as a literal/);
  assert.match(styleProblems('.a { font-size: 13px; }').join(), /size as a literal/);
  assert.match(styleProblems('.a { font-family: Inter, sans-serif; }').join(), /font stack as a literal/);
  assert.match(styleProblems('.a { border-radius: 10px; }').join(), /radius as a literal/);
  assert.deepEqual(styleProblems('.a { color: var(--text); border-radius: 50%; font-size: var(--font-size); background: transparent; }'), []);
});

test('step 93: the dark theme is complete — every themed light value has its GitHub Primer dark pair, in both dark blocks', () => {
  const tokensCss = readFileSync(join(consoleDir, 'src', 'tokens.css'), 'utf8');
  const themed = themeTokenNames();
  assert.deepEqual(themeProblems(tokensCss, themed), []);
  assert.ok((tokensCss.match(/primer-dark: --/g) ?? []).length >= 120, 'both dark blocks carry their pairs');
  // Положительные контроли [Р-94]: выкинутая пара, пара не того токена и разошедшиеся блоки краснеют
  const dropped = tokensCss.replace(/\n\s*--danger: #f85149; \/\* primer-dark: --fgColor-danger \*\//, '');
  assert.match(themeProblems(dropped, themed).join(), /--danger has no dark value/);
  const swapped = tokensCss.replace('--text: #f0f6fc; /* primer-dark: --fgColor-default */', '--text: #9198a1; /* primer-dark: --fgColor-muted */');
  assert.match(themeProblems(swapped, themed).join(), /--text takes --fgColor-muted instead of the dark --fgColor-default/);
  // исключение пропускает ровно названную пару: без него край шапки краснеет, с чужой парой — тоже
  assert.match(themeProblems(tokensCss, themed, {}).join(), /--header-edge takes --borderColor-muted instead of the dark --header-bgColor/);
  assert.match(themeProblems(tokensCss, themed, { '--header-edge': { dark: '--borderColor-default' } }).join(), /--header-edge takes --borderColor-muted instead of the dark --borderColor-default/);
});

test('step 93: padding, margin and gap in styles.css are on the GitHub Primer spacing scale', () => {
  const stylesCss = readFileSync(join(consoleDir, 'src', 'styles.css'), 'utf8');
  assert.deepEqual(spacingProblems(stylesCss), []);
  // Положительные контроли [Р-94]: подсунутый «13px» роняет сборку, токены, ноль, auto и выражения из токенов — нет
  assert.match(spacingProblems('.a { padding: 13px var(--space-2); }').join(), /13px is not on the Primer spacing scale/);
  assert.match(spacingProblems('.a { margin-top: 0.8rem; }').join(), /0\.8rem/);
  assert.match(spacingProblems('.a { gap: 10px; }').join(), /10px/);
  assert.deepEqual(spacingProblems('.a { padding: 0 var(--space-3); margin: 0 auto; gap: var(--base-size-2); margin-left: calc(-1 * var(--space-4)); }'), []);
  // правило не зеленеет на пустом файле: отступов в стилях сотни
  assert.ok((stylesCss.match(/padding|margin|gap/g) ?? []).length > 200);
});

test('step 85: media queries break only at GitHub Primer breakpoints', () => {
  const primer = primerTokens();
  const stylesCss = readFileSync(join(consoleDir, 'src', 'styles.css'), 'utf8');
  assert.deepEqual(mediaProblems(stylesCss, primer), []);
  // правило не зеленеет на файле без адаптива: узкие экраны в стилях есть
  assert.ok((stylesCss.match(/@media/g) ?? []).length >= 3, 'styles.css has responsive rules');
  // Положительные контроли [Р-94]: свои числа краснеют, брейкпоинты Primer — нет
  assert.match(mediaProblems('@media (max-width: 960px) { .a { display: none; } }', primer).join(), /960px is not a primer breakpoint/);
  assert.match(mediaProblems('@media (width < 1100px) { .a { display: none; } }', primer).join(), /1100px is not a primer breakpoint/);
  assert.match(mediaProblems('@media (width >= 50rem) { .a { display: none; } }', primer).join(), /50rem is not a primer breakpoint/);
  assert.deepEqual(mediaProblems('@media (width < 63.25rem) { .a { display: none; } } @media (34rem <= width < 48rem) { .b { color: var(--text); } }', primer), []);
});

/**
 * Шаг 96 (аудит, I) [Р-146]: иконки меню — Octicons, родной набор Primer (@primer/octicons, MIT). Путь каждой иконки в icons.tsx —
 * дословно путь размера 24 из пакета (ничего не нарисовано руками); у каждого пункта меню — своя иконка, и она есть в наборе.
 * Контроли: подменённый путь и повтор иконки — ловятся
 */
const octiconsData = join(consoleDir, '..', '..', 'node_modules', '@primer', 'octicons', 'build', 'data.json');

/** Пути Octicons из icons.tsx и иконки пунктов меню из App.tsx — текстом исходников */
function consoleIcons(icons = readFileSync(join(consoleDir, 'src', 'icons.tsx'), 'utf8'), app = readFileSync(join(consoleDir, 'src', 'App.tsx'), 'utf8')) {
  const block = /export const OCTICONS[^=]*= \{\n([\s\S]*?)\n\};/.exec(icons)?.[1] ?? '';
  const octicons = new Map([...block.matchAll(/^ {2}'([a-z-]+)': (\[.*\]),$/gm)].map((x) => [x[1]!, JSON.parse(x[2]!) as string[]]));
  const nav = /export const NAV_ICONS[^=]*= \{([\s\S]*?)\};/.exec(app)?.[1] ?? '';
  const menu = new Map([...nav.matchAll(/(['\w-]+):\s*'([a-z-]+)'/g)].map((x) => [x[1]!.replace(/'/g, ''), x[2]!]));
  return { octicons, menu };
}

function iconProblems(found: ReturnType<typeof consoleIcons>, data: Record<string, { heights: Record<string, { path: string }> }>): string[] {
  const problems: string[] = [];
  for (const [name, paths] of found.octicons) {
    const source = data[name]?.heights['24']?.path;
    if (!source) { problems.push(`${name}: no such Octicon (24)`); continue; }
    const expected = [...source.matchAll(/ d="([^"]+)"/g)].map((x) => x[1]);
    if (JSON.stringify(expected) !== JSON.stringify(paths)) problems.push(`${name}: the path differs from @primer/octicons`);
  }
  const seen = new Map<string, string>();
  for (const [item, icon] of found.menu) {
    if (!found.octicons.has(icon)) problems.push(`${item}: ${icon} is not an Octicon of icons.tsx`);
    if (seen.has(icon)) problems.push(`${item} and ${seen.get(icon)} share the icon ${icon}`);
    seen.set(icon, item);
  }
  return problems;
}

test('step 96: menu icons are Octicons, verbatim from @primer/octicons, and every menu item has its own', () => {
  const data = JSON.parse(readFileSync(octiconsData, 'utf8')) as Record<string, { heights: Record<string, { path: string }> }>;
  const found = consoleIcons();
  assert.ok(found.octicons.size >= 10 && found.menu.size >= 9, `icons ${found.octicons.size}, menu items ${found.menu.size}`);
  assert.deepEqual(iconProblems(found, data), []);
  // Положительные контроли [Р-94]: путь, нарисованный руками, и повтор иконки у двух пунктов — краснеют
  const forged = new Map(found.octicons);
  forged.set('eye', ['M0 0h24v24H0z']);
  assert.match(iconProblems({ ...found, octicons: forged }, data).join(' | '), /eye: the path differs/);
  const twice = new Map(found.menu);
  twice.set('stop', 'eye');
  assert.match(iconProblems({ ...found, menu: twice }, data).join(' | '), /share the icon eye/);
});
