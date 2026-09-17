import { md5Hex } from './sqs.ts';

/**
 * Очередь SQS в памяти по протоколу AWS JSON — только для тестов приёмника и стенда (экспорт ./testing, в рабочий код не входит). Поведение стандартной очереди из документации:
 * получение скрывает сообщение на VisibilityTimeout и увеличивает ApproximateReceiveCount; удаление — по ReceiptHandle последнего
 * получения; повтор и перестановку сообщений тест задаёт явно. Данные синтетические.
 */
interface Stored { messageId: string; body: string; md5: string; sentMs: number; visibleAtMs: number; receiveCount: number; handle: string | null }

export class FakeSqs {
  readonly messages: Stored[] = [];
  readonly requests: Array<{ target: string; authorization: string; body: Record<string, unknown> }> = [];
  failNextDelete = false;
  failNextReceive: number | null = null;
  private seq = 0;
  private readonly clock: { nowMs: number };
  constructor(clock: { nowMs: number }) { this.clock = clock; }

  send(body: string, options: { sentMs?: number; corruptMd5?: boolean } = {}): string {
    const messageId = `syn-msg-${++this.seq}`;
    this.messages.push({ messageId, body, md5: options.corruptMd5 ? '00000000000000000000000000000000' : md5Hex(body), sentMs: options.sentMs ?? this.clock.nowMs, visibleAtMs: 0, receiveCount: 0, handle: null });
    return messageId;
  }

  readonly fetch: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const target = headers.get('x-amz-target') ?? '';
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    this.requests.push({ target, authorization: headers.get('authorization') ?? '', body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/x-amz-json-1.0' } });
    if (target === 'AmazonSQS.ReceiveMessage') {
      if (this.failNextReceive !== null) { const s = this.failNextReceive; this.failNextReceive = null; return json(s, { __type: 'com.amazonaws.sqs#OverLimit', message: 'synthetic' }); }
      const max = Number(body.MaxNumberOfMessages ?? 1);
      const visibility = Number(body.VisibilityTimeout ?? 30);
      const visible = this.messages.filter((m) => m.visibleAtMs <= this.clock.nowMs).slice(0, max);
      const out = visible.map((m) => {
        m.receiveCount += 1;
        m.visibleAtMs = this.clock.nowMs + visibility * 1000;
        m.handle = `handle-${m.messageId}-${m.receiveCount}`;
        return { MessageId: m.messageId, ReceiptHandle: m.handle, MD5OfBody: m.md5, Body: m.body,
          Attributes: { SentTimestamp: String(m.sentMs), ApproximateReceiveCount: String(m.receiveCount), SenderId: 'AIDASYNTHETICSENDER01' } };
      });
      return json(200, out.length ? { Messages: out } : {});
    }
    if (target === 'AmazonSQS.DeleteMessageBatch') {
      const entries = body.Entries as Array<{ Id: string; ReceiptHandle: string }>;
      if (this.failNextDelete) { this.failNextDelete = false; return json(500, { __type: 'com.amazonaws.sqs#InternalError' }); }
      const successful: Array<{ Id: string }> = [];
      const failed: Array<{ Id: string; Code: string; SenderFault: boolean }> = [];
      for (const e of entries) {
        const i = this.messages.findIndex((m) => m.handle === e.ReceiptHandle);
        if (i < 0) failed.push({ Id: e.Id, Code: 'ReceiptHandleIsInvalid', SenderFault: true });
        else { this.messages.splice(i, 1); successful.push({ Id: e.Id }); }
      }
      return json(200, { Successful: successful, Failed: failed });
    }
    if (target === 'AmazonSQS.ChangeMessageVisibility') {
      const m = this.messages.find((x) => x.handle === body.ReceiptHandle);
      if (!m) return json(400, { __type: 'com.amazonaws.sqs#ReceiptHandleIsInvalid' });
      m.visibleAtMs = this.clock.nowMs + Number(body.VisibilityTimeout) * 1000;
      return json(200, {});
    }
    return json(400, { __type: 'com.amazonaws.sqs#InvalidAction' });
  };
}
