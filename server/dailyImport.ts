import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { DailyImportPreview, DailyReportInput, PlanningControl, PlanningControlAction, SourceOrderObservation } from '../src/domain/dailyImport';
import { baselineBalances, normalizeBucketText, quantityToScaled, scaledToQuantity } from '../src/domain/inventory';
import type { InventoryWorkbookItemInput } from '../src/domain/inventoryTypes';
import type { SourceImportInput, SourceOrderFields } from '../src/domain/sourceTypes';
import type { AppState, HistoryEvent } from '../src/domain/types';
import { ApiError } from './errors';
import { insertMovement, recalculateReservations, upsertWorkbookItem } from './inventory';
import { applySourceImport } from './sourceData';

export async function previewDailyReports(db: pg.Pool | pg.PoolClient, reports: DailyReportInput[]): Promise<DailyImportPreview> {
  const sorted = validateReports(reports);
  const revisionRow = await db.query<{ revision: string }>('SELECT revision::text FROM workspace WHERE id=1');
  const stored = await db.query<{digest:string;as_of_date:string}>("SELECT digest,as_of_date::text FROM inventory_imports WHERE workspace_id=1 AND import_mode='dated-report' AND as_of_date=ANY($1::date[])",[sorted.map(report=>report.asOfDate)]);
  const storedKeys = new Set(stored.rows.map(row=>`${row.digest}|${row.as_of_date}`));
  const fresh = sorted.filter(report=>!storedKeys.has(`${report.digest}|${report.asOfDate}`));
  const keys = uniqueOrderKeys(sorted);
  const existing = keys.length ? await db.query<{ do_no: string; material_code: string }>(
    `SELECT do_no,material_code FROM source_orders
      WHERE workspace_id=1 AND (lower(btrim(do_no)),lower(btrim(material_code))) IN
      (SELECT lower(btrim(x.do_no)),lower(btrim(x.material_code)) FROM jsonb_to_recordset($1::jsonb) x(do_no text,material_code text))`,
    [JSON.stringify(keys.map(([do_no, material_code]) => ({ do_no, material_code })))],
  ) : { rows: [] } as { rows: Array<{ do_no: string; material_code: string }> };
  const existingKeys = new Set(existing.rows.map(row => `${row.do_no.trim().toLowerCase()}\0${row.material_code.trim().toLowerCase()}`));
  const formulaDifferences: DailyImportPreview['formulaDifferences'] = [];
  const continuityDifferences: DailyImportPreview['continuityDifferences'] = [];
  const stockDifferences: DailyImportPreview['stockDifferences'] = [];
  let previous = new Map<string, InventoryWorkbookItemInput>();
  for (const report of sorted) {
    const current = new Map(report.stockRows.map(row => [stockKey(row), row]));
    if(storedKeys.has(`${report.digest}|${report.asOfDate}`)){previous=current;continue;}
    for (const row of report.stockRows) {
      const calculated = scaled(row, row.opening) + scaled(row, row.production) + scaled(row, row.received) + scaled(row, row.salesReturn) - scaled(row, row.rework) - scaled(row, row.issue);
      const difference = scaled(row, row.closing) - calculated;
      if (difference) formulaDifferences.push(differenceView(row, report.asOfDate, difference));
      const prior = previous.get(stockKey(row));
      if (prior) {
        const continuity = scaled(row, row.opening) - scaled(prior, prior.closing);
        if (continuity) continuityDifferences.push(differenceView(row, report.asOfDate, continuity));
      }
    }
    previous = current;
  }
  const last = sorted.at(-1)!;
  const balances = await db.query<{ material_code: string; unit: 'Bags'|'MT'; medication: string; fmr_omed: string; balance: string }>(
    `SELECT i.material_code,i.unit,l.medication,l.fmr_omed,sum(l.quantity_delta_scaled)::text balance
       FROM inventory_ledger l JOIN inventory_items i ON i.id=l.item_id WHERE l.workspace_id=1 AND l.occurred_on<=$1::date
      GROUP BY i.material_code,i.unit,l.medication,l.fmr_omed`,
    [last.asOfDate],
  );
  const balanceByKey = new Map(balances.rows.map(row => [`${row.material_code.trim().toUpperCase()}\0${normalizeBucketText(row.medication)}\0${normalizeBucketText(row.fmr_omed)}`, Number(row.balance)]));
  const established = await hasEstablishedInventory(db);
  if (fresh.length && established) for (const row of last.stockRows) {
    const difference = scaled(row, row.closing) - (balanceByKey.get(stockKey(row)) ?? 0);
    if (difference) stockDifferences.push(differenceView(row, last.asOfDate, difference));
  }
  const warnings: string[] = [];
  if(fresh.length<sorted.length)warnings.push(`${sorted.length-fresh.length} report(s) are already stored and will be skipped without changing stock or order controls.`);
  if (formulaDifferences.length) warnings.push(`${formulaDifferences.length} daily stock row(s) do not match their reported Closing.`);
  if (continuityDifferences.length) warnings.push(`${continuityDifferences.length} Opening value(s) do not continue from the preceding Closing.`);
  if (stockDifferences.length) warnings.push(`${stockDifferences.length} latest Closing value(s) differ from the current stock ledger.`);
  return {
    revision: Number(revisionRow.rows[0]?.revision ?? 0),
    reports: sorted.map(report => ({ asOfDate: report.asOfDate, fileName: report.fileName, sheetName: report.sheetName,
      orderCount: report.orderRows.length, stockCount: report.stockRows.length,
      bagCount: report.orderRows.filter(row => row.unit === 'Bags').length, bulkCount: report.orderRows.filter(row => row.unit === 'MT').length })),
    newOrders: keys.filter(([a,b]) => !existingKeys.has(`${a.trim().toLowerCase()}\0${b.trim().toLowerCase()}`)).length,
    existingOrders: keys.filter(([a,b]) => existingKeys.has(`${a.trim().toLowerCase()}\0${b.trim().toLowerCase()}`)).length,
    formulaDifferences, continuityDifferences, stockDifferences,
    requiresReconcile: Boolean(formulaDifferences.length || continuityDifferences.length || stockDifferences.length), warnings,
  };
}

