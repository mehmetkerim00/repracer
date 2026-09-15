import { PgPricingStore, PgWriteQueueStore, seedPricingWorld, translateStore, type PgPool } from '@repracer/pricing-store-pg';
import type { WriteQueueStore } from '@repracer/write-dispatcher';
import type { PricingStoreFactory } from './runner.ts';

/**
 * Хранилище пути решения на реальной PostgreSQL для сценариев стенда (OQ-89).
 * Каждый сценарий — новый синтетический тенант; идентификаторы сценария переводятся в UUID и обратно,
 * поэтому ожидания сценария одни и те же для хранилища в памяти и для базы.
 */
/**
 * Р-90: pool — роль пути решения (svc_app), adminPool — административного сервиса (остановки и снятия человеком),
 * provisioningPool — создания тенанта.
 */
export function pgStoreFactory(
  pool: PgPool, scanPool: PgPool, fxLoaderPool: PgPool,
  options: { memberUsers?: Readonly<Record<string, string>>; adminPool: PgPool; provisioningPool: PgPool },
): PricingStoreFactory {
  return async (seed, world) => {
    const seeded = await seedPricingWorld(pool, {
      fixtureTenantId: world.tenantId,
      fixtureChannelAccountId: world.channelAccountId,
      marketplaces: world.account.marketplaces,
      clock: world.clock,
      seed,
      fxLoaderPool,
      provisioningPool: options.provisioningPool,
      adminPool: options.adminPool,
      ...(options.memberUsers ? { memberUsers: options.memberUsers } : {}),
    });
    const inner = new PgPricingStore(pool, { adminPool: options.adminPool });
    const conflicts = [...(seed.commitConflicts ?? [])];
    const store = translateStore(inner, seeded.ids, {
      // Р-54: параллельное изменение границы между чтением и фиксацией — отдельной транзакцией, как второй пользователь
      commitEvaluation: async (_tenantId: string, input: { decisions: Array<{ context: { scope: { writeScopeId: string } } }> }) => {
        const i = conflicts.findIndex((c) => input.decisions.some((d) => d.context.scope.writeScopeId === c.writeScopeId));
        if (i < 0) return;
        const [conflict] = conflicts.splice(i, 1);
        await seeded.setBound(conflict!.writeScopeId, conflict!.bound, conflict!.value);
      },
    });
    // Очередь записей [Р-64]: обход идёт по всем тенантам базы, сценарий видит только свой тенант
    const writeQueue = new PgWriteQueueStore(pool, { scanPool });
    const queue = translateStore<WriteQueueStore>({
      claimNext: writeQueue.claimNext.bind(writeQueue),
      recordOutcome: writeQueue.recordOutcome.bind(writeQueue),
      recordReconciliation: writeQueue.recordReconciliation.bind(writeQueue),
      dueScopes: async (at, options) => (await writeQueue.dueScopes(at, options)).filter((d) => d.tenantId === seeded.tenantId),
    }, seeded.ids);
    const order = seed.scopes.map((s) => s.writeScopeId);
    return {
      store,
      queue,
      dump: async () => {
        const state = seeded.ids.fromDb(await inner.dumpState(seeded.tenantId));
        state.scopes.sort((a, b) => order.indexOf(a.writeScopeId) - order.indexOf(b.writeScopeId));
        return state;
      },
      setBound: (id, bound, value) => seeded.setBound(id, bound, value),
      setCost: (id, cost) => seeded.setCost(id, cost),
      close: async () => {},
      identity: { tenantId: seeded.tenantId, membershipAlias: (id) => seeded.ids.fromDb(id) },
    };
  };
}
