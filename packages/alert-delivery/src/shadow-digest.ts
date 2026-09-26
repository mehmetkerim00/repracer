import { LOCALES, messagesFor, type Locale } from '@repracer/console-model';
import type { ShadowDigestRecord, ShadowDigestTarget } from '@repracer/pricing-store-pg';
import type { MailMessage, MailSender } from './index.ts';

/**
 * Р-171 (шаг 41): недельный дайджест теневого режима. Продавец, подключивший канал «посмотреть», не станет каждый день
 * открывать экран — а решение включать бой он примет по числам. Письмо несёт ТЕ ЖЕ числа, что экран, человеческим
 * языком и на языке ТЕНАНТА [Р-161].
 *
 * Шаг 42 [Р-173]: письмо говорит ДЕНЬГАМИ — «пол удержал цену N раз; без него вы продали бы на X дешевле». X приходит
 * готовым агрегатом по каждой валюте [Р-71]: роль доставки по-прежнему не имеет ни одного права на решения о цене, и
 * отдельной цены в письме нет. Граница сдвинулась осознанно — разница цен по тенанту это не цена предложения.
 *
 * Чего в письме нет: обещания заработка. Купил бы покупатель дешевле — мы не знаем и не обещаем (OQ-230).
 *
 * Шаг 42 [Р-174]: у каждого письма есть СТРОКА ПЕРИОДА с отметкой доставки. Второе письмо за тот же период не уходит —
 * это держит база, а не осторожность процесса.
 */

export interface ShadowDigestDeps {
  store: {
    targets(sinceDays: number): Promise<ShadowDigestTarget[]>;
    record(target: ShadowDigestTarget): Promise<ShadowDigestRecord>;
    markDelivered(tenantId: string, digestId: string, delivery: { kind: 'EMAIL_DIGEST' | 'DRY_RUN'; ref: string | null }): Promise<void>;
    markFailed(tenantId: string, digestId: string, error: string): Promise<void>;
  };
  mail: MailSender;
  /** Часы нужны отметке доставки [Р-174]: период письма считается от них, а не от часов машины */
  now: () => string;
  /** Окно отчёта; неделя по умолчанию */
  sinceDays?: number;
  /** Язык, когда язык тенанта не из словаря консоли [Р-161] */
  locale?: Locale;
  log?: (line: string) => void;
}

export interface ShadowDigestOutcome {
  /** Сколько писем ушло */
  letters: number;
  /** Тенанты в тени, у которых за период не было ни одного решения: письмо не отправляется */
  quiet: number;
  /** Тенанты в тени без адреса владельца: письмо некому отправить, и это видно числом */
  noRecipient: number;
  failed: number;
  /** Письмо за этот период уже ДОСТАВЛЕНО: второе не отправляется [Р-174] */
  alreadySent: number;
}

export function shadowDigestMessage(target: ShadowDigestTarget, to: string, m: ReturnType<typeof messagesFor>): MailMessage {
  const t = m.ui.shadow;
  const lines = [
    t.digest.intro(target.tenantName, target.shadowAccounts),
    '',
    t.summary.decisions(target.decisions, target.changes),
    t.summary.floorHeld(target.floorHeld),
    t.summary.ceilingHeld(target.ceilingHeld),
    t.summary.held(target.heldWrites, target.heldPriceWrites, target.heldQuantityWrites),
    t.summary.budget(target.wouldSpendBudget),
    /**
     * Р-173: деньги — только когда пол действительно удерживал цену. «На 0,00 € дешевле» приучает не читать письмо, и
     * рядом с числом стоит оговорка: это разница цен, а не прогноз выручки.
     */
    ...(target.floorSavings.length > 0
      ? [t.summary.savings(target.floorSavings.map((x) => m.money(x.minor, x.currency)).join(', '), target.floorSavingsHolds), t.summary.savingsNote]
      : []),
    '',
    t.digest.cta,
    '',
    t.cannot,
  ];
  return { to, subject: t.digest.subject(target.tenantName), text: lines.join('\n') };
}

