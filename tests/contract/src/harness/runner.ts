import type { AdapterCallContext, AdapterDependencies, ChannelAdapter, InboundDelivery } from '@repracer/channel-port';
import { signKauflandRequest } from '@repracer/kaufland-client';
import { createPricingPipeline, InMemoryPricingStore, standUserOf, type MemorySeed, type PricingPipeline, type PricingStore, type SeedBound, type SnapshotReport } from '@repracer/pricing-pipeline';
import type { CostInputs } from '@repracer/pricing-model';
import { createWriteDispatcher, type WriteDispatcher, type WriteQueueStore } from '@repracer/write-dispatcher';
import { channelFetch, kauflandAuthChecker, ScriptedChannel, type ChannelBehaviour, type TraceEntry } from './channel.ts';
import { match } from './matchers.ts';
import { SimulatedKauflandChannel } from '../simulator/kaufland-channel.ts';
import type { CallStep, InboundDeliverySpec, PipelineStep, Scenario, StepContext, World } from './scenario.ts';
import { VirtualClock, worldDependencies, type Sink } from './world.ts';

export interface AdapterUnderTest {
  (input: { deps: AdapterDependencies; world: World; clock: VirtualClock; fetch: typeof fetch }): ChannelAdapter;
}

/** Хранилище пути решения для сценария: в памяти по умолчанию, PostgreSQL — через фабрику */
export interface PricingStoreUnderTest {
  store: PricingStore;
  /** Очередь записей того же хранилища — для диспетчера [Р-64] */
  queue: WriteQueueStore;
  dump(): Promise<unknown>;
  setBound(writeScopeId: string, bound: 'min' | 'max', value: SeedBound | null): Promise<void>;
  setCost(writeScopeId: string, cost: CostInputs | null): Promise<void>;
  close(): Promise<void>;
  /** Тенант и членства в хранилище входа (PostgreSQL): идентификаторы базы и их псевдонимы сценария [OQ-128] */
  identity?: { tenantId: string; membershipAlias(identityMembershipId: string): string };
}

export type PricingStoreFactory = (seed: MemorySeed, world: World) => Promise<PricingStoreUnderTest>;

export const memoryStoreFactory: PricingStoreFactory = async (seed, world) => {
  const store = new InMemoryPricingStore(seed, { tenantId: world.tenantId });
  return {
    store,
    queue: store,
    dump: () => store.dump(),
    setBound: async (id, bound, value) => store.setBound(id, bound, value),
    setCost: async (id, cost) => store.setCost(id, cost),
    close: async () => {},
  };
};

/** Доступ к миру сценария после шагов и до закрытия хранилища — стенд интерфейса [Р-67] */
export interface ScenarioHooks {
  onFinish?(finished: {
    scenario: Scenario;
    store: PricingStoreUnderTest | null;
    pipeline: PricingPipeline | null;
    dispatcher: WriteDispatcher | null;
    results: Record<string, unknown>;
    sink: Sink;
    clock: VirtualClock;
    /** Модель канала симулятора, если сценарий её задаёт */
    simulator: SimulatedKauflandChannel | null;
  }): Promise<void>;
}

export interface ScenarioReport {
  failures: string[];
  trace: TraceEntry[];
  logs: Sink['logs'];
  alerts: Sink['alerts'];
  results: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Подстановки времени: {"$clockIso": смещение_мс}, {"$clockSeconds": смещение_с}
// ---------------------------------------------------------------------------

export function resolvePlaceholders(value: unknown, clock: VirtualClock): unknown {
  if (Array.isArray(value)) return value.map((v) => resolvePlaceholders(v, clock));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === '$clockIso') return clock.iso(Number(obj.$clockIso));
    if (keys.length === 1 && keys[0] === '$clockSeconds') return String(Math.floor(clock.nowMs() / 1000) + Number(obj.$clockSeconds));
    return Object.fromEntries(keys.map((k) => [k, resolvePlaceholders(obj[k], clock)]));
  }
  return value;
}

