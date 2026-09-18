import type { DailyExportReport, DayRange, ExportGroup } from '@repracer/analytics-export';
import type { AdapterCallContext, ChannelAccountId, ChannelDescriptor, Instant, TenantId } from '@repracer/channel-port';
import { DEFAULT_LOSS_GRACE_SECONDS, type PricingPipeline } from '@repracer/pricing-pipeline';
import type { JobSource, JobSpec } from './scheduler.ts';

type JobAlert = { code: string; severity: 'WARNING' | 'CRITICAL'; details: Record<string, string | number | boolean | null> };

/**
 * Р-126 (шаг 25): работы планировщика. Работа по аккаунту появляется, только если канал её даёт (описание канала): ярусный опрос —
 * у канала с источником опроса для решения, сверка по кругу — у канала с источником только для сверки, проверка остановки выборкой —
 * у канала SAMPLE [Р-119], проверка потерь — у аккаунта со сверкой уведомлений [Р-121].
 * Частоты — допущения продукта, не лимиты каналов; лимиты держат ограничители адаптеров.
 */

export interface SchedulerAccount { tenantId: string; channelAccountId: string; channel: string }

export interface JobConfig {
  pollEverySeconds: number;
  /** Бюджет ярусного опроса на аккаунт, запросов в секунду: доля лимита Kaufland 111 rps на продавца [док] — допущение */
  pollBudgetRps: number;
  pollMaxQueries: number;
  lossReviewEverySeconds: number;
  /** Срок уведомления сверки — ДОПУЩЕНИЕ до замера K-10 и A-08 (OQ-175) */
  lossGraceSeconds: number;
  /**
   * getCompetitiveSummary: 0.033 rps, burst 1 [док] — вызов не чаще раза в 1/0.033 = 30,3 с, округлено вверх до 31 с, на ВСЕ аккаунты Amazon
   * приложения (лимит приложения не документирован, A-15). Было 30 с: в живом режиме (Р-128) каждый второй вызов отклонял ограничитель
   */
  amazonCallSeconds: number;
  amazonBatch: number;
  amazonCircleWarnHours: number;
  haltReviewEverySeconds: number;
  /** Обход офферов [Р-120] — раз в сутки, допущение (OQ-163) */
  discoveryEverySeconds: number;
  /** Выгрузка суток UTC — через 30 минут после конца суток; дни с непроверенными секциями — повторно за 13 суток (принудительное удаление — 14) */
  exportOffsetSeconds: number;
  exportLookbackDays: number;
  maintenanceEverySeconds: number;
}

export const DEFAULT_JOB_CONFIG: JobConfig = {
  pollEverySeconds: 60, pollBudgetRps: 10, pollMaxQueries: 600, lossReviewEverySeconds: 300, lossGraceSeconds: DEFAULT_LOSS_GRACE_SECONDS,
  amazonCallSeconds: 31, amazonBatch: 20, amazonCircleWarnHours: 24, haltReviewEverySeconds: 300, discoveryEverySeconds: 86_400,
  exportOffsetSeconds: 1_800, exportLookbackDays: 13, maintenanceEverySeconds: 3_600,
};

