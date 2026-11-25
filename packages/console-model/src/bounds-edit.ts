import { DANGEROUS_DEVIATION_BP } from '@repracer/pricing-model';
import type { BoundsEditInput, BoundsEditRow } from '@repracer/pricing-pipeline';
import { effectiveFloor } from './bounds.ts';
import type { Messages } from './i18n/index.ts';
import { fingerprint } from './strategies.ts';
import { gap, scopeById, unitOf, type Gap, type StandWorld, type Tone, type UnitRef } from './world.ts';

/**
 * Массовое редактирование границ (шаг 21). Порядок обязателен: запрос правки → экран различий (действующие границы до и после
 * вычисляет база в откатываемой транзакции) → применение с токеном этого экрана. Правка больше одной единицы — со вторым фактором
 * [Р-88]; устаревший экран — отказ хранилища (CONFLICT), экран строится заново.
 */

export type BoundAdjust = { kind: 'SET'; minor: number } | { kind: 'PERCENT'; bp: number };

export interface BoundsEditRequest {
  /** Весь каталог: раскрывается сервером [Р-136] */
  all?: boolean;
  writeScopeIds: string[];
  min?: BoundAdjust;
  max?: BoundAdjust;
}

export type BoundsRequestProblem =
  | { code: 'NO_SCOPES' | 'NOTHING_TO_CHANGE'; writeScopeId?: undefined; bound?: undefined }
  | { code: 'UNKNOWN_SCOPE'; writeScopeId: string; bound?: undefined }
  | { code: 'BAD_AMOUNT' | 'BOUND_NOT_SET'; writeScopeId: string; bound: 'min' | 'max' }
  /** Шаг 174 (BUG-02): новый минимум выше максимума — видно до задания по действующим границам; суммы — те, что получились бы */
  | { code: 'MIN_ABOVE_MAX'; writeScopeId: string; bound?: undefined; minMinor: number; maxMinor: number; currency: string };

/**
 * Р-136 (шаг 29): за один раз правятся границы всего каталога целевого клиента. Было 500 — живой прогон через консоль показал, что
 * продавцу с 10 000 предложений консоль отвечала «запрос неверен», не называя ни предела, ни того, что делать. Число — предел
 * продукта: столько же строк принимает импорт себестоимости (`row_count <= 200000`), и оно измерено живым прогоном.
 */
export const MAX_SCOPES = 200_000;

/** Процент — от действующей границы, округление до цента половиной вверх */
function adjusted(current: number | null, adjust: BoundAdjust): number | null {
  if (adjust.kind === 'SET') return adjust.minor;
  if (current === null) return null;
  return Math.floor((current * (10_000 + adjust.bp) + 5_000) / 10_000);
}

/**
 * Шаг 23: ввод человека — сумма в основных единицах («19,99» / «19.99») и процент («-5», «2,5»), а не центы и базисные пункты.
 * Разделитель — запятая или точка, не больше двух знаков после него; тысячные разделители не принимаются. null — не число.
 */
export function parseAmountInput(text: string): number | null {
  const m = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

export function parsePercentInput(text: string): number | null {
  const m = /^\s*([+\-−]?)(\d{1,4})(?:[.,](\d{1,2}))?\s*$/.exec(text);
  if (!m) return null;
  const bp = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] === '-' || m[1] === '−' ? -bp : bp;
}

export function parseBoundsEditRequest(raw: unknown): BoundsEditRequest | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const adjust = (v: unknown): BoundAdjust | undefined | null => {
    if (v === undefined || v === null) return undefined;
    const a = v as Record<string, unknown>;
    if (a.kind === 'SET' && Number.isSafeInteger(a.minor)) return { kind: 'SET', minor: a.minor as number };
    if (a.kind === 'PERCENT' && Number.isSafeInteger(a.bp) && (a.bp as number) > -10_000 && (a.bp as number) <= 100_000) return { kind: 'PERCENT', bp: a.bp as number };
    return null;
  };
  const min = adjust(r.min);
  const max = adjust(r.max);
  if (min === null || max === null) return null;
  /**
   * Р-136 (шаг 29, ревью, находка 1 и 2): «все предложения» — это ВЫБОР, а не список из десяти тысяч идентификаторов. Список
   * каталога весит 381 КБ и не проходит предел тела запроса (413), а экран со страницами может показать только страницу — до
   * этого «выбрать всё» означало «выбрать показанные 50». Раскрывает выбор сервер, по состоянию мира.
   */
  if (r.all === true) return { all: true, writeScopeIds: [], ...(min ? { min } : {}), ...(max ? { max } : {}) };
  if (!Array.isArray(r.writeScopeIds) || !r.writeScopeIds.every((x) => typeof x === 'string') || r.writeScopeIds.length > MAX_SCOPES) return null;
  return { writeScopeIds: [...new Set(r.writeScopeIds as string[])], ...(min ? { min } : {}), ...(max ? { max } : {}) };
}

