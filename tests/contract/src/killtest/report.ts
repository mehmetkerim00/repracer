import { decisionTrace, describe, messagesFor, shadowView, type DecisionTrace, type Messages, type StandWorld } from '@repracer/console-model';
import { storefrontPriceForMarginBp } from '@repracer/pricing-model';
import { COLUMN_ALIASES, type Catalog, type CatalogField, type RowNote, type RowProblem } from './catalog.ts';
import type { KilltestOptions, KilltestProduct, KilltestWorld } from './world.ts';

/**
 * Шаг 71: отчёт kill-test — английский самодостаточный HTML для клиента: сводка, топ-15 решений с «почему эта цена» словами, «что мы
 * НЕ сделали и почему», товары без себестоимости, чем прогон отличается от боя, допущения.
 *
 * Слова причин — из словаря консоли (`messagesFor('en')`, `describe`, `decisionTrace`, `shadowView`). Ревью шага 71: отчёт говорит
 * только то, что прогон доказал, — числа о поле подписаны как свойства СИМУЛЯЦИИ (конкурент, минимум и комиссия — наши допущения),
 * «ничего не отправлено» выводится из числа базы (отправленное — отчёт не пишется вовсе), что в пол не входит — названо.
 *
 * Внутренних кодов и идентификаторов в отчёте нет: перед записью файла проверяется ОТДЕЛЬНАЯ отрисовка, где каждая строка клиента
 * (SKU, названия, заголовки, имя файла) заменена заглушкой — так строка клиента не может спрятать нашу утечку (ревью, находка 8).
 */

const STOREFRONT = 'amazon.com';
const TOP = 15;

const FIELD_NAMES: Readonly<Record<CatalogField, string>> = {
  sku: 'SKU', title: 'product name', asin: 'ASIN', price: 'current price', quantity: 'stock', cost: 'unit cost', sales30d: 'units sold', currency: 'currency',
};
const PROBLEM_TEXT: Readonly<Record<RowProblem, string>> = {
  NO_SKU: 'no SKU', SKU_TOO_LONG: 'SKU longer than 40 characters (we accept at most 40)', DUPLICATE_SKU: 'the same SKU appears again (we kept the first row)',
  PRICE_MISSING: 'no price', PRICE_NOT_A_NUMBER: 'the price is not a number', PRICE_AMBIGUOUS: 'the price could be read two ways (for example 10.505) — we do not guess',
  PRICE_NOT_POSITIVE: 'the price is zero or negative', PRICE_NOT_USD: 'the price is in another currency (amazon.com sells in US dollars)',
  CURRENCY_NOT_USD: 'the currency column is not US dollars (amazon.com sells in US dollars; we do not convert)',
};
const NOTE_TEXT: Readonly<Record<RowNote, string>> = {
  COST_UNREADABLE: 'unit cost could not be read', COST_NOT_USD: 'unit cost is in another currency (we do not convert)',
  QUANTITY_UNREADABLE: 'stock could not be read', SALES_UNREADABLE: 'units sold could not be read',
};

interface DecisionRow {
  write_scope_id: string; price_decision_id: string; outcome: string; final_amount_minor: number | null; effective_floor_minor: number | null;
  effective_ceiling_minor: number | null; code: string | null;
  /** Причина отказа «граница не вычисляется» — какая именно (пол маржи выше max_price и т. п.) */
  cause: string | null;
  /** Главная причина намерения решения и граница подъёма [Р-207]: подъём до пола маржи — RAISED_TO_FLOOR + margin_floor */
  intent_reason: string | null; intent_bound: string | null;
}

/** Чем был пол решения: допущенный минимум (наш) или пол маржи из себестоимости клиента */
type FloorKind = 'ASSUMED_MIN' | 'MARGIN';

/**
 * Р-207 (шаг 72): товар, чья нынешняя цена ниже пола маржи по СВОЕЙ себестоимости клиента. Пол — тем же расчётом, что у движка;
 * прибыль на единицу при нынешней цене — цена минус допущенная комиссия минус себестоимость (FBA, доставка и прочее не входят)
 */
export interface BelowFloorRow {
  label: string; sku: string; sales: number | null; priceMinor: number; costMinor: number; profitMinor: number; floorMinor: number;
  /**
   * RAISED — одобренный подъём до пола маржи (главная причина RAISED_TO_FLOOR, граница — пол маржи); ABOVE — цена поднята выше пола
   * вслед за конкурентом; NOT_RAISED — подъёма нет, причина словами; NO_DECISION — решений нет; NOT_IN_RUN — товар не вошёл в прогон
   */
  status: 'RAISED' | 'ABOVE' | 'NOT_RAISED' | 'NO_DECISION' | 'NOT_IN_RUN';
  engineMinor: number | null;
  refused: string | null;
}

interface TopDecision {
  label: string; sku: string; sales: number | null; currentMinor: number; decidedMinor: number | null; floorMinor: number | null; ceilingMinor: number | null;
  floorKind: FloorKind | null; atFloor: boolean;
  /** Итоговая проверка отказала (цена ниже пола маржи): цена осталась прежней */
  refused: boolean; costSource: KilltestProduct['costSource']; when: string; why: string[]; checks: string[];
}

