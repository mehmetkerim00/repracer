import type { AdapterCallContext, AlertSink, ChannelAdapter, FieldWrite, IdentifiedObservation, Instant, WriteOutcome } from '@repracer/channel-port';
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

/** Р-116, Р-118: остановка по недоверию каналу из-за неверной базы цены, поставленная хранилищем */
export interface PriceBasisDistrust {
  distrustId: string;
  reason: WriteReason;
}

export interface WriteQueueStore {
  claimNext(tenantId: string, writeScopeId: string, now: Instant, policy: RetryPolicy): Promise<ClaimResult>;
  recordOutcome(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome>;
  recordReconciliation(tenantId: string, write: FieldWrite, result: Reconciliation, now: Instant, policy: RetryPolicy): Promise<RecordedOutcome>;
  /** Что пора отправить, повторить или сверить — по всем тенантам, только идентификаторы */
  dueScopes(now: Instant, options: { pendingMinAgeMs: number; inFlightTimeoutMs: number; limit: number }): Promise<DueScope[]>;
  /**
   * Р-116: канал показал цену, отличную от отправленной. Хранилище берёт ставку НДС товара и налоговый режим единицы; если разница
   * равна ставке — ставит остановку по недоверию каналу PRICE_BASIS_MISMATCH [Р-118] (все цены, только ручное снятие) и возвращает её.
   * Действующая остановка той же причины не дублируется: возвращается она же. null — не признак базы цены.
   */
  checkPriceBasis(tenantId: string, write: FieldWrite, observedMinor: number, now: Instant): Promise<PriceBasisDistrust | null>;
}

export type DispatchStep =
  | { action: 'DISPATCHED'; channelWriteId: string; version: number; attemptNo: number; outcome: WriteOutcome['status']; recorded: RecordedOutcome['status']; reason: WriteReason | null }
  | { action: 'RECONCILED'; channelWriteId: string; version: number; result: Reconciliation['kind']; recorded: RecordedOutcome['status'] }
  | { action: 'ENDED'; channelWriteId: string; status: string; reason: WriteReason }
  | { action: 'WAITING'; channelWriteId: string; status: 'DISPATCHED' | 'ACCEPTED' }
  | { action: 'RETRY_LATER'; channelWriteId: string; at: Instant }
  /** Р-116, Р-118: применённая цена отличается от отправленной на ставку налога — недоверие каналу */
  | { action: 'CHANNEL_DISTRUSTED'; channelWriteId: string; distrustId: string }
  /** Единица не обработана: ошибка хранилища или неизвестный отказ базы — алерт, остальной обход продолжается (находка 7 шага 15) */
  | { action: 'ERROR'; errorCode: string }
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
/** Повтор алерта об одной и той же ошибке единицы — не чаще раза в час: без лавины CRITICAL на каждом круге обхода (как D2) */
const SCOPE_ERROR_REALERT_MS = 3_600_000;

export function createWriteDispatcher(deps: WriteDispatcherDeps): WriteDispatcher {
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...deps.policy };
  const callTimeoutMs = deps.callTimeoutMs ?? 60_000;
  const tails = new Map<string, Promise<unknown>>();
  const scopeErrorAlertedAt = new Map<string, number>();

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

  /** Цена, которую видит покупатель: применённая каналом, если он её сообщает, иначе прочитанное значение поля */
  function observedPriceMinor(write: FieldWrite, observation: IdentifiedObservation | undefined): number | null {
    if (write.value.field !== 'PRICE' || !observation) return null;
    const price = observation.effectivePrice ?? (observation.value.field === 'PRICE' ? observation.value.price : null);
    return price && price.currency === write.value.price.currency ? price.amountMinor : null;
  }

