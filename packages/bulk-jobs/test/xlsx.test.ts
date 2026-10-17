import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { parseXlsx, readTable } from '@repracer/cost-import';
import type { BulkJobOutcome, BulkJobRow, PricingStore } from '@repracer/pricing-pipeline';
import { runNextBulkJob, type BulkJobHandlers } from '../src/index.ts';
import { crc32, xlsxOf } from '../src/xlsx.ts';

/**
 * Шаг 99 [Р-224]: шаблон импорта книгой XLSX — без новой зависимости. Книгу собирает единственный путь выгрузки [Р-145], и читается
 * она тем же разбором, что файлы продавца: что записано, то и прочитано — с ведущими нулями, знаками и строками справки
 */

test('step 99: a workbook reads back cell for cell — leading zeros, formula signs and markup stay text, the first sheet is the data', () => {
  const rows = [['sku', 'title', 'unit_cost'], ['# example: ABC-123', 'Garden hose, 15 m', '7.50'], ['00042', '=SUM(1) & <b>"x"</b>', '12.00'], ['', 'only title', '']];
  const bytes = xlsxOf([{ name: 'Data', rows, header: true }, { name: 'Help: [read me]', rows: [['How to fill in']] }]);
  const sheet = parseXlsx(bytes);
  assert.deepEqual(sheet.rows, rows, 'the first sheet — the data sheet — reads back as written');
  assert.deepEqual(sheet.lines, [1, 2, 3, 4], 'row numbers are the numbers of the sheet');
  assert.equal(readTable(bytes).format, 'XLSX', 'the import recognises the workbook by its content');
  assert.ok(bytes.toString('latin1').includes('xl/worksheets/sheet2.xml'), 'the help sheet is in the workbook');
  // Одинаковое содержимое — одинаковые байты: у шаблона сумма зависит только от данных
  assert.equal(createHash('sha256').update(xlsxOf([{ name: 'Data', rows }])).digest('hex'), createHash('sha256').update(xlsxOf([{ name: 'Data', rows }])).digest('hex'));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 of the zip entries is the standard one');
});

test('step 99 (Р-145): the executor builds the workbook — base64 in the database, the checksum of the bytes, the extension by the content', async () => {
  const saved: Array<{ fileName: string; contentType: string; content: string; sha256: string; rows: number }> = [];
  let outcome: BulkJobOutcome | null = null;
  let claims = 0;
  const job = {
    jobId: 'bf000000-0000-4000-8000-000000000991', kind: 'IMPORT_TEMPLATE', status: 'RUNNING', params: {}, phase: 'PREPARING', totalItems: null, doneItems: 0,
    result: null, errorCode: null, attempts: 1, createdWithMfa: false, createdByMembershipId: 'm-1', createdByUserId: 'u-1', createdAt: '2026-10-17T10:00:00.000Z',
    startedAt: null, finishedAt: null, leaseOwner: 'worker', leaseUntil: '2026-10-17T10:01:00.000Z', leaseExpired: false,
  } as BulkJobRow;
  const store = {
    async tenantIsDemo() { return false; },
    async claimBulkJob() { claims += 1; return claims === 1 ? job : null; },
    async updateBulkJobProgress() { return true; },
    async finishBulkJob(_t: string, _j: string, _o: string, o: BulkJobOutcome) { outcome = o; return true; },
    async saveBulkJobArtifact(_t: string, _j: string, a: (typeof saved)[number]) { saved.push({ ...a }); },
  } as unknown as PricingStore;
  const handlers: BulkJobHandlers = {
    async IMPORT_TEMPLATE() {
      return {
        total: 1,
        async run(_p, produce) {
          return { ...await produce({
            fileName: 'unit-costs-template', header: ['sku', 'unit_cost'], rows: [['A-1', '7.50']], format: 'xlsx',
            comments: [{ cells: ['# example: ABC-123', '1.00'], onDataSheet: true }, { cells: ['# How to fill in'] }],
            sheets: { data: 'Data', help: 'Help', helpLines: ['How to fill in'] },
          }) };
        },
      };
    },
  };
  await runNextBulkJob({ store, tenantId: '10000000-0000-4000-8000-000000000991', owner: 'worker', handlers });
  assert.equal((outcome as BulkJobOutcome | null)?.status, 'SUCCEEDED');
  const file = saved[0]!;
  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(file.fileName, 'unit-costs-template.xlsx', 'the extension is set by the content');
  const bytes = Buffer.from(file.content, 'base64');
  assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'), 'the checksum is of the workbook bytes, not of its base64 text');
  // На листе данных — заголовок, пример и строки; пояснение — только на листе справки
  assert.deepEqual(parseXlsx(bytes).rows, [['sku', 'unit_cost'], ['# example: ABC-123', '1.00'], ['A-1', '7.50']]);
});
