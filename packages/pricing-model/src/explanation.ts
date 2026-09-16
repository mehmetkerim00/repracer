import type { FxApplied } from './fx.ts';
import type { HaltRef, StopRef } from './policy.ts';
import { CHANNEL_PARAM_KEYS, COMPETITOR_RULE_DERIVED_KEYS, paramSchema, SANITY_RULES } from './reasons.ts';
import { isCompetitorDerived, type GateOutcome, type IntentClass, type PriceDecisionDraft, type PriceIntentDraft, type Reason, type SanityCheckRecord, type StrategyDefinition, type TriggerType } from './types.ts';

/**
 * Неизменяемый слепок объяснения решения [Р-68] в формате шагов 13–14.
 *  - Р-74: слепок есть у решений CHANGED и REJECTED_BY_GATE; у NO_OP слепка нет — решение хранит только код причины.
 *  - Р-75: повторяющиеся части не дублируются, а берутся из справочников:
 *      параметры стратегии — `tenant_data.pricing_strategy` по идентификатору и версии;
 *      порядок проверок Gate — профиль Gate (`platform.explanation_ruleset`, kind GATE): слепок хранит только непрошедшую проверку;
 *      порядок правил и пороги проверки входов — набор правил (kind SANITY): слепок хранит правила, которые не «прошли без пояснения»,
 *      и параметры класса CONFIG, только если они отличаются от порога набора.
 *  - Р-80: слепок не повторяет данные, которые решение и ядро хранят столбцами (итог, причина и границы Gate, отклонение,
 *    профиль и набор правил, версия стратегии, правило, триггер, предложенная цена): развёртывание берёт их из строки.
 * Данных канала в слепке нет: параметры класса CHANNEL вырезаются, их имена — в withheld [Р-3, Р-38].
 *  - Р-85: из слепка нельзя ВОССТАНОВИТЬ данные канала — вырезаются и производные величины (класс CHANNEL_DERIVED: цели стратегий
 *    по рынку, разница в мёртвой зоне), а у цены из данных конкурентов — предложенная цена, отклонение, шаг и сумма проверки.
 */

export const EXPLANATION_FORMAT = 'r80.1';

/**
 * Находка 8 ревью шага 17: вид значения каждого скалярного поля слепка — не только параметров причин. Реестр дублирован в БД
 * (`security.explanation_field_kinds()`, 0070); совпадение проверяет undercut-eternal.pg.test.ts. Поле без вида БД отклоняет.
 * Виды: code — код из заглавных букв (источник, проверка Gate, якорь), uuid, id — идентификатор витрины или записи; n — допускает null.
 */
export interface FieldKind { k: string; n?: true; v?: readonly string[] }
export const EXPLANATION_FIELD_KINDS: Readonly<Record<string, FieldKind>> = {
  '$.format': { k: 'enum', v: [EXPLANATION_FORMAT] },
  '$.snapshot.source': { k: 'code' },
  '$.sanity.checks[].rule': { k: 'enum', v: SANITY_RULES },
  '$.sanity.checks[].outcome': { k: 'enum', v: ['PASS', 'FAIL', 'SKIPPED'] },
  '$.sanity.anchorsUsed': { k: 'codeList' },
  '$.strategy.intentClass': { k: 'enum', v: ['NO_OP'] },
  '$.strategy.currentMinor': { k: 'money', n: true },
  '$.strategy.currency': { k: 'currency' },
  '$.strategy.boundsAtStrategy.minMinor': { k: 'money' },
  '$.strategy.boundsAtStrategy.maxMinor': { k: 'money' },
  '$.strategy.boundsAtStrategy.currency': { k: 'currency' },
  '$.gate.failed.check': { k: 'code' },
  '$.gate.minMarginBp': { k: 'bp' },
  '$.gate.fx.source': { k: 'enum', v: ['ECB'] },
  '$.gate.fx.rateDate': { k: 'date' },
  '$.gate.fx.base': { k: 'enum', v: ['EUR'] },
  '$.gate.fx.quote': { k: 'currency' },
  '$.gate.fx.rateMicros': { k: 'rateMicros' },
  '$.gate.fx.from': { k: 'currency' },
  '$.gate.fx.to': { k: 'currency' },
  '$.gate.fx.sourceAmountMinor': { k: 'money' },
  '$.gate.fx.convertedAmountMinor': { k: 'money' },
  '$.gate.fx.rounding': { k: 'enum', v: ['UP', 'NEAREST'] },
  '$.context.channelHalt.haltId': { k: 'uuid' },
  '$.context.channelHalt.reasonCode': { k: 'enum', v: ['CHANNEL_MASS_SHIFT'] },
  '$.context.channelHalt.marketplace': { k: 'id', n: true },
  '$.context.channelHalt.haltedAt': { k: 'instant' },
  '$.context.priceStop.stopId': { k: 'uuid' },
  '$.context.priceStop.scope': { k: 'enum', v: ['TENANT', 'CHANNEL_ACCOUNT', 'STOREFRONT'] },
  '$.context.priceStop.channelAccountId': { k: 'uuid', n: true },
  '$.context.priceStop.marketplace': { k: 'id', n: true },
  '$.context.priceStop.stoppedAt': { k: 'instant' },
  '$.context.priceStop.stoppedByMembershipId': { k: 'uuid' },
};

