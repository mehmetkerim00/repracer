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

/**
 * Отправитель письма. `dry: true` — СУХОЙ РЕЖИМ (шаг 37, задача D): письмо собирается целиком и не уходит никуда.
 * Это не «выключено»: событие разбирается, текст строится, отметка в базе ставится видом `DRY_RUN`, и запросом видно,
 * что письма никто не получил. Провайдер подключается ключом и доменом — кода это не меняет (OQ-224).
 */
export interface MailSender {
  send(message: MailMessage): Promise<{ ref: string }>;
  dry?: boolean;
}

/**
 * Сухой режим по умолчанию: у проекта нет ни ключа провайдера, ни домена отправителя (OQ-224). Молчать об этом нельзя,
 * поэтому каждое несостоявшееся письмо оставляет строку журнала — БЕЗ получателя и без тела: в сухом режиме они такие
 * же настоящие, как в рабочем.
 */
export function createDryMailSender(log: (line: string) => void = (l) => console.log(l)): MailSender {
  let n = 0;
  return {
    dry: true,
    async send(message: MailMessage): Promise<{ ref: string }> {
      n += 1;
      log(JSON.stringify({ level: 'INFO', code: 'MAIL_DRY_RUN', message: 'письмо собрано и не отправлено: провайдер не настроен (OQ-224)', details: { subjectLength: message.subject.length, textLength: message.text.length, letter: n } }));
      return { ref: `dry-run-${n}` };
    },
  };
}

export function createMailSender(config: MailConfig, fetchImpl: typeof fetch = fetch): MailSender {
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
