import type { DecisionExplanation } from './explanation.ts';
import type { FxApplied } from './fx.ts';
import type { CompetitorSnapshot, Instant, PriceBasis } from '@repracer/channel-port';
import type { DispatchReasonCode, EngineReasonCode, GateReasonCode, PipelineReasonCode, SanityNoteCode, SanityReasonCode, SanityWarningCode } from './reasons.ts';

/**
 * Общие типы пути решения о цене: проверка входов (Р-42) → движок стратегий → Price Gate (Р-43, Р-44).
 * Пакеты слоёв не зависят друг от друга, только от этих типов: Gate остаётся независимой проверкой движка.
 * Деньги — целые минимальные единицы (INV-06).
 */

/** Структурированная причина: код из реестра reasons.ts и параметры для объяснения */
export interface Reason<C extends string = ReasonCode> {
  code: C;
  params: Readonly<Record<string, string | number | boolean | null>>;
}

/** Итог одного правила проверки входов: код правила и пояснение кодом с параметрами [Р-72] */
export interface SanityCheckRecord {
  rule: string;
  outcome: 'PASS' | 'FAIL' | 'SKIPPED';
  detail?: Reason<SanityNoteCode | SanityReasonCode | SanityWarningCode>;
}

export type ReasonCode = SanityReasonCode | SanityWarningCode | EngineReasonCode | GateReasonCode | PipelineReasonCode | DispatchReasonCode;

/**
 * Правила, цена которых выведена из данных конкурентов. Остановка канала блокирует только их [Р-51];
 * совпадает с генерируемым столбцом channel_data.price_intent.competitor_derived (0032).
 */
export const COMPETITOR_DERIVED_RULES: ReadonlySet<string> = new Set(['MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION']);

export function isCompetitorDerived(ruleCode: string): boolean {
  return COMPETITOR_DERIVED_RULES.has(ruleCode);
}

// ---------------------------------------------------------------------------
// Принятый снимок
// ---------------------------------------------------------------------------

declare const acceptedBrand: unique symbol;

/**
 * Снимок, прошедший проверку входов. Движок принимает только этот тип: испорченный снимок не может попасть
 * в стратегию без явного обхода системы типов. Создаётся только в @repracer/input-sanity.
 */
export type AcceptedSnapshot = CompetitorSnapshot & {
  readonly [acceptedBrand]: 'INPUT_SANITY_ACCEPTED';
  readonly sanityRuleset: string;
};

/** Только для @repracer/input-sanity: пометить снимок принятым после всех проверок */
export function markAcceptedBySanity(snapshot: CompetitorSnapshot, ruleset: string): AcceptedSnapshot {
  return { ...snapshot, sanityRuleset: ruleset } as AcceptedSnapshot;
}

// ---------------------------------------------------------------------------
// Границы цены [Р-5, Р-18, Р-43]
// ---------------------------------------------------------------------------

export type BoundResolution =
  | { status: 'RESOLVED'; amountMinor: number; sourceIds: string[] }
  | {
      status: 'UNRESOLVABLE';
      cause: 'MISSING' | 'CURRENCY_MISMATCH' | 'BASIS_MISMATCH' | 'INVALID_AMOUNT';
      /** Валюта и база границы, если она есть, но в другой валюте или базе — для объяснения (шаг 12) */
      actualCurrency?: string;
      actualBasis?: PriceBasis;
    };

/** Абсолютные границы единицы записи: максимум активных min_price и минимум активных max_price по уровням товара и единицы */
export interface PriceBounds {
  currency: string;
  basis: PriceBasis;
  min: BoundResolution;
  max: BoundResolution;
}

// ---------------------------------------------------------------------------
// Себестоимость и комиссии (на единицу товара, в валюте единицы записи)
// ---------------------------------------------------------------------------

export interface CostInputs {
  currency: string;
  costProfileId: string;
  /** Закупка, логистика, упаковка, обработка, доставка покупателю, прочее */
  unitCostMinor: number;
  /** Фиксированная комиссия канала на продажу (тарифная таблица, Р-32) */
  fixedFeeMinor: number;
  /** Комиссия канала от цены витрины, базисные пункты */
  feeRateBp: number;
  /** Налоговый режим цены витрины единицы записи [Р-58] */
  tax: TaxTreatment;
  /** Себестоимость в другой валюте переведена по курсу ЕЦБ [Р-61]; null или нет — уже в валюте единицы записи */
  fx?: FxApplied | null;
}

/** ЕС — цена витрины с НДС (брутто); США — цена без налога с продаж (нетто), налог добавляется при покупке [Р-58] */
export type TaxRegime = 'VAT_INCLUDED' | 'SALES_TAX_EXCLUDED';

export type TaxTreatment =
  /** vatRateBp: null — ставка не известна: маржа не вычисляется, fail-closed */
  | { regime: 'VAT_INCLUDED'; vatRateBp: number | null }
  | { regime: 'SALES_TAX_EXCLUDED' };

// ---------------------------------------------------------------------------
// Стратегии [Р-39, ADR-0007]
// ---------------------------------------------------------------------------

export type CompletenessKind = 'TOP_N' | 'CHEAPEST_ONLY' | 'FULL';