export interface ReportData {
  generatedAt: string;
  fileName: string;
  format: string;
  hours: number;
  options: KilltestOptions;
  /** Заголовок колонки продаж клиента: период продаж — из него («Units Ordered» — период его выгрузки, не обязательно 30 дней) */
  salesHeader: string | null;
  counts: { rows: number; rejectedRows: number; inRun: number; inEngine: number; withFileCost: number; assumedCost: number; noCost: number; skippedByLimit: number;
    decisions: number; assumedCostDecisions: number; changes: number; floorHeld: number; floorHeldAssumedMin: number; floorHeldMargin: number;
    /** Цена стратегии оказалась ниже пола маржи — итоговая проверка отказала, цена осталась прежней (Р-44: отказ, не округление) */
    marginRefused: number; ceilingHeld: number;
    /** Товары ниже пола маржи, поднятые до пола (одно правило для отчёта и итога команды) */
    raisedToFloor: number;
    heldWrites: number; competitorUpdates: number;
    /** Отправлено в канал — записи базы со временем отправки плюс вызовы записи модели порта; больше нуля — отчёт не пишется (main.ts) */
    sentToAmazon: number; dbDispatched: number; portWrites: number };
  savings: string | null;
  belowFloor: BelowFloorRow[];
  top: TopDecision[];
  notDone: Array<{ title: string; text: string }>;
  noCostExamples: string[];
  rejected: Array<{ text: string; lines: number[]; values: string[] }>;
  notes: Array<{ text: string; count: number }>;
  columns: { recognized: Array<{ header: string; meaning: string }>; ignored: string[]; duplicates: Array<{ meaning: string; used: string; skipped: string[] }> };
  /** База прогона оставлена для разбора (--keep) — отчёт не обещает, что она удалена */
  databaseKept: boolean;
}

/** Внутренние имена в словах словаря консоли — словами для клиента */
const CLIENT_SAFE: ReadonlyArray<[RegExp, string]> = [
  [/\bmin_price and max_price set\b/g, 'minimum and maximum price set'],
  [/\bmin_price\b/g, 'the minimum price'], [/\bmax_price\b/g, 'the maximum price'],
  [/\bANY_OFFER_CHANGED notification\b/g, 'notification of a competitor price change'],
];
const clientSafe = (text: string): string => CLIENT_SAFE.reduce((t, [re, to]) => t.replace(re, to), text);

/**
 * Утечки внутреннего в тексте отчёта: коды, идентификаторы, наши номера решений и вопросов, синтетика мира прогона, внешние ресурсы.
 * Проверяется отрисовка, где строки клиента уже заменены заглушкой (`renderReport(d, { client: () => … })`), — исключений здесь нет
 */
