/**
 * Порядок публикации outbox → брокер [ADR-0005 п. 3, Р-34]. created_at события — начало транзакции, а scope_seq выдаётся
 * под блокировкой строки единицы в порядке коммитов. Поэтому внутри единицы записи порядок — только по scope_seq:
 * транзакция, начатая раньше, может закоммитить событие позже. Пропуск номера — транзакция ещё не закоммичена:
 * события единицы после пропуска ждут; если пропуск не закрылся за gapTimeoutMs (откат транзакции тоже оставляет
 * пропуск — номер выдан, строки нет), публикация продолжается и пропуск отдаётся наружу для алерта.
 * События без единицы записи публикуются в порядке (created_at, id).
 */

export interface OutboxRow {
  outboxEventId: string;
  tenantId: string;
  createdAt: string;
  topic: string;
  partitionKey: string;
  writeScopeId: string | null;
  scopeSeq: number | null;
  eventType: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export interface RelayCursor {
  /** Последний опубликованный scope_seq единицы; после перезапуска неизвестен — первый увиденный номер принимается */
  lastSeqByScope: Map<string, number>;
  /** Опубликованные события в окне повторного чтения: id → created_at, мс */
  publishedIds: Map<string, number>;
  /** С какого момента единица ждёт закрытия пропуска */
  heldSince: Map<string, number>;
}

export interface SeqGap {
  writeScopeId: string;
  expectedSeq: number;
  nextSeq: number;
}

export interface PublicationPlan {
  publish: OutboxRow[];
  held: Array<SeqGap & { sinceMs: number }>;
  gapsReleased: SeqGap[];
  /** Номер меньше уже опубликованного: транзакция закоммитилась после выпуска пропуска по таймауту */
  late: OutboxRow[];
}

export function newRelayCursor(): RelayCursor {
  return { lastSeqByScope: new Map(), publishedIds: new Map(), heldSince: new Map() };
}

const byCreated = (a: OutboxRow, b: OutboxRow) => a.createdAt.localeCompare(b.createdAt) || a.outboxEventId.localeCompare(b.outboxEventId);

export function planPublication(rows: readonly OutboxRow[], cursor: RelayCursor, nowMs: number, gapTimeoutMs: number): PublicationPlan {
  const plan: PublicationPlan = { publish: [], held: [], gapsReleased: [], late: [] };
  const fresh = rows.filter((r) => !cursor.publishedIds.has(r.outboxEventId));
  plan.publish.push(...fresh.filter((r) => r.writeScopeId === null).sort(byCreated));

  const byScope = new Map<string, OutboxRow[]>();
  for (const r of fresh) {
    if (r.writeScopeId === null) continue;
    const list = byScope.get(r.writeScopeId) ?? [];
    list.push(r);
    byScope.set(r.writeScopeId, list);
  }
  for (const [writeScopeId, list] of byScope) {
    list.sort((a, b) => a.scopeSeq! - b.scopeSeq!);
    const last = cursor.lastSeqByScope.get(writeScopeId);
    let expected = last === undefined ? list[0]!.scopeSeq! : last + 1;
    for (let i = 0; i < list.length; i++) {
      const row = list[i]!;
      const seq = row.scopeSeq!;
      if (seq < expected) {
        plan.late.push(row);
        plan.publish.push(row);
        continue;
      }
      if (seq > expected) {
        const since = cursor.heldSince.get(writeScopeId) ?? nowMs;
        if (nowMs - since < gapTimeoutMs) {
          cursor.heldSince.set(writeScopeId, since);
          plan.held.push({ writeScopeId, expectedSeq: expected, nextSeq: seq, sinceMs: since });
          break;
        }
        plan.gapsReleased.push({ writeScopeId, expectedSeq: expected, nextSeq: seq });
      }
      cursor.heldSince.delete(writeScopeId);
      plan.publish.push(row);
      expected = seq + 1;
    }
  }
  return plan;
}

/** Отметить опубликованное (после подтверждения брокером) и забыть события старше окна повторного чтения */
export function markPublished(cursor: RelayCursor, rows: readonly OutboxRow[], forgetBeforeMs: number): void {
  for (const r of rows) {
    cursor.publishedIds.set(r.outboxEventId, Date.parse(r.createdAt));
    if (r.writeScopeId !== null && r.scopeSeq !== null) {
      cursor.lastSeqByScope.set(r.writeScopeId, Math.max(cursor.lastSeqByScope.get(r.writeScopeId) ?? 0, r.scopeSeq));
    }
  }
  for (const [id, createdMs] of cursor.publishedIds) if (createdMs < forgetBeforeMs) cursor.publishedIds.delete(id);
}