function buildDelivery(d: InboundDeliverySpec, scenario: Scenario, clock: VirtualClock): InboundDelivery {
  const { world } = scenario;
  const rawBody = d.rawBody ?? (d.body === undefined ? '' : JSON.stringify(resolvePlaceholders(d.body, clock)));
  const headers: Record<string, string> = {};
  let signWith: unknown;
  for (const [name, raw] of Object.entries(d.headers ?? {})) {
    if (raw && typeof raw === 'object' && '$signWith' in (raw as object)) { signWith = (raw as { $signWith: unknown }).$signWith; headers[name] = ''; continue; }
    headers[name] = String(resolvePlaceholders(raw, clock));
  }
  if (signWith !== undefined) {
    const secretKey = signWith === 'seller' ? world.credentials.seller.secretKey
      : signWith === 'partner' ? world.credentials.partner?.secretKey ?? ''
      : String((signWith as { secretKey?: string }).secretKey ?? '');
    const tsHeader = Object.entries(headers).find(([k]) => k.toLowerCase() === 'shop-timestamp')?.[1] ?? '0';
    const name = Object.keys(headers).find((k) => headers[k] === '' && k.toLowerCase() === 'shop-signature') ?? 'Shop-Signature';
    headers[name] = signKauflandRequest({ method: d.method.toUpperCase(), uri: d.url, body: rawBody, timestamp: Number(tsHeader), secretKey });
  }
  return {
    claimed: {
      tenantId: (d.claimed?.tenantId ?? world.tenantId) as InboundDelivery['claimed']['tenantId'],
      channelAccountId: (d.claimed?.channelAccountId ?? world.channelAccountId) as InboundDelivery['claimed']['channelAccountId'],
    },
    method: d.method,
    url: d.url,
    headers,
    rawBody,
    receivedAt: clock.iso(),
  };
}

function callContext(stepCtx: StepContext | undefined, stepId: string, scenario: Scenario, clock: VirtualClock): AdapterCallContext {
  return {
    tenantId: (stepCtx?.tenantId ?? scenario.world.tenantId) as AdapterCallContext['tenantId'],
    channelAccountId: (stepCtx?.channelAccountId ?? scenario.world.channelAccountId) as AdapterCallContext['channelAccountId'],
    correlationId: `${scenario.id}:${stepId}`,
    deadline: clock.iso(stepCtx?.deadlineInMs ?? 60_000),
  };
}

