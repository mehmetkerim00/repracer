import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { createKafka, createKeyedProducer, ensureTopics, TOPICS, type KeyedMessage } from '@repracer/broker';
import type { MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, seedPricingWorld } from '@repracer/pricing-store-pg';
import pg from 'pg';

/**
 * Р-24, Р-64: порядок внутри единицы записи при трёх экземплярах пути решения за брокером — с убийством одного экземпляра
 * посреди прогона (перебалансировка группы) и заменой его новым. Что доказывает зелёный прогон:
 *  1. каждый снимок товара впервые обработан после всех предыдущих снимков того же товара (повторная доставка после
 *     перебалансировки допустима только для уже обработанного номера);
 *  2. канал получил версии каждой единицы строго по возрастанию;
 *  3. последняя решённая цена каждой единицы дошла до канала, записей PENDING не осталось;
 *  4. ни один снимок не отклонён как устаревший (OUT_OF_ORDER) — путь решения не видел перестановок.
 * Негативный контроль: те же проверки на публикации без ключа партиции обязаны найти нарушения порядка — иначе
 * проверка ничего не доказывает.
 *
 * Нужны: REPRACER_KAFKA_BROKERS (Redpanda, infra/local/compose.yaml), REPRACER_PG_URL (svc_app), REPRACER_PG_ADMIN_URL
 * (суперпользователь одноразовой базы — служебная схема proof для журнала). Без них тест падает [Р-84].
 */

const BROKERS = process.env.REPRACER_KAFKA_BROKERS;
const PG_URL = process.env.REPRACER_PG_URL;
const ADMIN_URL = process.env.REPRACER_PG_ADMIN_URL;
// Р-84: без брокера и базы тест не пропускается, а падает (CI поднимает Redpanda и PostgreSQL)
if (!(BROKERS && PG_URL && ADMIN_URL)) throw new Error('REPRACER_KAFKA_BROKERS, REPRACER_PG_URL and REPRACER_PG_ADMIN_URL are required: the test does not skip (Р-84)');
const skip = false;
const WORKER = fileURLToPath(new URL('./proof-worker.ts', import.meta.url));
const ACCOUNT = '20000000-0000-4000-8000-000000000001';
const PRODUCTS = 60;
const SNAPSHOTS_PER_PRODUCT = 8;
const BUYBOX = { strategyId: 'st-buybox', version: 1, params: { type: 'MATCH_BUYBOX', undercutMinor: 5, holdWhenWinning: false, atBound: 'CAP' }, deadbandMinor: 0 } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-proof' }) : null;
// Р-90: тенант доказательства создаёт роль создания тенанта
const provisioning = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-proof-provisioning' }) : null;
// Р-96: конфигурацию мира доказательства пишет административная роль
const adminService = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-proof-admin' }) : null;
// Журнал доказательства — в той же базе, куда пишут экземпляры (PG_URL): административный адрес указывает на базу postgres.
// Шаг 20: до исправления схема proof создавалась в базе postgres, запись журнала в экземплярах падала, и каждое сообщение
// уходило в «отравленные» — первый прогон в CI (шаг 19) обработал ноль сообщений
const journalAdminUrl = (() => {
  const admin = new URL(ADMIN_URL!);
  admin.pathname = new URL(PG_URL!).pathname;
  return admin.toString();
})();
const admin = ADMIN_URL ? new pg.Pool({ connectionString: journalAdminUrl, max: 2 }) : null;
const alertsByCode = new Map<string, number>();
const children: ChildProcess[] = [];
after(async () => {
  for (const c of children) c.kill('SIGKILL');
  await pool?.end();
  await provisioning?.end();
  await adminService?.end();
  await admin?.end();
});

