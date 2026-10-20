import { createHash } from 'node:crypto';
import { readTable, TABLE_ENCODINGS, type TableEncoding } from '@repracer/cost-import';
import {
  boundsDiffView, currentStrategies, expandBoundsEdit, messagesFor, parseBoundsEditRequest,
  parseStrategyDraft, PRICE_EVIDENCE_HEADER, priceEvidenceRows, strategyPreviewView, STRATEGY_PREVIEW_ROWS_SHOWN, LOCALES,
  parseFeedQuery, PRICE_FEED_CSV_HEADER, priceFeedFileName, priceFeedRowsOf, feedPageQuery, FEED_PAGE_MAX,
  describe, unitOf, buildImportPlan, importCheckView, importMapping, importReportRows, importTemplate, IMPORT_FILE_NAMES, IMPORT_KIND_LIST, IMPORT_REPORT_HEADER,
  refineBoundsPlan, type ConsoleScope, type EnableResultView, type ImportKind, type ImportPlan, type ImportPlanContext, type Locale, type StandWorld,
} from '@repracer/console-model';
import type { StrategyDefinition } from '@repracer/pricing-model';
import type { ImportRunInput, ImportRunRow } from '@repracer/pricing-pipeline';

/** Стратегия предложения на момент предпросмотра — как её ждёт хранилище */
type StrategyExpectation = { writeScopeId: string; strategyId: string | null; version: number | null };
import type { BoundsEditInput, BulkJobRow, StrategyPreview } from '@repracer/pricing-pipeline';
import type { StockStore } from '@repracer/stock-sync';
import type { BulkJobContext, BulkJobHandlers, BulkJobWork } from './index.ts';
import type { BulkJobPhase } from '@repracer/pricing-pipeline';
import { EXPORT_ABOUT_SHEET, EXPORT_FORMATS, EXPORT_HEADERS, EXPORT_MAX_ROWS, EXPORT_NUMERIC_COLUMNS, EXPORT_SCREENS, exportAboutLines, exportFileName } from '@repracer/console-model';
import { screenExportCount, screenExportRows, type ScreenExportDeps, type ScreenExportParams } from './screen-export.ts';

// Шаг 104 [Р-229]: сервер переводит фильтры экрана в запрос и считает строки тем же путём, что исполнитель
export { screenExportCount, screenExportRows, type ScreenExportDeps, type ScreenExportParams, type ScreenExportQuery } from './screen-export.ts';

/**
 * Р-139 (шаг 30): что делает фоновое задание каждого вида. Работа повторяет ровно тот путь, который раньше шёл синхронным
 * запросом, — те же проверки хранилища и то же «целиком или никак» [Р-134]. Отличие одно: ход виден, и падение процесса не
 * оставляет половины.
 *
 * Мир консоли (`StandWorld`) собирается здесь же из состояния хранилища: задание исполняется без браузера, и брать состояние
 * ему больше неоткуда.
 */

export interface BulkJobWorldOptions {
  /** Мир тенанта на момент исполнения: сопоставление офферов, границы, стратегии */
  world(ctx: BulkJobContext): Promise<StandWorld>;
  /**
   * Решение по одному предложению с черновиком стратегии [OQ-201]. Даёт его хозяин обработчиков: путь решения знает возможности
   * канала, а задание — нет. Канал при этом НЕ опрашивается: считается по последнему принятому снимку.
   */
  previewStrategy?(ctx: BulkJobContext, scope: ConsoleScope, strategy: StrategyDefinition): Promise<StrategyPreview | null>;
  /**
   * Шаг 34 [Р-149]: включение движка у одного предложения — тем же путём, что кнопка на экране товаров. Канал при этом не
   * опрашивается: проверяются себестоимость [Р-131], границы и стратегия по данным базы.
   */
  enableRepricing?(ctx: BulkJobContext, scope: ConsoleScope): Promise<{ enabled: boolean; problems: Array<{ code: string; params?: Record<string, unknown> }> }>;
  /** Шаг 35 [Р-152]: хранилище остатков — файл остатков применяется им от имени автора задания, пересчёт создаёт записи в каналы */
  stock?: StockStore;
  /**
   * Шаг 99 [Р-225, Р-39]: даёт ли канал предложения данные, нужные стратегии, — по описанию канала, которое знает хозяин обработчиков.
   * Без него импорт стратегий доступность не проверяет (последнее слово всё равно за базой, 0082)
   */
  strategyAvailable?(scope: ConsoleScope, params: StrategyDefinition['params']): { available: true } | { available: false; unmet: Record<string, string[]> };
}

/** Шаг 99 [Р-224]: что задание шаблона, примерки и применения знает о файле — ровно то, что прислал человек */
interface ImportFileParams {
  importKind: ImportKind;
  fileName: string;
  content: string;
  encoding?: TableEncoding;
  mapping?: Record<string, unknown>;
  stockSourceId?: string;
}

/** Задание применения каждого импорта (то же сопоставление держит страж журнала, 0193) */
export const APPLY_JOB_OF: Readonly<Record<ImportKind, 'COST_IMPORT' | 'STOCK_IMPORT' | 'BOUNDS_EDIT' | 'STRATEGY_ASSIGN'>> = {
  COSTS: 'COST_IMPORT', STOCK: 'STOCK_IMPORT', BOUNDS: 'BOUNDS_EDIT', STRATEGY: 'STRATEGY_ASSIGN',
};

