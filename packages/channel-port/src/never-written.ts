import type { Channel, WriteField } from './primitives.ts';

/**
 * Поля канала, которые ядро не пишет [Р-12, Р-111]. Это запрет, а не пометка «проверить»: собственный пол цены канала —
 * вероятный включатель автоматического ценообразования площадки (у Kaufland — Smart Pricing, у Amazon — A-05). Две системы,
 * меняющие одну цену, — отказ, который клиент припишет нам.
 *
 * Поле порта CHANNEL_MIN_PRICE база разрешает только у Kaufland и только в явном режиме тенанта Smart Pricing, где наш движок
 * выключен (0077: channel_capability_channel_min_price_only_kaufland, write_scope_smart_pricing_only_kaufland, триггер
 * channel_write); до ответа поддержки этот режим не включается ни у кого [Р-41].
 */
export const NEVER_WRITTEN_CHANNEL_ATTRIBUTES: ReadonlyArray<{
  channel: Channel;
  attribute: string;
  portField: WriteField;
  decision: string;
  exception: string | null;
}> = [
  { channel: 'KAUFLAND', attribute: 'minimum_price', portField: 'CHANNEL_MIN_PRICE', decision: 'Р-12',
    exception: 'явный режим тенанта KAUFLAND_SMART_PRICING на единице записи; не включается до ответа поддержки [Р-41]' },
  { channel: 'AMAZON', attribute: 'minimum_seller_allowed_price', portField: 'CHANNEL_MIN_PRICE', decision: 'Р-111', exception: null },
];

/** Запись этого поля в этот канал запрещена без исключения */
export function isNeverWritten(channel: Channel, field: WriteField): boolean {
  return NEVER_WRITTEN_CHANNEL_ATTRIBUTES.some((a) => a.channel === channel && a.portField === field && a.exception === null);
}
