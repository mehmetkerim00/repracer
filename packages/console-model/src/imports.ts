import { currencyInCell, parseFeeRateBp, parseMoneyMinor, TABLE_ENCODINGS, type Sheet } from '@repracer/cost-import';
import type { ImportKind, ImportRunRow } from '@repracer/pricing-pipeline/store';
import { storefrontPriceForMarginBp, type StrategyDefinition } from '@repracer/pricing-model';
import { costInScopeCurrency } from './bounds.ts';
import { channelPricingBlocks } from './channel-bounds.ts';
import type { PageInfo } from './page.ts';
import type { Messages } from './i18n/index.ts';
import { fingerprint } from './strategies.ts';
import { channelOf, storefrontName, unitOf, type ConsoleScope, type StandWorld, type Tone } from './world.ts';

/**
 * Шаг 99 [Р-224, Р-225]: четыре импорта продавца — себестоимость, остатки, границы, стратегии — одним путём.
 *
 * 1. **Шаблон.** Файл с текущими значениями каталога: первая строка — заголовки по-английски (их знает разбор), вторая — пример,
 *    закомментированный «#», дальше — пояснение на языке пространства и строки каталога. Продавец правит, а не составляет с нуля.
 * 2. **Примерка.** Сервер разбирает файл и сравнивает каждую строку с текущими данными: сколько строк изменится, сколько без
 *    изменений и какие с ошибкой — номер строки в файле и причина. Пустая ячейка значения — «не менять».
 * 3. **Применение ровно примерки.** Отпечаток примерки (`token`) держит ВСЁ, что она показала: строки к изменению с прежними и новыми
 *    значениями, ошибки, число строк без изменений. Применение считает примерку заново по текущим данным и отказывает, если отпечаток
 *    другой; файл с ошибочными строками не применяется вовсе — частично-молчаливых применений не бывает.
 *
 * Здесь нет ни базы, ни файлов: только разбор строк уже прочитанной таблицы, сравнение с миром и слова для экрана.
 */

export type { ImportKind } from '@repracer/pricing-pipeline/store';
export const IMPORT_KIND_LIST: readonly ImportKind[] = ['COSTS', 'STOCK', 'BOUNDS', 'STRATEGY'];

export type ImportFieldName =
  | 'sku' | 'storefront' | 'title' | 'unit_cost' | 'currency' | 'fee_percent' | 'fixed_fee' | 'quantity' | 'min_price' | 'max_price'
  | 'min_margin_percent' | 'strategy';

interface FieldSpec {
  field: ImportFieldName;
  /** key — чем продавец называет предложение или товар; storefront — уточнение витрины; info — для ориентира, не читается; value — значение */
  role: 'key' | 'storefront' | 'info' | 'value';
  synonyms: readonly string[];
}

const SKU: FieldSpec = {
  field: 'sku', role: 'key',
  synonyms: ['sku', 'seller sku', 'merchant sku', 'item sku', 'артикул', 'артикул товара', 'artikelnummer', 'artikel', 'ean', 'gtin', 'upc', 'asin',
    'item id', 'offer id', 'id offer', 'id unit', 'unit', 'código', 'référence', 'reference'],
};
const STOREFRONT: FieldSpec = { field: 'storefront', role: 'storefront', synonyms: ['storefront', 'marketplace', 'site', 'витрина', 'marktplatz', 'tienda', 'boutique'] };
const TITLE: FieldSpec = { field: 'title', role: 'info', synonyms: ['title', 'name', 'product', 'product name', 'название', 'titel', 'título', 'titre'] };
const CURRENCY: FieldSpec = { field: 'currency', role: 'value', synonyms: ['currency', 'валюта', 'währung', 'waehrung', 'moneda', 'devise', 'ccy'] };

/** Колонки каждого импорта — в порядке шаблона. Заголовок шаблона — имя поля; синонимы — для чужих выгрузок */
export const IMPORT_SCHEMAS: Readonly<Record<ImportKind, readonly FieldSpec[]>> = {
  COSTS: [
    SKU, STOREFRONT, TITLE,
    { field: 'unit_cost', role: 'value', synonyms: ['unit cost', 'cost', 'cost price', 'purchase price', 'buying price', 'себестоимость', 'einstandspreis', 'einkaufspreis', 'kosten', 'costo', 'coût', 'cout'] },
    CURRENCY,
    { field: 'fee_percent', role: 'value', synonyms: ['fee percent', 'fee %', 'fee', 'commission', 'commission %', 'комиссия', 'provision', 'gebühr', 'comisión', 'commission %'] },
    { field: 'fixed_fee', role: 'value', synonyms: ['fixed fee', 'fee fixed', 'фиксированная комиссия', 'fixkosten', 'tarifa fija', 'frais fixes'] },
  ],
  STOCK: [
    SKU, TITLE,
    { field: 'quantity', role: 'value', synonyms: ['quantity', 'qty', 'stock', 'on hand', 'available', 'количество', 'остаток', 'menge', 'bestand', 'cantidad', 'quantité', 'quantite'] },
  ],
  BOUNDS: [
    SKU, STOREFRONT, TITLE, CURRENCY,
    { field: 'min_price', role: 'value', synonyms: ['min price', 'minimum price', 'floor', 'min', 'мин цена', 'mindestpreis', 'precio mínimo', 'prix minimum'] },
    { field: 'max_price', role: 'value', synonyms: ['max price', 'maximum price', 'ceiling', 'max', 'макс цена', 'höchstpreis', 'precio máximo', 'prix maximum'] },
    { field: 'min_margin_percent', role: 'value', synonyms: ['min margin percent', 'min margin %', 'min margin', 'minimum margin', 'margin %', 'мин маржа', 'mindestmarge', 'margen mínimo', 'marge minimale'] },
  ],
  STRATEGY: [
    SKU, STOREFRONT, TITLE,
    { field: 'strategy', role: 'value', synonyms: ['strategy', 'strategy name', 'стратегия', 'strategie', 'estrategia', 'stratégie'] },
  ],
};

