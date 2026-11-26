import type { PgPool } from '../src/index.ts';

/**
 * Шаг 173.1: решение PostgreSQL о JIT — оператор компилируется, когда `jit` включён и оценка плана выше `jit_above_cost`. Локальный
 * PostgreSQL без LLVM JIT не исполняет, поэтому правило смотрит на это решение, а не на время
 */
export interface Explained { text: string; cost: number; jit: string; above: number }

/** Пул, у которого каждый оператор чтения объясняется сразу после исполнения — в той же транзакции и с теми же параметрами */
export function explaining(target: PgPool, seen: Explained[]): PgPool {
  const connect = target.connect.bind(target);
  const wrapped = new WeakSet<object>();
  (target as unknown as { connect: () => Promise<unknown> }).connect = async () => {
    const client = await connect() as unknown as { query: (text: unknown, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };
    // Пул выдаёт тот же клиент снова — обёртка ставится один раз, иначе объяснялись бы и её собственные запросы
    if (wrapped.has(client)) return client;
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = async (text: unknown, values?: unknown[]) => {
      const result = await query(text, values);
      if (typeof text === 'string' && /^\s*(WITH|SELECT)\b/i.test(text) && !/set_config\(/.test(text)) {
        const { rows: [plan] } = await query(`EXPLAIN (FORMAT JSON) ${text}`, values);
        const { rows: [s] } = await query(`SELECT current_setting('jit') AS jit, current_setting('jit_above_cost')::float8 AS above`);
        const cost = Number((plan!['QUERY PLAN'] as Array<{ Plan: { 'Total Cost': number } }>)[0]!.Plan['Total Cost']);
        seen.push({ text: text.replace(/\s+/g, ' ').trim(), cost, jit: String(s!.jit), above: Number(s!.above) });
      }
      return result;
    };
    return client;
  };
  return target;
}

/** Операторы, которые PostgreSQL скомпилировал бы: `jit` включён, оценка выше порога — строкой с оценкой и началом текста */
export const jitCompiled = (seen: readonly Explained[]): string[] =>
  seen.filter((s) => s.jit === 'on' && s.cost > s.above).map((s) => `${s.cost.toExponential(2)} > ${s.above}: ${s.text.slice(0, 200)}`);
