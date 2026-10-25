import type { SourceImportInput } from '../domain/sourceTypes';
import { cellText, identifierText, parseDate, type ImportBook } from './excelImport';

export interface FeedStockRow {
  materialCode: string; description: string; unit: 'Bags' | 'MT'; bagWeightKg: 25 | 50 | null;
  strategy: 'mto' | 'mts'; targetQuantity: number; needsReview: boolean;
  opening: number; production: number; received: number; salesReturn: number;
  rework: number; issue: number; closing: number; medication: string; fmrOmed: string;
}
export interface FeedWorkbookData {
  fileName: string; digest: string; asOfDate: string; orders: SourceImportInput[];
  items: FeedStockRow[];
  annotations: Array<{ doNo: string; materialCode: string; remark: string; medication: string; fmrOmed: string }>;
  packingBinTotal: number | null;
}
export function isFeedWorkbook(book: ImportBook): boolean {
  return ['bag order', 'bulk order'].every(name => book.sheets.some(sheet => sheet.name.trim().toLowerCase() === name));
}
/** Reads saved cell values only; VBA, formulas and external links are never run. */
export function parseFeedWorkbook(book: ImportBook, fileName: string): FeedWorkbookData {
  if (!isFeedWorkbook(book)) throw new Error('The workbook needs bag order and bulk order worksheets.');
  const daily = book.sheets.find(sheet => /^\d+(st|nd|rd|th)$/i.test(sheet.name.trim()));
  if (!daily) throw new Error('A dated daily-stock worksheet is required for this template.');
  const asOfDate = parseDate(daily.getCell('R14'), 'MDY', book.date1904);
  const orders: SourceImportInput[] = [];
  const annotations: FeedWorkbookData['annotations'] = [];
  const items: FeedStockRow[] = [];
  const number = (row: number, column: number) => {
    const text = cellText(daily.getRow(row).getCell(column));
    if (!text) return 0;
    const value = Number(text.replace(/,/g, ''));
    if (!Number.isFinite(value) || value < 0) throw new Error(`${daily.name}!${row}: invalid stock quantity in column ${column}.`);
    return value;
  };
  for (const name of ['bag order', 'bulk order']) {
    const sheet = book.sheets.find(sheet => sheet.name.trim().toLowerCase() === name)!;
    const rows: SourceImportInput['rows'] = [];
    const seen = new Set<string>();
    for (let n = 2; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      const doNo = identifierText(row.getCell(1));
      if (!doNo) continue;
      const materialCode = identifierText(row.getCell(6));
      if (!materialCode) throw new Error(`${sheet.name}!${n}: Material is required.`);
      const unitText = cellText(row.getCell(9)).toUpperCase();
      if (!['BAG', 'BAGS', 'MT'].includes(unitText)) throw new Error(`${sheet.name}!${n}: unsupported Sales Unit.`);
      const unit = unitText === 'MT' ? 'MT' : 'Bags';
      const quantity = Number(cellText(row.getCell(8)).replace(/,/g, ''));
      if (!Number.isFinite(quantity) || quantity < 0 || (unit === 'Bags' && !Number.isInteger(quantity))) throw new Error(`${sheet.name}!${n}: invalid Delivery quantity.`);
      const key = `${doNo.toLowerCase()}\u0000${materialCode.toLowerCase()}`;
      if (seen.has(key)) throw new Error(`${sheet.name}!${n}: duplicate DO + Material; SAP item numbers are required to distinguish these rows.`);
      seen.add(key);
      rows.push({ doNo, materialCode, deliveryDate: parseDate(row.getCell(3), 'MDY', book.date1904),
        soldToParty: cellText(row.getCell(4)), shipToParty: cellText(row.getCell(5)),
        description: cellText(row.getCell(7)), quantity, unit,
        deliveryLeadDays: null, daysOutstanding: null, remark: '', medication: '', fmrOmed: '',
        goodsMovementStatus: cellText(row.getCell(2)), sourceSheet: sheet.name, sourceRow: n });
    }
    if (!rows.length) throw new Error(`${sheet.name}: no order rows found.`);
    orders.push({ fileName, sheetName: sheet.name, digest: book.digest, asOfDate, rows });
  }
  for (let n = 1; n <= Math.min(130, daily.rowCount); n++) {
    const row = daily.getRow(n);
    const materialCode = cellText(row.getCell(2));
    if (!/^\d+\.\d+$/.test(materialCode)) continue;
    const mode = cellText(row.getCell(6)).toUpperCase();
    if (!['BAG', 'BAGS', 'BULK'].includes(mode)) continue;
    const unit = mode === 'BULK' ? 'MT' : 'Bags';
    const bagWeightKg = unit === 'Bags' ? number(n, 4) : null;
    if (unit === 'Bags' && ![25, 50].includes(bagWeightKg!)) throw new Error(`${daily.name}!${n}: confirm bag weight before import.`);
    const safety = cellText(row.getCell(14));
    const target = safety !== '' && Number.isFinite(Number(safety)) ? Number(safety) : null;
    items.push({ materialCode, description: cellText(row.getCell(3)), unit, bagWeightKg: bagWeightKg as 25 | 50 | null,
      strategy: target !== null ? 'mts' : 'mto', targetQuantity: target ?? 0,
      needsReview: !safety, opening: number(n, 7), production: number(n, 8), received: number(n, 9),
      salesReturn: number(n, 10), rework: number(n, 11), issue: number(n, 12), closing: number(n, 13), medication: '', fmrOmed: '' });
  }
  for (let n = 131; n <= daily.rowCount; n++) {
    const row = daily.getRow(n);
    const doNo = cellText(row.getCell(3)), materialCode = cellText(row.getCell(12));
    if (!/^\d+$/.test(doNo) || !/^\d+\.\d+$/.test(materialCode)) continue;
    const remark = cellText(row.getCell(19)), medication = cellText(row.getCell(22)), fmrOmed = cellText(row.getCell(23));
    if (remark || medication || fmrOmed) annotations.push({ doNo, materialCode, remark, medication, fmrOmed });
  }
  if (!items.length) throw new Error('No finished-goods stock rows found.');
  return { fileName, digest: book.digest, asOfDate, orders, items, annotations,
    packingBinTotal: cellText(daily.getCell('G130')) ? number(130, 7) : null };
}
