import { buildPreview, readTable, suggestMapping, type ColumnMapping, type TableEncoding } from '@repracer/cost-import';
import {
  boundsDiffView, costImportView, currentStrategies, expandBoundsEdit, importTargets, messagesFor, parseBoundsEditRequest,
  parseStrategyDraft, PRICE_EVIDENCE_HEADER, priceEvidenceRows, strategyPreviewView, STRATEGY_PREVIEW_ROWS_SHOWN, LOCALES,
  COST_IMPORT_REPORT_HEADER, costImportReportRows, parseFeedQuery, PRICE_FEED_CSV_HEADER, priceFeedFileName, priceFeedRowsOf, feedPageQuery, FEED_PAGE_MAX,
  describe, unitOf, type ConsoleScope, type EnableResultView, type Locale, type StandWorld,
} from '@repracer/console-model';
import type { StrategyDefinition } from '@repracer/pricing-model';

/** Стратегия предложения на момент предпросмотра — как её ждёт хранилище */
type StrategyExpectation = { writeScopeId: string; strategyId: string | null; version: number | null };
import type { BoundsEditInput, BulkJobRow, StrategyPreview } from '@repracer/pricing-pipeline';
import { parseStockSheet, type StockStore } from '@repracer/stock-sync';
import type { BulkJobContext, BulkJobHandlers, BulkJobWork } from './index.ts';
import type { BulkJobPhase } from '@repracer/pricing-pipeline';

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
      // Выбор продавца сильнее подсказки, а null — «этой колонки в файле нет»: подсказка снимается так же явно, как ставится
      const mapping = { ...suggested.mapping };
      for (const [field, index] of Object.entries((p.mapping ?? {}) as Record<string, unknown>)) {
        if (index === null) delete mapping[field as keyof typeof mapping];
        else if (typeof index === 'number' && Number.isSafeInteger(index) && index >= 0) mapping[field as keyof typeof mapping] = index;
      }
      const world = await options.world(ctx);
      const offers = importTargets(world, m);
      const preview = buildPreview({ sheet, mapping, offers });
      const view = costImportView(world, preview, { name: p.fileName, sheet, mapping }, suggested.suggestions, m);
      return {
        total: preview.apply.length + preview.skipped.length,
        async run(progress, produce) {
          // Ход разбора: продавец видит, что файл читается, а не что «ничего не происходит»
          for (let done = 0; done < preview.apply.length; done += PROGRESS_STEP) await progress(Math.min(done, preview.apply.length));
          if (p.fingerprint !== undefined && p.fingerprint !== preview.fingerprint) throw Object.assign(new Error('plan changed'), { cause: 'PLAN_CHANGED' });
          if (preview.blocked) throw Object.assign(new Error('blocked'), { cause: 'COLUMNS_MISSING' });
          if (preview.apply.length === 0) throw Object.assign(new Error('no rows'), { cause: 'NO_ROWS' });
          /**
           * Отчёт об импорте пишется ДО применения (находка 13 ревью шага 31). Он описывает предпросмотр и известен заранее, а
           * писать его ПОСЛЕ значило расширить окно между «в базе уже применено» и «задание об этом знает»: процесс, убитый в
           * этом окне, оставлял бы применённую себестоимость при задании, которое говорит «в базе ничего не изменено».
           */
          if (preview.skipped.length > 0) {
            await produce({
              fileName: `import-report_${p.fileName}`,
              header: COST_IMPORT_REPORT_HEADER, rows: costImportReportRows(preview, m),
            });
          }
          await progress(preview.apply.length, 'APPLYING');
          const applied = await ctx.store.importCosts(ctx.tenantId, {
            sourceName: p.fileName, sourceFormat: sheet.format, fingerprint: preview.fingerprint, skippedRows: preview.totals.skipped,
            rows: preview.apply.map((r) => ({
              writeScopeId: r.writeScopeId!, unitCostMinor: r.unitCostMinor!, currency: r.currency!,
              ...(r.fixedFeeMinor === undefined ? {} : { fixedFeeMinor: r.fixedFeeMinor }),
              ...(r.feeRateBp === undefined ? {} : { feeRateBp: r.feeRateBp }),
            })),
          }, { membershipId: ctx.membershipId, userId: ctx.userId, mfa: false, bulkJobId: ctx.jobId }, 'APPLY');
          /**
           * OQ-196 (шаг 33): окно массовой правки [Р-135] и массовая правка — РАЗНЫЕ отказы, и продавцу нужен разный совет.
           * Окно срабатывает и на правке ОДНОГО предложения, если за последние десять минут их было больше пяти.
           */
          if (applied.status !== 'APPLIED') {
            const cause = applied.status === 'INVALID' ? applied.cause
              : applied.status === 'MFA_REQUIRED' && applied.window === true ? 'MFA_REQUIRED_WINDOW' : applied.status;
            throw Object.assign(new Error(applied.status), { cause });
          }
          /**
           * Р-142 (шаг 31): отчёт об импорте — ФАЙЛ, а не пять примеров на экране. На выгрузке в 10 000 строк с 1430
           * несопоставленными продавец по экрану не поймёт, какие строки чинить; с файлом он правит свою выгрузку и ввозит
           * снова.
           */
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
      const m = messagesFor(localeOf(job));
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
      const m = messagesFor(localeOf(job));
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
      const m = messagesFor(localeOf(job));
      const p = job.params as { fileName: string; content: string; stockSourceId: string; encoding?: TableEncoding };
      if (!options.stock) throw Object.assign(new Error('no stock store'), { cause: 'NOT_SUPPORTED' });
      const stock = options.stock;
      const sheet = readTable(Buffer.from(p.content, 'base64'), p.encoding);
      const parsed = parseStockSheet(sheet.rows);
      if ('code' in parsed) throw Object.assign(new Error(parsed.code), { cause: parsed.code });
      return {
        total: parsed.rows.length,
        async run(progress) {
          await progress(0, 'APPLYING');
          const applied = await stock.importStock(ctx.tenantId, p.stockSourceId, parsed.rows, { membershipId: ctx.membershipId, userId: ctx.userId, mfa: job.createdWithMfa });
          if (applied.status !== 'APPLIED') throw Object.assign(new Error(applied.status), { cause: applied.status });
          await progress(parsed.rows.length, 'APPLYING');
          const recalculated = applied.productIds.length > 0 ? await stock.recalculate(ctx.tenantId, applied.productIds, new Date().toISOString() as never) : { writes: [], unchanged: 0 };
          const unmatched = [...parsed.skipped.map((s) => ({ sku: s.sku, reason: s.reason })), ...applied.unmatched];
          const byReason: Record<string, number> = {};
          for (const u of unmatched) byReason[u.reason] = (byReason[u.reason] ?? 0) + 1;
          const view = {
            matched: applied.matched, changed: applied.changed, unmatched: unmatched.length, writes: recalculated.writes.length,
            byReason: Object.entries(byReason).map(([reason, count]) => ({ reason, title: (m.ui.stock.importFile.unmatched as Record<string, string>)[reason] ?? reason, count })),
            examples: unmatched.slice(0, 50),
          };
          return { matched: applied.matched, changed: applied.changed, unmatched: unmatched.length, writes: recalculated.writes.length, view };
        },
      };
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
          const recalculated = await stock.recalculate(ctx.tenantId, null, new Date().toISOString() as never);
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
          const m = messagesFor(localeOf(job));
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
      const m = messagesFor(localeOf(job));
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
     * Доказательная история цен [Р-123, OQ-202]: файл готовится заданием и лежит в базе, а не едет в ответе экрана. Предел в
     * 100 000 строк, введённый шагом 29, больше не нужен — ждать нечего, продавец скачивает готовое.
     */
    async PRICE_EVIDENCE(job: BulkJobRow, ctx: BulkJobContext): Promise<BulkJobWork> {
      const m = messagesFor(localeOf(job));
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
