import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool } from '@repracer/pricing-store-pg';
import { requireEnv } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { privacyProblem } from './killtest/main.ts';
import { internalLeaks, renderForLeakCheck, type ReportData } from './killtest/report.ts';
import { syntheticCatalog, syntheticItems } from './killtest/synthetic.ts';
import { DEFAULT_OPTIONS } from './killtest/world.ts';

/**
 * Шаг 71: kill-test «как руки» — от файла каталога до отчёта той же командой, что запускает человек (`scripts/killtest`), дочерним
 * процессом. Файл — синтетическая выгрузка «Business Report» на 300 строк (пять из них негодны), отчёт — во временном каталоге вне
 * репозитория. Числа отчёта сверяются с базой прогона, оставленной `--keep`, отдельными запросами (ревью, находка 13); в канал не ушло
 * ничего — ни записью базы, ни вызовом модели порта. База прогона не переживает ни конец прогона, ни прерывание, а базы старше суток
 * удаляет следующий запуск (находка 10).
 */

const repo = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), 'repracer-killtest-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[]) => spawnSync(join(repo, 'scripts', 'killtest'), args, { cwd: repo, encoding: 'utf8', env: process.env, timeout: 600_000 });
const summaryOf = (stdout: string) => JSON.parse(stdout.trim().split('\n').at(-1)!) as Record<string, number | string | boolean>;
const dbUrl = (name: string) => { const u = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); u.pathname = `/${name}`; return u.toString(); };
async function databases(pattern = 'killtest\\_%'): Promise<string[]> {
  const admin = createPool(requireEnv('REPRACER_PG_ADMIN_URL'), { max: 1 });
  try { return (await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname LIKE $1', [pattern])).rows.map((r) => r.datname); } finally { await admin.end(); }
}
async function adminQuery(sql: string): Promise<void> {
  const admin = createPool(requireEnv('REPRACER_PG_ADMIN_URL'), { max: 1 });
  try { await admin.query(sql); } finally { await admin.end(); }
}

/**
 * Внутреннее, которого в отчёте клиенту быть не должно, — СВОЙ список теста, а не правила отчёта: если правило отчёта ослабят, этот
 * список его не повторит. Исходы, стратегии, режимы, статусы записи, таблицы, витрина, синтетика мира прогона
 */
const INTERNAL = ['BEAT_LOWEST', 'APPROVED', 'REJECTED', 'NO_CHANGE', 'SHADOW_HELD', 'SHADOW_ALREADY_PROPOSED', 'SALES_TAX_EXCLUDED', 'ENGINE', 'DISPATCHED',
  'min_price', 'max_price', 'write_scope', 'channel_write', 'price_decision', 'pricing_halt', 'effective_floor', 'ATVPDKIKX0DER', 'A1SYNKILLTEST', 'B0KT',
  'killtest', 'Р-', 'OQ-', 'r49.', 'undefined', 'NaN', '[object'];

test('step 71: from a client file to a self-contained English report — numbers match the run database, nothing sent, no internal codes', async (t) => {
  const input = join(dir, 'business-report.csv');
  const output = join(dir, 'business-report.report.html');
  writeFileSync(input, syntheticCatalog('business'));
  const r = run(['--in', input, '--out', output, '--hours', '4', '--keep']);
  assert.equal(r.status, 0, `killtest failed: ${r.stderr.slice(-2000)}`);
  // Журнал команды — только числа и имя базы: ни SKU, ни названий клиента
  assert.doesNotMatch(r.stderr + r.stdout, /SYN-KT-\d+|Plant pot|Water bottle/, 'the command log carries no client SKU or product name');
  const summary = summaryOf(r.stdout);
  const name = String(summary.database);
  // Оставленная базой --keep копия каталога удаляется и тогда, когда утверждение ниже упало (шаг 72)
  t.after(() => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  assert.match(r.stderr, new RegExp(`database kept: ${name}; delete it with: psql .* -c 'DROP DATABASE ${name} WITH \\(FORCE\\)'`));
  const items = syntheticItems(300).slice(0, 295);
  const noCost = items.filter((x) => x.costMinor === null).length;
  // Пол маржи при комиссии 15 % и марже 10 % — не ниже себестоимости ÷ 0,75: себестоимость выше 75 % цены — цена ниже пола уже сейчас
  const belowFloor = items.filter((x) => x.costMinor !== null && x.costMinor > 0.75 * x.priceMinor).length;
  // Пол маржи выше допущенного максимума (+30 %) — подъёма нет (ревью шага 72, находка 1): ⌈себестоимость · 4 / 3⌉ > ⌈цена · 1,3⌉
  const raisable = items.filter((x) => x.costMinor !== null && x.costMinor > 0.75 * x.priceMinor && Math.ceil((x.costMinor * 4) / 3) <= Math.ceil((x.priceMinor * 130) / 100)).length;
  assert.ok(raisable > 0 && raisable < belowFloor, `the synthetic file has products below the margin floor of both kinds: ${raisable} of ${belowFloor}`);
  assert.deepEqual([summary.products, summary.rejectedRows, summary.priced, summary.noCost, summary.assumedCost, summary.top, summary.belowFloor],
    [300, 5, 295 - noCost, noCost, 0, 15, belowFloor]);
  // Р-207 (шаг 72): движок поднимает цену ниже пола маржи до пола — у каждого товара, чей пол не выше допущенного максимума
  assert.equal(summary.raisedToFloor, raisable, JSON.stringify(summary));

  // Пересчёт по базе прогона своими запросами — не функцией сводки тени, которой пользуется отчёт
  const pool = createPool(dbUrl(name), { max: 1 });
  let recount: Record<string, number>;
  try {
    const [d] = (await pool.query<Record<string, number>>(
      `SELECT count(*)::int AS decisions, count(*) FILTER (WHERE outcome = 'APPROVED')::int AS changes,
              count(*) FILTER (WHERE final_amount_minor = effective_floor_minor)::int AS floor_held, count(*) FILTER (WHERE NOT shadow)::int AS live,
              count(*) FILTER (WHERE outcome = 'REJECTED' AND rejection_reason = 'BELOW_MARGIN_FLOOR')::int AS margin_refused
         FROM channel_data.price_decision`)).rows;
    // Р-207: подъёмы до пола — главная причина намерения RAISED_TO_FLOOR; удержание пола маржи пишет строку floor_hold (0178)
    const [i] = (await pool.query<Record<string, number>>(
      `SELECT (SELECT count(DISTINCT d.write_scope_id)::int FROM channel_data.price_decision d
                 JOIN channel_data.price_intent x ON x.tenant_id = d.tenant_id AND x.price_intent_id = d.price_intent_id
                WHERE d.outcome = 'APPROVED' AND x.rationale -> 'reason' ->> 'code' = 'RAISED_TO_FLOOR'
                  AND x.rationale -> 'reason' -> 'params' ->> 'bound' = 'margin_floor') AS raised_scopes,
              (SELECT count(*)::int FROM channel_data.price_decision
                WHERE rejection_reason = 'BOUND_UNRESOLVABLE' AND reason_params ->> 'cause' = 'MARGIN_FLOOR_ABOVE_MAX_PRICE') AS above_max,
              count(*) FILTER (WHERE rationale -> 'reason' ->> 'code' = 'RAISED_TO_FLOOR' AND rationale -> 'reason' -> 'params' ->> 'bound' = 'margin_floor')::int AS raised,
              (SELECT count(*)::int FROM channel_data.price_intent pi JOIN channel_data.floor_hold h ON h.tenant_id = pi.tenant_id AND h.price_intent_id = pi.price_intent_id
                WHERE pi.rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MARGIN_FLOOR"}]'::jsonb) AS margin_holds,
              -- Ревью шага 72, находка 5: удержанная цена — пол из шага цепочки, и на повторном опросе тени («уже предложено» с ценой витрины)
              (SELECT count(*) FILTER (WHERE pi.rationale -> 'reason' ->> 'code' = 'SHADOW_ALREADY_PROPOSED')::int
                 FROM channel_data.price_intent pi JOIN channel_data.floor_hold h ON h.tenant_id = pi.tenant_id AND h.price_intent_id = pi.price_intent_id
                WHERE pi.rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MARGIN_FLOOR"}]'::jsonb) AS margin_holds_repeated,
              (SELECT count(*)::int FROM channel_data.price_intent pi JOIN channel_data.floor_hold h ON h.tenant_id = pi.tenant_id AND h.price_intent_id = pi.price_intent_id
                 CROSS JOIN LATERAL jsonb_array_elements(pi.rationale -> 'explanation') e
                WHERE e ->> 'code' = 'CAPPED_AT_MARGIN_FLOOR'
                  AND h.below_minor <> (e -> 'params' ->> 'floorMinor')::bigint - (e -> 'params' ->> 'targetMinor')::bigint) AS margin_hold_mismatch
         FROM channel_data.price_intent`)).rows;
    const [w] = (await pool.query<Record<string, number>>(
      `SELECT (SELECT count(*)::int FROM tenant_data.channel_write_history WHERE final_status = 'SHADOW_HELD' AND field <> 'QUANTITY') AS held,
              (SELECT count(*)::int FROM tenant_data.channel_write WHERE dispatched_at IS NOT NULL)
            + (SELECT count(*)::int FROM tenant_data.channel_write_history WHERE dispatched_at IS NOT NULL) AS dispatched`)).rows;
    recount = { ...d!, ...w!, ...i! };
    // Шаг 72 (находка 26 ревью шага 71): клиент amazon.com — регион хранения US [Р-60], и у базы, и у тенанта прогона
    const [r] = (await pool.query<{ db: string; tenants: string[] }>(
      `SELECT current_setting('repracer.region') AS db, array_agg(DISTINCT data_region) AS tenants FROM tenant_data.tenant WHERE kind <> 'PLATFORM'`)).rows;
    assert.deepEqual([r!.db, r!.tenants], ['US', ['US']]);
  } finally {
    await pool.end();
  }
  assert.ok(recount.decisions! > 0 && recount.changes! > 0 && recount.floor_held! > 0, JSON.stringify(recount));
  assert.deepEqual([summary.decisions, summary.changes, summary.floorHeld, summary.heldWrites, summary.marginRefused],
    [recount.decisions, recount.changes, recount.floor_held, recount.held, recount.margin_refused]);
  /**
   * Шаг 71 нашёл: цене ниже пола маржи движок не поднимал цену до пола — итоговая проверка ОТКАЗЫВАЛА, и цена оставалась прежней.
   * Р-207 (шаг 72): стратегия встаёт на пол маржи сама — отказов ниже пола маржи нет, подъёмы есть, удержания пола маржи записаны
   */
  assert.equal(recount.margin_refused, 0, 'no price below the margin floor reaches the final check any more');
  assert.ok(recount.raised! > 0 && recount.margin_holds! > 0 && recount.above_max! > 0, JSON.stringify(recount));
  assert.ok(recount.margin_holds_repeated! > 0, `the repeated shadow polls are exercised: ${JSON.stringify(recount)}`);
  assert.equal(recount.margin_hold_mismatch, 0, 'every margin floor hold is the floor minus the target, also on a repeated shadow poll');
  // Находка 4 ревью шага 72: подъём — по товару, своим запросом: у КАЖДОГО поднимаемого товара — одобренное решение с причиной подъёма
  // до пола маржи (до Р-207 таких решений не было вовсе, а цена выше пола вслед за конкурентом подъёмом не считается)
  assert.equal(recount.raised_scopes, raisable, JSON.stringify(recount));
  assert.deepEqual([recount.live, recount.dispatched, summary.sentToAmazon, summary.portWrites], [0, 0, 0, 0], 'a shadow run sends nothing: no live decision, no dispatched write, no call to the channel model');
  await adminQuery(`DROP DATABASE ${name} WITH (FORCE)`);
  assert.deepEqual(await databases(name), [], 'the kept database is gone after the drop command');

  const html = readFileSync(output, 'utf8');
  for (const heading of ['Repricing decisions for your catalog', 'What is real and what is simulated', '15 decisions in detail', 'What we did NOT do — and why',
    'Without your unit cost', 'Rows we could not use', 'How this run differs from live pricing', 'How this run was set up']) {
    assert.ok(html.includes(heading), `section «${heading}» is in the report`);
  }
  assert.match(html, new RegExp(`<div class="value">${summary.decisions}</div><div class="label">decisions</div>`));
  assert.match(html, /<div class="value">0<\/div><div class="label">changes sent to Amazon<\/div>/);
  // Находка 2: удержания полом — свойство симуляции, с разбивкой на допущенный минимум и пол маржи; части в сумме дают целое
  const split = /the price landed on the floor (\d+) times: (\d+) times on the assumed minimum price, (\d+) times on your margin floor/.exec(html);
  assert.ok(split, 'the floor holds are broken down');
  assert.equal(Number(split[1]), summary.floorHeld);
  assert.equal(Number(split[2]) + Number(split[3]), Number(split[1]));
  assert.ok(Number(split[3]) > 0 && Number(split[3]) === summary.floorHeldMargin, 'the price landed on the margin floor from the client cost');
  assert.doesNotMatch(html, /the final price check refused it/);
  // Находка 4: что в пол не входит — названо
  assert.match(html, /does not include FBA fees, per-item minimum fees, closing fees or shipping/);
  assert.match(html, /prices are treated as US dollars excluding sales tax/);
  // Находки 1 и 3: ни «точно как в бою», ни выдуманного предела скорости
  assert.doesNotMatch(html, /exactly as (in )?live|per second|flood/i);
  // Р-207 (шаг 72): отдельный раздел — товары ниже пола маржи по СВОЕЙ себестоимости клиента: цена, себестоимость, прибыль на единицу,
  // пол и цена движка; у каждого — подъём до пола маржи
  const section = html.slice(html.indexOf('<h2>Products priced below your margin floor</h2>'), html.indexOf('decisions in detail</h2>'));
  assert.match(section, new RegExp(`<strong>${belowFloor} of your products are priced below the margin floor computed from your unit cost</strong>, an assumed Amazon referral fee of 15% and a minimum margin of 10%\\. The engine raises such a price to your margin floor`));
  assert.match(section, new RegExp(`In this run the engine would have raised ${raisable} of them to the floor \\(shadow mode: nothing was sent\\)\\.`));
  // Находка 2: пределов шага и частоты в прогоне нет — отчёт не обещает их проверку и не показывает их «пройденными»
  assert.match(section, /No limit on the size of a price step was set in this run/);
  assert.doesNotMatch(html, /Step within limit|Change frequency within limit/);
  const rows = section.split('<tr><td>').slice(1);
  assert.equal(rows.length, belowFloor);
  let losses = 0;
  for (const row of rows) {
    // Суммы со знаком: у товара с себестоимостью выше цены прибыль на единицу отрицательна
    const [price, cost, profit, floor, engine] = [...row.matchAll(/(−|-)?\$([\d,]+\.\d\d)/g)].map((x) => (x[1] ? -1 : 1) * Math.round(Number(x[2]!.replace(/,/g, '')) * 100));
    // Своя арифметика теста: прибыль = цена − 15 % − себестоимость; пол = ⌈себестоимость ÷ 0,75⌉ = ⌈себестоимость · 4 / 3⌉ (в целых)
    assert.equal(profit, price! - Math.round(price! * 0.15) - cost!, row);
    assert.equal(floor, Math.ceil((cost! * 4) / 3), row);
    assert.ok(price! < floor!, row);
    if (profit! < 0) { losses += 1; assert.match(row, /class="loss"/); }
    if (floor! <= Math.ceil((price! * 130) / 100)) {
      // Подъём до пола: цена движка — ровно пол маржи
      assert.ok(engine === floor && /would be raised to your margin floor/.test(row), row);
    } else {
      assert.match(row, /not raised<div class="muted">your margin floor is above the maximum price we assumed \(30% above your price\)/);
    }
  }
  assert.equal(losses, belowFloor - raisable, 'the products whose cost is above the price lose money on each sale at the assumed fee');
  assert.match(html, new RegExp(`<h4>We did not go above the maximum price</h4><p>${recount.above_max} decisions were refused because your margin floor is above the maximum price we assumed`));
  assert.match(html, /<div class="value">\d+<\/div><div class="label">priced below your margin floor<\/div>/);
  // Топ-15: у каждого решения «почему» словами и итог Price Gate
  const decisions = html.split('<article class="decision">').slice(1);
  assert.equal(decisions.length, 15);
  for (const d of decisions) {
    assert.match(d, /<h4>Why this price<\/h4>/);
    // Одобрено в границах — или отказ словами у товара, чей пол маржи выше допущенного максимума (себестоимость выше цены)
    assert.match(d, /approved within \$[\d,]+\.\d\d–\$[\d,]+\.\d\d|Rejected: .*cannot be computed — the minimum-margin price is above the maximum price/, 'the Price Gate step is in words');
    // Находка 7: у «Units Ordered» нет периода в названии — период назван как период файла, а не «30 дней»
    assert.match(d, /units ordered in the period of your file/);
    assert.doesNotMatch(d, /assumed cost/, 'no assumed cost without --assume-cost-pct');
  }
  assert.ok(decisions.some((d) => /Undercut the lowest price \$[\d,]+\.\d\d by \$0\.01/.test(d)), 'the strategy step is in words, with amounts');
  assert.ok(decisions.some((d) => d.includes('stopped by your margin floor') || d.includes('stopped by the assumed minimum price')), 'a decision shows the floor stopping the price');
  assert.ok(decisions.some((d) => /<div class="muted">\+\d/.test(d)), 'at least one decision raised the price');
  // Негодные строки — своей причиной и номером строки в файле клиента (заголовок — строка 1)
  assert.match(html, /<td>no price<\/td><td>1<\/td><td>297<\/td>/);
  assert.match(html, /could be read two ways/);
  assert.match(html, /another currency \(amazon\.com sells in US dollars\)/);
  assert.match(html, /“Units Ordered” as units sold/);
  assert.match(html, /Columns we ignored: “Ordered Product Sales”, “Sessions - Total”/);
  // Строки синтетического клиента без подчёркиваний — правило отчёта и свой список теста проверяют сам отчёт целиком
  assert.deepEqual(internalLeaks(html), []);
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  assert.deepEqual(INTERNAL.filter((x) => text.includes(x)), [], 'none of the internal names of the test list is in the report');
  assert.doesNotMatch(html, /<script|<link|<img|https?:\/\//i, 'the report is one self-contained file');
  assert.match(html, /temporary database of this run was kept on our machine/, 'with --keep the report does not claim the database was deleted');
});

test('step 71: a run deletes its database, and the next run deletes temporary databases older than a day — but not a fresh one', async () => {
  const stale = `killtest_${(Date.now() - 25 * 3_600_000).toString(36)}_deadbeef`;
  const fresh = `killtest_${(Date.now() - 3_600_000).toString(36)}_cafebabe`;
  await adminQuery(`CREATE DATABASE ${stale} TEMPLATE template0`);
  await adminQuery(`CREATE DATABASE ${fresh} TEMPLATE template0`);
  try {
    const input = join(dir, 'small.csv');
    writeFileSync(input, syntheticCatalog('simple', 20));
    const r = run(['--in', input, '--out', join(dir, 'small.report.html'), '--hours', '1']);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    assert.match(r.stderr, /deleted \d+ temporary databases of earlier runs older than a day/);
    const left = await databases();
    assert.equal(left.includes(stale), false, 'a database older than a day is deleted');
    assert.equal(left.includes(fresh), true, 'a database of a run younger than a day is left alone');
    assert.equal(left.includes(String(summaryOf(r.stdout).database)), false, 'the run deleted its own database');
    assert.match(readFileSync(join(dir, 'small.report.html'), 'utf8'), /temporary database that was deleted when the report was written/);
  } finally {
    await adminQuery(`DROP DATABASE IF EXISTS ${stale} WITH (FORCE)`);
    await adminQuery(`DROP DATABASE IF EXISTS ${fresh} WITH (FORCE)`);
  }
});

test('step 71: an interrupted run deletes its database (it holds the client catalog) and writes no report', async () => {
  const input = join(dir, 'interrupted.csv');
  const output = join(dir, 'interrupted.report.html');
  writeFileSync(input, syntheticCatalog('simple', 60));
  const child = spawn(join(repo, 'scripts', 'killtest'), ['--in', input, '--out', output, '--hours', '72'], { cwd: repo, env: process.env });
  let stderr = '';
  let name: string | null = null;
  const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
  await new Promise<void>((seeded, failed) => {
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      name ??= /temporary database (killtest_\w+)/.exec(stderr)?.[1] ?? null;
      if (/world seeded/.test(stderr)) seeded();
    });
    void exited.then(() => failed(new Error(`killtest ended before seeding: ${stderr.slice(-2000)}`)));
  });
  assert.ok(name, 'the run names its temporary database');
  assert.deepEqual(await databases(name!), [name], 'the database exists while the run goes');
  child.kill('SIGTERM');
  assert.equal(await exited, 143, stderr.slice(-2000));
  assert.match(stderr, /SIGTERM: deleting the temporary database/);
  assert.deepEqual(await databases(name!), [], 'the interrupted run left no database');
  assert.equal(existsSync(output), false, 'no report from an interrupted run');
});

test('step 72: an unknown option or an option without its value is refused before anything is read — a typo does not change the run silently', () => {
  const sample = join(dir, 'options.csv');
  writeFileSync(sample, syntheticCatalog('simple', 20));
  const typo = run(['--in', sample, '--out', join(dir, 'options.report.html'), '--assume-cost', '50']);
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown option --assume-cost; did you mean --assume-cost-pct\?/);
  const bare = run(['--in', sample, '--hours']);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /--hours needs a value/);
  const twice = run(['--in', sample, '--in', sample]);
  assert.match(twice.stderr, /--in is given twice/);
  assert.equal(existsSync(join(dir, 'options.report.html')), false, 'nothing was written');
});

