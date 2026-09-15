import type { CompetitorSnapshot, Instant, Money, PriceBasis } from '@repracer/channel-port';
import { SANITY_RULES as RULESET_RULES, type SanityRuleset } from '@repracer/pricing-model';
import {
  markAcceptedBySanity,
  SANITY_ALARM_CLASS,
  type AcceptedSnapshot,
  type AlarmClass,
  type Reason,
  type SanityCheckRecord,
  type SanityNoteCode,
  type SanityReasonCode,
  type SanityWarningCode,
  convertMinor,
  type FxApplied,
  type FxQuote,
} from '@repracer/pricing-model';

/**
 * Проверка правдоподобия входных данных до движка стратегий [Р-42, Р-49, Р-50, Р-55].
 *
 * Основные якоря — величины, которые система не меняет сама, в порядке применения:
 *   1) себестоимость товара; 2) внутренняя согласованность снимка; 3) тот же EAN на другом канале тенанта;
 *   4) историческое распределение единицы записи.
 * Наша собственная цена — вспомогательный якорь: расхождение с ней даёт предупреждение, но не отклоняет снимок.
 * Проверять снимок относительно цены, которую система сама меняет, — замкнутый круг (ловушка OQ-90, холодный старт).
 *
 * Без единого основного якоря снимок не используется (fail-closed, INV-05): сверить цену не с чем.
 * Чистая функция. Контекст — данные одного тенанта (AUP, INV-07).
 */

export const SANITY_RULESET_VERSION = 'r49.1';

export type AnchorName = 'COST' | 'INTERNAL' | 'CROSS_CHANNEL' | 'HISTORY';

export interface SanityConfig {
  /** Якорь 1: цена конкурента ниже себестоимости × costLowRatio или выше × costHighRatio — неправдоподобна */
  costLowRatio: number;
  costHighRatio: number;
  /** Якорь 2: сколько чужих предложений нужно, чтобы говорить о согласованности; во сколько раз от медианы — выброс */
  internalMinOffers: number;
  internalOutlierFactor: number;
  /** Якорь 3: допустимое расхождение с тем же EAN на другом канале; возраст опорного значения */
  crossChannelFactor: number;
  crossChannelMaxAgeSeconds: number;
  /** Якорь 4: окно истории, минимум дней с данными, коэффициент диапазона */
  historyWindowDays: number;
  minHistoryDays: number;
  historyBandFactor: number;
  /** «Ровно 100» и «ровно 0.01»: относительный допуск */
  unitScaleTolerance: number;
  /** Вспомогательный якорь: предупреждение при расхождении с нашей ценой больше чем в столько раз */
  ownPriceWarnFactor: number;
  /** Наше предложение в снимке дальше этого от всех известных нам цен — кейс расхождения [Р-55] */
  selfOfferMaxRatio: number;
  maxSnapshotAgeSeconds: number;
  maxFutureSkewSeconds: number;
  massShift: {
    windowSeconds: number;
    minProducts: number;
    /** Сдвиг считается большим от этого множителя (или обратного) */
    minFactor: number;
    sameDirectionShare: number;
    /** Р-50: стандартное отклонение ln(коэффициента) не больше этого — ошибка разбора, а не рыночное событие */
    maxParseErrorSpread: number;
  };
}

export const DEFAULT_SANITY_CONFIG: SanityConfig = {
  costLowRatio: 1 / 3,
  costHighRatio: 20,
  internalMinOffers: 3,
  internalOutlierFactor: 5,
  crossChannelFactor: 4,
  crossChannelMaxAgeSeconds: 7 * 86_400,
  historyWindowDays: 30,
  minHistoryDays: 7,
  historyBandFactor: 3,
  unitScaleTolerance: 0.02,
  ownPriceWarnFactor: 5,
  selfOfferMaxRatio: 1.5,
  maxSnapshotAgeSeconds: 3600,
  maxFutureSkewSeconds: 300,
  massShift: { windowSeconds: 900, minProducts: 10, minFactor: 1.15, sameDirectionShare: 0.8, maxParseErrorSpread: 0.005 },
};

/**
 * Набор правил как справочник слепка объяснения [Р-75]: порядок правил и пороги (параметры класса CONFIG) по кодам причин.
 * Слепок не повторяет порог, совпадающий с набором; изменение порога или порядка — новая версия набора и строка
 * в `platform.explanation_ruleset` (совпадение с БД проверяет тест).
 */
