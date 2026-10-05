import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startModelIdentityProvider, type ModelIdentityProvider } from '@repracer/identity/test-provider';
import { DEFAULT_JOB_CONFIG } from '@repracer/scheduler';
import { createIsolatedDatabase, type IsolatedDatabase } from '../../../packages/pricing-store-pg/test/isolated-db.ts';
import { beginLogin, finishLogin } from '../../../apps/console/src/oidc.ts';
import { demoProducts, kauflandLiveWorld, WallClock, type KauflandLiveWorld, type LiveProduct } from './live/index.ts';
import { startKauflandHttpModel, type KauflandChaos, type KauflandHttpModel, type KauflandWriteJournalEntry } from './live/kaufland-http.ts';

/**
 * Шаг 65, часть 1: ХАОС. Повторяемое задание: семя печатается первой строкой, и по нему же повторяется план — какие сбои канала в
 * каком раунде, какой процесс и когда убит. Время процессов настоящее, поэтому повтор плана не значит повтор чередования до миллисекунды:
 * найденный дефект закрепляется своей проверкой, а семя — способ к нему вернуться.
 *
 * Процессы — НАСТОЯЩИЕ и отдельные, убиваются SIGKILL посреди работы:
 *  - планировщик — промышленная точка входа `services/scheduler/src/main.ts` (стенд: адрес модели канала);
 *  - диспетчер записей — обход-страховка `pricing-worker` без брокера (`chaos/dispatcher-process.ts`: брокера на машине прогона нет);
 *  - консоль — промышленная точка входа `apps/console/server/console-service.ts`, вход у модели поставщика identity, как браузер;
 *  - исполнитель массовых заданий — `apps/console/server/bulk-worker.ts`.
 * Канал — модель Kaufland за настоящим HTTP в процессе прогона: её состояние переживает любое убийство. Порча канала:
 *  - тайм-аут после применения (модель K-14: запись применена, клиент ответа не получил — разрешает обратное чтение);
 *  - обрыв соединения посреди ответа (заголовок и половина тела ушли);
 *  - 500 посреди пакета (строка пакета) и 500 на весь пакет, уже применённый;
 *  - повторная доставка строки заказа в той же странице.
 * После каждого раунда — затишье (сбои сняты, спрос модели на паузе, все процессы живы, очередь записей и задания дошли до конца) и
 * инварианты:
 *  a) журналы только на добавление целы: число строк не убывает, номера outbox у единицы — без пропусков;
 *  b) ни одна версия записи не потеряна (версии единицы — ровно 1…N) и не отправлена мимо учёта (запросов записи в канал не больше
 *     учтённых попыток);
 *  c) резервации = неотгруженные строки заказов канала, ни одна строка не зарезервирована дважды;
 *  d) у каждой единицы значение в канале = наша цель, или расхождение записано с причиной;
 *  e) бюджеты и квоты не отрицательны и не удвоены.
 * Данные синтетические.
 */
const SEED = Number(process.env.REPRACER_CHAOS_SEED ?? Math.floor(Math.random() * 2 ** 31));
const ROUNDS = Number(process.env.REPRACER_CHAOS_ROUNDS ?? 4);
const WINDOW_MS = Number(process.env.REPRACER_CHAOS_WINDOW_MS ?? 45_000);
const QUIESCE_LIMIT_MS = 6 * 60_000;
const OFFERS = 40;
const ON_HAND = 40;
const BUFFER = 2;
const TAG = 6500;
const CONSOLE_AUDIENCE = 'repracer-console-chaos';
const PROCESSES = ['scheduler', 'dispatcher', 'console', 'bulk-worker'] as const;
type ProcessKind = (typeof PROCESSES)[number];
const KILL_WEIGHTS: readonly ProcessKind[] = ['scheduler', 'dispatcher', 'dispatcher', 'console', 'bulk-worker'];

console.log(`chaos seed ${SEED} rounds ${ROUNDS} window ${WINDOW_MS} ms`);

/** mulberry32: план хаоса из семени */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const plan = prng(SEED);
const between = (lo: number, hi: number) => lo + Math.floor(plan() * (hi - lo + 1));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const root = fileURLToPath(new URL('../../../', import.meta.url));

