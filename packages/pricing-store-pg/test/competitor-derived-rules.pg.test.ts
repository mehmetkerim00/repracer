import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { COMPETITOR_DERIVED_RULES, RULE_CODES, STRATEGY_TYPES } from '@repracer/pricing-model';
import { createPool } from '../src/index.ts';
import { requireEnv } from './isolated-db.ts';

/**
 * Шаг 97, правило-страж (решение владельца): правило «цена из данных конкурентов» живёт в коде одним списком (`COMPETITOR_DERIVED_RULES`)
 * и в базе — генерируемыми столбцами намерения и вечного ядра и списком стратегий снятия остановки выборкой. Разойдись они — остановка
 * витрины держала бы по коду одно, а по базе другое [Р-51], а вечное ядро хранило бы производные от цены конкурента [Р-85]. Сравнивается
 * ПОВЕДЕНИЕ: выражение каждого столбца вычисляется на каждом коде правила, а не сравнивается текстом. Красное при любом расхождении.
 */

const url = requireEnv('REPRACER_PG_URL');
const pool = createPool(url, { max: 1, applicationName: 'repracer-competitor-derived-rules' });
after(async () => { await pool.end(); });

// Правила без стратегии: подъём к полу из данных продавца (FLOOR_RAISE_RULE движка) и ручная цена; плюс выдуманный код — ответ «нет»
const CANDIDATES = [...new Set([...RULE_CODES, ...STRATEGY_TYPES, 'FLOOR_RAISE', 'MANUAL', 'SYN_UNKNOWN_RULE'])].sort();

async function expression(table: string): Promise<string> {
  const { rows: [r] } = await pool.query(
    `SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1::regclass AND a.attname = 'competitor_derived' AND a.attgenerated = 's'`, [table]);
  assert.ok(r?.e, `${table}.competitor_derived is a generated column`);
  return r.e as string;
}

/** Расхождения выражения базы со списком кода: коды, на которых ответы разные */
async function mismatches(expr: string): Promise<string[]> {
  const out: string[] = [];
  for (const code of CANDIDATES) {
    const { rows: [r] } = await pool.query(`SELECT ${expr} AS v FROM (SELECT $1::text AS rule_code) x`, [code]);
    if (r.v !== COMPETITOR_DERIVED_RULES.has(code)) out.push(`${code}: database ${r.v}, code ${COMPETITOR_DERIVED_RULES.has(code)}`);
  }
  return out;
}

test('step 97: the competitor-derived rule list of the code equals the database — intent, eternal core and halt review', async () => {
  for (const table of ['channel_data.price_intent', 'tenant_data.price_intent_core']) {
    assert.deepEqual(await mismatches(await expression(table)), [], `${table}.competitor_derived agrees with COMPETITOR_DERIVED_RULES`);
  }
  // Снятие остановки витрины выборкой [Р-52] смотрит предложения со стратегией из данных конкурентов: список типов стратегий в функции
  const { rows: [f] } = await pool.query(`SELECT pg_get_functiondef('channel_data.review_halt_by_sample(uuid,uuid,timestamp with time zone)'::regprocedure) AS d`);
  const list = /ps\.type IN \(([^)]*)\)/.exec(f.d as string)?.[1]?.split(',').map((x) => x.trim().replace(/^'|'$/g, '')).sort();
  const strategyRules = [...COMPETITOR_DERIVED_RULES].sort();
  assert.deepEqual(list, strategyRules, 'the halt review samples offers of every competitor-derived strategy type');
});

test('step 97: positive control — an expression without WIN_BUYBOX is a mismatch', async () => {
  const expr = (await expression('channel_data.price_intent')).replace(", 'WIN_BUYBOX'::text", '');
  assert.ok(!expr.includes('WIN_BUYBOX'), 'the control removed the rule from the expression');
  assert.deepEqual(await mismatches(expr), ['WIN_BUYBOX: database false, code true']);
});