/** Ключ на предложение — у себестоимости, границ и стратегий; у остатков — товар (пул общий для всех каналов, Р-6) */
export const importTargetsOffers = (kind: ImportKind) => kind !== 'STOCK';

export type ImportMapping = Partial<Record<ImportFieldName, number>>;

const normalize = (header: string) => header.trim().toLowerCase().replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').replace(/[()[\]]/g, '');
const fieldHeader = (field: ImportFieldName) => normalize(field);

/**
 * Колонки файла по заголовкам: сначала точное совпадение с именем поля или синонимом, затем — заголовок, содержащий синоним. Одна
 * колонка — одному полю. Выбор продавца сильнее подсказки, а `null` в нём — «этой колонки в файле нет» [Р-134, OQ-200]
 */
export function importMapping(kind: ImportKind, sheet: Pick<Sheet, 'rows'>, chosen?: Readonly<Record<string, unknown>> | null): ImportMapping {
  const headers = (sheet.rows[0] ?? []).map((h) => normalize(String(h)));
  const mapping: ImportMapping = {};
  const taken = new Set<number>();
  const take = (field: ImportFieldName, index: number) => {
    if (index < 0 || taken.has(index) || mapping[field] !== undefined) return;
    taken.add(index);
    mapping[field] = index;
  };
  const specs = IMPORT_SCHEMAS[kind];
  for (const spec of specs) take(spec.field, headers.findIndex((h) => h === fieldHeader(spec.field) || spec.synonyms.includes(h)));
  for (const spec of specs) take(spec.field, headers.findIndex((h, i) => !taken.has(i) && h !== '' && spec.synonyms.some((s) => s.length > 2 && h.includes(s))));
  for (const [field, index] of Object.entries(chosen ?? {})) {
    if (!specs.some((s) => s.field === field)) continue;
    if (index === null) delete mapping[field as ImportFieldName];
    else if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) mapping[field as ImportFieldName] = index;
  }
  return mapping;
}

/** Чего не хватает, чтобы примерка вообще была возможна: ключа и хотя бы одной колонки значения */
export function missingImportColumns(kind: ImportKind, mapping: ImportMapping): ImportFieldName[] {
  const specs = IMPORT_SCHEMAS[kind];
  const missing: ImportFieldName[] = [];
  if (mapping.sku === undefined) missing.push('sku');
  const values = specs.filter((s) => s.role === 'value' && s.field !== 'currency');
  if (!values.some((s) => mapping[s.field] !== undefined)) missing.push(...values.map((s) => s.field));
  return missing;
}

/**
 * Строки с данными: без заголовка, без пустых и без строк-комментариев — первая непустая ячейка начинается с «#» (пример и пояснение
 * шаблона). Номер строки — как в файле продавца (`sheet.lines`): по нему он ищет строку в своей таблице
 */
export function importDataRows(sheet: Pick<Sheet, 'rows' | 'lines'>): Array<{ line: number; cells: readonly string[] }> {
  const out: Array<{ line: number; cells: readonly string[] }> = [];
  sheet.rows.forEach((row, i) => {
    if (i === 0) return;
    const first = row.find((c) => String(c ?? '').trim() !== '');
    if (first === undefined || String(first).trim().startsWith('#')) return;
    out.push({ line: sheet.lines[i] ?? i + 1, cells: row });
  });
  return out;
}

/**
 * Ячейка как её написал продавец. Апостроф перед «= + - @» снимается: так значение экранирует выгрузка CSV, чтобы таблица не приняла
 * его за формулу (exports.ts), — и шаблон, скачанный и загруженный обратно, читается тем же значением
 */
const cellOf = (cells: readonly string[], index: number | undefined): string => {
  if (index === undefined) return '';
  const raw = String(cells[index] ?? '').trim();
  return /^'[=+\-@]/.test(raw) ? raw.slice(1) : raw;
};

export type ImportProblem =
  | 'KEY_EMPTY' | 'NOT_FOUND' | 'AMBIGUOUS' | 'STOREFRONT_NOT_FOUND' | 'DUPLICATE'
  | 'NOT_A_NUMBER' | 'AMBIGUOUS_SEPARATOR' | 'NEGATIVE' | 'TOO_LARGE' | 'NOT_POSITIVE'
  | 'CURRENCY_UNSUPPORTED' | 'CURRENCY_NOT_OF_OFFER' | 'PERCENT_OUT_OF_RANGE' | 'PERCENT_AMBIGUOUS' | 'QUANTITY_INVALID' | 'COST_MISSING'
  | 'MIN_ABOVE_MAX' | 'MARGIN_HELD_WIDER' | 'MARGIN_FLOOR_ABOVE_MAX' | 'BOUND_HELD_ELSEWHERE'
  | 'STRATEGY_NOT_FOUND' | 'STRATEGY_AMBIGUOUS' | 'STRATEGY_NOT_ACTIVE' | 'STRATEGY_UNAVAILABLE' | 'CHANNEL_PRICING';

export interface ImportRowError {
  line: number;
  key: string;
  problem: ImportProblem;
  /** Колонка, в которой ошибка (если она одна) */
  field?: ImportFieldName;
  raw?: string;
  /** Суммы и проценты для текста причины — без перевода: слова ставит вид экрана */
  params?: Record<string, number | string>;
}

/** Строка, которая изменит данные: что поставить (`set`) и что было на примерке (`expected`) — по ним применение сверяет базу */
export interface ImportPlanRow {
  line: number;
  key: string;
  /** Предложение (`writeScopeId`) или товар (`productId`) у остатков */
  target: string;
  set: Record<string, number | string>;
  expected: Record<string, unknown>;
  /** Что видит продавец: поле, было, стало — в денежных единицах и процентах, уже словами не переводится */
  changes: Array<{ field: ImportFieldName; from: number | string | null; to: number | string }>;
}

