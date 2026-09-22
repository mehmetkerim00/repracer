/**
 * Р-156 (шаг 36): отправка письма владельцу. Провайдер конфигурируем: развёртывание называет адрес HTTP-API провайдера,
 * ключ (из файла секретов) и адрес отправителя. Своего SMTP мы не поднимаем и новых зависимостей не вводим — письмо
 * уходит обычным `fetch` тем же способом, что и отметка внешнего контроля [Р-127].
 *
 * Чего этот отправитель НЕ делает: не повторяет отправку (повтор — дело работы планировщика, у неё растущая пауза
 * [Р-132]) и не пишет в журнал ни адреса получателя, ни тела письма — только код ошибки провайдера.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface MailConfig {
  /** Адрес HTTP-API провайдера: тело — JSON `{from, to, subject, text}` */
  apiUrl: string;
  /** Ключ провайдера: только из файла секретов развёртывания */
  apiKey: string;
  /** От кого: адрес, за которым закреплён домен отправителя */
  from: string;
  timeoutMs?: number;
}

export function createMailSender(config: MailConfig, fetchImpl: typeof fetch = fetch) {
  if (!config.apiUrl.startsWith('https://')) throw new Error('CONFIG_INVALID: mail api url must be https');
  return {
    async send(message: MailMessage): Promise<{ ref: string }> {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, config.timeoutMs ?? 10_000);
      try {
        const response = await fetchImpl(config.apiUrl, {
          method: 'POST', signal: controller.signal,
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: config.from, to: message.to, subject: message.subject, text: message.text }),
        });
        if (!response.ok) throw new Error(`MAIL_HTTP_${response.status}`);
        // Идентификатор письма у провайдера — доказательство отправки; его формат у провайдеров разный, поэтому терпим любой
        const body = await response.json().catch(() => ({})) as { id?: unknown; messageId?: unknown };
        const ref = typeof body.id === 'string' ? body.id : typeof body.messageId === 'string' ? body.messageId : `sent-${Date.now()}`;
        return { ref };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