test('step 71: a client file or a report inside the repository is refused — also through a link or in another letter case; git-ignored places are accepted', () => {
  const sample = join(dir, 'sample.csv');
  writeFileSync(sample, syntheticCatalog('simple', 20));
  const inside = join(repo, 'tests', 'contract', 'killtest-report-should-not-exist.html');
  const refused = run(['--in', sample, '--out', inside, '--hours', '1']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /inside the repository and not ignored by git: put client files and reports into \.killtest\/ or outside the repository/);
  assert.equal(existsSync(inside), false, 'nothing was written');
  const refusedInput = run(['--in', join(repo, 'tests', 'contract', 'package.json'), '--out', join(dir, 'x.html')]);
  assert.equal(refusedInput.status, 2);
  assert.match(refusedInput.stderr, /package\.json is inside the repository and not ignored by git/);
  // Находка 11: ссылка снаружи репозитория внутрь него — путь внутри по настоящему пути, а не по тексту
  const link = join(dir, 'link-into-repo');
  symlinkSync(join(repo, 'tests', 'contract'), link);
  assert.match(privacyProblem(join(link, 'report.html')) ?? '', /not ignored by git/, 'a report through a link into the repository');
  assert.match(privacyProblem(join(link, 'new', 'dir', 'report.html')) ?? '', /not ignored by git/, 'a report in directories not yet created behind the link');
  const fileLink = join(dir, 'client.csv');
  symlinkSync(join(repo, 'tests', 'contract', 'package.json'), fileLink);
  assert.match(privacyProblem(fileLink) ?? '', /not ignored by git/, 'a client file that is a link into the repository');
  if (process.platform === 'darwin') {
    assert.match(privacyProblem(join(repo, 'tests', 'contract', 'r.html').toUpperCase()) ?? '', /not ignored by git/, 'another letter case on a case-insensitive file system');
  }
  // Положительные контроли: игнорируемый git каталог и место вне репозитория — принимаются
  assert.equal(privacyProblem(join(repo, '.killtest', 'client', 'report.html')), null);
  assert.equal(privacyProblem(join(dir, 'report.html')), null);
});