export interface ImportPlan {
  kind: ImportKind;
  rowsTotal: number;
  changed: ImportPlanRow[];
  unchanged: number;
  /** Все цели строк без ошибки — изменившиеся и нет: остатки пересчитываются по ним (повтор после падения, хаос шага 97.2) */
  matchedTargets: string[];
  errors: ImportRowError[];
  /** Колонок не хватает — примерка невозможна, применять нечего */
  missingColumns: ImportFieldName[];
  /** Отпечаток примерки: применение считает её заново и сравнивает */
  token: string;
}

/** Товар глазами импорта остатков — как отдаёт хранилище остатков (`stockImportTargets`) */
export interface StockTarget {
  productId: string;
  sku: string | null;
  title: string | null;
  keys: readonly string[];
  onHand: number | null;
}

/**
 * Что примерке нужно сверх мира: товары с остатком (импорт остатков) и доступность стратегии каналу предложения [Р-39] — её знает
 * сервер по описанию канала, а модель экранов описаний каналов не видит
 */
export interface ImportPlanContext {
  stockTargets?: readonly StockTarget[];
  strategyAvailable?(scope: ConsoleScope, params: StrategyDefinition['params']): { available: true } | { available: false; unmet: Record<string, string[]> };
}

const keyOf = (value: string) => value.trim().toLowerCase();
const money = (minor: number) => (minor / 100).toFixed(2);
const percent = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;

/** Деньги: «7.50», «7,50», «$7.50» — как у импорта себестоимости; валюта в ячейке сверяется с валютой предложения [Р-138] */
function moneyCell(raw: string, currency: string, positive: boolean): { ok: true; minor: number } | { ok: false; problem: ImportProblem } {
  const named = currencyInCell(raw);
  if (named !== null && named !== currency) return { ok: false, problem: 'CURRENCY_NOT_OF_OFFER' };
  const parsed = parseMoneyMinor(raw);
  if (!parsed.ok) {
    return { ok: false, problem: parsed.problem === 'COST_AMBIGUOUS_SEPARATOR' ? 'AMBIGUOUS_SEPARATOR' : parsed.problem === 'COST_NEGATIVE' ? 'NEGATIVE' : parsed.problem === 'COST_TOO_LARGE' ? 'TOO_LARGE' : 'NOT_A_NUMBER' };
  }
  if (positive && parsed.minor <= 0) return { ok: false, problem: 'NOT_POSITIVE' };
  return { ok: true, minor: parsed.minor };
}

/** Проценты: «15», «15%», «15,5 %»; меньше одного процента — только со знаком: «0.15» — это 15 % или 0,15 % (ревью шага 28) */
function percentCell(raw: string): { ok: true; bp: number } | { ok: false; problem: ImportProblem } {
  const parsed = parseFeeRateBp(raw);
  if (parsed.ok) return parsed;
  return { ok: false, problem: parsed.problem === 'FEE_AMBIGUOUS_FRACTION' ? 'PERCENT_AMBIGUOUS' : parsed.problem === 'FEE_RATE_OUT_OF_RANGE' ? 'PERCENT_OUT_OF_RANGE' : 'NOT_A_NUMBER' };
}

/** Количество — целое число штук без знаков и дробей; разделитель тысяч допускается пробелом */
function quantityCell(raw: string): { ok: true; n: number } | { ok: false } {
  const text = raw.replace(/[\s ]/g, '');
  if (!/^\d{1,7}$/.test(text)) return { ok: false };
  return { ok: true, n: Number(text) };
}

/** Название стратегии для поиска: без регистра и лишних пробелов */
const strategyKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, ' ');

/** Действующие стратегии мира: последняя версия каждой, её имя и статус */
export function strategiesByName(world: StandWorld): Map<string, Array<{ strategyId: string; version: number; name: string; active: boolean; definition: StrategyDefinition }>> {
  const latest = new Map<string, StrategyDefinition>();
  for (const d of [...world.state.strategies, ...world.state.scopes.flatMap((s) => (s.strategy ? [s.strategy] : []))]) {
    const known = latest.get(d.strategyId);
    if (!known || d.version > known.version) latest.set(d.strategyId, d);
  }
  const out = new Map<string, Array<{ strategyId: string; version: number; name: string; active: boolean; definition: StrategyDefinition }>>();
  for (const d of latest.values()) {
    const versions = world.state.strategyVersions.filter((x) => x.strategyId === d.strategyId);
    const meta = versions.find((x) => x.version === d.version);
    const name = meta?.name ?? versions.at(-1)?.name ?? d.strategyId;
    const list = out.get(strategyKey(name)) ?? [];
    list.push({ strategyId: d.strategyId, version: d.version, name, active: (meta?.status ?? 'ACTIVE') === 'ACTIVE', definition: d });
    out.set(strategyKey(name), list);
  }
  return out;
}

/** Имя стратегии предложения так, как его пишет шаблон и узнаёт разбор */
function strategyNameOf(world: StandWorld, scope: ConsoleScope): string {
  if (!scope.strategy) return '';
  const versions = world.state.strategyVersions.filter((x) => x.strategyId === scope.strategy!.strategyId);
  return versions.find((x) => x.version === scope.strategy!.version)?.name ?? versions.at(-1)?.name ?? scope.strategy.strategyId;
}

/** Комиссия, объявленная продавцом, — оценка `SELLER_DECLARED` [Р-138]; тарифная таблица канала — не его число, и шаблон её не показывает */
function sellerFeeOf(scope: ConsoleScope): { feeRateBp: number | null; fixedFeeMinor: number | null } | null {
  const own = (scope.feeEstimates ?? []).find((f) => f.source === 'SELLER_DECLARED');
  return own ? { feeRateBp: own.feeRateBp, fixedFeeMinor: own.fixedFeeMinor } : null;
}

