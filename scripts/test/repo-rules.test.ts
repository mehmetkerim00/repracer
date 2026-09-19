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
  // Зубы [Р-94]: правило обязано отличать верный заголовок от неверного и от его отсутствия
  assert.equal(numberOf('-- 0110_mass_change_guards.sql: стражи'), '0110');
  assert.equal(numberOf('-- Шаг 32: у файла задания появляются стражи'), null);

  /**
   * Отсутствие номера — тоже нарушение (находка 6 ревью шага 32): первая редакция правила такие файлы ПРОПУСКАЛА, и его
   * собственная новая миграция номера не называла. Старые миграции без номера перечислены поимённо — список закрытый, и
   * новая миграция в него попасть не может.
   */
  const WITHOUT_NUMBER_BEFORE_STEP_32 = new Set(readdirSync(new URL('migrations/', root))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 113 && numberOf(read(`migrations/${f}`)) === null));
  assert.ok(WITHOUT_NUMBER_BEFORE_STEP_32.size > 0 && WITHOUT_NUMBER_BEFORE_STEP_32.size < 30,
    `старых миграций без номера в заголовке: ${WITHOUT_NUMBER_BEFORE_STEP_32.size}`);

  const wrong: string[] = [];
  for (const file of readdirSync(new URL('migrations/', root)).filter((f) => /^\d{4}_.*\.sql$/.test(f))) {
    const declared = numberOf(read(`migrations/${file}`));
    if (declared === null) {
      if (!WITHOUT_NUMBER_BEFORE_STEP_32.has(file)) wrong.push(`${file} не называет своего номера`);
    } else if (declared !== file.slice(0, 4)) wrong.push(`${file} называет себя ${declared}`);
  }
  assert.deepEqual(wrong, [], 'миграция называет чужой номер или не называет своего: по заголовку её потом не найти');
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

/**
 * Р-145 (шаг 32), находка 9 ревью шага 32: список видов, отдающих файл, живёт в ДВУХ местах — в базе (0113) и в коде
 * (`FILE_PRODUCING_JOB_KINDS`). Разойтись они могут молча: вид, забытый в базе, упадёт в проде отказом `insufficient_privilege`
 * уже после того, как задание отработало, и продавец увидит непонятный код.
 */
test('Р-145: список видов, отдающих файл, одинаков в базе и в коде (находка 9 ревью шага 32)', () => {
  const kindsIn = (text: string, marker: RegExp) => {
    const body = marker.exec(text)?.[1] ?? '';
    return [...body.matchAll(/'([A-Z_]+)'/g)].map((h) => h[1]!).sort();
  };
  const inDb = kindsIn(read('migrations/0113_bulk_job_artifact_guards.sql'),
    /file_producing_job_kinds\(\)[\s\S]*?unnest\(ARRAY\[([^\]]*)\]/);
  const inCode = kindsIn(read('packages/pricing-pipeline/src/store.ts'),
    /FILE_PRODUCING_JOB_KINDS[^=]*=\s*\[([^\]]*)\]/);
  // Зубы: правило обязано что-то прочитать, а не сравнить два пустых списка
  assert.ok(inDb.length === 3 && inCode.length === 3, `списки прочитаны: база ${inDb}, код ${inCode}`);
  assert.deepEqual(inCode, inDb, 'список видов с файлом разошёлся между базой и кодом: база откажет уже после работы задания');
});