export async function importDailyReports(
  client: pg.PoolClient, state: AppState, reports: DailyReportInput[], reconcile: boolean, reason: string, nowIso: string,
): Promise<AppState> {
  const sorted = validateReports(reports);
  const preview = await previewDailyReports(client, sorted);
  if (preview.requiresReconcile && !reconcile) {
    throw new ApiError(409, 'DAILY_REPORT_RECONCILIATION_REQUIRED', 'The daily reports contain balance differences. Preview and confirm reconciliation first.');
  }
  if (reconcile && !reason.trim()) throw new ApiError(400, 'RECONCILIATION_REASON_REQUIRED', 'A reason is required when reconciling reported stock.');
  const previousDaily = await client.query('SELECT 1 FROM inventory_imports WHERE workspace_id=1 AND import_mode=$1 LIMIT 1', ['dated-report']);
  const initialHistory = !previousDaily.rowCount && !await hasEstablishedInventory(client);
  let next = state;
  let previousReport:DailyReportInput|null=null;
  let importedAny=false;
  for (const report of sorted) {
    const duplicate = await client.query('SELECT id FROM inventory_imports WHERE workspace_id=1 AND digest=$1 AND as_of_date=$2::date AND import_mode=$3', [report.digest, report.asOfDate, 'dated-report']);
    if (duplicate.rowCount) { previousReport=report;continue; }
    const sameDate=await client.query('SELECT 1 FROM inventory_imports WHERE workspace_id=1 AND as_of_date=$1::date AND import_mode=$2 LIMIT 1',[report.asOfDate,'dated-report']);
    if(sameDate.rowCount)throw new ApiError(409,'DAILY_REPORT_DATE_CONFLICT','A different dated report is already stored for this date. Review the existing import instead of replaying the day.');
    importedAny=true;
    next = withCatalog(next, report.stockRows);
    const inventoryImportId = `inventory-import-${randomUUID()}`;
    await client.query(
      `INSERT INTO inventory_imports(id,workspace_id,file_name,digest,semantic_digest,as_of_date,included_baseline,packing_bin_total_scaled,imported_at,import_mode,sheet_name)
       VALUES($1,1,$2,$3,$4,$5::date,$6,NULL,$7::timestamptz,'dated-report',$8)`,
      [inventoryImportId, report.fileName, report.digest, canonicalHash({ date: report.asOfDate, stock: report.stockRows }), report.asOfDate,
        initialHistory && report === sorted[0], nowIso, report.sheetName],
    );
    for (const row of report.stockRows) {
      const item = await upsertWorkbookItem(client, next, row, nowIso, initialHistory && report === sorted[0]);
      const values = stockValues(row);
      const calculated = baselineBalances(values.opening, values.production, values.received, values.salesReturn, values.rework, values.issue);
      const formulaDifference = values.closing - calculated;
      const prior=previousReport?.stockRows.find(candidate=>stockKey(candidate)===stockKey(row));
      const continuityDifference=prior?values.opening-scaled(prior,prior.closing):0;
      await client.query(
        `INSERT INTO inventory_baseline_reports(import_id,item_id,medication,fmr_omed,opening_scaled,production_scaled,received_scaled,sales_return_scaled,rework_scaled,issue_scaled,closing_scaled,calculated_closing_scaled,formula_difference_scaled,continuity_difference_scaled,reconciliation_difference_scaled)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,0)`,
        [inventoryImportId, item.id, normalizeBucketText(row.medication), normalizeBucketText(row.fmrOmed), values.opening, values.production, values.received,
          values.salesReturn, values.rework, values.issue, values.closing, calculated, formulaDifference,continuityDifference],
      );
      if (initialHistory) {
        if (report === sorted[0] && values.opening) await movement(client, item.id, row, 'baseline', values.opening, report, inventoryImportId, nowIso, 'opening');
        if (continuityDifference) await movement(client,item.id,row,'adjustment',continuityDifference,report,inventoryImportId,nowIso,'continuity',reason);
        await movement(client, item.id, row, 'production', values.production, report, inventoryImportId, nowIso, 'production');
        await movement(client, item.id, row, 'received', values.received, report, inventoryImportId, nowIso, 'received');
        await movement(client, item.id, row, 'return', values.salesReturn, report, inventoryImportId, nowIso, 'return');
        await movement(client, item.id, row, 'rework', -values.rework, report, inventoryImportId, nowIso, 'rework');
        await movement(client, item.id, row, 'dispatch', -values.issue, report, inventoryImportId, nowIso, 'issue');
        if (formulaDifference) await movement(client, item.id, row, 'adjustment', formulaDifference, report, inventoryImportId, nowIso, 'reported-closing', reason);
      } else if (reconcile) {
        const balance = await client.query<{ balance: string }>(
          `SELECT COALESCE(sum(quantity_delta_scaled),0)::text balance FROM inventory_ledger WHERE item_id=$1 AND medication=$2 AND fmr_omed=$3 AND occurred_on<=$4::date`,
          [item.id, normalizeBucketText(row.medication), normalizeBucketText(row.fmrOmed), report.asOfDate],
        );
        const difference = values.closing - Number(balance.rows[0].balance);
        if (difference) {
          await client.query('UPDATE inventory_baseline_reports SET reconciliation_difference_scaled=$2 WHERE import_id=$1 AND item_id=$3 AND medication=$4 AND fmr_omed=$5',
            [inventoryImportId, difference, item.id, normalizeBucketText(row.medication), normalizeBucketText(row.fmrOmed)]);
          await movement(client, item.id, row, 'adjustment', difference, report, inventoryImportId, nowIso, 'physical-count', reason);
        }
      }
    }
    next = await importDailyOrders(client, next, report, nowIso);
    previousReport=report;
  }
  if(!importedAny)return state;
  await applyLatestProjection(client, sorted.at(-1)!.asOfDate, nowIso);
  await recalculateReservations(client, nowIso);
  return appendEvent(next, nowIso, 'inventory.daily-reports.imported', `Imported ${sorted.length} dated daily report${sorted.length === 1 ? '' : 's'} through ${sorted.at(-1)!.asOfDate}.`);
}

