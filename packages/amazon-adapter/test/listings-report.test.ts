import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeDiscoveryCursor, decodeReportDocument, encodeDiscoveryCursor, parseListingsReport, REPORT_DOCUMENTED_COLUMNS } from '../src/index.ts';

/**
 * Шаг 117 (P0-16): строгий разбор документа отчёта GET_MERCHANT_LISTINGS_ALL_DATA (страница отчёта: табуляция, UTF-8 BOM, колонки списка) и курсор
 * обнаружения. Каждое правило — своим утверждением с зубами [Р-94]. Данные синтетические
 */
const header = REPORT_DOCUMENTED_COLUMNS.join('\t');
const row = (sku: string, extra = '') => REPORT_DOCUMENTED_COLUMNS.map((c) => (c === 'seller-sku' ? sku : c === 'item-name' ? `Synthetic ${sku}` : '')).join('\t') + extra;

test('step 117: the report document — BOM and CRLF, every SKU once, broken rows skipped and counted, unknown columns named', () => {
  const text = `﻿${header}\tsyn-new-column\r\n${row('SYN-A')}\r\n${row('SYN-B')}\r\n${row('SYN-A')}\r\n${row('')}\r\n${row('SYN-\u0007')}\r\n${row('SYN-C', '\tx\ty')}\r\nSYN-SHORT-ROW\r\n`;
  const r = parseListingsReport(text);
  assert.ok(r.ok);
  assert.deepEqual(r.skus, ['SYN-A', 'SYN-B'], 'each SKU once, in the order of the report');
  assert.deepEqual([r.rows, r.badRows, r.duplicates], [7, 4, 1], 'empty and control-character SKU, a row with extra fields, a row without the SKU column — skipped and counted');
  assert.deepEqual(r.unknownColumns, ['syn-new-column'], 'a column outside the page is named, not refused');
  // Строка короче заголовка допустима, если SKU в ней есть: хвостовые колонки адаптер не читает
  const short = parseListingsReport(`${header}\nSynthetic\t\t\tSYN-D\n`);
  assert.ok(short.ok && short.skus.join() === 'SYN-D', JSON.stringify(short));
});

test('step 117 (A-37): headers in another locale — no seller-sku column — the report does not go at all', () => {
  assert.deepEqual(parseListingsReport(`${REPORT_DOCUMENTED_COLUMNS.map((c) => `syn-localized-${c}`).join('\t')}\n${row('SYN-A')}\n`), { ok: false, reason: 'REPORT_HEADER' });
  assert.deepEqual(parseListingsReport(''), { ok: false, reason: 'REPORT_HEADER' });
});

test('step 117 (A-36): UTF-8 only — charset named otherwise or bytes that are not UTF-8 are refused; GZIP is unpacked with a size limit', () => {
  const bytes = new TextEncoder().encode(`﻿${header}\n${row('SYN-É')}\n`);
  const ok = decodeReportDocument(bytes, undefined, 'text/plain;charset=UTF-8');
  assert.ok(ok.ok && parseListingsReport(ok.text).ok);
  assert.ok(decodeReportDocument(bytes, undefined, null).ok, 'no charset — UTF-8, as the page says');
  assert.deepEqual(decodeReportDocument(bytes, undefined, 'text/plain; charset=Cp1252'), { ok: false, reason: 'REPORT_ENCODING' });
  assert.deepEqual(decodeReportDocument(new Uint8Array([0x53, 0xff, 0x41]), undefined, null), { ok: false, reason: 'REPORT_ENCODING' }, 'not UTF-8 — refused, not guessed');
  assert.ok(decodeReportDocument(gzipSync(bytes), 'GZIP', 'text/plain').ok);
  assert.deepEqual(decodeReportDocument(bytes, 'ZIP', null), { ok: false, reason: 'REPORT_DOCUMENT' }, 'an unknown compression is refused');
  assert.deepEqual(decodeReportDocument(bytes, 'GZIP', null), { ok: false, reason: 'REPORT_DOCUMENT' }, 'GZIP that is not GZIP is refused');
  const bomb = gzipSync(Buffer.alloc(300 * 1024 * 1024));
  assert.deepEqual(decodeReportDocument(bomb, 'GZIP', null), { ok: false, reason: 'REPORT_DOCUMENT' }, 'a document unpacking past 256 MiB is refused');
});

test('step 117: the discovery cursor carries the phase; an unknown or broken cursor of ours starts the circle, a raw token of the old search goes on by search', () => {
  for (const c of [{ kind: 'CREATE', i: 1 }, { kind: 'WAIT', i: 0, reportId: 'syn-report-1' }, { kind: 'DOCUMENT', i: 0, documentId: 'amzn1.spdoc.1.4.na.syn', offset: 40, token: 'syn-page-2' },
    { kind: 'SEARCH', i: 0, reason: 'REPORT_REFUSED', token: null }] as const) {
    assert.deepEqual(decodeDiscoveryCursor(encodeDiscoveryCursor(c)), c);
  }
  assert.deepEqual(decodeDiscoveryCursor(undefined), { kind: 'CREATE', i: 0 });
  assert.deepEqual(decodeDiscoveryCursor('amz2:not-json'), { kind: 'CREATE', i: 0 });
  assert.deepEqual(decodeDiscoveryCursor(`amz2:${Buffer.from(JSON.stringify({ kind: 'DOCUMENT', i: 0, documentId: 'x', offset: -1 })).toString('base64url')}`), { kind: 'CREATE', i: 0 });
  assert.deepEqual(decodeDiscoveryCursor('syn-page-40'), { kind: 'LEGACY', token: 'syn-page-40' });
});
