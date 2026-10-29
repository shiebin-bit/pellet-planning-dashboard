# Command API

Default base URL: `http://127.0.0.1:8080` (configurable through APP_PORT). Responses use JSON. This local API has no login. The default boundary accepts only loopback Host names on configured ports and rejects foreign/cross-site browser mutations.

## Endpoints

| Method and route | Result |
| --- | --- |
| `GET /api/health` | `{"status":"ok"}` when a database query succeeds; 503 on a recognized database outage |
| `GET /api/workspace` | Consistent workspace envelope; `Cache-Control: no-store` |
| `POST /api/commands` | Applies one validated command and returns the confirmed envelope |

Envelope:

```typescript
interface WorkspaceEnvelope {
  state: AppState; // schemaVersion: 2, catalog, jobs, settings, events
  revision: number;
  isDemo: boolean;
  previousBackup: AppState | null;
  updatedAt: string; // ISO timestamp
  canUndo: boolean;
}
```

POST requires `Content-Type: application/json`. The command body limit is 66 MB (portable backup payloads are capped at 64 MB); import preview is capped at 10 MB; unknown request/command fields are rejected.

```json
{
  "expectedRevision": 0,
  "commandId": "a-new-uuid-for-this-action",
  "command": {
    "type": "job.create",
    "input": {
      "date": "2026-10-16",
      "lineId": "PM1",
      "orderNo": "EXAMPLE-001",
      "productCode": "DEMO-A",
      "description": "Example production",
      "bin": "B01",
      "mode": "bags",
      "bagCount": 200,
      "quantityMt": 10,
      "remarks": ""
    }
  }
}
```

Read the current revision first. Use a new command ID for a new action; retain the **same ID and identical command** for an uncertain retry. A duplicate can return a newer current workspace than the original response. Do not generate a new ID merely because the first response was lost.

## Commands

| Type | Additional fields |
| --- | --- |
| `job.create` | `input: JobInput` (all fields in the example required) |
| `job.update` | `jobId`, `patch: Partial<JobInput>` |
| `job.move` | `jobId`, `toLineId`, optional `beforeJobId`; omitted means append |
| `job.start` | `jobId`; start time is server-generated |
| `job.pause` | `jobId`, nonblank `reason` (trimmed, at most 1,000 characters); time is server-generated |
| `job.resume` | `jobId`; time is server-generated |
| `job.complete` | `jobId`, `actualQuantityMt`, optional `completionNote`; end time is server-generated |
| `job.recordActual` | `jobId`, `actualQuantityMt`, optional `completionNote`; preserves existing start/end |
| `job.cancel` | `jobId` |
| `job.reportIssue` | `jobId`, nonblank `reason` |
| `job.resolveIssue` | `jobId` |
| `job.confirmBin` | `jobId` |
| `job.copyBatch` | `sourceDate`, `targetDate`, `items: {sourceJobId, orderNo, quantity}[]`; 1–500 items |
| `catalog.create` | `input: {code, description, defaultMode}` |
| `catalog.update` | `productId`, `patch: Partial<{code, description, defaultMode}>` |
| `catalog.setActive` | `productId`, `active: boolean` |
| `settings.update` | complete `settings: Settings` |
| `workspace.restore` | `backup: AppState`; validates then replaces workspace with recovery copy |
| `workspace.resetDemo` | `date: YYYY-MM-DD`; replaces workspace with demo and retains recovery copy |
| `workspace.undoLastMove` | No additional fields |

Lines are `PM1` through `PM4`. Quantity mode is `bags` or `bulk`; use `bagCount: null` for bulk. Quantities must be finite and non-negative. Bagged MT is calculated using the configured bag weight. Scheduling and status constraints are checked server-side. See [domain types](../src/domain/types.ts) for complete settings/job/backup shapes.

