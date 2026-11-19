import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PgPricingStore, PgShadowStore, seedPricingWorld, type PgPool, type SeededPricingWorld } from '../src/index.ts';
import { createIsolatedDatabase, type IsolatedDatabase } from './isolated-db.ts';

/**
 * Шаг 173 (#35): чеклисту готовности от тени нужны два поля — свойства витрин аккаунтов и закрытая для боевых записей база. На QA-A маршрут
 * чеклиста читал ради них страницу тени целиком (сводка недели, график, дайджесты) — 2,2 с, журнал медленных запросов. Лёгкое чтение отдаёт
 * ровно те же поля тем же запросом. Данные синтетические
 */
const ACCOUNT = '20000000-0000-4000-8000-000000000173';
const US = 'ATVPDKIKX0DER';
let db: IsolatedDatabase;
let pool: PgPool;
let admin: PgPool;
let world: SeededPricingWorld;

before(async () => {
  db = await createIsolatedDatabase('step173');
  pool = db.pool('svc_app');
  admin = db.pool('svc_admin', 2);
  world = await seedPricingWorld(pool, { provisioningPool: db.pool('svc_provisioning', 1), adminPool: admin,
    fixtureTenantId: '10000000-0000-4000-8000-000000000173', fixtureChannelAccountId: ACCOUNT, fixtureChannel: 'AMAZON', fixtureRegion: 'US',
    fixtureExternalAccountId: `A1SYN173${Date.now().toString(36).toUpperCase()}`, marketplaces: [US], writeMode: 'SHADOW', clock: new Date().toISOString(), seed: { scopes: [] } });
  void new PgPricingStore(pool, { adminPool: admin });
});
after(async () => { await db?.drop(); });

test('step 173: the readiness inputs are the storefront properties and the live-writes guard of the shadow page — without the week summary', async () => {
  const shadow = new PgShadowStore({ adminPool: admin });
  const page = await shadow.shadowPage(world.tenantId, new Date().toISOString() as never, { offset: 0, limit: 1 });
  const inputs = await shadow.readinessInputs(world.tenantId);
  assert.ok(inputs.properties.some((p) => p.marketplace === US), `amazon.com has storefront properties: ${JSON.stringify(inputs.properties.map((p) => [p.marketplace, p.property, p.status]))}`);
  assert.deepEqual(inputs, { properties: page.properties, liveWritesRefused: page.liveWritesRefused }, 'the same fields as the shadow page');
});
