import type { AppState, Board } from '../domain/types';
import type { ProductionReport } from '../domain/reports';
import { getProductionResult } from '../domain/production-results';
import { dateLabel, fullDateTime, numberLabel, STATUS_LABELS } from './format';

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
export function exportBackup(state: AppState,filename='millplan-workspace-backup.json') {
  saveBlob(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), filename);
}
export async function exportExcel(board: Board, state: AppState) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Millplan'; workbook.created = new Date();
  const sheet = workbook.addWorksheet('Daily production', { pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  sheet.views = [{ state: 'frozen', ySplit: 7 }];
  sheet.mergeCells(1, 1, 1, 36); sheet.getCell(1, 1).value = state.settings.siteName;
  sheet.getCell(1, 1).font = { bold: true, size: 18 };
  sheet.mergeCells(2, 1, 2, 36); sheet.getCell(2, 1).value = 'FEEDMILL DAILY PRODUCTION SCHEDULE — ' + dateLabel(board.date);
  sheet.mergeCells(3, 1, 3, 36); sheet.getCell(3, 1).value = 'Planned production: ' + numberLabel(board.lines.reduce((sum, line) => sum + line.plannedMt, 0)) + ' MT · Local workspace export';
  const headings = ['Order no.', 'Product & description', 'Bin', 'Bags', 'MT', 'Planned start', 'Planned end', 'Status', 'Remarks'];
  board.lines.forEach((line, index) => {
    const offset = index * 9;
    sheet.mergeCells(5, offset + 1, 5, offset + 9);
    sheet.getCell(5, offset + 1).value = 'PELLET MILL ' + line.lineId.slice(-1);
    sheet.mergeCells(6, offset + 1, 6, offset + 9);
    sheet.getCell(6, offset + 1).value = 'Production ' + (line.productionMinutes / 60).toFixed(1) + 'h / Available ' + (line.availableMinutes / 60).toFixed(1) + 'h · Utilisation ' + (line.utilisation === null ? 'n/a' : Math.round(line.utilisation * 100) + '%');
    headings.forEach((heading, column) => {
      const cell = sheet.getCell(7, offset + column + 1);
      cell.value = heading; cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF22382A' } };
      cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
      sheet.getColumn(offset + column + 1).width = [10, 25, 11, 10, 10, 20, 20, 13, 26][column];
    });
    const rows = [
      ...line.jobs.map(job => ({ ...job, exportStart: fullDateTime(job.plannedStart), exportEnd: fullDateTime(job.plannedEnd), exportStatus: job.issue ? 'Issue (' + STATUS_LABELS[job.status] + ')' : STATUS_LABELS[job.status] })),
      ...board.backlog.filter(job => job.lineId === line.lineId).map(job => ({ ...job, exportStart: '', exportEnd: '', exportStatus: job.issue ? 'Issue / awaiting quantity' : 'Awaiting quantity' })),
    ];
    rows.forEach((job, rowIndex) => {
      [job.orderNo, job.productCode + ' ' + job.description, job.bin, job.bagCount, job.quantityMt, job.exportStart, job.exportEnd, job.exportStatus, job.remarks + (job.issue ? ' · Issue: ' + job.issue.reason : '') + (job.binNeedsReview ? ' · Review destination bin' : '')].forEach((value, column) => {
        const cell = sheet.getCell(8 + rowIndex, offset + column + 1);
        // Values beginning with "=" stay literal text, never executable spreadsheet formulas.
        cell.value = value;
        cell.alignment = { vertical: 'top', wrapText: true };
        if (column === 4) cell.numFmt = '#,##0.00';
      });
    });
  });
  sheet.eachRow(row => { row.height = 32; });
  sheet.getRow(1).height = 28; sheet.getRow(2).height = 24;
  const actuals = workbook.addWorksheet('Actual production');
  actuals.columns = [
    { header: 'Line', key: 'line', width: 12 }, { header: 'Product', key: 'product', width: 24 },
    { header: 'Order reference', key: 'order', width: 22 }, { header: 'Planning date', key: 'date', width: 16 },
    { header: 'Planned MT', key: 'planned', width: 14 }, { header: 'Actual MT', key: 'actual', width: 14 },
    { header: 'Actual - planned MT', key: 'variance', width: 22 }, { header: 'Actual start', key: 'start', width: 24 },
    { header: 'Actual end (Done)', key: 'end', width: 24 }, { header: 'Planned production hrs', key: 'plannedHours', width: 24 },
    { header: 'Actual elapsed hrs (includes stops)', key: 'elapsedHours', width: 34 }, { header: 'Status', key: 'status', width: 22 },
    { header: 'Completion note', key: 'note', width: 48 }, { header: 'Issue details', key: 'issue', width: 40 },
  ];
  board.lines.flatMap(line => line.jobs).forEach(job => {
    const result=getProductionResult(job);
    actuals.addRow({ line: job.lineId, product: job.productCode, order:job.orderNo, date:job.date, planned:job.quantityMt,
      actual:result.actualQuantityMt??'',variance:result.varianceMt??'',plannedHours:job.durationMinutes/60,
      elapsedHours:result.elapsedMinutes===null?'':result.elapsedMinutes/60,
      start:job.actualStart?fullDateTime(job.actualStart):'',end:job.actualEnd?fullDateTime(job.actualEnd):'',
      status:job.issue?'Issue ('+STATUS_LABELS[job.status]+')':STATUS_LABELS[job.status],note:job.completionNote??'',issue:job.issue?.reason||'' });
  });
  actuals.views=[{state:'frozen',ySplit:1}];
  actuals.autoFilter='A1:N1';
  for(const column of ['planned','actual','variance','plannedHours','elapsedHours'])actuals.getColumn(column).numFmt='#,##0.00';
  actuals.getRow(1).font={bold:true};
  actuals.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
  const buffer = await workbook.xlsx.writeBuffer();
  saveBlob(new Blob([buffer as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'Millplan_' + board.date + '.xlsx');
}
export function printReport() { window.print(); }

export async function exportRangeExcel(report:ProductionReport,state:AppState) {
  const {default:ExcelJS}=await import('exceljs');
  const workbook=new ExcelJS.Workbook();workbook.creator='Millplan';workbook.created=new Date();
  const summary=workbook.addWorksheet('Summary');
  summary.addRow([state.settings.siteName]);
  summary.addRow(['Planning dates',report.selection.from,report.selection.to,'Line',report.selection.lineId]);
  summary.addRow(['Records are selected by planning date. Carry-over is listed once. Cancelled quantities are excluded from planned totals.']);
  summary.addRow(['Actual output',report.recordedCount?report.actualMt:'Not recorded','MT',`${report.recordedCount} / ${report.completedCount} completed records have actual output`]);
  summary.addRow(['Capacity includes production inside each daily window, including carry-over. It is planned utilisation, not OEE.']);
  summary.addRow(['Planning date','Line','Planned MT','Production hrs in day','Available hrs','Planned utilisation','Completed tasks','Actuals recorded','Actual MT']);
  for(const day of report.days)for(const line of day.lines){
    const jobs=report.jobs.filter(job=>job.date===day.date&&job.lineId===line.lineId);
    const completed=jobs.filter(job=>job.status==='completed');
    const recorded=completed.map(getProductionResult).filter(result=>result.actualQuantityMt!==null);
    summary.addRow([day.date,line.lineId,line.plannedMt,line.productionMinutes/60,line.availableMinutes/60,line.utilisation??'',completed.length,recorded.length,recorded.length?recorded.reduce((sum,result)=>sum+result.actualQuantityMt!,0):'']);
  }
  summary.columns.forEach((column,index)=>{column.width=[18,14,17,24,19,22,20,20,18][index]??20;});
  summary.getRow(1).font={bold:true,size:16};summary.getRow(6).font={bold:true};
  summary.views=[{state:'frozen',ySplit:6}];summary.autoFilter='A6:I6';
  for(const column of [3,4,5,9])summary.getColumn(column).numFmt='#,##0.00';summary.getColumn(6).numFmt='0%';
  const records=workbook.addWorksheet('Production records');
  records.columns=[
    {header:'Planning date',key:'date',width:17},{header:'Line',key:'line',width:10},{header:'Order reference',key:'order',width:24},
    {header:'Product',key:'product',width:20},{header:'Description',key:'description',width:30},{header:'Destination bin',key:'bin',width:20},
    {header:'Delivery mode',key:'mode',width:15},{header:'Bags',key:'bags',width:12},{header:'Planned MT',key:'planned',width:16},
    {header:'Actual MT',key:'actual',width:16},{header:'Actual - planned MT',key:'variance',width:23},
    {header:'Planned start (MYT)',key:'plannedStart',width:25},{header:'Planned end (MYT)',key:'plannedEnd',width:25},
    {header:'Actual start (MYT)',key:'actualStart',width:25},{header:'Actual end (MYT)',key:'actualEnd',width:25},
    {header:'Planned production hrs',key:'plannedHours',width:25},{header:'Actual elapsed hrs (includes stops)',key:'elapsedHours',width:35},
    {header:'Status',key:'status',width:22},{header:'Completion note',key:'note',width:45},{header:'Remarks',key:'remarks',width:40},{header:'Issue details',key:'issue',width:40},
  ];
  for(const job of report.jobs){
    const result=getProductionResult(job);
    records.addRow({date:job.date,line:job.lineId,order:job.orderNo,product:job.productCode,description:job.description,bin:job.bin,mode:job.mode,bags:job.bagCount??'',planned:job.quantityMt,actual:result.actualQuantityMt??'',variance:result.varianceMt??'',
      plannedStart:job.plannedStart===null?'':fullDateTime(job.plannedStart),plannedEnd:job.plannedEnd===null?'':fullDateTime(job.plannedEnd),actualStart:job.actualStart?fullDateTime(job.actualStart):'',actualEnd:job.actualEnd?fullDateTime(job.actualEnd):'',
      plannedHours:job.durationMinutes/60,elapsedHours:result.elapsedMinutes===null?'':result.elapsedMinutes/60,
      status:job.issue?'Issue ('+STATUS_LABELS[job.status]+')':job.quantityMt===0&&job.status==='pending'?'Awaiting quantity':STATUS_LABELS[job.status],note:job.completionNote??'',remarks:job.remarks,issue:job.issue?.reason??''});
  }
  records.views=[{state:'frozen',ySplit:1}];records.autoFilter='A1:U1';records.getRow(1).font={bold:true};
  for(const key of ['planned','actual','variance','plannedHours','elapsedHours'])records.getColumn(key).numFmt='#,##0.00';
  records.eachRow(row=>{row.alignment={vertical:'top',wrapText:true};});
  const buffer=await workbook.xlsx.writeBuffer();
  saveBlob(new Blob([buffer as BlobPart],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),`Millplan_${report.selection.from}_${report.selection.to}_${report.selection.lineId}.xlsx`);
}
