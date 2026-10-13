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

function primerTokens(): Map<string, string> {
  const files = [
    join(primerDir, 'functional', 'themes', 'light.css'),
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
export function tokenProblems(tokensCss: string, primer: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const body = tokensCss.replace(/\/\*(?!\s*primer:)[\s\S]*?\*\//g, '');
  for (const line of body.split('\n')) {
    const m = /^\s*(--[A-Za-z0-9-]+)\s*:\s*(.+?);\s*(?:\/\*\s*primer:\s*(--[A-Za-z0-9-]+)\s*\*\/)?\s*$/.exec(line);
    if (!m) continue;
    const [, name, value, source] = m as unknown as [string, string, string, string | undefined];
    if (source !== undefined) {
      const expected = primer.get(source);
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

test('step 83: every value in tokens.css is the GitHub Primer token it names — nothing invented', () => {
  const primer = primerTokens();
  const tokensCss = readFileSync(join(consoleDir, 'src', 'tokens.css'), 'utf8');
  assert.deepEqual(tokenProblems(tokensCss, primer), []);
  // Положительные контроли: чужое значение под пометкой, непомеченное значение и выдуманный токен краснеют [Р-94]
  assert.match(tokenProblems('  --text: #123456; /* primer: --fgColor-default */', primer).join(), /is not primer --fgColor-default/);
  assert.match(tokenProblems('  --brand: #0B7A62;', primer).join(), /has no primer source/);
  assert.match(tokenProblems('  --x: #ffffff; /* primer: --fgColor-madeUp */', primer).join(), /is not in the package/);
  assert.deepEqual(tokenProblems('  --ring: 0 0 0 var(--focus-width) var(--focus-color);', primer), [], 'a value composed of tokens needs no source');
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