const boundOf = (b: ConsoleScope['bounds']['min']) => (b.status === 'RESOLVED' ? b.amountMinor : null);

/** Чем строка файла может назвать витрину предложения: словами экрана, кодом витрины, именем канала */
function storefrontKeys(world: StandWorld, scope: ConsoleScope, m: Messages): string[] {
  const channel = channelOf(world, scope.channelAccountId);
  return [storefrontName(channel, scope.marketplace, m), scope.marketplace, `${channel} ${scope.marketplace}`].map(keyOf);
}

/**
 * Примерка: файл против текущих данных. Ошибки — по строкам с причиной; строка с ошибкой не применяется, и файл с ошибками — тоже
 * (это решает применение, не примерка). Пустая ячейка значения — «не менять»; строка без единого изменения — «без изменений»
 */
export function buildImportPlan(kind: ImportKind, sheet: Pick<Sheet, 'rows' | 'lines'>, mapping: ImportMapping, world: StandWorld, m: Messages,
  context: ImportPlanContext = {}): ImportPlan {
  const rows = importDataRows(sheet);
  const missingColumns = missingImportColumns(kind, mapping);
  if (missingColumns.length > 0) {
    const plan = { kind, rowsTotal: rows.length, changed: [], unchanged: 0, matchedTargets: [], missingColumns,
      errors: [] as ImportRowError[] };
    return { ...plan, token: fingerprint(['MISSING', kind, missingColumns, rows.length]) };
  }
  const errors: ImportRowError[] = [];
  const candidates: Array<{ line: number; key: string; target: string; row: ImportPlanRow | null }> = [];
  const cell = (cells: readonly string[], field: ImportFieldName) => cellOf(cells, mapping[field]);

  // Цели: предложения по ключам (у остатков — товары)
  const offerIndex = new Map<string, ConsoleScope[]>();
  if (importTargetsOffers(kind)) {
    for (const s of world.state.scopes) {
      for (const k of [s.sku, s.externalUnitId, s.channelProductRef, s.gtin]) {
        if (typeof k !== 'string' || k.trim() === '') continue;
        const list = offerIndex.get(keyOf(k)) ?? [];
        if (!list.includes(s)) list.push(s);
        offerIndex.set(keyOf(k), list);
      }
    }
  }
  const productIndex = new Map<string, StockTarget[]>();
  for (const t of context.stockTargets ?? []) {
    for (const k of t.keys) {
      const list = productIndex.get(keyOf(k)) ?? [];
      if (!list.includes(t)) list.push(t);
      productIndex.set(keyOf(k), list);
    }
  }
  const strategies = kind === 'STRATEGY' ? strategiesByName(world) : new Map();

  for (const { line, cells } of rows) {
    const key = cell(cells, 'sku');
    const fail = (problem: ImportProblem, extra: Partial<ImportRowError> = {}) => errors.push({ line, key, problem, ...extra });
    if (key === '') { fail('KEY_EMPTY', { field: 'sku' }); continue; }

    if (kind === 'STOCK') {
      const found = productIndex.get(keyOf(key)) ?? [];
      if (found.length === 0) { fail('NOT_FOUND', { field: 'sku', raw: key }); continue; }
      if (found.length > 1) { fail('AMBIGUOUS', { field: 'sku', raw: key }); continue; }
      const t = found[0]!;
      const raw = cell(cells, 'quantity');
      if (raw === '') { candidates.push({ line, key, target: t.productId, row: null }); continue; }
      const q = quantityCell(raw);
      if (!q.ok) { fail('QUANTITY_INVALID', { field: 'quantity', raw }); continue; }
      const now = t.onHand ?? 0;
      candidates.push({
        line, key, target: t.productId,
        row: q.n === now ? null : { line, key, target: t.productId, set: { quantity: q.n }, expected: { onHand: t.onHand }, changes: [{ field: 'quantity', from: t.onHand, to: q.n }] },
      });
      continue;
    }

    // Предложение: ключ и, если ключ общий у нескольких витрин, — витрина
    let found = offerIndex.get(keyOf(key)) ?? [];
    if (found.length === 0) { fail('NOT_FOUND', { field: 'sku', raw: key }); continue; }
    const storefront = cell(cells, 'storefront');
    if (storefront !== '') {
      found = found.filter((s) => storefrontKeys(world, s, m).includes(keyOf(storefront)));
      if (found.length === 0) { fail('STOREFRONT_NOT_FOUND', { field: 'storefront', raw: storefront }); continue; }
    }
    if (found.length > 1) { fail('AMBIGUOUS', { field: 'sku', raw: key }); continue; }
    const scope = found[0]!;
    const currencyRaw = cell(cells, 'currency').toUpperCase();

    if (kind === 'COSTS') {
      const declared = scope.declaredCost ?? null;
      const sellerFee = sellerFeeOf(scope);
      const set: Record<string, number | string> = {};
      const changes: ImportPlanRow['changes'] = [];
      const costRaw = cell(cells, 'unit_cost');
      // Валюта строки: названа в файле — та и есть; иначе валюта нынешней себестоимости, а без неё — валюта предложения
      const currency = currencyRaw !== '' ? currencyRaw : declared?.currency ?? scope.currency;
      if (!/^(EUR|USD)$/.test(currency)) { fail('CURRENCY_UNSUPPORTED', { field: 'currency', raw: currencyRaw }); continue; }
      let bad = false;
      if (costRaw !== '') {
        const named = currencyInCell(costRaw);
        const parsed = moneyCell(costRaw, named ?? currency, false);
        if (!parsed.ok) { fail(parsed.problem, { field: 'unit_cost', raw: costRaw }); continue; }
        const costCurrency = named ?? currency;
        const same = declared !== null && declared.unitCostMinor === parsed.minor && declared.currency === costCurrency;
        if (!same) {
          // Импорт не переводит валюты [Р-138]: себестоимость пишется в валюте предложения
          if (costCurrency !== scope.currency) { fail('CURRENCY_NOT_OF_OFFER', { field: 'currency', raw: currencyRaw || costCurrency }); continue; }
          set.unitCostMinor = parsed.minor;
          changes.push({ field: 'unit_cost', from: declared && declared.currency === scope.currency ? declared.unitCostMinor : null, to: parsed.minor });
        }
      }
      for (const field of ['fee_percent', 'fixed_fee'] as const) {
        const raw = cell(cells, field);
        if (raw === '') continue;
        const parsed = field === 'fee_percent' ? percentCell(raw) : moneyCell(raw, scope.currency, false);
        if (!parsed.ok) { fail(parsed.problem, { field, raw }); bad = true; break; }
        const value = 'bp' in parsed ? parsed.bp : parsed.minor;
        const current = field === 'fee_percent' ? sellerFee?.feeRateBp ?? null : sellerFee?.fixedFeeMinor ?? null;
        if (current !== value) {
          set[field === 'fee_percent' ? 'feeRateBp' : 'fixedFeeMinor'] = value;
          changes.push({ field, from: current, to: value });
        }
      }
      if (bad) continue;
      // Комиссия без себестоимости ничего не даёт: пол маржи без себестоимости не считается [Р-131]
      if (set.unitCostMinor === undefined && changes.length > 0 && declared === null) { fail('COST_MISSING', { field: 'unit_cost' }); continue; }
      // Строке только с комиссией себестоимость не нужна — но её валюта та же, что у предложения (база сверяет)
      candidates.push({
        line, key, target: scope.writeScopeId,
        row: changes.length === 0 ? null : {
          line, key, target: scope.writeScopeId, set: { ...set, currency: scope.currency },
          expected: { costProfileId: declared?.costProfileId ?? null, sellerFee }, changes,
        },
      });
      continue;
    }

    if (kind === 'BOUNDS') {
      if (currencyRaw !== '' && currencyRaw !== scope.currency) { fail('CURRENCY_NOT_OF_OFFER', { field: 'currency', raw: currencyRaw }); continue; }
      const nowMin = boundOf(scope.bounds.min);
      const nowMax = boundOf(scope.bounds.max);
      const nowMargin = scope.minMarginBp;
      const set: Record<string, number> = {};
      const changes: ImportPlanRow['changes'] = [];
      let bad = false;
      for (const field of ['min_price', 'max_price'] as const) {
        const raw = cell(cells, field);
        if (raw === '') continue;
        const parsed = moneyCell(raw, scope.currency, true);
        if (!parsed.ok) { fail(parsed.problem, { field, raw }); bad = true; break; }
        const current = field === 'min_price' ? nowMin : nowMax;
        if (current !== parsed.minor) {
          set[field === 'min_price' ? 'minMinor' : 'maxMinor'] = parsed.minor;
          changes.push({ field, from: current, to: parsed.minor });
        }
      }
      if (bad) continue;
      const marginRaw = cell(cells, 'min_margin_percent');
      if (marginRaw !== '') {
        const parsed = percentCell(marginRaw);
        if (!parsed.ok) { fail(parsed.problem, { field: 'min_margin_percent', raw: marginRaw }); continue; }
        if (parsed.bp !== nowMargin) {
          // Действует наибольшая из маржей уровней [Gate]: своя ниже более широкой ничего не меняет — и продавцу это говорится
          const wider = scope.widerMinMarginBp ?? null;
          if (wider !== null && parsed.bp < wider) { fail('MARGIN_HELD_WIDER', { field: 'min_margin_percent', raw: marginRaw, params: { widerBp: wider } }); continue; }
          set.minMarginBp = parsed.bp;
          changes.push({ field: 'min_margin_percent', from: nowMargin, to: parsed.bp });
        }
      }
      const newMin = set.minMinor ?? nowMin;
      const newMax = set.maxMinor ?? nowMax;
      if (changes.length > 0 && newMin !== null && newMax !== null && newMin > newMax) {
        fail('MIN_ABOVE_MAX', { field: set.minMinor !== undefined ? 'min_price' : 'max_price', params: { minMinor: newMin, maxMinor: newMax, currency: scope.currency } });
        continue;
      }
      // Пол маржи выше потолка — Gate отклонит любую цену: продавец узнаёт это строкой, а не тишиной на витрине
      if (changes.length > 0 && newMax !== null && (set.minMarginBp !== undefined || set.maxMinor !== undefined)) {
        const margin = set.minMarginBp ?? nowMargin;
        const converted = margin === null ? null : costInScopeCurrency(scope, world);
        if (margin !== null && converted && 'cost' in converted) {
          const priced = storefrontPriceForMarginBp(converted.cost, Math.max(margin, scope.widerMinMarginBp ?? 0));
          if (priced.ok && priced.priceMinor > newMax) {
            fail('MARGIN_FLOOR_ABOVE_MAX', { field: set.minMarginBp !== undefined ? 'min_margin_percent' : 'max_price', params: { floorMinor: priced.priceMinor, maxMinor: newMax, currency: scope.currency } });
            continue;
          }
        }
      }
      candidates.push({
        line, key, target: scope.writeScopeId,
        row: changes.length === 0 ? null : {
          line, key, target: scope.writeScopeId, set, expected: { minMinor: nowMin, maxMinor: nowMax, minMarginBp: nowMargin }, changes,
        },
      });
      continue;
    }

    // STRATEGY
    const name = cell(cells, 'strategy');
    if (name === '') { candidates.push({ line, key, target: scope.writeScopeId, row: null }); continue; }
    const named = strategies.get(strategyKey(name)) ?? [];
    if (named.length === 0) { fail('STRATEGY_NOT_FOUND', { field: 'strategy', raw: name }); continue; }
    if (named.length > 1) { fail('STRATEGY_AMBIGUOUS', { field: 'strategy', raw: name }); continue; }
    const chosen = named[0]!;
    const nowStrategy = scope.strategy;
    if (nowStrategy && nowStrategy.strategyId === chosen.strategyId && nowStrategy.version === chosen.version) {
      candidates.push({ line, key, target: scope.writeScopeId, row: null });
      continue;
    }
    if (!chosen.active) { fail('STRATEGY_NOT_ACTIVE', { field: 'strategy', raw: name }); continue; }
    // Р-120: у предложения своё ценообразование канала — стратегию не назначит база (0082)
    const owned = world.state.offerChannelPricing.find((o) => o.channelAccountId === scope.channelAccountId && o.marketplace === scope.marketplace && o.externalSku === scope.externalUnitId);
    if (owned && channelPricingBlocks(owned, scope.currency)) { fail('CHANNEL_PRICING', { field: 'strategy', raw: name }); continue; }
    // Р-39: канал не даёт нужных этой стратегии данных конкурентов — та же проверка, что у предпросмотра стратегии
    const availability = context.strategyAvailable?.(scope, chosen.definition.params);
    if (availability && !availability.available) {
      fail('STRATEGY_UNAVAILABLE', { field: 'strategy', raw: name, params: { unmet: JSON.stringify(availability.unmet) } });
      continue;
    }
    candidates.push({
      line, key, target: scope.writeScopeId,
      row: {
        line, key, target: scope.writeScopeId, set: { strategyId: chosen.strategyId, version: chosen.version },
        expected: { strategyId: nowStrategy?.strategyId ?? null, version: nowStrategy?.version ?? null },
        changes: [{ field: 'strategy', from: nowStrategy ? strategyNameOf(world, scope) : null, to: chosen.name }],
      },
    });
  }

  // Одна цель дважды: какая строка верная, знает только продавец — ошибка у обеих
  const seen = new Map<string, number>();
  for (const c of candidates) seen.set(c.target, (seen.get(c.target) ?? 0) + 1);
  const changed: ImportPlanRow[] = [];
  const matchedTargets: string[] = [];
  let unchanged = 0;
  for (const c of candidates) {
    if ((seen.get(c.target) ?? 0) > 1) { errors.push({ line: c.line, key: c.key, problem: 'DUPLICATE', field: 'sku', raw: c.key }); continue; }
    matchedTargets.push(c.target);
    if (c.row) changed.push(c.row);
    else unchanged += 1;
  }
  errors.sort((a, b) => a.line - b.line);
  const token = fingerprint([kind, rows.length, unchanged, changed.map((r) => [r.target, r.set, r.expected]), errors.map((e) => [e.line, e.problem, e.field ?? null])]);
  return { kind, rowsTotal: rows.length, changed, unchanged, matchedTargets, errors, missingColumns: [], token };
}

