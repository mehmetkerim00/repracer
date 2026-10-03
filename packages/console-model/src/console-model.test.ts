import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALL_REASON_CODES, COMPETITOR_RULE_DERIVED_KEYS, ENGINE_REASON_CODES, GATE_REASON_CODES, REASON_PARAMS, SANITY_NOTE_CODES, SANITY_NOTE_PARAMS, SANITY_WARNING_CODES, type ParamSchema, type ParamSpec } from '@repracer/pricing-model';
import { describe, explainabilityCatalogue, FEED_PAGE_MAX, LOCALES, messagesFor, parseAmountInput, parseFeedQuery, parsePercentInput, REASON_LIMITS } from './index.ts';

/** Р-71, Р-72: словарь DE/EN полон, суммы — только с валютой, значения канала вне слепка помечаются */

function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [path];
  if (Array.isArray(value)) return [path];
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k)).sort();
  return [path];
}

test('Р-72: the German and English dictionaries have the same keys, and every reason code has a title and a text', () => {
  const [de, en] = LOCALES.map((l) => messagesFor(l));
  assert.deepEqual(shape(de), shape(en));
  for (const m of [de!, en!]) {
    for (const code of ALL_REASON_CODES) {
      assert.equal(typeof m.titles[code], 'string', `${m.locale} title ${code}`);
      assert.equal(typeof m.reasons[code], 'function', `${m.locale} text ${code}`);
    }
    for (const code of SANITY_NOTE_CODES) assert.equal(typeof m.notes[code], 'function', `${m.locale} note ${code}`);
  }
});

test('Р-71: an amount is formatted only with the currency of the reason; without it the screen says so', () => {
  const en = messagesFor('en');
  const de = messagesFor('de');
  const reason = { code: 'BELOW_MIN_PRICE', params: { proposedMinor: 900, minMinor: 1000, deviationBp: 1000, currency: 'USD' } };
  const r = describe(reason, en);
  assert.deepEqual([r.text, r.problems], ['Rejected: $9.00 is below min_price $10.00 by 10%.', []]);
  assert.equal(describe(reason, de).text, 'Abgelehnt: 9,00 $ liegt unter min_price 10,00 $ um 10 %.');
  const noCurrency = describe({ code: 'BELOW_MIN_PRICE', params: { proposedMinor: 900, minMinor: 1000 } }, en);
  assert.ok(noCurrency.problems.includes('AMOUNT_WITHOUT_CURRENCY'));
  assert.match(noCurrency.text, /900 \(currency missing\)/);
});

test('Р-68: a channel value withheld from the explanation is marked, not invented', () => {
  const r = describe({ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, targetMinor: 1775, currency: 'EUR' }, withheld: ['buyboxMinor'] }, messagesFor('en'));
  // Шаг 68 (K11): не заглушка посреди фразы («Undercut the Buy Box channel value not kept by …»), а текст без сумм канала
  assert.equal(r.text, 'Undercut the Buy Box price seen at that moment by €0.05. The decision keeps amounts taken from competitor prices for 3 days, so they are no longer shown; the full snapshot is linked in the snapshot step.');
  assert.deepEqual([r.problems, r.withheld], [[], ['buyboxMinor']]);
});

/** Значение параметра по его виду — для правила ниже: каждый код описывается без единой подстановки руками */
function sampleValue(spec: ParamSpec): string | number | boolean {
  switch (spec.kind) {
    case 'money': case 'count': case 'seconds': case 'minutes': return 1250;
    case 'bp': return 1200;
    case 'ratio': return 0.8;
    case 'rateMicros': return 1_100_000;
    case 'currency': return 'USD';
    case 'instant': return '2026-10-01T09:00:00.000Z';
    case 'date': return '2026-10-01';
    case 'bool': return true;
    case 'enum': return spec.values?.[0] ?? 'X';
    case 'enumList': return spec.values?.[0] ?? 'X';
    case 'storefrontList': return 'de';
    default: return 'synthetic';
  }
}

/**
 * Шаг 68 (K11, Р-146): ни одна причина с параметрами канала не показывает заглушку посреди фразы — ни на одном языке. И у каждой причины,
 * которая бывает в ВЕЧНОМ объяснении (стратегия, предупреждения и заметки проверки входов), — свой текст без сумм канала, а не общий
 * «правило словами»: это строка экрана «почему эта цена», который видит каждый продавец через три дня после решения
 */
