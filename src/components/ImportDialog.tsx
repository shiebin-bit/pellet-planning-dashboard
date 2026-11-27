import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, ArrowLeft, Check } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { IMPORT_FIELDS, cellText, readImportBook, suggestHeader, suggestMapping } from '../lib/excelImport';
import type { ColumnMapping, DateOrder, ImportBook } from '../lib/excelImport';
import type { SourceImportInput, SourceImportPreview } from '../domain/sourceTypes';
import { previewSourceImport, readSapImportContext, type SapImportContext } from '../lib/dataApi';
import { useModal } from './useModal';
import './ProductionEditor.css';
import '../pages/Data.css';
import { parseSapNextDayWorkbook, parseMappedSapNextDayWorkbook, type SapNextDayCounts } from '../lib/feedWorkbook';
import type { DailyReportInput } from '../domain/dailyImport';
import { FeedImportDialog } from './FeedImportDialog';
import { ImportChanges } from './ImportChanges';

function columnName(index: number): string { let value = ''; while (index) { index--; value = String.fromCharCode(65 + index % 26) + value; index = Math.floor(index / 26); } return value; }
export function ImportDialog() {
  const { closeImport, commit, mutationLocked, hasConflict, resolveConflict, refresh, storageWarning, toast, confirmedRetry, navigate } = useWorkspace();
  const [book, setBook] = useState<ImportBook | null>(null);
  const [mode, setMode] = useState<'baseline'|'sap'>('baseline');
  const [reports, setReports] = useState<DailyReportInput[]>([]);
  const [manualMapping, setManualMapping] = useState(false);
  const [fileName, setFileName] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [header, setHeader] = useState(1);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>('MDY');
  const [context, setContext] = useState<SapImportContext | null>(null);
  const [contextError, setContextError] = useState('');
  const asOfDate = context?.asOfDate ?? '';
  async function updateContext() { try { const value = await readSapImportContext(); setContext(value); setContextError(''); return value; } catch (reason) { setContextError(reason instanceof Error ? reason.message : 'The server import date could not be checked.'); return null; } }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<SourceImportPreview | null>(null);
  const [inputs, setInputs] = useState<SourceImportInput[]>([]);
  const input = inputs[0];
  const [confirmed, setConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const retryAtMount = useRef(confirmedRetry?.nonce ?? 0);
  const dialog = useModal(() => { if (!busy && !mutationLocked) closeImport(); });
  const standardSap = !!book?.sheets.some(sheet => /^(bag|bulk)order$/.test(sheet.name.toLowerCase().replace(/[^a-z]/g, ''))) && !manualMapping;
  const sheet = book?.sheets[sheetIndex];
  useEffect(() => { void updateContext(); return () => { request.current++; }; }, []);
  useEffect(() => { if (confirmedRetry && confirmedRetry.nonce > retryAtMount.current && ['data.import', 'data.importBatch', 'inventory.importStockReports'].includes(confirmedRetry.type)) { closeImport(); navigate(confirmedRetry.type === 'inventory.importStockReports' ? 'stock' : 'data'); } }, [confirmedRetry?.nonce]);
  const parsed = useMemo(() => {
    const counts: SapNextDayCounts = { matched: 0, bag: 0, bulk: 0, old: 0, future: 0, invalidDate: 0 };
    if (!book || !context) return { rows: [], inputs: [] as SourceImportInput[], counts, error: '' };
    try {
      if (standardSap) {
        const value = parseSapNextDayWorkbook(book, fileName, context.asOfDate, context.targetIssueDate);
        return { ...value, rows: value.inputs.flatMap(batch => batch.rows.map((data, index) => ({ rowNumber: data.sourceRow ?? index + 1, data, errors: [] as string[] }))), error: '' };
      }
      if (!sheet || !mapping) return { rows: [], inputs: [] as SourceImportInput[], counts, error: '' };
      return { ...parseMappedSapNextDayWorkbook(book, fileName, sheetIndex, header, mapping, dateOrder, context.asOfDate, context.targetIssueDate), error: '' };
    } catch (reason) { return { rows: [], inputs: [] as SourceImportInput[], counts, error: reason instanceof Error ? reason.message : 'The worksheet could not be parsed.' }; }
  }, [sheet, sheetIndex, mapping, header, dateOrder, book, standardSap, fileName, context]);
  const invalid = parsed.rows.filter(row => row.errors.length);
  const columns = sheet ? Array.from({ length: Math.min(256, Math.max(sheet.columnCount, 13)) }, (_, index) => {
    let text = ''; try { text = cellText(sheet.getRow(header).getCell(index + 1)); } catch { text = 'Invalid header'; }
    return { column: index + 1, label: columnName(index + 1) + (text ? ' · ' + text : '') };
  }) : [];
  function resetPreview() { setPreview(null); setInputs([]); setConfirmed(false); setError(''); setFailed(false); setPage(1); }
  async function read(file: File) {
    const version = ++request.current; resetPreview(); setBook(null); setBusy(true); setFileName(file.name);
    try {
      const value = await readImportBook(file);
      if (version !== request.current) return;
      setManualMapping(false);
      const row = suggestHeader(value.sheets[0]);
      setBook(value); setSheetIndex(0); setHeader(row); setMapping(suggestMapping(value.sheets[0], row));
    } catch (reason) { if (version === request.current) setError(reason instanceof Error ? reason.message : 'The workbook could not be read.'); }
    finally { if (version === request.current) setBusy(false); }
  }
  async function review() {
    if (!sheet || !book || invalid.length || parsed.error || !parsed.rows.length || !context) return;
    setBusy(true); setError('');
    const values = parsed.inputs;
    try {
      const latest = await updateContext();
      if (!latest) return;
      if (latest.targetIssueDate !== context!.targetIssueDate) { resetPreview(); setError('The import day changed. Your file is preserved. Review the future orders before importing.'); return; }
      const previews = await Promise.all(values.map(value => previewSourceImport(value)));
      setPreview(previews.reduce((total, value) => ({added: total.added + value.added, skipped: total.skipped + value.skipped, unchanged: total.unchanged + value.unchanged, changed: total.changed + value.changed, rows: [...total.rows, ...value.rows]}), {added: 0, skipped: 0, unchanged: 0, changed: 0, rows: []}));
      setInputs(values); setConfirmed(false); setPage(1);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The import preview could not be generated.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!inputs.length || !preview || !confirmed) return;
    setBusy(true);
    try {
      const latest = await updateContext();
      if (!latest) return;
      if (latest.asOfDate !== inputs[0].asOfDate) { resetPreview(); setError('The import day changed. Your file is preserved. Review the future orders before importing.'); return; }
      if (await commit({ type: 'data.importBatch', inputs }, `Imported ${preview.added} new orders. Existing orders were retained.`)) { closeImport(); navigate('data'); }
      else { setFailed(true); const refreshed = await updateContext(); if (refreshed && refreshed.asOfDate !== inputs[0].asOfDate) { resetPreview(); setError('The import day changed. Your file is preserved. Review the future orders before importing.'); } }
    } finally { setBusy(false); }
  }
  const entries = preview?.rows ?? [];
  const rows = preview ? entries.slice((page - 1) * 50, page * 50) : parsed.rows.slice((page - 1) * 50, page * 50);
  const count = preview ? entries.length : parsed.rows.length;
  return <div className="editor-layer"><button className="editor-scrim" disabled={mutationLocked || busy} onClick={closeImport} aria-label="Close Excel import"/><section ref={dialog} tabIndex={-1} className="production-editor import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><header className="editor-header"><div><h2 id="import-title">Import Excel</h2><p>Choose the source of the data before importing.</p></div><button className="icon-button" disabled={mutationLocked || busy} onClick={closeImport} aria-label="Close Excel import"><X size={21}/></button></header><div className="import-mode-switch" role="group" aria-label="Import type"><button type="button" aria-pressed={mode === 'baseline'} disabled={busy || mutationLocked} onClick={() => setMode('baseline')}><strong>Baseline import</strong><span>Daily worksheet - stock only</span></button><button type="button" aria-pressed={mode === 'sap'} disabled={busy || mutationLocked} onClick={() => setMode('sap')}><strong>SAP orders</strong><span>Bag order / bulk order - Issue Dates from tomorrow onward</span></button></div><div className="import-mode-pane" hidden={mode !== 'baseline'}><FeedImportDialog reports={reports} onReportsChange={setReports} onBusyChange={setBusy}/></div><div className="import-mode-pane" hidden={mode !== 'sap'}><div className="editor-body">
    {hasConflict && <div className="notice warning" role="alert">The workspace changed. Your file is preserved. <button className="text-link" disabled={mutationLocked} onClick={() => { resolveConflict(); resetPreview(); }}>Reload latest data and review again</button></div>}
    {storageWarning && <div className="notice warning">{storageWarning}<button className="text-link" disabled={mutationLocked && !storageWarning} onClick={() => void refresh()}>Retry connection</button></div>}
    <div className="notice"><strong>Goods Issue Date from: {context?.targetIssueDate ?? 'Checking server date…'}</strong><p>Malaysia today: {context?.asOfDate ?? '—'}. All dates from tomorrow onward are accepted. Today and earlier orders are excluded.</p><button className="text-link" disabled={busy || mutationLocked} onClick={() => {resetPreview(); void updateContext();}}>Refresh import date</button></div>
    {contextError && <p className="data-error" role="alert">{contextError}</p>}
    {!preview && <div inert={mutationLocked || hasConflict || busy}><div className="import-file"><Upload size={22}/><div><strong>{fileName || 'Choose the Excel export'}</strong><p>.xlsx / .xlsm · up to 5 MB · 2,000 orders per import</p></div><button className="button secondary" onClick={() => fileInput.current?.click()}>{book ? 'Choose another file' : 'Choose file'}</button><input ref={fileInput} type="file" hidden accept=".xlsx,.xlsm" aria-label="Excel order file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file); }}/></div>{book && sheet && mapping && <>{standardSap ? <><p className="notice">Recognised SAP tables: {parsed.inputs.map(batch => `${batch.sheetName} (${batch.rows.length})`).join(' · ')}. Dated daily worksheets are excluded.</p><button className="text-link" onClick={() => setManualMapping(true)}>Use manual column mapping</button></> : <><div className="import-options"><label className="field">Worksheet<select value={sheetIndex} onChange={event => { const index = +event.target.value; const row = suggestHeader(book.sheets[index]); setSheetIndex(index); setHeader(row); setMapping(suggestMapping(book.sheets[index], row)); resetPreview(); }}>{book.sheets.map((item, index) => <option key={item.id} value={index}>{item.name}</option>)}</select></label><label className="field">Header row<input type="number" min="1" max={sheet.rowCount || 1} value={header} onChange={event => { const row = Math.max(1, Math.min(sheet.rowCount || 1, +event.target.value)); setHeader(row); setMapping(suggestMapping(sheet, row)); resetPreview(); }}/></label><label className="field">Text date format<select value={dateOrder} onChange={event => { setDateOrder(event.target.value as DateOrder); resetPreview(); }}><option value="MDY">MM/DD/YYYY</option><option value="DMY">DD/MM/YYYY</option><option value="YMD">YYYY/MM/DD</option></select></label></div><details className="import-mapping" open={Object.values(mapping).some(value => !value)}><summary>Column mapping · {Object.values(mapping).filter(Boolean).length} / 13 matched</summary><div className="import-mapping-grid">{IMPORT_FIELDS.map(([key, label]) => <label className="field" key={key}>{key === 'deliveryDate' ? 'Goods Issue Date' : label}<select value={mapping[key]} onChange={event => { setMapping(previous => ({ ...previous!, [key]: +event.target.value })); resetPreview(); }}><option value={0}>Choose a column</option>{columns.map(column => <option key={column.column} value={column.column}>{column.label}</option>)}</select></label>)}</div></details></>}<p className="data-note">DO no + full Material code identifies an order. Existing dates, quantities, statuses and manual fields remain unchanged. Missing orders are kept. Formula cells need saved results; formulas and links are never executed.</p></>}</div>}
    {book && !parsed.error && <><div className="import-summary" aria-label="SAP date filter summary"><div><strong>{parsed.counts.matched}</strong><span>Matching future orders</span></div><div><strong>{parsed.counts.bag} / {parsed.counts.bulk}</strong><span>Bags / Bulk</span></div><div><strong>{parsed.counts.old} / {parsed.counts.invalidDate}</strong><span>Excluded: today or earlier / invalid date</span></div></div>{!parsed.rows.length && !preview && <p className="notice">No orders have a future Goods Issue Date. Nothing will be saved. Check the file or import again on the appropriate day.</p>}</>}
    {busy && <p role="status">{book ? 'Comparing the import with PostgreSQL…' : 'Reading the workbook…'}</p>}
    {(error || parsed.error) && <p className="data-error" role="alert">{error || parsed.error}</p>}
    {invalid.length > 0 && !preview && <div className="data-error" role="alert"><strong>{invalid.length} rows need correction.</strong> Nothing will be imported until every row is valid.</div>}
    {preview && <><div className="import-summary" aria-label="Import preview summary"><div><strong>{preview.added}</strong><span>New orders</span></div><div><strong>{preview.unchanged}</strong><span>Existing · unchanged</span></div><div><strong>{preview.changed}</strong><span>Existing · Excel differs</span></div></div><p className="data-note"><strong>{input?.fileName}</strong> · {input?.sheetName} · Excel as-of {input?.asOfDate}. Existing dates, quantities, statuses, manual fields and production cards stay unchanged. Goods Issue Dates from tomorrow onward are included.</p></>}
    {count > 0 && <><div className="table-scroll import-preview" role="region" aria-label="Excel import comparison" tabIndex={0}><table><colgroup>{[9,12,21,12,10,36].map((width,index)=><col key={index} style={{width:`${width}%`}}/>)}</colgroup><thead><tr><th>ROW / RESULT</th><th>DO NO</th><th>MATERIAL</th><th>GOODS ISSUE DATE</th><th>QUANTITY</th><th>{preview ? 'CHANGES' : 'CHECKS'}</th></tr></thead><tbody>{rows.map((item, index) => {
      const data = 'data' in item ? item.data : item.fields;
      const errors = 'errors' in item ? item.errors : [];
      return <tr key={index} className={errors.length ? 'import-invalid' : ''}><td>{'rowNumber' in item ? item.rowNumber : <span className={'source-tag ' + item.disposition}>{item.disposition === 'added' ? 'New' : 'Skipped'}</span>}</td><td>{data.doNo || '—'}</td><td><strong>{data.materialCode || '—'}</strong><small>{data.description}</small></td><td>{data.deliveryDate || '—'}</td><td>{data.quantity ?? '—'} {data.unit}</td><td>{'changedFields' in item ? <><ImportChanges row={item} asOfDate={input?.asOfDate ?? asOfDate}/>{item.disposition === 'added' && data.deliveryDate < asOfDate && <span className="source-tag review">Status check before planning</span>}</> : errors.length ? errors.join(' · ') : 'Valid'}</td></tr>;
    })}</tbody></table></div><div className="data-pagination"><span>{(page - 1) * 50 + 1}–{Math.min(page * 50, count)} of {count} rows</span><div><button className="button secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><button className="button secondary" disabled={page * 50 >= count} onClick={() => setPage(value => value + 1)}>Next</button></div></div></>}
    {preview && <label className="checkbox-label import-confirm"><input type="checkbox" checked={confirmed} disabled={mutationLocked || hasConflict} onChange={event => setConfirmed(event.target.checked)}/>I reviewed the new orders. Add them without updating existing orders or creating production cards.</label>}
    {failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
  </div><footer className="editor-footer">{preview && <button className="button secondary" disabled={mutationLocked || busy} onClick={resetPreview}><ArrowLeft size={15}/>Back to worksheet</button>}<div className="toolbar-spacer"/><button className="button secondary" disabled={mutationLocked || busy} onClick={closeImport}>Cancel</button>{preview ? <button className="button primary" disabled={!confirmed || mutationLocked || hasConflict || busy} onClick={() => void save()}><Check size={16}/>{mutationLocked ? 'Saving…' : 'Confirm import'}</button> : <button className="button primary" disabled={!book || !parsed.rows.length || !!invalid.length || !!parsed.error || !context || !!contextError || busy || mutationLocked || hasConflict} onClick={() => void review()}>Review import</button>}</footer></div></section></div>;
}
