import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkPartB, parseEnvFile, PART_B_KEYS, reportPartB } from '../src/part-b.ts';

/**
 * Шаг 114: конфигурация части Б — шаблон с заглушками и проверка заполненного файла «да/нет» без значений. Значения ниже синтетические
 */
const TEMPLATE = fileURLToPath(new URL('../../../deploy/notification-receiver/part-b.env.example', import.meta.url));
const APP = 'amzn1.sellerapps.app.syn-part-b-0114';
const SOURCE = `aws.partner/sellingpartnerapi.amazon.com/123456789012/${APP}`;
const FILLED: Record<string, string> = {
  REPRACER_AMAZON_REGION: 'NA', REPRACER_AWS_REGION: 'us-east-1', REPRACER_AWS_ACCOUNT_ID: '123456789012', REPRACER_AMAZON_APPLICATION_ID: APP,
  REPRACER_SQS_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/syn-notifications',
  REPRACER_SQS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:syn-notifications',
  REPRACER_SQS_DLQ_ARN: 'arn:aws:sqs:us-east-1:123456789012:syn-notifications-dlq',
  REPRACER_EVENTBRIDGE_PARTNER_SOURCE: SOURCE,
  REPRACER_EVENTBRIDGE_BUS_ARN: `arn:aws:events:us-east-1:123456789012:event-bus/${SOURCE}`,
  REPRACER_EVENTBRIDGE_RULE_ARN: `arn:aws:events:us-east-1:123456789012:rule/${SOURCE}/syn-listings-to-queue`,
  REPRACER_SPAPI_DESTINATION_ID_SQS: 'syn-destination-sqs-0114', REPRACER_SPAPI_DESTINATION_ID_EVENTBRIDGE: 'syn-destination-eb-0114',
  REPRACER_AWS_ACCESS_KEY_ID: 'AKIASYNTHETICPARTB14', REPRACER_AWS_SECRET_ACCESS_KEY: 'syn-part-b-secret-access-key-0114',
};
const failed = (env: Record<string, string>) => checkPartB(env).filter((c) => !c.ok).map((c) => c.check);

test('step 114: the template names every variable of part B and every one of them is a placeholder — the check says «no» to each', () => {
  const template = parseEnvFile(readFileSync(TEMPLATE, 'utf8'));
  assert.deepEqual(Object.keys(template).sort(), [...PART_B_KEYS].sort());
  const unfilled = checkPartB(template).filter((c) => c.check.endsWith('заполнен') && !c.ok).map((c) => c.check);
  // Регион SP-API в шаблоне уже назван (рынок США, Р-214) — остальные значения заглушки
  assert.deepEqual(unfilled, PART_B_KEYS.filter((k) => k !== 'REPRACER_AMAZON_REGION').map((k) => `${k} заполнен`));
});

test('step 114: a consistent filled file passes every check; each kind of inconsistency is named by its own check', () => {
  assert.deepEqual(failed(FILLED), []);
  assert.deepEqual(failed({ ...FILLED, REPRACER_SQS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:210987654321:syn-notifications' }), ['всё в одном аккаунте AWS']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_SQS_DLQ_ARN: 'arn:aws:sqs:us-west-2:123456789012:syn-notifications-dlq' }), ['всё в одном регионе AWS']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_SQS_DLQ_ARN: FILLED.REPRACER_SQS_QUEUE_ARN! }), ['очередь недоставленных — другая очередь']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_SQS_QUEUE_ARN: 'arn:aws:sqs:us-east-1:123456789012:another-queue' }), ['адрес и ARN — одна очередь']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_AMAZON_APPLICATION_ID: 'amzn1.sellerapps.app.someone-else' }), ['источник партнёра — наше приложение']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_EVENTBRIDGE_RULE_ARN: 'arn:aws:events:us-east-1:123456789012:rule/default/syn-rule' }), ['шина — шина источника партнёра, правило — на этой шине']);
  assert.deepEqual(failed({ ...FILLED, REPRACER_SPAPI_DESTINATION_ID_EVENTBRIDGE: FILLED.REPRACER_SPAPI_DESTINATION_ID_SQS! }), ['адресаты SQS и EventBridge — разные']);
});

test('step 114: the report says only yes or no — no value of the file appears in it, whole or in part', () => {
  const dir = mkdtempSync(join(tmpdir(), 'part-b-'));
  try {
    const file = join(dir, 'part-b.env');
    writeFileSync(file, Object.entries(FILLED).map(([k, v]) => `${k}=${v}`).join('\n'), { mode: 0o600 });
    const { lines, ok } = reportPartB(file);
    assert.equal(ok, true);
    assert.ok(lines.every((l) => /: (да|нет)$/.test(l)), lines.join('\n'));
    const text = lines.join('\n');
    for (const value of Object.values(FILLED)) {
      // Части значения, по которым его узнать: синтетические имена, номера, ключ; слова формата (sellerapps, amazonaws) и код региона SP-API — не значения
      for (const piece of [...(value.length >= 6 ? [value] : []), ...value.split(/[/:.]/).filter((p) => /syn|\d{6,}|AKIA/i.test(p))]) assert.ok(!text.includes(piece), `a value leaked into the report: ${piece.length} chars`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
