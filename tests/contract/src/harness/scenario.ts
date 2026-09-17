import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SanityConfig } from '@repracer/input-sanity';
import type { MemorySeed, SeedBound } from '@repracer/pricing-pipeline';
import type { CostInputs, TriggerType } from '@repracer/pricing-model';
import type { KauflandChannelModelSpec } from '../simulator/kaufland-channel.ts';

/**
 * Формат сценария контрактного теста. Один файл — один сценарий: мир (аккаунт, ключи, часы, бюджет, данные цен),
 * шаги драйвера (вызовы порта, входящие уведомления, путь решения о цене, сдвиг часов), обмены с каналом в порядке
 * их ожидания и ожидания по выходам.
 *
 * Разделение «шаги ↔ обмены ↔ ожидания» сделано под симулятор: обмены — это сценарий поведения канала.
 * Стенд воспроизводит их строго по порядку (ScriptedChannel); симулятор подставит вместо списка модель канала
 * с состоянием (ChannelBehaviour), а шаги и ожидания останутся теми же.
 */
export const SCENARIO_FORMAT = 'repracer.contract-scenario/v1';

export type Provenance =
  /** Собрано вручную по документации и спецификации канала; данные синтетические */
  | { kind: 'SYNTHETIC_FROM_DOCS'; sources: string[] }
  /** Записано рекордером с реального тестового аккаунта и обезличено; без рецензии не исполняется */
  | { kind: 'RECORDED_REDACTED'; recordedAt: string; recorderVersion: string; redactions: string[]; reviewedBy: string | null };

export interface BucketSpec { ratePerSecond: number; burst: number }

export interface World {
  /** Начальное время виртуальных часов (ISO) */
  clock: string;
  tenantId: string;
  channelAccountId: string;
  /** region — регион SP-API аккаунта Amazon (EU, NA) */
  account: { externalAccountId: string; marketplaces: string[]; channel?: string; region?: string };
  /** Синтетические ключи; seller обязателен, partner — если partner = true */
  /**
   * Синтетические ключи. Kaufland: seller {clientKey, secretKey}, partner. Amazon: seller {refreshToken} (согласие продавца LWA),
   * application {clientId, clientSecret} (ключи приложения), accessToken — токен, который выдаёт обмен LWA сценария.
   */
  credentials: { seller: Record<string, string>; partner?: Record<string, string>; application?: Record<string, string>; accessToken?: string };
  partner?: boolean;
  /** Ответ каталога аккаунтов для любого вызова: по умолчанию проверка тенанта и аккаунта мира */
  directory?: 'CHECK' | 'NOT_FOUND' | 'DISCONNECTED';
  budget?: { seller: BucketSpec; partner?: BucketSpec };
  client?: { timeoutMs?: number; maxAttempts?: number };
  adapter?: { confirmationWindowMs?: number; webhookMaxAgeMs?: number; buyBoxChangedAccess?: 'GRANTED' | 'NOT_GRANTED'; amazonApplicationLoadRps?: number };
  /** Данные пути решения о цене (хранилище в памяти); без них шаги pipeline* недоступны */
  pricing?: MemorySeed & { sanity?: Partial<SanityConfig> };
  /** Строки, которых не должно быть нигде в выходах, журнале и алертах (синтетические PII) */
  pii?: string[];
  /** Строки, которых не должно быть в журнале и алертах (токен адреса вебхука) */
  secrets?: string[];
  /** Симулятор [Р-113]: канал с состоянием вместо обменов; exchanges сценария пусты */
  channelModel?: KauflandChannelModelSpec;
}

export type PortMethod =
  | 'planDispatch' | 'dispatch' | 'readBack' | 'confirm' | 'readCompetitors' | 'discoverOffers' | 'readOrderLines'
  | 'ensureSubscriptions' | 'requestReport' | 'pollReport';

export interface StepContext { tenantId?: string; channelAccountId?: string; deadlineInMs?: number }

