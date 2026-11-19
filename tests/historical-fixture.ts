/**
 * Test-only access to historical import primitives. Public SAP ingestion accepts
 * tomorrow only; regression fixtures deliberately include old/multi-day orders.
 * Never import this module from application code or point it at a live database.
 */
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { WorkspaceStore } from '../server/store';
import { applyInventoryWorkbook, recalculateReservations, syncInventoryOrders } from '../server/inventory';
import { applySourceImport, previewSourceImport } from '../server/sourceData';
import { parseCommand, type WorkspaceEnvelope } from '../src/domain/commands';
import type { InventoryWorkbookInput } from '../src/domain/inventoryTypes';
import type { SourceImportInput } from '../src/domain/sourceTypes';
import { ApiError } from '../server/errors';

export function isHistoricalFixtureCommand(value: unknown): boolean {
  const command = value as { type?: string; input?: { orders?: unknown[]; annotations?: unknown[] } };
  return command.type === 'data.import' || command.type === 'data.importBatch' ||
    (['inventory.importBaseline', 'inventory.importWorkbook'].includes(command.type ?? '') &&
      Boolean(command.input?.orders?.length || command.input?.annotations?.length));
}

export function assertFixtureDatabase(): string {
  const value = process.env.TEST_DATABASE_URL;
  if (!value) throw new Error('Historical fixtures require explicit TEST_DATABASE_URL.');
  const test = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(test.protocol) || !/(^|[-_])test(?:[-_]|$)/i.test(decodeURIComponent(test.pathname.slice(1)))) {
    throw new Error('Historical fixtures require a dedicated database with a separated test marker.');
  }
  const productionValue = process.env.DATABASE_URL;
  if (productionValue) {
    const production = new URL(productionValue);
    const identity = (url: URL) => `${url.hostname.toLowerCase()}:${url.port || '5432'}${url.pathname}`;
    // Browser test servers explicitly use the same disposable DB under both
    // variables; only the non-production loopback + replacement guard allows it.
    if (identity(test) === identity(production) && !guardedBrowserFixture()) {
      throw new Error('Historical fixture database must differ from DATABASE_URL.');
    }
  }
  return value;
}

function guardedBrowserFixture(): boolean {
  if (process.env.BROWSER_ALLOW_REPLACE !== '1' || !process.env.BROWSER_BASE_URL) return false;
  const base = new URL(process.env.BROWSER_BASE_URL);
  return ['localhost', '127.0.0.1'].includes(base.hostname) && Boolean(base.port) && base.port !== '8080';
}