const PROGRESS_STEP = 500;

/**
 * Язык задания — тот, на котором его создал человек [Р-72]. Задание работает без запроса, и взять язык ему больше неоткуда:
 * тексты, попавшие в его итог (заголовки предпросмотра, названия проблем импорта), должны быть на языке продавца, а не на языке
 * процесса. Неизвестный язык — немецкий, как язык по умолчанию у консоли.
 */
const localeOf = (job: BulkJobRow) => {
  const locale = (job.params as { locale?: unknown }).locale;
  return (LOCALES as readonly string[]).includes(locale as string) ? (locale as Locale) : 'de';
};
/** Шаг 69 (K1, K4; ревью, находка 8): тексты и времена итога задания — языком и в поясе мира, в котором его создали */
const messagesOfJob = (job: BulkJobRow) => {
  const zone = (job.params as { timeZone?: unknown }).timeZone;
  return messagesFor(localeOf(job), { timeZone: typeof zone === 'string' ? zone : null });
};

const fail = (cause: string): never => { throw Object.assign(new Error(cause), { cause }); };

export function bulkJobHandlers(options: BulkJobWorldOptions): BulkJobHandlers {
  const actorOf = (ctx: BulkJobContext) => ({ membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId });

  /**
   * Шаг 99 [Р-224]: примерка файла против ТЕКУЩИХ данных — одним путём у задания примерки и у задания применения. Применение не берёт
   * примерку из итога, а считает её заново и сравнивает отпечаток: так оно видит изменения, случившиеся после примерки
   */
  const prepareImport = async (p: ImportFileParams, ctx: BulkJobContext, m: ReturnType<typeof messagesFor>) => {
    if (!IMPORT_KIND_LIST.includes(p.importKind) || typeof p.content !== 'string') fail('BAD_REQUEST');
    const bytes = Buffer.from(p.content, 'base64');
    let sheet;
    try { sheet = readTable(bytes, TABLE_ENCODINGS.find((e) => e === p.encoding)); } catch { return fail('BAD_FILE'); }
    const mapping = importMapping(p.importKind, sheet, p.mapping ?? null);
    const world = await options.world(ctx);
    const context: ImportPlanContext = {
      ...(options.strategyAvailable ? { strategyAvailable: options.strategyAvailable } : {}),
    };
    if (p.importKind === 'STOCK') {
      if (!options.stock || typeof p.stockSourceId !== 'string') fail('NOT_INTERNAL_POOL');
      const targets = await options.stock!.stockImportTargets(ctx.tenantId, p.stockSourceId!);
      if ('status' in targets) return fail('NOT_INTERNAL_POOL');
      context.stockTargets = targets;
    }
    let plan = buildImportPlan(p.importKind, sheet, mapping, world, m, context);
    /**
     * Границы: что станет действующей границей на деле, считает база без записи — у товара может быть своя граница, и тогда строка
     * предложения ничего не меняет (ошибка с причиной). Строка с полом выше потолка по уровню товара — тоже ошибка этой строки
     */
    if (plan.kind === 'BOUNDS') {
      const excluded = new Set<string>();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const edits = plan.changed.filter((r) => !excluded.has(r.target) && (r.set.minMinor !== undefined || r.set.maxMinor !== undefined)).map((r) => ({
          writeScopeId: r.target,
          ...(r.set.minMinor !== undefined ? { minMinor: Number(r.set.minMinor) } : {}),
          ...(r.set.maxMinor !== undefined ? { maxMinor: Number(r.set.maxMinor) } : {}),
          expected: { minMinor: (r.expected.minMinor ?? null) as number | null, maxMinor: (r.expected.maxMinor ?? null) as number | null },
        }));
        if (edits.length === 0) break;
        const preview = await ctx.store.editBounds(ctx.tenantId, edits, actorOf(ctx), 'PREVIEW');
        if (preview.status === 'PREVIEWED') { plan = refineBoundsPlan(plan, new Map(preview.rows.map((r) => [r.writeScopeId, r.after]))); break; }
        if (preview.status === 'INVALID' && preview.cause === 'MIN_ABOVE_MAX') {
          // Пол выше потолка с учётом уровня товара — ошибка этой строки; остальные считаются заново
          const row = plan.changed.find((r) => r.target === preview.writeScopeId)!;
          excluded.add(row.target);
          plan = refineBoundsPlan({ ...plan, changed: plan.changed.filter((r) => r !== row),
            errors: [...plan.errors, { line: row.line, key: row.key, problem: 'BOUND_HELD_ELSEWHERE', field: row.set.minMinor !== undefined ? 'min_price' : 'max_price' }] }, new Map());
          continue;
        }
        if (preview.status === 'FORBIDDEN') fail('FORBIDDEN');
        if (preview.status === 'CONFLICT') fail('DATA_CHANGED');
        break;
      }
    }
    const fileSha256 = createHash('sha256').update(bytes).digest('hex');
    return { sheet, mapping, world, context, plan, fileSha256 };
  };

  const runOf = (p: ImportFileParams, plan: ImportPlan, fileSha256: string, outcome: ImportRunInput['outcome'], reason?: string): ImportRunInput => ({
    kind: p.importKind, outcome, ...(reason ? { reason } : {}), fileName: p.fileName, fileSha256,
    rowsTotal: plan.rowsTotal, rowsChanged: plan.changed.length, rowsUnchanged: plan.unchanged, rowsRejected: plan.errors.length,
  });

  /**
   * Шаг 99 [Р-224]: применение импорта. Примерка — ЗАДАНИЕ того же человека; применение считает её заново по текущим данным и
   * отказывает, если отпечаток другой (данные изменились), если в файле ошибки или менять нечего — каждый отказ строкой журнала.
   * Запись — одной транзакцией хранилища вместе со строкой «применено»; повтор задания после падения процесса не применяет дважды
   */
  const applyImport = async (kind: ImportKind, job: BulkJobRow, ctx: BulkJobContext,
    write: (prepared: Awaited<ReturnType<typeof prepareImport>>, run: ImportRunInput) => Promise<{ status: string; run?: ImportRunRow; cause?: string; window?: boolean }>,
    after?: (prepared: Awaited<ReturnType<typeof prepareImport>>) => Promise<void>): Promise<BulkJobWork> => {
    const m = messagesOfJob(job);
    const p = job.params as { checkJobId?: string; checkToken?: string };
    const checkJob = typeof p.checkJobId === 'string' ? await ctx.store.bulkJob(ctx.tenantId, p.checkJobId) : null;
    const checked = (checkJob?.params ?? {}) as unknown as ImportFileParams;
    if (!checkJob || checkJob.kind !== 'IMPORT_CHECK' || checkJob.status !== 'SUCCEEDED' || checked.importKind !== kind
      || checkJob.createdByMembershipId !== ctx.membershipId || (checkJob.result as { token?: unknown } | null)?.token !== p.checkToken) fail('CHECK_MISSING');
    const prepared = await prepareImport(checked, ctx, m);
    const { plan, fileSha256 } = prepared;
    const result = (run: ImportRunRow) => ({ importKind: kind, applied: run.rowsChanged, total: run.rowsTotal, durationMs: run.durationMs, fileName: run.fileName });
    return {
      total: plan.changed.length,
      async run(progress) {
        // Повтор задания после падения: строка журнала уже есть — данные применены той же транзакцией, второй раз не применяются
        const recorded = await ctx.store.importRunOfJob(ctx.tenantId, ctx.jobId);
        if (recorded?.outcome === 'APPLIED') { if (after) await after(prepared); return result(recorded); }
        if (recorded?.outcome === 'REFUSED') fail(recorded.reason ?? 'DATA_CHANGED');
        const refuse = async (reason: string): Promise<never> => {
          await ctx.store.recordImportRun(ctx.tenantId, runOf(checked, plan, fileSha256, 'REFUSED', reason), actorOf(ctx));
          return fail(reason);
        };
        if (plan.token !== p.checkToken) await refuse('DATA_CHANGED');
        if (plan.missingColumns.length > 0 || plan.errors.length > 0) await refuse('HAS_ERRORS');
        if (plan.changed.length === 0) await refuse('NOTHING_TO_APPLY');
        await progress(0, 'APPLYING');
        const written = await write(prepared, runOf(checked, plan, fileSha256, 'APPLIED'));
        if (written.status === 'CONFLICT') await refuse('DATA_CHANGED');
        if (written.status === 'MFA_REQUIRED') await refuse(written.window ? 'MFA_REQUIRED_WINDOW' : 'MFA_REQUIRED');
        if (written.status === 'FORBIDDEN' || written.status === 'NOT_INTERNAL_POOL') await refuse(written.status);
        if (written.status === 'INVALID') await refuse('INVALID');
        await progress(plan.changed.length, 'APPLYING');
        // В памяти журнал остатков у хранилища цен: строка пишется сразу после применения
        const run = written.run ?? await ctx.store.recordImportRun(ctx.tenantId, runOf(checked, plan, fileSha256, 'APPLIED'), actorOf(ctx));
        if (after) await after(prepared);
        return result(run);
      },
    };
  };

  return {
    /**
     * Шаг 99 [Р-224]: шаблон импорта — текущие значения каталога файлом CSV или XLSX: заголовки по-английски, пример «#», пояснение на
     * языке пространства. Ничего не меняет
     */
    async IMPORT_TEMPLATE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const p = job.params as { importKind?: ImportKind; format?: string; stockSourceId?: string };
      if (!p.importKind || !IMPORT_KIND_LIST.includes(p.importKind)) fail('BAD_REQUEST');
      const kind = p.importKind!;
      const world = await options.world(ctx);
      const context: ImportPlanContext = {};
      if (kind === 'STOCK') {
        if (!options.stock || typeof p.stockSourceId !== 'string') fail('NOT_INTERNAL_POOL');
        const targets = await options.stock!.stockImportTargets(ctx.tenantId, p.stockSourceId!);
        if ('status' in targets) return fail('NOT_INTERNAL_POOL');
        context.stockTargets = targets;
      }
      const tpl = importTemplate(kind, world, m, context);
      return {
        total: tpl.rows.length,
        async run(progress, produce) {
          await progress(0, 'PRODUCING');
          const file = await produce({
            fileName: tpl.fileName, header: tpl.header, rows: tpl.rows, format: p.format === 'xlsx' ? 'xlsx' : 'csv',
            comments: [{ cells: tpl.example, onDataSheet: true }, ...tpl.notes.map((n) => ({ cells: [`# ${n}`] }))],
            sheets: { data: m.ui.imports.sheets.data, help: m.ui.imports.sheets.help, helpLines: tpl.notes },
          });
          return { ...file };
        },
      };
    },

    /**
     * Шаг 99 [Р-224]: примерка файла — сколько строк изменится, сколько без изменений, ошибки по строкам; итог — экран примерки и её
     * отпечаток, ошибочные строки — файлом. Строка журнала «проверено». Ничего не меняет
     */
    async IMPORT_CHECK(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const p = job.params as unknown as ImportFileParams;
      const prepared = await prepareImport(p, ctx, m);
      const { plan, fileSha256 } = prepared;
      return {
        total: plan.rowsTotal,
        async run(progress, produce) {
          await progress(plan.rowsTotal, 'PRODUCING');
          if (plan.errors.length > 0) {
            await produce({ fileName: `${IMPORT_FILE_NAMES[p.importKind]}-errors_${p.fileName}`, header: IMPORT_REPORT_HEADER, rows: importReportRows(plan, m) });
          }
          await ctx.store.recordImportRun(ctx.tenantId, runOf(p, plan, fileSha256, 'CHECKED'), actorOf(ctx));
          const view = importCheckView(prepared.world, plan, { name: p.fileName, sheet: prepared.sheet, mapping: prepared.mapping }, m, prepared.context);
          return {
            view: view as unknown as Record<string, unknown>, token: plan.token, importKind: p.importKind, fileSha256,
            total: plan.rowsTotal, changed: plan.changed.length, unchanged: plan.unchanged, rejected: plan.errors.length,
          };
        },
      };
    },

    /**
     * Импорт себестоимости [Р-134]. Шаг 99 [Р-224]: применяется ровно примерка — ни одной строки, если в файле есть ошибка, и ничего,
     * если себестоимость или комиссия предложения изменились после примерки
     */
    async COST_IMPORT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      return applyImport('COSTS', job, ctx, async ({ plan, sheet, world }, run) => ctx.store.importCosts(ctx.tenantId, {
        sourceName: run.fileName, sourceFormat: sheet.format, fingerprint: plan.token, skippedRows: 0, run, asOf: world.now,
        rows: plan.changed.map((r) => ({
          writeScopeId: r.target, currency: String(r.set.currency),
          ...(r.set.unitCostMinor !== undefined ? { unitCostMinor: Number(r.set.unitCostMinor) } : {}),
          ...(r.set.feeRateBp !== undefined ? { feeRateBp: Number(r.set.feeRateBp) } : {}),
          ...(r.set.fixedFeeMinor !== undefined ? { fixedFeeMinor: Number(r.set.fixedFeeMinor) } : {}),
          expected: r.expected as { costProfileId: string | null; sellerFee: { feeRateBp: number | null; fixedFeeMinor: number | null } | null },
        })),
      }, actorOf(ctx), 'APPLY'));
    },

    /**
     * Правка границ. Экран различий строит САМО задание и сверяет его с токеном того экрана, который видел человек: иначе
     * пересчёт различий по каталогу (10 000 предложений) остался бы в синхронном запросе — ровно то, от чего уходит Р-139.
     */
    async BOUNDS_EDIT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      // Шаг 99 [Р-225]: импорт границ — та же массовая правка границ, но из файла и ровно по примерке, с минимальной маржой
      if ('checkJobId' in job.params) {
        return applyImport('BOUNDS', job, ctx, async ({ plan }, run) => ctx.store.importBounds(ctx.tenantId, {
          run,
          rows: plan.changed.map((r) => ({
            writeScopeId: r.target,
            ...(r.set.minMinor !== undefined ? { minMinor: Number(r.set.minMinor) } : {}),
            ...(r.set.maxMinor !== undefined ? { maxMinor: Number(r.set.maxMinor) } : {}),
            ...(r.set.minMarginBp !== undefined ? { minMarginBp: Number(r.set.minMarginBp) } : {}),
            expected: r.expected as { minMinor: number | null; maxMinor: number | null; minMarginBp: number | null },
          })),
        }, actorOf(ctx)));
      }
      const p = job.params as { planJobId?: string; planToken?: string };
      /**
       * Задача D шага 31: правка берёт ГОТОВЫЙ набор из задания экрана различий, а не считает его заново. Прежде задание
       * повторяло весь расчёт (`editBounds` в режиме предпросмотра по всему каталогу) только ради сверки токена — работа по
       * каталогу делалась дважды, 44 секунды вместо двадцати.
       *
       * Обещание «применяется ровно то, что было на экране» от этого не слабеет, а УСИЛИВАЕТСЯ: применяются те самые правки,
       * которые экран показал, вместе с границами, которые человек видел (`expected` у каждой). Изменилось что-то между
       * показом и применением — хранилище отвечает CONFLICT по этим самым `expected`, а не по пересчитанным.
       */
      const plan = p.planJobId ? await ctx.store.bulkJob(ctx.tenantId, p.planJobId) : null;
      const stored = (plan?.result as { edits?: BoundsEditInput[]; planToken?: string } | null) ?? null;
      if (plan === null || plan.kind !== 'BOUNDS_PLAN' || plan.status !== 'SUCCEEDED' || !stored?.edits) {
        throw Object.assign(new Error('no plan'), { cause: 'PLAN_CHANGED' });
      }
      if (p.planToken !== undefined && stored.planToken !== p.planToken) throw Object.assign(new Error('plan changed'), { cause: 'PLAN_CHANGED' });
      const edits = stored.edits;
      if (edits.length === 0) throw Object.assign(new Error('no scopes'), { cause: 'BAD_EDIT' });
      const actor = { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId };
      return {
        total: edits.length,
        async run(progress) {
          await progress(edits.length, 'APPLYING');
          const applied = await ctx.store.editBounds(ctx.tenantId, edits, actor, 'APPLY');
          if (applied.status !== 'APPLIED') {
            const cause = applied.status === 'INVALID' ? applied.cause
              : applied.status === 'MFA_REQUIRED' && applied.window === true ? 'MFA_REQUIRED_WINDOW' : applied.status;
            throw Object.assign(new Error(applied.status), { cause });
          }
          return { offers: applied.rows.length, changed: applied.rows.filter((r) => r.before.minMinor !== r.after.minMinor || r.before.maxMinor !== r.after.maxMinor).length };
        },
      };
    },

    /**
     * Экран различий массовой правки границ. Он тоже задание [Р-139]: расчёт идёт по всему каталогу, а не по странице, и
     * держать его в запросе значило бы ждать ответа секунды. Итог задания — и то, что человек читает (первые строки и числа),
     * и то, что потом применяется: набор правок с границами, которые он видел.
     */
    async BOUNDS_PLAN(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const world = await options.world(ctx);
      const request = parseBoundsEditRequest((job.params as { request: unknown }).request);
      if (!request) throw Object.assign(new Error('bad request'), { cause: 'BAD_REQUEST' });
      const { edits, problems } = expandBoundsEdit(world, request);
      if (problems.length > 0) throw Object.assign(new Error('bad edit'), { cause: 'BAD_EDIT' });
      const actor = { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId };
      return {
        total: edits.length,
        async run(progress) {
          await progress(0, 'PRODUCING');
          const preview = await ctx.store.editBounds(ctx.tenantId, edits, actor, 'PREVIEW');
          if (preview.status !== 'PREVIEWED') throw Object.assign(new Error(preview.status), { cause: preview.status === 'INVALID' ? preview.cause : preview.status });
          await progress(edits.length, 'PRODUCING');
          const view = boundsDiffView(world, edits, preview.rows, m);
          return {
            view: view as unknown as Record<string, unknown>, planToken: view.planToken,
            edits: edits as unknown as Record<string, unknown>, offers: edits.length,
          };
        },
      };
    },

    /**
     * Назначение стратегии. Предпросмотр и его токен остались на стороне экрана: это то, что человек видел, и сверить их надо
     * до создания задания. В задании — запись, которая растёт с каталогом: либо новая версия с назначением, либо назначение уже
     * существующей версии (OQ-169) — тем же видом задания, потому что для продавца это одна операция.
     */
    async STRATEGY_ASSIGN(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      // Шаг 99 [Р-225]: импорт стратегий — у предложений разные стратегии по имени, ровно по примерке
      if ('checkJobId' in job.params) {
        return applyImport('STRATEGY', job, ctx, async ({ plan }, run) => ctx.store.importStrategies(ctx.tenantId, {
          run,
          assignments: plan.changed.map((r) => ({ writeScopeId: r.target, strategyId: String(r.set.strategyId), version: Number(r.set.version) })),
          expected: plan.changed.map((r) => ({ writeScopeId: r.target, strategyId: (r.expected.strategyId ?? null) as string | null, version: (r.expected.version ?? null) as number | null })),
        }, actorOf(ctx)));
      }
      const m = messagesOfJob(job);
      const p = job.params as { draft?: unknown; strategyId?: string | null; version?: number; previewJobId?: string };
      /**
       * Предложения и их стратегии берутся ИЗ ПРЕДПРОСМОТРА, а не раскрываются заново. «Весь каталог», раскрытый в момент
       * работы задания, включил бы предложение, появившееся уже после предпросмотра: человек его не видел и не проверял
       * (находка 9 ревью шага 30). Заодно это и есть `expected` — стратегии на момент предпросмотра: сравнивать базу с самой
       * собой бессмысленно [Р-99], и хранилище отвечает CONFLICT, если за это время их поменял кто-то другой.
       */
      const preview = p.previewJobId ? await ctx.store.bulkJob(ctx.tenantId, p.previewJobId) : null;
      const expected = (preview?.result as { expected?: StrategyExpectation[] } | null)?.expected;
      if (!expected) throw Object.assign(new Error('no preview'), { cause: 'PREVIEW_CHANGED' });
      const ids = expected.map((e) => e.writeScopeId);
      if (ids.length === 0) throw Object.assign(new Error('no scopes'), { cause: 'BAD_SCOPES' });
      const actor = { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId };
      const parsed = p.version === undefined ? parseStrategyDraft(p.draft) : null;
      if (parsed && !parsed.ok) throw Object.assign(new Error('bad draft'), { cause: 'BAD_DRAFT' });
      return {
        total: ids.length,
        async run(progress) {
          await progress(ids.length, 'APPLYING');
          const saved = p.version !== undefined && typeof p.strategyId === 'string'
            ? await ctx.store.assignStrategyVersion(ctx.tenantId, { strategyId: p.strategyId, version: p.version, assignTo: ids, expected }, actor)
            : await ctx.store.saveStrategy(ctx.tenantId, {
              strategyId: p.strategyId ?? null, name: parsed!.draft.name, params: parsed!.draft.params,
              deadbandMinor: parsed!.draft.deadbandMinor, assignTo: ids, expected,
            }, actor);
          if (saved.status !== 'SAVED') throw Object.assign(new Error(saved.status), { cause: saved.status === 'INVALID' ? saved.cause : saved.status });
          return { offers: saved.assigned.length, strategyId: saved.strategy.strategyId, version: saved.strategy.version };
        },
      };
    },


    /**
     * OQ-201 (шаг 30): предпросмотр стратегии по ПОЛНОМУ каталогу. Шаг 29 считал его по выборке 500 предложений из 10 000 —
     * не потому, что человеку хватает выборки, а потому, что 10 000 решений не помещались в один ответ. Теперь это задание:
     * решение считается по каждому предложению, итоги — по всем, на экран идут первые строки.
     */
    async STRATEGY_PREVIEW(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const preview = options.previewStrategy;
      if (!preview) throw Object.assign(new Error('no preview'), { cause: 'UNKNOWN_JOB_KIND' });
      const p = job.params as { draft: unknown; writeScopeIds?: string[]; all?: boolean };
      const world = await options.world(ctx);
      const parsed = parseStrategyDraft(p.draft);
      if (!parsed.ok) throw Object.assign(new Error('bad draft'), { cause: 'BAD_DRAFT' });
      const byId = new Map(world.state.scopes.map((sc) => [sc.writeScopeId, sc]));
      const scopes = (p.all === true ? world.state.scopes.map((sc) => sc.writeScopeId) : (p.writeScopeIds ?? []))
        .map((id) => byId.get(id)).filter((sc): sc is ConsoleScope => sc !== undefined);
      if (scopes.length === 0) throw Object.assign(new Error('no scopes'), { cause: 'BAD_SCOPES' });
      const strategy: StrategyDefinition = { strategyId: 'draft', version: 1, ...parsed.draft };
      return {
        total: scopes.length,
        async run(progress) {
          const previews: StrategyPreview[] = [];
          for (const sc of scopes) {
            const one = await preview(ctx, sc, strategy);
            if (!one) throw Object.assign(new Error('scope vanished'), { cause: 'BAD_SCOPES' });
            previews.push(one);
            await progress(previews.length, 'PRODUCING');
          }
          const view = strategyPreviewView(world, parsed.draft, previews, m, scopes.length, STRATEGY_PREVIEW_ROWS_SHOWN);
          /**
           * Итог задания — сам экран предпросмотра: продавец читает его, а сохранение сверяется с ЭТИМ токеном, а не с новым
           * счётом. Вместе с ним записываются стратегии предложений НА МОМЕНТ предпросмотра: по ним назначение и отличает
           * «ничего не изменилось» от «пока считали, стратегию поменял кто-то другой» [находка 4 ревью шага 21].
           */
          return {
            view: view as unknown as Record<string, unknown>, previewToken: view.previewToken, offers: previews.length,
            expected: currentStrategies(world, scopes.map((sc) => sc.writeScopeId)) as unknown as Record<string, unknown>,
          };
        },
      };
    },
    /**
     * Шаг 34 [Р-149]: последний шаг пути — включить движок у НАБОРА предложений. По одному это делает `scopes/:id/enable`;
     * набор — массовая операция, а массовые операции — задания [Р-139]. Предложение, которое включить нельзя (нет
     * себестоимости, границ, стратегии), не роняет задание: оно называется в итоге поимённо с причиной, остальные включаются.
     * Это не «целиком или никак» — включение обратимо и по одному, и продавцу важнее знать, ЧТО не включилось.
     */
    /**
     * Шаг 35 [Р-152]: файл остатков продавца. Разбор байтов — тот же, что у себестоимости (кодировка, разделитель, XLSX);
     * смысл колонок — артикул и количество. Применение — инвентаризация внутреннего пула; затем пересчёт публикуемого
     * количества создаёт записи в каналы, которые отправит диспетчер [Р-64]. Итог — поимённо с причинами, как у себестоимости.
     */
    async STOCK_IMPORT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      if (!options.stock) fail('NOT_SUPPORTED');
      const stock = options.stock!;
      const sourceOf = async () => ((await ctx.store.bulkJob(ctx.tenantId, String((job.params as { checkJobId?: string }).checkJobId ?? '')))?.params as { stockSourceId?: string } | undefined)?.stockSourceId ?? '';
      /**
       * Шаг 99 [Р-224]: инвентаризация ровно по примерке — остатки сверяются с примеркой (CONFLICT — ничего), строка журнала той же
       * транзакцией. Пересчёт публикуемого количества — после, по ВСЕМ сопоставленным товарам файла, и при повторе задания тоже: задание,
       * убитое между инвентаризацией и пересчётом, иначе не пересчитало бы никогда (хаос CI 38957827994, шаг 97.2)
       */
      return applyImport('STOCK', job, ctx,
        async ({ plan }, run) => stock.applyStockImport(ctx.tenantId, await sourceOf(), {
          run, rows: plan.changed.map((r) => ({ productId: r.target, quantity: Number(r.set.quantity), expectedOnHand: (r.expected.onHand ?? null) as number | null })),
        }, { membershipId: ctx.membershipId, userId: ctx.userId, mfa: job.createdWithMfa, bulkJobId: ctx.jobId }),
        async ({ plan, world }) => {
          // Часы МИРА, а не стены процесса (находка 21 ревью шага 35): на виртуальных часах стенда стена — чужое время
          if (plan.matchedTargets.length > 0) await stock.recalculate(ctx.tenantId, plan.matchedTargets, world.now as never);
        });
    },

    /**
     * Шаг 35 [Р-139, Р-152]: включение синхронизации остатка — буфер аккаунта, единицы записи для всех предложений, первые
     * записи. На каталоге целевого клиента это 33 с одним запросом — массовая операция, значит задание.
     */
    async STOCK_SYNC_ENABLE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const p = job.params as { channelAccountId: string; bufferUnits: number; maxQuantity: number | null; minQuantityToList: number; acknowledgeSideEffects: boolean };
      if (!options.stock) throw Object.assign(new Error('no stock store'), { cause: 'NOT_SUPPORTED' });
      const stock = options.stock;
      return {
        total: Number(job.totalItems ?? 0),
        async run(progress) {
          await progress(0, 'APPLYING');
          const enabled = await stock.enableStockSync(ctx.tenantId, p.channelAccountId, { bufferUnits: p.bufferUnits, maxQuantity: p.maxQuantity, minQuantityToList: p.minQuantityToList, acknowledgeSideEffects: p.acknowledgeSideEffects === true },
            { membershipId: ctx.membershipId, userId: ctx.userId, mfa: job.createdWithMfa });
          if (enabled.status !== 'ENABLED') throw Object.assign(new Error(enabled.status), { cause: enabled.status });
          await progress(enabled.scopes, 'APPLYING');
          const recalculated = await stock.recalculate(ctx.tenantId, null, (await options.world(ctx)).now as never);
          const view = { scopes: enabled.scopes, created: enabled.created, awaitingAck: enabled.awaitingAck, writes: recalculated.writes.length };
          return { ...view, view };
        },
      };
    },

    async REPRICING_ENABLE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const p = job.params as { writeScopeIds?: string[]; all?: boolean };
      const world = await options.world(ctx);
      const chosen = p.all === true ? world.state.scopes : world.state.scopes.filter((s) => (p.writeScopeIds ?? []).includes(s.writeScopeId));
      if (!options.enableRepricing) throw Object.assign(new Error('no enabler'), { cause: 'NOT_SUPPORTED' });
      const enable = options.enableRepricing;
      return {
        total: chosen.length,
        async run(progress) {
          const m = messagesOfJob(job);
          const skipped: Array<{ writeScopeId: string; label: string; problems: string[]; reasons: string[] }> = [];
          let enabled = 0;
          let already = 0;
          for (const [i, scope] of chosen.entries()) {
            if (scope.pricingMode === 'ENGINE') { already += 1; }
            else {
              const result = await enable(ctx, scope);
              if (result.enabled) enabled += 1;
              else skipped.push({
                writeScopeId: scope.writeScopeId, label: unitOf(world, scope, m).label, problems: result.problems.map((x) => x.code),
                // Причина — словами словаря [Р-72], на языке, на котором человек создал задание
                reasons: result.problems.map((x) => describe({ code: x.code, params: (x.params ?? {}) as never }, m).text),
              });
            }
            if (i % PROGRESS_STEP === 0) await progress(i, 'APPLYING');
          }
          await progress(chosen.length, 'APPLYING');
          /**
           * Итог, который увидит продавец [Р-147: экрану отдаётся только `view`]. Без него задание говорило «не включено,
           * смотрите список» — а списка не было: первый живой прогон онбординга отказал всем 150 предложениям, и узнать
           * причину с экрана было нельзя. Причины сгруппированы по коду, поимённо — первые пятьдесят: с НАЗВАНИЕМ предложения
           * и причиной словами, а не идентификатором и кодом (ревью шага 34, находка 3).
           */
          const byCode: Record<string, number> = {};
          for (const s of skipped) for (const code of s.problems) byCode[code] = (byCode[code] ?? 0) + 1;
          const view: EnableResultView = {
            enabled, already, skipped: skipped.length,
            byCode: Object.entries(byCode).map(([code, count]) => ({ code, title: (m.titles as Record<string, string | undefined>)[code] ?? code, count }))
              .sort((a, b) => b.count - a.count),
            examples: skipped.slice(0, 50).map((s) => ({ writeScopeId: s.writeScopeId, label: s.label, reasons: s.reasons })),
          };
          return { enabled, already, skipped: skipped.length, view };
        },
      };
    },

    /**
     * Р-142 (шаг 31): выгрузка ленты цен. Экран отдаёт страницу не больше 200 записей — за 30 суток по каталогу их сотни
     * тысяч, и по страницам их никто не читает. Фильтр берётся тот же, что был на экране: файл не должен расходиться с
     * показанным.
     */
    async PRICE_FEED_EXPORT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const raw = (job.params as { query?: Record<string, string> }).query ?? {};
      const query = parseFeedQuery(new URLSearchParams(raw));
      if (!query) throw Object.assign(new Error('bad query'), { cause: 'BAD_REQUEST' });
      const world = await options.world(ctx);
      const now = world.now as never;
      const total = (await ctx.store.feedPage(ctx.tenantId, now, feedPageQuery({ ...query, offset: 0, limit: 1 }))).total;
      return {
        total,
        async run(progress, produce) {
          await progress(0, 'PRODUCING');
          /**
           * Р-154: страницы ленты берутся у базы по очереди — ни одна из них не держит всю ленту в памяти; строки из страницы
           * собирает модель экрана, файл из них делает исполнитель [Р-145]. Итог зафиксирован в момент старта: записи,
           * пришедшие во время выгрузки, в файл не попадают, и число строк совпадает с объявленным.
           */
          const rows: string[][] = [];
          for (let offset = 0; offset < total; offset += FEED_PAGE_MAX) {
            // `counts: false`: счётчики групп — подсчёт по ВСЕЙ ленте, и на каждой из сотен страниц это был бы тот же квадрат, что чинил шаг 31
            const page = await ctx.store.feedPage(ctx.tenantId, now, { ...feedPageQuery({ ...query, offset, limit: Math.min(FEED_PAGE_MAX, total - offset) }), counts: false });
            rows.push(...priceFeedRowsOf(world, m, page.items));
            await progress(rows.length, 'PRODUCING');
          }
          return { ...await produce({ fileName: priceFeedFileName(world, m, query), header: PRICE_FEED_CSV_HEADER, rows }) };
        },
      };
    },

    /**
     * Шаг 104 [Р-229]: выгрузка экрана — строки те же, что у экрана при тех же фильтрах и периоде (запрос к хранилищу сервер положил в
     * параметры задания), заголовки английские; XLSX — с листом «About this export». Больше 50 000 строк — отказ: файл не обрезается
     */
    async SCREEN_EXPORT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const p = job.params as unknown as ScreenExportParams & { timeZone?: unknown };
      if (!(EXPORT_SCREENS as readonly string[]).includes(p.screen) || !(EXPORT_FORMATS as readonly string[]).includes(p.format) || !p.query) {
        throw Object.assign(new Error('bad screen export'), { cause: 'BAD_REQUEST' });
      }
      const m = messagesOfJob(job);
      const timeZone = typeof p.timeZone === 'string' ? p.timeZone : null;
      let world: Promise<StandWorld> | null = null;
      const deps: ScreenExportDeps = {
        store: ctx.store, ...(options.stock ? { stock: options.stock } : {}), tenantId: ctx.tenantId, now: p.exportedAt,
        world: () => (world ??= options.world(ctx)), m, timeZone,
      };
      // Число строк — тем же запросом: данные могли вырасти после нажатия, и потолок держится и здесь
      const total = await screenExportCount(p, deps);
      if (total > EXPORT_MAX_ROWS) throw Object.assign(new Error('too many rows'), { cause: 'TOO_MANY_ROWS' });
      return {
        total,
        async run(progress, produce) {
          await progress(0, 'PRODUCING');
          const rows = await screenExportRows(p, deps, (n) => progress(Math.min(n, Math.max(total, n)), 'PRODUCING'));
          const about = exportAboutLines({ workspace: p.workspace, screen: p.screen, period: p.period, filters: p.filters, exportedBy: p.exportedBy,
            exportedAt: p.exportedAt, rows: rows.length, timeZone });
          return { ...await produce({
            fileName: exportFileName(p.workspace, p.screen, p.periodPart), header: EXPORT_HEADERS[p.screen], rows, format: p.format, numericColumns: EXPORT_NUMERIC_COLUMNS,
            ...(p.format === 'xlsx' ? { sheets: { data: 'Data', help: EXPORT_ABOUT_SHEET, helpLines: about } } : {}),
          }) };
        },
      };
    },

    /**
     * Доказательная история цен [Р-123, OQ-202]: файл готовится заданием и лежит в базе, а не едет в ответе экрана. Предел в
     * 100 000 строк, введённый шагом 29, больше не нужен — ждать нечего, продавец скачивает готовое.
     */
    async PRICE_EVIDENCE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesOfJob(job);
      const p = job.params as { from: string; to: string; writeScopeId?: string | null };
      const world = await options.world(ctx);
      return {
        total: world.state.scopes.length,
        async run(progress, produce) {
          await progress(0, 'PRODUCING');
          const days = await ctx.store.priceEvidence(ctx.tenantId, {
            from: p.from, to: p.to, ...(p.writeScopeId ? { writeScopeIds: [p.writeScopeId] } : {}),
          });
          // Ход считается в ТЕХ ЖЕ единицах, что объявлен объём задания, — в предложениях: «300000 из 10000» не читается никак
          return { ...await produce({
            fileName: `price-evidence_${p.from}_${p.to}.csv`,
            header: PRICE_EVIDENCE_HEADER, rows: priceEvidenceRows(world, days),
          }) };
        },
      };
    },
  };
}