let db: IsolatedDatabase;
let live: KauflandLiveWorld;
let model: KauflandHttpModel;
let provider: ModelIdentityProvider;
let secretsDir = '';
let dist = '';
const journal: KauflandWriteJournalEntry[] = [];
/** Шаг 67: предложения, чьё расхождение количества объяснено OQ-220 в последней проверке, — число идёт в отчёт раунда, чтобы признание не стало слепым пятном */
const oq220Seen = new Set<string>();
const chaos: KauflandChaos = { random: prng(SEED ^ 0x5eed), dropMidResponseShare: 0, bulk500AfterApplyShare: 0, duplicateOrderLineShare: 0 };
const ports: Record<string, number> = {};
const procs = new Map<ProcessKind, ChildProcess>();
const tails = new Map<ProcessKind, string[]>();
const kills: Array<{ round: number; kind: ProcessKind; atMs: number }> = [];
const report: Array<Record<string, unknown>> = [];
/** Доля записей, на которых диспетчер убивается в момент применения (план раунда) */
let killOnWriteShare = 0;
let currentRound = 0;
let consoleOrigin = '';
let tokens: { access: string; id: string | null } = { access: '', id: null };
let worldId = '';
let stockSourceId = '';

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function envOf(kind: ProcessKind): Record<string, string> {
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', REPRACER_MODE: 'stand' };
  if (kind === 'scheduler') {
    return {
      ...base,
      REPRACER_SCHEDULER_PG_URL: db.url('svc_scheduler'), REPRACER_APP_PG_URL: db.url('svc_app'), REPRACER_STOCK_PG_URL: db.url('svc_stock'),
      REPRACER_EXPORTER_PG_URL: db.url('svc_exporter'),
      // Выгрузке прогона ClickHouse не нужен: адрес, по которому никто не отвечает, — конфигурация процесса, а не зависимость раунда
      REPRACER_CH_URL: 'http://127.0.0.1:9', REPRACER_CH_INGEST_USER: 'syn-ingest', REPRACER_CH_INGEST_PASSWORD: 'syn-ingest',
      REPRACER_CH_VERIFIER_USER: 'syn-verifier', REPRACER_CH_VERIFIER_PASSWORD: 'syn-verifier',
      REPRACER_CHANNEL_SECRETS_DIR: secretsDir, REPRACER_KAUFLAND_BASE_URL: model.baseUrl, REPRACER_KAUFLAND_FALLBACK_EMAIL: 'ops@example.invalid',
      REPRACER_AMAZON_APPLICATION_CREDENTIALS_REF: 'secret-ref:amazon-application', REPRACER_SCHEDULER_HEARTBEAT: 'off', REPRACER_SCHEDULER_MAIL: 'off',
      REPRACER_SCHEDULER_METRICS_PORT: String(ports.scheduler), REPRACER_SCHEDULER_TICK_MS: '1000', REPRACER_SCHEDULER_OWNER: 'chaos-scheduler',
    };
  }
  if (kind === 'dispatcher') {
    return {
      ...base, REPRACER_CHAOS_APP_PG_URL: db.url('svc_app'), REPRACER_CHAOS_DISPATCHER_PG_URL: db.url('svc_dispatcher'),
      REPRACER_CHANNEL_SECRETS_DIR: secretsDir, REPRACER_KAUFLAND_BASE_URL: model.baseUrl, REPRACER_CHAOS_SWEEP_MS: '1000',
    };
  }
  if (kind === 'bulk-worker') {
    return {
      ...base, BULK_WORKER_CONFIG: '', REPRACER_BULK_HEARTBEAT: 'off', REPRACER_BULK_METRICS_PORT: String(ports['bulk-worker']),
      REPRACER_BULK_POLL_MS: '200', REPRACER_BULK_IDLE_MS: '100',
      REPRACER_BULK_APP_PG_URL: db.url('svc_app'), REPRACER_BULK_ADMIN_PG_URL: db.url('svc_admin'), REPRACER_BULK_BULK_WORKER_PG_URL: db.url('svc_bulk_worker'),
      REPRACER_BULK_STOCK_PG_URL: db.url('svc_stock'),
    };
  }
  const roles = ['app', 'admin', 'authenticator', 'onboarding', 'provisioning', 'dispatcher', 'stock', 'scheduler', 'exporter', 'fx_loader', 'bulk_worker'];
  return {
    ...base, REPRACER_CONSOLE_PORT: String(ports.console), REPRACER_CONSOLE_METRICS_PORT: String(ports.consoleMetrics), REPRACER_CONSOLE_DIST: dist,
    REPRACER_CONSOLE_PUBLIC_DEMO: 'off', REPRACER_CONSOLE_HEARTBEAT: 'off',
    ...Object.fromEntries(roles.map((r) => [`REPRACER_CONSOLE_${r.toUpperCase()}_PG_URL`, db.url(`svc_${r}` as never)])),
    REPRACER_CONSOLE_OIDC_ISSUER: provider.issuer, REPRACER_CONSOLE_OIDC_AUDIENCE: CONSOLE_AUDIENCE, REPRACER_CONSOLE_OIDC_JWKS_URL: provider.jwksUrl,
    REPRACER_CONSOLE_OIDC_CLIENT_ID: 'console-spa', REPRACER_CONSOLE_OIDC_DISCOVERY_BASE: provider.origin,
  };
}

const ENTRY: Record<ProcessKind, string> = {
  scheduler: 'services/scheduler/src/main.ts',
  dispatcher: 'tests/contract/src/chaos/dispatcher-process.ts',
  console: 'apps/console/server/console-service.ts',
  'bulk-worker': 'apps/console/server/bulk-worker.ts',
};

/** Жив ли процесс: убитый сигналом получает `signalCode`, а `exitCode` у него остаётся null (ревью шага 65, находка 3) */
const alive = (child: ChildProcess | undefined): child is ChildProcess => child !== undefined && child.exitCode === null && child.signalCode === null;

async function ready(kind: ProcessKind): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const child = procs.get(kind);
    if (!alive(child)) throw new Error(`${kind} exited before it was ready: ${(tails.get(kind) ?? []).slice(-5).join(' | ')}`);
    const probe = kind === 'console' ? `${consoleOrigin}/api/session`
      : kind === 'dispatcher' ? null : `http://127.0.0.1:${kind === 'scheduler' ? ports.scheduler : ports['bulk-worker']}/healthz`;
    if (probe === null) {
      if ((tails.get(kind) ?? []).some((l) => l.includes('CHAOS_DISPATCHER_READY'))) return;
    } else {
      const ok = await fetch(probe).then((r) => r.ok, () => false);
      if (ok) return;
    }
    if (Date.now() > deadline) throw new Error(`${kind} not ready in 60 s: ${(tails.get(kind) ?? []).slice(-5).join(' | ')}`);
    await sleep(200);
  }
}

async function start(kind: ProcessKind): Promise<void> {
  tails.set(kind, []);
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', join(root, ENTRY[kind])],
    { cwd: root, env: envOf(kind), stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk: Buffer) => {
    const lines = tails.get(kind)!;
    lines.push(...chunk.toString().split('\n').filter(Boolean));
    if (lines.length > 200) lines.splice(0, lines.length - 200);
  };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  procs.set(kind, child);
  await ready(kind);
}

async function kill(kind: ProcessKind): Promise<void> {
  const child = procs.get(kind);
  if (!alive(child)) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exited;
}

/** Аренды убитого планировщика держались бы до срока (до 30 мин): прогон снимает их суперпользователем — страж это допускает */
async function expireSchedulerLeases(): Promise<void> {
  await db.superuser(`UPDATE maintenance.scheduled_job SET lease_until = now() WHERE lease_until > now()`);
}

