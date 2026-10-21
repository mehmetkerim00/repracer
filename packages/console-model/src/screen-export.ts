import type { ConsoleAuditRow, ConsoleDecisionRow, FeedPageItem, ImportKind, ImportRunRow } from '@repracer/pricing-pipeline';
import type { StockRow } from '@repracer/stock-sync';
import type { CompetitorSnapshot } from '@repracer/channel-port';
import { fulfilmentKind } from '@repracer/pricing-model';
import { competitionRowOffers, landedOf, orderedOffers } from './competition.ts';
import { effectiveFloor } from './bounds.ts';
import type { DangerousItem, FloorHoldItem } from './dangerous-report.ts';
import type { ExportRef } from './export-ref.ts';
import type { Messages } from './i18n/index.ts';
import { importHistoryView, secondsOf } from './imports.ts';
import { feedItemOf } from './price-feed.ts';
import { strategyLabel, type ProductRow } from './products.ts';
import type { RejectedItem } from './rejected.ts';
import { auditCards } from './stop.ts';
import { decisionItems, explanationOf } from './trace.ts';
import { scopeById, storefrontName, type StandWorld, type UnitRef } from './world.ts';

/**
 * Шаг 104 [Р-229]: выгрузка экрана в файл — кнопка «Export (CSV / XLSX)» на экранах с данными. Что видишь, то и выгружаешь: строки файла
 * строятся из тех же строк, что экран (те же фильтры, период и порядок), сверх экрана — только сырьё для таблиц: момент — ISO 8601 в
 * поясе рабочего пространства, суммы — числом с точкой и отдельной колонкой валюты, состояния — кодами.
 *
 * Заголовки колонок — ВСЕГДА английские, независимо от языка интерфейса: на них держатся формулы и интеграции продавца. Тексты причин —
 * на языке рабочего пространства. Не больше 50 000 строк: больше — честный отказ «narrow the period», а не молча обрезанный файл.
 */

export const EXPORT_SCREENS = ['price-changes', 'decisions', 'stopped-by-people', 'prevented-by-rules', 'offers', 'offer-competitors', 'inventory', 'imports', 'audit-log'] as const;
export type ExportScreen = (typeof EXPORT_SCREENS)[number];
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Потолок строк одной выгрузки: столько же держит база у файла выгрузки (0201) */
export const EXPORT_MAX_ROWS = 50_000;

/**
 * Глубина периода журналов, получивших поле Period на шаге 104 (решение владельца): журнал аудита живёт 18 месяцев (`audit.audit_event`,
 * 0012), журнал импортов — до закрытия тенанта (0193): календарь назад — на десять лет
 */
export const AUDIT_KEEP_DAYS = 548;
export const IMPORTS_KEEP_DAYS = 3650;

/** Название экрана в файле (лист «About this export») — английское, как заголовки */
export const EXPORT_SCREEN_TITLES: Readonly<Record<ExportScreen, string>> = {
  'price-changes': 'Price changes — prices sent', decisions: 'Price changes — all decisions', 'stopped-by-people': 'Protections — stopped by people',
  'prevented-by-rules': 'Protections — prevented by rules', offers: 'Offers', 'offer-competitors': 'Offers — competitors of the last snapshot', inventory: 'Inventory', imports: 'Import history', 'audit-log': 'Stop pricing — audit log',
};

const PROTECTION_HEADER = ['time', 'section', 'kind', 'decision_id', 'channel', 'storefront', 'sku', 'offer', 'price_was', 'price_wanted', 'price_set', 'bound',
  'currency', 'beyond_bound_percent', 'reason_code', 'reason'] as const;

