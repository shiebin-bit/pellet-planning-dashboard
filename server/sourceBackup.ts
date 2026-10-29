import { createHash } from "node:crypto";
import type pg from "pg";
import { validateWorkspaceBackup } from "../src/domain/backup";
import type { AppState } from "../src/domain/types";
import type { PortableSourceData, PortableWorkspaceBackupV3, SourceOrderFields } from "../src/domain/sourceTypes";
import type { PortableInventoryData, PortableWorkspaceBackupV4 } from "../src/domain/inventoryTypes";
import { getJobSourceAllocations } from "../src/domain/jobSources";

export function validatePortableBackupV4(value: unknown): PortableWorkspaceBackupV4 {
  const root = record(value, "backup");
  exact(root, ["schemaVersion", "exportedAt", "planning", "sourceData", "inventory"], "backup");
  if (root.schemaVersion !== 4) throw new Error("backup.schemaVersion must be 4.");
  const legacy = validatePortableBackupV3({ schemaVersion: 3, exportedAt: root.exportedAt, planning: root.planning, sourceData: root.sourceData });
  return { schemaVersion: 4, exportedAt: legacy.exportedAt, planning: legacy.planning, sourceData: legacy.sourceData,
    inventory: validatePortableInventoryData(root.inventory, legacy.sourceData, legacy.planning) };
}

