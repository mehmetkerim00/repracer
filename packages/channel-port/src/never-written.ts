import type { Channel, WriteField } from './primitives.ts';

/**
 * Атрибуты канала, которые ядро и адаптеры не пишут [Р-12, Р-111, Р-114]. Это запрет, а не пометка «проверить».
 *
 * Причины разные, и Р-114 исправила причину Р-111:
 * - `CHANNEL_REPRICER` — атрибут включает собственное автоматическое ценообразование канала: две системы, меняющие одну цену, —
 *   отказ, который клиент припишет нам. Kaufland `minimum_price` (Smart Pricing, Р-12); Amazon
 *   `automated_pricing_merchandising_rule_plan` — привязка оффера к правилу автоматического ценообразования (Р-114).
 * - `SECOND_BOUNDS` — атрибут создаёт второй набор границ на стороне канала: базовая цена обязана лежать между ними, иначе канал
 *   отклоняет запись (Р-114, решение владельца). Наши границы должны быть единственными. Amazon `minimum_seller_allowed_price` и
 *   `maximum_seller_allowed_price` — сами репрайсер Amazon не включают (Р-114 исправляет Р-111).
 *
 * Поле порта CHANNEL_MIN_PRICE база разрешает только у Kaufland и только в явном режиме тенанта Smart Pricing, где наш движок
 * выключен (0077); до ответа поддержки этот режим не включается ни у кого [Р-41]. У остальных атрибутов поля порта нет:
 * адаптер не может их отправить, а контрактный стенд проверяет, что их нет ни в одном теле запроса.
 */
export type NeverWrittenReason = 'CHANNEL_REPRICER' | 'SECOND_BOUNDS';

export const NEVER_WRITTEN_CHANNEL_ATTRIBUTES: ReadonlyArray<{
  channel: Channel;
  attribute: string;
  /** Поле порта, через которое атрибут можно было бы записать; null — поля нет */
  portField: WriteField | null;
  reason: NeverWrittenReason;
  decision: string;
  exception: string | null;
}> = [
  { channel: 'KAUFLAND', attribute: 'minimum_price', portField: 'CHANNEL_MIN_PRICE', reason: 'CHANNEL_REPRICER', decision: 'Р-12',
    exception: 'явный режим тенанта KAUFLAND_SMART_PRICING на единице записи; не включается до ответа поддержки [Р-41]' },
  { channel: 'AMAZON', attribute: 'automated_pricing_merchandising_rule_plan', portField: null, reason: 'CHANNEL_REPRICER', decision: 'Р-114', exception: null },
  { channel: 'AMAZON', attribute: 'minimum_seller_allowed_price', portField: 'CHANNEL_MIN_PRICE', reason: 'SECOND_BOUNDS', decision: 'Р-111, Р-114', exception: null },
  { channel: 'AMAZON', attribute: 'maximum_seller_allowed_price', portField: null, reason: 'SECOND_BOUNDS', decision: 'Р-114', exception: null },
];

/** Запись этого поля порта в этот канал запрещена без исключения */
export function isNeverWritten(channel: Channel, field: WriteField): boolean {
  return NEVER_WRITTEN_CHANNEL_ATTRIBUTES.some((a) => a.channel === channel && a.portField === field && a.exception === null);
}

/** Атрибуты канала, которых не должно быть ни в одном теле запроса записи */
export function neverWrittenAttributes(channel: Channel): string[] {
  return NEVER_WRITTEN_CHANNEL_ATTRIBUTES.filter((a) => a.channel === channel && a.exception === null).map((a) => a.attribute);
}
