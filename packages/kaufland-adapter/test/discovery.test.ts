import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChannelAccountId, TenantId } from '@repracer/channel-port';
import { createKauflandAdapter } from '../src/index.ts';
import { OFFER_TITLE_MAX } from '../src/mapping.ts';

/** Модульные проверки обнаружения адаптера Kaufland (шаг 69, OQ-249). Данные синтетические; форма ответа — UnitEmbedded и Product снимка 2026-09-14 */

const NOW = '2026-10-02T10:00:00.000Z';
const ctx = { tenantId: '10000000-0000-4000-8000-000000000001' as TenantId, channelAccountId: '20000000-0000-4000-8000-000000000001' as ChannelAccountId, correlationId: 'unit', deadline: '2026-10-02T10:05:00.000Z' };

test('step 69 (OQ-249): discovery takes the product title from product.title of the unit embedded by embedded=products — trimmed, capped, absent when missing or blank; no extra call', async () => {
  const long = `Synthetisches Produkt ${'y'.repeat(300)}`;
  const unit = (id: number, product: Record<string, unknown> | undefined) => ({
    id_unit: id, storefront: 'de', currency: 'EUR', condition: 'new', listing_price: 1999, amount: 2, id_offer: `SYN-${id}`, id_product: 900 + id,
    fulfillment_type: 'fulfilled_by_merchant', is_live: true, ...(product ? { product } : {}),
  });
  const seen: URL[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    return new Response(JSON.stringify({ data: [
      unit(1, { id_product: 901, storefront: 'de', title: '  Synthetisches\n Produkt\t 1 ', eans: [] }),
      unit(2, { id_product: 902, storefront: 'de', eans: [] }),
      unit(3, { id_product: 903, storefront: 'de', title: ' ', eans: [] }),
      unit(4, undefined),
      unit(5, { id_product: 905, storefront: 'de', title: long, eans: [] }),
    ] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const adapter = createKauflandAdapter({
    deps: {
      accounts: { verify: async (tenantId, channelAccountId) => ({ ok: true, account: { tenantId, channelAccountId, channel: 'KAUFLAND', externalAccountId: 'syn-seller', marketplaces: ['de'], credentialsRef: 'cred:seller' } }) },
      credentials: { get: async (): Promise<Record<string, string>> => ({ clientKey: 'syn-client-key', secretKey: 'syn-secret-key' }) },
      alerts: { raise: async () => {} },
      logger: { log: () => {} },
      now: () => NOW,
    },
    userAgent: 'repracer-test/1.0', subscriptionFallbackEmail: 'ops@example.invalid', fetch: fetchFn, timeoutMs: 1000,
  });
  const page = await adapter.discoverOffers(ctx, { limit: 10 });
  assert.deepEqual(page.items.map((i) => i.identity.externalUnitId), ['1', '2', '3', '4', '5']);
  const [one, noTitle, blank, noProduct, capped] = page.items;
  assert.equal(one!.title, 'Synthetisches Produkt 1', 'whitespace and control characters collapse to one space, edges trimmed');
  for (const o of [noTitle!, blank!, noProduct!]) {
    assert.equal(o.title, undefined, `unit ${o.identity.externalUnitId}: no title from the channel`);
    assert.ok(!('title' in o), `unit ${o.identity.externalUnitId}: the key is absent, not an empty string`);
  }
  assert.equal(Array.from(capped!.title!).length, OFFER_TITLE_MAX);
  assert.ok(long.startsWith(capped!.title!));
  assert.equal(seen.length, 1, 'the title comes from the units page itself — no product call');
  assert.equal(seen[0]!.pathname, '/v2/units');
  assert.equal(seen[0]!.searchParams.get('embedded'), 'products', 'the product (and its title) is embedded by the query discovery already makes');
});