/** Заголовки колонок по экранам — английские всегда (свойство держит тест на экранах ES и FR) */
export const EXPORT_HEADERS: Readonly<Record<ExportScreen, readonly string[]>> = {
  'price-changes': ['time', 'write_id', 'decision_id', 'channel', 'storefront', 'sku', 'offer', 'price_from', 'price_to', 'currency', 'change_percent', 'status', 'source', 'reason'],
  decisions: ['time', 'decision_id', 'channel', 'storefront', 'sku', 'offer', 'outcome', 'price', 'currency', 'reason'],
  'stopped-by-people': PROTECTION_HEADER,
  'prevented-by-rules': PROTECTION_HEADER,
  offers: ['write_scope_id', 'channel', 'storefront', 'sku', 'offer', 'current_price', 'floor', 'floor_source', 'min_price', 'max_price', 'currency', 'strategy', 'repricing'],
  // Шаг 105 [Р-230]: конкуренты последнего снимка по каждому показанному предложению — строки страницы Competition
  'offer-competitors': ['write_scope_id', 'channel', 'storefront', 'sku', 'offer', 'snapshot_at', 'rank', 'seller', 'is_you', 'holds_buy_box', 'landed_price', 'price',
    'shipping', 'currency', 'fulfilment'],
  inventory: ['product_id', 'sku', 'product', 'gtin', 'on_hand', 'reserved', 'available', 'channel_managed', 'channels'],
  imports: ['time', 'import_run_id', 'import', 'outcome', 'reason_code', 'reason', 'file', 'file_sha256', 'rows_total', 'rows_changed', 'rows_unchanged',
    'rows_rejected', 'duration_seconds', 'by'],
  'audit-log': ['time', 'event_id', 'action', 'action_text', 'actor', 'subject', 'note', 'detail'],
};

/** Шаг 105 [Р-230]: колонки Buy Box выгрузки Offers — когда они включены на экране («что видишь, то и выгружаешь») */
export const OFFER_BUYBOX_HEADERS = ['buy_box_holder', 'buy_box_seller', 'buy_box_price', 'buy_box_price_landed', 'buy_box_gap', 'buy_box_share_7d', 'buy_box_snapshot_at'] as const;

/** Заголовки файла экрана: у Offers с включёнными колонками Buy Box — и они */
export function exportHeaders(screen: ExportScreen, options: { buybox?: boolean } = {}): readonly string[] {
  return screen === 'offers' && options.buybox ? [...EXPORT_HEADERS.offers, ...OFFER_BUYBOX_HEADERS] : EXPORT_HEADERS[screen];
}

/** Колонки чисел: в XLSX — числовые ячейки, чтобы формулы продавца считали */
export const EXPORT_NUMERIC_COLUMNS: readonly string[] = ['price_from', 'price_to', 'change_percent', 'price', 'price_was', 'price_wanted', 'price_set', 'bound',
  'beyond_bound_percent', 'current_price', 'floor', 'min_price', 'max_price', 'on_hand', 'reserved', 'available', 'channel_managed', 'rows_total', 'rows_changed',
  'rows_unchanged', 'rows_rejected', 'duration_seconds', 'buy_box_price', 'buy_box_gap', 'buy_box_share_7d', 'rank', 'landed_price', 'shipping'];

const pad = (n: number, w = 2) => String(Math.trunc(n)).padStart(w, '0');

/**
 * Момент — ISO 8601 в поясе рабочего пространства: «2026-10-20T03:04:00-04:00». Пояс не назван или UTC — «Z». Часов машины модель не
 * читает [Р-146]: момент — из данных
 */