type Params = Reason['params'];
type Value = string | number | boolean | null;

export interface ExplainedReason {
  code: string;
  /** Нет поля — параметров в слепке нет */
  params?: Params;
  /**
   * Вырезанные параметры, которые нельзя вывести из реестра: необязательные ключи канала и необъявленные ключи.
   * Обязательные ключи класса CHANNEL не перечисляются — их список есть в реестре причин [Р-75]
   */
  withheld?: string[];
}

// ---------------------------------------------------------------------------
// Справочники [Р-75]
// ---------------------------------------------------------------------------

export interface SanityRulesetDefinition {
  /** Правила в порядке применения */
  rules: string[];
  /** Пороги набора: код причины → параметр класса CONFIG → значение */
  config: Record<string, Record<string, Value>>;
}

export interface GateProfileDefinition {
  /** Порядок проверок Gate для intent с изменением цены и без него */
  CHANGED: string[];
  NO_OP: string[];
}

export interface SanityRuleset { rulesetId: string; kind: 'SANITY'; definition: SanityRulesetDefinition }
export interface GateProfile { rulesetId: string; kind: 'GATE'; definition: GateProfileDefinition }
export type ExplanationRuleset = SanityRuleset | GateProfile;

export interface ExplanationDictionary {
  rulesets: readonly ExplanationRuleset[];
  strategies: readonly StrategyDefinition[];
}

// ---------------------------------------------------------------------------
// Хранимый слепок
// ---------------------------------------------------------------------------

/** Итог проверки входов с набором правил: набор — столбец sanity_ruleset, остальное — слепок [Р-80] */
export type SanitySummary = ExplanationSanity & { ruleset: string };

export interface ExplanationSanity {
  /** Правила, которые не «прошли без пояснения»; остальные правила набора (столбец sanity_ruleset) прошли */
  checks: Array<{ rule: string; outcome: 'PASS' | 'FAIL' | 'SKIPPED'; detail?: ExplainedReason }>;
  anchorsUsed: string[];
  warnings?: ExplainedReason[];
}

export interface DecisionExplanation {
  format: typeof EXPLANATION_FORMAT;
  /** Источник снимка; время наблюдения и содержимое — в ссылке на снимок (18 месяцев) */
  snapshot?: { source: string };
  sanity?: ExplanationSanity;
  strategy: {
    /** Только у intent без изменения цены, отклонённого Gate */
    intentClass?: 'NO_OP';
    /** Суммы — с валютой рядом [Р-71] */
    currentMinor: number | null;
    boundsAtStrategy: { minMinor: number; maxMinor: number; currency: string };
    currency: string;
    reason: ExplainedReason;
    /** Шаги расчёта до итоговой причины */
    steps?: ExplainedReason[];
    /** Вся цепочка, если её последний шаг — не итоговая причина */
    chain?: ExplainedReason[];
  };
  /** Только то, чего нет в столбцах: непрошедшая проверка (прошедшие до неё — из профиля), минимальная маржа, курс */
  gate?: {
    failed?: { check: string; detail?: ExplainedReason };
    minMarginBp?: number;
    fx?: FxApplied;
  };
  context?: { channelHalt?: HaltRef; priceStop?: StopRef };
}

