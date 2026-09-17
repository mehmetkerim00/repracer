import type { AdapterLogger, AlertSink, ChannelAccountId, InboundDelivery, TenantId } from '@repracer/channel-port';
import { parseEnvelope, type NotificationEnvelope } from './envelope.ts';
import { md5Hex, type SqsClient, type SqsMessage } from './sqs.ts';

/**
 * Приёмник уведомлений SP-API из стандартной очереди Amazon SQS (шаг 23). Факты доставки — страница set-up-notifications-with-amazon-sqs:
 * FIFO не поддерживается; порядок не гарантирован; одно уведомление может прийти больше одного раза; дубликат узнаётся по NotificationId.
 * ANY_OFFER_CHANGED и PRICING_HEALTH идут только через SQS (страница notification-type-values, «Workflow»), EventBridge для них не применим.
 *
 * Что делает приёмник:
 *  - ПОДЛИННОСТЬ. Подписи у уведомления нет [AMZ_C08, A-12]. Писать в очередь может только принципал SP-API по политике очереди
 *    (tutorial-grant-permission-to-sqs-queue, аккаунт 437568002678 — условие инфраструктуры, не кода). Код сверяет ApplicationId с нашим
 *    приложением и отправляет уведомление только в аккаунты, чей SellerId и регион совпадают (маршрутизатор); адаптер ещё раз сверяет
 *    SellerId с аккаунтом [Р-31]. Чужое приложение, неизвестный продавец, неразбираемое тело — удаляются с алертом, в путь не идут.
 *  - ДЕДУПЛИКАЦИЯ. Журнал обработанных NotificationId на тенант (channel_data.inbound_notification): повтор удаляется без обработки.
 *    Сообщение удаляется из очереди только после записи в журнал, поэтому потерянное удаление даёт повтор, а не потерю.
 *  - ПОРЯДОК. В пределах полученной пачки — по EventTime. Между пачками порядка нет: ядро применяет правило «новее — побеждает» по моменту
 *    события (снимок старше принятого — OUT_OF_ORDER; состояние PRICING_HEALTH — только более позднее).
 *  - ПОТЕРЯ. Номеров последовательности нет — пропуск отдельного уведомления не обнаружить. Обнаруживается: тишина очереди дольше
 *    silenceAlertAfterMs (подписка или получатель сломаны), доставка позже lateAfterMs (очередь отстаёт, данные устарели — ядро отклонит
 *    снимок SNAPSHOT_TOO_OLD), сбой обработки — сообщение остаётся, повтор с растущей паузой; после maxReceiveCount — CRITICAL-алерт,
 *    дальше — очередь недоставленных по политике переадресации (условие инфраструктуры). Устаревшие данные конкурентов стратегия не
 *    использует (требование свежести, Р-39), догона опросом у Amazon нет [Р-119].
 */

export type AmazonRegion = 'NA' | 'EU' | 'FE';

export interface SellerRoute {
  tenantId: string;
  channelAccountId: string;
}

/** Аккаунты тенантов, подключившие продавца в регионе. Межтенантный поиск только по идентификатору — ролью маршрутизатора (0083) */
export interface SellerRouter {
  resolve(region: AmazonRegion, sellerId: string): Promise<SellerRoute[]>;
}

/** Журнал обработанных уведомлений тенанта */
export interface NotificationLedger {
  wasProcessed(route: SellerRoute, notificationId: string): Promise<boolean>;
  markProcessed(route: SellerRoute, entry: { notificationId: string; notificationType: string; eventTime: string | null; receivedAt: string }): Promise<void>;
}

/** Доставка в путь решения: обычно pipeline.processInbound. Исключение — временный сбой, сообщение останется в очереди */
export interface NotificationSink {
  deliver(route: SellerRoute, delivery: InboundDelivery, envelope: NotificationEnvelope): Promise<'ACCEPTED' | 'REJECTED'>;
}

export interface ReceiverPolicy {
  /** 0…20 с (ReceiveMessage) */
  waitTimeSeconds: number;
  maxMessages: number;
  visibilityTimeoutSeconds: number;
  /** Должно совпадать с maxReceiveCount политики переадресации очереди (проверить при подключении очереди) */
  maxReceiveCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  silenceAlertAfterMs: number;
  lateAfterMs: number;
}

