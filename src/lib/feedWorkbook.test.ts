import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { cellText, type ImportBook } from './excelImport';
import { parseFeedWorkbook } from './feedWorkbook';

function workbook(): ImportBook {
  const b = new ExcelJS.Workbook();
  for (const [name, unit, code] of [['bag order', 'BAG', '7.9999000000025'], ['bulk order', 'MT', '7.9999000000000']]) {
    const s = b.addWorksheet(name); s.addRow(['Delivery', 'Goods movement stat.', 'Goods Issue Date', 'Name of sold-to party', 'Name of the ship-to party', 'Material', 'Description', 'Delivery quantity', 'Sales Unit']);
    s.addRow(['0012345678', 'A', new Date('2026-10-20T00:00:00Z'), 'Customer', 'Destination', code, 'Feed', 100, unit]);
  }
  const d = b.addWorksheet('18th'); d.getCell('R14').value = new Date('2026-10-18T00:00:00Z');
  const r = d.getRow(18); r.getCell(2).value = '7.9999000000025'; r.getCell(3).value = 'Feed'; r.getCell(4).value = 25; r.getCell(6).value = 'BAG'; r.getCell(7).value = 30; r.getCell(8).value = { formula: '0', result: 0 }; r.getCell(13).value = 30; r.getCell(14).value = 20;
  d.getCell('G130').value = 42.123;
  d.getCell('C135').value = '0012345678'; d.getCell('L135').value = '7.9999000000025'; d.getCell('S135').value = 'DONE'; d.getCell('V135').value = 'Medication'; d.getCell('W135').value = 'FMR/1'; d.getCell('X135').value = 999;
  return { sheets: b.worksheets, date1904: false, digest: 'a'.repeat(64) };
}
describe('daily stock workbook adapter', () => {
  it('imports SAP orders separately from daily stock and manual annotations', () => {
    const parsed = parseFeedWorkbook(workbook(), 'daily.xlsm');
    expect(parsed.asOfDate).toBe('2026-10-18');
    expect(parsed.orders.map(o => o.rows.length)).toEqual([1, 1]);
    expect(parsed.orders[0].rows[0]).toMatchObject({ doNo: '0012345678', materialCode: '7.9999000000025', unit: 'Bags', medication: '', remark: '', goodsMovementStatus: 'A' });
    expect(parsed.items[0]).toMatchObject({ opening: 30, closing: 30, production: 0, bagWeightKg: 25, strategy: 'mts', targetQuantity: 20 });
    expect(parsed.annotations).toEqual([{ doNo: '0012345678', materialCode: '7.9999000000025', remark: 'DONE', medication: 'Medication', fmrOmed: 'FMR/1' }]);
    expect(parsed.packingBinTotal).toBe(42.123);
  });
  it('preserves cached zero without evaluating formulas and rejects an absent cache', () => {
    const book = workbook();
    expect(cellText(book.sheets[2].getCell('H18'))).toBe('0');
    book.sheets[2].getCell('H18').value = { formula: 'EXTERNAL_LINK()' };
    expect(() => parseFeedWorkbook(book, 'daily.xlsm')).toThrow('cached result');
  });
  it('rejects ambiguous duplicate order keys and numeric material codes with lost precision', () => {
    const book = workbook(); book.sheets[0].addRow(book.sheets[0].getRow(2).values);
    expect(() => parseFeedWorkbook(book, 'daily.xlsm')).toThrow('duplicate DO');
    const other = workbook(); other.sheets[0].getCell('F2').value = 7.9999000000025;
    expect(() => parseFeedWorkbook(other, 'daily.xlsm')).toThrow('identifier as text');
  });
});
