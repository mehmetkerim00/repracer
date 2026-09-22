import type { ExplanationRuleset as DictionaryRuleset } from '@repracer/pricing-model';
import {
  floorCauseFromDatabase, convertMinor, type FxQuote } from '@repracer/pricing-model';
import { DEFAULT_RETRY_POLICY } from '@repracer/write-dispatcher';
import {
  rotation, type BulkJobArtifact, type BulkJobCreated, type BulkJobInput, type BulkJobOutcome, type BulkJobProgress, type BulkJobRow,
} from '@repracer/pricing-pipeline';
import { offerIdentityOf, type CompetitorQuery, type CompetitorSnapshot, type FieldWrite, type Instant, type PricingHealthObservation, type WriteOutcome } from '@repracer/channel-port';
import type { CrossChannelReference, DailyRange } from '@repracer/input-sanity';
import type { GuardrailSet } from '@repracer/price-gate';
import type { OmnibusPriorPrice } from '@repracer/pricing-model';
import type { AcceptedSnapshot, BoundResolution, CostInputs, DistrustRef, HaltRef, PriceBounds, PriceIntentDraft, Reason, StopRef, StrategyDefinition } from '@repracer/pricing-model';
import { randomUUID } from 'node:crypto';
import type {
  AdminActor,
  BoundsEditInput,
  BoundsEditResult,
  BoundsEditRow,
  StrategySaveInput,
  StrategySaveResult,
  BoundsRead,
  CommittedDecision,
  CostImportBatch,
  CostImportResult,
  ConsoleDecisionRow,
  ConsoleScopeRow,
  ConsoleState,
  ConsoleStopRow,
  StopRecord,
  StopRelease,
  StopResult,
  StoredSnapshotRef,
  DecisionToCommit,
  DispatchRecorded,
  EvaluationCommit,
  EvaluationCommitResult,
  EvaluationContext,
  HaltInfo,
  HaltRecord,
  NotificationLossCheck,
  NotificationLossVerdict,
  PollCandidate,
  HaltReviewRecord, HaltSampleObservation, HaltSampleReview,
  PriceScopeContext,
  PricingStore,
  ProductKey,
  ScopeEvaluationContext,
  ShiftWindow,
  SnapshotOutcome, ConsoleAuditRow, ConsoleIntentRow, ConsoleWriteRow, ConsoleRejectedSnapshotRow, DecisionPageQuery, DecisionPage, DecisionDetail, ScopeDecisionStats, InterventionSlice, FeedPageQuery, FeedPage, FeedPageItem, FeedStatusGroup, WorldCounters, ConsoleDistrustRow, ConsoleStrategyVersionRow, DiscountAnnouncementInput, DiscountAnnouncementRow, DiscountAnnounceResult, PriceEvidenceDay, StrategyAssignInput, StrategyUnassignInput, StrategyUnassignResult, ConsoleOfferChannelPricingRow, ConsolePricingHealthRow, InboundNotificationEntry, OfferChannelPricingObservation, OnboardingProgressRow, OnboardingProgressInput, OnboardingStepStatus, ChannelAccountRow} from '@repracer/pricing-pipeline';
import { FEED_IN_FLIGHT_STATUSES, FEED_NOT_SENT_STATUSES } from '@repracer/pricing-pipeline';
import { inTenant, RollbackWith, type PgPool, type Tx } from './db.ts';
import { PgWriteQueueStore } from './write-queue.ts';

/**
 * PricingStore на реальной схеме. Инварианты — в БД: RLS с FORCE, append-only, монотонность версий,
 * отложенная проверка границ, проверки при отправке. Хранилище их не дублирует, а переводит ошибки БД в причины.
 *
 * Р-59: оценка снимка — одно чтение контекста (одна транзакция, один запрос), одна транзакция фиксации и итог отправки.
 * Состояние предложения в схеме — канонический верхний регистр (offer_mapping.condition DEFAULT 'NEW'),
 * в порте канала — код канала в нижнем регистре.
 */

type Row = Record<string, any>;

export interface PgPricingStoreOptions {
  /**
   * Р-90: пул административного сервиса (роль repracer_admin) — остановки человеком и ручное снятие системной остановки.
   * Без него эти действия недоступны: путь решения работает ролью repracer_app, у которой прав на них нет.
   */
  adminPool?: PgPool;
  /**
   * Р-90, Р-139: пул фонового исполнителя массовых операций (роль repracer_bulk_worker) — аренда, ход и итог задания. Отдельная
   * роль, потому что это записи МАШИНЫ: ход меняется раз в секунду, и человека за ним нет. Создаёт задание административная
   * роль — от имени человека и в аудите.
   */
  bulkWorkerPool?: PgPool;
  /**
   * Только для замера шага 9: окно сдвига из журнала движений (DISTINCT ON по competitor_move, как в шаге 8)
   * вместо проекции competitor_move_latest [OQ-93]. В работе — projection.
   */
  shiftWindowSource?: 'projection' | 'move_log';
}

const dbCondition = (c: string) => c.toUpperCase();
const portCondition = (c: string) => c.toLowerCase();
const iso = (v: string) => new Date(v).toISOString();

const COMPETITOR_RULES = ['MATCH_BUYBOX', 'BEAT_LOWEST', 'POSITION'];

/**
 * Строки единицы записи цены: предложение, единица, товар, версии записи, стратегия.
 * Р-91: подрез стратегии — из channel_data.pricing_strategy_undercut (18 месяцев после замены версии), не из вечной версии стратегии
 */
const SCOPE_COLUMNS = `
  s.write_scope_id, s.product_id, s.channel_account_id, s.channel, m.marketplace, m.region, m.external_unit_id, m.external_sku, m.external_listing_id, m.channel_product_ref, m.condition,
  s.scope_key, p.gtin, s.currency, s.price_basis, s.tax_regime, s.pricing_mode, s.status, s.pricing_strategy_id, s.pricing_strategy_version, s.created_at,
  CASE WHEN ud.undercut_minor IS NULL THEN ps.params ELSE ps.params || jsonb_build_object('undercutMinor', ud.undercut_minor) END AS strategy_params,
  ss.latest_version_accepted, ss.last_sent_amount_minor`;

const SCOPE_FROM = `
    FROM tenant_data.offer_mapping m
    JOIN tenant_data.write_scope s
      ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id AND s.field = 'PRICE' AND s.status <> 'RETIRED'
    JOIN tenant_data.product p ON p.tenant_id = s.tenant_id AND p.product_id = s.product_id
    JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
    LEFT JOIN tenant_data.pricing_strategy ps
      ON ps.tenant_id = s.tenant_id AND ps.pricing_strategy_id = s.pricing_strategy_id AND ps.version = s.pricing_strategy_version
    LEFT JOIN channel_data.pricing_strategy_undercut ud
      ON ud.tenant_id = ps.tenant_id AND ud.pricing_strategy_id = ps.pricing_strategy_id AND ud.version = ps.version
   WHERE m.tenant_id = $1 AND m.status <> 'ENDED'`;

/** Последние версии границ на обоих уровнях — как tenant_data.effective_min_price / effective_max_price; alias sc */
const BOUNDS_ROWS = `
  SELECT coalesce(json_agg(b), '[]') FROM (
    (SELECT 'min' AS bound, 'WRITE_SCOPE' AS level, x.min_price_id AS id, x.amount_minor, x.is_active FROM tenant_data.min_price x
      WHERE x.tenant_id = $1 AND x.scope_type = 'WRITE_SCOPE' AND x.write_scope_id = sc.write_scope_id ORDER BY x.version DESC LIMIT 1)
    UNION ALL
    (SELECT 'min', 'PRODUCT', x.min_price_id, x.amount_minor, x.is_active FROM tenant_data.min_price x
      WHERE x.tenant_id = $1 AND x.scope_type = 'PRODUCT' AND x.product_id = sc.product_id AND x.currency = sc.currency AND x.price_basis = sc.price_basis
      ORDER BY x.version DESC LIMIT 1)
    UNION ALL
    (SELECT 'max', 'WRITE_SCOPE', x.max_price_id, x.amount_minor, x.is_active FROM tenant_data.max_price x
      WHERE x.tenant_id = $1 AND x.scope_type = 'WRITE_SCOPE' AND x.write_scope_id = sc.write_scope_id ORDER BY x.version DESC LIMIT 1)
    UNION ALL
    (SELECT 'max', 'PRODUCT', x.max_price_id, x.amount_minor, x.is_active FROM tenant_data.max_price x
      WHERE x.tenant_id = $1 AND x.scope_type = 'PRODUCT' AND x.product_id = sc.product_id AND x.currency = sc.currency AND x.price_basis = sc.price_basis
      ORDER BY x.version DESC LIMIT 1)
  ) b`;

const HALT_WHERE = `
    FROM channel_data.pricing_halt h
   WHERE h.tenant_id = $1 AND h.channel_account_id = sc.channel_account_id AND h.released_at IS NULL
     AND (h.marketplace IS NULL OR h.marketplace = sc.marketplace)
   LIMIT 1`;
const ACTIVE_HALT = `SELECT h.pricing_halt_id ${HALT_WHERE}`;
const ACTIVE_HALT_JSON = `SELECT json_build_object('haltId', h.pricing_halt_id, 'reasonCode', h.reason_code, 'marketplace', h.marketplace, 'haltedAt', h.halted_at) ${HALT_WHERE}`;

/** Остановка по недоверию каналу [Р-118]: все цены; как channel_data.channel_distrust_for (0082) */
const DISTRUST_WHERE = `
    FROM channel_data.channel_distrust d
   WHERE d.tenant_id = $1 AND d.channel_account_id = sc.channel_account_id AND d.released_at IS NULL
     AND (d.marketplace IS NULL OR d.marketplace = sc.marketplace)
   ORDER BY d.detected_at
   LIMIT 1`;
const ACTIVE_DISTRUST = `SELECT d.channel_distrust_id ${DISTRUST_WHERE}`;
const ACTIVE_DISTRUST_JSON = `SELECT json_build_object('distrustId', d.channel_distrust_id, 'reasonCode', d.reason_code, 'marketplace', d.marketplace, 'detectedAt', d.detected_at) ${DISTRUST_WHERE}`;

/** Остановка человеком [Р-69, Р-70]: тенант — на любой аккаунт; аккаунт; витрина */
const STOP_WHERE = `
    FROM tenant_data.price_stop st
   WHERE st.tenant_id = $1 AND st.released_at IS NULL
     AND (st.scope_type = 'TENANT'
          OR (st.channel_account_id = sc.channel_account_id AND (st.scope_type = 'CHANNEL_ACCOUNT' OR st.marketplace = sc.marketplace)))
   ORDER BY CASE st.scope_type WHEN 'TENANT' THEN 0 WHEN 'CHANNEL_ACCOUNT' THEN 1 ELSE 2 END
   LIMIT 1`;
const ACTIVE_STOP = `SELECT st.price_stop_id ${STOP_WHERE}`;
const ACTIVE_STOP_JSON = `SELECT json_build_object('stopId', st.price_stop_id, 'scope', st.scope_type, 'channelAccountId', st.channel_account_id,
  'marketplace', st.marketplace, 'stoppedAt', st.stopped_at, 'stoppedBy', st.stopped_by_membership_id) ${STOP_WHERE}`;

/**
 * Контекст решения по единице записи; $1 — тенант, $2 — момент оценки.
 * Подзапросы по price_history ограничены тенантом и временем константами: секции месяц × hash отсекаются
 * при планировании (в шаге 8 условие соединения по tenant_id давало 24 мс планирования на 0,4 мс исполнения).
 */
/**
 * Р-154 (шаг 35): потоки консоли — решения, намерения, записи, отклонённые снимки, аудит — читаются НЕ целиком, а страницей,
 * окном или агрегатом. Столбцы и отображения строк общие для всех запросов, чтобы страница и окно не разошлись по форме.
 */
const INTENT_COLUMNS = `price_intent_id, created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version, trigger_type, source_event_id,
  proposed_amount_minor, currency, price_basis, inputs, rationale, expires_at, rule_code, reference_amount_minor`;
const DECISION_COLUMNS = `d.*, ref.competitor_snapshot_id, ref.source AS ref_source, ref.observed_at AS ref_observed_at`;
const DECISION_FROM = `FROM channel_data.price_decision d
  LEFT JOIN channel_data.price_decision_snapshot_ref ref ON ref.tenant_id = d.tenant_id AND ref.price_decision_id = d.price_decision_id`;
const WRITE_HOT_COLUMNS = `w.channel_write_id, w.write_scope_id, w.price_decision_id, w.amount_minor, w.currency, w.price_basis, w.version, w.status,
  w.attempt_count, w.created_at, w.dispatched_at, w.accepted_at, w.next_attempt_at, w.last_error_code, w.end_reason, w.end_params,
  w.superseded_by_write_id, coalesce(d.competitor_derived, false) AS competitor_derived`;
const WRITE_HISTORY_COLUMNS = `h.channel_write_id, h.write_scope_id, h.price_decision_id, h.amount_minor, h.currency, h.price_basis, h.version, h.final_status AS status,
  h.attempt_count, h.created_at, h.dispatched_at, h.accepted_at, NULL::timestamptz AS next_attempt_at, h.last_error_code, h.end_reason, h.end_params,
  h.superseded_by_write_id, coalesce(d.competitor_derived, false) AS competitor_derived`;
/** Момент записи для ленты: применена → отправлена → создана; по нему же построен индекс истории (0117) */
const WRITE_AT = (alias: string) => `coalesce(${alias}.accepted_at, ${alias}.dispatched_at, ${alias}.created_at)`;

function intentRow(r: Row): ConsoleIntentRow {
  return {
    intentId: r.price_intent_id, writeScopeId: r.write_scope_id, strategyId: r.pricing_strategy_id, strategyVersion: r.pricing_strategy_version,
    trigger: { type: r.trigger_type, ...(r.source_event_id ? { sourceEventId: r.source_event_id } : {}) }, ruleCode: r.rule_code,
    intentClass: r.rationale.intentClass, proposedMinor: r.proposed_amount_minor, currentMinor: r.rationale.currentMinor ?? null,
    referenceMinor: r.reference_amount_minor, currency: r.currency, basis: r.price_basis, reason: r.rationale.reason, explanation: r.rationale.explanation ?? [],
    inputs: r.inputs, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at),
  } as PriceIntentDraft & { intentId: string };
}

function decisionRow(r: Row): ConsoleDecisionRow {
  return {
    decisionId: r.price_decision_id, intentId: r.price_intent_id, writeScopeId: r.write_scope_id, outcome: r.outcome,
    decisionClass: r.intent_class === 'NO_OP' ? 'NO_OP' : r.intent_class, finalMinor: r.final_amount_minor, currency: r.currency, basis: r.price_basis,
    effectiveFloorMinor: r.effective_floor_minor, effectiveCeilingMinor: r.effective_ceiling_minor, minPriceIds: r.min_price_ids, maxPriceIds: r.max_price_ids,
    guardrailIds: r.guardrail_ids, rejectionReason: r.rejection_reason,
    reason: { code: r.rejection_reason ?? (r.outcome === 'APPROVED' ? 'APPROVED' : 'NO_CHANGE'), params: r.reason_params },
    checks: r.checks, alert: null, decidedAt: iso(r.decided_at), fx: r.fx, boundDeviationBp: r.bound_deviation_bp ?? null, explanation: r.explanation,
    noChangeReason: r.no_change_reason ?? null, gateProfile: r.gate_profile ?? null, sanityRuleset: r.sanity_ruleset ?? null,
    strategyId: r.pricing_strategy_id ?? null, strategyVersion: r.pricing_strategy_version ?? null, ruleCode: r.rule_code, trigger: r.trigger_type,
    proposedMinor: r.proposed_amount_minor,
    snapshotRef: r.competitor_snapshot_id ? { competitorSnapshotId: r.competitor_snapshot_id, source: r.ref_source, observedAt: iso(r.ref_observed_at) } : null,
  };
}

function writeRow(r: Row): ConsoleWriteRow {
  return {
    channelWriteId: r.channel_write_id, writeScopeId: r.write_scope_id, decisionId: r.price_decision_id, amountMinor: r.amount_minor, currency: r.currency,
    basis: r.price_basis, version: r.version, status: r.status, attemptCount: r.attempt_count, competitorDerived: r.competitor_derived, createdAt: iso(r.created_at),
    dispatchedAt: r.dispatched_at ? iso(r.dispatched_at) : null, acceptedAt: r.accepted_at ? iso(r.accepted_at) : null,
    nextAttemptAt: r.next_attempt_at ? iso(r.next_attempt_at) : null, lastErrorCode: r.last_error_code, endReason: r.end_reason,
    endParams: r.end_params ?? {}, supersededByWriteId: r.superseded_by_write_id,
  };
}

function rejectedSnapshotRow(r: Row): ConsoleRejectedSnapshotRow {
  return {
    rejectedSnapshotId: r.rejected_snapshot_id,
    key: { channelAccountId: r.channel_account_id, marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: portCondition(r.condition) },
    source: r.source, ...(r.source_event_id ? { sourceEventId: r.source_event_id } : {}), observedAt: iso(r.observed_at), receivedAt: iso(r.received_at),
    verdict: r.verdict, reasonCode: r.reason_code, alarmClass: r.alarm_class, details: r.details, ruleset: r.ruleset_version,
  };
}

function auditRow(r: Row): ConsoleAuditRow {
  return {
    at: new Date(r.changes.at).toISOString(), action: r.action, actorType: r.actor_type, membershipId: r.actor_membership_id, role: r.changes.role ?? null,
    entityType: r.entity_type, entityId: r.entity_id, scope: r.changes.scope ?? null, channelAccountId: r.changes.channelAccountId ?? null,
    marketplace: r.changes.marketplace ?? null, note: r.changes.note ?? null,
  };
}

const SCOPE_JSON = `json_build_object(
  'row', row_to_json(sc),
  'observed', (SELECT o.observed_amount_minor FROM channel_data.observed_channel_state o
                WHERE o.tenant_id = $1 AND o.write_scope_id = sc.write_scope_id AND o.field = 'PRICE'),
  'recent', ARRAY(SELECT h.amount_minor FROM tenant_data.price_history h
                   WHERE h.tenant_id = $1 AND h.write_scope_id = sc.write_scope_id
                     AND h.accepted_at > $2::timestamptz - interval '7 days' AND h.accepted_at <= $2::timestamptz
                   ORDER BY h.accepted_at DESC LIMIT 3),
  'inFlight', ARRAY(SELECT w.amount_minor FROM tenant_data.channel_write w
                     WHERE w.tenant_id = $1 AND w.write_scope_id = sc.write_scope_id AND w.field = 'PRICE'
                       AND w.status IN ('DISPATCHED', 'ACCEPTED', 'FAILED')),
  -- Р-154: последняя применённая цена — по индексу единицы и времени, а не перебором всех записей тенанта
  'lastApplied', (SELECT json_build_object('amountMinor', h.amount_minor, 'acceptedAt', h.accepted_at) FROM tenant_data.price_history h
                   WHERE h.tenant_id = $1 AND h.write_scope_id = sc.write_scope_id AND h.corrects_price_history_id IS NULL
                   ORDER BY h.accepted_at DESC, h.price_history_id DESC LIMIT 1),
  'changes', (SELECT count(*) FROM tenant_data.price_history h
               WHERE h.tenant_id = $1 AND h.write_scope_id = sc.write_scope_id AND h.corrects_price_history_id IS NULL
                 AND h.accepted_at >= $2::timestamptz - interval '1 hour' AND h.accepted_at <= $2::timestamptz),
  'bounds', (${BOUNDS_ROWS}),
  'halt', (${ACTIVE_HALT_JSON}),
  'distrust', (${ACTIVE_DISTRUST_JSON}),
  'stop', (${ACTIVE_STOP_JSON}),
  -- Почему единица не активна: последняя ошибка канала, требующая человека
  'blocking', (SELECT json_build_object('errorCode', w.last_error_code, 'since', coalesce(w.dispatched_at, w.created_at))
                 FROM tenant_data.channel_write w
                WHERE w.tenant_id = $1 AND w.write_scope_id = sc.write_scope_id AND w.field = 'PRICE' AND sc.status <> 'ACTIVE'
                  AND w.status IN ('FAILED', 'BLOCKED', 'ACCEPTED') AND w.next_attempt_at IS NULL AND w.last_error_code IS NOT NULL
                ORDER BY w.version DESC LIMIT 1),
  'cost', (SELECT json_build_object(
              'costProfileId', cp.cost_profile_id, 'currency', cp.currency,
              'unitCost', cp.purchase_cost_minor + cp.inbound_logistics_minor + cp.packaging_minor + cp.handling_minor + cp.outbound_shipping_minor + cp.other_fixed_minor,
              -- Р-138: пол считается по БОЛЬШЕЙ действующей оценке комиссии — как в базе (0106)
              'fee', (SELECT fe.fee_model FROM channel_data.fee_estimate fe
                       WHERE fe.tenant_id = $1 AND fe.write_scope_id = sc.write_scope_id AND fe.valid_until > $2::timestamptz
                         AND jsonb_typeof(fe.fee_model -> 'feeRateBp') = 'number' AND jsonb_typeof(fe.fee_model -> 'fixedFeeMinor') = 'number'
                       ORDER BY (fe.fee_model ->> 'feeRateBp')::bigint DESC, (fe.fee_model ->> 'fixedFeeMinor')::bigint DESC, fe.computed_at DESC LIMIT 1),
              -- Р-138: все действующие оценки с источниками — продавец видит и своё число, и тариф, когда они расходятся
              'feeEstimates', (SELECT coalesce(json_agg(json_build_object('source', fe.source, 'feeRateBp', fe.fee_model -> 'feeRateBp',
                                                                          'fixedFeeMinor', fe.fee_model -> 'fixedFeeMinor',
                                                                          'scheduleVersion', fe.fee_schedule_version)
                                                        ORDER BY fe.source), '[]'::json)
                                 FROM channel_data.fee_estimate fe
                                WHERE fe.tenant_id = $1 AND fe.write_scope_id = sc.write_scope_id AND fe.valid_until > $2::timestamptz))
             FROM tenant_data.cost_profile cp
            -- Р-61: себестоимость — в валюте возникновения; перевод в валюту единицы записи — при расчёте по курсу ЕЦБ
            WHERE cp.tenant_id = $1 AND cp.product_id = sc.product_id
              AND (cp.channel_account_id IS NULL OR (cp.channel_account_id = sc.channel_account_id AND cp.marketplace = sc.marketplace))
              AND cp.valid_from <= $2::timestamptz
            ORDER BY (cp.channel_account_id IS NOT NULL) DESC, cp.valid_from DESC, cp.version DESC LIMIT 1),
  -- Р-58: ставка НДС — только в режиме НДС; страна — из справочника витрин, а не из кода витрины
  'vatRateBp', CASE WHEN sc.tax_regime = 'VAT_INCLUDED' THEN tenant_data.effective_vat_rate_bp($1, sc.product_id,
                 (SELECT mk.country FROM platform.marketplace mk WHERE mk.channel = sc.channel AND mk.marketplace = sc.marketplace)) END,
  -- Р-61, Р-63: курсы ЕЦБ, загруженные к моменту решения, — последний на каждую валюту
  'fx', (SELECT coalesce(json_agg(json_build_object('source', f.source, 'rateDate', f.rate_date, 'base', f.base_currency, 'quote', f.quote_currency,
                  'rateMicros', (f.rate * 1000000)::bigint, 'availableFrom', f.available_from)), '[]')
           FROM (SELECT DISTINCT ON (x.quote_currency) x.source, x.rate_date, x.base_currency, x.quote_currency, x.rate, x.available_from
                   FROM platform.fx_rate x
                  WHERE x.source = 'ECB' AND x.available_from <= $2::timestamptz AND x.rate_date <= ($2::timestamptz)::date
                  ORDER BY x.quote_currency, x.rate_date DESC) f),
  'guardrails', (SELECT coalesce(json_agg(gg), '[]') FROM (
      SELECT DISTINCT ON (g.scope_type) g.guardrail_id, g.min_margin_bp, g.max_step_change_bp, g.max_changes_per_hour, g.on_violation, g.is_active
        FROM tenant_data.guardrail g
       WHERE g.tenant_id = $1
         AND (g.scope_type = 'TENANT'
              OR (g.scope_type = 'CHANNEL_ACCOUNT' AND g.channel_account_id = sc.channel_account_id)
              OR (g.scope_type = 'PRODUCT' AND g.product_id = sc.product_id)
              OR (g.scope_type = 'WRITE_SCOPE' AND g.write_scope_id = sc.write_scope_id))
       ORDER BY g.scope_type, g.version DESC) gg)
)`;