test('шаг 68 (K11): причины без значений канала читаются фразой, у причин объяснения — свой текст без канала', () => {
  const schemas = { ...REASON_PARAMS, ...SANITY_NOTE_PARAMS } as Record<string, ParamSchema>;
  // Ревью шага 68, находка 1: причина Gate тоже в вечном объяснении, и у цены из данных конкурента слепок вырезает ещё и ключи правила
  // стратегии (`COMPETITOR_RULE_DERIVED_KEYS`) — правило перебирает и их
  const inExplanation = new Set<string>([...ENGINE_REASON_CODES, ...SANITY_WARNING_CODES, ...SANITY_NOTE_CODES, ...GATE_REASON_CODES]);
  const channelClass = (spec: ParamSpec, key = '') => spec.class === 'CHANNEL' || spec.class === 'CHANNEL_DERIVED' || COMPETITOR_RULE_DERIVED_KEYS.includes(key);
  let checked = 0;
  for (const locale of LOCALES) {
    const m = messagesFor(locale);
    for (const [code, schema] of Object.entries(schemas)) {
      const withheld = Object.entries(schema).filter(([k, spec]) => channelClass(spec, k)).map(([k]) => k);
      if (withheld.length === 0) continue;
      const params = Object.fromEntries(Object.entries(schema).filter(([k, spec]) => !channelClass(spec, k)).map(([k, spec]) => [k, sampleValue(spec)]));
      const r = describe({ code, params, withheld }, m);
      assert.ok(!r.text.includes(m.ui.common.withheld), `${locale} ${code}: заглушка в тексте — ${r.text}`);
      assert.deepEqual(r.problems.filter((x) => x === 'UNKNOWN_CODE'), [], `${locale} ${code}: текста нет`);
      // Причина вечного объяснения не уходит в общий «правило словами»: свой текст без канала или шаблон, которому вырезанное не нужно
      if (inExplanation.has(code)) assert.notEqual(r.text, m.ui.common.withheldReason(r.title), `${locale} ${code}: причина вечного объяснения без своего текста без канала`);
      checked += 1;
    }
  }
  // Положительный контроль: правило видит коды с параметрами канала (41 на шаге 68), а не пустой список
  assert.ok(checked >= 2 * 40, `проверено ${checked}`);
  // Отрицательный контроль: словарь без текстов без канала и с «правилом словами», вставляющим пометку, — правило её видит
  const en = messagesFor('en');
  const broken = { ...en, reasonsWithoutChannel: {}, ui: { ...en.ui, common: { ...en.ui.common, withheldReason: () => `x ${en.ui.common.withheld}` } } } as typeof en;
  const r = describe({ code: 'BUYBOX_UNDERCUT', params: { undercutMinor: 5, targetMinor: 1775, currency: 'EUR' }, withheld: ['buyboxMinor'] }, broken);
  assert.ok(r.text.includes(en.ui.common.withheld), r.text);
});

test('D: four codes stay limited, each with the reason a parameter is impossible', () => {
  for (const locale of LOCALES) {
    const rows = explainabilityCatalogue(messagesFor(locale));
    assert.equal(rows.length, ALL_REASON_CODES.length);
    const limited = rows.filter((r) => r.verdict === 'LIMITED');
    assert.deepEqual(limited.map((r) => r.code).sort(), Object.keys(REASON_LIMITS).sort());
    assert.equal(limited.length, 4);
    // OQ-204: длина строки ничего не говорит о её содержании — пояснение обязано назвать САМО ограничение
    for (const r of limited) {
      const note = r.note ?? '';
      assert.ok(note.length > 40 && /\p{L}{4}/u.test(note), `пояснение причины ${r.code} — текст, а не заполнитель: ${note}`);
      assert.ok(!note.includes(r.code), `пояснение причины ${r.code} не повторяет её код: ${note}`);
    }
  }
});

test('unknown codes and optional parameters: problems only where the registry is violated', () => {
  const en = messagesFor('en');
  assert.deepEqual(describe({ code: 'NOT_A_CODE', params: {} }, en).problems.filter((p) => p === 'UNKNOWN_CODE'), ['UNKNOWN_CODE']);
  const optional = describe({ code: 'SCOPE_NOT_ACTIVE', params: { status: 'HELD', mode: 'ENGINE', blockedByErrorCode: null, blockedSince: null, action: null } }, en);
  assert.deepEqual([optional.text, optional.problems], ['Held: the offer is held with pricing mode automatic.', []]);
});

