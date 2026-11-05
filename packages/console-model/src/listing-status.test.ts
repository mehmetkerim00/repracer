import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dataSourceText } from './connections.ts';
import { messagesFor } from './i18n/index.ts';
import { channelNotes } from './products.ts';
import type { StandWorld } from './world.ts';

/**
 * Шаг 114 на модели (данные синтетические): пилюля «Not buyable on Amazon» — по последнему статусу листинга из любого источника,
 * принудительные действия — словами, кодов на экране нет; строка Channels — уведомления за сутки по видам или «только опрос»
 */
const scope = { writeScopeId: 'ws-1', channelAccountId: 'acc-amazon', marketplace: 'ATVPDKIKX0DER', externalUnitId: 'SYN-SKU-1', channelProductRef: 'B0SYN00001', condition: 'new', currency: 'USD' };
const world = (listingStatus: unknown[]) => ({
  accounts: [{ channelAccountId: 'acc-amazon', channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }],
  state: { scopes: [scope], offerChannelPricing: [], pricingHealth: [], listingStatus },
}) as unknown as StandWorld;
const row = (over: Record<string, unknown>) => ({ channelAccountId: 'acc-amazon', marketplace: 'ATVPDKIKX0DER', externalSku: 'SYN-SKU-1', buyable: false, deleted: false,
  source: 'NOTIFICATION', observedAt: '2026-11-05T09:59:30.000Z', enforcementActions: null, ...over });

test('step 114: an offer Amazon does not sell carries the stop pill with what Amazon said in words — never its codes; a buyable one carries none', () => {
  for (const lang of ['en', 'de', 'es', 'fr'] as const) {
    const m = messagesFor(lang);
    const [note] = channelNotes(world([row({ enforcementActions: ['LISTING_SUPPRESSED', 'SOMETHING_NEW'] })]), scope as never, m);
    assert.equal(note?.code, 'LISTING_NOT_BUYABLE', lang);
    assert.equal(note?.tone, 'stop');
    assert.equal(note?.label, m.ui.channelNotes.notBuyable);
    for (const text of [note!.detail, note!.short!, note!.whatToDo!.text]) {
      assert.ok(!/LISTING_SUPPRESSED|SOMETHING_NEW|NOTIFICATION|BUYABLE/.test(text), `${lang}: no channel codes on screen — ${text}`);
    }
    assert.ok(note!.detail.includes(m.ui.channelNotes.enforcement.LISTING_SUPPRESSED) && note!.detail.includes(m.ui.channelNotes.enforcement.OTHER), `${lang}: ${note!.detail}`);
    assert.ok(note!.detail.includes(m.ui.channelNotes.listingSources.NOTIFICATION), 'the detail names where the status came from');
  }
  const en = messagesFor('en');
  assert.deepEqual(channelNotes(world([row({ buyable: true })]), scope as never, en), []);
  assert.deepEqual(channelNotes(world([row({ externalSku: 'SYN-SKU-2' })]), scope as never, en), [], 'another offer’s status is not this offer’s');
  assert.match(channelNotes(world([row({ deleted: true, source: 'DISCOVERY' })]), scope as never, en)[0]!.detail, /deleted \(catalog scan/);
});

test('step 114: Channels says where the data of an Amazon account comes from — notifications of the last 24 hours by kind, or polling only', () => {
  const en = messagesFor('en');
  assert.equal(dataSourceText(undefined, en), en.ui.connections.dataSource.polling);
  assert.equal(dataSourceText({ channelAccountId: 'a', lastReceivedAt: '2026-11-03T10:00:00.000Z', last24h: [] }, en), en.ui.connections.dataSource.polling, 'notifications older than a day — polling only');
  const text = dataSourceText({ channelAccountId: 'a', lastReceivedAt: '2026-11-05T09:59:30.000Z', last24h: [
    { notificationType: 'ANY_OFFER_CHANGED', count: 12 }, { notificationType: 'LISTINGS_ITEM_ISSUES_CHANGE', count: 1 }, { notificationType: 'LISTINGS_ITEM_STATUS_CHANGE', count: 2 },
  ] }, en);
  assert.match(text, /^Data source: Amazon notifications, the last one .+; in 24 hours: 12 competitor updates, 3 offer status changes\. /);
  assert.ok(!/ANY_OFFER_CHANGED|LISTINGS_ITEM/.test(text));
});