/** Окно массового сдвига [Р-50]; $1 тенант, $2 момент, $3 аккаунт, $4 витрина, $5 товар, $6 состояние, $7 окно, $8/$9 пороги */
const WINDOW_PROJECTION = `
  SELECT json_build_object(
           'products', count(*),
           'moves', coalesce(json_agg(json_build_object(
                      'productRef', w.channel_product_ref || '|' || lower(w.condition), 'evaluatedAt', w.evaluated_at,
                      'moveBp', w.move_bp, 'sellerRef', w.seller_ref) ORDER BY w.evaluated_at)
                    FILTER (WHERE w.move_bp >= $8::int OR w.move_bp <= $9::int), '[]'))
    FROM channel_data.competitor_move_latest w
   WHERE w.tenant_id = $1 AND w.channel_account_id = $3 AND w.marketplace = $4
     AND w.evaluated_at >= $2::timestamptz - make_interval(secs => $7::int) AND w.evaluated_at <= $2::timestamptz
     AND NOT (w.channel_product_ref = $5 AND w.condition = $6)`;

const WINDOW_MOVE_LOG = `
  SELECT json_build_object(
           'products', count(*),
           'moves', coalesce(json_agg(json_build_object(
                      'productRef', w.channel_product_ref || '|' || lower(w.condition), 'evaluatedAt', w.evaluated_at,
                      'moveBp', w.move_bp, 'sellerRef', w.seller_ref) ORDER BY w.evaluated_at)
                    FILTER (WHERE w.move_bp >= $8::int OR w.move_bp <= $9::int), '[]'))
    FROM (SELECT DISTINCT ON (mv.channel_product_ref, mv.condition) mv.channel_product_ref, mv.condition, mv.evaluated_at, mv.move_bp, mv.seller_ref
            FROM channel_data.competitor_move mv
           WHERE mv.tenant_id = $1 AND mv.channel_account_id = $3 AND mv.marketplace = $4
             AND mv.evaluated_at >= $2::timestamptz - make_interval(secs => $7::int) AND mv.evaluated_at <= $2::timestamptz
             AND NOT (mv.channel_product_ref = $5 AND mv.condition = $6)
           ORDER BY mv.channel_product_ref, mv.condition, mv.evaluated_at DESC) w`;

const STATE_JSON = `json_build_object(
  'source', cs.source, 'sourceEventId', cs.source_event_id, 'observedAt', cs.observed_at, 'buyboxMinor', cs.buybox_amount_minor,
  'buyboxIsSelf', cs.buybox_is_self, 'offers', cs.offers, 'completeness', cs.completeness, 'completenessN', cs.completeness_n,
  'currency', cs.currency, 'basis', cs.price_basis, 'suggestedMinor', cs.suggested_price_minor,
  'competitorSnapshotId', cs.competitor_snapshot_id, 'sanity', cs.sanity_summary)`;

function contextSql(window: string): string {
  return `
WITH sc AS (SELECT ${SCOPE_COLUMNS} ${SCOPE_FROM}
               AND m.channel_account_id = $3 AND m.marketplace = $4 AND m.channel_product_ref = $5 AND m.condition = $6)
SELECT
  (SELECT coalesce(json_agg(${SCOPE_JSON} ORDER BY sc.created_at, sc.write_scope_id), '[]') FROM sc) AS scopes,
  (SELECT json_build_object('currency', mk.currency, 'basis', mk.price_basis)
     FROM tenant_data.channel_account a JOIN platform.marketplace mk ON mk.channel = a.channel AND mk.marketplace = $4
    WHERE a.tenant_id = $1 AND a.channel_account_id = $3) AS storefront,
  (SELECT json_build_object('observedAt', cs.observed_at, 'buyboxMinor', cs.buybox_amount_minor, 'buyboxIsSelf', cs.buybox_is_self,
            'lowestMinor', (SELECT min((o->'price'->>'amountMinor')::bigint) FROM jsonb_array_elements(cs.offers) o
                             WHERE NOT coalesce((o->>'isSelf')::boolean, false)))
     FROM channel_data.competitor_state cs
    WHERE cs.tenant_id = $1 AND cs.channel_account_id = $3 AND cs.marketplace = $4 AND cs.channel_product_ref = $5 AND cs.condition = $6) AS last_accepted,
  (SELECT coalesce(json_agg(json_build_object(
            'day', d.price_day, 'minMinor', least(d.buybox_min_minor, d.lowest_min_minor), 'maxMinor', greatest(d.buybox_max_minor, d.lowest_max_minor))
            ORDER BY d.price_day), '[]')
     FROM channel_data.competitor_price_daily d
    WHERE d.tenant_id = $1 AND d.channel_account_id = $3 AND d.marketplace = $4 AND d.channel_product_ref = $5 AND d.condition = $6
      AND d.price_day >= ($2::timestamptz - interval '30 days')::date) AS daily,
  (SELECT coalesce(json_agg(json_build_object(
            'channel', x.channel, 'marketplace', x.marketplace, 'referenceMinor', coalesce(x.buybox_amount_minor, x.lowest_landed_minor),
            'currency', x.currency, 'observedAt', x.observed_at)), '[]')
     FROM channel_data.competitor_state x
    WHERE x.tenant_id = $1 AND x.gtin = (SELECT sc.gtin FROM sc WHERE sc.gtin IS NOT NULL LIMIT 1)
      AND NOT (x.channel_account_id = $3 AND x.marketplace = $4 AND x.channel_product_ref = $5 AND x.condition = $6)
      AND x.observed_at >= $2::timestamptz - interval '7 days'
      AND coalesce(x.buybox_amount_minor, x.lowest_landed_minor) IS NOT NULL) AS cross_channel,
  (SELECT json_build_object('haltId', h.pricing_halt_id, 'haltedAt', h.halted_at, 'reasonCode', h.reason_code, 'marketplace', h.marketplace)
     FROM channel_data.pricing_halt h
    WHERE h.tenant_id = $1 AND h.channel_account_id = $3 AND h.released_at IS NULL AND (h.marketplace IS NULL OR h.marketplace = $4)
    LIMIT 1) AS halt,
  (${window}) AS shift_window`;
}

const SCOPE_BY_ID_SQL = `
WITH sc AS (SELECT ${SCOPE_COLUMNS} ${SCOPE_FROM} AND s.write_scope_id = $3 LIMIT 1)
SELECT (SELECT ${SCOPE_JSON} FROM sc) AS scope,
       (SELECT ${STATE_JSON} FROM channel_data.competitor_state cs JOIN sc
           ON cs.channel_account_id = sc.channel_account_id AND cs.marketplace = sc.marketplace
          AND cs.channel_product_ref = sc.channel_product_ref AND cs.condition = sc.condition
         WHERE cs.tenant_id = $1) AS state`;

const VERSION_SQL = `
SELECT sc.write_scope_id, sc.currency, sc.price_basis, (${BOUNDS_ROWS}) AS bounds, (${ACTIVE_HALT}) AS halt_id, (${ACTIVE_DISTRUST}) AS distrust_id, (${ACTIVE_STOP}) AS stop_id
  FROM (SELECT s.write_scope_id, s.product_id, s.currency, s.price_basis, s.channel_account_id, m.marketplace
          FROM tenant_data.write_scope s
          JOIN tenant_data.offer_mapping m ON m.tenant_id = s.tenant_id AND m.price_write_scope_id = s.write_scope_id AND m.status <> 'ENDED'
         WHERE s.tenant_id = $1 AND s.write_scope_id = ANY ($2::uuid[])) sc`;

/** Последние версии границ одной единицы; сохраняется для включения репрайсинга и замера */
export const PRICE_BOUNDS_SQL = `
SELECT sc.currency, sc.price_basis, (${BOUNDS_ROWS}) AS bounds
  FROM (SELECT s.write_scope_id, s.product_id, s.currency, s.price_basis FROM tenant_data.write_scope s
         WHERE s.tenant_id = $1 AND s.write_scope_id = $2 AND s.field = 'PRICE') sc`;

function toStrategy(r: Row): StrategyDefinition | null {
  if (!r.pricing_strategy_id || !r.strategy_params) return null;
  const { deadbandMinor, ...params } = r.strategy_params as Record<string, unknown>;
  return {
    strategyId: r.pricing_strategy_id,
    version: r.pricing_strategy_version,
    params: params as unknown as StrategyDefinition['params'],
    deadbandMinor: typeof deadbandMinor === 'number' ? deadbandMinor : 0,
  };
}

function toBounds(rows: Row[], currency: string, basis: 'GROSS' | 'NET'): PriceBounds {
  const resolve = (bound: 'min' | 'max'): BoundResolution => {
    const active = rows.filter((r) => r.bound === bound && r.is_active);
    if (active.length === 0) return { status: 'UNRESOLVABLE', cause: 'MISSING' };
    const amounts = active.map((r) => Number(r.amount_minor));
    return { status: 'RESOLVED', amountMinor: bound === 'min' ? Math.max(...amounts) : Math.min(...amounts), sourceIds: active.map((r) => r.id as string) };
  };
  return { currency, basis, min: resolve('min'), max: resolve('max') };
}

function contextVersion(bounds: Row[], haltId: string | null, distrustId: string | null, stopId: string | null): string {
  return `${bounds.map((r) => `${r.bound}:${r.level}:${r.id}`).sort().join('|')}|halt:${haltId ?? '-'}|distrust:${distrustId ?? '-'}|stop:${stopId ?? '-'}`;
}

/** Что изменилось в контексте решения между чтением и фиксацией — параметры BOUNDS_VERSION_CHANGED [Р-54] */
function contextChange(read: ScopeEvaluationContext, now: Row | undefined): Reason {
  const amount = (b: BoundResolution) => (b.status === 'RESOLVED' ? b.amountMinor : null);
  const currency = read.scope.currency;
  const fresh = now ? toBounds(now.bounds ?? [], currency, read.scope.basis) : null;
  const changed: string[] = [];
  if (!fresh || amount(fresh.min) !== amount(read.bounds.min) || fresh.min.status !== read.bounds.min.status) changed.push('MIN_PRICE');
  if (!fresh || amount(fresh.max) !== amount(read.bounds.max) || fresh.max.status !== read.bounds.max.status) changed.push('MAX_PRICE');
  if ((now?.halt_id ?? null) !== (read.channelHalt?.haltId ?? null)) changed.push('CHANNEL_HALT');
  if ((now?.distrust_id ?? null) !== (read.channelDistrust?.distrustId ?? null)) changed.push('CHANNEL_DISTRUST');
  if ((now?.stop_id ?? null) !== (read.priceStop?.stopId ?? null)) changed.push('PRICING_STOP');
  return {
    code: 'BOUNDS_VERSION_CHANGED',
    params: {
      attempt: 1, changed: changed.join(','), oldMinMinor: amount(read.bounds.min), newMinMinor: fresh ? amount(fresh.min) : null,
      oldMaxMinor: amount(read.bounds.max), newMaxMinor: fresh ? amount(fresh.max) : null, currency,
    },
  };
}

function toFxQuotes(v: unknown): FxQuote[] {
  return ((v ?? []) as Row[]).map((f) => ({
    source: 'ECB', rateDate: String(f.rateDate).slice(0, 10), base: 'EUR', quote: f.quote, rateMicros: Number(f.rateMicros), availableFrom: iso(f.availableFrom),
  }));
}

function toScopeContext(j: Row, now: Instant): ScopeEvaluationContext {
  const r = j.row as Row;
  const lastSent = r.last_sent_amount_minor === null ? null : Number(r.last_sent_amount_minor);
  const current: number | null = Number(r.latest_version_accepted) > 0 && lastSent !== null ? lastSent : j.observed === null ? null : Number(j.observed);
  const known = new Set<number>();
  for (const v of [current, ...(j.inFlight ?? []), ...(j.recent ?? [])]) if (v !== null && v !== undefined) known.add(Number(v));
  const scope: PriceScopeContext = {
    writeScopeId: r.write_scope_id,
    productId: r.product_id,
    channelAccountId: r.channel_account_id,
    marketplace: r.marketplace,
    externalUnitId: r.external_unit_id ?? r.external_sku ?? '',
    identity: offerIdentityOf({
      channel: r.channel, field: 'PRICE', region: r.region, marketplace: r.marketplace, externalSku: r.external_sku,
      externalListingId: r.external_listing_id, externalUnitId: r.external_unit_id,
    }),
    channelProductRef: r.channel_product_ref ?? '',
    condition: portCondition(r.condition),
    scopeKey: r.scope_key,
    gtin: r.gtin ?? null,
    currency: r.currency,
    basis: r.price_basis,
    taxRegime: r.tax_regime,
    pricingMode: r.pricing_mode,
    status: r.status,
    strategy: toStrategy(r),
    currentPriceMinor: current,
    knownPricesMinor: [...known],
  };
  const bounds = (j.bounds ?? []) as Row[];
  const c = j.cost as Row | null;
  const fee = (c?.fee ?? null) as { feeRateBp?: unknown; fixedFeeMinor?: unknown } | null;
  // Р-61: себестоимость в валюте возникновения переводится в валюту единицы записи по курсу ЕЦБ на момент решения (вверх)
  const converted = c ? convertMinor(Number(c.unitCost), c.currency, r.currency, toFxQuotes(j.fx), now, 'UP') : null;
  // Без действующей оценки комиссии маржа не вычисляется: себестоимость для маржи не отдаётся (fail-closed)
  const cost: CostInputs | null = c && converted?.ok && fee && Number.isSafeInteger(fee.feeRateBp) && Number.isSafeInteger(fee.fixedFeeMinor)
    ? {
        currency: r.currency, costProfileId: c.costProfileId, unitCostMinor: converted.amountMinor,
        fixedFeeMinor: fee.fixedFeeMinor as number, feeRateBp: fee.feeRateBp as number,
        tax: r.tax_regime === 'SALES_TAX_EXCLUDED' ? { regime: 'SALES_TAX_EXCLUDED' } : { regime: 'VAT_INCLUDED', vatRateBp: j.vatRateBp ?? null },
        fx: converted.fx,
      }
    : null;
  const active = ((j.guardrails ?? []) as Row[]).filter((g) => g.is_active);
  const pick = (col: string, f: (...v: number[]) => number) => {
    const values = active.map((g) => g[col]).filter((v): v is number => typeof v === 'number');
    return values.length ? f(...values) : null;
  };
  const guardrails: GuardrailSet = {
    guardrailIds: active.map((g) => g.guardrail_id),
    minMarginBp: pick('min_margin_bp', Math.max),
    maxStepChangeBp: pick('max_step_change_bp', Math.min),
    maxChangesPerHour: pick('max_changes_per_hour', Math.min),
    // CLAMP к границе запрещён [Р-44]: нарушение ограничения — удержание, если ни один уровень не требует отказа
    onViolation: active.some((g) => g.on_violation === 'REJECT') ? 'REJECT' : 'HOLD',
  };
  const halt = j.halt as Row | null;
  const stop = j.stop as Row | null;
  const blocking = j.blocking as Row | null;
  const channelHalt: HaltRef | null = halt ? { haltId: halt.haltId, reasonCode: halt.reasonCode, marketplace: halt.marketplace ?? null, haltedAt: iso(halt.haltedAt) } : null;
  const distrust = j.distrust as Row | null;
  const channelDistrust: DistrustRef | null = distrust
    ? { distrustId: distrust.distrustId, reasonCode: distrust.reasonCode, marketplace: distrust.marketplace ?? null, detectedAt: iso(distrust.detectedAt) } : null;
  const priceStop: StopRef | null = stop
    ? { stopId: stop.stopId, scope: stop.scope, channelAccountId: stop.channelAccountId ?? null, marketplace: stop.marketplace ?? null, stoppedAt: iso(stop.stoppedAt), stoppedByMembershipId: stop.stoppedBy }
    : null;
  return {
    scope,
    bounds: toBounds(bounds, scope.currency, scope.basis),
    contextVersion: contextVersion(bounds, channelHalt?.haltId ?? null, channelDistrust?.distrustId ?? null, priceStop?.stopId ?? null),
    cost,
    unitCostMinor: converted?.ok ? converted.amountMinor : null,
    costUnavailableCause: converted && !converted.ok ? converted.cause : null,
    costMissingCause: !c ? 'COST_PROFILE_MISSING' : converted && !converted.ok ? converted.cause : !cost ? 'FEE_ESTIMATE_MISSING' : null,
    guardrails,
    channelHalt,
    channelDistrust,
    priceStop,
    blocking: blocking ? { errorCode: blocking.errorCode, since: iso(blocking.since) } : null,
    changesInLastHour: Number(j.changes ?? 0),
  };
}

function toSnapshot(key: ProductKey, s: Row): AcceptedSnapshot {
  const money = (amountMinor: number) => ({ amountMinor, currency: s.currency, basis: s.basis });
  // competitor_state хранит только принятые снимки; валюта, база и подсказка канала — из проекции [OQ-94]
  return {
    marketplace: key.marketplace,
    channelProductRef: key.channelProductRef,
    condition: key.condition,
    source: s.source,
    ...(s.sourceEventId ? { sourceEventId: s.sourceEventId } : {}),
    observedAt: iso(s.observedAt),
    completeness: s.completeness === 'TOP_N' ? { kind: 'TOP_N', n: s.completenessN } : { kind: s.completeness },
    ...(s.buyboxMinor !== null ? { buybox: { price: money(Number(s.buyboxMinor)), isSelf: Boolean(s.buyboxIsSelf) } } : {}),
    ...(s.suggestedMinor !== null ? { channelSuggestedPrice: money(Number(s.suggestedMinor)) } : {}),
    offers: s.offers,
    sanityRuleset: 'stored',
  } as unknown as AcceptedSnapshot;
}

function dbReason(error: unknown, amountMinor: number | null, currency: string): Reason | null {
  const e = error as { code?: string; message?: string };
  if (e.code !== '23514') return null;
  const message = e.message ?? '';
  // Граница — из сообщения триггера БД (0030): «… effective min_price <amount>»; параметры — как у Gate, с валютой [Р-71]
  const bound = (name: string): number | null => {
    const m = new RegExp(`effective ${name} (-?\\d+)`).exec(message);
    return m ? Number(m[1]) : null;
  };
  const uuid = (table: string): string | null => new RegExp(`${table} ([0-9a-f-]{36})`).exec(message)?.[1] ?? null;
  // Р-83 (0051): пол при создании записи — min_price и пол маржи, вычисленные заново
  const floor = /is below effective price floor (\d+) \(min_price (\d+), margin floor (\d+|none), min margin (\d+|none) bp\)/.exec(message);
  if (floor) {
    const [floorMinor, minMinor] = [Number(floor[1]), Number(floor[2])];
    return floor[3] !== 'none' && Number(floor[3]) > minMinor
      ? { code: 'BELOW_MARGIN_FLOOR', params: { proposedMinor: amountMinor, floorMinor, minMinor, ...(floor[4] !== 'none' ? { minMarginBp: Number(floor[4]) } : {}), currency } }
      : { code: 'BELOW_MIN_PRICE', params: { proposedMinor: amountMinor, minMinor, source: 'DATABASE', currency } };
  }
  const unresolvable = /price floor of write_scope \S+ cannot be computed [^:]*: (\w+)/.exec(message);
  if (unresolvable) {
    const cause = floorCauseFromDatabase(unresolvable[1]!);
    return { code: 'BOUND_UNRESOLVABLE', params: { bound: unresolvable[1] === 'MIN_PRICE_MISSING' ? 'min' : 'margin_floor', cause } };
  }
  if (message.includes('below effective min_price')) return { code: 'BELOW_MIN_PRICE', params: { proposedMinor: amountMinor, minMinor: bound('min_price'), source: 'DATABASE', currency } };
  if (message.includes('above effective max_price')) return { code: 'ABOVE_MAX_PRICE', params: { proposedMinor: amountMinor, maxMinor: bound('max_price'), source: 'DATABASE', currency } };
  const stopId = uuid('price_stop');
  if (stopId) return { code: 'PRICING_STOPPED', params: { stopId, stage: 'DATABASE' } };
  const distrustId = uuid('channel_distrust');
  if (distrustId) return { code: 'CHANNEL_DISTRUSTED', params: { stage: 'DATABASE', distrustId } };
  const haltId = uuid('pricing_halt');
  if (haltId) return { code: 'CHANNEL_HALTED', params: { stage: 'DATABASE', haltId } };
  return null;
}