/** Столбцы решения и ядра, из которых разворачивается слепок [Р-80]; в памяти — те же значения черновиков */
export interface ExplanationRow {
  outcome: GateOutcome;
  rejectionReason: string | null;
  reasonParams: Params;
  floorMinor: number | null;
  ceilingMinor: number | null;
  boundDeviationBp: number | null;
  currency: string;
  gateProfile: string | null;
  sanityRuleset: string | null;
  strategyId: string | null;
  strategyVersion: number | null;
  ruleCode: string;
  trigger: TriggerType;
  /** NULL — в вечном ядре у отклонённой цены из данных конкурентов предложенная цена не хранится [Р-85] */
  proposedMinor: number | null;
}

// ---------------------------------------------------------------------------
// Развёрнутый слепок — для экранов
// ---------------------------------------------------------------------------

export interface ExpandedReason {
  code: string;
  params: Params;
  withheld: string[];
}

export interface ExpandedExplanation {
  format: string;
  snapshot: { source: string } | null;
  sanity: {
    ruleset: string;
    anchorsUsed: string[];
    checks: Array<{ rule: string; outcome: 'PASS' | 'FAIL' | 'SKIPPED'; detail: ExpandedReason | null }>;
    warnings: ExpandedReason[];
  } | null;
  strategy: {
    strategyId: string | null;
    version: number | null;
    type: string | null;
    params: Params;
    ruleCode: string;
    intentClass: IntentClass;
    trigger: TriggerType;
    currentMinor: number | null;
    proposedMinor: number | null;
    boundsAtStrategy: { minMinor: number; maxMinor: number; currency: string };
    currency: string;
    reason: ExpandedReason;
    /** Вся цепочка расчёта, включая итоговую причину */
    steps: ExpandedReason[];
  };
  gate: {
    profile: string | null;
    outcome: GateOutcome;
    reason: ExpandedReason;
    checks: Array<{ check: string; passed: boolean; detail: ExpandedReason | null }>;
    /** Проверки профиля после непрошедшей — не выполнялись */
    notRun: string[];
    /** Профиль найден и описывает непрошедшую проверку: checks и notRun — весь путь; иначе порядок неизвестен [находка 8] */
    profileKnown: boolean;
    floorMinor: number | null;
    ceilingMinor: number | null;
    minMarginBp: number | null;
    boundDeviationBp: number | null;
    currency: string;
    fx: FxApplied | null;
  };
  context: { channelHalt: HaltRef | null; priceStop: StopRef | null };
}

/** Чего не нашлось в справочниках: экран называет пробел, а не показывает пустоту */
export interface ExplanationGap {
  kind: 'SANITY_RULESET' | 'GATE_PROFILE' | 'STRATEGY';
  ref: string;
}

const CHANNEL_KEYS = new Set(CHANNEL_PARAM_KEYS);

/**
 * Причина для слепка: параметры класса CHANNEL и необъявленные (fail-closed) не сохраняются; порог класса CONFIG,
 * совпадающий с порогом набора правил, не дублируется [Р-75].
 */