  /**
   * Р-116: обратное чтение сравнивает применённую цену с отправленной. Расхождение на ставку налога — остановка витрины; прочие
   * расхождения — предмет сверки и DivergenceCase, не этой проверки.
   */
  async function checkBasis(tenantId: string, write: FieldWrite, observation: IdentifiedObservation | undefined, report: ScopeDispatchReport): Promise<void> {
    const observed = observedPriceMinor(write, observation);
    if (observed === null || write.value.field !== 'PRICE' || observed === write.value.price.amountMinor) return;
    const distrust = await deps.store.checkPriceBasis(tenantId, write, observed, deps.now());
    if (!distrust) return;
    report.steps.push({ action: 'CHANNEL_DISTRUSTED', channelWriteId: write.channelWriteId, distrustId: distrust.distrustId });
    // В алерт — коды и ставка, без сумм: применённая цена — данные канала
    await alert(tenantId, 'PRICING_CHANNEL_DISTRUSTED', 'CRITICAL', {
      writeScopeId: write.writeScope.writeScopeId, channelWriteId: write.channelWriteId, distrustId: distrust.distrustId, distrustReason: 'PRICE_BASIS_MISMATCH',
      basisError: String(distrust.reason.params.basisError ?? ''), vatRateBp: Number(distrust.reason.params.vatRateBp ?? 0),
    });
  }

  async function readBack(tenantId: string, channelAccountId: string, write: FieldWrite): Promise<{ result: Reconciliation; observation?: IdentifiedObservation }> {
    const ctx = callContext(tenantId, channelAccountId, `reconcile:${write.channelWriteId}:${write.attemptNo}`);
    try {
      const adapter = await deps.adapterFor(tenantId, channelAccountId);
      const result = await adapter.readBack(ctx, [{ writeScope: write.writeScope, fields: [write.value.field] }]);
      const failure = result.failures.find((f) => f.writeScopeId === write.writeScope.writeScopeId);
      if (failure) return { result: { kind: 'UNKNOWN', error: failure.error } };
      const observation = result.observations.find((o) => o.field === write.value.field);
      if (!observation) return { result: { kind: 'UNKNOWN', error: null } };
      if (sameWriteValue(observation.value, write.value)) return { result: { kind: 'APPLIED' }, observation };
      const observedMinor = observation.value.field === 'PRICE' ? observation.value.price.amountMinor : null;
      return { result: { kind: 'NOT_APPLIED', observedMinor }, observation };
    } catch {
      return { result: { kind: 'UNKNOWN', error: null } };
    }
  }

  async function afterRecorded(tenantId: string, write: FieldWrite, recorded: RecordedOutcome): Promise<void> {
    const details = { writeScopeId: write.writeScope.writeScopeId, channelWriteId: write.channelWriteId, version: write.version };
    const blockedCode = recorded.reason?.params?.code;
    if (recorded.scopeBlocked) await alert(tenantId, 'PRICE_WRITE_SCOPE_BLOCKED', 'CRITICAL', { ...details, reason: recorded.reason?.code ?? 'UNKNOWN', ...(typeof blockedCode === 'string' ? { code: blockedCode } : {}) });
    else if (recorded.status === 'DISCARDED_STALE' || recorded.status === 'BUDGET_EXHAUSTED' || recorded.status === 'NOT_APPLIED') {
      await alert(tenantId, 'PRICE_WRITE_NOT_SENT', 'CRITICAL', { ...details, status: recorded.status, reason: recorded.reason?.code ?? 'UNKNOWN' });
    }
  }

  /**
   * Р-155 (шаг 36): готовая к отправке запись может быть не отправлена сразу, а ОТДАНА обходу для пакета. Порядок и
   * инвариант «одна запись в полёте на единицу» [Р-64, ADR-0005] это не трогает: запись уже захвачена (DISPATCHED),
   * и в одном пакете не может оказаться двух записей одной единицы — их выдаёт `claimNext`, по одной на единицу.
   */
  interface CollectedClaim { tenantId: string; writeScopeId: string; channelAccountId: string; write: FieldWrite; report: ScopeDispatchReport }