/**
 * Импорт границ: граница уровня предложения может ничего не изменить — у товара своя граница, и действует наибольший пол и наименьший
 * потолок. Что получится на деле, считает база без записи (`editBounds` в режиме PREVIEW); строка, у которой действующая граница не
 * станет той, что в файле, — ошибка с причиной, а не тихое «применено». Отпечаток пересчитывается: уточнённая примерка — это и есть
 * то, что видит продавец
 */
export function refineBoundsPlan(plan: ImportPlan, after: ReadonlyMap<string, { minMinor: number | null; maxMinor: number | null }>): ImportPlan {
  if (plan.kind !== 'BOUNDS' || plan.missingColumns.length > 0) return plan;
  const errors = [...plan.errors];
  const changed: ImportPlanRow[] = [];
  for (const r of plan.changed) {
    const a = after.get(r.target);
    const held = a !== undefined && ((r.set.minMinor !== undefined && a.minMinor !== r.set.minMinor) || (r.set.maxMinor !== undefined && a.maxMinor !== r.set.maxMinor));
    if (held) errors.push({ line: r.line, key: r.key, problem: 'BOUND_HELD_ELSEWHERE', field: r.set.minMinor !== undefined && a!.minMinor !== r.set.minMinor ? 'min_price' : 'max_price' });
    else changed.push(r);
  }
  errors.sort((x, y) => x.line - y.line);
  const held = new Set(plan.changed.filter((r) => !changed.includes(r)).map((r) => r.target));
  const token = fingerprint([plan.kind, plan.rowsTotal, plan.unchanged, changed.map((r) => [r.target, r.set, r.expected]), errors.map((e) => [e.line, e.problem, e.field ?? null])]);
  return { ...plan, changed, errors, matchedTargets: plan.matchedTargets.filter((t) => !held.has(t)), token };
}