export function explainedReason(
  reason: { code: string; params: Params }, config: Readonly<Record<string, Value>> = {}, options: { competitorDerived?: boolean } = {},
): ExplainedReason {
  const schema = paramSchema(reason.code);
  const params: Record<string, Value> = {};
  const withheld: string[] = [];
  for (const [key, value] of Object.entries(reason.params ?? {})) {
    const spec = schema?.[key];
    // Р-85: ключ, производный от цены конкурента в решении из данных конкурентов, реестр вывести не может — он перечисляется
    if (options.competitorDerived && COMPETITOR_RULE_DERIVED_KEYS.includes(key)) withheld.push(key);
    else if (!spec || spec.class === 'CHANNEL' || spec.class === 'CHANNEL_DERIVED' || CHANNEL_KEYS.has(key)) {
      if (!spec || spec.optional) withheld.push(key);
    } else if (spec.class === 'CONFIG' && Object.hasOwn(config, key) && config[key] === value) continue;
    else params[key] = value;
  }
  // Валюта нужна, только если в слепке осталась сумма
  const amountLeft = Object.keys(params).some((k) => schema?.[k]?.kind === 'money');
  if (!amountLeft && 'currency' in params && schema?.currency?.optional) delete params.currency;
  return { code: reason.code, ...(Object.keys(params).length > 0 ? { params } : {}), ...(withheld.length > 0 ? { withheld: withheld.sort() } : {}) };
}

/**
 * Итог проверки входов принятого снимка для слепка; хранится и с принятым снимком, чтобы пересчёт объяснялся так же.
 * Принятый снимок прошёл все правила набора в порядке справочника — иначе справочник не описывает проверку, и это ошибка кода.
 */
export function summarizeSanity(
  verdict: { ruleset: string; anchorsUsed: readonly string[]; checks: readonly SanityCheckRecord[]; warnings: readonly Reason[] },
  ruleset: SanityRuleset,
): SanitySummary {
  if (verdict.ruleset !== ruleset.rulesetId) throw new Error(`sanity ruleset ${verdict.ruleset} is not the dictionary entry ${ruleset.rulesetId} (Р-75)`);
  const rules = ruleset.definition.rules;
  if (verdict.checks.length !== rules.length || verdict.checks.some((c, i) => c.rule !== rules[i])) {
    throw new Error(`accepted snapshot checks ${verdict.checks.map((c) => c.rule).join(',')} do not follow ruleset ${ruleset.rulesetId} (Р-75)`);
  }
  const cfg = (code: string) => ruleset.definition.config[code] ?? {};
  const checks = verdict.checks
    .filter((c) => c.outcome !== 'PASS' || c.detail)
    .map((c) => ({ rule: c.rule, outcome: c.outcome, ...(c.detail ? { detail: explainedReason(c.detail, cfg(c.detail.code)) } : {}) }));
  const warnings = verdict.warnings.map((w) => explainedReason(w, cfg(w.code)));
  return { ruleset: ruleset.rulesetId, checks, anchorsUsed: [...verdict.anchorsUsed], ...(warnings.length > 0 ? { warnings } : {}) };
}

export interface ExplanationInput {
  snapshot: { source: string } | null;
  /** Итог проверки входов с набором правил: набор уходит в столбец sanity_ruleset, итог — в слепок */
  sanity: SanitySummary | null;
  intent: PriceIntentDraft;
  decision: PriceDecisionDraft;
  minMarginBp: number | null;
  channelHalt: HaltRef | null;
  priceStop: StopRef | null;
}

const same = (a: ExplainedReason, b: ExplainedReason) => JSON.stringify(a) === JSON.stringify(b);

