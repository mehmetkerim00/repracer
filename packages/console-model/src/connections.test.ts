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
  discoveryCircleStartedAt: null, discoveryCircleCompletedAt: null,
  otherTools: null, otherToolsAnsweredAt: null, quantityWritesConfirmed: false, externalEdits24h: 0, ...over,
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
    en: 'In live mode we do not yet see on eBay the price buyers see or edits made by other programs: our writes are confirmed by the offer record, and the price-basis check is limited.',
    de: 'Den Preis, den Käufer sehen, und Änderungen anderer Programme sehen wir auf eBay im Live-Betrieb noch nicht: Unsere Änderungen werden über den Angebotsdatensatz bestätigt, die Prüfung der Preisbasis ist eingeschränkt.',
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
  const expected = { en: 'confirmed by the offer record, not by the live listing', de: 'bestätigt über den Angebotsdatensatz, nicht über das Live-Angebot' };
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
  assert.match(view({ discoveryCircleStartedAt: '2026-09-27T12:00:00.000Z' as never, discoveryCircleCompletedAt: '2026-09-28T18:00:00.000Z' as never }) ?? '', /last full circle took 30 h.*within about 85 h \(two circles and a day\), if the next circle is not longer/);
  assert.match(view({ discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /within about two circles and a day/, 'no promise of «one circle»');
  // Шаг 58 (ревью шага 56, находка 9): «старые листинги eBay» — только у аккаунта eBay
  assert.doesNotMatch(view({ discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /eBay/, 'an Amazon account is not told about eBay listings');
  assert.match(view({ channel: 'EBAY', discoveryCircleStartedAt: '2026-09-29T06:00:00.000Z' as never }) ?? '', /older eBay listings/);
});

test('шаг 60 [Р-202]: вопрос о других инструментах, запись количества по подтверждению владельца и внешние правки — словами на обоих языках', () => {
  for (const locale of ['de', 'en'] as const) {
    const m = messagesFor(locale);
    const t = m.ui.connections;
    const account = (role: 'OWNER' | 'ADMIN' | 'VIEWER', over: Partial<ConnectionRow>) => connectionsView({ worldId: 'w', role, now: NOW }, { accounts: [row(over)], pending: [] }, [], m).accounts[0]!;
    // Не отвечено: вопрос задан, запись количества выключена, подтвердить нельзя — сначала ответ
    const fresh = account('OWNER', {});
    assert.deepEqual([fresh.otherTools.answer, fresh.otherTools.text, fresh.otherTools.options.map((o) => o.answer), fresh.otherTools.warning],
      [null, t.otherTools.unanswered, ['NONE', 'STOCK', 'PRICES', 'STOCK_AND_PRICES'], null]);
    assert.deepEqual([fresh.quantityWrites.confirmed, fresh.quantityWrites.text, fresh.quantityWrites.blockedText, fresh.quantityWrites.canConfirm, fresh.quantityWrites.typeToConfirm],
      [false, t.quantityWrites.off, t.quantityWrites.answerFirst, false, null]);
    // «Нет других инструментов»: владелец видит форму и что набрать — внешний идентификатор аккаунта
    const none = account('OWNER', { otherTools: 'NONE' });
    assert.deepEqual([none.quantityWrites.canConfirm, none.quantityWrites.typeToConfirm, none.quantityWrites.blockedText], [true, 'A3SYN', null]);
    assert.ok(none.quantityWrites.confirmationHint!.includes('A3SYN'), none.quantityWrites.confirmationHint!);
    // Не владелец формы не получает — база ему откажет; наблюдатель не отвечает на вопрос
    assert.deepEqual([account('ADMIN', { otherTools: 'NONE' }).quantityWrites.canConfirm, account('ADMIN', { otherTools: 'NONE' }).quantityWrites.blockedText], [false, t.quantityWrites.ownerOnly]);
    assert.deepEqual(account('VIEWER', {}).otherTools.options, []);
    // Остатки ведёт другой инструмент: подтвердить нельзя, и сказано почему
    for (const answer of ['STOCK', 'STOCK_AND_PRICES'] as const) {
      const v = account('OWNER', { otherTools: answer });
      assert.deepEqual([v.quantityWrites.canConfirm, v.quantityWrites.blockedText], [false, t.quantityWrites.otherToolManagesStock], answer);
    }
    // Цены ведёт другой инструмент — предупреждение о двух репрайсерах; у ответов без цен его нет
    for (const answer of ['PRICES', 'STOCK_AND_PRICES'] as const) assert.equal(account('OWNER', { otherTools: answer }).otherTools.warning, t.otherTools.twoRepricers, answer);
    for (const answer of ['NONE', 'STOCK'] as const) assert.equal(account('OWNER', { otherTools: answer }).otherTools.warning, null, answer);
    // Подтверждено: включена, формы нет
    const on = account('OWNER', { otherTools: 'NONE', quantityWritesConfirmed: true, externalEdits24h: 3 });
    assert.deepEqual([on.quantityWrites.confirmed, on.quantityWrites.text, on.quantityWrites.canConfirm, on.quantityWrites.blockedText], [true, t.quantityWrites.on, false, null]);
    // Шаг 61 [Р-202]: отзыв — у подтверждённого аккаунта и только владельцу, набранным тем же идентификатором
    assert.deepEqual([on.quantityWrites.canRevoke, on.quantityWrites.typeToRevoke], [true, 'A3SYN']);
    assert.ok(on.quantityWrites.revokeHint!.includes('A3SYN'), on.quantityWrites.revokeHint!);
    assert.deepEqual([account('ADMIN', { otherTools: 'NONE', quantityWritesConfirmed: true }).quantityWrites.canRevoke, fresh.quantityWrites.canRevoke, fresh.quantityWrites.typeToRevoke], [false, false, null]);
    // Счётчик внешних правок — число из строки, а не константа
    assert.equal(on.externalEdits24h, 3);
    assert.ok(on.externalEditsText.endsWith(': 3'), on.externalEditsText);
    assert.ok(fresh.externalEditsText.endsWith(': 0'), fresh.externalEditsText);
  }
});

/**
 * Шаг 64 (проход консоли глазами клиента): количество, удержанное тенью, на экране остатков не «отправлено» — в канал ничего не ушло.
 * Демо в тени показывало «sent 21 (SHADOW_HELD, …)» рядом с красным «DIVERGED»
 */
test('step 64: a stock quantity held by shadow mode is not shown as sent, and not in the alarm tone', async () => {
  const { channelCell } = await import('./stock.ts');
  const held = { writeScopeId: 'ws-q', channelAccountId: 'acc', channel: 'KAUFLAND', marketplaces: ['de'], syncEnabled: true, published: 21,
    sent: { quantity: 21, status: 'SHADOW_HELD', at: NOW, version: 2 }, confirmed: null, divergence: null, sideEffects: { requiresAck: false, acknowledged: false, text: null } };
  const expected = { en: 'held by shadow mode: 21 would be sent', de: 'vom Schattenmodus zurückgehalten: würde 21 senden' };
  for (const locale of ['de', 'en'] as const) {
    const c = channelCell(held as never, messagesFor(locale));
    assert.ok(c.sentText.startsWith(expected[locale]), c.sentText);
    assert.ok(!c.sentText.includes('SHADOW_HELD'), c.sentText);
    assert.equal(c.tone, 'off');
  }
  // Контроль: отправленная запись по-прежнему «отправлена»
  const sent = channelCell({ ...held, sent: { ...held.sent, status: 'APPLIED' } } as never, messagesFor('en'));
  assert.ok(sent.sentText.startsWith('sent 21'), sent.sentText);
});

/**
 * Шаг 64 (ревью, мелкая): ловушка остатка Amazon выбирается по витрине аккаунта — продавцу amazon.com нельзя называть amazon.fr, .it, .es,
 * а продавцу amazon.de — Северную Америку. Правило теста консоли принимает оба текста, поэтому неверный выбор ловит только эта проверка
 */
test('step 64: the Amazon stock trap names North America for amazon.com and the EU storefronts for amazon.de', async () => {
  const { stockTraps } = await import('./stock.ts');
  const world = (marketplaces: string[]) => ({ id: 'w', title: 't', description: 'd', tenantId: 't', now: NOW, viewer: { membershipId: 'm', role: 'OWNER' },
    accounts: [{ channelAccountId: 'acc', channel: 'AMAZON', marketplaces }], state: { scopes: [], strategies: [] } }) as never;
  for (const locale of ['de', 'en'] as const) {
    const m = messagesFor(locale);
    const us = stockTraps(world(['ATVPDKIKX0DER']), m)[0]!;
    const eu = stockTraps(world(['A1PA6795UKMFR9']), m)[0]!;
    assert.ok(/amazon\.com/.test(us.text) && !/amazon\.fr/.test(us.text), us.text);
    assert.ok(/amazon\.fr/.test(eu.text) && !/amazon\.com/.test(eu.text), eu.text);
    assert.ok(us.requiresAck && eu.requiresAck, 'both need the confirmation of the side effect');
  }
});