export function isoInZone(instant: string | null | undefined, timeZone: string | null): string {
  if (!instant) return '';
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return '';
  const whole = Math.floor(d.getTime() / 1000) * 1000;
  if (!timeZone || timeZone === 'UTC') return new Date(whole).toISOString().replace('.000Z', 'Z');
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).map((p) => [p.type, p.value]));
  } catch {
    // Пояс, которого не знает ICU среды, — UTC, как у экранов (ревью шага 69, находка 15)
    return new Date(whole).toISOString().replace('.000Z', 'Z');
  }
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const offset = Math.round((local - whole) / 60_000);
  const sign = offset < 0 ? '-' : '+';
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(Math.abs(offset) / 60)}:${pad(Math.abs(offset) % 60)}`;
}

/** Дата в поясе рабочего пространства — часть имени файла */
export function dateInZone(instant: string, timeZone: string | null): string {
  return isoInZone(instant, timeZone).slice(0, 10);
}

const fractionDigits = new Map<string, number>();
function digitsOf(currency: string): number {
  let d = fractionDigits.get(currency);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat('en-US', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    } catch {
      d = 2;
    }
    fractionDigits.set(currency, d);
  }
  return d;
}

/** Сумма числом без локали: 1799 USD → «17.99» (точка, без разделителей групп); нет суммы — пустая ячейка */
export function amountText(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined || !Number.isFinite(minor)) return '';
  const digits = currency ? digitsOf(currency) : 2;
  const neg = minor < 0;
  const abs = String(Math.abs(Math.trunc(minor))).padStart(digits + 1, '0');
  return `${neg ? '-' : ''}${digits > 0 ? `${abs.slice(0, -digits)}.${abs.slice(-digits)}` : abs}`;
}

/** Изменение в процентах числом: «-12.5»; без «было» — пусто */
export function changePercent(from: number | null, to: number | null): string {
  if (from === null || to === null || from === 0) return '';
  return (Math.round(((to - from) / from) * 1000) / 10).toFixed(1);
}

/** Базисные пункты → проценты числом: 1250 → «12.5» */
const percentOfBp = (bp: number | null | undefined) => (bp === null || bp === undefined ? '' : (bp / 100).toFixed(bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2));

/** Канал словом, витрина словом, SKU и подпись предложения — как на экране */
function unitCells(unit: UnitRef | null, m: Messages): string[] {
  if (!unit) return ['', '', '', ''];
  return [(m.values as Record<string, string | undefined>)[unit.channel] ?? unit.channel, storefrontName(unit.channel, unit.marketplace, m), unit.externalUnitId, unit.label];
}

// ------------------------------------------------------------------------------------------------- строки экранов

/** Price changes, вид «отправленные цены» — строки ленты в её порядке */
export function feedExportRows(world: StandWorld, m: Messages, timeZone: string | null, items: readonly FeedPageItem[]): string[][] {
  return items.map((item) => {
    const i = feedItemOf(world, m, item);
    const w = item.write;
    const from = item.intentCurrentMinor ?? (item.decision ? explanationOf(world, item.decision)?.value.strategy.currentMinor ?? null : null);
    return [isoInZone(w.acceptedAt ?? w.dispatchedAt ?? w.createdAt, timeZone), w.channelWriteId, w.decisionId ?? '', ...unitCells(i.unit, m),
      amountText(from, w.currency), amountText(w.amountMinor, w.currency), w.currency, changePercent(from, w.amountMinor), w.status, i.source, i.reason?.text ?? ''];
  });
}

/** Price changes, вид «все решения» — строки списка решений в его порядке */
export function decisionExportRows(world: StandWorld, m: Messages, timeZone: string | null, decisions: readonly ConsoleDecisionRow[]): string[][] {
  const items = decisionItems(world, decisions, m);
  return decisions.map((d, k) => {
    const i = items[k]!;
    return [isoInZone(d.decidedAt, timeZone), d.decisionId, ...unitCells(i.unit, m), d.outcome, amountText(d.finalMinor ?? d.proposedMinor, d.currency), d.currency, i.reason];
  });
}

/** Строка отчёта Protections: раздел (удержание пола, отказ Gate за границей, прочие правила или остановка человеком), сырьё — из модели отчёта */
function protectionRow(m: Messages, timeZone: string | null, section: string, kind: string, unit: UnitRef | null, ref: ExportRef | undefined,
  reason: { code: string; text: string }, decisionId: string | null): string[] {
  const c = ref?.currency ?? null;
  return [isoInZone(ref?.at, timeZone), section, kind, decisionId ?? '', ...unitCells(unit, m), amountText(ref?.was, c), amountText(ref?.wanted, c),
    amountText(ref?.set, c), amountText(ref?.bound, c), c ?? '', percentOfBp(ref?.deviationBp), reason.code, reason.text];
}

/**
 * Protections — ровно то, что на вкладке: у «Prevented by rules» — удержания пола, отказы Gate за границей и прочие правила (список
 * с фильтром причины экрана), у «Stopped by people» — остановленное человеком. Повторы на экране свёрнуты в «×N» — в файле каждая строка
 */
export function protectionExportRows(m: Messages, timeZone: string | null, parts: {
  floorHolds?: readonly FloorHoldItem[]; dangerous?: readonly DangerousItem[]; rejected: readonly RejectedItem[];
}): string[][] {
  return [
    ...(parts.floorHolds ?? []).map((i) => protectionRow(m, timeZone, 'floor_hold', i.kind, i.unit, i.ref, i.reason, i.decisionId)),
    ...(parts.dangerous ?? []).map((i) => protectionRow(m, timeZone, 'beyond_bound', 'GATE', i.unit, i.ref, i.reason, i.decisionId)),
    ...parts.rejected.map((i) => protectionRow(m, timeZone, i.kind === 'STOP' ? 'stopped_by_people' : 'rule', i.kind, i.unit, i.ref, i.reason, i.decisionId)),
  ];
}

/**
 * Offers — строки списка предложений в его порядке; суммы — из предложения мира, пол — тем же расчётом, что колонка Floor. Шаг 105: с
 * колонками Buy Box (строки несут их) — и они: код держателя, продавец, цена числом, с доставкой ли, разрыв со знаком, доля в процентах,
 * момент снимка; пусто — значения нет (прочерк экрана), а не ноль
 */
export function offerExportRows(world: StandWorld, m: Messages, rows: readonly ProductRow[], options: { buybox?: boolean; timeZone?: string | null } = {}): string[][] {
  return rows.map((r) => {
    const scope = scopeById(world, r.unit.writeScopeId);
    const base = (() => {
      if (!scope) return [r.unit.writeScopeId, ...unitCells(r.unit, m), '', '', '', '', '', '', '', ''];
      const floor = effectiveFloor(scope, world);
      const c = scope.currency;
      const bound = (b: typeof scope.bounds.min) => (b.status === 'RESOLVED' ? amountText(b.amountMinor, c) : '');
      return [scope.writeScopeId, ...unitCells(r.unit, m), amountText(scope.currentPriceMinor, c), amountText(floor.minor, c), floor.source ?? '',
        bound(scope.bounds.min), bound(scope.bounds.max), c, scope.strategy ? strategyLabel(scope.strategy, c, m).label : '', scope.pricingMode];
    })();
    if (!options.buybox) return base;
    const b = r.buybox;
    if (!b) return [...base, '', '', '', '', '', '', ''];
    return [...base, b.holder.kind, b.seller ?? '', amountText(b.priceMinor, b.currency), b.priceLanded === null ? '' : b.priceLanded ? 'yes' : 'no',
      amountText(b.gapMinor, b.currency), amountText(b.shareBp, null), b.observedAt ? isoInZone(b.observedAt, options.timeZone ?? null) : ''];
  });
}

/**
 * Шаг 105 [Р-230]: конкуренты последнего снимка — по каждому предложению строки страницы Competition (первые 10 по цене с доставкой и
 * наша строка ниже десятой) в их порядке: место, продавец («You» — наша строка; не назван — пусто), держит ли Buy Box (канал не говорит —
 * пусто), цена с доставкой (доставка не названа — пусто), цена, доставка, исполнение FBA / FBM (канал не назвал — пусто)
 */
export function competitorExportRows(m: Messages, timeZone: string | null,
  items: ReadonlyArray<{ unit: UnitRef; snapshot: { snapshot: CompetitorSnapshot; observedAt: string } | null; holderNamed: boolean; state: 'OK' | 'NO_COMPETITOR_DATA' | 'NO_SNAPSHOT' }>): string[][] {
  return items.flatMap((x) => {
    if (x.state !== 'OK' || !x.snapshot) return [];
    return competitionRowOffers(orderedOffers(x.snapshot.snapshot)).map(({ offer: o, rank }) => {
      const k = fulfilmentKind(o.fulfillment);
      return [x.unit.writeScopeId, ...unitCells(x.unit, m), isoInZone(x.snapshot!.observedAt, timeZone), String(rank), o.isSelf ? 'You' : o.sellerRef ?? '',
        o.isSelf ? 'yes' : 'no', o.holdsBuyBox === true ? 'yes' : x.holderNamed ? 'no' : '', amountText(landedOf(o), o.price.currency), amountText(o.price.amountMinor, o.price.currency),
        o.shipping ? amountText(o.shipping.amountMinor, o.shipping.currency) : '', o.price.currency, k === 'CHANNEL' ? 'FBA' : k === 'MERCHANT' ? 'FBM' : ''];
    });
  });
}

/** Inventory — товары страницы остатков в её порядке; по каналу — витрины, посчитанное к публикации, отправленное и подтверждённое */
export function stockExportRows(m: Messages, items: readonly StockRow[]): string[][] {
  return items.map((r) => [
    r.productId, r.sku, r.title ?? '', r.gtin ?? '', String(r.onHand), String(r.reserved), String(r.available),
    String((r.channelManaged ?? []).reduce((sum, c) => sum + c.quantity, 0)),
    r.channels.map((c) => `${c.marketplaces.map((mk) => storefrontName(c.channel, mk, m)).join('+')}: published ${c.published}, sent ${c.sent?.quantity ?? '-'}, confirmed ${c.confirmed?.quantity ?? '-'}`).join('; '),
  ]);
}

/** Import history — строки журнала импортов вида в его порядке; кто — так же, как на экране */
export function importExportRows(world: StandWorld, m: Messages, timeZone: string | null, kind: ImportKind, runs: readonly ImportRunRow[]): string[][] {
  const view = importHistoryView(kind, runs, world, m);
  return runs.map((r, k) => [isoInZone(r.recordedAt, timeZone), r.runId, r.kind, r.outcome, r.reason ?? '', view.items[k]!.reason ?? '', r.fileName, r.fileSha256,
    String(r.rowsTotal), String(r.rowsChanged), String(r.rowsUnchanged), String(r.rowsRejected), String(secondsOf(r.durationMs)), view.items[k]!.who]);
}

/** Stop pricing — журнал аудита в его порядке; что и кто — теми же словами, что карточки журнала */
export function auditExportRows(world: StandWorld, m: Messages, timeZone: string | null, rows: readonly ConsoleAuditRow[]): string[][] {
  const cards = auditCards(world, rows, m);
  return rows.map((a, k) => {
    const c = cards[k]!;
    return [isoInZone(a.at, timeZone), a.entityId, a.action, c.action, c.actor, c.scope, c.note ?? '', c.detail ?? ''];
  });
}

// ------------------------------------------------------------------------------------------------- файл

/** Рабочее пространство в имени файла: строчными, через дефис, без знаков */
export function workspaceSlug(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return slug === '' ? 'workspace' : slug;
}

/** Имя файла: «<workspace>-<screen>-<period>» (расширение ставит исполнитель по виду содержимого [Р-145]) */
export function exportFileName(workspace: string, screen: ExportScreen, period: string): string {
  return `${workspaceSlug(workspace)}-${screen}-${period}`;
}

/** Что сказано в файле о выгрузке — лист «About this export» книги XLSX; английский, как заголовки */
export interface ExportAbout {
  workspace: string;
  screen: ExportScreen;
  /** Период экрана словами файла; null — состояние на момент выгрузки (Offers, Inventory) */
  period: { since: string | null; until: string | null } | null;
  filters: Readonly<Record<string, string>>;
  exportedBy: string;
  exportedAt: string;
  rows: number;
  timeZone: string | null;
}

export const EXPORT_ABOUT_SHEET = 'About this export';

export function exportAboutLines(a: ExportAbout): string[] {
  const filters = Object.entries(a.filters).filter(([, v]) => v !== '');
  const zone = a.timeZone && a.timeZone !== 'UTC' ? a.timeZone : 'UTC';
  return [
    EXPORT_ABOUT_SHEET,
    `Workspace: ${a.workspace}`,
    `Screen: ${EXPORT_SCREEN_TITLES[a.screen]}`,
    `Period: ${a.period ? `${a.period.since ? isoInZone(a.period.since, a.timeZone) : 'since the start of what is kept'} – ${a.period.until ? isoInZone(a.period.until, a.timeZone) : isoInZone(a.exportedAt, a.timeZone)}` : 'current state at the time of export'}`,
    `Filters: ${filters.length === 0 ? 'none' : filters.map(([k, v]) => `${k} = ${v}`).join('; ')}`,
    `Exported by: ${a.exportedBy}`,
    `Exported at: ${isoInZone(a.exportedAt, a.timeZone)}`,
    `Rows: ${a.rows}`,
    `Column headers are always in English. Times are ISO 8601 in the workspace time zone (${zone}). Amounts are numbers with a decimal point and a separate currency column. Status codes are in English; reason texts are in the workspace language.`,
  ];
}
