import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { IMPORT_FIELDS, cellText, type ColumnMapping, type ImportBook } from './excelImport';
import { parseFeedWorkbook,parseDailyReportWorkbook,parseSapOrderWorkbook,parseSapNextDayWorkbook,parseMappedSapNextDayWorkbook } from './feedWorkbook';

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
  it('manually mapped imports filter dates before quantities, material validation and duplicate detection',()=>{
    const excel=new ExcelJS.Workbook(),sheet=excel.addWorksheet('Mapped SAP');
    sheet.addRow(IMPORT_FIELDS.map(([,label])=>label));
    sheet.addRow(['KEEP','2026-11-20','Buyer','Farm','7.9999000000025','FS 5220 TEST 25KG',100,'Bags',1,'',0,'','']);
    sheet.addRow(['KEEP','2026-11-19','Buyer','Farm',{formula:'NO_CACHE()'},'',{error:'#VALUE!'},'Bags',1,'',0,'','']);
    sheet.addRow(['KEEP','2026-11-21','Buyer','Farm','7.9999000000025','',-100,'Bags',1,'',0,'','']);
    sheet.addRow(['NO-DATE','unknown']);
    const book:ImportBook={sheets:excel.worksheets,date1904:false,digest:'b'.repeat(64)};
    const mapping=Object.fromEntries(IMPORT_FIELDS.map(([field],index)=>[field,index+1])) as ColumnMapping;
    const parsed=parseMappedSapNextDayWorkbook(book,'mapped.xlsx',0,1,mapping,'YMD','2026-11-19','2026-11-20');
    expect(parsed.counts).toEqual({matched:1,bag:1,bulk:0,old:1,future:1,invalidDate:1});
    expect(parsed.rows[0].errors).toEqual([]);expect(parsed.rows[0].rowNumber).toBe(2);
    expect(parsed.inputs[0].rows[0].materialCode).toBe('7.9999000000025');
    expect(parseMappedSapNextDayWorkbook(book,'mapped.xlsx',0,1,mapping,'YMD','2026-12-01','2026-12-02').inputs).toEqual([]);
    sheet.addRow(sheet.getRow(2).values);
    expect(parseMappedSapNextDayWorkbook(book,'mapped.xlsx',0,1,mapping,'YMD','2026-11-19','2026-11-20').rows.every(row=>row.errors.some(error=>error.includes('Duplicate')))).toBe(true);
  });
  it('reads only stock and never evaluates lower order cells',()=>{
    const book=workbook(),daily=book.sheets[2];
    daily.getCell('C135').value={formula:'BROKEN()'};daily.getCell('P135').value={error:'#VALUE!'};
    const parsed=parseDailyReportWorkbook(book,'test.xlsm');
    expect(parsed.orderRows).toEqual([]);
    expect(parsed.stockRows[0]).toMatchObject({opening:30,closing:30});
    expect(parseSapOrderWorkbook(book,'test.xlsm','2026-10-19')[0].rows[0].remark).toBe('');
    expect(()=>parseSapOrderWorkbook({...book,sheets:[daily]},'test.xlsm','2026-10-19')).toThrow('No SAP');
  });
  it('filters dates before validating obsolete SAP fields and preserves full material identifiers',()=>{
    const book=workbook(),bag=book.sheets[0];
    bag.addRow(['old','A',new Date('2026-10-19'),'', '', {error:'#VALUE!'},'',{formula:'BROKEN()'},'BAG']);
    bag.addRow(['future','A',new Date('2026-10-21'),'', '', '', '', 'invalid','BAG']);
    bag.addRow(['bad-date','A','unknown']);
    const parsed=parseSapNextDayWorkbook(book,'test.xlsm','2026-10-19','2026-10-20');
    expect(parsed.counts).toEqual({matched:2,bag:1,bulk:1,old:1,future:1,invalidDate:1});
    expect(parsed.inputs[0].rows[0].materialCode).toBe('7.9999000000025');
    expect(parseSapNextDayWorkbook(book,'test.xlsm','2026-10-22','2026-10-23').inputs).toEqual([]);
  });
  it('handles next-day month and year boundaries',()=>{
    for (const [today,tomorrow] of [['2026-10-31','2026-11-01'],['2026-12-31','2027-01-01']]) {
      const book=workbook();book.sheets[0].getCell('C2').value=new Date(tomorrow+'T00:00:00Z');
      expect(parseSapOrderWorkbook(book,'test.xlsm',today)[0].rows[0].deliveryDate).toBe(tomorrow);
    }
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
