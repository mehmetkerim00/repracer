import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BulkJobRow, ImportRunInput, ImportRunRow } from '@repracer/pricing-pipeline';
import { InMemoryStockStore, type StockStore } from '@repracer/stock-sync';
import { bulkJobHandlers } from '../src/handlers.ts';
import type { BulkJobContext } from '../src/index.ts';

/**
 * Красный хаос полного прогона шага 97 (CI 38957827994, семя 2054262221, раунд 4): «в канале 22, наша цель 14, и записи в пути нет».
 * Механизм — задание импорта остатков продавца: инвентаризация пула и пересчёт публикуемого количества — РАЗНЫЕ транзакции. Исполнитель
 * заданий, убитый между ними, оставляет пул изменённым без пересчёта; задание после истечения аренды повторяется, но тот же файл уже ничего
 * не меняет. Шаг 99 [Р-224]: применение — ровно примерка, и повтор задания видит строку журнала «применено» (она в той же транзакции, что
 * инвентаризация) — второй раз пул не трогается, а пересчёт по всем товарам файла делается снова. Данные синтетические.
 */

const TENANT = 't-chaos';
const actor = { membershipId: 'm-owner', userId: 'u-owner', mfa: true };
const NOW = '2026-10-17T10:00:00.000Z';

function world() {
  const stock = new InMemoryStockStore([
    { productId: 'p-100001', sku: '100001', channelAccountId: 'acc-k', channel: 'KAUFLAND', marketplaces: ['de'], externalOfferId: 'SYN-OFFER-100001' },
  ], { tenantId: TENANT, roleOf: () => 'OWNER' });
  const recalculated: Array<readonly string[] | null> = [];
  let crashAfterImport = false;
  // Падение процесса между двумя транзакциями: инвентаризация зафиксирована, до пересчёта дело не дошло
  const crashing = new Proxy(stock, {
    get(target, prop, receiver) {
      if (prop === 'recalculate') {
        return async (tenantId: string, productIds: readonly string[] | null, now: string) => {
          if (crashAfterImport) { crashAfterImport = false; throw Object.assign(new Error('SIGKILL between the stocktake and the recalculation'), { code: 'KILLED' }); }
          recalculated.push(productIds);
          return target.recalculate(tenantId, productIds, now as never);
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as StockStore;
  const handlers = bulkJobHandlers({ stock: crashing, world: async () => ({ id: 'w', now: NOW, accounts: [], state: { scopes: [], strategies: [], strategyVersions: [], members: [] } }) as never } as never);
  // Задания и журнал импортов — как у хранилища: одна строка журнала на задание
  const jobs = new Map<string, BulkJobRow>();
  const runs = new Map<string, ImportRunRow>();
  const store = {
    bulkJob: async (_t: string, id: string) => jobs.get(id) ?? null,
    importRunOfJob: async (_t: string, id: string) => runs.get(id) ?? null,
    recordImportRun: async (_t: string, run: ImportRunInput, a: { bulkJobId: string }) => {
      if (!runs.has(a.bulkJobId)) {
        runs.set(a.bulkJobId, { ...run, reason: run.reason ?? null, runId: `run-${runs.size + 1}`, bulkJobId: a.bulkJobId, createdByMembershipId: actor.membershipId,
          createdByUserId: actor.userId, durationMs: 5, recordedAt: NOW });
      }
      return runs.get(a.bulkJobId)!;
    },
  };
  const ctxOf = (jobId: string) => ({ tenantId: TENANT, jobId, membershipId: actor.membershipId, userId: actor.userId, store }) as unknown as BulkJobContext;
  const row = (jobId: string, kind: BulkJobRow['kind'], params: Record<string, unknown>, extra: Partial<BulkJobRow> = {}): BulkJobRow => ({
    jobId, kind, status: 'RUNNING', phase: 'PREPARING', totalItems: null, doneItems: 0, params, result: null, errorCode: null, attempts: 1,
    createdWithMfa: true, createdByMembershipId: actor.membershipId, createdByUserId: actor.userId, createdAt: '2026-10-17T09:59:00.000Z', startedAt: null,
    finishedAt: null, leaseOwner: 'w', leaseUntil: null, leaseExpired: false, ...extra,
  });
  /** Примерка файла и затем применение ровно её — как через консоль */
  const check = async (n: number, stockSourceId: string, csv: string) => {
    const checkId = `bf000000-0000-4000-8000-0000000000c${n}`;
    const params = { importKind: 'STOCK', fileName: 'stock.csv', content: Buffer.from(csv).toString('base64'), stockSourceId };
    const work = await handlers.IMPORT_CHECK!(row(checkId, 'IMPORT_CHECK', params), ctxOf(checkId));
    const result = await work.run(async () => undefined, (async () => { throw new Error('no errors in this file'); }) as never);
    jobs.set(checkId, row(checkId, 'IMPORT_CHECK', params, { status: 'SUCCEEDED', result }));
    return { checkJobId: checkId, checkToken: String(result.token) };
  };
  const apply = async (applyId: string, checked: { checkJobId: string; checkToken: string }, attempts = 1) => {
    const work = await handlers.STOCK_IMPORT!(row(applyId, 'STOCK_IMPORT', checked, { attempts }), ctxOf(applyId));
    return work.run(async () => undefined, (async () => { throw new Error('no file in a stock import'); }) as never);
  };
  return { stock, recalculated, crash: () => { crashAfterImport = true; }, check, apply, runs };
}

test('chaos 2054262221, step 99: a stock import retried after a death between the stocktake and the recalculation recalculates and does not apply twice', async () => {
  const w = world();
  const source = await w.stock.createStockSource(TENANT, { mode: 'INTERNAL_POOL', name: 'Warehouse' }, actor);
  assert.equal(source.status, 'CREATED');
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  await w.apply('bf000000-0000-4000-8000-0000000000a1', await w.check(1, sourceId, 'SKU,Quantity\r\n100001,22'));
  assert.deepEqual(w.recalculated.at(-1), ['p-100001'], 'the first import recalculates the product');

  // Продавец загружает новый файл; исполнитель умирает после инвентаризации — пул уже 14, пересчёта не было
  const second = await w.check(2, sourceId, 'SKU,Quantity\r\n100001,14');
  w.crash();
  await assert.rejects(w.apply('bf000000-0000-4000-8000-0000000000a2', second), /SIGKILL/);
  assert.equal(w.runs.get('bf000000-0000-4000-8000-0000000000a2')?.outcome, 'APPLIED', 'the stocktake is recorded as applied');
  const before = w.recalculated.length;
  // Аренда истекла — задание повторяется. Пул уже 14: второй раз он не трогается, а пересчитать товар всё равно нужно
  const retried = await w.apply('bf000000-0000-4000-8000-0000000000a2', second, 2);
  assert.equal(retried.applied, 1, 'the retry reports the applied run, it does not apply again');
  assert.equal(w.recalculated.length, before + 1, 'the retried import recalculates');
  assert.deepEqual(w.recalculated.at(-1), ['p-100001'], 'every matched product of the file is recalculated, not only the changed ones');
});
