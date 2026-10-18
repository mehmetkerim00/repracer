import type { CompetitorSnapshot, CompetitorSourceDescriptor, Instant, PriceBasis } from '@repracer/channel-port';
import {
  competitorExclusion,
  filterCompetitors,
  fulfilmentKind,
  storefrontPriceForMarginBp,
  type AcceptedSnapshot,
  type BUYBOX_UNUSED,
  type CompetitorRequirement,
  type CostInputs,
  type EngineReasonCode,
  type FloorRaiseReason,
  type PriceIntentDraft,
  type Reason,
  type StrategyDefinition,
  type StrategyParams,
  type TriggerType,
} from '@repracer/pricing-model';

/**
 * Движок стратегий. Чистые функции: принятый снимок (только AcceptedSnapshot, Р-42), себестоимость, границы
 * и параметры стратегии на входе; PriceIntent с классом CHANGED / NO_OP и цепочкой причин на выходе.
 * Движок не решает, можно ли отправить цену: это Price Gate, который проверяет границы заново.
 * Модели и автоподбор параметров отсутствуют [Р-10].
 */

export interface EngineInput {
  writeScope: { writeScopeId: string; currency: string; basis: PriceBasis };
  strategy: StrategyDefinition;
  snapshot: AcceptedSnapshot | null;
  cost: CostInputs | null;
  /**
   * Границы на момент расчёта; Gate перечитывает их из источника истины. `marginFloor` — пол маржи тем же расчётом, что у Gate
   * (`resolveMarginFloor`), или null, если минимальная маржа не задана или не вычисляется (тогда отказ скажет Gate) [Р-207]
   */
  bounds: { minMinor: number; maxMinor: number; marginFloor?: { amountMinor: number; minMarginBp: number } | null };
  currentPriceMinor: number | null;
  /**
   * Р-171 (шаг 41): последнее предложение, УДЕРЖАННОЕ тенью. В теневом режиме цена на витрине не двигается, поэтому
   * сравнение с ней даёт «изменить» на каждом опросе; сравнение с уже удержанным предложением даёт честное «мы это уже
   * предложили». В боевом режиме поле пустое.
   */
  shadowLastProposedMinor?: number | null;
  /**
   * Р-208 (шаг 73): предел шага (`max_step_change_bp` ограничений). Подъём к полу больше предела идёт лестницей: ступень на предел
   * шага, следующая — на следующей оценке. Предел не снимается, Gate проверяет его как у любой цены
   */
  stepLimitBp?: number | null;
  /** Р-209…Р-211: переоценка без наблюдения конкурентов — повод, изменившийся вход пола (себестоимость, курс, min_price, маржа, НДС, отказ перепроверки) */
  raiseAfter?: FloorRaiseReason | null;
  /**
   * Р-212 (шаг 74): пауза лестницы — ступень к полу не чаще периода планового пересчёта (свойство канала). `lastStepAt` — последняя
   * ступень единицы за сутки; внутри паузы подъём от цены ниже пола — «без изменения» LADDER_PACED, и наблюдения конкурентов его не
   * ускоряют
   */
  ladderPace?: { lastStepAt: Instant | null; paceSeconds: number } | null;
  /**
   * Шаг 97 [Р-219]: подъём «Win the Buy Box» — последний одобренный подъём (CREEP_UP: когда, от какой цены, к какой) и последний возврат
   * после потери (CREEP_STEP_BACK: когда, на какой цене Buy Box ушёл). Период — тот же `ladderPace.paceSeconds` (плановый пересчёт канала)
   */
  creep?: CreepState | null;
  now: Instant;
  trigger: { type: TriggerType; sourceEventId?: string };
  intentTtlSeconds?: number;
}

export interface CreepState {
  lastUp: { at: Instant; fromMinor: number; toMinor: number } | null;
  lastBack: { at: Instant; lostAtMinor: number } | null;
  /** Последнее одобренное взятие Buy Box (цель от победителя): ступень подъёма — не раньше периода и после него (живой прогон I3) */
  lastTake?: { at: Instant } | null;
}

/** Шаг 97 [Р-219]: пауза подъёма после потери Buy Box — столько периодов планового пересчёта (решение владельца: 4, при 15 минутах — час) */
export const CREEP_PAUSE_PERIODS = 4;
/** Ревью шага 97: шаг назад — только если Buy Box потерян не позже стольких периодов после подъёма */
export const CREEP_STEP_BACK_WINDOW_PERIODS = 2;
/**
 * Решение владельца после шага 97.1: ступень ВВЕРХ — и на снимке возрастом до стольких периодов планового пересчёта, пока Buy Box наш (тихий
 * рынок — безопасное время дожимать маржу; подрез конкурента сам принесёт свежий снимок). Взятие, шаг назад и прочее — только свежий снимок
 */
export const CREEP_STALE_PERIODS = 2;

export type EngineResult =
  | { kind: 'INTENT'; intent: PriceIntentDraft }
  | { kind: 'NOT_EVALUATED'; strategyType: StrategyParams['type']; reason: Reason<EngineReasonCode> };

// ---------------------------------------------------------------------------
// Требуемая полнота данных [Р-39]
// ---------------------------------------------------------------------------

/** Свежесть снимка — одно число с квитанцией решения (pricing-model) */
export { STRATEGY_STALENESS_SECONDS } from '@repracer/pricing-model';
import { STRATEGY_STALENESS_SECONDS } from '@repracer/pricing-model';

/** Шаг 101 [Р-226]: ориентир по умолчанию — прежнее поведение типа: «Beat the lowest» — самая низкая цена, «Win the Buy Box» — Buy Box */
export function anchorOf(params: StrategyParams): 'BUYBOX' | 'LOWEST' | 'LOWER_OF_TWO' {
  if (params.type === 'BEAT_LOWEST') return params.anchor ?? 'LOWEST';
  if (params.type === 'WIN_BUYBOX') return params.anchor ?? 'BUYBOX';
  return 'BUYBOX';
}
/** Шаг 101 [Р-226]: с кем соревноваться; нет поля — со всеми */
export function competeWithOf(params: StrategyParams): 'ALL' | 'CHANNEL' | 'MERCHANT' {
  return params.type === 'MATCH_BUYBOX' || params.type === 'BEAT_LOWEST' || params.type === 'WIN_BUYBOX' ? params.competeWith ?? 'ALL' : 'ALL';
}

