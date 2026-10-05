import { demoTitle } from '../live/demo-world.ts';

/**
 * Шаг 71: синтетический каталог для kill-test — три варианта колонок, как три разные выгрузки клиента. Данные выдуманы целиком
 * (названия — синтетические названия демо, SKU — SYN-KT-*, ASIN-подобные — с приставкой SYN): настоящих данных продавцов в репозитории
 * нет и не бывает. Генератор детерминирован семенем.
 *  - `simple` — шаблон, который мы просим заполнить: sku, title, price, quantity, cost, sales_30d (запятая, точка в дробях);
 *  - `listings` — табуляция и колонки отчёта о листингах (item-name, seller-sku, price, quantity, asin1 и лишние), себестоимости нет;
 *  - `business` — кавычки, доллары с разделителями тысяч, «Your Price», «Available», «Unit Cost», «Units Ordered», лишние колонки и пять
 *    намеренно негодных строк (без цены, повтор SKU, цена «10.505», без SKU, цена в евро).
 */

export type SyntheticVariant = 'simple' | 'listings' | 'business';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SyntheticItem { sku: string; title: string; priceMinor: number; quantity: number; costMinor: number | null; sales30d: number }

export function syntheticItems(count: number, seed = 71): SyntheticItem[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const priceMinor = 500 + Math.floor(r() * 7500);
    // Каждый десятый товар — без себестоимости: честная пометка отчёта «без себестоимости движок не стартует» проверяется на них
    const usual = i % 10 === 9 ? null : Math.round(priceMinor * (0.3 + r() * 0.3));
    // Каждый двадцать пятый (со своей себестоимостью) — себестоимость 80 % цены: при комиссии 15 % и марже 10 % нынешняя цена ниже пола
    // маржи, и пометка отчёта «движок поднял бы цену» проверяется на них (ревью шага 71, находка 5)
    const costMinor = usual !== null && i % 25 === 24 ? Math.round(priceMinor * 0.8) : usual;
    return { sku: `SYN-KT-${String(i + 1).padStart(4, '0')}`, title: demoTitle(i), priceMinor, quantity: Math.floor(r() * 60), costMinor, sales30d: Math.floor(r() * 120) };
  });
}

const dollars = (minor: number, thousands = false): string => {
  const whole = Math.trunc(minor / 100);
  const w = thousands ? whole.toLocaleString('en-US') : String(whole);
  return `${w}.${String(minor % 100).padStart(2, '0')}`;
};
const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;

export function syntheticCatalog(variant: SyntheticVariant, count = 300, seed = 71): string {
  const items = syntheticItems(count, seed);
  if (variant === 'simple') {
    return ['sku,title,price,quantity,cost,sales_30d',
      ...items.map((x) => [x.sku, quote(x.title), dollars(x.priceMinor), x.quantity, x.costMinor === null ? '' : dollars(x.costMinor), x.sales30d].join(','))].join('\n') + '\n';
  }
  if (variant === 'listings') {
    const head = ['item-name', 'item-description', 'listing-id', 'seller-sku', 'price', 'quantity', 'open-date', 'asin1', 'fulfillment-channel', 'item-condition'];
    return [head.join('\t'), ...items.map((x, i) => [x.title, '', `SYN-LID-${i + 1}`, x.sku, dollars(x.priceMinor), x.quantity, '2026-01-15 10:00:00 PST',
      `SYN${String(1_000_000 + i).padStart(7, '0')}`, 'DEFAULT', '11'].join('\t'))].join('\n') + '\n';
  }
  const head = ['SKU', 'Title', 'Your Price', 'Available', 'Unit Cost', 'Units Ordered', 'Ordered Product Sales', 'Sessions - Total'];
  const lines = items.map((x) => [x.sku, x.title, `$${dollars(x.priceMinor, true)}`, String(x.quantity), x.costMinor === null ? '' : `$${dollars(x.costMinor, true)}`,
    String(x.sales30d), `$${dollars(x.priceMinor * x.sales30d, true)}`, String(x.sales30d * 7)].map(quote).join(','));
  // Пять негодных строк — по одной на причину; всего строк данных — count (последние пять товаров заменены)
  const bad = [
    ['SYN-KT-BAD1', 'Synthetic bad row, no price', '', '3', '$2.00', '1', '$0.00', '1'],
    [items[0]!.sku, 'Synthetic duplicate SKU', '$9.99', '1', '$2.00', '1', '$9.99', '1'],
    ['SYN-KT-BAD3', 'Synthetic ambiguous price', '10.505', '2', '$2.00', '1', '$0.00', '1'],
    ['', 'Synthetic row without SKU', '$4.99', '1', '$1.00', '1', '$4.99', '1'],
    ['SYN-KT-BAD5', 'Synthetic price in euros', '€12,00', '1', '$1.00', '1', '$0.00', '1'],
  ].map((row) => row.map(quote).join(','));
  return [head.map(quote).join(','), ...lines.slice(0, count - bad.length), ...bad].join('\r\n') + '\r\n';
}
