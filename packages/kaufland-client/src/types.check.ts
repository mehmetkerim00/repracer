// Проверка контракта типов на этапе компиляции (только tsc, не выполняется).
// Типизированный request должен принимать поля спецификации и отвергать всё остальное.
import type { KauflandClient } from './transport.ts';

declare const client: KauflandClient;

export async function typeContract(): Promise<void> {
  await client.request('patch', '/units/{id_unit}', {
    path: { id_unit: 1 },
    query: { storefront: 'de' },
    body: { listing_price: 1999, amount: 5 },
  });

  await client.request('post', '/units/bulk', {
    query: { storefront: 'at' },
    body: [{ id_unit: 1, unit_data: { listing_price: 1999 } }],
  });

  await client.request('get', '/units/{id_unit}', { path: { id_unit: 1 }, query: { storefront: 'de' } });

  await client.request('patch', '/units/{id_unit}', {
    path: { id_unit: 1 },
    query: { storefront: 'de' },
    // @ts-expect-error опечатка в имени поля
    body: { listing_prise: 1999 },
  });

  await client.request('patch', '/units/{id_unit}', {
    path: { id_unit: 1 },
    // @ts-expect-error витрины нет в спецификации
    query: { storefront: 'xx' },
    body: { amount: 1 },
  });

  // @ts-expect-error у пути нет метода POST
  await client.request('post', '/units/{id_unit}', {});
}
