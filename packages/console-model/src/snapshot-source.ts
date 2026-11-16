import type { Messages } from './i18n/index.ts';

/**
 * Шаг 143 (внешний аудит UX, корзина 1.1): источник снимка конкурентов на экране — ЧТО прочитано и КАК пришло: уведомлением канала,
 * нашим опросом, отчётом канала или от симулятора демо. Было: демо США подаёт снимки модели amazon.com прямо в путь решения, а квитанция
 * говорила «Amazon, notification of a competitor price change», хотя приёмника уведомлений нет и Channels честно пишет «polling only».
 */
export type SourceDelivery = 'NOTIFICATION' | 'POLLING' | 'REPORT' | 'SIMULATOR';

/**
 * Как источник доставляет данные — тот же `kind`, что в описании канала (`CompetitorSourceDescriptor.kind`). Страница консоли описаний
 * каналов не импортирует (серверные пакеты), поэтому таблица здесь, а равенство с описаниями держит правило шага 143 в
 * tests/contract/src/console.test.ts. Источник, которого нет в таблице, называется без способа: способ не придумывается
 */
export const SOURCE_KIND: Readonly<Record<string, 'PUSH' | 'PULL' | 'REPORT'>> = {
  KAUFLAND_BUY_BOX_CHANGED: 'PUSH',
  KAUFLAND_BUYBOX: 'PULL',
  KAUFLAND_COMPETITORS_COMPARER: 'REPORT',
  AMAZON_ANY_OFFER_CHANGED: 'PUSH',
  AMAZON_COMPETITIVE_SUMMARY: 'PULL',
  WALMART_BUY_BOX: 'PULL',
};

const BY_KIND = { PUSH: 'NOTIFICATION', PULL: 'POLLING', REPORT: 'REPORT' } as const;

/** Демо — симулятор у любого источника: признак тенанта демо из базы (`tenant.demo`, Р-151), данные демо синтетические целиком */
export function sourceDelivery(source: string, demo: boolean): SourceDelivery | null {
  if (demo) return 'SIMULATOR';
  const kind = SOURCE_KIND[source];
  return kind ? BY_KIND[kind] : null;
}

/** Строка «источник» квитанции и страницы Competition: слова источника и способ доставки; код источника на экран не выходит (шаг 93) */
export function snapshotSourceText(source: string, demo: boolean, m: Messages): string {
  const what = (m.ui.sources as Record<string, string | undefined>)[source] ?? m.ui.trace.sourceUnnamed;
  const how = sourceDelivery(source, demo);
  return how ? m.ui.sourceDelivery.line(what, m.ui.sourceDelivery[how]) : what;
}
