import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Upload, X } from 'lucide-react';
import type { DailyImportPreview, DailyReportInput } from '../domain/dailyImport';
import { readImportBook, type ImportBook } from '../lib/excelImport';
import { parseDailyReportWorkbook } from '../lib/feedWorkbook';
import { previewDailyReports } from '../lib/inventoryApi';
import { numberLabel } from '../lib/format';
import { useWorkspace } from '../lib/workspace';

/** Content only: ImportDialog owns the single modal, focus trap and body lock. */
export function FeedImportDialog({ reports, onReportsChange, onBusyChange }: {
  reports: DailyReportInput[];
  onReportsChange: (reports: DailyReportInput[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const { commit, closeImport, navigate, mutationLocked, hasConflict, resolveConflict, toast } = useWorkspace();
  const [books, setBooks] = useState<Record<string, ImportBook>>({});
  const [preview, setPreview] = useState<DailyImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [reconcile, setReconcile] = useState(false);
  const [reason, setReason] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  function resetPreview() { setPreview(null); setConfirmed(false); setReconcile(false); setError(''); }
  function updateReports(next: DailyReportInput[]) {
    onReportsChange([...next].sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)));
    resetPreview();
  }
  async function readFiles(files: File[]) {
    const request = ++generation.current;
    setBusy(true); resetPreview();
    const next = [...reports];
    const nextBooks = { ...books };
    const errors: string[] = [];
    for (const file of files) {
      try {
        const book = await readImportBook(file);
        const candidateSheets = book.sheets.filter(sheet => /^\d{1,2}(st|nd|rd|th)$/i.test(sheet.name.trim()));
        let report = parseDailyReportWorkbook(book, file.name, candidateSheets[0]?.name);
        // Another file may contain the same first day plus additional dated sheets.
        // Start with the first unused day so that the worksheet chooser stays usable.
        if (next.some(row => row.asOfDate === report.asOfDate)) {
          for (const sheet of candidateSheets.slice(1)) {
            const candidate = parseDailyReportWorkbook(book, file.name, sheet.name);
            if (!next.some(row => row.asOfDate === candidate.asOfDate)) { report = candidate; break; }
          }
        }
        if (next.some(row => row.digest === report.digest && row.sheetName === report.sheetName)) continue;
        if (next.some(row => row.asOfDate === report.asOfDate)) throw Error(`A report for ${report.asOfDate} is already selected. Remove it before choosing a replacement.`);
        if (next.length >= 31) throw Error('Select at most 31 daily reports in one batch.');
        next.push(report); nextBooks[report.digest] = book;
      } catch (reason) { errors.push(`${file.name}: ${reason instanceof Error ? reason.message : 'Could not read workbook.'}`); }
    }
    if (request !== generation.current) return;
    onReportsChange(next.sort((a, b) => a.asOfDate.localeCompare(b.asOfDate)));
    setBooks(nextBooks); setError(errors.join('\n')); setBusy(false);
  }
  function changeSheet(report: DailyReportInput, sheetName: string) {
    try {
      const next = parseDailyReportWorkbook(books[report.digest], report.fileName, sheetName);
      if (reports.some(row => row !== report && row.asOfDate === next.asOfDate)) throw Error(`A report for ${next.asOfDate} is already selected.`);
      updateReports(reports.map(row => row === report ? next : row));
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not read worksheet.'); }
  }
  async function review() {
    setBusy(true); setError('');
    try { setPreview(await previewDailyReports(reports)); setConfirmed(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not compare daily reports. Your selected files are preserved.'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || !confirmed || (preview.requiresReconcile && (!reconcile || !reason.trim()))) return;
    const stockReports=reports.map(report=>({fileName:report.fileName,digest:report.digest,sheetName:report.sheetName,asOfDate:report.asOfDate,stockRows:report.stockRows}));
    if (await commit({ type: 'inventory.importStockReports', reports:stockReports, reconcile, reason: reason.trim() }, 'Stock reports imported. Orders were not changed.')) { closeImport(); navigate('stock'); }
  }
  const locked = busy || mutationLocked || hasConflict;
  return <>
    <div className="editor-body">
      {hasConflict && <div className="notice warning" role="alert">The workspace changed. Your files and draft are preserved. <button className="text-link" disabled={mutationLocked} onClick={() => { resolveConflict(); resetPreview(); }}>Reload and compare again</button></div>}
      {!preview && <div className="import-file"><Upload size={22}/><div><strong>Company daily worksheets</strong><p>Select one or more .xlsx / .xlsm files. Only the dated worksheet (26th, 27th, etc.) is used.</p></div><button className="button secondary" disabled={locked} onClick={() => fileInput.current?.click()}>{reports.length ? 'Add files' : 'Choose files'}</button><input hidden multiple type="file" accept=".xlsx,.xlsm" ref={fileInput} aria-label="Baseline Excel files" onChange={event => { const files = Array.from(event.target.files ?? []); event.target.value = ''; if (files.length) void readFiles(files); }}/></div>}
      <p className="data-note">Only the stock table is read. The order table, remarks and manual order fields below it are ignored. In an empty ledger, Opening plus reported movements establishes stock. Later imports keep the report as history and change balances only through confirmed count adjustments, without replaying production or deliveries.</p>
      {reports.length > 0 && <div className="table-scroll import-file-list" role="region" aria-label="Selected baseline reports" tabIndex={0}><table><thead><tr><th>FILE</th><th>DAILY WORKSHEET</th><th>DATE</th><th>STOCK</th><th/></tr></thead><tbody>{reports.map(report => <tr key={`${report.digest}-${report.sheetName}`}><td>{report.fileName}</td><td>{!preview && books[report.digest] ? <select aria-label={`Daily worksheet for ${report.fileName}`} disabled={locked} value={report.sheetName} onChange={event => changeSheet(report, event.target.value)}>{books[report.digest].sheets.filter(sheet => /^\d{1,2}(st|nd|rd|th)$/i.test(sheet.name.trim())).map(sheet => <option key={sheet.id}>{sheet.name}</option>)}</select> : report.sheetName}</td><td>{report.asOfDate}</td><td>{report.stockRows.length}</td><td>{!preview && <button className="icon-button" disabled={locked} aria-label={`Remove ${report.fileName}`} onClick={() => updateReports(reports.filter(row => row !== report))}><X size={16}/></button>}</td></tr>)}</tbody></table></div>}
      {busy && <p role="status">{reports.length ? 'Reading and comparing daily reports…' : 'Reading workbooks…'}</p>}
      {preview && <>
        <div className="import-summary"><div><strong>{preview.reports.length}</strong><span>Stock reports</span></div><div><strong>{preview.reports.reduce((sum,row)=>sum+row.stockCount,0)}</strong><span>Stock rows</span></div><div><strong>{preview.stockDifferences.length}</strong><span>Ledger / Closing differences</span></div></div>
        {preview.warnings.map((warning, index) => <p className="notice warning" key={index}>{warning}</p>)}
        {[['Formula reconciliation', preview.formulaDifferences], ['Daily stock continuity', preview.continuityDifferences], ['Ledger / Closing differences', preview.stockDifferences]].map(([title, entries]) => {
          const rows = entries as DailyImportPreview['stockDifferences'];
          return rows.length > 0 && <details key={String(title)} open><summary>{String(title)} · {rows.length} items</summary><div className="table-scroll import-preview" tabIndex={0}><table><thead><tr><th>DATE</th><th>MATERIAL</th><th>DIFFERENCE</th></tr></thead><tbody>{rows.map((row, index) => <tr key={index}><td>{row.date}</td><td>{row.materialCode}</td><td>{numberLabel(row.difference, row.unit === 'Bags' ? 0 : 3)} {row.unit}</td></tr>)}</tbody></table></div></details>;
        })}
        {preview.requiresReconcile && <div className="notice warning"><label className="checkbox-label"><input type="checkbox" checked={reconcile} disabled={locked} onChange={event => { setReconcile(event.target.checked); setConfirmed(false); }}/>Reconcile the reported Closing and record the displayed differences as stock adjustments</label><label className="field">Reconciliation reason<textarea maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the formula, continuity or ledger differences and why the reported Closing is correct"/></label></div>}
        <p className="data-note">Read-only comparison against workspace revision {preview.revision}. Confirmation validates the whole batch again before saving.</p>
      </>}
      {preview && <label className="checkbox-label import-confirm"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)}/>I checked the report dates and stock differences. Import these stock reports without changing orders.</label>}
      {error && <p className="data-error import-error" role="alert">{error}</p>}
      {toast?.error && <p className="data-error" role="alert">{toast.message}</p>}
    </div>
    <footer className="editor-footer">{preview && <button className="button secondary" disabled={locked} onClick={resetPreview}><ArrowLeft size={15}/>Back to selected files</button>}<div className="toolbar-spacer"/><button className="button secondary" disabled={busy || mutationLocked} onClick={closeImport}>Cancel</button>{preview ? <button className="button primary" disabled={locked || !confirmed || (preview.requiresReconcile && (!reconcile || !reason.trim()))} onClick={() => void save()}><Check size={16}/>{mutationLocked ? 'Saving…' : 'Confirm baseline import'}</button> : <button className="button primary" disabled={locked || !reports.length} onClick={() => void review()}>Review baseline import</button>}</footer>
  </>;
}