export function validatePortableInventoryData(value: unknown, sourceData: PortableSourceData, planning: AppState): PortableInventoryData {
  const root = record(value, "backup.inventory");
  exact(root, ["items", "imports", "baselineReports", "orders", "ledger", "reservations"], "backup.inventory");
  const items = array(root.items, "backup.inventory.items", 10_000).map((value,index)=>{
    const p=`backup.inventory.items[${index}]`,r=record(value,p);exact(r,["id","catalogId","materialCode","description","unit","bagWeightKg","strategy","targetQuantityScaled","extraType","extraValueScaled","needsReview","createdAt","updatedAt"],p);
    if(r.unit!=="Bags"&&r.unit!=="MT")throw new Error(`${p}.unit is invalid.`);if(r.bagWeightKg!==null&&r.bagWeightKg!==25&&r.bagWeightKg!==50)throw new Error(`${p}.bagWeightKg is invalid.`);if(r.strategy!==null&&r.strategy!=="mto"&&r.strategy!=="mts")throw new Error(`${p}.strategy is invalid.`);if(r.extraType!==null&&r.extraType!=="fixed"&&r.extraType!=="percent")throw new Error(`${p}.extraType is invalid.`);
    return{id:text(r.id,`${p}.id`,200),catalogId:r.catalogId===null?null:text(r.catalogId,`${p}.catalogId`,200),materialCode:text(r.materialCode,`${p}.materialCode`,120),description:string(r.description,`${p}.description`,200),unit:r.unit,bagWeightKg:r.bagWeightKg,strategy:r.strategy,targetQuantityScaled:r.targetQuantityScaled===null?null:safeInteger(r.targetQuantityScaled,`${p}.targetQuantityScaled`,0),extraType:r.extraType,extraValueScaled:r.extraValueScaled===null?null:safeInteger(r.extraValueScaled,`${p}.extraValueScaled`,1),needsReview:bool(r.needsReview,`${p}.needsReview`),createdAt:timestamp(r.createdAt,`${p}.createdAt`),updatedAt:timestamp(r.updatedAt,`${p}.updatedAt`)} as PortableInventoryData["items"][number];
  });
  const imports = array(root.imports,"backup.inventory.imports",10_000).map((value,index)=>{const p=`backup.inventory.imports[${index}]`,r=record(value,p);exact(r,["id","fileName","digest","semanticDigest","asOfDate","includedBaseline","packingBinTotalScaled","importedAt"],p);return{id:text(r.id,`${p}.id`,200),fileName:text(r.fileName,`${p}.fileName`,255),digest:sha256(r.digest,`${p}.digest`),semanticDigest:sha256(r.semanticDigest,`${p}.semanticDigest`),asOfDate:date(r.asOfDate,`${p}.asOfDate`),includedBaseline:bool(r.includedBaseline,`${p}.includedBaseline`),packingBinTotalScaled:r.packingBinTotalScaled===null?null:safeInteger(r.packingBinTotalScaled,`${p}.packingBinTotalScaled`,0),importedAt:timestamp(r.importedAt,`${p}.importedAt`)}});
  const baselineReports = array(root.baselineReports,"backup.inventory.baselineReports",100_000).map((value,index)=>{const p=`backup.inventory.baselineReports[${index}]`,r=record(value,p);exact(r,["importId","itemId","medication","fmrOmed","openingScaled","productionScaled","receivedScaled","salesReturnScaled","reworkScaled","issueScaled","closingScaled"],p);return{importId:text(r.importId,`${p}.importId`,200),itemId:text(r.itemId,`${p}.itemId`,200),medication:string(r.medication,`${p}.medication`,200),fmrOmed:string(r.fmrOmed,`${p}.fmrOmed`,200),openingScaled:safeInteger(r.openingScaled,`${p}.openingScaled`,0),productionScaled:safeInteger(r.productionScaled,`${p}.productionScaled`,0),receivedScaled:safeInteger(r.receivedScaled,`${p}.receivedScaled`,0),salesReturnScaled:safeInteger(r.salesReturnScaled,`${p}.salesReturnScaled`,0),reworkScaled:safeInteger(r.reworkScaled,`${p}.reworkScaled`,0),issueScaled:safeInteger(r.issueScaled,`${p}.issueScaled`,0),closingScaled:safeInteger(r.closingScaled,`${p}.closingScaled`,0)}});
  const orders = array(root.orders,"backup.inventory.orders",100_000).map((value,index)=>{const p=`backup.inventory.orders[${index}]`,r=record(value,p);exact(r,["sourceOrderId","itemId","dueDate","orderedQuantityScaled","medication","fmrOmed","historicalStatus","manualMedication","manualFmrOmed","manualDueDate","needsReview","createdAt","updatedAt"],p);if(r.historicalStatus!=="pending"&&r.historicalStatus!=="done"&&r.historicalStatus!=="out")throw new Error(`${p}.historicalStatus is invalid.`);return{sourceOrderId:text(r.sourceOrderId,`${p}.sourceOrderId`,200),itemId:text(r.itemId,`${p}.itemId`,200),dueDate:date(r.dueDate,`${p}.dueDate`),orderedQuantityScaled:safeInteger(r.orderedQuantityScaled,`${p}.orderedQuantityScaled`,0),medication:string(r.medication,`${p}.medication`,200),fmrOmed:string(r.fmrOmed,`${p}.fmrOmed`,200),historicalStatus:r.historicalStatus,manualMedication:bool(r.manualMedication,`${p}.manualMedication`),manualFmrOmed:bool(r.manualFmrOmed,`${p}.manualFmrOmed`),manualDueDate:bool(r.manualDueDate,`${p}.manualDueDate`),needsReview:bool(r.needsReview,`${p}.needsReview`),createdAt:timestamp(r.createdAt,`${p}.createdAt`),updatedAt:timestamp(r.updatedAt,`${p}.updatedAt`)} as PortableInventoryData["orders"][number];});
  const movementTypes=new Set(["baseline","production","received","return","rework","dispatch","adjustment","reversal"]);
  const ledger = array(root.ledger,"backup.inventory.ledger",1_000_000).map((value,index)=>{const p=`backup.inventory.ledger[${index}]`,r=record(value,p);exact(r,["id","itemId","medication","fmrOmed","movementType","quantityDeltaScaled","occurredOn","recordedAt","postingKey","sourceOrderId","jobId","reversesMovementId","importId","note","metadata"],p);if(typeof r.movementType!=="string"||!movementTypes.has(r.movementType))throw new Error(`${p}.movementType is invalid.`);const metadata=record(r.metadata,`${p}.metadata`);return{id:text(r.id,`${p}.id`,200),itemId:text(r.itemId,`${p}.itemId`,200),medication:string(r.medication,`${p}.medication`,200),fmrOmed:string(r.fmrOmed,`${p}.fmrOmed`,200),movementType:r.movementType as PortableInventoryData["ledger"][number]["movementType"],quantityDeltaScaled:nonzeroSafeInteger(r.quantityDeltaScaled,`${p}.quantityDeltaScaled`),occurredOn:date(r.occurredOn,`${p}.occurredOn`),recordedAt:timestamp(r.recordedAt,`${p}.recordedAt`),postingKey:text(r.postingKey,`${p}.postingKey`,200),sourceOrderId:r.sourceOrderId===null?null:text(r.sourceOrderId,`${p}.sourceOrderId`,200),jobId:r.jobId===null?null:text(r.jobId,`${p}.jobId`,200),reversesMovementId:r.reversesMovementId===null?null:text(r.reversesMovementId,`${p}.reversesMovementId`,200),importId:r.importId===null?null:text(r.importId,`${p}.importId`,200),note:r.note===null?null:string(r.note,`${p}.note`,1000),metadata}});
  const reservations = array(root.reservations,"backup.inventory.reservations",100_000).map((value,index)=>{const p=`backup.inventory.reservations[${index}]`,r=record(value,p);exact(r,["sourceOrderId","itemId","medication","fmrOmed","quantityScaled","updatedAt"],p);return{sourceOrderId:text(r.sourceOrderId,`${p}.sourceOrderId`,200),itemId:text(r.itemId,`${p}.itemId`,200),medication:string(r.medication,`${p}.medication`,200),fmrOmed:string(r.fmrOmed,`${p}.fmrOmed`,200),quantityScaled:safeInteger(r.quantityScaled,`${p}.quantityScaled`,0),updatedAt:timestamp(r.updatedAt,`${p}.updatedAt`)}});
  unique(items.map(r=>r.id),"inventory item id");unique(items.map(r=>r.materialCode.trim().toLowerCase()),"inventory material code");unique(imports.map(r=>r.id),"inventory import id");unique(imports.map(r=>r.semanticDigest),"inventory import digest");unique(orders.map(r=>r.sourceOrderId),"inventory order");unique(ledger.map(r=>r.id),"inventory movement id");unique(ledger.map(r=>r.postingKey),"inventory posting key");unique(reservations.map(r=>r.sourceOrderId),"inventory reservation");
  const itemIds=new Set(items.map(r=>r.id)),importIds=new Set(imports.map(r=>r.id)),sourceIds=new Set(sourceData.orders.map(r=>r.id)),jobIds=new Set(planning.jobs.map(r=>r.id)),movementIds=new Set(ledger.map(r=>r.id));
  const baselineKeys=new Set<string>();for(const r of baselineReports){if(!itemIds.has(r.itemId)||!importIds.has(r.importId))throw new Error("Inventory baseline refers to a missing item or import.");const key=`${r.importId}\0${r.itemId}\0${r.medication}\0${r.fmrOmed}`;if(baselineKeys.has(key))throw new Error("Backup contains a duplicate inventory baseline row.");baselineKeys.add(key);if(r.openingScaled+r.productionScaled+r.receivedScaled+r.salesReturnScaled-r.reworkScaled-r.issueScaled!==r.closingScaled)throw new Error("An inventory baseline row does not balance.");}
  for(const r of orders)if(!itemIds.has(r.itemId)||!sourceIds.has(r.sourceOrderId))throw new Error("Inventory order refers to a missing item or source order.");
  const movementById=new Map(ledger.map(r=>[r.id,r]));const balances=new Map<string,number>();
  const inventoryById=new Map(items.map(item=>[item.id,item]));
  for(const job of planning.jobs){if(!job.inventoryItemId)continue;const item=inventoryById.get(job.inventoryItemId);if(!item||item.materialCode.trim().toUpperCase()!==job.productCode.trim().toUpperCase()||(item.unit==='Bags')!==(job.mode==='bags'))throw new Error('A planning card refers to a missing or mismatched inventory product.');}
  for(const order of orders){const source=sourceData.orders.find(row=>row.id===order.sourceOrderId),item=inventoryById.get(order.itemId);const latest=sourceData.versions.find(row=>row.sourceOrderId===order.sourceOrderId&&row.version===source?.latestVersion);if(!source||!item||!latest||latest.fields.materialCode.trim().toUpperCase()!==item.materialCode.trim().toUpperCase()||latest.fields.unit!==item.unit)throw new Error('An inventory order does not match its latest source product.');}
  const reversedDispatch=new Map<string,number>();
  for(const row of ledger){
    if(row.jobId){const job=planning.jobs.find(job=>job.id===row.jobId);const sources=job?new Set(getJobSourceAllocations(job).map(allocation=>allocation.sourceOrderId)):new Set<string>();if(!job||job.inventoryItemId!==row.itemId||(row.sourceOrderId!==null&&!sources.has(row.sourceOrderId))||(job.medication??'')!==row.medication||(job.fmrOmed??'')!==row.fmrOmed)throw new Error('A production movement does not match its card.');}
    if(!row.reversesMovementId)continue;
    const original=movementById.get(row.reversesMovementId);
    if(!original||original.id===row.id||original.recordedAt>row.recordedAt||original.sourceOrderId!==row.sourceOrderId||original.jobId!==row.jobId||!['production','dispatch'].includes(original.movementType))throw new Error('A correction refers to an invalid original movement.');
    const seen=new Set([row.id]);let cursor:typeof original|undefined=original;while(cursor){if(seen.has(cursor.id))throw new Error('Inventory corrections contain a cycle.');seen.add(cursor.id);cursor=cursor.reversesMovementId?movementById.get(cursor.reversesMovementId):undefined;}
    if(original.movementType==='dispatch'){if(row.movementType!=='reversal'||row.quantityDeltaScaled<=0)throw new Error('A delivery reversal must return stock.');const total=(reversedDispatch.get(original.id)??0)+row.quantityDeltaScaled;if(total>-original.quantityDeltaScaled)throw new Error('Delivery reversals exceed the original pickup.');reversedDispatch.set(original.id,total);}
    else if(row.movementType!=='production'&&row.movementType!=='reversal')throw new Error('A production correction has an invalid type.');
  }
  for(const r of [...ledger].sort((a,b)=>a.recordedAt.localeCompare(b.recordedAt)||a.id.localeCompare(b.id))){if(!itemIds.has(r.itemId)||r.importId&&!importIds.has(r.importId)||r.sourceOrderId&&!sourceIds.has(r.sourceOrderId)||r.jobId&&!jobIds.has(r.jobId)||r.reversesMovementId&&!movementIds.has(r.reversesMovementId))throw new Error("Inventory movement contains an orphan reference.");if(["baseline","production","received","return"].includes(r.movementType)&&r.quantityDeltaScaled<0)throw new Error("A positive inventory movement has a negative quantity.");if(["dispatch","rework"].includes(r.movementType)&&r.quantityDeltaScaled>0)throw new Error("An outbound inventory movement has a positive quantity.");if(r.movementType==="reversal"&&!r.reversesMovementId)throw new Error("An inventory reversal must refer to its original movement.");if(r.reversesMovementId){const original=movementById.get(r.reversesMovementId);if(!original||original.itemId!==r.itemId||original.medication!==r.medication||original.fmrOmed!==r.fmrOmed)throw new Error("An inventory correction does not match its original bucket.");}const key=`${r.itemId}\0${r.medication}\0${r.fmrOmed}`,next=(balances.get(key)??0)+r.quantityDeltaScaled;if(next<0)throw new Error("Inventory backup replays to negative physical stock.");balances.set(key,next);}
  const orderBySource=new Map(orders.map(r=>[r.sourceOrderId,r])),reservedByBucket=new Map<string,number>();for(const r of reservations){const order=orderBySource.get(r.sourceOrderId);if(!itemIds.has(r.itemId)||!sourceIds.has(r.sourceOrderId)||!order||order.itemId!==r.itemId||order.medication!==r.medication||order.fmrOmed!==r.fmrOmed)throw new Error("Inventory reservation contains an orphan or mismatched reference.");const key=`${r.itemId}\0${r.medication}\0${r.fmrOmed}`;reservedByBucket.set(key,(reservedByBucket.get(key)??0)+r.quantityScaled);}for(const [key,reserved] of reservedByBucket)if(reserved>(balances.get(key)??0))throw new Error("Inventory reservations exceed physical stock.");
  return{items,imports,baselineReports,orders,ledger,reservations};
}

