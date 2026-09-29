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
  credentialObtainedAt: NOW as never, credentialVerifiedAt: null, credentialCheckFailures: 0, oauth: true,
  discoveryCircleStartedAt: null, discoveryCircleCompletedAt: null, ...over,
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

/**
 * Шаг 49 [Р-190, E-21]: в бою Browse у eBay недоступен — продавец узнаёт словами, чего мы на eBay не видим: цену покупателя и правки
 * других программ, подтверждение — по записи предложения, проверка базы цены ограничена. Окружения экран не знает — текст у любого
 * аккаунта eBay (и у карточки канала eBay до подключения), на экране подключений и на экране тени; у Amazon его нет.
 */
test('Р-190: every eBay account and the eBay channel card say in words what live mode does not see; Amazon does not; both languages', async () => {
  const { shadowView } = await import('./shadow.ts');
  const ebayApps: ConnectableChannel[] = [{ channel: 'AMAZON', platformMissing: [], marketplaces: ['A1PA6795UKMFR9'] }, { channel: 'EBAY', platformMissing: [], marketplaces: ['EBAY_DE'] }];
  const expected = {
    en: 'In live mode we do not yet see on eBay the price buyers see or edits made by other programs: our writes are confirmed by the offer record, and the price-basis check is limited (question E-21).',
    de: 'Den Preis, den Käufer sehen, und Änderungen anderer Programme sehen wir auf eBay im Live-Betrieb noch nicht: Unsere Änderungen werden über den Angebotsdatensatz bestätigt, die Prüfung der Preisbasis ist eingeschränkt (Frage E-21).',
  };
  for (const locale of ['de', 'en'] as const) {
    const m = messagesFor(locale);
    const v = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, {
      accounts: [row({ channelAccountId: 'ebay-shadow', channel: 'EBAY', marketplaces: ['EBAY_DE'] }), row({ channelAccountId: 'ebay-live', channel: 'EBAY', marketplaces: ['EBAY_DE'], writeMode: 'LIVE' }), row({ channelAccountId: 'amazon' })],
      pending: [],
    }, ebayApps, m);
    const by = Object.fromEntries(v.accounts.map((a) => [a.channelAccountId, a.channelLimitText]));
    assert.deepEqual(by, { 'ebay-shadow': expected[locale], 'ebay-live': expected[locale], amazon: null });
    assert.deepEqual(v.channels.map((c) => [c.channel, c.channelLimitText]), [['AMAZON', null], ['EBAY', expected[locale]]], 'the eBay card says it before connecting');

    const account = (channelAccountId: string, channel: string) => ({ channelAccountId, channel, displayName: null, externalAccountId: `syn-${channelAccountId}`, writeMode: 'SHADOW' as const,
      authStatus: 'ACTIVE', changedAt: null, changedByMembershipId: null, changedFrom: null, offers: 3, engineScopes: 3 });
    const shadow = shadowView(
      { id: 'w', title: 't', description: 'd', tenantId: 't', now: NOW, accounts: [], viewer: { membershipId: 'membership-owner', role: 'OWNER' }, state: {} as never },
      { summary: { since: NOW, until: NOW, decisions: 0, changes: 0, floorHeld: 0, ceilingHeld: 0, heldWrites: 0, heldPriceWrites: 0, heldQuantityWrites: 0,
        wouldSpendBudget: 0, wouldSpendUnconfirmed: 0, floorSavings: [], floorSavingsHolds: 0 } as never,
        rows: [], total: 0, accounts: [account('ebay', 'EBAY'), account('amazon', 'AMAZON')], properties: [], digests: [] },
      { offset: 0, limit: 20 } as never, m, 7);
    assert.deepEqual(shadow.accounts.map((a) => [a.channelAccountId, a.channelLimitText]), [['ebay', expected[locale]], ['amazon', null]], 'the shadow screen says it before the live button');
  }
});

/**
 * Шаг 49 [Р-190], находка 9 ревью: запись eBay, подтверждённая в бою только НАШЕЙ записью предложения (Browse недоступен), — не
 * «подтверждено каналом» без оговорки: лента цен и экран остатков говорят это словами. Запись, подтверждённая живым листингом, — без оговорки.
 */
