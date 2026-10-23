/**
 * Шаг 107 [Р-232]: имя продавца-конкурента — внешняя ссылка на его страницу на площадке, но ТОЛЬКО из настоящего идентификатора,
 * который дал канал. Мёртвая ссылка хуже текста: продавец кликнет и решит, что продукт сломан.
 *
 * - Amazon: SellerId предложения в уведомлении ANY_OFFER_CHANGED (схема снимка `vendor/amazon/sp-api-models`) — страница продавца
 *   `https://www.amazon.<витрина>/sp?seller=<SellerId>`. Формат адреса — факт владельца с публичными подтверждениями
 *   (docs/channels/amazon.md): официальной документации SP-API у него нет. Адрес — только у витрин, для которых он записан ниже.
 * - SellerId в схеме — латинские заглавные буквы и цифры («A3TH9S8BH6GOGM»). Имя с пробелами — синтетика симулятора и демо, а не
 *   идентификатор: текстом. Демо — синтетика целиком: текстом при любой форме.
 * - Kaufland называет продавца псевдонимом, у Walmart адрес страницы продавца не известен (W-вопросы), eBay конкурентов не даёт — текст.
 * - «You» и неизвестный держатель (Amazon не называет держателя Buy Box, A-29) ссылками не становятся никогда.
 */
/** Страница продавца по каналу и витрине; канал — часть ключа: идентификатор продавца одного канала не открывает страниц другого */
const SELLER_PAGE: Readonly<Record<string, { id: RegExp; url: (id: string) => string }>> = {
  'AMAZON|ATVPDKIKX0DER': { id: /^[A-Z0-9]{8,20}$/, url: (id) => `https://www.amazon.com/sp?seller=${encodeURIComponent(id)}` },
  'AMAZON|A1PA6795UKMFR9': { id: /^[A-Z0-9]{8,20}$/, url: (id) => `https://www.amazon.de/sp?seller=${encodeURIComponent(id)}` },
};

export interface SellerLinkInput {
  channel: string;
  marketplace: string;
  /** Идентификатор продавца, который назвал канал; нет — текст */
  sellerRef: string | null | undefined;
  /** Наша строка */
  self: boolean;
  /** Пространство демо: продавцы синтетические */
  demo: boolean;
}

export function sellerLink(input: SellerLinkInput): string | null {
  if (input.self || input.demo || !input.sellerRef) return null;
  const page = SELLER_PAGE[`${input.channel}|${input.marketplace}`];
  return page && page.id.test(input.sellerRef) ? page.url(input.sellerRef) : null;
}