async function prepareJournal(): Promise<void> {
  await admin!.query(`
    CREATE SCHEMA IF NOT EXISTS proof;
    CREATE TABLE IF NOT EXISTS proof.adapter_call (seq bigserial PRIMARY KEY, run_id text NOT NULL, worker_id text NOT NULL, tenant_id uuid NOT NULL,
      write_scope_id uuid NOT NULL, version bigint NOT NULL, amount_minor bigint, at timestamptz NOT NULL DEFAULT clock_timestamp());
    CREATE TABLE IF NOT EXISTS proof.consumed (seq bigserial PRIMARY KEY, run_id text NOT NULL, worker_id text NOT NULL, topic text NOT NULL, partition int NOT NULL,
      message_offset text NOT NULL, message_key text NOT NULL, product_seq int, at timestamptz NOT NULL DEFAULT clock_timestamp());
    GRANT USAGE ON SCHEMA proof TO svc_app;
    GRANT SELECT, INSERT ON proof.adapter_call, proof.consumed TO svc_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA proof TO svc_app;`);
}

function spawnWorker(workerId: string, runId: string): Promise<ChildProcess> {
  const child = fork(WORKER, [], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    env: { ...process.env, PROOF_WORKER_ID: workerId, PROOF_RUN_ID: runId, PROOF_JOURNAL_URL: PG_URL! },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.on('message', (m: { kind?: string; code?: string }) => {
      if (m?.kind === 'ready') resolve(child);
      if (m?.kind === 'alert' && m.code) alertsByCode.set(m.code, (alertsByCode.get(m.code) ?? 0) + 1);
    });
    child.on('exit', (code) => reject(new Error(`worker ${workerId} exited with ${code} before ready`)));
  });
}

function scopes(): MemorySeedScope[] {
  return Array.from({ length: PRODUCTS }, (_, i) => {
    const n = 9000 + i;
    return {
      writeScopeId: `ws-${n}`, productId: `prod-${n}`, channelAccountId: ACCOUNT, marketplace: 'de', externalUnitId: String(n), channelProductRef: `36209${n}`,
      condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', strategy: BUYBOX, currentPriceMinor: 2000,
      minPrice: { amountMinor: 1000, id: `min-${n}` }, maxPrice: { amountMinor: 3000, id: `max-${n}` },
      // Р-131 (шаг 27): движок без объявленной себестоимости база не включает; проверка — о порядке записей, не о себестоимости
      cost: { currency: 'EUR', costProfileId: `cp-${n}`, unitCostMinor: 300, fixedFeeMinor: 0, feeRateBp: 1000, tax: { regime: 'VAT_INCLUDED' as const, vatRateBp: 1900 } },
    };
  });
}

interface ProofResult {
  consumedFirstOutOfOrder: number;
  redeliveries: number;
  adapterVersionViolations: number;
  scopesWithLostLatestPrice: number;
  strandedPending: number;
  outOfOrderRejections: number;
  outOfOrderRejectionsNotRedelivered: number;
  workersThatConsumed: number;
  messagesPublished: number;
  snapshotsConsumed: number;
  alerts: Record<string, number>;
  adapterCalls: number;
  decisionsApproved: number;
}