// ------------------------------------------------------------------------------------------------------------------- шаблон

export interface ImportTemplate {
  fileName: string;
  header: string[];
  /** Вторая строка — пример, закомментированный «#» в первой ячейке */
  example: string[];
  /** Пояснение на языке пространства: в CSV — строками «#», в XLSX — листом справки */
  notes: string[];
  rows: string[][];
}

/** Имя файла шаблона — латиницей во всех языках: исполнитель приводит имя к безопасному виду, и не латиница стала бы подчёркиваниями */
export const IMPORT_FILE_NAMES: Readonly<Record<ImportKind, string>> = { COSTS: 'unit-costs', STOCK: 'stock', BOUNDS: 'min-max-prices', STRATEGY: 'strategies' };

/** Шаблон каждого импорта, заполненный текущими значениями каталога: продавец правит то, что есть */
export function importTemplate(kind: ImportKind, world: StandWorld, m: Messages, context: ImportPlanContext = {}): ImportTemplate {
  const t = m.ui.imports;
  const header = IMPORT_SCHEMAS[kind].map((s) => s.field);
  const storefrontOf = (s: ConsoleScope) => storefrontName(channelOf(world, s.channelAccountId), s.marketplace, m);
  const keyOfScope = (s: ConsoleScope) => s.sku ?? s.externalUnitId;
  let rows: string[][];
  let example: string[];
  switch (kind) {
    case 'COSTS':
      rows = world.state.scopes.map((s) => {
        const fee = sellerFeeOf(s);
        return [keyOfScope(s), storefrontOf(s), s.title ?? '', s.declaredCost ? money(s.declaredCost.unitCostMinor) : '', s.declaredCost?.currency ?? s.currency,
          fee?.feeRateBp !== null && fee?.feeRateBp !== undefined ? percent(fee.feeRateBp) : '', fee?.fixedFeeMinor !== null && fee?.fixedFeeMinor !== undefined ? money(fee.fixedFeeMinor) : ''];
      });
      example = [`# ${t.exampleKey}`, 'amazon.com', t.exampleTitle, '7.50', 'USD', '15%', '0.30'];
      break;
    case 'STOCK':
      rows = (context.stockTargets ?? []).map((p) => [p.sku ?? p.keys[0] ?? '', p.title ?? '', p.onHand === null ? '' : String(p.onHand)]);
      example = [`# ${t.exampleKey}`, t.exampleTitle, '12'];
      break;
    case 'BOUNDS':
      rows = world.state.scopes.map((s) => {
        const min = boundOf(s.bounds.min);
        const max = boundOf(s.bounds.max);
        return [keyOfScope(s), storefrontOf(s), s.title ?? '', s.currency, min === null ? '' : money(min), max === null ? '' : money(max), s.minMarginBp === null ? '' : percent(s.minMarginBp)];
      });
      example = [`# ${t.exampleKey}`, 'amazon.com', t.exampleTitle, 'USD', '14.00', '50.00', '12%'];
      break;
    case 'STRATEGY':
      rows = world.state.scopes.map((s) => [keyOfScope(s), storefrontOf(s), s.title ?? '', strategyNameOf(world, s)]);
      example = [`# ${t.exampleKey}`, 'amazon.com', t.exampleTitle, t.exampleStrategy];
      break;
  }
  return { fileName: `${IMPORT_FILE_NAMES[kind]}-template`, header, example, notes: t.notes[kind], rows };
}