export function validatePortableBackupV3(value: unknown): PortableWorkspaceBackupV3 {
  const root = record(value, "backup");
  exact(root, ["schemaVersion", "exportedAt", "planning", "sourceData"], "backup");
  if (root.schemaVersion !== 3) throw new Error("backup.schemaVersion must be 3.");
  const exportedAt = timestamp(root.exportedAt, "backup.exportedAt");
  const planning = validateWorkspaceBackup(root.planning);
  const source = record(root.sourceData, "backup.sourceData");
  exact(source, ["imports", "orders", "versions"], "backup.sourceData");
  const imports = array(source.imports, "backup.sourceData.imports", 10_000).map((item, index) => {
    const path = `backup.sourceData.imports[${index}]`; const row = record(item, path);
    exact(row, ["id", "fileName", "sheetName", "digest", "semanticDigest", "asOfDate", "rowCount", "importedAt"], path);
    return { id: text(row.id, `${path}.id`, 200), fileName: text(row.fileName, `${path}.fileName`, 255), sheetName: text(row.sheetName, `${path}.sheetName`, 120), digest: sha256(row.digest, `${path}.digest`), semanticDigest: sha256(row.semanticDigest, `${path}.semanticDigest`), asOfDate: date(row.asOfDate, `${path}.asOfDate`), rowCount: integer(row.rowCount, `${path}.rowCount`, 0), importedAt: timestamp(row.importedAt, `${path}.importedAt`) };
  });
  const orders = array(source.orders, "backup.sourceData.orders", 100_000).map((item, index) => {
    const path = `backup.sourceData.orders[${index}]`; const row = record(item, path);
    exact(row, ["id", "doNo", "materialCode", "latestVersion", "latestImportId", "deliveryStatus", "deliverySource", "deliveryRecordedAt", "deliveryReason", "needsReview", "updatedAt"], path);
    if (row.deliveryStatus !== "pending" && row.deliveryStatus !== "delivered") throw new Error(`${path}.deliveryStatus is invalid.`);
    if (row.deliverySource !== null && row.deliverySource !== "import" && row.deliverySource !== "manual") throw new Error(`${path}.deliverySource is invalid.`);
    const deliveryStatus = row.deliveryStatus as "pending" | "delivered";
    const deliverySource = row.deliverySource as "import" | "manual" | null;
    const deliveryRecordedAt = nullableTimestamp(row.deliveryRecordedAt, `${path}.deliveryRecordedAt`);
    if (deliveryStatus === "delivered" && (!deliverySource || !deliveryRecordedAt)) throw new Error(`${path} delivered orders require a delivery source and recorded time.`);
    if (deliveryStatus === "pending" && (deliverySource !== null || deliveryRecordedAt !== null)) throw new Error(`${path} pending orders cannot have a delivery source or recorded time.`);
    return { id: text(row.id, `${path}.id`, 200), doNo: text(row.doNo, `${path}.doNo`, 120).trim(), materialCode: text(row.materialCode, `${path}.materialCode`, 120).trim(), latestVersion: integer(row.latestVersion, `${path}.latestVersion`, 1), latestImportId: text(row.latestImportId, `${path}.latestImportId`, 200), deliveryStatus, deliverySource, deliveryRecordedAt, deliveryReason: nullableText(row.deliveryReason, `${path}.deliveryReason`, 1_000), needsReview: bool(row.needsReview, `${path}.needsReview`), updatedAt: timestamp(row.updatedAt, `${path}.updatedAt`) };
  });
  const versions = array(source.versions, "backup.sourceData.versions", 500_000).map((item, index) => {
    const path = `backup.sourceData.versions[${index}]`; const row = record(item, path);
    exact(row, ["sourceOrderId", "version", "importId", "fields", "contentHash", "createdAt"], path);
    return { sourceOrderId: text(row.sourceOrderId, `${path}.sourceOrderId`, 200), version: integer(row.version, `${path}.version`, 1), importId: text(row.importId, `${path}.importId`, 200), fields: sourceFields(row.fields, `${path}.fields`), contentHash: sha256(row.contentHash, `${path}.contentHash`), createdAt: timestamp(row.createdAt, `${path}.createdAt`) };
  });
  unique(imports.map(row => row.id), "import id"); unique(orders.map(row => row.id), "source order id");
  const importIds = new Set(imports.map(row => row.id)); const orderIds = new Set(orders.map(row => row.id));
  for (const row of orders) if (!importIds.has(row.latestImportId)) throw new Error(`Source order ${row.id} refers to a missing import.`);
  const versionKeys = new Set<string>();
  const versionByKey = new Map<string, (typeof versions)[number]>();
  for (const row of versions) {
    if (!orderIds.has(row.sourceOrderId) || !importIds.has(row.importId)) throw new Error("A source version refers to a missing order or import.");
    if (row.contentHash !== fieldsHash(row.fields)) throw new Error("A source version content hash does not match its fields.");
    const key = `${row.sourceOrderId}\u0000${row.version}`;
    if (versionKeys.has(key)) throw new Error("Backup contains a duplicate source order version.");
    versionKeys.add(key);
    versionByKey.set(key, row);
  }
  const businessKeys = new Set<string>();
  for (const order of orders) {
    const key = businessKey(order.doNo, order.materialCode);
    if (businessKeys.has(key)) throw new Error("Backup contains a duplicate DO number and material code.");
    businessKeys.add(key);
    const latest = versionByKey.get(`${order.id}\u0000${order.latestVersion}`);
    if (!latest) throw new Error(`Source order ${order.id} has no matching latest version.`);
    if (businessKey(latest.fields.doNo, latest.fields.materialCode) !== businessKey(order.doNo, order.materialCode)) throw new Error(`Source order ${order.id} does not match its latest version key.`);
  }
  const orderById = new Map(orders.map(order => [order.id, order]));
  for (const job of planning.jobs) for (const allocation of getJobSourceAllocations(job)) {
    if (!orderIds.has(allocation.sourceOrderId)) throw new Error(`Job ${job.id} refers to a missing source order.`);
    const order = orderById.get(allocation.sourceOrderId)!;
    if (allocation.sourceOrderVersion > order.latestVersion) throw new Error(`Job ${job.id} has an invalid source version.`);
    const sourceVersion = versionByKey.get(`${allocation.sourceOrderId}\u0000${allocation.sourceOrderVersion}`);
    if (!sourceVersion) throw new Error(`Job ${job.id} refers to a missing source version.`);
    const snapshot = allocation.sourceSnapshot;
    const fields = sourceVersion.fields;
    if (!snapshot || snapshot.doNo !== fields.doNo || snapshot.materialCode !== fields.materialCode || snapshot.description !== fields.description || snapshot.quantity !== fields.quantity || snapshot.unit !== fields.unit) {
      throw new Error(`Job ${job.id} source snapshot does not match its source version.`);
    }
    if (job.productCode !== snapshot.materialCode) {
      throw new Error(`Job ${job.id} planning fields do not match its source snapshot.`);
    }
    if (fields.unit === "Bags") {
      if (job.mode !== "bags" || job.bagCount === null || !job.bagWeightKgSnapshot || Math.abs(job.quantityMt - job.bagCount * job.bagWeightKgSnapshot / 1_000) > 1e-9) throw new Error(`Job ${job.id} bag conversion snapshot is inconsistent.`);
    } else if (job.mode !== "bulk" || job.bagCount !== null || job.bagWeightKgSnapshot !== undefined) {
      throw new Error(`Job ${job.id} bulk quantity snapshot is inconsistent.`);
    }
  }
  return { schemaVersion: 3, exportedAt, planning, sourceData: { imports, orders, versions } };
}

