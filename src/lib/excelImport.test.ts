import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { IMPORT_FIELDS, parseImportRows, suggestHeader, suggestMapping } from './excelImport';
function fixture() {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Orders');
  sheet.addRow(['SAP order list']); sheet.addRow(IMPORT_FIELDS.map(([, label]) => label));
  sheet.addRow(['001234', '10/22/2026', 'Example customer', 'Example warehouse', '000070313008512800', 'Fictional feed', 25, 'MT', 3, 'Open', -2, '', '']);
  return { sheet, mapping: suggestMapping(sheet, 2) };
}
describe('Excel order import parsing', () => {
  it('detects the header and preserves codes, blank optional values and signed day counts', () => {
    const { sheet, mapping } = fixture(); expect(suggestHeader(sheet)).toBe(2);
    const rows = parseImportRows(sheet, 2, mapping, 'MDY');
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data).toMatchObject({ doNo: '001234', materialCode: '000070313008512800', deliveryDate: '2026-10-22', deliveryLeadDays: 3, daysOutstanding: -2 });
    sheet.getCell('I3').value = null;
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].data.deliveryLeadDays).toBeNull();
  });
  it('applies the chosen text date order and rejects invalid dates', () => {
    const { sheet, mapping } = fixture(); sheet.getCell('B3').value = '03/04/2026';
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].data.deliveryDate).toBe('2026-03-04');
    expect(parseImportRows(sheet, 2, mapping, 'DMY')[0].data.deliveryDate).toBe('2026-04-03');
    sheet.getCell('B3').value = '02/30/2026';
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('Invalid date');
  });
  it('handles numeric 1900/1904 dates and formatted numeric identifiers', () => {
    const { sheet, mapping } = fixture(); sheet.getCell('B3').value = 1; sheet.getCell('A3').value = 1234; sheet.getCell('A3').numFmt = '000000';
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].data).toMatchObject({ deliveryDate: '1900-01-01', doNo: '001234' });
    expect(parseImportRows(sheet, 2, mapping, 'MDY', true)[0].data.deliveryDate).toBe('1904-01-02');
    sheet.getCell('B3').value = 60;
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('Invalid Excel date');
  });
  it('only reads cached formula results and treats hyperlink labels as plain text', () => {
    const { sheet, mapping } = fixture(); sheet.getCell('G3').value = { formula: 'SUM(20,5)', result: 25 };
    sheet.getCell('C3').value = { text: 'Example customer', hyperlink: 'https://example.invalid/' };
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors).toEqual([]);
    sheet.getCell('G3').value = { formula: 'SUM(20,5)' };
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('no cached result');
  });
  it('rejects ambiguous numeric material identifiers instead of silently losing digits or formatting', () => {
    const { sheet, mapping } = fixture(); sheet.getCell('E3').value = 7.03130085128;
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('as text');
    sheet.getCell('E3').value = 12345; sheet.getCell('E3').numFmt = '0.00E+00';
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('numeric identifier format');
    sheet.getCell('E3').numFmt = 'General'; sheet.getCell('E3').value = 1234567890123456;
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('exact digits');
  });
  it('blocks duplicate business keys, negative quantities and fractional Bags', () => {
    const { sheet, mapping } = fixture(); sheet.addRow(sheet.getRow(3).values);
    const duplicates = parseImportRows(sheet, 2, mapping, 'MDY'); expect(duplicates.every(row => row.errors.join().includes('Duplicate'))).toBe(true);
    sheet.spliceRows(4, 1); sheet.getCell('G3').value = -1;
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('negative');
    sheet.getCell('G3').value = 1.5; sheet.getCell('H3').value = 'Bags';
    expect(parseImportRows(sheet, 2, mapping, 'MDY')[0].errors.join()).toContain('whole number');
  });
  it('requires complete unique mapping and refuses more than 2000 orders', () => {
    const { sheet, mapping } = fixture(); expect(() => parseImportRows(sheet, 2, { ...mapping, unit: 0 }, 'MDY')).toThrow('Map every column');
    expect(() => parseImportRows(sheet, 2, { ...mapping, unit: mapping.quantity }, 'MDY')).toThrow('different Excel column');
    for (let i = 0; i < 2000; i++) sheet.addRow([String(i), '10/22/2026', '', '', '1234', '', 1, 'MT', '', '', '', '', '']);
    expect(() => parseImportRows(sheet, 2, mapping, 'MDY')).toThrow('2,000');
  });
});