export async function importSourceBatch(client: pg.PoolClient, state: AppState, inputs: SourceImportInput[], nowIso: string): Promise<AppState> {
  let next = state;
  for (const input of inputs) {
    const result = await applySourceImport(client, next, input, nowIso);
    next = result.state;
    await client.query(`UPDATE source_imports SET import_mode='sap-append' WHERE workspace_id=1 AND digest=$1 AND as_of_date=$2::date`, [input.digest, input.asOfDate]);
    await syncSapOrders(client, input, nowIso);
  }
  await recalculateReservations(client, nowIso);
  return next;
}

export async function setPlanningControl(client: pg.PoolClient, state: AppState, sourceOrderId: string, action: PlanningControlAction, reason: string, stockAccounted: boolean | undefined, nowIso: string): Promise<AppState> {
  if (!reason.trim()) throw new ApiError(400, 'PLANNING_CONTROL_REASON_REQUIRED', 'A reason is required.');
  const current = await client.query<{ planning_control: PlanningControl; historical_status: 'pending'|'done'|'out' }>(
    'SELECT planning_control,historical_status FROM inventory_orders WHERE source_order_id=$1 FOR UPDATE', [sourceOrderId]);
  if (!current.rowCount) throw new ApiError(404, 'INVENTORY_ORDER_NOT_FOUND', 'Inventory order not found.');
  if (action === 'historicalOut' && stockAccounted !== true) throw new ApiError(409, 'OUT_STOCK_CONFIRMATION_REQUIRED', 'Confirm that this historical OUT quantity is already reflected in the stock baseline.');
  const before = current.rows[0].planning_control;
  const after: PlanningControl = action === 'hold' ? 'hold' : action === 'cancel' ? 'cancel' : 'active';
  let status = action === 'historicalDone' ? 'done' : action === 'historicalOut' ? 'out' : current.rows[0].historical_status;
  if(action==='release'&&status!=='pending'){
    const actual=await client.query("SELECT 1 FROM inventory_ledger WHERE source_order_id=$1 LIMIT 1",[sourceOrderId]);
    if(!actual.rowCount)status='pending';
  }
  await client.query(`UPDATE inventory_orders SET planning_control=$2,planning_control_reason=$3,planning_control_updated_at=$4::timestamptz,historical_status=$5,needs_review=$6,updated_at=$4::timestamptz WHERE source_order_id=$1`,
    [sourceOrderId, after, reason.trim(), nowIso, status, false]);
  await client.query(`INSERT INTO planning_control_events(id,workspace_id,source_order_id,action,before_control,after_control,reason,occurred_at) VALUES($1,1,$2,$3,$4,$5,$6,$7::timestamptz)`,
    [`control-${randomUUID()}`, sourceOrderId, action, before, after, reason.trim(), nowIso]);
  await recalculateReservations(client, nowIso);
  return appendEvent(state, nowIso, 'data.planning-control.changed', `Updated planning control: ${reason.trim()}`);
}

