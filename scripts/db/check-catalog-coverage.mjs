#!/usr/bin/env node
// Р-108: каждая НОВАЯ защита схемы попадает в каталог мутаций при создании. Защита — триггер (не внутренний) или CHECK-ограничение
// родительской таблицы схем приложения. Защита «в каталоге», если её имя стоит в кавычках в tests/db/mutations.mjs или (для триггера)
// функция триггера мутируется заменой текста. Защиты, не покрытые на момент шага 19, перечислены в базовом списке
// tests/db/uncatalogued-baseline.txt (принятый риск 13, каталог задним числом не расширяется); всё прочее без строки каталога —
// красная сборка. Метод тот же, что у docs/evidence/step19-uncatalogued-protections.txt.
//   PGHOST=… PGUSER=<суперпользователь> node scripts/db/check-catalog-coverage.mjs [база, по умолчанию REPRACER_PG_TEMPLATE или repracer_template]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SCHEMAS = ['security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal'];

/** Строка защиты: «trigger <таблица> <имя>» или «check <таблица> <имя>» */
export const protectionLine = (p) => `${p.kind} ${p.table} ${p.name}`;

/** Защиты вне каталога и вне базового списка; обратный список — строки базы, которых в схеме больше нет или которые уже в каталоге */
export function coverage({ protections, catalogText, baseline }) {
  const base = new Set(baseline);
  const catalogued = (p) => catalogText.includes(`'${p.name}'`) || (p.kind === 'trigger' && p.fn && catalogText.includes(`${p.fn}(`));
  const missing = protections.filter((p) => !catalogued(p) && !base.has(protectionLine(p))).map(protectionLine).sort();
  const present = new Set(protections.filter((p) => !catalogued(p)).map(protectionLine));
  const resolved = [...base].filter((l) => !present.has(l)).sort();
  return { missing, resolved };
}

export function readProtections(database) {
  const sql = `
    SELECT 'trigger', c.oid::regclass::text, t.tgname, p.oid::regproc::text
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND NOT c.relispartition AND n.nspname = ANY ('{${SCHEMAS.join(',')}}')
    UNION ALL
    SELECT 'check', c.oid::regclass::text, k.conname, ''
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.contype = 'c' AND NOT c.relispartition AND n.nspname = ANY ('{${SCHEMAS.join(',')}}')`;
  const out = execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-X', '-At', '-F', '\t', '-d', database, '-c', sql], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).map((l) => {
    const [kind, table, name, fn] = l.split('\t');
    return { kind, table, name, fn: fn || null };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const database = process.argv[2] ?? process.env.REPRACER_PG_TEMPLATE ?? 'repracer_template';
  const baseline = readFileSync(`${root}tests/db/uncatalogued-baseline.txt`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const { missing, resolved } = coverage({ protections: readProtections(database), catalogText: readFileSync(`${root}tests/db/mutations.mjs`, 'utf8'), baseline });
  if (resolved.length > 0) console.log(`baseline entries no longer uncatalogued (covered or removed): ${resolved.length}\n  ${resolved.join('\n  ')}`);
  if (missing.length > 0) {
    console.error(`CATALOG COVERAGE RED (Р-108): ${missing.length} protection(s) created without a row in tests/db/mutations.mjs:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`catalog coverage: every protection outside the step 19 baseline (${baseline.length}) has a catalog row (Р-108)`);
}