export interface CallStep {
  id: string;
  kind: 'call';
  method: PortMethod;
  /** Аргументы после ctx; для requestReport — [reportType, marketplace] */
  args: unknown[];
  ctx?: StepContext;
  repeat?: number;
  /** Ожидание результата (подмножество); при repeat — для каждого вызова, если нет expectEach */
  expect?: unknown;
  expectEach?: unknown[];
  /** Ожидание ошибки ChannelCallError (подмножество ChannelError) */
  expectThrows?: unknown;
}

export interface InboundDeliverySpec {
  method: string;
  url: string;
  headers?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
  claimed?: { tenantId?: string; channelAccountId?: string };
}

export interface InboundStep {
  id: string;
  kind: 'inbound';
  delivery: InboundDeliverySpec;
  expect: unknown;
}

export interface ClockStep {
  id: string;
  kind: 'advanceClock';
  ms: number;
}

// ---------------------------------------------------------------------------
// Путь решения о цене (шаг 7)
// ---------------------------------------------------------------------------

/** Уведомление целиком через путь: адаптер → снимок или опрос → проверка входов → стратегия → Gate → запись */
export interface PipelineInboundStep { id: string; kind: 'pipelineInbound'; delivery: InboundDeliverySpec; expect?: unknown }
/** Опрос конкурентов через адаптер и путь */
export interface PipelinePollStep { id: string; kind: 'pipelinePoll'; queries: unknown[]; ctx?: StepContext; expect?: unknown }
/** Пересчёт единицы без нового снимка */
export interface PipelineRecomputeStep { id: string; kind: 'pipelineRecompute'; writeScopeId: string; trigger: { type: TriggerType; sourceEventId?: string }; ctx?: StepContext; expect?: unknown }
/** Включение репрайсинга [Р-43] */
export interface PipelineEnableStep { id: string; kind: 'pipelineEnableRepricing'; writeScopeId: string; acknowledgeWarnings?: boolean; ctx?: StepContext; expect?: unknown }
/** Изменение мира цен между шагами: граница или себестоимость */
export type PricingMutationStep =
  | { id: string; kind: 'pricingMutation'; op: 'setBound'; writeScopeId: string; bound: 'min' | 'max'; value: SeedBound | null; expectThrows?: string }
  | { id: string; kind: 'pricingMutation'; op: 'setCost'; writeScopeId: string; value: CostInputs | null; expectThrows?: string };

/** Р-52: проверить остановки, у которых подошло окно */
export interface PipelineReviewHaltsStep { id: string; kind: 'pipelineReviewHalts'; sampleSize: number; ctx?: StepContext; expect?: unknown }
/** Р-52: ручное снятие остановки по её номеру в состоянии хранилища */
export interface PipelineReleaseHaltStep { id: string; kind: 'pipelineReleaseHalt'; haltIndex: number; membershipId: string; note: string; ctx?: StepContext; expect?: unknown }
/** Р-118: снятие недоверия каналу человеком (второй фактор — у пользователя стенда, если mfa не false) */
export interface PipelineReleaseDistrustStep { id: string; kind: 'pipelineReleaseDistrust'; distrustIndex: number; membershipId: string; note: string; mfa?: boolean; ctx?: StepContext; expect?: unknown }

/** Остановка человеком и её снятие [Р-69, Р-70]: права — по роли участника (DEFAULT_MEMBERS); снятие — по номеру остановки */
export type PricingStopStep =
  | { id: string; kind: 'pricingStop'; op: 'stop'; scope: 'TENANT' | 'CHANNEL_ACCOUNT' | 'STOREFRONT'; channelAccountId?: string; marketplace?: string; membershipId: string; note: string; ctx?: StepContext; expect?: unknown }
  | { id: string; kind: 'pricingStop'; op: 'release'; stopIndex: number; membershipId: string; note: string; ctx?: StepContext; expect?: unknown };

/** Обход диспетчера записей [Р-64]: отправить, повторить или сверить всё, чей срок наступил по часам мира */
export interface PipelineDispatchDueStep { id: string; kind: 'pipelineDispatchDue'; expect?: unknown }

