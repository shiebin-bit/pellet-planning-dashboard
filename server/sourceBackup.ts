import { createHash } from "node:crypto";
import type pg from "pg";
import { validateWorkspaceBackup } from "../src/domain/backup";
import type { AppState } from "../src/domain/types";
import type { PortableSourceData, PortableWorkspaceBackupV3, SourceOrderFields } from "../src/domain/sourceTypes";

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
  const activeLinks = new Set<string>();
  const orderById = new Map(orders.map(order => [order.id, order]));
  for (const job of planning.jobs) if (job.sourceOrderId) {
    if (!orderIds.has(job.sourceOrderId)) throw new Error(`Job ${job.id} refers to a missing source order.`);
    const order = orderById.get(job.sourceOrderId)!;
    if (!job.sourceOrderVersion || job.sourceOrderVersion > order.latestVersion) throw new Error(`Job ${job.id} has an invalid source version.`);
    const sourceVersion = versionByKey.get(`${job.sourceOrderId}\u0000${job.sourceOrderVersion}`);
    if (!sourceVersion) throw new Error(`Job ${job.id} refers to a missing source version.`);
    const snapshot = job.sourceSnapshot!;
    const fields = sourceVersion.fields;
    if (!snapshot || snapshot.doNo !== fields.doNo || snapshot.materialCode !== fields.materialCode || snapshot.description !== fields.description || snapshot.quantity !== fields.quantity || snapshot.unit !== fields.unit) {
      throw new Error(`Job ${job.id} source snapshot does not match its source version.`);
    }
    if (job.orderNo !== snapshot.doNo || job.productCode !== snapshot.materialCode || job.description !== snapshot.description) {
      throw new Error(`Job ${job.id} planning fields do not match its source snapshot.`);
    }
    if (fields.unit === "Bags") {
      if (job.mode !== "bags" || job.bagCount !== fields.quantity || !job.bagWeightKgSnapshot || Math.abs(job.quantityMt - fields.quantity * job.bagWeightKgSnapshot / 1_000) > 1e-9) throw new Error(`Job ${job.id} bag conversion snapshot is inconsistent.`);
    } else if (job.mode !== "bulk" || job.bagCount !== null || job.bagWeightKgSnapshot !== undefined || Math.abs(job.quantityMt - fields.quantity) > 1e-9) {
      throw new Error(`Job ${job.id} bulk quantity snapshot is inconsistent.`);
    }
    if (job.status !== "cancelled") {
      if (activeLinks.has(job.sourceOrderId)) throw new Error(`More than one active job refers to source order ${job.sourceOrderId}.`);
      activeLinks.add(job.sourceOrderId);
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

export function portableBackup(planning: AppState, sourceData: PortableSourceData, exportedAt = new Date().toISOString()): PortableWorkspaceBackupV3 {
  return { schemaVersion: 3, exportedAt, planning, sourceData };
}

function sourceFields(value: unknown, path: string): SourceOrderFields {
  const row = record(value, path); const keys = ["doNo","deliveryDate","soldToParty","shipToParty","materialCode","description","quantity","unit","deliveryLeadDays","remark","daysOutstanding","medication","fmrOmed"];
  exact(row, keys, path); if (row.unit !== "MT" && row.unit !== "Bags") throw new Error(`${path}.unit is invalid.`);
  const nullable = (v: unknown, p: string) => v === null ? null : number(v, p, true);
  return { doNo:text(row.doNo,`${path}.doNo`,120).trim(),deliveryDate:date(row.deliveryDate,`${path}.deliveryDate`),soldToParty:string(row.soldToParty,`${path}.soldToParty`,1000),shipToParty:string(row.shipToParty,`${path}.shipToParty`,1000),materialCode:text(row.materialCode,`${path}.materialCode`,80).trim(),description:string(row.description,`${path}.description`,200),quantity:number(row.quantity,`${path}.quantity`,false),unit:row.unit,deliveryLeadDays:nullable(row.deliveryLeadDays,`${path}.deliveryLeadDays`),remark:string(row.remark,`${path}.remark`,1000),daysOutstanding:nullable(row.daysOutstanding,`${path}.daysOutstanding`),medication:string(row.medication,`${path}.medication`,1000),fmrOmed:string(row.fmrOmed,`${path}.fmrOmed`,1000)};
}
function record(v:unknown,p:string):Record<string,unknown>{if(!v||typeof v!=="object"||Array.isArray(v))throw new Error(`${p} must be an object.`);return v as Record<string,unknown>}
function exact(v:Record<string,unknown>,keys:readonly string[],p:string){const allowed=new Set(keys);for(const key of Object.keys(v))if(!allowed.has(key))throw new Error(`${p}.${key} is not supported.`);for(const key of keys)if(!(key in v))throw new Error(`${p}.${key} is required.`)}
function array(v:unknown,p:string,max:number):unknown[]{if(!Array.isArray(v)||v.length>max)throw new Error(`${p} must be an array of ${max} items or fewer.`);return v}
function string(v:unknown,p:string,max:number):string{if(typeof v!=="string"||v.length>max)throw new Error(`${p} must be text of ${max} characters or fewer.`);return v}
function text(v:unknown,p:string,max:number):string{const r=string(v,p,max);if(!r.trim())throw new Error(`${p} cannot be blank.`);return r}
function nullableText(v:unknown,p:string,max:number):string|null{return v===null?null:string(v,p,max)}
function integer(v:unknown,p:string,min:number):number{if(!Number.isSafeInteger(v)||(v as number)<min||(v as number)>2_147_483_647)throw new Error(`${p} must be an integer within the PostgreSQL integer range.`);return v as number}
function number(v:unknown,p:string,signed:boolean):number{if(typeof v!=="number"||!Number.isFinite(v)||(!signed&&v<0))throw new Error(`${p} must be a finite number.`);return v}
function bool(v:unknown,p:string):boolean{if(typeof v!=="boolean")throw new Error(`${p} must be true or false.`);return v}
function date(v:unknown,p:string):string{const r=string(v,p,10);if(!validDate(r))throw new Error(`${p} must be a date.`);return r}
function timestamp(v:unknown,p:string):string{const r=string(v,p,100);if(!Number.isFinite(Date.parse(r)))throw new Error(`${p} must be a timestamp.`);return new Date(r).toISOString()}
function nullableTimestamp(v:unknown,p:string):string|null{return v===null?null:timestamp(v,p)}
function unique(values:string[],label:string){if(new Set(values).size!==values.length)throw new Error(`Backup contains duplicate ${label}.`)}
function dbDate(value:string|Date):string{return value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10)}
function sha256(value:unknown,path:string):string{const result=text(value,path,64).toLocaleLowerCase("en-US");if(!/^[a-f0-9]{64}$/.test(result))throw new Error(`${path} must be a SHA-256 digest.`);return result}
function fieldsHash(fields:SourceOrderFields):string{return createHash("sha256").update(canonicalJson(fields)).digest("hex")}
function canonicalJson(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonicalJson).join(",")}]`;const source=value as Record<string,unknown>;return `{${Object.keys(source).sort().map(key=>`${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`}
function businessKey(doNo:string,materialCode:string):string{return `${doNo.trim().toLocaleUpperCase("en-US")}\u0000${materialCode.trim().toLocaleUpperCase("en-US")}`}
function validDate(value:string):boolean{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [year,month,day]=value.split("-").map(Number);const parsed=new Date(Date.UTC(year,month-1,day));return parsed.getUTCFullYear()===year&&parsed.getUTCMonth()===month-1&&parsed.getUTCDate()===day}
function* chunks<T>(values:readonly T[],size:number):Generator<readonly T[]>{for(let index=0;index<values.length;index+=size)yield values.slice(index,index+size)}