export function createShadowDigest(deps: ShadowDigestDeps) {
  const sinceDays = deps.sinceDays ?? 7;
  const fallback = deps.locale ?? 'de';
  const log = deps.log ?? ((line: string) => console.log(line));
  const localeOf = (value: string): Locale => (LOCALES.includes(value as Locale) ? (value as Locale) : fallback);
  return {
    async send(): Promise<ShadowDigestOutcome> {
      const outcome: ShadowDigestOutcome = { letters: 0, quiet: 0, noRecipient: 0, failed: 0, alreadySent: 0 };
      for (const target of await deps.store.targets(sinceDays)) {
        /**
         * Тишина — не повод для письма: тенант, у которого за неделю не было ни одного решения, ещё не настроил
         * предложения, и письмо «ноль из нуля» научило бы его не читать наши письма.
         */
        if (target.decisions === 0 && target.heldWrites === 0) {
          outcome.quiet += 1;
          continue;
        }
        if (target.ownerEmail === null) {
          // Адрес владельца — единственный получатель [Р-156]; его отсутствие видно числом, а не тишиной
          outcome.noRecipient += 1;
          log(JSON.stringify({ level: 'WARN', code: 'SHADOW_DIGEST_NO_RECIPIENT', message: 'у теневого тенанта нет активного владельца', details: { tenantId: target.tenantId } }));
          continue;
        }
        /**
         * Р-174: строка периода пишется ДО отправки, и повторный прогон смотрит на ОТМЕТКУ ДОСТАВКИ, а не на наличие
         * строки (находка 3 ревью шага 42). Доставлено — второе письмо не уходит; строка есть, а отметки нет — письмо не
         * ушло (отказ провайдера или падение процесса между записью и отправкой), и прогон обязан попробовать снова.
         */
        const record = await deps.store.record(target);
        if (record.delivered) {
          outcome.alreadySent += 1;
          log(JSON.stringify({ level: 'INFO', code: 'SHADOW_DIGEST_ALREADY_SENT', message: 'дайджест за этот период уже доставлен',
            details: { tenantId: target.tenantId, digestId: record.digestId } }));
          continue;
        }
        if (record.alreadyRecorded) {
          log(JSON.stringify({ level: 'WARN', code: 'SHADOW_DIGEST_RETRY', message: 'дайджест за этот период записан, но не доставлен: повтор',
            details: { tenantId: target.tenantId, digestId: record.digestId } }));
        }
        const message = shadowDigestMessage(target, target.ownerEmail, messagesFor(localeOf(target.locale)));
        try {
          const sent = await deps.mail.send(message);
          await deps.store.markDelivered(target.tenantId, record.digestId, {
            kind: deps.mail.dry ? 'DRY_RUN' : 'EMAIL_DIGEST', ref: sent.ref ?? null });
          outcome.letters += 1;
          // В журнал — код, тенант и признак сухого режима; ни адреса, ни текста письма [Р-148]
          log(JSON.stringify({ level: 'INFO', code: 'SHADOW_DIGEST_SENT', message: 'дайджест теневого режима отправлен',
            details: { tenantId: target.tenantId, ref: sent.ref, dry: Boolean(deps.mail.dry), decisions: target.decisions, held: target.heldWrites } }));
        } catch (error) {
          outcome.failed += 1;
          // Отметки доставки у строки нет, и это ВИДНО запросом: письмо, которое не ушло, не считается доставленным [Р-174]
          await deps.store.markFailed(target.tenantId, record.digestId, error instanceof Error ? error.message : String(error));
          log(JSON.stringify({ level: 'ERROR', code: 'SHADOW_DIGEST_FAILED', message: error instanceof Error ? error.message : String(error), details: { tenantId: target.tenantId } }));
        }
      }
      return outcome;
    },
  };
}