  /**
   * Р-155: отправка ПАКЕТОМ. Сколько записей уходит одним запросом, решает адаптер канала (`planDispatch`): у Kaufland
   * это до 150 unit одной витрины [K-01], у других каналов — по одной. Диспетчер только собирает совместимые готовые
   * записи и разносит итоги обратно по единицам — разбор ответа по-прежнему поэлементный.
   */
  async function sendBatched(claims: readonly CollectedClaim[]): Promise<void> {
    const tenantId = claims[0]!.tenantId;
    const channelAccountId = claims[0]!.channelAccountId;
    const writes = claims.map((c) => c.write);
    const byWriteId = new Map(claims.map((c) => [c.write.channelWriteId, c]));
    const ctx = callContext(tenantId, channelAccountId, `dispatch:batch:${claims[0]!.write.channelWriteId}:${writes.length}`);
    const outcomes = new Map<string, WriteOutcome>();
    try {
      const adapter = await deps.adapterFor(tenantId, channelAccountId);
      const plan = await adapter.planDispatch(ctx, writes);
      for (const r of plan.rejected) outcomes.set(r.channelWriteId, { channelWriteId: r.channelWriteId, status: 'REJECTED', error: r.error });
      for (const batch of plan.batches) {
        // Пакет с записью одной единицы дважды невозможен: `claimNext` выдаёт по одной записи на единицу, но правило
        // ядра проверяется и здесь — молчаливое нарушение порядка дороже отказа
        const scopes = new Set(batch.items.map((w) => w.writeScope.writeScopeId));
        if (scopes.size !== batch.items.length) {
          for (const w of batch.items) outcomes.set(w.channelWriteId, { channelWriteId: w.channelWriteId, status: 'REJECTED', error: coreError('VALIDATION', 'PERMANENT', 'batch holds two writes of one scope') });
          continue;
        }
        try {
          const result = await adapter.dispatch(ctx, batch);
          for (const o of result.outcomes) outcomes.set(o.channelWriteId, o);
        } catch (error) {
          // Исключение после отправки не исключено: итог каждой записи пакета неизвестен, перед повтором — сверка
          for (const w of batch.items) outcomes.set(w.channelWriteId, { channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error: coreError('UNKNOWN', 'TRANSIENT', String((error as Error).message ?? error).slice(0, 200)) });
        }
      }
    } catch (error) {
      for (const w of writes) outcomes.set(w.channelWriteId, { channelWriteId: w.channelWriteId, status: 'OUTCOME_UNKNOWN', error: coreError('UNKNOWN', 'TRANSIENT', String((error as Error).message ?? error).slice(0, 200)) });
    }
    for (const [writeId, claim] of byWriteId) {
      const outcome = outcomes.get(writeId)
        // Адаптер не запланировал запись и не отказал: к каналу обращения не было — повтор безопасен
        ?? { channelWriteId: writeId, status: 'REJECTED' as const, error: coreError('UNKNOWN', 'TRANSIENT', 'adapter planned no batch for the write') };
      const recorded = await deps.store.recordOutcome(claim.tenantId, claim.write, outcome, deps.now(), policy);
      claim.report.steps.push({
        action: 'DISPATCHED', channelWriteId: claim.write.channelWriteId, version: claim.write.version, attemptNo: claim.write.attemptNo,
        outcome: outcome.status, recorded: recorded.status, reason: recorded.reason,
      });
      await afterRecorded(claim.tenantId, claim.write, recorded);
      if (outcome.status === 'ACCEPTED' && outcome.appliedImmediately) await checkBasis(claim.tenantId, claim.write, outcome.observation, claim.report);
    }
  }

