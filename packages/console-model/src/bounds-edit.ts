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
  writeScopeIds: string[];
  min?: BoundAdjust;
  max?: BoundAdjust;
}

export type BoundsRequestProblem = { code: 'NO_SCOPES' | 'NOTHING_TO_CHANGE' | 'UNKNOWN_SCOPE' | 'BAD_AMOUNT' | 'BOUND_NOT_SET'; writeScopeId?: string; bound?: 'min' | 'max' };

const MAX_SCOPES = 500;

/** Процент — от действующей границы, округление до цента половиной вверх */
function adjusted(current: number | null, adjust: BoundAdjust): number | null {
  if (adjust.kind === 'SET') return adjust.minor;
  if (current === null) return null;
  return Math.floor((current * (10_000 + adjust.bp) + 5_000) / 10_000);
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
  if (min === null || max === null || !Array.isArray(r.writeScopeIds) || !r.writeScopeIds.every((x) => typeof x === 'string') || r.writeScopeIds.length > MAX_SCOPES) return null;
  return { writeScopeIds: [...new Set(r.writeScopeIds as string[])], ...(min ? { min } : {}), ...(max ? { max } : {}) };
}

/** Запрос → правки с ожидаемыми действующими границами (то, что человек видит сейчас) */
export function expandBoundsEdit(world: StandWorld, request: BoundsEditRequest): { edits: BoundsEditInput[]; problems: BoundsRequestProblem[] } {
  const problems: BoundsRequestProblem[] = [];
  if (request.writeScopeIds.length === 0) problems.push({ code: 'NO_SCOPES' });
  if (!request.min && !request.max) problems.push({ code: 'NOTHING_TO_CHANGE' });
  const edits: BoundsEditInput[] = [];
  for (const id of request.writeScopeIds) {
    const scope = scopeById(world, id);
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
    edits.push(edit);
  }
  return { edits, problems };
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

export interface BoundsDiffView {
  worldId: string;
  headline: string;
  rows: DiffRow[];
  summary: { scopes: number; flagged: number; pricesOutside: number };
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

export function boundsDiffView(world: StandWorld, edits: readonly BoundsEditInput[], rows: readonly BoundsEditRow[], m: Messages): BoundsDiffView {
  const t = m.ui.boundsEdit;
  const out = rows.map((r): DiffRow => {
    const scope = scopeById(world, r.writeScopeId)!;
    const money = (v: number | null) => m.money(v, r.currency);
    const flags: DiffRow['flags'] = [];
    const price = scope.currentPriceMinor;
    // Пол Gate — наибольший из min_price и цены минимальной маржи: правка min_price ниже пола по марже цену не отпустит
    const marginFloor = effectiveFloor(scope, world).marginFloorMinor;
    if (price !== null && r.after.minMinor !== null && price < r.after.minMinor) flags.push({ code: 'PRICE_BELOW_NEW_FLOOR', text: t.flags.PRICE_BELOW_NEW_FLOOR(money(price), money(r.after.minMinor)) });
    if (price !== null && r.after.maxMinor !== null && price > r.after.maxMinor) flags.push({ code: 'PRICE_ABOVE_NEW_CEILING', text: t.flags.PRICE_ABOVE_NEW_CEILING(money(price), money(r.after.maxMinor)) });
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
  const summary = {
    scopes: out.length,
    flagged: out.filter((r) => r.flags.length > 0).length,
    pricesOutside: out.filter((r) => r.flags.some((f) => f.code === 'PRICE_BELOW_NEW_FLOOR' || f.code === 'PRICE_ABOVE_NEW_CEILING')).length,
  };
  return {
    worldId: world.id, headline: t.headline(summary), rows: out, summary, mfaRequired: out.length > 1,
    planToken: boundsPlanToken(edits, rows), gaps: [gap(m, 'BOUND_LEVELS'), gap(m, 'MASS_EDIT_MFA_PER_TRANSACTION')],
  };
}
