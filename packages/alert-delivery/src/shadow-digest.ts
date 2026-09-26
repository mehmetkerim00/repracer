import { LOCALES, messagesFor, type Locale } from '@repracer/console-model';
import type { ShadowDigestTarget } from '@repracer/pricing-store-pg';
import type { MailMessage, MailSender } from './index.ts';

/**
 * Р-171 (шаг 41): недельный дайджест теневого режима. Продавец, подключивший канал «посмотреть», не станет каждый день
 * открывать экран — а решение включать бой он примет по числам. Письмо несёт ТЕ ЖЕ числа, что экран, человеческим
 * языком и на языке ТЕНАНТА [Р-161].
 *
 * Чего в письме нет: обещания заработка и ни одной цены. Роль доставки цен не видит (0120), и это не ограничение
 * реализации, а граница: письмо о том, СКОЛЬКО РАЗ движок что-то сделал бы, а не о том, сколько это стоило.
 */

export interface ShadowDigestDeps {
  store: { targets(sinceDays: number): Promise<ShadowDigestTarget[]> };
  mail: MailSender;
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
      const outcome: ShadowDigestOutcome = { letters: 0, quiet: 0, noRecipient: 0, failed: 0 };
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
        const message = shadowDigestMessage(target, target.ownerEmail, messagesFor(localeOf(target.locale)));
        try {
          const sent = await deps.mail.send(message);
          outcome.letters += 1;
          // В журнал — код, тенант и признак сухого режима; ни адреса, ни текста письма [Р-148]
          log(JSON.stringify({ level: 'INFO', code: 'SHADOW_DIGEST_SENT', message: 'дайджест теневого режима отправлен',
            details: { tenantId: target.tenantId, ref: sent.ref, dry: Boolean(deps.mail.dry), decisions: target.decisions, held: target.heldWrites } }));
        } catch (error) {
          outcome.failed += 1;
          log(JSON.stringify({ level: 'ERROR', code: 'SHADOW_DIGEST_FAILED', message: error instanceof Error ? error.message : String(error), details: { tenantId: target.tenantId } }));
        }
      }
      return outcome;
    },
  };
}