export function requirementOf(params: StrategyParams): CompetitorRequirement {
  /**
   * Шаг 101 [Р-226]: фильтр «Compete with» — источник должен называть исполнение предложений; а где ориентир — только Buy Box («Match the Buy Box»,
   * «Beat the lowest» с ориентиром Buy Box), фильтр проверяет и держателя: без держателя не понять, входит ли Buy Box в фильтр
   */
  const filtered = competeWithOf(params) !== 'ALL';
  switch (params.type) {
    case 'FIXED':
    case 'TARGET_MARGIN':
      return { kind: null, needsBuyboxWinner: false, needsBuyboxPrice: false, needsOwnRank: false, needsShipping: false, conditions: [], maxStalenessSeconds: null };
    // Шаг 97 [Р-221]: «Match the Buy Box» нужна цена Buy Box; держатель — только чтобы не подрезать самих себя, и без него цена держится
    case 'MATCH_BUYBOX':
      return { kind: 'TOP_N', minN: 1, needsBuyboxWinner: filtered, needsBuyboxPrice: true, needsOwnRank: false, needsShipping: false, needsFulfilment: filtered, conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS };
    case 'BEAT_LOWEST': {
      const onlyBuybox = anchorOf(params) === 'BUYBOX';
      return {
        kind: params.scope === 'MARKET' ? 'CHEAPEST_ONLY' : 'TOP_N', ...(params.scope === 'MARKET' ? {} : { minN: 1 }),
        needsBuyboxWinner: onlyBuybox && filtered, needsBuyboxPrice: onlyBuybox, needsOwnRank: false, needsShipping: params.compareLanded, needsFulfilment: filtered,
        conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS,
      };
    }
    // Шаг 97 [Р-219]: «Win the Buy Box» — держатель Buy Box (наш или чужой) и доставка: цель — от landed-цены победителя
    case 'WIN_BUYBOX':
      return { kind: 'TOP_N', minN: 1, needsBuyboxWinner: true, needsBuyboxPrice: true, needsOwnRank: false, needsShipping: true, needsFulfilment: filtered, conditions: ['new'], maxStalenessSeconds: STRATEGY_STALENESS_SECONDS };
  }
}

type Completeness = CompetitorSnapshot['completeness'];

function completenessSatisfies(have: Completeness, req: CompetitorRequirement): boolean {
  if (req.kind === null || have.kind === 'FULL') return true;
  if (req.kind === 'TOP_N') return have.kind === 'TOP_N' && have.n >= (req.minN ?? 1);
  return have.kind === req.kind;
}

/** Что из требования не выполнено для конкретного снимка */
export function unmetRequirements(req: CompetitorRequirement, snapshot: CompetitorSnapshot | null, now: Instant): string[] {
  if (req.kind === null) return [];
  if (!snapshot) return ['NO_SNAPSHOT'];
  const unmet: string[] = [];
  if (!completenessSatisfies(snapshot.completeness, req)) unmet.push('COMPLETENESS');
  if (req.needsBuyboxPrice && !snapshot.buybox) unmet.push('BUYBOX_PRICE');
  // Шаг 97: держатель нужен названным — цена Buy Box без держателя (`isSelf: null`) его не заменяет
  if (req.needsBuyboxWinner && (!snapshot.buybox || snapshot.buybox.isSelf === null)) unmet.push('BUYBOX_WINNER');
  if (req.needsOwnRank && !snapshot.offers.some((o) => o.isSelf && o.rank !== undefined)) unmet.push('OWN_RANK');
  if (req.needsShipping && snapshot.offers.some((o) => !o.isSelf && !o.shipping)) unmet.push('SHIPPING');
  if (req.conditions.length > 0 && !req.conditions.includes(snapshot.condition.toLowerCase())) unmet.push('CONDITION');
  if (req.maxStalenessSeconds !== null && Date.parse(now) - Date.parse(snapshot.observedAt) > req.maxStalenessSeconds * 1000) unmet.push('STALENESS');
  return unmet;
}

/** Доступность стратегии на канале по заявленным источникам: для интерфейса и включения стратегии [Р-39] */
export function strategyAvailability(
  params: StrategyParams,
  sources: readonly CompetitorSourceDescriptor[],
): { available: true; via: string | null } | { available: false; unmet: Record<string, string[]> } {
  const req = requirementOf(params);
  if (req.kind === null) return { available: true, via: null };
  // Шаг 47: канал без источников конкурентов (eBay, Р-39) — причина названа, как в channel_data.strategy_unmet (0082): иначе недоступность
  // выглядела бы пустым списком причин
  if (sources.length === 0) return { available: false, unmet: { '*': ['NO_COMPETITOR_SOURCE'] } };
  const unmet: Record<string, string[]> = {};
  for (const s of sources) {
    const u: string[] = [];
    if (s.role !== 'PRIMARY') u.push('RECONCILIATION_ONLY');
    if (s.availability !== 'AVAILABLE') u.push(`AVAILABILITY_${s.availability}`);
    if (!completenessSatisfies(s.completeness, req)) u.push('COMPLETENESS');
    if (req.needsBuyboxPrice && !s.hasBuyboxPrice) u.push('BUYBOX_PRICE');
    if (req.needsBuyboxWinner && !s.hasBuyboxWinner) u.push('BUYBOX_WINNER');
    if (req.needsOwnRank && !s.hasOwnRank) u.push('OWN_RANK');
    if (req.needsShipping && !s.hasShipping) u.push('SHIPPING');
    // Шаг 101 [Р-226]: фильтр «Compete with» — источник называет исполнение предложений (Walmart — нет, W-05)
    if (req.needsFulfilment && !s.hasFulfilment) u.push('FULFILMENT');
    if (!req.conditions.every((c) => s.conditions.includes(c))) u.push('CONDITION');
    if (req.maxStalenessSeconds !== null && s.typicalStalenessSeconds !== null && s.typicalStalenessSeconds > req.maxStalenessSeconds) u.push('STALENESS');
    if (u.length === 0) return { available: true, via: s.source };
    unmet[s.source] = u;
  }
  return { available: false, unmet };
}

// ---------------------------------------------------------------------------
// Расчёт
// ---------------------------------------------------------------------------

function r<C extends EngineReasonCode>(code: C, params: Reason['params'] = {}): Reason<C> {
  return { code, params };
}