test('Р-190: a write confirmed by our own offer record is named so on the price feed and the stock screen; a live-listing confirmation is not', async () => {
  const { feedItemOf } = await import('./price-feed.ts');
  const { channelCell } = await import('./stock.ts');
  const expected = { en: 'confirmed by the offer record, not by the live listing (question E-21)', de: 'bestätigt über den Angebotsdatensatz, nicht über das Live-Angebot (Frage E-21)' };
  const world = { id: 'w', title: 't', description: 'd', tenantId: 't', now: NOW, accounts: [], viewer: { membershipId: 'membership-owner', role: 'OWNER' }, state: { scopes: [], strategies: [] } } as never;
  const write = (own: boolean, status = 'APPLIED') => ({ channelWriteId: 'cw', writeScopeId: 'ws', decisionId: null, amountMinor: 1349, currency: 'EUR', basis: 'GROSS' as const, version: 1, status,
    attemptCount: 1, competitorDerived: false, createdAt: NOW, dispatchedAt: NOW, acceptedAt: NOW, nextAttemptAt: null, lastErrorCode: null, endReason: null, endParams: {},
    supersededByWriteId: null, confirmedByOwnRecord: own });
  const cell = (ownRecordOnly: boolean) => ({ writeScopeId: 'ws-q', channelAccountId: 'acc', channel: 'EBAY', marketplaces: ['EBAY_DE'], syncEnabled: true, published: 3,
    sent: { quantity: 3, status: 'APPLIED', at: NOW, version: 1 }, confirmed: { quantity: 3, at: NOW, ...(ownRecordOnly ? { ownRecordOnly: true } : {}) }, divergence: null,
    sideEffects: { requiresAck: false, acknowledged: false, text: null } });
  for (const locale of ['de', 'en'] as const) {
    const m = messagesFor(locale);
    assert.equal(feedItemOf(world, m, { write: write(true), decision: null, intentCurrentMinor: null }).confirmation, expected[locale]);
    assert.equal(feedItemOf(world, m, { write: write(false), decision: null, intentCurrentMinor: null }).confirmation, null, 'the live listing confirmed it — no remark');
    assert.ok(channelCell(cell(true) as never, m).confirmedText.endsWith(expected[locale]), channelCell(cell(true) as never, m).confirmedText);
    assert.ok(!channelCell(cell(false) as never, m).confirmedText.includes('E-21'));
  }
});

test('review 49 #11: the eBay card waiting for the account deletion endpoint names the reason in words, not by its code', () => {
  for (const locale of ['de', 'en'] as const) {
    const v = connectionsView({ worldId: 'w', role: 'OWNER', now: NOW }, { accounts: [], pending: [] },
      [{ channel: 'EBAY', platformMissing: ['EBAY_ACCOUNT_DELETION_ENDPOINT'], marketplaces: ['EBAY_DE'] }], messagesFor(locale));
    assert.deepEqual([v.channels[0]!.state, v.channels[0]!.canConnect], ['AWAITING_PLATFORM', false]);
    assert.ok(v.channels[0]!.missingText && !v.channels[0]!.missingText.includes('EBAY_ACCOUNT_DELETION_ENDPOINT') && /eBay/.test(v.channels[0]!.missingText), v.channels[0]!.missingText!);
  }
});

test('step 56–57 (Р-198): the connection says how long the discovery circle runs and names an honest bound — two circles and a day', () => {
  const m = messagesFor('en');
  const view = (over: Partial<ConnectionRow>) => connectionsView({ worldId: 'w', role: 'OWNER', now: '2026-09-29T12:00:00.000Z' }, { accounts: [row(over)], pending: [] }, [], m).accounts[0]!.discoveryText;
  assert.equal(view({}), null, 'no circle yet — nothing to say');
  assert.match(view({ discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /running 6 h \(the first one\)/);
  assert.match(view({ discoveryCircleStartedAt: '2026-09-27T12:00:00.000Z' as never, discoveryCircleCompletedAt: '2026-09-28T18:00:00.000Z' as never }) ?? '', /last full circle took 30 h.*within about 85 h at most \(two circles and a day\)/);
  assert.match(view({ discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /within two circles and a day at most/, 'no promise of «one circle»');
  // Шаг 58 (ревью шага 56, находка 9): «старые листинги eBay» — только у аккаунта eBay
  assert.doesNotMatch(view({ discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /eBay/, 'an Amazon account is not told about eBay listings');
  assert.match(view({ channel: 'EBAY', discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /older eBay listings/);
});
