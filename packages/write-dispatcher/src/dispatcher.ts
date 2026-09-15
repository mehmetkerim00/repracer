import type { AdapterCallContext, AlertSink, ChannelAdapter, FieldWrite, Instant, WriteOutcome } from '@repracer/channel-port';
import {
  coreError,
  DEFAULT_RETRY_POLICY,
  sameWriteValue,
  type Reconciliation,
  type RetryPolicy,
  type WriteReason,
} from './transitions.ts';

/**
 * Диспетчер записей [Р-64, Р-24, ADR-0005].
 *
 * Порядок по write_scope_id гарантируют три слоя, каждый сам по себе достаточен для «старое не перезапишет новое»:
 *  1. база данных: одна запись в полёте на единицу (write_scope_sync_state.in_flight_write_id), отправляется только
 *     последняя созданная версия, захват — под блокировкой строки единицы;
 *  2. брокер: события scope.write.v1 с ключом write_scope_id — одна партиция, один потребитель;
 *  3. процесс: вызовы dispatchScope по одной единице выстраиваются в цепочку.
 * Диспетчер опирается на состояние в БД, а не на содержимое события: повтор и дубль события безвредны, потерянное
 * событие подбирает обход (sweep). Запись не остаётся PENDING бесследно — либо отправлена, либо завершена с причиной.
 */

export type DueKind = 'PENDING' | 'RETRY' | 'RECONCILE' | 'IN_FLIGHT_STALE';

export interface DueScope {
  tenantId: string;
  writeScopeId: string;
  dueKind: DueKind;
  dueSince: Instant;
}