test('Р-117: the report counts the floor holding a strategy, not Gate rejections; the amount is the distance from the kept price to the strategy target', async () => {
  const { dangerousReport } = await import('./index.ts');
  const scope = { writeScopeId: 'ws-1', productId: 'p-1', channelAccountId: 'acc-1', marketplace: 'de', externalUnitId: '4101', channelProductRef: '3621', condition: 'new', gtin: null, currency: 'EUR' };
  const intent = (intentId: string, createdAt: string, reason: { code: string; params: Record<string, unknown> }, explanation: unknown[], currentMinor: number) => ({
    intentId, writeScopeId: 'ws-1', createdAt, currency: 'EUR', currentMinor, reason, explanation,
  });
  const world = {
    id: 'w', title: 'w', description: '', tenantId: 't', now: '2026-09-17T12:00:00.000Z', viewer: {},
    accounts: [{ channelAccountId: 'acc-1', channel: 'KAUFLAND', marketplaces: ['de'] }],
    state: { scopes: [scope], strategies: [], explanationRulesets: [] },
  } as never;
  /**
   * Р-154: отчёт получает срез вмешательств от ХРАНИЛИЩА, и здесь его считает настоящее хранилище в памяти
   * (`InMemoryPricingStore.interventions`), а не копия правила в тесте [находка 10 ревью шага 35]. Копия зеленела бы и
   * при разошедшемся правиле: граница эпизода считалась бы дважды и по-разному. Так проверяется и сам отчёт, и то, что
   * оценка без удержания между двумя удержаниями (i-1b) закрывает эпизод, не входя в срез.
   */
  const { InMemoryPricingStore } = await import('@repracer/pricing-pipeline');
  const sliceOf = async (intents: ReturnType<typeof intent>[], days: number) => {
    const store = new InMemoryPricingStore({ scopes: [] } as never);
    for (const i of intents) store.intents.push(i as never);
    const to = '2026-09-17T12:00:00.000Z';
    return (await store.interventions('t', new Date(Date.parse(to) - days * 86_400_000).toISOString(), to)) as never;
  };
  const intents = [
        // Поставлена на пол: цель 11.95, пол 15.00 — без пола на 3.05 дешевле
        intent('i-1', '2026-09-17T10:00:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'BUYBOX_UNDERCUT', params: {} }, { code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1195, minMinor: 1500, currency: 'EUR' } }], 1850),
        // Рынок ушёл вверх: пол не нужен — удержание закончилось
        intent('i-1b', '2026-09-17T10:30:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'BUYBOX_UNDERCUT', params: {} }], 1500),
        // Оставлена без изменения на 18.50: цель 14.00 ниже пола 15.00 — без пола на 4.50 дешевле
        intent('i-2', '2026-09-17T11:00:00.000Z', { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 1400, minMinor: 1500, maxMinor: 2500, currency: 'EUR' } }, [], 1850),
        // Удержание потолком — не работа пола
        intent('i-3', '2026-09-17T11:30:00.000Z', { code: 'TARGET_OUTSIDE_BOUNDS_HOLD', params: { targetMinor: 2600, minMinor: 1500, maxMinor: 2500, currency: 'EUR' } }, [], 1850),
        // Вне периода одного дня
        intent('i-4', '2026-09-15T11:00:00.000Z', { code: 'BUYBOX_UNDERCUT', params: {} }, [{ code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1000, minMinor: 1500, currency: 'EUR' } }], 1850),
  ];
  const en = messagesFor('en');
  // Находка 22 ревью шага 35: граница эпизода считается ВНУТРИ окна, как оконная функция базы. Удержание 15.09 вне окна
  // суток, поэтому i-1 (17.09) — начало эпизода в этом окне; в окне семи суток оно продолжает удержание 15.09
  const episodeStartOf = async (days: number) => ((await sliceOf(intents, days)) as unknown as { intents: Array<{ intentId: string; episodeStart: boolean }> }).intents.find((i) => i.intentId === 'i-1')!.episodeStart;
  assert.deepEqual([await episodeStartOf(1), await episodeStartOf(7)], [true, false]);
  const day = dangerousReport(world, await sliceOf(intents, 1), 1, en);
  assert.equal(day.headline, 'The floor held the price 2 times in the last 1 day; without it you would have sold €7.55 cheaper');
  assert.deepEqual(day.floorHolds.items.map((i) => [i.kind, i.target, i.floor, i.below]), [['HELD', '€14.00', '€15.00', '€4.50'], ['CAPPED', '€11.95', '€15.00', '€3.05']]);
  assert.equal(day.gateHeadline, 'Your bounds stopped 0 dangerous changes in the last 1 day');
  // За 7 дней оценка 15.09 и 17.09 10:00 идут подряд без оценки вне пола — одно удержание; вместе с удержанием после 10:30 — два
  assert.equal(dangerousReport(world, await sliceOf(intents, 7), 7, en).floorHolds.count, 2);
  // Ревью шага 22, находка 4: цена стоит на полу, стратегия оценивается 12 раз подряд — одно удержание, а не двенадцать
  const repeated = Array.from({ length: 12 }, (_, n) =>
    intent(`r-${n}`, `2026-09-17T11:${String(n * 5).padStart(2, '0')}:00.000Z`, { code: 'ALREADY_AT_TARGET', params: {} }, [{ code: 'CAPPED_AT_MIN_PRICE', params: { targetMinor: 1195, minMinor: 1500, currency: 'EUR' } }], 1500));
  assert.equal(dangerousReport(world, await sliceOf(repeated, 1), 1, en).headline, 'The floor held the price 1 time in the last 1 day; without it you would have sold €3.05 cheaper');
  assert.equal(dangerousReport(world, await sliceOf(intents, 1), 1, messagesFor('de')).headline, 'Die Untergrenze hat den Preis in den letzten 1 Tag 2-mal gehalten; ohne sie hätten Sie 7,55 € billiger verkauft');
});

