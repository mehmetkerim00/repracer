/**
 * Шаги 110.3 и 110.5 (решения владельца): предел времени, поднятый выше цели из-за медленной группы раннеров CI, — времянка. Пока предел
 * выше цели, у него есть обратный билет — строка таблицы docs/deferred.md: по теме её узнают, обещание возврата названо словами. Предел
 * без билета — находка, и тест, который её зовёт, красит сборку: временное не становится постоянным молча
 */
export interface ReturnTicket {
  /** Действующий предел, секунды */
  readonly limit: number;
  /** Цель, к которой предел вернётся, секунды */
  readonly target: number;
  /** Слова, по которым строку отложенного узнают */
  readonly topic: string;
  /** Обещание возврата, как оно записано в строке */
  readonly promise: string;
}

export function returnTicketFindings(deferred: string, { limit, target, topic, promise }: ReturnTicket): string[] {
  if (limit <= target) return [];
  const ticket = deferred.split('\n').find((line) => line.startsWith('|') && line.includes(topic) && line.includes(promise));
  return ticket ? [] : [`предел ${limit} с выше цели ${target} с, а в docs/deferred.md нет строки «${topic} … ${promise}»`];
}