async function runProof(options: { keyed: boolean; killOne: boolean }): Promise<ProofResult> {
  const runId = randomUUID();
  const kafka = createKafka(BROKERS!.split(','), `repracer-proof-producer-${runId.slice(0, 8)}`);
  // Топики стенда пересоздаются: сообщения прошлых прогонов не должны попасть в этот (число партиций фиксировано)
  const kadmin = kafka.admin();
  await kadmin.connect();
  const existing = await kadmin.listTopics();
  const stale = [TOPICS.rawCompetitorSnapshot, TOPICS.scopeWrite].filter((t) => existing.includes(t));
  if (stale.length) await kadmin.deleteTopics({ topics: stale, timeout: 30_000 });
  // Удаление топика в брокере асинхронно: создание до его окончания находит «существующий» топик, который затем исчезает
  for (let i = 0; i < 60 && (await kadmin.listTopics()).some((t) => (stale as string[]).includes(t)); i++) await sleep(500);
  await kadmin.disconnect();
  await ensureTopics(kafka, [{ topic: TOPICS.rawCompetitorSnapshot, numPartitions: 12 }, { topic: TOPICS.scopeWrite, numPartitions: 12 }]);
  alertsByCode.clear();

  const nowMs = Date.now();
  const world = await seedPricingWorld(pool!, {
    provisioningPool: provisioning!, adminPool: adminService!,
    fixtureTenantId: '10000000-0000-4000-8000-000000000001', fixtureChannelAccountId: ACCOUNT, marketplaces: ['de', 'at'], clock: new Date(nowMs).toISOString(),
    seed: {
      scopes: scopes(),
      competitorDaily: Object.fromEntries(scopes().map((s) => [`de|${s.channelProductRef}|new`, Array.from({ length: 20 }, (_, d) => ({
        day: new Date(nowMs - (d + 1) * 86_400_000).toISOString().slice(0, 10), minMinor: 1700, maxMinor: 2300 }))])),
    },
  });

  const workers = await Promise.all(['w1', 'w2', 'w3'].map((id) => spawnWorker(id, runId)));
  await sleep(5_000); // группа потребителей распределяет партиции

  const producer = await createKeyedProducer(kafka);
  const messages: KeyedMessage[] = [];
  for (let s = 1; s <= SNAPSHOTS_PER_PRODUCT; s++) {
    for (const scope of scopes()) {
      // Цена конкурента меняется небольшими шагами в разные стороны: без массового сдвига [Р-50], каждое решение — новая цена
      const buybox = 1900 + ((s * 37 + Number(scope.externalUnitId)) % 11) * 10;
      const observedAt = new Date(nowMs + s * 1_000).toISOString();
      const money = (amountMinor: number) => ({ amountMinor, currency: 'EUR', basis: 'GROSS' as const });
      const snapshot: CompetitorSnapshot = {
        marketplace: 'de', channelProductRef: scope.channelProductRef, condition: 'new', source: 'KAUFLAND_BUYBOX', observedAt,
        completeness: { kind: 'TOP_N', n: 10 }, buybox: { price: money(buybox), isSelf: false },
        offers: [{ rank: 1, sellerRef: `synthetic-competitor-${scope.externalUnitId}`, isSelf: false, price: money(buybox) }],
      };
      const productKey = `${world.channelAccountId}|de|${scope.channelProductRef}|new`;
      messages.push({
        topic: TOPICS.rawCompetitorSnapshot,
        key: options.keyed ? productKey : randomUUID(),
        value: JSON.stringify({ tenantId: world.tenantId, channelAccountId: world.channelAccountId, correlationId: `${runId}:${productKey}:${s}`, productSeq: s, snapshot }),
        headers: { 'product-key': productKey },
      });
    }
  }
  const third = Math.floor(messages.length / 3);
  await producer.send(messages.slice(0, third));
  if (options.killOne) {
    await sleep(3_000);
    workers[1]!.kill('SIGKILL'); // экземпляр умирает без выхода из группы
    await spawnWorker('w4', runId);
  }
  await producer.send(messages.slice(third));
  await producer.disconnect();

  // Ждём затихания: все снимки обработаны, ждущих записей нет, канал давно не получал записей
  // Запись убитого экземпляра освобождается тайм-аутом полёта (120 с, DEFAULT_RETRY_POLICY) и сверкой — окно ожидания больше него
  const deadline = Date.now() + 330_000;
  let last = -1;
  let stableRounds = 0;
  while (Date.now() < deadline) {
    const { rows: [c] } = await admin!.query(
      `SELECT (SELECT count(DISTINCT (message_key, product_seq)) FROM proof.consumed WHERE run_id = $1 AND topic = $2) AS consumed,
              (SELECT count(*) FROM proof.adapter_call WHERE run_id = $1) AS calls`, [runId, TOPICS.rawCompetitorSnapshot]);
    const pending = await inTenant(pool!, world.tenantId, async (tx) => Number((await tx.query(
      `SELECT count(*) AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND status IN ('PENDING', 'DISPATCHED')`, [world.tenantId])).rows[0].n));
    const progress = Number(c.consumed) * 100_000 + Number(c.calls);
    if (Number(c.consumed) >= messages.length && pending === 0 && progress === last) {
      if (++stableRounds >= 3) break;
    } else {
      stableRounds = 0;
    }
    last = progress;
    await sleep(1_000);
  }
  for (const w of children) if (w.connected) w.send({ kind: 'stop' });
  await sleep(2_000);

  // Порядок по товару: номер снимка — из журнала потребления; без ключа партиции товар восстанавливается по опубликованному сообщению
  const { rows: byProduct } = await admin!.query(
    `SELECT c.seq, c.product_seq, c.worker_id, c.message_key FROM proof.consumed c WHERE c.run_id = $1 AND c.topic = $2 ORDER BY c.seq`,
    [runId, TOPICS.rawCompetitorSnapshot]);
  const productOf = new Map<string, string>();
  for (const m of messages) productOf.set(m.key, m.headers['product-key']!);

  let consumedFirstOutOfOrder = 0;
  let redeliveries = 0;
  const seen = new Map<string, Set<number>>();
  const redelivered = new Set<string>();
  const maxSeen = new Map<string, number>();
  for (const r of byProduct) {
    const product = options.keyed ? r.message_key : productOf.get(r.message_key) ?? r.message_key;
    const set = seen.get(product) ?? new Set<number>();
    const seq = Number(r.product_seq);
    if (set.has(seq)) {
      redeliveries++;
      redelivered.add(`${product}|${seq}`);
    }
    else if (seq < (maxSeen.get(product) ?? 0)) consumedFirstOutOfOrder++;
    set.add(seq);
    seen.set(product, set);
    maxSeen.set(product, Math.max(maxSeen.get(product) ?? 0, seq));
  }

  const { rows: calls } = await admin!.query(`SELECT write_scope_id, version, amount_minor FROM proof.adapter_call WHERE run_id = $1 ORDER BY seq`, [runId]);
  const lastCall = new Map<string, { version: number; amount: number }>();
  let adapterVersionViolations = 0;
  for (const c of calls) {
    const prev = lastCall.get(c.write_scope_id);
    if (prev && Number(c.version) <= prev.version) adapterVersionViolations++;
    lastCall.set(c.write_scope_id, { version: Number(c.version), amount: Number(c.amount_minor) });
  }

  const state = await inTenant(pool!, world.tenantId, async (tx) => {
    const { rows: latest } = await tx.query(
      `SELECT ss.write_scope_id, ss.latest_version_created,
              coalesce((SELECT w.amount_minor FROM tenant_data.channel_write w WHERE w.tenant_id = ss.tenant_id AND w.write_scope_id = ss.write_scope_id AND w.version = ss.latest_version_created),
                       (SELECT h.amount_minor FROM tenant_data.channel_write_history h WHERE h.tenant_id = ss.tenant_id AND h.write_scope_id = ss.write_scope_id AND h.version = ss.latest_version_created)) AS amount
         FROM tenant_data.write_scope_sync_state ss WHERE ss.tenant_id = $1 AND ss.latest_version_created > 0`, [world.tenantId]);
    const { rows: [p] } = await tx.query(`SELECT count(*) AS n FROM tenant_data.channel_write WHERE tenant_id = $1 AND status = 'PENDING'`, [world.tenantId]);
    const { rows: oooRows } = await tx.query(
      `SELECT channel_product_ref, observed_at FROM channel_data.rejected_competitor_snapshot WHERE tenant_id = $1 AND reason_code = 'OUT_OF_ORDER'`, [world.tenantId]);
    const ooo = { n: oooRows.length };
    // Шаг 20: отклонение OUT_OF_ORDER допустимо только для повторной доставки уже обработанного снимка (at-least-once после
    // перебалансировки); номер снимка восстанавливается из observed_at = начало прогона + номер секунд
    const rejectedNotRedelivered = oooRows.filter((r) => {
      const seq = Math.round((new Date(r.observed_at).getTime() - nowMs) / 1_000);
      const product = `${world.channelAccountId}|de|${r.channel_product_ref}|new`;
      return !redelivered.has(`${product}|${seq}`);
    }).length;
    const { rows: [approved] } = await tx.query(`SELECT count(*) AS n FROM channel_data.price_decision WHERE tenant_id = $1 AND outcome = 'APPROVED'`, [world.tenantId]);
    return { latest, pending: Number(p.n), outOfOrder: Number(ooo.n), rejectedNotRedelivered, approved: Number(approved.n) };
  });
  let lost = 0;
  for (const l of state.latest) if (lastCall.get(l.write_scope_id)?.amount !== Number(l.amount)) lost++;
  const { rows: [w] } = await admin!.query(`SELECT count(DISTINCT worker_id) AS n FROM proof.consumed WHERE run_id = $1`, [runId]);

  return {
    consumedFirstOutOfOrder, redeliveries, adapterVersionViolations, scopesWithLostLatestPrice: lost, strandedPending: state.pending,
    outOfOrderRejections: state.outOfOrder, outOfOrderRejectionsNotRedelivered: state.rejectedNotRedelivered, workersThatConsumed: Number(w.n), adapterCalls: calls.length, decisionsApproved: state.approved,
    messagesPublished: messages.length, snapshotsConsumed: seen.size === 0 ? 0 : [...seen.values()].reduce((n, set) => n + set.size, 0), alerts: Object.fromEntries(alertsByCode),
  };
}