test('step 23: a person enters amounts and percentages, not cents and basis points; anything else is refused, not guessed', () => {
  assert.deepEqual(['19,99', '19.9', ' 20 ', '0.05'].map(parseAmountInput), [1999, 1990, 2000, 5]);
  assert.deepEqual(['1.234,50', '19,999', '-5', 'x', ''].map(parseAmountInput), [null, null, null, null, null]);
  assert.deepEqual(['-5', '2,5', '−12.25', '+3', '12.5'].map(parsePercentInput), [-500, 250, -1225, 300, 1250]);
  assert.deepEqual(['*5', '5%', '1.234'].map(parsePercentInput), [null, null, null]);
});

test('step 23: the feed query is checked on the server — an unknown status, period or page size is a bad request, not “all”', () => {
  const q = (s: string) => parseFeedQuery(new URLSearchParams(s));
  assert.deepEqual(q('status=APPLIED&days=7&offset=50&limit=50'), { status: 'APPLIED', days: 7, offset: 50, limit: 50 });
  assert.deepEqual(q(''), {});
  for (const bad of ['status=ALL', 'days=5', 'limit=0', `limit=${FEED_PAGE_MAX + 1}`, 'offset=-1', 'offset=1e3']) assert.equal(q(bad), null, bad);
});

test('review of step 24, finding 12: the price evidence CSV neutralises spreadsheet formulas and quotes line breaks', async () => {
  const { PRICE_EVIDENCE_HEADER, priceEvidenceRows } = await import('./compliance.ts');
  const { csvOf } = await import('./exports.ts');
  const world = { accounts: [], state: { scopes: [] } } as never;
  const csv = csvOf(PRICE_EVIDENCE_HEADER, priceEvidenceRows(world, [{ writeScopeId: '=HYPERLINK("x")', day: '2026-09-17', timeZone: 'Europe/Berlin', currency: 'EUR', basis: 'GROSS', minMinor: 1000, maxMinor: 1000,
    firstMinor: 1000, lastMinor: 1000, changes: 1, source: 'CLOSED', corrected: true, correctionReason: '+cmd\r|x' }]));
  const line = csv.split('\n')[1]!;
  assert.ok(line.includes(`"'=HYPERLINK(""x"")"`), line);
  assert.ok(line.includes(`"'+cmd\r|x"`), line);
});

test('Р-152, находка 18 ревью шага 35: путь остатков ведёт тот, у кого право на каталог, а не на цены', async () => {
  const { onboardingView } = await import('./index.ts');
  const de = messagesFor('de');
  const progress = (path: 'STOCK' | 'STOCK_AND_PRICING') => ({ scopeWriteScopeIds: null, path, startedAt: '2026-09-22T10:00:00.000Z', updatedAt: '2026-09-22T10:00:00.000Z' }) as never;
  const view = (role: string, path: 'STOCK' | 'STOCK_AND_PRICING') =>
    onboardingView({ id: 'w', demo: false, viewer: { role } } as never, progress(path), [], [], de);
  // Менеджер остатков: право на каталог есть, на цены — нет
  assert.deepEqual([view('INVENTORY_MANAGER', 'STOCK').canLead, view('INVENTORY_MANAGER', 'STOCK_AND_PRICING').canLead], [true, false]);
  // Менеджер цен: цены правит, каталог — нет; путь остатков ведёт не он
  assert.deepEqual([view('PRICING_MANAGER', 'STOCK').canLead, view('PRICING_MANAGER', 'STOCK_AND_PRICING').canLead], [false, true]);
});

