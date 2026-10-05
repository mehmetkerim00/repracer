import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CatalogError, readCatalog } from './catalog.ts';
import { ACCEPTED_COLUMNS_TEXT, collectReport, internalLeaks, renderReport } from './report.ts';
import { syntheticCatalog, type SyntheticVariant } from './synthetic.ts';
import { buildKilltestWorld, DEFAULT_OPTIONS, type KilltestOptions } from './world.ts';

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
  --keep                keep the temporary database for inspection

Client files and reports stay out of the repository: inside it, only the git-ignored .killtest/ directory is accepted.
Columns we understand:
${ACCEPTED_COLUMNS_TEXT}`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Внутри репозитория — только игнорируемый git путь; снаружи — любой */
export function privacyProblem(path: string): string | null {
  const full = resolve(path);
  if (full !== repoRoot && !full.startsWith(repoRoot + sep)) return null;
  try {
    execFileSync('git', ['check-ignore', '-q', full], { cwd: repoRoot, stdio: 'ignore' });
    return null;
  } catch {
    return `${path} is inside the repository and not ignored by git: put client files and reports into .killtest/ or outside the repository`;
  }
}

function args(argv: string[]): Map<string, string | true> {
  const out = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.set(a.slice(2), true);
    else { out.set(a.slice(2), next); i++; }
  }
  return out;
}

const number = (a: Map<string, string | true>, name: string, fallback: number, min: number, max: number): number => {
  const v = a.get(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (typeof v !== 'string' || !Number.isFinite(n) || n < min || n > max) throw new Error(`--${name} must be a number from ${min} to ${max}`);
  return n;
};

export async function main(argv: string[]): Promise<number> {
  const log = (line: string) => process.stderr.write(`killtest: ${line}\n`);
  let a: Map<string, string | true>;
  try { a = args(argv); } catch (e) { log((e as Error).message); process.stderr.write(`${USAGE}\n`); return 2; }
  if (a.has('help') || a.size === 0) { process.stdout.write(`${USAGE}\n`); return a.has('help') ? 0 : 2; }
  const out = a.get('out');
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
    };
  } catch (e) { log((e as Error).message); return 2; }
  let catalog;
  try {
    catalog = readCatalog(readFileSync(input), basename(input));
  } catch (e) {
    if (e instanceof CatalogError) { log(`${e.message}`); return 2; }
    throw e;
  }
  log(`catalog: ${catalog.rows.length} usable rows, ${catalog.rejected.length} rows not usable, ${catalog.recognized.length} columns read, ${catalog.ignored.length} ignored`);
  const started = Date.now();
  const world = await buildKilltestWorld(catalog, options, log);
  let html: string;
  let data;
  try {
    data = await collectReport(catalog, world, options, a.has('keep'));
    html = renderReport(data);
  } finally {
    await world.close(a.has('keep'));
  }
  const leaks = internalLeaks(html, data.clientStrings);
  if (leaks.length > 0) { log(`the report would show internal codes and was not written: ${leaks.join('; ')}`); return 3; }
  mkdirSync(dirname(resolve(report)), { recursive: true });
  writeFileSync(report, html);
  const c = data.counts;
  process.stdout.write(`${JSON.stringify({ report: basename(report), seconds: Math.round((Date.now() - started) / 100) / 10, products: c.rows, priced: c.inEngine, decisions: c.decisions,
    changes: c.changes, floorHeld: c.floorHeld, noCost: c.noCost, rejectedRows: c.rejectedRows, sentToAmazon: c.sentToAmazon, top: data.top.length })}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`killtest: failed: ${(error as Error)?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
