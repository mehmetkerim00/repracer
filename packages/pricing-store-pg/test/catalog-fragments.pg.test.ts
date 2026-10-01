import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createPool, type PgPool } from '../src/index.ts';
import { createIsolatedDatabase, requireEnv, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 65 (ревью шага, находка 2) [Р-146]: строка каталога мутаций, чей предмет исчез из схемы, роняет ПОЛНЫЙ прогон мутаций целиком —
 * раннер бросает «mutation text not found» вне проверки, без отчёта. Шаг 65 переписал функцию каталога, и фрагмент строки шага 47 перестал
 * в ней встречаться: это было бы видно только в полном прогоне CI. Здесь — на каждом коммите: каждый фрагмент `replaceInFunction`
 * находится в теле своей функции, каждое снимаемое ограничение и каждый снимаемый триггер существуют. Мутации не применяются.
 */
interface Mutation { apply: string | { fn: string; from: string; to: string } }
interface Row { row: string; mutations: Mutation[] }

let db: IsolatedDatabase;
let admin: PgPool;
let rows: Row[] = [];

before(async () => {
  db = await createIsolatedDatabase('fragments');
  const url = new URL(requireEnv('REPRACER_PG_ADMIN_URL')); url.pathname = `/${db.name}`;
  admin = createPool(url.toString(), { max: 1, applicationName: 'repracer-catalog-fragments' });
  const catalog = await import(pathToFileURL(join(import.meta.dirname, '..', '..', '..', 'tests', 'db', 'mutations.mjs')).href) as Record<string, unknown>;
  rows = Object.entries(catalog).filter(([name, v]) => name.endsWith('_ROWS') && Array.isArray(v)).flatMap(([, v]) => v as Row[]);
});

after(async () => {
  await admin?.end();
  await db?.drop();
});

/** Чего нет в схеме из того, что строка каталога снимает или правит */
async function missing(subjects: Array<{ row: string; apply: Mutation['apply'] }>): Promise<string[]> {
  const out: string[] = [];
  for (const { row, apply } of subjects) {
    if (typeof apply === 'object') {
      const { rows: [r] } = await admin.query(`SELECT pg_get_functiondef(to_regprocedure($1)) AS def`, [apply.fn]);
      const def = (r as { def: string | null }).def;
      if (def === null) out.push(`${row}: function ${apply.fn} does not exist`);
      else if (!def.includes(apply.from)) out.push(`${row}: «${apply.from.slice(0, 80)}» is not in ${apply.fn}`);
      continue;
    }
    const constraint = /^ALTER TABLE (\S+) DROP CONSTRAINT (\S+)$/.exec(apply);
    if (constraint) {
      const { rows: [r] } = await admin.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2`, [constraint[1], constraint[2]]);
      if ((r as { n: number }).n === 0) out.push(`${row}: constraint ${constraint[2]} on ${constraint[1]} does not exist`);
      continue;
    }
    const trigger = /^DROP TRIGGER (\S+) ON (\S+)$/.exec(apply);
    if (trigger) {
      const { rows: [r] } = await admin.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass($1) AND tgname = $2`, [trigger[2], trigger[1]]);
      if ((r as { n: number }).n === 0) out.push(`${row}: trigger ${trigger[1]} on ${trigger[2]} does not exist`);
    }
  }
  return out;
}

test('шаг 65: каждый предмет строк каталога мутаций есть в схеме — фрагменты функций, ограничения, триггеры', async () => {
  const subjects = rows.flatMap((r) => r.mutations.map((m) => ({ row: r.row, apply: m.apply })));
  assert.ok(subjects.filter((s) => typeof s.apply === 'object').length > 100, `каталог прочитан: ${subjects.length} мутаций`);
  // Положительные контроли: выдуманный фрагмент, ограничение и триггер правило обязано назвать
  const controls = await missing([
    { row: 'control', apply: { fn: 'tenant_data.record_discovered_offers(uuid, uuid, jsonb)', from: 'this text is not in the function', to: '' } },
    { row: 'control', apply: 'ALTER TABLE tenant_data.offer_mapping DROP CONSTRAINT no_such_constraint' },
    { row: 'control', apply: 'DROP TRIGGER no_such_trigger ON tenant_data.offer_mapping' },
  ]);
  assert.equal(controls.length, 3, `правило видит пропажу каждого вида: ${JSON.stringify(controls)}`);
  assert.deepEqual(await missing(subjects), [], 'предметы строк каталога, которых в схеме больше нет');
});