async function runCall(step: CallStep, adapter: ChannelAdapter, scenario: Scenario, clock: VirtualClock): Promise<{ result?: unknown; thrown?: unknown }> {
  const ctx = callContext(step.ctx, step.id, scenario, clock);
  const method = (adapter as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[step.method];
  if (typeof method !== 'function') return { thrown: { harness: `adapter has no method ${step.method}` } };
  const args = resolvePlaceholders(step.args, clock) as unknown[];
  try {
    return { result: await method.call(adapter, ctx, ...args) };
  } catch (error) {
    const channelError = (error as { error?: unknown }).error;
    return { thrown: channelError ?? { message: String(error) } };
  }
}

async function runPipelineStep(
  step: PipelineStep, pipeline: PricingPipeline, store: PricingStoreUnderTest, dispatcher: WriteDispatcher, scenario: Scenario, clock: VirtualClock,
): Promise<{ result?: unknown; failure?: string }> {
  switch (step.kind) {
    case 'pipelineDispatchDue':
      return { result: await dispatcher.sweep({ pendingMinAgeMs: 0 }) };
    case 'pipelineInbound':
      return { result: await pipeline.processInbound(buildDelivery(step.delivery, scenario, clock)) };
    case 'pipelinePoll':
      return { result: await pipeline.pollCompetitors(callContext(step.ctx, step.id, scenario, clock), resolvePlaceholders(step.queries, clock) as never) };
    case 'pipelineRecompute':
      return { result: await pipeline.recompute(callContext(step.ctx, step.id, scenario, clock), step.writeScopeId, step.trigger) };
    case 'pipelineEnableRepricing':
      return { result: await pipeline.enableRepricing(callContext(step.ctx, step.id, scenario, clock), step.writeScopeId,
        // Р-97: включение — действие владельца сценария в административном сервисе
        { ...(step.acknowledgeWarnings ? { acknowledgeWarnings: true } : {}), userId: standUserOf('membership-owner') }) };
    case 'pricingStop': {
      const ctx = callContext(step.ctx, step.id, scenario, clock);
      if (step.op === 'stop') {
        return {
          result: await pipeline.stopPricing(ctx, {
            scope: step.scope, channelAccountId: step.scope === 'TENANT' ? null : step.channelAccountId ?? scenario.world.channelAccountId,
            marketplace: step.scope === 'STOREFRONT' ? step.marketplace ?? null : null, stoppedAt: clock.iso(), stoppedByMembershipId: step.membershipId,
            stoppedByUserId: standUserOf(step.membershipId), note: step.note,
          }),
        };
      }
      const dump = (await store.dump()) as { stops?: Array<{ stopId: string }> };
      const stop = dump.stops?.[step.stopIndex];
      if (!stop) return { failure: `${step.id}: no stop #${step.stopIndex}` };
      return { result: await pipeline.resumePricing(ctx, stop.stopId, { membershipId: step.membershipId, userId: standUserOf(step.membershipId), mfa: true, note: step.note, at: clock.iso() }) };
    }
    case 'pipelineReviewHalts':
      return { result: await pipeline.reviewHalts(callContext(step.ctx, step.id, scenario, clock), step.sampleSize) };
    case 'pipelineReleaseHalt': {
      const dump = (await store.dump()) as { halts?: Array<{ haltId: string }> };
      const halt = dump.halts?.[step.haltIndex];
      if (!halt) return { failure: `${step.id}: no halt #${step.haltIndex}` };
      return { result: await pipeline.releaseHaltManually(callContext(step.ctx, step.id, scenario, clock), halt.haltId, { membershipId: step.membershipId, userId: standUserOf(step.membershipId), mfa: true }, step.note) };
    }
    case 'pricingMutation': {
      try {
        if (step.op === 'setBound') await store.setBound(step.writeScopeId, step.bound, step.value);
        else await store.setCost(step.writeScopeId, step.value);
      } catch (error) {
        if (step.expectThrows && String(error).includes(step.expectThrows)) return { result: { thrown: String(error) } };
        return { failure: `${step.id}: mutation failed: ${String(error)}` };
      }
      return step.expectThrows ? { failure: `${step.id}: expected mutation to fail with "${step.expectThrows}"` } : { result: { ok: true } };
    }
  }
}

function jsonIncludes(haystack: unknown, needle: string): boolean {
  return needle.length > 0 && JSON.stringify(haystack).includes(needle);
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Сценарий без привязки к календарной дате [OQ-95]: все моменты и даты сдвигаются так, чтобы часы мира начинались в target.
 * Относительные расстояния сохраняются; формат строки (миллисекунды, смещение зоны) — тоже.
 */
export function rebaseScenario(scenario: Scenario, targetIso: string): Scenario {
  const origin = Date.parse(scenario.world.clock);
  const target = Date.parse(targetIso);
  const offsetMs = target - origin;
  const dayShift = Math.floor(target / 86_400_000) - Math.floor(origin / 86_400_000);
  if (offsetMs === 0) return scenario;
  const shift = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const m = ISO_INSTANT.exec(value);
      if (m) {
        const zone = m[3]!;
        const zoneMs = zone === 'Z' ? 0 : (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * 60_000;
        const local = new Date(Date.parse(value) + offsetMs + zoneMs).toISOString();
        return local.slice(0, 19) + (m[2] ? local.slice(19, 19 + m[2].length) : '') + zone;
      }
      if (ISO_DATE.test(value)) return new Date(Date.parse(`${value}T00:00:00Z`) + dayShift * 86_400_000).toISOString().slice(0, 10);
      return value;
    }
    if (Array.isArray(value)) return value.map(shift);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'provenance' ? v : shift(v)]));
    return value;
  };
  return shift(scenario) as Scenario;
}

/** Начало часов сценариев: REPRACER_STAND_CLOCK или текущий момент с точностью до секунды */
export function standClock(): string {
  return process.env.REPRACER_STAND_CLOCK ?? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}

