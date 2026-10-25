import type { Cell, CellValue, Worksheet } from 'exceljs';

export const IMPORT_FIELDS = [
  ['doNo', 'DO no'], ['deliveryDate', 'Delivery date'], ['soldToParty', 'Sold to Party'],
  ['shipToParty', 'Ship to Party'], ['materialCode', 'Material code'], ['description', 'Description'],
  ['quantity', 'Qty'], ['unit', 'Unit'], ['deliveryLeadDays', 'Delivery lead days'], ['remark', 'Remark'],
  ['daysOutstanding', 'Days of outstanding'], ['medication', 'Medication'], ['fmrOmed', 'FMR / OMED'],
] as const;
export type ImportField = typeof IMPORT_FIELDS[number][0];
export type ColumnMapping = Record<ImportField, number>;
export type DateOrder = 'MDY' | 'DMY' | 'YMD';
export interface ExcelOrderRow {
  doNo: string; deliveryDate: string; soldToParty: string; shipToParty: string;
  materialCode: string; description: string; quantity: number; unit: 'MT' | 'Bags';
  deliveryLeadDays: number | null; remark: string; daysOutstanding: number | null;
  medication: string; fmrOmed: string;
}
export interface ImportedRow { rowNumber: number; data: ExcelOrderRow; errors: string[] }
export interface ImportBook { sheets: Worksheet[]; date1904: boolean; digest: string }
const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
const aliases: Record<ImportField, string[]> = {
  doNo: ['dono', 'donumber', 'deliveryorderno', 'deliveryorder'], deliveryDate: ['deliverydate'],
  soldToParty: ['soldtoparty', 'soldto'], shipToParty: ['shiptoparty', 'shipto'],
  materialCode: ['materialcode', 'material', 'materialno'], description: ['description', 'materialdescription'],
  quantity: ['qty', 'quantity'], unit: ['unit', 'uom'], deliveryLeadDays: ['deliveryleaddays', 'deliverylead'],
  remark: ['remark', 'remarks', 'status'], daysOutstanding: ['daysofoutstanding', 'daysoutstanding'],
  medication: ['medication'], fmrOmed: ['fmromed'],
};