export function sanityRuleset(cfg: SanityConfig = DEFAULT_SANITY_CONFIG): SanityRuleset {
  const shift = { windowMinutes: Math.round(cfg.massShift.windowSeconds / 60), maxSpread: cfg.massShift.maxParseErrorSpread };
  return {
    rulesetId: SANITY_RULESET_VERSION,
    kind: 'SANITY',
    definition: {
      rules: [...RULESET_RULES],
      config: {
        SNAPSHOT_FROM_FUTURE: { maxSkewSeconds: cfg.maxFutureSkewSeconds },
        SNAPSHOT_TOO_OLD: { maxAgeSeconds: cfg.maxSnapshotAgeSeconds },
        CHANNEL_MASS_SHIFT: shift,
        MARKET_SHIFT_DISPERSED: shift,
        MARKET_SHIFT_SINGLE_SELLER: shift,
        DISPERSED_MARKET_EVENT: { maxSpread: cfg.massShift.maxParseErrorSpread },
        SHIFT_BELOW_SHARE: { minProducts: cfg.massShift.minProducts, share: cfg.massShift.sameDirectionShare },
        SMALL_MOVE: { minFactor: cfg.massShift.minFactor },
        PRICE_BELOW_COST_ANCHOR: { limit: cfg.costLowRatio },
        PRICE_ABOVE_COST_ANCHOR: { limit: cfg.costHighRatio },
        TOO_FEW_COMPETITOR_OFFERS: { minOffers: cfg.internalMinOffers },
        SNAPSHOT_INTERNAL_OUTLIER: { outlierFactor: cfg.internalOutlierFactor },
        NO_FRESH_CROSS_CHANNEL_REFERENCE: { maxAgeSeconds: cfg.crossChannelMaxAgeSeconds },
        CROSS_CHANNEL_MISMATCH: { limit: cfg.crossChannelFactor },
        HISTORY_TOO_SHORT: { minHistoryDays: cfg.minHistoryDays },
        OUTSIDE_HISTORY_BAND: { bandFactor: cfg.historyBandFactor },
        NO_PLAUSIBILITY_ANCHOR: { minOffers: cfg.internalMinOffers, minHistoryDays: cfg.minHistoryDays },
        OWN_PRICE_DEVIATION: { limit: cfg.ownPriceWarnFactor },
        SELF_OFFER_DIVERGENCE: { limit: cfg.selfOfferMaxRatio },
      },
    },
  };
}

export const SANITY_RULESET: SanityRuleset = sanityRuleset();

export interface DailyRange {
  /** YYYY-MM-DD */
  day: string;
  minMinor: number;
  maxMinor: number;
}

export interface CrossChannelReference {
  channel: string;
  marketplace: string;
  /** Принятая цена Buy Box или минимальная цена конкурента того же EAN */
  referenceMinor: number;
  currency: string;
  observedAt: Instant;
}

export interface SanityContext {
  now: Instant;
  expectedCurrency: string;
  /** База цен витрины [Р-58]: GROSS — с НДС (ЕС), NET — без налога с продаж (США) */
  expectedBasis: PriceBasis;
  /** Якорь 1: себестоимость единицы товара в валюте предложения; null — не указана */
  unitCostMinor: number | null;
  /** Якорь 3: тот же EAN на других каналах и витринах тенанта */
  crossChannel: CrossChannelReference[];
  /** Курсы ЕЦБ, известные на момент проверки, — для ссылок в другой валюте [Р-63] */
  fxRates?: FxQuote[];
  /** Якорь 4: принятые цены конкурентов по дням (channel_data.competitor_price_daily) */
  competitorDaily: DailyRange[];
  /** Последний принятый снимок этого товара — только для движения и ошибки единиц */
  lastAccepted: { observedAt: Instant; buyboxMinor: number | null; lowestMinor: number | null } | null;
  /** Вспомогательный якорь: наша действующая цена */
  ourPriceMinor: number | null;
  /** Цены, которые канал может сейчас показывать: действующая, недавно отправленные */
  ourKnownPricesMinor: number[];
  channel: {
    /** Действующая системная остановка витрины [Р-51] */
    halt: { haltId: string; haltedAt: Instant; reasonCode: 'CHANNEL_MASS_SHIFT'; marketplace: string | null } | null;
    /** Оценённые движения других товаров того же тенанта, аккаунта и витрины */
    recentMoves: Array<{ productRef: string; evaluatedAt: Instant; moveBp: number; sellerRef: string | null }>;
    /**
     * Число других товаров витрины с движением в окне. Если задано, хранилище передаёт в recentMoves только последние
     * большие движения, а доля «в одну сторону» считается от этого числа: окно не пересылается целиком на каждый снимок.
     */
    windowProducts?: number;
  };
}

