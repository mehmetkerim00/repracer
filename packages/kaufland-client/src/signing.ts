import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Подпись запроса Kaufland Seller API v2 (https://sellerapi.kaufland.com/?page=rest-api#signing-requests):
 * HMAC-SHA256 от строки `METHOD\nURI\nBODY\nTIMESTAMP` секретным ключом.
 *
 * Документация в тексте называет кодировку base64, но все официальные примеры (PHP, Python, Java) и тестовый вектор
 * дают hex. Реализован hex; вектор проверяется в signing.selftest.ts. Вопрос отправлен в поддержку (channel-capabilities.md).
 */
export interface SignatureInput {
  /** HTTP-метод в верхнем регистре */
  method: string;
  /** Полный URI с https://, доменом, путём и строкой запроса — ровно как отправляется */
  uri: string;
  /** Тело запроса ровно как отправляется; пустая строка, если тела нет */
  body: string;
  /** Unix-время в секундах; то же значение, что в заголовке Shop-Timestamp */
  timestamp: number;
  /** Секретный ключ как строка (не декодировать как hex) */
  secretKey: string;
}

export function signKauflandRequest(input: SignatureInput): string {
  const plain = [input.method.toUpperCase(), input.uri, input.body, String(input.timestamp)].join('\n');
  return createHmac('sha256', input.secretKey).update(plain, 'utf8').digest('hex');
}

/**
 * Проверка подписи push-уведомления (https://sellerapi.kaufland.com/?page=push-notifications).
 * Документация: подпись вычисляется «той же функцией», что и подпись запросов, ключом key_secret, время — заголовок
 * Shop-Timestamp. Какие method и uri участвуют в подписи уведомления и чей секрет (продавца или технологического
 * партнёра) используется — в документации не указано (вопрос в поддержку). Параметры передаются явно, чтобы не зашивать
 * непроверенное допущение.
 */
export function verifyKauflandSignature(input: SignatureInput, receivedSignature: string): boolean {
  const expected = Buffer.from(signKauflandRequest(input), 'utf8');
  const received = Buffer.from(receivedSignature.trim().toLowerCase(), 'utf8');
  return expected.length === received.length && timingSafeEqual(expected, received);
}
