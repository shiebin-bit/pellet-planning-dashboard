import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { createJob, getScheduledJobs } from "../src/domain/engine";
import {
  baselineBalances,
  bucketIdentity,
  extraQuantityScaled,
  historicalStatus,
  normalizeBucketText,
  orderNeedScaled,
  quantityToScaled,
  scaledToQuantity,
  signedQuantityToScaled,
  sourceBusinessKey,
} from "../src/domain/inventory";
import type {
  InventoryBucketSnapshot,
  InventoryCommand,
  InventoryDailyStockRow,
  InventoryDraftJob,
  InventoryDraftRequest,
  InventoryItemSnapshot,
  InventoryLedgerEntry,
  InventoryOrderJournalRow,
  InventoryOrderProgress,
  InventoryOrderProgressSnapshot,
  InventoryPlanningDemandRow,
  InventorySnapshot,
  InventoryUnit,
  InventoryWorkbookInput,
} from "../src/domain/inventoryTypes";
import type { SourceImportInput, SourceOrderFields } from "../src/domain/sourceTypes";
import type { AppState, HistoryEvent, Job } from "../src/domain/types";
import { ApiError } from "./errors";
import { applySourceImport } from "./sourceData";

interface ItemRow {
  id: string; catalog_id: string | null; material_code: string; description: string; unit: InventoryUnit;
  bag_weight_kg: 25 | 50 | null; strategy: "mto" | "mts" | null; target_quantity_scaled: string | null;
  extra_type: "fixed" | "percent" | null; extra_value_scaled: string | null; needs_review: boolean;
}

interface OrderRow {
  source_order_id: string; item_id: string; do_no: string; material_code: string; description: string;
  unit: InventoryUnit; due_date: string | Date; ordered_quantity_scaled: string; medication: string; fmr_omed: string;
  historical_status: "pending" | "done" | "out"; needs_review: boolean;
}

interface BalanceRow { item_id: string; medication: string; fmr_omed: string; quantity_scaled: string }