export type SanityCheckOutcome = SanityCheckRecord['outcome'];

/** Итог правила: код правила и пояснение кодом с параметрами — текстов в движке нет [Р-72] */
export type SanityCheck = SanityCheckRecord;

/** Движение цены товара относительно последнего принятого снимка: новое / прежнее × 10 000; продавец нового значения */
export interface MoveRecord {
  productRef: string;
  moveBp: number;
  sellerRef: string | null;
}

interface VerdictBase {
  ruleset: string;
  checks: SanityCheck[];
  move: MoveRecord | null;
  warnings: Reason<SanityWarningCode>[];
  anchorsUsed: AnchorName[];
}

export type SanityVerdict =
  | (VerdictBase & {
      verdict: 'ACCEPT';
      snapshot: AcceptedSnapshot;
      /** Наше предложение в канале не совпадает с нашей ценой — кейс расхождения, а не отказ [Р-55] */
      divergence: { valueMinor: number; ourPriceMinor: number } | null;
    })
  | (VerdictBase & { verdict: 'REJECT'; reason: Reason<SanityReasonCode>; alarmClass: AlarmClass; alert: boolean })
  | (VerdictBase & { verdict: 'HALT_CHANNEL'; reason: Reason<'CHANNEL_MASS_SHIFT'>; alarmClass: 'CHANNEL_SHIFT'; alert: true });

interface Probe {
  field: 'buybox' | 'lowest' | 'suggested';
  valueMinor: number;
}

type SnapshotField = 'BUYBOX_PRICE' | 'SUGGESTED_PRICE' | 'OFFER_PRICE' | 'OFFER_SHIPPING' | 'OFFER_TOTAL';

/** Отказы без алерта: ожидаемые события (повтор старых данных, уже остановленный канал) */
const SILENT: ReadonlySet<SanityReasonCode> = new Set(['OUT_OF_ORDER', 'CHANNEL_HALTED']);

function isAmount(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2]! : Math.round((s[n / 2 - 1]! + s[n / 2]!) / 2);
}

function nearRatio(q: number, target: number, tolerance: number): boolean {
  return Math.abs(q / target - 1) <= tolerance;
}

