import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BulkJobRow } from '@repracer/pricing-pipeline';
import { InMemoryStockStore, type StockStore } from '@repracer/stock-sync';
import { bulkJobHandlers } from '../src/handlers.ts';
import type { BulkJobContext } from '../src/index.ts';

/**
 * Красный хаос полного прогона шага 97 (CI 38957827994, семя 2054262221, раунд 4): «в канале 22, наша цель 14, и записи в пути нет».
 * Механизм — задание импорта остатков продавца: инвентаризация пула и пересчёт публикуемого количества — РАЗНЫЕ транзакции. Исполнитель
 * заданий, убитый между ними, оставляет пул изменённым без пересчёта; задание после истечения аренды повторяется, но тот же файл уже ничего
 * не меняет — у импорта «изменившихся товаров» нет, и пересчёт не зовётся никогда. Цель меняется, записи нет. Inbound API это правило знает
 * давно: пересчитываются все узнанные товары, а не только изменённые. Данные синтетические.
 */

const TENANT = 't-chaos';
const actor = { membershipId: 'm-owner', userId: 'u-owner', mfa: true };

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
  const handlers = bulkJobHandlers({ stock: crashing, world: async () => ({ now: '2026-10-17T10:00:00.000Z' }) as never } as never);
  return { stock, handlers, recalculated, crash: () => { crashAfterImport = true; } };
}

const job = (stockSourceId: string, csv: string, attempts: number): BulkJobRow => ({
  jobId: 'bf000000-0000-4000-8000-000000000097', kind: 'STOCK_IMPORT', status: 'RUNNING', phase: 'PREPARING', totalItems: null, doneItems: 0,
  params: { fileName: 'stock.csv', content: Buffer.from(csv).toString('base64'), stockSourceId }, result: null, errorCode: null, attempts,
  createdWithMfa: true, createdByMembershipId: actor.membershipId, createdByUserId: actor.userId, createdAt: '2026-10-17T09:59:00.000Z', startedAt: null,
} as unknown as BulkJobRow);
const ctx = { tenantId: TENANT, jobId: 'bf000000-0000-4000-8000-000000000097', membershipId: actor.membershipId, userId: actor.userId, store: {} } as unknown as BulkJobContext;

async function runJob(handlers: ReturnType<typeof bulkJobHandlers>, row: BulkJobRow) {
  const work = await handlers.STOCK_IMPORT!(row, ctx);
  return work.run(async () => undefined, (async () => { throw new Error("no file in a stock import"); }) as never);
}

test('chaos 2054262221: a stock import retried after a death between the stocktake and the recalculation still recalculates the product', async () => {
  const w = world();
  const source = await w.stock.createStockSource(TENANT, { mode: 'INTERNAL_POOL', name: 'Warehouse' }, actor);
  assert.equal(source.status, 'CREATED');
  const sourceId = (source as { stockSourceId: string }).stockSourceId;
  await runJob(w.handlers, job(sourceId, 'SKU,Quantity\r\n100001,22', 1));
  assert.deepEqual(w.recalculated.at(-1), ['p-100001'], 'the first import recalculates the changed product');

  // Продавец загружает новый файл; исполнитель умирает после инвентаризации — пул уже 14, пересчёта не было
  w.crash();
  await assert.rejects(runJob(w.handlers, job(sourceId, 'SKU,Quantity\r\n100001,14', 1)), /SIGKILL/);
  const before = w.recalculated.length;
  // Аренда истекла — задание повторяется тем же файлом. Пул уже 14: «изменившихся» нет, а пересчитать товар всё равно нужно
  await runJob(w.handlers, job(sourceId, 'SKU,Quantity\r\n100001,14', 2));
  assert.equal(w.recalculated.length, before + 1, 'the retried import recalculates');
  assert.deepEqual(w.recalculated.at(-1), ['p-100001'], 'every matched product of the file is recalculated, not only the changed ones');
});