export const DEFAULT_RECEIVER_POLICY: ReceiverPolicy = {
  waitTimeSeconds: 20, maxMessages: 10, visibilityTimeoutSeconds: 60, maxReceiveCount: 5,
  retryBaseSeconds: 30, retryMaxSeconds: 900,
  // Допущения до замеров задержки доставки (A-08): тишина полчаса при активных подписках, опоздание — дольше допуска свежести стратегии (900 с)
  silenceAlertAfterMs: 30 * 60_000, lateAfterMs: 15 * 60_000,
};

export const SUPPORTED_NOTIFICATION_TYPES: ReadonlySet<string> = new Set(['ANY_OFFER_CHANGED', 'PRICING_HEALTH']);

export type MessageOutcome =
  | 'DELIVERED' | 'DUPLICATE' | 'REJECTED_BY_ADAPTER' | 'FOREIGN_APPLICATION' | 'UNKNOWN_SELLER' | 'UNSUPPORTED_TYPE' | 'UNPARSEABLE' | 'CORRUPT' | 'RETRY' | 'GIVEN_UP';

export interface PollReport {
  received: number;
  outcomes: Array<{ messageId: string; outcome: MessageOutcome; notificationId?: string; late?: boolean }>;
  deleted: number;
  deleteFailed: number;
  queueError?: string;
}

export interface ReceiverOptions {
  sqs: SqsClient;
  queueUrl: string;
  region: AmazonRegion;
  /** amzn1.sellerapps.app.… нашего приложения */
  applicationId: string;
  router: SellerRouter;
  ledger: NotificationLedger;
  sink: NotificationSink;
  alerts: AlertSink;
  logger: AdapterLogger;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
  policy?: Partial<ReceiverPolicy>;
}

export interface NotificationReceiver {
  readonly policy: ReceiverPolicy;
  pollOnce(): Promise<PollReport>;
  /** Тишина очереди: один WARNING-алерт на период тишины */
  checkSilence(): Promise<boolean>;
  run(signal: AbortSignal): Promise<void>;
}