/** Запрос → правки с ожидаемыми действующими границами (то, что человек видит сейчас) */
export function expandBoundsEdit(world: StandWorld, request: BoundsEditRequest): { edits: BoundsEditInput[]; problems: BoundsRequestProblem[] } {
  const problems: BoundsRequestProblem[] = [];
  // «Все предложения» раскрывается здесь: продавец выбрал каталог, а не перечислил его
  const ids = request.all ? world.state.scopes.map((s) => s.writeScopeId) : request.writeScopeIds;
  if (ids.length === 0) problems.push({ code: 'NO_SCOPES' });
  if (!request.min && !request.max) problems.push({ code: 'NOTHING_TO_CHANGE' });
  // Поиск предложения — по отображению: перебор состояния на каждый идентификатор был квадратичным (ревью шага 29, находка 11)
  const byId = new Map(world.state.scopes.map((s) => [s.writeScopeId, s]));
  const edits: BoundsEditInput[] = [];
  for (const id of ids) {
    const scope = byId.get(id);
    if (!scope) { problems.push({ code: 'UNKNOWN_SCOPE', writeScopeId: id }); continue; }
    const current = {
      minMinor: scope.bounds.min.status === 'RESOLVED' ? scope.bounds.min.amountMinor : null,
      maxMinor: scope.bounds.max.status === 'RESOLVED' ? scope.bounds.max.amountMinor : null,
    };
    const edit: BoundsEditInput = { writeScopeId: id, expected: current };
    for (const bound of ['min', 'max'] as const) {
      const a = request[bound];
      if (!a) continue;
      const value = adjusted(bound === 'min' ? current.minMinor : current.maxMinor, a);
      if (value === null) { problems.push({ code: 'BOUND_NOT_SET', writeScopeId: id, bound }); continue; }
      if (!Number.isSafeInteger(value) || value <= 0) { problems.push({ code: 'BAD_AMOUNT', writeScopeId: id, bound }); continue; }
      if (bound === 'min') edit.minMinor = value; else edit.maxMinor = value;
    }
    /**
     * Шаг 174 (BUG-02): минимум выше максимума — до задания, по действующим границам. Ложной тревоги нет: действующий пол не ниже пола уровня
     * предложения, действующий потолок не выше его потолка, а неправленная граница остаётся прежней — значит, отказ здесь будет и у базы.
     * Обратное неверно (граница товара может решить иначе), поэтому последнее слово — по-прежнему за базой
     */
    const afterMin = edit.minMinor ?? current.minMinor;
    const afterMax = edit.maxMinor ?? current.maxMinor;
    if ((edit.minMinor !== undefined || edit.maxMinor !== undefined) && afterMin !== null && afterMax !== null && afterMin > afterMax) {
      problems.push({ code: 'MIN_ABOVE_MAX', writeScopeId: id, minMinor: afterMin, maxMinor: afterMax, currency: scope.currency });
    }
    edits.push(edit);
  }
  return { edits, problems };
}

/** Сколько предложений называть по имени в тексте отказа: остальные — числом */
export const PROBLEM_OFFERS_SHOWN = 10;

/**
 * Шаг 174 (BUG-02): отказ правки — ОДИН текст словами: что не так, у каких предложений (подпись предложения, а не внутренний идентификатор)
 * и с какими суммами; «ничего не изменено» — потому что правка применяется целиком или никак [Р-134]
 */
