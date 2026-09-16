#!/usr/bin/env node
// Р-108: каждая НОВАЯ защита схемы попадает в каталог мутаций при создании. Защита — триггер (не внутренний) или CHECK-ограничение
// родительской таблицы схем приложения. Защита «в каталоге», если её имя стоит в кавычках в tests/db/mutations.mjs или (для триггера)
// функция триггера мутируется заменой текста. Защиты, не покрытые на момент шага 19, перечислены в базовом списке
// tests/db/uncatalogued-baseline.txt (принятый риск 13, каталог задним числом не расширяется); всё прочее без строки каталога —
// красная сборка. Метод тот же, что у docs/evidence/step19-uncatalogued-protections.txt.
//   PGHOST=… PGUSER=<суперпользователь> node scripts/db/check-catalog-coverage.mjs [база, по умолчанию REPRACER_PG_TEMPLATE или repracer_template]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** SHA-256 базового списка на конец шага 19 (725 защит: 238 триггеров, 487 CHECK) */
export const BASELINE_SHA256 = 'bb3befd49c081ba57f34c1b5acf8b3d227f4a1ca70202e151f26af5f160e810e';

export const SCHEMAS = ['security', 'platform', 'tenant_data', 'channel_data', 'audit', 'maintenance', 'legal'];

/** Строка защиты: «trigger <таблица> <имя>» или «check <таблица> <имя>» */
export const protectionLine = (p) => `${p.kind} ${p.table} ${p.name}`;

/**
 * Защиты вне каталога и вне базового списка; обратный список — строки базы, которых в схеме больше нет или которые уже в каталоге.
 * Ревью шага 20 (находка 6): защита засчитывается строкой каталога, только если в ней стоят вместе имя защиты И её таблица
 * (`dropTrigger('имя', 'таблица')`, `dropConstraint('имя', 'таблица')`) — одноимённые обобщённые триггеры других таблиц
 * (`zz_append_only`, `a0_admin_write_person_insert`) новую таблицу не покрывают. Мутация тела функции триггера засчитывается, только
 * если функция принадлежит одному-единственному триггеру: мутация общей функции (страж и аудит административной записи,
 * неизменяемость) проверяется своими проверками на одной таблице и о других таблицах ничего не говорит.
 */
export function coverage({ protections, catalogText, baseline }) {
  const base = new Set(baseline);
  const triggersOfFn = new Map();
  for (const p of protections) if (p.kind === 'trigger' && p.fn) triggersOfFn.set(p.fn, (triggersOfFn.get(p.fn) ?? 0) + 1);
  const catalogued = (p) => catalogText.includes(`'${p.name}', '${p.table}'`)
    || (p.kind === 'trigger' && p.fn && triggersOfFn.get(p.fn) === 1 && catalogText.includes(`'${p.fn}(`));
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
  const baselineText = readFileSync(`${root}tests/db/uncatalogued-baseline.txt`, 'utf8');
  // Р-108: базовый список не растёт — его содержимое закреплено контрольной суммой; правка списка видна в изменении этого файла
  const sum = createHash('sha256').update(baselineText).digest('hex');
  if (sum !== BASELINE_SHA256) {
    console.error(`CATALOG COVERAGE RED (Р-108): tests/db/uncatalogued-baseline.txt changed (sha256 ${sum}); the baseline of step 19 does not grow`);
    process.exit(1);
  }
  const baseline = baselineText.split('\n').filter((l) => l && !l.startsWith('#'));
  const { missing, resolved } = coverage({ protections: readProtections(database), catalogText: readFileSync(`${root}tests/db/mutations.mjs`, 'utf8'), baseline });
  if (resolved.length > 0) console.log(`baseline entries no longer uncatalogued (covered or removed): ${resolved.length}\n  ${resolved.join('\n  ')}`);
  if (missing.length > 0) {
    console.error(`CATALOG COVERAGE RED (Р-108): ${missing.length} protection(s) created without a row in tests/db/mutations.mjs:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`catalog coverage: every protection outside the step 19 baseline (${baseline.length}) has a catalog row (Р-108)`);
}