export async function exportSourceData(client: pg.Pool | pg.PoolClient): Promise<PortableSourceData> {
  // A PoolClient must not execute concurrent queries; pg 9 will reject that pattern.
  const imports = await client.query<any>("SELECT id, file_name, sheet_name, digest, semantic_digest, as_of_date::text AS as_of_date, row_count, imported_at FROM source_imports WHERE workspace_id = 1 ORDER BY imported_at, id");
  const orders = await client.query<any>("SELECT id, do_no, material_code, latest_version, latest_import_id, delivery_status, delivery_source, delivery_recorded_at, delivery_reason, needs_review, updated_at FROM source_orders WHERE workspace_id = 1 ORDER BY id");
  const versions = await client.query<any>("SELECT source_order_id, version, import_id, fields, content_hash, created_at FROM source_order_versions WHERE source_order_id IN (SELECT id FROM source_orders WHERE workspace_id = 1) ORDER BY source_order_id, version");
  return {
    imports: imports.rows.map((row: any) => ({ id: row.id, fileName: row.file_name, sheetName: row.sheet_name, digest: row.digest, semanticDigest: row.semantic_digest, asOfDate: dbDate(row.as_of_date), rowCount: row.row_count, importedAt: new Date(row.imported_at).toISOString() })),
    orders: orders.rows.map((row: any) => ({ id: row.id, doNo: row.do_no, materialCode: row.material_code, latestVersion: row.latest_version, latestImportId: row.latest_import_id, deliveryStatus: row.delivery_status, deliverySource: row.delivery_source, deliveryRecordedAt: row.delivery_recorded_at ? new Date(row.delivery_recorded_at).toISOString() : null, deliveryReason: row.delivery_reason, needsReview: row.needs_review, updatedAt: new Date(row.updated_at).toISOString() })),
    versions: versions.rows.map((row: any) => ({ sourceOrderId: row.source_order_id, version: row.version, importId: row.import_id, fields: row.fields, contentHash: row.content_hash, createdAt: new Date(row.created_at).toISOString() })),
  };
}

