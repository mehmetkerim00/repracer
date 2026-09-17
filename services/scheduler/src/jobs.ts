import type { DailyExportReport, DayRange } from '@repracer/analytics-export';
import type { AdapterCallContext, ChannelAccountId, ChannelDescriptor, Instant, TenantId } from '@repracer/channel-port';
import { DEFAULT_LOSS_GRACE_SECONDS, type PricingPipeline } from '@repracer/pricing-pipeline';
import type { JobSource, JobSpec } from './scheduler.ts';

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
  /** getCompetitiveSummary: 0.033 rps, burst 1 [док] — вызов раз в 30 с на ВСЕ аккаунты Amazon приложения (лимит приложения не документирован, A-15) */
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
  amazonCallSeconds: 30, amazonBatch: 20, amazonCircleWarnHours: 24, haltReviewEverySeconds: 300, discoveryEverySeconds: 86_400,
  exportOffsetSeconds: 1_800, exportLookbackDays: 13, maintenanceEverySeconds: 3_600,
};

export interface JobDeps {
  /** Подключённые аккаунты всех тенантов — только идентификаторы (роль планировщика), данные тенантов не объединяются */
  accounts(): Promise<SchedulerAccount[]>;
  descriptorOf(channel: string): ChannelDescriptor | null;
  pipelineFor(account: SchedulerAccount): PricingPipeline;
  exportDay(range: DayRange): Promise<DailyExportReport>;
  /** Сутки с невыгруженными или непроверенными секциями за lookbackDays до now */
  unverifiedDays(now: Instant, lookbackDays: number): Promise<DayRange[]>;
  maintenance: {
    closePriceDays(now: Instant): Promise<number>;
    ensurePartitions(now: Instant): Promise<void>;
    dropExpiredPartitions(now: Instant): Promise<number>;
    deleteExpiredRows(now: Instant): Promise<number>;
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
  { name: 'amazon-reconcile-rotation', scope: 'ACCOUNT', when: '30 с × число аккаунтов Amazon', missed: 'LATEST: окно круга — по числу успешных запусков, пропуск не пропускает товары, круг сдвигается на время простоя' },
  { name: 'halt-review', scope: 'ACCOUNT', when: 'каждые 5 мин (каналы с выборкой)', missed: 'LATEST: остановка снимается позже' },
  { name: 'offer-discovery', scope: 'ACCOUNT', when: 'раз в сутки', missed: 'LATEST: чужое ценообразование нового оффера обнаружится при записи или следующем обходе' },
  { name: 'analytics-export-day', scope: 'GLOBAL', when: 'сутки UTC, в 00:30 следующих суток', missed: 'EVERY_SLOT: каждые пропущенные сутки выгружаются по очереди; секции журнала не удаляются без проверенной выгрузки; принудительное удаление через 14 суток — CRITICAL-отставание раньше (3 суток)' },
  { name: 'price-days-close', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: функция закрывает все незакрытые сутки по очереди; сырьё цен не удаляется, пока сутки не закрыты' },
  { name: 'partitions', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: секции созданы на 3 суток вперёд; простой дольше — отказ записи снимков и цен (CRITICAL через 2 суток)' },
  { name: 'retention', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: удаление по сроку откладывается, данные хранятся дольше — PostgreSQL растёт' },
];

const hours = (h: number) => h * 3600;
const alignedDay = (now: Instant, offsetSeconds: number): Instant => {
  const t = Date.parse(now);
  const day = Math.floor(t / 86_400_000) * 86_400_000 + offsetSeconds * 1000;
  return new Date(day <= t ? day : day - 86_400_000).toISOString();
};

export function jobSource(deps: JobDeps): JobSource {
  const cfg = { ...DEFAULT_JOB_CONFIG, ...deps.config };
  const reconcileEnabled = deps.reconcileEnabled ?? ((_a, d) => (d.competitorSources ?? []).some((s) => s.kind === 'PUSH' && s.availability === 'AVAILABLE'));
  const ctxOf = (a: SchedulerAccount, now: Instant, job: string): AdapterCallContext => ({
    tenantId: a.tenantId as TenantId, channelAccountId: a.channelAccountId as ChannelAccountId, correlationId: `scheduler:${job}:${now}`, deadline: new Date(Date.parse(now) + 50_000).toISOString(),
  });

  return {
    async jobs(now) {
      const specs: JobSpec[] = [];
      const immediately = () => now;

      // Глобальные работы
      specs.push({
        name: 'analytics-export-day', scope: null, intervalSeconds: 86_400, catchUp: 'EVERY_SLOT', firstDueAt: (n) => alignedDay(n, cfg.exportOffsetSeconds),
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(72), leaseSeconds: hours(2),
        async run({ slotAt }) {
          const to = Date.parse(slotAt) - cfg.exportOffsetSeconds * 1000;
          const days = new Map<string, DayRange>([[new Date(to).toISOString(), { from: new Date(to - 86_400_000).toISOString(), to: new Date(to).toISOString() }]]);
          for (const d of await deps.unverifiedDays(slotAt, cfg.exportLookbackDays)) if (Date.parse(d.to) <= to) days.set(d.to, d);
          let items = 0;
          const unverified: string[] = [];
          const missing: string[] = [];
          for (const range of [...days.values()].sort((a, b) => a.from.localeCompare(b.from))) {
            const r = await deps.exportDay(range);
            items += r.exports.reduce((n, e) => n + e.rows, 0);
            unverified.push(...r.unverified);
            missing.push(...r.missing.map((m) => `${m}@${range.from.slice(0, 10)}`));
          }
          const alerts = [
            ...(unverified.length ? [{ code: 'ANALYTICS_EXPORT_UNVERIFIED', severity: 'CRITICAL' as const, details: { partitions: unverified.slice(0, 10).join(','), count: unverified.length } }] : []),
            // Секции суток нет: удалена принудительно без выгрузки или не создана — если в сутках были данные, история потеряна
            ...(missing.length ? [{ code: 'ANALYTICS_EXPORT_PARTITION_MISSING', severity: 'CRITICAL' as const, details: { partitions: missing.slice(0, 10).join(','), count: missing.length } }] : []),
          ];
          return { items, ...(alerts.length ? { alerts } : {}) };
        },
      });
      specs.push({
        name: 'price-days-close', scope: null, intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(3), lagCriticalSeconds: hours(24), leaseSeconds: 1800,
        async run({ now: n }) { return { items: await deps.maintenance.closePriceDays(n) }; },
      });
      specs.push({
        name: 'partitions', scope: null, intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(48), leaseSeconds: 600,
        async run({ now: n }) { await deps.maintenance.ensurePartitions(n); return { items: 0 }; },
      });
      specs.push({
        name: 'retention', scope: null, intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(168), leaseSeconds: 1800,
        async run({ now: n }) { return { items: (await deps.maintenance.dropExpiredPartitions(n)) + (await deps.maintenance.deleteExpiredRows(n)) }; },
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
            name: 'competitor-poll', scope, intervalSeconds: cfg.pollEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 600, lagCriticalSeconds: hours(1), leaseSeconds: 300,
            async run({ now: n }) {
              const r = await pipeline().pollDueCompetitors(ctxOf(a, n, 'competitor-poll'),
                { budgetRequestsPerSecond: cfg.pollBudgetRps, maxQueries: cfg.pollMaxQueries, ...(reconcile ? { reconcile: { graceSeconds: cfg.lossGraceSeconds } } : {}) });
              return {
                items: r.due,
                ...(r.plan.coldTierExceedsBudget ? { alerts: [{ code: 'COMPETITOR_POLL_BUDGET_EXCEEDED', severity: 'WARNING' as const, details: { candidates: r.candidates, demoted: r.plan.demoted } }] } : {}),
              };
            },
          });
        }
        if (reconcile) {
          specs.push({
            name: 'notification-loss-review', scope, intervalSeconds: cfg.lossReviewEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 1800, lagCriticalSeconds: hours(3), leaseSeconds: 300,
            async run({ now: n }) {
              const r = await pipeline().reviewNotificationLoss(ctxOf(a, n, 'notification-loss-review'));
              return { items: r.delayed + r.lossSuspected.length };
            },
          });
        }
        if (reconcile && rotationAccounts.includes(a)) {
          // Лимит вызова делят все аккаунты Amazon приложения: темп на аккаунт — 30 с × число аккаунтов (OQ-176)
          const interval = Math.ceil(cfg.amazonCallSeconds * rotationAccounts.length);
          specs.push({
            name: 'amazon-reconcile-rotation', scope, intervalSeconds: interval, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: interval * 10, lagCriticalSeconds: Math.max(hours(3), interval * 60), leaseSeconds: 120,
            async run({ now: n, runIndex }) {
              const r = await pipeline().reconcileRotation(ctxOf(a, n, 'amazon-reconcile-rotation'), { size: cfg.amazonBatch, cycle: runIndex, graceSeconds: cfg.lossGraceSeconds });
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
            name: 'halt-review', scope, intervalSeconds: cfg.haltReviewEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: 1800, lagCriticalSeconds: hours(6), leaseSeconds: 300,
            async run({ now: n }) { return { items: (await pipeline().reviewHalts(ctxOf(a, n, 'halt-review'))).length }; },
          });
        }
        specs.push({
          name: 'offer-discovery', scope, intervalSeconds: cfg.discoveryEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
          lagWarningSeconds: hours(36), lagCriticalSeconds: hours(72), leaseSeconds: 1800,
          async run({ now: n }) {
            const r = await pipeline().discoverOffers(ctxOf(a, n, 'offer-discovery'));
            return { items: r.offers };
          },
        });
      }
      return specs;
    },
  };
}
