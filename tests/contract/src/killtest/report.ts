import { decisionTrace, describe, messagesFor, shadowView, type DecisionTrace, type Messages, type StandWorld } from '@repracer/console-model';
import { COLUMN_ALIASES, type Catalog, type CatalogField, type RowNote, type RowProblem } from './catalog.ts';
import type { KilltestOptions, KilltestProduct, KilltestWorld } from './world.ts';

/**
 * Шаг 71: отчёт kill-test — английский самодостаточный HTML для клиента: сводка, топ-15 решений с «почему эта цена» словами, «что мы
 * НЕ сделали и почему», товары без себестоимости, допущения прогона.
 *
 * Слова — из словаря консоли (`messagesFor('en')`, `describe`, `decisionTrace`, `shadowView`): клиент читает то же, что увидит в
 * консоли, а не пересказ. Внутренних кодов, идентификаторов и номеров решений в отчёте нет: перед записью файла текст проверяется
 * (`internalLeaks`), и отчёт с утечкой не пишется вовсе — fail-closed.
 */

const STOREFRONT = 'amazon.com';
const TOP = 15;

const FIELD_NAMES: Readonly<Record<CatalogField, string>> = {
  sku: 'SKU', title: 'product name', asin: 'ASIN', price: 'current price', quantity: 'stock', cost: 'unit cost', sales30d: 'units sold in 30 days',
};
const PROBLEM_TEXT: Readonly<Record<RowProblem, string>> = {
  NO_SKU: 'no SKU', SKU_TOO_LONG: 'SKU longer than 40 characters (Amazon allows at most 40)', DUPLICATE_SKU: 'the same SKU appears again (we kept the first row)',
  PRICE_MISSING: 'no price', PRICE_NOT_A_NUMBER: 'the price is not a number', PRICE_AMBIGUOUS: 'the price could be read two ways (for example 10.505) — we do not guess',
  PRICE_NOT_POSITIVE: 'the price is zero or negative', PRICE_NOT_USD: 'the price is in another currency (amazon.com sells in US dollars)',
};
const NOTE_TEXT: Readonly<Record<RowNote, string>> = {
  COST_UNREADABLE: 'unit cost could not be read', COST_NOT_USD: 'unit cost is in another currency (we do not convert)',
  QUANTITY_UNREADABLE: 'stock could not be read', SALES_UNREADABLE: '30-day units could not be read',
};

interface DecisionRow {
  write_scope_id: string; price_decision_id: string; outcome: string; final_amount_minor: number | null; effective_floor_minor: number | null;
  effective_ceiling_minor: number | null; proposed_amount_minor: number | null; code: string | null; decided_at: string;
}

interface TopDecision {
  label: string; sku: string; salesText: string | null; currentMinor: number; decidedMinor: number | null; floorMinor: number | null; ceilingMinor: number | null;
  atFloor: boolean; when: string; why: string[]; checks: string[]; outcome: string;
}

export interface ReportData {
  generatedAt: string;
  fileName: string;
  format: string;
  hours: number;
  options: KilltestOptions;
  counts: { rows: number; rejectedRows: number; inRun: number; inEngine: number; withFileCost: number; assumedCost: number; noCost: number; skippedByLimit: number;
    decisions: number; changes: number; floorHeld: number; ceilingHeld: number; heldWrites: number; competitorUpdates: number; belowFloorNow: number; sentToAmazon: number };
  summaryLines: string[];
  top: TopDecision[];
  notDone: Array<{ title: string; text: string }>;
  noCostExamples: string[];
  rejected: Array<{ text: string; lines: number[] }>;
  notes: Array<{ text: string; count: number }>;
  columns: { recognized: Array<{ header: string; meaning: string }>; ignored: string[]; duplicates: string[] };
  /** Строки клиента (SKU, названия, заголовки) — исключаются из проверки на внутренние коды: они его, а не наши */
  clientStrings: string[];
  /** База прогона оставлена для разбора (--keep) — отчёт не обещает, что она удалена */
  databaseKept: boolean;
}

const CLIENT_SAFE: ReadonlyArray<[RegExp, string]> = [
  [/\bmin_price and max_price set\b/g, 'minimum and maximum price set'],
  [/\bmin_price\b/g, 'the minimum price'], [/\bmax_price\b/g, 'the maximum price'],
  [/\bANY_OFFER_CHANGED notification\b/g, 'notification of a competitor price change'],
];
const clientSafe = (text: string): string => CLIENT_SAFE.reduce((t, [re, to]) => t.replace(re, to), text);

