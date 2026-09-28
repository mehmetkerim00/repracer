import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConnectionRow, PendingRequestRow } from '@repracer/pricing-store-pg';
import { connectionsView, type ConnectableChannel } from './connections.ts';
import { messagesFor } from './i18n/index.ts';

/**
 * Р-175…Р-177, Р-150 (шаг 43): состояние подключения ВЫВОДИТСЯ из данных — аккаунта, запроса согласия и приложения
 * платформы. Каждое из семи состояний утверждается на своём случае, и тексты есть на обоих языках. Данные синтетические.
 */

const NOW = '2026-09-27T10:00:00.000Z';
const row = (over: Partial<ConnectionRow>): ConnectionRow => ({
  channelAccountId: 'acc-1', channel: 'AMAZON', region: 'EU', marketplaces: ['A1PA6795UKMFR9'], externalAccountId: 'A3SYN',
  authStatus: 'ACTIVE', accessBlockers: [], writeMode: 'SHADOW', connectedAt: NOW as never, offers: 0, unmanagedOffers: 0, shadowDecisions24h: 0,
  credentialObtainedAt: NOW as never, credentialVerifiedAt: null, credentialCheckFailures: 0, oauth: true, ...over,
});
const pending = (over: Partial<PendingRequestRow>): PendingRequestRow => ({
  authorizationRequestId: 'r1', channel: 'AMAZON', marketplaces: ['A1PA6795UKMFR9'], requestedAt: NOW as never,
  expiresAt: '2026-09-27T10:05:00.000Z' as never, status: 'PENDING', failureCode: null, ...over,
});
const apps: ConnectableChannel[] = [
  { channel: 'AMAZON', platformMissing: [], marketplaces: ['A1PA6795UKMFR9'] },
  { channel: 'EBAY', platformMissing: ['EBAY_DEVELOPER_KEYS'], marketplaces: ['EBAY_DE'] },
];

test('Р-175, Р-150: не подключён, ждёт согласия, ждёт доступа платформы — у канала', () => {
  for (const locale of ['de', 'en'] as const) {
    const m = messagesFor(locale);
    const empty = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [], pending: [] }, apps, m);
    assert.deepEqual(empty.channels.map((c) => [c.channel, c.state, c.canConnect]), [['AMAZON', 'NOT_CONNECTED', true], ['EBAY', 'AWAITING_PLATFORM', false]]);
    assert.ok(empty.channels[1]!.missingText && !empty.channels[1]!.missingText.includes('EBAY_DEVELOPER_KEYS'), 'причина названа словами, а не кодом');
    const waiting = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [], pending: [pending({})] }, apps, m);
    assert.deepEqual([waiting.channels[0]!.state, waiting.channels[0]!.canConnect], ['AWAITING_CONSENT', false], 'второй запрос, пока первый жив, не начинается');
    const expired = connectionsView({ worldId: 'w', role: 'OWNER', now: '2026-09-27T10:06:00.000Z' }, { accounts: [], pending: [pending({})] }, apps, m);
    assert.equal(expired.channels[0]!.state, 'NOT_CONNECTED', 'истёкший запрос — снова «не подключён»');
  }
});

test('Р-176, Р-177, Р-150: тень с прогрессом, бой, отзыв, ждёт доступа — у аккаунта', () => {
  const m = messagesFor('en');
  const v = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, {
    accounts: [
      row({ channelAccountId: 'discovering' }),
      row({ channelAccountId: 'found', offers: 25 }),
      row({ channelAccountId: 'counting', offers: 25, shadowDecisions24h: 90 }),
      row({ channelAccountId: 'live', writeMode: 'LIVE', offers: 12 }),
      row({ channelAccountId: 'revoked', authStatus: 'REVOKED', offers: 25 }),
      row({ channelAccountId: 'awaiting', authStatus: 'AWAITING_ACCESS', accessBlockers: ['NOTIFICATION_QUEUE'], oauth: false }),
    ], pending: [],
  }, apps, m);
  const by = Object.fromEntries(v.accounts.map((a) => [a.channelAccountId, a]));
  assert.deepEqual(v.accounts.map((a) => a.state), ['SHADOW', 'SHADOW', 'SHADOW', 'LIVE', 'REVOKED', 'AWAITING_ACCESS']);
  assert.match(by.discovering!.progressText!, /Looking for your offers/);
  assert.match(by.found!.progressText!, /Found 25 offers\. The shadow starts counting once/);
  assert.match(by.counting!.progressText!, /Found 25 offers; the shadow made 90 decisions/);
  assert.deepEqual([by.revoked!.canReconnect, by.revoked!.reconnectLabel], [true, 'Connect again']);
  assert.equal(by.awaiting!.canReconnect, false, 'аккаунт не из OAuth повторным согласием не чинится');
  const ebay = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [row({ channel: 'EBAY', authStatus: 'REVOKED' })], pending: [] }, apps, m);
  assert.equal(ebay.accounts[0]!.canReconnect, false, 'eBay не называет продавца (E-11): повторное согласие создало бы второй аккаунт');
  // Наблюдатель видит состояние, но кнопок у него нет
  const viewer = connectionsView({ worldId: 'w', role: 'VIEWER', now: NOW }, { accounts: [row({ authStatus: 'REVOKED' })], pending: [] }, apps, m);
  assert.deepEqual([viewer.canManage, viewer.channels[0]!.canConnect, viewer.accounts[0]!.canReconnect], [false, false, false]);
  assert.ok(viewer.noRightText);
});

test('хвост шага 47: «нашли N» называет и то, что вести нельзя, — немигрированные листинги и аукционы eBay', () => {
  const m = messagesFor('en');
  const v = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, {
    accounts: [
      row({ channelAccountId: 'mixed', channel: 'EBAY', offers: 10, unmanagedOffers: 2 }),
      row({ channelAccountId: 'clean', channel: 'EBAY', offers: 10, unmanagedOffers: 0 }),
    ], pending: [],
  }, apps, m);
  const by = Object.fromEntries(v.accounts.map((a) => [a.channelAccountId, a]));
  assert.match(by.mixed!.progressText!, /Found 10 offers\..* Of them we can write to 8; 2 are not open for our writes/);
  assert.doesNotMatch(by.clean!.progressText!, /not open for our writes/, 'все управляемые — второй фразы нет');
  const de = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [row({ channel: 'EBAY', offers: 10, unmanagedOffers: 2 })], pending: [] }, apps, messagesFor('de'));
  assert.match(de.accounts[0]!.progressText!, /Davon können wir 8 ändern; 2 sind für unsere Änderungen nicht offen/);
});

test('хвост шага 47: одно неуправляемое предложение — в единственном числе', () => {
  const v = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [row({ channel: 'EBAY', offers: 3, unmanagedOffers: 1 })], pending: [] }, apps, messagesFor('en'));
  assert.match(v.accounts[0]!.progressText!, /write to 2; 1 is not open/);
});
