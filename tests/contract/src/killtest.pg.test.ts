import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readCatalog } from './killtest/catalog.ts';
import { internalLeaks } from './killtest/report.ts';
import { syntheticCatalog, syntheticItems } from './killtest/synthetic.ts';

/**
 * Шаг 71: kill-test «как руки» — от файла каталога до отчёта той же командой, что запускает человек (`scripts/killtest`), дочерним
 * процессом. Файл — синтетическая выгрузка «Business Report» на 300 строк (пять из них негодны), отчёт — во временном каталоге вне
 * репозитория. Проверяется готовый HTML: разделы, числа, «почему эта цена» словами, ни одного внутреннего кода или идентификатора,
 * ни одной внешней ссылки; в канал не ушло ничего — число из базы прогона, а не константа.
 */

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'repracer-killtest-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(join(repo, 'scripts', 'killtest'), args, { cwd: repo, encoding: 'utf8', env: process.env, timeout: 600_000 });

test('step 71: from a client file to a self-contained English report — decisions with reasons, what we did not do, no internal codes, nothing sent', () => {
  const input = join(dir, 'business-report.csv');
  const output = join(dir, 'business-report.report.html');
  writeFileSync(input, syntheticCatalog('business'));
  const r = run(['--in', input, '--out', output, '--hours', '4']);
  assert.equal(r.status, 0, `killtest failed: ${r.stderr.slice(-2000)}`);
  // Журнал команды — только числа: ни SKU, ни названий клиента
  assert.doesNotMatch(r.stderr + r.stdout, /SYN-KT-\d+|Plant pot|Water bottle/, 'the command log carries no client SKU or product name');
  const summary = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, number | string>;
  const items = syntheticItems(300).slice(0, 295);
  const noCost = items.filter((x) => x.costMinor === null).length;
  assert.deepEqual([summary.products, summary.rejectedRows, summary.priced, summary.noCost, summary.top, summary.sentToAmazon], [300, 5, 295 - noCost, noCost, 15, 0]);
  assert.ok(Number(summary.decisions) > 0 && Number(summary.changes) > 0 && Number(summary.floorHeld) > 0, JSON.stringify(summary));

  const html = readFileSync(output, 'utf8');
  for (const heading of ['Repricing decisions for your catalog', 'What is real and what is simulated', 'The 15 decisions that matter most', 'What we did NOT do — and why',
    'Without your unit cost', 'Rows we could not use', 'How this run was set up']) {
    assert.ok(html.includes(heading), `section «${heading}» is in the report`);
  }
  // Сводка — числа прогона, «в Amazon отправлено» — 0 из базы
  assert.match(html, new RegExp(`<div class="value">${summary.decisions}</div><div class="label">decisions</div>`));
  assert.match(html, /<div class="value">0<\/div><div class="label">changes sent to Amazon<\/div>/);
  // Топ-15: у каждого решения есть «почему» словами — подрез конкурента или упор в пол — и итог Price Gate
  const decisions = html.split('<article class="decision">').slice(1);
  assert.equal(decisions.length, 15);
  for (const d of decisions) {
    assert.match(d, /<h4>Why this price<\/h4>/);
    assert.match(d, /Undercut the lowest price \$[\d,]+\.\d\d by \$0\.01/, 'the strategy step is in words, with amounts');
    assert.match(d, /approved within \$[\d,]+\.\d\d–\$[\d,]+\.\d\d/, 'the Price Gate step is in words');
  }
  assert.ok(decisions.some((d) => d.includes('held by the floor')), 'at least one decision shows the floor stopping the price');
  assert.ok(decisions.some((d) => /\+\d/.test(d)), 'at least one decision raised the price');
  // Негодные строки — своей причиной и номером строки в файле клиента (заголовок — строка 1)
  assert.match(html, /<td>no price<\/td><td>1<\/td><td>297<\/td>/);
  assert.match(html, /could be read two ways/);
  assert.match(html, /another currency \(amazon\.com sells in US dollars\)/);
  // Колонки: прочитанные и проигнорированные названы
  assert.match(html, /"Units Ordered" as units sold in 30 days/);
  assert.match(html, /Columns we ignored: "Ordered Product Sales", "Sessions - Total"/);
  // Ни внутренних кодов, ни идентификаторов, ни внешних ресурсов (строки клиента — его SKU, названия, заголовки — не наши)
  const catalog = readCatalog(readFileSync(input), 'business-report.csv');
  const clientStrings = [catalog.fileName, ...catalog.recognized.map((c) => c.header), ...catalog.ignored, ...catalog.rows.flatMap((x) => [x.sku, x.title ?? '']),
    ...catalog.rejected.map((x) => x.sku ?? '')];
  assert.deepEqual(internalLeaks(html, clientStrings), []);
  assert.doesNotMatch(html, /<script|<link|<img|https?:\/\//i, 'the report is one self-contained file');
});

test('step 71: a client file or a report inside the repository is refused before anything is read, unless git ignores the place', () => {
  const sample = join(dir, 'sample.csv');
  writeFileSync(sample, syntheticCatalog('simple', 20));
  const inside = join(repo, 'tests', 'contract', 'killtest-report-should-not-exist.html');
  const refused = run(['--in', sample, '--out', inside, '--hours', '1']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /inside the repository and not ignored by git: put client files and reports into \.killtest\/ or outside the repository/);
  assert.equal(existsSync(inside), false, 'nothing was written');
  const insideInput = join(repo, 'tests', 'contract', 'package.json');
  const refusedInput = run(['--in', insideInput, '--out', join(dir, 'x.html')]);
  assert.equal(refusedInput.status, 2);
  assert.match(refusedInput.stderr, /package\.json is inside the repository and not ignored by git/);
});

test('step 71: the leak check names each kind of internal code — a report with one is not written (positive controls)', () => {
  const clean = '<p>Price $12.99 approved within $10.00–$20.00.</p>';
  assert.deepEqual(internalLeaks(clean, []), []);
  const cases: Array<[string, RegExp]> = [
    ['<p>decision 3c875137-0ebc-4e68-ae55-66fe3ea81821</p>', /^uuid/],
    ['<p>strategy BEAT_LOWEST</p>', /^UPPER_SNAKE code/],
    ['<p>below min_price</p>', /^lower_snake name/],
    ['<p>see Р-205</p>', /^decision or question number/],
    ['<p>rule set r49.1</p>', /^ruleset or profile version/],
    ['<p>storefront ATVPDKIKX0DER</p>', /^storefront id/],
    ['<p>offer B0KT000012</p>', /^synthetic world id/],
    ['<script src="x.js"></script>', /^external script/],
  ];
  for (const [html, kind] of cases) assert.ok(internalLeaks(html, []).some((l) => kind.test(l)), `${html} → ${JSON.stringify(internalLeaks(html, []))}`);
  // Строка клиента с подчёркиванием (его заголовок «sales_30d») — не наша и утечкой не считается
  assert.deepEqual(internalLeaks('<li>"sales_30d" as units sold in 30 days</li>', ['sales_30d']), []);
});