test('ревью шага 47, находка 11: недоступность стратегии на канале без источников конкурентов (ключ *) — словом словаря, без «*:» и без кода', async () => {
  const { unmetText } = await import('./index.ts');
  assert.equal(unmetText({ '*': ['NO_COMPETITOR_SOURCE'] }, messagesFor('en')), 'no competitor data source on this channel');
  assert.equal(unmetText({ '*': ['NO_COMPETITOR_SOURCE'] }, messagesFor('de')), 'keine Quelle für Wettbewerbsdaten in diesem Kanal');
  assert.equal(unmetText({ KAUFLAND_BUYBOX: ['BUYBOX_WINNER'] }, messagesFor('en')), 'KAUFLAND_BUYBOX: the Buy Box winner', 'у настоящего источника имя остаётся');
});

/**
 * Шаг 59 [Р-199]: возвраты на экране остатков. Возврат по отгруженной резервации внутреннего пула ждёт решения человека
 * (остаток не меняется сам), у источника Inbound API — только сведения. Хранилище в памяти — те же правила, что у базы
 */
test('Р-199: возврат внутреннего пула ждёт решения человека, возврат источника Inbound API — только сведения; принятие поднимает остаток ровно один раз', async () => {
  const { stockReturnsView } = await import('./index.ts');
  const { InMemoryStockStore } = await import('@repracer/stock-sync');
  const offers = [
    { productId: 'p-own', sku: 'syn-own', channelAccountId: 'acc', channel: 'KAUFLAND', marketplaces: ['de'], externalOfferId: 'SYN-OWN' },
    { productId: 'p-wms', sku: 'syn-wms', channelAccountId: 'acc', channel: 'KAUFLAND', marketplaces: ['de'], externalOfferId: 'SYN-WMS' },
  ];
  const store = new InMemoryStockStore(offers, { now: () => '2026-09-30T10:00:00.000Z' });
  const actor = { membershipId: 'm-1', userId: 'u-1', mfa: false };
  const pool = await store.createStockSource('t', { mode: 'INTERNAL_POOL', name: 'Lager' }, actor);
  const wms = await store.createStockSource('t', { mode: 'INBOUND_API', name: 'WMS' }, actor);
  assert.ok(pool.status === 'CREATED' && wms.status === 'CREATED');
  await store.importStock('t', pool.stockSourceId, [{ sku: 'syn-own', quantity: 10 }], actor);
  await store.inboundStock('t', wms.stockSourceId, [{ sku: 'syn-wms', quantity: 20, asOf: '2026-09-30T09:00:00.000Z' }]);
  const line = (offer: string, status: 'OPEN' | 'SHIPPED' | 'RETURNED') => ({
    externalOrderRef: `SYN-ORDER-${offer}`, externalOrderLineRef: `SYN-LINE-${offer}`, identity: { marketplace: 'de', externalOfferId: offer }, quantity: 2, orderedAt: '2026-09-30T09:30:00.000Z', status,
  }) as never;
  await store.recordOrderLines('t', 'acc', [line('SYN-OWN', 'SHIPPED'), line('SYN-WMS', 'OPEN')], '2026-09-30T09:30:00.000Z' as never);
  const onHand = async (sku: string) => (await store.stockPage('t', { offset: 0, limit: 10 })).items.find((r) => r.sku === sku)!.onHand;
  assert.equal(await onHand('syn-own'), 8, 'отгрузка списала пул');
  const returned = await store.recordOrderLines('t', 'acc', [line('SYN-OWN', 'RETURNED'), line('SYN-WMS', 'RETURNED')], '2026-09-30T09:40:00.000Z' as never);
  assert.equal(returned.returns, 2);
  assert.equal(await onHand('syn-own'), 8, 'возврат сам в пул не попадает — на полку ставит человек');

  const rows = await store.listReturns('t', 50);
  const de = messagesFor('de'); const en = messagesFor('en');
  const owner = stockReturnsView({ id: 'w', demo: false, viewer: { role: 'OWNER' } } as never, rows, de);
  assert.deepEqual(owner.items.map((x) => [x.sku, x.status, x.pending, x.infoOnly]), [['syn-own', 'PENDING', true, false], ['syn-wms', 'INFO_ONLY', false, true]], 'ждущие решения — первыми');
  assert.deepEqual([owner.pendingCount, owner.canDecide], [1, true]);
  assert.equal(owner.pendingText, de.ui.stock.returns.pendingCount(1));
  assert.equal(owner.items[0]!.statusText, de.ui.stock.returns.status.PENDING);
  assert.match(owner.items[0]!.text, /^2 Stück retourniert/);
  // INFO_ONLY называет, что остаток ведёт система продавца, — на обоих языках, а не пустую строку
  assert.match(stockReturnsView({ id: 'w', demo: false, viewer: { role: 'OWNER' } } as never, rows, en).items[1]!.text, /kept by your system/);
  assert.match(owner.items[1]!.text, /führt Ihr System/);
  assert.equal(stockReturnsView({ id: 'w', demo: false, viewer: { role: 'VIEWER' } } as never, rows, de).canDecide, false, 'зритель видит, но не решает');

  // Решение: права — у хранилища; повтор и сведения — NOT_PENDING; принятие поднимает остаток на количество возврата
  const forbidden = new InMemoryStockStore(offers, { canManage: () => false });
  assert.deepEqual(await forbidden.decideReturn('t', owner.items[0]!.orderReturnId, { accept: true, note: null }, actor), { status: 'FORBIDDEN' });
  assert.deepEqual(await store.decideReturn('t', owner.items[1]!.orderReturnId, { accept: true, note: null }, actor), { status: 'NOT_PENDING' }, 'сведения не принимаются в пул');
  assert.deepEqual(await store.decideReturn('t', '00000000-0000-4000-8000-000000000000', { accept: true, note: null }, actor), { status: 'NOT_FOUND' });
  assert.deepEqual(await store.decideReturn('t', owner.items[0]!.orderReturnId, { accept: true, note: 'ok' }, actor), { status: 'DECIDED', productId: 'p-own', accepted: true });
  assert.equal(await onHand('syn-own'), 10);
  assert.deepEqual(await store.decideReturn('t', owner.items[0]!.orderReturnId, { accept: true, note: null }, actor), { status: 'NOT_PENDING' });
  assert.equal(await onHand('syn-own'), 10, 'повторное решение остаток не поднимает');
  const after = stockReturnsView({ id: 'w', demo: false, viewer: { role: 'OWNER' } } as never, await store.listReturns('t', 50), en);
  assert.deepEqual([after.pendingCount, after.items.find((x) => x.sku === 'syn-own')!.statusText, after.items.find((x) => x.sku === 'syn-own')!.note], [0, en.ui.stock.returns.status.ACCEPTED, 'ok']);
});