export function createNotificationReceiver(options: ReceiverOptions): NotificationReceiver {
  const policy: ReceiverPolicy = { ...DEFAULT_RECEIVER_POLICY, ...options.policy };
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let lastMessageAt = options.now().getTime();
  let silenceAlerted = false;

  const alert = (code: string, severity: 'WARNING' | 'CRITICAL', details: Record<string, string | number | boolean>, route?: SellerRoute) =>
    options.alerts.raise({ code, severity, details, ...(route ? { tenantId: route.tenantId as TenantId, channelAccountId: route.channelAccountId as ChannelAccountId } : {}) });
  const log = (level: 'INFO' | 'WARN', code: string, details: Record<string, string | number | boolean | null>) =>
    options.logger.log({ level, code, message: code, details });

  async function handle(message: SqsMessage, parsed: ReturnType<typeof parseEnvelope>, toDelete: SqsMessage[]): Promise<PollReport['outcomes'][number]> {
    const base = { messageId: message.messageId };
    // Тело искажено по дороге: не удаляем — придёт снова, после maxReceiveCount уйдёт в очередь недоставленных
    if (md5Hex(message.body) !== message.md5OfBody.toLowerCase()) {
      log('WARN', 'NOTIFICATION_BODY_CORRUPT', { messageId: message.messageId });
      // Ревью шага 23, находка 4: на последней попытке — тот же CRITICAL, что у сбоя обработки, дальше очередь недоставленных
      const count = message.attributes.approximateReceiveCount ?? 1;
      if (count >= policy.maxReceiveCount) await alert('NOTIFICATION_GIVING_UP', 'CRITICAL', { messageId: message.messageId, receiveCount: count, corrupt: true });
      return { ...base, outcome: 'CORRUPT' };
    }
    if (!parsed.ok) {
      toDelete.push(message);
      await alert('NOTIFICATION_UNPARSEABLE', 'CRITICAL', { messageId: message.messageId, problem: parsed.problem });
      return { ...base, outcome: 'UNPARSEABLE' };
    }
    const e = parsed.envelope;
    const withId = { ...base, notificationId: e.notificationId };
    if (e.applicationId !== options.applicationId) {
      toDelete.push(message);
      await alert('NOTIFICATION_FOREIGN_APPLICATION', 'CRITICAL', { messageId: message.messageId, notificationType: e.notificationType });
      return { ...withId, outcome: 'FOREIGN_APPLICATION' };
    }
    if (!SUPPORTED_NOTIFICATION_TYPES.has(e.notificationType)) {
      toDelete.push(message);
      log('WARN', 'NOTIFICATION_TYPE_UNSUPPORTED', { messageId: message.messageId, notificationType: e.notificationType });
      return { ...withId, outcome: 'UNSUPPORTED_TYPE' };
    }
    const routes = e.sellerId ? await options.router.resolve(options.region, e.sellerId) : [];
    if (routes.length === 0) {
      // Продавец отключён или уведомление не для наших аккаунтов: в путь не идёт; идентификатор продавца в алерт не пишется
      toDelete.push(message);
      await alert('NOTIFICATION_UNKNOWN_SELLER', 'WARNING', { messageId: message.messageId, notificationType: e.notificationType, hasSellerId: e.sellerId !== null });
      return { ...withId, outcome: 'UNKNOWN_SELLER' };
    }
    const receivedAt = options.now().toISOString();
    const late = message.attributes.sentTimestampMs !== null && options.now().getTime() - message.attributes.sentTimestampMs > policy.lateAfterMs;
    let delivered = 0;
    let rejected = 0;
    let duplicates = 0;
    try {
      for (const route of routes) {
        if (await options.ledger.wasProcessed(route, e.notificationId)) {
          duplicates += 1;
          continue;
        }
        const delivery: InboundDelivery = {
          claimed: { tenantId: route.tenantId as TenantId, channelAccountId: route.channelAccountId as ChannelAccountId },
          method: 'SQS', url: options.queueUrl, headers: { 'x-sqs-message-id': message.messageId }, rawBody: message.body, receivedAt,
        };
        const result = await options.sink.deliver(route, delivery, e);
        await options.ledger.markProcessed(route, { notificationId: e.notificationId, notificationType: e.notificationType, eventTime: e.eventTime, receivedAt });
        if (result === 'ACCEPTED') delivered += 1; else rejected += 1;
        if (late) await alert('NOTIFICATION_LATE', 'WARNING', { notificationType: e.notificationType, ageSeconds: Math.round((options.now().getTime() - message.attributes.sentTimestampMs!) / 1000) }, route);
      }
    } catch (error) {
      const count = message.attributes.approximateReceiveCount ?? 1;
      if (count >= policy.maxReceiveCount) {
        await alert('NOTIFICATION_GIVING_UP', 'CRITICAL', { messageId: message.messageId, notificationType: e.notificationType, receiveCount: count });
        return { ...withId, outcome: 'GIVEN_UP' };
      }
      const pause = Math.min(policy.retryMaxSeconds, policy.retryBaseSeconds * 2 ** Math.max(0, count - 1));
      await options.sqs.changeVisibility(message.receiptHandle, pause);
      log('WARN', 'NOTIFICATION_RETRY', { messageId: message.messageId, receiveCount: count, retryInSeconds: pause, error: String((error as Error).name ?? 'Error') });
      return { ...withId, outcome: 'RETRY' };
    }
    toDelete.push(message);
    const outcome: MessageOutcome = delivered > 0 ? 'DELIVERED' : rejected > 0 ? 'REJECTED_BY_ADAPTER' : duplicates > 0 ? 'DUPLICATE' : 'DELIVERED';
    return { ...withId, outcome, ...(late ? { late: true } : {}) };
  }

  return {
    policy,
    async pollOnce() {
      const received = await options.sqs.receive({ maxMessages: policy.maxMessages, waitTimeSeconds: policy.waitTimeSeconds, visibilityTimeoutSeconds: policy.visibilityTimeoutSeconds });
      if (!received.ok) {
        const queueError = `${received.status}${received.errorType ? ` ${received.errorType}` : ''}`;
        log('WARN', 'NOTIFICATION_QUEUE_UNAVAILABLE', { status: String(received.status), errorType: received.errorType });
        return { received: 0, outcomes: [], deleted: 0, deleteFailed: 0, queueError };
      }
      const messages = received.value;
      if (messages.length > 0) {
        lastMessageAt = options.now().getTime();
        silenceAlerted = false;
      }
      // Порядок внутри пачки — по моменту события; без момента — в конец
      const parsed = messages.map((m) => ({ m, p: parseEnvelope(m.body) }));
      const at = (x: (typeof parsed)[number]) => (x.p.ok && x.p.envelope.eventTime ? Date.parse(x.p.envelope.eventTime) : Number.POSITIVE_INFINITY);
      parsed.sort((a, b) => at(a) - at(b));
      const toDelete: SqsMessage[] = [];
      const outcomes: PollReport['outcomes'] = [];
      for (const { m, p } of parsed) outcomes.push(await handle(m, p, toDelete));
      let deleted = 0;
      let deleteFailed = 0;
      for (let i = 0; i < toDelete.length; i += 10) {
        const chunk = toDelete.slice(i, i + 10);
        const r = await options.sqs.deleteBatch(chunk.map((m, n) => ({ id: String(n), receiptHandle: m.receiptHandle })));
        if (!r.ok) {
          // Не удалено — придёт снова; журнал обработанных не даст обработать второй раз
          deleteFailed += chunk.length;
          log('WARN', 'NOTIFICATION_DELETE_FAILED', { messages: chunk.length, status: String(r.status) });
          continue;
        }
        deleted += r.value.successful.length;
        deleteFailed += r.value.failed.length;
      }
      return { received: messages.length, outcomes, deleted, deleteFailed };
    },
    async checkSilence() {
      const silentMs = options.now().getTime() - lastMessageAt;
      if (silentMs < policy.silenceAlertAfterMs || silenceAlerted) return false;
      silenceAlerted = true;
      await alert('NOTIFICATION_QUEUE_SILENT', 'WARNING', { silentMinutes: Math.floor(silentMs / 60_000) });
      return true;
    },
    async run(signal) {
      let failures = 0;
      while (!signal.aborted) {
        const report = await this.pollOnce();
        await this.checkSilence();
        failures = report.queueError ? failures + 1 : 0;
        if (failures > 0) await sleep(Math.min(60_000, 1_000 * 2 ** Math.min(failures, 6)));
      }
    },
  };
}