/** Слепок решения CHANGED или REJECTED_BY_GATE и ссылки на справочники для столбцов; решение NO_OP слепка не имеет [Р-74] */
export function buildExplanation(input: ExplanationInput, gate: GateProfile): { explanation: DecisionExplanation; gateProfile: string; sanityRuleset: string | null } {
  const { intent, decision } = input;
  if (decision.decisionClass === 'NO_OP') throw new Error('a NO_OP decision keeps only its reason code, not an explanation (Р-74)');
  const order = gate.definition[intent.intentClass];
  const checks = decision.checks;
  checks.forEach((c, i) => {
    if (c.check !== order[i] || (!c.passed && i !== checks.length - 1)) {
      throw new Error(`Gate checks ${checks.map((x) => x.check).join(',')} do not follow profile ${gate.rulesetId} (Р-75)`);
    }
  });
  const last = checks[checks.length - 1];
  const failed = last && !last.passed ? last : null;
  if (!failed && checks.length !== order.length) throw new Error(`Gate passed ${checks.length} of ${order.length} checks of profile ${gate.rulesetId} without a failure (Р-75)`);

  const derived = { competitorDerived: isCompetitorDerived(intent.ruleCode) };
  const reason = explainedReason(intent.reason, {}, derived);
  const chain = intent.explanation.map((r) => explainedReason(r, {}, derived));
  const tail = chain[chain.length - 1];
  const chainPart = tail && same(tail, reason) ? (chain.length > 1 ? { steps: chain.slice(0, -1) } : {}) : { chain };
  const context = {
    ...(input.channelHalt ? { channelHalt: input.channelHalt } : {}),
    ...(input.priceStop ? { priceStop: input.priceStop } : {}),
  };
  const gatePart = {
    ...(failed ? { failed: { check: failed.check, ...(failed.detail ? { detail: explainedReason(failed.detail, {}, derived) } : {}) } } : {}),
    ...(input.minMarginBp !== null ? { minMarginBp: input.minMarginBp } : {}),
    ...(decision.fx ? { fx: decision.fx } : {}),
  };
  const sanity = input.sanity ? (({ ruleset: _ruleset, ...rest }) => rest)(input.sanity) : null;
  return {
    explanation: {
      format: EXPLANATION_FORMAT,
      ...(input.snapshot ? { snapshot: { source: input.snapshot.source } } : {}),
      ...(sanity ? { sanity } : {}),
      strategy: {
        ...(intent.intentClass === 'NO_OP' ? { intentClass: 'NO_OP' as const } : {}),
        currentMinor: intent.currentMinor,
        boundsAtStrategy: { ...intent.inputs.boundsAtStrategy, currency: intent.currency },
        currency: intent.currency,
        reason,
        ...chainPart,
      },
      ...(Object.keys(gatePart).length > 0 ? { gate: gatePart } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
    },
    gateProfile: gate.rulesetId,
    sanityRuleset: input.sanity?.ruleset ?? null,
  };
}

/** Столбцы intent, которые решение и ядро хранят рядом со слепком [Р-80] */
export interface ExplanationIntentColumns {
  strategyId: string | null;
  strategyVersion: number | null;
  ruleCode: string;
  trigger: TriggerType;
  proposedMinor: number;
}

/** Столбцы строки для развёртывания: итог Gate и ссылки — из решения, стратегия и предложенная цена — из intent */
export function explanationRowOf(
  intent: ExplanationIntentColumns,
  decision: Pick<PriceDecisionDraft, 'outcome' | 'rejectionReason' | 'reason' | 'effectiveFloorMinor' | 'effectiveCeilingMinor' | 'boundDeviationBp' | 'currency' | 'gateProfile' | 'sanityRuleset'>,
): ExplanationRow {
  return {
    outcome: decision.outcome, rejectionReason: decision.rejectionReason, reasonParams: { ...(decision.reason.params ?? {}) },
    floorMinor: decision.effectiveFloorMinor, ceilingMinor: decision.effectiveCeilingMinor, boundDeviationBp: decision.boundDeviationBp,
    currency: decision.currency, gateProfile: decision.gateProfile ?? null, sanityRuleset: decision.sanityRuleset ?? null,
    strategyId: intent.strategyId, strategyVersion: intent.strategyVersion, ruleCode: intent.ruleCode, trigger: intent.trigger, proposedMinor: intent.proposedMinor,
  };
}

/** Слепок со справочниками — полное объяснение для экрана; чего нет в справочниках — в gaps */
export function expandExplanation(e: DecisionExplanation, row: ExplanationRow, dict: ExplanationDictionary): { value: ExpandedExplanation; gaps: ExplanationGap[] } {
  const gaps: ExplanationGap[] = [];
  const expand = (r: ExplainedReason, config: Readonly<Record<string, Value>> = {}, fromStrategy: Readonly<Record<string, Value>> = {}): ExpandedReason => {
    const schema = paramSchema(r.code);
    const params: Record<string, Value> = { ...(r.params ?? {}) };
    // Обязательные ключи канала вырезаются всегда — список из реестра; необязательные и необъявленные — из слепка
    const withheld = new Set(r.withheld ?? []);
    for (const [k, spec] of Object.entries(schema ?? {})) {
      if ((spec.class === 'CHANNEL' || spec.class === 'CHANNEL_DERIVED') && !spec.optional && !Object.hasOwn(params, k)) withheld.add(k);
    }
    // Р-91: подрез в слепке не хранится; пока он есть у версии стратегии (18 месяцев после её замены) — берётся оттуда. В архиве его нет
    for (const [k, v] of Object.entries(fromStrategy)) {
      if (schema?.[k] && !Object.hasOwn(params, k)) {
        params[k] = v;
        withheld.delete(k);
      }
    }
    for (const [k, v] of Object.entries(config)) {
      if (schema?.[k]?.class === 'CONFIG' && !Object.hasOwn(params, k) && !withheld.has(k)) params[k] = v;
    }
    return { code: r.code, params, withheld: [...withheld].sort() };
  };

  let sanity: ExpandedExplanation['sanity'] = null;
  if (e.sanity) {
    const rulesetId = row.sanityRuleset ?? '';
    const rs = dict.rulesets.find((x): x is SanityRuleset => x.kind === 'SANITY' && x.rulesetId === rulesetId);
    if (!rs) gaps.push({ kind: 'SANITY_RULESET', ref: rulesetId || 'missing' });
    const cfg = (code: string) => rs?.definition.config[code] ?? {};
    const stored = new Map(e.sanity.checks.map((c) => [c.rule, c]));
    const rules = rs ? rs.definition.rules : e.sanity.checks.map((c) => c.rule);
    sanity = {
      ruleset: rulesetId,
      anchorsUsed: [...e.sanity.anchorsUsed],
      checks: rules.map((rule) => {
        const c = stored.get(rule);
        return c ? { rule, outcome: c.outcome, detail: c.detail ? expand(c.detail, cfg(c.detail.code)) : null } : { rule, outcome: 'PASS' as const, detail: null };
      }),
      warnings: (e.sanity.warnings ?? []).map((w) => expand(w, cfg(w.code))),
    };
  }

  const s = e.strategy;
  const def = row.strategyId === null ? null : dict.strategies.find((d) => d.strategyId === row.strategyId && d.version === row.strategyVersion) ?? null;
  if (row.strategyId !== null && !def) gaps.push({ kind: 'STRATEGY', ref: `${row.strategyId}@${row.strategyVersion}` });
  const undercut = (def?.params as { undercutMinor?: unknown } | undefined)?.undercutMinor;
  const fromStrategy: Record<string, Value> = typeof undercut === 'number' ? { undercutMinor: undercut } : {};
  const reason = expand(s.reason, {}, fromStrategy);
  const intentClass: IntentClass = s.intentClass ?? 'CHANGED';

  const profile = row.gateProfile === null ? undefined : dict.rulesets.find((x): x is GateProfile => x.kind === 'GATE' && x.rulesetId === row.gateProfile);
  const failed = e.gate?.failed ?? null;
  // Причина Gate — из столбцов решения: код отказа или итог; данные канала не показываются и здесь [Р-3]
  const gateReason = expand(explainedReason({ code: row.rejectionReason ?? (row.outcome === 'APPROVED' ? 'APPROVED' : 'NO_CHANGE'), params: row.reasonParams }, {},
    { competitorDerived: isCompetitorDerived(row.ruleCode) }));
  let checks: ExpandedExplanation['gate']['checks'];
  let notRun: string[] = [];
  let profileKnown = false;
  const failedCheck = () => (failed ? [{ check: failed.check, passed: false, detail: failed.detail ? expand(failed.detail) : null }] : []);
  if (!profile) {
    gaps.push({ kind: 'GATE_PROFILE', ref: row.gateProfile ?? 'missing' });
    checks = failedCheck();
  } else {
    const order = profile.definition[intentClass];
    const at = failed ? order.indexOf(failed.check) : order.length;
    if (at < 0) {
      gaps.push({ kind: 'GATE_PROFILE', ref: `${row.gateProfile}:${failed!.check}` });
      checks = failedCheck();
    } else {
      profileKnown = true;
      checks = [...order.slice(0, at).map((check) => ({ check, passed: true, detail: null })), ...failedCheck()];
      notRun = order.slice(at + (failed ? 1 : 0));
    }
  }

  return {
    value: {
      format: e.format,
      snapshot: e.snapshot ?? null,
      sanity,
      strategy: {
        strategyId: row.strategyId, version: row.strategyVersion, type: def?.params.type ?? null,
        params: def ? { ...(def.params as Record<string, Value>), deadbandMinor: def.deadbandMinor, currency: s.currency } : {},
        ruleCode: row.ruleCode, intentClass, trigger: row.trigger, currentMinor: s.currentMinor, proposedMinor: row.proposedMinor,
        boundsAtStrategy: { ...s.boundsAtStrategy }, currency: s.currency, reason,
        steps: s.chain ? s.chain.map((r) => expand(r, {}, fromStrategy)) : [...(s.steps ?? []).map((r) => expand(r, {}, fromStrategy)), reason],
      },
      gate: {
        profile: row.gateProfile, outcome: row.outcome, reason: gateReason, checks, notRun, profileKnown,
        floorMinor: row.floorMinor, ceilingMinor: row.ceilingMinor, minMarginBp: e.gate?.minMarginBp ?? null,
        boundDeviationBp: row.boundDeviationBp, currency: row.currency, fx: e.gate?.fx ?? null,
      },
      context: { channelHalt: e.context?.channelHalt ?? null, priceStop: e.context?.priceStop ?? null },
    },
    gaps,
  };
}


/**
 * Вечная запись решения — то, что ядро intent хранит вместе со слепком (price_decision_record_core): столбцы intent и итога
 * решения и сам слепок. Нужна проверке Р-85: из этой записи и справочника стратегий не должна выводиться цена конкурента.
 */
export function eternalCoreOf(
  intent: PriceIntentDraft,
  decision: PriceDecisionDraft,
  built: { explanation: DecisionExplanation; gateProfile: string; sanityRuleset: string | null },
): { columns: Record<string, Value | Params>; explanation: DecisionExplanation } {
  // Как price_decision_record_core (0052): у отклонённой цены из данных конкурентов нет предложенной цены и отклонения [Р-85]
  const hidden = isCompetitorDerived(intent.ruleCode) && decision.decisionClass === 'REJECTED_BY_GATE';
  const reasonParams = Object.fromEntries(Object.entries(decision.reason.params ?? {}).filter(([k]) => !(hidden && COMPETITOR_RULE_DERIVED_KEYS.includes(k))));
  return {
    columns: {
      strategyId: intent.strategyId, strategyVersion: intent.strategyVersion, ruleCode: intent.ruleCode, trigger: intent.trigger.type,
      proposedMinor: hidden ? null : intent.proposedMinor, currency: decision.currency, outcome: decision.outcome, finalMinor: decision.finalMinor,
      floorMinor: decision.effectiveFloorMinor, ceilingMinor: decision.effectiveCeilingMinor, rejectionReason: decision.rejectionReason,
      reasonParams, boundDeviationBp: hidden ? null : decision.boundDeviationBp, dangerous: decision.boundDeviationBp !== null && decision.boundDeviationBp > 1000,
      gateProfile: built.gateProfile, sanityRuleset: built.sanityRuleset,
    },
    explanation: built.explanation,
  };
}

/** Все ключи слепка класса CHANNEL — должен быть пуст (проверка слепка в тестах и триггер БД) */
export function channelKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => channelKeysIn(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    (k !== 'withheld' && CHANNEL_KEYS.has(k) ? [`${path}.${k}`] : []).concat(k === 'withheld' ? [] : channelKeysIn(v, `${path}.${k}`)));
}
