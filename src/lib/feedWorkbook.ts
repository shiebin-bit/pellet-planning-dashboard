import type { SourceImportInput } from '../domain/sourceTypes';
import { cellText, identifierText, parseDate, type ImportBook } from './excelImport';
import type { DailyReportInput } from '../domain/dailyImport';
import { quantityToScaled, scaledToQuantity } from '../domain/inventory';

/** Explicit SAP mode: reads orders only, never the dated report's remarks or stock. */
export function parseSapOrderWorkbook(book: ImportBook, fileName: string, asOfDate: string): SourceImportInput[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) throw new Error('Choose the SAP export date.');
  const imports: SourceImportInput[] = [];
  for (const sheet of book.sheets.filter(sheet => /^(bag|bulk) order$/i.test(sheet.name.trim()))) {
    const rows: SourceImportInput['rows'] = [], seen = new Set<string>();
    for (let n = 2; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n), doNo = identifierText(row.getCell(1));
      if (!doNo) continue;
      const materialCode = identifierText(row.getCell(6));
      if (!materialCode) throw new Error(`${sheet.name}!${n}: Material is required.`);
      const rawUnit = cellText(row.getCell(9)).toUpperCase();
      if (!['BAG','BAGS','MT'].includes(rawUnit)) throw new Error(`${sheet.name}!${n}: unsupported Sales Unit.`);
      const unit = rawUnit === 'MT' ? 'MT' : 'Bags';
      const quantity = normalizedQuantity(unit, cellText(row.getCell(8)), `${sheet.name}!${n}: Delivery quantity`);
      const key = `${doNo.toLowerCase()}\0${materialCode.toLowerCase()}`;
      if (seen.has(key)) throw new Error(`${sheet.name}!${n}: duplicate DO + Material.`);
      seen.add(key);
      rows.push({ doNo, materialCode, deliveryDate: parseDate(row.getCell(3), 'MDY', book.date1904),
        soldToParty: cellText(row.getCell(4)), shipToParty: cellText(row.getCell(5)), description: cellText(row.getCell(7)), quantity, unit,
        deliveryLeadDays: null, daysOutstanding: null, remark: '', medication: '', fmrOmed: '',
        goodsMovementStatus: cellText(row.getCell(2)), sourceSheet: sheet.name, sourceRow: n });
    }
    if (rows.length) imports.push({fileName, sheetName: sheet.name, digest: book.digest, asOfDate, rows});
  }
  if (!imports.length) throw new Error('No SAP order rows found in bag order or bulk order.');
  return imports;
}