export async function executeHistoricalFixture(pool: pg.Pool, revision: number, commandId: string, value: unknown): Promise<WorkspaceEnvelope> {
  const expectedDatabase = assertFixtureDatabase();
  if ((pool.options as { connectionString?: string }).connectionString !== expectedDatabase) throw new Error('Fixture pool must match TEST_DATABASE_URL.');
  if (!isHistoricalFixtureCommand(value)) throw new Error('Only explicit historical fixture imports may use this helper.');
  // Validate order fields with the normal structural parser. Strip only the
  // legacy stock-import order attachment, now prohibited by public commands.
  const raw = value as any;
  let command: any;
  if (raw.type.startsWith('inventory.')) {
    parseCommand({ ...raw, input: { ...raw.input, orders: [], annotations: [] } });
    for (const input of raw.input.orders) parseCommand({ type: 'data.import', input });
    command = structuredClone(raw);
  } else command = parseCommand(value);
  const store = new WorkspaceStore(pool);
  const initial = await store.getWorkspace();
  const client = await pool.connect();
  const hash = createHash('sha256').update(canonical(command)).digest('hex');
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT revision FROM workspace WHERE id=1 FOR UPDATE');
    const receipt = await client.query('SELECT payload_hash FROM command_receipts WHERE command_id=$1', [commandId]);
    if (receipt.rowCount) {
      if (receipt.rows[0].payload_hash !== hash) throw new ApiError(409, 'COMMAND_ID_REUSED', 'Fixture command ID was reused.');
      await client.query('COMMIT');
      return await store.getWorkspace();
    }
    if (Number(locked.rows[0].revision) !== revision || initial.revision !== revision) throw new ApiError(409, 'STALE_REVISION', 'Fixture revision changed.');
    const now = new Date().toISOString();
    let state = initial.state;
    let inputs: SourceImportInput[];
    if (command.type.startsWith('inventory.')) {
      const input = command.input as InventoryWorkbookInput;
      state = await applyInventoryWorkbook(client, state, input, now, command.type === 'inventory.importBaseline');
      inputs = input.orders;
    } else {
      inputs = command.type === 'data.import' ? [command.input] : command.inputs;
      for (const input of inputs) {
        state = (await applySourceImport(client, state, input, now)).state;
        await syncInventoryOrders(client, state, input, now);
      }
    }
    // Explicit admission represents fixture provenance, never a production
    // bypass. Existing admissions stay stable across duplicate fixture imports.
    for (const input of inputs) {
      const rows = await client.query<{ id: string }>(`SELECT o.id FROM source_orders o JOIN inventory_orders i ON i.source_order_id=o.id
        JOIN jsonb_to_recordset($1::jsonb) k(do_no text,material_code text,ordinal integer)
          ON lower(btrim(o.do_no))=lower(btrim(k.do_no)) AND lower(btrim(o.material_code))=lower(btrim(k.material_code))
        WHERE o.workspace_id=1 AND i.admission_batch_id IS NULL ORDER BY k.ordinal`,
      [JSON.stringify(input.rows.map((row, index) => ({ do_no: row.doNo, material_code: row.materialCode, ordinal: index })))]);
      if (!rows.rowCount) continue;
      const id = `test-admission-${randomUUID()}`;
      await client.query(`INSERT INTO order_admission_batches(id,workspace_id,target_date,semantic_digest,accepted_at,row_count)
        VALUES($1,1,$2,$3,$4,$5)`, [id, input.rows[0].deliveryDate, createHash('sha256').update(id).digest('hex'), now, rows.rowCount]);
      for (const [index, row] of rows.rows.entries()) await client.query('UPDATE inventory_orders SET admission_batch_id=$1,admission_ordinal=$2 WHERE source_order_id=$3', [id, index, row.id]);
    }
    await recalculateReservations(client, now);
    await client.query('UPDATE workspace SET revision=$1,catalog=$2::jsonb,updated_at=$3,undo_state=NULL,undo_revision=NULL WHERE id=1', [revision + 1, JSON.stringify(state.catalog), now]);
    for (const [index, event] of state.events.entries()) await client.query(`INSERT INTO history_events(workspace_id,id,ordinal,occurred_at,event_type,job_id,payload)
      VALUES(1,$1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`, [event.id, index, event.at, event.type, event.jobId ?? null, JSON.stringify(event)]);
    await client.query('INSERT INTO command_receipts(command_id,payload_hash,applied_revision,created_at) VALUES($1,$2,$3,$4)', [commandId, hash, revision + 1, now]);
    await client.query('COMMIT');
    return await store.getWorkspace();
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function historicalFixturePreview(pool: pg.Pool, request: SourceImportInput | { input: SourceImportInput; context?: any }): Promise<Response> {
  assertFixtureDatabase();
  const input = 'input' in request ? request.input : request;
  const context = 'input' in request ? request.context : undefined;
  return Response.json(await previewSourceImport(pool, input, context));
}

export async function historicalFixtureResponse(pool: pg.Pool, revision: number, id: string, command: unknown): Promise<Response> {
  try { return Response.json(await executeHistoricalFixture(pool, revision, id, command)); }
  catch (error) {
    const api = error instanceof ApiError ? error : new ApiError(400, 'INVALID_REQUEST', error instanceof Error ? error.message : String(error));
    return Response.json({ error: { code: api.code, message: api.message } }, { status: api.status });
  }
}

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!guardedBrowserFixture()) throw new Error('CLI fixtures require guarded loopback browser replacement.');
  const pool = new pg.Pool({ connectionString: assertFixtureDatabase() });
  try {
    let payload = ''; for await (const chunk of process.stdin) payload += chunk;
    const request = JSON.parse(payload);
    const result = await executeHistoricalFixture(pool, request.expectedRevision, request.commandId, request.command);
    process.stdout.write(JSON.stringify(result));
  } finally { await pool.end(); }
}