  async function runScope(tenantId: string, writeScopeId: string, collect?: (claim: CollectedClaim) => void): Promise<ScopeDispatchReport> {
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
          const severity = claim.status === 'BLOCKED' || claim.reason.code === 'CHANNEL_HALTED' || claim.reason.code === 'CHANNEL_DISTRUSTED' ? 'CRITICAL' : 'WARNING';
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
          const { result, observation } = await readBack(tenantId, claim.channelAccountId, claim.write);
          const recorded = await deps.store.recordReconciliation(tenantId, claim.write, result, deps.now(), policy);
          report.steps.push({ action: 'RECONCILED', channelWriteId: claim.write.channelWriteId, version: claim.write.version, result: result.kind, recorded: recorded.status });
          await afterRecorded(tenantId, claim.write, recorded);
          if (result.kind === 'APPLIED') await checkBasis(tenantId, claim.write, observation, report);
          if (!recorded.slotFreed) return report;
          continue;
        }
        case 'DISPATCH': {
          if (collect) {
            // Запись захвачена и ждёт пакета: отправит её обход, он же запишет итог и продолжит единицу
            collect({ tenantId, writeScopeId, channelAccountId: claim.channelAccountId, write: claim.write, report });
            return report;
          }
          const outcome = await send(tenantId, claim.channelAccountId, claim.write);
          const recorded = await deps.store.recordOutcome(tenantId, claim.write, outcome, deps.now(), policy);
          report.steps.push({
            action: 'DISPATCHED', channelWriteId: claim.write.channelWriteId, version: claim.write.version, attemptNo: claim.write.attemptNo,
            outcome: outcome.status, recorded: recorded.status, reason: recorded.reason,
          });
          await afterRecorded(tenantId, claim.write, recorded);
          if (outcome.status === 'ACCEPTED' && outcome.appliedImmediately) await checkBasis(tenantId, claim.write, outcome.observation, report);
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
      /**
       * Р-155: обход идёт КРУГАМИ. Круг: у каждой единицы берётся её готовая запись (по одной — `claimNext`), готовые
       * записи одного аккаунта уходят пакетами, итоги разносятся по единицам. Единица, освободившаяся после итога,
       * участвует в следующем круге: так цепочка версий уходит, как и раньше, но запросов к каналу — на порядок меньше.
       * Кругов не больше `MAX_CLAIMS_PER_CALL` — столько же захватов на единицу, сколько делал прежний обход.
       */
      let pending = unique;
      for (let round = 0; round < MAX_CLAIMS_PER_CALL && pending.length > 0; round++) {
        const collected: CollectedClaim[] = [];
        const roundReports: ScopeDispatchReport[] = [];
        let next = 0;
        const worker = async () => {
          while (next < pending.length) {
            const item = pending[next++]!;
            try {
              roundReports.push(await serialized(`${item.tenantId}:${item.writeScopeId}`,
                () => runScope(item.tenantId, item.writeScopeId, (claim) => collected.push(claim))));
            } catch (error) {
              // Одна единица не роняет обход остальных, и её сбой не молчит [Р-64]. В алерт — только код ошибки
              const errorCode = String((error as { code?: unknown }).code ?? 'UNKNOWN');
              roundReports.push({ tenantId: item.tenantId, writeScopeId: item.writeScopeId, steps: [{ action: 'ERROR', errorCode }] });
              const key = `${item.tenantId}:${item.writeScopeId}:${errorCode}`;
              const at = Date.parse(deps.now());
              const last = scopeErrorAlertedAt.get(key);
              if (last === undefined || at - last >= SCOPE_ERROR_REALERT_MS) {
                scopeErrorAlertedAt.set(key, at);
                await alert(item.tenantId, 'PRICE_WRITE_DISPATCH_ERROR', 'CRITICAL', { writeScopeId: item.writeScopeId, dueKind: item.dueKind, errorCode });
              }
            }
          }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 8, pending.length)) }, worker));
        // Пакеты — по аккаунту канала: у каждого свои учётные данные, свой лимитер и свои правила группировки
        const byAccount = new Map<string, CollectedClaim[]>();
        for (const c of collected) {
          const key = `${c.tenantId}:${c.channelAccountId}`;
          byAccount.set(key, [...(byAccount.get(key) ?? []), c]);
        }
        await Promise.all([...byAccount.values()].map((claims) => sendBatched(claims)));
        for (const r of roundReports) {
          const existing = reports.find((x) => x.tenantId === r.tenantId && x.writeScopeId === r.writeScopeId);
          if (existing) existing.steps.push(...r.steps); else reports.push(r);
        }
        // Следующий круг — только единицы, у которых место освободилось и осталась работа
        const freed = new Set(collected
          .filter((c) => c.report.steps.some((step) => step.action === 'DISPATCHED' && step.recorded !== 'DISPATCHED' && step.recorded !== 'ACCEPTED'))
          .map((c) => `${c.tenantId}:${c.writeScopeId}`));
        pending = pending.filter((item) => freed.has(`${item.tenantId}:${item.writeScopeId}`));
      }
      return { due: unique.length, reports };
    },
  };
}