/** Company daily report. Cached values only; numeric outstanding days never infer status. */
export function parseDailyReportWorkbook(book: ImportBook, fileName: string, sheetName?: string): DailyReportInput {
  const candidates = book.sheets.filter(sheet => /^\d+(st|nd|rd|th)$/i.test(sheet.name.trim()));
  const daily = sheetName ? candidates.find(sheet => sheet.name === sheetName) : candidates.length === 1 ? candidates[0] : undefined;
  if (!daily) throw new Error(candidates.length > 1 ? 'Choose the dated worksheet to import.' : 'No dated daily-report worksheet found.');
  const asOfDate = parseDate(daily.getCell('R14'), 'MDY', book.date1904);
  if (Number(daily.name.match(/^\d+/)?.[0]) !== Number(asOfDate.slice(-2))) throw new Error(`${daily.name}: worksheet day does not match the report date in R14.`);
  const stockRows: DailyReportInput['stockRows'] = [], orderRows: DailyReportInput['orderRows'] = [];
  const seenStock = new Set<string>(), seenOrders = new Set<string>();
  for (let n = 1; n <= daily.rowCount; n++) {
    const row = daily.getRow(n);
    const stockMaterial = n <= 130 ? cellText(row.getCell(2)) : '';
    const mode = /^\d+\.\d+$/.test(stockMaterial) ? cellText(row.getCell(6)).toUpperCase() : '';
    if (/^\d+\.\d+$/.test(stockMaterial) && ['BAG','BAGS','BULK'].includes(mode)) {
      const materialCode = identifierText(row.getCell(2)), unit = mode === 'BULK' ? 'MT' : 'Bags';
      if (seenStock.has(materialCode.toLowerCase())) throw new Error(`${daily.name}!${n}: duplicate stock material.`);
      seenStock.add(materialCode.toLowerCase());
      const q = (column: number) => normalizedQuantity(unit, cellText(row.getCell(column)) || '0', `${daily.name}!${n}, column ${column}`);
      const bagWeightKg = unit === 'Bags' ? Number(cellText(row.getCell(4))) : null;
      if (unit === 'Bags' && bagWeightKg !== 25 && bagWeightKg !== 50) throw new Error(`${daily.name}!${n}: confirm 25kg / 50kg bag weight.`);
      const safety = cellText(row.getCell(14)), numericSafety = safety !== '' && Number.isFinite(Number(safety.replace(/,/g,'')));
      stockRows.push({materialCode, description:cellText(row.getCell(3)), unit, bagWeightKg:bagWeightKg as 25|50|null,
        strategy:numericSafety ? 'mts' : 'mto', targetQuantity:numericSafety ? normalizedQuantity(unit,safety, 'Safety stock') : 0,
        needsReview:!numericSafety && !/^PER\s+ADVICE$/i.test(safety), opening:q(7),production:q(8),received:q(9),salesReturn:q(10),rework:q(11),issue:q(12),closing:q(13),medication:'',fmrOmed:''});
    }
    if(n<=130)continue;
    const doText = cellText(row.getCell(3));
    if(!/^\d+$/.test(doText))continue;
    const materialText = cellText(row.getCell(12));
    if (!/^\d+$/.test(doText) || !/^\d+\.\d+$/.test(materialText)) continue;
    const doNo = identifierText(row.getCell(3)), materialCode = identifierText(row.getCell(12));
    const key = `${doNo.toLowerCase()}\0${materialCode.toLowerCase()}`;
    if (seenOrders.has(key)) throw new Error(`${daily.name}!${n}: duplicate DO + Material.`);
    seenOrders.add(key);
    const rawUnit = cellText(row.getCell(17)).toUpperCase();
    if (!['BAG','BAGS','MT'].includes(rawUnit)) throw new Error(`${daily.name}!${n}: unsupported order unit.`);
    const unit = rawUnit === 'MT' ? 'MT' : 'Bags';
    const optionalDays = (column:number) => {const text=cellText(row.getCell(column)); if(!text)return null; const value=Number(text); if(!Number.isSafeInteger(value))throw new Error(`${daily.name}!${n}: invalid days value.`);return value;};
    orderRows.push({doNo,materialCode,deliveryDate:parseDate(row.getCell(4),'MDY',book.date1904),soldToParty:cellText(row.getCell(7)),shipToParty:cellText(row.getCell(10)),
      description:cellText(row.getCell(13)),quantity:normalizedQuantity(unit,cellText(row.getCell(16)),`${daily.name}!${n}: order quantity`),unit,
      deliveryLeadDays:optionalDays(18),remark:cellText(row.getCell(19)),daysOutstanding:optionalDays(20),medication:cellText(row.getCell(22)),fmrOmed:cellText(row.getCell(23)),sourceSheet:daily.name,sourceRow:n});
  }
  if (!stockRows.length) throw new Error(`${daily.name}: no finished-goods stock rows found.`);
  return {fileName,digest:book.digest,sheetName:daily.name,asOfDate,stockRows,orderRows};
}

function normalizedQuantity(unit:'Bags'|'MT', text:string, label:string):number {
  if (!text.trim()) throw new Error(`${label} is required.`);
  return scaledToQuantity(unit,quantityToScaled(unit,Number(text.replace(/,/g,'')),label));
}

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