/**
 * Ревью шага 28, находка 10: стражи второго фактора отказывают тем же SQLSTATE, что и права роли (42501). Продавцу, у которого право
 * есть, «у вашей роли нет права» — неправда: ему нужно войти со вторым фактором. Отличаем по причине отказа, которую страж называет.
 */
function secondFactorRefused(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  return e.code === '42501' && /second factor/i.test(e.message ?? '');
}

/**
 * OQ-196 (шаг 33): за отказом «нужен второй фактор» стоят ДВА РАЗНЫХ правила, и продавцу важно знать, какое сработало.
 *
 * Первое — массовая правка: больше одного предложения одной транзакцией. Второе — окно [Р-135]: правок больше пяти за
 * десять минут, даже если каждая была по одному предложению. До шага 33 оба отказа приходили на экран одним кодом, и
 * продавец, честно поправивший ШЕСТОЕ предложение подряд, читал «правка больше чем одного предложения требует второго
 * фактора» — про операцию, которой он не делал. Совет из этого текста невыполним: делить нечего.
 */
function windowRefused(error: unknown): boolean {
  const e = error as { code?: string; message?: string };
  /**
   * Опознаётся ИМЕННО окно пяти правок. Текстом «within ten minutes» отказывают ДВА стража 0110, и второй — широкий
   * гардрейл («a guardrail of every offer was changed…»): он про изменение пола маржи у всего тенанта, а не про пять
   * предложений (находка 1 ревью шага 33). Сказать продавцу про пять предложений там, где он менял гардрейл, — это тот
   * самый дефект, ради которого OQ-196 и правился, просто в новой форме.
   */
  return e.code === '42501' && /offers changed within ten minutes/i.test(e.message ?? '');
}

const BULK_JOB_COLUMNS = `bulk_job_id, kind, status, params, phase, total_items, done_items, result, error_code, attempts,
  (lease_until IS NOT NULL AND lease_until <= now()) AS lease_expired,
  created_with_mfa, created_by_membership_id, created_by_user_id, created_at, started_at, finished_at, lease_owner, lease_until`;

/** Те же столбцы с именем таблицы: в запросе взятия задания рядом стоит CTE со своим `bulk_job_id` */
const BULK_JOB_COLUMNS_OF_J = BULK_JOB_COLUMNS.replace(/\blease_until IS NOT NULL AND lease_until\b/, 'j.lease_until IS NOT NULL AND j.lease_until')
  .split(/,(?![^(]*\))/).map((c) => (c.includes('(') ? c.trim() : `j.${c.trim()}`)).join(', ');

function toBulkJob(r: Row): BulkJobRow {
  return {
    jobId: String(r.bulk_job_id), kind: r.kind, status: r.status, params: r.params, phase: r.phase ?? null,
    totalItems: r.total_items === null ? null : Number(r.total_items), doneItems: Number(r.done_items),
    result: r.result ?? null, errorCode: r.error_code ?? null, attempts: Number(r.attempts),
    createdWithMfa: r.created_with_mfa === true, createdByMembershipId: String(r.created_by_membership_id),
    createdByUserId: String(r.created_by_user_id),
    createdAt: String(r.created_at), startedAt: r.started_at === null ? null : String(r.started_at),
    finishedAt: r.finished_at === null ? null : String(r.finished_at),
    leaseOwner: r.lease_owner ?? null, leaseUntil: r.lease_until === null ? null : String(r.lease_until),
    leaseExpired: r.lease_expired === true,
  };
}

export class PgPricingStore implements PricingStore {
  private readonly pool: PgPool;
  private readonly adminPool: PgPool | null;
  private readonly bulkWorkerPool: PgPool | null;
  private readonly contextQuery: string;
  private readonly writeQueue: PgWriteQueueStore;

  constructor(pool: PgPool, options: PgPricingStoreOptions = {}) {
    this.pool = pool;
    this.adminPool = options.adminPool ?? null;
    this.bulkWorkerPool = options.bulkWorkerPool ?? null;
    this.writeQueue = new PgWriteQueueStore(pool);
    this.contextQuery = contextSql(options.shiftWindowSource === 'move_log' ? WINDOW_MOVE_LOG : WINDOW_PROJECTION);
  }

