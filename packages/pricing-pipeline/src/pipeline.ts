import { randomUUID } from 'node:crypto';
import type {
  AdapterCallContext,
  AdapterLogger,
  AlertSink,
  ChannelAdapter,
  CompetitorQuery,
  CompetitorSnapshot,
  FieldWrite,
  IdentifiedObservation,
  InboundDelivery,
  InboundResult,
  Instant,
  WriteOutcome,
} from '@repracer/channel-port';
import { assessShift, DEFAULT_SANITY_CONFIG, evaluateSnapshot, SANITY_RULESET, type AnchorName, type SanityCheck, type SanityConfig } from '@repracer/input-sanity';
import { decide, GATE_PROFILE, repricingWarnings, validateRepricingEnablement } from '@repracer/price-gate';
import {
  buildExplanation,
  isCompetitorDerived,
  summarizeSanity,
  type AcceptedSnapshot,
  type SanitySummary,
  type AlarmClass,
  type PriceDecisionDraft,
  type PriceIntentDraft,
  type Reason,
  type StrategyDefinition,
  type TriggerType,
} from '@repracer/pricing-model';
import { runStrategy, strategyAvailability } from '@repracer/strategy-engine';
import { channelRefusal, type DispatchStep, type WriteDispatcher } from '@repracer/write-dispatcher';
import type {
  HaltSampleObservation,
  CommittedDecision,
  DecisionToCommit,
  DispatchRecorded,
  EvaluationCommit,
  HaltInfo,
  PricingStore,
  ProductKey,
  ScopeEvaluationContext,
  SnapshotOutcome,
  SnapshotRef,
  StopRecord,
  StopRelease,
  StopResult,
} from './store.ts';

/**
 * Сквозной путь решения о цене:
 *   событие → снимок → контекст одним чтением → проверка входов [Р-49, Р-50] → стратегия → Price Gate [Р-43, Р-44]
 *   → одна транзакция: снимок, intent, решение, запись с закреплённой версией контекста [Р-54] → адаптер канала → итог.
 * Р-59: не больше трёх транзакций на оценку. Изменился контекст — откат и повтор всей оценки; алерты и журнал —
 * только после успешной фиксации, чтобы повторы их не дублировали.
 */

export type Stage = 'SANITY' | 'SCOPE' | 'STRATEGY' | 'GATE' | 'COMMIT' | 'WRITE_RECHECK' | 'DISPATCH_PLAN' | 'DISPATCH';

export interface StageRecord {
  stage: Stage;
  outcome: string;
  reason?: Reason;
}

export interface ScopeReport {
  writeScopeId: string;
  stages: StageRecord[];
  intentId?: string;
  intent?: PriceIntentDraft;
  decisionId?: string;
  decision?: PriceDecisionDraft;
  channelWriteId?: string;
  dispatch?: WriteOutcome;
  /** Шаги диспетчера, которому единица передана после итога записи [Р-64] */
  queue?: DispatchStep[];
  /** Сколько раз оценка повторена из-за смены контекста решения */
  boundsRetries?: number;
}

export interface SnapshotReport {
  marketplace: string;
  channelProductRef: string;
  condition: string;
  verdict: 'ACCEPT' | 'REJECT' | 'HALT_CHANNEL';
  reason?: Reason;
  alarmClass?: AlarmClass;
  warnings: Reason[];
  anchorsUsed: AnchorName[];
  /** Оценённый снимок — основание решения («почему эта цена», шаг 11) */
  snapshot?: CompetitorSnapshot;
  /** Все правила проверки входов: прошло, отклонено, пропущено — с пояснением */
  sanityChecks?: SanityCheck[];
  /** Версия набора правил проверки входов */
  ruleset?: string;
  divergenceCaseId?: string;
  engineInvocations: number;
  scopes: ScopeReport[];
}

/** Превью стратегии до сохранения (шаг 21): что предложила бы стратегия и что решил бы Gate, без фиксации */
export interface StrategyPreview {
  writeScopeId: string;
  evaluatedAt: Instant;
  snapshotObservedAt: Instant | null;
  currentPriceMinor: number | null;
  currency: string;
  stages: StageRecord[];
  intent?: PriceIntentDraft;
  decision?: PriceDecisionDraft;
  /** Даёт ли канал данные, которые нужны стратегии [Р-39] */
  availability: ReturnType<typeof strategyAvailability>;
}

export interface HaltReviewReport {
  haltId: string;
  /** MANUAL_ONLY — канал не даёт выборки, остановку снимает только человек [Р-119] */
  outcome: 'RELEASED' | 'SAMPLE_FAILED' | 'NO_SAMPLE' | 'MANUAL_ONLY';
  sampleSize: number;
  failedCount: number;
  failures: Array<{ channelProductRef: string; reason: string }>;
  snapshots: SnapshotReport[];
}

export interface PipelineDeps {
  store: PricingStore;
  adapter: ChannelAdapter;
  alerts: AlertSink;
  logger: AdapterLogger;
  now: () => Instant;
  sanityConfig?: Partial<SanityConfig>;
  /** Сколько раз повторять оценку при смене контекста решения */
  maxBoundsRetries?: number;
  /**
   * Диспетчер записей [Р-64]. Путь решения сам отправляет только захваченную им запись; если после её итога в очереди ждёт
   * запись другой оценки, единица передаётся диспетчеру в этом же процессе. Без диспетчера такую запись отправит
   * экземпляр, получивший событие scope.write.v1, или обход.
   */
  dispatcher?: Pick<WriteDispatcher, 'dispatchScope'>;
}

