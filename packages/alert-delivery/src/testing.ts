import type { MailMessage, MailSender } from './index.ts';

/**
 * Перехватчик почты для стенда и прогонов [Р-156]: письма никуда не уходят, но их СОДЕРЖИМОЕ проверяется утверждениями.
 * Модель понимает ровно то, что шлёт отправитель, и ничего не додумывает: письмо без получателя или без темы — отказ,
 * как у настоящего провайдера (образец — модель ClickHouse и модель очереди SQS).
 */
export class FakeMail implements MailSender {
  readonly sent: Array<MailMessage & { ref: string }> = [];
  /** Сколько ближайших отправок провалить: письмо, которое не ушло, доставленным не считается */
  failNext = 0;
  /**
   * Сухой режим провайдера (шаг 37): письмо собирается целиком и не уходит никуда. Прогону это нужно, чтобы проверить
   * ТРЕТИЙ вид отметки доставки [Р-174] — «собрано, не отправлено» отличается и от доставленного, и от провала.
   */
  dry = false;
  private no = 0;

  async send(message: MailMessage): Promise<{ ref: string }> {
    if (!message.to.includes('@')) throw new Error('MAIL_NO_RECIPIENT');
    if (message.subject.trim() === '' || message.text.trim() === '') throw new Error('MAIL_EMPTY');
    if (this.failNext > 0) { this.failNext -= 1; throw new Error('MAIL_PROVIDER_UNAVAILABLE'); }
    const ref = `fake-mail-${++this.no}`;
    this.sent.push({ ...message, ref });
    return { ref };
  }

  /** Письма, в теме или теле которых есть эта подстрока */
  matching(part: string): Array<MailMessage & { ref: string }> {
    return this.sent.filter((x) => x.subject.includes(part) || x.text.includes(part));
  }
}