Copy quantity is a discriminated object: `{mode: "bags", bagCount: 200}` or `{mode: "bulk", quantityMt: 10}`. Its mode must match the source. Dates must differ, sources must belong to `sourceDate`, and cancelled/duplicate source IDs and blank new order references are rejected. Cards are ordered by their original line/sequence, appended to `targetDate`, reset to pending and scheduled with current rules. Any invalid item or schedule collision rolls back the whole batch. Use the same request ID/content to retry an uncertain copy; the batch cannot partially persist.

Catalog codes are trimmed and unique ignoring case, including inactive products. Code length is at most 80, description at most 200; both are required. Create defaults to active; setActive controls availability. Stored products have `{id, code, description, defaultMode, active}`. Catalog changes do not rewrite existing job fields. Empty ordinary workspaces have no products; explicitly reset Demo workspaces include eight fictional products.

Database portable exports are version 3; offline planning exports remain version 2. `workspace.restore` also accepts strict version 1 JSON, normalizes its planning state to version 2 with an empty catalog, clears source links/Data, and preserves a recovery copy of the replaced workspace.

## Pause intervals and change history

Paused jobs keep `status: "running"` and optionally store `pauseIntervals: {pausedAt: string, resumedAt: string | null, reason: string}[]`. Only running jobs can pause/resume; at most the final interval may be open. Intervals are ordered, non-overlapping, start no earlier than actual start and end no later than actual end. Completing while paused closes the interval at the same timestamp as actual end. Clock regressions are rejected. Pausing does not change `lockedSegments`, release the line or recalculate planned utilisation. Copy omits all pause intervals.

Do not send pause/resume timestamps: unknown command fields are rejected. Both commands use normal revision checks, transactions, receipts and retry deduplication. A job accepts at most 10,000 pause intervals.

New activity may carry `changes: {field: string, before: string | number | boolean | null, after: string | number | boolean | null}[]`. These snapshots are derived from normalized persisted values. Unchanged fields and incidental timestamps are omitted; missing values use `null`. Move Undo stores the reverse changes. Settings changes record causal settings values, not every derived pending-job quantity. Large settings lists use bounded count/fingerprint summaries. At most 100 unique changed fields are accepted per event.

Existing jobs/events may omit these optional fields and remain readable in version 1 or 2 imports. The JSON schema version remains 2; no SQL migration is needed for the optional JSONB fields. Restore replaces activity along with the workspace. These records have no authenticated actor and are not an immutable compliance log.

## Errors

```json
{
  "error": {
    "code": "STALE_REVISION",
    "message": "The workspace changed. Refresh it before making another change.",
    "requestId": "server-generated-id"
  },
  "workspace": "latest envelope is included for STALE_REVISION"
}
```