/** Требуемая стратегией полнота конкурентных данных */
export interface CompetitorRequirement {
  /** null — стратегии конкуренты не нужны */
  kind: CompletenessKind | null;
  minN?: number;
  needsBuyboxWinner: boolean;
  needsOwnRank: boolean;
  needsShipping: boolean;
  conditions: string[];
  maxStalenessSeconds: number | null;
}

export type StrategyParams =
  | { type: 'FIXED'; priceMinor: number }
  | { type: 'TARGET_MARGIN'; targetMarginBp: number }
  | {
      type: 'MATCH_BUYBOX';
      /** 0 — сравняться, > 0 — встать дешевле на столько центов */
      undercutMinor: number;
      /** Уже выигрываем Buy Box — цену не трогаем */
      holdWhenWinning: boolean;
      /** Цель вне границ: CAP — встать на границу, HOLD — не менять цену */
      atBound: 'CAP' | 'HOLD';
    }
  | {
      type: 'BEAT_LOWEST';
      undercutMinor: number;
      /** VISIBLE_TOP_N — минимум среди видимых N предложений; MARKET — минимум рынка (нужен CHEAPEST_ONLY или FULL) */
      scope: 'VISIBLE_TOP_N' | 'MARKET';
      /** Сравнивать цену с доставкой */
      compareLanded: boolean;
      atBound: 'CAP' | 'HOLD';
    };

export type StrategyType = StrategyParams['type'];

export interface StrategyDefinition {
  strategyId: string;
  version: number;
  params: StrategyParams;
  /** Изменение меньше этого — не меняем цену (NO_OP) */
  deadbandMinor: number;
}

// ---------------------------------------------------------------------------
// Intent и решение
// ---------------------------------------------------------------------------

export type TriggerType = 'COMPETITOR_CHANGE' | 'COST_CHANGE' | 'STOCK_CHANGE' | 'SCHEDULE' | 'MANUAL' | 'DIVERGENCE_REASSERT';

export type IntentClass = 'CHANGED' | 'NO_OP';

export interface PriceIntentDraft {
  writeScopeId: string;
  strategyId: string | null;
  strategyVersion: number | null;
  trigger: { type: TriggerType; sourceEventId?: string };
  /** Код правила (channel_data.price_intent.rule_code) */
  ruleCode: string;
  intentClass: IntentClass;
  proposedMinor: number;
  currentMinor: number | null;
  /** Опорное значение входа: цена Buy Box, минимум, себестоимость */
  referenceMinor: number | null;
  currency: string;
  basis: PriceBasis;
  /** Главная причина */
  reason: Reason;
  /** Цепочка шагов расчёта для экрана «почему такая цена» */
  explanation: Reason[];
  inputs: {
    snapshotSourceEventId?: string;
    snapshotObservedAt?: Instant;
    snapshotSource?: string;
    costProfileId?: string;
    boundsAtStrategy: { minMinor: number; maxMinor: number };
  };
  createdAt: Instant;
  expiresAt: Instant;
}

export type GateOutcome = 'APPROVED' | 'REJECTED' | 'HELD' | 'NO_CHANGE';

/** Класс intent по итогу Gate (channel_data.price_decision.intent_class, Р-27) */
export type DecisionClass = 'CHANGED' | 'REJECTED_BY_GATE' | 'NO_OP';

export type GateRejectionReason = Extract<GateReasonCode,
  | 'BELOW_MIN_PRICE' | 'BELOW_MARGIN_FLOOR' | 'ABOVE_MAX_PRICE' | 'BOUND_UNRESOLVABLE' | 'STEP_LIMIT' | 'CHANGE_RATE_LIMIT'
  | 'INTENT_EXPIRED' | 'INTENT_INVALID' | 'SCOPE_NOT_ACTIVE' | 'CHANNEL_HALTED' | 'PRICING_STOPPED' | 'INTERNAL_BOUND_VIOLATION'>;

export interface GateCheck {
  check: string;
  passed: boolean;
  detail: Reason | null;
}

export interface PriceDecisionDraft {
  writeScopeId: string;
  outcome: GateOutcome;
  decisionClass: DecisionClass;
  finalMinor: number | null;
  currency: string;
  basis: PriceBasis;
  effectiveFloorMinor: number | null;
  effectiveCeilingMinor: number | null;
  minPriceIds: string[];
  maxPriceIds: string[];
  guardrailIds: string[];
  rejectionReason: GateRejectionReason | null;
  reason: Reason;
  checks: GateCheck[];
  alert: { code: string; severity: 'WARNING' | 'CRITICAL' } | null;
  decidedAt: Instant;
  /** Курс, по которому себестоимость переведена в валюту цены, — хранится вместе с решением [Р-61] */
  fx?: FxApplied | null;
  /** Отклонение предложенной цены от нарушенной границы, базисные пункты; опасно > 10 % [Р-73] */
  boundDeviationBp: number | null;
  /** Неизменяемый слепок объяснения [Р-68]; собирает путь решения после Gate; у решения NO_OP его нет [Р-74] */
  explanation?: DecisionExplanation | null;
  /** Код причины решения NO_OP — единственное, что от него остаётся [Р-74] */
  noChangeReason?: string | null;
  /** Профиль Gate и набор правил проверки входов слепка — столбцы решения со ссылкой на справочник [Р-75, Р-80] */
  gateProfile?: string | null;
  sanityRuleset?: string | null;
}
