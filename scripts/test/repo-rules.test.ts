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

/**
 * Р-148 (шаг 33): репозиторий ПУБЛИЧНЫЙ, и логи доказательств в нём не несут путей файловой системы машины разработчика,
 * имён пользователей и внутренних адресов.
 *
 * Логи доказательств попадают в репозиторий как есть — их для того и хранят, чтобы отчёт можно было проверить. Но вывод
 * тестов полон стек-трейсов, а стек-трейс несёт абсолютный путь: до шага 33 в шести логах был виден домашний каталог
 * разработчика и рабочий каталог сессии. Само по себе это не секрет, но это шум, который никому не нужен, и он копится:
 * следующий лог принесёт его снова.
 */
test('Р-148: доказательства не несут путей машины разработчика и внутренних адресов', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  /**
   * Что запрещено: домашний каталог человека, рабочий каталог сессии и адрес из частной сети. Путь раннера сборки
   * (`/home/runner/...`) разрешён намеренно: он одинаков у всех, ничего не раскрывает и приходит из публичных логов CI.
   */
  const LEAKS_A_PATH = /\/Users\/[^\s'")\]]+|\/home\/(?!runner\b)[a-z][^\s'")\]]*|[A-Za-z]:\\+[Uu]sers\\+|(?:\/private)?\/tmp\/claude-|\/var\/folders\/[\w+/-]{6,}|(?<![\w/])~\/[\w.-]+\/|\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/;
  // Зубы [Р-94]: правило обязано ловить ровно то, что шаг 33 из логов и вычистил
  for (const bad of [
    'at /Users/kerim/Desktop/repracer/node_modules/pg/lib/client.js:694:17',
    "location: '/private/tmp/claude-501/-Users-kerim-Desktop-repracer/f1e3c879/scratchpad/snap18e/packages'",
    'at /home/kerim/projects/repracer/index.ts:1:1',
    'connecting to 10.0.3.17:5432',
    'C:\\Users\\kerim\\repracer',
    'cwd: /var/folders/x1/9sd8f7s3/T/repracer-run',
    'смотри ~/repracer/docs/evidence',
  ]) assert.match(bad, LEAKS_A_PATH, `правило обязано ловить: ${bad.slice(0, 60)}`);
  /** Чего ловить не должно: путь внутри репозитория, путь раннера сборки и локальная петля */
  for (const fine of [
    'at <repo>/packages/pricing-store-pg/src/db.ts:80:16',
    'at file:///home/runner/work/repracer/repracer/services/pricing-worker/test/order.test.ts:240:10',
    'REPRACER_PG_URL: postgres://svc_app@127.0.0.1:5432/repracer_eu',
    'подключение к localhost:4318',
  ]) assert.doesNotMatch(fine, LEAKS_A_PATH, `правило не должно ловить: ${fine.slice(0, 60)}`);

  const root = new URL('../../', import.meta.url);
  const offenders: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      const child = `${rel}${name}`;
      if (statSync(new URL(child, root)).isDirectory()) { walk(`${child}/`); continue; }
      if (!/\.(md|log|txt|json|jsonl|ya?ml|sh|mjs|sql)$/.test(name)) continue;
      // Сам разбор истории называет найденные пути как находку — иначе о них нельзя написать
      if (child === 'docs/evidence/step33-history-audit.md') continue;
      for (const line of readFileSync(new URL(child, root), 'utf8').split('\n')) {
        if (LEAKS_A_PATH.test(line)) { offenders.push(`${child}: ${line.trim().slice(0, 70)}`); break; }
      }
    }
  };
  /**
   * Смотрится ВЕСЬ репозиторий, а не только `docs/` (находка 8 ревью шага 33): первая редакция обещала «доказательства», а
   * путь машины так же легко попадает в README, в пример конфигурации или в скрипт.
   */
  for (const dir of ['docs/', 'deploy/', 'scripts/', 'tests/', 'infra/']) walk(dir);
  for (const file of ['README.md', 'CLAUDE.md', 'NOTICE.md']) {
    for (const line of readFileSync(new URL(file, root), 'utf8').split('\n')) {
      if (LEAKS_A_PATH.test(line)) { offenders.push(`${file}: ${line.trim().slice(0, 70)}`); break; }
    }
  }
  assert.deepEqual(offenders, [], 'доказательство несёт путь машины разработчика: репозиторий публичный [Р-148]');
});