/** Утечки внутреннего в тексте отчёта: коды, идентификаторы, наши номера решений и вопросов, синтетика мира прогона */
export function internalLeaks(html: string, clientStrings: readonly string[]): string[] {
  let text = html.replace(/<style>[\s\S]*?<\/style>/, '');
  for (const s of [...clientStrings].filter((x) => x.length > 0).sort((a, b) => b.length - a.length)) text = text.split(escapeHtml(s)).join(' ');
  const rules: Array<[string, RegExp]> = [
    ['uuid', /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
    ['UPPER_SNAKE code', /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/],
    ['lower_snake name', /\b[a-z]+_[a-z0-9_]+\b/],
    // Без флага u граница слова `\b` не видит кириллицу: «Р-205» проходил незамеченным (поймал положительный контроль теста)
    ['decision or question number', /(?<![\p{L}\p{N}])(Р|R|A|E|K|OQ)-\d{2,3}(?![\p{L}\p{N}])/u],
    ['ruleset or profile version', /\b[rg]\d+\.\d+\b/],
    ['storefront id', /\bATVPDKIKX0DER\b/],
    ['synthetic world id', /\b(B0KT\d{6}|A1SYNKILLTEST|killtest)\b/],
    ['external script or stylesheet', /<script|<link|https?:\/\//i],
  ];
  return rules.filter(([, re]) => re.test(text)).map(([name, re]) => `${name}: ${(text.match(re) ?? [''])[0]}`);
}

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
  const shadow = shadowView(await worldFor([]), page, { offset: 0, limit: 1 } as never, m, 7);
  const byScope = new Map<string, KilltestProduct>(world.products.map((p) => [world.dbScopeId(p), p]));
  const decisions = await world.db.rows<DecisionRow>(
    `SELECT write_scope_id, price_decision_id, outcome, final_amount_minor, effective_floor_minor, effective_ceiling_minor, proposed_amount_minor,
            coalesce(rejection_reason, no_change_reason) AS code, decided_at::text
       FROM channel_data.price_decision WHERE tenant_id = $1 ORDER BY decided_at`, [tenantId]);
  const perProduct = new Map<string, DecisionRow[]>();
  for (const d of decisions) perProduct.set(d.write_scope_id, [...(perProduct.get(d.write_scope_id) ?? []), d]);
  const atFloor = (d: DecisionRow) => d.final_amount_minor !== null && d.final_amount_minor === d.effective_floor_minor;
  // Товар, чья нынешняя цена ниже пола, посчитанного движком из себестоимости, комиссии и маржи: движок поднял бы её
  const belowFloorNow = [...perProduct.entries()].filter(([scope, ds]) => {
    const p = byScope.get(scope);
    const floor = ds.find((d) => d.effective_floor_minor !== null)?.effective_floor_minor ?? null;
    return p !== undefined && floor !== null && p.row.priceMinor < floor;
  }).length;

  /**
   * Топ-15: самые продаваемые товары (без продаж — по порядку файла). Решения разные по очереди — пол остановил цену, движок пошёл за
   * конкурентом вниз, движок поднял цену за конкурентом: у каждого товара в прогоне есть все три, и одно и то же «пол удержал» пятнадцать
   * раз подряд не показывает, что движок делает ещё. Нет решения нужного вида — следующее по очереди, затем последнее решение
   */
  const ranked = [...world.products].filter((p) => (perProduct.get(world.dbScopeId(p)) ?? []).length > 0)
    .sort((a, b) => (b.row.sales30d ?? -1) - (a.row.sales30d ?? -1) || a.row.line - b.row.line).slice(0, TOP);
  const kinds: Array<(d: DecisionRow, p: KilltestProduct) => boolean> = [
    (d) => atFloor(d),
    (d, p) => d.outcome === 'APPROVED' && !atFloor(d) && d.final_amount_minor !== null && d.final_amount_minor < p.row.priceMinor,
    (d, p) => d.outcome === 'APPROVED' && d.final_amount_minor !== null && d.final_amount_minor > p.row.priceMinor,
  ];
  const top: TopDecision[] = [];
  for (const [rank, p] of ranked.entries()) {
    const ds = [...perProduct.get(world.dbScopeId(p))!].reverse();
    const order = [0, 1, 2].map((k) => kinds[(rank + k) % kinds.length]!);
    const chosen = order.map((kind) => ds.find((d) => kind(d, p))).find((d) => d !== undefined) ?? ds[0]!;
    const detail = await world.store.decisionDetail(tenantId, chosen.price_decision_id);
    if (!detail) continue;
    const trace: DecisionTrace = decisionTrace(await worldFor([chosen.write_scope_id]), detail, m);
    const step = (key: string) => trace.steps.find((s) => s.key === key);
    const why = [
      ...(step('STRATEGY')?.items ?? []).filter((i) => i.reason).map((i) => i.reason!.text),
      ...(step('GATE') ? [step('GATE')!.summary] : []),
    ].map(clientSafe);
    const checks = (step('GATE')?.items ?? []).filter((i) => i.outcome === 'PASS').map((i) => clientSafe(i.label));
    top.push({
      label: p.row.title ?? p.row.sku, sku: p.row.sku, salesText: p.row.sales30d !== null ? `${p.row.sales30d} sold in 30 days` : null,
      currentMinor: p.row.priceMinor, decidedMinor: chosen.final_amount_minor, floorMinor: chosen.effective_floor_minor, ceilingMinor: chosen.effective_ceiling_minor,
      atFloor: atFloor(chosen), when: trace.decidedAt, why, checks, outcome: chosen.outcome,
    });
  }

  const s = shadow.summary;
  /**
   * Сколько раз пол остановил цену — одним числом: намерения, где стратегия хотела ниже пола (Р-173), а без них — решения ровно на полу.
   * Экран тени называет оба числа (они считают разное, шаг 42), для клиента два «удержания» рядом — путаница
   */
  const floorStops = s.floorSavingsHolds > 0 ? s.floorSavingsHolds : s.floorHeld;
  const savings = s.floorSavings.filter((x) => x.currency === 'USD' && x.minor > 0).map((x) => m.money(x.minor, x.currency))[0] ?? null;
  const notDone: ReportData['notDone'] = [];
  /**
   * Отправленные в канал записи — из базы, а не константой: тень держит запись базой [Р-169], и число — проверка, а не обещание.
   * Отправленная запись — та, у которой есть время отправки (у удержанной тенью его не бывает)
   */
  const [sent] = await world.db.rows<{ n: number }>(
    `SELECT (SELECT count(*) FROM tenant_data.channel_write WHERE tenant_id = $1 AND dispatched_at IS NOT NULL)
          + (SELECT count(*) FROM tenant_data.channel_write_history WHERE tenant_id = $1 AND dispatched_at IS NOT NULL) AS n`, [tenantId]);
  const sentToAmazon = Number(sent?.n ?? 0);
  notDone.push({ title: sentToAmazon === 0 ? 'Nothing was changed on Amazon' : 'Changes were sent to Amazon',
    text: sentToAmazon === 0
      ? `This run is a shadow: the engine decided ${s.decisions} times and ${s.heldPriceWrites} price changes were held — none was sent. Your listings are exactly as they were.`
      : `${sentToAmazon} changes left the shadow. This must not happen in a kill-test run — tell us.` });
  if (s.decisions > 0) notDone.push({ title: 'We never went below your floor',
    text: `${floorStops} times the strategy wanted a lower price than your floor, and the floor stopped it${savings ? ` — without the floor you would have sold ${savings} cheaper in total` : ''}. The floor is the higher of your minimum price and your cost plus the Amazon fee plus the minimum margin.` });
  if (s.decisions > 0) notDone.push({ title: 'We never went above your ceiling', text: s.ceilingHeld > 0
    ? `${s.ceilingHeld} times the strategy wanted a higher price than your ceiling, and the price stopped at the ceiling.`
    : 'In this run the strategy never wanted a price above your ceiling.' });
  const reasonCounts = new Map<string, number>();
  for (const d of decisions) if (d.outcome !== 'APPROVED' && d.code) reasonCounts.set(`${d.outcome}|${d.code}`, (reasonCounts.get(`${d.outcome}|${d.code}`) ?? 0) + 1);
  for (const [key, n] of [...reasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const [outcome, code] = key.split('|') as [string, string];
    // Тень повторно не предлагает ту же цену: для клиента это «конкурент сдвинулся, а цена движка осталась прежней», а не внутренний механизм
    if (code === 'SHADOW_ALREADY_PROPOSED') {
      notDone.push({ title: 'We did not change a price that was already right', text: `${n} times a competitor moved but the engine's price stayed the same as its last proposal, so there was nothing new to change.` });
      continue;
    }
    const reason = describe({ code, params: {} } as never, m);
    notDone.push({ title: clientSafe(reason.title), text: `${n} ${n === 1 ? 'decision' : 'decisions'} ${outcome === 'NO_CHANGE' ? 'kept the price as it was' : outcome === 'REJECTED' ? 'were refused by the Price Gate' : 'held the price'}: ${clientSafe(reason.title).toLowerCase()}.` });
  }
  const refused = await world.db.rows<{ code: string; n: number }>(
    `SELECT reason_code AS code, count(*)::int AS n FROM channel_data.rejected_competitor_snapshot WHERE tenant_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [tenantId]);
  for (const r of refused) {
    notDone.push({ title: 'We ignored implausible competitor data', text: `${r.n} competitor updates were refused before any decision: ${clientSafe(describe({ code: r.code, params: {} } as never, m).title).toLowerCase()}.` });
  }
  const halts = await world.db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM channel_data.pricing_halt WHERE tenant_id = $1`, [tenantId]);
  if ((halts[0]?.n ?? 0) > 0) {
    notDone.push({ title: 'We paused competitor-based pricing', text: `${halts[0]!.n} times the competitor data of the whole storefront moved in a way that looks like broken data rather than a market; prices from competitor data were paused until it looked normal again.` });
  }
  notDone.push({ title: 'We would not flood Amazon with updates',
    text: 'In live mode the engine paces its writes to Amazon\'s own limit for price updates (5 per second for your account) and confirms each change by reading the listing back.' });

  const noCost = world.products.filter((p) => p.costSource === 'NONE');
  const rejectedMap = new Map<RowProblem, number[]>();
  for (const r of catalog.rejected) rejectedMap.set(r.problem, [...(rejectedMap.get(r.problem) ?? []), r.line]);
  const noteMap = new Map<RowNote, number>();
  for (const r of catalog.rows) for (const n of r.notes) noteMap.set(n, (noteMap.get(n) ?? 0) + 1);
  return {
    generatedAt: m.when(new Date().toISOString()), fileName: catalog.fileName, format: catalog.format, hours: options.hours, options,
    counts: {
      rows: catalog.rows.length + catalog.rejected.length, rejectedRows: catalog.rejected.length, inRun: world.products.length,
      inEngine: world.products.filter((p) => p.costMinor !== null).length, withFileCost: world.products.filter((p) => p.costSource === 'FILE').length,
      assumedCost: world.products.filter((p) => p.costSource === 'ASSUMED').length, noCost: noCost.length, skippedByLimit: world.skippedByLimit.length,
      decisions: s.decisions, changes: s.changes, floorHeld: floorStops, ceilingHeld: s.ceilingHeld, heldWrites: s.heldPriceWrites,
      competitorUpdates: world.snapshots, belowFloorNow, sentToAmazon,
    },
    summaryLines: [
      `${s.decisions} decisions on ${world.products.filter((p) => p.costMinor !== null).length} products; ${s.changes} of them would have changed the price.`,
      `${floorStops} times your floor stopped a lower price${savings ? `; without the floor you would have sold ${savings} cheaper in total` : ''}.`,
      ...(savings ? ['That amount is the difference between your floor and what the strategy wanted — not a forecast of revenue: whether a buyer would have bought at the lower price is not something we know.'] : []),
      `${s.heldPriceWrites} price changes were held by shadow mode; none was sent to Amazon.`,
    ],
    top, notDone,
    noCostExamples: noCost.slice(0, 12).map((p) => p.row.title ? `${p.row.title} (${p.row.sku})` : p.row.sku),
    rejected: [...rejectedMap.entries()].map(([problem, lines]) => ({ text: PROBLEM_TEXT[problem], lines })),
    notes: [...noteMap.entries()].map(([note, count]) => ({ text: NOTE_TEXT[note], count })),
    columns: {
      recognized: catalog.recognized.map((c) => ({ header: c.header, meaning: FIELD_NAMES[c.field] })),
      ignored: catalog.ignored,
      duplicates: catalog.duplicates.map((d) => `${FIELD_NAMES[d.field]}: we used "${d.used}", not ${d.skipped.map((x) => `"${x}"`).join(', ')}`),
    },
    clientStrings: [catalog.fileName, ...catalog.recognized.map((c) => c.header), ...catalog.ignored, ...catalog.duplicates.flatMap((d) => [d.used, ...d.skipped]),
      ...catalog.rows.flatMap((r) => [r.sku, r.title ?? '']), ...catalog.rejected.map((r) => r.sku ?? '')],
    databaseKept,
  };
}

const money = (m: Messages, minor: number | null): string => (minor === null ? '—' : m.money(minor, 'USD'));
const pct = (from: number, to: number): string => {
  const p = Math.round(((to - from) / from) * 1000) / 10;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}%`;
};

export function renderReport(d: ReportData): string {
  const m = messagesFor('en', { timeZone: 'America/New_York' });
  const e = escapeHtml;
  const c = d.counts;
  const card = (value: string | number, label: string) => `<div class="card"><div class="value">${e(String(value))}</div><div class="label">${e(label)}</div></div>`;
  const top = d.top.map((t, i) => `
    <article class="decision">
      <header><span class="rank">${i + 1}</span><div><h3>${e(t.label)}</h3><div class="muted">${e(t.sku)}${t.salesText ? ` · ${e(t.salesText)}` : ''} · simulated time ${e(t.when)}</div></div></header>
      <div class="prices">
        <div><div class="muted">Your price now</div><div class="price">${e(money(m, t.currentMinor))}</div></div>
        <div class="arrow">→</div>
        <div><div class="muted">Engine's price</div><div class="price ${t.atFloor ? 'floor' : ''}">${e(money(m, t.decidedMinor))}</div>${t.decidedMinor !== null ? `<div class="muted">${e(pct(t.currentMinor, t.decidedMinor))}</div>` : ''}</div>
        <div class="bounds"><div class="muted">Floor – ceiling</div><div>${e(money(m, t.floorMinor))} – ${e(money(m, t.ceilingMinor))}</div>${t.atFloor ? '<div class="tag">held by the floor</div>' : ''}</div>
      </div>
      <h4>Why this price</h4>
      <ul>${t.why.map((w) => `<li>${e(w)}</li>`).join('')}</ul>
      <details><summary>Safety checks passed (${t.checks.length})</summary><ul class="checks">${t.checks.map((x) => `<li>${e(x)}</li>`).join('')}</ul></details>
    </article>`).join('');
  const noCostSection = c.noCost > 0 || c.assumedCost > 0 ? `
    <section><h2>Without your unit cost</h2>
      ${c.noCost > 0 ? `<p>${e(String(c.noCost))} of your products have no unit cost in the file. <strong>For them the engine did not run at all</strong> — by design: without cost it cannot know where your margin ends, and it never prices blind.</p>
      <p>What is not available without unit cost:</p>
      <ul><li>the margin floor (cost + Amazon fee + minimum margin) — only your minimum price would protect you;</li>
      <li>pricing for a target margin;</li><li>any automatic decision at all for these products.</li></ul>
      <p class="muted">Products without cost${d.noCostExamples.length < c.noCost ? ` (first ${d.noCostExamples.length})` : ''}: ${d.noCostExamples.map(e).join('; ')}</p>` : ''}
      ${c.assumedCost > 0 ? `<p>${e(String(c.assumedCost))} products had no cost in the file and ran with an <strong>assumed</strong> cost of ${e(String(d.options.assumeCostPct))}% of the price, because you asked for it. Their floors are therefore estimates.</p>` : ''}
    </section>` : '';
  const rowsSection = d.rejected.length > 0 || d.notes.length > 0 ? `
    <section><h2>Rows we could not use</h2>
      ${d.rejected.length > 0 ? `<table><thead><tr><th>Why</th><th>Rows</th><th>Line numbers in your file</th></tr></thead><tbody>${d.rejected.map((r) => `<tr><td>${e(r.text)}</td><td>${r.lines.length}</td><td>${e(r.lines.slice(0, 20).join(', '))}${r.lines.length > 20 ? ', …' : ''}</td></tr>`).join('')}</tbody></table>` : ''}
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
@media (max-width:600px){.checks{columns:1}.prices{gap:10px}}
</style></head>
<body><main>
<h1>Repricing decisions for your catalog</h1>
<div class="muted">Shadow run on ${STOREFRONT} · ${e(d.generatedAt)} · ${d.hours} simulated hours · file: ${e(d.fileName)} (${e(d.format)})</div>
<p class="lead">We ran your catalog through our repricing engine in <strong>shadow mode</strong>: every decision was made exactly as it would be live, and <strong>nothing was sent to Amazon</strong>. Each decision below comes with the reason for its price.</p>
<div class="notice"><strong>What is real and what is simulated.</strong> Your SKUs, prices${c.withFileCost > 0 ? ', unit costs' : ''} and sales come from your file. Your competitors are <strong>simulated</strong>: we cannot see them until you connect your Amazon account in shadow mode. In this run a competitor near your price slides below your floor and back, so you can see where the engine follows and where it stops.</div>
<div class="cards">
${card(c.rows, 'products in your file')}${card(c.inEngine, 'priced by the engine')}${card(c.decisions, 'decisions')}${card(c.changes, 'would change the price')}${card(c.floorHeld, 'times your floor stopped a lower price')}${card(c.sentToAmazon, 'changes sent to Amazon')}
</div>
<section><h2>Summary</h2><ul>${d.summaryLines.map((l) => `<li>${e(l)}</li>`).join('')}</ul>
${c.belowFloorNow > 0 ? `<p><strong>${c.belowFloorNow} of your products are priced below their floor right now</strong> (cost + Amazon fee + minimum margin, or the minimum price): the engine would raise them first.</p>` : ''}
${c.skippedByLimit > 0 ? `<p class="muted">This run took your ${c.inRun} best-selling products; ${c.skippedByLimit} more were not run.</p>` : ''}
</section>
${d.top.length > 0 ? `<h2>The ${d.top.length} decisions that matter most</h2>
<p class="muted">Your best-selling products${d.top.some((t) => t.salesText) ? '' : ' (no sales column in your file — first products of the file)'}. We show different kinds of decisions in turn: where your floor stopped a lower price, where the engine followed a competitor down, and where it raised your price after a competitor went up.</p>
${top}` : `<section><h2>No decisions to show</h2><p>The engine made no decisions in this run: ${c.inEngine === 0 ? 'none of your products has a unit cost, and the engine never prices without one (see below). Send the same file with a unit cost column, or ask us for a run with an assumed cost.' : 'no competitor moved during the run.'}</p></section>`}
<section><h2>What we did NOT do — and why</h2>
${d.notDone.map((n) => `<h4>${e(n.title)}</h4><p>${e(n.text)}</p>`).join('')}
</section>
${noCostSection}
${rowsSection}
<section><h2>How this run was set up</h2><ul>
<li>Storefront ${STOREFRONT}, prices in US dollars without sales tax (Amazon adds it at checkout).</li>
<li>Strategy: one cent below the lowest competitor, never below the floor and never above the ceiling.</li>
<li>Your bounds were not in the file, so we assumed them: minimum price ${d.options.minPct}% below your current price, maximum price ${d.options.maxPct}% above it. In the pilot you set your own.</li>
<li>Margin floor: unit cost + Amazon referral fee ${d.options.feePct}% (most categories; yours may differ) + minimum margin ${d.options.marginPct}%.</li>
<li>${d.hours} simulated hours; each competitor changed its price every ${d.options.competitorEveryMinutes} minutes (${c.competitorUpdates} competitor updates in total).</li>
<li>Columns we read: ${d.columns.recognized.map((r) => `"${e(r.header)}" as ${e(r.meaning)}`).join(', ')}.</li>
${d.columns.ignored.length > 0 ? `<li>Columns we ignored: ${d.columns.ignored.map((h) => `"${e(h)}"`).join(', ')}.</li>` : ''}
${d.columns.duplicates.map((x) => `<li>${e(x)}.</li>`).join('')}
</ul></section>
<p class="muted">This report shows decisions, not a forecast of revenue: whether a buyer would have bought at another price is not something we know. Your file and this report stay with you; ${d.databaseKept ? 'the temporary database of this run was kept on our machine for inspection and is deleted after it.' : 'the run used a temporary database that was deleted when the report was written.'}</p>
</main></body></html>
`;
}

/** Колонки, которые мы понимаем, — для подсказки клиенту, что прислать (README и сообщение об ошибке) */
export const ACCEPTED_COLUMNS_TEXT = (Object.entries(COLUMN_ALIASES) as Array<[CatalogField, readonly string[]]>)
  .map(([field, names]) => `${FIELD_NAMES[field]}: ${names.join(', ')}`).join('\n');