test('step 71: the leak check reads a render with every client string replaced — a client header cannot hide our internal name (positive controls)', () => {
  const clean = '<p>Price $12.99 approved within $10.00–$20.00.</p>';
  assert.deepEqual(internalLeaks(clean), []);
  const cases: Array<[string, RegExp]> = [
    ['<p>decision 3c875137-0ebc-4e68-ae55-66fe3ea81821</p>', /^uuid/],
    ['<p>strategy BEAT_LOWEST</p>', /^UPPER_SNAKE code/],
    ['<p>below min_price</p>', /^lower_snake name/],
    ['<p>see Р-205</p>', /^decision or question number/],
    ['<p>rule set r49.1</p>', /^ruleset or profile version/],
    ['<p>storefront ATVPDKIKX0DER</p>', /^storefront id/],
    ['<p>offer B0KT000012</p>', /^synthetic world id/],
    ['<script src="x.js"></script>', /^external resource/],
  ];
  for (const [html, kind] of cases) assert.ok(internalLeaks(html).some((l) => kind.test(l)), `${html} → ${JSON.stringify(internalLeaks(html))}`);
  // Прежняя проверка вычитала строки клиента из текста: заголовок клиента «price» превращал «min_price» в «min_» и прятал утечку.
  // Теперь строки клиента — заглушка в отрисовке, а наш текст остаётся целиком
  const d = minimalReport({ header: 'price', ourText: 'held by min_price' });
  assert.ok(internalLeaks(renderForLeakCheck(d)).some((l) => l.startsWith('lower_snake name: min_price')), 'our min_price is found next to a client header «price»');
  // А строка клиента с подчёркиванием (его заголовок «sales_30d», его SKU «MY_SKU_1») — не наша и утечкой не считается
  assert.deepEqual(internalLeaks(renderForLeakCheck(minimalReport({ header: 'sales_30d', sku: 'MY_SKU_1', ourText: 'held by the floor' }))), []);
});