export async function listSourceOrderObservations(db: pg.Pool | pg.PoolClient, sourceOrderId: string): Promise<SourceOrderObservation[]> {
  const rows = await db.query<any>(`SELECT id,import_id,source_order_id,as_of_date::text,source_row,raw_status,effective_status,fields,created_at FROM source_order_observations WHERE workspace_id=1 AND source_order_id=$1 ORDER BY as_of_date,created_at,id`, [sourceOrderId]);
  return rows.rows.map(row => ({ id: row.id, importId: row.import_id, sourceOrderId: row.source_order_id, asOfDate: row.as_of_date,
    sourceRow: row.source_row, rawStatus: row.raw_status, effectiveStatus: row.effective_status, fields: row.fields, createdAt: new Date(row.created_at).toISOString() }));
}

async function importDailyOrders(client: pg.PoolClient, state: AppState, report: DailyReportInput, nowIso: string): Promise<AppState> {
  if (!report.orderRows.length) return state;
  const input: SourceImportInput = { fileName: report.fileName, sheetName: report.sheetName, digest: report.digest, asOfDate: report.asOfDate, rows: report.orderRows };
  const result = await applySourceImport(client, state, input, nowIso);
  const importRow = await client.query<{ id: string }>(`SELECT id FROM source_imports WHERE workspace_id=1 AND digest=$1 AND sheet_name=$2 AND as_of_date=$3::date ORDER BY imported_at DESC LIMIT 1`, [report.digest, report.sheetName, report.asOfDate]);
  if (!importRow.rowCount) throw new Error('Daily source import was not persisted.');
  const importId = importRow.rows[0].id;
  await client.query(`UPDATE source_imports SET import_mode='dated-report',daily_sheet_name=$2 WHERE id=$1`, [importId, report.sheetName]);
  const identities = await sourceIds(client, report.orderRows);
  for (const fields of report.orderRows) {
    const sourceOrderId = identities.get(orderKey(fields));
    if (!sourceOrderId) throw new Error(`Daily source identity was not persisted: ${fields.doNo}/${fields.materialCode}`);
    const rawStatus = `${fields.goodsMovementStatus ?? ''} ${fields.remark ?? ''}`.trim();
    await client.query(
      `INSERT INTO source_order_observations(id,workspace_id,import_id,source_order_id,as_of_date,source_row,raw_status,effective_status,fields,fields_hash,created_at)
       VALUES($1,1,$2,$3,$4::date,$5,$6,$7,$8::jsonb,$9,$10::timestamptz) ON CONFLICT(workspace_id,import_id,source_order_id) DO NOTHING`,
      [`observation-${randomUUID()}`, importId, sourceOrderId, report.asOfDate, fields.sourceRow ?? null, rawStatus, effectiveStatus(rawStatus), JSON.stringify(fields), canonicalHash(fields), nowIso],
    );
    const latest=await client.query<{latest:string}>("SELECT max(as_of_date)::text latest FROM source_order_observations WHERE source_order_id=$1",[sourceOrderId]);
    if(latest.rows[0].latest===report.asOfDate){
      await projectDatedSourceVersion(client,sourceOrderId,importId,fields,nowIso);
      await upsertProjectionOrder(client, state, sourceOrderId, fields, rawStatus, report.asOfDate, nowIso);
    }
  }
  await client.query("DELETE FROM source_order_discrepancies WHERE import_id=$1",[importId]);
  return result.state;
}

