import type { ChannelAdapter, FieldWrite } from '@repracer/channel-port';
import pg from 'pg';
import { startWorker } from '../src/worker.ts';

/**
 * Процесс-экземпляр для теста порядка за брокером. Канал — заглушка: принимает запись с задержкой и пишет в журнал
 * proof.adapter_call (служебная схема одноразовой базы, создаётся тестом). Потребление пишется в proof.consumed до обработки.
 * Только синтетические данные.
 */

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
};
const workerId = env('PROOF_WORKER_ID');
const runId = env('PROOF_RUN_ID');
const journal = new pg.Pool({ connectionString: env('PROOF_JOURNAL_URL'), max: 4, application_name: `repracer-proof-journal-${workerId}` });
journal.on('error', () => undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const adapter = {
  async planDispatch(_ctx: unknown, writes: readonly FieldWrite[]) {
    return { batches: writes.map((w) => ({ batchId: `proof:${w.channelWriteId}`, operation: 'PROOF', items: [w], budgetCharges: [], requestCount: 1 })), rejected: [] };
  },
  async dispatch(ctx: { tenantId: string }, batch: { batchId: string; items: FieldWrite[] }) {
    for (const w of batch.items) {
      await sleep(5 + Math.floor(Math.random() * 25));
      await journal.query(
        `INSERT INTO proof.adapter_call (run_id, worker_id, tenant_id, write_scope_id, version, amount_minor) VALUES ($1, $2, $3, $4, $5, $6)`,
        [runId, workerId, ctx.tenantId, w.writeScope.writeScopeId, w.version, w.value.field === 'PRICE' ? w.value.price.amountMinor : null]);
    }
    return { batchId: batch.batchId, outcomes: batch.items.map((w) => ({ channelWriteId: w.channelWriteId, status: 'ACCEPTED', appliedImmediately: true })), attemptsMade: 1 };
  },
  // Шаг 20: обратное чтение канала-заглушки — по журналу вызовов этого прогона. Раньше заглушка отвечала «нет данных»: запись,
  // которую захватил убитый экземпляр, после тайм-аута сверялась как UNKNOWN и навсегда держала единицу — последняя цена не доходила
  // до канала (CI шага 20, 2 единицы). У настоящего канала обратное чтение есть; без записи в журнале — цена мира стенда (2000)
  async readBack(_ctx: unknown, requests: readonly { writeScope: { writeScopeId: string }; fields: readonly string[] }[]) {
    const observations = [];
    for (const r of requests) {
      const { rows } = await journal.query(
        `SELECT amount_minor FROM proof.adapter_call WHERE run_id = $1 AND write_scope_id = $2 AND amount_minor IS NOT NULL ORDER BY seq DESC LIMIT 1`,
        [runId, r.writeScope.writeScopeId]);
      const amountMinor = rows.length > 0 ? Number(rows[0].amount_minor) : 2000;
      observations.push({ identity: r.writeScope, field: 'PRICE', value: { field: 'PRICE', price: { amountMinor, currency: 'EUR', basis: 'GROSS' } }, observedAt: new Date().toISOString(), source: 'READBACK' });
    }
    return { observations, failures: [] };
  },
} as unknown as ChannelAdapter;

const worker = await startWorker({
  workerId,
  pgUrl: env('REPRACER_PG_URL'),
  dispatcherPgUrl: env('REPRACER_PG_URL').replace('svc_app@', 'svc_dispatcher@'),
  relayPgUrl: env('REPRACER_PG_URL').replace('svc_app@', 'svc_relay@'),
  kafkaBrokers: env('REPRACER_KAFKA_BROKERS').split(','),
  adapterFor: () => adapter,
  alerts: { raise: async (a) => void process.send?.({ kind: 'alert', workerId, code: a.code }) },
  logger: { log: () => undefined },
  partitionsConcurrently: 4,
  consumerGroupSuffix: `-proof-${runId}`,
  sweepIntervalMs: 2_000,
  onConsumed: async (message, id) => {
    const seq = message.topic.startsWith('raw.') ? (JSON.parse(message.value) as { productSeq?: number }).productSeq ?? null : null;
    await journal.query(
      `INSERT INTO proof.consumed (run_id, worker_id, topic, partition, message_offset, message_key, product_seq) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [runId, id, message.topic, message.partition, message.offset, message.key, seq]);
  },
});
process.send?.({ kind: 'ready', workerId });
process.on('message', async (m: { kind?: string }) => {
  if (m?.kind === 'stop') {
    await worker.stop();
    await journal.end();
    process.exit(0);
  }
});