  private tx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return inTenant(this.pool, tenantId, fn);
  }

  private admin(action: string): PgPool {
    if (!this.adminPool) throw new Error(`${action} needs the administrative database role (Р-90): construct PgPricingStore with adminPool`);
    return this.adminPool;
  }

  private bulkWorker(action: string): PgPool {
    if (!this.bulkWorkerPool) throw new Error(`${action} needs the bulk worker database role (Р-139): construct PgPricingStore with bulkWorkerPool`);
    return this.bulkWorkerPool;
  }

  // --- оценка: транзакция 1 ----------------------------------------------------
  async loadEvaluationContext(tenantId: string, key: ProductKey, now: Instant, shift: ShiftWindow): Promise<EvaluationContext> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(this.contextQuery, [
        tenantId, now, key.channelAccountId, key.marketplace, key.channelProductRef, dbCondition(key.condition),
        shift.windowSeconds, Math.round(shift.minFactor * 10_000), Math.round(10_000 / shift.minFactor),
      ]);
      const r = rows[0]!;
      const scopes = (r.scopes as Row[]).map((j) => toScopeContext(j, now));
      const primary = scopes.find((s) => s.scope.pricingMode === 'ENGINE') ?? scopes[0] ?? null;
      const storefront = r.storefront as Row | null;
      const last = r.last_accepted as Row | null;
      const halt = r.halt as Row | null;
      const window = r.shift_window as { products: number; moves: Row[] };
      return {
        scopes,
        sanity: {
          now,
          // Витрина не описана в platform.marketplace — сверять не с чем: любой снимок отклоняется (fail-closed)
          expectedCurrency: primary?.scope.currency ?? storefront?.currency ?? '',
          expectedBasis: primary?.scope.basis ?? storefront?.basis ?? 'GROSS',
          unitCostMinor: primary?.unitCostMinor ?? null,
          crossChannel: (r.cross_channel as Row[]).map((x): CrossChannelReference => ({
            channel: x.channel, marketplace: x.marketplace, referenceMinor: Number(x.referenceMinor), currency: x.currency, observedAt: iso(x.observedAt),
          })),
          fxRates: toFxQuotes((r.scopes as Row[])[0]?.fx),
          competitorDaily: (r.daily as Row[]).map((d): DailyRange => ({ day: d.day, minMinor: Number(d.minMinor), maxMinor: Number(d.maxMinor) })),
          lastAccepted: last ? { observedAt: iso(last.observedAt), buyboxMinor: last.buyboxMinor ?? null, lowestMinor: last.lowestMinor ?? null, buyboxIsSelf: last.buyboxIsSelf ?? null } : null,
          ourPriceMinor: primary?.scope.currentPriceMinor ?? null,
          ourKnownPricesMinor: primary?.scope.knownPricesMinor ?? [],
          channel: {
            halt: halt ? { haltId: halt.haltId, haltedAt: iso(halt.haltedAt), reasonCode: halt.reasonCode, marketplace: halt.marketplace ?? null } : null,
            recentMoves: window.moves.map((m) => ({ productRef: m.productRef, evaluatedAt: iso(m.evaluatedAt), moveBp: m.moveBp, sellerRef: m.sellerRef ?? null })),
            windowProducts: Number(window.products),
          },
        },
      };
    });
  }

  async loadScopeContext(tenantId: string, writeScopeId: string, now: Instant) {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(SCOPE_BY_ID_SQL, [tenantId, now, writeScopeId]);
      const r = rows[0];
      if (!r?.scope) return null;
      const context = toScopeContext(r.scope, now);
      const s = context.scope;
      const snapshot = r.state ? toSnapshot({ channelAccountId: s.channelAccountId, marketplace: s.marketplace, channelProductRef: s.channelProductRef, condition: s.condition }, r.state) : null;
      const snapshotRef: StoredSnapshotRef | null = r.state?.competitorSnapshotId
        ? { competitorSnapshotId: r.state.competitorSnapshotId, source: r.state.source, observedAt: iso(r.state.observedAt), sanity: r.state.sanity ?? null }
        : null;
      return { context, snapshot, snapshotRef };
    });
  }

  // --- оценка: транзакция 2 ----------------------------------------------------
  async commitEvaluation(tenantId: string, input: EvaluationCommit): Promise<EvaluationCommitResult> {
    const writeScopeIds = [...new Set(input.decisions.map((d) => d.context.scope.writeScopeId))].sort();
    return this.tx<EvaluationCommitResult>(tenantId, async (tx) => {
      let current: DecisionToCommit | null = null;
      try {
        // OQ-171: журнал уведомления — первым в транзакции решения; повтор (и одновременный) ждёт уникальности и откатывается
        if (input.notification && !(await this.insertNotification(tx, tenantId, input.notification))) {
          throw new RollbackWith<EvaluationCommitResult>({ status: 'DUPLICATE_NOTIFICATION' });
        }
        if (writeScopeIds.length > 0) {
          // Решения по одной единице фиксируются по очереди (версия записи); FOR SHARE товара упорядочивает фиксацию
          // с изменением границ, которое берёт FOR UPDATE на товар в отложенной проверке [Р-54]. Права UPDATE на товар у пути
          // решения нет (Р-96): блокировку товара берёт функция базы (0065)
          await tx.query(
            `SELECT s.write_scope_id FROM tenant_data.write_scope s
              WHERE s.tenant_id = $1 AND s.write_scope_id = ANY ($2::uuid[])
              ORDER BY s.write_scope_id FOR NO KEY UPDATE OF s`,
            [tenantId, writeScopeIds],
          );
          await tx.query('SELECT tenant_data.lock_decision_products($1, $2::uuid[])', [tenantId, writeScopeIds]);
          // Версия контекста перечитывается уже под блокировкой
          const { rows } = await tx.query(VERSION_SQL, [tenantId, writeScopeIds]);
          const byScope = new Map(rows.map((r) => [r.write_scope_id as string, r]));
          for (const d of input.decisions) {
            const id = d.context.scope.writeScopeId;
            const r = byScope.get(id);
            if (!r || contextVersion(r.bounds, r.halt_id, r.distrust_id, r.stop_id) !== d.context.contextVersion) {
              throw new RollbackWith<EvaluationCommitResult>({ status: 'CONTEXT_CHANGED', writeScopeId: id, reason: contextChange(d.context, r) });
            }
          }
        }
        let rejectedSnapshotId: string | null = null;
        let divergenceCaseId: string | null = null;
        if (input.snapshot) ({ rejectedSnapshotId, divergenceCaseId } = await this.writeSnapshot(tx, tenantId, input.key, input.snapshot, input.now));
        const decisions: CommittedDecision[] = [];
        for (const d of input.decisions) {
          current = d;
          decisions.push(await this.writeDecision(tx, tenantId, d, input.now));
        }
        return { status: 'COMMITTED', rejectedSnapshotId, divergenceCaseId, decisions };
      } catch (error) {
        if (error instanceof RollbackWith) throw error;
        const reason = current ? dbReason(error, current.decision.finalMinor, current.decision.currency) : null;
        if (reason && current) throw new RollbackWith<EvaluationCommitResult>({ status: 'CONTEXT_CHANGED', writeScopeId: current.context.scope.writeScopeId, reason });
        throw error;
      }
    });
  }

  private async writeSnapshot(tx: Tx, tenantId: string, key: ProductKey, s: SnapshotOutcome, now: Instant): Promise<{ rejectedSnapshotId: string | null; divergenceCaseId: string | null }> {
    const condition = dbCondition(key.condition);
    // Р-122 (0086): полный снимок — в журнал для выгрузки в ClickHouse, в той же транзакции, при любом вердикте
    if (s.log) {
      await tx.query(
        `INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace,
                                                          channel_product_ref, condition, source, source_event_id, sanity_verdict, delivery, snapshot)
         SELECT $1, $2, $3, $4, a.channel_account_id, a.channel, $6, $7, $8, $9, $10, $11, $13, $12::jsonb
           FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $5`,
        [tenantId, s.log.competitorSnapshotId, s.log.receivedAt, s.log.snapshot.observedAt, key.channelAccountId, key.marketplace, key.channelProductRef,
          s.log.snapshot.condition, s.log.snapshot.source, s.log.snapshot.sourceEventId ?? null, s.verdict, JSON.stringify(s.log.snapshot), s.log.delivery]);
    }
    if (s.lossCheck) await PgPricingStore.insertLossCheck(tx, tenantId, s.lossCheck);
    const snapshot = s.accepted?.snapshot ?? null;
    const competitors = snapshot ? snapshot.offers.filter((o) => !o.isSelf) : [];
    const lowestPrice = competitors.length ? Math.min(...competitors.map((o) => o.price.amountMinor)) : null;
    const lowestLanded = competitors.length
      ? Math.min(...competitors.map((o) => o.totalPrice?.amountMinor ?? o.price.amountMinor + (o.shipping?.amountMinor ?? 0)))
      : null;
    const buybox = snapshot?.buybox?.price.amountMinor ?? null;
    // История — цены конкурентов: наш собственный Buy Box в якорь не попадает [Р-49]
    const competitorBuybox = snapshot?.buybox && !snapshot.buybox.isSelf ? buybox : null;
    const money = snapshot?.buybox?.price ?? snapshot?.offers[0]?.price ?? snapshot?.channelSuggestedPrice ?? null;
    const gtin = s.accepted?.gtin && /^[0-9]{8,14}$/.test(s.accepted.gtin) ? s.accepted.gtin : null;

    // Движение, проекция окна сдвига, проекция снимка и суточная история — одним оператором
    await tx.query(
      `WITH acct AS (SELECT channel FROM tenant_data.channel_account WHERE tenant_id = $1::uuid AND channel_account_id = $2::uuid),
       mv AS (
         INSERT INTO channel_data.competitor_move (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
         SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz, $8::int, $9::text, $10::text WHERE $8::int IS NOT NULL
         RETURNING 1),
       latest AS (
         INSERT INTO channel_data.competitor_move_latest AS l (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, observed_at, evaluated_at, move_bp, verdict, seller_ref)
         SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::timestamptz, $7::timestamptz, $8::int, $9::text, $10::text WHERE $8::int IS NOT NULL
         ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition) DO UPDATE SET
           observed_at = EXCLUDED.observed_at, evaluated_at = EXCLUDED.evaluated_at, move_bp = EXCLUDED.move_bp,
           verdict = EXCLUDED.verdict, seller_ref = EXCLUDED.seller_ref
         WHERE l.evaluated_at <= EXCLUDED.evaluated_at
         RETURNING 1),
       st AS (
         INSERT INTO channel_data.competitor_state AS cs
           (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, source_event_id, competitor_snapshot_id,
            observed_at, received_at, buybox_amount_minor, buybox_is_self, lowest_landed_minor, offer_count, offers, completeness, completeness_n, gtin,
            currency, price_basis, suggested_price_minor, sanity_summary)
         SELECT $1::uuid, $2::uuid, acct.channel, $3::text, $4::text, $5::text, $11::text, $12::text, coalesce($27::uuid, gen_random_uuid()),
                $6::timestamptz, $7::timestamptz, $13::bigint, $14::boolean, $15::bigint, $16::int, $17::jsonb, $18::text, $19::int, $20::text,
                $21::text, $22::text, $23::bigint, $28::jsonb
           FROM acct WHERE $24::boolean
         ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition) DO UPDATE SET
           source = EXCLUDED.source, source_event_id = EXCLUDED.source_event_id, competitor_snapshot_id = EXCLUDED.competitor_snapshot_id,
           observed_at = EXCLUDED.observed_at, received_at = EXCLUDED.received_at, buybox_amount_minor = EXCLUDED.buybox_amount_minor,
           buybox_is_self = EXCLUDED.buybox_is_self, lowest_landed_minor = EXCLUDED.lowest_landed_minor, offer_count = EXCLUDED.offer_count,
           offers = EXCLUDED.offers, completeness = EXCLUDED.completeness, completeness_n = EXCLUDED.completeness_n,
           gtin = coalesce(EXCLUDED.gtin, cs.gtin), currency = EXCLUDED.currency, price_basis = EXCLUDED.price_basis,
           suggested_price_minor = EXCLUDED.suggested_price_minor, sanity_summary = EXCLUDED.sanity_summary
         -- Два снимка одного товара могут прийти одновременно: более старый не перезаписывает проекцию
         WHERE cs.observed_at <= EXCLUDED.observed_at
         RETURNING 1),
       dly AS (
         INSERT INTO channel_data.competitor_price_daily AS d
           (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, price_day,
            buybox_min_minor, buybox_max_minor, buybox_last_minor, lowest_min_minor, lowest_max_minor, lowest_last_minor, samples, updated_at)
         SELECT $1::uuid, $2::uuid, acct.channel, $3::text, $4::text, $5::text, ($6::timestamptz AT TIME ZONE 'UTC')::date,
                $25::bigint, $25::bigint, $25::bigint, $26::bigint, $26::bigint, $26::bigint, 1, $7::timestamptz
           FROM acct WHERE $24::boolean AND ($25::bigint IS NOT NULL OR $26::bigint IS NOT NULL)
         ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition, price_day) DO UPDATE SET
           buybox_min_minor = least(d.buybox_min_minor, EXCLUDED.buybox_min_minor),
           buybox_max_minor = greatest(d.buybox_max_minor, EXCLUDED.buybox_max_minor),
           buybox_last_minor = coalesce(EXCLUDED.buybox_last_minor, d.buybox_last_minor),
           lowest_min_minor = least(d.lowest_min_minor, EXCLUDED.lowest_min_minor),
           lowest_max_minor = greatest(d.lowest_max_minor, EXCLUDED.lowest_max_minor),
           lowest_last_minor = coalesce(EXCLUDED.lowest_last_minor, d.lowest_last_minor),
           samples = d.samples + 1, updated_at = EXCLUDED.updated_at
         RETURNING 1)
       SELECT (SELECT count(*) FROM mv) + (SELECT count(*) FROM latest) + (SELECT count(*) FROM st) + (SELECT count(*) FROM dly) AS n`,
      [tenantId, key.channelAccountId, key.marketplace, key.channelProductRef, condition, s.observedAt, now,
       s.move?.moveBp ?? null, s.verdict, s.move?.sellerRef ? s.move.sellerRef.slice(0, 200) : null,
       snapshot?.source ?? null, snapshot?.sourceEventId ?? null, buybox, snapshot?.buybox?.isSelf ?? null, lowestLanded,
       snapshot?.offers.length ?? null, snapshot ? JSON.stringify(snapshot.offers) : null, snapshot?.completeness.kind ?? null,
       snapshot?.completeness.kind === 'TOP_N' ? snapshot.completeness.n : null, gtin,
       money?.currency ?? null, money?.basis ?? null, snapshot?.channelSuggestedPrice?.amountMinor ?? null,
       Boolean(snapshot && money), competitorBuybox, lowestPrice,
       s.accepted?.competitorSnapshotId ?? null, s.accepted ? JSON.stringify(s.accepted.sanity) : null],
    );

    let rejectedSnapshotId: string | null = null;
    if (s.rejected) {
      const { rows } = await tx.query(
        `INSERT INTO channel_data.rejected_competitor_snapshot
           (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, source, source_event_id,
            observed_at, received_at, verdict, reason_code, alarm_class, details, ruleset_version)
         SELECT $1, $2, a.channel, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
           FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2
         RETURNING rejected_snapshot_id`,
        [tenantId, key.channelAccountId, key.marketplace, key.channelProductRef, condition, s.rejected.source, s.rejected.sourceEventId ?? null,
         s.rejected.observedAt, s.rejected.receivedAt, s.rejected.verdict, s.rejected.reasonCode, s.rejected.alarmClass,
         JSON.stringify(s.rejected.details ?? {}), s.rejected.ruleset],
      );
      rejectedSnapshotId = rows[0]?.rejected_snapshot_id ?? null;
    }
    if (s.halt) await this.insertHalt(tx, tenantId, s.halt, rejectedSnapshotId);

    let divergenceCaseId: string | null = null;
    if (s.divergence) {
      const { rows } = await tx.query(
        `INSERT INTO channel_data.divergence_case (tenant_id, write_scope_id, field, expected_amount_minor, observed_amount_minor, cause, opened_at)
         VALUES ($1, $2, 'PRICE', $3, $4, 'EXTERNAL_CHANGE', $5)
         ON CONFLICT (tenant_id, write_scope_id, field) WHERE status = 'OPEN' DO NOTHING
         RETURNING divergence_case_id`,
        [tenantId, s.divergence.writeScopeId, s.divergence.expectedMinor, s.divergence.observedMinor, s.divergence.observedAt],
      );
      divergenceCaseId = rows[0]?.divergence_case_id ?? null;
    }
    return { rejectedSnapshotId, divergenceCaseId };
  }

  private async insertHalt(tx: Tx, tenantId: string, halt: HaltRecord, rejectedSnapshotId: string | null): Promise<void> {
    // Одна действующая остановка на аккаунт и витрину (pricing_halt_active_uq): повтор — без ошибки
    await tx.query(
      `INSERT INTO channel_data.pricing_halt (tenant_id, channel_account_id, channel, marketplace, reason_code, rejected_snapshot_id, details, halted_at)
       SELECT $1, $2, a.channel, $3, $4, $5, $6, $7 FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2
       ON CONFLICT (tenant_id, channel_account_id, (COALESCE(marketplace, '*'))) WHERE released_at IS NULL DO NOTHING`,
      [tenantId, halt.channelAccountId, halt.marketplace, halt.reasonCode, rejectedSnapshotId, JSON.stringify(halt.details ?? {}), halt.haltedAt],
    );
  }

  private async writeDecision(tx: Tx, tenantId: string, d: DecisionToCommit, now: Instant): Promise<CommittedDecision> {
    const { intent, decision, context } = d;
    const scope = context.scope;
    const { rows: [intentRow] } = await tx.query(
      `INSERT INTO channel_data.price_intent
         (tenant_id, created_at, write_scope_id, pricing_strategy_id, pricing_strategy_version, trigger_type, source_event_id,
          proposed_amount_minor, currency, price_basis, inputs, rationale, expires_at, rule_code, reference_amount_minor)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING price_intent_id`,
      [tenantId, intent.createdAt, scope.writeScopeId, intent.strategyId, intent.strategyVersion, intent.trigger.type, intent.trigger.sourceEventId ?? null,
       intent.proposedMinor, intent.currency, intent.basis, JSON.stringify(intent.inputs),
       JSON.stringify({ intentClass: intent.intentClass, currentMinor: intent.currentMinor, currency: intent.currency, reason: intent.reason, explanation: intent.explanation }),
       intent.expiresAt, intent.ruleCode, intent.referenceMinor],
    );
    const intentId: string = intentRow!.price_intent_id;
    const cost = context.cost;
    const { rows: [decisionRow] } = await tx.query(
      `INSERT INTO channel_data.price_decision
         (tenant_id, intent_created_at, price_intent_id, write_scope_id, decided_at, outcome, final_amount_minor, currency, price_basis,
          effective_floor_minor, effective_ceiling_minor, min_price_ids, max_price_ids, guardrail_ids, cost_profile_id, fee_inputs, violations,
          rejection_reason, reason_params, checks, fx, explanation, bound_deviation_bp, no_change_reason, sanity_ruleset, gate_profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid[], $13::uuid[], $14::uuid[], $15, $16, $17::text[], $18, $19, $20, $21, $22, $23, $24, $25, $26)
       RETURNING price_decision_id`,
      [tenantId, intent.createdAt, intentId, scope.writeScopeId, decision.decidedAt, decision.outcome, decision.finalMinor, decision.currency, decision.basis,
       decision.effectiveFloorMinor, decision.effectiveCeilingMinor, decision.minPriceIds, decision.maxPriceIds, decision.guardrailIds,
       cost?.costProfileId ?? null,
       cost ? JSON.stringify({ unitCostMinor: cost.unitCostMinor, fixedFeeMinor: cost.fixedFeeMinor, feeRateBp: cost.feeRateBp, tax: cost.tax }) : null,
       decision.checks.filter((c) => !c.passed).map((c) => c.check), decision.rejectionReason,
       JSON.stringify(decision.reason.params ?? {}), JSON.stringify(decision.checks), decision.fx ? JSON.stringify(decision.fx) : null,
       // Р-68: слепок объяснения — в той же вставке; БД отклоняет его без формата или с данными канала. Р-74: у NO_OP — только код причины;
       // Р-75: ссылки слепка на справочник — столбцами с внешним ключом
       // Р-80: столбцы intent в решении заполняет триггер из price_intent — приложение их не передаёт
       decision.explanation ? JSON.stringify(decision.explanation) : null, decision.boundDeviationBp, decision.noChangeReason ?? null,
       decision.sanityRuleset ?? null, decision.gateProfile ?? null],
    );
    const decisionId: string = decisionRow!.price_decision_id;
    // Ссылка на полный снимок — данные канала, 18 месяцев [Р-38, Р-68]; та же транзакция
    if (d.snapshotRef) {
      await tx.query(
        `INSERT INTO channel_data.price_decision_snapshot_ref (tenant_id, price_decision_id, decided_at, write_scope_id, competitor_snapshot_id, source, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, decisionId, decision.decidedAt, scope.writeScopeId, d.snapshotRef.competitorSnapshotId, d.snapshotRef.source, d.snapshotRef.observedAt],
      );
    }
    if (decision.outcome !== 'APPROVED' || decision.finalMinor === null) return { writeScopeId: scope.writeScopeId, intentId, decisionId, write: null, pendingWriteId: null };

    // Версия — следующая за последней созданной; монотонность и вытеснение старых записей обеспечивают триггеры
    const { rows: [writeRow] } = await tx.query(
      `INSERT INTO tenant_data.channel_write
         (tenant_id, write_scope_id, field, amount_minor, currency, price_basis, version, origin, price_decision_id, trigger_received_at, budget_scope_key, budget_day)
       SELECT $1, $2, 'PRICE', $3, $4, $5, ss.latest_version_created + 1, 'PRICE_DECISION', $6, $7, s.budget_scope_key,
              -- Бюджет правок [Р-19]: день — текущий местный день витрины; неподтверждённый пояс отклоняет триггер (Р-65)
              CASE WHEN s.budget_scope_key IS NOT NULL THEN (
                SELECT (now() AT TIME ZONE m.time_zone)::date
                  FROM tenant_data.offer_mapping om JOIN platform.marketplace m ON m.channel = s.channel AND m.marketplace = om.marketplace
                 WHERE om.tenant_id = s.tenant_id AND om.price_write_scope_id = s.write_scope_id
                 ORDER BY om.created_at LIMIT 1) END
         FROM tenant_data.write_scope_sync_state ss
         JOIN tenant_data.write_scope s ON s.tenant_id = ss.tenant_id AND s.write_scope_id = ss.write_scope_id
        WHERE ss.tenant_id = $1 AND ss.write_scope_id = $2
       RETURNING channel_write_id, version, idempotency_key`,
      [tenantId, scope.writeScopeId, decision.finalMinor, decision.currency, decision.basis, decisionId, intent.createdAt],
    );
    // Проверка 3 из 3: перевод в отправку в той же транзакции — триггеры перепроверяют пол, потолок и остановку.
    // Запись в полёте у единицы — новая остаётся PENDING; завершение записи в полёте ставит событие scope.write.v1,
    // и её отправляет диспетчер [Р-64, 0036]
    const claimed = await tx.query(
      `UPDATE tenant_data.channel_write w SET status = 'DISPATCHED', attempt_count = attempt_count + 1, dispatched_at = $3
        WHERE w.tenant_id = $1 AND w.channel_write_id = $2 AND w.status = 'PENDING'
          AND NOT EXISTS (SELECT 1 FROM tenant_data.write_scope_sync_state ss
                           WHERE ss.tenant_id = w.tenant_id AND ss.write_scope_id = w.write_scope_id AND ss.in_flight_write_id IS NOT NULL)`,
      [tenantId, writeRow!.channel_write_id, now],
    );
    if (claimed.rowCount !== 1) return { writeScopeId: scope.writeScopeId, intentId, decisionId, write: null, pendingWriteId: writeRow!.channel_write_id };
    return {
      writeScopeId: scope.writeScopeId, intentId, decisionId, pendingWriteId: null,
      write: {
        channelWriteId: writeRow!.channel_write_id as FieldWrite['channelWriteId'],
        writeScope: {
          writeScopeId: scope.writeScopeId as FieldWrite['writeScope']['writeScopeId'],
          field: 'PRICE',
          scopeKey: scope.scopeKey,
          identity: scope.identity,
        },
        version: writeRow!.version,
        idempotencyKey: writeRow!.idempotency_key,
        value: { field: 'PRICE', price: { amountMinor: decision.finalMinor, currency: scope.currency, basis: scope.basis } },
        attemptNo: 1,
      },
    };
  }

  // --- оценка: транзакция 3 ----------------------------------------------------
  async checkPriceBasis(tenantId: string, write: FieldWrite, observedMinor: number, now: Instant) {
    return this.writeQueue.checkPriceBasis(tenantId, write, observedMinor, now);
  }

  async recordDispatch(tenantId: string, write: FieldWrite, outcome: WriteOutcome, now: Instant): Promise<DispatchRecorded> {
    // Те же правила, что у диспетчера [Р-64]: временная ошибка — повтор со сроком, неизвестный итог — сверка обратным чтением,
    // постоянная — завершение с причиной. Раньше отказ канала оставлял запись FAILED без продолжения.
    return this.writeQueue.recordOutcome(tenantId, write, outcome, now, DEFAULT_RETRY_POLICY);
  }

  // --- включение репрайсинга ---------------------------------------------------
  async getPriceScope(tenantId: string, writeScopeId: string): Promise<PriceScopeContext | null> {
    const loaded = await this.loadScopeContext(tenantId, writeScopeId, new Date().toISOString());
    return loaded?.context.scope ?? null;
  }

  async resolveBounds(tenantId: string, writeScopeId: string): Promise<BoundsRead> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(PRICE_BOUNDS_SQL, [tenantId, writeScopeId]);
      const r = rows[0];
      const bounds = (r?.bounds ?? []) as Row[];
      return { bounds: toBounds(bounds, r?.currency ?? '', r?.price_basis ?? 'GROSS'), version: contextVersion(bounds, null, null, null) };
    });
  }

  async setPricingMode(tenantId: string, writeScopeId: string, mode: PriceScopeContext['pricingMode'], userId?: string): Promise<void> {
    await inTenant(this.admin('setPricingMode'), tenantId, (tx) => tx.query(
      `UPDATE tenant_data.write_scope
          SET pricing_mode = $3::text,
              -- Р-77: стратегия остаётся при выключении; только Smart Pricing Kaufland её не имеет [Р-12]
              pricing_strategy_id = CASE WHEN $3::text <> 'KAUFLAND_SMART_PRICING' THEN pricing_strategy_id END,
              pricing_strategy_version = CASE WHEN $3::text <> 'KAUFLAND_SMART_PRICING' THEN pricing_strategy_version END
        WHERE tenant_id = $1 AND write_scope_id = $2`,
      [tenantId, writeScopeId, mode],
      // Р-97: без пользователя сессии база смену режима не принимает
    ), userId);
  }

  // --- правка границ и стратегий из консоли (шаг 21) --------------------------------
  /**
   * Новые версии границ уровня единицы записи одной транзакцией административной роли от имени человека [Р-97]. Роль участника
   * проверяет база (security.require_person_for_admin_write, MANAGE_PRICING); действующие границы до и после — функции базы
   * effective_min_price и effective_max_price. PREVIEW выполняет то же и откатывает транзакцию.
   * Р-88: применение правки больше одной единицы требует второго фактора — проверяется здесь и базой (0078, в пределах одной транзакции;
   * правка, разбитая на транзакции административным сервисом, — принятый риск 17). Экран различий откатывает вставки каждого
   * предложения в своей точке сохранения и второго фактора не требует (находка 1 ревью шага 21).
   */
  async editBounds(tenantId: string, edits: readonly BoundsEditInput[], actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<BoundsEditResult> {
    const ids = edits.map((e) => e.writeScopeId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) return { status: 'INVALID', writeScopeId: duplicate, cause: 'DUPLICATE_SCOPE' };
    for (const e of edits) {
      if (e.minMinor === undefined && e.maxMinor === undefined) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'NOTHING_TO_CHANGE' };
      if ([e.minMinor, e.maxMinor].some((v) => v !== undefined && (!Number.isSafeInteger(v) || v <= 0))) return { status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'AMOUNT_INVALID' };
    }
    if (mode === 'APPLY' && new Set(ids).size > 1 && !actor.mfa && !actor.bulkJobId) return { status: 'MFA_REQUIRED' };
    const effective = async (tx: Tx, writeScopeId: string) => {
      const { rows: [r] } = await tx.query(
        `SELECT tenant_data.effective_min_price($1, $2) AS min, tenant_data.effective_max_price($1, $2) AS max`, [tenantId, writeScopeId]);
      return { minMinor: r?.min === null || r?.min === undefined ? null : Number(r.min), maxMinor: r?.max === null || r?.max === undefined ? null : Number(r.max) };
    };
    /** Действующие границы сразу многих предложений: один запрос вместо запроса на предложение [Р-136] */
    const effectiveAll = async (tx: Tx, scopeIds: readonly string[]) => {
      const { rows } = await tx.query(
        `SELECT t.id AS write_scope_id, tenant_data.effective_min_price($1, t.id) AS min, tenant_data.effective_max_price($1, t.id) AS max
           FROM unnest($2::uuid[]) AS t(id)`, [tenantId, scopeIds]);
      return new Map(rows.map((r) => [r.write_scope_id as string, {
        minMinor: r.min === null || r.min === undefined ? null : Number(r.min),
        maxMinor: r.max === null || r.max === undefined ? null : Number(r.max),
      }]));
    };
    const insertBounds = async (tx: Tx, table: 'min_price' | 'max_price', targets: readonly BoundsEditInput[]) => {
      const withAmount = targets.filter((e) => (table === 'min_price' ? e.minMinor : e.maxMinor) !== undefined);
      if (withAmount.length === 0) return;
      await tx.query(
        `INSERT INTO tenant_data.${table} (tenant_id, scope_type, write_scope_id, currency, price_basis, amount_minor, is_active, version, created_by_membership_id)
         SELECT s.tenant_id, 'WRITE_SCOPE', s.write_scope_id, s.currency, s.price_basis, i.amount, true, coalesce(v.max_version, 0) + 1, $3
           FROM unnest($2::uuid[], $4::bigint[]) AS i(write_scope_id, amount)
           JOIN tenant_data.write_scope s ON s.tenant_id = $1 AND s.write_scope_id = i.write_scope_id AND s.field = 'PRICE'
           LEFT JOIN LATERAL (
             SELECT max(b.version) AS max_version FROM tenant_data.${table} b
              WHERE b.tenant_id = $1 AND b.scope_type = 'WRITE_SCOPE' AND b.write_scope_id = i.write_scope_id
           ) v ON true`,
        [tenantId, withAmount.map((e) => e.writeScopeId), actor.membershipId,
          withAmount.map((e) => (table === 'min_price' ? e.minMinor! : e.maxMinor!))]);
    };
    try {
      return await inTenant(this.admin('editBounds'), tenantId, async (tx) => {
        const { rows: scopes } = await tx.query(
          `SELECT write_scope_id, currency FROM tenant_data.write_scope
            WHERE tenant_id = $1 AND write_scope_id = ANY ($2::uuid[]) AND field = 'PRICE'
            ORDER BY write_scope_id FOR NO KEY UPDATE`, [tenantId, ids]);
        const byScope = new Map(scopes.map((x) => [x.write_scope_id as string, x]));
        const rows: BoundsEditRow[] = [];
        for (const e of edits) {
          if (!byScope.has(e.writeScopeId)) throw new RollbackWith<BoundsEditResult>({ status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'SCOPE_NOT_FOUND' });
        }
        const before = await effectiveAll(tx, ids);
        for (const e of edits) {
          const now = before.get(e.writeScopeId)!;
          if (now.minMinor !== e.expected.minMinor || now.maxMinor !== e.expected.maxMinor) {
            throw new RollbackWith<BoundsEditResult>({ status: 'CONFLICT', writeScopeId: e.writeScopeId, actual: now });
          }
        }
        /**
         * Р-136 (шаг 29), задача D шага 31: экран различий НИЧЕГО НЕ ВСТАВЛЯЕТ. Прежде он вставлял версии границ и откатывал
         * их — а без второго фактора ещё и по одной, в своей точке сохранения, потому что страж массовой правки больше одной
         * в транзакции не пропускает: на каталоге это 10 000 точек сохранения и 72 секунды.
         *
         * Действующая граница — максимум активных полов и минимум активных потолков; подставить предлагаемое значение вместо
         * уровня единицы записи можно прямо в запросе (`effective_*_price_with`). Один запрос на весь каталог, ни одной
         * записи, ни стража, ни аудита — и предпросмотр перестал зависеть от того, есть ли у сессии второй фактор.
         */
        if (mode === 'PREVIEW') {
          /**
           * Право на экран различий проверяется ЯВНО (шаг 31). Раньше его проверял отказ базы на вставку версии границы: пока
           * предпросмотр писал и откатывал, зритель упирался в право на запись. Предпросмотр перестал писать — и вместе с
           * записью исчезла бы проверка, если бы её не назвали здесь. Роль читается из членства, как и у всякого действия [Р-90].
           */
          const { rows: [permission] } = await tx.query(
            `SELECT security.pricing_permission(m.role, 'MANAGE_PRICING') AS allowed FROM tenant_data.membership m
              WHERE m.tenant_id = $1 AND m.membership_id = $2 AND m.user_id = $3 AND m.status = 'ACTIVE'`,
            [tenantId, actor.membershipId, actor.userId]);
          if (permission?.allowed !== true) throw new RollbackWith<BoundsEditResult>({ status: 'FORBIDDEN' });
          const { rows: computed } = await tx.query(
            `SELECT e.id AS write_scope_id,
                    tenant_data.effective_min_price_with($1, e.id, e.min) AS min,
                    tenant_data.effective_max_price_with($1, e.id, e.max) AS max
               FROM unnest($2::uuid[], $3::bigint[], $4::bigint[]) AS e(id, min, max)`,
            [tenantId, ids, edits.map((e) => e.minMinor ?? null), edits.map((e) => e.maxMinor ?? null)]);
          const afterById = new Map(computed.map((r) => [r.write_scope_id as string, {
            minMinor: r.min === null ? null : Number(r.min), maxMinor: r.max === null ? null : Number(r.max),
          }]));
          for (const e of edits) {
            const a = afterById.get(e.writeScopeId)!;
            if (a.minMinor !== null && a.maxMinor !== null && a.minMinor > a.maxMinor) {
              throw new RollbackWith<BoundsEditResult>({ status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'MIN_ABOVE_MAX' });
            }
            rows.push({ writeScopeId: e.writeScopeId, currency: byScope.get(e.writeScopeId)!.currency, before: before.get(e.writeScopeId)!, after: a });
          }
          // Откатывать нечего: предпросмотр только читал. Транзакция закрывается как обычно, без точек сохранения
          return { status: 'PREVIEWED', rows } satisfies BoundsEditResult;
        } else {
          await insertBounds(tx, 'min_price', edits);
          await insertBounds(tx, 'max_price', edits);
          const after = await effectiveAll(tx, ids);
          for (const e of edits) {
            const a = after.get(e.writeScopeId)!;
            if (a.minMinor !== null && a.maxMinor !== null && a.minMinor > a.maxMinor) {
              throw new RollbackWith<BoundsEditResult>({ status: 'INVALID', writeScopeId: e.writeScopeId, cause: 'MIN_ABOVE_MAX' });
            }
            rows.push({ writeScopeId: e.writeScopeId, currency: byScope.get(e.writeScopeId)!.currency, before: before.get(e.writeScopeId)!, after: a });
          }
        }
        return { status: 'APPLIED', rows } satisfies BoundsEditResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      if (windowRefused(error)) return { status: 'MFA_REQUIRED', window: true };
      if (secondFactorRefused(error)) return { status: 'MFA_REQUIRED' };
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /**
   * Р-134, Р-135 (шаг 28): массовый импорт себестоимости. Предпросмотр только читает: он проверяет, что офферы на месте и валюта их,
   * и ничего не пишет. Применение — одна транзакция: пакет `cost_import` и все его строки; база отказывает, если строк пришло не
   * столько, сколько пакет объявил (частичного применения нет), и если у сессии нет второго фактора.
   */
  async importCosts(tenantId: string, batch: CostImportBatch, actor: AdminActor, mode: 'PREVIEW' | 'APPLY'): Promise<CostImportResult> {
    if (batch.rows.length === 0) return { status: 'INVALID', cause: 'NO_ROWS' };
    const ids = batch.rows.map((r) => r.writeScopeId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) return { status: 'INVALID', cause: 'DUPLICATE_SCOPE', writeScopeId: duplicate };
    for (const r of batch.rows) {
      const amounts = [r.unitCostMinor, r.fixedFeeMinor ?? 0];
      if (amounts.some((v) => !Number.isSafeInteger(v) || v < 0)) return { status: 'INVALID', cause: 'AMOUNT_INVALID', writeScopeId: r.writeScopeId };
      if (r.feeRateBp !== undefined && (!Number.isSafeInteger(r.feeRateBp) || r.feeRateBp < 0 || r.feeRateBp >= 10_000)) {
        return { status: 'INVALID', cause: 'AMOUNT_INVALID', writeScopeId: r.writeScopeId };
      }
    }
    if (mode === 'APPLY' && !actor.mfa && !actor.bulkJobId) return { status: 'MFA_REQUIRED' };
    try {
      return await inTenant(this.admin('importCosts'), tenantId, async (tx) => {
        // Область себестоимости — та же, что у пола маржи (0051): товар оффера, его аккаунт и витрина из привязки
        const { rows: scopes } = await tx.query(
          `SELECT s.write_scope_id, s.product_id, s.channel_account_id, s.currency,
                  (SELECT om.marketplace FROM tenant_data.offer_mapping om
                    WHERE om.tenant_id = s.tenant_id AND om.price_write_scope_id = s.write_scope_id
                    ORDER BY om.created_at LIMIT 1) AS marketplace
             FROM tenant_data.write_scope s
            WHERE s.tenant_id = $1 AND s.write_scope_id = ANY ($2::uuid[]) AND s.field = 'PRICE'
            ORDER BY s.write_scope_id FOR NO KEY UPDATE`, [tenantId, ids]);
        for (const r of batch.rows) {
          const scope = scopes.find((x) => x.write_scope_id === r.writeScopeId);
          if (!scope) throw new RollbackWith<CostImportResult>({ status: 'INVALID', cause: 'SCOPE_NOT_FOUND', writeScopeId: r.writeScopeId });
          if (scope.currency !== r.currency) throw new RollbackWith<CostImportResult>({ status: 'INVALID', cause: 'CURRENCY_MISMATCH', writeScopeId: r.writeScopeId });
        }
        const offers = new Set(batch.rows.map((r) => r.writeScopeId)).size;
        if (mode === 'PREVIEW') throw new RollbackWith<CostImportResult>({ status: 'PREVIEWED', rows: batch.rows.length, offers });
        const { rows: [created] } = await tx.query(
          `INSERT INTO tenant_data.cost_import (tenant_id, created_by_membership_id, source_name, source_format, row_count, fingerprint, skipped_rows)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING cost_import_id`,
          [tenantId, actor.membershipId, batch.sourceName, batch.sourceFormat, batch.rows.length, batch.fingerprint, batch.skippedRows]);
        const importId = String(created.cost_import_id);
        /**
         * Р-136 (шаг 29): применение — ПАКЕТНЫМИ запросами, а не строкой на строку. Живой прогон через консоль показал 11,7 секунды
         * на 10 000 строк: столько продавец смотрит на «применяется…», не зная, случилось ли что-нибудь. Поиск области оффера тоже
         * был квадратичным (`scopes.find` внутри цикла, ревью шага 28, замечание 21) — теперь это отображение.
         */
        const byScope = new Map(scopes.map((x) => [x.write_scope_id as string, x]));
        const target = batch.rows.map((r) => ({ r, scope: byScope.get(r.writeScopeId)! }));
        await tx.query(
          `INSERT INTO tenant_data.cost_profile (tenant_id, product_id, channel_account_id, marketplace, version, valid_from, currency,
                                                 purchase_cost_minor, inbound_logistics_minor, packaging_minor, handling_minor,
                                                 outbound_shipping_minor, other_fixed_minor, source, created_by_membership_id, cost_import_id)
           SELECT $1, i.product_id, i.channel_account_id, i.marketplace,
                  coalesce(p.max_version, 0) + row_number() OVER (PARTITION BY i.product_id, i.channel_account_id, i.marketplace ORDER BY i.ord),
                  now(), i.currency, i.unit_cost,
                  coalesce(p.inbound, 0), coalesce(p.packaging, 0), coalesce(p.handling, 0), coalesce(p.outbound, 0), coalesce(p.other_fixed, 0),
                  'IMPORT', $2, $3
             FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::text[], $8::bigint[])
                  WITH ORDINALITY AS i(product_id, channel_account_id, marketplace, currency, unit_cost, ord)
             LEFT JOIN LATERAL (
               SELECT max(c.version) AS max_version,
                      (array_agg(c.inbound_logistics_minor ORDER BY c.version DESC))[1] AS inbound,
                      (array_agg(c.packaging_minor ORDER BY c.version DESC))[1] AS packaging,
                      (array_agg(c.handling_minor ORDER BY c.version DESC))[1] AS handling,
                      (array_agg(c.outbound_shipping_minor ORDER BY c.version DESC))[1] AS outbound,
                      (array_agg(c.other_fixed_minor ORDER BY c.version DESC))[1] AS other_fixed
                 FROM tenant_data.cost_profile c
                WHERE c.tenant_id = $1 AND c.product_id = i.product_id
                  AND c.channel_account_id IS NOT DISTINCT FROM i.channel_account_id
                  AND c.marketplace IS NOT DISTINCT FROM i.marketplace
             ) p ON true`,
          [tenantId, actor.membershipId, importId,
            target.map((t) => t.scope.product_id), target.map((t) => t.scope.channel_account_id), target.map((t) => t.scope.marketplace),
            target.map((t) => t.r.currency), target.map((t) => t.r.unitCostMinor)]);
        /**
         * Комиссия канала — оценка оффера [Р-32]: в файле её может не быть, и тогда прежняя оценка остаётся. Ревью шага 28,
         * находка 5: колонки в файле может быть ОДНА, и вторую составляющую тогда нельзя обнулять — она сливается с прежней.
         * Если ни одной составляющей нет ни в файле, ни в базе, пол маржи остаётся неcчитаемым (`FEE_ESTIMATE_MISSING`,
         * 0051) — это прежнее fail-closed поведение, а не заниженный пол. Версия называет пакет импорта: число набрано
         * продавцом в таблице, а не взято из тарифа в репозитории (OQ-197).
         */
        const withFee = batch.rows.filter((r) => r.fixedFeeMinor !== undefined || r.feeRateBp !== undefined);
        if (withFee.length > 0) {
          await tx.query(
            `INSERT INTO channel_data.fee_estimate (tenant_id, write_scope_id, source, fee_model, computed_at, valid_until)
             SELECT $1, i.write_scope_id, 'SELLER_DECLARED',
                    jsonb_strip_nulls(jsonb_build_object('feeRateBp', i.fee_rate_bp, 'fixedFeeMinor', i.fixed_fee_minor)),
                    now(), now() + interval '90 days'
               FROM unnest($2::uuid[], $3::int[], $4::bigint[]) AS i(write_scope_id, fee_rate_bp, fixed_fee_minor)
             ON CONFLICT (tenant_id, write_scope_id, source) DO UPDATE
               SET fee_model = channel_data.fee_estimate.fee_model || EXCLUDED.fee_model,
                   computed_at = EXCLUDED.computed_at, valid_until = EXCLUDED.valid_until`,
            [tenantId, withFee.map((r) => r.writeScopeId),
              withFee.map((r) => r.feeRateBp ?? null), withFee.map((r) => r.fixedFeeMinor ?? null)]);
        }
        return { status: 'APPLIED', importId, rows: batch.rows.length, offers } satisfies CostImportResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      if (windowRefused(error)) return { status: 'MFA_REQUIRED', window: true };
      if (secondFactorRefused(error)) return { status: 'MFA_REQUIRED' };
      const code = (error as { code?: string }).code;
      if (code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /**
   * Р-139 (шаг 30): массовая операция продавца — фоновое задание. Создаёт его человек и предъявляет второй фактор [Р-135];
   * применяет фоновый процесс, называя базе задание (`app.bulk_job_id`), — иначе стражи массового изменения его не пропустят.
   */
  async createBulkJob(tenantId: string, input: BulkJobInput, actor: AdminActor): Promise<BulkJobCreated> {
    try {
      return await inTenant(this.admin('createBulkJob'), tenantId, async (tx) => {
        const { rows: [row] } = await tx.query(
          `INSERT INTO tenant_data.bulk_job (tenant_id, kind, params, total_items, phase, created_by_membership_id)
           VALUES ($1, $2, $3::jsonb, $4, 'PREPARING', $5) RETURNING bulk_job_id, created_at`,
          [tenantId, input.kind, JSON.stringify(input.params), input.totalItems ?? null, actor.membershipId]);
        return { status: 'CREATED', jobId: String(row.bulk_job_id), createdAt: String(row.created_at) } satisfies BulkJobCreated;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      if (secondFactorRefused(error)) return { status: 'MFA_REQUIRED' };
      // P0003 — предел очереди тенанта (0111): это не ошибка, а состояние, и продавцу о нём говорят словами
      if ((error as { code?: string }).code === 'P0003') return { status: 'QUEUE_FULL' };
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  /**
   * Взять задание в работу: самое давнее ожидающее или прерванное, а также то, чья аренда истекла (процесс упал). Аренда — как у
   * периодических работ [Р-126]: перехват чужой живой аренды база отклоняет.
   */
  async claimBulkJob(tenantId: string, owner: string, leaseSeconds: number): Promise<BulkJobRow | null> {
    return inTenant(this.bulkWorker('claimBulkJob'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `WITH next AS (
           SELECT bulk_job_id FROM tenant_data.bulk_job
            WHERE tenant_id = $1 AND (status IN ('PENDING', 'INTERRUPTED') OR (status = 'RUNNING' AND lease_until <= now()))
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         UPDATE tenant_data.bulk_job j
            SET status = 'RUNNING', lease_owner = $2, lease_until = now() + make_interval(secs => $3::int),
                started_at = coalesce(j.started_at, now()), attempts = j.attempts + 1, phase = 'PREPARING', done_items = 0
           FROM next WHERE j.tenant_id = $1 AND j.bulk_job_id = next.bulk_job_id
        RETURNING ${BULK_JOB_COLUMNS_OF_J}`, [tenantId, owner, leaseSeconds]);
      return rows.length === 0 ? null : toBulkJob(rows[0]!);
    }, undefined, { leaseOwner: owner });
  }

  /** Ход задания: пишется ОТДЕЛЬНОЙ транзакцией, поэтому переживает откат самой работы и виден продавцу во время применения */
  async updateBulkJobProgress(tenantId: string, jobId: string, owner: string, progress: BulkJobProgress): Promise<boolean> {
    return inTenant(this.bulkWorker('updateBulkJobProgress'), tenantId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE tenant_data.bulk_job
            SET phase = coalesce($4, phase), done_items = coalesce($5, done_items), total_items = coalesce($6, total_items),
                lease_until = now() + make_interval(secs => $7::int)
          WHERE tenant_id = $1 AND bulk_job_id = $2 AND lease_owner = $3 AND status = 'RUNNING'`,
        [tenantId, jobId, owner, progress.phase ?? null, progress.done ?? null, progress.total ?? null, progress.leaseSeconds ?? 60]);
      // Ноль строк — аренда уже не наша: задание взял другой процесс или оно завершено [находка 3 ревью шага 30]
      return (rowCount ?? 0) > 0;
    }, undefined, { leaseOwner: owner });
  }

  /** Итог задания: успех с результатом, отказ с причиной или возврат в очередь (процесс упал посреди применения) */
  async finishBulkJob(tenantId: string, jobId: string, owner: string, outcome: BulkJobOutcome): Promise<boolean> {
    return inTenant(this.bulkWorker('finishBulkJob'), tenantId, async (tx) => {
      if (outcome.status === 'INTERRUPTED') {
        const { rowCount } = await tx.query(
          `UPDATE tenant_data.bulk_job SET status = 'INTERRUPTED', lease_owner = NULL, lease_until = NULL, phase = NULL
            WHERE tenant_id = $1 AND bulk_job_id = $2 AND lease_owner = $3`, [tenantId, jobId, owner]);
        return (rowCount ?? 0) > 0;
      }
      const { rowCount } = await tx.query(
        `UPDATE tenant_data.bulk_job
            SET status = $4, result = $5::jsonb, error_code = $6, phase = 'DONE', finished_at = now(),
                lease_owner = NULL, lease_until = NULL
          WHERE tenant_id = $1 AND bulk_job_id = $2 AND lease_owner = $3`,
        [tenantId, jobId, owner, outcome.status, outcome.result === undefined ? null : JSON.stringify(outcome.result),
          outcome.status === 'FAILED' ? outcome.errorCode : null]);
      // Ноль строк — итог не записан: аренду отобрали, пока шла работа. Вызывающий обязан об этом узнать
      return (rowCount ?? 0) > 0;
    }, undefined, { leaseOwner: owner });
  }

  /** Задания тенанта: история для экрана — только свои [Р-16] */
  async listBulkJobs(tenantId: string, limit = 20): Promise<BulkJobRow[]> {
    return inTenant(this.admin('listBulkJobs'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${BULK_JOB_COLUMNS} FROM tenant_data.bulk_job WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`, [tenantId, limit]);
      return rows.map(toBulkJob);
    });
  }

  async bulkJob(tenantId: string, jobId: string): Promise<BulkJobRow | null> {
    return inTenant(this.admin('bulkJob'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${BULK_JOB_COLUMNS} FROM tenant_data.bulk_job WHERE tenant_id = $1 AND bulk_job_id = $2`, [tenantId, jobId]);
      return rows.length === 0 ? null : toBulkJob(rows[0]!);
    });
  }

  /** Файл, подготовленный заданием: доказательная история цен [OQ-202] */
  async saveBulkJobArtifact(tenantId: string, jobId: string, artifact: BulkJobArtifact, leaseOwner: string): Promise<void> {
    await inTenant(this.bulkWorker('saveBulkJobArtifact'), tenantId, async (tx) => {
      await tx.query(
        /**
         * Повтор задания перезаписывает свой файл (находка 7 ревью шага 30): процесс, убитый ПОСЛЕ записи файла и ДО записи
         * итога, оставлял строку, о которую следующая попытка разбивалась первичным ключом, — и продавец читал «23505».
         */
        `INSERT INTO tenant_data.bulk_job_artifact (tenant_id, bulk_job_id, file_name, content_type, content, sha256, rows_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, bulk_job_id) DO UPDATE
            SET file_name = excluded.file_name, content_type = excluded.content_type, content = excluded.content,
                sha256 = excluded.sha256, rows_count = excluded.rows_count, created_at = now()`,
        [tenantId, jobId, artifact.fileName, artifact.contentType, artifact.content, artifact.sha256, artifact.rows]);
    }, undefined, { leaseOwner });
  }

  // --- онбординг [Р-149], канал без доступов [Р-150] ---------------------------------------------------------------

  async onboardingProgress(tenantId: string): Promise<OnboardingProgressRow | null> {
    return inTenant(this.admin('onboardingProgress'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT scope_write_scope_ids, started_at, updated_at FROM tenant_data.onboarding_progress WHERE tenant_id = $1`, [tenantId]);
      const r = rows[0];
      return r === undefined ? null : {
        scopeWriteScopeIds: (r.scope_write_scope_ids as string[] | null) ?? null,
        startedAt: String(r.started_at), updatedAt: String(r.updated_at),
      };
    });
  }

  async saveOnboardingProgress(tenantId: string, input: OnboardingProgressInput, actor: AdminActor): Promise<'SAVED' | 'FORBIDDEN'> {
    try {
      await inTenant(this.admin('saveOnboardingProgress'), tenantId, async (tx) => {
        // Одна строка на тенанта; хранится только сужение набора [Р-131]: список сужает, `null` снимает
        await tx.query(
          `INSERT INTO tenant_data.onboarding_progress (tenant_id, scope_write_scope_ids, updated_by_membership_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id) DO UPDATE
             SET scope_write_scope_ids = excluded.scope_write_scope_ids,
                 updated_at = now(), updated_by_membership_id = excluded.updated_by_membership_id`,
          [tenantId, input.scopeWriteScopeIds, actor.membershipId]);
      }, actor.userId, { mfa: actor.mfa });
      return 'SAVED';
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return 'FORBIDDEN';
      throw error;
    }
  }

  async tenantIsDemo(tenantId: string): Promise<boolean> {
    return inTenant(this.admin('tenantIsDemo'), tenantId, async (tx) => {
      const { rows } = await tx.query(`SELECT demo FROM tenant_data.tenant WHERE tenant_id = $1`, [tenantId]);
      return rows[0]?.demo === true;
    });
  }

  async onboardingStatus(tenantId: string): Promise<OnboardingStepStatus[]> {
    return inTenant(this.admin('onboardingStatus'), tenantId, async (tx) => {
      const { rows } = await tx.query(`SELECT step, done_count, total_count, done, awaiting FROM tenant_data.onboarding_status($1)`, [tenantId]);
      return rows.map((r) => ({
        step: r.step as OnboardingStepStatus['step'], doneCount: Number(r.done_count), totalCount: Number(r.total_count),
        done: r.done === true, awaiting: r.awaiting === true,
      }));
    });
  }

  async scopesWithCost(tenantId: string): Promise<string[]> {
    return inTenant(this.admin('scopesWithCost'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT s.write_scope_id FROM tenant_data.write_scope s
          WHERE s.tenant_id = $1 AND s.field = 'PRICE' AND s.status <> 'RETIRED' AND tenant_data.write_scope_cost_ready($1, s.write_scope_id, now())
          ORDER BY s.write_scope_id`, [tenantId]);
      return rows.map((r) => r.write_scope_id as string);
    });
  }

  async channelAccounts(tenantId: string): Promise<ChannelAccountRow[]> {
    return inTenant(this.admin('channelAccounts'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT channel_account_id, channel, display_name, marketplaces, auth_status, access_blockers
           FROM tenant_data.channel_account WHERE tenant_id = $1 AND disconnected_at IS NULL ORDER BY connected_at, channel_account_id`, [tenantId]);
      return rows.map((r) => ({
        channelAccountId: r.channel_account_id as string, channel: r.channel as string, displayName: (r.display_name as string | null) ?? null,
        marketplaces: r.marketplaces as string[], authStatus: r.auth_status as ChannelAccountRow['authStatus'],
        accessBlockers: (r.access_blockers as ChannelAccountRow['accessBlockers']) ?? [],
      }));
    });
  }

  async bulkJobArtifact(tenantId: string, jobId: string): Promise<BulkJobArtifact | null> {
    return inTenant(this.admin('bulkJobArtifact'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT file_name, content_type, content, sha256, rows_count FROM tenant_data.bulk_job_artifact
          WHERE tenant_id = $1 AND bulk_job_id = $2`, [tenantId, jobId]);
      const r = rows[0];
      return r === undefined ? null
        : { fileName: r.file_name, contentType: r.content_type, content: r.content, sha256: r.sha256, rows: Number(r.rows_count) };
    });
  }

  /** Готовые файлы списка заданий — только имена и размеры: содержимое в списке не нужно и весит десятки мегабайт */
  async bulkJobArtifactSummaries(tenantId: string, jobIds: readonly string[]): Promise<Map<string, { fileName: string; rows: number; sha256: string }>> {
    if (jobIds.length === 0) return new Map();
    return inTenant(this.admin('bulkJobArtifactSummaries'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT bulk_job_id, file_name, rows_count, sha256 FROM tenant_data.bulk_job_artifact
          WHERE tenant_id = $1 AND bulk_job_id = ANY ($2::uuid[])`, [tenantId, jobIds]);
      return new Map(rows.map((r) => [String(r.bulk_job_id), { fileName: r.file_name as string, rows: Number(r.rows_count), sha256: r.sha256 as string }]));
    });
  }

  /** OQ-207: отмена ожидающего задания — действие человека, поэтому административной ролью и от его имени [Р-97] */
  async cancelBulkJob(tenantId: string, jobId: string, actor: AdminActor): Promise<'CANCELLED' | 'NOT_WAITING' | 'FORBIDDEN'> {
    try {
      return await inTenant(this.admin('cancelBulkJob'), tenantId, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE tenant_data.bulk_job SET status = 'CANCELLED', finished_at = now()
            WHERE tenant_id = $1 AND bulk_job_id = $2 AND status = 'PENDING'`, [tenantId, jobId]);
        // Ноль строк — задание уже взято в работу или завершено: отменять нечего, и это не ошибка, а состояние
        return (rowCount ?? 0) > 0 ? 'CANCELLED' : 'NOT_WAITING';
      }, actor.userId, { mfa: actor.mfa });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return 'FORBIDDEN';
      throw error;
    }
  }

  /** Р-120: наблюдения собственного ценообразования канала — путь обнаружения офферов, одна вставка */
  async recordOfferChannelPricing(tenantId: string, channelAccountId: string, observations: readonly OfferChannelPricingObservation[]): Promise<number> {
    if (observations.length === 0) return 0;
    return this.tx(tenantId, async (tx) => {
      const { rowCount } = await tx.query(
        `INSERT INTO channel_data.offer_channel_pricing (tenant_id, channel_account_id, channel, marketplace, external_sku, automated_pricing, channel_bounds, source, observed_at)
         SELECT $1, a.channel_account_id, a.channel, o.marketplace, o.external_sku, o.automated_pricing, o.channel_bounds, o.source, o.observed_at
           FROM tenant_data.channel_account a
           CROSS JOIN jsonb_to_recordset($3::jsonb) AS o(marketplace text, external_sku text, automated_pricing boolean, channel_bounds boolean, source text, observed_at timestamptz)
          WHERE a.tenant_id = $1 AND a.channel_account_id = $2`,
        [tenantId, channelAccountId, JSON.stringify(observations.map((o) => ({
          marketplace: o.marketplace, external_sku: o.externalSku, automated_pricing: o.automatedPricing, channel_bounds: o.channelBounds, source: o.source, observed_at: o.observedAt,
        })))]);
      return rowCount ?? 0;
    });
  }

  /** Шаг 23: состояние PRICING_HEALTH оффера (0083) — данные канала, 18 месяцев */
  /** OQ-171: запись журнала уведомлений в переданной транзакции; false — уведомление уже записано */
  private async insertNotification(tx: Tx, tenantId: string, entry: InboundNotificationEntry): Promise<boolean> {
    const { rowCount } = await tx.query(
      `INSERT INTO channel_data.inbound_notification (tenant_id, channel_account_id, channel, notification_id, notification_type, event_time, received_at)
       SELECT $1, a.channel_account_id, a.channel, $3, $4, $5, $6 FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2
       ON CONFLICT (tenant_id, channel, notification_id) DO NOTHING`,
      [tenantId, entry.channelAccountId, entry.notificationId, entry.notificationType, entry.eventTime, entry.receivedAt]);
    return (rowCount ?? 0) > 0;
  }

  async recordPricingHealth(tenantId: string, channelAccountId: string, health: PricingHealthObservation, notification?: InboundNotificationEntry): Promise<'RECORDED' | 'DUPLICATE_NOTIFICATION'> {
    return this.tx(tenantId, async (tx) => {
      if (notification && !(await this.insertNotification(tx, tenantId, notification))) return 'DUPLICATE_NOTIFICATION' as const;
      await tx.query(
        `INSERT INTO channel_data.offer_pricing_health (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, issue_type, event_time,
                                                        competitive_price_threshold_minor, currency, notification_id)
         SELECT $1, a.channel_account_id, a.channel, $3, $4, $5, $6, $7, $8, $9, $10 FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2`,
        [tenantId, channelAccountId, health.marketplace, health.channelProductRef, health.condition, health.issueType, health.occurredAt,
          health.competitivePriceThreshold?.amountMinor ?? null, health.competitivePriceThreshold?.currency ?? null, health.sourceEventId]);
      return 'RECORDED' as const;
    });
  }

  /** Шаг 23: журнал обработанных уведомлений (0083) — уникальность по тенанту, каналу аккаунта и идентификатору уведомления */
  async wasNotificationProcessed(tenantId: string, channelAccountId: string, notificationId: string): Promise<boolean> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT 1 FROM channel_data.inbound_notification n JOIN tenant_data.channel_account a ON a.tenant_id = n.tenant_id AND a.channel = n.channel
          WHERE n.tenant_id = $1 AND a.channel_account_id = $2 AND n.notification_id = $3`, [tenantId, channelAccountId, notificationId]);
      return rows.length > 0;
    });
  }

  async markNotificationProcessed(tenantId: string, entry: InboundNotificationEntry): Promise<void> {
    await this.tx(tenantId, async (tx) => { await this.insertNotification(tx, tenantId, entry); });
  }

  /** Находка 4 ревью шага 21: сохраняется то превью, что видел человек, — стратегии единиц с тех пор не менялись */
  private static async assertExpected(tx: Tx, tenantId: string, expected: StrategySaveInput['expected']): Promise<Row[]> {
    if (!expected) return [];
    const { rows: current } = await tx.query(
      `SELECT write_scope_id, pricing_strategy_id, pricing_strategy_version, pricing_mode FROM tenant_data.write_scope
        WHERE tenant_id = $1 AND write_scope_id = ANY ($2::uuid[]) AND field = 'PRICE' ORDER BY write_scope_id FOR NO KEY UPDATE`,
      [tenantId, expected.map((x) => x.writeScopeId)]);
    for (const x of expected) {
      const c = current.find((r) => r.write_scope_id === x.writeScopeId);
      if (!c) throw new RollbackWith({ status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
      if ((c.pricing_strategy_id ?? null) !== x.strategyId || (c.pricing_strategy_version === null ? null : Number(c.pricing_strategy_version)) !== x.version) {
        throw new RollbackWith({ status: 'CONFLICT', writeScopeId: x.writeScopeId });
      }
    }
    return current;
  }

  /** Отказы базы при назначении стратегии (0082, 0085) — в причины хранилища */
  private static strategyRefusal(error: unknown): StrategySaveResult | null {
    if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
    const message = String((error as Error).message ?? '');
    if (/is not available on channel/.test(message)) return { status: 'INVALID', cause: 'STRATEGY_UNAVAILABLE' };
    if (/cannot be assigned \(OQ-169\)/.test(message)) return { status: 'INVALID', cause: 'VERSION_NOT_ACTIVE' };
    const owned = /write_scope ([0-9a-f-]{36}) has channel-owned pricing/.exec(message);
    if (owned) return { status: 'INVALID', cause: 'CHANNEL_PRICING_ACTIVE', writeScopeId: owned[1]! };
    return null;
  }

  // --- Omnibus [Р-123] (шаг 24) --------------------------------------------------------
  private static omnibusRow(r: Row): OmnibusPriorPrice {
    const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : v === null || v === undefined ? null : String(v));
    return {
      status: r.status, lowestMinor: r.lowest_minor === null ? null : Number(r.lowest_minor), windowFrom: day(r.window_from), windowTo: day(r.window_to),
      timeZone: r.day_tz ?? null, historySince: r.history_since ? iso(r.history_since) : null,
      historyDays: r.history_days === null || r.history_days === undefined ? 0 : Number(r.history_days), externalChanges: r.external_changes === null || r.external_changes === undefined ? 0 : Number(r.external_changes),
    };
  }

  async omnibusCheck(tenantId: string, writeScopeId: string, startsAt: Instant): Promise<OmnibusPriorPrice> {
    return inTenant(this.admin('omnibusCheck'), tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('SELECT * FROM tenant_data.omnibus_lowest_prior_price($1, $2, $3)', [tenantId, writeScopeId, startsAt]);
      return PgPricingStore.omnibusRow(r);
    });
  }

  async announceDiscount(tenantId: string, input: DiscountAnnouncementInput, actor: AdminActor): Promise<DiscountAnnounceResult> {
    try {
      return await inTenant(this.admin('announceDiscount'), tenantId, async (tx) => {
        const { rows: [r] } = await tx.query(
          `INSERT INTO tenant_data.discount_announcement (tenant_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, ends_at, created_by_membership_id, check_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'OK')
           RETURNING discount_announcement_id, created_at, check_status, lowest_prior_minor, window_from, window_to, day_tz, covered_since, history_days, external_changes`,
          [tenantId, input.writeScopeId, input.referencePriceMinor, input.salePriceMinor, input.currency, input.startsAt, input.endsAt, actor.membershipId]);

        return {
          status: 'ANNOUNCED', announcement: {
            ...input, announcementId: r.discount_announcement_id, createdAt: iso(r.created_at), createdByMembershipId: actor.membershipId,
            check: PgPricingStore.omnibusRow({ status: r.check_status, lowest_minor: r.lowest_prior_minor, window_from: r.window_from, window_to: r.window_to, day_tz: r.day_tz, history_since: r.covered_since, history_days: r.history_days, external_changes: r.external_changes }),
          },
        } satisfies DiscountAnnounceResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      const message = String((error as Error).message ?? '');
      if (/is above the lowest price/.test(message)) return { status: 'VIOLATION', check: await this.omnibusCheck(tenantId, input.writeScopeId, input.startsAt) };
      if (/is not the currency of price write_scope/.test(message)) return { status: 'INVALID', cause: 'CURRENCY_MISMATCH' };
      if (/before the current storefront day/.test(message)) return { status: 'INVALID', cause: 'STARTS_BEFORE_TODAY' };
      if (/discount_announcement_prices/.test(message)) return { status: 'INVALID', cause: 'PRICES_INVALID' };
      if (/discount_announcement_period/.test(message)) return { status: 'INVALID', cause: 'PERIOD_INVALID' };
      if (/violates foreign key constraint/.test(message)) return { status: 'INVALID', cause: 'SCOPE_NOT_FOUND' };
      throw error;
    }
  }

  async discountAnnouncements(tenantId: string): Promise<DiscountAnnouncementRow[]> {
    return inTenant(this.admin('discountAnnouncements'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT discount_announcement_id, write_scope_id, reference_price_minor, sale_price_minor, currency, starts_at, ends_at, created_at, created_by_membership_id,
                check_status, lowest_prior_minor, window_from, window_to, day_tz, covered_since, history_days, external_changes
           FROM tenant_data.discount_announcement WHERE tenant_id = $1 ORDER BY starts_at DESC, created_at DESC`, [tenantId]);
      return rows.map((r): DiscountAnnouncementRow => ({
        announcementId: r.discount_announcement_id, writeScopeId: r.write_scope_id, referencePriceMinor: Number(r.reference_price_minor), salePriceMinor: Number(r.sale_price_minor),
        currency: r.currency, startsAt: iso(r.starts_at), endsAt: r.ends_at ? iso(r.ends_at) : null, createdAt: iso(r.created_at), createdByMembershipId: r.created_by_membership_id,
        check: PgPricingStore.omnibusRow({ status: r.check_status, lowest_minor: r.lowest_prior_minor, window_from: r.window_from, window_to: r.window_to, day_tz: r.day_tz, history_since: r.covered_since, history_days: r.history_days, external_changes: r.external_changes }),
      }));
    });
  }

  async priceEvidence(tenantId: string, range: { from: string; to: string; writeScopeIds?: string[] }): Promise<PriceEvidenceDay[]> {
    return inTenant(this.admin('priceEvidence'), tenantId, async (tx) => {
      const { rows } = await tx.query(
        `WITH scopes AS (
           SELECT s.write_scope_id, tenant_data.write_scope_time_zone(s.tenant_id, s.write_scope_id) AS tz, s.currency, s.price_basis
             FROM tenant_data.write_scope s
            WHERE s.tenant_id = $1 AND s.field = 'PRICE' AND ($4::uuid[] IS NULL OR s.write_scope_id = ANY ($4::uuid[]))),
         closed AS (
           SELECT d.write_scope_id, d.price_day AS day, d.day_tz AS tz, d.currency, d.price_basis, d.min_amount_minor AS min_minor, d.max_amount_minor AS max_minor,
                  d.first_amount_minor AS first_minor, d.last_amount_minor AS last_minor, d.change_count AS changes, 'CLOSED' AS source, d.corrected, d.correction_reason
             FROM tenant_data.price_daily_effective d JOIN scopes s ON s.write_scope_id = d.write_scope_id
            WHERE d.tenant_id = $1 AND d.price_type IN ('REGULAR', 'SALE') AND d.price_day BETWEEN $2::date AND $3::date),
         open AS (
           SELECT h.write_scope_id, (h.accepted_at AT TIME ZONE s.tz)::date AS day, s.tz, h.currency, h.price_basis,
                  min(h.amount_minor) AS min_minor, max(h.amount_minor) AS max_minor,
                  (array_agg(h.amount_minor ORDER BY h.accepted_at, h.price_history_id))[1] AS first_minor,
                  (array_agg(h.amount_minor ORDER BY h.accepted_at DESC, h.price_history_id DESC))[1] AS last_minor,
                  count(*)::int AS changes, 'OPEN' AS source, false AS corrected, NULL::text AS correction_reason
             FROM tenant_data.price_history h JOIN scopes s ON s.write_scope_id = h.write_scope_id AND s.tz IS NOT NULL
            WHERE h.tenant_id = $1 AND h.price_type IN ('REGULAR', 'SALE')
              AND NOT EXISTS (SELECT 1 FROM tenant_data.price_history c WHERE c.tenant_id = h.tenant_id AND c.corrects_price_history_id = h.price_history_id)
              AND (h.accepted_at AT TIME ZONE s.tz)::date BETWEEN $2::date AND $3::date
              AND NOT EXISTS (SELECT 1 FROM tenant_data.price_daily d WHERE d.tenant_id = h.tenant_id AND d.write_scope_id = h.write_scope_id
                                AND d.price_type = h.price_type AND d.price_day = (h.accepted_at AT TIME ZONE s.tz)::date)
            GROUP BY h.write_scope_id, (h.accepted_at AT TIME ZONE s.tz)::date, s.tz, h.currency, h.price_basis)
         SELECT * FROM closed UNION ALL SELECT * FROM open ORDER BY write_scope_id, day`,
        [tenantId, range.from, range.to, range.writeScopeIds ?? null]);
      const day = (v: unknown) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}` : String(v));
      return rows.map((r): PriceEvidenceDay => ({
        writeScopeId: r.write_scope_id, day: day(r.day), timeZone: r.tz, currency: r.currency, basis: r.price_basis, minMinor: Number(r.min_minor), maxMinor: Number(r.max_minor),
        firstMinor: Number(r.first_minor), lastMinor: Number(r.last_minor), changes: Number(r.changes), source: r.source, corrected: r.corrected, correctionReason: r.correction_reason,
      }));
    });
  }

  async assignStrategyVersion(tenantId: string, input: StrategyAssignInput, actor: AdminActor): Promise<StrategySaveResult> {
    try {
      return await inTenant(this.admin('assignStrategyVersion'), tenantId, async (tx) => {
        await PgPricingStore.assertExpected(tx, tenantId, input.expected);
        const { rows: [v] } = await tx.query(
          `SELECT ps.version, ps.type, ps.params, u.undercut_minor FROM tenant_data.pricing_strategy ps
             LEFT JOIN channel_data.pricing_strategy_undercut u ON u.tenant_id = ps.tenant_id AND u.pricing_strategy_id = ps.pricing_strategy_id AND u.version = ps.version
            WHERE ps.tenant_id = $1 AND ps.pricing_strategy_id = $2 AND ps.version = $3`, [tenantId, input.strategyId, input.version]);
        if (!v) throw new RollbackWith<StrategySaveResult>({ status: 'INVALID', cause: 'STRATEGY_NOT_FOUND' });
        const { rowCount } = await tx.query(
          `UPDATE tenant_data.write_scope SET pricing_strategy_id = $2, pricing_strategy_version = $3
            WHERE tenant_id = $1 AND write_scope_id = ANY ($4::uuid[]) AND field = 'PRICE'`,
          [tenantId, input.strategyId, input.version, input.assignTo]);
        if (rowCount !== new Set(input.assignTo).size) throw new RollbackWith<StrategySaveResult>({ status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
        const { deadbandMinor, ...params } = v.params as Record<string, unknown>;
        return {
          status: 'SAVED', assigned: [...input.assignTo],
          strategy: {
            strategyId: input.strategyId, version: input.version, deadbandMinor: Number(deadbandMinor ?? 0),
            params: { ...params, type: v.type, ...(v.undercut_minor !== null ? { undercutMinor: Number(v.undercut_minor) } : {}) } as unknown as StrategyDefinition['params'],
          },
        } satisfies StrategySaveResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      const refusal = PgPricingStore.strategyRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
  }

  async unassignStrategy(tenantId: string, input: StrategyUnassignInput, actor: AdminActor): Promise<StrategyUnassignResult> {
    try {
      return await inTenant(this.admin('unassignStrategy'), tenantId, async (tx) => {
        await PgPricingStore.assertExpected(tx, tenantId, input.expected);
        const { rows } = await tx.query(
          `SELECT write_scope_id, pricing_mode FROM tenant_data.write_scope
            WHERE tenant_id = $1 AND write_scope_id = ANY ($2::uuid[]) AND field = 'PRICE' ORDER BY write_scope_id FOR NO KEY UPDATE`, [tenantId, input.writeScopeIds]);
        if (rows.length !== new Set(input.writeScopeIds).size) throw new RollbackWith<StrategyUnassignResult>({ status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
        const engine = rows.find((r) => r.pricing_mode === 'ENGINE');
        if (engine) throw new RollbackWith<StrategyUnassignResult>({ status: 'INVALID', cause: 'REPRICING_ENABLED', writeScopeId: engine.write_scope_id });
        await tx.query(
          `UPDATE tenant_data.write_scope SET pricing_strategy_id = NULL, pricing_strategy_version = NULL
            WHERE tenant_id = $1 AND write_scope_id = ANY ($2::uuid[]) AND field = 'PRICE'`, [tenantId, input.writeScopeIds]);
        return { status: 'UNASSIGNED', writeScopeIds: [...input.writeScopeIds] } satisfies StrategyUnassignResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      if ((error as { code?: string }).code === '42501') return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  async saveStrategy(tenantId: string, input: StrategySaveInput, actor: AdminActor): Promise<StrategySaveResult> {
    if (input.name.trim().length === 0) return { status: 'INVALID', cause: 'NAME_REQUIRED' };
    try {
      return await inTenant(this.admin('saveStrategy'), tenantId, async (tx) => {
        await PgPricingStore.assertExpected(tx, tenantId, input.expected);
        let strategyId = input.strategyId;
        let version = 1;
        if (strategyId !== null) {
          const { rows: [r] } = await tx.query(
            `SELECT max(version) AS v FROM tenant_data.pricing_strategy WHERE tenant_id = $1 AND pricing_strategy_id = $2`, [tenantId, strategyId]);
          if (r?.v === null || r?.v === undefined) throw new RollbackWith<StrategySaveResult>({ status: 'INVALID', cause: 'STRATEGY_NOT_FOUND' });
          version = Number(r.v) + 1;
        } else {
          strategyId = randomUUID();
        }
        // Р-91: версия стратегии (вечная, архивируется с ядром) — без подреза; подрез — в таблице с 18-месячным сроком
        const { undercutMinor, ...stored } = input.params as Record<string, unknown>;
        await tx.query(
          `INSERT INTO tenant_data.pricing_strategy (tenant_id, pricing_strategy_id, version, name, type, params, triggers, status, created_by_membership_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', $8)`,
          [tenantId, strategyId, version, input.name.trim(), input.params.type, JSON.stringify({ ...stored, deadbandMinor: input.deadbandMinor }),
           ['COMPETITOR_CHANGE', 'COST_CHANGE', 'SCHEDULE'], actor.membershipId]);
        if (undercutMinor !== undefined) {
          await tx.query(`INSERT INTO channel_data.pricing_strategy_undercut (tenant_id, pricing_strategy_id, version, undercut_minor) VALUES ($1, $2, $3, $4)`,
            [tenantId, strategyId, version, undercutMinor]);
        }
        if (input.assignTo.length > 0) {
          const { rowCount } = await tx.query(
            `UPDATE tenant_data.write_scope SET pricing_strategy_id = $2, pricing_strategy_version = $3
              WHERE tenant_id = $1 AND write_scope_id = ANY ($4::uuid[]) AND field = 'PRICE'`,
            [tenantId, strategyId, version, input.assignTo]);
          if (rowCount !== new Set(input.assignTo).size) throw new RollbackWith<StrategySaveResult>({ status: 'INVALID', cause: 'SCOPE_NOT_FOUND' });
        }
        return {
          status: 'SAVED', assigned: [...input.assignTo],
          strategy: { strategyId, version, params: { ...input.params }, deadbandMinor: input.deadbandMinor },
        } satisfies StrategySaveResult;
      }, actor.userId, { mfa: actor.mfa, ...(actor.bulkJobId ? { bulkJobId: actor.bulkJobId } : {}) });
    } catch (error) {
      // Р-39, OQ-166, Р-120: назначение стратегии отклонила база (write_scope_strategy_guard, 0082)
      const refusal = PgPricingStore.strategyRefusal(error);
      if (refusal) return refusal;
      throw error;
    }
  }

  // --- остановки ------------------------------------------------------------------
  /** Системная остановка вне пути решения — для тестов БД (в работе её ставит проверка входов) */
  async haltChannel(tenantId: string, record: HaltRecord): Promise<void> {
    await this.tx(tenantId, (tx) => this.insertHalt(tx, tenantId, record, null));
  }

  // --- остановки человеком [Р-69, Р-70] ------------------------------------------
  private static readonly STOP_COLUMNS = `price_stop_id, scope_type, channel_account_id, marketplace, stopped_at, stopped_by_membership_id, stop_note,
    released_at, released_by_membership_id, release_note`;

  private static stopRow(r: Row): ConsoleStopRow {
    return {
      stopId: r.price_stop_id, scope: r.scope_type, channelAccountId: r.channel_account_id ?? null, marketplace: r.marketplace ?? null,
      stoppedAt: r.stopped_at, stoppedByMembershipId: r.stopped_by_membership_id, note: r.stop_note,
      releasedAt: r.released_at ?? null, releasedByMembershipId: r.released_by_membership_id ?? null, releaseNote: r.release_note ?? null,
    };
  }

  /** Права проверяет триггер БД (aa_price_stop_role_guard): отказ по роли — FORBIDDEN */
  private static forbidden(error: unknown): boolean {
    return (error as { code?: string }).code === '42501';
  }

  async stopPricing(tenantId: string, record: StopRecord): Promise<StopResult> {
    const channelAccountId = record.scope === 'TENANT' ? null : record.channelAccountId;
    const marketplace = record.scope === 'STOREFRONT' ? record.marketplace : null;
    try {
      // Автор — пользователь сессии (app.user_id): триггер прав сверяет с ним членство (находка 4); сессия — административного сервиса (Р-90)
      return await inTenant(this.admin('stopPricing'), tenantId, async (tx) => {
        const { rows: [created] } = await tx.query(
          `INSERT INTO tenant_data.price_stop (tenant_id, scope_type, channel_account_id, marketplace, stopped_at, stopped_by_membership_id, stop_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tenant_id, scope_type, (coalesce(channel_account_id, '00000000-0000-0000-0000-000000000000'::uuid)), (coalesce(marketplace, '*')))
             WHERE released_at IS NULL DO NOTHING
           RETURNING ${PgPricingStore.STOP_COLUMNS}`,
          [tenantId, record.scope, channelAccountId, marketplace, record.stoppedAt, record.stoppedByMembershipId, record.note.trim()],
        );
        if (created) return { status: 'STOPPED', stop: PgPricingStore.stopRow(created) } as StopResult;
        const { rows: [active] } = await tx.query(
          `SELECT ${PgPricingStore.STOP_COLUMNS} FROM tenant_data.price_stop
            WHERE tenant_id = $1 AND scope_type = $2 AND channel_account_id IS NOT DISTINCT FROM $3::uuid AND marketplace IS NOT DISTINCT FROM $4::text AND released_at IS NULL`,
          [tenantId, record.scope, channelAccountId, marketplace],
        );
        return { status: 'ALREADY_ACTIVE', stop: PgPricingStore.stopRow(active!) } as StopResult;
      }, record.stoppedByUserId);
    } catch (error) {
      if (PgPricingStore.forbidden(error)) return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  async releaseStop(tenantId: string, stopId: string, release: StopRelease): Promise<StopResult> {
    const adminPool = this.admin('releaseStop');
    try {
      return await inTenant(adminPool, tenantId, async (tx) => {
        const { rows: [released] } = await tx.query(
          `UPDATE tenant_data.price_stop SET released_at = $3, released_by_membership_id = $4, release_note = $5
            WHERE tenant_id = $1 AND price_stop_id = $2 AND released_at IS NULL
            RETURNING ${PgPricingStore.STOP_COLUMNS}`,
          [tenantId, stopId, release.at, release.membershipId, release.note.trim()],
        );
        return released ? { status: 'RELEASED', stop: PgPricingStore.stopRow(released) } as StopResult : { status: 'NOT_ACTIVE' } as StopResult;
      }, release.userId, { mfa: release.mfa });
    } catch (error) {
      // Р-88: отказ БД без второго фактора — отдельный итог, не «нет прав»
      if (/requires a second factor/.test((error as { message?: string }).message ?? '')) return { status: 'MFA_REQUIRED' };
      if (PgPricingStore.forbidden(error)) return { status: 'FORBIDDEN' };
      throw error;
    }
  }

  // --- состояние для консоли [Р-67, Р-68] -------------------------------------------
  /**
   * Экраны консоли на рабочих данных: объяснение решения — из слепка (price_decision.explanation), а не из отчёта прогона.
   * Горячие окна: intent 3 дня, решение 30 дней (Р-28); дальше слепок доступен в ядре intent и архиве.
   */
  async readConsoleState(tenantId: string, now: Instant): Promise<ConsoleState> {
    return inTenant(this.admin('readConsoleState'), tenantId, async (tx) => {
      const q = async (sql: string, params: unknown[] = [tenantId]) => (await tx.query(sql, params)).rows;
      const [scopeJson] = await q(`WITH sc AS (SELECT ${SCOPE_COLUMNS} ${SCOPE_FROM})
        SELECT coalesce(json_agg(${SCOPE_JSON} ORDER BY sc.created_at, sc.write_scope_id), '[]') AS scopes FROM sc`, [tenantId, now]);
      const scopes = ((scopeJson?.scopes ?? []) as Row[]).map((j): ConsoleScopeRow => {
        const ctx = toScopeContext(j, now);
        const c = j.cost as Row | null;
        const fee = (c?.fee ?? null) as { feeRateBp?: number; fixedFeeMinor?: number } | null;
        const row = j.row as Row;
        return {
          ...ctx.scope, bounds: ctx.bounds,
          // Себестоимость в валюте возникновения; без действующей оценки комиссии пол по марже не считается (как в решении)
          cost: c && fee && Number.isSafeInteger(fee.feeRateBp) && Number.isSafeInteger(fee.fixedFeeMinor)
            ? {
                currency: c.currency, costProfileId: c.costProfileId, unitCostMinor: Number(c.unitCost), fixedFeeMinor: fee.fixedFeeMinor!, feeRateBp: fee.feeRateBp!,
                tax: row.tax_regime === 'SALES_TAX_EXCLUDED' ? { regime: 'SALES_TAX_EXCLUDED' } : { regime: 'VAT_INCLUDED', vatRateBp: j.vatRateBp ?? null },
              }
            : null,
          minMarginBp: ctx.guardrails.minMarginBp, channelHalt: ctx.channelHalt, channelDistrust: ctx.channelDistrust, priceStop: ctx.priceStop,
          lastApplied: j.lastApplied ? { amountMinor: Number((j.lastApplied as Row).amountMinor), acceptedAt: iso((j.lastApplied as Row).acceptedAt as string) } : null,
          // Р-138: все действующие оценки комиссии с источниками — расхождение продавец должен видеть, а не угадывать
          feeEstimates: ((c?.feeEstimates ?? []) as Array<{ source: string; feeRateBp: number | null; fixedFeeMinor: number | null; scheduleVersion: string | null }>)
            .map((f) => ({ source: f.source, feeRateBp: f.feeRateBp ?? null, fixedFeeMinor: f.fixedFeeMinor ?? null, scheduleVersion: f.scheduleVersion ?? null })),
        };
      });
      // Р-154: только записи в полёте — одна на единицу; завершённые читаются лентой страницами
      const writes = (await q(`SELECT ${WRITE_HOT_COLUMNS} FROM tenant_data.channel_write w
                                 LEFT JOIN channel_data.price_decision d ON d.tenant_id = w.tenant_id AND d.price_decision_id = w.price_decision_id
                                WHERE w.tenant_id = $1 AND w.field = 'PRICE' ORDER BY w.created_at, w.version`)).map(writeRow);
      const halts = (await q(`SELECT pricing_halt_id, channel_account_id, marketplace, reason_code, details, halted_at, next_review_at, released_at, released_kind
                                FROM channel_data.pricing_halt WHERE tenant_id = $1 ORDER BY halted_at`))
        .map((r) => ({
          haltId: r.pricing_halt_id, channelAccountId: r.channel_account_id, marketplace: r.marketplace, reasonCode: r.reason_code, details: r.details,
          haltedAt: r.halted_at, nextReviewAt: r.next_review_at, releasedAt: r.released_at, releasedKind: r.released_kind,
        }));
      const haltReviews = (await q(`SELECT pricing_halt_id, kind, outcome, sample_size, failed_count, details, membership_id, note, reviewed_at
                                      FROM channel_data.pricing_halt_review WHERE tenant_id = $1 ORDER BY reviewed_at`))
        .map((r) => ({
          haltId: r.pricing_halt_id, kind: r.kind, outcome: r.outcome, sampleSize: r.sample_size, failedCount: r.failed_count, details: r.details,
          ...(r.membership_id ? { membershipId: r.membership_id } : {}), ...(r.note ? { note: r.note } : {}), at: r.reviewed_at,
        }));
      const offerChannelPricing = (await q(`SELECT DISTINCT ON (channel_account_id, marketplace, external_sku)
                                                   channel_account_id, marketplace, external_sku, automated_pricing, channel_bounds, source, observed_at
                                              FROM channel_data.offer_channel_pricing WHERE tenant_id = $1
                                             ORDER BY channel_account_id, marketplace, external_sku, observed_at DESC, recorded_at DESC`))
        .map((r): ConsoleOfferChannelPricingRow => ({
          channelAccountId: r.channel_account_id, marketplace: r.marketplace, externalSku: r.external_sku, automatedPricing: r.automated_pricing,
          channelBounds: r.channel_bounds, source: r.source, observedAt: iso(r.observed_at),
        }));
      const pricingHealth = (await q(`SELECT DISTINCT ON (h.channel_account_id, h.marketplace, h.channel_product_ref, h.condition)
                                             h.channel_account_id, h.marketplace, h.channel_product_ref, h.condition, h.issue_type, h.event_time,
                                             h.competitive_price_threshold_minor, h.currency, m.price_basis
                                        FROM channel_data.offer_pricing_health h
                                        LEFT JOIN platform.marketplace m ON m.channel = h.channel AND m.marketplace = h.marketplace
                                       WHERE h.tenant_id = $1
                                       ORDER BY h.channel_account_id, h.marketplace, h.channel_product_ref, h.condition, h.event_time DESC, h.recorded_at DESC`))
        .map((r): ConsolePricingHealthRow => ({
          channelAccountId: r.channel_account_id, marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: r.condition, issueType: r.issue_type,
          occurredAt: iso(r.event_time),
          competitivePriceThreshold: r.competitive_price_threshold_minor !== null && r.currency && r.price_basis
            ? { amountMinor: Number(r.competitive_price_threshold_minor), currency: r.currency, basis: r.price_basis } : null,
        }));
      const distrusts = (await q(`SELECT channel_distrust_id, channel_account_id, marketplace, reason_code, details, detected_at, released_at, released_by_membership_id, release_note
                                    FROM channel_data.channel_distrust WHERE tenant_id = $1 ORDER BY detected_at`))
        .map((r): ConsoleDistrustRow => ({
          distrustId: r.channel_distrust_id, channelAccountId: r.channel_account_id, marketplace: r.marketplace, reasonCode: r.reason_code, details: r.details,
          detectedAt: iso(r.detected_at), releasedAt: r.released_at ? iso(r.released_at) : null, releasedByMembershipId: r.released_by_membership_id, releaseNote: r.release_note,
        }));
      const stops = (await q(`SELECT ${PgPricingStore.STOP_COLUMNS} FROM tenant_data.price_stop WHERE tenant_id = $1 ORDER BY stopped_at`)).map(PgPricingStore.stopRow);
      const divergenceCases = (await q(`SELECT divergence_case_id, write_scope_id, expected_amount_minor, observed_amount_minor, cause, status
                                          FROM channel_data.divergence_case WHERE tenant_id = $1 AND field = 'PRICE' ORDER BY opened_at`))
        .map((r) => ({
          divergenceCaseId: r.divergence_case_id, writeScopeId: r.write_scope_id, expectedMinor: r.expected_amount_minor, observedMinor: r.observed_amount_minor,
          cause: r.cause, status: r.status,
        }));
      const fx = await q(`SELECT DISTINCT ON (x.quote_currency) to_char(x.rate_date, 'YYYY-MM-DD') AS rate_date, x.quote_currency, (x.rate * 1000000)::bigint AS rate_micros, x.available_from
                            FROM platform.fx_rate x WHERE x.source = 'ECB' AND x.available_from <= $1::timestamptz
                           ORDER BY x.quote_currency, x.rate_date DESC`, [now]);
      const members = (await q(`SELECT membership_id, user_id, role, status FROM tenant_data.membership WHERE tenant_id = $1 ORDER BY created_at`))
        .map((r) => ({ membershipId: r.membership_id, userId: r.user_id, role: r.role, status: r.status }));
      // Справочники слепка [Р-75]: версии стратегий тенанта и неизменяемые наборы правил и профили Gate
      const strategies = (await q(`SELECT pricing_strategy_id, version, params FROM tenant_data.pricing_strategy WHERE tenant_id = $1 ORDER BY pricing_strategy_id, version`))
        .map((r): StrategyDefinition => {
          const { deadbandMinor, ...params } = r.params as Record<string, unknown>;
          return { strategyId: r.pricing_strategy_id, version: r.version, params: params as unknown as StrategyDefinition['params'], deadbandMinor: Number(deadbandMinor ?? 0) };
        });
      const strategyVersions = (await q(`SELECT pricing_strategy_id, version, name, status, created_at, created_by_membership_id
                                           FROM tenant_data.pricing_strategy WHERE tenant_id = $1 ORDER BY pricing_strategy_id, version`))
        .map((r): ConsoleStrategyVersionRow => ({
          strategyId: r.pricing_strategy_id, version: Number(r.version), name: r.name, status: r.status, createdAt: iso(r.created_at),
          createdByMembershipId: r.created_by_membership_id,
        }));
      const explanationRulesets = (await q(`SELECT ruleset_id, kind, definition FROM platform.explanation_ruleset ORDER BY ruleset_id`, []))
        .map((r) => ({ rulesetId: r.ruleset_id, kind: r.kind, definition: r.definition }) as DictionaryRuleset);
      const [tenantRow] = await q(`SELECT demo FROM tenant_data.tenant WHERE tenant_id = $1`);
      return {
        tenantId, demo: tenantRow?.demo === true, scopes, writes, halts, haltReviews, distrusts, offerChannelPricing, pricingHealth, stops, divergenceCases,
        fxRates: fx.map((f) => ({ source: 'ECB', rateDate: f.rate_date, base: 'EUR', quote: f.quote_currency, rateMicros: Number(f.rate_micros), availableFrom: f.available_from })),
        members, strategies, strategyVersions, explanationRulesets,
      };
    });
  }

  // --- Р-154 (шаг 35): потоки — страницами, окнами, агрегатами -------------------------------------------------------

  async decisionPage(tenantId: string, query: DecisionPageQuery): Promise<DecisionPage> {
    return inTenant(this.admin('decisionPage'), tenantId, async (tx) => {
      const where = `d.tenant_id = $1${query.writeScopeId ? ' AND d.write_scope_id = $4' : ''}`;
      const params: unknown[] = [tenantId, query.limit, query.offset, ...(query.writeScopeId ? [query.writeScopeId] : [])];
      // Индексы 0117: (tenant_id, decided_at DESC) и (tenant_id, write_scope_id, decided_at DESC)
      const [{ rows }, { rows: [count] }] = await Promise.all([
        tx.query(`SELECT ${DECISION_COLUMNS} ${DECISION_FROM} WHERE ${where} ORDER BY d.decided_at DESC, d.price_decision_id DESC LIMIT $2 OFFSET $3`, params),
        tx.query(`SELECT count(*)::int AS n FROM channel_data.price_decision d WHERE ${where}`, [tenantId, ...(query.writeScopeId ? [null, null, query.writeScopeId] : [])]),
      ]);
      return { items: rows.map(decisionRow), total: Number(count!.n) };
    });
  }

  async decisionDetail(tenantId: string, decisionId: string): Promise<DecisionDetail | null> {
    return inTenant(this.admin('decisionDetail'), tenantId, async (tx) => {
      const { rows: [d] } = await tx.query(`SELECT ${DECISION_COLUMNS} ${DECISION_FROM} WHERE d.tenant_id = $1 AND d.price_decision_id = $2`, [tenantId, decisionId]);
      if (!d) return null;
      const [{ rows: [i] }, { rows: writes }] = await Promise.all([
        tx.query(`SELECT ${INTENT_COLUMNS} FROM channel_data.price_intent WHERE tenant_id = $1 AND write_scope_id = $2 AND price_intent_id = $3`,
          [tenantId, d.write_scope_id, d.price_intent_id]),
        tx.query(`SELECT * FROM (
                    SELECT ${WRITE_HOT_COLUMNS} FROM tenant_data.channel_write w LEFT JOIN channel_data.price_decision d ON d.tenant_id = w.tenant_id AND d.price_decision_id = w.price_decision_id
                     WHERE w.tenant_id = $1 AND w.price_decision_id = $2
                    UNION ALL
                    SELECT ${WRITE_HISTORY_COLUMNS} FROM tenant_data.channel_write_history h LEFT JOIN channel_data.price_decision d ON d.tenant_id = h.tenant_id AND d.price_decision_id = h.price_decision_id
                     WHERE h.tenant_id = $1 AND h.price_decision_id = $2) u ORDER BY version`, [tenantId, decisionId]),
      ]);
      return { decision: decisionRow(d), intent: i ? intentRow(i) : null, writes: writes.map(writeRow) };
    });
  }

  async scopeDecisionStats(tenantId: string, writeScopeIds: readonly string[]): Promise<ScopeDecisionStats[]> {
    if (writeScopeIds.length === 0) return [];
    return inTenant(this.admin('scopeDecisionStats'), tenantId, async (tx) => {
      // Только для показанных строк: на каталог целиком этот счёт стоил бы обхода всех решений тенанта [Р-154]
      const { rows } = await tx.query(
        `SELECT s.id AS write_scope_id,
                (SELECT d.price_decision_id FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = s.id ORDER BY d.decided_at DESC, d.price_decision_id DESC LIMIT 1) AS latest_id,
                (SELECT d.decided_at FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = s.id ORDER BY d.decided_at DESC, d.price_decision_id DESC LIMIT 1) AS latest_at,
                (SELECT count(*) FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.write_scope_id = s.id)::int AS n
           FROM unnest($2::uuid[]) AS s(id)`, [tenantId, [...writeScopeIds]]);
      return rows.map((r) => ({ writeScopeId: r.write_scope_id, latestDecisionId: r.latest_id ?? null, latestDecidedAt: r.latest_at ? iso(r.latest_at) : null, decisions: Number(r.n) }));
    });
  }

  async interventions(tenantId: string, from: Instant, to: Instant): Promise<InterventionSlice> {
    return inTenant(this.admin('interventions'), tenantId, async (tx) => {
      const params = [tenantId, from, to];
      // Частичные индексы 0117 отсекают «без изменения» и обычные намерения ещё в индексе — обходятся только вмешательства
      const [decisions, intents, ended, rejected] = await Promise.all([
        tx.query(`SELECT ${DECISION_COLUMNS} ${DECISION_FROM}
                   WHERE d.tenant_id = $1 AND d.outcome <> 'NO_CHANGE' AND d.decided_at > $2::timestamptz AND d.decided_at <= $3::timestamptz
                   ORDER BY d.decided_at DESC, d.price_decision_id DESC`, params),
        /**
         * Граница эпизода удержания — по ВСЕМ намерениям единицы окна (оконная функция), наружу идут только намерения на
         * границе. Полный обход намерений окна здесь неизбежен: он и есть определение эпизода; но наружу не уходит
         * девять десятых строк, а окно — три дня горячего буфера.
         */
        tx.query(`SELECT * FROM (
                    SELECT ${INTENT_COLUMNS},
                           (rationale -> 'reason' ->> 'code' = 'TARGET_OUTSIDE_BOUNDS_HOLD'
                            OR rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MIN_PRICE"}]'::jsonb
                            OR rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MAX_PRICE"}]'::jsonb) AS capped,
                           coalesce(lag(rationale -> 'reason' ->> 'code' = 'TARGET_OUTSIDE_BOUNDS_HOLD'
                            OR rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MIN_PRICE"}]'::jsonb
                            OR rationale -> 'explanation' @> '[{"code": "CAPPED_AT_MAX_PRICE"}]'::jsonb)
                              OVER (PARTITION BY write_scope_id ORDER BY created_at, price_intent_id), false) AS prev_capped
                      FROM channel_data.price_intent
                     WHERE tenant_id = $1 AND created_at > $2::timestamptz AND created_at <= $3::timestamptz) t
                   WHERE capped ORDER BY created_at`, params),
        tx.query(`SELECT ${WRITE_HISTORY_COLUMNS} FROM tenant_data.channel_write_history h
                   LEFT JOIN channel_data.price_decision d ON d.tenant_id = h.tenant_id AND d.price_decision_id = h.price_decision_id
                   WHERE h.tenant_id = $1 AND h.field = 'PRICE' AND h.end_reason IN ('WRITE_BLOCKED_BY_BOUND_RECHECK', 'PRICING_STOPPED')
                     AND h.created_at > $2::timestamptz AND h.created_at <= $3::timestamptz`, params),
        tx.query(`SELECT rejected_snapshot_id, channel_account_id, marketplace, channel_product_ref, condition, source, source_event_id,
                         observed_at, received_at, verdict, reason_code, alarm_class, details, ruleset_version
                    FROM channel_data.rejected_competitor_snapshot
                   WHERE tenant_id = $1 AND received_at > $2::timestamptz AND received_at <= $3::timestamptz ORDER BY received_at`, params),
      ]);
      return { from, to, decisions: decisions.rows.map(decisionRow), intents: intents.rows.map((r) => ({ ...intentRow(r), episodeStart: r.prev_capped !== true })), endedWrites: ended.rows.map(writeRow), rejectedSnapshots: rejected.rows.map(rejectedSnapshotRow) };
    });
  }

  async feedPage(tenantId: string, now: Instant, query: FeedPageQuery): Promise<FeedPage> {
    return inTenant(this.admin('feedPage'), tenantId, async (tx) => {
      const groupSql = `CASE WHEN u.status = 'APPLIED' THEN 'APPLIED'
                             WHEN u.status IN (${FEED_IN_FLIGHT_STATUSES.map((x) => `'${x}'`).join(', ')}) THEN 'IN_FLIGHT'
                             WHEN u.status IN (${FEED_NOT_SENT_STATUSES.map((x) => `'${x}'`).join(', ')}) THEN 'NOT_SENT' ELSE 'SUPERSEDED' END`;
      const since = query.sinceDays ? new Date(Date.parse(now) - query.sinceDays * 86_400_000).toISOString() : null;
      const scoped = `WITH u AS (
          SELECT ${WRITE_HOT_COLUMNS}, ${WRITE_AT('w')} AS at FROM tenant_data.channel_write w
            LEFT JOIN channel_data.price_decision d ON d.tenant_id = w.tenant_id AND d.price_decision_id = w.price_decision_id
           WHERE w.tenant_id = $1 AND w.field = 'PRICE' AND ($2::uuid IS NULL OR w.write_scope_id = $2) AND ($3::timestamptz IS NULL OR ${WRITE_AT('w')} >= $3)
          UNION ALL
          SELECT ${WRITE_HISTORY_COLUMNS}, ${WRITE_AT('h')} FROM tenant_data.channel_write_history h
            LEFT JOIN channel_data.price_decision d ON d.tenant_id = h.tenant_id AND d.price_decision_id = h.price_decision_id
           WHERE h.tenant_id = $1 AND h.field = 'PRICE' AND ($2::uuid IS NULL OR h.write_scope_id = $2) AND ($3::timestamptz IS NULL OR ${WRITE_AT('h')} >= $3))`;
      const base: unknown[] = [tenantId, query.writeScopeId ?? null, since];
      const [{ rows: counts }, { rows }] = await Promise.all([
        tx.query(`${scoped} SELECT ${groupSql} AS g, count(*)::int AS n FROM u GROUP BY 1`, base),
        tx.query(`${scoped} SELECT u.* FROM u WHERE ($4::text IS NULL OR ${groupSql} = $4) ORDER BY u.at DESC, u.version DESC LIMIT $5 OFFSET $6`,
          [...base, query.status ?? null, query.limit, query.offset]),
      ]);
      const groups: Record<FeedStatusGroup, number> = { APPLIED: 0, IN_FLIGHT: 0, NOT_SENT: 0, SUPERSEDED: 0 };
      for (const c of counts) groups[c.g as FeedStatusGroup] = Number(c.n);
      const total = query.status ? groups[query.status] : Object.values(groups).reduce((a, b) => a + b, 0);
      // Решение и горячее намерение — только для строк страницы
      const decisionIds = [...new Set(rows.map((r) => r.price_decision_id).filter((x): x is string => typeof x === 'string'))];
      const decisions = new Map<string, ConsoleDecisionRow>();
      const currentByIntent = new Map<string, number | null>();
      if (decisionIds.length > 0) {
        const { rows: ds } = await tx.query(`SELECT ${DECISION_COLUMNS} ${DECISION_FROM} WHERE d.tenant_id = $1 AND d.price_decision_id = ANY($2::uuid[])`, [tenantId, decisionIds]);
        for (const d of ds) decisions.set(d.price_decision_id, decisionRow(d));
        const { rows: is } = await tx.query(
          `SELECT i.price_intent_id, i.rationale -> 'currentMinor' AS current FROM channel_data.price_intent i
             JOIN channel_data.price_decision d ON d.tenant_id = i.tenant_id AND d.write_scope_id = i.write_scope_id AND d.price_intent_id = i.price_intent_id
            WHERE i.tenant_id = $1 AND d.price_decision_id = ANY($2::uuid[])`, [tenantId, decisionIds]);
        for (const i of is) currentByIntent.set(i.price_intent_id, i.current === null || i.current === undefined ? null : Number(i.current));
      }
      return {
        items: rows.map((r): FeedPageItem => {
          const decision = r.price_decision_id ? decisions.get(r.price_decision_id) ?? null : null;
          return { write: writeRow(r), decision, intentCurrentMinor: decision ? currentByIntent.get(decision.intentId) ?? null : null };
        }),
        total, counts: groups,
      };
    });
  }

  async auditRecent(tenantId: string, limit: number): Promise<ConsoleAuditRow[]> {
    return inTenant(this.admin('auditRecent'), tenantId, async (tx) => {
      // Остановки в журнале аудита [Р-76]: время действия — из события, роль — в момент действия; свежие первыми, не весь журнал
      const { rows } = await tx.query(`SELECT action, actor_type, actor_membership_id, entity_type, entity_id, changes FROM audit.audit_event
                                          WHERE tenant_id = $1 AND entity_type IN ('price_stop', 'pricing_halt')
                                          ORDER BY changes ->> 'at' DESC, recorded_at DESC, audit_event_id DESC LIMIT $2`, [tenantId, limit]);
      return rows.map(auditRow);
    });
  }

  async worldCounters(tenantId: string, now: Instant): Promise<WorldCounters> {
    return inTenant(this.admin('worldCounters'), tenantId, async (tx) => {
      const { rows: [r] } = await tx.query(
        `SELECT (SELECT count(*) FROM tenant_data.write_scope s WHERE s.tenant_id = $1 AND s.field = 'PRICE' AND s.status <> 'RETIRED')::int AS scopes,
                (SELECT count(*) FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.decided_at > $2::timestamptz - interval '1 day')::int AS decisions_day,
                (SELECT count(*) FROM channel_data.price_decision d WHERE d.tenant_id = $1 AND d.outcome <> 'NO_CHANGE' AND d.decided_at > $2::timestamptz - interval '7 days')::int AS interventions_week,
                (SELECT count(*) FROM tenant_data.price_stop p WHERE p.tenant_id = $1 AND p.released_at IS NULL)::int AS stops,
                (SELECT count(*) FROM channel_data.pricing_halt h WHERE h.tenant_id = $1 AND h.released_at IS NULL)::int AS halts,
                (SELECT demo FROM tenant_data.tenant t WHERE t.tenant_id = $1) AS demo`, [tenantId, now]);
      return { scopes: Number(r!.scopes), decisionsLastDay: Number(r!.decisions_day), interventionsLastWeek: Number(r!.interventions_week),
        activeStops: Number(r!.stops), activeHalts: Number(r!.halts), demo: r!.demo === true };
    });
  }

  private static haltInfo(r: Row): HaltInfo {
    return {
      haltId: r.pricing_halt_id, channelAccountId: r.channel_account_id, marketplace: r.marketplace, reasonCode: r.reason_code,
      haltedAt: r.halted_at, reviewWindowSeconds: r.review_window_seconds, nextReviewAt: r.next_review_at,
    };
  }

  private static readonly HALT_COLUMNS = `pricing_halt_id, channel_account_id, marketplace, reason_code, halted_at, next_review_at,
    extract(epoch FROM review_window)::int AS review_window_seconds`;

  async listDueHalts(tenantId: string, channelAccountId: string, now: Instant): Promise<HaltInfo[]> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${PgPricingStore.HALT_COLUMNS} FROM channel_data.pricing_halt
          WHERE tenant_id = $1 AND channel_account_id = $2 AND released_at IS NULL AND next_review_at <= $3
            -- Р-52: выборкой проверяется только остановка по массовому сдвигу; ручную снимает только человек
            AND reason_code = 'CHANNEL_MASS_SHIFT'
          ORDER BY next_review_at`,
        [tenantId, channelAccountId, now],
      );
      return rows.map(PgPricingStore.haltInfo);
    });
  }

  async getHalt(tenantId: string, haltId: string): Promise<HaltInfo | null> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${PgPricingStore.HALT_COLUMNS} FROM channel_data.pricing_halt WHERE tenant_id = $1 AND pricing_halt_id = $2 AND released_at IS NULL`,
        [tenantId, haltId],
      );
      return rows[0] ? PgPricingStore.haltInfo(rows[0]) : null;
    });
  }

  /** Р-121: проверка потери уведомления — в транзакции снимка (фиксация оценки или снимок только для сверки) */
  private static async insertLossCheck(tx: Tx, tenantId: string, c: NotificationLossCheck): Promise<void> {
    await tx.query(
      `INSERT INTO channel_data.notification_loss_check (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, compared,
                                                         held_observed_at, held_minor, poll_snapshot_id, poll_observed_at, poll_minor, currency, due_at)
       SELECT $1, a.channel_account_id, a.channel, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $2`,
      [tenantId, c.channelAccountId, c.marketplace, c.channelProductRef, c.condition, c.compared, c.heldObservedAt, c.heldMinor, c.pollSnapshotId,
        c.pollObservedAt, c.pollMinor, c.currency, c.dueAt]);
  }

  async recordReconciliationSnapshot(tenantId: string, entry: { channelAccountId: string; competitorSnapshotId: string; snapshot: CompetitorSnapshot; receivedAt: Instant; lossCheck?: NotificationLossCheck }): Promise<void> {
    const { snapshot } = entry;
    await this.tx(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO channel_data.competitor_snapshot_log (tenant_id, competitor_snapshot_id, received_at, observed_at, channel_account_id, channel, marketplace,
                                                          channel_product_ref, condition, source, source_event_id, sanity_verdict, delivery, snapshot)
         SELECT $1, $2, $3, $4, a.channel_account_id, a.channel, $6, $7, $8, $9, $10, 'RECONCILIATION', 'POLL', $11::jsonb
           FROM tenant_data.channel_account a WHERE a.tenant_id = $1 AND a.channel_account_id = $5`,
        [tenantId, entry.competitorSnapshotId, entry.receivedAt, snapshot.observedAt, entry.channelAccountId, snapshot.marketplace, snapshot.channelProductRef,
          snapshot.condition, snapshot.source, snapshot.sourceEventId ?? null, JSON.stringify(snapshot)]);
      if (entry.lossCheck) await PgPricingStore.insertLossCheck(tx, tenantId, entry.lossCheck);
    });
  }

  async heldCompetitorState(tenantId: string, key: ProductKey): Promise<{ observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null } | null> {
    return this.tx(tenantId, async (tx) => {
      const { rows: [r] } = await tx.query(
        `SELECT cs.observed_at, cs.buybox_amount_minor,
                (SELECT min((o->'price'->>'amountMinor')::bigint) FROM jsonb_array_elements(cs.offers) o WHERE NOT coalesce((o->>'isSelf')::boolean, false)) AS lowest
           FROM channel_data.competitor_state cs
          WHERE cs.tenant_id = $1 AND cs.channel_account_id = $2 AND cs.marketplace = $3 AND cs.channel_product_ref = $4 AND cs.condition = $5`,
        [tenantId, key.channelAccountId, key.marketplace, key.channelProductRef, dbCondition(key.condition)]);
      return r ? { observedAt: iso(r.observed_at), buyboxMinor: r.buybox_amount_minor === null ? null : Number(r.buybox_amount_minor), lowestMinor: r.lowest === null ? null : Number(r.lowest) } : null;
    });
  }

  async reviewNotificationLoss(tenantId: string, channelAccountId: string, at: Instant): Promise<NotificationLossVerdict[]> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query('SELECT * FROM channel_data.review_notification_loss($1, $2, $3)', [tenantId, channelAccountId, at]);
      return rows.map((r): NotificationLossVerdict => ({
        checkId: r.notification_loss_check_id, verdict: r.verdict, marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: r.condition,
        pollObservedAt: iso(r.poll_observed_at),
      }));
    });
  }

  async pickReconciliationSample(tenantId: string, channelAccountId: string, size: number, cycle: number): Promise<{ queries: CompetitorQuery[]; total: number }> {
    return this.tx(tenantId, async (tx) => {
      // Офферы аккаунта с товаром канала; порядок и окно — rotation, как в памяти
      const { rows } = await tx.query(
        `SELECT DISTINCT m.marketplace, m.channel_product_ref, m.condition FROM tenant_data.offer_mapping m
          WHERE m.tenant_id = $1 AND m.channel_account_id = $2 AND m.status <> 'ENDED' AND m.channel_product_ref IS NOT NULL`, [tenantId, channelAccountId]);
      const items = rows.map((r) => ({ marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: portCondition(r.condition) }));
      return { queries: rotation(items, size, cycle), total: items.length };
    });
  }

  async listPollCandidates(tenantId: string, channelAccountId: string, now: Instant): Promise<PollCandidate[]> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(
        // Движения и охват наблюдений — одним проходом по окну 48 часов (Р-128: волатильность известна, если наблюдения старше суток)
        `SELECT p.marketplace, p.channel_product_ref, p.condition, ps.last_polled_at, w.moves, coalesce(w.volatility_known, false) AS volatility_known
           FROM (SELECT DISTINCT m.marketplace, m.channel_product_ref, m.condition FROM tenant_data.offer_mapping m
                  WHERE m.tenant_id = $1 AND m.channel_account_id = $2 AND m.status <> 'ENDED' AND m.channel_product_ref IS NOT NULL) p
           LEFT JOIN channel_data.competitor_poll_state ps
             ON ps.tenant_id = $1 AND ps.channel_account_id = $2 AND ps.marketplace = p.marketplace AND ps.channel_product_ref = p.channel_product_ref
            AND ps.condition = lower(p.condition)
           LEFT JOIN LATERAL (
             SELECT count(*) FILTER (WHERE mv.move_bp <> 10000)::int AS moves,
                    bool_or(mv.evaluated_at <= $3::timestamptz - interval '24 hours') AS volatility_known
               FROM channel_data.competitor_move mv
              WHERE mv.tenant_id = $1 AND mv.channel_account_id = $2 AND mv.marketplace = p.marketplace AND mv.channel_product_ref = p.channel_product_ref
                AND mv.condition = p.condition AND mv.evaluated_at >= $3::timestamptz - interval '48 hours') w ON true`, [tenantId, channelAccountId, now]);
      return rows.map((r): PollCandidate => ({
        query: { marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: portCondition(r.condition) },
        lastPolledAt: r.last_polled_at ? iso(r.last_polled_at) : null, changesLast30Days: Number(r.moves ?? 0) * 15, volatilityKnown: r.volatility_known === true,
      }));
    });
  }

  async markPolled(tenantId: string, channelAccountId: string, queries: readonly CompetitorQuery[], at: Instant): Promise<void> {
    if (queries.length === 0) return;
    await this.tx(tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO channel_data.competitor_poll_state AS ps (tenant_id, channel_account_id, channel, marketplace, channel_product_ref, condition, last_polled_at)
         SELECT $1, a.channel_account_id, a.channel, q.marketplace, q.ref, q.condition, $4
           FROM tenant_data.channel_account a
           CROSS JOIN LATERAL jsonb_to_recordset($3::jsonb) AS q(marketplace text, ref text, condition text)
          WHERE a.tenant_id = $1 AND a.channel_account_id = $2
         ON CONFLICT (tenant_id, channel_account_id, marketplace, channel_product_ref, condition)
         DO UPDATE SET last_polled_at = greatest(ps.last_polled_at, EXCLUDED.last_polled_at)`,
        [tenantId, channelAccountId, JSON.stringify(queries.map((q) => ({ marketplace: q.marketplace, ref: q.channelProductRef, condition: q.condition }))), at]);
    });
  }


  async pickReviewSample(tenantId: string, halt: HaltInfo, size: number): Promise<CompetitorQuery[]> {
    return this.tx(tenantId, async (tx) => {
      const { rows } = await tx.query(
        // Шаг 26 (живой режим, Р-128): сначала товары с ценой из данных конкурентов, затем остальные товары витрины. Выборка проверяет
        // данные канала, а не стратегии: витрина без таких стратегий не получала выборки, и остановка не снималась никогда
        `SELECT marketplace, channel_product_ref, condition FROM (
           SELECT DISTINCT ON (m.marketplace, m.channel_product_ref, m.condition) m.marketplace, m.channel_product_ref, m.condition,
                  (s.pricing_mode = 'ENGINE' AND ps.type = ANY ($4::text[])) AS competitor_derived
             FROM tenant_data.offer_mapping m
             LEFT JOIN tenant_data.write_scope s ON s.tenant_id = m.tenant_id AND s.write_scope_id = m.price_write_scope_id
             LEFT JOIN tenant_data.pricing_strategy ps
               ON ps.tenant_id = s.tenant_id AND ps.pricing_strategy_id = s.pricing_strategy_id AND ps.version = s.pricing_strategy_version
            WHERE m.tenant_id = $1 AND m.channel_account_id = $2 AND ($3::text IS NULL OR m.marketplace = $3::text)
              AND m.status <> 'ENDED' AND m.channel_product_ref IS NOT NULL
            ORDER BY m.marketplace, m.channel_product_ref, m.condition, competitor_derived DESC NULLS LAST) p
          ORDER BY competitor_derived DESC NULLS LAST, channel_product_ref
          LIMIT $5`,
        [tenantId, halt.channelAccountId, halt.marketplace, COMPETITOR_RULES, size],
      );
      return rows.map((r) => ({ marketplace: r.marketplace, channelProductRef: r.channel_product_ref, condition: portCondition(r.condition) }));
    });
  }

  private static async insertReview(tx: Tx, tenantId: string, haltId: string, review: HaltReviewRecord): Promise<void> {
    await tx.query(
      `INSERT INTO channel_data.pricing_halt_review
         (tenant_id, pricing_halt_id, kind, outcome, sample_size, failed_count, details, membership_id, note, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [tenantId, haltId, review.kind, review.outcome, review.sampleSize, review.failedCount, JSON.stringify(review.details ?? {}),
       review.membershipId ?? null, review.note ?? null, review.at],
    );
  }

  /** Р-118: снятие недоверия каналу — в сессии пользователя административного сервиса со вторым фактором; права и заметку сверяет база (0082) */
  async releaseDistrust(tenantId: string, distrustId: string, release: { membershipId: string; userId: string; mfa: boolean; note: string; at: Instant }): Promise<'RELEASED' | 'NOT_ACTIVE'> {
    return inTenant(this.admin('releaseDistrust'), tenantId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE channel_data.channel_distrust SET released_at = $3, released_by_membership_id = $4, release_note = $5
          WHERE tenant_id = $1 AND channel_distrust_id = $2 AND released_at IS NULL`,
        [tenantId, distrustId, release.at, release.membershipId, release.note]);
      return rowCount === 1 ? 'RELEASED' as const : 'NOT_ACTIVE' as const;
    }, release.userId, { mfa: release.mfa });
  }

  async releaseHalt(tenantId: string, haltId: string, review: HaltReviewRecord): Promise<void> {
    // Р-52, находки 4, 12, Р-90: ручное снятие — в сессии пользователя административного сервиса со вторым фактором.
    // Автоматическое снятие путь решения не пишет: его вычисляет база по выборке (reviewHaltBySample, 0063)
    if (review.kind !== 'MANUAL_RELEASE') {
      throw new Error('an automatic halt release is computed by the database from the recorded sample (0063): use recordHaltSample and reviewHaltBySample');
    }
    await inTenant(this.admin('releaseHalt (manual)'), tenantId, async (tx) => {
      await PgPricingStore.insertReview(tx, tenantId, haltId, review);
      const { rowCount } = await tx.query(
        `UPDATE channel_data.pricing_halt
            SET released_at = $3, released_kind = 'MANUAL', released_by_membership_id = $4, release_note = $5
          WHERE tenant_id = $1 AND pricing_halt_id = $2 AND released_at IS NULL`,
        [tenantId, haltId, review.at, review.membershipId ?? null, review.note ?? null],
      );
      if (rowCount !== 1) throw new Error(`pricing halt ${haltId} is not active`);
    }, review.userId, { mfa: review.mfa === true });
  }

  /** Находка 2 ревью шага 16 [0063]: путь решения пишет только наблюдения выборки проверки остановки */
  async recordHaltSample(tenantId: string, haltId: string, samples: readonly HaltSampleObservation[], _now: Instant): Promise<void> {
    if (samples.length === 0) return;
    await this.tx(tenantId, (tx) => tx.query(
      `INSERT INTO channel_data.pricing_halt_sample (tenant_id, pricing_halt_id, channel_product_ref, observed_at, verdict, reason_code)
       SELECT $1, $2, x.ref, x.observed_at, x.verdict, x.reason FROM jsonb_to_recordset($3::jsonb) AS x(ref text, observed_at timestamptz, verdict text, reason text)`,
      [tenantId, haltId, JSON.stringify(samples.map((o) => ({ ref: o.channelProductRef, observed_at: o.observedAt, verdict: o.verdict, reason: o.reasonCode })))]));
  }

  /** Итог проверки выборки и автоматическое снятие — функция базы; срок и размер выборки она берёт сама, момент — не позже часов базы (0065) */
  async reviewHaltBySample(tenantId: string, haltId: string, now: Instant): Promise<HaltSampleReview> {
    return this.tx(tenantId, async (tx) => (await tx.query('SELECT channel_data.review_halt_by_sample($1, $2, $3) AS outcome', [tenantId, haltId, now])).rows[0].outcome as HaltSampleReview);
  }

  /** Состояние тенанта в форме InMemoryPricingStore.dump() — для ожиданий сценариев стенда */
  async dumpState(tenantId: string) {
    return inTenant(this.admin('dumpState'), tenantId, async (tx) => {
      const q = async (sql: string) => (await tx.query(sql, [tenantId])).rows;
      const scopes = await q(`SELECT s.write_scope_id, s.pricing_mode, ss.latest_version_accepted, ss.last_sent_amount_minor, o.observed_amount_minor
                                FROM tenant_data.write_scope s
                                JOIN tenant_data.write_scope_sync_state ss ON ss.tenant_id = s.tenant_id AND ss.write_scope_id = s.write_scope_id
                                LEFT JOIN channel_data.observed_channel_state o ON o.tenant_id = s.tenant_id AND o.write_scope_id = s.write_scope_id AND o.field = 'PRICE'
                               WHERE s.tenant_id = $1 AND s.field = 'PRICE' ORDER BY s.created_at, s.write_scope_id`);
      const rejected = await q(`SELECT verdict, reason_code, alarm_class, channel_product_ref, marketplace FROM channel_data.rejected_competitor_snapshot
                                 WHERE tenant_id = $1 ORDER BY created_at, received_at`);
      const halts = await q(`SELECT pricing_halt_id, channel_account_id, marketplace, reason_code, released_at, released_kind, next_review_at
                               FROM channel_data.pricing_halt WHERE tenant_id = $1 ORDER BY halted_at`);
      // Порядок вставки внутри одного виртуального момента — по xmin (каждая фиксация — отдельная транзакция)
      const reviews = await q(`SELECT kind, outcome, sample_size, failed_count FROM channel_data.pricing_halt_review
                                 WHERE tenant_id = $1 ORDER BY reviewed_at, xmin::text::bigint`);
      const intents = await q(`SELECT write_scope_id, rule_code, proposed_amount_minor FROM channel_data.price_intent
                                 WHERE tenant_id = $1 ORDER BY created_at, xmin::text::bigint`);
      const decisions = await q(`SELECT write_scope_id, outcome, intent_class, rejection_reason, final_amount_minor, reason_params, fx, bound_deviation_bp FROM channel_data.price_decision
                                   WHERE tenant_id = $1 ORDER BY decided_at, xmin::text::bigint, write_scope_id`);
      const writes = await q(`SELECT write_scope_id, amount_minor, version, status, end_reason, created_at FROM tenant_data.channel_write WHERE tenant_id = $1 AND field = 'PRICE'
                              UNION ALL
                              SELECT write_scope_id, amount_minor, version, final_status, end_reason, created_at FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND field = 'PRICE'
                              ORDER BY created_at, version`);
      const stops = await q(`SELECT price_stop_id, scope_type, marketplace, released_at FROM tenant_data.price_stop WHERE tenant_id = $1 ORDER BY stopped_at`);
      const distrusts = await q(`SELECT channel_distrust_id, marketplace, reason_code, released_at FROM channel_data.channel_distrust WHERE tenant_id = $1 ORDER BY detected_at`);
      const ocp = await q(`SELECT marketplace, external_sku, automated_pricing, channel_bounds, source FROM channel_data.offer_channel_pricing WHERE tenant_id = $1 ORDER BY observed_at, external_sku`);
      const health = await q(`SELECT marketplace, channel_product_ref, issue_type, competitive_price_threshold_minor FROM channel_data.offer_pricing_health WHERE tenant_id = $1 ORDER BY recorded_at, event_time`);
      const snapshotLog = await q(`SELECT channel_product_ref, sanity_verdict, source, delivery FROM channel_data.competitor_snapshot_log WHERE tenant_id = $1 ORDER BY received_at, observed_at, channel_product_ref`);
      const lossChecks = await q(`SELECT c.channel_product_ref, c.compared, c.held_minor, c.poll_minor, v.verdict FROM channel_data.notification_loss_check c
                                    LEFT JOIN channel_data.notification_loss_verdict v ON v.tenant_id = c.tenant_id AND v.notification_loss_check_id = c.notification_loss_check_id
                                   WHERE c.tenant_id = $1 ORDER BY c.poll_observed_at, c.channel_product_ref`);
      const inbound = await q(`SELECT notification_id, notification_type FROM channel_data.inbound_notification WHERE tenant_id = $1 ORDER BY processed_at, notification_id`);
      const cases = await q(`SELECT write_scope_id, expected_amount_minor, observed_amount_minor, cause, status FROM channel_data.divergence_case
                               WHERE tenant_id = $1 ORDER BY opened_at`);
      const states = await q(`SELECT marketplace, channel_product_ref, condition, observed_at, buybox_amount_minor, offers, currency, suggested_price_minor
                                FROM channel_data.competitor_state WHERE tenant_id = $1 ORDER BY marketplace, channel_product_ref`);
      return {
        scopes: scopes.map((s) => ({
          writeScopeId: s.write_scope_id, pricingMode: s.pricing_mode,
          currentPriceMinor: Number(s.latest_version_accepted) > 0 && s.last_sent_amount_minor !== null ? s.last_sent_amount_minor : s.observed_amount_minor ?? null,
        })),
        rejectedSnapshots: rejected.map((r) => ({ verdict: r.verdict, reasonCode: r.reason_code, alarmClass: r.alarm_class, key: { channelProductRef: r.channel_product_ref, marketplace: r.marketplace } })),
        halts: halts.map((h) => ({ haltId: h.pricing_halt_id, channelAccountId: h.channel_account_id, marketplace: h.marketplace, reasonCode: h.reason_code, releasedAt: h.released_at, releasedKind: h.released_kind, nextReviewAt: h.next_review_at })),
        haltReviews: reviews.map((r) => ({ kind: r.kind, outcome: r.outcome, sampleSize: r.sample_size, failedCount: r.failed_count })),
        stops: stops.map((r) => ({ stopId: r.price_stop_id, scope: r.scope_type, marketplace: r.marketplace, releasedAt: r.released_at })),
        distrusts: distrusts.map((d) => ({ distrustId: d.channel_distrust_id, marketplace: d.marketplace, reasonCode: d.reason_code, releasedAt: d.released_at, released: d.released_at !== null })),
        offerChannelPricing: ocp.map((o) => ({ marketplace: o.marketplace, externalSku: o.external_sku, automatedPricing: o.automated_pricing, channelBounds: o.channel_bounds, source: o.source })),
        pricingHealth: health.map((h) => ({ marketplace: h.marketplace, channelProductRef: h.channel_product_ref, issueType: h.issue_type, thresholdMinor: h.competitive_price_threshold_minor === null ? null : Number(h.competitive_price_threshold_minor) })),
        inboundNotifications: inbound.map((n) => ({ notificationId: n.notification_id, notificationType: n.notification_type })),
        snapshotLog: snapshotLog.map((l) => ({ channelProductRef: l.channel_product_ref, verdict: l.sanity_verdict, source: l.source, delivery: l.delivery })),
        lossChecks: lossChecks.map((c) => ({
          channelProductRef: c.channel_product_ref, compared: c.compared, heldMinor: c.held_minor === null ? null : Number(c.held_minor),
          pollMinor: c.poll_minor === null ? null : Number(c.poll_minor), verdict: c.verdict ?? null,
        })),
        intents: intents.map((i) => ({ writeScopeId: i.write_scope_id, ruleCode: i.rule_code, proposedMinor: i.proposed_amount_minor })),
        decisions: decisions.map((d) => ({ writeScopeId: d.write_scope_id, outcome: d.outcome, decisionClass: d.intent_class, rejectionReason: d.rejection_reason, finalMinor: d.final_amount_minor, reasonParams: d.reason_params, fx: d.fx, boundDeviationBp: d.bound_deviation_bp })),
        writes: writes.map((w) => ({ writeScopeId: w.write_scope_id, amountMinor: w.amount_minor, version: w.version, status: w.status, endReason: w.end_reason })),
        divergenceCases: cases.map((c) => ({ writeScopeId: c.write_scope_id, expectedMinor: c.expected_amount_minor, observedMinor: c.observed_amount_minor, cause: c.cause, status: c.status })),
        competitorState: Object.fromEntries(states.map((s) => [`${s.marketplace}|${s.channel_product_ref}|${portCondition(s.condition)}`, {
          observedAt: s.observed_at,
          buyboxMinor: s.buybox_amount_minor,
          lowestMinor: (s.offers as Array<{ isSelf?: boolean; price?: { amountMinor?: number } }>)
            .filter((o) => !o.isSelf && typeof o.price?.amountMinor === 'number')
            .reduce<number | null>((m, o) => (m === null || o.price!.amountMinor! < m ? o.price!.amountMinor! : m), null),
          currency: s.currency,
          suggestedMinor: s.suggested_price_minor,
        }])),
      };
    });
  }
}