export async function restoreSourceData(client: pg.PoolClient, data: PortableSourceData): Promise<void> {
  for (const rows of chunks(data.imports, 1_000)) await client.query(
    `INSERT INTO source_imports(id, workspace_id, file_name, sheet_name, digest, semantic_digest, as_of_date, row_count, imported_at)
     SELECT id, 1, file_name, sheet_name, digest, semantic_digest, as_of_date::date, row_count, imported_at::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, file_name text, sheet_name text, digest text, semantic_digest text, as_of_date text, row_count integer, imported_at text)`,
    [JSON.stringify(rows.map(row => ({ id: row.id, file_name: row.fileName, sheet_name: row.sheetName, digest: row.digest, semantic_digest: row.semanticDigest, as_of_date: row.asOfDate, row_count: row.rowCount, imported_at: row.importedAt })))],
  );
  for (const rows of chunks(data.orders, 1_000)) await client.query(
    `INSERT INTO source_orders(id, workspace_id, do_no, material_code, latest_version, latest_import_id, delivery_status, delivery_source, delivery_recorded_at, delivery_reason, needs_review, updated_at)
     SELECT id, 1, do_no, material_code, latest_version, latest_import_id, delivery_status, delivery_source, delivery_recorded_at::timestamptz, delivery_reason, needs_review, updated_at::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, do_no text, material_code text, latest_version integer, latest_import_id text, delivery_status text, delivery_source text, delivery_recorded_at text, delivery_reason text, needs_review boolean, updated_at text)`,
    [JSON.stringify(rows.map(row => ({ id: row.id, do_no: row.doNo, material_code: row.materialCode, latest_version: row.latestVersion, latest_import_id: row.latestImportId, delivery_status: row.deliveryStatus, delivery_source: row.deliverySource, delivery_recorded_at: row.deliveryRecordedAt, delivery_reason: row.deliveryReason, needs_review: row.needsReview, updated_at: row.updatedAt })))],
  );
  for (const rows of chunks(data.versions, 1_000)) await client.query(
    `INSERT INTO source_order_versions(source_order_id, version, import_id, fields, content_hash, created_at)
     SELECT source_order_id, version, import_id, fields, content_hash, created_at::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS x(source_order_id text, version integer, import_id text, fields jsonb, content_hash text, created_at text)`,
    [JSON.stringify(rows.map(row => ({ source_order_id: row.sourceOrderId, version: row.version, import_id: row.importId, fields: row.fields, content_hash: row.contentHash, created_at: row.createdAt })))],
  );
}