/** Журнал на хранилище пути решения (PricingStore.wasNotificationProcessed/markNotificationProcessed) — без зависимости от пакета хранилища */
export function storeLedger(store: {
  wasNotificationProcessed(tenantId: string, channelAccountId: string, notificationId: string): Promise<boolean>;
  markNotificationProcessed(tenantId: string, entry: { channelAccountId: string; notificationId: string; notificationType: string; eventTime: string | null; receivedAt: string }): Promise<void>;
}): NotificationLedger {
  return {
    wasProcessed: (route, notificationId) => store.wasNotificationProcessed(route.tenantId, route.channelAccountId, notificationId),
    markProcessed: (route, entry) => store.markNotificationProcessed(route.tenantId, { channelAccountId: route.channelAccountId, ...entry }),
  };
}

/**
 * Доставка в путь решения (pipeline.processInbound). Отказ адаптера (чужой SellerId, неразбираемый оффер) — REJECTED: сообщение удаляется,
 * алерт поднял адаптер. Исключение хранилища или сети — наружу: сообщение остаётся в очереди и придёт повторно.
 */
export function pipelineSink(pipeline: { processInbound(delivery: InboundDelivery): Promise<{ inbound: { kind: string } }> }): NotificationSink {
  return {
    async deliver(_route, delivery) {
      const { inbound } = await pipeline.processInbound(delivery);
      return inbound.kind === 'REJECTED' ? 'REJECTED' : 'ACCEPTED';
    },
  };
}
