import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogTestRefs, laneOf, LIGHT_PLACES } from '../ci-lane.mjs';
import { mergeDecision } from '../merge-when-green.mjs';

/**
 * Р-236 (шаг 110): две полосы CI. Полосу шага решает скрипт по списку путей диффа, а не суждение: лёгкая — только явный список мест
 * (консоль, модели экранов и словари, тесты консоли быстрой области, документы), всё остальное — тяжёлая («спорное = тяжёлая»). Слияние —
 * по полосе и по последней ночи: красная ночь останавливает слияние любого шага. Полный прогон main — ночью по расписанию.
 */

const root = new URL('../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const lane = (paths: string[]) => laneOf(paths).lane;

test('Р-236: лёгкая полоса — только консоль, модели экранов и словари, тесты консоли быстрой области и документы', () => {
  assert.equal(lane(['apps/console/src/screens/Competition.tsx', 'packages/console-model/src/i18n/fr.ts', 'apps/console/test/browser-smoke.test.ts']), 'LIGHT');
  assert.equal(lane(['docs/evidence/step110-ci-lanes.md', 'docs/evidence/step109-ux/after-en-light-1440-competition-summary-us.jpg', 'CLAUDE.md', 'README.md']), 'LIGHT');
  assert.deepEqual(LIGHT_PLACES.map((p) => p.prefix ?? p.exact),
    ['apps/console/src/', 'packages/console-model/src/', 'apps/console/test/', 'docs/', 'CLAUDE.md', 'README.md'], 'список лёгких мест расширяется только решением');
});

test('Р-236: тяжёлая полоса — миграции, движок, хранилище, Gate, симулятор, ClickHouse и всё вне списка; спорное — тяжёлое', () => {
  const heavyOf = (path: string) => laneOf([path]).heavy.map((h) => h.why);
  for (const path of [
    'migrations/0209_example.sql', 'packages/strategy-engine/src/engine.ts', 'packages/stock-sync/src/pipeline.ts', 'packages/pricing-store-pg/src/store.ts',
    'packages/price-gate/src/gate.ts', 'tests/contract/src/simulator/amazon-port.ts', 'packages/analytics-export/src/competitor-history.ts', 'schemas/clickhouse/099_verify.sql',
    // Спорное — тяжёлое: сервер консоли пишет в базу, конфигурация сборки консоли, зависимости, процесс CI, сами правила, снимки каналов, лендинг
    'apps/console/server/stand-server.ts', 'apps/console/vite.config.ts', 'package-lock.json', '.github/workflows/ci.yml', 'scripts/ci-lane.mjs',
    'vendor/amazon/sp-api-models/2026-10-29/SOURCE.md', 'apps/landing/index.html', 'packages/console-model/package.json', 'docsx/readme.md',
  ]) assert.deepEqual(heavyOf(path), ['вне списка лёгких мест'], path);
  // Одного тяжёлого файла хватает, чтобы весь шаг шёл тяжёлой полосой
  assert.equal(lane(['apps/console/src/screens/Offers.tsx', 'migrations/0209_example.sql']), 'HEAVY');
  assert.equal(lane([]), 'HEAVY', 'пустой дифф — спрашивают не о том');
});

test('Р-236: тест в лёгком месте — тяжёлый, если быстрый прогон его не гоняет или на него ссылается каталог мутаций', () => {
  // Зубы [Р-94]: настоящий тест полного прогона из scripts/test-scopes.mjs
  assert.deepEqual(laneOf(['apps/console/test/demo-day-live.pg.test.ts']).heavy.map((h) => h.why), ['тест полного прогона (scripts/test-scopes.mjs)']);
  assert.deepEqual(laneOf(['apps/console/test/shadow-live.pg.test.ts']).heavy.map((h) => h.why), ['тест полного прогона (scripts/test-scopes.mjs)']);
  // Каталог называет тесты и полным путём, и именем файла — оба вида ловятся
  const catalog = catalogTestRefs(`node('summary-step109.pg.test.ts', 'x'); node('apps/console/test/named.pg.test.ts', 'y');`);
  assert.deepEqual([...catalog].sort(), ['apps/console/test/named.pg.test.ts', 'summary-step109.pg.test.ts']);
  assert.equal(laneOf(['apps/console/test/named.pg.test.ts'], { catalog }).lane, 'HEAVY');
  assert.equal(laneOf(['apps/console/test/summary-step109.pg.test.ts'], { catalog }).lane, 'HEAVY');
  assert.equal(laneOf(['apps/console/test/console.test.ts'], { catalog }).lane, 'LIGHT');
  // Настоящий каталог читается: на него ссылаются тесты хранилища
  assert.ok(catalogTestRefs().has('summary-step109.pg.test.ts'), 'каталог мутаций прочитан');
});

test('Р-236: слияние — лёгкая по зелёному быстрому, тяжёлая по обоим; красная ночь останавливает любой шаг', () => {
  const green = { status: 'completed', conclusion: 'success' };
  const red = { status: 'completed', conclusion: 'failure' };
  const running = { status: 'in_progress', conclusion: null };
  const decide = (lane: 'LIGHT' | 'HEAVY', push: object | null, dispatch: object | null, night: object | null) => mergeDecision({ lane, push, dispatch, night });
  assert.deepEqual(decide('LIGHT', green, null, green), { action: 'MERGE', why: 'LIGHT_FAST_GREEN' });
  assert.deepEqual(decide('LIGHT', green, null, null), { action: 'MERGE', why: 'LIGHT_FAST_GREEN' }, 'ночей ещё не было — лёгкая сливается');
  assert.deepEqual(decide('HEAVY', green, null, green), { action: 'WAIT', why: 'FULL_NOT_STARTED' }, 'тяжёлая без полного прогона не сливается');
  assert.deepEqual(decide('HEAVY', green, running, green), { action: 'WAIT', why: 'FULL_RUNNING' });
  assert.deepEqual(decide('HEAVY', green, green, green), { action: 'MERGE', why: 'HEAVY_BOTH_GREEN' });
  assert.deepEqual(decide('HEAVY', green, red, green), { action: 'STOP', why: 'FULL_RED' });
  assert.deepEqual(decide('LIGHT', running, null, green), { action: 'WAIT', why: 'FAST_RUNNING' });
  assert.deepEqual(decide('LIGHT', red, null, green), { action: 'STOP', why: 'FAST_RED' });
  assert.deepEqual(decide('LIGHT', green, null, red), { action: 'STOP', why: 'NIGHT_RED' }, 'красная ночь — шаги не сливаются до зелёной');
  assert.deepEqual(decide('HEAVY', green, green, { status: 'completed', conclusion: 'cancelled' }), { action: 'STOP', why: 'NIGHT_RED' }, 'снятая ночь — не зелёная');
});

/**
 * Р-236, п. 3: полный прогон main — ночью по расписанию; задания полного прогона (полный, сутки демо и тени, хаос, масштаб) идут по
 * расписанию и по запросу, а не на каждый push — тяжёлая полоса запускает их на ветке до слияния, лёгкая их до ночи не ждёт.
 * Быстрые задания (fast, guards, замер сжатия) — на каждый push
 */
const FULL_JOBS = ['full', 'demo-day', 'shadow-day', 'chaos', 'scale'];
const FAST_JOBS = ['fast', 'guards', 'clickhouse-compression'];
const NIGHT_CONDITION = "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";

function workflowFindings(ci: string): string[] {
  const findings: string[] = [];
  const on = /^on:\n((?: {2}.*\n|\n)*)/m.exec(ci)?.[1] ?? '';
  const cron = /^ {2}schedule:\n {4}- cron: '([^']+)'/m.exec(on)?.[1];
  if (!cron) findings.push('нет ночного расписания on.schedule');
  else if (!/^\d{1,2} \d{1,2} \* \* \*$/.test(cron) || cron.startsWith('0 ')) findings.push(`расписание не раз в сутки или в начале часа: ${cron}`);
  if (!/^ {2}push:/m.test(on) || !/^ {2}workflow_dispatch:/m.test(on)) findings.push('push и workflow_dispatch должны остаться');
  const jobs = new Map([...ci.matchAll(/^ {2}([a-z-]+):\n((?: {4}.*\n|\n)*)/gm)].map((m) => [m[1]!, m[2]!]));
  for (const job of FULL_JOBS) {
    const body = jobs.get(job);
    if (!body) findings.push(`нет задания ${job}`);
    else if (!body.split('\n').some((line) => line.trim() === NIGHT_CONDITION)) findings.push(`${job}: не только ночью и по запросу`);
  }
  for (const job of FAST_JOBS) {
    const body = jobs.get(job);
    if (!body) findings.push(`нет задания ${job}`);
    else if (/^ {4}if:/m.test(body)) findings.push(`${job}: быстрое задание должно идти на каждый push`);
  }
  return findings;
}

test('Р-236: ночной полный прогон main по расписанию; полные задания — ночью и по запросу, быстрые — на каждый push', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.deepEqual(workflowFindings(ci), []);
  // Зубы [Р-94]: прежнее условие «на push в main» и пропавшее расписание правило видит
  const old = ci.replaceAll(NIGHT_CONDITION, "if: github.ref == 'refs/heads/main' || github.event_name == 'workflow_dispatch'").replace(/^ {2}schedule:\n {4}- cron: '[^']+'.*\n/m, '');
  assert.deepEqual(workflowFindings(old), ['нет ночного расписания on.schedule', ...FULL_JOBS.map((j) => `${j}: не только ночью и по запросу`)]);
  assert.deepEqual(workflowFindings(ci.replace(/- cron: '[^']+'/, "- cron: '0 2 * * *'")), ["расписание не раз в сутки или в начале часа: 0 2 * * *"],
    'начало часа — время наибольшей нагрузки GitHub Actions: запуск сдвигают или снимают');
});
