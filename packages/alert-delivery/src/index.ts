import { messagesFor, type Locale, type Messages } from '@repracer/console-model';
import type { AlertDeliveryStore, AlertRow } from '@repracer/pricing-store-pg';

/**
 * Р-156 (шаг 36): алерт, который живёт только в базе, считается НЕдоставленным. CRITICAL уходит владельцу немедленно
 * письмом, WARNING — часовым дайджестом. Провайдер почты конфигурируем: здесь только порт `MailSender`, а кто именно
 * отправляет — решает развёртывание (на стенде — перехватчик, в production — HTTP-провайдер с ключом из файла).
 *
 * Почему письмо, а не экран: событие, ради которого продавец должен что-то СДЕЛАТЬ, он увидит на экране только если
 * откроет консоль. Остановка цен человеком, недоверие каналу и заблокированная единица ждать этого не могут.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailSender {
  /** Отправить письмо; `ref` — идентификатор письма у провайдера, доказательство отправки (адрес в него не входит) */
  send(message: MailMessage): Promise<{ ref: string }>;
}

export interface AlertDeliveryDeps {
  store: AlertDeliveryStore;
  mail: MailSender;
  now: () => string;
  /** Кому писать о платформенных событиях (отставание выгрузки, падающая работа): оператору, а не продавцу */
  operatorEmail?: string;
  /** Язык писем продавца: тот же словарь, что у консоли [Р-72] */
  locale?: Locale;
  /** Сколько алертов уровня брать за один заход */
  batchLimit?: number;
  /** Сколько ждать перед отправкой: событие, поднятое прямо сейчас, может быть частью пачки */
  quietSeconds?: number;
  /** Период дайджеста WARNING */
  digestSeconds?: number;
}

export interface DeliveryOutcome {
  /** Сколько писем ушло немедленно (по одному на CRITICAL) */
  immediate: number;
  /** Сколько дайджестов ушло (по одному на тенанта) */
  digests: number;
  /** Сколько алертов отмечено доставленными */
  delivered: number;
  /** Сколько не удалось отправить: попытка засчитана, отметки доставки нет */
  failed: number;
}

const HOUR_MS = 3_600_000;

/** Что случилось, словами продавца: код без текста в словаре — тоже письмо, но честно названное кодом */
export function alertText(row: Pick<AlertRow, 'code'>, m: Messages): { what: string; step: string } {
  const codes = m.ui.alerts.codes as Record<string, { what: string; step: string } | undefined>;
  const known = codes[row.code];
  return known ?? { what: m.ui.alerts.unknown(row.code), step: m.ui.alerts.unknownStep };
}

/**
 * Письмо об одном событии: тенант, канал, причина человеческим языком и первое действие [Р-156].
 *
 * Находка 4 ревью шага 36: КОД события дайджест печатал, а срочное письмо запрещало — два правила об одном, и одно из
 * них лишнее. Осталось одно: код печатается ВСЕГДА. Причина — у кода одна работа, и она не в том, чтобы объяснить
 * событие (для этого есть текст словаря), а в том, чтобы на него сослаться: продавец пишет в поддержку «у меня
 * PRICE_WRITE_SCOPE_BLOCKED», и это тот же код, что в `tenant_data.alert`, в журнале процесса и на экране консоли.
 * Без него продавец пересказывает немецкую фразу, а мы ищем, о каком из шести кодов речь. Тексты словаря есть не у
 * всех кодов [находка 3 ревью шага 36], и у остальных код — единственное, что в письме вообще названо точно.
 */
export function immediateMessage(row: AlertRow, tenant: string, to: string, m: Messages): MailMessage {
  const { what, step } = alertText(row, m);
  const severity = (m.ui.alerts.severity as Record<string, string>)[row.severity] ?? row.severity;
  const lines = [
    m.ui.alerts.tenantLine(tenant),
    ...(row.channel ? [m.ui.alerts.channelLine(row.channel, row.marketplaces.join(', '))] : []),
    m.ui.alerts.whenLine(m.when(row.raisedAt)),
    m.ui.alerts.codeLine(row.code),
    '',
    what,
    '',
    m.ui.alerts.firstStepLine(step),
  ];
  return { to, subject: m.ui.alerts.subject(severity, what, tenant), text: lines.join('\n') };
}

/** Часовой дайджест: одно письмо на тенанта, события сгруппированы по коду с числом и последним временем */
export function digestMessage(rows: readonly AlertRow[], tenant: string, to: string, m: Messages): MailMessage {
  const byCode = new Map<string, { count: number; last: string }>();
  for (const r of rows) {
    const seen = byCode.get(r.code);
    byCode.set(r.code, { count: (seen?.count ?? 0) + 1, last: seen && seen.last > r.raisedAt ? seen.last : r.raisedAt });
  }
  const lines = [
    m.ui.alerts.tenantLine(tenant),
    '',
    m.ui.alerts.digestIntro(rows.length),
    ...[...byCode.entries()].map(([code, x]) => m.ui.alerts.digestRow(code, alertText({ code }, m).what, x.count, m.when(x.last))),
    '',
    m.ui.alerts.digestFirstStep,
  ];
  return { to, subject: m.ui.alerts.digestSubject(rows.length, tenant), text: lines.join('\n') };
}

