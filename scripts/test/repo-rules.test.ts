import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * Р-146 (шаг 32): находка, пойманная ревьюером или мутацией, закрывается ПРАВИЛОМ там, где это возможно. Ревьюер и мутация
 * ловят случайно — правило ловит всегда.
 *
 * Здесь — правила уровня репозитория, выросшие из конкретных находок шагов 29–31. У каждого назван свой случай: правило,
 * которое не может назвать, что именно оно поймало, обычно не ловит ничего.
 */

const root = new URL('../../', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, root), 'utf8');

/**
 * Находка 15 ревью шага 31: заголовок миграции `0110` называл себя `0111`. Мелочь — пока по заголовкам не начнут искать
 * миграцию, объясняющую поведение базы; тогда это стоит получаса.
 */
test('Р-146: миграция называет в заголовке свой собственный номер (находка 15 ревью шага 31)', () => {
  const numberOf = (text: string) => /^--\s*(\d{4})_/.exec(text.split('\n')[0] ?? '')?.[1] ?? null;
  // Зубы [Р-94]: правило обязано отличать верный заголовок от неверного
  assert.equal(numberOf('-- 0110_mass_change_guards.sql: стражи'), '0110');
  assert.equal(numberOf('-- Шаг 32: у файла задания появляются стражи'), null, 'заголовок без номера правилом не считается');

  const wrong: string[] = [];
  for (const file of readdirSync(new URL('migrations/', root)).filter((f) => /^\d{4}_.*\.sql$/.test(f))) {
    const declared = numberOf(read(`migrations/${file}`));
    if (declared !== null && declared !== file.slice(0, 4)) wrong.push(`${file} называет себя ${declared}`);
  }
  assert.deepEqual(wrong, [], 'миграция называет чужой номер: по заголовку её потом не найти');
});

/**
 * Находка 23 ревью шага 29: номера открытых вопросов дублировались (OQ-197 и OQ-200 описаны дважды), а ссылки на них
 * расходились. Номер — это адрес решения; два решения по одному адресу означают, что ссылка ведёт не туда.
 */
test('Р-146: номера решений и открытых вопросов не повторяются, ссылки разрешаются (находка 23 ревью шага 29)', () => {
  /** Номер объявлен там, где строка таблицы ИМ НАЧИНАЕТСЯ: `| Р-145 | …`. Упоминание в тексте объявлением не считается */
  const declared = (text: string, prefix: string) => {
    const seen = new Set<string>();
    const twice: string[] = [];
    for (const line of text.split('\n')) {
      const hit = new RegExp(`^\\|\\s*(?:~~)?${prefix}-(\\d+)`).exec(line);
      if (!hit) continue;
      const id = `${prefix}-${hit[1]}`;
      // Зачёркнутая строка — прежняя формулировка того же номера, а не второе решение
      if (line.includes('~~') && line.slice(0, line.indexOf('|', 2)).includes('~~')) continue;
      if (seen.has(id)) twice.push(id); else seen.add(id);
    }
    return { seen, twice };
  };
  // Зубы: правило обязано увидеть повтор и не считать повтором зачёркнутую прежнюю формулировку
  assert.deepEqual(declared('| Р-1 | a |\n| Р-1 | b |', 'Р').twice, ['Р-1']);
  assert.deepEqual(declared('| OQ-9 | B | новое |\n| ~~OQ-9~~ | — | прежняя формулировка |', 'OQ').twice, []);

  const decisions = declared(read('docs/decisions.md'), 'Р');
  const questions = declared(read('docs/open-questions.md'), 'OQ');
  /** Та же таблица в постоянном контексте проекта: её читают чаще, чем сам реестр решений */
  const contextTable = declared(read('CLAUDE.md'), 'Р');
  assert.deepEqual([...decisions.twice, ...questions.twice, ...contextTable.twice], [],
    'один номер у двух строк: ссылка на него ведёт в обе сразу');
  assert.ok(decisions.seen.size > 140 && questions.seen.size > 180, `правилу есть что проверять: ${decisions.seen.size}/${questions.seen.size}`);

  /** Ссылка из постоянного контекста проекта обязана разрешаться: CLAUDE.md читают как оглавление */
  const context = read('CLAUDE.md');
  const dangling = [...new Set([...context.matchAll(/\bOQ-(\d+)\b/g)].map((h) => `OQ-${h[1]}`))]
    .filter((id) => !questions.seen.has(id));
  assert.deepEqual(dangling, [], 'CLAUDE.md ссылается на открытый вопрос, которого нет в docs/open-questions.md');
});

/**
 * Находка 18 ревью шага 29 (осталась в OQ-204): сборка перестала выполнять `test`-скрипты пакетов — файлы запускает раннер
 * своими флагами. Значит флаг, нужный пакету и добавленный в его скрипт, в сборке НЕ применится: пакет у себя зелёный, CI
 * гоняет не то же самое.
 */
test('Р-146: флаг, нужный пакету для тестов, есть и у раннера сборки (находка 18 ревью шага 29)', () => {
  const runner = read('scripts/test-all.mjs');
  const runnerArgs = /const args = \[([^\]]*)\]/.exec(runner)?.[1] ?? '';
  const runnerFlags = new Set([...runnerArgs.matchAll(/'(--[^']+)'/g)].map((h) => h[1]!));
  assert.ok(runnerFlags.has('--experimental-strip-types') && runnerFlags.has('--test'), `флаги раннера прочитаны: ${[...runnerFlags]}`);
  /** Вид отчёта на то, ЧТО выполняется, не влияет — он про то, как печатать */
  const COSMETIC = /^--test-reporter/;

  const missing: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      if (name === 'node_modules') continue;
      if (name === 'package.json') {
        const script = (JSON.parse(read(`${rel}package.json`)) as { scripts?: Record<string, string> }).scripts?.test;
        for (const flag of (script ?? '').split(/\s+/).filter((a) => a.startsWith('--'))) {
          if (!COSMETIC.test(flag) && !runnerFlags.has(flag)) missing.push(`${rel}: ${flag}`);
        }
      } else if (!name.includes('.')) walk(`${rel}${name}/`);
    }
  };
  for (const dir of ['packages/', 'apps/', 'services/', 'tests/']) walk(dir);
  assert.deepEqual(missing, [], 'пакет просит флаг, которого раннер сборки не передаёт: у себя пакет зелёный, в CI — другое');
});