export async function runScenario(
  original: Scenario, adapterUnderTest: AdapterUnderTest, behaviour?: ChannelBehaviour, storeFactory: PricingStoreFactory = memoryStoreFactory,
  hooks: ScenarioHooks = {},
): Promise<ScenarioReport> {
  const scenario = rebaseScenario(original, standClock());
  const { world } = scenario;
  const clock = new VirtualClock(world.clock);
  const sink: Sink = { logs: [], alerts: [] };
  const violations: string[] = [];
  const trace: TraceEntry[] = [];
  const channel = behaviour
    ?? (world.channelModel ? new SimulatedKauflandChannel(world.channelModel, world.clock) : new ScriptedChannel(scenario.exchanges, scenario.expect?.allExchangesUsed ?? true));
  const simulator = channel instanceof SimulatedKauflandChannel ? channel : null;
  const fetch = channelFetch(channel, kauflandAuthChecker(world, clock), clock, violations, trace);
  const deps = worldDependencies(world, clock, sink);
  const adapter = adapterUnderTest({ deps, world, clock, fetch });
  const failures: string[] = [];
  const results: Record<string, unknown> = {};

  let store: PricingStoreUnderTest | null = null;
  let pipeline: PricingPipeline | null = null;
  let dispatcher: WriteDispatcher | null = null;
  if (world.pricing) {
    const { sanity, ...seed } = world.pricing;
    store = await storeFactory(seed, world);
    dispatcher = createWriteDispatcher({ store: store.queue, adapterFor: () => adapter, alerts: deps.alerts, now: () => clock.iso() });
    pipeline = createPricingPipeline({
      store: store.store, adapter, alerts: deps.alerts, logger: deps.logger, now: () => clock.iso(), dispatcher, ...(sanity ? { sanityConfig: sanity } : {}),
    });
  }
  try {

  for (const step of scenario.steps) {
    if (step.kind === 'advanceClock') { clock.advance(step.ms); continue; }

    if (step.kind === 'inbound') {
      const result = await adapter.handleInbound(buildDelivery(step.delivery, scenario, clock));
      results[step.id] = result;
      for (const m of match(result, resolvePlaceholders(step.expect, clock), 'subset', step.id)) failures.push(m);
      continue;
    }

    if (step.kind === 'channelOrder') { simulator!.placeOrder(step.idOffer, step.quantity, clock.nowMs()); continue; }
    if (step.kind === 'channelDeliver') {
      const snapshots: unknown[] = [];
      const deliveries = simulator!.drainDeliveries(clock.nowMs());
      for (const d of deliveries) snapshots.push(...(await pipeline!.processInbound(buildDelivery(d, scenario, clock))).snapshots);
      const result = { deliveries: deliveries.length, snapshots };
      results[step.id] = result;
      if (step.expect !== undefined) failures.push(...match(result, resolvePlaceholders(step.expect, clock), 'subset', step.id));
      continue;
    }

    if (step.kind === 'channelRun') {
      const summary = { ticks: 0, deliveries: 0, snapshots: 0, verdicts: {} as Record<string, number>, rejectReasons: {} as Record<string, number>,
        decisions: {} as Record<string, number>, dispatched: 0 };
      const count = (bag: Record<string, number>, key: string) => { bag[key] = (bag[key] ?? 0) + 1; };
      const take = (reports: SnapshotReport[]) => {
        for (const r of reports) {
          summary.snapshots += 1;
          count(summary.verdicts, r.verdict);
          if (r.verdict !== 'ACCEPT' && r.reason) count(summary.rejectReasons, r.reason.code);
          for (const sc of r.scopes) if (sc.decision) count(summary.decisions, sc.decision.decisionClass);
        }
      };
      for (let elapsed = 0; elapsed < step.durationMs; elapsed += step.tickMs) {
        clock.advance(step.tickMs);
        summary.ticks += 1;
        const deliveries = simulator!.drainDeliveries(clock.nowMs());
        summary.deliveries += deliveries.length;
        for (const d of deliveries) take((await pipeline!.processInbound(buildDelivery(d, scenario, clock))).snapshots);
        if (step.poll) take((await pipeline!.pollCompetitors(callContext(undefined, step.id, scenario, clock), resolvePlaceholders(step.poll, clock) as never)).snapshots);
        summary.dispatched += (await dispatcher!.sweep({ pendingMinAgeMs: 0 })).due;
      }
      results[step.id] = summary;
      if (step.expect !== undefined) failures.push(...match(summary, resolvePlaceholders(step.expect, clock), 'subset', step.id));
      continue;
    }

    if (step.kind !== 'call') {
      const { result, failure } = await runPipelineStep(step, pipeline!, store!, dispatcher!, scenario, clock);
      if (failure) { failures.push(failure); continue; }
      results[step.id] = result;
      const expected = 'expect' in step ? step.expect : undefined;
      if (expected !== undefined) failures.push(...match(result, resolvePlaceholders(expected, clock), 'subset', step.id));
      continue;
    }

    const runs = step.repeat ?? 1;
    const outputs: unknown[] = [];
    for (let i = 0; i < runs; i++) {
      const { result, thrown } = await runCall(step, adapter, scenario, clock);
      outputs.push(thrown !== undefined ? { thrown } : result);
      const label = runs > 1 ? `${step.id}#${i + 1}` : step.id;
      if (step.expectThrows !== undefined) {
        if (thrown === undefined) failures.push(`${label}: expected a thrown channel error, got ${JSON.stringify(result)?.slice(0, 200)}`);
        else failures.push(...match(thrown, resolvePlaceholders(step.expectThrows, clock), 'subset', label));
        continue;
      }
      if (thrown !== undefined) { failures.push(`${label}: unexpected throw ${JSON.stringify(thrown).slice(0, 300)}`); continue; }
      const expected = step.expectEach?.[i] ?? step.expect;
      if (expected !== undefined) failures.push(...match(result, resolvePlaceholders(expected, clock), 'subset', label));
    }
    results[step.id] = runs > 1 ? outputs : outputs[0];
  }

  failures.push(...violations.map((v) => `channel: ${v}`));
  failures.push(...channel.finish().map((v) => `channel: ${v}`));

  const expect = scenario.expect ?? {};
  for (const e of expect.logs ?? []) {
    const { count, ...shape } = e;
    const n = sink.logs.filter((entry) => match(entry, shape, 'subset').length === 0).length;
    if (count === undefined ? n === 0 : n !== count) failures.push(`logs: ${JSON.stringify(shape)} seen ${n} times, expected ${count ?? '≥1'}`);
  }
  for (const e of expect.alerts ?? []) {
    const { count, ...shape } = e;
    const n = sink.alerts.filter((a) => match(a, shape, 'subset').length === 0).length;
    if (count === undefined ? n === 0 : n !== count) failures.push(`alerts: ${JSON.stringify(shape)} raised ${n} times, expected ${count ?? '≥1'}`);
  }
  for (const code of expect.noLogCodes ?? []) {
    if (sink.logs.some((l) => l.code === code)) failures.push(`logs: ${code} must not be logged`);
  }
  if (expect.noAlerts && sink.alerts.length > 0) failures.push(`alerts: expected none, got ${sink.alerts.map((a) => a.code).join(', ')}`);
  const pipelineState = store ? await store.dump() : null;
  if (expect.pipeline !== undefined && store) {
    failures.push(...match(pipelineState, resolvePlaceholders(expect.pipeline, clock), 'subset', 'pipeline'));
  }
  if (expect.channel !== undefined && simulator) {
    failures.push(...match(simulator.dump(), resolvePlaceholders(expect.channel, clock), 'subset', 'channel'));
  }

  // Секреты и синтетические PII не должны утечь
  const everywhere = { results, logs: sink.logs, alerts: sink.alerts, pipeline: pipelineState };
  const observability = { logs: sink.logs, alerts: sink.alerts };
  const creds = [world.credentials.seller.secretKey, world.credentials.seller.clientKey, world.credentials.partner?.secretKey, world.credentials.partner?.clientKey];
  for (const secret of creds) if (secret && jsonIncludes(everywhere, secret)) failures.push('leak: channel credentials appear in results, logs or alerts');
  for (const pii of world.pii ?? []) if (jsonIncludes(everywhere, pii)) failures.push(`leak: PII sentinel "${pii}" appears in results, logs or alerts`);
  for (const secret of world.secrets ?? []) if (jsonIncludes(observability, secret)) failures.push(`leak: secret sentinel "${secret}" appears in logs or alerts`);

  await hooks.onFinish?.({ scenario, store, pipeline, dispatcher, results, sink, clock, simulator });
  return { failures, trace, logs: sink.logs, alerts: sink.alerts, results };
  } finally {
    await store?.close();
  }
}