/** Одно и то же событие много раз подряд: письмо одно, и в нём сказано, сколько их было [находка 13 ревью шага 36] */
export function repeatedMessage(rows: readonly AlertRow[], tenant: string, to: string, m: Messages): MailMessage {
  const first = rows[0]!;
  const letter = immediateMessage(first, tenant, to, m);
  const last = rows.reduce((a, b) => (a.raisedAt > b.raisedAt ? a : b));
  return {
    to,
    subject: `${letter.subject} ×${rows.length}`,
    text: `${letter.text}\n\n${m.ui.alerts.repeated(rows.length, m.when(last.raisedAt))}`,
  };
}

export function createAlertDelivery(deps: AlertDeliveryDeps) {
  const m = messagesFor(deps.locale ?? 'de');
  const batchLimit = deps.batchLimit ?? 200;
  const quietMs = (deps.quietSeconds ?? 0) * 1000;
  const digestMs = (deps.digestSeconds ?? 3600) * 1000;

  const byCode = (rows: readonly AlertRow[]): Map<string, AlertRow[]> => {
    const map = new Map<string, AlertRow[]>();
    for (const r of rows) map.set(r.code, [...(map.get(r.code) ?? []), r]);
    return map;
  };

  const byTenant = (rows: readonly AlertRow[]): Map<string, AlertRow[]> => {
    const map = new Map<string, AlertRow[]>();
    for (const r of rows) map.set(r.tenantId, [...(map.get(r.tenantId) ?? []), r]);
    return map;
  };

  /**
   * Адреса владельца может не быть (тенант без активного владельца — платформенный, демо до приглашения). Письмо тогда
   * не уходит, и алерт остаётся НЕдоставленным: это видно запросом, а не «ушло куда-то».
   */
  async function sendFor(rows: readonly AlertRow[], kind: 'EMAIL_IMMEDIATE' | 'EMAIL_DIGEST', build: (rows: AlertRow[], tenant: string, to: string) => MailMessage,
    outcome: DeliveryOutcome): Promise<void> {
    const platform = await deps.store.platformTenantId();
    for (const [tenantId, list] of byTenant(rows)) {
      // Платформенное событие адресовано оператору: у платформенного тенанта нет владельца-продавца
      const to = tenantId === platform ? deps.operatorEmail ?? null : await deps.store.ownerEmail(tenantId);
      if (!to) { await deps.store.markFailed(tenantId, list.map((r) => r.alertId), 'NO_OWNER_EMAIL'); outcome.failed += list.length; continue; }
      const tenant = await deps.store.tenantName(tenantId);
      /**
       * Находка 13 ревью шага 36: остановка канала на каталоге в 10 000 предложений давала 10 000 отдельных писем
       * одному владельцу. CRITICAL одного КОДА сворачивается в одно письмо с числом — событие видно, а ящик читаем.
       */
      const groups = kind === 'EMAIL_DIGEST' ? [list] : [...byCode(list).values()];
      for (const group of groups) {
        try {
          const { ref } = await deps.mail.send(build(group, tenant, to));
          const marked = await deps.store.markDelivered(tenantId, group.map((r) => r.alertId), kind, ref);
          outcome.delivered += marked;
          if (kind === 'EMAIL_IMMEDIATE') outcome.immediate += 1; else outcome.digests += 1;
        } catch (error) {
          // Причина — коротким кодом: адрес получателя и тело письма в журнал не попадают
          await deps.store.markFailed(tenantId, group.map((r) => r.alertId), String((error as Error).message ?? error).slice(0, 200));
          outcome.failed += group.length;
        }
      }
    }
  }

  return {
    /**
     * Один заход доставки. CRITICAL — каждое своим письмом. WARNING — дайджестом, но только когда самому старому
     * недоставленному уже больше периода дайджеста: иначе письмо уходило бы на каждое событие и переставало читаться.
     */
    async deliver(): Promise<DeliveryOutcome> {
      const outcome: DeliveryOutcome = { immediate: 0, digests: 0, delivered: 0, failed: 0 };
      const nowMs = Date.parse(deps.now());
      const before = new Date(nowMs - quietMs).toISOString();
      const critical = await deps.store.undelivered('CRITICAL', batchLimit, before);
      await sendFor(critical, 'EMAIL_IMMEDIATE',
        (rows, tenant, to) => (rows.length === 1 ? immediateMessage(rows[0]!, tenant, to, m) : repeatedMessage(rows, tenant, to, m)), outcome);

      const warnings = await deps.store.undelivered('WARNING', batchLimit, before);
      const ripe = [...byTenant(warnings).entries()]
        .filter(([, list]) => nowMs - Date.parse(list[0]!.raisedAt) >= digestMs)
        .flatMap(([, list]) => list);
      await sendFor(ripe, 'EMAIL_DIGEST', (rows, tenant, to) => digestMessage(rows, tenant, to, m), outcome);
      return outcome;
    },
  };
}

export type AlertDelivery = ReturnType<typeof createAlertDelivery>;