/** Работы — к сроку сейчас: раунд длится минуту, а у чтения заказов период 5 минут */
async function jobsDueNow(): Promise<void> {
  await db.superuser(`UPDATE maintenance.scheduled_job SET next_due_at = now() WHERE next_due_at > now()`);
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const r = await fetch(`${consoleOrigin}${path}`, {
    method, headers: { authorization: `Bearer ${tokens.access}`, ...(tokens.id ? { 'x-repracer-id-token': tokens.id } : {}), cookie: 'repracer_locale=en',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

const api = (...parts: string[]) => `/api/worlds/${encodeURIComponent(worldId)}/${parts.map(encodeURIComponent).join('/')}`;

before(async () => {
  db = await createIsolatedDatabase('chaos');
  const products: LiveProduct[] = demoProducts({ bare: false }).slice(0, OFFERS).map((p) => {
    const { moreCompetitors: _more, ...rest } = p as LiveProduct & { moreCompetitors?: unknown };
    return { ...rest, behaviour: { kind: 'RANDOM_WALK', everyMs: 20_000, volatilityBp: 300, minMinor: 1500, maxMinor: 2400 } } as LiveProduct;
  });
  live = await kauflandLiveWorld({
    tag: TAG, clock: new WallClock(), products, seed: SEED, writeMode: 'LIVE',
    appPool: db.pool('svc_app', 4), adminPool: db.pool('svc_admin', 2), provisioningPool: db.pool('svc_provisioning', 1), dispatcherPool: db.pool('svc_dispatcher', 1),
    stock: { onHand: ON_HAND, bufferUnits: BUFFER, stockPool: db.pool('svc_stock', 2) },
    demand: { orderEveryMs: 2_000, shipAfterMs: 40_000, cancelShare: 0.15 },
  });
  const seller = live.world.credentials.seller as { clientKey: string; secretKey: string };
  model = await startKauflandHttpModel({
    simulator: live.simulator, seller, chaos, journal,
    // Самый опасный миг: канал запись применил, диспетчер итога не узнал и не записал — убит. Разобрать это может только обратное чтение
    onWriteApplied: () => {
      const d = procs.get('dispatcher');
      if (!alive(d) || chaos.random() >= killOnWriteShare) return;
      d.kill('SIGKILL');
      kills.push({ round: currentRound, kind: 'dispatcher', atMs: -1 });
    },
  });
  secretsDir = mkdtempSync(join(tmpdir(), 'repracer-chaos-secrets-'));
  const [account] = await db.rows<{ credentials_ref: string }>('SELECT credentials_ref FROM tenant_data.channel_account WHERE channel_account_id = $1', [live.seeded.channelAccountId]);
  writeFileSync(join(secretsDir, account!.credentials_ref.replaceAll(':', '_')), JSON.stringify(seller), { mode: 0o600 });
  dist = mkdtempSync(join(tmpdir(), 'repracer-chaos-dist-'));
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>repracer</title>', 'utf8');

  for (const k of ['scheduler', 'bulk-worker', 'console', 'consoleMetrics']) ports[k] = await freePort();
  consoleOrigin = `http://127.0.0.1:${ports.console}`;
  provider = await startModelIdentityProvider({ issuer: 'https://idp.chaos.example.invalid', clients: { 'console-spa': { redirectUris: [`${consoleOrigin}/auth/callback`], audience: CONSOLE_AUDIENCE } } });
  // Владелец мира входит у модели поставщика: связь (издатель, subject) ↔ пользователь — данными теста, мимо приглашения (оно — не предмет прогона)
  assert.match(live.seeded.userId, /^[0-9a-f-]{36}$/);
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO platform.external_identity (issuer, subject, user_id) VALUES ('${provider.issuer}', 'chaos-owner', '${live.seeded.userId}');`);

  for (const kind of PROCESSES) await start(kind);
  const session = await (await fetch(`${consoleOrigin}/api/session`)).json() as { oidc: { issuer: string; clientId: string; scope: string } };
  const { url, pending } = await beginLogin(session.oidc, `${consoleOrigin}/auth/callback`, provider.fetch as never);
  provider.signInAs({ subject: 'chaos-owner', email: 'owner-chaos@example.invalid', amr: ['pwd', 'otp'] });
  const redirected = await fetch(url, { redirect: 'manual' });
  const back = new URL(redirected.headers.get('location')!);
  const t = await finishLogin(session.oidc, { code: back.searchParams.get('code'), state: back.searchParams.get('state') }, pending, provider.fetch as never);
  tokens = { access: t.accessToken, id: t.idToken ?? null };
  const worlds = await call<Array<{ id: string }>>('GET', '/api/worlds');
  assert.equal(worlds.status, 200, JSON.stringify(worlds.body).slice(0, 300));
  worldId = worlds.body[0]!.id;
  const stock = await call<{ sources: Array<{ stockSourceId: string }> }>('GET', api('stock'));
  stockSourceId = stock.body.sources[0]!.stockSourceId;
});

after(async () => {
  for (const kind of PROCESSES) await kill(kind);
  await model?.close();
  await provider?.close();
  if (secretsDir) rmSync(secretsDir, { recursive: true, force: true });
  if (dist) rmSync(dist, { recursive: true, force: true });
  console.log(JSON.stringify({ chaos: { seed: SEED, rounds: report, kills: kills.length, journal: journal.length } }));
  await db?.drop();
});

/** Действие продавца в консоли: файл остатков на несколько SKU — задание, которое ведёт исполнитель массовых заданий */
async function sellerImportsStock(): Promise<string> {
  const skus = Array.from({ length: between(5, 15) }, () => String(live.products[between(0, live.products.length - 1)]!.idProduct).slice(-6));
  const csv = ['SKU,Quantity', ...[...new Set(skus)].map((s) => `${s},${between(5, ON_HAND)}`)].join('\r\n');
  const r = await call<{ jobId?: string }>('POST', api('stock', 'import'), { fileName: 'stock.csv', content: Buffer.from(csv).toString('base64'), stockSourceId });
  return `${r.status}`;
}

// ---------------------------------------------------------------- затишье и инварианты
let previousCounts: Record<string, number> = {};
/** Строк бюджета правок в последней сверке: у Kaufland их нет, и инвариант e) в раундах пуст — это видно в отчёте, а не только в документе */
let lastBudgetRows = 0;

async function quiesce(round: number): Promise<{ drained: boolean; waitedMs: number; left: unknown[] }> {
  chaos.dropMidResponseShare = 0; chaos.bulk500AfterApplyShare = 0; chaos.duplicateOrderLineShare = 0;
  killOnWriteShare = 0;
  live.simulator.params.faults = { writeTimeoutShare: 0, timeoutAppliedShare: 0.5, bulkItemMissingShare: 0, bulkItemServerErrorShare: 0 };
  const pausedAt = Date.now();
  live.simulator.pauseMarket(pausedAt);
  // Ревью шага 67, находка 12: с метками процессов и базы сравнивается момент паузы по часам БАЗЫ (не раньше паузы рынка)
  const pausedAtDb = (await db.rows<{ now: string }>(`SELECT now()::text AS now`))[0]!.now;
  for (const kind of PROCESSES) if (!alive(procs.get(kind))) await start(kind);
  const started = Date.now();
  let left: unknown[] = [];
  let lastForce = 0;
  for (;;) {
    if (Date.now() - lastForce > 15_000) {
      await expireSchedulerLeases();
      await jobsDueNow();
      lastForce = Date.now();
    }
    await sleep(2_000);
    const [busy] = await db.rows<{ jobs: number; writes: number; ordersRead: boolean }>(
      `SELECT (SELECT count(*)::int FROM tenant_data.bulk_job WHERE tenant_id = $1 AND status IN ('PENDING', 'RUNNING', 'INTERRUPTED')) AS jobs,
              (SELECT count(*)::int FROM tenant_data.channel_write WHERE tenant_id = $1) AS writes,
              EXISTS (SELECT 1 FROM maintenance.scheduled_job_run WHERE job_name = 'order-lines' AND outcome = 'SUCCEEDED' AND started_at > to_timestamp($2 / 1000.0))
              /**
               * Шаг 67 (красный хаос шага 66, seed 2039802170): запуск, начатый после паузы, мог ДОЧИТЫВАТЬ цепочку, начатую раньше неё, — её
               * окно канал отдаёт видом первой страницы (шаг 58), и продажа перед паузой в него не попадает. Затишье — когда дочитана цепочка,
               * начавшая чтение после паузы: курсора нет, и начало следующего окна («начало чтения − интервал», jobs.ts) не раньше паузы − интервал
               */
              AND NOT EXISTS (SELECT 1 FROM tenant_data.channel_account a
                               WHERE a.tenant_id = $1 AND a.disconnected_at IS NULL
                                 AND NOT EXISTS (SELECT 1 FROM tenant_data.channel_discovery_circle c
                                                  WHERE c.tenant_id = a.tenant_id AND c.channel_account_id = a.channel_account_id
                                                    AND c.order_cursor IS NULL AND c.order_read_from IS NULL AND c.order_since IS NOT NULL
                                                    AND c.order_since + make_interval(secs => $3) >= $4::timestamptz)) AS "ordersRead"`,
      [live.seeded.tenantId, pausedAt, DEFAULT_JOB_CONFIG.orderLinesEverySeconds, pausedAtDb]);
    if (busy!.jobs === 0 && busy!.writes === 0 && busy!.ordersRead) {
      // Чтение заказов после паузы дошло и очередь пуста: проверка «очередь пуста» ещё раз — запись, вставшая между запросами, затишье отменяет
      const [again] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_data.channel_write WHERE tenant_id = $1`, [live.seeded.tenantId]);
      if (again!.n === 0) return { drained: true, waitedMs: Date.now() - started, left: [] };
    }
    if (Date.now() - started > QUIESCE_LIMIT_MS) {
      left = await db.rows(`SELECT write_scope_id, field, version, status, attempt_count, last_error_code, next_attempt_at, dispatched_at FROM tenant_data.channel_write WHERE tenant_id = $1 ORDER BY created_at LIMIT 20`, [live.seeded.tenantId]);
      void round;
      return { drained: false, waitedMs: Date.now() - started, left };
    }
  }
}

async function invariants(round: number): Promise<string[]> {
  oq220Seen.clear();
  const t = live.seeded.tenantId;
  const problems: string[] = [];

  // a) журналы только на добавление: число строк не убывает; номера outbox единицы — 1…N без пропусков и повторов
  const tables = await db.rows<{ table_name: string }>(`SELECT table_name FROM security.table_registry WHERE mutation_mode = 'append_only' ORDER BY 1`);
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [c] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM ${table_name}`);
    counts[table_name] = c!.n;
    if (previousCounts[table_name] !== undefined && c!.n < previousCounts[table_name]!) problems.push(`a) ${table_name}: rows ${previousCounts[table_name]} → ${c!.n}`);
  }
  previousCounts = counts;
  const gaps = await db.rows(`SELECT o.write_scope_id, count(*)::int AS n, count(DISTINCT o.scope_seq)::int AS d, min(o.scope_seq) AS lo, max(o.scope_seq) AS hi, max(ss.latest_event_seq) AS latest
      FROM tenant_data.outbox_event o JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = o.tenant_id AND ss.write_scope_id = o.write_scope_id
     WHERE o.tenant_id = $1 GROUP BY o.write_scope_id
    HAVING count(*) <> count(DISTINCT o.scope_seq) OR min(o.scope_seq) <> 1 OR max(o.scope_seq) <> count(*) OR max(o.scope_seq) <> max(ss.latest_event_seq)`, [t]);
  if (gaps.length > 0) problems.push(`a) outbox seq gaps: ${JSON.stringify(gaps).slice(0, 400)}`);

  // b) версии единицы — ровно 1…N; запросов записи в канал не больше учтённых попыток (по полю)
  const lost = await db.rows(`WITH v AS (SELECT tenant_id, write_scope_id, version FROM tenant_data.channel_write
                                          UNION ALL SELECT tenant_id, write_scope_id, version FROM tenant_data.channel_write_history)
      SELECT ss.write_scope_id, ss.latest_version_created AS created, count(v.version)::int AS n, count(DISTINCT v.version)::int AS d, max(v.version) AS hi
        FROM tenant_data.write_scope_sync_state ss LEFT JOIN v ON v.tenant_id = ss.tenant_id AND v.write_scope_id = ss.write_scope_id
       WHERE ss.tenant_id = $1 GROUP BY ss.write_scope_id, ss.latest_version_created
      HAVING count(v.version) <> count(DISTINCT v.version) OR count(DISTINCT v.version) <> ss.latest_version_created OR coalesce(max(v.version), 0) <> ss.latest_version_created`, [t]);
  if (lost.length > 0) problems.push(`b) versions lost or doubled: ${JSON.stringify(lost).slice(0, 400)}`);
  const [attempts] = await db.rows<{ price: number; quantity: number }>(`SELECT
      coalesce(sum(attempt_count) FILTER (WHERE field = 'PRICE'), 0)::int AS price, coalesce(sum(attempt_count) FILTER (WHERE field = 'QUANTITY'), 0)::int AS quantity
      FROM (SELECT field, attempt_count FROM tenant_data.channel_write WHERE tenant_id = $1 UNION ALL SELECT field, attempt_count FROM tenant_data.channel_write_history WHERE tenant_id = $1) w`, [t]);
  const sentPrice = journal.reduce((n, e) => n + e.units.filter((u) => u.priceMinor !== null).length, 0);
  const sentQuantity = journal.reduce((n, e) => n + e.units.filter((u) => u.amount !== null).length, 0);
  if (sentPrice > attempts!.price) problems.push(`b) price writes reached the channel ${sentPrice} times, attempts recorded ${attempts!.price}`);
  if (sentQuantity > attempts!.quantity) problems.push(`b) quantity writes reached the channel ${sentQuantity} times, attempts recorded ${attempts!.quantity}`);
  /**
   * Ревью шага 65, находка 7: общая сумма копит запас (попытка, учтённая до отправки и убитая до HTTP), и двойная отправка одной единицы в нём
   * тонет. Поэтому и по каждой единице записи: запросов к её единице канала не больше попыток её записей
   */
  const perScope = await db.rows<{ unit: string; storefront: string; field: string; attempts: number }>(
    `SELECT om.external_unit_id AS unit, om.marketplace AS storefront, f.field, coalesce(sum(w.attempt_count), 0)::int AS attempts
       FROM tenant_data.offer_mapping om
       CROSS JOIN LATERAL (VALUES ('PRICE', om.price_write_scope_id), ('QUANTITY', om.quantity_write_scope_id)) f(field, scope)
       LEFT JOIN (SELECT tenant_id, write_scope_id, attempt_count FROM tenant_data.channel_write
                  UNION ALL SELECT tenant_id, write_scope_id, attempt_count FROM tenant_data.channel_write_history) w
         ON w.tenant_id = om.tenant_id AND w.write_scope_id = f.scope
      WHERE om.tenant_id = $1 AND f.scope IS NOT NULL GROUP BY 1, 2, 3`, [t]);
  const attemptsOf = new Map(perScope.map((r) => [`${r.field}|${r.unit}|${r.storefront}`, r.attempts]));
  const sentTo = new Map<string, number>();
  for (const e of journal) for (const u of e.units) {
    if (u.priceMinor !== null) sentTo.set(`PRICE|${u.idUnit}|${u.storefront}`, (sentTo.get(`PRICE|${u.idUnit}|${u.storefront}`) ?? 0) + 1);
    if (u.amount !== null) sentTo.set(`QUANTITY|${u.idUnit}|${u.storefront}`, (sentTo.get(`QUANTITY|${u.idUnit}|${u.storefront}`) ?? 0) + 1);
  }
  for (const [key, sent] of sentTo) {
    if (sent > (attemptsOf.get(key) ?? 0)) problems.push(`b) ${key}: reached the channel ${sent} times, attempts recorded ${attemptsOf.get(key) ?? 0}`);
  }

  // c) резервации = неотгруженные строки заказов канала; строка заказа не зарезервирована дважды
  const open = live.simulator.openOrderLines();
  const reserved = await db.rows<{ line: string; quantity: number }>(`SELECT channel_order_line_ref AS line, sum(quantity)::int AS quantity FROM channel_data.reservation
      WHERE tenant_id = $1 AND status IN ('CREATED', 'CONFIRMED_BY_SOURCE') GROUP BY 1`, [t]);
  const byLine = new Map(reserved.map((r) => [r.line, r.quantity]));
  for (const o of open) if (byLine.get(String(o.idOrderUnit)) !== o.quantity) problems.push(`c) open order line ${o.idOrderUnit} reserved ${byLine.get(String(o.idOrderUnit)) ?? 0} (channel: ${o.quantity})`);
  const openRefs = new Set(open.map((o) => String(o.idOrderUnit)));
  for (const r of reserved) if (!openRefs.has(r.line)) problems.push(`c) reservation of line ${r.line} is open, the channel line is not`);
  // «Строка зарезервирована дважды» держит UNIQUE базы — отдельная проверка была бы тавтологией (ревью шага 65); повтор доставки ловит
  // равенство количеств выше: резервация открытой строки — ровно её количество

  // d) значение в канале = наша цель, или расхождение записано с причиной
  const units = (live.simulator.dump() as { units: Array<{ idUnit: number; idOffer: string; storefront: string; listingPriceMinor: number; amount: number }> }).units;
  /**
   * Шаг 67 (полный CI шагов 66 и 67, OQ-220 — решение владельца): модель канала списывает остаток при заказе и не возвращает его при
   * отмене (допущение K-11, Kaufland не подтвердил). Заказ, созданный после нашей последней записи количества и отменённый раньше, чем
   * работа заказов его прочитала, резервации не оставляет — канал держит на единицу меньше нашей цели до следующей записи (безопасная
   * сторона). Объяснено — только РОВНО это: канал ниже нашего значения ровно на число отменённых заказов предложения, созданных после
   * последней записи количества, которую модель ПРИМЕНИЛА.
   *
   * Шаг 69 (полный CI 37109507914, семя 1781501529): до шага момент записи брался из журнала HTTP-модели — «запрос дошёл», в том числе
   * тайм-аут без применения, ошибка строки пакета и отказ по лимиту правок. Отмена между настоящей последней записью и таким запросом
   * не считалась, и OQ-220 не узнавался. Момент применения знает только модель
   */
  const lastAppliedAmountAt = (offer: string): number =>
    live.simulator.appliedAmountWrites(offer).reduce((at, w) => Math.max(at, w.atMs), Number.NEGATIVE_INFINITY);
  const oq220Drift = (offer: string): number => {
    const lastWriteAt = lastAppliedAmountAt(offer);
    return live.simulator.orderHistory(offer).filter((o) => o.status === 'cancelled' && o.tsCreatedMs > lastWriteAt).length;
  };
  /**
   * Шаг 69: след количества предложения в сообщении проверки — запросы журнала к его единицам (дошёл ли ответ), записи, которые модель
   * применила, и заказы. По одному сообщению CI видно, какая запись и какие заказы дали расхождение, без повтора прогона
   */
  const clock = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) : String(ms));
  const quantityTrail = (offer: string): string => {
    const offerUnits = new Set(units.filter((u) => u.idOffer === offer).map((u) => `${u.idUnit}|${u.storefront}`));
    const requests = journal.filter((e) => e.units.some((u) => u.amount !== null && offerUnits.has(`${u.idUnit}|${u.storefront}`))).slice(-8)
      .map((e) => `${clock(e.atMs)} ${e.route} ${e.delivered}${e.status === null ? '' : ` ${e.status}`} amount=${e.units.find((u) => u.amount !== null && offerUnits.has(`${u.idUnit}|${u.storefront}`))!.amount}`);
    const applied = live.simulator.appliedAmountWrites(offer).slice(-5).map((w) => `${clock(w.atMs)} amount=${w.amount}`);
    const orders = live.simulator.orderHistory(offer).slice(-10).map((o) => `${o.idOrderUnit} ${o.status} created ${clock(o.tsCreatedMs)} updated ${clock(o.tsUpdatedMs)}`);
    return ` | offer ${offer}: requests [${requests.join('; ')}] applied [${applied.join('; ')}] orders [${orders.join('; ')}]`;
  };
  const knownOq220 = (s: { field: string; offer: string }, ours: number, channelValue: number): boolean => {
    if (s.field !== 'QUANTITY' || channelValue >= ours) return false;
    const drift = oq220Drift(s.offer);
    if (drift === 0 || ours - channelValue !== drift) return false;
    oq220Seen.add(`${s.offer}`);
    return true;
  };
  const scopes = await db.rows<{ field: string; unit: string; storefront: string; offer: string; scope_status: string; last_version: string | null; last_status: string | null; last_amount: number | null;
    last_quantity: number | null; reason: string | null; applied_amount: number | null; applied_quantity: number | null; open_divergence: boolean; scope_id: string; in_flight: boolean }>(
    `SELECT f.field, s.write_scope_id AS scope_id, om.external_unit_id AS unit, om.marketplace AS storefront, om.external_offer_id AS offer, s.status AS scope_status,
            EXISTS (SELECT 1 FROM tenant_data.channel_write w WHERE w.tenant_id = s.tenant_id AND w.write_scope_id = s.write_scope_id) AS in_flight,
            last.version AS last_version, last.final_status AS last_status, last.amount_minor AS last_amount, last.quantity AS last_quantity,
            coalesce(last.end_reason, last.last_error_code) AS reason, ap.amount_minor AS applied_amount, ap.quantity AS applied_quantity,
            EXISTS (SELECT 1 FROM channel_data.divergence_case d WHERE d.tenant_id = s.tenant_id AND d.write_scope_id = s.write_scope_id AND d.status = 'OPEN') AS open_divergence
       FROM tenant_data.offer_mapping om
       CROSS JOIN LATERAL (VALUES ('PRICE', om.price_write_scope_id), ('QUANTITY', om.quantity_write_scope_id)) f(field, scope)
       JOIN tenant_data.write_scope s ON s.tenant_id = om.tenant_id AND s.write_scope_id = f.scope
       LEFT JOIN LATERAL (SELECT h.version, h.final_status, h.amount_minor, h.quantity, h.end_reason, h.last_error_code FROM tenant_data.channel_write_history h
                           WHERE h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id ORDER BY h.version DESC LIMIT 1) last ON true
       LEFT JOIN LATERAL (SELECT h.amount_minor, h.quantity FROM tenant_data.channel_write_history h
                           WHERE h.tenant_id = s.tenant_id AND h.write_scope_id = s.write_scope_id AND h.final_status = 'APPLIED' ORDER BY h.version DESC LIMIT 1) ap ON true
      WHERE om.tenant_id = $1 AND f.scope IS NOT NULL`, [t]);
  /**
   * Ревью шага 65, находка 6: для количества цель известна сейчас — публикуемое (пул − резервации − буфер), то же число, что считает
   * экран остатков. Сверка с целью, а не с последним применённым, видит и потерянный пересчёт (цель изменилась, записи нет)
   */
  const published = new Map<string, number>();
  for (let offset = 0; ; offset += 100) {
    const page = await live.stock!.stockPage(t, { offset, limit: 100 });
    for (const item of page.items) for (const c of item.channels) published.set(c.writeScopeId, c.published);
    if (offset + 100 >= page.total) break;
  }
  for (const s of scopes) {
    // Запись в очереди — ещё не итог: сверять её единицу рано (затишье ждёт пустой очереди, это страховка от гонки чтений)
    if (s.in_flight) continue;
    const unit = units.find((u) => String(u.idUnit) === s.unit && u.storefront === s.storefront);
    if (!unit) { problems.push(`d) unit ${s.unit}/${s.storefront} is not in the channel`); continue; }
    const channelValue = s.field === 'PRICE' ? unit.listingPriceMinor : unit.amount;
    const applied = s.field === 'PRICE' ? s.applied_amount : s.applied_quantity;
    const explained = s.open_divergence || ['BLOCKED', 'HELD', 'CONTESTED'].includes(s.scope_status);
    if (s.last_status !== null && s.last_status !== 'APPLIED' && s.last_status !== 'SUPERSEDED' && s.reason === null && !explained) {
      problems.push(`d) ${s.field} ${s.unit}: the last write ended ${s.last_status} without a reason`);
    }
    if (applied !== null && channelValue !== applied && !explained && !knownOq220(s, applied, channelValue)) {
      problems.push(`d) ${s.field} ${s.unit}: the channel holds ${channelValue}, our last applied value is ${applied}, no divergence recorded (last write v${s.last_version} ${s.last_status})`
        + (s.field === 'QUANTITY' ? quantityTrail(s.offer) : ''));
    }
    const target = s.field === 'QUANTITY' ? published.get(s.scope_id) : undefined;
    if (target !== undefined && channelValue !== target && !explained && s.last_status === 'APPLIED' && !knownOq220(s, target, channelValue)) {
      problems.push(`d) QUANTITY ${s.unit}: the channel holds ${channelValue}, our target (published) is ${target}, and no write is on its way${quantityTrail(s.offer)}`);
    }
  }

  // e) бюджеты и квоты не отрицательны и не удвоены: попытки бюджета = попытки записей с этим ключом и днём
  const budgets = await db.rows(`SELECT b.budget_scope_key, b.budget_day, b.attempts_price + b.attempts_quantity AS spent, coalesce(w.attempts, 0) AS attempts
      FROM tenant_data.edit_budget b LEFT JOIN LATERAL (
        SELECT sum(attempt_count)::int AS attempts FROM (SELECT attempt_count, budget_scope_key, budget_day FROM tenant_data.channel_write WHERE tenant_id = b.tenant_id
                                                          UNION ALL SELECT attempt_count, budget_scope_key, budget_day FROM tenant_data.channel_write_history WHERE tenant_id = b.tenant_id) x
         WHERE x.budget_scope_key = b.budget_scope_key AND x.budget_day = b.budget_day) w ON true
     WHERE b.tenant_id = $1 AND (b.attempts_price < 0 OR b.attempts_quantity < 0 OR b.attempts_price + b.attempts_quantity <> coalesce(w.attempts, 0))`, [t]);
  if (budgets.length > 0) problems.push(`e) edit budget doubled or negative: ${JSON.stringify(budgets).slice(0, 300)}`);
  const [budgetRows] = await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_data.edit_budget WHERE tenant_id = $1 AND budget_scope_key <> 'chaos-control'`, [t]);
  lastBudgetRows = budgetRows!.n;
  const quotas = await db.rows(`SELECT * FROM platform.channel_app_quota_hour WHERE spent < 0`);
  if (quotas.length > 0) problems.push(`e) app quota negative: ${JSON.stringify(quotas).slice(0, 300)}`);
  void round;
  return problems;
}