export type PipelineStep = PipelineInboundStep | PipelinePollStep | PipelineRecomputeStep | PipelineEnableStep | PricingMutationStep
  | PipelineReviewHaltsStep | PipelineReleaseHaltStep | PipelineReleaseDistrustStep | PipelineDispatchDueStep | PricingStopStep;

/** Симулятор: доставить уведомления модели канала, срок которых наступил, через путь решения */
export interface ChannelDeliverStep { id: string; kind: 'channelDeliver'; expect?: unknown }
/** Симулятор: заказ покупателя в канале (K-11) */
export interface ChannelOrderStep { id: string; kind: 'channelOrder'; idOffer: string; quantity: number }

/**
 * Симулятор: прогон мира за период — каждые tickMs часы сдвигаются, уведомления модели идут через путь решения,
 * при poll — опрос конкурентов, затем обход диспетчера записей [Р-64]. Итог — сводка, а не отчёты каждого снимка.
 */
export interface ChannelRunStep { id: string; kind: 'channelRun'; durationMs: number; tickMs: number; poll?: unknown[]; expect?: unknown }

export type Step = CallStep | InboundStep | ClockStep | PipelineStep | ChannelDeliverStep | ChannelOrderStep | ChannelRunStep;

export interface ScriptedResponse { status: number; headers?: Record<string, string>; body?: unknown }

export interface Exchange {
  id: string;
  note?: string;
  request: { method: string; path: string; query?: Record<string, unknown>; body?: unknown };
  response?: ScriptedResponse;
  /** Сбой вместо ответа: TIMEOUT — канал не отвечает до отмены запроса клиентом; NETWORK_ERROR — обрыв */
  fault?: 'TIMEOUT' | 'NETWORK_ERROR';
}

export interface LogExpectation { code: string; count?: number; [key: string]: unknown }
export interface AlertExpectation { code: string; count?: number; [key: string]: unknown }

export interface Scenario {
  format: typeof SCENARIO_FORMAT;
  id: string;
  channel: 'KAUFLAND' | 'AMAZON';
  apiVersion: string;
  title: string;
  description: string;
  tags: string[];
  provenance: Provenance;
  world: World;
  steps: Step[];
  exchanges: Exchange[];
  expect?: {
    logs?: LogExpectation[];
    alerts?: AlertExpectation[];
    noLogCodes?: string[];
    noAlerts?: boolean;
    /** По умолчанию все обмены должны быть использованы */
    allExchangesUsed?: boolean;
    /** Подмножество состояния хранилища пути решения после всех шагов */
    pipeline?: unknown;
    /** Подмножество состояния модели канала (только с world.channelModel) */
    channel?: unknown;
  };
  /**
   * Варианты ответов на открытые вопросы канала (только с world.channelModel): тот же сценарий при других параметрах модели.
   * expect варианта заменяет ожидания сценария целиком, stepExpect — ожидания отдельных шагов.
   */
  variants?: Array<{ id: string; question: string; params: Record<string, unknown>; finding?: string; expect?: Scenario['expect']; stepExpect?: Record<string, unknown> }>;
}

const ID_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;
const PIPELINE_KINDS = new Set(['channelDeliver', 'channelRun', 'pipelineInbound', 'pipelinePoll', 'pipelineRecompute', 'pipelineEnableRepricing', 'pricingMutation', 'pipelineReviewHalts', 'pipelineReleaseHalt', 'pipelineReleaseDistrust', 'pricingStop']);

