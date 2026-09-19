import { buildPreview, readTable, suggestMapping, type ColumnMapping, type TableEncoding } from '@repracer/cost-import';
import {
  boundsDiffView, costImportView, currentStrategies, expandBoundsEdit, importTargets, messagesFor, parseBoundsEditRequest,
  parseStrategyDraft, priceEvidenceCsv, strategyPreviewView, STRATEGY_PREVIEW_ROWS_SHOWN, LOCALES,
  type ConsoleScope, type Locale, type StandWorld,
} from '@repracer/console-model';
import type { StrategyDefinition } from '@repracer/pricing-model';

/** Стратегия предложения на момент предпросмотра — как её ждёт хранилище */
type StrategyExpectation = { writeScopeId: string; strategyId: string | null; version: number | null };
import type { BulkJobRow, StrategyPreview } from '@repracer/pricing-pipeline';
import { sha256, type BulkJobContext, type BulkJobHandlers, type BulkJobWork } from './index.ts';

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
}

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

export function bulkJobHandlers(options: BulkJobWorldOptions): BulkJobHandlers {
  return {
    /** Импорт себестоимости: разбор файла с видимым ходом, затем применение одной транзакцией [Р-134] */
    async COST_IMPORT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesFor(localeOf(job));
      const p = job.params as { fileName: string; content: string; mapping?: ColumnMapping; encoding?: TableEncoding; fingerprint?: string };
      const sheet = readTable(Buffer.from(p.content, 'base64'), p.encoding);
      const suggested = suggestMapping(sheet);
      const mapping = { ...suggested.mapping, ...(p.mapping ?? {}) };
      const world = await options.world(ctx);
      const offers = importTargets(world, m);
      const preview = buildPreview({ sheet, mapping, offers });
      const view = costImportView(world, preview, { name: p.fileName, sheet, mapping }, suggested.suggestions, m);
      return {
        total: preview.apply.length + preview.skipped.length,
        async run(progress) {
          // Ход разбора: продавец видит, что файл читается, а не что «ничего не происходит»
          for (let done = 0; done < preview.apply.length; done += PROGRESS_STEP) await progress(Math.min(done, preview.apply.length));
          if (p.fingerprint !== undefined && p.fingerprint !== preview.fingerprint) throw Object.assign(new Error('plan changed'), { cause: 'PLAN_CHANGED' });
          if (preview.blocked) throw Object.assign(new Error('blocked'), { cause: 'COLUMNS_MISSING' });
          if (preview.apply.length === 0) throw Object.assign(new Error('no rows'), { cause: 'NO_ROWS' });
          await progress(preview.apply.length, 'APPLYING');
          const applied = await ctx.store.importCosts(ctx.tenantId, {
            sourceName: p.fileName, sourceFormat: sheet.format, fingerprint: preview.fingerprint, skippedRows: preview.totals.skipped,
            rows: preview.apply.map((r) => ({
              writeScopeId: r.writeScopeId!, unitCostMinor: r.unitCostMinor!, currency: r.currency!,
              ...(r.fixedFeeMinor === undefined ? {} : { fixedFeeMinor: r.fixedFeeMinor }),
              ...(r.feeRateBp === undefined ? {} : { feeRateBp: r.feeRateBp }),
            })),
          }, { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId }, 'APPLY');
          if (applied.status !== 'APPLIED') throw Object.assign(new Error(applied.status), { cause: applied.status === 'INVALID' ? applied.cause : applied.status });
          return {
            rows: applied.rows, offers: applied.offers, skipped: preview.totals.skipped,
            offersMissing: preview.totals.offersMissing, headline: view.headline,
            problems: view.skipped.map((g) => ({ problem: g.problem, rows: g.rows })),
          };
        },
      };
    },

    /**
     * Правка границ. Экран различий строит САМО задание и сверяет его с токеном того экрана, который видел человек: иначе
     * пересчёт различий по каталогу (10 000 предложений) остался бы в синхронном запросе — ровно то, от чего уходит Р-139.
     */
    async BOUNDS_EDIT(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesFor(localeOf(job));
      const p = job.params as { request: unknown; planToken?: string };
      const world = await options.world(ctx);
      const request = parseBoundsEditRequest(p.request);
      if (!request) throw Object.assign(new Error('bad request'), { cause: 'BAD_REQUEST' });
      const { edits, problems } = expandBoundsEdit(world, request);
      if (problems.length > 0) throw Object.assign(new Error('bad edit'), { cause: 'BAD_EDIT' });
      const actor = { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId };
      return {
        total: edits.length,
        async run(progress) {
          await progress(0, 'PREPARING');
          const preview = await ctx.store.editBounds(ctx.tenantId, edits, actor, 'PREVIEW');
          if (preview.status !== 'PREVIEWED') throw Object.assign(new Error(preview.status), { cause: preview.status === 'INVALID' ? preview.cause : preview.status });
          // Применяется ровно то, что видел человек: набор изменился — задание отказывает, а не применяет другое
          if (p.planToken !== undefined && boundsDiffView(world, edits, preview.rows, m).planToken !== p.planToken) {
            throw Object.assign(new Error('plan changed'), { cause: 'PLAN_CHANGED' });
          }
          await progress(edits.length, 'APPLYING');
          const applied = await ctx.store.editBounds(ctx.tenantId, edits, actor, 'APPLY');
          if (applied.status !== 'APPLIED') {
            throw Object.assign(new Error(applied.status), { cause: applied.status === 'INVALID' ? applied.cause : applied.status });
          }
          return { offers: applied.rows.length, changed: applied.rows.filter((r) => r.before.minMinor !== r.after.minMinor || r.before.maxMinor !== r.after.maxMinor).length };
        },
      };
    },

    /**
     * Назначение стратегии. Предпросмотр и его токен остались на стороне экрана: это то, что человек видел, и сверить их надо
     * до создания задания. В задании — запись, которая растёт с каталогом: либо новая версия с назначением, либо назначение уже
     * существующей версии (OQ-169) — тем же видом задания, потому что для продавца это одна операция.
     */
    async STRATEGY_ASSIGN(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesFor(localeOf(job));
      const p = job.params as { draft?: unknown; writeScopeIds?: string[]; all?: boolean; strategyId?: string | null; version?: number; previewJobId?: string };
      const world = await options.world(ctx);
      const ids = p.all === true ? world.state.scopes.map((s) => s.writeScopeId) : (p.writeScopeIds ?? []);
      if (ids.length === 0) throw Object.assign(new Error('no scopes'), { cause: 'BAD_SCOPES' });
      /**
       * Стратегии, которые человек видел в предпросмотре. Не «действующие сейчас»: тогда проверка сравнивала бы базу с самой
       * собой и не поймала бы ничего [Р-99]. Изменились со времени предпросмотра — хранилище отвечает CONFLICT.
       */
      const preview = p.previewJobId ? await ctx.store.bulkJob(ctx.tenantId, p.previewJobId) : null;
      const expected = (preview?.result as { expected?: StrategyExpectation[] } | null)?.expected;
      if (!expected) throw Object.assign(new Error('no preview'), { cause: 'PREVIEW_CHANGED' });
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
      const m = messagesFor(localeOf(job));
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
     * Доказательная история цен [Р-123, OQ-202]: файл готовится заданием и лежит в базе, а не едет в ответе экрана. Предел в
     * 100 000 строк, введённый шагом 29, больше не нужен — ждать нечего, продавец скачивает готовое.
     */
    async PRICE_EVIDENCE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesFor(localeOf(job));
      const p = job.params as { from: string; to: string; writeScopeId?: string | null };
      const world = await options.world(ctx);
      return {
        total: world.state.scopes.length,
        async run(progress) {
          await progress(0, 'PRODUCING');
          const days = await ctx.store.priceEvidence(ctx.tenantId, {
            from: p.from, to: p.to, ...(p.writeScopeId ? { writeScopeIds: [p.writeScopeId] } : {}),
          });
          await progress(world.state.scopes.length, 'PRODUCING');
          const csv = priceEvidenceCsv(world, days);
          await ctx.store.saveBulkJobArtifact(ctx.tenantId, ctx.jobId, {
            fileName: `price-evidence_${p.from}_${p.to}.csv`, contentType: 'text/csv', content: csv, sha256: sha256(csv), rows: days.length,
          });
          return { rows: days.length, bytes: Buffer.byteLength(csv, 'utf8'), sha256: sha256(csv) };
        },
      };
    },
  };
}
