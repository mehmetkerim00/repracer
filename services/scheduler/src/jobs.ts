import type { DailyExportReport, DayRange, ExportGroup } from '@repracer/analytics-export';
import type { AdapterCallContext, ChannelAccountId, ChannelDescriptor, Instant, TenantId } from '@repracer/channel-port';
import { DEFAULT_LOSS_GRACE_SECONDS, type PricingPipeline } from '@repracer/pricing-pipeline';
import { JobHoldsWindowError, type JobSource, type JobSpec } from './scheduler.ts';

type JobAlert = { code: string; severity: 'WARNING' | 'CRITICAL'; details: Record<string, string | number | boolean | null> };

/**
 * Р-126 (шаг 25): работы планировщика. Работа по аккаунту появляется, только если канал её даёт (описание канала): ярусный опрос —
 * у канала с источником опроса для решения, сверка по кругу — у канала с источником только для сверки, проверка остановки выборкой —
 * у канала SAMPLE [Р-119], проверка потерь — у аккаунта со сверкой уведомлений [Р-121].
 * Частоты — допущения продукта, не лимиты каналов; лимиты держат ограничители адаптеров.
 */

/** Шаг 58: `connectedAt` — время подключения аккаунта; от него первое окно чтения заказов (заказ между согласием и первым заходом не теряется) */
export interface SchedulerAccount { tenantId: string; channelAccountId: string; channel: string; connectedAt?: Instant }

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
  /**
   * Обход офферов [Р-120]. Шаг 56 (ревью шага 55, находка 4): заход — раз в час, НОВЫЙ круг — не чаще `discoveryCircleEverySeconds` (сутки,
   * допущение OQ-163): прерванный сроком или квотой круг продолжается в пределах часа, а не через сутки; закрытый — канал не трогается
   */
  discoveryEverySeconds: number;
  discoveryCircleEverySeconds: number;
  /**
   * Шаг 55 (OQ-240): суточный бюджет квот ПРИЛОЖЕНИЯ для обхода предложений, по имени квоты (его называет адаптер страницы). eBay Trading —
   * 5 000 вызовов в сутки по умолчанию на приложение (снимок vendor/ebay/2026-09-28/api-call-limits.html); обходу — 3 000, остальное —
   * предполётной проверке миграции (GetItem, GetUserPreferences) и запасу. После Application Growth Check поднимается конфигурацией
   */
  discoveryAppQuotas: Readonly<Record<string, number>>;
  /** Шаг 35 [Р-25]: строки заказов канала — резервации; окно чтения перекрывает интервал, повторы безвредны (идемпотентно по строке заказа) */
  orderLinesEverySeconds: number;
  /**
   * Шаг 58 (ревью шага 56, находка 10): первое окно чтения заказов — от подключения аккаунта, но не глубже этого предела. Отгруженный заказ
   * резервация списывает с пула; заказ, отгруженный задолго до подключения, уже учтён в остатке источника, и его списание было бы вторым.
   * Сутки — с запасом больше промежутка «согласие → первый заход работы»; урезанное окно — WARNING, а не молчание
   */
  orderLinesFirstLookbackSeconds: number;
  /** Выгрузка суток UTC — через 30 минут после конца суток; дни с непроверенными секциями — повторно за 13 суток (принудительное удаление — 14) */
  exportOffsetSeconds: number;
  exportLookbackDays: number;
  maintenanceEverySeconds: number;
  /** Р-156: как часто заходит доставка алертов; дайджест WARNING всё равно уходит раз в час */
  alertsDeliverEverySeconds: number;
  /** Шаг 41 [Р-171]: период недельного дайджеста тени */
  shadowDigestEverySeconds: number;
  /** Шаг 43 [Р-177]: как часто заходит проверка авторизаций каналов обменом refresh-токена */
  authorizationCheckEverySeconds: number;
  /** Шаг 47: пересчёт цен, не зависящих от конкурентов (фиксированная, маржинальная) — допущение, как у обхода офферов */
  scheduledRecomputeEverySeconds: number;
  /** Ревью шага 47, находка 5: предел единиц за заход — самые давние первыми, остальные — следующими заходами */
  scheduledRecomputeLimit: number;
}