export function boundsProblemsText(world: StandWorld, problems: readonly BoundsRequestProblem[], m: Messages): string {
  const t = m.ui.boundsEdit.problems;
  const byId = new Map(world.state.scopes.map((s) => [s.writeScopeId, s]));
  const label = (id: string) => { const scope = byId.get(id); return scope ? unitOf(world, scope, m).label : t.unknownOffer; };
  const listOf = (items: readonly string[]) => {
    const shown = items.slice(0, PROBLEM_OFFERS_SHOWN);
    return t.list(shown, items.length - shown.length);
  };
  const parts: string[] = [];
  if (problems.some((p) => p.code === 'NO_SCOPES')) parts.push(t.NO_SCOPES);
  if (problems.some((p) => p.code === 'NOTHING_TO_CHANGE')) parts.push(t.NOTHING_TO_CHANGE);
  const unknown = problems.filter((p) => p.code === 'UNKNOWN_SCOPE');
  if (unknown.length > 0) parts.push(t.UNKNOWN_SCOPE(unknown.length));
  const crossed = problems.flatMap((p) => (p.code === 'MIN_ABOVE_MAX' ? [p] : []));
  if (crossed.length > 0) {
    parts.push(t.MIN_ABOVE_MAX(crossed.length, listOf(crossed.map((p) => t.crossedOffer(label(p.writeScopeId), m.money(p.minMinor, p.currency), m.money(p.maxMinor, p.currency))))));
  }
  for (const code of ['BAD_AMOUNT', 'BOUND_NOT_SET'] as const) {
    for (const bound of ['min', 'max'] as const) {
      const hit = problems.filter((p) => p.code === code && p.bound === bound);
      if (hit.length > 0) parts.push(t[code](bound === 'min' ? t.minPrice : t.maxPrice, hit.length, listOf(hit.map((p) => label(p.writeScopeId!)))));
    }
  }
  return `${parts.join(' ')} ${t.nothingChanged}`;
}

export type DiffFlag = 'PRICE_BELOW_NEW_FLOOR' | 'PRICE_ABOVE_NEW_CEILING' | 'BIG_CHANGE' | 'MARGIN_FLOOR_ABOVE_MIN' | 'NO_EFFECT';

export interface DiffRow {
  unit: UnitRef;
  tone: Tone;
  minBefore: string;
  minAfter: string;
  minChange: string | null;
  maxBefore: string;
  maxAfter: string;
  maxChange: string | null;
  currentPrice: string;
  flags: Array<{ code: DiffFlag; text: string }>;
}

/**
 * Сколько строк различий показывать: как у импорта себестоимости [Р-134] — первые строки и итоги. Живой прогон через консоль
 * показал 4,2 МБ ответа на каталог целевого клиента: столько строк никто не читает, а браузер их разбирает секунды [Р-136].
 */
export const DIFF_ROWS_SHOWN = 50;

export interface BoundsDiffView {
  worldId: string;
  /** Показанные строки: первые DIFF_ROWS_SHOWN; сколько их всего — в summary.scopes */
  rows: DiffRow[];
  /** Строки с пометками показываются первыми: продавцу важно именно опасное */
  shown: { rows: number; of: number };
  /**
   * Шаг 163 (#27): числа полосы сводки — предложения, у скольких граница меняется и у скольких нет (правка ничего не меняет — `NO_EFFECT`),
   * сколько с пометками и у скольких текущая цена вне новых границ
   */
  summary: { scopes: number; changed: number; unchanged: number; flagged: number; pricesOutside: number };
  mfaRequired: boolean;
  /** Применение принимается только с этим токеном: правки и различия — те, что видел человек */
  planToken: string;
  gaps: Gap[];
}

export function boundsPlanToken(edits: readonly BoundsEditInput[], rows: readonly BoundsEditRow[]): string {
  return fingerprint([edits, rows]);
}

const bigChange = (before: number | null, after: number | null) =>
  before !== null && after !== null && before > 0 && Math.abs(after - before) * 10_000 > before * DANGEROUS_DEVIATION_BP;