export async function applyInventoryWorkbook(
  client: pg.PoolClient,
  state: AppState,
  input: InventoryWorkbookInput,
  nowIso: string,
  requireBaseline: boolean,
): Promise<AppState> {
  if (requireBaseline && !input.includeBaseline) throw new ApiError(400, "BASELINE_REQUIRED", "Baseline import requires includeBaseline=true.");
  const semanticDigest = hashCanonical(input);
  const duplicate = await client.query<{ id: string }>(
    "SELECT id FROM inventory_imports WHERE workspace_id = 1 AND semantic_digest = $1",
    [semanticDigest],
  );
  if (duplicate.rowCount) return appendEvent(state, nowIso, "inventory.import.duplicate", `Skipped duplicate inventory import ${input.fileName}.`);
  if (input.includeBaseline) {
    const seeded = await client.query("SELECT 1 FROM inventory_imports WHERE workspace_id=1 AND included_baseline LIMIT 1");
    if (seeded.rowCount) throw new ApiError(409, "BASELINE_ALREADY_IMPORTED", "Physical closing stock has already been seeded. Import later workbooks without baseline stock.");
    const movements=await client.query("SELECT 1 FROM inventory_ledger LIMIT 1");
    if(movements.rowCount)throw new ApiError(409,"BASELINE_HAS_MOVEMENTS","Inventory already has physical movements. Use a confirmed physical-count reconciliation instead of adding another opening balance.");
  }

  const catalog=[...state.catalog];
  for(const row of input.items){if(!catalog.some(product=>product.code.trim().toUpperCase()===row.materialCode.trim().toUpperCase()))catalog.push({id:`catalog-${stableItemId(row.materialCode)}`,code:row.materialCode,description:row.description,defaultMode:row.unit==="Bags"?"bags":"bulk",active:true});}
  let next = {...state,catalog};
  for (const source of input.orders) next = (await applySourceImport(client, next, source, nowIso)).state;

  const importId = `inventory-import-${randomUUID()}`;
  const packingUnit = input.packingBinTotal === null ? null : quantityToScaled("MT", input.packingBinTotal, "packing bin total");
  await client.query(
    `INSERT INTO inventory_imports(id, workspace_id, file_name, digest, semantic_digest, as_of_date,
       included_baseline, packing_bin_total_scaled, imported_at)
     VALUES ($1, 1, $2, $3, $4, $5::date, $6, $7, $8::timestamptz)`,
    [importId, input.fileName, input.digest, semanticDigest, input.asOfDate, input.includeBaseline, packingUnit, nowIso],
  );

  for (const row of input.items) {
    const item = await upsertWorkbookItem(client, next, row, nowIso, input.includeBaseline);
    if (!input.includeBaseline && !input.reconcileStock) continue;
    const values = {
      opening: quantityToScaled(row.unit, row.opening, `${row.materialCode} opening`),
      production: quantityToScaled(row.unit, row.production, `${row.materialCode} production`),
      received: quantityToScaled(row.unit, row.received, `${row.materialCode} received`),
      salesReturn: quantityToScaled(row.unit, row.salesReturn, `${row.materialCode} sales return`),
      rework: quantityToScaled(row.unit, row.rework, `${row.materialCode} rework`),
      issue: quantityToScaled(row.unit, row.issue, `${row.materialCode} issue`),
      closing: quantityToScaled(row.unit, row.closing, `${row.materialCode} closing`),
    };
    const calculated = baselineBalances(values.opening, values.production, values.received, values.salesReturn, values.rework, values.issue);
    if (calculated !== values.closing) {
      throw new ApiError(400, "BASELINE_DOES_NOT_BALANCE", `${row.materialCode} does not balance: opening + production + received + return - rework - issue must equal closing.`);
    }
    const medication = normalizeBucketText(row.medication); const fmrOmed = normalizeBucketText(row.fmrOmed);
    await client.query(
      `INSERT INTO inventory_baseline_reports(import_id, item_id, medication, fmr_omed, opening_scaled,
         production_scaled, received_scaled, sales_return_scaled, rework_scaled, issue_scaled, closing_scaled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [importId, item.id, medication, fmrOmed, values.opening, values.production, values.received, values.salesReturn, values.rework, values.issue, values.closing],
    );
    if(input.reconcileStock && !input.includeBaseline){
      const balance=await client.query<{total:string}>("SELECT COALESCE(sum(quantity_delta_scaled),0)::text total FROM inventory_ledger WHERE item_id=$1 AND medication=$2 AND fmr_omed=$3 AND occurred_on<=$4::date",[item.id,medication,fmrOmed,input.asOfDate]);
      const delta=values.closing-numeric(balance.rows[0].total);
      if(delta){
        await assertNonnegativeAfter(client,item.id,medication,fmrOmed,delta);
        await insertMovement(client,{itemId:item.id,medication,fmrOmed,movementType:"adjustment",quantityDeltaScaled:delta,occurredOn:input.asOfDate,recordedAt:nowIso,postingKey:`count:${semanticDigest}:${item.id}`,importId,note:`Confirmed physical count from ${input.fileName}: ${row.closing} ${row.unit}.`,metadata:{physicalCount:true}});
      }
    } else if (values.closing > 0) {
      await insertMovement(client, {
        itemId: item.id, medication, fmrOmed, movementType: "baseline", quantityDeltaScaled: values.closing,
        occurredOn: input.asOfDate, recordedAt: nowIso,
        postingKey: `baseline:${input.asOfDate}:${item.id}:${createHash("sha256").update(bucketIdentity(medication, fmrOmed)).digest("hex").slice(0,16)}`,
        importId, note: `Physical closing balance from ${input.fileName}.`, metadata: { reported: values },
      });
    }
  }

  const annotations = new Map(input.annotations.map(row => [sourceBusinessKey(row.doNo, row.materialCode), row]));
  for (const source of input.orders) await syncInventoryOrders(client, next, source, nowIso, annotations, input.includeBaseline);
  await recalculateReservations(client, nowIso);
  return appendEvent(next, nowIso, input.includeBaseline ? "inventory.baseline.imported" : "inventory.workbook.imported",
    `${input.includeBaseline ? "Seeded" : "Imported"} inventory data from ${input.fileName}.`);
}

export async function syncInventoryOrders(
  client: pg.PoolClient,
  state: AppState,
  input: SourceImportInput,
  nowIso: string,
  annotations = new Map<string, { remark: string; medication: string; fmrOmed: string }>(),
  applyBaselineAnnotations = false,
): Promise<void> {
  if (!input.rows.length) return;
  const keys = input.rows.map(row => ({ do_no: row.doNo, material_code: row.materialCode }));
  const persisted = await client.query<{ id: string; fields: SourceOrderFields }>(
    `SELECT o.id, v.fields FROM source_orders o
       JOIN source_order_versions v ON v.source_order_id = o.id AND v.version = o.latest_version
       JOIN jsonb_to_recordset($1::jsonb) k(do_no text, material_code text)
         ON lower(btrim(o.do_no)) = lower(btrim(k.do_no)) AND lower(btrim(o.material_code)) = lower(btrim(k.material_code))
      WHERE o.workspace_id = 1`,
    [JSON.stringify(keys)],
  );
  for (const source of persisted.rows) {
    const fields = source.fields;
    const item = await ensureItem(client, state, fields.materialCode, fields.description, fields.unit, nowIso);
    const annotation = annotations.get(sourceBusinessKey(fields.doNo, fields.materialCode));
    const medication = normalizeBucketText(annotation?.medication ?? fields.medication);
    const fmrOmed = normalizeBucketText(annotation?.fmrOmed ?? fields.fmrOmed);
    const rawStatus = historicalStatus(fields.goodsMovementStatus, annotation?.remark ?? fields.remark);
    // Only the opening workbook can establish a historical state without physical postings.
    const status = applyBaselineAnnotations ? rawStatus : "pending";
    const updateAnnotatedBucket = applyBaselineAnnotations && annotation !== undefined;
    const ordered = quantityToScaled(fields.unit, fields.quantity, `${fields.doNo} ordered quantity`);
    await client.query(
      `INSERT INTO inventory_orders(source_order_id, workspace_id, item_id, due_date, ordered_quantity_scaled,
         medication, fmr_omed, historical_status, needs_review, created_at, updated_at)
       VALUES ($1,1,$2,$3::date,$4,$5,$6,$7,$8,$9::timestamptz,$9::timestamptz)
       ON CONFLICT (source_order_id) DO UPDATE SET
         item_id = EXCLUDED.item_id,
         due_date = CASE WHEN inventory_orders.manual_due_date THEN inventory_orders.due_date ELSE EXCLUDED.due_date END,
         ordered_quantity_scaled = EXCLUDED.ordered_quantity_scaled,
         medication = CASE WHEN $10 AND NOT inventory_orders.manual_medication THEN EXCLUDED.medication ELSE inventory_orders.medication END,
         fmr_omed = CASE WHEN $10 AND NOT inventory_orders.manual_fmr_omed THEN EXCLUDED.fmr_omed ELSE inventory_orders.fmr_omed END,
         historical_status = CASE WHEN $10 THEN EXCLUDED.historical_status ELSE inventory_orders.historical_status END,
         needs_review = inventory_orders.needs_review OR EXCLUDED.needs_review,
         updated_at = EXCLUDED.updated_at`,
      [source.id, item.id, fields.deliveryDate, ordered, medication, fmrOmed, status, item.needs_review || (!applyBaselineAnnotations && rawStatus !== "pending"), nowIso, updateAnnotatedBucket],
    );
    await synchronizeDeliveryStatus(client, source.id, nowIso);
  }
  await recalculateReservations(client, nowIso);
}

export async function executeInventoryCommand(
  client: pg.PoolClient,
  state: AppState,
  command: InventoryCommand,
  nowIso: string,
): Promise<AppState> {
  switch (command.type) {
    case "inventory.importBaseline": return applyInventoryWorkbook(client, state, command.input, nowIso, true);
    case "inventory.importWorkbook": return applyInventoryWorkbook(client, state, command.input, nowIso, false);
    case "inventory.configure": {
      const current = await requireItem(client, command.itemId, true);
      const bagWeight = command.patch.bagWeightKg === undefined ? current.bag_weight_kg : command.patch.bagWeightKg;
      if (current.unit === "Bags" && bagWeight === null) throw new ApiError(400, "BAG_WEIGHT_REQUIRED", "Bag items require a 25 kg or 50 kg bag weight before automatic planning.");
      if (current.unit === "MT" && bagWeight !== null) throw new ApiError(400, "BAG_WEIGHT_NOT_APPLICABLE", "Bulk items cannot have a bag weight.");
      const target = command.patch.targetQuantity === undefined ? current.target_quantity_scaled :
        command.patch.targetQuantity === null || command.patch.targetQuantity === 0 ? null : String(quantityToScaled(current.unit, command.patch.targetQuantity, "target quantity"));
      let extraType = current.extra_type; let extraValue = current.extra_value_scaled;
      if (command.patch.defaultExtra !== undefined) {
        extraType = command.patch.defaultExtra?.type ?? null;
        extraValue = command.patch.defaultExtra === null ? null : command.patch.defaultExtra.type === "fixed"
          ? String(quantityToScaled(current.unit, command.patch.defaultExtra.quantity, "fixed extra quantity"))
          : String(Math.round(command.patch.defaultExtra.percent * 1_000));
      }
      await client.query(
        `UPDATE inventory_items SET bag_weight_kg=$2, strategy=$3, target_quantity_scaled=$4,
           extra_type=$5, extra_value_scaled=$6, needs_review=$7, updated_at=$8::timestamptz WHERE workspace_id=1 AND id=$1`,
        [command.itemId, bagWeight, command.patch.strategy === undefined ? current.strategy : command.patch.strategy,
          target, extraType, extraValue, command.patch.needsReview ?? current.needs_review, nowIso],
      );
      return appendEvent(state, nowIso, "inventory.item.configured", `Updated inventory settings for ${current.material_code}.`);
    }
    case "inventory.adjust": {
      if (await replayPosting(client, command.postingKey, command)) return state;
      const item = await requireItem(client, command.itemId, true);
      const delta = signedQuantityToScaled(item.unit, command.quantityDelta, "adjustment quantity");
      if(command.countedQuantity!==undefined){const counted=quantityToScaled(item.unit,command.countedQuantity,"physical count");const balance=await client.query<{total:string}>("SELECT COALESCE(sum(quantity_delta_scaled),0)::text total FROM inventory_ledger WHERE item_id=$1 AND medication=$2 AND fmr_omed=$3 AND occurred_on<=$4::date",[item.id,command.medication,command.fmrOmed,command.occurredOn??malaysiaDateAt(nowIso)]);if(counted-numeric(balance.rows[0].total)!==delta)throw new ApiError(409,"COUNT_BALANCE_CHANGED","The ledger changed after this physical count preview. Refresh and review the difference.");}
      await assertNonnegativeAfter(client, item.id, command.medication, command.fmrOmed, delta);
      await insertMovement(client, { itemId: item.id, medication: command.medication, fmrOmed: command.fmrOmed,
        movementType: "adjustment", quantityDeltaScaled: delta, occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso),
        recordedAt: nowIso, postingKey: command.postingKey, note: command.reason, metadata: { commandFingerprint: hashCanonical(command), ...(command.countedQuantity===undefined?{}:{physicalCount:true,countedQuantity:command.countedQuantity}) } });
      await recalculateReservations(client, nowIso);
      return appendEvent(state, nowIso, "inventory.adjusted", `Adjusted ${item.material_code}: ${command.reason}`);
    }
    case "inventory.receive": {
      if (await replayPosting(client, command.postingKey, command)) return state;
      const item = await requireItem(client, command.itemId, true);
      const movementType = command.movementType ?? "received";
      const magnitude = quantityToScaled(item.unit, command.quantity);
      const delta = movementType === "rework" ? -magnitude : magnitude;
      if (delta < 0) await assertNonnegativeAfter(client, item.id, command.medication, command.fmrOmed, delta);
      await insertMovement(client, { itemId: item.id, medication: command.medication, fmrOmed: command.fmrOmed,
        movementType, quantityDeltaScaled: delta, occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso),
        recordedAt: nowIso, postingKey: command.postingKey, note: command.note ?? null, metadata: { commandFingerprint: hashCanonical(command) } });
      await recalculateReservations(client, nowIso);
      return appendEvent(state, nowIso, "inventory.received", `Recorded inventory receipt for ${item.material_code}.`);
    }
    case "production.recordReceipt": return recordProductionReceipt(client, state, command, nowIso);
    case "production.correct": return correctProduction(client, state, command, nowIso);
    case "delivery.record": return recordDelivery(client, state, command, nowIso);
    case "delivery.reverse": return reverseDelivery(client, state, command, nowIso);
    case "data.updateManualFields": return updateManualFields(client, state, command, nowIso);
    case "planning.commitDraft": return commitDraft(client, state, command.previewRevision, command.jobs, nowIso);
  }
}

async function recordProductionReceipt(client: pg.PoolClient, state: AppState, command: Extract<InventoryCommand, { type: "production.recordReceipt" }>, nowIso: string): Promise<AppState> {
  const job = state.jobs.find(candidate => candidate.id === command.jobId);
  if (!job) throw new ApiError(400, "JOB_NOT_FOUND", "The production job no longer exists.");
  if (!job.inventoryItemId) throw new ApiError(400, "JOB_INVENTORY_ITEM_REQUIRED", "Link the job to an inventory item before recording production.");
  const item = await requireItem(client, job.inventoryItemId, true);
  const total = quantityToScaled(item.unit, command.totalActualQuantity, "total actual quantity");
  const posted = await jobProductionTotal(client, job.id);
  if (total < posted) throw new ApiError(409, "PRODUCTION_TOTAL_DECREASED", "Use production.correct to reduce an already posted receipt.");
  const delta = total - posted;
  if (delta === 0) return state;
  await insertMovement(client, { itemId: item.id, medication: job.medication ?? "", fmrOmed: job.fmrOmed ?? "", movementType: "production",
    quantityDeltaScaled: delta, occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso), recordedAt: nowIso,
    postingKey: `production-${randomUUID()}`, sourceOrderId: job.sourceOrderId ?? null, jobId: job.id,
    note: `Production receipt total ${scaledToQuantity(item.unit, total)} ${item.unit}.` });
  await recalculateReservations(client, nowIso);
  const actualQuantityMt=item.unit==="Bags"?scaledToQuantity(item.unit,total)*(job.bagWeightKgSnapshot??item.bag_weight_kg??50)/1000:scaledToQuantity(item.unit,total);
  const next={...state,jobs:state.jobs.map(row=>row.id===job.id&&row.status==="completed"?{...row,actualQuantityMt,updatedAt:nowIso}:row)};
  return appendEvent(next, nowIso, "production.received", `Received production for ${job.orderNo}.`, job.id);
}

async function correctProduction(client: pg.PoolClient, state: AppState, command: Extract<InventoryCommand, { type: "production.correct" }>, nowIso: string): Promise<AppState> {
  if (await replayPosting(client, command.postingKey, command)) return state;
  const original = await movementById(client, command.movementId, true);
  if (original.movement_type !== "production") throw new ApiError(400, "PRODUCTION_MOVEMENT_REQUIRED", "Only a production receipt can be corrected here.");
  const item = await requireItem(client, original.item_id, true);
  const corrected = quantityToScaled(item.unit, command.correctedTotalQuantity, "corrected total quantity");
  if (!original.job_id) throw new ApiError(400, "PRODUCTION_JOB_REQUIRED", "The receipt must refer to a production card.");
  const delta = corrected - await jobProductionTotal(client, original.job_id);
  if (delta === 0) return state;
  if (delta < 0) await assertNonnegativeAfter(client, item.id, original.medication, original.fmr_omed, delta);
  await insertMovement(client, { itemId: item.id, medication: original.medication, fmrOmed: original.fmr_omed,
    movementType: delta < 0 ? "reversal" : "production", quantityDeltaScaled: delta,
    occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso), recordedAt: nowIso, postingKey: command.postingKey,
    sourceOrderId: original.source_order_id, jobId: original.job_id, reversesMovementId: original.id,
    note: command.reason, metadata: { commandFingerprint: hashCanonical(command) } });
  await recalculateReservations(client, nowIso);
  const job=state.jobs.find(row=>row.id===original.job_id);
  const actualQuantityMt=item.unit==="Bags"?scaledToQuantity(item.unit,corrected)*(job?.bagWeightKgSnapshot??item.bag_weight_kg??50)/1000:scaledToQuantity(item.unit,corrected);
  return appendEvent({...state,jobs:state.jobs.map(row=>row.id===original.job_id&&row.status==="completed"?{...row,actualQuantityMt,updatedAt:nowIso}:row)}, nowIso, "production.corrected", `Corrected a production receipt: ${command.reason}`, original.job_id);
}

async function recordDelivery(client: pg.PoolClient, state: AppState, command: Extract<InventoryCommand, { type: "delivery.record" }>, nowIso: string): Promise<AppState> {
  if (await replayPosting(client, command.postingKey, command)) return state;
  await recalculateReservations(client, nowIso);
  const order = await orderById(client, command.sourceOrderId, true);
  if (order.historical_status === "out") throw new ApiError(400, "ORDER_HISTORICALLY_OUT", "This order was already fully delivered before inventory tracking began.");
  const quantity = quantityToScaled(order.unit, command.quantity, "delivery quantity");
  const delivered = await orderDeliveredTotal(client, order.source_order_id);
  if (delivered + quantity > numeric(order.ordered_quantity_scaled)) throw new ApiError(400, "DELIVERY_EXCEEDS_ORDER", "Delivery cannot exceed the order's remaining quantity.");
  const reservation = await client.query<{ quantity_scaled: string }>("SELECT quantity_scaled FROM inventory_reservations WHERE source_order_id=$1 FOR UPDATE", [order.source_order_id]);
  if (numeric(reservation.rows[0]?.quantity_scaled ?? "0") < quantity) throw new ApiError(409, "DELIVERY_NOT_RESERVED", "Not enough stock is reserved for this order.");
  await assertNonnegativeAfter(client, order.item_id, order.medication, order.fmr_omed, -quantity);
  const movement = await insertMovement(client, { itemId: order.item_id, medication: order.medication, fmrOmed: order.fmr_omed,
    movementType: "dispatch", quantityDeltaScaled: -quantity, occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso), recordedAt: nowIso,
    postingKey: command.postingKey, sourceOrderId: order.source_order_id, note: `Delivery for ${order.do_no}.`, metadata: { commandFingerprint: hashCanonical(command) } });
  await synchronizeDeliveryStatus(client, order.source_order_id, nowIso);
  await recalculateReservations(client, nowIso);
  return appendEvent(state, nowIso, "delivery.recorded", `Recorded delivery for ${order.do_no} (${movement.id}).`);
}

async function reverseDelivery(client: pg.PoolClient, state: AppState, command: Extract<InventoryCommand, { type: "delivery.reverse" }>, nowIso: string): Promise<AppState> {
  if (await replayPosting(client, command.postingKey, command)) return state;
  const original = await movementById(client, command.movementId, true);
  if (original.movement_type !== "dispatch") throw new ApiError(400, "DELIVERY_MOVEMENT_REQUIRED", "Only a delivery movement can be reversed here.");
  const item = await requireItem(client, original.item_id, true);
  const quantity = quantityToScaled(item.unit, command.quantity, "reversal quantity");
  const reversed = await reversedTotal(client, original.id);
  if (quantity > -numeric(original.quantity_delta_scaled) - reversed) throw new ApiError(400, "REVERSAL_EXCEEDS_DELIVERY", "Reversal cannot exceed the remaining delivered quantity.");
  await insertMovement(client, { itemId: original.item_id, medication: original.medication, fmrOmed: original.fmr_omed,
    movementType: "reversal", quantityDeltaScaled: quantity, occurredOn: command.occurredOn ?? malaysiaDateAt(nowIso), recordedAt: nowIso,
    postingKey: command.postingKey, sourceOrderId: original.source_order_id, reversesMovementId: original.id, note: command.reason, metadata: { commandFingerprint: hashCanonical(command) } });
  await synchronizeDeliveryStatus(client, original.source_order_id, nowIso);
  await recalculateReservations(client, nowIso);
  return appendEvent(state, nowIso, "delivery.reversed", `Reversed a delivery: ${command.reason}`);
}

async function updateManualFields(client: pg.PoolClient, state: AppState, command: Extract<InventoryCommand, { type: "data.updateManualFields" }>, nowIso: string): Promise<AppState> {
  const order = await orderById(client, command.sourceOrderId, true);
  if (command.patch.medication !== undefined || command.patch.fmrOmed !== undefined) {
    const postings = await client.query("SELECT 1 FROM inventory_ledger WHERE source_order_id=$1 LIMIT 1", [command.sourceOrderId]);
    if (postings.rowCount) throw new ApiError(409, "ORDER_BUCKET_ALREADY_POSTED", "Medication/FMR cannot change after physical movements have been posted for the order.");
  }
  await client.query(
    `UPDATE inventory_orders SET
       medication=COALESCE($2,medication), fmr_omed=COALESCE($3,fmr_omed), due_date=COALESCE($4::date,due_date),
       manual_medication=manual_medication OR $2 IS NOT NULL, manual_fmr_omed=manual_fmr_omed OR $3 IS NOT NULL,
       manual_due_date=manual_due_date OR $4 IS NOT NULL, needs_review=false, updated_at=$5::timestamptz
     WHERE source_order_id=$1`,
    [command.sourceOrderId, command.patch.medication ?? null, command.patch.fmrOmed ?? null, command.patch.dueDate ?? null, nowIso],
  );
  await recalculateReservations(client, nowIso);
  return appendEvent(state, nowIso, "data.manual-fields.updated", `Updated manual order fields for ${order.do_no}.`);
}

async function commitDraft(client: pg.PoolClient, state: AppState, previewRevision: number, rows: InventoryDraftJob[], nowIso: string): Promise<AppState> {
  // WorkspaceStore has already locked and verified expectedRevision. This second token rejects stale preview UI state.
  if (!Number.isSafeInteger(previewRevision) || previewRevision < 0) throw new ApiError(400, "INVALID_DRAFT_REVISION", "Draft revision is invalid.");
  let next = state;
  const createdIds: string[] = [];
  const oldSchedules = new Map(getScheduledJobs(state).map(job=>[job.id,job]));
  for (let row of rows) {
    const item=await requireItem(client,row.itemId,true);
    if(item.material_code.trim().toUpperCase()!==row.materialCode.trim().toUpperCase()||item.unit!==row.unit||item.bag_weight_kg!==row.bagWeightKg)throw new ApiError(409,"DRAFT_ITEM_CHANGED","The product or bag weight changed. Refresh the draft.");
    if(row.sourceOrderId){
      const order=await orderById(client,row.sourceOrderId,true);
      if(order.item_id!==item.id||bucketIdentity(order.medication,order.fmr_omed)!==bucketIdentity(row.medication,row.fmrOmed)||order.historical_status!=="pending")throw new ApiError(409,"DRAFT_ORDER_CHANGED","The order product, variant or production status changed. Refresh the draft.");
      const delivered=await orderDeliveredTotal(client,order.source_order_id);
      if(delivered>=numeric(order.ordered_quantity_scaled))throw new ApiError(409,"ORDER_ALREADY_DELIVERED","This order has already been collected.");
    }
    if(row.date<malaysiaDateAt(nowIso))throw new ApiError(409,"DRAFT_DATE_PASSED","Draft production cannot be scheduled on a past date.");
    row={...row,notBefore:new Date(Math.max(Date.parse(row.notBefore),Date.parse(scheduleFloor(row.date,nowIso)))).toISOString()};
    const quantityMt = row.unit === "Bags" ? row.quantity * (row.bagWeightKg ?? 0) / 1_000 : row.quantity;
    if (row.unit === "Bags" && !row.bagWeightKg) throw new ApiError(400, "BAG_WEIGHT_REQUIRED", `Bag weight is required for ${row.materialCode}.`);
    next = createJob(next, {
      date: row.date, lineId: row.lineId, orderNo: row.orderNo, productCode: row.materialCode,
      description: row.description, bin: row.bin, mode: row.unit === "Bags" ? "bags" : "bulk",
      bagCount: row.unit === "Bags" ? row.quantity : null, quantityMt, remarks: row.remarks,
      inventoryItemId: row.itemId, medication: row.medication, fmrOmed: row.fmrOmed,
      productionPurpose: row.productionPurpose, ...(row.bagWeightKg ? { bagWeightKgSnapshot: row.bagWeightKg } : {}), notBefore: row.notBefore,
    });
    const created = next.jobs.at(-1);
    if (created) createdIds.push(created.id);
    if (created && row.sourceOrderId) {
      const sourceOrderId = row.sourceOrderId;
      const source = await client.query<{ latest_version:number; fields:SourceOrderFields }>(`SELECT o.latest_version,v.fields FROM source_orders o
        JOIN source_order_versions v ON v.source_order_id=o.id AND v.version=o.latest_version WHERE o.workspace_id=1 AND o.id=$1`,[sourceOrderId]);
      if(!source.rowCount)throw new ApiError(400,"SOURCE_NOT_FOUND","The source order no longer exists.");
      const fields=source.rows[0].fields;
      next = { ...next, jobs: next.jobs.map(job => job.id === created.id ? { ...job, sourceOrderId,
        sourceOrderVersion:source.rows[0].latest_version,sourceSnapshot:{doNo:fields.doNo,materialCode:fields.materialCode,description:fields.description,quantity:fields.quantity,unit:fields.unit},
        createdAt: nowIso, updatedAt: nowIso } : job) };
    }
  }
  const schedules = new Map(getScheduledJobs(next).map(job => [job.id, job]));
  for(const [id,old] of oldSchedules){const current=schedules.get(id);if(current?.plannedStart!==old.plannedStart||current?.plannedEnd!==old.plannedEnd)throw new ApiError(409,"DRAFT_EXISTING_PLAN_CHANGED","The draft would change an existing card. Append it after the existing plan.");}
  for (const id of createdIds) {
    const scheduled = schedules.get(id);
    if (!scheduled || scheduled.plannedStart === null || scheduled.overflow) {
      throw new ApiError(409, "DRAFT_CAPACITY_CHANGED", "An edited draft job no longer fits the selected line and day. Adjust the draft and try again.");
    }
  }
  return appendEvent(next, nowIso, "planning.draft.committed", `Committed ${rows.length} inventory draft job${rows.length === 1 ? "" : "s"}.`);
}

export async function getInventorySnapshot(pool: pg.Pool): Promise<InventorySnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = await workspaceRevision(client);
    const countDates = await client.query<{ baseline_date: string | null; last_count_date: string | null }>(
      `SELECT min(as_of_date) FILTER (WHERE included_baseline)::text AS baseline_date,GREATEST(max(as_of_date),(SELECT max(occurred_on) FROM inventory_ledger WHERE metadata->>'physicalCount'='true'))::text AS last_count_date
         FROM inventory_imports WHERE workspace_id=1 AND (included_baseline OR id IN (SELECT import_id FROM inventory_baseline_reports))`,
    );
    const items = await allItems(client);
    const balances = await physicalBalances(client);
    const reservations = await reservationBalances(client);
    const result: InventoryItemSnapshot[] = items.map(item => {
      const keys = new Set([...balances.filter(row => row.item_id === item.id).map(row => bucketIdentity(row.medication, row.fmr_omed)), ...reservations.filter(row => row.item_id === item.id).map(row => bucketIdentity(row.medication, row.fmr_omed))]);
      const buckets: InventoryBucketSnapshot[] = [...keys].map(key => {
        const physical = balances.find(row => row.item_id === item.id && bucketIdentity(row.medication, row.fmr_omed) === key);
        const reserved = reservations.find(row => row.item_id === item.id && bucketIdentity(row.medication, row.fmr_omed) === key);
        const onHandScaled = numeric(physical?.quantity_scaled ?? "0"); const reservedScaled = numeric(reserved?.quantity_scaled ?? "0");
        const [medication, fmrOmed] = key.split("\u0000");
        return { medication, fmrOmed, onHand: scaledToQuantity(item.unit, onHandScaled), reserved: scaledToQuantity(item.unit, reservedScaled), available: scaledToQuantity(item.unit, onHandScaled - reservedScaled) };
      }).sort((a, b) => `${a.medication}\0${a.fmrOmed}`.localeCompare(`${b.medication}\0${b.fmrOmed}`));
      return { ...itemView(item), buckets, totalOnHand: sum(buckets.map(row => row.onHand)), totalReserved: sum(buckets.map(row => row.reserved)), totalAvailable: sum(buckets.map(row => row.available)) };
    });
    await client.query("COMMIT");
    return { revision, asOfDate: malaysiaDateAt(new Date().toISOString()), baselineDate: countDates.rows[0]?.baseline_date ?? null,
      lastCountDate: countDates.rows[0]?.last_count_date ?? null, items: result };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function getOrderProgress(pool: pg.Pool, state: AppState): Promise<InventoryOrderProgressSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const revision = await workspaceRevision(client); const rows = await allOrders(client);
    const persistedJobs=await client.query<{payload:Job}>("SELECT payload FROM jobs WHERE workspace_id=1 ORDER BY ordinal");
    state={...state,jobs:persistedJobs.rows.map(row=>row.payload)};
    const reservations = await client.query<{ source_order_id: string; quantity_scaled: string }>("SELECT source_order_id, quantity_scaled FROM inventory_reservations");
    const movementTotals = await movementTotalsByOrder(client);
    const items = new Map((await allItems(client)).map(row => [row.id, row]));
    const orders: InventoryOrderProgress[] = [];
    for (const row of rows) {
      const item = items.get(row.item_id)!; const ordered = numeric(row.ordered_quantity_scaled);
      const delivered = row.historical_status === "out" ? ordered : movementTotals.get(row.source_order_id)?.delivered ?? 0;
      const produced = row.historical_status === "done" ? ordered : movementTotals.get(row.source_order_id)?.produced ?? 0;
      const reserved = numeric(reservations.rows.find(value => value.source_order_id === row.source_order_id)?.quantity_scaled ?? "0");
      const scheduled = (await Promise.all(state.jobs.filter(job => job.sourceOrderId === row.source_order_id && (job.status === "pending" || job.status === "running")).map(async job => Math.max(0, jobScaled(job, item.unit) - await jobProductionTotal(client, job.id))))).reduce((a,b)=>a+b,0);
      const need = row.historical_status === "done" ? 0 : orderNeedScaled(ordered, delivered, reserved);
      orders.push({ sourceOrderId: row.source_order_id, itemId: row.item_id, doNo: row.do_no, materialCode: row.material_code,
        description: row.description, dueDate: dbDate(row.due_date), unit: row.unit, medication: row.medication, fmrOmed: row.fmr_omed,
        ordered: scaledToQuantity(row.unit, ordered), produced: scaledToQuantity(row.unit, produced), delivered: scaledToQuantity(row.unit, delivered),
        reserved: scaledToQuantity(row.unit, reserved), orderNeed: scaledToQuantity(row.unit, need), scheduledUnreceived: scaledToQuantity(row.unit, Math.max(0, scheduled)),
        netToPlan: scaledToQuantity(row.unit, Math.max(0, need - Math.max(0, scheduled))), historicalStatus: row.historical_status, needsReview: row.needs_review || (row.historical_status === "done" && reserved < Math.max(0, ordered-delivered)) });
    }
    await client.query("COMMIT");
    return { revision, asOfDate: malaysiaDateAt(new Date().toISOString()), orders };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function buildPlanningDemand(client: pg.PoolClient, state: AppState, request: InventoryDraftRequest, nowIso: string): Promise<InventoryPlanningDemandRow[]> {
  const rows = await allOrders(client); const items = new Map((await allItems(client)).map(row => [row.id, row]));
  const balances = await physicalBalances(client); const reservationRows = await client.query<{ source_order_id: string; quantity_scaled: string }>("SELECT source_order_id, quantity_scaled FROM inventory_reservations");
  const postedRows = await client.query<{ job_id:string; total:string }>(`SELECT l.job_id,COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0)::text total
    FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.job_id IS NOT NULL GROUP BY l.job_id`);
  const postedByJob=new Map(postedRows.rows.map(row=>[row.job_id,numeric(row.total)]));
  const movementTotals=await movementTotalsByOrder(client);const deliveredByOrder=new Map<string,number>();for(const order of rows)deliveredByOrder.set(order.source_order_id,order.historical_status==="out"?numeric(order.ordered_quantity_scaled):movementTotals.get(order.source_order_id)?.delivered??0);
  const selected = request.sourceOrderIds ? new Set(request.sourceOrderIds) : null;
  const result: InventoryPlanningDemandRow[] = [];
  const details:Array<{order:OrderRow;item:ItemRow;core:number;scheduled:number}>=[],coreByItem=new Map<string,number>();
  for(const order of rows){
    if(order.historical_status!=="pending"||(selected?!selected.has(order.source_order_id):dbDate(order.due_date)>(request.demandThrough??request.toDate)))continue;
    const item=items.get(order.item_id)!;if(item.unit==="Bags"&&!item.bag_weight_kg)continue;
    const ordered=numeric(order.ordered_quantity_scaled),delivered=deliveredByOrder.get(order.source_order_id)??0;
    const reserved=numeric(reservationRows.rows.find(row=>row.source_order_id===order.source_order_id)?.quantity_scaled??"0");
    const core=orderNeedScaled(ordered,delivered,reserved);if(!core)continue;
    const scheduled=state.jobs.filter(job=>job.sourceOrderId===order.source_order_id&&(job.status==="pending"||job.status==="running")).reduce((total,job)=>total+Math.max(0,jobScaled(job,item.unit)-(postedByJob.get(job.id)??0)),0);
    const cohort=bucketKey(item.id,order.medication,order.fmr_omed);
    details.push({order,item,core,scheduled});coreByItem.set(cohort,(coreByItem.get(cohort)??0)+core);
  }
  const extraOwner=new Set<string>();
  for(const detail of details){
    const cohort=bucketKey(detail.item.id,detail.order.medication,detail.order.fmr_omed);
    const ownsExtra=!extraOwner.has(cohort);if(ownsExtra)extraOwner.add(cohort);
    const extra=ownsExtra?extraQuantityScaled(detail.item.unit,coreByItem.get(cohort)??0,itemExtra(detail.item)):0;
    const demand=Math.max(0,detail.core+extra-detail.scheduled);if(!demand)continue;
    const order=detail.order,item=detail.item;
    result.push({key:`order:${order.source_order_id}`,itemId:order.item_id,materialCode:order.material_code,description:order.description,
      unit:order.unit,bagWeightKg:item.bag_weight_kg,strategy:item.strategy??"mto",purpose:"mto",sourceOrderId:order.source_order_id,
      orderNo:order.do_no,dueDate:dbDate(order.due_date),notBefore:scheduleFloor(request.fromDate,nowIso),quantity:scaledToQuantity(order.unit,demand),medication:order.medication,fmrOmed:order.fmr_omed});
  }
  for(const item of items.values()){
    if(item.strategy!=="mts"||item.needs_review||!item.target_quantity_scaled||(item.unit==="Bags"&&!item.bag_weight_kg))continue;
    const physical=balances.filter(row=>row.item_id===item.id&&!row.medication&&!row.fmr_omed).reduce((total,row)=>total+numeric(row.quantity_scaled),0);
    const itemOrderIds=new Set(rows.filter(order=>order.item_id===item.id&&!order.medication&&!order.fmr_omed).map(order=>order.source_order_id));
    const reserved=reservationRows.rows.filter(row=>itemOrderIds.has(row.source_order_id)).reduce((total,row)=>total+numeric(row.quantity_scaled),0);
    const relevantOrders=new Set(details.filter(detail=>detail.item.id===item.id&&!detail.order.medication&&!detail.order.fmr_omed).map(detail=>detail.order.source_order_id));
    const scheduledAll=state.jobs.filter(job=>job.inventoryItemId===item.id&&!job.medication&&!job.fmrOmed&&(job.status==="pending"||job.status==="running")&&job.date<=request.toDate&&(!job.sourceOrderId||relevantOrders.has(job.sourceOrderId)))
      .reduce((total,job)=>total+Math.max(0,jobScaled(job,item.unit)-(postedByJob.get(job.id)??0)),0);
    const newMto=result.filter(row=>row.itemId===item.id&&!row.medication&&!row.fmrOmed&&row.purpose==="mto").reduce((total,row)=>total+quantityToScaled(item.unit,row.quantity),0);
    const projectedFree=Math.max(0,(physical-reserved)+scheduledAll+newMto-(coreByItem.get(bucketKey(item.id,"",""))??0));
    const need=Math.max(0,numeric(item.target_quantity_scaled)-projectedFree);if(!need)continue;
    result.push({key:`mts:${item.id}`,itemId:item.id,materialCode:item.material_code,description:item.description,unit:item.unit,bagWeightKg:item.bag_weight_kg,
      strategy:"mts",purpose:"mts",sourceOrderId:null,orderNo:null,dueDate:request.toDate,notBefore:scheduleFloor(request.fromDate,nowIso),quantity:scaledToQuantity(item.unit,need),medication:"",fmrOmed:""});
  }
  return result;
}

export async function listLedger(pool: pg.Pool, limit = 500, itemId?: string): Promise<InventoryLedgerEntry[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2_000) throw new ApiError(400, "INVALID_LIMIT", "limit must be between 1 and 2000.");
  const result = await pool.query<any>(
    `SELECT l.*, i.unit FROM inventory_ledger l JOIN inventory_items i ON i.id=l.item_id
      WHERE l.workspace_id=1 AND ($2::text IS NULL OR l.item_id=$2)
      ORDER BY l.occurred_on DESC,l.recorded_at DESC,l.id DESC LIMIT $1`, [limit, itemId ?? null]);
  return result.rows.map(row => ledgerView(row));
}

export async function listDailyStock(pool: pg.Pool, date?:string): Promise<InventoryDailyStockRow[]> {
  const result = await pool.query<any>(
    `WITH daily AS (
       SELECT occurred_on,item_id,medication,fmr_omed,
         sum(quantity_delta_scaled) delta,
         sum(quantity_delta_scaled) FILTER (WHERE movement_type='production') production,
         sum(quantity_delta_scaled) FILTER (WHERE movement_type='received') received,
         sum(quantity_delta_scaled) FILTER (WHERE movement_type='return') sales_return,
         -sum(quantity_delta_scaled) FILTER (WHERE movement_type='rework') rework,
         -sum(quantity_delta_scaled) FILTER (WHERE movement_type='dispatch') dispatch,
         sum(quantity_delta_scaled) FILTER (WHERE movement_type IN ('adjustment','reversal')) adjustment
       FROM inventory_ledger WHERE workspace_id=1 GROUP BY occurred_on,item_id,medication,fmr_omed
     ), buckets AS (SELECT id item_id,''::text medication,''::text fmr_omed FROM inventory_items UNION SELECT item_id,medication,fmr_omed FROM inventory_ledger),
     dates AS (SELECT $1::date occurred_on WHERE $1::date IS NOT NULL UNION SELECT DISTINCT occurred_on FROM daily WHERE $1::date IS NULL),
     reported AS (SELECT b.*,im.as_of_date FROM inventory_baseline_reports b JOIN inventory_imports im ON im.id=b.import_id WHERE im.included_baseline)
     SELECT dates.occurred_on,b.*,i.material_code,i.unit,
       COALESCE(r.opening_scaled,(SELECT COALESCE(sum(quantity_delta_scaled),0) FROM inventory_ledger l WHERE l.item_id=b.item_id AND l.medication=b.medication AND l.fmr_omed=b.fmr_omed AND l.occurred_on<dates.occurred_on)) opening,
       COALESCE(r.production_scaled,d.production,0) production,COALESCE(r.received_scaled,d.received,0) received,
       COALESCE(r.sales_return_scaled,d.sales_return,0) sales_return,COALESCE(r.rework_scaled,d.rework,0) rework,
       COALESCE(r.issue_scaled,d.dispatch,0) dispatch,COALESCE(d.adjustment,0) adjustment,
       (SELECT COALESCE(sum(quantity_delta_scaled),0) FROM inventory_ledger l WHERE l.item_id=b.item_id AND l.medication=b.medication AND l.fmr_omed=b.fmr_omed AND l.occurred_on<=dates.occurred_on) closing
     FROM dates CROSS JOIN buckets b JOIN inventory_items i ON i.id=b.item_id
     LEFT JOIN daily d ON d.occurred_on=dates.occurred_on AND d.item_id=b.item_id AND d.medication=b.medication AND d.fmr_omed=b.fmr_omed
     LEFT JOIN reported r ON r.as_of_date=dates.occurred_on AND r.item_id=b.item_id AND r.medication=b.medication AND r.fmr_omed=b.fmr_omed
     ORDER BY dates.occurred_on DESC,i.material_code,b.medication,b.fmr_omed`,[date??null]);
  return result.rows.map((row: any) => ({ date: dbDate(row.occurred_on), itemId: row.item_id, materialCode: row.material_code, unit: row.unit,
    medication: row.medication, fmrOmed: row.fmr_omed, opening: scaledToQuantity(row.unit, numeric(row.opening)),
    production: scaledToQuantity(row.unit, numeric(row.production ?? 0)), received: scaledToQuantity(row.unit, numeric(row.received ?? 0)),
    salesReturn: scaledToQuantity(row.unit, numeric(row.sales_return ?? 0)), rework: scaledToQuantity(row.unit, numeric(row.rework ?? 0)),
    dispatch: scaledToQuantity(row.unit, numeric(row.dispatch ?? 0)), adjustment: scaledToQuantity(row.unit, numeric(row.adjustment ?? 0)), closing: scaledToQuantity(row.unit, numeric(row.closing)) }));
}

export async function listOrderJournal(pool: pg.Pool, sourceOrderId?:string): Promise<InventoryOrderJournalRow[]> {
  const result = await pool.query<any>(
    `SELECT l.*,i.unit,o.do_no,i.material_code,original.movement_type original_type FROM inventory_ledger l JOIN inventory_items i ON i.id=l.item_id
       JOIN source_orders o ON o.id=l.source_order_id LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id
       WHERE l.workspace_id=1 AND l.source_order_id IS NOT NULL AND ($1::text IS NULL OR l.source_order_id=$1)
       ORDER BY l.occurred_on DESC,l.recorded_at DESC,l.id DESC LIMIT 2000`,[sourceOrderId??null]);
  const movements: InventoryOrderJournalRow[] = result.rows.map((row: any) => ({ sourceOrderId: row.source_order_id, doNo: row.do_no, materialCode: row.material_code,
    eventType: row.movement_type === "dispatch" ? "delivery" : row.movement_type === "reversal" ? row.original_type==="production"?"production-corrected":"delivery-reversed" : "production",
    quantity: scaledToQuantity(row.unit, row.movement_type==="reversal"&&row.original_type==="production"?numeric(row.quantity_delta_scaled):Math.abs(numeric(row.quantity_delta_scaled))), unit: row.unit, occurredOn: dbDate(row.occurred_on),
    referenceId: row.id, note: row.note }));
  const reservations = await pool.query<any>(`SELECT r.*,o.do_no,i.material_code,i.unit FROM inventory_reservations r
    JOIN source_orders o ON o.id=r.source_order_id JOIN inventory_items i ON i.id=r.item_id WHERE r.quantity_scaled>0`);
  return [...movements, ...reservations.rows.map((row: any): InventoryOrderJournalRow => ({ sourceOrderId: row.source_order_id,
    doNo: row.do_no, materialCode: row.material_code, eventType: "reserved", quantity: scaledToQuantity(row.unit, numeric(row.quantity_scaled)),
    unit: row.unit, occurredOn: new Date(row.updated_at).toISOString().slice(0,10), referenceId: `reservation:${row.source_order_id}`, note: null }))]
    .sort((a,b)=>b.occurredOn.localeCompare(a.occurredOn)||b.referenceId.localeCompare(a.referenceId));
}

export async function recalculateReservations(client: pg.PoolClient, nowIso: string): Promise<void> {
  const balances = await physicalBalances(client);
  const orders = await allOrders(client);
  const movementTotals = await movementTotalsByOrder(client);
  const available = new Map(balances.map(row => [bucketKey(row.item_id, row.medication, row.fmr_omed), Math.max(0, numeric(row.quantity_scaled))]));
  const allocations = new Map<string, number>();
  const sorted = [...orders].sort((a, b) => statusPriority(a.historical_status) - statusPriority(b.historical_status) || dbDate(a.due_date).localeCompare(dbDate(b.due_date)) || a.source_order_id.localeCompare(b.source_order_id));
  for (const order of sorted) {
    const ordered = numeric(order.ordered_quantity_scaled);
    const delivered = order.historical_status === "out" ? ordered : movementTotals.get(order.source_order_id)?.delivered ?? 0;
    const remaining = Math.max(0, ordered - delivered);
    const key = bucketKey(order.item_id, order.medication, order.fmr_omed);
    const reserved = Math.min(remaining, available.get(key) ?? 0);
    allocations.set(order.source_order_id, reserved);
    available.set(key, (available.get(key) ?? 0) - reserved);
  }
  await client.query("DELETE FROM inventory_reservations WHERE source_order_id NOT IN (SELECT source_order_id FROM inventory_orders)");
  for (let offset=0;offset<orders.length;offset+=1000) {
    const rows=orders.slice(offset,offset+1000).map(order=>({source_order_id:order.source_order_id,item_id:order.item_id,medication:order.medication,fmr_omed:order.fmr_omed,quantity_scaled:allocations.get(order.source_order_id)??0,updated_at:nowIso}));
    await client.query(`INSERT INTO inventory_reservations(source_order_id,item_id,medication,fmr_omed,quantity_scaled,updated_at)
      SELECT source_order_id,item_id,medication,fmr_omed,quantity_scaled,updated_at::timestamptz FROM jsonb_to_recordset($1::jsonb)
        x(source_order_id text,item_id text,medication text,fmr_omed text,quantity_scaled bigint,updated_at text)
      ON CONFLICT(source_order_id) DO UPDATE SET item_id=EXCLUDED.item_id,medication=EXCLUDED.medication,fmr_omed=EXCLUDED.fmr_omed,quantity_scaled=EXCLUDED.quantity_scaled,updated_at=EXCLUDED.updated_at`,[JSON.stringify(rows)]);
  }
}

async function upsertWorkbookItem(client: pg.PoolClient, state: AppState, row: InventoryWorkbookInput["items"][number], nowIso: string, configure: boolean): Promise<ItemRow> {
  const current = await findItemByMaterial(client, row.materialCode, true);
  if (current && current.unit !== row.unit) throw new ApiError(409, "INVENTORY_UNIT_CONFLICT", `${row.materialCode} is already configured as ${current.unit}.`);
  const catalogId = state.catalog.find(product => product.code.trim().toLocaleUpperCase("en-US") === row.materialCode.trim().toLocaleUpperCase("en-US"))?.id ?? current?.catalog_id ?? null;
  const id = current?.id ?? stableItemId(row.materialCode);
  if (!configure) {
    if (current) {
      await client.query("UPDATE inventory_items SET catalog_id=COALESCE($2,catalog_id),description=$3,updated_at=$4::timestamptz WHERE id=$1", [id,catalogId,row.description,nowIso]);
      return requireItem(client,id,false);
    }
    await client.query(`INSERT INTO inventory_items(id,workspace_id,catalog_id,material_code,description,unit,bag_weight_kg,strategy,target_quantity_scaled,needs_review,created_at,updated_at)
      VALUES($1,1,$2,$3,$4,$5,$6,NULL,NULL,true,$7::timestamptz,$7::timestamptz)`, [id,catalogId,row.materialCode.trim(),row.description,row.unit,row.bagWeightKg,nowIso]);
    return requireItem(client,id,false);
  }
  const target = row.targetQuantity === 0 ? null : quantityToScaled(row.unit, row.targetQuantity, `${row.materialCode} target quantity`);
  await client.query(
    `INSERT INTO inventory_items(id,workspace_id,catalog_id,material_code,description,unit,bag_weight_kg,strategy,target_quantity_scaled,needs_review,created_at,updated_at)
     VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$10::timestamptz)
     ON CONFLICT(id) DO UPDATE SET catalog_id=COALESCE(EXCLUDED.catalog_id,inventory_items.catalog_id),material_code=EXCLUDED.material_code,
       description=EXCLUDED.description,bag_weight_kg=EXCLUDED.bag_weight_kg,strategy=EXCLUDED.strategy,target_quantity_scaled=EXCLUDED.target_quantity_scaled,
       needs_review=EXCLUDED.needs_review,updated_at=EXCLUDED.updated_at`,
    [id, catalogId, row.materialCode.trim(), row.description, row.unit, row.bagWeightKg, row.strategy, target, row.needsReview, nowIso]);
  return requireItem(client, id, false);
}

async function ensureItem(client: pg.PoolClient, state: AppState, materialCode: string, description: string, unit: InventoryUnit, nowIso: string): Promise<ItemRow> {
  const existing = await findItemByMaterial(client, materialCode, true);
  if (existing) {
    if (existing.unit !== unit) throw new ApiError(409, "INVENTORY_UNIT_CONFLICT", `${materialCode} is already configured as ${existing.unit}.`);
    return existing;
  }
  const catalogId = state.catalog.find(product => product.code.trim().toLocaleUpperCase("en-US") === materialCode.trim().toLocaleUpperCase("en-US"))?.id ?? null;
  const id = stableItemId(materialCode);
  await client.query(`INSERT INTO inventory_items(id,workspace_id,catalog_id,material_code,description,unit,needs_review,created_at,updated_at)
    VALUES($1,1,$2,$3,$4,$5,true,$6::timestamptz,$6::timestamptz)`, [id, catalogId, materialCode.trim(), description, unit, nowIso]);
  return requireItem(client, id, false);
}

async function requireItem(client: pg.PoolClient, id: string, lock: boolean): Promise<ItemRow> {
  const result = await client.query<ItemRow>(`SELECT * FROM inventory_items WHERE workspace_id=1 AND id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  if (!result.rowCount) throw new ApiError(400, "INVENTORY_ITEM_NOT_FOUND", "Inventory item not found.");
  return result.rows[0];
}
export async function validateInventoryJobs(client:pg.PoolClient,state:AppState):Promise<void>{
  const items=new Map((await allItems(client)).map(item=>[item.id,item]));
  const orders=new Map((await allOrders(client)).map(order=>[order.source_order_id,order]));
  const jobs=new Map(state.jobs.map(job=>[job.id,job]));
  for(const job of state.jobs){
    if(!job.inventoryItemId)continue;
    const item=items.get(job.inventoryItemId),order=job.sourceOrderId?orders.get(job.sourceOrderId):undefined;
    if(!item||item.material_code.trim().toUpperCase()!==job.productCode.trim().toUpperCase()||(item.unit==="Bags")!==(job.mode==="bags"))throw new ApiError(409,"JOB_STOCK_IDENTITY_MISMATCH","A stock card must retain its linked product and packaging.");
    if(order&&(order.item_id!==item.id||bucketIdentity(order.medication,order.fmr_omed)!==bucketIdentity(job.medication??"",job.fmrOmed??"")))throw new ApiError(409,"JOB_ORDER_VARIANT_MISMATCH","The card must match its order's Medication and FMR/OMED.");
  }
  const posted=await client.query<{job_id:string;item_id:string;medication:string;fmr_omed:string;source_order_id:string|null}>("SELECT DISTINCT job_id,item_id,medication,fmr_omed,source_order_id FROM inventory_ledger WHERE job_id IS NOT NULL");
  for(const row of posted.rows){const job=jobs.get(row.job_id);if(!job||job.inventoryItemId!==row.item_id||(job.sourceOrderId??null)!==row.source_order_id||bucketIdentity(job.medication??"",job.fmrOmed??"")!==bucketIdentity(row.medication,row.fmr_omed))throw new ApiError(409,"POSTED_JOB_IMMUTABLE","Cards with inventory movements cannot be deleted or assigned another product, order or variant. Correct their original movements instead.");}
}
async function findItemByMaterial(client: pg.PoolClient, materialCode: string, lock: boolean): Promise<ItemRow | null> {
  const result = await client.query<ItemRow>(`SELECT * FROM inventory_items WHERE workspace_id=1 AND lower(btrim(material_code))=lower(btrim($1))${lock ? " FOR UPDATE" : ""}`, [materialCode]);
  return result.rows[0] ?? null;
}
async function allItems(client: pg.PoolClient): Promise<ItemRow[]> { return (await client.query<ItemRow>("SELECT * FROM inventory_items WHERE workspace_id=1 ORDER BY material_code")).rows; }
async function allOrders(client: pg.PoolClient): Promise<OrderRow[]> { return (await client.query<OrderRow>(`SELECT io.*,o.do_no,i.material_code,i.description,i.unit FROM inventory_orders io JOIN source_orders o ON o.id=io.source_order_id JOIN inventory_items i ON i.id=io.item_id WHERE io.workspace_id=1 ORDER BY io.due_date,o.do_no,i.material_code`)).rows; }
async function orderById(client: pg.PoolClient, id: string, lock: boolean): Promise<OrderRow> { const result = await client.query<OrderRow>(`SELECT io.*,o.do_no,i.material_code,i.description,i.unit FROM inventory_orders io JOIN source_orders o ON o.id=io.source_order_id JOIN inventory_items i ON i.id=io.item_id WHERE io.workspace_id=1 AND io.source_order_id=$1${lock ? " FOR UPDATE OF io" : ""}`, [id]); if (!result.rowCount) throw new ApiError(400,"INVENTORY_ORDER_NOT_FOUND","Inventory order not found."); return result.rows[0]; }

