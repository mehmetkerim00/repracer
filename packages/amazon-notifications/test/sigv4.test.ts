import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalRequest, signRequest } from '../src/sigv4.ts';
import { createSqsClient, regionOfQueue } from '../src/sqs.ts';
import { FakeSqs } from '../src/testing.ts';

/** Ключи — пример AWS из документации, синтетические */
const CREDENTIALS = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLE' };
const QUEUE = 'https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-syn-notifications';

test('SigV4: the signature equals an independent implementation of the documented algorithm (test/sigv4_reference.py)', () => {
  const body = '{"QueueUrl":"https://sqs.eu-west-1.amazonaws.com/000000000000/repracer-syn-notifications","MaxNumberOfMessages":10,"WaitTimeSeconds":20}';
  const headers = signRequest({ method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'AmazonSQS.ReceiveMessage' }, body },
    CREDENTIALS, 'eu-west-1', 'sqs', new Date('2026-09-17T10:15:00.000Z'));
  assert.equal(headers['x-amz-date'], '20260917T101500Z');
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20260917/eu-west-1/sqs/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=3a4c7c9f3c3ebefce11fd4a03f5a1ab666d86775b4bd45de18f2dcaaf1e958f4');
  assert.ok(!JSON.stringify(headers).includes(CREDENTIALS.secretAccessKey), 'the secret key never appears in the headers');
  // Канонический запрос: пустой путь — «/», параметры запроса отсортированы и закодированы по RFC 3986
  assert.equal(canonicalRequest({ method: 'get', url: 'https://example.amazonaws.com?b=2&a=x y', headers: { host: 'example.amazonaws.com' }, body: '' }, ['host']).split('\n').slice(0, 3).join('|'),
    'GET|/|a=x%20y&b=2');
  const temporary = signRequest({ method: 'POST', url: 'https://sqs.eu-west-1.amazonaws.com/', headers: {}, body: '{}' }, { ...CREDENTIALS, sessionToken: 'syn-session-token' }, 'eu-west-1', 'sqs', new Date());
  assert.match(temporary.authorization!, /SignedHeaders=host;x-amz-date;x-amz-security-token,/);
});

test('SQS JSON protocol: target header, attributes, long-poll timeout beyond WaitTimeSeconds, partial delete failure, errors without message text', async () => {
  const clock = { nowMs: Date.parse('2026-09-17T10:00:00.000Z') };
  const sqs = new FakeSqs(clock);
  sqs.send('{"a":1}', { sentMs: clock.nowMs - 5_000 });
  const client = createSqsClient({ queueUrl: QUEUE, credentials: async () => CREDENTIALS, fetch: sqs.fetch, now: () => new Date(clock.nowMs), timeoutMs: 50 });
  assert.equal(regionOfQueue(QUEUE), 'eu-west-1');
  assert.throws(() => regionOfQueue('https://example.com/queue'), /queue URL/);
  const r = await client.receive({ maxMessages: 50, waitTimeSeconds: 99, visibilityTimeoutSeconds: 60 });
  assert.ok(r.ok);
  assert.deepEqual(sqs.requests[0]!.body, { QueueUrl: QUEUE, MaxNumberOfMessages: 10, WaitTimeSeconds: 20, VisibilityTimeout: 60, MessageSystemAttributeNames: ['SentTimestamp', 'ApproximateReceiveCount', 'SenderId'] });
  assert.equal(sqs.requests[0]!.target, 'AmazonSQS.ReceiveMessage');
  assert.match(sqs.requests[0]!.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/eu-west-1\/sqs\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=[0-9a-f]{64}$/);
  assert.deepEqual(r.value[0]!.attributes, { sentTimestampMs: clock.nowMs - 5_000, approximateReceiveCount: 1, senderId: 'AIDASYNTHETICSENDER01' });
  const del = await client.deleteBatch([{ id: '0', receiptHandle: r.value[0]!.receiptHandle }, { id: '1', receiptHandle: 'stale-handle' }]);
  assert.deepEqual(del, { ok: true, value: { successful: ['0'], failed: [{ id: '1', code: 'ReceiptHandleIsInvalid', senderFault: true }] } });
  await assert.rejects(client.deleteBatch(Array.from({ length: 11 }, (_, i) => ({ id: String(i), receiptHandle: 'h' }))), /at most 10/);
  sqs.failNextReceive = 400;
  assert.deepEqual(await client.receive({ maxMessages: 1, waitTimeSeconds: 0, visibilityTimeoutSeconds: 30 }), { ok: false, status: 400, errorType: 'OverLimit' });
});