export async function exportInventoryData(client: pg.Pool | pg.PoolClient): Promise<PortableInventoryData> {
  const items = await client.query<any>("SELECT * FROM inventory_items WHERE workspace_id=1 ORDER BY id");
  const imports = await client.query<any>("SELECT * FROM inventory_imports WHERE workspace_id=1 ORDER BY imported_at,id");
  const baseline = await client.query<any>("SELECT * FROM inventory_baseline_reports ORDER BY import_id,item_id,medication,fmr_omed");
  const orders = await client.query<any>("SELECT * FROM inventory_orders WHERE workspace_id=1 ORDER BY source_order_id");
  const ledger = await client.query<any>("SELECT * FROM inventory_ledger WHERE workspace_id=1 ORDER BY recorded_at,id");
  const reservations = await client.query<any>("SELECT * FROM inventory_reservations ORDER BY source_order_id");
  return {
    items: items.rows.map((r:any)=>({id:r.id,catalogId:r.catalog_id,materialCode:r.material_code,description:r.description,unit:r.unit,bagWeightKg:r.bag_weight_kg,strategy:r.strategy,targetQuantityScaled:nullableDbInteger(r.target_quantity_scaled),extraType:r.extra_type,extraValueScaled:nullableDbInteger(r.extra_value_scaled),needsReview:r.needs_review,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()})),
    imports: imports.rows.map((r:any)=>({id:r.id,fileName:r.file_name,digest:r.digest,semanticDigest:r.semantic_digest,asOfDate:dbDate(r.as_of_date),includedBaseline:r.included_baseline,packingBinTotalScaled:nullableDbInteger(r.packing_bin_total_scaled),importedAt:new Date(r.imported_at).toISOString()})),
    baselineReports: baseline.rows.map((r:any)=>({importId:r.import_id,itemId:r.item_id,medication:r.medication,fmrOmed:r.fmr_omed,openingScaled:dbInteger(r.opening_scaled),productionScaled:dbInteger(r.production_scaled),receivedScaled:dbInteger(r.received_scaled),salesReturnScaled:dbInteger(r.sales_return_scaled),reworkScaled:dbInteger(r.rework_scaled),issueScaled:dbInteger(r.issue_scaled),closingScaled:dbInteger(r.closing_scaled)})),
    orders: orders.rows.map((r:any)=>({sourceOrderId:r.source_order_id,itemId:r.item_id,dueDate:dbDate(r.due_date),orderedQuantityScaled:dbInteger(r.ordered_quantity_scaled),medication:r.medication,fmrOmed:r.fmr_omed,historicalStatus:r.historical_status,manualMedication:r.manual_medication,manualFmrOmed:r.manual_fmr_omed,manualDueDate:r.manual_due_date,needsReview:r.needs_review,createdAt:new Date(r.created_at).toISOString(),updatedAt:new Date(r.updated_at).toISOString()})),
    ledger: ledger.rows.map((r:any)=>({id:r.id,itemId:r.item_id,medication:r.medication,fmrOmed:r.fmr_omed,movementType:r.movement_type,quantityDeltaScaled:dbInteger(r.quantity_delta_scaled),occurredOn:dbDate(r.occurred_on),recordedAt:new Date(r.recorded_at).toISOString(),postingKey:r.posting_key,sourceOrderId:r.source_order_id,jobId:r.job_id,reversesMovementId:r.reverses_movement_id,importId:r.import_id,note:r.note,metadata:r.metadata})),
    reservations: reservations.rows.map((r:any)=>({sourceOrderId:r.source_order_id,itemId:r.item_id,medication:r.medication,fmrOmed:r.fmr_omed,quantityScaled:dbInteger(r.quantity_scaled),updatedAt:new Date(r.updated_at).toISOString()})),
  };
}

export async function clearInventoryData(client: pg.PoolClient): Promise<void> {
  await client.query("DELETE FROM inventory_reservations");
  await client.query("DELETE FROM inventory_baseline_reports");
  await client.query("DELETE FROM inventory_ledger WHERE workspace_id=1");
  await client.query("DELETE FROM inventory_orders WHERE workspace_id=1");
  await client.query("DELETE FROM inventory_imports WHERE workspace_id=1");
  await client.query("DELETE FROM inventory_items WHERE workspace_id=1");
}