function minimalReport(x: { header: string; ourText: string; sku?: string }): ReportData {
  const sku = x.sku ?? 'SYN-1';
  return {
    generatedAt: 'Oct 6, 2026', fileName: 'client_file.csv', format: 'comma-separated text', hours: 1, options: DEFAULT_OPTIONS, salesHeader: x.header,
    counts: { rows: 1, rejectedRows: 0, inRun: 1, inEngine: 1, withFileCost: 1, assumedCost: 0, noCost: 0, skippedByLimit: 0, decisions: 1, assumedCostDecisions: 0,
      changes: 1, floorHeld: 1, floorHeldAssumedMin: 0, floorHeldMargin: 1, marginRefused: 0, ceilingHeld: 0, raisedToFloor: 1, heldWrites: 1, competitorUpdates: 1, sentToAmazon: 0, dbDispatched: 0, portWrites: 0 },
    savings: null,
    belowFloor: [{ label: `${sku}_title`, sku, sales: 1, priceMinor: 1000, costMinor: 800, profitMinor: 50, floorMinor: 1067, status: 'RAISED', engineMinor: 1067, refused: null }],
    top: [{ label: `${sku}_title`, sku, sales: 1, currentMinor: 1000, decidedMinor: 900, floorMinor: 900, ceilingMinor: 1300, floorKind: 'MARGIN', atFloor: true, refused: false,
      costSource: 'FILE', when: 'Oct 6, 2026', why: ['Undercut the lowest price $9.00 by $0.01'], checks: ['Floor'] }],
    notDone: [{ title: 'The price never went below the floor', text: x.ourText }],
    noCostExamples: [], rejected: [{ text: 'the currency column is not US dollars', lines: [2], values: [`${sku}_EUR`] }], notes: [],
    columns: { recognized: [{ header: x.header, meaning: 'units sold' }], ignored: [`${x.header}_extra`], duplicates: [] },
    databaseKept: false,
  };
}
