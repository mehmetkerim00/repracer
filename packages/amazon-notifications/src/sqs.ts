import { createHash } from 'node:crypto';
import { signRequest, type AwsCredentials } from './sigv4.ts';

/**
 * Клиент Amazon SQS по протоколу AWS JSON (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-making-api-requests-json.html):
 * POST https://sqs.<регион>.amazonaws.com/, X-Amz-Target: AmazonSQS.<операция>, Content-Type: application/x-amz-json-1.0, подпись SigV4.
 * Операции и пределы — страницы API Reference (vendor/aws/SOURCE.md): ReceiveMessage (MaxNumberOfMessages 1…10, WaitTimeSeconds 0…20,
 * MessageSystemAttributeNames), DeleteMessageBatch (не больше 10 записей, частичный успех при HTTP 200), ChangeMessageVisibility.
 */
export interface SqsMessage {
  messageId: string;
  receiptHandle: string;
  body: string;
  md5OfBody: string;
  /** Системные атрибуты: SentTimestamp и ApproximateFirstReceiveTimestamp — мс эпохи, ApproximateReceiveCount — число, SenderId — строка */
  attributes: { sentTimestampMs: number | null; approximateReceiveCount: number | null; senderId: string | null };
}

export type SqsResult<T> = { ok: true; value: T } | { ok: false; status: number | 'NETWORK' | 'TIMEOUT'; errorType: string | null };

export interface SqsClient {
  receive(options: { maxMessages: number; waitTimeSeconds: number; visibilityTimeoutSeconds: number }): Promise<SqsResult<SqsMessage[]>>;
  deleteBatch(entries: ReadonlyArray<{ id: string; receiptHandle: string }>): Promise<SqsResult<{ successful: string[]; failed: Array<{ id: string; code: string; senderFault: boolean }> }>>;
  changeVisibility(receiptHandle: string, visibilityTimeoutSeconds: number): Promise<SqsResult<null>>;
}

export interface SqsClientOptions {
  /** Адрес очереди: https://sqs.<регион>.amazonaws.com/<аккаунт>/<очередь> */
  queueUrl: string;
  credentials: () => Promise<AwsCredentials>;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export function md5Hex(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('hex');
}

export function regionOfQueue(queueUrl: string): string {
  const m = /^https:\/\/sqs\.([a-z0-9-]+)\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_-]{1,80}\/?$/.exec(queueUrl);
  if (!m) throw new Error('queue URL must be https://sqs.<region>.amazonaws.com/<account>/<queue>');
  return m[1]!;
}

export function createSqsClient(options: SqsClientOptions): SqsClient {
  const region = regionOfQueue(options.queueUrl);
  const endpoint = `https://sqs.${region}.amazonaws.com/`;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  async function call<T>(operation: string, payload: Record<string, unknown>, extraTimeoutMs = 0): Promise<SqsResult<T>> {
    const body = JSON.stringify({ QueueUrl: options.queueUrl, ...payload });
    const headers = signRequest({ method: 'POST', url: endpoint, headers: { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `AmazonSQS.${operation}` }, body },
      await options.credentials(), region, 'sqs', now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (options.timeoutMs ?? 10_000) + extraTimeoutMs);
    try {
      const res = await doFetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = {}; }
      if (!res.ok) {
        // Тело ошибки AWS содержит __type; текст сообщения не логируется — в нём может быть адрес очереди
        const type = typeof json.__type === 'string' ? json.__type.split('#').pop()! : null;
        return { ok: false, status: res.status, errorType: type };
      }
      return { ok: true, value: json as T };
    } catch (error) {
      return { ok: false, status: (error as Error).name === 'AbortError' ? 'TIMEOUT' : 'NETWORK', errorType: null };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async receive({ maxMessages, waitTimeSeconds, visibilityTimeoutSeconds }) {
      const max = Math.max(1, Math.min(10, Math.trunc(maxMessages)));
      const wait = Math.max(0, Math.min(20, Math.trunc(waitTimeSeconds)));
      // HTTP-тайм-аут длиннее WaitTimeSeconds — требование страницы ReceiveMessage
      const r = await call<{ Messages?: Array<Record<string, unknown>> }>('ReceiveMessage', {
        MaxNumberOfMessages: max, WaitTimeSeconds: wait, VisibilityTimeout: visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ['SentTimestamp', 'ApproximateReceiveCount', 'SenderId'],
      }, wait * 1000);
      if (!r.ok) return r;
      const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
      return {
        ok: true,
        value: (r.value.Messages ?? []).map((m) => {
          const a = (m.Attributes ?? {}) as Record<string, unknown>;
          return {
            messageId: String(m.MessageId ?? ''), receiptHandle: String(m.ReceiptHandle ?? ''), body: String(m.Body ?? ''), md5OfBody: String(m.MD5OfBody ?? ''),
            attributes: { sentTimestampMs: num(a.SentTimestamp), approximateReceiveCount: num(a.ApproximateReceiveCount), senderId: typeof a.SenderId === 'string' ? a.SenderId : null },
          };
        }),
      };
    },
    async deleteBatch(entries) {
      if (entries.length === 0) return { ok: true, value: { successful: [], failed: [] } };
      if (entries.length > 10) throw new Error('DeleteMessageBatch accepts at most 10 entries');
      const r = await call<{ Successful?: Array<{ Id: string }>; Failed?: Array<{ Id: string; Code: string; SenderFault: boolean }> }>('DeleteMessageBatch', {
        Entries: entries.map((e) => ({ Id: e.id, ReceiptHandle: e.receiptHandle })),
      });
      if (!r.ok) return r;
      return { ok: true, value: { successful: (r.value.Successful ?? []).map((s) => s.Id), failed: (r.value.Failed ?? []).map((f) => ({ id: f.Id, code: f.Code, senderFault: f.SenderFault })) } };
    },
    async changeVisibility(receiptHandle, visibilityTimeoutSeconds) {
      const r = await call<unknown>('ChangeMessageVisibility', { ReceiptHandle: receiptHandle, VisibilityTimeout: visibilityTimeoutSeconds });
      return r.ok ? { ok: true, value: null } : r;
    },
  };
}
