import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createPool, PgPricingStore, seedPricingWorld } from '../src/index.ts';

/**
 * Шаг 168 (находка снимков): строка «требует внимания» на Offers — те же причины, что считает строка состояния. На демо США строки
 * Walmart, снятые с публикации, были подсвечены (правило экрана), а строка состояния их не считала: условие «не продаётся» в базе сверяло
 * состояние предложения (`condition`) буквально — у наблюдения Walmart `new`, у предложения `NEW`. Во всех прочих местах хранилище сравнивает
 * `condition` без учёта регистра (`lower`). Данные синтетические
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL || !process.env.REPRACER_PG_ADMIN_URL) throw new Error('REPRACER_PG_URL and REPRACER_PG_ADMIN_URL are required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-step168' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-step168-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-step168-admin' });
after(async () => { await pool.end(); await provisioning.end(); await admin.end(); });

const DE = 'A1PA6795UKMFR9';

test('step 168: an offer unpublished by Walmart counts as «not buyable» whatever the case of its condition — the status line and the Offers filter', async () => {
  const now = new Date().toISOString();
  const scope = (n: number, condition: string) => ({
    writeScopeId: `ws-168-${n}`, productId: `p-168-${n}`, channelAccountId: '20000000-0000-4000-8000-000000000168', marketplace: DE,
    externalUnitId: `SYN-168-${n}`, channelProductRef: `B0SYN168${n}`, condition, currency: 'EUR', basis: 'GROSS' as const, pricingMode: 'OFF' as const,
    strategy: null, currentPriceMinor: 1999,
  });
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000168', fixtureChannelAccountId: '20000000-0000-4000-8000-000000000168',
    fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: `A1SYN168${Date.now().toString(36).toUpperCase()}`, marketplaces: [DE], clock: now,
    seed: { scopes: [scope(1, 'NEW'), scope(2, 'NEW')] },
  });
  const accountId = w.ids.dbId('20000000-0000-4000-8000-000000000168');
  const store = new PgPricingStore(pool, { adminPool: admin });
  const unpublished = (n: number, condition: string) => store.recordPricingHealth(w.tenantId, accountId, {
    marketplace: DE, channelProductRef: `B0SYN168${n}`, condition, issueType: 'WALMART_UNPUBLISHED_UNCOMPETITIVE_PRICE', occurredAt: now,
    sourceEventId: `syn-168-${n}`, competitivePriceThreshold: null,
  } as never);
  // Предложение 1 — наблюдение тем же регистром (контроль: проходит и на прежнем условии); предложение 2 — как у демо, `new` против `NEW`
  await unpublished(1, 'NEW');
  await unpublished(2, 'new');
  const facts = await store.consoleCatalogFacts(w.tenantId, { attention: { now } } as never);
  assert.equal(facts.attention?.byReason.NOT_BUYABLE, 2, `both unpublished offers are «not buyable» — ${JSON.stringify(facts.attention)}`);
  const state = await store.readConsoleState(w.tenantId, now as never);
  assert.equal(state.pricingHealth.length, 2, 'the screen reads both observations (its query compares the condition without case)');
});