export function evaluateSnapshot(snapshot: CompetitorSnapshot, ctx: SanityContext, overrides: Partial<SanityConfig> = {}): SanityVerdict {
  const cfg: SanityConfig = { ...DEFAULT_SANITY_CONFIG, ...overrides, massShift: { ...DEFAULT_SANITY_CONFIG.massShift, ...overrides.massShift } };
  const checks: SanityCheck[] = [];
  const warnings: Reason<SanityWarningCode>[] = [];
  const anchorsUsed: AnchorName[] = [];
  let move: MoveRecord | null = null;
  const productRef = `${snapshot.channelProductRef}|${snapshot.condition}`;
  const base = (): VerdictBase => ({ ruleset: SANITY_RULESET_VERSION, checks, move, warnings, anchorsUsed });

  const reject = (code: SanityReasonCode, params: Reason['params']): SanityVerdict => {
    checks.push({ rule: code, outcome: 'FAIL', detail: { code, params } });
    return { verdict: 'REJECT', reason: { code, params }, alarmClass: SANITY_ALARM_CLASS[code], alert: !SILENT.has(code), ...base() };
  };
  const note = (code: SanityNoteCode, params: Reason['params'] = {}): Reason<SanityNoteCode> => ({ code, params });
  const pass = (rule: string, detail?: Reason<SanityNoteCode>) => checks.push({ rule, outcome: 'PASS', ...(detail ? { detail } : {}) });
  const skip = (rule: string, detail: Reason<SanityNoteCode>) => checks.push({ rule, outcome: 'SKIPPED', detail });
  const currency = ctx.expectedCurrency;
  const warn = (code: SanityWarningCode, params: Reason['params']) => warnings.push({ code, params });

  // 1. Остановленный канал: снимки не используются до возобновления
  if (ctx.channel.halt) {
    const h = ctx.channel.halt;
    return reject('CHANNEL_HALTED', { stage: 'INPUT', haltId: h.haltId, haltedAt: h.haltedAt, haltReason: h.reasonCode, marketplace: h.marketplace });
  }
  pass('CHANNEL_HALTED');

  // 2. Структура
  const monies: Array<[SnapshotField, number | null, Money | undefined]> = [
    ['BUYBOX_PRICE', null, snapshot.buybox?.price],
    ['SUGGESTED_PRICE', null, snapshot.channelSuggestedPrice],
    ...snapshot.offers.flatMap((o, i): Array<[SnapshotField, number | null, Money | undefined]> => [
      ['OFFER_PRICE', o.rank ?? i + 1, o.price], ['OFFER_SHIPPING', o.rank ?? i + 1, o.shipping], ['OFFER_TOTAL', o.rank ?? i + 1, o.totalPrice],
    ]),
  ];
  for (const [field, rank, m] of monies) {
    if (!m) continue;
    const at: Record<string, string | number> = { field, ...(rank !== null ? { offerRank: rank } : {}) };
    const zeroAllowed = field === 'OFFER_SHIPPING';
    if (!Number.isSafeInteger(m.amountMinor) || m.amountMinor < 0 || (!zeroAllowed && m.amountMinor === 0)) {
      const shown: Record<string, number | string> = Number.isSafeInteger(m.amountMinor) && /^[A-Z]{3}$/.test(m.currency) ? { valueMinor: m.amountMinor, currency: m.currency } : {};
      return reject('INVALID_AMOUNT', { ...at, ...shown });
    }
    if (m.currency !== ctx.expectedCurrency) return reject('CURRENCY_MISMATCH', { ...at, actual: m.currency, expected: ctx.expectedCurrency });
    if (m.basis !== ctx.expectedBasis) return reject('PRICE_BASIS_MISMATCH', { ...at, actual: m.basis, expected: ctx.expectedBasis });
  }
  for (const [i, o] of snapshot.offers.entries()) {
    if (o.shipping && o.totalPrice && o.totalPrice.amountMinor !== o.price.amountMinor + o.shipping.amountMinor) {
      return reject('INCONSISTENT_SNAPSHOT', {
        inconsistency: 'OFFER_TOTAL_NOT_PRICE_PLUS_SHIPPING', offerRank: o.rank ?? i + 1,
        offerPriceMinor: o.price.amountMinor, shippingMinor: o.shipping.amountMinor, totalMinor: o.totalPrice.amountMinor, currency,
      });
    }
  }
  if (snapshot.completeness.kind === 'TOP_N' && snapshot.offers.length > snapshot.completeness.n) {
    return reject('INCONSISTENT_SNAPSHOT', { inconsistency: 'MORE_OFFERS_THAN_TOP_N', offers: snapshot.offers.length, topN: snapshot.completeness.n });
  }
  const rankOne = snapshot.offers.find((o) => o.rank === 1);
  if (snapshot.buybox && rankOne && rankOne.price.amountMinor !== snapshot.buybox.price.amountMinor) {
    return reject('INCONSISTENT_SNAPSHOT', { inconsistency: 'BUYBOX_NOT_RANK_ONE_PRICE', buyboxMinor: snapshot.buybox.price.amountMinor, rankOneMinor: rankOne.price.amountMinor, currency });
  }
  pass('STRUCTURE');

  // 3. Свежесть и порядок; устаревание — с предупреждением [Р-55]
  const nowMs = Date.parse(ctx.now);
  const observedMs = Date.parse(snapshot.observedAt);
  if (Number.isNaN(observedMs)) return reject('INVALID_AMOUNT', { field: 'OBSERVED_AT' });
  if (observedMs - nowMs > cfg.maxFutureSkewSeconds * 1000) {
    return reject('SNAPSHOT_FROM_FUTURE', { skewSeconds: Math.round((observedMs - nowMs) / 1000), maxSkewSeconds: cfg.maxFutureSkewSeconds });
  }
  if (nowMs - observedMs > cfg.maxSnapshotAgeSeconds * 1000) {
    return reject('SNAPSHOT_TOO_OLD', { ageSeconds: Math.round((nowMs - observedMs) / 1000), maxAgeSeconds: cfg.maxSnapshotAgeSeconds });
  }
  if (ctx.lastAccepted && Date.parse(ctx.lastAccepted.observedAt) >= observedMs) {
    return reject('OUT_OF_ORDER', { lastAcceptedAt: new Date(Date.parse(ctx.lastAccepted.observedAt)).toISOString(), observedAt: new Date(observedMs).toISOString() });
  }
  pass('FRESHNESS');

  // Значения, которые использует стратегия: Buy Box конкурента, минимальная цена конкурента, подсказка канала
  const competitors = snapshot.offers.filter((o) => !o.isSelf && isAmount(o.price.amountMinor));
  const lowestOffer = competitors.reduce<(typeof competitors)[number] | null>((best, o) => (!best || o.price.amountMinor < best.price.amountMinor ? o : best), null);
  const buybox = snapshot.buybox && !snapshot.buybox.isSelf ? snapshot.buybox.price.amountMinor : null;
  const probes: Probe[] = [];
  if (buybox !== null) probes.push({ field: 'buybox', valueMinor: buybox });
  if (lowestOffer) probes.push({ field: 'lowest', valueMinor: lowestOffer.price.amountMinor });
  if (snapshot.channelSuggestedPrice) probes.push({ field: 'suggested', valueMinor: snapshot.channelSuggestedPrice.amountMinor });

  // Движение относительно последнего принятого снимка и продавец нового значения
  const snapshotBuybox = snapshot.buybox?.price.amountMinor ?? null;
  if (ctx.lastAccepted?.buyboxMinor && snapshotBuybox !== null) {
    move = { productRef, moveBp: clampBp(snapshotBuybox / ctx.lastAccepted.buyboxMinor), sellerRef: rankOne?.sellerRef ?? null };
  } else if (ctx.lastAccepted?.lowestMinor && lowestOffer) {
    move = { productRef, moveBp: clampBp(lowestOffer.price.amountMinor / ctx.lastAccepted.lowestMinor), sellerRef: lowestOffer.sellerRef ?? null };
  }

  // 4. Массовый сдвиг [Р-50]: почти одинаковый коэффициент у многих товаров разных продавцов — ошибка разбора
  const factorBp = Math.round(cfg.massShift.minFactor * 10_000);
  const inverseBp = Math.round(10_000 / cfg.massShift.minFactor);
  if (move && (move.moveBp >= factorBp || move.moveBp <= inverseBp)) {
    const up = move.moveBp >= factorBp;
    const windowStart = nowMs - cfg.massShift.windowSeconds * 1000;
    const latest = new Map<string, { moveBp: number; sellerRef: string | null }>();
    for (const m of ctx.channel.recentMoves) {
      const at = Date.parse(m.evaluatedAt);
      if (m.productRef === productRef || Number.isNaN(at) || at < windowStart) continue;
      latest.set(m.productRef, { moveBp: m.moveBp, sellerRef: m.sellerRef });
    }
    const same = [{ moveBp: move.moveBp, sellerRef: move.sellerRef }, ...[...latest.values()].filter((m) => (up ? m.moveBp >= factorBp : m.moveBp <= inverseBp))];
    const products = 1 + Math.max(latest.size, ctx.channel.windowProducts ?? 0);
    if (same.length >= cfg.massShift.minProducts && same.length / products >= cfg.massShift.sameDirectionShare) {
      const logs = same.map((m) => Math.log(m.moveBp / 10_000));
      const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
      const spread = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
      const sellers = new Set(same.map((m) => m.sellerRef));
      const params = {
        direction: up ? 'UP' : 'DOWN', sameDirection: same.length, products, windowMinutes: Math.round(cfg.massShift.windowSeconds / 60),
        spread: Math.round(spread * 10_000) / 10_000, maxSpread: cfg.massShift.maxParseErrorSpread, medianFactor: median(same.map((m) => m.moveBp)) / 10_000,
      };
      if (sellers.size === 1 && !sellers.has(null)) {
        warn('MARKET_SHIFT_SINGLE_SELLER', { ...params, seller: [...sellers][0]! });
        pass('CHANNEL_MASS_SHIFT', note('SINGLE_SELLER_MARKET_EVENT', { seller: [...sellers][0]! }));
      } else if (spread > cfg.massShift.maxParseErrorSpread) {
        warn('MARKET_SHIFT_DISPERSED', params);
        pass('CHANNEL_MASS_SHIFT', note('DISPERSED_MARKET_EVENT', { spread: params.spread, maxSpread: cfg.massShift.maxParseErrorSpread }));
      } else {
        checks.push({ rule: 'CHANNEL_MASS_SHIFT', outcome: 'FAIL', detail: { code: 'CHANNEL_MASS_SHIFT', params } });
        return { verdict: 'HALT_CHANNEL', reason: { code: 'CHANNEL_MASS_SHIFT', params }, alarmClass: 'CHANNEL_SHIFT', alert: true, ...base() };
      }
    } else {
      pass('CHANNEL_MASS_SHIFT', note('SHIFT_BELOW_SHARE', {
        sameDirection: same.length, products, minProducts: cfg.massShift.minProducts, share: cfg.massShift.sameDirectionShare,
      }));
    }
  } else {
    pass('CHANNEL_MASS_SHIFT', move ? note('SMALL_MOVE', { minFactor: cfg.massShift.minFactor }) : note('NO_PREVIOUS_SNAPSHOT'));
  }

  // Опорные значения основных якорей
  const cost = isAmount(ctx.unitCostMinor) ? ctx.unitCostMinor : null;
  const internalMedian = competitors.length >= cfg.internalMinOffers ? median(competitors.map((o) => o.price.amountMinor)) : null;
  // Р-63: ссылка в другой валюте переводится по курсу ЕЦБ; без курса — явное предупреждение, а не молчаливый пропуск
  const crossRefs: Array<{ referenceMinor: number; fx: FxApplied | null; storefront: string }> = [];
  for (const r of ctx.crossChannel) {
    if (!isAmount(r.referenceMinor) || nowMs - Date.parse(r.observedAt) > cfg.crossChannelMaxAgeSeconds * 1000) continue;
    const converted = convertMinor(r.referenceMinor, r.currency, ctx.expectedCurrency, ctx.fxRates ?? [], ctx.now, 'NEAREST');
    if (converted.ok) crossRefs.push({ referenceMinor: converted.amountMinor, fx: converted.fx, storefront: `${r.channel}:${r.marketplace}` });
    else warn('CROSS_CHANNEL_FX_UNAVAILABLE', { channel: r.channel, marketplace: r.marketplace, currency: r.currency, expected: ctx.expectedCurrency, cause: converted.cause });
  }
  const crossMedian = crossRefs.length > 0 ? median(crossRefs.map((r) => r.referenceMinor)) : null;
  const crossFx = crossRefs.find((r) => r.fx)?.fx ?? null;
  const windowStartDay = new Date(nowMs - cfg.historyWindowDays * 86_400_000).toISOString().slice(0, 10);
  const ranges = ctx.competitorDaily.filter((r) => r.day >= windowStartDay && isAmount(r.minMinor) && isAmount(r.maxMinor));
  const historyDays = new Set(ranges.map((r) => r.day)).size;
  const historyMedian = historyDays >= cfg.minHistoryDays ? median(ranges.map((r) => Math.round((r.minMinor + r.maxMinor) / 2))) : null;

  // 5. Ошибка единиц: ровно ×100 или ×0.01 к любому якорю или к последнему принятому значению (не к нашей цене)
  const scaleRefs: Array<[string, number]> = [];
  if (cost !== null) scaleRefs.push(['COST', cost]);
  if (crossMedian !== null) scaleRefs.push(['CROSS_CHANNEL', crossMedian]);
  if (historyMedian !== null) scaleRefs.push(['HISTORY', historyMedian]);
  if (ctx.lastAccepted?.buyboxMinor) scaleRefs.push(['LAST_ACCEPTED', ctx.lastAccepted.buyboxMinor]);
  else if (ctx.lastAccepted?.lowestMinor) scaleRefs.push(['LAST_ACCEPTED', ctx.lastAccepted.lowestMinor]);
  for (const probe of probes) {
    for (const [anchor, ref] of scaleRefs) {
      const q = probe.valueMinor / ref;
      if (nearRatio(q, 100, cfg.unitScaleTolerance)) return reject('UNIT_SCALE_X100', { field: probe.field, valueMinor: probe.valueMinor, referenceMinor: ref, anchor, currency });
      if (nearRatio(q, 0.01, cfg.unitScaleTolerance)) return reject('UNIT_SCALE_X0_01', { field: probe.field, valueMinor: probe.valueMinor, referenceMinor: ref, anchor, currency });
    }
  }
  if (scaleRefs.length === 0) skip('UNIT_SCALE', note('NO_SCALE_REFERENCE')); else pass('UNIT_SCALE');

  // 6. Якорь 1: себестоимость
  if (cost === null) {
    skip('COST_ANCHOR', note('COST_NOT_DECLARED'));
  } else {
    anchorsUsed.push('COST');
    for (const probe of probes) {
      if (probe.valueMinor < cost * cfg.costLowRatio) return reject('PRICE_BELOW_COST_ANCHOR', { field: probe.field, valueMinor: probe.valueMinor, costMinor: cost, limit: cfg.costLowRatio, currency });
      if (probe.valueMinor > cost * cfg.costHighRatio) return reject('PRICE_ABOVE_COST_ANCHOR', { field: probe.field, valueMinor: probe.valueMinor, costMinor: cost, limit: cfg.costHighRatio, currency });
    }
    pass('COST_ANCHOR');
  }

  // 7. Якорь 2: внутренняя согласованность снимка (наше предложение не участвует)
  if (internalMedian === null) {
    skip('INTERNAL_ANCHOR', note('TOO_FEW_COMPETITOR_OFFERS', { offers: competitors.length, minOffers: cfg.internalMinOffers }));
  } else {
    anchorsUsed.push('INTERNAL');
    const probeValues = new Set(probes.filter((p) => p.field !== 'suggested').map((p) => p.valueMinor));
    for (const o of competitors) {
      const r = o.price.amountMinor / internalMedian;
      if (r < cfg.internalOutlierFactor && r > 1 / cfg.internalOutlierFactor) continue;
      if (probeValues.has(o.price.amountMinor)) {
        return reject('SNAPSHOT_INTERNAL_OUTLIER', { valueMinor: o.price.amountMinor, medianMinor: internalMedian, offers: competitors.length, outlierFactor: cfg.internalOutlierFactor, currency });
      }
      warn('INTERNAL_OUTLIER_IGNORED', { valueMinor: o.price.amountMinor, medianMinor: internalMedian, currency });
    }
    pass('INTERNAL_ANCHOR');
  }

  // 8. Якорь 3: тот же EAN на другом канале тенанта
  if (crossMedian === null) {
    skip('CROSS_CHANNEL_ANCHOR', warnings.some((w) => w.code === 'CROSS_CHANNEL_FX_UNAVAILABLE')
      ? note('REFERENCES_WITHOUT_ECB_RATE') : note('NO_FRESH_CROSS_CHANNEL_REFERENCE', { maxAgeSeconds: cfg.crossChannelMaxAgeSeconds }));
  } else {
    anchorsUsed.push('CROSS_CHANNEL');
    for (const probe of probes) {
      const r = Math.max(probe.valueMinor / crossMedian, crossMedian / probe.valueMinor);
      if (r > cfg.crossChannelFactor) {
        return reject('CROSS_CHANNEL_MISMATCH', {
          field: probe.field, valueMinor: probe.valueMinor, referenceMinor: crossMedian, ratio: Math.round(r * 100) / 100, limit: cfg.crossChannelFactor,
          references: crossRefs.length, referenceStorefronts: [...new Set(crossRefs.map((x) => x.storefront))].sort().join(','),
          ...(crossFx ? { fxRateDate: crossFx.rateDate, fxRateMicros: crossFx.rateMicros, fxFrom: crossFx.from } : {}), currency,
        });
      }
    }
    pass('CROSS_CHANNEL_ANCHOR', crossFx
      ? note('REFERENCES_CONVERTED_AT_ECB', { fxFrom: crossFx.from, currency: crossFx.to, fxRateDate: crossFx.rateDate, fxRateMicros: crossFx.rateMicros })
      : undefined);
  }

  // 9. Якорь 4: историческое распределение единицы записи
  if (historyMedian === null) {
    skip('HISTORY_ANCHOR', note('HISTORY_TOO_SHORT', { days: historyDays, minHistoryDays: cfg.minHistoryDays }));
  } else {
    anchorsUsed.push('HISTORY');
    const bandLow = Math.floor(Math.min(...ranges.map((r) => r.minMinor)) / cfg.historyBandFactor);
    const bandHigh = Math.ceil(Math.max(...ranges.map((r) => r.maxMinor)) * cfg.historyBandFactor);
    for (const probe of probes) {
      if (probe.valueMinor < bandLow || probe.valueMinor > bandHigh) {
        return reject('OUTSIDE_HISTORY_BAND', {
          field: probe.field, valueMinor: probe.valueMinor, bandLowMinor: bandLow, bandHighMinor: bandHigh, days: historyDays, bandFactor: cfg.historyBandFactor, currency,
        });
      }
    }
    pass('HISTORY_ANCHOR', note('HISTORY_AVAILABLE', { days: historyDays }));
  }

  // 10. Ни одного основного якоря: снимок не с чем сверить (fail-closed)
  if (anchorsUsed.length === 0 && probes.length > 0) {
    return reject('NO_PLAUSIBILITY_ANCHOR', {
      competitorOffers: competitors.length, historyDays, minOffers: cfg.internalMinOffers, minHistoryDays: cfg.minHistoryDays, costDeclared: cost !== null,
    });
  }

  // 11. Вспомогательный якорь — наша цена: только предупреждение [Р-49]
  if (ctx.ourPriceMinor !== null && isAmount(ctx.ourPriceMinor)) {
    for (const probe of probes) {
      const r = Math.max(probe.valueMinor / ctx.ourPriceMinor, ctx.ourPriceMinor / probe.valueMinor);
      if (r > cfg.ownPriceWarnFactor) {
        warn('OWN_PRICE_DEVIATION', { field: probe.field, valueMinor: probe.valueMinor, ourPriceMinor: ctx.ourPriceMinor, ratio: Math.round(r * 100) / 100, limit: cfg.ownPriceWarnFactor, currency });
        break;
      }
    }
  }

  // 12. Наше предложение в канале не совпадает с нашей ценой — расхождение, а не отказ [Р-55]
  let divergence: { valueMinor: number; ourPriceMinor: number } | null = null;
  const known = ctx.ourKnownPricesMinor.filter(isAmount);
  const self = snapshot.offers.find((o) => o.isSelf && isAmount(o.price.amountMinor));
  if (self && known.length > 0) {
    const v = self.price.amountMinor;
    const closest = known.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
    if (Math.max(v / closest, closest / v) >= cfg.selfOfferMaxRatio) {
      divergence = { valueMinor: v, ourPriceMinor: closest };
      warn('SELF_OFFER_DIVERGENCE', { valueMinor: v, ourPriceMinor: closest, limit: cfg.selfOfferMaxRatio, currency });
    }
  }

  return { verdict: 'ACCEPT', snapshot: markAcceptedBySanity(snapshot, SANITY_RULESET_VERSION), divergence, ...base() };
}

