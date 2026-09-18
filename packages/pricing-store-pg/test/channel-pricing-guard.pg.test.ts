import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, test } from 'node:test';
import { standUserOf, type MemorySeedScope } from '@repracer/pricing-pipeline';
import { createPool, inTenant, PgPricingStore, seedPricingWorld } from '../src/index.ts';
import { engineCost } from './drafts.ts';

/**
 * Ревью шага 23, находки 1 и 3 [Р-120]: ценообразование канала у предложения не мешает выключить репрайсинг, но не даёт включить его
 * и не даёт привязать предложение к единице со стратегией в режиме ENGINE (обход при создании единицы). Данные синтетические.
 */
const PG_URL = process.env.REPRACER_PG_URL;
if (!PG_URL) throw new Error('REPRACER_PG_URL is required: database tests do not skip (Р-84)');
const pool = createPool(PG_URL, { max: 4, applicationName: 'repracer-step23-guard' });
const provisioning = createPool(PG_URL.replace('svc_app@', 'svc_provisioning@'), { max: 1, applicationName: 'repracer-step23-guard-provisioning' });
const admin = createPool(PG_URL.replace('svc_app@', 'svc_admin@'), { max: 2, applicationName: 'repracer-step23-guard-admin' });
after(async () => { await pool.end(); await provisioning.end(); await admin.end(); });

const DE = 'A1PA6795UKMFR9';
const ACCOUNT = '20000000-0000-4000-8000-000000000239';
const scope = (sku: string): MemorySeedScope => ({
  writeScopeId: `ws-${sku}`, productId: `prod-${sku}`, channelAccountId: ACCOUNT, marketplace: DE, externalUnitId: sku, channelProductRef: 'B000023901',
  condition: 'new', currency: 'EUR', basis: 'GROSS', pricingMode: 'ENGINE', cost: engineCost(),
  strategy: { strategyId: 'st-fixed', version: 1, params: { type: 'FIXED', priceMinor: 2000 }, deadbandMinor: 0 },
  currentPriceMinor: 1850, minPrice: { amountMinor: 1500, id: `min-${sku}` }, maxPrice: { amountMinor: 2500, id: `max-${sku}` },
});

async function world() {
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const sku = `SYN-SKU-G${tag}`;
  const w = await seedPricingWorld(pool, {
    provisioningPool: provisioning, adminPool: admin, fixtureTenantId: '10000000-0000-4000-8000-000000000239', fixtureChannelAccountId: ACCOUNT,
    fixtureChannel: 'AMAZON', fixtureRegion: 'EU', fixtureExternalAccountId: `A1SYNG${tag}`, marketplaces: [DE], clock: new Date().toISOString(), seed: { scopes: [scope(sku)] },
  });
  const accountId = w.ids.dbId(ACCOUNT);
  const observe = (externalSku: string) => inTenant(pool, w.tenantId, (tx) => tx.query(
    `INSERT INTO channel_data.offer_channel_pricing (tenant_id, channel_account_id, channel, marketplace, external_sku, automated_pricing, channel_bounds, source, observed_at)
     VALUES ($1, $2, 'AMAZON', $3, $4, true, false, 'DISCOVERY', now())`, [w.tenantId, accountId, DE, externalSku]));
  return { w, sku, ws: w.ids.dbId(`ws-${sku}`), accountId, observe, owner: w.ids.dbId(standUserOf('membership-owner')) };
}

const outcome = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return String((e as Error).message); } };

test('finding 1 [Р-120]: channel-owned pricing does not block switching repricing off, but blocks switching it on', async () => {
  const { w, sku, ws, observe, owner } = await world();
  const store = new PgPricingStore(pool, { adminPool: admin });
  await observe(sku);
  assert.equal(await outcome(store.setPricingMode(w.tenantId, ws, 'OFF', owner)), 'OK', 'finding 1: switching repricing off is not refused by channel-owned pricing');
  await assert.rejects(store.setPricingMode(w.tenantId, ws, 'ENGINE', owner), /has channel-owned pricing \(CHANNEL_REPRICER_ACTIVE\)/,
    'Р-120: repricing is not switched on for an offer the channel prices itself');
});