export async function restoreInventoryData(client: pg.PoolClient, data: PortableInventoryData): Promise<void> {
  for(const rows of chunks(data.items,1000))await client.query(`INSERT INTO inventory_items(id,workspace_id,catalog_id,material_code,description,unit,bag_weight_kg,strategy,target_quantity_scaled,extra_type,extra_value_scaled,needs_review,created_at,updated_at)
    SELECT id,1,catalog_id,material_code,description,unit,bag_weight_kg,strategy,target_quantity_scaled,extra_type,extra_value_scaled,needs_review,created_at::timestamptz,updated_at::timestamptz FROM jsonb_to_recordset($1::jsonb) x(id text,catalog_id text,material_code text,description text,unit text,bag_weight_kg integer,strategy text,target_quantity_scaled bigint,extra_type text,extra_value_scaled bigint,needs_review boolean,created_at text,updated_at text)`,[JSON.stringify(rows.map(r=>({id:r.id,catalog_id:r.catalogId,material_code:r.materialCode,description:r.description,unit:r.unit,bag_weight_kg:r.bagWeightKg,strategy:r.strategy,target_quantity_scaled:r.targetQuantityScaled,extra_type:r.extraType,extra_value_scaled:r.extraValueScaled,needs_review:r.needsReview,created_at:r.createdAt,updated_at:r.updatedAt})))]);
  for(const rows of chunks(data.imports,1000))await client.query(`INSERT INTO inventory_imports(id,workspace_id,file_name,digest,semantic_digest,as_of_date,included_baseline,packing_bin_total_scaled,imported_at)
    SELECT id,1,file_name,digest,semantic_digest,as_of_date::date,included_baseline,packing_bin_total_scaled,imported_at::timestamptz FROM jsonb_to_recordset($1::jsonb) x(id text,file_name text,digest text,semantic_digest text,as_of_date text,included_baseline boolean,packing_bin_total_scaled bigint,imported_at text)`,[JSON.stringify(rows.map(r=>({id:r.id,file_name:r.fileName,digest:r.digest,semantic_digest:r.semanticDigest,as_of_date:r.asOfDate,included_baseline:r.includedBaseline,packing_bin_total_scaled:r.packingBinTotalScaled,imported_at:r.importedAt})))]);
  for(const rows of chunks(data.baselineReports,1000))await client.query(`INSERT INTO inventory_baseline_reports(import_id,item_id,medication,fmr_omed,opening_scaled,production_scaled,received_scaled,sales_return_scaled,rework_scaled,issue_scaled,closing_scaled)
    SELECT * FROM jsonb_to_recordset($1::jsonb) x(import_id text,item_id text,medication text,fmr_omed text,opening_scaled bigint,production_scaled bigint,received_scaled bigint,sales_return_scaled bigint,rework_scaled bigint,issue_scaled bigint,closing_scaled bigint)`,[JSON.stringify(rows.map(r=>({import_id:r.importId,item_id:r.itemId,medication:r.medication,fmr_omed:r.fmrOmed,opening_scaled:r.openingScaled,production_scaled:r.productionScaled,received_scaled:r.receivedScaled,sales_return_scaled:r.salesReturnScaled,rework_scaled:r.reworkScaled,issue_scaled:r.issueScaled,closing_scaled:r.closingScaled})))]);
  for(const rows of chunks(data.orders,1000))await client.query(`INSERT INTO inventory_orders(source_order_id,workspace_id,item_id,due_date,ordered_quantity_scaled,medication,fmr_omed,historical_status,manual_medication,manual_fmr_omed,manual_due_date,needs_review,created_at,updated_at)
    SELECT source_order_id,1,item_id,due_date::date,ordered_quantity_scaled,medication,fmr_omed,historical_status,manual_medication,manual_fmr_omed,manual_due_date,needs_review,created_at::timestamptz,updated_at::timestamptz FROM jsonb_to_recordset($1::jsonb) x(source_order_id text,item_id text,due_date text,ordered_quantity_scaled bigint,medication text,fmr_omed text,historical_status text,manual_medication boolean,manual_fmr_omed boolean,manual_due_date boolean,needs_review boolean,created_at text,updated_at text)`,[JSON.stringify(rows.map(r=>({source_order_id:r.sourceOrderId,item_id:r.itemId,due_date:r.dueDate,ordered_quantity_scaled:r.orderedQuantityScaled,medication:r.medication,fmr_omed:r.fmrOmed,historical_status:r.historicalStatus,manual_medication:r.manualMedication,manual_fmr_omed:r.manualFmrOmed,manual_due_date:r.manualDueDate,needs_review:r.needsReview,created_at:r.createdAt,updated_at:r.updatedAt})))]);
  for(const rows of chunks(data.ledger,1000))await client.query(`INSERT INTO inventory_ledger(id,workspace_id,item_id,medication,fmr_omed,movement_type,quantity_delta_scaled,occurred_on,recorded_at,posting_key,source_order_id,job_id,reverses_movement_id,import_id,note,metadata)
    SELECT id,1,item_id,medication,fmr_omed,movement_type,quantity_delta_scaled,occurred_on::date,recorded_at::timestamptz,posting_key,source_order_id,job_id,NULL,import_id,note,metadata FROM jsonb_to_recordset($1::jsonb) x(id text,item_id text,medication text,fmr_omed text,movement_type text,quantity_delta_scaled bigint,occurred_on text,recorded_at text,posting_key text,source_order_id text,job_id text,import_id text,note text,metadata jsonb)`,[JSON.stringify(rows.map(r=>({id:r.id,item_id:r.itemId,medication:r.medication,fmr_omed:r.fmrOmed,movement_type:r.movementType,quantity_delta_scaled:r.quantityDeltaScaled,occurred_on:r.occurredOn,recorded_at:r.recordedAt,posting_key:r.postingKey,source_order_id:r.sourceOrderId,job_id:r.jobId,import_id:r.importId,note:r.note,metadata:r.metadata})))]);
  for(const row of data.ledger)if(row.reversesMovementId)await client.query("UPDATE inventory_ledger SET reverses_movement_id=$2 WHERE id=$1",[row.id,row.reversesMovementId]);
  for(const rows of chunks(data.reservations,1000))await client.query(`INSERT INTO inventory_reservations(source_order_id,item_id,medication,fmr_omed,quantity_scaled,updated_at)
    SELECT source_order_id,item_id,medication,fmr_omed,quantity_scaled,updated_at::timestamptz FROM jsonb_to_recordset($1::jsonb) x(source_order_id text,item_id text,medication text,fmr_omed text,quantity_scaled bigint,updated_at text)`,[JSON.stringify(rows.map(r=>({source_order_id:r.sourceOrderId,item_id:r.itemId,medication:r.medication,fmr_omed:r.fmrOmed,quantity_scaled:r.quantityScaled,updated_at:r.updatedAt})))]);
}

export function portableBackup(planning: AppState, sourceData: PortableSourceData, exportedAt = new Date().toISOString()): PortableWorkspaceBackupV3 {
  return { schemaVersion: 3, exportedAt, planning, sourceData };
}

export function portableBackupV4(planning: AppState, sourceData: PortableSourceData, inventory: PortableInventoryData, exportedAt = new Date().toISOString()): PortableWorkspaceBackupV4 {
  return { schemaVersion: 4, exportedAt, planning, sourceData, inventory };
}