export interface JobDeps {
  /** Подключённые аккаунты всех тенантов — только идентификаторы (роль планировщика), данные тенантов не объединяются */
  accounts(): Promise<SchedulerAccount[]>;
  descriptorOf(channel: string): ChannelDescriptor | null;
  pipelineFor(account: SchedulerAccount): PricingPipeline;
  exportDay(range: DayRange, groups?: readonly ExportGroup[]): Promise<DailyExportReport>;
  /**
   * Ревью шага 25, находки 4, 5, 7: закрытые сутки за lookbackDays, секция которых не выгружена, не проверена или изменилась после проверки
   * (опоздавшие строки), — по группам таблиц; повторяется только группа, а не все таблицы суток
   */
  exportBacklog(now: Instant, lookbackDays: number): Promise<Array<{ group: ExportGroup; range: DayRange; reason: 'NOT_EXPORTED' | 'UNVERIFIED' | 'ROWS_CHANGED' }>>;
  /** Секции, удалённые принудительно без выгрузки с момента since (журнал удаления по сроку) */
  forceDroppedSince(since: Instant): Promise<string[]>;
  maintenance: {
    closePriceDays(now: Instant): Promise<number>;
    /** Р-29, OQ-192: пересчёт закрытых суток после опоздавшего подтверждения применения */
    correctClosedPriceDays(now: Instant): Promise<number>;
    ensurePartitions(now: Instant): Promise<void>;
    dropExpiredPartitions(now: Instant): Promise<number>;
    deleteExpiredRows(now: Instant): Promise<number>;
    /** Часы базы: журнал удаления по сроку пишет момент базы, а не планировщика */
    databaseNow(): Promise<Instant>;
  };
  /** Сверка уведомлений опросом включена для аккаунта [Р-121]; по умолчанию — если источник уведомлений канала доступен */
  reconcileEnabled?(account: SchedulerAccount, descriptor: ChannelDescriptor): boolean;
  config?: Partial<JobConfig>;
}

/** Что делает работа и что будет при её пропуске — для отчёта и экрана эксплуатации */
export interface JobCatalogEntry { name: string; scope: 'GLOBAL' | 'ACCOUNT'; when: string; missed: string }

