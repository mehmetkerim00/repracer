import { deflateRawSync } from 'node:zlib';

/**
 * Синтетическая книга XLSX для тестов: тот же формат, что пишут Excel и выгрузки каналов (ZIP с XML). Ячейка-число (цифры, точка, знак, экспонента) —
 * число (`<v>` без типа), иначе — общая строка. Данные синтетические. Помощник общий у импорта себестоимости и kill-test (шаг 72).
 */
export function xlsx(rows: string[][], options: { deflate?: boolean }): Buffer {
  const shared: string[] = [];
  const indexOf = (value: string) => {
    const at = shared.indexOf(value);
    if (at >= 0) return at;
    shared.push(value);
    return shared.length - 1;
  };
  const xmlRows = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === '') return '';
      const reference = `${String.fromCharCode(65 + c)}${r + 1}`;
      return /^-?[0-9.]+([eE][-+]?[0-9]+)?$/.test(value) ? `<c r="${reference}"><v>${value}</v></c>` : `<c r="${reference}" t="s"><v>${indexOf(value)}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheet = `<?xml version="1.0"?><worksheet><sheetData>${xmlRows}</sheetData></worksheet>`;
  const strings = `<?xml version="1.0"?><sst count="${shared.length}">${shared.map((s) => `<si><t>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></si>`).join('')}</sst>`;
  const workbook = '<?xml version="1.0"?><workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const rels = '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>';
  return zip([
    ['xl/workbook.xml', workbook],
    ['xl/_rels/workbook.xml.rels', rels],
    ['xl/sharedStrings.xml', strings],
    ['xl/worksheets/sheet1.xml', sheet],
  ], options.deflate === true);
}

export function zip(entries: Array<[string, string]>, deflate: boolean, options: { declaredSize?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(options.declaredSize ?? raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(options.declaredSize ?? raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