export function internalLeaks(html: string): string[] {
  const text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  const rules: Array<[string, RegExp]> = [
    ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ['UPPER_SNAKE code', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/],
    ['lower_snake name', /\b[a-z]+_[a-z0-9_]+\b/],
    // Без флага u граница слова `\b` не видит кириллицу: «Р-205» проходил незамеченным (поймал положительный контроль теста)
    ['decision or question number', /(?<![\p{L}\p{N}])(Р|R|A|E|K|OQ)-\d{2,3}(?![\p{L}\p{N}])/u],
    ['ruleset or profile version', /\b[rg]\d+\.\d+\b/],
    ['storefront id', /\bATVPDKIKX0DER\b/],
    ['synthetic world id', /\b(B0KT\d{6}|A1SYNKILLTEST|killtest)\b/],
    ['external resource', /<script|<link|<img|<iframe|https?:\/\//i],
  ];
  return rules.filter(([, re]) => re.test(text)).map(([name, re]) => `${name}: ${(text.match(re) ?? [''])[0]}`);
}

/** Отрисовка для проверки утечек: каждая строка клиента — заглушкой, так строка клиента не прячет и не изображает нашу утечку */
export const renderForLeakCheck = (d: ReportData): string => renderReport(d, { client: () => 'CLIENT' });

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function collectReport(catalog: Catalog, world: KilltestWorld, options: KilltestOptions, databaseKept = false): Promise<ReportData> {
  const m = messagesFor('en', { timeZone: 'America/New_York' });
  const tenantId = world.seeded.tenantId;
  const now = world.clock.iso();
  const worldFor = async (scopeIds: string[]): Promise<StandWorld> => ({
    id: 'report', title: 'Report', description: '', tenantId, now,
    accounts: [{ channelAccountId: world.seeded.channelAccountId, channel: 'AMAZON', marketplaces: ['ATVPDKIKX0DER'], haltRelease: 'MANUAL_ONLY' }],
    viewer: { membershipId: world.seeded.ownerMembershipId, role: 'OWNER' },
    state: await world.store.readConsoleState(tenantId, now as never, { scopeIds }),
  }) as StandWorld;
  const page = await world.shadow.shadowPage(tenantId, now as never, { offset: 0, limit: 1, sinceDays: 7 });
  const s = shadowView(await worldFor([]), page, { offset: 0, limit: 1 } as never, m, 7).summary;
  const byScope = new Map<string, KilltestProduct>(world.products.map((p) => [world.dbScopeId(p), p]));
  const decisions = await world.db.rows<DecisionRow>(
    `SELECT d.write_scope_id, d.price_decision_id, d.outcome, d.final_amount_minor, d.effective_floor_minor, d.effective_ceiling_minor,
            coalesce(d.rejection_reason, d.no_change_reason) AS code, d.reason_params ->> 'cause' AS cause,
            pi.rationale -> 'reason' ->> 'code' AS intent_reason, pi.rationale -> 'reason' -> 'params' ->> 'bound' AS intent_bound
       FROM channel_data.price_decision d
       LEFT JOIN channel_data.price_intent pi ON pi.tenant_id = d.tenant_id AND pi.price_intent_id = d.price_intent_id AND pi.created_at = d.intent_created_at
      WHERE d.tenant_id = $1 ORDER BY d.decided_at`, [tenantId]);
  const perProduct = new Map<string, DecisionRow[]>();
  for (const d of decisions) {
    const list = perProduct.get(d.write_scope_id);
    if (list) list.push(d); else perProduct.set(d.write_scope_id, [d]);
  }
  const atFloor = (d: DecisionRow) => d.final_amount_minor !== null && d.final_amount_minor === d.effective_floor_minor;
  // Пол решения — допущенный минимум, если равен ему; иначе пол маржи (себестоимость + допущенная комиссия + маржа)
  const floorKindOf = (d: DecisionRow, p: KilltestProduct): FloorKind | null => (d.effective_floor_minor === null ? null : d.effective_floor_minor === p.minMinor ? 'ASSUMED_MIN' : 'MARGIN');
  const productOf = (d: DecisionRow) => byScope.get(d.write_scope_id);
  const floorDecisions = decisions.filter(atFloor);
  const marginRefused = decisions.filter((d) => d.outcome === 'REJECTED' && d.code === 'BELOW_MARGIN_FLOOR').length;

  /**
   * Нынешняя цена ниже пола маржи — только по СВОЕЙ себестоимости клиента: с допущенной себестоимостью вывод был бы нашим допущением
   * (ревью шага 71, находка 5). Пол маржи — той же функцией, что у движка и Gate: себестоимость + допущенная комиссия + маржа, цены
   * без налога с продаж. Р-207 (шаг 72): движок поднимает такую цену до пола обычным путём решения — цена движка берётся из базы
   */
  /**
   * Ревью шага 72, находка 3: по ВСЕМ строкам файла со своей себестоимостью, а не только по товарам прогона (предел maxProducts) —
   * для арифметики пола движок не нужен; товар вне прогона назван «не в этом прогоне». Находка 4: «поднят» — только одобренное
   * решение с главной причиной RAISED_TO_FLOOR у пола маржи; цена выше пола вслед за конкурентом — отдельный случай
   */
  const belowFloor: BelowFloorRow[] = [];
  const runBySku = new Map(world.products.map((p) => [p.row.sku, p]));
  for (const row of catalog.rows) {
    if (row.costMinor === null) continue;
    const priced = storefrontPriceForMarginBp({ currency: 'USD', costProfileId: 'report', unitCostMinor: row.costMinor, fixedFeeMinor: 0,
      feeRateBp: Math.round(options.feePct * 100), tax: { regime: 'SALES_TAX_EXCLUDED' } }, Math.round(options.marginPct * 100));
    if (!priced.ok || row.priceMinor >= priced.priceMinor) continue;
    const p = runBySku.get(row.sku) ?? null;
    const ds = p ? perProduct.get(world.dbScopeId(p)) ?? [] : [];
    const raise = ds.find((d) => d.outcome === 'APPROVED' && d.intent_reason === 'RAISED_TO_FLOOR' && d.intent_bound === 'margin_floor') ?? null;
    const above = ds.find((d) => d.outcome === 'APPROVED' && d.final_amount_minor !== null && d.final_amount_minor >= priced.priceMinor) ?? null;
    const last = ds[ds.length - 1] ?? null;
    // Находка 1: пол маржи выше допущенного max_price — причина из фактов, а не «граница не вычисляется»
    const refused = p === null || raise || above || last === null ? null
      : priced.priceMinor > p.maxMinor ? `your margin floor is above the maximum price we assumed (${options.maxPct}% above your price)`
        : last.code ? clientSafe(describe({ code: last.code, params: {} } as never, m).title).toLowerCase() : 'no raise in this run';
    belowFloor.push({
      label: row.title ?? row.sku, sku: row.sku, sales: row.sales30d, priceMinor: row.priceMinor, costMinor: row.costMinor,
      profitMinor: row.priceMinor - Math.round((row.priceMinor * options.feePct) / 100) - row.costMinor, floorMinor: priced.priceMinor,
      status: p === null ? 'NOT_IN_RUN' : raise ? 'RAISED' : above ? 'ABOVE' : last === null ? 'NO_DECISION' : 'NOT_RAISED',
      engineMinor: (raise ?? above)?.final_amount_minor ?? null, refused,
    });
  }
  belowFloor.sort((a, b) => a.profitMinor - b.profitMinor || a.sku.localeCompare(b.sku));

  /**
   * Топ-15: самые продаваемые товары (без продаж — по порядку файла). Решения разные по очереди — пол остановил цену, итоговая
   * проверка отказала цене ниже пола маржи, движок пошёл за конкурентом вниз, движок поднял цену за конкурентом: одно и то же «пол
   * удержал» пятнадцать раз подряд не показывает, что движок делает ещё. Нет решения нужного вида — следующее по очереди, затем
   * последнее решение
   */
  const unsetLimits = new Set([(m.ui.gateChecks as Record<string, string>).STEP, (m.ui.gateChecks as Record<string, string>).RATE]);
  const ranked = [...world.products].filter((p) => (perProduct.get(world.dbScopeId(p)) ?? []).length > 0)
    .sort((a, b) => (b.row.sales30d ?? -1) - (a.row.sales30d ?? -1) || a.row.line - b.row.line).slice(0, TOP);
  const kinds: Array<(d: DecisionRow, p: KilltestProduct) => boolean> = [
    (d) => atFloor(d),
    (d) => d.outcome === 'REJECTED',
    (d, p) => d.outcome === 'APPROVED' && !atFloor(d) && d.final_amount_minor !== null && d.final_amount_minor < p.row.priceMinor,
    (d, p) => d.outcome === 'APPROVED' && d.final_amount_minor !== null && d.final_amount_minor > p.row.priceMinor,
  ];
  const top: TopDecision[] = [];
  for (const [rank, p] of ranked.entries()) {
    const ds = [...perProduct.get(world.dbScopeId(p))!].reverse();
    const order = kinds.map((_, k) => kinds[(rank + k) % kinds.length]!);
    const chosen = order.map((kind) => ds.find((d) => kind(d, p))).find((d) => d !== undefined) ?? ds[0]!;
    const detail = await world.store.decisionDetail(tenantId, chosen.price_decision_id);
    if (!detail) continue;
    const trace: DecisionTrace = decisionTrace(await worldFor([chosen.write_scope_id]), detail, m);
    const step = (key: string) => trace.steps.find((x) => x.key === key);
    const why = [
      ...(step('STRATEGY')?.items ?? []).filter((i) => i.reason).map((i) => i.reason!.text),
      ...(step('GATE') ? [step('GATE')!.summary] : []),
    ].map(clientSafe);
    // Ревью шага 72, находка 2: пределов шага и частоты в прогоне нет — их «пройдено» было бы обещанием проверки, которой не было
    const checks = (step('GATE')?.items ?? []).filter((i) => i.outcome === 'PASS' && !unsetLimits.has(i.label)).map((i) => clientSafe(i.label));
    top.push({
      label: p.row.title ?? p.row.sku, sku: p.row.sku, sales: p.row.sales30d,
      currentMinor: p.row.priceMinor, decidedMinor: chosen.final_amount_minor, floorMinor: chosen.effective_floor_minor, ceilingMinor: chosen.effective_ceiling_minor,
      floorKind: floorKindOf(chosen, p), atFloor: atFloor(chosen), refused: chosen.outcome === 'REJECTED', costSource: p.costSource, when: trace.decidedAt, why, checks,
    });
  }

  /**
   * Отправленные в канал записи — из базы, а не константой: тень держит запись базой [Р-169]. Отправленная запись — та, у которой есть
   * время отправки (у удержанной тенью его не бывает). Больше нуля — отчёт не пишется вовсе (main.ts)
   */
  const [sent] = await world.db.rows<{ n: number }>(
    `SELECT (SELECT count(*) FROM tenant_data.channel_write WHERE tenant_id = $1 AND dispatched_at IS NOT NULL)
          + (SELECT count(*) FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND dispatched_at IS NOT NULL) AS n`, [tenantId]);
  const dbDispatched = Number(sent?.n ?? 0);
  const portWrites = world.portWriteCalls();
  const sentToAmazon = dbDispatched + portWrites;
  const savings = s.floorSavings.filter((x) => x.currency === 'USD' && x.minor > 0).map((x) => m.money(x.minor, x.currency))[0] ?? null;

  const notDone: ReportData['notDone'] = [];
  notDone.push({ title: sentToAmazon === 0 ? 'Nothing was changed on Amazon' : `${sentToAmazon} changes reached Amazon`,
    text: `The engine decided ${s.decisions} times and ${s.heldPriceWrites} price changes were held by shadow mode; ${sentToAmazon} were sent.${sentToAmazon === 0 ? ' Your listings are exactly as they were.' : ''}` });
  if (s.decisions > 0) {
    notDone.push({ title: 'The price never went below the floor',
      text: `In this simulation the competitor dropped below the floor. The price did not follow it there: ${floorDecisions.length} times it landed on the floor`
        + (marginRefused > 0 ? `, and ${marginRefused} times a price below your margin floor was refused, so the price stayed as it was. ` : '. ')
        + 'The floor is the higher of the minimum price (assumed in this run) and your margin floor (unit cost + assumed Amazon referral fee + minimum margin). '
        + 'It does not include FBA fees, per-item minimum fees, closing fees or shipping: if they apply to you, your real break-even is higher.'
        + (savings ? ` Without the floor the engine would have priced ${savings} lower in total in this simulation — the amount depends on how far we let the simulated competitor drop; it is not a forecast.` : '') });
    if (s.ceilingHeld > 0) notDone.push({ title: 'The price never went above the ceiling', text: `The price landed on the ceiling (assumed in this run) ${s.ceilingHeld} times.` });
  }
  const reasonCounts = new Map<string, number>();
  for (const d of decisions) if (d.outcome !== 'APPROVED' && d.code) reasonCounts.set(`${d.outcome}|${d.code}`, (reasonCounts.get(`${d.outcome}|${d.code}`) ?? 0) + 1);
  for (const [key, n] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const [outcome, code] = key.split('|') as [string, string];
    // Отказы ниже пола маржи уже сказаны в пункте о поле — второй раз тем же числом не повторяются
    if (code === 'BELOW_MARGIN_FLOOR') continue;
    // Тень повторно не предлагает ту же цену: для клиента это «конкурент сдвинулся, а цена движка осталась прежней», а не внутренний механизм
    if (code === 'SHADOW_ALREADY_PROPOSED') {
      notDone.push({ title: 'We did not repeat a price we had already proposed', text: `${n} times a competitor moved but the engine's price stayed the same as its last proposal, so there was nothing new to change.` });
      continue;
    }
    const reason = describe({ code, params: {} } as never, m);
    // Находка 1: пол маржи выше допущенного max_price — причина словами, не «граница не вычисляется»
    const aboveMax = decisions.filter((d) => d.code === code && d.cause === 'MARGIN_FLOOR_ABOVE_MAX_PRICE').length;
    if (code === 'BOUND_UNRESOLVABLE' && aboveMax === n) {
      notDone.push({ title: 'We did not go above the maximum price', text: `${n} ${n === 1 ? 'decision was' : 'decisions were'} refused because your margin floor is above the maximum price we assumed (${options.maxPct}% above your price): the engine never prices above the maximum. In a pilot you set your own maximum price.` });
      continue;
    }
    notDone.push({ title: clientSafe(reason.title), text: `${n} ${n === 1 ? 'decision' : 'decisions'} ${outcome === 'NO_CHANGE' ? 'kept the price as it was' : outcome === 'REJECTED' ? 'were refused by the final price check' : 'held the price'}: ${clientSafe(reason.title).toLowerCase()}.` });
  }
  const refused = await world.db.rows<{ code: string; n: number }>(
    `SELECT reason_code AS code, count(*)::int AS n FROM channel_data.rejected_competitor_snapshot WHERE tenant_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [tenantId]);
  for (const r of refused) {
    notDone.push({ title: 'We ignored implausible competitor data', text: `${r.n} simulated competitor updates were refused before any decision: ${clientSafe(describe({ code: r.code, params: {} } as never, m).title).toLowerCase()}.` });
  }
  const halts = await world.db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM channel_data.pricing_halt WHERE tenant_id = $1`, [tenantId]);
  if ((halts[0]?.n ?? 0) > 0) {
    notDone.push({ title: 'We paused competitor-based pricing', text: `${halts[0]!.n} times the simulated competitor data of the whole storefront moved in a way that looks like broken data rather than a market; prices from competitor data were paused until it looked normal again.` });
  }
  // Ревью, находка 3: про бюджеты — только то, что известно; про скорость записи в бою прогон ничего не доказал, и пункта нет
  notDone.push({ title: 'No edit budget was spent',
    text: 'We know of no daily limit on price edits per listing on amazon.com (eBay, for example, allows 250 edits a day), so none applies in this run. No limit on the size of a price step or on how often a price changes was set in this run either; in a pilot you can set them, and every decision is checked against them.' });

  const noCost = world.products.filter((p) => p.costSource === 'NONE');
  const rejectedMap = new Map<RowProblem, number[]>();
  for (const r of catalog.rejected) {
    const lines = rejectedMap.get(r.problem);
    if (lines) lines.push(r.line); else rejectedMap.set(r.problem, [r.line]);
  }
  const noteMap = new Map<RowNote, number>();
  for (const r of catalog.rows) for (const n of r.notes) noteMap.set(n, (noteMap.get(n) ?? 0) + 1);
  const assumed = new Set(world.products.filter((p) => p.costSource === 'ASSUMED').map((p) => world.dbScopeId(p)));
  return {
    generatedAt: m.when(new Date().toISOString()), fileName: catalog.fileName, format: catalog.format, hours: options.hours, options,
    salesHeader: catalog.recognized.find((c) => c.field === 'sales30d')?.header ?? null,
    counts: {
      rows: catalog.rows.length + catalog.rejected.length, rejectedRows: catalog.rejected.length, inRun: world.products.length,
      inEngine: world.products.filter((p) => p.costMinor !== null).length, withFileCost: world.products.filter((p) => p.costSource === 'FILE').length,
      assumedCost: world.products.filter((p) => p.costSource === 'ASSUMED').length, noCost: noCost.length, skippedByLimit: world.skippedByLimit.length,
      decisions: s.decisions, assumedCostDecisions: decisions.filter((d) => assumed.has(d.write_scope_id)).length, changes: s.changes,
      floorHeld: floorDecisions.length,
      floorHeldAssumedMin: floorDecisions.filter((d) => { const p = productOf(d); return p !== undefined && floorKindOf(d, p) === 'ASSUMED_MIN'; }).length,
      floorHeldMargin: floorDecisions.filter((d) => { const p = productOf(d); return p !== undefined && floorKindOf(d, p) === 'MARGIN'; }).length, marginRefused,
      raisedToFloor: belowFloor.filter((b) => b.status === 'RAISED').length,
      ceilingHeld: s.ceilingHeld, heldWrites: s.heldPriceWrites, competitorUpdates: world.snapshots, sentToAmazon, dbDispatched, portWrites,
    },
    savings,
    belowFloor,
    top, notDone,
    noCostExamples: noCost.slice(0, 12).map((p) => p.row.title ? `${p.row.title} (${p.row.sku})` : p.row.sku),
    rejected: [...rejectedMap.entries()].map(([problem, lines]) => ({ text: PROBLEM_TEXT[problem], lines,
      values: [...new Set(catalog.rejected.filter((r) => r.problem === problem && r.currency !== undefined).map((r) => r.currency!))] })),
    notes: [...noteMap.entries()].map(([note, count]) => ({ text: NOTE_TEXT[note], count })),
    columns: {
      recognized: catalog.recognized.map((c) => ({ header: c.header, meaning: FIELD_NAMES[c.field] })),
      ignored: catalog.ignored,
      duplicates: catalog.duplicates.map((d) => ({ meaning: FIELD_NAMES[d.field], used: d.used, skipped: d.skipped })),
    },
    databaseKept,
  };
}

const money = (m: Messages, minor: number | null): string => (minor === null ? '—' : m.money(minor, 'USD'));
const pct = (from: number, to: number): string => {
  const p = Math.round(((to - from) / from) * 1000) / 10;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}%`;
};

/**
 * `client` — как показать строку клиента. Отчёт для клиента показывает её как есть; проверка утечек рисует тот же отчёт с заглушкой
 * вместо каждой строки клиента и ищет наши коды без единого исключения
 */
export function renderReport(d: ReportData, options: { client?: (s: string) => string } = {}): string {
  const m = messagesFor('en', { timeZone: 'America/New_York' });
  const e = escapeHtml;
  const cl = (s: string) => e(options.client ? options.client(s) : s);
  const c = d.counts;
  // Ревью, находка 7: «Units Ordered» Business Report — период выгрузки клиента, а не обязательно 30 дней
  const salesPeriod = d.salesHeader !== null && /30/.test(d.salesHeader) ? 'sold in 30 days' : 'units ordered in the period of your file';
  const card = (value: string | number, label: string) => `<div class="card"><div class="value">${e(String(value))}</div><div class="label">${e(label)}</div></div>`;
  const floorTag = (t: TopDecision) => (t.refused ? '<div class="tag">refused by the final price check</div>'
    : t.atFloor ? `<div class="tag">${t.decidedMinor !== null && t.decidedMinor > t.currentMinor ? (t.floorKind === 'MARGIN' ? 'raised to your margin floor' : 'raised to the assumed minimum price')
      : t.floorKind === 'MARGIN' ? 'stopped by your margin floor' : 'stopped by the assumed minimum price'}</div>` : '');
  const top = d.top.map((t, i) => `
    <article class="decision">
      <header><span class="rank">${i + 1}</span><div><h3>${cl(t.label)}</h3><div class="muted">${cl(t.sku)}${t.sales !== null ? ` · ${t.sales} ${e(salesPeriod)}` : ''}${t.costSource === 'ASSUMED' ? ' · <strong>assumed cost</strong>' : ''} · simulated time ${e(t.when)}</div></div></header>
      <div class="prices">
        <div><div class="muted">Your price now</div><div class="price">${e(money(m, t.currentMinor))}</div></div>
        <div class="arrow">→</div>
        <div><div class="muted">Engine's price</div>${t.refused || t.decidedMinor === null
          ? `<div class="price floor">${e(money(m, t.currentMinor))}</div><div class="muted">unchanged</div>`
          : `<div class="price ${t.atFloor ? 'floor' : ''}">${e(money(m, t.decidedMinor))}</div><div class="muted">${e(pct(t.currentMinor, t.decidedMinor))}</div>`}</div>
        <div class="bounds"><div class="muted">Floor – ceiling</div><div>${e(money(m, t.floorMinor))} – ${e(money(m, t.ceilingMinor))}</div>${floorTag(t)}</div>
      </div>
      <h4>Why this price</h4>
      <ul>${t.why.map((w) => `<li>${e(w)}</li>`).join('')}</ul>
      <details><summary>Safety checks passed (${t.checks.length})</summary><ul class="checks">${t.checks.map((x) => `<li>${e(x)}</li>`).join('')}</ul></details>
    </article>`).join('');
  const fromFile = ['SKUs', 'prices', ...(c.withFileCost > 0 ? ['unit costs'] : []), ...(d.salesHeader !== null ? ['units sold'] : [])];
  const noCostSection = c.noCost > 0 || c.assumedCost > 0 ? `
    <section><h2>Without your unit cost</h2>
      ${c.noCost > 0 ? `<p>${c.noCost} of your products have no unit cost in the file. <strong>For them the engine did not run at all</strong> — by design: without cost it cannot know where your margin ends, and it never prices blind.</p>
      <p>What is not available without unit cost:</p>
      <ul><li>the margin floor (unit cost + Amazon fee + minimum margin);</li><li>pricing for a target margin;</li><li>any automatic decision at all for these products.</li></ul>
      <p class="muted">Products without cost${d.noCostExamples.length < c.noCost ? ` (first ${d.noCostExamples.length})` : ''}: ${d.noCostExamples.map(cl).join('; ')}</p>` : ''}
      ${c.assumedCost > 0 ? `<p>${c.assumedCost} products had no cost in the file and ran with an <strong>assumed</strong> cost of ${d.options.assumeCostPct}% of the price, because you asked for it: ${c.assumedCostDecisions} of the decisions are on these products, and their floors are estimates. Such decisions are marked “assumed cost” below.</p>` : ''}
    </section>` : '';
  /**
   * Р-207 (шаг 72): самая продающая находка для владельца — товары, которые он продаёт ниже своего же пола маржи. Факты — его цена и
   * себестоимость; комиссия и маржа — допущения, названные рядом; цена движка — из базы прогона, отказ — словами
   */
  const notInRun = d.belowFloor.filter((b) => b.status === 'NOT_IN_RUN').length;
  const engineCell = (b: BelowFloorRow): string => {
    if (b.status === 'RAISED') return `<strong>${e(money(m, b.engineMinor))}</strong><div class="muted">would be raised to your margin floor · ${e(pct(b.priceMinor, b.engineMinor!))}</div>`;
    if (b.status === 'ABOVE') return `<strong>${e(money(m, b.engineMinor))}</strong><div class="muted">would be raised above your margin floor, following the simulated competitor · ${e(pct(b.priceMinor, b.engineMinor!))}</div>`;
    if (b.status === 'NOT_RAISED') return `not raised<div class="muted">${e(b.refused ?? '')}</div>`;
    if (b.status === 'NOT_IN_RUN') return '<span class="muted">not in this run</span>';
    return '<span class="muted">no decision in this run</span>';
  };
  const belowFloorSection = d.belowFloor.length > 0 ? `
    <section class="highlight"><h2>Products priced below your margin floor</h2>
      <p><strong>${d.belowFloor.length} of your products are priced below the margin floor computed from your unit cost</strong>, an assumed Amazon referral fee of ${d.options.feePct}% and a minimum margin of ${d.options.marginPct}%. The engine raises such a price to your margin floor, through the same final price check as every other price; it never goes above the maximum price. In this run the engine would have raised ${c.raisedToFloor} of them to the floor (shadow mode: nothing was sent).${notInRun > 0 ? ` ${notInRun} of them were not in this run.` : ''} No limit on the size of a price step was set in this run; in a pilot, a step limit you set can hold back a large raise.</p>
      <table><thead><tr><th>Product</th><th>Your price</th><th>Unit cost</th><th>Profit per unit at your price*</th><th>Margin floor</th><th>Engine's price</th></tr></thead><tbody>
      ${d.belowFloor.slice(0, 50).map((b) => `<tr><td>${cl(b.label)}<div class="muted">${cl(b.sku)}${b.sales !== null ? ` · ${b.sales} ${e(salesPeriod)}` : ''}</div></td><td>${e(money(m, b.priceMinor))}</td><td>${e(money(m, b.costMinor))}</td><td class="${b.profitMinor < 0 ? 'loss' : ''}">${e(money(m, b.profitMinor))}</td><td>${e(money(m, b.floorMinor))}</td><td>${engineCell(b)}</td></tr>`).join('')}
      </tbody></table>
      ${d.belowFloor.length > 50 ? `<p class="muted">The first 50 of ${d.belowFloor.length}, with the lowest profit per unit first.</p>` : ''}
      <p class="muted">* Your price minus the assumed ${d.options.feePct}% referral fee minus your unit cost. FBA fees, per-item minimum fees, closing fees and shipping are not included: if they apply to you, the real profit per unit is lower. Prices are treated as excluding sales tax. Whether buyers buy at the raised price is not something we know.</p>
    </section>` : '';
  const rowsSection = d.rejected.length > 0 || d.notes.length > 0 ? `
    <section><h2>Rows we could not use</h2>
      ${d.rejected.length > 0 ? `<table><thead><tr><th>Why</th><th>Rows</th><th>Line numbers in your file</th></tr></thead><tbody>${d.rejected.map((r) => `<tr><td>${e(r.text)}${r.values.length > 0 ? `: ${r.values.slice(0, 5).map(cl).join(', ')}` : ''}</td><td>${r.lines.length}</td><td>${e(r.lines.slice(0, 20).join(', '))}${r.lines.length > 20 ? ', …' : ''}</td></tr>`).join('')}</tbody></table>` : ''}
      ${d.notes.length > 0 ? `<p>Rows we used with a gap:</p><ul>${d.notes.map((n) => `<li>${e(n.text)}: ${n.count}</li>`).join('')}</ul>` : ''}
    </section>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repricing decisions for your catalog</title>
