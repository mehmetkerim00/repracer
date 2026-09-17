import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neverWrittenAttributes } from '@repracer/channel-port';
import { decimalToMinor, minorToDecimal, patchBody, TwoLevelBudget } from '../src/index.ts';

/** Модульные проверки адаптера Amazon (шаг 22). Данные синтетические */

test('money: decimal strings and JSON numbers become whole cents; sub-cent fractions are refused', () => {
  assert.equal(decimalToMinor('17.75'), 1775);
  assert.equal(decimalToMinor(17.8), 1780);
  assert.equal(decimalToMinor('20'), 2000);
  assert.equal(decimalToMinor('17.750'), 1775);
  assert.equal(decimalToMinor('17.755'), null);
  assert.equal(decimalToMinor('-1'), null);
  assert.equal(decimalToMinor('1e3'), null);
  assert.equal(minorToDecimal(1775), 17.75);
  assert.equal(minorToDecimal(1705), 17.05);
  assert.equal(JSON.stringify({ v: minorToDecimal(100000001) }), '{"v":1000000.01}');
});

test('Р-114: a PATCH body contains our_price or fulfillment_availability only — never a channel bound or an automated pricing rule', () => {
  const write = (field: 'PRICE' | 'QUANTITY') => ({
    channelWriteId: 'cw' as never, version: 1, idempotencyKey: 'k', attemptNo: 1,
    writeScope: { writeScopeId: 'ws' as never, field, scopeKey: 'k', identity: { region: 'EU', marketplace: 'A1PA6795UKMFR9', externalSku: 'SYN-1' } },
    value: field === 'PRICE' ? { field, price: { amountMinor: 1999, currency: 'EUR', basis: 'GROSS' as const } } : { field, quantity: 3 },
  });
  for (const body of [JSON.stringify(patchBody('SYN_TYPE', [write('PRICE')])), JSON.stringify(patchBody('SYN_TYPE', [write('QUANTITY')]))]) {
    for (const attribute of neverWrittenAttributes('AMAZON')) assert.ok(!body.includes(attribute), `${attribute} in ${body}`);
  }
  assert.deepEqual(neverWrittenAttributes('AMAZON').sort(), ['automated_pricing_merchandising_rule_plan', 'maximum_seller_allowed_price', 'minimum_seller_allowed_price']);
});

test('E: two-level budget — the pair limit and the application limit, whichever is reached first; sellers share the application level', () => {
  const b = new TwoLevelBudget();
  const t = Date.parse('2026-09-14T10:00:00.000Z');
  for (let i = 0; i < 5; i++) assert.equal(b.tryAcquire('S1', 'patchListingsItem', t).ok, true);
  const sixth = b.tryAcquire('S1', 'patchListingsItem', t);
  assert.ok(!sixth.ok && sixth.level === 'PAIR' && sixth.retryAtMs === t + 200);
  assert.equal(b.tryAcquire('S1', 'patchListingsItem', t + 200).ok, true, 'refills at 5 per second');
  // Уровень приложения: burst пары принят и для приложения (A-09) — пятеро других продавцов исчерпывают общий запас
  const shared = new TwoLevelBudget();
  for (let i = 0; i < 5; i++) assert.equal(shared.tryAcquire(`S${i}`, 'getListingsItem', t).ok, true);
  const other = shared.tryAcquire('S9', 'getListingsItem', t);
  assert.ok(!other.ok && other.level === 'APPLICATION');
  const loaded = new TwoLevelBudget({ applicationLoadRps: () => 100 });
  assert.equal(loaded.tryAcquire('S1', 'getListingsItem', t).ok, false, 'no application capacity left');
  // Ревью шага 22, находка 3: свободно 19 rps из 100 — запросы идут со скоростью свободной доли, а не стоят
  const partly = new TwoLevelBudget({ applicationLoadRps: () => 81 });
  let passed = 0;
  for (let ms = 0; ms < 10_000; ms += 10) if (partly.tryAcquire(`S${ms % 7}`, 'getListingsItem', t + ms).ok) passed += 1;
  assert.ok(passed >= 150 && passed <= 200, `about 19 per second pass: ${passed}`);
  const header = new TwoLevelBudget();
  header.observePairLimit('S1', 'patchListingsItem', 1);
  for (let i = 0; i < 5; i++) header.tryAcquire('S1', 'patchListingsItem', t);
  const slow = header.tryAcquire('S1', 'patchListingsItem', t);
  assert.ok(!slow.ok && slow.retryAtMs === t + 1000, 'x-amzn-RateLimit-Limit lowers the pair rate');
});