/**
 * Шаг 64 (проход консоли глазами клиента из США): английский интерфейс не несёт ссылок на внутренние решения и открытые вопросы —
 * «(Р-35)», «(OQ-77, Р-32)» продавцу ничего не говорят, а кириллическая «Р» выдаёт внутреннюю кухню. Правило читает ИСХОДНИК
 * словаря без комментариев: так видны и тексты-функции, которые перебором значений не достать [Р-146].
 */
test('шаг 64: английский и немецкий словари без ссылок на решения (Р-NN), открытые вопросы (OQ-NN), миграции, шаги и риски', async () => {
  const { readFileSync } = await import('node:fs');
  // Ревью шага 64: и номера миграций «(0078)», и «since step 28», и «risk 17» — та же внутренняя кухня. Шаг 68 (K10): немецкий тоже —
  // гость публичного демо открывает консоль по-немецки, и «(Р-74)» в объяснении решения видел первым
  const hasRef = (line: string) => /Р-\d+|OQ-\d+|\b[AEK]-\d{2}\b|\(0\d{3}\)|\bsteps? \d+\b|\brisk \d+\b|\bSchritte?n? \d+\b|\bRisiko \d+\b/.test(line);
  // Положительные контроли: правило видит каждый вид ссылки, и после снятия комментариев тексты на месте
  for (const sample of ["KAUFLAND: 'the offer (id_offer, Р-35)'", '(OQ-77)', 'not confirmed (A-16)', 'a second factor (0078)', 'since step 28', 'the remainder of risk 17', 'seit Schritt 28', 'Rest von Risiko 17']) {
    assert.ok(hasRef(sample), sample);
  }
  for (const [file, loading] of [['en.ts', 'Loading…'], ['de.ts', 'Standdaten werden geladen']] as const) {
    const source = readFileSync(new URL(`./i18n/${file}`, import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(code.includes(loading), `${file}: после снятия комментариев тексты словаря остались`);
    const hits = code.split('\n').filter(hasRef);
    assert.deepEqual(hits.map((l) => l.trim().slice(0, 120)), [], `${file}: ссылки на решения и вопросы в текстах`);
  }
});

/** Шаг 64: доллары у продавца из США — `$1,234.56` (en-US), без евро-привычек; немецкая консоль пишет те же доллары по-своему */
test('шаг 64: сумма в USD — $1,234.56 по-английски и 1.234,56 $ по-немецки, минус и копейки без округления', async () => {
  const { numberFormat } = await import('./i18n/shape.ts');
  const en = numberFormat('en', '—');
  const de = numberFormat('de', '—');
  assert.equal(en.money(123456, 'USD'), '$1,234.56');
  assert.equal(en.money(-99, 'USD'), '−$0.99');
  assert.equal(en.money(100000005, 'USD'), '$1,000,000.05');
  assert.equal(de.money(123456, 'USD'), '1.234,56 $');
  assert.equal(en.money(123456, 'EUR'), '€1,234.56');
  assert.equal(en.money(123456, null), '—', 'сумма без валюты не домысливается [Р-71]');
});

/**
 * Шаг 69 (K9): единый словарь терминов консоли — [docs/console-glossary.md](../../../docs/console-glossary.md). Правило читает ТЕКСТЫ
 * словарей (строки и шаблоны без подстановок, без комментариев и ключей): экраны и письма берут тексты только отсюда [Р-72]. Запрещённый
 * синоним — красная сборка; исключение одно: «listing» — слово eBay, оно допустимо в тексте, который говорит об eBay или Trading API.
 */
export const GLOSSARY_FORBIDDEN: Readonly<Record<'en' | 'de', ReadonlyArray<{ pattern: RegExp; use: string }>>> = {
  en: [
    { pattern: /\btenants?\b/i, use: 'workspace' },
    { pattern: /\bseller accounts?\b/i, use: 'workspace (repracer) or channel account (channel)' },
    { pattern: /\baccount groups?\b/i, use: 'workspace' },
    { pattern: /\bmarketplaces?\b/i, use: 'storefront (amazon.de) or channel (Amazon)' },
    { pattern: /\bunits?\b(?! costs?)/i, use: 'offer; pieces for quantities (“unit cost” stays)' },
    { pattern: /\bitems?\b/i, use: 'offer or product' },
    { pattern: /\barticles?\b/i, use: 'product' },
    { pattern: /\bchannel connections?\b/i, use: 'channel account' },
    { pattern: /\bstand\b(?! still)/i, use: 'server (the stand is a test bench)' },
  ],
  de: [
    { pattern: /\bMandant(en|in)?\b|Mandanten-?[Ss]topp/, use: 'Arbeitsbereich' },
    { pattern: /\bMarktpl(atz|atzes|ätze|ätzen)\b/, use: 'Storefront oder Kanal' },
    { pattern: /\bEinheit(en)?\b|Kanaleinheit/, use: 'Angebot; Stück für Mengen' },
    { pattern: /\bArtikel\b/, use: 'Produkt' },
    { pattern: /\bListings?\b/, use: 'Angebot' },
    { pattern: /\bVerkäuferkont(o|en|os)\b|\bHändlerkont(o|en|os)\b/, use: 'Arbeitsbereich oder Kanalkonto' },
    { pattern: /\bKanalverbindung(en)?\b/, use: 'Kanalkonto' },
    { pattern: /\bKanal-Kont(o|os|en)\b/, use: 'Kanal-Backoffice (Verkäuferbereich des Kanals) oder Kanalkonto' },
    { pattern: /\bStand(es|s)?\b|Standzeit/, use: 'Server (der Stand ist ein Prüfstand)' },
  ],
};
const EBAY_LISTING = /\blistings?\b/i;

/** Тексты исходника словаря: строки в кавычках и шаблоны без `${…}`, без комментариев */
export function dictionaryTexts(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  let i = 0;
  const quoted = (q: string): void => {
    let s = '';
    i++;
    while (i < code.length && code[i] !== q && code[i] !== '\n') {
      if (code[i] === '\\') { s += code[i + 1]; i += 2; continue; }
      s += code[i]; i++;
    }
    i++;
    out.push(s);
  };
  const template = (): void => {
    let s = '';
    i++;
    while (i < code.length && code[i] !== '`') {
      if (code[i] === '\\') { s += code[i + 1]; i += 2; continue; }
      if (code[i] === '$' && code[i + 1] === '{') {
        let depth = 1;
        i += 2;
        s += ' ';
        while (i < code.length && depth > 0) {
          if (code[i] === '`') { template(); continue; }
          if (code[i] === "'" || code[i] === '"') { quoted(code[i]!); continue; }
          if (code[i] === '{') depth++;
          else if (code[i] === '}') depth--;
          i++;
        }
        continue;
      }
      s += code[i]; i++;
    }
    i++;
    out.push(s);
  };
  while (i < code.length) {
    const c = code[i]!;
    if (c === '`') template();
    else if (c === "'" || c === '"') quoted(c);
    else i++;
  }
  return out;
}

export function glossaryViolations(lang: 'en' | 'de', texts: readonly string[]): string[] {
  const hits: string[] = [];
  for (const text of texts) {
    // Строка из одного слова — ключ, код или значение перечисления, а не текст продавца
    if (!/\s/.test(text)) continue;
    for (const { pattern, use } of GLOSSARY_FORBIDDEN[lang]) {
      if (!pattern.test(text)) continue;
      if (lang === 'en' && pattern.source === EBAY_LISTING.source) continue;
      hits.push(`${pattern} → ${use}: ${text.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
    if (lang === 'en' && EBAY_LISTING.test(text) && !/eBay|Trading API/.test(text)) hits.push(`listing → offer (outside eBay): ${text.slice(0, 140)}`);
  }
  return hits;
}

test('шаг 69 (K9): словари EN и DE говорят терминами глоссария — запрещённых синонимов нет, «listing» — только об eBay', async () => {
  const { readFileSync } = await import('node:fs');
  // Положительные контроли: каждое запрещённое слово правило видит, разрешённое — пропускает
  const en = (s: string) => glossaryViolations('en', [s]).length;
  const de = (s: string) => glossaryViolations('de', [s]).length;
  for (const bad of ['the whole tenant', 'Your seller account is ready', 'the account group stop', 'read from the marketplace', 'channel units in sync', 'the item may break',
    'one article', 'Open the channel connections', 'The stand is unavailable', 'Check the listing in the channel']) assert.equal(en(bad), 1, bad);
  for (const ok of ['the unit cost of this offer', 'prices stand still', 'older eBay listings', 'edits this listing through the Trading API', 'Workspace: Demo']) assert.equal(en(ok), 0, ok);
  for (const bad of ['den gesamten Mandanten', 'ein Mandanten-Stopp', 'Rechner des Marktplatzes', 'neue Einheiten', 'Kanaleinheiten im Abgleich', 'ein Artikel hier',
    'Ihr Verkäuferkonto ist da', 'dieses Händlerkonto ist verbunden', 'Öffnen Sie die Kanalverbindungen', 'im Kanal-Konto prüfen', 'Fehler des Stands.']) assert.equal(de(bad), 1, bad);
  for (const ok of ['Kanalkonto verbinden', 'im Kanal-Backoffice prüfen', 'Ihre Stückkosten sind ein Betrag', 'Das Angebot steht still']) assert.equal(de(ok), 0, ok);
  // Разбор исходника: подстановки шаблона и комментарии не считаются текстом, тексты-функции — считаются
  assert.deepEqual(dictionaryTexts("/* tenant */ a: (t: string) => `Your ${t} tenant`, // tenant\n b: 'x y'"), ['Your   tenant', 'x y']);
  for (const lang of ['en', 'de'] as const) {
    const texts = dictionaryTexts(readFileSync(new URL(`./i18n/${lang}.ts`, import.meta.url), 'utf8'));
    assert.ok(texts.length > 1000, `${lang}: тексты словаря прочитаны — ${texts.length}`);
    assert.deepEqual(glossaryViolations(lang, texts), [], `${lang}: запрещённые синонимы глоссария`);
  }
});

/**
 * Шаг 69 (K4): время показа — в поясе продавца со смещением; внутри системы — UTC. Переход на летнее время берётся из настенного
 * времени Intl, смещение с минутами подписано минутами, календарная дата не сдвигается, неизвестный среде пояс — UTC без падения
 */
test('шаг 69 (K4): время в поясе продавца — летнее и зимнее смещение, минуты смещения, дата без сдвига, неизвестный пояс', async () => {
  const { messagesFor } = await import('./i18n/index.ts');
  const la = messagesFor('en', { timeZone: 'America/Los_Angeles' });
  assert.equal(la.when('2026-10-02T07:34:21Z'), '2026-10-02 00:34:21 UTC−7', 'летнее время Тихоокеанского побережья');
  assert.equal(la.when('2026-12-02T07:34:21Z'), '2026-12-01 23:34:21 UTC−8', 'зимнее время — на час дальше, и сутки ещё вчерашние');
  assert.equal(messagesFor('de', { timeZone: 'Europe/Berlin' }).when('2026-10-02T07:34:21Z'), '02.10.2026, 09:34:21 UTC+2');
  assert.equal(messagesFor('en', { timeZone: 'Asia/Kolkata' }).when('2026-10-02T07:34:21Z'), '2026-10-02 13:04:21 UTC+5:30', 'смещение с минутами');
  assert.equal(la.date('2026-10-02'), messagesFor('en').date('2026-10-02'), 'календарная дата — та же в любом поясе');
  assert.equal(messagesFor('en', { timeZone: 'UTC' }).when('2026-10-02T07:34:21Z'), messagesFor('en').when('2026-10-02T07:34:21Z'), 'UTC — прежний вид');
  // Ревью шага 69, находка 15: пояс, неизвестный среде, не роняет экран — время в UTC
  assert.equal(messagesFor('en', { timeZone: 'Mars/Olympus_Mons' }).when('2026-10-02T07:34:21Z'), messagesFor('en').when('2026-10-02T07:34:21Z'));
});