test('finding 3 [Р-120]: an offer the channel prices itself is not mapped to a write scope that already prices with a strategy', async () => {
  const { w, ws, accountId, observe, owner } = await world();
  const fresh = `SYN-SKU-N${randomBytes(3).toString('hex').toUpperCase()}`;
  await observe(fresh);
  // Обход, найденный ревьюером: единица со стратегией включается в ENGINE до привязки предложения (стражу назначения нечего проверять),
  // затем привязывается предложение, у которого канал уже ведёт цену
  const mapped = inTenant(admin, w.tenantId, async (tx) => {
    const { rows: [created] } = await tx.query(
      `INSERT INTO tenant_data.product (tenant_id, product_id, sku, kind) VALUES ($1, gen_random_uuid(), $2, 'SIMPLE') RETURNING product_id`, [w.tenantId, `syn-${fresh}`]);
    const { rows: [scopeRow] } = await tx.query(
      `INSERT INTO tenant_data.write_scope (tenant_id, write_scope_id, channel_account_id, channel, field, product_id, capability_id, capability_version, scope_kind, scope_key,
                                            currency, price_basis, tax_regime, pricing_mode, status, pricing_strategy_id, pricing_strategy_version)
       SELECT s.tenant_id, gen_random_uuid(), s.channel_account_id, s.channel, 'PRICE', $3, s.capability_id, s.capability_version, s.scope_kind,
              tenant_data.derive_scope_key(jsonb_build_object('region', 'EU', 'marketplace', $4::text, 'external_sku', $5::text), c.write_scope_key_template),
              s.currency, s.price_basis, s.tax_regime, 'OFF', 'ACTIVE', s.pricing_strategy_id, s.pricing_strategy_version
         FROM tenant_data.write_scope s JOIN platform.channel_capability c ON c.capability_id = s.capability_id AND c.version = s.capability_version
        WHERE s.tenant_id = $1 AND s.write_scope_id = $2 RETURNING write_scope_id, currency, price_basis`,
      [w.tenantId, ws, created.product_id, DE, fresh]);
    for (const [table, amount] of [['min_price', 1500], ['max_price', 2500]] as const) {
      await tx.query(
        `INSERT INTO tenant_data.${table} (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, is_active, version, created_by_membership_id)
         VALUES ($1, 'WRITE_SCOPE', $2, $3, $4, $5, true, 1, $6)`,
        [w.tenantId, scopeRow.write_scope_id, scopeRow.currency, scopeRow.price_basis, amount, w.ownerMembershipId]);
    }
    // Р-131 (шаг 27): без объявленной себестоимости движок не включается — проверка не о ней, поэтому себестоимость объявлена
    await tx.query(
      `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, version, valid_from, currency, purchase_cost_minor, source, created_by_membership_id)
       VALUES ($1, $2, 1, now() - interval '1 day', $3, 100, 'MANUAL', $4)`,
      [w.tenantId, created.product_id, scopeRow.currency, w.ownerMembershipId]);
    await tx.query(`UPDATE tenant_data.write_scope SET pricing_mode = 'ENGINE' WHERE tenant_id = $1 AND write_scope_id = $2`, [w.tenantId, scopeRow.write_scope_id]);
    await tx.query(
      `INSERT INTO tenant_data.offer_mapping (tenant_id, product_id, channel_account_id, channel, region, marketplace, channel_offer_key, external_sku, channel_product_ref, condition, status, price_write_scope_id)
       VALUES ($1, $2, $3, 'AMAZON', 'EU', $4, $5, $6, 'B000023902', 'NEW', 'ACTIVE', $7)`,
      [w.tenantId, created.product_id, accountId, DE, `offer:${fresh}`, fresh, scopeRow.write_scope_id]);
  }, owner, { mfa: true });
  await assert.rejects(mapped, /has channel-owned pricing \(CHANNEL_REPRICER_ACTIVE\)/, 'finding 3: an offer with channel-owned pricing is mapped to a strategy write scope');
});