export type ClaimResult =
  /** Запись захвачена: DISPATCHED, attemptNo увеличен, пол, потолок и остановка перепроверены триггерами */
  | { kind: 'DISPATCH'; channelAccountId: string; write: FieldWrite }
  /** В полёте другая запись; reconcileDue — пора сверять её обратным чтением */
  | { kind: 'IN_FLIGHT'; channelAccountId: string; write: FieldWrite; status: 'DISPATCHED' | 'ACCEPTED'; since: Instant; reconcileDue: boolean }
  | { kind: 'RETRY_LATER'; channelWriteId: string; at: Instant }
  /** Запись не может быть отправлена и завершена с причиной (или ждёт разбора в BLOCKED) */
  | { kind: 'ENDED'; channelWriteId: string; status: 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED' | 'BLOCKED'; reason: WriteReason }
  | { kind: 'IDLE' };

export interface RecordedOutcome {
  status: 'DISPATCHED' | 'ACCEPTED' | 'APPLIED' | 'NOT_APPLIED' | 'FAILED' | 'DISCARDED_STALE' | 'BUDGET_EXHAUSTED';
  /** Единица свободна — следующая ждущая запись может уйти */
  slotFreed: boolean;
  /** Единица свободна и в очереди ждёт запись: её надо передать диспетчеру */
  queuedWaiting: boolean;
  nextAttemptAt: Instant | null;
  reason: WriteReason | null;
  scopeBlocked: boolean;
}

export interface WriteQueueStore {
  claimNext(tenantId: string, writeScopeId: string, now: Instant, policy: RetryPolicy): Promise<ClaimResult>;
  recordOutcome(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome>;
  recordReconciliation(tenantId: string, write: FieldWrite, result: Reconciliation, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome>;
  /** Что пора отправить, повторить или сверить — по всем тенантам, только идентификаторы */
  dueScopes(now: Instant, options: { pendingMinAgeMs: number; inFlightTimeoutMs: number; limit: number }): Promise<DueScope[]>;
}

export type DispatchStep =
  | { action: 'DISPATCHED'; channelWriteId: string; version: number; attemptNo: number; outcome: WriteOutcome['status']; recorded: RecordedOutcome['status']; reason: WriteReason | null }
  | { action: 'RECONCILED'; channelWriteId: string; version: number; result: Reconciliation['kind']; recorded: RecordedOutcome['status'] }
  | { action: 'ENDED'; channelWriteId: string; status: string; reason: WriteReason }
  | { action: 'WAITING'; channelWriteId: string; status: 'DISPATCHED' | 'ACCEPTED' }
  | { action: 'RETRY_LATER'; channelWriteId: string; at: Instant }
  | { action: 'IDLE' };

export interface ScopeDispatchReport {
  tenantId: string;
  writeScopeId: string;
  steps: DispatchStep[];
}

export interface WriteDispatcherDeps {
  store: WriteQueueStore;
  /** Адаптер канала аккаунта; тенант сверяется самим адаптером [Р-31] */
  adapterFor: (tenantId: string, channelAccountId: string) => ChannelAdapter | Promise<ChannelAdapter>;
  alerts: AlertSink;
  now: () => Instant;
  policy?: Partial<RetryPolicy>;
  /** Крайний срок одного вызова адаптера */
  callTimeoutMs?: number;
}

export interface SweepOptions {
  /** Ждущая запись моложе этого — ещё в пути событием, обход её не трогает */
  pendingMinAgeMs?: number;
  limit?: number;
  concurrency?: number;
}

export interface WriteDispatcher {
  readonly policy: RetryPolicy;
  dispatchScope(tenantId: string, writeScopeId: string): Promise<ScopeDispatchReport>;
  sweep(options?: SweepOptions): Promise<{ due: number; reports: ScopeDispatchReport[] }>;
}

/** Больше захватов за один вызов по единице не нужно: синхронный канал освобождает единицу сразу, асинхронный — нет */
const MAX_CLAIMS_PER_CALL = 8;

export function createWriteDispatcher(deps: WriteDispatcherDeps): WriteDispatcher {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...deps.policy };
  const callTimeoutMs = deps.callTimeoutMs ?? 60_000;
  const tails = new Map<string, Promise<unknown>>();

  function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  }

  function callContext(tenantId: string, channelAccountId: string, correlationId: string): AdapterCallContext {
    return {
      tenantId: tenantId as AdapterCallContext['tenantId'],
      channelAccountId: channelAccountId as AdapterCallContext['channelAccountId'],
      correlationId,
      deadline: new Date(Date.parse(deps.now()) + callTimeoutMs).toISOString(),
    };
  }

  async function alert(tenantId: string, code: string, severity: 'WARNING' | 'CRITICAL', details: Record<string, string | number | boolean>): Promise<void> {
    await deps.alerts.raise({ code, severity, tenantId: tenantId as AdapterCallContext['tenantId'], details });
  }

  async function send(tenantId: string, channelAccountId: string, write: FieldWrite): Promise<WriteOutcome> {
    const ctx = callContext(tenantId, channelAccountId, `dispatch:${write.channelWriteId}:${write.attemptNo}`);
    try {
      const adapter = await deps.adapterFor(tenantId, channelAccountId);
      const plan = await adapter.planDispatch(ctx, [write]);
      const rejected = plan.rejected.find((r) => r.channelWriteId === write.channelWriteId);
      if (rejected) return { channelWriteId: write.channelWriteId, status: 'REJECTED', error: rejected.error };
      const batch = plan.batches.find((b) => b.items.some((item) => item.channelWriteId === write.channelWriteId));
      // Адаптер не запланировал запись и не отказал: к каналу обращения не было — повтор безопасен
      if (!batch) return { channelWriteId: write.channelWriteId, status: 'REJECTED', error: coreError('UNKNOWN', 'TRANSIENT', 'adapter planned no batch for the write') };
      const result = await adapter.dispatch(ctx, batch);
      return result.outcomes.find((o) => o.channelWriteId === write.channelWriteId)
        ?? { channelWriteId: write.channelWriteId, status: 'OUTCOME_UNKNOWN', error: coreError('UNKNOWN', 'TRANSIENT', 'adapter returned no outcome for the write') };
    } catch (error) {
      // Исключение адаптера после отправки не исключено: итог неизвестен, перед повтором — сверка
      return { channelWriteId: write.channelWriteId, status: 'OUTCOME_UNKNOWN', error: coreError('UNKNOWN', 'TRANSIENT', String((error as Error).message ?? error).slice(0, 200)) };
    }
  }

  async function readBack(tenantId: string, channelAccountId: string, write: FieldWrite): Promise<Reconciliation> {
    const ctx = callContext(tenantId, channelAccountId, `reconcile:${write.channelWriteId}:${write.attemptNo}`);
    try {
      const adapter = await deps.adapterFor(tenantId, channelAccountId);
      const result = await adapter.readBack(ctx, [{ writeScope: write.writeScope, fields: [write.value.field] }]);
      const failure = result.failures.find((f) => f.writeScopeId === write.writeScope.writeScopeId);
      if (failure) return { kind: 'UNKNOWN', error: failure.error };
      const observation = result.observations.find((o) => o.field === write.value.field);
      if (!observation) return { kind: 'UNKNOWN', error: null };
      if (sameWriteValue(observation.value, write.value)) return { kind: 'APPLIED' };
      const observedMinor = observation.value.field === 'PRICE' ? observation.value.price.amountMinor : null;
      return { kind: 'NOT_APPLIED', observedMinor };
    } catch {
      return { kind: 'UNKNOWN', error: null };
    }
  }

  async function afterRecorded(tenantId: string, write: FieldWrite, recorded: RecordedOutcome): Promise<void> {
    const details = { writeScopeId: write.writeScope.writeScopeId, channelWriteId: write.channelWriteId, version: write.version };
    if (recorded.scopeBlocked) await alert(tenantId, 'PRICE_WRITE_SCOPE_BLOCKED', 'CRITICAL', { ...details, reason: recorded.reason?.code ?? 'UNKNOWN' });
    else if (recorded.status === 'DISCARDED_STALE' || recorded.status === 'BUDGET_EXHAUSTED' || recorded.status === 'NOT_APPLIED') {
      await alert(tenantId, 'PRICE_WRITE_NOT_SENT', 'CRITICAL', { ...details, status: recorded.status, reason: recorded.reason?.code ?? 'UNKNOWN' });
    }
  }

  async function runScope(tenantId: string, writeScopeId: string): Promise<ScopeDispatchReport> {
    const report: ScopeDispatchReport = { tenantId, writeScopeId, steps: [] };
    for (let i = 0; i < MAX_CLAIMS_PER_CALL; i++) {
      const claim = await deps.store.claimNext(tenantId, writeScopeId, deps.now(), policy);
      switch (claim.kind) {
        case 'IDLE':
          report.steps.push({ action: 'IDLE' });
          return report;
        case 'RETRY_LATER':
          report.steps.push({ action: 'RETRY_LATER', channelWriteId: claim.channelWriteId, at: claim.at });
          return report;
        case 'ENDED': {
          report.steps.push({ action: 'ENDED', channelWriteId: claim.channelWriteId, status: claim.status, reason: claim.reason });
          const severity = claim.status === 'BLOCKED' || claim.reason.code === 'CHANNEL_HALTED' ? 'CRITICAL' : 'WARNING';
          await alert(tenantId, claim.status === 'BLOCKED' ? 'PRICE_WRITE_SCOPE_BLOCKED' : 'PRICE_WRITE_NOT_SENT', severity,
            { writeScopeId, channelWriteId: claim.channelWriteId, status: claim.status, reason: claim.reason.code });
          if (claim.status === 'BLOCKED') return report;
          continue;
        }
        case 'IN_FLIGHT': {
          if (!claim.reconcileDue) {
            report.steps.push({ action: 'WAITING', channelWriteId: claim.write.channelWriteId, status: claim.status });
            return report;
          }
          const result = await readBack(tenantId, claim.channelAccountId, claim.write);
          const recorded = await deps.store.recordReconciliation(tenantId, claim.write, result, deps.now(), policy);
          report.steps.push({ action: 'RECONCILED', channelWriteId: claim.write.channelWriteId, version: claim.write.version, result: result.kind, recorded: recorded.status });
          await afterRecorded(tenantId, claim.write, recorded);
          if (!recorded.slotFreed) return report;
          continue;
        }
        case 'DISPATCH': {
          const outcome = await send(tenantId, claim.channelAccountId, claim.write);
          const recorded = await deps.store.recordOutcome(tenantId, claim.write, outcome, deps.now(), policy);
          report.steps.push({
            action: 'DISPATCHED', channelWriteId: claim.write.channelWriteId, version: claim.write.version, attemptNo: claim.write.attemptNo,
            outcome: outcome.status, recorded: recorded.status, reason: recorded.reason,
          });
          await afterRecorded(tenantId, claim.write, recorded);
          if (!recorded.slotFreed) return report;
          continue;
        }
      }
    }
    return report;
  }

  return {
    policy,
    dispatchScope: (tenantId, writeScopeId) => serialized(`${tenantId}:${writeScopeId}`, () => runScope(tenantId, writeScopeId)),
    async sweep(options = {}) {
      const due = await deps.store.dueScopes(deps.now(), {
        pendingMinAgeMs: options.pendingMinAgeMs ?? 5_000, inFlightTimeoutMs: policy.inFlightTimeoutMs, limit: options.limit ?? 500,
      });
      const unique = [...new Map(due.map((d) => [`${d.tenantId}:${d.writeScopeId}`, d])).values()];
      const reports: ScopeDispatchReport[] = [];
      let next = 0;
      const worker = async () => {
        while (next < unique.length) {
          const item = unique[next++]!;
          reports.push(await this.dispatchScope(item.tenantId, item.writeScopeId));
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, unique.length)) }, worker));
      return { due: unique.length, reports };
    },
  };
}