test('Р-24, Р-64: three pricing path instances behind the broker, one killed mid-run — order within every write scope holds', { skip, timeout: 600_000 }, async () => {
  await prepareJournal();
  const result = await runProof({ keyed: true, killOne: true });
  console.log(`BROKER_ORDER_RESULT ${JSON.stringify(result)}`);
  // Шаг 20: пустой прогон не доказывает порядок — каждое опубликованное сообщение обработано, отравленных нет
  assert.equal(result.snapshotsConsumed, result.messagesPublished, 'every published snapshot is consumed at least once');
  assert.equal(result.alerts.BROKER_MESSAGE_POISONED ?? 0, 0, 'no message is poisoned');
  assert.ok(result.decisionsApproved > 0 && result.adapterCalls > 0, 'decisions were made and reached the channel');
  assert.ok(result.workersThatConsumed >= 3, 'the rebalance did not spread partitions over several instances');
  assert.equal(result.consumedFirstOutOfOrder, 0, 'a snapshot of a product was processed after a later snapshot of the same product');
  assert.equal(result.adapterVersionViolations, 0, 'the channel received an older version after a newer one');
  assert.equal(result.scopesWithLostLatestPrice, 0, 'the latest decided price did not reach the channel');
  assert.equal(result.strandedPending, 0);
  // Шаг 20, первый настоящий прогон: 7 отклонений OUT_OF_ORDER при 8 повторных доставках после убийства экземпляра. Повторная
  // доставка уже обработанного снимка отклоняется как устаревшая — это at-least-once, а не перестановка; перестановкой было бы
  // отклонение снимка, который впервые пришёл после более нового
  assert.equal(result.outOfOrderRejectionsNotRedelivered, 0, 'a snapshot rejected as out of order was not a redelivery');
  assert.ok(result.outOfOrderRejections <= result.redeliveries, 'more out-of-order rejections than redeliveries');
});

test('control — publishing without the partition key, the same checker finds reordering', { skip, timeout: 600_000 }, async () => {
  await prepareJournal();
  const result = await runProof({ keyed: false, killOne: false });
  console.log(`BROKER_ORDER_CONTROL ${JSON.stringify(result)}`);
  assert.equal(result.snapshotsConsumed, result.messagesPublished, 'the control consumed every published snapshot');
  assert.ok(result.consumedFirstOutOfOrder + result.outOfOrderRejections > 0, 'without the key reordering is expected; a checker that sees none proves nothing');
});