interface MovementInput { itemId:string; medication:string; fmrOmed:string; movementType:string; quantityDeltaScaled:number; occurredOn:string; recordedAt:string; postingKey:string; sourceOrderId?:string|null; jobId?:string|null; reversesMovementId?:string|null; importId?:string|null; note?:string|null; metadata?:unknown }
async function replayPosting(client:pg.PoolClient, postingKey:string, command:InventoryCommand):Promise<boolean>{
  const result=await client.query<{metadata:{commandFingerprint?:string}}>("SELECT metadata FROM inventory_ledger WHERE workspace_id=1 AND posting_key=$1 FOR UPDATE",[postingKey]);
  if(!result.rowCount)return false;
  if(result.rows[0].metadata.commandFingerprint!==hashCanonical(command))throw new ApiError(409,"POSTING_KEY_CONFLICT","This posting key was already used for different content.");
  return true;
}
async function synchronizeDeliveryStatus(client:pg.PoolClient,sourceOrderId:string,nowIso:string):Promise<void>{
  const order=await orderById(client,sourceOrderId,false);
  const delivered=order.historical_status==="out"||await orderDeliveredTotal(client,sourceOrderId)>=numeric(order.ordered_quantity_scaled);
  await client.query(`UPDATE source_orders SET delivery_status=$2,delivery_source=CASE WHEN $3 THEN COALESCE(delivery_source,'manual') ELSE NULL END,
    delivery_recorded_at=CASE WHEN $3 THEN COALESCE(delivery_recorded_at,$4::timestamptz) ELSE NULL END,updated_at=$4::timestamptz WHERE id=$1`,[sourceOrderId,delivered?"delivered":"pending",delivered,nowIso]);
}
async function insertMovement(client:pg.PoolClient,input:MovementInput):Promise<{id:string;existing:boolean}>{
  const medication=normalizeBucketText(input.medication),fmrOmed=normalizeBucketText(input.fmrOmed);
  const existing=await client.query<any>("SELECT * FROM inventory_ledger WHERE workspace_id=1 AND posting_key=$1 FOR UPDATE",[input.postingKey]);
  if(existing.rowCount){const row=existing.rows[0];if(row.item_id!==input.itemId||row.medication!==medication||row.fmr_omed!==fmrOmed||row.movement_type!==input.movementType||numeric(row.quantity_delta_scaled)!==input.quantityDeltaScaled||dbDate(row.occurred_on)!==input.occurredOn||row.source_order_id!==(input.sourceOrderId??null)||row.job_id!==(input.jobId??null)||row.reverses_movement_id!==(input.reversesMovementId??null)||row.import_id!==(input.importId??null))throw new ApiError(409,"POSTING_KEY_CONFLICT","This posting key was already used for a different movement.");return{id:row.id,existing:true};}
  const id=`movement-${randomUUID()}`;
  const item=await requireItem(client,input.itemId,false);
  const boundary=await client.query<{date:string|null}>("SELECT min(as_of_date)::text date FROM inventory_imports WHERE included_baseline");
  if(input.movementType!=="baseline"&&boundary.rows[0].date&&input.occurredOn<boundary.rows[0].date)throw new ApiError(400,"MOVEMENT_BEFORE_BASELINE","Record movements on or after the stock baseline date. Earlier history is already included in Closing.");
  const job=input.jobId?await client.query<{payload:Job}>("SELECT payload FROM jobs WHERE id=$1",[input.jobId]):null;
  const snapshot={materialCode:item.material_code,description:item.description,unit:item.unit,bagWeightKg:job?.rows[0]?.payload.bagWeightKgSnapshot??item.bag_weight_kg};
  const metadata={...(input.metadata as Record<string,unknown>??{}),snapshot};
  await client.query(`INSERT INTO inventory_ledger(id,workspace_id,item_id,medication,fmr_omed,movement_type,quantity_delta_scaled,occurred_on,recorded_at,posting_key,source_order_id,job_id,reverses_movement_id,import_id,note,metadata)
    VALUES($1,1,$2,$3,$4,$5,$6,$7::date,$8::timestamptz,$9,$10,$11,$12,$13,$14,$15::jsonb)`,[id,input.itemId,medication,fmrOmed,input.movementType,input.quantityDeltaScaled,input.occurredOn,input.recordedAt,input.postingKey,input.sourceOrderId??null,input.jobId??null,input.reversesMovementId??null,input.importId??null,input.note??null,JSON.stringify(metadata)]);
  const invalid=await client.query(`WITH daily AS(SELECT occurred_on,sum(quantity_delta_scaled) delta FROM inventory_ledger WHERE item_id=$1 AND medication=$2 AND fmr_omed=$3 GROUP BY occurred_on),running AS(SELECT sum(delta) OVER(ORDER BY occurred_on) balance FROM daily) SELECT 1 FROM running WHERE balance<0 LIMIT 1`,[input.itemId,medication,fmrOmed]);
  if(invalid.rowCount)throw new ApiError(409,"NEGATIVE_DAILY_STOCK","This date would create a negative historical stock balance. Check the movement date or reverse the affected delivery first.");
  return{id,existing:false};
}
async function physicalBalances(client:pg.PoolClient):Promise<BalanceRow[]>{return(await client.query<BalanceRow>("SELECT item_id,medication,fmr_omed,sum(quantity_delta_scaled)::text quantity_scaled FROM inventory_ledger WHERE workspace_id=1 GROUP BY item_id,medication,fmr_omed")).rows;}
async function reservationBalances(client:pg.PoolClient):Promise<BalanceRow[]>{return(await client.query<BalanceRow>("SELECT item_id,medication,fmr_omed,sum(quantity_scaled)::text quantity_scaled FROM inventory_reservations GROUP BY item_id,medication,fmr_omed")).rows;}
async function assertNonnegativeAfter(client:pg.PoolClient,itemId:string,medication:string,fmrOmed:string,delta:number):Promise<void>{const r=await client.query<{quantity_scaled:string}>("SELECT COALESCE(sum(quantity_delta_scaled),0)::text quantity_scaled FROM inventory_ledger WHERE item_id=$1 AND medication=$2 AND fmr_omed=$3",[itemId,normalizeBucketText(medication),normalizeBucketText(fmrOmed)]);if(numeric(r.rows[0].quantity_scaled)+delta<0)throw new ApiError(409,"NEGATIVE_PHYSICAL_STOCK","Movement would make physical stock negative.");}
async function orderDeliveredTotal(client:pg.PoolClient,sourceOrderId:string):Promise<number>{const r=await client.query<{total:string}>(`SELECT COALESCE(sum(CASE WHEN l.movement_type='dispatch' THEN -l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='dispatch' THEN -l.quantity_delta_scaled ELSE 0 END),0)::text total FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.source_order_id=$1`,[sourceOrderId]);return numeric(r.rows[0].total);}
async function movementTotalsByOrder(client:pg.PoolClient):Promise<Map<string,{delivered:number;produced:number}>>{const rows=await client.query<{source_order_id:string;delivered:string;produced:string}>(`SELECT l.source_order_id,
  COALESCE(sum(CASE WHEN l.movement_type='dispatch' THEN -l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='dispatch' THEN -l.quantity_delta_scaled ELSE 0 END),0)::text delivered,
  COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0)::text produced
  FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.source_order_id IS NOT NULL GROUP BY l.source_order_id`);return new Map(rows.rows.map(row=>[row.source_order_id,{delivered:numeric(row.delivered),produced:numeric(row.produced)}]));}