function sourceFields(value: unknown, path: string): SourceOrderFields {
  const row = record(value, path); const keys = ["doNo","deliveryDate","soldToParty","shipToParty","materialCode","description","quantity","unit","deliveryLeadDays","remark","daysOutstanding","medication","fmrOmed"];
  const optional = ["goodsMovementStatus","sourceSheet","sourceRow"]; const allowed=new Set([...keys,...optional]);for(const key of Object.keys(row))if(!allowed.has(key))throw new Error(`${path}.${key} is not supported.`);for(const key of keys)if(!(key in row))throw new Error(`${path}.${key} is required.`);if (row.unit !== "MT" && row.unit !== "Bags") throw new Error(`${path}.unit is invalid.`);
  const nullable = (v: unknown, p: string) => v === null ? null : number(v, p, true);
  return { ...(row.goodsMovementStatus===undefined?{}:{goodsMovementStatus:string(row.goodsMovementStatus,`${path}.goodsMovementStatus`,100)}),...(row.sourceSheet===undefined?{}:{sourceSheet:string(row.sourceSheet,`${path}.sourceSheet`,120)}),...(row.sourceRow===undefined?{}:{sourceRow:integer(row.sourceRow,`${path}.sourceRow`,1)}),doNo:text(row.doNo,`${path}.doNo`,120).trim(),deliveryDate:date(row.deliveryDate,`${path}.deliveryDate`),soldToParty:string(row.soldToParty,`${path}.soldToParty`,1000),shipToParty:string(row.shipToParty,`${path}.shipToParty`,1000),materialCode:text(row.materialCode,`${path}.materialCode`,80).trim(),description:string(row.description,`${path}.description`,200),quantity:number(row.quantity,`${path}.quantity`,false),unit:row.unit,deliveryLeadDays:nullable(row.deliveryLeadDays,`${path}.deliveryLeadDays`),remark:string(row.remark,`${path}.remark`,1000),daysOutstanding:nullable(row.daysOutstanding,`${path}.daysOutstanding`),medication:string(row.medication,`${path}.medication`,1000),fmrOmed:string(row.fmrOmed,`${path}.fmrOmed`,1000)};
}
function record(v:unknown,p:string):Record<string,unknown>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error(`${p} must be an object.`);return v as Record<string,unknown>}
function exact(v:Record<string,unknown>,keys:readonly string[],p:string){const allowed=new Set(keys);for(const key of Object.keys(v))if(!allowed.has(key))throw new Error(`${p}.${key} is not supported.`);for(const key of keys)if(!(key in v))throw new Error(`${p}.${key} is required.`)}
function array(v:unknown,p:string,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)throw new Error(`${p} must be an array of ${max} items or fewer.`);return v}
function string(v:unknown,p:string,max:number):string{if(typeof v!=="string"||v.length>max)throw new Error(`${p} must be text of ${max} characters or fewer.`);return v}
function text(v:unknown,p:string,max:number):string{const r=string(v,p,max);if(!r.trim())throw new Error(`${p} cannot be blank.`);return r}
function nullableText(v:unknown,p:string,max:number):string|null{return v===null?null:string(v,p,max)}
function integer(v:unknown,p:string,min:number):number{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>2_147_483_647)throw new Error(`${p} must be an integer within the PostgreSQL integer range.`);return v as number}
function safeInteger(v:unknown,p:string,min:number):number{if(!Number.isSafeInteger(v)||(v as number)<min)throw new Error(`${p} must be a safe integer of at least ${min}.`);return v as number}
function nonzeroSafeInteger(v:unknown,p:string):number{if(!Number.isSafeInteger(v)||v===0)throw new Error(`${p} must be a nonzero safe integer.`);return v as number}
function number(v:unknown,p:string,signed:boolean):number{if(typeof v!=="number"||!Number.isFinite(v)||(!signed&&v<0))throw new Error(`${p} must be a finite number.`);return v}
function bool(v:unknown,p:string):boolean{if(typeof v!=="boolean")throw new Error(`${p} must be true or false.`);return v}
function date(v:unknown,p:string):string{const r=string(v,p,10);if(!validDate(r))throw new Error(`${p} must be a date.`);return r}
function timestamp(v:unknown,p:string):string{const r=string(v,p,100);if(!Number.isFinite(Date.parse(r)))throw new Error(`${p} must be a timestamp.`);return new Date(r).toISOString()}
function nullableTimestamp(v:unknown,p:string):string|null{return v===null?null:timestamp(v,p)}
function unique(values:string[],label:string){if(new Set(values).size!==values.length)throw new Error(`Backup contains duplicate ${label}.`)}
function dbDate(value:string|Date):string{return value instanceof Date?`${value.getFullYear().toString().padStart(4,"0")}-${(value.getMonth()+1).toString().padStart(2,"0")}-${value.getDate().toString().padStart(2,"0")}`:String(value).slice(0,10)}
function sha256(value:unknown,path:string):string{const result=text(value,path,64).toLocaleLowerCase("en-US");if(!/^[a-f0-9]{64}$/.test(result))throw new Error(`${path} must be a SHA-256 digest.`);return result}
function fieldsHash(fields:SourceOrderFields):string{return createHash("sha256").update(canonicalJson(fields)).digest("hex")}
function canonicalJson(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;const source=value as Record<string,unknown>;return `{${Object.keys(source).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`}
function businessKey(doNo:string,materialCode:string):string{return `${doNo.trim().toLocaleUpperCase("en-US")}\u0000${materialCode.trim().toLocaleUpperCase("en-US")}`}
function validDate(value:string):boolean{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [year,month,day]=value.split("-").map(Number);const parsed=new Date(Date.UTC(year,month-1,day));return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day}
function* chunks<T>(values:readonly T[],size:number):Generator<readonly T[]>{for(let index=0;index<values.length;index+=size)yield values.slice(index,index+size)}
function dbInteger(value:string|number):number{const result=Number(value);if(!Number.isSafeInteger(result))throw new Error("Stored inventory quantity exceeds JSON safe integer range.");return result}
function nullableDbInteger(value:string|number|null):number|null{return value===null?null:dbInteger(value)}