export const JOB_CATALOG: JobCatalogEntry[] = [
  { name: 'competitor-poll', scope: 'ACCOUNT', when: 'каждые 60 с, товары по ярусам 120 с / 1 ч / 24 ч', missed: 'LATEST: следующий запуск опрашивает все товары, чей ярус истёк; решения по опросу задерживаются на время простоя' },
  { name: 'notification-loss-review', scope: 'ACCOUNT', when: 'каждые 5 мин', missed: 'LATEST: следующий запуск решает все просроченные проверки; вердикт ищет уведомление в журнале снимков, который хранится 3 суток после выгрузки (риск 26)' },
  { name: 'amazon-reconcile-rotation', scope: 'ACCOUNT', when: '31 с × число аккаунтов Amazon, аккаунты — со сдвигом на 31 с', missed: 'LATEST: окно круга — по числу успешных запусков; окно, отклонённое каналом, повторяется; пропуск не пропускает товары, круг сдвигается на время простоя' },
  { name: 'halt-review', scope: 'ACCOUNT', when: 'каждые 5 мин (каналы с выборкой)', missed: 'LATEST: остановка снимается позже' },
  { name: 'offer-discovery', scope: 'ACCOUNT', when: 'раз в сутки', missed: 'LATEST: чужое ценообразование нового оффера обнаружится при записи или следующем обходе' },
  { name: 'analytics-export-day', scope: 'GLOBAL', when: 'сутки UTC, в 00:30 следующих суток', missed: 'EVERY_SLOT: каждые пропущенные сутки выгружаются по очереди; провалившиеся, непроверенные и изменившиеся после проверки сутки повторяются каждым запуском из отставания (13 суток); секции журнала не удаляются без проверенной выгрузки; отставание CRITICAL — с 72 часов, принудительное удаление через 14 суток — CRITICAL ANALYTICS_PARTITION_FORCE_DROPPED' },
  { name: 'price-days-close', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: функция закрывает все незакрытые сутки по очереди; сырьё цен не удаляется, пока сутки не закрыты' },
  { name: 'partitions', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: секции созданы на 3 суток вперёд; простой дольше — отказ записи снимков и цен (CRITICAL через 2 суток)' },
  { name: 'retention', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: удаление по сроку откладывается, данные хранятся дольше — PostgreSQL растёт' },
];

const hours = (h: number) => h * 3600;
const failuresShareAlert = 0.2;
const alignedDay = (now: Instant, offsetSeconds: number): Instant => {
  const t = Date.parse(now);
  const day = Math.floor(t / 86_400_000) * 86_400_000 + offsetSeconds * 1000;
  return new Date(day <= t ? day : day - 86_400_000).toISOString();
};

export function jobSource(deps: JobDeps): JobSource {
  const cfg = { ...DEFAULT_JOB_CONFIG, ...deps.config };
  const reconcileEnabled = deps.reconcileEnabled ?? ((_a, d) => (d.competitorSources ?? []).some((s) => s.kind === 'PUSH' && s.availability === 'AVAILABLE'));
  // Срок вызова — от начала запуска работы, не такта: работы такта идут по очереди (ревью шага 25, находка 1)
  const ctxOf = (a: SchedulerAccount, startedAt: Instant, job: string, seconds: number): AdapterCallContext => ({
    tenantId: a.tenantId as TenantId, channelAccountId: a.channelAccountId as ChannelAccountId, correlationId: `scheduler:${job}:${startedAt}`,
    deadline: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(),
  });
  const pollSeconds = Math.ceil(cfg.pollMaxQueries / Math.max(0.1, cfg.pollBudgetRps)) + 60;

  return {
    async jobs(now) {
      const specs: JobSpec[] = [];
      const immediately = () => now;

      // Глобальные работы
      specs.push({
        name: 'analytics-export-day', scope: null, retryKind: 'INTERNAL', intervalSeconds: 86_400, catchUp: 'EVERY_SLOT', firstDueAt: (n) => alignedDay(n, cfg.exportOffsetSeconds),
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(72), leaseSeconds: hours(2),
        /**
         * Сутки слота — все группы; отставшие сутки (не выгружены, не проверены, изменились после проверки) — только их группы. Провал одних
         * суток не держит слот: остальные сутки выгружаются, провалившиеся повторяются следующим запуском из отставания (ревью шага 25, находка 7).
         * Отставание старше 72 часов — CRITICAL: принудительное удаление через 14 суток
         */
        async run({ slotAt }) {
          const to = Date.parse(slotAt) - cfg.exportOffsetSeconds * 1000;
          const slotRange = { from: new Date(to - 86_400_000).toISOString(), to: new Date(to).toISOString() };
          const work = new Map<string, { range: DayRange; groups: Set<ExportGroup>; slot: boolean }>([[slotRange.from, { range: slotRange, groups: new Set(['DECISIONS', 'WRITES', 'SNAPSHOTS']), slot: true }]]);
          for (const b of await deps.exportBacklog(slotAt, cfg.exportLookbackDays)) {
            if (Date.parse(b.range.to) > to) continue;
            const w = work.get(b.range.from) ?? { range: b.range, groups: new Set<ExportGroup>(), slot: false };
            w.groups.add(b.group);
            work.set(b.range.from, w);
          }
          let items = 0;
          const unverified: string[] = [];
          const missing: string[] = [];
          const failed: string[] = [];
          for (const w of [...work.values()].sort((a, b) => a.range.from.localeCompare(b.range.from))) {
            for (const group of w.groups) {
              try {
                const r = await deps.exportDay(w.range, [group]);
                items += r.exports.reduce((n, e) => n + e.rows, 0);
                unverified.push(...r.unverified);
                // Секции нет: для суток слота — удалена или не создана; у отставших суток секция была найдена списком отставания
                missing.push(...r.missing.map((m) => `${m}@${w.range.from.slice(0, 10)}`));
              } catch (error) {
                failed.push(`${group}@${w.range.from.slice(0, 10)}: ${String((error as Error).message).slice(0, 80)}`);
              }
            }
          }
          const backlog = await deps.exportBacklog(new Date(to + cfg.exportOffsetSeconds * 1000).toISOString(), cfg.exportLookbackDays);
          const oldest = backlog.reduce<number | null>((m, b) => (m === null || Date.parse(b.range.to) < m ? Date.parse(b.range.to) : m), null);
          const backlogHours = oldest === null ? 0 : (Date.parse(slotAt) - oldest) / 3_600_000;
          const alerts: JobAlert[] = [
            ...(failed.length ? [{ code: 'ANALYTICS_EXPORT_FAILED', severity: 'CRITICAL' as const, details: { failed: failed.slice(0, 5).join(' | '), count: failed.length } }] : []),
            ...(unverified.length ? [{ code: 'ANALYTICS_EXPORT_UNVERIFIED', severity: 'CRITICAL' as const, details: { partitions: unverified.slice(0, 10).join(','), count: unverified.length } }] : []),
            ...(missing.length ? [{ code: 'ANALYTICS_EXPORT_PARTITION_MISSING', severity: 'CRITICAL' as const, details: { partitions: missing.slice(0, 10).join(','), count: missing.length } }] : []),
            ...(backlog.length ? [{ code: 'ANALYTICS_EXPORT_BACKLOG', severity: backlogHours >= 72 ? 'CRITICAL' as const : 'WARNING' as const,
              details: { days: new Set(backlog.map((b) => b.range.from)).size, oldestHours: Math.round(backlogHours) } }] : []),
          ];
          return { items, ...(alerts.length ? { alerts } : {}) };
        },
      });
      specs.push({
        name: 'price-days-close', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(3), lagCriticalSeconds: hours(24), leaseSeconds: 1800,
        async run({ now: n }) {
          const days = await deps.maintenance.closePriceDays(n);
          // Шаг 27, D [Р-29, риск 34, OQ-192]: подтверждение применения приходит позже закрытия суток — закрытые сутки пересчитываются
          // строкой-поправкой той же работой, сразу после закрытия
          const corrections = await deps.maintenance.correctClosedPriceDays(n);
          return { items: days + corrections };
        },
      });
      specs.push({
        name: 'partitions', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(48), leaseSeconds: 600,
        async run({ now: n }) { await deps.maintenance.ensurePartitions(n); return { items: 0 }; },
      });
      specs.push({
        name: 'retention', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(168), leaseSeconds: 1800,
        async run({ now: n }) {
          const mark = await deps.maintenance.databaseNow();
          const items = (await deps.maintenance.dropExpiredPartitions(n)) + (await deps.maintenance.deleteExpiredRows(n));
          // Ревью шага 25, находка 5: принудительное удаление невыгруженной секции — потеря истории, алерт
          const dropped = await deps.forceDroppedSince(mark);
          return { items, ...(dropped.length ? { alerts: [{ code: 'ANALYTICS_PARTITION_FORCE_DROPPED', severity: 'CRITICAL' as const, details: { partitions: dropped.slice(0, 10).join(','), count: dropped.length } }] } : {}) };
        },
      });

      // Работы по аккаунтам
      const accounts = await deps.accounts();
      const rotationAccounts = accounts.filter((a) => (deps.descriptorOf(a.channel)?.competitorSources ?? []).some((s) => s.kind === 'PULL' && s.role === 'RECONCILIATION' && s.availability === 'AVAILABLE'));
      for (const a of accounts) {
        const d = deps.descriptorOf(a.channel);
        if (!d) continue;
        const scope = { tenantId: a.tenantId, channelAccountId: a.channelAccountId };
        const pipeline = () => deps.pipelineFor(a);
        const reconcile = reconcileEnabled(a, d);
        if ((d.competitorSources ?? []).some((s) => s.kind === 'PULL' && s.role === 'PRIMARY' && s.availability === 'AVAILABLE')) {
          specs.push({
            name: 'competitor-poll', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.pollEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 600, lagCriticalSeconds: hours(1), leaseSeconds: 300,
            async run({ startedAt }) {
              const r = await pipeline().pollDueCompetitors(ctxOf(a, startedAt, 'competitor-poll', pollSeconds),
                { budgetRequestsPerSecond: cfg.pollBudgetRps, maxQueries: cfg.pollMaxQueries, ...(reconcile ? { reconcile: { graceSeconds: cfg.lossGraceSeconds } } : {}) });
              // Ревью шага 25, находка 1: отказы канала и сбои обработки не прячутся за успешным запуском
              const failed = r.failures.length + r.processingFailed;
              const alerts: JobAlert[] = [
                ...(r.plan.coldTierExceedsBudget ? [{ code: 'COMPETITOR_POLL_BUDGET_EXCEEDED', severity: 'WARNING' as const, details: { candidates: r.candidates, demoted: r.plan.demoted } }] : []),
                ...(r.due > 0 && failed / r.due > failuresShareAlert ? [{ code: 'COMPETITOR_POLL_FAILURES', severity: 'WARNING' as const, details: {
                  due: r.due, channelFailures: r.failures.length, processingFailures: r.processingFailed, firstError: r.failures[0]?.error.code ?? 'PROCESSING' } }] : []),
              ];
              return { items: r.due - failed, ...(alerts.length ? { alerts } : {}) };
            },
          });
        }
        if (reconcile) {
          specs.push({
            // Р-133 (ревью шага 28, находка 20): сверка потерь читает принятое состояние и ставит вердикт в базе (0088), в канал не
            // ходит — значит лимитов канала у неё нет и повтор у неё внутренний
            name: 'notification-loss-review', scope, retryKind: 'INTERNAL', intervalSeconds: cfg.lossReviewEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 1800, lagCriticalSeconds: hours(3), leaseSeconds: 300,
            async run({ startedAt }) {
              const r = await pipeline().reviewNotificationLoss(ctxOf(a, startedAt, 'notification-loss-review', 50));
              return { items: r.delayed + r.lossSuspected.length };
            },
          });
        }
        if (reconcile && rotationAccounts.includes(a)) {
          // Лимит вызова делят все аккаунты Amazon приложения: темп на аккаунт — 31 с × число аккаунтов (OQ-176); первый запуск аккаунта
          // сдвинут на 31 с × его номер — иначе все аккаунты начинают в одном такте и отклоняются ограничителем приложения
          const interval = Math.ceil(cfg.amazonCallSeconds * rotationAccounts.length);
          const offsetMs = rotationAccounts.indexOf(a) * cfg.amazonCallSeconds * 1000;
          specs.push({
            name: 'amazon-reconcile-rotation', scope, retryKind: 'CHANNEL', intervalSeconds: interval, catchUp: 'LATEST', firstDueAt: (n) => new Date(Date.parse(n) + offsetMs).toISOString(),
            lagWarningSeconds: interval * 10, lagCriticalSeconds: Math.max(hours(3), interval * 60), leaseSeconds: 120,
            async run({ startedAt, runIndex }) {
              const r = await pipeline().reconcileRotation(ctxOf(a, startedAt, 'amazon-reconcile-rotation', 50), { size: cfg.amazonBatch, cycle: runIndex, graceSeconds: cfg.lossGraceSeconds });
              // Шаг 26 (живой режим, Р-128): окно, которое канал отдал не целиком, — провал запуска: номер окна не сдвигается, окно
              // повторяется. Иначе отклонённые товары пропускались в каждом круге и не сверялись ни разу (ревью шага 26, находка 9а)
              if (r.failures.length > 0) throw new Error(`${r.failures[0]?.error.code ?? 'CHANNEL_FAILED'}: reconciliation window ${runIndex} read ${r.queries - r.failures.length} of ${r.queries}`);
              const circleHours = (Math.ceil(r.total / cfg.amazonBatch) * interval) / 3600;
              return {
                items: r.queries,
                ...(circleHours > cfg.amazonCircleWarnHours ? { alerts: [{ code: 'AMAZON_RECONCILIATION_CIRCLE_SLOW', severity: 'WARNING' as const, details: { offers: r.total, circleHours: Math.round(circleHours * 10) / 10, accounts: rotationAccounts.length } }] } : {}),
              };
            },
          });
        }
        if (d.haltRelease.kind === 'SAMPLE') {
          specs.push({
            name: 'halt-review', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.haltReviewEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 1800, lagCriticalSeconds: hours(6), leaseSeconds: 300,
            async run({ startedAt }) { return { items: (await pipeline().reviewHalts(ctxOf(a, startedAt, 'halt-review', 120))).length }; },
          });
        }
        specs.push({
          name: 'offer-discovery', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.discoveryEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
          lagWarningSeconds: hours(36), lagCriticalSeconds: hours(72), leaseSeconds: 1800,
          async run({ startedAt }) {
            const r = await pipeline().discoverOffers(ctxOf(a, startedAt, 'offer-discovery', 1500));
            return { items: r.offers };
          },
        });
      }
      return specs;
    },
  };
}
