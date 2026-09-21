import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BulkJobOutcome, BulkJobProgress, BulkJobRow, PricingStore } from '@repracer/pricing-pipeline';
import { DEMO_FILE_PREFIX, DEMO_ROW_MARK, runNextBulkJob, type BulkJobHandlers } from '../src/index.ts';

/**
 * Р-139 (шаг 30): исполнитель фоновых заданий. Проверяется его собственное поведение — что он делает с заданием и что пишет в
 * хранилище, — поэтому хранилище здесь поддельное и записывает каждый вызов. Работу самих обработчиков проверяют тесты на
 * настоящей базе (`apps/console/test/console-live.pg.test.ts`): там она и имеет смысл.
 */

const TENANT = '10000000-0000-4000-8000-000000000301';

interface Recorded {
  progress: Array<BulkJobProgress>;
  outcome: BulkJobOutcome | null;
  claims: number;
}

function fakeStore(job: BulkJobRow | null, log: Recorded, demo = false): PricingStore {
  return {
    // Р-151: демо ли тенант, исполнитель спрашивает у базы — от этого зависит метка файла
    async tenantIsDemo() { return demo; },
    async claimBulkJob() {
      log.claims += 1;
      return log.claims === 1 ? job : null;
    },
    async updateBulkJobProgress(_t: string, _j: string, _o: string, p: BulkJobProgress) {
      log.progress.push({ ...p });
    },
    async finishBulkJob(_t: string, _j: string, _o: string, outcome: BulkJobOutcome) {
      log.outcome = outcome;
    },
  } as unknown as PricingStore;
}

const jobRow = (over: Partial<BulkJobRow> = {}): BulkJobRow => ({
  jobId: 'bf000000-0000-4000-8000-000000000001', kind: 'COST_IMPORT', status: 'RUNNING', params: {}, phase: 'PREPARING',
  totalItems: null, doneItems: 0, result: null, errorCode: null, attempts: 1, createdWithMfa: true,
  createdByMembershipId: 'm-1', createdByUserId: 'u-1', createdAt: '2026-09-19T10:00:00.000Z', startedAt: null,
  finishedAt: null, leaseOwner: 'worker-one', leaseUntil: '2026-09-19T10:01:00.000Z', leaseExpired: false, ...over,
});

const run = (store: PricingStore, handlers: BulkJobHandlers, now?: () => number, leaseSeconds = 30) =>
  runNextBulkJob({ store, tenantId: TENANT, owner: 'worker-one', handlers, leaseSeconds, ...(now ? { now } : {}) });

test('пустая очередь — исполнитель ничего не делает и говорит об этом', async () => {
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  assert.equal(await run(fakeStore(null, log), {}), null);
  assert.deepEqual([log.progress.length, log.outcome], [0, null], 'ни хода, ни итога у несуществующего задания не появляется');
});

test('вид задания, которого исполнитель не знает, завершается отказом с названной причиной, а не тишиной', async () => {
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  const done = await run(fakeStore(jobRow(), log), {});
  assert.deepEqual([done?.status, log.outcome], ['FAILED', { status: 'FAILED', errorCode: 'UNKNOWN_JOB_KIND' }]);
});

test('итог работы попадает в задание, а последний ход — всегда, как бы редко ход ни писался', async () => {
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  // Часы стоят: правило «не чаще раза в секунду» отбрасывает промежуточный ход, и это проверяется
  const handlers: BulkJobHandlers = {
    async COST_IMPORT() {
      return {
        total: 3,
        async run(progress) {
          await progress(1);
          await progress(2);
          await progress(3, 'APPLYING');
          return { rows: 3 };
        },
      };
    },
  };
  const done = await run(fakeStore(jobRow(), log), handlers, () => 1_000);
  assert.equal(done?.status, 'SUCCEEDED');
  assert.deepEqual(log.outcome, { status: 'SUCCEEDED', result: { rows: 3 } });
  /**
   * Первый ход — объявление объёма. Дальше правило «не чаще раза в секунду» пропускает промежуточный ход (2 из 3), а последний
   * пишется ВСЕГДА, независимо от того, сколько прошло времени: иначе продавец видел бы «6 200 из 10 000» у готового задания.
   */
  assert.deepEqual(log.progress.map((p) => [p.phase ?? null, p.done ?? null, p.total ?? null]),
    [['PREPARING', 0, 3], [null, 1, 3], ['APPLYING', 3, 3]], JSON.stringify(log.progress));
});

test('падение работы становится отказом задания с кодом причины, а текст ошибки в задание не попадает', async () => {
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  const handlers: BulkJobHandlers = {
    async COST_IMPORT() {
      return {
        total: 1,
        async run() {
          // Текст ошибки может содержать данные продавца; наружу идёт только код
          throw Object.assign(new Error('SKU-4711 стоит 19,99 €'), { cause: 'PLAN_CHANGED' });
        },
      };
    },
  };
  const done = await run(fakeStore(jobRow(), log), handlers);
  assert.equal(done?.status, 'FAILED');
  assert.deepEqual(log.outcome, { status: 'FAILED', errorCode: 'PLAN_CHANGED' });
  assert.ok(!JSON.stringify(log.outcome).includes('SKU-4711'), 'данные продавца в итог задания не попадают');
});

