import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientChannelsOf, connectableInMarket, extendedRolesOf, localeInMarket, marketProfileOf, marketScope, storefrontInMarket, tenantMarketScope, worldInMarket } from './market.ts';

/**
 * Шаг 87 [Р-214]: профиль рынка. США — сейчас: amazon.com и ebay.com, английский, без Omnibus. Европа заморожена, не удалена: профиль
 * eu отдаёт ровно прежнее предложение (Kaufland, amazon.de, ebay.de, немецкий, Omnibus), global — всё сразу
 */

test('step 87: the deployment market profile is us unless set, and a wrong value is refused rather than defaulted', () => {
  assert.equal(marketProfileOf(undefined), 'us');
  assert.equal(marketProfileOf(''), 'us');
  assert.equal(marketProfileOf('eu'), 'eu');
  assert.equal(marketProfileOf('global'), 'global');
  assert.throws(() => marketProfileOf('de'), /REPRACER_MARKET_PROFILE must be one of us, eu, global, got de/);
});

test('step 87: the us profile offers amazon.com and ebay.com in English without Omnibus; eu keeps the European offer whole', () => {
  const us = marketScope('us'), eu = marketScope('eu'), global = marketScope('global');
  // Шаг 89: Walmart — канал рынка США, только в us и global
  assert.deepEqual([us.channels, us.locales, us.omnibus, us.currencies], [['AMAZON', 'EBAY', 'WALMART'], ['en', 'es', 'fr'], false, ['USD']]);
  assert.deepEqual([eu.channels, eu.locales, eu.omnibus], [['KAUFLAND', 'AMAZON', 'EBAY'], ['de', 'en', 'es', 'fr'], true]);
  const cases: Array<[string, string, boolean, boolean, boolean]> = [
    // канал, витрина, us, eu, global
    ['AMAZON', 'ATVPDKIKX0DER', true, false, true],
    ['EBAY', 'EBAY_US', true, false, true],
    ['WALMART', 'WALMART_US', true, false, true],
    ['AMAZON', 'A1PA6795UKMFR9', false, true, true],
    ['EBAY', 'EBAY_DE', false, true, true],
    ['KAUFLAND', 'de', false, true, true],
    ['KAUFLAND', 'at', false, true, true],
  ];
  for (const [channel, mp, inUs, inEu, inGlobal] of cases) {
    assert.deepEqual([storefrontInMarket(us, channel, mp), storefrontInMarket(eu, channel, mp), storefrontInMarket(global, channel, mp)], [inUs, inEu, inGlobal], `${channel} ${mp}`);
  }
  // язык: немецкий в us — английский; в eu — свой
  assert.equal(localeInMarket(us, 'de'), 'en');
  assert.equal(localeInMarket(eu, 'de'), 'de');
  // Шаг 98 [Р-223]: испанский и французский — языки обоих профилей; немецкий в us спрятан, как прежде
  assert.deepEqual([localeInMarket(us, 'es'), localeInMarket(us, 'fr'), localeInMarket(eu, 'fr')], ['es', 'fr', 'fr']);
});

test('step 87: connect offers only the channels and storefronts of the profile; a world is shown when it has a storefront of the profile', () => {
  const offered = [
    { channel: 'AMAZON', platformMissing: [], marketplaces: ['A1PA6795UKMFR9', 'ATVPDKIKX0DER'] },
    { channel: 'EBAY', platformMissing: [], marketplaces: ['EBAY_DE', 'EBAY_US'] },
    { channel: 'KAUFLAND', platformMissing: [], marketplaces: ['de', 'at'] },
  ];
  assert.deepEqual(connectableInMarket(marketScope('us'), offered).map((c) => [c.channel, c.marketplaces]), [['AMAZON', ['ATVPDKIKX0DER']], ['EBAY', ['EBAY_US']]]);
  assert.deepEqual(connectableInMarket(marketScope('eu'), offered).map((c) => [c.channel, c.marketplaces]), [['AMAZON', ['A1PA6795UKMFR9']], ['EBAY', ['EBAY_DE']], ['KAUFLAND', ['de', 'at']]]);
  assert.equal(connectableInMarket(marketScope('global'), offered).length, 3);
  const kaufland = [{ channel: 'KAUFLAND', marketplaces: ['de'] }];
  const usDemo = [{ channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }, { channel: 'EBAY', marketplaces: ['EBAY_US'] }];
  assert.equal(worldInMarket(marketScope('us'), kaufland), false);
  assert.equal(worldInMarket(marketScope('us'), usDemo), true);
  assert.equal(worldInMarket(marketScope('eu'), usDemo), false);
  assert.equal(worldInMarket(marketScope('us'), []), true, 'an empty workspace is shown everywhere — onboarding starts there');
});

test('step 88 (Р-213): the extended roles flag is on or off, off by default; anything else is refused, not silently off', () => {
  assert.deepEqual([extendedRolesOf(undefined), extendedRolesOf(''), extendedRolesOf('off'), extendedRolesOf('on')], [false, false, false, true]);
  assert.throws(() => extendedRolesOf('yes'), /REPRACER_EXTENDED_ROLES must be on or off, got yes/);
});

/**
 * Шаг 176 [Р-256]: каталог каналов тенанта — клиент при «только Amazon US» видит и подключает только amazon.com профиля; демо и развёртывание
 * «all» — профиль целиком
 */
test('step 176 [Р-256]: the client channel catalog narrows the profile to amazon.com; demo and «all» keep the whole profile', () => {
  const us = marketScope('us');
  const offered = [
    { channel: 'AMAZON', marketplaces: ['A1PA6795UKMFR9', 'ATVPDKIKX0DER'] },
    { channel: 'EBAY', marketplaces: ['EBAY_US'] },
    { channel: 'WALMART', marketplaces: ['WALMART_US'] },
  ];
  const client = tenantMarketScope(us, { demo: false }, 'AMAZON_US');
  assert.deepEqual(client.channels, ['AMAZON']);
  assert.deepEqual(connectableInMarket(client, offered), [{ channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }], 'a client connects amazon.com only');
  assert.deepEqual([storefrontInMarket(client, 'EBAY', 'EBAY_US'), storefrontInMarket(client, 'AMAZON', 'A1PA6795UKMFR9'), storefrontInMarket(client, 'AMAZON', 'ATVPDKIKX0DER')],
    [false, false, true]);
  assert.equal(tenantMarketScope(us, { demo: true }, 'AMAZON_US'), us, 'the demo keeps the three simulator channels');
  assert.equal(tenantMarketScope(us, { demo: false }, 'ALL'), us, '«all» keeps the profile');
  // В глобальном профиле рамка тоже сужает до amazon.com, а не до «Amazon любой витрины»
  assert.deepEqual(connectableInMarket(tenantMarketScope(marketScope('global'), { demo: false }, 'AMAZON_US'), offered), [{ channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'] }]);
  assert.deepEqual([clientChannelsOf(undefined, 'AMAZON_US'), clientChannelsOf('all', 'AMAZON_US'), clientChannelsOf('amazon_us', 'ALL')], ['AMAZON_US', 'ALL', 'AMAZON_US']);
  assert.throws(() => clientChannelsOf('ALL', 'ALL'), /REPRACER_CLIENT_CHANNELS must be amazon_us or all, got ALL/);
});
