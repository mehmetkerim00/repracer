import type { Channel, OfferIdentity, WriteField } from './primitives.ts';

/**
 * Единственное определение идентичности предложения для записи в канал (OQ-165, шаг 23). И путь решения, и диспетчер строят
 * `OfferIdentity` только этой функцией из строки `tenant_data.offer_mapping` (или её двойника в памяти). До шага 23 путь решения
 * передавал Amazon SKU в `externalUnitId`, а диспетчер — в `externalSku` с регионом; адаптер принимал оба варианта.
 *
 * Правило: у ключа записи — только поля, которые есть у предложения; `externalOfferId` — ключ остатка Kaufland [Р-35], у цены его нет.
 */
export interface OfferMappingKeys {
  channel: Channel;
  field: WriteField;
  region?: string | null;
  marketplace?: string | null;
  externalSku?: string | null;
  externalOfferId?: string | null;
  externalListingId?: string | null;
  externalUnitId?: string | null;
}

export function offerIdentityOf(k: OfferMappingKeys): OfferIdentity {
  const identity: OfferIdentity = {};
  if (k.region) identity.region = k.region;
  if (k.marketplace) identity.marketplace = k.marketplace;
  if (k.externalSku) identity.externalSku = k.externalSku;
  if (k.field === 'QUANTITY' && k.externalOfferId) identity.externalOfferId = k.externalOfferId;
  if (k.externalListingId) identity.externalListingId = k.externalListingId;
  if (k.externalUnitId) identity.externalUnitId = k.externalUnitId;
  return identity;
}