export function validateScenario(s: Scenario): string[] {
  const problems: string[] = [];
  if (s.format !== SCENARIO_FORMAT) problems.push(`format must be ${SCENARIO_FORMAT}`);
  if (!ID_RE.test(s.id ?? '')) problems.push('id must be kebab-case with / separators');
  if (!s.title || !s.description) problems.push('title and description are required');
  if (!Array.isArray(s.tags)) problems.push('tags must be an array');
  if (s.provenance?.kind === 'RECORDED_REDACTED' && !s.provenance.reviewedBy) {
    problems.push('recorded fixture has not been reviewed (provenance.reviewedBy is null)');
  } else if (s.provenance?.kind !== 'SYNTHETIC_FROM_DOCS' && s.provenance?.kind !== 'RECORDED_REDACTED') {
    problems.push('provenance.kind is unknown');
  }
  if (!s.world?.credentials?.seller) problems.push('world.credentials.seller is required');
  if (s.world?.partner && !s.world.credentials.partner) problems.push('world.partner requires credentials.partner');
  if (s.channel === 'AMAZON' && (!s.world?.credentials?.application || !s.world.credentials.accessToken || !s.world.account.region)) {
    problems.push('an Amazon world needs credentials.application, credentials.accessToken and account.region');
  }
  const stepIds = new Set<string>();
  for (const step of s.steps ?? []) {
    if (stepIds.has(step.id)) problems.push(`duplicate step id ${step.id}`);
    stepIds.add(step.id);
    if (PIPELINE_KINDS.has(step.kind) && !s.world?.pricing) problems.push(`step ${step.id}: pipeline steps require world.pricing`);
  }
  if (s.expect?.pipeline !== undefined && !s.world?.pricing) problems.push('expect.pipeline requires world.pricing');
  if (s.world?.channelModel && (s.exchanges ?? []).length > 0) problems.push('world.channelModel replaces exchanges: exchanges must be empty');
  if (!s.world?.channelModel && (s.variants || s.expect?.channel !== undefined || (s.steps ?? []).some((st) => st.kind === 'channelDeliver' || st.kind === 'channelOrder' || st.kind === 'channelRun'))) {
    problems.push('variants, expect.channel and channel steps require world.channelModel');
  }
  for (const c of s.world?.channelModel?.competitors ?? []) {
    if (c.behaviour.kind === 'RANDOM_WALK' && !(c.behaviour.everyMs > 0)) problems.push(`competitor ${c.sellerRef}: RANDOM_WALK everyMs must be > 0`);
  }
  const exchangeIds = new Set<string>();
  for (const ex of s.exchanges ?? []) {
    if (exchangeIds.has(ex.id)) problems.push(`duplicate exchange id ${ex.id}`);
    exchangeIds.add(ex.id);
    const pathOk = s.channel === 'AMAZON'
      ? /^\/(listings\/2021-08-01\/items\/|auth\/o2\/token$)/.test(ex.request?.path ?? '')
      : Boolean(ex.request?.path?.startsWith('/v2/'));
    if (!pathOk) problems.push(`exchange ${ex.id}: request.path is not an ${s.channel} API path`);
    if (Boolean(ex.response) === Boolean(ex.fault)) problems.push(`exchange ${ex.id}: exactly one of response or fault`);
  }
  return problems;
}

/** Сценарий симулятора и его варианты: по одному прогону на набор параметров модели */
export function expandVariants(s: Scenario): Array<{ variant: string; question: string | null; finding: string | null; scenario: Scenario }> {
  const base = { variant: 'default', question: null, finding: null, scenario: s };
  if (!s.world.channelModel || !s.variants) return [base];
  return [base, ...s.variants.map((v) => {
    const model = s.world.channelModel!;
    const steps = s.steps.map((step) => (v.stepExpect && step.id in v.stepExpect ? { ...step, expect: v.stepExpect[step.id] } : step)) as Step[];
    const scenario: Scenario = {
      ...s, steps, world: { ...s.world, channelModel: { ...model, params: { ...model.params, ...v.params } } },
      ...(v.expect ? { expect: v.expect } : {}),
    };
    return { variant: v.id, question: v.question, finding: v.finding ?? null, scenario };
  })];
}

export function loadScenarios(dir: string): Array<{ file: string; scenario: Scenario }> {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => {
    const scenario = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Scenario;
    const problems = validateScenario(scenario);
    if (problems.length > 0) throw new Error(`${file}: ${problems.join('; ')}`);
    return { file, scenario };
  });
}