/**
 * Р-209, Р-210 (шаг 73): подъём к полу без снимка конкурентов — цена из данных продавца (себестоимость, комиссия, маржа). Своё правило:
 * не «из данных конкурентов» (`COMPETITOR_DERIVED_RULES`), поэтому слепок снимка ему не нужен, а остановка таких цен его не держит
 */
export const FLOOR_RAISE_RULE = 'FLOOR_RAISE';

/** Р-212: допуск паузы лестницы на ход самого пересчёта (не больше десятой части паузы) */
export const LADDER_PACE_TOLERANCE_SECONDS = 60;

/**
 * Какой пол двигает повод переоценки: границы (min_price — пол сам, max_price — действует ли пол маржи) и отказ перепроверки — любой;
 * себестоимость, комиссия, курс, гардрейл и НДС — только пол маржи
 */
function raiseAfterMoves(after: FloorRaiseReason, marginBinding: boolean): boolean {
  if (after === 'FLOOR_RECHECK' || after === 'BOUNDS_UPDATE') return true;
  return marginBinding;
}

/**
 * Шаг 101 [Р-226]: какой ориентир у «меньшей из двух» (у одиночного ориентира — он сам). Обе цены есть — меньшая, при равенстве — Buy Box (держатель
 * Buy Box и есть самая низкая цена); одной нет — другая, и причина, почему Buy Box не участвовал. Хотя бы один ориентир есть — проверяет вызывающий
 */
function pickAnchor(bb: { minor: number } | { unused: (typeof BUYBOX_UNUSED)[number] }, lowest: number | null): {
  anchorMinor: number;
  params: { anchorUsed: 'BUYBOX' | 'LOWEST'; anchorMinor: number; otherAnchorMinor?: number; buyboxUnused?: (typeof BUYBOX_UNUSED)[number] };
} {
  if ('unused' in bb) return { anchorMinor: lowest!, params: { anchorUsed: 'LOWEST', anchorMinor: lowest!, buyboxUnused: bb.unused } };
  if (lowest === null) return { anchorMinor: bb.minor, params: { anchorUsed: 'BUYBOX', anchorMinor: bb.minor } };
  return bb.minor <= lowest
    ? { anchorMinor: bb.minor, params: { anchorUsed: 'BUYBOX', anchorMinor: bb.minor, otherAnchorMinor: lowest } }
    : { anchorMinor: lowest, params: { anchorUsed: 'LOWEST', anchorMinor: lowest, otherAnchorMinor: bb.minor } };
}

