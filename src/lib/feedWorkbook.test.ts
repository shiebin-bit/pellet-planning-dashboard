import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { cellText, type ImportBook } from './excelImport';
import { parseFeedWorkbook,parseDailyReportWorkbook,parseSapOrderWorkbook } from './feedWorkbook';

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
  it('reads dated orders and raw status independently of delayed SAP and outstanding days',()=>{
    const book=workbook(),daily=book.sheets[2];
    daily.getCell('D135').value=new Date('2026-10-10T00:00:00Z');daily.getCell('G135').value='Test customer';daily.getCell('M135').value='FS 5220 TEST';daily.getCell('P135').value=100;daily.getCell('Q135').value='BAG';daily.getCell('R135').value=-7;daily.getCell('T135').value=1;
    const parsed=parseDailyReportWorkbook(book,'test.xlsm');
    expect(parsed.orderRows[0]).toMatchObject({remark:'DONE',daysOutstanding:1,deliveryLeadDays:-7,medication:'Medication',fmrOmed:'FMR/1',quantity:100});
    expect(parsed.stockRows[0]).toMatchObject({opening:30,closing:30});
    expect(parseSapOrderWorkbook(book,'test.xlsm','2026-10-18')[0].rows[0].remark).toBe('');
    const dailyOnly={...book,sheets:[daily]};expect(parseDailyReportWorkbook(dailyOnly,'test.xlsm').orderRows).toHaveLength(1);
    expect(()=>parseSapOrderWorkbook(dailyOnly,'test.xlsm','2026-10-18')).toThrow('No SAP');
    daily.getCell('S135').value='CANCEL';expect(parseDailyReportWorkbook(book,'test.xlsm').orderRows[0].remark).toBe('CANCEL');
  });
  it('normalizes cached bulk arithmetic tails but rejects genuine excessive precision',()=>{
    const book=workbook(),daily=book.sheets[2];daily.getCell('C135').value=null;daily.getCell('F18').value='BULK';daily.getCell('G18').value=1.2340000000000002;daily.getCell('M18').value=1.234;
    expect(parseDailyReportWorkbook(book,'test.xlsm').stockRows[0].opening).toBe(1.234);
    daily.getCell('G18').value=1.2345;expect(()=>parseDailyReportWorkbook(book,'test.xlsm')).toThrow('three decimal');
  });
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
