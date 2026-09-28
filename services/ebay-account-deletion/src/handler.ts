import { challengeResponse, verifyNotification, type PublicKeySource } from './verify.ts';

/**
 * Шаг 49 [Р-192]: обработчик уведомлений eBay Marketplace Account Deletion — чистая логика без сервера.
 *
 * По странице снимка (`vendor/ebay/2026-09-28/marketplace-user-account-deletion.html`):
 *   * GET `?challenge_code=…` — ответ 200, `application/json`, тело `{"challengeResponse": "<hex>"}` — SHA-256 от
 *     challengeCode + verificationToken + endpoint. Тело собирается JSON-библиотекой: строка с BOM ломает подписку (страница
 *     предупреждает об этом отдельно).
 *   * POST — уведомление; подтверждение — 200/201/202/204, иначе eBay повторяет до подтверждения, через сутки помечает адрес
 *     неработающим, через 30 дней — разработчика несоответствующим.
 * Подлинность — как в официальном SDK: подпись проверяется ДО подтверждения; не прошла — 412, ключ сейчас не получить или база
 * недоступна — 500 (eBay повторит). Удаление и его аудит делает база одной функцией; обработчик её только зовёт.
 * Идентификаторы пользователя eBay (`userId`, `username`, `eiasToken`) в журнал не пишутся никогда.
 */

export const DELETION_TOPIC = 'MARKETPLACE_ACCOUNT_DELETION';

export interface DeletionNotice {
  notificationId: string;
  userId: string;
  eventDate: string;
  publishAttemptCount: number;
}

export interface DeletionStore {
  /**
   * Число аккаунтов, чьи данные удалены (0 — пользователь нам не известен), и их идентификаторы — наши UUID, не данные
   * пользователя eBay. Повторная доставка — то же число и пустой список.
   */
  delete(notice: DeletionNotice): Promise<{ accounts: number; accountIds: string[] }>;
}

export interface DeletionLog {
  log(entry: { level: 'INFO' | 'WARN' | 'ERROR'; code: string; details?: Record<string, string | number | boolean | null> }): void;
}

export interface HandlerRequest {
  method: string;
  /** Путь с запросом, как пришёл (`/ebay/account-deletion?challenge_code=…`) */
  url: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: string;
}

export interface HandlerResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface DeletionHandlerOptions {
  /** Адрес, зарегистрированный у eBay, — ровно тот, что участвует в хэше challenge */
  endpoint: string;
  verificationToken: string;
  keys: PublicKeySource;
  store: DeletionStore;
  log: DeletionLog;
}

const NOTIFICATION_ID_RE = /^[A-Za-z0-9_.:-]{8,200}$/;
const MAX_BODY = 64 * 1024;

const json = (status: number, value: unknown): HandlerResponse => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const empty = (status: number): HandlerResponse => ({ status, headers: {}, body: '' });

/** Разбор уведомления по форме AsyncAPI страницы: чего-то нет или не того вида — не угадывается */
export function parseNotice(message: unknown): DeletionNotice | null {
  const m = message as { metadata?: { topic?: unknown }; notification?: { notificationId?: unknown; eventDate?: unknown; publishAttemptCount?: unknown; data?: { userId?: unknown } } };
  const n = m?.notification;
  if (!n || typeof n.notificationId !== 'string' || !NOTIFICATION_ID_RE.test(n.notificationId)) return null;
  const userId = n.data?.userId;
  if (typeof userId !== 'string' || userId.length < 1 || userId.length > 128) return null;
  if (typeof n.eventDate !== 'string' || Number.isNaN(Date.parse(n.eventDate))) return null;
  const attempt = typeof n.publishAttemptCount === 'number' && Number.isSafeInteger(n.publishAttemptCount) && n.publishAttemptCount >= 1 ? n.publishAttemptCount : 1;
  return { notificationId: n.notificationId, userId, eventDate: new Date(Date.parse(n.eventDate)).toISOString(), publishAttemptCount: attempt };
}

export function createDeletionHandler(options: DeletionHandlerOptions) {
  const path = new URL(options.endpoint).pathname;
  return async function handle(req: HandlerRequest): Promise<HandlerResponse> {
    const url = new URL(req.url, 'http://placeholder.invalid');
    if (url.pathname !== path) return empty(404);
    if (req.method === 'GET') {
      const code = url.searchParams.get('challenge_code');
      if (!code || code.length > 512) return json(400, { error: 'challenge_code is required' });
      options.log.log({ level: 'INFO', code: 'EBAY_DELETION_CHALLENGE_ANSWERED' });
      return json(200, { challengeResponse: challengeResponse(code, options.verificationToken, options.endpoint) });
    }
    if (req.method !== 'POST') return empty(405);
    if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY) return empty(413);
    let message: unknown;
    try {
      message = JSON.parse(req.body);
    } catch {
      options.log.log({ level: 'WARN', code: 'EBAY_DELETION_BODY_UNPARSEABLE' });
      return empty(400);
    }
    let verdict;
    try {
      verdict = await verifyNotification(message, req.headers['x-ebay-signature'], options.keys);
    } catch (error) {
      // Ключ сейчас не получить: не подтверждаем — eBay повторит [страница снимка]
      options.log.log({ level: 'ERROR', code: 'EBAY_DELETION_KEY_UNAVAILABLE', details: { error: String((error as Error).message).slice(0, 160) } });
      return empty(500);
    }
    if (!verdict.ok) {
      options.log.log({ level: 'WARN', code: 'EBAY_DELETION_SIGNATURE_REJECTED', details: { reason: verdict.reason } });
      return empty(412);
    }
    const topic = (message as { metadata?: { topic?: unknown } })?.metadata?.topic;
    if (topic !== DELETION_TOPIC) {
      // Подлинное уведомление другой темы: подтверждаем, чтобы eBay не повторял, и ничего не делаем
      options.log.log({ level: 'WARN', code: 'EBAY_DELETION_OTHER_TOPIC', details: { topic: typeof topic === 'string' ? topic.slice(0, 64) : null } });
      return empty(204);
    }
    const notice = parseNotice(message);
    if (!notice) {
      options.log.log({ level: 'ERROR', code: 'EBAY_DELETION_NOTICE_MALFORMED' });
      return empty(400);
    }
    let accounts: number;
    let accountIds: string[];
    try {
      ({ accounts, accountIds } = await options.store.delete(notice));
    } catch (error) {
      options.log.log({ level: 'ERROR', code: 'EBAY_DELETION_STORE_FAILED', details: { notification: notice.notificationId.slice(0, 16), error: String((error as Error).message).slice(0, 160) } });
      return empty(500);
    }
    /**
     * В журнал — номер уведомления (его выдаёт eBay, он не называет пользователя), число и НАШИ идентификаторы удалённых
     * аккаунтов; идентификаторов пользователя eBay — нет. Журнал процесса живёт отдельно от базы: после восстановления базы
     * из копии удаление повторяется по этим идентификаторам (принятый риск 36).
     */
    options.log.log({ level: 'INFO', code: 'EBAY_DELETION_APPLIED', details: { notification: notice.notificationId.slice(0, 16), accounts, accountIds: accountIds.join(',') || null } });
    return empty(204);
  };
}