<style>
:root{--ink:#1d2733;--muted:#5d6b7a;--line:#dde3ea;--bg:#f6f8fa;--accent:#1f6feb;--floor:#8a5a00;--floorbg:#fff4d6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:32px 0 10px}h3{font-size:16px;margin:0}h4{font-size:14px;margin:14px 0 4px}
.muted{color:var(--muted);font-size:13px}.lead{font-size:16px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}
.card{background:#fff;border:1px solid var(--line);border-radius:8px;padding:12px}.card .value{font-size:24px;font-weight:600}.card .label{color:var(--muted);font-size:13px}
section{background:#fff;border:1px solid var(--line);border-radius:8px;padding:4px 18px 14px;margin-top:16px}section h2{margin-top:14px}
.decision{background:#fff;border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:10px 0}.decision header{display:flex;gap:12px;align-items:flex-start}
.rank{flex:none;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:13px}
.prices{display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin-top:12px}.price{font-size:20px;font-weight:600}.price.floor{color:var(--floor)}.arrow{font-size:20px;color:var(--muted)}
.tag{display:inline-block;margin-top:4px;background:var(--floorbg);color:var(--floor);border-radius:4px;padding:1px 6px;font-size:12px}
ul{margin:4px 0 0;padding-left:20px}li{margin:2px 0}.checks{columns:2;font-size:13px;color:var(--muted)}details summary{cursor:pointer;color:var(--muted);font-size:13px;margin-top:8px}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
.notice{background:#eef5ff;border:1px solid #c9dcff;border-radius:8px;padding:10px 14px;margin-top:14px}
section.highlight{border-color:#e3b341;background:#fffbea}td.loss{color:#b42318;font-weight:600}
@media (max-width:600px){.checks{columns:1}.prices{gap:10px}}
</style></head>
<body><main>
<h1>Repricing decisions for your catalog</h1>
<div class="muted">Shadow run on ${STOREFRONT} · ${e(d.generatedAt)} · ${d.hours} simulated hours · file: ${cl(d.fileName)} (${e(d.format)})</div>
<p class="lead">We ran your catalog through our repricing engine in <strong>shadow mode</strong>: each decision went through the same checks as in live mode, and ${c.sentToAmazon} changes were sent to Amazon. Each decision below comes with the reason for its price.</p>
<div class="notice"><strong>What is real and what is simulated.</strong> Your ${fromFile.slice(0, -1).join(', ')} and ${fromFile.at(-1)} come from your file. Simulated or assumed: your competitors (we cannot see them until you connect your Amazon account), your minimum and maximum prices, the Amazon referral fee and the minimum margin — see “How this run was set up”. The numbers about the floor describe this simulation, not your market.</div>
<div class="cards">
${card(c.rows, 'rows in your file')}${card(c.inEngine, 'priced by the engine')}${d.belowFloor.length > 0 ? card(d.belowFloor.length, 'priced below your margin floor') : ''}${card(c.decisions, 'decisions')}${card(c.changes, 'would change the price')}${card(c.floorHeld, 'landed on the floor (simulation)')}${card(c.sentToAmazon, 'changes sent to Amazon')}
</div>
<section><h2>Summary</h2><ul>
<li>${c.decisions} decisions on ${c.inEngine} products; ${c.changes} of them would have changed the price.${c.assumedCostDecisions > 0 ? ` ${c.assumedCostDecisions} of the decisions are on products with an assumed cost.` : ''}</li>
${c.decisions > 0 ? `<li>In this simulation the price landed on the floor ${c.floorHeld} times: ${c.floorHeldAssumedMin} times on the assumed minimum price, ${c.floorHeldMargin} times on your margin floor.</li>` : ''}
${c.marginRefused > 0 ? `<li>${c.marginRefused} times the engine's price would have been below your margin floor: the final price check refused it, and the price stayed as it was.</li>` : ''}
<li>${c.heldWrites} price changes were held by shadow mode; ${c.sentToAmazon} were sent to Amazon.</li>
</ul>
${c.skippedByLimit > 0 ? `<p class="muted">This run took ${c.inRun} of your products${d.salesHeader !== null ? ' with the most units sold' : ' in the order of your file'}; ${c.skippedByLimit} more were not run.</p>` : ''}
</section>
${belowFloorSection}
${d.top.length > 0 ? `<h2>${d.top.length} decisions in detail</h2>
<p class="muted">${d.salesHeader !== null ? 'Your products with the most units sold' : 'The first products of your file (it has no sales column)'}. We show different kinds of decisions in turn: where the floor stopped a lower price, where the engine followed a competitor down, and where it raised your price after a competitor went up.</p>
${top}` : `<section><h2>No decisions to show</h2><p>The engine made no decisions in this run: ${c.inEngine === 0 ? 'none of your products has a unit cost, and the engine never prices without one (see below). Send the same file with a unit cost column, or ask us for a run with an assumed cost.' : 'no competitor moved during the run.'}</p></section>`}
<section><h2>What we did NOT do — and why</h2>
${d.notDone.map((n) => `<h4>${e(n.title)}</h4><p>${e(n.text)}</p>`).join('')}
</section>
${noCostSection}
${rowsSection}
<section><h2>How this run differs from live pricing</h2><ul>
<li>Your current price stays the same during the whole run: in shadow mode nothing changes on Amazon, so each new proposal is compared with the engine's own last proposal, not with a changed price.</li>
<li>Your competitors are simulated: one competitor per product, near your price, that slides below the floor and back. Real markets move differently.</li>
<li>Connecting your Amazon account and live price changes on ${STOREFRONT} are not open yet: connecting waits on Amazon's approval of our app, and live changes need checks on your account that start with a period of shadow pricing. A pilot starts in shadow mode, with your own minimum and maximum prices.</li>
</ul></section>
<section><h2>How this run was set up</h2><ul>
<li>Storefront ${STOREFRONT}; prices are treated as US dollars excluding sales tax (our assumption for ${STOREFRONT}).</li>
<li>Strategy: one cent below the lowest competitor, never below the floor and never above the ceiling.</li>
<li>Your minimum and maximum prices were not in the file, so we assumed them: minimum ${d.options.minPct}% below your current price, maximum ${d.options.maxPct}% above it. In the pilot you set your own.</li>
<li>Margin floor: unit cost + an assumed Amazon referral fee of ${d.options.feePct}% (the fee depends on the product category; yours may differ) + minimum margin ${d.options.marginPct}%. FBA fees, per-item minimum fees, closing fees and shipping are not included.</li>
<li>${d.hours} simulated hours; each simulated competitor changed its price every ${d.options.competitorEveryMinutes} minutes (${c.competitorUpdates} competitor updates in total).</li>
<li>Columns we read: ${d.columns.recognized.map((r) => `“${cl(r.header)}” as ${e(r.meaning)}`).join(', ')}.</li>
${d.columns.ignored.length > 0 ? `<li>Columns we ignored: ${d.columns.ignored.map((h) => `“${cl(h)}”`).join(', ')}.</li>` : ''}
${d.columns.duplicates.map((x) => `<li>${e(x.meaning)}: we used “${cl(x.used)}”, not ${x.skipped.map((h) => `“${cl(h)}”`).join(', ')}.</li>`).join('')}
</ul></section>
<p class="muted">This report shows decisions, not a forecast of revenue: whether a buyer would have bought at another price is not something we know. Your file and this report stay with you; ${d.databaseKept ? 'the temporary database of this run was kept on our machine for inspection and is deleted after it.' : 'the run used a temporary database that was deleted when the report was written.'}</p>
</main></body></html>
`;
}

/** Колонки, которые мы понимаем, — для подсказки, что прислать (сообщение команды) */
export const ACCEPTED_COLUMNS_TEXT = (Object.entries(COLUMN_ALIASES) as Array<[CatalogField, readonly string[]]>)
  .map(([field, names]) => `${FIELD_NAMES[field]}: ${names.join(', ')}`).join('\n');
