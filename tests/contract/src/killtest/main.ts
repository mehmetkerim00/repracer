import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError, readCatalog } from './catalog.ts';
import type { IsolatedDatabase } from '../../../../packages/pricing-store-pg/test/isolated-db.ts';
import { ACCEPTED_COLUMNS_TEXT, collectReport, internalLeaks, renderForLeakCheck, renderReport } from './report.ts';
import { syntheticCatalog, type SyntheticVariant } from './synthetic.ts';
import { buildKilltestWorld, DEFAULT_OPTIONS, dropStaleKilltestDatabases, type KilltestOptions } from './world.ts';

/**
 * Шаг 71: команда kill-test — `scripts/killtest --in <файл клиента> [--out <отчёт.html>]`. Файл клиента и отчёт в репозиторий не
 * попадают: путь внутри репозитория принимается только в каталоге, который игнорирует git (`.killtest/`), иначе отказ до чтения файла.
 * В журнал команды — только числа, ни SKU, ни названий, ни цен клиента.
 */

const USAGE = `Usage:
  scripts/killtest --in <catalog.csv|.txt|.xlsx> [--out <report.html>] [options]
  scripts/killtest --make-sample simple|listings|business --out <file> [--rows 300]

Options (defaults in brackets):
  --hours N             simulated hours of shadow pricing [${DEFAULT_OPTIONS.hours}]
  --every-minutes N     a competitor changes its price every N minutes [${DEFAULT_OPTIONS.competitorEveryMinutes}]
  --min-pct N           assumed minimum price: N% below the current price [${DEFAULT_OPTIONS.minPct}]
  --max-pct N           assumed maximum price: N% above the current price [${DEFAULT_OPTIONS.maxPct}]
  --margin-pct N        minimum margin above cost + fee [${DEFAULT_OPTIONS.marginPct}]
  --fee-pct N           Amazon referral fee [${DEFAULT_OPTIONS.feePct}]
  --assume-cost-pct N   run products without cost with an assumed cost of N% of the price (named in the report) [off]
  --max-products N      run at most N best-selling products [${DEFAULT_OPTIONS.maxProducts}]
  --step-pct N          a price changes by at most N% at a time; a larger raise to the floor goes step by step [no limit]
  --keep                keep the temporary database for inspection (its name and the command to delete it are printed;
                        temporary databases older than a day are deleted by the next run)

Client files and reports stay out of the repository: a path inside it is accepted only if git ignores it, such as .killtest/.
Columns we understand:
${ACCEPTED_COLUMNS_TEXT}`;

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../..'));

/**
 * Настоящий путь: ссылка ведёт туда, куда ведёт, а несуществующий хвост (файл отчёта, ещё не созданные каталоги) приставляется к
 * настоящему пути ближайшего существующего предка. Ревью шага 71, находка 11: сравнение ТЕКСТА пути пропускало ссылку снаружи
 * репозитория внутрь него и другой регистр букв на нечувствительной к регистру файловой системе macOS
 */
export function realPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

/** Внутри репозитория — только игнорируемый git путь; снаружи — любой */
export function privacyProblem(path: string): string | null {
  const full = realPath(path);
  const fold = (p: string) => (process.platform === 'darwin' || process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(full) !== fold(repoRoot) && !fold(full).startsWith(fold(repoRoot) + sep)) return null;
  const inside = full.slice(repoRoot.length + 1);
  try {
    if (inside === '') throw new Error('the repository root itself');
    execFileSync('git', ['check-ignore', '-q', '--', inside], { cwd: repoRoot, stdio: 'ignore' });
    return null;
  } catch {
    return `${path} is inside the repository and not ignored by git: put client files and reports into .killtest/ or outside the repository`;
  }
}

/**
 * Ключи команды. Шаг 72 (ревью шага 71, находка 22): неизвестный ключ — отказ, а не тишина: опечатка `--assume-cost` вместо
 * `--assume-cost-pct` молча оставляла товары без себестоимости вне движка, и клиент получал отчёт не о том, что просили
 */
