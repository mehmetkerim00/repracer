/**
 * Р-134 (шаг 28): сопоставление колонок выгрузки с полями импорта — С ПОДСКАЗКАМИ, но решает продавец. Подсказка — это совпадение
 * заголовка со словарём синонимов (русский, немецкий, английский) или узнаваемая форма значений в колонке. Ни одна подсказка не
 * применяется молча: экран показывает, что именно мы предположили, и даёт исправить.
 */
export type ImportField = 'offerKey' | 'unitCostMinor' | 'currency' | 'fixedFeeMinor' | 'feeRateBp';

export interface FieldDefinition {
  field: ImportField;
  /** Без этой колонки импорт невозможен */
  required: boolean;
  synonyms: readonly string[];
}

/**
 * Ключ оффера — то, чем продавец называет товар в своей выгрузке: наш SKU товара, идентификатор оффера канала или EAN.
 * Что именно это было, решает сопоставление со списком офферов, а не заголовок колонки.
 */
export const IMPORT_FIELDS: readonly FieldDefinition[] = [
  {
    field: 'offerKey', required: true,
    synonyms: ['sku', 'артикул', 'артикул товара', 'код товара', 'товар', 'ean', 'gtin', 'штрихкод', 'barcode', 'asin', 'id_offer',
      'offer id', 'offerid', 'unit', 'id unit', 'id_unit', 'artikelnummer', 'artikel', 'produkt', 'produktnummer', 'item', 'item id'],
  },
  {
    field: 'unitCostMinor', required: true,
    synonyms: ['себестоимость', 'закупка', 'закупочная цена', 'цена закупки', 'cost', 'unit cost', 'purchase price', 'cost price',
      'buying price', 'einstandspreis', 'einkaufspreis', 'ek', 'ek-preis', 'kosten', 'wareneinsatz'],
  },
  {
    field: 'currency', required: false,
    synonyms: ['валюта', 'currency', 'währung', 'waehrung', 'curr', 'ccy'],
  },
  {
    field: 'fixedFeeMinor', required: false,
    synonyms: ['фиксированная комиссия', 'комиссия фикс', 'fixed fee', 'fee fixed', 'versandkosten', 'fixkosten', 'handling'],
  },
  {
    field: 'feeRateBp', required: false,
    synonyms: ['комиссия', 'комиссия %', 'процент комиссии', 'fee', 'fee %', 'commission', 'provision', 'provision %', 'gebühr', 'gebuehr'],
  },
];

export type ColumnMapping = Partial<Record<ImportField, number>>;

export interface ColumnSuggestion {
  field: ImportField;
  columnIndex: number;
  /** Почему предложено: продавец должен видеть основание, а не магию */
  reason: 'HEADER_EXACT' | 'HEADER_CONTAINS' | 'VALUES_LOOK_LIKE_MONEY' | 'VALUES_LOOK_LIKE_CURRENCY';
}

const normalize = (header: string) => header.trim().toLowerCase().replace(/[_.]+/g, ' ').replace(/\s+/g, ' ').replace(/[()[\]]/g, '');

const MONEY = /^-?\d{1,9}([.,]\d{1,4})?$/;
const CURRENCY_CODE = /^(eur|usd)$/i;

/** Подсказки по заголовкам и значениям; одна колонка предлагается одному полю, первое совпадение сильнее */
export function suggestMapping(sheet: { rows: readonly (readonly string[])[] }, headerRow = 0): { suggestions: ColumnSuggestion[]; mapping: ColumnMapping } {
  const headers = (sheet.rows[headerRow] ?? []).map(normalize);
  const body = sheet.rows.slice(headerRow + 1, headerRow + 21);
  const suggestions: ColumnSuggestion[] = [];
  const taken = new Set<number>();
  const take = (field: ImportField, columnIndex: number, reason: ColumnSuggestion['reason']) => {
    if (taken.has(columnIndex) || suggestions.some((s) => s.field === field)) return;
    taken.add(columnIndex);
    suggestions.push({ field, columnIndex, reason });
  };
  for (const definition of IMPORT_FIELDS) {
    const exact = headers.findIndex((h) => definition.synonyms.includes(h));
    if (exact >= 0) take(definition.field, exact, 'HEADER_EXACT');
  }
  for (const definition of IMPORT_FIELDS) {
    const contains = headers.findIndex((h) => h !== '' && definition.synonyms.some((s) => h.includes(s)));
    if (contains >= 0) take(definition.field, contains, 'HEADER_CONTAINS');
  }
  // Заголовков может не быть вовсе: тогда колонку узнаём по значениям — деньги и код валюты видно сразу
  const columnValues = (c: number) => body.map((r) => (r[c] ?? '').trim()).filter((v) => v !== '');
  const width = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
  for (let c = 0; c < width; c += 1) {
    const values = columnValues(c);
    if (values.length === 0) continue;
    if (values.every((v) => CURRENCY_CODE.test(v))) take('currency', c, 'VALUES_LOOK_LIKE_CURRENCY');
    else if (values.every((v) => MONEY.test(v))) take('unitCostMinor', c, 'VALUES_LOOK_LIKE_MONEY');
  }
  const mapping: ColumnMapping = {};
  for (const s of suggestions) mapping[s.field] = s.columnIndex;
  return { suggestions, mapping };
}

export function missingRequiredFields(mapping: ColumnMapping): ImportField[] {
  return IMPORT_FIELDS.filter((d) => d.required && mapping[d.field] === undefined).map((d) => d.field);
}