/**
 * Шаг 57 (п. 2): необязательная возможность работ → работа, которую она заводит. Без возможности работы в процессе нет вовсе (так было
 * с `stock` до шага 56). Правило репозитория держит список равным необязательным членам `JobDeps`, тест точки входа
 * (`production-composition.pg.test.ts`) — что настоящий `startScheduler` в промышленной конфигурации заводит каждую из этих работ
 */
/** Шаг 59 (ревью шага 58, находки 1–2): место чтения заказов — начало окна, курсор, начало чтения цепочки и отказы на курсоре */
export interface OrderReadPlace { since: Instant; cursor: string | null; readFrom: Instant | null; cursorFailures: number }

/** Шаг 58: сохранённый курсор заказов снимается на третьем провале подряд — как круг обнаружения (0152) */
export const ORDER_CURSOR_DROP_AFTER_FAILURES = 3;

export const CAPABILITY_JOBS = {
  stock: 'order-lines',
  alertDelivery: 'alerts-deliver',
  shadowDigest: 'shadow-digest',
  channelAuthorizations: 'channel-authorizations',
} as const;

export const DEFAULT_JOB_CONFIG: JobConfig = {
  pollEverySeconds: 60, pollBudgetRps: 10, pollMaxQueries: 600, lossReviewEverySeconds: 300, lossGraceSeconds: DEFAULT_LOSS_GRACE_SECONDS,
  amazonCallSeconds: 31, amazonBatch: 20, amazonCircleWarnHours: 24, haltReviewEverySeconds: 300, discoveryEverySeconds: 3_600, discoveryCircleEverySeconds: 86_400, discoveryAppQuotas: { EBAY_TRADING: 3000 }, orderLinesEverySeconds: 300, orderLinesFirstLookbackSeconds: 86_400,
  exportOffsetSeconds: 1_800, exportLookbackDays: 13, maintenanceEverySeconds: 3_600, alertsDeliverEverySeconds: 60,
  // Находка 3 ревью шага 43: заход ЕЖЕДНЕВНЫЙ — письмо о прошлой закрытой неделе, недоставленное повторяется каждые сутки
  shadowDigestEverySeconds: 86_400,
  authorizationCheckEverySeconds: 3_600,
  scheduledRecomputeEverySeconds: 900,
  scheduledRecomputeLimit: 1_000,
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
    /** Р-25: резервация, которую источник не подтвердил за TTL (24 ч), освобождается — иначе доступный остаток занижен навсегда */
    releaseExpiredReservations(now: Instant): Promise<number>;
    /** Р-30: подтверждённая резервация старше 14 суток НЕ освобождается, а поднимает алерт — её разбирает человек */
    alertStaleConfirmedReservations(now: Instant): Promise<number>;
    /** Часы базы: журнал удаления по сроку пишет момент базы, а не планировщика */
    databaseNow(): Promise<Instant>;
  };
  /**
   * Р-156 (шаг 36): доставка алертов владельцу — CRITICAL письмом немедленно, WARNING часовым дайджестом. Без неё алерт
   * живёт только в базе и считается недоставленным; процесс без настроенной почты не стартует, если её не выключили явно.
   */
  alertDelivery?: { deliver(): Promise<{ immediate: number; digests: number; delivered: number; failed: number }> };
  /** Шаг 41 [Р-171]: недельный дайджест теневого режима — те же числа, что на экране, письмом владельцу */
  shadowDigest?: { send(): Promise<{ letters: number; quiet: number; noRecipient: number; failed: number }> };
  /**
   * Шаг 43 [Р-177]: проверка авторизаций каналов. Отзыв продавцом виден только обменом refresh-токена (уведомления об
   * отзыве в снимках нет — A-18, E-09); итог пишет база, отзыв — CRITICAL владельцу, сломанные ключи приложения — оператору.
   */
  channelAuthorizations?: { check(): Promise<{ checked: number; ok: number; revoked: number; transient: number; platform: number; platformChannels: string[]; suspiciousRevocations: number; keyringFailures: number }> };
  /**
   * Шаг 35 [Р-25, Р-152]: заказы канала → резервации → пересчёт публикуемого остатка → записи. Без хранилища остатков в
   * процессе работы нет; процесс без роли остатков — конфигурация, а не молчаливый пропуск.
   */
  stock?: {
    syncOrders(account: SchedulerAccount, ctx: AdapterCallContext, since: Instant, options?: { cursor?: string }): Promise<{ lines: number; created: number; consumed: number; released: number; unknownOffers: number; writes: number; cursorRepeated?: boolean; pageLimit?: { pages: number; nextCursor: string };
      silentSources?: Array<{ stockSourceId: string; reservations: number; oldestConfirmedAt: Instant }> }>;
    /**
     * Шаг 56 (ревью шага 54, находка 8): место чтения заказов аккаунта — заход, упёршийся в предел страниц, записывает начало окна и
     * курсор, следующий продолжает оттуда. Без хранилища места работа читает окно заново (ничего не теряя, но и не продвигаясь дальше
     * предела на огромном окне — это видно алертом)
     */
    positions?: {
      /** Шаг 57: место без курсора держит только начало окна — следующий заход перечитывает окно от начала (ревью шага 56, находки 3–4) */
      get(account: SchedulerAccount): Promise<OrderReadPlace | null>;
      save(account: SchedulerAccount, position: OrderReadPlace | null, at: Instant): Promise<void>;
    };
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
  { name: 'order-lines', scope: 'ACCOUNT', when: 'каждые 5 мин', missed: 'LATEST: окно чтения — с предыдущего запуска; пропуск ничего не теряет, резервации создаются позже, доступный остаток в каналах завышен на время пропуска' },
  { name: 'scheduled-recompute', scope: 'ACCOUNT', when: 'каждые 15 мин: единицы без решения за 24 часа, не больше 1000 за заход', missed: 'LATEST: фиксированные и маржинальные цены пересчитываются позже; у канала без данных конкурентов (eBay) решений нет всё время простоя' },
  { name: 'offer-discovery', scope: 'ACCOUNT', when: 'раз в сутки', missed: 'LATEST: чужое ценообразование нового оффера обнаружится при записи или следующем обходе' },
  { name: 'analytics-export-day', scope: 'GLOBAL', when: 'сутки UTC, в 00:30 следующих суток', missed: 'EVERY_SLOT: каждые пропущенные сутки выгружаются по очереди; провалившиеся, непроверенные и изменившиеся после проверки сутки повторяются каждым запуском из отставания (13 суток); секции журнала не удаляются без проверенной выгрузки; отставание CRITICAL — с 72 часов, принудительное удаление через 14 суток — CRITICAL ANALYTICS_PARTITION_FORCE_DROPPED' },
  { name: 'price-days-close', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: функция закрывает все незакрытые сутки по очереди; сырьё цен не удаляется, пока сутки не закрыты' },
  { name: 'partitions', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: секции созданы на 3 суток вперёд; простой дольше — отказ записи снимков и цен (CRITICAL через 2 суток)' },
  { name: 'alerts-deliver', scope: 'GLOBAL', when: 'каждую минуту', missed: 'LATEST: письма уходят позже; CRITICAL, поднятый во время простоя, ждёт следующего запуска — алерт остаётся в базе без отметки доставки, и это видно запросом [Р-156]' },
  { name: 'shadow-digest', scope: 'GLOBAL', when: 'раз в сутки: письмо о прошлой закрытой ISO-неделе (UTC); доставленное второй раз не уходит, недоставленное повторяется каждые сутки до конца следующей недели', missed: 'LATEST: дайджест уходит позже; у него ЕСТЬ отметка доставки [Р-174, шаг 42] — строка периода в tenant_data.shadow_digest, — поэтому пропуск недели и недоставленное письмо видны запросом, а повторный запуск не пишет продавцу дважды' },
  { name: 'channel-authorizations', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: отзыв авторизации продавцом обнаружится позже — до того записи в канал отказывают, и аккаунт не переведён в понятное состояние; токены сами не истекают быстрее срока канала' },
  { name: 'retention', scope: 'GLOBAL', when: 'каждый час', missed: 'LATEST: удаление по сроку откладывается, данные хранятся дольше — PostgreSQL растёт; неподтверждённые резервации висят дольше TTL, и доступный остаток занижен всё это время; алерт о подтверждённой резервации старше 14 суток [Р-30] приходит позже' },
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
      if (deps.alertDelivery) {
        const delivery = deps.alertDelivery;
        specs.push({
          name: 'alerts-deliver', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.alertsDeliverEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
          lagWarningSeconds: 600, lagCriticalSeconds: hours(2), leaseSeconds: 300,
          async run() {
            // Провал отправки работу не роняет: попытка засчитана в базе, алерт остаётся недоставленным и уйдёт следующим заходом
            const r = await delivery.deliver();
            return { items: r.delivered };
          },
        });
      }
      if (deps.shadowDigest) {
        const digest = deps.shadowDigest;
        specs.push({
          name: 'shadow-digest', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.shadowDigestEverySeconds, catchUp: 'LATEST',
          firstDueAt: immediately, lagWarningSeconds: hours(24), lagCriticalSeconds: hours(72), leaseSeconds: 600,
          async run() {
            // Провал отправки работу не роняет: у строки периода остаётся отметка «не доставлено», и СЛЕДУЮЩИЙ заход
            // отправляет письмо снова [Р-174, шаг 42]; доставленное второй раз не уходит — это держит база
            const r = await digest.send();
            return { items: r.letters };
          },
        });
      }
      if (deps.channelAuthorizations) {
        const authorizations = deps.channelAuthorizations;
        specs.push({
          name: 'channel-authorizations', scope: null, retryKind: 'CHANNEL', intervalSeconds: cfg.authorizationCheckEverySeconds, catchUp: 'LATEST',
          firstDueAt: immediately, lagWarningSeconds: hours(6), lagCriticalSeconds: hours(24), leaseSeconds: 900,
          async run() {
            const r = await authorizations.check();
            // Отзыв продавцом алертом поднимает БАЗА (у тенанта, владельцу); здесь — только поломка платформы, для оператора
            const alerts: Array<{ code: string; severity: 'WARNING' | 'CRITICAL'; details: Record<string, string | number | boolean | null> }> = [
              ...(r.platform > 0 ? [{ code: 'CHANNEL_APP_CREDENTIALS_REJECTED', severity: 'CRITICAL' as const,
                details: { channels: r.platformChannels.join(','), refused: r.platform } }] : []),
              // Находка 7 ревью шага 43: массовый `invalid_grant` — не решение продавцов, а скорее наша поломка: оператору
              ...(r.suspiciousRevocations > 0 ? [{ code: 'CHANNEL_REVOCATIONS_SUSPICIOUS', severity: 'CRITICAL' as const,
                details: { refused: r.suspiciousRevocations, checked: r.checked } }] : []),
              // Находка 15: токен не открывается кольцом ключей процесса — своя причина, а не «ключи приложения отклонены»
              ...(r.keyringFailures > 0 ? [{ code: 'CHANNEL_KEYRING_UNREADABLE', severity: 'CRITICAL' as const,
                details: { credentials: r.keyringFailures } }] : []),
            ];
            return { items: r.checked, ...(alerts.length > 0 ? { alerts } : {}) };
          },
        });
      }
      specs.push({
        name: 'retention', scope: null, retryKind: 'INTERNAL', intervalSeconds: cfg.maintenanceEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
        lagWarningSeconds: hours(6), lagCriticalSeconds: hours(168), leaseSeconds: 1800,
        async run({ now: n }) {
          const mark = await deps.maintenance.databaseNow();
          const items = (await deps.maintenance.dropExpiredPartitions(n)) + (await deps.maintenance.deleteExpiredRows(n))
            + (await deps.maintenance.releaseExpiredReservations(n)) + (await deps.maintenance.alertStaleConfirmedReservations(n));
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
        if (deps.stock) {
          const stock = deps.stock;
          specs.push({
            name: 'order-lines', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.orderLinesEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
            lagWarningSeconds: cfg.orderLinesEverySeconds * 6, lagCriticalSeconds: hours(6), leaseSeconds: 300,
            async run({ startedAt, previousSucceededAt }) {
              const intervalMs = cfg.orderLinesEverySeconds * 1000;
              const positions = stock.positions;
              const saved = (await positions?.get(a)) ?? null;
              /**
               * Окно чтения. Шаг 59 (ревью шага 58, находка 1): следующее окно начинается от НАЧАЛА ЧТЕНИЯ прошлого (минус интервал), а не от
               * конца прошлого успешного запуска. Канал отдаёт окно в виде первой страницы (Kaufland — `ts_updated:desc` со смещением): строка,
               * обновлённая после первой страницы, уходит наверх, до смещения, и продолжение по курсору её не видит. Цепочка продолжений
               * переживает провалы с паузой, и от конца последнего запуска всё обновлённое за время цепочки не читалось никогда — перепродажа.
               * Поэтому место хранится всегда: начало окна, курсор, начало чтения цепочки (`readFrom`) и отказы на курсоре.
               *
               * Шаг 58 (ревью шага 56, находка 10): первое окно — от подключения аккаунта, не глубже `orderLinesFirstLookbackSeconds`. Шаг 59
               * (ревью шага 58, находка 4): оно закрепляется местом при первой попытке — предел «сутки от запуска» не ползёт вперёд с провалами
               */
              const connectedMs = a.connectedAt ? Date.parse(a.connectedAt) - intervalMs : null;
              const firstFloorMs = Date.parse(startedAt) - cfg.orderLinesFirstLookbackSeconds * 1000;
              const firstSinceMs = connectedMs === null ? Date.parse(startedAt) - intervalMs : Math.max(connectedMs, firstFloorMs);
              const since = saved?.since
                ?? (previousSucceededAt ? new Date(Date.parse(previousSucceededAt) - intervalMs).toISOString() : new Date(firstSinceMs).toISOString());
              if (!saved && !previousSucceededAt && positions) await positions.save(a, { since, cursor: null, readFrom: null, cursorFailures: 0 }, startedAt);
              const continuing = Boolean(saved?.cursor);
              // Начало чтения цепочки: продолжение — первая страница цепочки; иначе — этот заход
              const readFrom = continuing ? (saved!.readFrom ?? startedAt) : startedAt;
              // Первое окно, не дотянувшееся до подключения, — WARNING при первом успехе (до него прошлого успеха нет)
              const cappedAlert = !previousSucceededAt && connectedMs !== null && Date.parse(since) > connectedMs
                ? [{ code: 'ORDER_LINES_FIRST_WINDOW_CAPPED', severity: 'WARNING' as const, details: { connectedAt: a.connectedAt!, since, lookbackHours: cfg.orderLinesFirstLookbackSeconds / 3600 } }] : [];
              let r: Awaited<ReturnType<typeof stock.syncOrders>>;
              try {
                r = await stock.syncOrders(a, ctxOf(a, startedAt, 'order-lines', 120), since, continuing ? { cursor: saved!.cursor! } : {});
              } catch (error) {
                /**
                 * Шаг 58 (ревью шага 57, находка 2): чтение оборвалось посреди окна — прочитанное записано, место — последний принятый курсор.
                 * Шаг 59 (ревью шага 58, находка 2): заход, продвинувшийся вперёд, — не обычный провал: он повторяется в свой период, без
                 * удвоения паузы (иначе отставание заказов росло бы вместе с паузой), и не считается отказом на курсоре
                 */
                const interrupted = error as { linesRecorded?: number; cursor?: string; code?: string };
                if (typeof interrupted.linesRecorded === 'number' && interrupted.cursor) {
                  await positions?.save(a, { since, cursor: interrupted.cursor, readFrom, cursorFailures: 0 }, startedAt);
                  const cause = /^[A-Z][A-Z0-9_]{2,}$/.test(String(interrupted.code)) ? String(interrupted.code) : 'ORDER_READ_INTERRUPTED';
                  throw new JobHoldsWindowError(cause, `order lines read interrupted after ${interrupted.linesRecorded} lines, continued from the last accepted cursor`);
                }
                /**
                 * Шаг 57–59: курсор, который канал больше не принимает, держал бы работу на себе вечно; снимать его на первом отказе тоже нельзя —
                 * разовый 5xx отбрасывал заход к началу окна. Отказы считаются НА САМОМ курсоре (ревью шага 58, находка 2): третий подряд снимает
                 * его, начало окна и начало чтения остаются
                 */
                if (continuing && positions) {
                  const failures = saved!.cursorFailures + 1;
                  await positions.save(a, failures >= ORDER_CURSOR_DROP_AFTER_FAILURES
                    ? { since: saved!.since, cursor: null, readFrom: saved!.readFrom, cursorFailures: 0 }
                    : { ...saved!, cursorFailures: failures }, startedAt);
                }
                throw error;
              }
              /**
               * Шаг 59 [Р-200]: источник Inbound API молчит сутки после подтверждения отгруженного заказа — вычитание отгруженного держится
               * (в каналах меньше, чем могло бы быть, — безопасная сторона), и продавец узнаёт, что его система не присылает остаток
               */
              const silentAlerts = (r.silentSources ?? []).map((x) => ({ code: 'INBOUND_SOURCE_SILENT', severity: 'WARNING' as const,
                details: { stockSourceId: x.stockSourceId, reservations: x.reservations, oldestConfirmedAt: x.oldestConfirmedAt } }));
              if (r.pageLimit && !positions) {
                // Места хранить негде — успех сдвинул бы окно и потерял хвост: окно держится провалом без удвоения паузы (шаг 55)
                throw new JobHoldsWindowError('ORDER_LINES_PAGE_LIMIT_REACHED', `order lines read ${r.lines} in ${r.pageLimit.pages} pages, no position store, the window is kept`);
              }
              if (r.pageLimit) {
                // Шаг 56: предел страниц захода — прочитанное записано, место — тоже; следующий заход продолжит ту же цепочку
                await positions!.save(a, { since, cursor: r.pageLimit.nextCursor, readFrom, cursorFailures: 0 }, startedAt);
                return { items: r.lines, alerts: [...cappedAlert, ...silentAlerts, { code: 'ORDER_LINES_PAGE_LIMIT_REACHED', severity: 'WARNING' as const, details: { pages: r.pageLimit.pages, lines: r.lines, continued: continuing } }] };
              }
              /**
               * Шаг 53–57: канал повторил курсор — прочитанное записано, но окно не дочитано: запуск — провал (успех сдвинул бы окно), место —
               * начало окна без курсора: следующий заход перечитывает окно от его начала (повтор строки безвреден)
               */
              if (r.cursorRepeated) {
                await positions?.save(a, { since, cursor: null, readFrom: null, cursorFailures: 0 }, startedAt);
                throw new JobHoldsWindowError('CHANNEL_PAGE_CURSOR_REPEATED', `order lines read ${r.lines}, the window is kept for the next run`);
              }
              // Окно дочитано: следующее — от начала чтения этой цепочки минус интервал (ревью шага 58, находка 1)
              await positions?.save(a, { since: new Date(Date.parse(readFrom) - intervalMs).toISOString() as Instant, cursor: null, readFrom: null, cursorFailures: 0 }, startedAt);
              return { items: r.lines, ...(cappedAlert.length + silentAlerts.length > 0 ? { alerts: [...cappedAlert, ...silentAlerts] } : {}) };
            },
          });
        }
        specs.push({
          // Шаг 47: снимок конкурентов будит только цены из данных конкурентов; фиксированную и маржинальную — расписание.
          // В канал ходит запись решения (в бою) — работа класса CHANNEL
          name: 'scheduled-recompute', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.scheduledRecomputeEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
          lagWarningSeconds: hours(1), lagCriticalSeconds: hours(6), leaseSeconds: 600,
          async run({ startedAt }) {
            const r = await pipeline().recomputeScheduled(ctxOf(a, startedAt, 'scheduled-recompute', 540), { limit: cfg.scheduledRecomputeLimit });
            // Все должные упали — провал запуска: пауза растёт по Р-132, отставание видно; часть — WARNING с числом
            if (r.scopes > 0 && r.failed === r.scopes) throw new Error(`${r.firstError ?? 'RECOMPUTE_FAILED'}: all ${r.scopes} due scopes failed`);
            return { items: r.scopes - r.failed, ...(r.failed > 0 ? { alerts: [{ code: 'SCHEDULED_RECOMPUTE_FAILURES', severity: 'WARNING' as const, details: { scopes: r.scopes, failed: r.failed } }] } : {}) };
          },
        });
        specs.push({
          name: 'offer-discovery', scope, retryKind: 'CHANNEL', intervalSeconds: cfg.discoveryEverySeconds, catchUp: 'LATEST', firstDueAt: immediately,
          lagWarningSeconds: hours(36), lagCriticalSeconds: hours(72), leaseSeconds: 1800,
          async run({ startedAt }) {
            /**
             * Шаг 55 (OQ-240; ревью шага 54, находка 9): заход — отрезок круга. Срок вызова и квота приложения останавливают его сами, место
             * записано, следующий заход продолжит. Круг, не закрытый заходом, — не провал: это нормальный ход крупного каталога
             */
            const r = await pipeline().discoverOffers(ctxOf(a, startedAt, 'offer-discovery', 1500), { quotas: cfg.discoveryAppQuotas, circleEveryMs: cfg.discoveryCircleEverySeconds * 1000 });
            return { items: r.offers };
          },
        });
      }
      return specs;
    },
  };
}