export function runStrategy(input: EngineInput): EngineResult {
  const { strategy, snapshot, writeScope, bounds, currentPriceMinor: current, now } = input;
  const heldInShadow = input.shadowLastProposedMinor ?? null;
  const pace = input.ladderPace && Number.isSafeInteger(input.ladderPace.paceSeconds) && input.ladderPace.paceSeconds > 0 ? input.ladderPace : null;
  const params = strategy.params;
  const currency = writeScope.currency;
  const notEvaluated = (reason: Reason<EngineReasonCode>): EngineResult => ({ kind: 'NOT_EVALUATED', strategyType: params.type, reason });
  const safe = (v: unknown): number | null => (Number.isSafeInteger(v) ? (v as number) : null);
  const invalidMoney = (param: string, value: unknown, allowed: 'POSITIVE' | 'NON_NEGATIVE') =>
    notEvaluated(r('INVALID_STRATEGY_PARAMS', { param, settingMinor: safe(value), allowed, currency }));

  if (!Number.isSafeInteger(bounds.minMinor) || !Number.isSafeInteger(bounds.maxMinor) || bounds.minMinor <= 0 || bounds.maxMinor < bounds.minMinor) {
    return notEvaluated(r('BOUNDS_INVALID', { minMinor: safe(bounds.minMinor), maxMinor: safe(bounds.maxMinor), currency }));
  }
  if (!Number.isSafeInteger(strategy.deadbandMinor) || strategy.deadbandMinor < 0) return invalidMoney('deadbandMinor', strategy.deadbandMinor, 'NON_NEGATIVE');

  /**
   * Р-207 (шаг 72, OQ-250): пол стратегии — наибольшее из min_price и пола маржи [Р-5]. До решения стратегия, следующая за рынком,
   * вставала на min_price, а пол маржи держала только Gate ОТКАЗОМ — и цена, уже стоящая ниже пола маржи, там и оставалась. Пол маржи
   * выше max_price стратегия не берёт: это противоречие настройки, его называет Gate (MARGIN_FLOOR_ABOVE_MAX_PRICE).
   */
  const margin = bounds.marginFloor ?? null;
  const marginBinding = margin !== null && Number.isSafeInteger(margin.amountMinor) && margin.amountMinor > bounds.minMinor && margin.amountMinor <= bounds.maxMinor;
  const floorMinor = marginBinding ? margin!.amountMinor : bounds.minMinor;
  const belowFloor = current !== null && current < floorMinor;
  const stepLimit = input.stepLimitBp !== null && input.stepLimitBp !== undefined && Number.isSafeInteger(input.stepLimitBp) && input.stepLimitBp > 0 ? input.stepLimitBp : null;
  const floorParams = { floorMinor, bound: marginBinding ? 'margin_floor' : 'min', ...(marginBinding ? { minMarginBp: margin!.minMarginBp } : {}),
    // Повод — только у пола, который он двигает (ревью шага 73, находка 2): min_price двигает только новая версия min_price, пол маржи —
    // себестоимость, комиссия, курс, гардрейл и НДС; отказ перепроверки — любой пол
    ...(input.raiseAfter && raiseAfterMoves(input.raiseAfter, marginBinding) ? { after: input.raiseAfter } : {}) };
  /** Шаг в базисных пунктах, как его считает Gate: вверх до пункта */
  const stepBp = (from: number, to: number) => Math.ceil(((to - from) * 10_000) / from);
  /** Наибольшая цена, до которой Gate пропустит шаг от `from` */
  const rungFrom = (from: number) => from + Math.floor((from * stepLimit!) / 10_000);
  /**
   * Подъём от нынешней цены ниже пола [Р-207]: до пола, если шаг в пределе; иначе — ступень на предел шага и «осталось ~N шагов»
   * [Р-208]. Ступень ниже пола, но выше нынешней цены: её пропускают Gate и база только как ступень лестницы (0180)
   */
  const raiseStep = (): { to: number; reason: Reason } => {
    const cur = current!;
    if (stepLimit !== null && stepBp(cur, floorMinor) > stepLimit) {
      const to = rungFrom(cur);
      if (to > cur) {
        let p = to;
        let left = 0;
        for (let guard = 0; p < floorMinor && guard < 10_000; guard += 1) {
          left += 1;
          if (stepBp(p, floorMinor) <= stepLimit) break;
          const next = rungFrom(p);
          if (next <= p) break;
          p = next;
        }
        return { to, reason: r('RAISED_TOWARD_FLOOR', { currentMinor: cur, ...floorParams, stepLimitBp: stepLimit, stepsLeft: left, currency }) };
      }
    }
    return { to: floorMinor, reason: r('RAISED_TO_FLOOR', { currentMinor: cur, ...floorParams, currency }) };
  };
  /**
   * NO_OP стратегии, следующей за рынком (удержание вне границ, Buy Box уже наш, конкурентов нет), не держит цену ниже пола: при
   * нынешней цене ниже пола она поднимается к полу обычным путём (сравнение с предложением тени, Gate, бюджет, журнал)
   */
  const holdOrRaise = (holdAt: number, main: Reason, chain: Reason[], reference: number | null): EngineResult => {
    if (!belowFloor) return intent('NO_OP', holdAt, main, chain, reference);
    const step = raiseStep();
    return propose(step.to, [...chain, step.reason], reference, true);
  };
  const marketFollowing = params.type === 'MATCH_BUYBOX' || params.type === 'BEAT_LOWEST' || params.type === 'WIN_BUYBOX';

  const req = requirementOf(params);
  const unmet = unmetRequirements(req, snapshot, now);
  // Решение владельца после шага 97.1: снимок старше свежести, но не старше двух периодов, при нашем Buy Box — только для ветки подъёма
  const quietRaise = params.type === 'WIN_BUYBOX' && params.creepUp && unmet.length === 1 && unmet[0] === 'STALENESS'
    && snapshot?.buybox?.isSelf === true && current !== null && !belowFloor && pace !== null
    && Date.parse(now) - Date.parse(snapshot.observedAt) <= CREEP_STALE_PERIODS * pace.paceSeconds * 1000;
  if (unmet.length > 0 && !quietRaise) {
    /**
     * Р-210 (шаг 73, OQ-253): нынешняя цена ниже пола — подъём к полу и без свежего снимка конкурентов: он опирается только на данные
     * продавца (себестоимость, комиссию, маржу), а наблюдения конкурента можно ждать часами. Р-209: так же — переоценка после отказа
     * перепроверки перед отправкой по новому курсу
     */
    if (marketFollowing && belowFloor) {
      const step = raiseStep();
      // Цена из данных продавца, а не конкурентов: своё правило — слепок снимка ей не нужен, остановка цен из данных конкурентов [Р-51]
      // её не держит
      return propose(step.to, [step.reason], null, true, FLOOR_RAISE_RULE);
    }
    return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', {
      unmet: unmet.join(','), requiredCompleteness: req.kind, requiredN: req.minN ?? null,
      actualCompleteness: snapshot?.completeness.kind ?? null, actualN: snapshot?.completeness.kind === 'TOP_N' ? snapshot.completeness.n : null,
      maxStalenessSeconds: req.maxStalenessSeconds, ageSeconds: snapshot ? Math.max(0, Math.round((Date.parse(now) - Date.parse(snapshot.observedAt)) / 1000)) : null,
    }));
  }
  if (snapshot && req.kind !== null) {
    const foreign = [snapshot.buybox?.price, ...snapshot.offers.map((o) => o.price)].find((m) => m && m.currency !== writeScope.currency);
    if (foreign) return notEvaluated(r('ENGINE_CURRENCY_MISMATCH', { source: 'SNAPSHOT', actual: foreign.currency, expected: writeScope.currency }));
  }

  /**
   * Шаг 101 [Р-226]: фильтр «Compete with» — до расчёта: стратегия видит только прошедших фильтр, неизвестное исполнение исключено и
   * посчитано. Никого после фильтра — «без изменения» NO_ELIGIBLE_COMPETITORS: к «всем» фильтр не откатывается
   */
  const competeWith = competeWithOf(params);
  const pool = competeWith !== 'ALL' && snapshot && req.kind !== null ? filterCompetitors(snapshot.offers, competeWith) : null;
  /** Предложение-держатель Buy Box: канал назвал его признаком держателя или продавцом Buy Box */
  const holderOffer = () => snapshot!.offers.find((o) => !o.isSelf && o.holdsBuyBox === true)
    ?? (snapshot!.buybox?.sellerRef ? snapshot!.offers.find((o) => !o.isSelf && o.sellerRef === snapshot!.buybox!.sellerRef) : undefined);
  /** Держатель Buy Box под фильтром: проходит, вне фильтра или канал не назвал его исполнения */
  const holderUnderFilter = (): 'OK' | 'EXCLUDED' | 'UNKNOWN' => {
    if (pool === null) return 'OK';
    const h = holderOffer();
    if (!h) return 'UNKNOWN';
    const why = competitorExclusion(h.fulfillment, competeWith);
    return why === null ? 'OK' : why === 'FILTER' ? 'EXCLUDED' : 'UNKNOWN';
  };
  /** Чужие предложения, с которыми стратегия соревнуется: прошедшие фильтр или все */
  const competitorsOf = () => (pool ? [...pool.eligible] : snapshot!.offers.filter((o) => !o.isSelf));
  const noEligible = (buyboxHolder?: 'EXCLUDED' | 'UNKNOWN'): EngineResult => {
    const why = r('NO_ELIGIBLE_COMPETITORS', { competeWith, offersTotal: pool!.total, offersUnknown: pool!.unknown, ...(buyboxHolder ? { buyboxHolder } : {}) });
    return holdOrRaise(current ?? floorMinor, why, [why], null);
  };
  /**
   * Шаг 101 [Р-226]: ориентир Buy Box (с доставкой, где стратегия сравнивает landed) или почему он не участвует: Buy Box нет, он наш, держатель
   * неизвестен (под фильтром — исполнение не названо; без фильтра — цена равна нашей, и Buy Box, возможно, наш), держатель вне фильтра,
   * доставка Buy Box не названа
   */
  const buyboxAnchor = (landed: boolean): { minor: number } | { unused: (typeof BUYBOX_UNUSED)[number] } => {
    const bb = snapshot!.buybox;
    if (!bb) return { unused: 'ABSENT' };
    if (bb.isSelf === true) return { unused: 'SELF' };
    if (bb.isSelf === null) {
      if (pool !== null || (current !== null && current === bb.price.amountMinor)) return { unused: 'UNKNOWN' };
    } else {
      const h = holderUnderFilter();
      if (h !== 'OK') return { unused: h };
    }
    if (!landed) return { minor: bb.price.amountMinor };
    const ship = bb.shipping?.amountMinor ?? holderOffer()?.shipping?.amountMinor ?? null;
    return ship === null ? { unused: 'NO_SHIPPING' } : { minor: bb.price.amountMinor + ship };
  };

  const explanation: Reason[] = [];
  let target: number;
  let referenceMinor: number | null = null;
  let capable = false;
  if (pool) {
    if (pool.eligible.length === 0) return noEligible();
    explanation.push(r('COMPETITORS_FILTERED', { competeWith, offersConsidered: pool.eligible.length, offersTotal: pool.total, offersUnknown: pool.unknown }));
  }

  switch (params.type) {
    case 'FIXED': {
      if (!Number.isSafeInteger(params.priceMinor) || params.priceMinor <= 0) return invalidMoney('priceMinor', params.priceMinor, 'POSITIVE');
      target = params.priceMinor;
      explanation.push(r('FIXED_PRICE', { targetMinor: target, currency }));
      break;
    }
    case 'TARGET_MARGIN': {
      const cost = input.cost;
      if (!cost) return notEvaluated(r('COST_INPUTS_MISSING', { missing: 'COST_PROFILE' }));
      if (cost.currency !== writeScope.currency) return notEvaluated(r('ENGINE_CURRENCY_MISMATCH', { source: 'COST', actual: cost.currency, expected: writeScope.currency }));
      const priced = storefrontPriceForMarginBp(cost, params.targetMarginBp);
      if (!priced.ok) {
        if (priced.cause === 'VAT_UNKNOWN') return notEvaluated(r('COST_INPUTS_MISSING', { missing: 'VAT_RATE' }));
        if (priced.cause === 'UNATTAINABLE') {
          return notEvaluated(r('MARGIN_UNATTAINABLE', {
            marginBp: params.targetMarginBp, feeRateBp: cost.feeRateBp, fixedFeeMinor: cost.fixedFeeMinor, unitCostMinor: cost.unitCostMinor,
            vatRateBp: cost.tax.regime === 'VAT_INCLUDED' ? cost.tax.vatRateBp : null, currency,
          }));
        }
        return notEvaluated(r('INVALID_STRATEGY_PARAMS', {
          param: 'targetMarginBp', settingBp: Number.isInteger(params.targetMarginBp) ? params.targetMarginBp : null, allowed: 'MARGIN_BELOW_100_PERCENT',
        }));
      }
      target = priced.priceMinor;
      referenceMinor = cost.unitCostMinor > 0 ? cost.unitCostMinor : null;
      explanation.push(r('MARGIN_TARGET', { marginBp: params.targetMarginBp, targetMinor: target, currency }));
      break;
    }
    case 'MATCH_BUYBOX': {
      if (!Number.isSafeInteger(params.undercutMinor) || params.undercutMinor < 0) return invalidMoney('undercutMinor', params.undercutMinor, 'NON_NEGATIVE');
      const bb = snapshot!.buybox!;
      capable = true;
      /**
       * Шаг 97 [Р-221]: канал не называет держателя (Amazon, A-29), а наша цена равна цене Buy Box — возможно, Buy Box наш. Подрез здесь
       * подрезал бы нашу же цену на каждом уведомлении до пола; цена держится. Цена Buy Box НЕ равна нашей — держатель не мы, и это
       * обычный путь
       */
      if (bb.isSelf === null && current !== null && current === bb.price.amountMinor) {
        const unknown = r('BUYBOX_HOLDER_UNKNOWN', { buyboxMinor: bb.price.amountMinor, currentMinor: current, currency });
        return holdOrRaise(current, unknown, [...explanation, unknown], bb.price.amountMinor);
      }
      if (bb.isSelf) {
        if (params.holdWhenWinning) {
          return holdOrRaise(current ?? bb.price.amountMinor, r('ALREADY_WINNING_BUYBOX'), [...explanation, r('ALREADY_WINNING_BUYBOX')], bb.price.amountMinor);
        }
        // Не соревнуемся сами с собой: ориентир — лучшее чужое предложение по рангу (под фильтром — среди прошедших его)
        const next = competitorsOf().sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))[0];
        if (!next) return holdOrRaise(current ?? bb.price.amountMinor, r('NO_COMPETITOR_OFFERS'), [...explanation, r('NO_COMPETITOR_OFFERS')], null);
        referenceMinor = next.price.amountMinor;
      } else {
        // Шаг 101 [Р-226]: под фильтром Buy Box — ориентир, только если его держатель проходит фильтр
        const holder = holderUnderFilter();
        if (holder !== 'OK') return noEligible(holder);
        referenceMinor = bb.price.amountMinor;
      }
      target = referenceMinor - params.undercutMinor;
      explanation.push(params.undercutMinor > 0
        ? r('BUYBOX_UNDERCUT', { buyboxMinor: referenceMinor, undercutMinor: params.undercutMinor, targetMinor: target, currency })
        : r('BUYBOX_MATCH', { buyboxMinor: referenceMinor, targetMinor: target, currency }));
      break;
    }
    case 'BEAT_LOWEST': {
      if (!Number.isSafeInteger(params.undercutMinor) || params.undercutMinor < 0) return invalidMoney('undercutMinor', params.undercutMinor, 'NON_NEGATIVE');
      capable = true;
      const anchor = anchorOf(params);
      const competitors = competitorsOf();
      const landed = competitors.map((o) => (params.compareLanded ? o.totalPrice?.amountMinor ?? o.price.amountMinor + (o.shipping?.amountMinor ?? 0) : o.price.amountMinor));
      const lowest = landed.length > 0 ? Math.min(...landed) : null;
      // Шаг 101 [Р-226]: ориентир Buy Box или меньшая из двух; самая низкая (умолчание) — прежний путь
      const bbA = anchor === 'LOWEST' ? null : buyboxAnchor(params.compareLanded);
      if (anchor === 'BUYBOX' && bbA && 'unused' in bbA) {
        const bb = snapshot!.buybox;
        if (bbA.unused === 'SELF') return holdOrRaise(current ?? bb!.price.amountMinor, r('ALREADY_WINNING_BUYBOX'), [...explanation, r('ALREADY_WINNING_BUYBOX')], bb!.price.amountMinor);
        if (bbA.unused === 'UNKNOWN' && pool === null && current !== null) {
          const unknown = r('BUYBOX_HOLDER_UNKNOWN', { buyboxMinor: bb!.price.amountMinor, currentMinor: current, currency });
          return holdOrRaise(current, unknown, [...explanation, unknown], bb!.price.amountMinor);
        }
        if (bbA.unused === 'EXCLUDED' || bbA.unused === 'UNKNOWN') return noEligible(bbA.unused);
        return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: bbA.unused === 'NO_SHIPPING' ? 'SHIPPING' : 'BUYBOX_PRICE' }));
      }
      // Обоих ориентиров нет (или самой низкой — при ориентире «самая низкая») — прежняя страховка «канал не дал данных»
      // Шаг 75 (ревью шага 72, находка 10): без нынешней цены удержание — на полу стратегии (min_price или пол маржи), а не на min_price
      if (lowest === null && (bbA === null || 'unused' in bbA)) {
        return holdOrRaise(current ?? floorMinor, r('NO_COMPETITOR_OFFERS'), [...explanation, r('NO_COMPETITOR_OFFERS')], null);
      }
      let ownShipping = 0;
      if (params.compareLanded) {
        const self = snapshot!.offers.find((o) => o.isSelf);
        if (!self?.shipping) return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: 'OWN_SHIPPING' }));
        ownShipping = self.shipping.amountMinor;
      }
      if (bbA === null) {
        referenceMinor = lowest!;
        target = referenceMinor - params.undercutMinor - ownShipping;
        const n = snapshot!.completeness.kind === 'TOP_N' ? snapshot!.completeness.n : null;
        explanation.push(params.undercutMinor > 0
          ? r('LOWEST_UNDERCUT', { lowestMinor: referenceMinor, undercutMinor: params.undercutMinor, targetMinor: target, scope: params.scope, n, currency })
          : r('LOWEST_MATCH', { lowestMinor: referenceMinor, scope: params.scope, n, targetMinor: target, currency }));
        break;
      }
      // Одиночный ориентир Buy Box — без пары: «какой победил» говорит только меньшая из двух
      const pick = pickAnchor(bbA, anchor === 'LOWER_OF_TWO' ? lowest : null);
      referenceMinor = pick.anchorMinor;
      target = pick.anchorMinor - params.undercutMinor - ownShipping;
      explanation.push(r('ANCHOR_UNDERCUT', {
        strategyType: 'BEAT_LOWEST', anchorSetting: anchor, ...pick.params, undercutMinor: params.undercutMinor,
        ...(params.compareLanded ? { ownShippingMinor: ownShipping } : {}), targetMinor: target, currency,
      }));
      break;
    }
    case 'WIN_BUYBOX': {
      if (!Number.isSafeInteger(params.undercutMinor) || params.undercutMinor < 0) return invalidMoney('undercutMinor', params.undercutMinor, 'NON_NEGATIVE');
      if (!Number.isSafeInteger(params.fulfillmentHandicapMinor) || params.fulfillmentHandicapMinor < 0) {
        return invalidMoney('fulfillmentHandicapMinor', params.fulfillmentHandicapMinor, 'NON_NEGATIVE');
      }
      if (params.creepUp && (!Number.isSafeInteger(params.creepStepBp) || params.creepStepBp <= 0)) {
        return notEvaluated(r('INVALID_STRATEGY_PARAMS', { param: 'creepStepBp', settingBp: Number.isInteger(params.creepStepBp) ? params.creepStepBp : null, allowed: 'POSITIVE' }));
      }
      capable = true;
      const bb = snapshot!.buybox!;
      const creep = input.creep ?? null;
      const period = pace?.paceSeconds ?? null;
      const pausedUntilMs = creep?.lastBack && period !== null ? Date.parse(creep.lastBack.at) + CREEP_PAUSE_PERIODS * period * 1000 : null;
      const paused = pausedUntilMs !== null && Date.parse(now) < pausedUntilMs;
      if (bb.isSelf) {
        // Buy Box наш: цену не снижаем (Keep when winning); подъём — только за флагом creepUp
        if (!params.creepUp || current === null || belowFloor) {
          const keep = r('ALREADY_WINNING_BUYBOX');
          return holdOrRaise(current ?? bb.price.amountMinor, keep, [...explanation, keep], bb.price.amountMinor);
        }
        if (paused) {
          const wait = r('CREEP_PAUSED', { currentMinor: current, pausedUntil: new Date(pausedUntilMs!).toISOString(), currency });
          return intent('NO_OP', current, wait, [wait], bb.price.amountMinor);
        }
        if (current >= bounds.maxMinor) {
          const top = r('CREEP_AT_MAX', { currentMinor: current, maxMinor: bounds.maxMinor, currency });
          return intent('NO_OP', current, top, [top], bb.price.amountMinor);
        }
        // Подъём не чаще периода планового пересчёта — от прошлой ступени или от взятия Buy Box (взятие — тоже изменение цены); допуск
        // в минуту — только пересчёту (как у лестницы, Р-212)
        const lastMoveMs = Math.max(creep?.lastUp ? Date.parse(creep.lastUp.at) : Number.NEGATIVE_INFINITY, creep?.lastTake ? Date.parse(creep.lastTake.at) : Number.NEGATIVE_INFINITY);
        if (Number.isFinite(lastMoveMs) && period !== null) {
          const tolerance = input.trigger.type === 'COMPETITOR_CHANGE' ? 0 : Math.min(LADDER_PACE_TOLERANCE_SECONDS, Math.floor(period / 10));
          const nextAt = lastMoveMs + period * 1000;
          if (Date.parse(now) < nextAt - tolerance * 1000) {
            const wait = r('CREEP_PACED', { currentMinor: current, nextStepAt: new Date(nextAt).toISOString(), currency });
            return intent('NO_OP', current, wait, [wait], bb.price.amountMinor);
          }
        }
        // Шаг — в пределах шага Gate (больший урезается до предела), не меньше цента и не выше максимума
        const stepBp = stepLimit !== null ? Math.min(params.creepStepBp, stepLimit) : params.creepStepBp;
        const up = Math.min(bounds.maxMinor, current + Math.max(1, Math.floor((current * stepBp) / 10_000)));
        referenceMinor = bb.price.amountMinor;
        target = up;
        explanation.push(r('CREEP_UP', { fromMinor: current, toMinor: up, creepStepBp: stepBp, currency }));
        break;
      }
      /**
       * Buy Box чужой. Потерян сразу после нашего подъёма (цена — та, к которой мы поднялись, возврата после него не было) — назад к
       * последней выигрышной цене и пауза подъёма; цена потери — потолок на время паузы
       */
      // Ревью шага 97, находка (в2): «сразу» — не дольше двух периодов после подъёма; прежняя цена вне рамок (пол поднялся) — обычная цель
      // от победителя, иначе потеря через сутки откатывала к давней цене, а «держать на границе» застревало до суток
      const up = creep?.lastUp ?? null;
      const rightAfter = up !== null && period !== null && Date.parse(now) - Date.parse(up.at) <= CREEP_STEP_BACK_WINDOW_PERIODS * period * 1000;
      if (up && rightAfter && current !== null && current === up.toMinor && up.fromMinor < up.toMinor
          && up.fromMinor >= floorMinor && up.fromMinor <= bounds.maxMinor
          && (!creep!.lastBack || Date.parse(creep!.lastBack.at) < Date.parse(up.at))) {
        const until = new Date(Date.parse(now) + CREEP_PAUSE_PERIODS * (period ?? 0) * 1000).toISOString();
        // Возврат проходит те же рамки: пол, потолок, Gate — прежняя выигрышная цена могла оказаться ниже поднявшегося с тех пор пола
        referenceMinor = bb.price.amountMinor;
        target = up.fromMinor;
        explanation.push(r('CREEP_STEP_BACK', { lostAtMinor: current, backToMinor: up.fromMinor, pausedUntil: until, currency }));
        break;
      }
      const anchor = anchorOf(params);
      if (anchor !== 'BUYBOX') {
        // Шаг 101 [Р-226]: ориентир «самая низкая» или меньшая из двух — landed-цены прошедших фильтр; гандикап — по исполнению ориентира
        const self = snapshot!.offers.find((o) => o.isSelf);
        const competitors = competitorsOf();
        const landedOf = (o: (typeof competitors)[number]) => o.totalPrice?.amountMinor ?? o.price.amountMinor + (o.shipping?.amountMinor ?? 0);
        const cheapest = competitors.reduce<(typeof competitors)[number] | null>((best, o) => (best === null || landedOf(o) < landedOf(best) ? o : best), null);
        const bbA = anchor === 'LOWER_OF_TWO' ? buyboxAnchor(true) : null;
        if (cheapest === null && (bbA === null || 'unused' in bbA)) {
          return holdOrRaise(current ?? floorMinor, r('NO_COMPETITOR_OFFERS'), [...explanation, r('NO_COMPETITOR_OFFERS')], null);
        }
        if (!self?.shipping) return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: 'OWN_SHIPPING' }));
        const pick = pickAnchor(bbA ?? { unused: 'ABSENT' }, cheapest === null ? null : landedOf(cheapest));
        const anchoredKind = fulfilmentKind((pick.params.anchorUsed === 'BUYBOX' ? holderOffer() : cheapest)?.fulfillment);
        const handicap = anchoredKind === 'CHANNEL' && fulfilmentKind(self.fulfillment) === 'MERCHANT' ? params.fulfillmentHandicapMinor : 0;
        referenceMinor = pick.anchorMinor;
        target = pick.anchorMinor - params.undercutMinor - handicap - self.shipping.amountMinor;
        const { buyboxUnused, ...rest } = pick.params;
        explanation.push(r('ANCHOR_UNDERCUT', {
          strategyType: 'WIN_BUYBOX', anchorSetting: anchor, ...rest, ...(anchor === 'LOWER_OF_TWO' && buyboxUnused ? { buyboxUnused } : {}),
          undercutMinor: params.undercutMinor, handicapMinor: handicap, ownShippingMinor: self.shipping.amountMinor, targetMinor: target, currency,
        }));
      } else {
      // Шаг 101 [Р-226]: под фильтром Buy Box — ориентир, только если его держатель проходит фильтр; иначе не с кем соревноваться
      const holder = holderUnderFilter();
      if (holder !== 'OK') return noEligible(holder);
      // Цель — от landed-цены победителя: цена Buy Box и доставка победителя (у Buy Box или у предложения-держателя)
      const winner = holderOffer();
      const winnerShipping = bb.shipping?.amountMinor ?? winner?.shipping?.amountMinor ?? null;
      if (winnerShipping === null) return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: 'SHIPPING' }));
      const self = snapshot!.offers.find((o) => o.isSelf);
      if (!self?.shipping) return notEvaluated(r('COMPETITOR_REQUIREMENT_NOT_MET', { unmet: 'OWN_SHIPPING' }));
      const winnerLanded = bb.price.amountMinor + winnerShipping;
      const winnerKind = fulfilmentKind(winner?.fulfillment);
      // Гандикап — только когда канал назвал оба исполнения: победителя исполняет канал, а нас — нет
      const handicap = winnerKind === 'CHANNEL' && fulfilmentKind(self.fulfillment) === 'MERCHANT' ? params.fulfillmentHandicapMinor : 0;
      referenceMinor = winnerLanded;
      target = winnerLanded - params.undercutMinor - handicap - self.shipping.amountMinor;
      explanation.push(r('BUYBOX_WIN_TARGET', {
        winnerLandedMinor: winnerLanded, undercutMinor: params.undercutMinor, handicapMinor: handicap, ownShippingMinor: self.shipping.amountMinor,
        ...(winnerKind ? { winnerFulfilment: winnerKind } : {}), targetMinor: target, currency,
      }));
      }
      // Пока идёт пауза, цена потери — потолок: выше неё не предлагаем
      if (paused && creep?.lastBack && target >= creep.lastBack.lostAtMinor) {
        const ceiling = creep.lastBack.lostAtMinor;
        explanation.push(r('CAPPED_AT_CREEP_CEILING', { targetMinor: target, ceilingMinor: ceiling, currency }));
        target = ceiling - 1;
      }
      break;
    }
  }

  // Границы: стратегии, следующие за рынком, встают на границу или держат цену; фиксированная цена и маржа —
  // нет: конфликт настройки с границами должен дойти до Gate и быть виден как REJECTED_BY_GATE [Р-44]
  let proposed = target;
  if (capable && (target < floorMinor || target > bounds.maxMinor)) {
    const atBound = (params as { atBound: 'CAP' | 'HOLD' }).atBound;
    if (atBound === 'HOLD') {
      // Нижняя граница удержания — пол стратегии (min_price или пол маржи, Р-207): цель ниже пола маржи не уходит в Gate на отказ
      const held = r('TARGET_OUTSIDE_BOUNDS_HOLD', { targetMinor: target, minMinor: floorMinor, maxMinor: bounds.maxMinor, currency });
      if (current === null) return notEvaluated(held);
      return holdOrRaise(current, held, [...explanation, held], referenceMinor);
    }
    if (target < floorMinor) {
      proposed = floorMinor;
      explanation.push(marginBinding
        ? r('CAPPED_AT_MARGIN_FLOOR', { targetMinor: target, floorMinor, minMinor: bounds.minMinor, minMarginBp: margin!.minMarginBp, currency })
        : r('CAPPED_AT_MIN_PRICE', { targetMinor: target, minMinor: bounds.minMinor, currency }));
      if (belowFloor) {
        const step = raiseStep();
        proposed = step.to;
        explanation.push(step.reason);
      }
    } else {
      proposed = bounds.maxMinor;
      explanation.push(r('CAPPED_AT_MAX_PRICE', { targetMinor: target, maxMinor: bounds.maxMinor, currency }));
    }
  }
  if (proposed <= 0) proposed = bounds.minMinor;
  /**
   * Р-208: нынешняя цена ниже пола, предложение на полу или выше, но шаг до него больше предела — ступень к полу вместо отказа Gate
   * STEP_LIMIT на каждой оценке; дальше пола лестница не ведёт
   */
  if (belowFloor && stepLimit !== null && proposed >= floorMinor && stepBp(current!, proposed) > stepLimit) {
    const step = raiseStep();
    proposed = step.to;
    explanation.push(step.reason);
  }
  return propose(proposed, explanation, referenceMinor, belowFloor && proposed > current!);

  /**
   * Предложение цены: сравнение с нынешней ценой и с предложением тени. Подъём от цены ниже пола (до пола, ступенью или выше)
   * зоной нечувствительности не глушится — она не держит цену ниже пола [Р-207, Р-208]
   */
  function propose(proposed: number, chain: Reason[], reference: number | null, raising = false, ruleCode: string = params.type): EngineResult {
    /**
     * Р-212 (шаг 74): подъём от цены ниже пола — ступень лестницы; после ступени следующая не раньше паузы (период планового пересчёта),
     * откуда бы ни пришла оценка — снимок конкурента, запрос базы или расписание. Допуск в минуту (не больше десятой паузы) — только
     * пересчёту, на его собственный ход: единица одного захода оценивается в разные секунды
     */
    if (raising && belowFloor && pace !== null && pace.lastStepAt !== null) {
      // Допуск — только оценке пересчёта (расписание, запрос базы): наблюдение конкурента ступень не ускоряет даже на минуту
      const tolerance = input.trigger.type === 'COMPETITOR_CHANGE' ? 0 : Math.min(LADDER_PACE_TOLERANCE_SECONDS, Math.floor(pace.paceSeconds / 10));
      const nextAt = Date.parse(pace.lastStepAt) + pace.paceSeconds * 1000;
      if (Date.parse(now) < nextAt - tolerance * 1000) {
        const paced = r('LADDER_PACED', { currentMinor: current!, floorMinor, nextStepAt: new Date(nextAt).toISOString(), currency });
        return intent('NO_OP', current!, paced, [...chain, paced], reference, ruleCode);
      }
    }
    if (current !== null && !raising) {
      const delta = Math.abs(proposed - current);
      if (delta === 0) {
        const same = r('ALREADY_AT_TARGET', { targetMinor: proposed, currency });
        return intent('NO_OP', current, same, [...chain, same], reference, ruleCode);
      }
      if (delta < strategy.deadbandMinor) {
        const band = r('WITHIN_DEADBAND', { deltaMinor: delta, deadbandMinor: strategy.deadbandMinor, currency });
        return intent('NO_OP', current, band, [...chain, band], reference, ruleCode);
      }
    }
    /**
     * Р-171: то же самое предложение уже удержано тенью — повторять его незачем. Проверка стоит ПОСЛЕ сравнения с текущей
     * ценой; в тени именно она превращает поток дублей в один held-write на изменение. В бою поле пустое: хранилище отдаёт
     * предложение тени только у аккаунта в тени (шаг 64 — до этого оно оставалось после перевода в бой, и цена, уже
     * предложенная тенью, в бою не уходила никогда).
     */
    if (heldInShadow !== null && Math.abs(proposed - heldInShadow) <= strategy.deadbandMinor) {
      const already = r('SHADOW_ALREADY_PROPOSED', { proposedMinor: proposed, heldMinor: heldInShadow, currency });
      return intent('NO_OP', current ?? heldInShadow, already, [...chain, already], reference, ruleCode);
    }
    return intent('CHANGED', proposed, chain[chain.length - 1]!, chain, reference, ruleCode);
  }

  function intent(intentClass: 'CHANGED' | 'NO_OP', proposedMinor: number, main: Reason, chain: Reason[], reference: number | null, ruleCode: string = params.type): EngineResult {
    const ttl = input.intentTtlSeconds ?? 600;
    return {
      kind: 'INTENT',
      intent: {
        writeScopeId: writeScope.writeScopeId,
        strategyId: strategy.strategyId,
        strategyVersion: strategy.version,
        trigger: input.trigger,
        ruleCode,
        intentClass,
        proposedMinor,
        currentMinor: current,
        referenceMinor: reference,
        currency: writeScope.currency,
        basis: writeScope.basis,
        reason: main,
        explanation: chain,
        inputs: {
          ...(snapshot?.sourceEventId ? { snapshotSourceEventId: snapshot.sourceEventId } : {}),
          ...(snapshot ? { snapshotObservedAt: snapshot.observedAt, snapshotSource: snapshot.source } : {}),
          ...(input.cost ? { costProfileId: input.cost.costProfileId } : {}),
          boundsAtStrategy: { minMinor: bounds.minMinor, maxMinor: bounds.maxMinor },
        },
        createdAt: now,
        expiresAt: new Date(Date.parse(now) + ttl * 1000).toISOString(),
      },
    };
  }
}