const MAX_BOUNDS_RETRIES = 3;

type Effect =
  | { kind: 'alert'; code: string; severity: 'WARNING' | 'CRITICAL'; details: Record<string, string | number | boolean | null> }
  | { kind: 'log'; level: 'INFO' | 'WARN'; code: string; message: string; details: Record<string, string | number | boolean | null> };

interface ScopeEvaluation {
  report: ScopeReport;
  toCommit: DecisionToCommit | null;
  invoked: number;
}

export function createPricingPipeline(deps: PipelineDeps) {
  const { store, adapter, alerts, logger } = deps;
  const massShift = { ...DEFAULT_SANITY_CONFIG.massShift, ...deps.sanityConfig?.massShift };
  const shift = { windowSeconds: massShift.windowSeconds, minFactor: massShift.minFactor };
  const maxRetries = deps.maxBoundsRetries ?? MAX_BOUNDS_RETRIES;

  const alertBase = (ctx: AdapterCallContext) => ({ tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, correlationId: ctx.correlationId });
  const emit = async (ctx: AdapterCallContext, effects: readonly Effect[]) => {
    for (const e of effects) {
      if (e.kind === 'alert') await alerts.raise({ ...alertBase(ctx), code: e.code, severity: e.severity, details: e.details as Record<string, string | number | boolean> });
      else logger.log({ level: e.level, code: e.code, message: e.message, correlationId: ctx.correlationId, tenantId: ctx.tenantId, channelAccountId: ctx.channelAccountId, details: e.details });
    }
  };

  /** Стратегия и Gate по одной единице записи — без обращений к хранилищу */
  function evaluateScope(
    sc: ScopeEvaluationContext, snapshot: AcceptedSnapshot | null, trigger: { type: TriggerType; sourceEventId?: string },
    now: Instant, effects: Effect[], stages: StageRecord[],
    source: { snapshotRef: SnapshotRef | null; sanity: SanitySummary | null },
  ): ScopeEvaluation {
    const { scope, bounds } = sc;
    const report: ScopeReport = { writeScopeId: scope.writeScopeId, stages };
    if (scope.pricingMode !== 'ENGINE' || !scope.strategy) {
      stages.push({ stage: 'SCOPE', outcome: 'SKIPPED', reason: { code: 'SCOPE_NOT_ENGINE', params: { mode: scope.pricingMode } } });
      return { report, toCommit: null, invoked: 0 };
    }
    if (bounds.min.status !== 'RESOLVED' || bounds.max.status !== 'RESOLVED') {
      const bound = bounds.min.status !== 'RESOLVED' ? 'min' : 'max';
      const cause = bounds.min.status !== 'RESOLVED' ? bounds.min.cause : (bounds.max as { cause: string }).cause;
      stages.push({ stage: 'STRATEGY', outcome: 'SKIPPED', reason: { code: 'BOUND_UNRESOLVABLE', params: { bound, cause } } });
      effects.push({ kind: 'alert', code: 'PRICING_BOUND_UNRESOLVABLE', severity: 'CRITICAL', details: { writeScopeId: scope.writeScopeId, bound, cause } });
      return { report, toCommit: null, invoked: 0 };
    }
    const result = runStrategy({
      writeScope: { writeScopeId: scope.writeScopeId, currency: scope.currency, basis: scope.basis },
      strategy: scope.strategy,
      snapshot,
      cost: sc.cost,
      bounds: { minMinor: bounds.min.amountMinor, maxMinor: bounds.max.amountMinor },
      currentPriceMinor: scope.currentPriceMinor,
      now,
      trigger,
    });
    if (result.kind === 'NOT_EVALUATED') {
      stages.push({ stage: 'STRATEGY', outcome: 'NOT_EVALUATED', reason: result.reason });
      return { report, toCommit: null, invoked: 1 };
    }
    const intent = result.intent;
    const decision = decide({
      intent,
      scope: {
        writeScopeId: scope.writeScopeId, currency: scope.currency, basis: scope.basis, pricingMode: scope.pricingMode, status: scope.status,
        channelHalt: sc.channelHalt, channelDistrust: sc.channelDistrust, priceStop: sc.priceStop, blocking: sc.blocking,
      },
      bounds,
      guardrails: sc.guardrails,
      cost: sc.cost,
      costUnavailableCause: sc.costUnavailableCause ?? null,
      changesInLastHour: sc.changesInLastHour,
      now,
    });
    // Р-74: у решения NO_OP слепка и ссылки на снимок нет — только код причины. Остальные решения — слепок в том же
    // решении и той же транзакции фиксации [Р-68]; повторяющиеся части — ссылками на справочники [Р-75]
    const noChange = decision.decisionClass === 'NO_OP';
    const usesSnapshot = !noChange && isCompetitorDerived(intent.ruleCode) && source.snapshotRef !== null;
    if (noChange) {
      decision.explanation = null;
      decision.gateProfile = null;
      decision.sanityRuleset = null;
      decision.noChangeReason = intent.reason.code;
    } else {
      // Р-80: слепок без данных, которые решение хранит столбцами; ссылки на справочники — столбцы
      const built = buildExplanation({
        snapshot: usesSnapshot ? { source: source.snapshotRef!.source } : null,
        sanity: usesSnapshot ? source.sanity : null,
        intent, decision, minMarginBp: sc.guardrails.minMarginBp, channelHalt: sc.channelHalt, channelDistrust: sc.channelDistrust, priceStop: sc.priceStop,
      }, GATE_PROFILE);
      decision.explanation = built.explanation;
      decision.gateProfile = built.gateProfile;
      decision.sanityRuleset = built.sanityRuleset;
    }
    stages.push({ stage: 'STRATEGY', outcome: intent.intentClass, reason: intent.reason });
    stages.push({ stage: 'GATE', outcome: decision.outcome, reason: decision.reason });
    report.intent = intent;
    report.decision = decision;
    if (decision.alert) {
      effects.push({ kind: 'alert', code: decision.alert.code, severity: decision.alert.severity, details: { writeScopeId: scope.writeScopeId, reason: decision.reason.code } });
    }
    return { report, toCommit: { context: sc, intent, decision, snapshotRef: usesSnapshot ? source.snapshotRef : null }, invoked: 1 };
  }

  /** Отправка записей, уже переведённых в отправку транзакцией фиксации; итог — третья транзакция */
  async function dispatchCommitted(ctx: AdapterCallContext, committed: CommittedDecision, report: ScopeReport): Promise<void> {
    report.intentId = committed.intentId;
    report.decisionId = committed.decisionId;
    const write = committed.write;
    if (!write) {
      if (committed.pendingWriteId) {
        report.channelWriteId = committed.pendingWriteId;
        report.stages.push({ stage: 'DISPATCH_PLAN', outcome: 'QUEUED_BEHIND_IN_FLIGHT', reason: { code: 'WRITE_QUEUED_BEHIND_IN_FLIGHT', params: {} } });
      }
      return;
    }
    report.channelWriteId = write.channelWriteId;
    report.stages.push({ stage: 'WRITE_RECHECK', outcome: 'PASS' });
    const plan = await adapter.planDispatch(ctx, [write]);
    for (const rejected of plan.rejected) {
      const outcome: WriteOutcome = { channelWriteId: rejected.channelWriteId, status: 'REJECTED', error: rejected.error };
      report.dispatch = outcome;
      report.stages.push({ stage: 'DISPATCH_PLAN', outcome: 'REJECTED', reason: channelRefusal(rejected.error) as Reason });
      await handOff(ctx, write.writeScope.writeScopeId, await store.recordDispatch(ctx.tenantId, write, outcome, deps.now()), report);
    }
    for (const batch of plan.batches) {
      report.stages.push({ stage: 'DISPATCH_PLAN', outcome: 'PLANNED' });
      const res = await adapter.dispatch(ctx, batch);
      for (const outcome of res.outcomes) {
        report.dispatch = outcome;
        report.stages.push({
          stage: 'DISPATCH', outcome: outcome.status,
          ...(outcome.status === 'ACCEPTED' ? {} : { reason: channelRefusal(outcome.error) as Reason }),
        });
        const recorded = await store.recordDispatch(ctx.tenantId, write, outcome, deps.now());
        // Р-116 на первой отправке: синхронный канал применил запись сразу, сверки диспетчером не будет (ревью шага 22, находка 1)
        if (outcome.status === 'ACCEPTED' && outcome.appliedImmediately) await checkBasis(ctx, write, outcome.observation, report);
        await handOff(ctx, write.writeScope.writeScopeId, recorded, report);
      }
    }
  }

  /** Цена покупателя против отправленной; расхождение на ставку НДС — остановка витрины хранилищем [Р-116], как диспетчер */
  async function checkBasis(ctx: AdapterCallContext, write: FieldWrite, observation: IdentifiedObservation | undefined, report: ScopeReport): Promise<void> {
    if (write.value.field !== 'PRICE' || !observation) return;
    const price = observation.effectivePrice ?? (observation.value.field === 'PRICE' ? observation.value.price : null);
    if (!price || price.currency !== write.value.price.currency || price.amountMinor === write.value.price.amountMinor) return;
    const distrust = await store.checkPriceBasis(ctx.tenantId, write, price.amountMinor, deps.now());
    if (!distrust) return;
    report.stages.push({ stage: 'DISPATCH', outcome: 'CHANNEL_DISTRUSTED', reason: distrust.reason as Reason });
    await alerts.raise({ ...alertBase(ctx), code: 'PRICING_CHANNEL_DISTRUSTED', severity: 'CRITICAL', details: {
      writeScopeId: write.writeScope.writeScopeId, channelWriteId: write.channelWriteId, distrustId: distrust.distrustId, distrustReason: 'PRICE_BASIS_MISMATCH',
      basisError: String(distrust.reason.params.basisError ?? ''), vatRateBp: Number(distrust.reason.params.vatRateBp ?? 0),
    } });
  }

  /** Единица освободилась, а в очереди ждёт запись другой оценки — отправку продолжает диспетчер [Р-64] */
  async function handOff(ctx: AdapterCallContext, writeScopeId: string, recorded: DispatchRecorded, report: ScopeReport): Promise<void> {
    // Те же алерты, что у диспетчера (afterRecorded): до шага 21 отказ канала «нужен человек» на пути решения блокировал единицу молча —
    // симулятор с лимитом правок (K-05) это показал
    const blockedCode = (recorded.reason as { params?: Record<string, unknown> } | null)?.params?.code;
    const details = { writeScopeId, channelWriteId: report.channelWriteId ?? '', reason: recorded.reason?.code ?? 'UNKNOWN',
      // Р-115: продавец видит, что именно у оффера в канале, а не только «заблокировано»
      ...(typeof blockedCode === 'string' ? { code: blockedCode } : {}) };
    if (recorded.scopeBlocked) {
      await alerts.raise({ ...alertBase(ctx), code: 'PRICE_WRITE_SCOPE_BLOCKED', severity: 'CRITICAL', details });
    } else if (recorded.status === 'DISCARDED_STALE' || recorded.status === 'BUDGET_EXHAUSTED' || recorded.status === 'NOT_APPLIED') {
      await alerts.raise({ ...alertBase(ctx), code: 'PRICE_WRITE_NOT_SENT', severity: 'CRITICAL', details: { ...details, status: recorded.status } });
    }
    if (!deps.dispatcher || !recorded.queuedWaiting) return;
    const dispatched = await deps.dispatcher.dispatchScope(ctx.tenantId, writeScopeId);
    report.queue = [...(report.queue ?? []), ...dispatched.steps];
  }

  /**
   * Фиксация с повтором при смене контекста. build — одна попытка оценки: читает контекст и строит то, что фиксировать.
   * После последней неудачной попытки фиксируется только снимок (без решений), чтобы проекция конкурентов не отставала.
   */
  async function commitWithRetry<T extends { commit: EvaluationCommit; effects: Effect[]; reports: ScopeReport[] }>(
    ctx: AdapterCallContext, build: () => Promise<T>,
  ): Promise<{ attempt: T; committed: CommittedDecision[]; rejectedSnapshotId: string | null; divergenceCaseId: string | null } | null> {
    for (let attempt = 1; ; attempt++) {
      const built = await build();
      let result;
      try {
        result = await store.commitEvaluation(ctx.tenantId, built.commit);
      } catch (error) {
        for (const r of built.reports) if (r.decision) r.stages.push({ stage: 'COMMIT', outcome: 'ERROR' });
        await emit(ctx, [{ kind: 'alert', code: 'PRICING_COMMIT_FAILED', severity: 'CRITICAL', details: { error: String((error as Error).message).slice(0, 300) } }]);
        return null;
      }
      if (result.status === 'COMMITTED') {
        if (attempt > 1) for (const r of built.reports) if (r.decision) r.boundsRetries = attempt - 1;
        return { attempt: built, committed: result.decisions, rejectedSnapshotId: result.rejectedSnapshotId, divergenceCaseId: result.divergenceCaseId };
      }
      const report = built.reports.find((r) => r.writeScopeId === result.writeScopeId);
      if (attempt < maxRetries) continue;
      const conflict = result.reason.code === 'BOUNDS_VERSION_CHANGED';
      if (report) {
        report.boundsRetries = attempt;
        report.stages.push(conflict
          ? { stage: 'COMMIT', outcome: 'BOUNDS_CHANGED', reason: { code: 'BOUNDS_VERSION_CHANGED', params: { ...result.reason.params, attempt } } }
          : { stage: 'WRITE_RECHECK', outcome: 'BLOCKED', reason: result.reason });
      }
      const effects: Effect[] = [conflict
        ? { kind: 'alert', code: 'PRICING_COMMIT_CONFLICT', severity: 'WARNING', details: { writeScopeId: result.writeScopeId, attempts: attempt } }
        : { kind: 'alert', code: 'PRICE_WRITE_BLOCKED_BY_RECHECK', severity: 'CRITICAL', details: { writeScopeId: result.writeScopeId, reason: result.reason.code } }];
      // Снимок без решений: его проверка от контекста решения не зависит
      let fallback = null;
      if (built.commit.snapshot) {
        const snapshotOnly = await store.commitEvaluation(ctx.tenantId, { ...built.commit, decisions: [] });
        if (snapshotOnly.status === 'COMMITTED') fallback = snapshotOnly;
      }
      await emit(ctx, [...built.effects.filter((e) => e.kind === 'log'), ...effects]);
      return fallback ? { attempt: { ...built, reports: built.reports }, committed: [], rejectedSnapshotId: fallback.rejectedSnapshotId, divergenceCaseId: fallback.divergenceCaseId } : null;
    }
  }

  async function processSnapshot(ctx: AdapterCallContext, snapshot: CompetitorSnapshot): Promise<SnapshotReport> {
    const key: ProductKey = {
      channelAccountId: ctx.channelAccountId, marketplace: snapshot.marketplace,
      channelProductRef: snapshot.channelProductRef, condition: snapshot.condition,
    };
    let report!: SnapshotReport;
    let scopeReports: ScopeReport[] = [];

    const outcome = await commitWithRetry(ctx, async () => {
      const now = deps.now();
      const context = await store.loadEvaluationContext(ctx.tenantId, key, now, shift);
      const verdict = evaluateSnapshot(snapshot, context.sanity, deps.sanityConfig);
      report = {
        marketplace: snapshot.marketplace, channelProductRef: snapshot.channelProductRef, condition: snapshot.condition,
        verdict: verdict.verdict, warnings: verdict.warnings, anchorsUsed: verdict.anchorsUsed, engineInvocations: 0, scopes: [],
        snapshot, sanityChecks: verdict.checks, ruleset: verdict.ruleset,
      };
      // Р-72: журнал — коды и параметры, без текста
      const effects: Effect[] = verdict.warnings.map((w) => ({ kind: 'log', level: 'WARN', code: `INPUT_SANITY_${w.code}`, message: w.code, details: { channelProductRef: snapshot.channelProductRef } }));
      const snapshotOutcome: SnapshotOutcome = { verdict: verdict.verdict, observedAt: snapshot.observedAt, move: verdict.move };
      const commit: EvaluationCommit = { key, now, snapshot: snapshotOutcome, decisions: [] };
      scopeReports = [];

      if (verdict.verdict !== 'ACCEPT') {
        report.reason = verdict.reason;
        report.alarmClass = verdict.alarmClass;
        snapshotOutcome.rejected = {
          source: snapshot.source, ...(snapshot.sourceEventId ? { sourceEventId: snapshot.sourceEventId } : {}),
          observedAt: snapshot.observedAt, receivedAt: now, verdict: verdict.verdict, reasonCode: verdict.reason.code,
          alarmClass: verdict.alarmClass, details: verdict.reason.params, ruleset: verdict.ruleset,
        };
        if (verdict.verdict === 'HALT_CHANNEL') {
          snapshotOutcome.halt = { channelAccountId: ctx.channelAccountId, marketplace: snapshot.marketplace, reasonCode: 'CHANNEL_MASS_SHIFT', details: verdict.reason.params, haltedAt: now };
          effects.push({ kind: 'alert', code: 'PRICING_CHANNEL_HALTED', severity: 'CRITICAL', details: { marketplace: snapshot.marketplace, ...verdict.reason.params } });
        } else if (verdict.alert) {
          const unitScale = verdict.alarmClass === 'UNIT_SCALE';
          effects.push({
            kind: 'alert', code: unitScale ? 'COMPETITOR_UNIT_SCALE_SUSPECT' : 'COMPETITOR_SNAPSHOT_REJECTED', severity: unitScale ? 'CRITICAL' : 'WARNING',
            details: { reasonCode: verdict.reason.code, alarmClass: verdict.alarmClass, marketplace: snapshot.marketplace, channelProductRef: snapshot.channelProductRef },
          });
        }
        effects.push({ kind: 'log', level: 'WARN', code: `INPUT_SANITY_${verdict.verdict}`, message: verdict.reason.code, details: { reasonCode: verdict.reason.code, channelProductRef: snapshot.channelProductRef } });
        return { commit, effects, reports: scopeReports };
      }

      const primary = context.scopes.find((s) => s.scope.pricingMode === 'ENGINE') ?? context.scopes[0] ?? null;
      const sanity = summarizeSanity(verdict, SANITY_RULESET);
      const snapshotRef: SnapshotRef = { competitorSnapshotId: randomUUID(), source: snapshot.source, observedAt: snapshot.observedAt };
      snapshotOutcome.accepted = { snapshot: verdict.snapshot, gtin: primary?.scope.gtin ?? null, competitorSnapshotId: snapshotRef.competitorSnapshotId, sanity };
      if (verdict.divergence && primary) {
        snapshotOutcome.divergence = {
          writeScopeId: primary.scope.writeScopeId, expectedMinor: verdict.divergence.ourPriceMinor, observedMinor: verdict.divergence.valueMinor, observedAt: snapshot.observedAt,
        };
      }
      if (context.scopes.length === 0) report.reason = { code: 'NO_SCOPE_FOR_PRODUCT', params: {} };
      const trigger = { type: 'COMPETITOR_CHANGE' as const, ...(snapshot.sourceEventId ? { sourceEventId: snapshot.sourceEventId } : {}) };
      for (const sc of context.scopes) {
        const evaluation = evaluateScope(sc, verdict.snapshot, trigger, now, effects, [{ stage: 'SANITY', outcome: 'ACCEPT' }], { snapshotRef, sanity });
        scopeReports.push(evaluation.report);
        report.engineInvocations += evaluation.invoked;
        if (evaluation.toCommit) commit.decisions.push(evaluation.toCommit);
      }
      return { commit, effects, reports: scopeReports };
    });

    report.scopes = scopeReports;
    if (!outcome) return report;
    if (outcome.divergenceCaseId && report.verdict === 'ACCEPT') {
      report.divergenceCaseId = outcome.divergenceCaseId;
      const d = outcome.attempt.commit.snapshot?.divergence;
      outcome.attempt.effects.push({ kind: 'log', level: 'WARN', code: 'DIVERGENCE_CASE_OPENED', message: 'DIVERGENCE_CASE_OPENED', details: { writeScopeId: d?.writeScopeId ?? null, observedMinor: d?.observedMinor ?? null, expectedMinor: d?.expectedMinor ?? null } });
    }
    await emit(ctx, outcome.attempt.effects);
    for (const committed of outcome.committed) {
      const r = scopeReports.find((x) => x.writeScopeId === committed.writeScopeId);
      if (r) await dispatchCommitted(ctx, committed, r);
    }
    return report;
  }

  async function pollCompetitors(ctx: AdapterCallContext, queries: readonly CompetitorQuery[]) {
    const read = await adapter.readCompetitors(ctx, queries);
    const snapshots: SnapshotReport[] = [];
    for (const snapshot of read.snapshots) snapshots.push(await processSnapshot(ctx, snapshot));
    return { snapshots, failures: read.failures };
  }

  /** Р-52: свежая независимая выборка; прошла проверки — остановка снимается с записью в журнал */
  async function reviewHalt(ctx: AdapterCallContext, halt: HaltInfo, sampleSize: number): Promise<HaltReviewReport> {
    const tenantId = ctx.tenantId;
    const now = deps.now();
    const queries = await store.pickReviewSample(tenantId, halt, sampleSize);
    if (queries.length === 0) {
      await emit(ctx, [{ kind: 'log', level: 'WARN', code: 'HALT_REVIEW_NO_SAMPLE', message: 'HALT_REVIEW_NO_SAMPLE', details: { haltId: halt.haltId } }]);
      return { haltId: halt.haltId, outcome: 'NO_SAMPLE', sampleSize: 0, failedCount: 0, failures: [], snapshots: [] };
    }
    const read = await adapter.readCompetitors(ctx, queries);
    const failures: HaltReviewReport['failures'] = read.failures.map((f) => ({ channelProductRef: f.query.channelProductRef, reason: f.error.code }));
    // Находка 2 ревью шага 16 [0063]: путь решения записывает только наблюдения выборки; итог и снятие вычисляет хранилище
    const samples: HaltSampleObservation[] = read.failures.map((f) => ({ channelProductRef: f.query.channelProductRef, observedAt: now, verdict: 'READ_FAILED', reasonCode: f.error.code }));
    const moves: Array<{ moveBp: number; sellerRef: string | null }> = [];
    for (const snapshot of read.snapshots) {
      const key: ProductKey = { channelAccountId: ctx.channelAccountId, marketplace: snapshot.marketplace, channelProductRef: snapshot.channelProductRef, condition: snapshot.condition };
      const context = await store.loadEvaluationContext(tenantId, key, now, shift);
      // Независимая выборка: без действующей остановки и без окна движений, которое её вызвало
      const verdict = evaluateSnapshot(snapshot, { ...context.sanity, channel: { halt: null, recentMoves: [] } }, deps.sanityConfig);
      if (verdict.move) moves.push({ moveBp: verdict.move.moveBp, sellerRef: verdict.move.sellerRef });
      if (verdict.verdict !== 'ACCEPT') failures.push({ channelProductRef: snapshot.channelProductRef, reason: verdict.reason.code });
      samples.push(verdict.verdict === 'ACCEPT'
        ? { channelProductRef: snapshot.channelProductRef, observedAt: snapshot.observedAt, verdict: 'ACCEPT', reasonCode: null }
        : { channelProductRef: snapshot.channelProductRef, observedAt: snapshot.observedAt, verdict: 'REJECT', reasonCode: verdict.reason.code });
    }
    const sampleShift = assessShift(moves, deps.sanityConfig?.massShift);
    if (sampleShift.parseErrorSuspected) {
      failures.push({ channelProductRef: '*', reason: 'CHANNEL_MASS_SHIFT' });
      samples.push({ channelProductRef: '*', observedAt: now, verdict: 'MASS_SHIFT', reasonCode: 'CHANNEL_MASS_SHIFT' });
    }
    const sampleSizeTaken = queries.length;
    await store.recordHaltSample(tenantId, halt.haltId, samples, now);
    const outcome = await store.reviewHaltBySample(tenantId, halt.haltId, now);

    if (outcome === 'SAMPLE_FAILED') {
      await emit(ctx, [{ kind: 'log', level: 'WARN', code: 'HALT_REVIEW_FAILED', message: 'HALT_REVIEW_FAILED', details: { haltId: halt.haltId, sampleSize: sampleSizeTaken, failed: failures.length } }]);
      return { haltId: halt.haltId, outcome: 'SAMPLE_FAILED', sampleSize: sampleSizeTaken, failedCount: Math.min(failures.length, sampleSizeTaken), failures, snapshots: [] };
    }
    if (outcome !== 'RELEASED') {
      // Выборки не хватило (или остановка уже снята, или срок не наступил) — остановка остаётся до следующей проверки
      await emit(ctx, [{ kind: 'log', level: 'WARN', code: 'HALT_REVIEW_NO_SAMPLE', message: 'HALT_REVIEW_NO_SAMPLE', details: { haltId: halt.haltId, outcome, sampleSize: sampleSizeTaken } }]);
      return { haltId: halt.haltId, outcome: 'NO_SAMPLE', sampleSize: sampleSizeTaken, failedCount: 0, failures, snapshots: [] };
    }
    await emit(ctx, [
      { kind: 'log', level: 'INFO', code: 'HALT_AUTO_RELEASED', message: 'HALT_AUTO_RELEASED', details: { haltId: halt.haltId, sampleSize: sampleSizeTaken } },
      { kind: 'alert', code: 'PRICING_CHANNEL_RESUMED', severity: 'WARNING', details: { haltId: halt.haltId, sampleSize: sampleSizeTaken, kind: 'AUTO' } },
    ]);
    // Выборка прошла — те же снимки идут обычным путём
    const snapshots: SnapshotReport[] = [];
    for (const snapshot of read.snapshots) snapshots.push(await processSnapshot(ctx, snapshot));
    return { haltId: halt.haltId, outcome: 'RELEASED', sampleSize: sampleSizeTaken, failedCount: 0, failures: [], snapshots };
  }

  return {
    processSnapshot,
    pollCompetitors,

    /** Уведомление: снимок с данными — сразу в путь; без данных — опрос ресурса [Р-46] */
    async processInbound(delivery: InboundDelivery): Promise<{ inbound: InboundResult; snapshots: SnapshotReport[] }> {
      const inbound = await adapter.handleInbound(delivery);
      const snapshots: SnapshotReport[] = [];
      if (inbound.kind !== 'EVENTS') return { inbound, snapshots };
      const ctx: AdapterCallContext = {
        tenantId: delivery.claimed.tenantId,
        channelAccountId: delivery.claimed.channelAccountId,
        correlationId: `pipeline:${inbound.deliveryId}`,
        deadline: new Date(Date.parse(deps.now()) + 60_000).toISOString(),
      };
      for (const event of inbound.events) {
        if (event.kind === 'COMPETITOR_SNAPSHOT') snapshots.push(await processSnapshot(ctx, event.snapshot));
        else if (event.kind === 'RESOURCE_CHANGED' && event.competitorQuery) snapshots.push(...(await pollCompetitors(ctx, [event.competitorQuery])).snapshots);
      }
      return { inbound, snapshots };
    },

    /**
     * Шаг 21: превью стратегии на реальной единице записи до сохранения. Стратегия и Gate — те же функции, что у оценки, на последнем
     * принятом снимке товара и текущих границах, себестоимости, остановках; ничего не фиксируется, не пишется в канал, алертов нет.
     * Момент оценки — время снимка (иначе снимок почти всегда старше допуска стратегии); границы и себестоимость — текущие.
     */
    async previewStrategy(ctx: AdapterCallContext, writeScopeId: string, strategy: StrategyDefinition): Promise<StrategyPreview | null> {
      const loaded = await store.loadScopeContext(ctx.tenantId, writeScopeId, deps.now());
      if (!loaded) return null;
      const at = loaded.snapshot ? new Date(Date.parse(loaded.snapshot.observedAt) + 1_000).toISOString() : deps.now();
      const context: ScopeEvaluationContext = { ...loaded.context, scope: { ...loaded.context.scope, pricingMode: 'ENGINE', strategy } };
      const evaluation = evaluateScope(context, loaded.snapshot, { type: 'MANUAL' }, at, [], [], { snapshotRef: loaded.snapshotRef, sanity: loaded.snapshotRef?.sanity ?? null });
      return {
        writeScopeId,
        evaluatedAt: at,
        snapshotObservedAt: loaded.snapshot?.observedAt ?? null,
        currentPriceMinor: loaded.context.scope.currentPriceMinor,
        currency: loaded.context.scope.currency,
        stages: evaluation.report.stages,
        ...(evaluation.report.intent ? { intent: evaluation.report.intent } : {}),
        ...(evaluation.report.decision ? { decision: evaluation.report.decision } : {}),
        availability: strategyAvailability(strategy.params, adapter.descriptor.competitorSources ?? []),
      };
    },

    /** Пересчёт единицы без нового снимка: изменилась себестоимость, расписание, ручной запуск */
    async recompute(ctx: AdapterCallContext, writeScopeId: string, trigger: { type: TriggerType; sourceEventId?: string }): Promise<ScopeReport> {
      let report: ScopeReport = { writeScopeId, stages: [] };
      const outcome = await commitWithRetry(ctx, async () => {
        const now = deps.now();
        const loaded = await store.loadScopeContext(ctx.tenantId, writeScopeId, now);
        const effects: Effect[] = [];
        if (!loaded) {
          report = { writeScopeId, stages: [{ stage: 'SCOPE', outcome: 'SKIPPED', reason: { code: 'SCOPE_NOT_ENGINE', params: { mode: null } } }] };
          return { commit: { key: { channelAccountId: ctx.channelAccountId, marketplace: '', channelProductRef: '', condition: '' }, now, decisions: [] }, effects, reports: [report] };
        }
        const { scope } = loaded.context;
        const evaluation = evaluateScope(loaded.context, loaded.snapshot, trigger, now, effects, [], { snapshotRef: loaded.snapshotRef, sanity: loaded.snapshotRef?.sanity ?? null });
        report = evaluation.report;
        const key = { channelAccountId: scope.channelAccountId, marketplace: scope.marketplace, channelProductRef: scope.channelProductRef, condition: scope.condition };
        return { commit: { key, now, decisions: evaluation.toCommit ? [evaluation.toCommit] : [] }, effects, reports: [report] };
      });
      if (!outcome) return report;
      await emit(ctx, outcome.attempt.effects);
      for (const committed of outcome.committed) await dispatchCommitted(ctx, committed, report);
      return report;
    },

    /**
     * Включение репрайсинга [Р-43]: без обеих границ режим не меняется. Маржинальная стратегия или пол по марже без
     * себестоимости — предупреждение до включения; включить можно только явно подтвердив его (шаг 12).
     */
    async enableRepricing(ctx: AdapterCallContext, writeScopeId: string, options: { acknowledgeWarnings?: boolean; userId?: string } = {}): Promise<{ enabled: boolean; problems: Reason[]; warnings: Reason[] }> {
      const loaded = await store.loadScopeContext(ctx.tenantId, writeScopeId, deps.now());
      if (!loaded) return { enabled: false, problems: [{ code: 'NO_SCOPE_FOR_PRODUCT', params: { writeScopeId } }], warnings: [] };
      const { scope, bounds } = loaded.context;
      const problems = validateRepricingEnablement(bounds, scope.currency, scope.basis, scope.strategy);
      // Р-77: предупреждение решается по типу стратегии единицы записи; без стратегии включение отказывает (STRATEGY_MISSING)
      const warnings = scope.strategy
        ? repricingWarnings({ strategy: scope.strategy, minMarginBp: loaded.context.guardrails.minMarginBp, cost: loaded.context.cost, costMissingCause: loaded.context.costMissingCause ?? null })
        : [];
      const codes = (list: Reason[]) => list.map((p) => p.code).join(',');
      if (problems.length > 0) {
        await emit(ctx, [{ kind: 'log', level: 'WARN', code: 'REPRICING_NOT_ENABLED', message: 'REPRICING_NOT_ENABLED', details: { writeScopeId, problems: codes(problems), warnings: codes(warnings) } }]);
        return { enabled: false, problems, warnings };
      }
      if (warnings.length > 0 && !options.acknowledgeWarnings) {
        await emit(ctx, [{ kind: 'log', level: 'WARN', code: 'REPRICING_WARNINGS_NOT_ACKNOWLEDGED', message: 'REPRICING_WARNINGS_NOT_ACKNOWLEDGED', details: { writeScopeId, warnings: codes(warnings) } }]);
        return { enabled: false, problems: [], warnings };
      }
      await store.setPricingMode(ctx.tenantId, writeScopeId, 'ENGINE', options.userId);
      return { enabled: true, problems: [], warnings };
    },

    /** Kill switch [Р-69, Р-70]: все изменения цен; права и заметку проверяют хранилище и БД */
    async stopPricing(ctx: AdapterCallContext, record: StopRecord): Promise<StopResult> {
      const result = await store.stopPricing(ctx.tenantId, record);
      if (result.status === 'STOPPED') {
        await emit(ctx, [{ kind: 'alert', code: 'PRICING_STOPPED_BY_PERSON', severity: 'CRITICAL', details: { stopId: result.stop.stopId, scope: result.stop.scope, marketplace: result.stop.marketplace } }]);
      }
      return result;
    },

    async resumePricing(ctx: AdapterCallContext, stopId: string, release: StopRelease): Promise<StopResult> {
      const result = await store.releaseStop(ctx.tenantId, stopId, release);
      if (result.status === 'RELEASED') {
        await emit(ctx, [{ kind: 'alert', code: 'PRICING_RESUMED_BY_PERSON', severity: 'WARNING', details: { stopId, scope: result.stop.scope } }]);
      }
      return result;
    },

    /** Р-52: проверить остановки аккаунта, у которых подошло окно */
    async reviewHalts(ctx: AdapterCallContext, sampleSize = 5): Promise<HaltReviewReport[]> {
      const due = await store.listDueHalts(ctx.tenantId, ctx.channelAccountId, deps.now());
      const reports: HaltReviewReport[] = [];
      // Р-119: у канала нет опроса конкурентов — выборку для Р-52 взять неоткуда. Это свойство канала: чтение не пробуется, провал
      // выборки не записывается, остановка ждёт человека (база возвращает MANUAL_ONLY и сама, 0082)
      if (adapter.descriptor.haltRelease.kind === 'MANUAL_ONLY') {
        for (const halt of due) {
          await emit(ctx, [{ kind: 'log', level: 'INFO', code: 'HALT_RELEASE_MANUAL_ONLY', message: 'HALT_RELEASE_MANUAL_ONLY', details: { haltId: halt.haltId, channel: adapter.descriptor.channel } }]);
          reports.push({ haltId: halt.haltId, outcome: 'MANUAL_ONLY', sampleSize: 0, failedCount: 0, failures: [], snapshots: [] });
        }
        return reports;
      }
      for (const halt of due) reports.push(await reviewHalt(ctx, halt, sampleSize));
      return reports;
    },

    /** Р-118: снятие остановки по недоверию каналу — только человек; права, второй фактор и заметку проверяют хранилище и БД */
    async releaseDistrust(ctx: AdapterCallContext, distrustId: string, actor: { membershipId: string; userId: string; mfa: boolean }, note: string): Promise<{ released: boolean }> {
      const result = await store.releaseDistrust(ctx.tenantId, distrustId, { ...actor, note, at: deps.now() });
      if (result !== 'RELEASED') return { released: false };
      await emit(ctx, [
        { kind: 'log', level: 'INFO', code: 'DISTRUST_RELEASED', message: 'DISTRUST_RELEASED', details: { distrustId, membershipId: actor.membershipId } },
        { kind: 'alert', code: 'PRICING_CHANNEL_TRUST_RESTORED', severity: 'WARNING', details: { distrustId } },
      ]);
      return { released: true };
    },

    /** Р-52: ручное снятие — без ограничения числа попыток, с обязательной заметкой */
    async releaseHaltManually(ctx: AdapterCallContext, haltId: string, actor: { membershipId: string; userId: string; mfa: boolean }, note: string): Promise<{ released: boolean }> {
      const halt = await store.getHalt(ctx.tenantId, haltId);
      if (!halt) return { released: false };
      await store.releaseHalt(ctx.tenantId, haltId, {
        kind: 'MANUAL_RELEASE', outcome: 'RELEASED', sampleSize: 0, failedCount: 0, details: {}, membershipId: actor.membershipId, userId: actor.userId, mfa: actor.mfa, note, at: deps.now(),
      });
      await emit(ctx, [
        { kind: 'log', level: 'INFO', code: 'HALT_MANUALLY_RELEASED', message: 'HALT_MANUALLY_RELEASED', details: { haltId, membershipId: actor.membershipId } },
        { kind: 'alert', code: 'PRICING_CHANNEL_RESUMED', severity: 'WARNING', details: { haltId, kind: 'MANUAL' } },
      ]);
      return { released: true };
    },
  };
}

export type PricingPipeline = ReturnType<typeof createPricingPipeline>;