/**
 * OQ-183, OQ-194, задача E шага 33: внешний контроль покрывает ВСЕ разворачиваемые процессы, а не только планировщик.
 *
 * Р-127 говорит: работоспособность процесса контролируется извне, потому что изнутри остановленный процесс о себе не
 * сообщает. Но само по себе это свойство держалось перечислением: три процесса по очереди научили отмечаться, и ничто не
 * мешало четвёртому появиться молчащим. Правило проверяет то, что должно быть верно и для процесса, которого ещё нет.
 */
test('Р-127: каждый разворачиваемый процесс отмечается во внешнем сервисе (OQ-183)', async () => {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);

  /**
   * «Разворачиваемый» определяется РАЗВЁРТЫВАНИЕМ, а не каталогом `services/` (находка 7 ревью шага 33): первая редакция
   * правила обещала «каждый процесс», а смотрела на `services/*`, и процесс, разворачиваемый иначе, мимо неё прошёл бы.
   * Точку входа называет сам compose развёртывания — оттуда она и берётся.
   */
  const entryPoints: Array<{ deployment: string; main: string }> = [];
  for (const name of readdirSync(new URL('deploy/', root))) {
    // `deploy/ci` — надстройки, которыми сборка поднимает остальные развёртывания, а не процесс
    if (name === 'ci' || !existsSync(new URL(`deploy/${name}/compose.yaml`, root))) continue;
    /**
     * Шаг 37 (находка 10 ревью): профиль берёт сервис ЧУЖОГО развёртывания через `extends`, и его `command:` виден
     * только там. Без раскрытия `extends` правило считало бы, что в профиле процессов продукта нет, — то есть второй
     * процесс, добавленный так же, прошёл бы мимо требования отмечаться. Это находка 7 ревью шага 33 в новой форме.
     */
    const readCompose = (file: string): string => {
      const text = readFileSync(new URL(file, root), 'utf8');
      const included = [...text.matchAll(/extends:\s*\n\s*file:\s*([^\s#]+)/g)].map((x) => x[1]!);
      return [text, ...included.map((rel) => readCompose(`deploy/${name}/${rel}`.replace(/[^/]+\/\.\.\//g, '')))].join('\n');
    };
    const compose = readCompose(`deploy/${name}/compose.yaml`);
    /**
     * Наш процесс в развёртывании узнаётся по тому, что оно запускает ФАЙЛ РЕПОЗИТОРИЯ. Шаг 36: профиль production
     * состоит из чужих образов (обратный прокси, копия базы) — отмечаться там нечему, и требовать отметку не от кого.
     * Правило от этого не слабеет: как только профиль запустит наш файл, отметка станет обязательной — и путь к файлу
     * проверяется целиком, а не только `services/*`.
     */
    /**
     * Наш код узнаётся по ЛЮБОМУ пути репозитория, а не только по `.ts` (находка 16 ревью шага 36): профиль production
     * запускает `backup-loop.sh` — первая редакция правила его не видела. Исключение для профиля из чужих образов —
     * ИМЕНОВАННОЕ, с причиной, а не «в compose есть слово image», которое истинно всегда.
     */
    const ours = [...compose.matchAll(/(?:^|[\s"'[])((?:services|apps|packages|scripts|tests)\/[\w./-]+\.(?:ts|mjs|js|sh))/gm)].map((x) => x[1]!);
    /**
     * Точка входа — то, что развёртывание ЗАПУСКАЕТ (`command:` или `entrypoint:`), а не файл с подходящим именем
     * (шаг 37): консоль запускается файлом `apps/console/server/console-service.ts`, и правило по имени его не видело
     * бы — то есть новый разворачиваемый процесс прошёл бы мимо требования отмечаться.
     */
    const launched = new Set([...compose.matchAll(/^\s*(?:command|entrypoint):.*$/gm)]
      .flatMap((line) => [...line[0].matchAll(/((?:services|apps|packages|scripts|tests)\/[\w./-]+\.(?:ts|mjs|js|sh))/g)].map((x) => x[1]!)));
    const entryLike = ours.filter((f) => launched.has(f) && !/\.sh$/.test(f));
    if (entryLike.length === 0) {
      /**
       * Шаг 37: именованных исключений больше НЕТ. Профиль production раньше состоял из чужих образов, а теперь берёт
       * консоль через `extends` — и её точка входа видна правилу (находка 10 ревью шага 37). Развёртывание без нашего
       * процесса вовсе — случай, которого сегодня не существует, и притворяться, что он предусмотрен, незачем.
       */
      assert.fail(`развёртывание ${name} не запускает ни одного нашего процесса: ${ours.join(', ') || 'нашего кода в нём нет'}`);
    }
    for (const main of entryLike) {
      // Процессы бэкенда живут в `services/<имя>/src/main.ts`, консоль — в своём приложении: оба варианта названы явно
      assert.match(main, /^(?:services\/[\w-]+\/src\/main\.ts|apps\/[\w-]+\/server\/[\w-]+\.ts)$/,
        `развёртывание ${name} запускает наш код точкой входа процесса: ${main}`);
      entryPoints.push({ deployment: name, main });
    }
  }
  assert.ok(entryPoints.length >= 3, `развёртывания найдены: ${entryPoints.map((e) => e.deployment).join(', ')}`);

  const silent: string[] = [];
  for (const { deployment, main } of entryPoints) {
    // Настройки процесса лежат рядом с его точкой входа: `services/<имя>/src/config.ts` или `apps/<имя>/server/config.ts`
    const dir = main.slice(0, main.lastIndexOf('/'));
    const source = readFileSync(new URL(main, root), 'utf8');
    const configPath = `${dir}/config.ts`;
    const config = existsSync(new URL(configPath, root)) ? readFileSync(new URL(configPath, root), 'utf8') : '';
    // Процесс обязан СТАВИТЬ отметку и обязан уметь объяснить её отсутствие: выключение — только явное
    const beats = /createHeartbeat\s*\(/.test(source) && /heartbeat\.beat\s*\(/.test(source);
    const optOutIsExplicit = /HEARTBEAT\s*===\s*'off'/.test(config);
    if (!beats || !optOutIsExplicit) {
      silent.push(`${deployment} (${main}): отметка ${beats ? 'есть' : 'НЕ СТАВИТСЯ'}, явное выключение ${optOutIsExplicit ? 'есть' : 'ОТСУТСТВУЕТ'}`);
    }
    // Отметка у всех одна и та же: вторая реализация разойдётся с общей [Р-145]
    assert.ok(!existsSync(new URL(`${dir}/heartbeat.ts`, root)), `${deployment}: своя реализация отметки`);
  }
  assert.deepEqual(silent, [], 'разворачиваемый процесс без внешней отметки: его остановку никто не заметит [Р-127]');
});

/**
 * Р-146, находка 10 ревью шага 33: правило «ссылки разрешаются» проверяло только номера открытых вопросов, а файловые
 * ссылки — нет. На том же шаге удалили файл, и три документа стали вести в никуда: реализацию отметки искали бы по
 * ссылке, которой больше нет. Документация, ведущая в 404, хуже её отсутствия — она отнимает время молча.
 */
test('Р-146: ссылка из документации ведёт на существующий файл (находка 10 ревью шага 33)', async () => {
  const { readdirSync, readFileSync, existsSync, statSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const LINK = /\]\(([^)#\s]+)(?:#[^)\s]*)?\)/g;

  const files: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      const child = `${rel}${name}`;
      if (statSync(new URL(child, root)).isDirectory()) walk(`${child}/`);
      else if (name.endsWith('.md')) files.push(child);
    }
  };
  walk('docs/');
  for (const name of ['README.md', 'CLAUDE.md', 'NOTICE.md']) files.push(name);
  assert.ok(files.length > 50, `документов найдено: ${files.length}`);

  const broken: string[] = [];
  for (const file of files) {
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    for (const [, target] of readFileSync(new URL(file, root), 'utf8').matchAll(LINK)) {
      // Внешние адреса и якоря внутри страницы — не наше дело: проверяются ссылки на файлы репозитория
      if (/^(https?:|mailto:)/.test(target!) || target!.startsWith('<')) continue;
      const resolved = new URL(target!, new URL(dir, root));
      if (!existsSync(resolved)) broken.push(`${file} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], 'ссылка из документации ведёт на несуществующий файл');
});

/**
 * Находка 1 ревью шага 36: то же правило смотрело ТОЛЬКО `.md`, и профиль production в двух местах отсылал к
 * `scripts/backup-restore-check.mjs`, которого нет. Файлы развёртывания и скрипты оболочки читают в тот же момент, что и
 * документацию, — когда что-то не поднялось, — и ссылка в никуда там стоит ровно столько же времени.
 *
 * Ссылка здесь — не markdown, а путь репозитория внутри комментария или команды: `scripts/…`, `deploy/…`, `packages/…`.
 * Файл окружения (`*.env`) в репозитории отсутствует намеренно (`.gitignore`: секреты не коммитятся) — его образец
 * `*.env.example` и есть то, что должно существовать.
 */
test('Р-146: путь репозитория в развёртывании и скрипте ведёт на существующее место (находка 1 ревью шага 36)', async () => {
  const { readdirSync, readFileSync, existsSync, statSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);
  const TOP = 'scripts|deploy|packages|apps|services|migrations|docs|tests|infra|schemas';
  const REF = new RegExp(`(?:^|[\\s"'\`(<\\[=,])((?:${TOP})/[A-Za-z0-9._/-]+)`, 'g');

  /**
   * СОБИРАЕМЫЕ пути: их в репозитории нет и быть не должно (`.gitignore`), они появляются сборкой. Список именованный и
   * с причиной — иначе правило либо краснеет на чистом клоне (так и случилось в CI шага 37: `apps/console/dist`
   * существовал только у того, кто собирал интерфейс), либо молча разрешает любой несуществующий путь.
   */
  const BUILT = ['apps/console/dist'];
  /** Путь, названный текстом, обязан существовать — сам, как образец для оператора или как результат сборки */
  const resolves = (target: string) => existsSync(new URL(target, root)) || existsSync(new URL(`${target}.example`, root))
    || BUILT.some((b) => target === b || target.startsWith(`${b}/`));
  const refsOf = (text: string) => [...text.matchAll(REF)].map(([, p]) => p!.replace(/[.,:;)\]]+$/, ''));

  /**
   * Положительный контроль [Р-94]: детектор обязан отличать живой путь от мёртвого и не считать ссылкой то, что ею не
   * является. Без него пустой список нарушителей не значит ничего — ровно так правило и пропустило находку 1.
   */
  const sample = 'запускается scripts/test-all.mjs, проверка — scripts/backup-restore-check.mjs (см. deploy/production/Caddyfile)';
  assert.deepEqual(refsOf(sample), ['scripts/test-all.mjs', 'scripts/backup-restore-check.mjs', 'deploy/production/Caddyfile']);
  assert.deepEqual(refsOf(sample).filter((p) => !resolves(p)), ['scripts/backup-restore-check.mjs'], 'детектор находит мёртвый путь');
  assert.deepEqual(refsOf('образ postgres/17 и путь /var/lib/postgresql/data ссылками не считаются'), []);
  // Собираемый путь разрешён, но только он сам: опечатка в нём — по-прежнему мёртвая ссылка
  assert.deepEqual(refsOf('интерфейс лежит в apps/console/dist/index.html, а не в apps/console/build/index.html').filter((x) => !resolves(x)),
    ['apps/console/build/index.html'], 'собираемый путь разрешён, опечатка в нём — нет');

  const files: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = `${rel}${name}`;
      if (statSync(new URL(child, root)).isDirectory()) walk(`${child}/`);
      else if (rel.startsWith('deploy/') || name.endsWith('.sh')) files.push(child);
    }
  };
  walk('');
  assert.ok(files.length > 10, `файлов развёртывания и скриптов найдено: ${files.length}`);

  const found: string[] = [];
  const broken: string[] = [];
  for (const file of files) {
    for (const target of refsOf(readFileSync(new URL(file, root), 'utf8'))) {
      found.push(target);
      if (!resolves(target)) broken.push(`${file} → ${target}`);
    }
  }
  // Второй положительный контроль: на настоящем дереве правило что-то ВИДИТ, а не молчит из-за неверного обхода
  assert.ok(found.length > 20, `путей репозитория в развёртываниях и скриптах найдено: ${found.length}`);
  assert.deepEqual(broken, [], 'развёртывание или скрипт ссылается на несуществующее место репозитория');
});

/**
 * Шаг 36: прогон, утверждающий СЕКУНДЫ, шёл в одном процессе node с соседями по рабочему пространству и мерил их нагрузку —
 * предпросмотр стратегии на 10 000 предложений уложился в 58 секунд в одиночку и не уложился в предел 120, пока рядом шли
 * остальные живые прогоны консоли. Такие файлы названы в `MEASURED_FILES` и идут по одному. Правило держит список полным:
 * новый прогон с утверждением о секундах, не названный там, снова начнёт мерить чужую нагрузку — молча и мимо.
 */
test('Р-146: каждый прогон, утверждающий секунды, назван прогоном-замером (шаг 36)', async () => {
  const { MEASURED_FILES } = await import('../test-scopes.mjs');
  const { existsSync, readdirSync, readFileSync, statSync } = await import('node:fs');
  const root = new URL('../../', import.meta.url);

  for (const file of MEASURED_FILES) assert.ok(existsSync(new URL(file, root)), `названный замером файл существует: ${file}`);

  const tests: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(new URL(rel, root))) {
      if (name === 'node_modules' || name === '.git') continue;
      const child = `${rel}${name}`;
      if (statSync(new URL(child, root)).isDirectory()) walk(`${child}/`);
      else if (name.endsWith('.test.ts')) tests.push(child);
    }
  };
  for (const dir of ['apps/', 'packages/', 'services/', 'tests/', 'scripts/']) walk(dir);
  assert.ok(tests.length > 50, `тестов найдено: ${tests.length}`);

  /**
   * Прогон решает по времени двумя способами, и оба ищутся: утверждением о секундах и ПРЕДЕЛОМ ОЖИДАНИЯ, после которого
   * прогон падает сам (`*_LIMIT_SECONDS` у опроса задания). Второй способ нашёлся сразу: `stock-only-live` секунд не
   * утверждает, но отказывает по пределу ожидания — одного детектора здесь мало.
   */
  const ASSERTS_TIME = /assert\.ok\([^;]*\b(?:seconds|Seconds|ms|Ms|elapsed|duration)\b[^;]*[<>]=?[^;]*\)/;
  const WAITS_BY_LIMIT = /\b[A-Z_]*LIMIT_(?:SECONDS|MS)\b/;
  const decidesByTime = (text: string) => ASSERTS_TIME.test(text) || WAITS_BY_LIMIT.test(text);
  // Положительный контроль: детектор действительно срабатывает — иначе пустой список «нарушителей» не значит ничего [Р-94]
  const listed = [...MEASURED_FILES].filter((f) => decidesByTime(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(listed.sort(), [...MEASURED_FILES].sort(), 'каждый названный замером прогон действительно решает по времени');
  // Само правило называет искомые образцы текстом — иначе оно нашло бы себя
  const SELF = 'scripts/test/repo-rules.test.ts';
  const missing = tests.filter((f) => f !== SELF && !MEASURED_FILES.has(f) && decidesByTime(readFileSync(new URL(f, root), 'utf8')));
  assert.deepEqual(missing, [], 'прогон утверждает время, но делит машину с соседями — назовите его в MEASURED_FILES');
});