function diffRowsOf(world: StandWorld, edits: readonly BoundsEditInput[], rows: readonly BoundsEditRow[], m: Messages): DiffRow[] {
  const t = m.ui.boundsEdit;
  // Предложение ищется по отображению: перебор состояния на каждую строку был квадратичным (ревью шага 29, находка 11)
  const byId = new Map(world.state.scopes.map((s) => [s.writeScopeId, s]));
  return rows.map((r): DiffRow => {
    const scope = byId.get(r.writeScopeId)!;
    const money = (v: number | null) => m.money(v, r.currency);
    const flags: DiffRow['flags'] = [];
    const price = scope.currentPriceMinor;
    // Пол Gate — наибольший из min_price и цены минимальной маржи: правка min_price ниже пола по марже цену не отпустит
    const marginFloor = effectiveFloor(scope, world).marginFloorMinor;
    /**
     * Шаг 175 (QA-A Testing 2.0, этап 4): цена вне новых границ — как есть, без обещания «следующее решение поднимет/снизит»: с выключенной
     * автоценой решения нет, подъём к полу идёт лестницей, а в тени новые цены только считаются — это сказано
     */
    const shadow = world.accounts.find((a) => a.channelAccountId === scope.channelAccountId)?.writeMode === 'SHADOW';
    const outside = (text: string) => (shadow ? `${text} — ${t.flags.shadowNote}` : text);
    if (price !== null && r.after.minMinor !== null && price < r.after.minMinor) flags.push({ code: 'PRICE_BELOW_NEW_FLOOR', text: outside(t.flags.PRICE_BELOW_NEW_FLOOR(money(price), money(r.after.minMinor))) });
    if (price !== null && r.after.maxMinor !== null && price > r.after.maxMinor) flags.push({ code: 'PRICE_ABOVE_NEW_CEILING', text: outside(t.flags.PRICE_ABOVE_NEW_CEILING(money(price), money(r.after.maxMinor))) });
    if (bigChange(r.before.minMinor, r.after.minMinor) || bigChange(r.before.maxMinor, r.after.maxMinor)) flags.push({ code: 'BIG_CHANGE', text: t.flags.BIG_CHANGE(m.percentBp(DANGEROUS_DEVIATION_BP)) });
    if (marginFloor !== null && r.after.minMinor !== null && marginFloor > r.after.minMinor) flags.push({ code: 'MARGIN_FLOOR_ABOVE_MIN', text: t.flags.MARGIN_FLOOR_ABOVE_MIN(money(marginFloor)) });
    const edit = edits.find((e) => e.writeScopeId === r.writeScopeId);
    // База берёт наибольший пол и наименьший потолок из уровней товара и единицы: запись уровня единицы может ничего не изменить
    if (edit && r.before.minMinor === r.after.minMinor && r.before.maxMinor === r.after.maxMinor) flags.push({ code: 'NO_EFFECT', text: t.flags.NO_EFFECT });
    return {
      unit: unitOf(world, scope, m),
      tone: flags.some((f) => f.code === 'PRICE_BELOW_NEW_FLOOR' || f.code === 'PRICE_ABOVE_NEW_CEILING' || f.code === 'BIG_CHANGE') ? 'warn' : flags.length > 0 ? 'unknown' : 'ok',
      minBefore: money(r.before.minMinor), minAfter: money(r.after.minMinor), minChange: m.change(r.before.minMinor, r.after.minMinor),
      maxBefore: money(r.before.maxMinor), maxAfter: money(r.after.maxMinor), maxChange: m.change(r.before.maxMinor, r.after.maxMinor),
      currentPrice: money(price), flags,
    };
  });
}

/**
 * Шаг 177 (уточнение Р-140, (г)): предпросмотр перечисляет ВСЕ затрагиваемые предложения — страницами, в порядке экрана: сначала строки с
 * пометками (сортировка устойчивая, первая страница — те же строки, что `rows` вида). Задание плана хранит строки базы в этом порядке
 */
export function orderedPlanRows(world: StandWorld, edits: readonly BoundsEditInput[], rows: readonly BoundsEditRow[], m: Messages): BoundsEditRow[] {
  const out = diffRowsOf(world, edits, rows, m);
  return rows.map((r, i) => ({ r, n: out[i]!.flags.length })).sort((a, b) => b.n - a.n).map((x) => x.r);
}

export function boundsDiffView(world: StandWorld, edits: readonly BoundsEditInput[], rows: readonly BoundsEditRow[], m: Messages, options: { keepOrder?: boolean } = {}): BoundsDiffView {
  const out = diffRowsOf(world, edits, rows, m);
  // Сначала — строки с пометками: если показать можно не всё, показывается то, что важно; страница плана уже упорядочена (`keepOrder`)
  const ordered = options.keepOrder ? out : [...out].sort((a, b) => b.flags.length - a.flags.length);
  const unchanged = out.filter((r) => r.flags.some((f) => f.code === 'NO_EFFECT')).length;
  const summary = {
    scopes: out.length,
    changed: out.length - unchanged,
    unchanged,
    flagged: out.filter((r) => r.flags.length > 0).length,
    pricesOutside: out.filter((r) => r.flags.some((f) => f.code === 'PRICE_BELOW_NEW_FLOOR' || f.code === 'PRICE_ABOVE_NEW_CEILING')).length,
  };
  return {
    worldId: world.id, rows: ordered.slice(0, DIFF_ROWS_SHOWN),
    shown: { rows: Math.min(ordered.length, DIFF_ROWS_SHOWN), of: out.length }, summary, mfaRequired: out.length > 1,
    planToken: boundsPlanToken(edits, rows), gaps: [gap(m, 'BOUND_LEVELS'), gap(m, 'MASS_EDIT_MFA_PER_TRANSACTION')],
  };
}
