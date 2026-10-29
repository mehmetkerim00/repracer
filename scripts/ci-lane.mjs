// Р-236 (шаг 110): две полосы CI. Полосу шага решает этот скрипт по диффу ветки против main — списком путей, а не суждением.
//
// Тяжёлая полоса — оба прогона до слияния (быстрый от push и полный по запросу): миграции, движок цен и остатков, хранилище, Gate,
// симулятор каналов, выгрузка в ClickHouse и всё остальное, что не названо ниже. Лёгкая — шаг только консоли, текстов и документов без
// миграций: слияние по зелёному быстрому прогону и затронутым тестам; полный прогон main идёт ночью по расписанию.
//
// Список ЛЁГКИХ мест — явный; путь вне списка — тяжёлая полоса («спорное = тяжёлая»). Тест в лёгком месте всё равно тяжёлый, если
// быстрый прогон его не гоняет (scripts/test-scopes.mjs) или на него ссылается каталог мутаций (tests/db/mutations.mjs): его правку
// проверяет только полный прогон.
//
//   node scripts/ci-lane.mjs [база] [вершина]    — по умолчанию origin/main и HEAD; печатает JSON: полоса и тяжёлые пути с причиной

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INFRASTRUCTURE_FILES } from './test-scopes.mjs';

const root = new URL('../', import.meta.url);

/** Лёгкие места: интерфейс консоли, модели экранов и словари, тесты консоли быстрой области, документы */
export const LIGHT_PLACES = [
  { prefix: 'apps/console/src/', what: 'интерфейс консоли' },
  { prefix: 'packages/console-model/src/', what: 'модели экранов и словари' },
  { prefix: 'apps/console/test/', what: 'тесты консоли быстрой области' },
  { prefix: 'docs/', what: 'документы и доказательства' },
  { exact: 'CLAUDE.md', what: 'постоянный контекст проекта' },
  { exact: 'README.md', what: 'обзор' },
];

/** Файлы тестов, на которые ссылается каталог мутаций: полные пути и имена файлов (каталог называет и так, и так) */
export function catalogTestRefs(text = readFileSync(new URL('tests/db/mutations.mjs', root), 'utf8')) {
  return new Set([...text.matchAll(/'([A-Za-z0-9._/-]+\.test\.ts)'/g)].map((m) => m[1]));
}

/**
 * Полоса по списку изменённых путей. Возвращает `{ lane: 'LIGHT' | 'HEAVY', heavy: [{ path, why }] }`; пустой дифф — тяжёлая (сливать
 * нечего — значит, спрашивают не о том)
 */
export function laneOf(paths, { fullOnly = INFRASTRUCTURE_FILES, catalog = catalogTestRefs() } = {}) {
  const heavy = [];
  for (const path of paths) {
    const place = LIGHT_PLACES.find((p) => (p.exact ? path === p.exact : path.startsWith(p.prefix)));
    if (!place) { heavy.push({ path, why: 'вне списка лёгких мест' }); continue; }
    if (fullOnly.has(path)) { heavy.push({ path, why: 'тест полного прогона (scripts/test-scopes.mjs)' }); continue; }
    const name = path.split('/').at(-1);
    if (catalog.has(path) || catalog.has(name)) heavy.push({ path, why: 'тест каталога мутаций (tests/db/mutations.mjs)' });
  }
  if (paths.length === 0) heavy.push({ path: '(пусто)', why: 'дифф пуст' });
  return { lane: heavy.length === 0 ? 'LIGHT' : 'HEAVY', heavy };
}

/** Изменённые пути ветки против базы (от общего предка): при переименовании — оба имени */
export function changedPaths(base, head) {
  const out = execFileSync('git', ['diff', '--name-status', '-M', `${base}...${head}`], { cwd: fileURLToPath(root), encoding: 'utf8' });
  return [...new Set(out.split('\n').filter(Boolean).flatMap((line) => line.split('\t').slice(1)))];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base = 'origin/main', head = 'HEAD'] = process.argv.slice(2);
  const paths = changedPaths(base, head);
  console.log(JSON.stringify({ base, head, files: paths.length, ...laneOf(paths) }, null, 2));
}