// ------------------------------------------------------------------------------------------------------------------- экран

export interface ImportCheckView {
  kind: ImportKind;
  fileName: string;
  source: { format: string; delimiter: string | null; encoding: string | null; encodingConfident: boolean };
  encodings: string[];
  counts: { total: number; changed: number; unchanged: number; rejected: number };
  headline: string;
  tone: Tone;
  /** Колонок не хватает — сказано словами и названы поля */
  blocked: string | null;
  /** Сопоставление колонок можно исправить: поля импорта и колонки файла с заголовком и примером */
  fields: Array<{ field: ImportFieldName; label: string; columnIndex: number | null }>;
  fileColumns: Array<{ index: number; name: string; header: string; sample: string }>;
  /** Первые ошибки по строкам; все — в отчёте примерки (файл) */
  errors: Array<{ line: number; key: string; field: string | null; text: string }>;
  /** Первые изменения: строка, предложение, поле, было, стало */
  changes: Array<{ line: number; offer: string; field: string; from: string; to: string }>;
  /** Почему применить нельзя; null — можно */
  applyBlocked: string | null;
  mfaRequired: boolean;
  token: string;
}

export const IMPORT_ERRORS_SHOWN = 200;
export const IMPORT_CHANGES_SHOWN = 50;

/** Колонка так, как её видит продавец в таблице: A, B, …, AA */
export function sheetColumnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** Причина ошибки строки словами словаря — на экране и в отчёте примерки */
export function importProblemText(e: Pick<ImportRowError, 'problem' | 'params' | 'field'>, m: Messages): string {
  const p = m.ui.imports.problems;
  const params = e.params ?? {};
  const currency = String(params.currency ?? '');
  switch (e.problem) {
    case 'MIN_ABOVE_MAX': return p.MIN_ABOVE_MAX(m.money(Number(params.minMinor), currency), m.money(Number(params.maxMinor), currency));
    case 'MARGIN_FLOOR_ABOVE_MAX': return p.MARGIN_FLOOR_ABOVE_MAX(m.money(Number(params.floorMinor), currency), m.money(Number(params.maxMinor), currency));
    case 'MARGIN_HELD_WIDER': return p.MARGIN_HELD_WIDER(m.percentBp(Number(params.widerBp)));
    case 'STRATEGY_UNAVAILABLE': {
      let unmet: Record<string, string[]> = {};
      try { unmet = JSON.parse(String(params.unmet ?? '{}')) as Record<string, string[]>; } catch { /* текст без подробностей */ }
      const words = Object.entries(unmet).map(([source, codes]) => {
        const list = codes.map((c) => m.values[c as keyof typeof m.values] ?? c).join(', ');
        return source === '*' ? list : `${source}${m.colon}${list}`;
      }).join('; ');
      return p.STRATEGY_UNAVAILABLE(words);
    }
    default: return p[e.problem];
  }
}

/** Значение поля так, как его читает продавец: деньги с валютой, проценты, штуки, имя стратегии */
function valueText(field: ImportFieldName, value: number | string | null, currency: string, m: Messages): string {
  if (value === null) return m.ui.common.noValue;
  if (typeof value === 'string') return value;
  switch (field) {
    case 'unit_cost': case 'fixed_fee': case 'min_price': case 'max_price': return m.money(value, currency);
    case 'fee_percent': case 'min_margin_percent': return m.percentBp(value);
    default: return String(value);
  }
}