function clampBp(ratio: number): number {
  return Math.max(1, Math.min(2_000_000_000, Math.round(ratio * 10_000)));
}

/**
 * Р-50 для выборки при проверке остановки: большие сдвиги одного направления с почти нулевым разбросом
 * у разных продавцов — подозрение на ошибку разбора, которая не прошла.
 */
export function assessShift(
  moves: ReadonlyArray<{ moveBp: number; sellerRef: string | null }>,
  overrides: Partial<SanityConfig['massShift']> = {},
): { bigMoves: number; spread: number | null; sellers: number; parseErrorSuspected: boolean } {
  const cfg = { ...DEFAULT_SANITY_CONFIG.massShift, ...overrides };
  const up = moves.filter((m) => m.moveBp >= Math.round(cfg.minFactor * 10_000));
  const down = moves.filter((m) => m.moveBp <= Math.round(10_000 / cfg.minFactor));
  const same = up.length >= down.length ? up : down;
  if (same.length < 2) return { bigMoves: same.length, spread: null, sellers: 0, parseErrorSuspected: false };
  const logs = same.map((m) => Math.log(m.moveBp / 10_000));
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const spread = Math.sqrt(logs.reduce((a, b) => a + (b - mean) ** 2, 0) / logs.length);
  const sellers = new Set(same.map((m) => m.sellerRef));
  const singleSeller = sellers.size === 1 && !sellers.has(null);
  return {
    bigMoves: same.length,
    spread: Math.round(spread * 10_000) / 10_000,
    sellers: sellers.size,
    parseErrorSuspected: !singleSeller && same.length === moves.length && spread <= cfg.maxParseErrorSpread,
  };
}