export async function jobProductionTotal(client:pg.PoolClient,jobId:string):Promise<number>{const r=await client.query<{total:string}>(`SELECT COALESCE(sum(CASE WHEN l.movement_type='production' THEN l.quantity_delta_scaled WHEN l.movement_type='reversal' AND original.movement_type='production' THEN l.quantity_delta_scaled ELSE 0 END),0)::text total FROM inventory_ledger l LEFT JOIN inventory_ledger original ON original.id=l.reverses_movement_id WHERE l.job_id=$1`,[jobId]);return numeric(r.rows[0].total);}
async function reversedTotal(client:pg.PoolClient,id:string):Promise<number>{const r=await client.query<{total:string}>("SELECT COALESCE(sum(quantity_delta_scaled),0)::text total FROM inventory_ledger WHERE reverses_movement_id=$1",[id]);return numeric(r.rows[0].total);}
async function movementById(client:pg.PoolClient,id:string,lock:boolean):Promise<any>{const r=await client.query(`SELECT * FROM inventory_ledger WHERE workspace_id=1 AND id=$1${lock?" FOR UPDATE":""}`,[id]);if(!r.rowCount)throw new ApiError(400,"MOVEMENT_NOT_FOUND","Inventory movement not found.");return r.rows[0];}

function scheduledForOrder(jobs:Job[],sourceOrderId:string,item:ItemRow):number{return jobs.filter(job=>job.sourceOrderId===sourceOrderId&&(job.status==="pending"||job.status==="running")).reduce((total,job)=>total+jobScaled(job,item.unit),0);}
function jobScaled(job:Job,unit:InventoryUnit):number{if(unit==="Bags")return quantityToScaled(unit,job.bagCount??0);return quantityToScaled(unit,job.quantityMt);}
function itemView(item:ItemRow):Omit<InventoryItemSnapshot,"buckets"|"totalOnHand"|"totalReserved"|"totalAvailable">{return{itemId:item.id,materialCode:item.material_code,description:item.description,unit:item.unit,bagWeightKg:item.bag_weight_kg,strategy:item.strategy,targetQuantity:item.target_quantity_scaled===null?null:scaledToQuantity(item.unit,numeric(item.target_quantity_scaled)),defaultExtra:itemExtra(item),needsReview:item.needs_review};}
function itemExtra(item:ItemRow){if(!item.extra_type||item.extra_value_scaled===null)return null;return item.extra_type==="fixed"?{type:"fixed" as const,quantity:scaledToQuantity(item.unit,numeric(item.extra_value_scaled))}:{type:"percent" as const,percent:numeric(item.extra_value_scaled)/1_000};}
function ledgerView(row:any):InventoryLedgerEntry{return{id:row.id,itemId:row.item_id,medication:row.medication,fmrOmed:row.fmr_omed,movementType:row.movement_type,quantityDelta:scaledToQuantity(row.unit,numeric(row.quantity_delta_scaled)),unit:row.unit,occurredOn:dbDate(row.occurred_on),recordedAt:new Date(row.recorded_at).toISOString(),sourceOrderId:row.source_order_id,jobId:row.job_id,reversesMovementId:row.reverses_movement_id,note:row.note};}
function appendEvent(state:AppState,at:string,type:string,message:string,jobId?:string|null):AppState{const event:HistoryEvent={id:`event-${randomUUID()}`,at,type,message,...(jobId?{jobId}: {})};return{...state,events:[...state.events,event]};}
function stableItemId(materialCode:string):string{return`inventory-${createHash("sha256").update(materialCode.trim().toLocaleUpperCase("en-US")).digest("hex").slice(0,24)}`;}
function hashCanonical(value:unknown):string{return createHash("sha256").update(canonicalJson(value)).digest("hex");}
function canonicalJson(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonicalJson).join(",")}]`;const row=value as Record<string,unknown>;return`{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;}
function numeric(value:string|number):number{const result=Number(value);if(!Number.isSafeInteger(result))throw new Error("Stored inventory quantity is outside the safe integer range.");return result;}
function dbDate(value:string|Date):string{return value instanceof Date?`${value.getFullYear().toString().padStart(4,"0")}-${(value.getMonth()+1).toString().padStart(2,"0")}-${value.getDate().toString().padStart(2,"0")}`:String(value).slice(0,10);}
function malaysiaDateAt(nowIso:string):string{return new Date(Date.parse(nowIso)+8*60*60_000).toISOString().slice(0,10);}
function scheduleFloor(fromDate:string,nowIso:string):string{const from=Date.parse(`${fromDate}T07:00:00+08:00`);return new Date(Math.max(from,Date.parse(nowIso))).toISOString();}
function statusPriority(status:string):number{return status==="done"?0:status==="pending"?1:2;}
function bucketKey(itemId:string,medication:string,fmrOmed:string):string{return`${itemId}\u0000${bucketIdentity(medication,fmrOmed)}`;}
function sum(values:number[]):number{return Math.round(values.reduce((total,value)=>total+value,0)*1_000)/1_000;}
async function workspaceRevision(client:pg.PoolClient):Promise<number>{const row=await client.query<{revision:string}>("SELECT revision FROM workspace WHERE id=1");return numeric(row.rows[0].revision);}