| Status | Typical codes | Client handling |
| --- | --- | --- |
| 400 | `INVALID_COMMAND`, `INVALID_REQUEST`, `MALFORMED_JSON`, `INVALID_HOST` | Correct input/request; domain validation did not apply a change |
| 403 | `INVALID_ORIGIN`, `CROSS_SITE_REQUEST` | Use the local application or explicitly configured development origin |
| 409 | `STALE_REVISION` | Accept latest envelope, keep draft and review before submitting a new action |
| 409 | `COMMAND_ID_CONFLICT`, `UNDO_NOT_AVAILABLE` | Do not reuse an ID for different content; Undo may have expired |
| 413 / 415 | `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | Reduce input / send JSON |
| 503 | `DATABASE_UNAVAILABLE` | Reconnect, retaining the command ID for uncertain saves |
| 500 | `INTERNAL_ERROR` | Preserve the draft and retain request ID for diagnostics |

Do not infer a failed commit from a disconnected response: the database may have committed before the client lost the reply. Use the idempotent retry contract. Logs and public error responses do not expose connection URLs or SQL details.


## Source order data

- `GET /api/data`: `search`, `deliveryFrom`, `deliveryTo`, `unit` (`MT|Bags`), `productionStatus`, `deliveryStatus`, `overdue` (`production|pickup`), `importId`, `page`. Returns 50-row `items`, `page`, `total` and filtered `stats` across all matches. Current lead/pickup days are derived in MYT from the import as-of date.
- `GET /api/data/imports`: batch options (ID, file name, as-of date, import timestamp and row count).
- `GET /api/data/:id`: current fields, production/delivery status, linked card ID, deadline counts, review flag and immutable versions.
- `POST /api/data/preview`: `SourceImportInput` (`fileName`, `sheetName`, `digest`, `asOfDate`, normalized `rows`). Read-only validation/comparison; response has added/changed/unchanged totals and changed field names per row.
- `GET /api/backup`, `GET /api/backup/previous`: current or recovery portable version 3 backup. Data is fetched on demand, not in the live workspace response or Undo snapshot.

All source mutations use the existing `POST /api/commands` revision/command-ID envelope:

```ts
{ type: 'data.import', input: SourceImportInput }
{ type: 'job.createFromSource', input: { sourceOrderId, sourceOrderVersion, date, lineId, bin, remarks } }
{ type: 'data.setDeliveryStatus', sourceOrderId, delivered, reason? }
{ type: 'settings.activateCalendar', effectiveFrom, dayStart, availableHours }
{ type: 'job.start', jobId }
```

`job.start` rejects a client-supplied `actualStart`; the server timestamp is retained on retry. Import accepts up to 2,000 orders per transaction, validates every row before writes, and retains existing orders absent from the file. An order can be split across several cards; a combined card stores ordered source allocations. Imports only insert previously unseen DO + full-material identities; existing orders are skipped without new source versions or changed import dates. Source fields on linked cards cannot be changed through ordinary `job.update`; cancelled cards can be replanned. Delivery reopen requires a reason. Imported Done never invents actual production timestamps.

Database portable backup v3 is `{schemaVersion:3, exportedAt, planning:AppState, sourceData:{imports,orders,versions}}`. Restore validates the complete graph inside the transaction and retains both planning and source data as a recovery copy. Version 1/2 planning backups remain accepted and replace Data with an empty set. Live `AppState.schemaVersion` remains 2 for planning compatibility.

### Combined order production

```ts
{ type: 'job.createFromSources', input: { orders: [{sourceOrderId, sourceOrderVersion, plannedQuantity}], date, lineId, bin, remarks } }
{ type: 'job.combinePending', jobIds: [firstId, secondId], bin, remarks }
{ type: 'production.correctJobTotal', jobId, correctedTotalQuantity, reason, postingKey, occurredOn? }
```

Create accepts 1–500 unique order shares and derives the product, snapshots and card total on the server. Combine accepts 2–500 pending/unposted source cards on one date and line with identical product/packaging/bucket identity. It keeps the earliest card and cancels the other originals atomically. Stale versions, incompatible products and invalid allocations roll back the whole command. All normal revision checks and command receipts apply.

`Job.sourceAllocations[]` saves source ID, version, immutable source snapshot (including customer/date when available) and planned quantity in the source unit. Legacy singular source metadata remains readable. Portable backup v4 includes the optional allocation field and full production ledger. Import previews expose `skipped` and per-row `importAction: "insert" | "skip-existing"`; `changed` is informational and never authorizes overwrite.

`GET /api/inventory/jobs/:id/production` returns the physical card total and optional `orderTotals` split by source order; a `null` source ID identifies extra stock. Correcting a card total retains original postings and records the required reversal or additional receipt. A combined card is posted once and attributed in allocation order, with output beyond the allocated total becoming compatible stock.

Draft demand rows may include `sourceAllocationQuantity`: the actual order portion of physical `quantity`. Draft job `sourceAllocations` cannot exceed current unplanned order demand; their sum can be smaller than physical card quantity, with the balance becoming stock. Omit allocations for a pure stock continuation.
