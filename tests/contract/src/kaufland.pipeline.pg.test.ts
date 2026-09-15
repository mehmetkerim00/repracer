import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPool } from '@repracer/pricing-store-pg';
import { kauflandUnderTest } from './adapters.ts';
import { pgStoreFactory } from './harness/pg-store.ts';
import { runScenario } from './harness/runner.ts';
import { loadScenarios } from './harness/scenario.ts';

/**
 * Те же сценарии пути решения, но хранилище — настоящая PostgreSQL со всеми миграциями (OQ-89):
 * RLS с FORCE, append-only, триггеры версий, отложенные проверки границ.
 * REPRACER_PG_URL — роль приложения (repracer_app) в одноразовой базе; без переменной сценарии пропускаются.
 */

const PG_URL = process.env.REPRACER_PG_URL;
const FIXTURES = fileURLToPath(new URL('../fixtures/kaufland/', import.meta.url));
const pool = PG_URL ? createPool(PG_URL, { max: 4, applicationName: 'repracer-contract-pg' }) : null;
// Р-84: без базы тест не пропускается, а падает
if (!pool) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
// Обход диспетчера записей — роль svc_dispatcher (test/setup.sql) в той же базе
const scanPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_dispatcher@'), { max: 2, applicationName: 'repracer-contract-pg-dispatcher' }) : null;
// Курсы ЕЦБ сценариев — справочник платформы, загружает роль svc_fx_loader
const fxLoaderPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_fx_loader@'), { max: 1, applicationName: 'repracer-contract-pg-fx' }) : null;
// Р-90: остановки и снятия сценариев — административный сервис; тенанты — роль создания тенанта
const adminPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-contract-pg-admin' }) : null;
const provisioningPool = PG_URL ? createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-contract-pg-provisioning' }) : null;

after(async () => {
  await pool?.end();
  await scanPool?.end();
  await fxLoaderPool?.end();
  await adminPool?.end();
  await provisioningPool?.end();
});

// memory-only: сценарий опирается на отсутствие общих справочных данных платформы (курсов), которые в общей базе стенда
// засевают другие сценарии. На PostgreSQL этот случай НЕ проверяется (OQ-145); fx-day-boundary.pg.test.ts проверяет другой случай —
// устаревший курс, а не отсутствующий
for (const { file, scenario } of loadScenarios(FIXTURES).filter(({ scenario }) => scenario.world.pricing && !scenario.tags.includes('memory-only'))) {
  test(`[pg] ${scenario.id} [${file}]`, {}, async () => {
    const report = await runScenario(scenario, kauflandUnderTest, undefined, pgStoreFactory(pool!, scanPool!, fxLoaderPool!, { adminPool: adminPool!, provisioningPool: provisioningPool! }));
    const trace = report.trace.map((t) => `  ${t.method} ${t.path} → ${t.exchangeId ?? '-'} ${t.outcome}`).join('\n');
    assert.deepEqual(report.failures, [], `${report.failures.join('\n')}\ntrace:\n${trace}`);
  });
}
