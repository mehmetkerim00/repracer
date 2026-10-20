import assert from 'node:assert/strict';
import { test } from 'node:test';
import { csvOf } from './exports.ts';
import { amountText, changePercent, EXPORT_HEADERS, EXPORT_SCREENS, exportAboutLines, exportFileName, isoInZone, workspaceSlug } from './screen-export.ts';

/**
 * Шаг 104 [Р-229] на модели (данные синтетические): заголовки — английские и непустые у каждого экрана; время — ISO 8601 в поясе рабочего
 * пространства (летнее и зимнее смещение); суммы — числом с точкой по разрядности валюты; имя файла — «<workspace>-<screen>-<period>»;
 * лист «About this export» называет всё, что задаёт выгрузку; CSV не делает текстом отрицательное число
 */

test('step 104 [Р-229]: column headers are English, unique and present for every screen', () => {
  for (const screen of EXPORT_SCREENS) {
    const h = EXPORT_HEADERS[screen];
    assert.ok(h.length > 0 && new Set(h).size === h.length && h.every((x) => /^[a-z][a-z0-9_]*$/.test(x)), `${screen}: ${h.join(',')}`);
  }
});

test('step 104 [Р-229]: times are ISO 8601 with the workspace zone, amounts are numbers with a point by the currency digits', () => {
  assert.equal(isoInZone('2026-10-20T07:04:05.678Z', 'America/New_York'), '2026-10-20T03:04:05-04:00', 'summer time in New York');
  assert.equal(isoInZone('2026-12-20T07:04:05.000Z', 'America/New_York'), '2026-12-20T02:04:05-05:00', 'winter time in New York');
  assert.equal(isoInZone('2026-10-20T07:04:05.000Z', 'Europe/Berlin'), '2026-10-20T09:04:05+02:00');
  assert.equal(isoInZone('2026-10-20T07:04:05.000Z', null), '2026-10-20T07:04:05Z', 'no zone — UTC');
  assert.equal(isoInZone('2026-10-20T07:04:05.000Z', 'Not/AZone'), '2026-10-20T07:04:05Z', 'a zone ICU does not know — UTC, as on the screens');
  assert.equal(isoInZone(null, 'UTC'), '');
  assert.equal(JSON.stringify([amountText(1799, 'USD'), amountText(5, 'EUR'), amountText(-1250, 'EUR'), amountText(1500, 'JPY'), amountText(null, 'EUR')]),
    JSON.stringify(['17.99', '0.05', '-12.50', '1500', '']));
  assert.equal(JSON.stringify([changePercent(2000, 1750), changePercent(null, 1750), changePercent(0, 10)]), JSON.stringify(['-12.5', '', '']));
});

test('step 104 [Р-229]: the file name is <workspace>-<screen>-<period>; «About this export» names the workspace, screen, period, filters, who, when and rows', () => {
  assert.equal(exportFileName('Demo store (simulator)', 'price-changes', '2026-10-13_2026-10-20'), 'demo-store-simulator-price-changes-2026-10-13_2026-10-20');
  assert.equal(workspaceSlug('Tienda de demostración'), 'tienda-de-demostracion', 'accents become plain letters');
  assert.equal(workspaceSlug('***'), 'workspace');
  const lines = exportAboutLines({ workspace: 'Demo store', screen: 'decisions', period: { since: '2026-10-13T04:00:00.000Z', until: null }, filters: { outcome: 'REJECTED', search: '' },
    exportedBy: 'Alex Porter', exportedAt: '2026-10-20T14:00:00.000Z', rows: 37, timeZone: 'America/New_York' });
  assert.deepEqual(lines.slice(0, 8), ['About this export', 'Workspace: Demo store', 'Screen: Price changes — all decisions',
    'Period: 2026-10-13T00:00:00-04:00 – 2026-10-20T10:00:00-04:00', 'Filters: outcome = REJECTED', 'Exported by: Alex Porter', 'Exported at: 2026-10-20T10:00:00-04:00', 'Rows: 37']);
  assert.match(lines[8]!, /^Column headers are always in English\. Times are ISO 8601 in the workspace time zone \(America\/New_York\)\./);
  assert.equal(exportAboutLines({ workspace: 'W', screen: 'offers', period: null, filters: {}, exportedBy: 'x', exportedAt: '2026-10-20T14:00:00.000Z', rows: 0, timeZone: null })[3],
    'Period: current state at the time of export');
});

test('step 104 [Р-229]: CSV keeps a plain negative number a number; a value that starts like a formula still gets the apostrophe', () => {
  assert.equal(csvOf(['a', 'b', 'c'], [['-12.5', '=SUM(A1)', '-x']]), "a,b,c\n-12.5,'=SUM(A1),'-x\n");
});