test('аренда продлевается, пока идёт работа: применение каталога длиннее срока аренды', async () => {
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  const handlers: BulkJobHandlers = {
    async COST_IMPORT() {
      return {
        total: 1,
        // Работа не пишет ход: применение каталога — одна транзакция. Аренду держит сердцебиение
        run: async () => { await new Promise((resolve) => setTimeout(resolve, 700)); return { rows: 1 }; },
      };
    },
  };
  // Аренда в секунду: сердцебиение бьёт каждые 500 мс, работа идёт 700 мс — без продления аренда истекла бы посреди неё
  const done = await run(fakeStore(jobRow(), log), handlers, () => Date.now(), 1);
  assert.equal(done?.status, 'SUCCEEDED');
  const beats = log.progress.filter((p) => p.done === undefined && p.leaseSeconds === 1);
  assert.ok(beats.length >= 1, `аренда продлевалась во время работы: ${JSON.stringify(log.progress)}`);
});

/**
 * Р-145 (шаг 32): имя и содержимое файла делает ИСПОЛНИТЕЛЬ, и расширение он ставит по виду содержимого, а не по имени,
 * которое дал обработчик. Дважды подряд ошиблись именно здесь: сначала отчёт по `report.csv` звался `report.csv.csv`, потом
 * отчёт по выгрузке `kosten.xlsx` стал бы `kosten.xlsx` с CSV внутри (находка 1 ревью шага 32). Утверждения на имя файла не
 * было ни одного — поэтому обе ошибки и доживали до замера.
 */
test('Р-145: файл собирает исполнитель — имя по виду содержимого, сумма по содержимому, строки экранированы', async () => {
  const saved: Array<{ fileName: string; content: string; sha256: string; rows: number; owner: string }> = [];
  const log: Recorded = { progress: [], outcome: null, claims: 0 };
  const store = {
    ...fakeStore(jobRow({ kind: 'PRICE_FEED_EXPORT' }), log),
    async saveBulkJobArtifact(_t: string, _j: string, a: { fileName: string; content: string; sha256: string; rows: number }, owner: string) {
      saved.push({ ...a, owner });
    },
  } as unknown as PricingStore;

  const handlers: BulkJobHandlers = {
    async PRICE_FEED_EXPORT() {
      return {
        total: 2,
        async run(_progress, produce) {
          return { ...await produce({
            // Обработчик даёт имя ИСХОДНОЙ выгрузки продавца — с чужим расширением и небезопасными символами
            fileName: 'import-report_kosten 2026.xlsx',
            header: ['a', 'b'],
            rows: [['=SUM(1)', 'x,y'], ['2', '3']],
          }) };
        },
      };
    },
  };
  const done = await run(store, handlers);

  assert.equal(done?.status, 'SUCCEEDED');
  assert.equal(saved.length, 1);
  const file = saved[0]!;
  assert.equal(file.fileName, 'import-report_kosten_2026.csv', 'расширение — по виду содержимого, а не по имени от обработчика');
  assert.equal(file.owner, 'worker-one', 'файл кладётся под АРЕНДОЙ: база иначе откажет [Р-145]');
  const { createHash } = await import('node:crypto');
  assert.equal(file.sha256, createHash('sha256').update(file.content).digest('hex'), 'сумма считается по тому, что записано');
  // Нейтрализация формул электронной таблицы — часть единственного пути, а не забота обработчика
  assert.match(file.content, /'=SUM\(1\)/, `формула нейтрализована: ${file.content}`);
  assert.match(file.content, /"x,y"/, `запятая внутри значения закавычена: ${file.content}`);
  assert.equal(log.outcome?.status === 'SUCCEEDED' && (log.outcome.result as { rows: number }).rows, 2);
});

/**
 * Р-151 (шаг 34; ревью шага, находка 4): файл демо-тенанта помечен в имени И в каждой строке — выгрузку пересылают и
 * переименовывают, и доказательство от синтетического тенанта не должно сойти за настоящее. Метку ставит исполнитель, а не
 * обработчик: обработчик ниже о демо не знает вовсе. У обычного тенанта тот же обработчик даёт файл без единой пометки.
 */
test('Р-151: файл демо-тенанта помечен в имени и в каждой строке; у обычного тенанта — ни одной пометки', async () => {
  const handlers: BulkJobHandlers = {
    async PRICE_FEED_EXPORT() {
      return { total: 2, async run(_progress, produce) { return { ...await produce({ fileName: 'price-feed.csv', header: ['a', 'b'], rows: [['1', '2'], ['3', '4']] }) }; } };
    },
  };
  const fileOf = async (demo: boolean) => {
    const saved: Array<{ fileName: string; content: string }> = [];
    const store = {
      ...fakeStore(jobRow({ kind: 'PRICE_FEED_EXPORT' }), { progress: [], outcome: null, claims: 0 }, demo),
      async saveBulkJobArtifact(_t: string, _j: string, a: { fileName: string; content: string }) { saved.push({ ...a }); },
    } as unknown as PricingStore;
    assert.equal((await run(store, handlers))?.status, 'SUCCEEDED');
    return saved[0]!;
  };

  const marked = await fileOf(true);
  assert.equal(marked.fileName, `${DEMO_FILE_PREFIX}price-feed.csv`);
  const lines = marked.content.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.length > 0);
  assert.equal(lines.length, 3, marked.content);
  assert.match(lines[0]!, /demo"?$/, `заголовок несёт колонку метки: ${lines[0]}`);
  assert.deepEqual(lines.slice(1).map((l) => l.includes(DEMO_ROW_MARK)), [true, true], 'помечена каждая строка');

  const plain = await fileOf(false);
  assert.equal(plain.fileName, 'price-feed.csv');
  assert.ok(!plain.content.includes(DEMO_ROW_MARK) && !/demo/i.test(plain.content), `у обычного тенанта пометок нет: ${plain.content}`);
});
