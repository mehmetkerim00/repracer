/**
 * Строки PostgreSQL → строки аналитического слоя (schemas/clickhouse 010–050). Чистые функции.
 * Классы intent [Р-27]: CHANGED и REJECTED_BY_GATE — целиком в price_intent и price_decision; NO_OP — одной строкой
 * в price_intent_noop (intent и итог решения), дальше только почасовой агрегат.
 * JSON-поля (входы, обоснование, параметры причины, проверки, курс) — строками: схема параметров открыта.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PgRow = Record<string, any>;

const iso = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const json = (v: unknown, empty: string): string => (v === null || v === undefined ? empty : typeof v === 'string' ? v : JSON.stringify(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const day = (v: unknown): string | null => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export type IntentClass = 'CHANGED' | 'REJECTED_BY_GATE' | 'NO_OP';

/** Класс intent — по решению (generated-столбец price_decision.intent_class); без решения — по обоснованию intent */
export function intentClassOf(intent: PgRow, decision: PgRow | undefined): IntentClass {
  const c = decision?.intent_class ?? intent.rationale?.intentClass;
  if (c === 'CHANGED' || c === 'REJECTED_BY_GATE' || c === 'NO_OP') return c;
  throw new Error(`price_intent ${intent.price_intent_id}: unknown intent class ${String(c)}`);
}

export function priceIntentRow(intent: PgRow, intentClass: Exclude<IntentClass, 'NO_OP'>): PgRow {
  const reason = intent.rationale?.reason ?? {};
  return {
    tenant_id: intent.tenant_id,
    price_intent_id: intent.price_intent_id,
    created_at: iso(intent.created_at),
    write_scope_id: intent.write_scope_id,
    pricing_strategy_id: intent.pricing_strategy_id ?? null,
    pricing_strategy_version: num(intent.pricing_strategy_version),
    trigger_type: intent.trigger_type,
    intent_class: intentClass,
    rule_code: intent.rule_code ?? null,
    reason_code: reason.code ?? '',
    reason_params: json(reason.params, '{}'),
    source_event_id: intent.source_event_id ?? null,
    competitor_snapshot_id: intent.competitor_snapshot_id ?? null,
    proposed_amount_minor: num(intent.proposed_amount_minor),
    reference_amount_minor: num(intent.reference_amount_minor),
    currency: intent.currency,
    price_basis: intent.price_basis,
    inputs: json(intent.inputs, '{}'),
    rationale: json(intent.rationale, '{}'),
    expires_at: iso(intent.expires_at),
  };
}

/**
 * NO_OP одной строкой с кодом причины [Р-81]: через 7 дней остаётся только почасовой агрегат, и без кода в его ключе вопрос
 * «почему цена не менялась» остался бы без ответа навсегда. Код — из решения (no_change_reason, Р-74), без решения — из intent.
 */
export function priceIntentNoopRow(intent: PgRow, decision: PgRow | undefined): PgRow {
  const reason = decision?.no_change_reason ?? intent.rationale?.reason?.code;
  if (typeof reason !== 'string' || reason === '') throw new Error(`price_intent ${intent.price_intent_id}: a NO_OP intent without a reason code (Р-81)`);
  return {
    tenant_id: intent.tenant_id,
    price_intent_id: intent.price_intent_id,
    created_at: iso(intent.created_at),
    write_scope_id: intent.write_scope_id,
    trigger_type: intent.trigger_type,
    rule_code: intent.rule_code ?? '',
    no_change_reason: reason,
    proposed_amount_minor: num(intent.proposed_amount_minor),
    reference_amount_minor: num(intent.reference_amount_minor),
    decision_outcome: decision?.outcome ?? 'NO_DECISION',
    currency: intent.currency,
    price_basis: intent.price_basis,
  };
}

export function priceDecisionRow(decision: PgRow): PgRow {
  const fx = decision.fx ?? null;
  return {
    tenant_id: decision.tenant_id,
    price_decision_id: decision.price_decision_id,
    intent_created_at: iso(decision.intent_created_at),
    price_intent_id: decision.price_intent_id,
    write_scope_id: decision.write_scope_id,
    decided_at: iso(decision.decided_at),
    outcome: decision.outcome,
    intent_class: decision.intent_class,
    rejection_reason: decision.rejection_reason ?? null,
    // В PostgreSQL код причины одобрения не хранится отдельно: он совпадает с исходом решения
    reason_code: decision.rejection_reason ?? decision.outcome,
    reason_params: json(decision.reason_params, '{}'),
    final_amount_minor: num(decision.final_amount_minor),
    currency: decision.currency,
    price_basis: decision.price_basis,
    effective_floor_minor: num(decision.effective_floor_minor),
    effective_ceiling_minor: num(decision.effective_ceiling_minor),
    min_price_ids: decision.min_price_ids ?? [],
    max_price_ids: decision.max_price_ids ?? [],
    guardrail_ids: decision.guardrail_ids ?? [],
    cost_profile_id: decision.cost_profile_id ?? null,
    fee_inputs: json(decision.fee_inputs, '{}'),
    fx: fx === null ? null : json(fx, 'null'),
    fx_rate_date: fx === null ? null : day(fx.rateDate),
    fx_from: fx === null ? null : fx.from,
    violations: decision.violations ?? [],
    checks: json(decision.checks, '[]'),
  };
}

export function completedWriteRow(write: PgRow): PgRow {
  return {
    tenant_id: write.tenant_id,
    channel_write_id: write.channel_write_id,
    finished_at: iso(write.finished_at),
    write_scope_id: write.write_scope_id,
    field: write.field,
    amount_minor: num(write.amount_minor),
    currency: write.currency ?? null,
    price_basis: write.price_basis ?? null,
    quantity: num(write.quantity),
    version: num(write.version),
    origin: write.origin,
    price_decision_id: write.price_decision_id ?? null,
    direction: write.direction ?? null,
    final_status: write.final_status,
    end_reason: write.end_reason ?? null,
    end_params: write.end_params === null || write.end_params === undefined ? null : json(write.end_params, '{}'),
    superseded_by_write_id: write.superseded_by_write_id ?? null,
    last_error_code: write.last_error_code ?? null,
    attempt_count: num(write.attempt_count),
    budget_scope_key: write.budget_scope_key ?? null,
    budget_day: day(write.budget_day),
    floor_at_dispatch_minor: num(write.floor_at_dispatch_minor),
    trigger_received_at: iso(write.trigger_received_at),
    created_at: iso(write.created_at),
    dispatched_at: iso(write.dispatched_at),
    accepted_at: iso(write.accepted_at),
    applied_at: iso(write.applied_at),
  };
}
