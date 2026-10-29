import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { apiExchanges, apiModelErrors, loadApiOperations, operationOf, type ApiOperation } from './amazon-fixtures/schema-check.ts';

/**
 * Шаг 109 [A, Р-146]: тела ОТВЕТОВ SP-API в фикстурах стенда — по схеме ответа операции модели снимка 2026-10-29, как уведомления шага 97:
 * ни одного пропущенного обязательного поля и ни одного поля вне модели. Разведка шага 108 сверила фикстуры с настоящими ответами песочницы
 * (docs/evidence/step108-sp-api-recon.md): у 57 из 61 сводки листинга не было обязательных `createdDate` и `lastUpdatedDate`, а
 * `conditionType` и `itemName`, которые адаптер читает, стенд не подавал вовсе
 */

const FIXTURES = new URL('../fixtures/amazon/', import.meta.url);
const OPS = loadApiOperations();

function fixtures(): Array<{ file: string; fixture: unknown }> {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort().map((file) => ({ file, fixture: JSON.parse(readFileSync(new URL(file, FIXTURES), 'utf8')) as unknown }));
}

const schemaOf = (op: ApiOperation, status: number) => op.responses[String(status)]?.schema ?? op.responses.default?.schema;

test('step 109 [A]: every SP-API response in the Amazon stand fixtures passes its operation model — nothing required missing, nothing outside', () => {
  let bodies = 0;
  const problems: string[] = [];
  for (const { file, fixture } of fixtures()) {
    for (const e of apiExchanges(fixture)) {
      const op = operationOf(OPS, e.method, e.path);
      if (!op) { problems.push(`${file} ${e.id}: ${e.method} ${e.path} is not an operation of the models snapshot`); continue; }
      const schema = schemaOf(op, e.status);
      if (!schema) {
        if (e.body !== undefined && e.body !== null) problems.push(`${file} ${e.id}: ${op.operationId} answers ${e.status} without a body in the model, the fixture has one`);
        continue;
      }
      bodies += 1;
      for (const p of apiModelErrors(op.model, schema, e.body)) problems.push(`${file} ${e.id} ${op.operationId} ${e.status} ${p}`);
    }
  }
  assert.ok(bodies >= 80, `the fixtures carry SP-API responses (${bodies})`);
  assert.deepEqual(problems, [], 'a stand response lacks a field the channel always sends, or carries one the model does not describe');
});

/** Поля сводки листинга, которые читает адаптер: витрина, ASIN, тип товара (запись), статус (продаётся ли), состояние и название (обнаружение) */
const SUMMARY_FIELDS_READ = ['marketplaceId', 'asin', 'productType', 'status', 'conditionType', 'itemName'] as const;

test('step 109 [A]: every listing summary in the fixtures carries every field the adapter reads from it', () => {
  let summaries = 0;
  const problems: string[] = [];
  for (const { file, fixture } of fixtures()) {
    for (const e of apiExchanges(fixture)) {
      const op = operationOf(OPS, e.method, e.path);
      if (e.status !== 200 || (op?.operationId !== 'getListingsItem' && op?.operationId !== 'searchListingsItems')) continue;
      const body = e.body as { summaries?: unknown[]; items?: Array<{ summaries?: unknown[] }> };
      for (const s of [...(body.summaries ?? []), ...(body.items ?? []).flatMap((i) => i.summaries ?? [])] as Array<Record<string, unknown>>) {
        summaries += 1;
        const absent = SUMMARY_FIELDS_READ.filter((f) => !(f in s));
        if (absent.length > 0) problems.push(`${file} ${e.id}: ${absent.join(', ')}`);
      }
    }
  }
  assert.ok(summaries >= 50, `the fixtures carry listing summaries (${summaries})`);
  assert.deepEqual(problems, [], 'the stand never feeds the adapter a field it reads: the parse of that field is untested');
});

test('step 109 [A]: positive control — the check refuses a missing required field, a field outside the model and a wrong kind', () => {
  const op = OPS.find((o) => o.operationId === 'getListingsItem')!;
  const sample = structuredClone((op.responses['200'] as { 'x-amzn-api-sandbox': { static: Array<{ response: Record<string, unknown> }> } })['x-amzn-api-sandbox'].static[0]!.response) as {
    summaries: Array<Record<string, unknown>>; offers: Array<{ price: Record<string, unknown> }> };
  const schema = schemaOf(op, 200)!;
  assert.deepEqual(apiModelErrors(op.model, schema, sample), [], 'the model sample itself passes');
  delete sample.summaries[0]!.createdDate;
  sample.summaries[0]!.IsBuyBoxWinner = true;
  sample.offers[0]!.price.amount = 100;
  assert.deepEqual(apiModelErrors(op.model, schema, sample), [
    '$.offers[].price.amount: integer, the model says string',
    '$.summaries[].IsBuyBoxWinner: not in the model',
    '$.summaries[].createdDate: required by the model, absent',
  ]);
  // Атрибуты листинга в модели — свободный объект: их форму держат страницы документации, не модель (step 108, finding 3)
  assert.deepEqual(apiModelErrors(op.model, schema, { sku: 'SYN-SKU-109', attributes: { purchasable_offer: [{ our_price: [] }] } }), []);
  assert.equal(operationOf(OPS, 'GET', '/listings/2021-08-01/items/A1SYNSELLER0001')?.operationId, 'searchListingsItems');
  assert.equal(operationOf(OPS, 'GET', '/listings/2021-08-01/items/A1SYNSELLER0001/SYN-SKU-109')?.operationId, 'getListingsItem');
});