test('шаг 65: хаос — процессы убиваются посреди работы, канал портит ответы, после каждого раунда инварианты целы', { timeout: 120 * 60_000 }, async () => {
  const violations: string[] = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const faults = {
      timeoutAfterApply: plan() < 0.6 ? between(10, 35) / 100 : 0,
      itemServerError: plan() < 0.6 ? between(10, 35) / 100 : 0,
      dropMidResponse: plan() < 0.6 ? between(5, 25) / 100 : 0,
      bulk500AfterApply: plan() < 0.5 ? between(10, 30) / 100 : 0,
      duplicateOrderLine: plan() < 0.6 ? between(20, 60) / 100 : 0,
      killDispatcherOnWrite: plan() < 0.7 ? between(5, 20) / 100 : 0,
    };
    currentRound = round;
    killOnWriteShare = faults.killDispatcherOnWrite;
    live.simulator.resumeMarket(Date.now());
    live.simulator.params.faults = { writeTimeoutShare: faults.timeoutAfterApply, timeoutAppliedShare: 1, bulkItemMissingShare: 0, bulkItemServerErrorShare: faults.itemServerError };
    chaos.dropMidResponseShare = faults.dropMidResponse; chaos.bulk500AfterApplyShare = faults.bulk500AfterApply; chaos.duplicateOrderLineShare = faults.duplicateOrderLine;
    const roundKills: Array<{ kind: ProcessKind; atMs: number }> = [];
    const actions: string[] = [];
    const roundStart = Date.now();
    let nextKill = roundStart + between(3_000, 9_000);
    let nextAction = roundStart + between(1_000, 4_000);
    let nextForce = roundStart;
    while (Date.now() - roundStart < WINDOW_MS) {
      if (Date.now() >= nextForce) { await jobsDueNow(); nextForce = Date.now() + 7_000; }
      // Диспетчер, убитый моделью в момент записи, поднимается снова — как его поднял бы перезапуск контейнера
      for (const kind of PROCESSES) if (!alive(procs.get(kind))) await start(kind);
      if (Date.now() >= nextAction) {
        actions.push(await sellerImportsStock().catch((e: unknown) => `console: ${String((e as Error).message).slice(0, 60)}`));
        nextAction = Date.now() + between(2_000, 5_000);
      }
      if (Date.now() >= nextKill) {
        // Диспетчер — вдвое чаще: его смерть посреди отправки — главный путь к потере или повтору записи
        const kind = KILL_WEIGHTS[between(0, KILL_WEIGHTS.length - 1)]!;
        const atMs = Date.now() - roundStart;
        await kill(kind);
        roundKills.push({ kind, atMs });
        kills.push({ round, kind, atMs });
        if (kind === 'scheduler') await expireSchedulerLeases();
        await sleep(between(300, 2_000));
        await start(kind);
        nextKill = Date.now() + between(3_000, 7_000);
      }
      await sleep(250);
    }
    const settled = await quiesce(round);
    const problems = settled.drained ? await invariants(round) : [`queue did not drain in ${QUIESCE_LIMIT_MS / 1000} s: ${JSON.stringify(settled.left).slice(0, 600)}`];
    const entry = { round, seed: SEED, faults, kills: roundKills, killedOnWrite: kills.filter((k) => k.round === round && k.atMs === -1).length, actions, quiesceMs: settled.waitedMs, budgetRowsChecked: lastBudgetRows, problems, knownOq220: oq220Seen.size, journal: journal.length, violations: model.violations.slice(0, 3) };
    report.push(entry);
    console.log(JSON.stringify({ chaosRound: entry }));
    violations.push(...problems.map((p) => `round ${round} (seed ${SEED}): ${p}`));
  }
  assert.deepEqual(model.violations.filter((v) => /Signature|Client-Key|Timestamp|leaked/.test(v)), [], 'ни один запрос процессов не отвергнут проверкой подписи');
  assert.ok(kills.length >= ROUNDS, `процессы убивались: ${kills.length}`);
  // Ревью шага 65, находка 3: «убийство в момент записи» — не намерение плана, а событие: при ненулевой доле и записях оно обязано случиться
  const planned = report.filter((r) => ((r.faults as { killDispatcherOnWrite: number }).killDispatcherOnWrite ?? 0) > 0).length;
  const killedOnWrite = report.reduce((n, r) => n + (r.killedOnWrite as number), 0);
  if (planned > 0 && journal.length > 20) assert.ok(killedOnWrite >= 1, `диспетчер убит в момент записи: ${killedOnWrite} (раундов с долей: ${planned})`);
  assert.deepEqual(violations, [], `инварианты после раундов хаоса (seed ${SEED})`);
});

