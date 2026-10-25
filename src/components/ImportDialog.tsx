import { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, X, ArrowLeft, Check } from 'lucide-react';
import { useWorkspace } from '../lib/workspace';
import { localDate } from '../lib/format';
import { IMPORT_FIELDS, cellText, parseImportRows, readImportBook, suggestHeader, suggestMapping } from '../lib/excelImport';
import type { ColumnMapping, DateOrder, ImportBook } from '../lib/excelImport';
import type { SourceImportInput, SourceImportPreview } from '../domain/sourceTypes';
import { previewSourceImport } from '../lib/dataApi';
import { useModal } from './useModal';
import './ProductionEditor.css';
import '../pages/Data.css';
import { isFeedWorkbook, parseFeedWorkbook, type FeedWorkbookData } from '../lib/feedWorkbook';
import { FeedImportDialog } from './FeedImportDialog';

function columnName(index: number): string { let value = ''; while (index) { index--; value = String.fromCharCode(65 + index % 26) + value; index = Math.floor(index / 26); } return value; }
export function ImportDialog() {
  const { closeImport, commit, mutationLocked, hasConflict, resolveConflict, refresh, storageWarning, toast, confirmedRetry, navigate } = useWorkspace();
  const [book, setBook] = useState<ImportBook | null>(null);
  const [feed, setFeed] = useState<FeedWorkbookData | null>(null);
  const [fileName, setFileName] = useState('');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [header, setHeader] = useState(1);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [dateOrder, setDateOrder] = useState<DateOrder>('MDY');
  const [asOfDate, setAsOfDate] = useState(localDate());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<SourceImportPreview | null>(null);
  const [input, setInput] = useState<SourceImportInput | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(1);
  const fileInput = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const retryAtMount = useRef(confirmedRetry?.nonce ?? 0);
  const dialog = useModal(closeImport);
  const sheet = book?.sheets[sheetIndex];
  useEffect(() => () => { request.current++; }, []);
  useEffect(() => { if (confirmedRetry && confirmedRetry.nonce > retryAtMount.current && confirmedRetry.type === 'data.import') { closeImport(); navigate('data'); } }, [confirmedRetry?.nonce]);
  const parsed = useMemo(() => {
    if (!sheet || !mapping || !book) return { rows: [], error: '' };
    try { return { rows: parseImportRows(sheet, header, mapping, dateOrder, book.date1904), error: '' }; }
    catch (reason) { return { rows: [], error: reason instanceof Error ? reason.message : 'The worksheet could not be parsed.' }; }
  }, [sheet, mapping, header, dateOrder, book]);
  const invalid = parsed.rows.filter(row => row.errors.length);
  const columns = sheet ? Array.from({ length: Math.min(256, Math.max(sheet.columnCount, 13)) }, (_, index) => {
    let text = ''; try { text = cellText(sheet.getRow(header).getCell(index + 1)); } catch { text = 'Invalid header'; }
    return { column: index + 1, label: columnName(index + 1) + (text ? ' · ' + text : '') };
  }) : [];
  function resetPreview() { setPreview(null); setInput(null); setConfirmed(false); setError(''); setFailed(false); setPage(1); }
  async function read(file: File) {
    const version = ++request.current; resetPreview(); setBook(null); setBusy(true); setFileName(file.name);
    try {
      const value = await readImportBook(file);
      if (version !== request.current) return;
      if (isFeedWorkbook(value)) { setFeed(parseFeedWorkbook(value, file.name)); return; }
      const row = suggestHeader(value.sheets[0]);
      setBook(value); setSheetIndex(0); setHeader(row); setMapping(suggestMapping(value.sheets[0], row));
    } catch (reason) { if (version === request.current) setError(reason instanceof Error ? reason.message : 'The workbook could not be read.'); }
    finally { if (version === request.current) setBusy(false); }
  }
  async function review() {
    if (!sheet || !book || invalid.length || parsed.error || !parsed.rows.length || !asOfDate) return;
    setBusy(true); setError('');
    const value: SourceImportInput = { fileName, sheetName: sheet.name, digest: book.digest, asOfDate, rows: parsed.rows.map(row => row.data) };
    try { setPreview(await previewSourceImport(value)); setInput(value); setConfirmed(false); setPage(1); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'The import preview could not be generated.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!input || !preview || !confirmed) return;
    if (await commit({ type: 'data.import', input }, `Imported ${preview.added} new and ${preview.changed} updated orders.`)) { closeImport(); navigate('data'); }
    else setFailed(true);
  }
  const entries = preview?.rows ?? [];
  const rows = preview ? entries.slice((page - 1) * 50, page * 50) : parsed.rows.slice((page - 1) * 50, page * 50);
  const count = preview ? entries.length : parsed.rows.length;
  if (feed) return <FeedImportDialog data={feed} onBack={() => { setFeed(null); setBook(null); resetPreview(); }}/ >;
  return <div className="editor-layer"><button className="editor-scrim" disabled={mutationLocked || busy} onClick={closeImport} aria-label="Close Excel import"/><section ref={dialog} tabIndex={-1} className="production-editor import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><header className="editor-header"><div><h2 id="import-title">Import Excel orders</h2><p>Review the worksheet and changes before saving to Data.</p></div><button className="icon-button" disabled={mutationLocked || busy} onClick={closeImport} aria-label="Close Excel import"><X size={21}/></button></header><div className="editor-body">
    {hasConflict && <div className="notice warning" role="alert">The workspace changed. Your file is preserved. <button className="text-link" disabled={mutationLocked} onClick={() => { resolveConflict(); resetPreview(); }}>Reload latest data and review again</button></div>}
    {storageWarning && <div className="notice warning">{storageWarning}<button className="text-link" disabled={mutationLocked && !storageWarning} onClick={() => void refresh()}>Retry connection</button></div>}
    {!preview && <div inert={mutationLocked || hasConflict || busy}><div className="import-file"><Upload size={22}/><div><strong>{fileName || 'Choose the Excel export'}</strong><p>.xlsx / .xlsm · up to 5 MB · 2,000 orders per import</p></div><button className="button secondary" onClick={() => fileInput.current?.click()}>{book ? 'Choose another file' : 'Choose file'}</button><input ref={fileInput} type="file" hidden accept=".xlsx,.xlsm" aria-label="Excel order file" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void read(file); }}/></div>{book && sheet && mapping && <><div className="import-options"><label className="field">Worksheet<select value={sheetIndex} onChange={event => { const index = +event.target.value; const row = suggestHeader(book.sheets[index]); setSheetIndex(index); setHeader(row); setMapping(suggestMapping(book.sheets[index], row)); resetPreview(); }}>{book.sheets.map((item, index) => <option key={item.id} value={index}>{item.name}</option>)}</select></label><label className="field">Header row<input type="number" min="1" max={sheet.rowCount || 1} value={header} onChange={event => { const row = Math.max(1, Math.min(sheet.rowCount || 1, +event.target.value)); setHeader(row); setMapping(suggestMapping(sheet, row)); resetPreview(); }}/></label><label className="field">Text date format<select value={dateOrder} onChange={event => { setDateOrder(event.target.value as DateOrder); resetPreview(); }}><option value="MDY">MM/DD/YYYY</option><option value="DMY">DD/MM/YYYY</option><option value="YMD">YYYY/MM/DD</option></select></label><label className="field">Excel as-of date<input required type="date" value={asOfDate} onChange={event => { setAsOfDate(event.target.value); resetPreview(); }}/><small>Day counts are measured from this date.</small></label></div><details className="import-mapping" open={Object.values(mapping).some(value => !value)}><summary>Column mapping · {Object.values(mapping).filter(Boolean).length} / 13 matched</summary><div className="import-mapping-grid">{IMPORT_FIELDS.map(([key, label]) => <label className="field" key={key}>{label}<select value={mapping[key]} onChange={event => { setMapping(previous => ({ ...previous!, [key]: +event.target.value })); resetPreview(); }}><option value={0}>Choose a column</option>{columns.map(column => <option key={column.column} value={column.column}>{column.label}</option>)}</select></label>)}</div></details><p className="data-note">DO no + Material code identifies an order. Missing orders are kept. Formula cells need saved results; formulas and links are never executed.</p></>}</div>}
    {busy && <p role="status">{book ? 'Comparing the import with PostgreSQL…' : 'Reading the workbook…'}</p>}
    {(error || parsed.error) && <p className="data-error" role="alert">{error || parsed.error}</p>}
    {invalid.length > 0 && !preview && <div className="data-error" role="alert"><strong>{invalid.length} rows need correction.</strong> Nothing will be imported until every row is valid.</div>}
    {preview && <><div className="import-summary" aria-label="Import preview summary"><div><strong>{preview.added}</strong><span>New orders</span></div><div><strong>{preview.changed}</strong><span>Updated orders</span></div><div><strong>{preview.unchanged}</strong><span>Unchanged · skipped</span></div></div><p className="data-note"><strong>{input?.fileName}</strong> · {input?.sheetName} · Excel as-of {input?.asOfDate}. Updates retain the previous imported version. Production cards keep their existing quantities.</p></>}
    {count > 0 && <><div className="table-scroll import-preview"><table><thead><tr><th>ROW / RESULT</th><th>DO NO</th><th>MATERIAL</th><th>DELIVERY DATE</th><th>QUANTITY</th><th>{preview ? 'CHANGES' : 'CHECKS'}</th></tr></thead><tbody>{rows.map((item, index) => {
      const data = 'data' in item ? item.data : item.fields;
      const errors = 'errors' in item ? item.errors : [];
      return <tr key={index} className={errors.length ? 'import-invalid' : ''}><td>{'rowNumber' in item ? item.rowNumber : <span className={'source-tag ' + item.disposition}>{item.disposition}</span>}</td><td>{data.doNo || '—'}</td><td><strong>{data.materialCode || '—'}</strong><small>{data.description}</small></td><td>{data.deliveryDate || '—'}</td><td>{data.quantity ?? '—'} {data.unit}</td><td>{'changedFields' in item ? item.changedFields.join(', ') || '—' : errors.length ? errors.join(' · ') : 'Valid'}</td></tr>;
    })}</tbody></table></div><div className="data-pagination"><span>{(page - 1) * 50 + 1}–{Math.min(page * 50, count)} of {count} rows</span><div><button className="button secondary" disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><button className="button secondary" disabled={page * 50 >= count} onClick={() => setPage(value => value + 1)}>Next</button></div></div></>}
    {preview && <label className="checkbox-label import-confirm"><input type="checkbox" checked={confirmed} disabled={mutationLocked || hasConflict} onChange={event => setConfirmed(event.target.checked)}/>I reviewed the dates, quantities and updates. Save these orders without creating production cards.</label>}
    {failed && toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
  </div><footer className="editor-footer">{preview && <button className="button secondary" disabled={mutationLocked || busy} onClick={resetPreview}><ArrowLeft size={15}/>Back to worksheet</button>}<div className="toolbar-spacer"/><button className="button secondary" disabled={mutationLocked || busy} onClick={closeImport}>Cancel</button>{preview ? <button className="button primary" disabled={!confirmed || mutationLocked || hasConflict || busy} onClick={() => void save()}><Check size={16}/>{mutationLocked ? 'Saving…' : 'Confirm import'}</button> : <button className="button primary" disabled={!book || !parsed.rows.length || !!invalid.length || !!parsed.error || !asOfDate || busy || mutationLocked || hasConflict} onClick={() => void review()}>Review import</button>}</footer></section></div>;
}
