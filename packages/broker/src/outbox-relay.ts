import type pg from 'pg';
import type { KeyedMessage, KeyedProducer } from './kafka.ts';
import { markPublished, newRelayCursor, planPublication, type OutboxRow, type PublicationPlan, type RelayCursor } from './relay-order.ts';

/**
 * Ретранслятор outbox → брокер: собственный поллер с advisory lock [Р-34]. Один активный ретранслятор на регион;
 * второй экземпляр ждёт блокировку. Доставка at-least-once: окно повторного чтения (overlapMs) и id опубликованных
 * событий в памяти защищают от пропуска поздно закоммиченных транзакций, дубли после перезапуска отсекает потребитель
 * (диспетчер записей опирается на состояние в БД, событие для него — только сигнал).
 * Роль — repracer_relay: чтение outbox всех тенантов и собственное состояние, без бизнес-таблиц (миграция 0038).
 */

export interface OutboxRelayOptions {
  pool: pg.Pool;
  producer: KeyedProducer;
  relayName?: string;
  batchSize?: number;
  /** Окно повторного чтения назад от водяного знака */
  overlapMs?: number;
  /** Сколько ждать закрытия пропуска scope_seq */
  gapTimeoutMs?: number;
  pollIntervalMs?: number;
  onGap?: (gap: { writeScopeId: string; expectedSeq: number; nextSeq: number }) => void;
  now?: () => number;
}

const LOCK_KEY = 'repracer.outbox_relay';

export function toKeyedMessage(row: OutboxRow): KeyedMessage {
  return {
    topic: row.topic,
    key: row.partitionKey,
    value: JSON.stringify({
      eventId: row.outboxEventId, tenantId: row.tenantId, eventType: row.eventType, schemaVersion: row.schemaVersion,
      writeScopeId: row.writeScopeId, scopeSeq: row.scopeSeq, createdAt: row.createdAt, payload: row.payload,
    }),
    headers: {
      'tenant-id': row.tenantId, 'event-type': row.eventType, 'event-id': row.outboxEventId,
      ...(row.scopeSeq !== null ? { 'scope-seq': String(row.scopeSeq) } : {}),
    },
  };
}

export class OutboxRelay {
  private readonly options: Required<Omit<OutboxRelayOptions, 'onGap'>> & Pick<OutboxRelayOptions, 'onGap'>;
  private readonly cursor: RelayCursor = newRelayCursor();
  private watermarkMs: number | null = null;

  constructor(options: OutboxRelayOptions) {
    this.options = {
      relayName: 'default', batchSize: 2000, overlapMs: 60_000, gapTimeoutMs: 30_000, pollIntervalMs: 200, now: () => Date.now(), ...options,
    };
  }

  private async loadWatermark(client: pg.PoolClient): Promise<void> {
    if (this.watermarkMs !== null) return;
    const { rows } = await client.query(`SELECT watermark FROM maintenance.outbox_relay_state WHERE relay_name = $1`, [this.options.relayName]);
    this.watermarkMs = rows[0]?.watermark ? Date.parse(new Date(rows[0].watermark).toISOString()) : 0;
  }

  /** Один проход: прочитать окно, спланировать порядок, опубликовать, сдвинуть водяной знак */
  async runOnce(client: pg.PoolClient): Promise<{ fetched: number; plan: PublicationPlan }> {
    await this.loadWatermark(client);
    const from = new Date(Math.max(0, this.watermarkMs! - this.options.overlapMs)).toISOString();
    const { rows } = await client.query(
      `SELECT tenant_id, outbox_event_id, created_at, topic, partition_key, write_scope_id, scope_seq, event_type, schema_version, payload
         FROM tenant_data.outbox_event
        WHERE created_at >= $1::timestamptz
        ORDER BY created_at, outbox_event_id
        LIMIT $2`,
      [from, this.options.batchSize]);
    const events: OutboxRow[] = rows.map((r) => ({
      outboxEventId: r.outbox_event_id, tenantId: r.tenant_id, createdAt: new Date(r.created_at).toISOString(), topic: r.topic,
      partitionKey: r.partition_key, writeScopeId: r.write_scope_id, scopeSeq: r.scope_seq === null ? null : Number(r.scope_seq),
      eventType: r.event_type, schemaVersion: Number(r.schema_version), payload: r.payload,
    }));
    const nowMs = this.options.now();
    const plan = planPublication(events, this.cursor, nowMs, this.options.gapTimeoutMs);
    for (const gap of plan.gapsReleased) this.options.onGap?.(gap);
    if (plan.publish.length > 0) {
      await this.options.producer.send(plan.publish.map(toKeyedMessage));
      const newest = Math.max(...plan.publish.map((r) => Date.parse(r.createdAt)));
      // Водяной знак не обгоняет самое старое удерживаемое событие
      const heldOldest = plan.held.length > 0
        ? Math.min(...events.filter((e) => plan.held.some((h) => h.writeScopeId === e.writeScopeId)).map((e) => Date.parse(e.createdAt)))
        : Number.POSITIVE_INFINITY;
      this.watermarkMs = Math.max(this.watermarkMs!, Math.min(newest, heldOldest));
      markPublished(this.cursor, plan.publish, this.watermarkMs - 2 * this.options.overlapMs);
      await client.query(
        `INSERT INTO maintenance.outbox_relay_state (relay_name, watermark, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (relay_name) DO UPDATE SET watermark = EXCLUDED.watermark, updated_at = now()`,
        [this.options.relayName, new Date(this.watermarkMs).toISOString()]);
    }
    return { fetched: events.length, plan };
  }

  /**
   * Один активный ретранслятор на регион [Р-34]: блокировка берётся на соединении и держится, пока оно живо. Публичный метод —
   * чтобы проверка в живом режиме шла тем же путём, что и цикл (Р-130)
   */
  async tryLock(client: pg.PoolClient): Promise<boolean> {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`, [LOCK_KEY]);
    return rows[0].locked === true;
  }

  /** Цикл: удерживает advisory lock на своём соединении; без блокировки ждёт, пока активный ретранслятор не освободит её */
  async run(signal: AbortSignal): Promise<void> {
    const client = await this.options.pool.connect();
    try {
      while (!signal.aborted) {
        if (await this.tryLock(client)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      while (!signal.aborted) {
        const { fetched, plan } = await this.runOnce(client);
        if (fetched < this.options.batchSize || plan.publish.length === 0) await new Promise((r) => setTimeout(r, this.options.pollIntervalMs));
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [LOCK_KEY]).catch(() => undefined);
      client.release();
    }
  }
}