/**
 * Положительные контроли [Р-94]: инвариант, который не может покраснеть, ничего не доказывает. После раундов мир чист (это утвердил
 * первый тест); здесь его портят по одному виду за раз — так, как испортил бы дефект, — и каждая проверка обязана назвать свою порчу
 */
test('шаг 65: каждый инвариант хаоса краснеет на своей порче', async () => {
  const t = live.seeded.tenantId;
  const expectProblem = async (label: string, pattern: RegExp) => {
    const found = await invariants(0);
    assert.ok(found.some((p) => pattern.test(p)), `${label}: проверка не назвала порчу — ${JSON.stringify(found).slice(0, 400)}`);
  };
  assert.deepEqual(await invariants(0), [], 'до порчи мир чист');

  // b) запрос записи в канал, которого нет в учёте попыток, — «отправлено мимо учёта»
  const [attempts] = await db.rows<{ price: number }>(`SELECT coalesce(sum(attempt_count) FILTER (WHERE field = 'PRICE'), 0)::int AS price FROM
      (SELECT field, attempt_count FROM tenant_data.channel_write_history WHERE tenant_id = $1 UNION ALL SELECT field, attempt_count FROM tenant_data.channel_write WHERE tenant_id = $1) w`, [t]);
  const sent = journal.reduce((n, e) => n + e.units.filter((u) => u.priceMinor !== null).length, 0);
  const extra = Array.from({ length: attempts!.price - sent + 1 }, () => ({ atMs: Date.now(), route: 'PATCH /v2/units/{id}', units: [{ idUnit: 1, storefront: 'de', priceMinor: 1999, amount: null }], delivered: 'REPLY' as const, status: 200 }));
  journal.push(...extra);
  await expectProblem('b) отправка мимо учёта', /^b\) price writes reached the channel/);
  journal.splice(journal.length - extra.length, extra.length);

  // a) число строк журнала только на добавление уменьшилось (подмена счёта прошлого раунда — та же арифметика, что у удаления)
  const [first] = Object.keys(previousCounts);
  previousCounts[first!] = (previousCounts[first!] ?? 0) + 1000;
  await expectProblem('a) журнал похудел', new RegExp(`^a\\) ${first!.replace('.', '\\.')}: rows`));

  // Дальше порча — данными базы, мимо стражей (суперпользователь, триггеры выключены в своём соединении): так выглядел бы дефект
  // a) пропуск номера outbox единицы
  await db.superuser(`SET session_replication_role = replica;
    DELETE FROM tenant_data.outbox_event WHERE (tenant_id, outbox_event_id) IN (SELECT tenant_id, outbox_event_id FROM tenant_data.outbox_event
     WHERE tenant_id = '${t}' AND scope_seq = 1 LIMIT 1);`);
  await expectProblem('a) пропуск outbox', /^a\) outbox seq gaps/);

  // b) потерянная версия записи
  await db.superuser(`SET session_replication_role = replica;
    DELETE FROM tenant_data.channel_write_history WHERE (tenant_id, channel_write_id) IN (SELECT tenant_id, channel_write_id FROM tenant_data.channel_write_history
     WHERE tenant_id = '${t}' AND version = 1 LIMIT 1);`);
  await expectProblem('b) потерянная версия', /^b\) versions lost or doubled/);

  // c) открытая строка заказа без резервации
  const open = live.simulator.openOrderLines();
  assert.ok(open.length > 0, 'у канала есть открытые строки заказов — иначе контролю нечего портить');
  await db.superuser(`SET session_replication_role = replica;
    DELETE FROM channel_data.reservation WHERE tenant_id = '${t}' AND channel_order_line_ref = '${open[0]!.idOrderUnit}';`);
  await expectProblem('c) строка без резервации', new RegExp(`^c\\) open order line ${open[0]!.idOrderUnit} reserved 0`));

  // d) цену в канале поменял кто-то другой — расхождение не записано
  // Единица с применённой ценой: только у неё «наша цель» известна, и расхождение есть с чем сравнивать
  const [priced] = await db.rows<{ unit: string; storefront: string }>(`SELECT om.external_unit_id AS unit, om.marketplace AS storefront FROM tenant_data.offer_mapping om
      WHERE om.tenant_id = $1 AND EXISTS (SELECT 1 FROM tenant_data.channel_write_history h WHERE h.tenant_id = om.tenant_id AND h.write_scope_id = om.price_write_scope_id AND h.final_status = 'APPLIED')
      ORDER BY 1 LIMIT 1`, [t]);
  assert.ok(priced, 'у мира есть единица с применённой ценой — иначе контролю нечего портить');
  const unit = (live.simulator.dump() as { units: Array<{ idUnit: number; storefront: string; listingPriceMinor: number }> }).units
    .find((u) => String(u.idUnit) === priced.unit && u.storefront === priced.storefront)!;
  live.simulator.reply({ method: 'PATCH', rawUrl: `http://model/v2/units/${unit.idUnit}?storefront=${unit.storefront}`, path: `/v2/units/${unit.idUnit}`,
    query: { storefront: unit.storefront }, rawBody: JSON.stringify({ listing_price: unit.listingPriceMinor + 77 }), body: { listing_price: unit.listingPriceMinor + 77 }, headers: {} } as never, Date.now());
  await expectProblem('d) чужая цена в канале', new RegExp(`^d\\) PRICE ${unit.idUnit}: the channel holds ${unit.listingPriceMinor + 77}`));

  /**
   * d) количество в канале ниже нашего, и это НЕ объясняется отменами (OQ-220): разница больше всех отмен предложения — признание OQ-220
   * не должно глотать любое расхождение количества (шаг 67)
   */
  const quantityScopes = await db.rows<{ unit: string; storefront: string; offer: string; quantity: number }>(
    `SELECT om.external_unit_id AS unit, om.marketplace AS storefront, om.external_offer_id AS offer, ap.quantity FROM tenant_data.offer_mapping om
       CROSS JOIN LATERAL (SELECT h.quantity FROM tenant_data.channel_write_history h WHERE h.tenant_id = om.tenant_id AND h.write_scope_id = om.quantity_write_scope_id
                            AND h.final_status = 'APPLIED' ORDER BY h.version DESC LIMIT 1) ap
      WHERE om.tenant_id = $1 ORDER BY 1`, [t]);
  // Разница — на две больше ВСЕХ отмен предложения: ни одно число неувиденных отмен с ней не совпадёт
  const counted = quantityScopes.find((q) => q.quantity - live.simulator.orderHistory(q.offer).filter((o) => o.status === 'cancelled').length - 2 >= 0);
  assert.ok(counted, 'у мира есть единица с применённым количеством — иначе контролю нечего портить');
  const lowered = counted.quantity - live.simulator.orderHistory(counted.offer).filter((o) => o.status === 'cancelled').length - 2;
  live.simulator.reply({ method: 'PATCH', rawUrl: `http://model/v2/units/${counted.unit}?storefront=${counted.storefront}`, path: `/v2/units/${counted.unit}`,
    query: { storefront: counted.storefront }, rawBody: JSON.stringify({ amount: lowered }), body: { amount: lowered }, headers: {} } as never, Date.now());
  await expectProblem('d) количество ниже нашего не по отменам', new RegExp(`^d\\) QUANTITY ${counted.unit}: the channel holds ${lowered}`));

  // d) последняя запись завершена не применением и БЕЗ причины — дефект «запись исчезла молча»
  // Последняя версия своей единицы — именно её смотрит проверка «завершена без причины»
  const [lastPrice] = await db.rows<{ id: string }>(`SELECT h.channel_write_id AS id FROM tenant_data.channel_write_history h
      WHERE h.tenant_id = $1 AND h.field = 'PRICE' AND h.final_status = 'APPLIED'
        AND h.version = (SELECT max(x.version) FROM tenant_data.channel_write_history x WHERE x.tenant_id = h.tenant_id AND x.write_scope_id = h.write_scope_id)
      LIMIT 1`, [t]);
  assert.ok(lastPrice, 'есть применённая запись цены — контролю есть что портить');
  await db.superuser(`SET session_replication_role = replica;
    UPDATE tenant_data.channel_write_history SET final_status = 'NOT_APPLIED', end_reason = NULL, last_error_code = NULL
     WHERE tenant_id = '${t}' AND channel_write_id = '${lastPrice!.id}';`);
  await expectProblem('d) запись исчезла без причины', /^d\) PRICE \S+: the last write ended NOT_APPLIED without a reason/);

  // e) бюджет правок насчитал попытку, которой не было
  await db.superuser(`SET session_replication_role = replica;
    INSERT INTO tenant_data.edit_budget (tenant_id, channel_account_id, budget_scope_key, budget_day, edit_limit, attempts_price)
    VALUES ('${t}', '${live.seeded.channelAccountId}', 'chaos-control', current_date, 250, 1);`);
  await expectProblem('e) удвоенный бюджет', /^e\) edit budget doubled or negative/);
});