/** Cached results only. Excel formulas, hyperlinks and external references are never executed. */
function cached(cell: Cell): CellValue {
  const value = cell.value;
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    // ExcelJS's value getter omits falsy cached results; cell.result retains numeric zero.
    const result = cell.result;
    if (result === undefined || result === null) throw new Error('Formula has no cached result');
    return result;
  }
  return value;
}
export function cellText(cell: Cell): string {
  const value = cached(cell);
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    if ('error' in value) throw new Error('Excel error: ' + value.error);
    if ('richText' in value) return value.richText.map(part => part.text).join('').trim();
    if ('text' in value) return String(value.text).trim();
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    throw new Error('Unsupported cell value');
  }
  if (typeof value === 'number') {
    // Numeric identifiers with a zero format must keep their displayed leading zeros.
    const mask = cell.numFmt?.split(';')[0];
    if (mask && /^0+$/.test(mask) && Number.isInteger(value)) return String(value).padStart(mask.length, '0');
    if (!Number.isSafeInteger(value) && Number.isInteger(value)) throw new Error('Identifier exceeds Excel numeric precision; store it as text');
  }
  return String(value).trim();
}
export function identifierText(cell: Cell): string {
  const value = cached(cell);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Math.abs(value) >= 1e15) throw new Error('Save this identifier as text in Excel to preserve its exact digits');
    const mask = cell.numFmt || 'General';
    if (mask !== 'General' && !/^0+$/.test(mask)) throw new Error('Unsupported numeric identifier format; save this identifier as text in Excel');
  }
  return cellText(cell);
}
export async function readImportBook(file: File): Promise<ImportBook> {
  if (!/\.xls[xm]$/i.test(file.name)) throw new Error('Choose an .xlsx or .xlsm workbook.');
  if (file.size > 5 * 1024 * 1024) throw new Error('Choose a workbook smaller than 5 MB.');
  const bytes = await file.arrayBuffer();
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  if (!book.worksheets.length) throw new Error('The workbook has no worksheets.');
  return { sheets: book.worksheets, date1904: Boolean(book.properties.date1904), digest };
}
export function suggestHeader(sheet: Worksheet): number {
  let best = 1, score = 0;
  for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
    const found = Object.values(suggestMapping(sheet, row)).filter(Boolean).length;
    if (found > score) { score = found; best = row; }
  }
  return best;
}
export function suggestMapping(sheet: Worksheet, headerRow: number): ColumnMapping {
  const result = Object.fromEntries(IMPORT_FIELDS.map(([field]) => [field, 0])) as ColumnMapping;
  sheet.getRow(headerRow).eachCell((cell, column) => {
    let name = '';
    try { name = normalized(cellText(cell)); } catch { return; }
    for (const [field] of IMPORT_FIELDS) if (aliases[field].includes(name) && !result[field]) result[field] = column;
  });
  return result;
}
function validDate(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || year > 2200 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('Invalid date');
  return date.toISOString().slice(0, 10);
}
export function parseDate(cell: Cell, order: DateOrder, date1904: boolean): string {
  const value = cached(cell);
  if (value instanceof Date) return validDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || (!date1904 && Math.floor(value) === 60)) throw new Error('Invalid Excel date');
    const serial = Math.floor(value);
    const days = date1904 ? serial : serial - (serial > 60 ? 1 : 0);
    const date = new Date(Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31) + days * 86_400_000);
    return validDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
  }
  const text = cellText(cell);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return validDate(+iso[1], +iso[2], +iso[3]);
  const match = /^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})$/.exec(text);
  if (!match) throw new Error('Use a date or a numeric date in the selected format');
  const values = [+match[1], +match[2], +match[3]];
  const year = values[order.indexOf('Y')];
  if (year < 1000) throw new Error('Use a four-digit year');
  return validDate(year, values[order.indexOf('M')], values[order.indexOf('D')]);
}
function parseNumber(cell: Cell, optional: boolean, whole: boolean): number | null {
  const text = cellText(cell);
  if (!text && optional) return null;
  if (!/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(text)) throw new Error('Enter a valid number');
  const value = Number(text.replace(/,/g, ''));
  if (!Number.isFinite(value) || Math.abs(value) > 1e9 || (whole && !Number.isInteger(value))) throw new Error(whole ? 'Enter a whole number' : 'Number is out of range');
  return value;
}
export function parseImportRows(sheet: Worksheet, headerRow: number, mapping: ColumnMapping, dateOrder: DateOrder, date1904 = false): ImportedRow[] {
  const missing = IMPORT_FIELDS.filter(([key]) => !mapping[key]);
  if (missing.length) throw new Error('Map every column: ' + missing.map(([, label]) => label).join(', '));
  if (new Set(Object.values(mapping)).size !== IMPORT_FIELDS.length) throw new Error('Each field needs a different Excel column.');
  const result: ImportedRow[] = [];
  const seen = new Map<string, ImportedRow>();
  for (let rowNumber = headerRow + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (Object.values(mapping).every(column => row.getCell(column).value == null || row.getCell(column).value === '')) continue;
    if (result.length >= 2000) throw new Error('Import up to 2,000 non-empty rows at a time.');
    const data = {} as ExcelOrderRow;
    const errors: string[] = [];
    for (const [field, label] of IMPORT_FIELDS) {
      try {
        const cell = row.getCell(mapping[field]);
        let value: string | number | null;
        if (field === 'deliveryDate') value = parseDate(cell, dateOrder, date1904);
        else if (field === 'quantity' || field === 'deliveryLeadDays' || field === 'daysOutstanding') {
          value = parseNumber(cell, field !== 'quantity', field !== 'quantity');
          if (field === 'quantity' && value !== null && value < 0) throw new Error('Quantity cannot be negative');
        } else if (field === 'unit') {
          const unit = cellText(cell).toLowerCase();
          if (!['mt', 'bags', 'bag'].includes(unit)) throw new Error('Only MT or Bags is supported');
          value = unit === 'mt' ? 'MT' : 'Bags';
        } else {
          value = field === 'doNo' || field === 'materialCode' ? identifierText(cell) : cellText(cell);
          if ((field === 'doNo' || field === 'materialCode') && !value) throw new Error('Required');
          const limit = field === 'doNo' ? 120 : field === 'materialCode' ? 80 : field === 'description' ? 200 : 1000;
          if (value.length > limit) throw new Error('Maximum ' + limit + ' characters');
        }
        Object.assign(data, { [field]: value });
      } catch (error) { errors.push(label + ': ' + (error instanceof Error ? error.message : 'Invalid value')); }
    }
    if (data.unit === 'Bags' && !Number.isInteger(data.quantity)) errors.push('Qty: Bags must be a whole number');
    const imported = { rowNumber, data, errors };
    const key = JSON.stringify([data.doNo?.toLowerCase(), data.materialCode?.toLowerCase()]);
    if (data.doNo && data.materialCode) {
      const previous = seen.get(key);
      if (previous) { errors.push('Duplicate DO no + Material code (row ' + previous.rowNumber + ')'); previous.errors.push('Duplicate DO no + Material code (row ' + rowNumber + ')'); }
      else seen.set(key, imported);
    }
    result.push(imported);
  }
  if (!result.length) throw new Error('No order rows found below the selected header.');
  return result;
}