async function projectDatedSourceVersion(client:pg.PoolClient,sourceOrderId:string,importId:string,fields:SourceOrderFields,nowIso:string):Promise<void>{
  const current=await client.query<{latest_version:number;fields:SourceOrderFields}>(`SELECT o.latest_version,v.fields FROM source_orders o JOIN source_order_versions v ON v.source_order_id=o.id AND v.version=o.latest_version WHERE o.id=$1 FOR UPDATE OF o`,[sourceOrderId]);
  if(!current.rowCount)throw new Error('Dated source order projection is missing.');
  if(canonicalHash(current.rows[0].fields)===canonicalHash(fields))return;
  const version=current.rows[0].latest_version+1;
  await client.query(`INSERT INTO source_order_versions(source_order_id,version,import_id,fields,content_hash,created_at) VALUES($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,[sourceOrderId,version,importId,JSON.stringify(fields),canonicalHash(fields),nowIso]);
  await client.query(`UPDATE source_orders SET latest_version=$2,latest_import_id=$3,updated_at=$4::timestamptz WHERE id=$1`,[sourceOrderId,version,importId,nowIso]);
}

async function applyLatestProjection(client: pg.PoolClient, importedThrough:string, nowIso: string): Promise<void> {
  const maximum=await client.query<{date:string|null}>("SELECT max(as_of_date)::text date FROM inventory_imports WHERE workspace_id=1 AND import_mode='dated-report'");
  if(!maximum.rows[0].date||importedThrough<maximum.rows[0].date)return;
  const latestIds=await client.query<{source_order_id:string}>("SELECT DISTINCT source_order_id FROM source_order_observations WHERE as_of_date=$1::date",[maximum.rows[0].date]);
  const latestKeys = new Set(latestIds.rows.map(row=>row.source_order_id));
  const rows = await client.query<{ source_order_id: string; do_no: string; material_code: string; historical_status: 'pending'|'done'|'out'; planning_control: PlanningControl }>(
    `SELECT io.source_order_id,o.do_no,o.material_code,io.historical_status,io.planning_control FROM inventory_orders io JOIN source_orders o ON o.id=io.source_order_id
      WHERE EXISTS(SELECT 1 FROM source_order_observations x WHERE x.source_order_id=io.source_order_id)`,
  );
  for (const row of rows.rows) {
    if (latestKeys.has(row.source_order_id)) continue;
    if (row.historical_status === 'out' || row.planning_control === 'cancel') continue;
    await client.query(`UPDATE inventory_orders SET planning_control='review',planning_control_reason='Missing from latest dated report',planning_control_updated_at=$2::timestamptz,needs_review=true,updated_at=$2::timestamptz WHERE source_order_id=$1`, [row.source_order_id, nowIso]);
  }
}

async function upsertProjectionOrder(client: pg.PoolClient, state: AppState, sourceOrderId: string, fields: SourceOrderFields, rawStatus: string, asOfDate: string, nowIso: string): Promise<void> {
  const item = await upsertWorkbookItem(client, state, sourceAsStock(fields), nowIso, false);
  const current = await client.query<{ historical_status: 'pending'|'done'|'out'; planning_control: PlanningControl; planning_control_reason: string|null;ordered_quantity_scaled:string }>('SELECT historical_status,planning_control,planning_control_reason,ordered_quantity_scaled::text FROM inventory_orders WHERE source_order_id=$1 FOR UPDATE', [sourceOrderId]);
  const token = rawStatus.trim().toUpperCase();
  const rawEffective = effectiveStatus(token);
  let status: 'pending'|'done'|'out' = current.rows[0]?.historical_status ?? 'pending';
  let control: PlanningControl = current.rows[0]?.planning_control ?? 'active';
  let controlReason: string | null = current.rows[0]?.planning_control_reason ?? null;
  let needsReview = item.needs_review;
  if (status !== 'out') {
    if (rawEffective === 'out') status = 'out'; else if (rawEffective === 'done') status = 'done';
    else if (status === 'done' && !token) { control = 'review'; controlReason = 'DONE disappeared from a later dated report'; needsReview = true; }
  }
  if (token.includes('CANCEL')) { control = 'cancel'; controlReason = `CANCEL in ${asOfDate}`; }
  else if (token.includes('HOLD') && control !== 'cancel') { control = 'hold'; controlReason = `HOLD in ${asOfDate}`; }
  else if (token && rawEffective==='pending') { control='review';controlReason=`Unrecognized status in ${asOfDate}: ${rawStatus}`;needsReview=true; }
  else if (!token && (control === 'hold' || control === 'cancel')) { /* sticky */ }
  else if (control !== 'cancel' && control !== 'review') { control = 'active'; controlReason = null; }
  let ordered = quantityToScaled(fields.unit, fields.quantity, `${fields.doNo} quantity`);
  if(current.rowCount){
    const actual=await client.query<{total:string}>(`SELECT greatest(
      COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0),
      COALESCE(sum(CASE WHEN l.movement_type='dispatch' THEN -l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='dispatch' THEN -l.quantity_delta_scaled ELSE 0 END),0)
      )::text total FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.source_order_id=$1`,[sourceOrderId]);
    if(ordered<Number(actual.rows[0].total)){ordered=Number(current.rows[0].ordered_quantity_scaled);control='review';controlReason='Reported quantity is below recorded production or collection';needsReview=true;}
  }
  await client.query(
    `INSERT INTO inventory_orders(source_order_id,workspace_id,item_id,due_date,ordered_quantity_scaled,medication,fmr_omed,historical_status,needs_review,planning_control,planning_control_reason,planning_control_updated_at,created_at,updated_at)
     VALUES($1,1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$11::timestamptz,$11::timestamptz)
     ON CONFLICT(source_order_id) DO UPDATE SET item_id=EXCLUDED.item_id,due_date=CASE WHEN inventory_orders.manual_due_date THEN inventory_orders.due_date ELSE EXCLUDED.due_date END,
       ordered_quantity_scaled=EXCLUDED.ordered_quantity_scaled,historical_status=EXCLUDED.historical_status,needs_review=inventory_orders.needs_review OR EXCLUDED.needs_review,
       planning_control=EXCLUDED.planning_control,planning_control_reason=EXCLUDED.planning_control_reason,planning_control_updated_at=EXCLUDED.planning_control_updated_at,updated_at=EXCLUDED.updated_at`,
    [sourceOrderId, item.id, fields.deliveryDate, ordered, normalizeBucketText(fields.medication), normalizeBucketText(fields.fmrOmed), status, needsReview, control, controlReason, nowIso],
  );
}

async function syncSapOrders(client: pg.PoolClient, input: SourceImportInput, nowIso: string): Promise<void> {
  const ids = await sourceIds(client, input.rows);
  for (const fields of input.rows) {
    const id = ids.get(orderKey(fields)); if (!id) continue;
    const current = await client.query<{ historical_status:string; planning_control:PlanningControl }>('SELECT historical_status,planning_control FROM inventory_orders WHERE source_order_id=$1', [id]);
    if (current.rowCount) continue; // SAP append never regresses established operational/history state.
    const stale = fields.deliveryDate < input.asOfDate;
    await upsertProjectionOrder(client, { catalog: [] } as unknown as AppState, id, fields, '', input.asOfDate, nowIso);
    if (stale) await client.query(`UPDATE inventory_orders SET planning_control='review',planning_control_reason='New SAP order is already overdue',planning_control_updated_at=$2::timestamptz,needs_review=true WHERE source_order_id=$1`, [id, nowIso]);
  }
}

async function sourceIds(client: pg.PoolClient, fields: SourceOrderFields[]): Promise<Map<string,string>> {
  const rows = await client.query<{ id:string;do_no:string;material_code:string }>(
    `SELECT o.id,o.do_no,o.material_code FROM source_orders o JOIN jsonb_to_recordset($1::jsonb) x(do_no text,material_code text)
      ON lower(btrim(o.do_no))=lower(btrim(x.do_no)) AND lower(btrim(o.material_code))=lower(btrim(x.material_code)) WHERE o.workspace_id=1`,
    [JSON.stringify(fields.map(row => ({ do_no: row.doNo, material_code: row.materialCode })))],
  );
  return new Map(rows.rows.map(row => [`${row.do_no.trim().toLowerCase()}\0${row.material_code.trim().toLowerCase()}`, row.id]));
}

async function movement(client:pg.PoolClient,itemId:string,row:InventoryWorkbookItemInput,type:string,delta:number,report:DailyReportInput,importId:string,nowIso:string,kind:string,note?:string) {
  if (!delta) return;
  await insertMovement(client, { itemId, medication: row.medication, fmrOmed: row.fmrOmed, movementType: type, quantityDeltaScaled: delta,
    occurredOn: report.asOfDate, recordedAt: nowIso, postingKey: `daily:${report.asOfDate}:${itemId}:${canonicalHash([row.medication,row.fmrOmed,kind]).slice(0,20)}`,
    importId, note: note || `${kind} reported by ${report.fileName}.`, metadata: { datedReport: true, sheetName: report.sheetName } });
}

function validateReports(reports: DailyReportInput[]): DailyReportInput[] {
  if (!reports.length) throw new ApiError(400, 'DAILY_REPORTS_REQUIRED', 'At least one dated report is required.');
  const sorted = reports.slice().sort((a,b) => a.asOfDate.localeCompare(b.asOfDate));
  if (new Set(sorted.map(row => row.asOfDate)).size !== sorted.length) throw new ApiError(400, 'DAILY_REPORT_DATE_DUPLICATE', 'Only one dated report may be imported for each day.');
  return sorted;
}
async function hasEstablishedInventory(db:pg.Pool|pg.PoolClient):Promise<boolean>{
  const result=await db.query<{established:boolean}>("SELECT EXISTS(SELECT 1 FROM inventory_ledger WHERE workspace_id=1) OR EXISTS(SELECT 1 FROM inventory_imports WHERE workspace_id=1 AND included_baseline) AS established");
  return result.rows[0].established;
}
function withCatalog(state:AppState,rows:InventoryWorkbookItemInput[]):AppState { const catalog=[...state.catalog]; for(const row of rows)if(!catalog.some(p=>p.code.trim().toUpperCase()===row.materialCode.trim().toUpperCase()))catalog.push({id:`catalog-${canonicalHash(row.materialCode.trim().toUpperCase()).slice(0,24)}`,code:row.materialCode,description:row.description,defaultMode:row.unit==='Bags'?'bags':'bulk',active:true}); return {...state,catalog}; }
function sourceAsStock(row:SourceOrderFields):InventoryWorkbookItemInput { const match=row.description.match(/\b(25|50)\s*KG\b/i);return { materialCode:row.materialCode,description:row.description,unit:row.unit,bagWeightKg:row.unit==='Bags'?(match?Number(match[1]) as 25|50:null):null,strategy:'mto',targetQuantity:0,needsReview:row.unit==='Bags'&&!match,opening:0,production:0,received:0,salesReturn:0,rework:0,issue:0,closing:0,medication:row.medication,fmrOmed:row.fmrOmed }; }
function stockValues(row:InventoryWorkbookItemInput){return{opening:scaled(row,row.opening),production:scaled(row,row.production),received:scaled(row,row.received),salesReturn:scaled(row,row.salesReturn),rework:scaled(row,row.rework),issue:scaled(row,row.issue),closing:scaled(row,row.closing)}}
function scaled(row:InventoryWorkbookItemInput,value:number){return quantityToScaled(row.unit,value,`${row.materialCode} quantity`)}
function differenceView(row:InventoryWorkbookItemInput,date:string,difference:number){return{materialCode:row.materialCode,unit:row.unit,date,difference:scaledToQuantity(row.unit,difference)}}
function stockKey(row:{materialCode:string;medication:string;fmrOmed:string}){return`${row.materialCode.trim().toUpperCase()}\0${normalizeBucketText(row.medication)}\0${normalizeBucketText(row.fmrOmed)}`}
function orderKey(row:{doNo:string;materialCode:string}){return`${row.doNo.trim().toLowerCase()}\0${row.materialCode.trim().toLowerCase()}`}
function uniqueOrderKeys(reports:DailyReportInput[]){const map=new Map<string,[string,string]>();for(const row of reports.flatMap(r=>r.orderRows))map.set(orderKey(row),[row.doNo,row.materialCode]);return[...map.values()]}
function effectiveStatus(raw:string):'pending'|'done'|'out'{const token=raw.trim().toUpperCase();return token.includes('OUT')?'out':token.includes('DONE')?'done':'pending'}
function canonicalHash(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex')}
function canonical(value:unknown):string{if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;const row=value as Record<string,unknown>;return`{${Object.keys(row).sort().map(k=>`${JSON.stringify(k)}:${canonical(row[k])}`).join(',')}}`}
function appendEvent(state:AppState,at:string,type:string,message:string):AppState{const event:HistoryEvent={id:`event-${randomUUID()}`,at,type,message};return{...state,events:[...state.events,event]}}