const VALUE_OPTIONS = ['in', 'out', 'hours', 'every-minutes', 'min-pct', 'max-pct', 'margin-pct', 'fee-pct', 'assume-cost-pct', 'max-products', 'step-pct', 'make-sample', 'rows'] as const;
const FLAG_OPTIONS = ['keep', 'help'] as const;

export function args(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  const known = [...VALUE_OPTIONS, ...FLAG_OPTIONS] as readonly string[];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const name = a.slice(2);
    if (!known.includes(name)) {
      const near = known.filter((k) => k.startsWith(name) || name.startsWith(k));
      throw new Error(`unknown option --${name}${near.length > 0 ? `; did you mean ${near.map((k) => `--${k}`).join(' or ')}?` : ''}`);
    }
    if (out.has(name)) throw new Error(`--${name} is given twice`);
    const next = argv[i + 1];
    if ((FLAG_OPTIONS as readonly string[]).includes(name)) { out.set(name, true); continue; }
    if (next === undefined || next.startsWith('--')) throw new Error(`--${name} needs a value`);
    out.set(name, next);
    i++;
  }
  return out;
}

const number = (a: Map<string, string | true>, name: string, fallback: number, min: number, max: number): number => {
  const v = a.get(name);
  if (v === undefined) return fallback;
  // Шаг 75 (ревью шага 72, находка 8): число — только десятичная запись; `Number('')` — 0, `Number('0x10')` — 16, и опечатка проходила
  const n = typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}`);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  const log = (line: string) => process.stderr.write(`killtest: ${line}\n`);
  let a: Map<string, string | true>;
  try { a = args(argv); } catch (e) { log((e as Error).message); process.stderr.write(`${USAGE}\n`); return 2; }
  if (a.has('help') || a.size === 0) { process.stdout.write(`${USAGE}\n`); return a.has('help') ? 0 : 2; }
  const out = a.get('out');
  // Шаг 75 (ревью шага 72, находка 8): ключ, неприменимый к режиму, — отказ, а не тишина
  const notForSample = [...a.keys()].filter((k) => !['make-sample', 'out', 'rows'].includes(k));
  if (a.has('make-sample') && notForSample.length > 0) { log(`${notForSample.map((k) => `--${k}`).join(', ')} does not apply to --make-sample`); return 2; }
  if (!a.has('make-sample') && a.has('rows')) { log('--rows applies only to --make-sample'); return 2; }
  if (a.has('make-sample')) {
    const variant = a.get('make-sample') as SyntheticVariant;
    if (!['simple', 'listings', 'business'].includes(variant) || typeof out !== 'string') { process.stderr.write(`${USAGE}\n`); return 2; }
    writeFileSync(out, syntheticCatalog(variant, number(a, 'rows', 300, 10, 20_000)));
    log(`synthetic ${variant} catalog written`);
    return 0;
  }
  const input = a.get('in');
  if (typeof input !== 'string') { process.stderr.write(`${USAGE}\n`); return 2; }
  const report = typeof out === 'string' ? out : join(dirname(input), `${basename(input, extname(input))}.report.html`);
  // Шаг 75 (ревью шага 71, находка 22): отчёт поверх файла клиента затёр бы его
  if (resolve(report) === resolve(input)) { log('--out is the client file itself: the report would overwrite it'); return 2; }
  for (const p of [input, report]) {
    const problem = privacyProblem(p);
    if (problem) { log(problem); return 2; }
  }
  let options: KilltestOptions;
  try {
    options = {
      hours: number(a, 'hours', DEFAULT_OPTIONS.hours, 1, 72), competitorEveryMinutes: number(a, 'every-minutes', DEFAULT_OPTIONS.competitorEveryMinutes, 15, 720),
      minPct: number(a, 'min-pct', DEFAULT_OPTIONS.minPct, 1, 90), maxPct: number(a, 'max-pct', DEFAULT_OPTIONS.maxPct, 1, 500),
      marginPct: number(a, 'margin-pct', DEFAULT_OPTIONS.marginPct, 0, 90), feePct: number(a, 'fee-pct', DEFAULT_OPTIONS.feePct, 0, 60),
      assumeCostPct: a.has('assume-cost-pct') ? number(a, 'assume-cost-pct', 0, 1, 99) : null, maxProducts: number(a, 'max-products', DEFAULT_OPTIONS.maxProducts, 1, 20_000),
      stepPct: a.has('step-pct') ? number(a, 'step-pct', 0, 1, 90) : null,
    };
    // Шаг 75 (ревью шага 71, находка 22): комиссия и маржа вместе от 100 % — пол маржи невычислим, прогон был бы отказом каждой цены
    if (options.feePct + options.marginPct >= 100) throw new Error('--fee-pct and --margin-pct together must stay below 100');
  } catch (e) { log((e as Error).message); return 2; }
  let catalog;
  try {
    catalog = readCatalog(readFileSync(input), basename(input));
  } catch (e) {
    if (e instanceof CatalogError) { log(`${e.message}`); return 2; }
    throw e;
  }
  log(`catalog: ${catalog.rows.length} usable rows, ${catalog.rejected.length} rows not usable, ${catalog.recognized.length} columns read, ${catalog.ignored.length} ignored`);
  const keep = a.has('keep');
  const stale = await dropStaleKilltestDatabases();
  if (stale.length > 0) log(`deleted ${stale.length} temporary databases of earlier runs older than a day`);
  const started = Date.now();
  // Ревью шага 71, находка 10: прерванный прогон удаляет свою базу (в ней каталог клиента) — и с --keep: недоделанную базу не держим
  let active: IsolatedDatabase | null = null;
  const interrupted = (signal: NodeJS.Signals) => {
    log(`${signal}: deleting the temporary database`);
    const done = () => process.exit(signal === 'SIGINT' ? 130 : 143);
    if (active) active.drop().then(done, done); else done();
  };
  process.once('SIGINT', interrupted);
  process.once('SIGTERM', interrupted);
  try {
    const world = await buildKilltestWorld(catalog, options, log, { onDatabase: (db) => { active = db; } });
    let data;
    try {
      data = await collectReport(catalog, world, options, keep);
    } finally {
      await world.close(keep);
      active = null;
    }
    if (keep) log(`database kept: ${world.db.name}; delete it with: psql "$REPRACER_PG_ADMIN_URL" -c 'DROP DATABASE ${world.db.name} WITH (FORCE)'`);
    const c = data.counts;
    // Ревью шага 71, находка 1: отчёт тени утверждает «ничего не отправлено» — отправленное хоть раз значит, что отчёт лжёт
    if (c.sentToAmazon > 0) { log(`${c.dbDispatched} writes were dispatched and the channel model received ${c.portWrites}: a shadow run must send nothing, the report was not written`); return 4; }
    const leaks = internalLeaks(renderForLeakCheck(data));
    if (leaks.length > 0) { log(`the report would show internal codes and was not written: ${leaks.join('; ')}`); return 3; }
    mkdirSync(dirname(resolve(report)), { recursive: true });
    writeFileSync(report, renderReport(data));
    process.stdout.write(`${JSON.stringify({ report: basename(report), seconds: Math.round((Date.now() - started) / 100) / 10, products: c.rows, priced: c.inEngine, decisions: c.decisions,
      changes: c.changes, floorHeld: c.floorHeld, floorHeldMargin: c.floorHeldMargin, marginRefused: c.marginRefused, noCost: c.noCost, assumedCost: c.assumedCost, rejectedRows: c.rejectedRows,
      belowFloor: data.belowFloor.length, raisedToFloor: c.raisedToFloor, ladders: c.ladders, heldWrites: c.heldWrites, sentToAmazon: c.sentToAmazon, portWrites: c.portWrites, top: data.top.length,
      database: world.db.name, databaseKept: keep })}\n`);
    return 0;
  } finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`killtest: failed: ${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