export function importCheckView(world: StandWorld, plan: ImportPlan, source: { name: string; sheet: Sheet; mapping: ImportMapping }, m: Messages,
  context: ImportPlanContext = {}): ImportCheckView {
  const t = m.ui.imports;
  const counts = { total: plan.rowsTotal, changed: plan.changed.length, unchanged: plan.unchanged, rejected: plan.errors.length };
  const byScope = new Map(world.state.scopes.map((s) => [s.writeScopeId, s]));
  const byProduct = new Map((context.stockTargets ?? []).map((p) => [p.productId, p]));
  const offerOf = (target: string) => {
    const scope = byScope.get(target);
    if (scope) return { label: unitOf(world, scope, m).label, currency: scope.currency };
    const product = byProduct.get(target);
    return { label: product ? product.title ?? product.sku ?? target : target, currency: '' };
  };
  const changes = plan.changed.slice(0, IMPORT_CHANGES_SHOWN).flatMap((r) => {
    const offer = offerOf(r.target);
    return r.changes.map((c) => ({
      line: r.line, offer: offer.label, field: t.fields[c.field],
      from: valueText(c.field, c.from, offer.currency, m), to: valueText(c.field, c.to, offer.currency, m),
    }));
  });
  const blocked = plan.missingColumns.length > 0 ? t.blocked(plan.missingColumns.map((f) => t.fields[f])) : null;
  const applyBlocked = blocked !== null ? blocked
    : plan.errors.length > 0 ? t.applyBlocked.errors(plan.errors.length)
    : plan.changed.length === 0 ? t.applyBlocked.nothing : null;
  const width = source.sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
  const firstData = importDataRows(source.sheet);
  return {
    kind: plan.kind, fileName: source.name,
    source: {
      format: (source.sheet as Sheet).format ?? 'CSV', delimiter: (source.sheet as Sheet).delimiter ?? null,
      encoding: (source.sheet as Sheet).encoding ?? null, encodingConfident: (source.sheet as Sheet).encodingConfident !== false,
    },
    encodings: [...TABLE_ENCODINGS],
    counts, headline: t.counts(counts),
    tone: blocked || plan.errors.length > 0 ? 'stop' : plan.changed.length === 0 ? 'off' : 'ok',
    blocked,
    fields: IMPORT_SCHEMAS[plan.kind].filter((s) => s.role !== 'info').map((s) => ({ field: s.field, label: t.fields[s.field], columnIndex: source.mapping[s.field] ?? null })),
    fileColumns: Array.from({ length: width }, (_, index) => ({
      index, name: sheetColumnName(index), header: String(source.sheet.rows[0]?.[index] ?? '').trim(),
      sample: String(firstData.find((r) => String(r.cells[index] ?? '').trim() !== '')?.cells[index] ?? '').trim(),
    })),
    errors: plan.errors.slice(0, IMPORT_ERRORS_SHOWN).map((e) => ({ line: e.line, key: e.key, field: e.field ? t.fields[e.field] : null, text: importProblemText(e, m) })),
    changes, applyBlocked,
    mfaRequired: plan.kind === 'COSTS' || plan.kind === 'BOUNDS',
    token: plan.token,
  };
}

/** Отчёт примерки — КАЖДАЯ ошибочная строка с причиной: экран показывает первые, файл — все */
export const IMPORT_REPORT_HEADER = ['line', 'sku', 'column', 'problem', 'problem_text'];
export function importReportRows(plan: ImportPlan, m: Messages): string[][] {
  return plan.errors.map((e) => [String(e.line), e.key, e.field ?? '', e.problem, importProblemText(e, m)]);
}

// ------------------------------------------------------------------------------------------------------------------- история

export interface ImportHistoryItem {
  runId: string;
  when: string;
  who: string;
  outcome: string;
  tone: Tone;
  reason: string | null;
  fileName: string;
  /** Контрольная сумма файла: короткая для глаза, полная — подсказкой */
  sha256: string;
  shaShort: string;
  rows: string;
  duration: string;
}

export interface ImportHistoryView {
  kind: ImportKind;
  items: ImportHistoryItem[];
  /** Шаг 104 [Р-229]: журнал за период — страницей (прежде — последние 20 без листания) */
  page?: PageInfo;
}

const OUTCOME_TONE: Readonly<Record<ImportRunRow['outcome'], Tone>> = { CHECKED: 'progress', APPLIED: 'ok', REFUSED: 'stop' };

/** «2.3 s» — секунды с десятой: продавцу важна скорость, и она называется числом [шаг 99, E] */
export const secondsOf = (ms: number) => Math.round(ms / 100) / 10;

export function importHistoryView(kind: ImportKind, runs: readonly ImportRunRow[], world: StandWorld, m: Messages): ImportHistoryView {
  const t = m.ui.imports;
  const who = (membershipId: string) => {
    if (membershipId === world.viewer.membershipId) return t.you;
    const role = world.state.members.find((x) => x.membershipId === membershipId)?.role;
    return role ? m.values[role] : m.ui.common.noValue;
  };
  return {
    kind,
    items: runs.map((r) => ({
      runId: r.runId, when: m.when(r.recordedAt), who: who(r.createdByMembershipId), outcome: t.outcomes[r.outcome], tone: OUTCOME_TONE[r.outcome],
      reason: r.reason ? (t.reasons as Record<string, string>)[r.reason] ?? r.reason : null,
      fileName: r.fileName, sha256: r.fileSha256, shaShort: r.fileSha256.slice(0, 12),
      rows: r.outcome === 'APPLIED' ? t.historyApplied(r.rowsChanged, r.rowsTotal) : t.historyRows({ total: r.rowsTotal, changed: r.rowsChanged, unchanged: r.rowsUnchanged, rejected: r.rowsRejected }),
      duration: t.seconds(secondsOf(r.durationMs)),
    })),
  };
}
