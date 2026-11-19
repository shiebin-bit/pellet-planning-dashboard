# Command API

Default base URL: `http://127.0.0.1:8080` (configurable through APP_PORT). Responses use JSON. This local API has no login. The default boundary accepts only loopback Host names on configured ports and rejects foreign/cross-site browser mutations.

## Endpoints

| Method and route | Result |
| --- | --- |
| `GET /api/health` | `{"status":"ok"}` when a database query succeeds; 503 on a recognized database outage |
| `GET /api/inventory/production-summary?date=YYYY-MM-DD` | Repeatable-read `{revision,date,netQuantityMt,jobCount,unconvertedCount}`; exactly one valid date, no other filters |
| `GET /api/workspace` | Consistent workspace envelope; `Cache-Control: no-store` |
| `GET /api/operations-summary` | Read-only repeatable-read `{revision,serverNow,asOfDate,dueSoonThrough,counts,freshness}`; rejects all query parameters |
| `GET /api/backup/status` | Read-only automatic portable-backup status; rejects all query parameters; no filesystem paths or backup payloads |
| `POST /api/commands` | Applies one validated command and returns the confirmed envelope |

Envelope:

The operations summary captures one MYT date and counts all matching rows, independently of pagination. `counts.overdueToPlan` matches `/api/data?view=needs-production&deliveryTo=<yesterday>`; `dueSoon` matches pending delivery orders between `asOfDate` and `dueSoonThrough` (today + 3, inclusive). `stockShortages` counts standard blank-Medication/FMR MTS products whose available stock is below a non-null safety target; missing standard buckets count as zero stock and other variants cannot offset them. `pendingImportReviews` counts pending review rows. Freshness includes `latestOrderImport: {asOfDate,importedAt} | null`, `newestExcelAsOfDate`, `inventoryBaselineDate` and `lastVerifiedStockCountDate`. A late upload of an older file can therefore have a newer upload time and an older file date. This endpoint writes no records and changes no revision.

Automatic-backup status returns `enabled`, `format: "portable-v7"`, `intervalHours`, `retentionCount`, `state` (`disabled`, `idle`, `running` or `degraded`), `lastAttempt: {at,result,code?,sanitizedMessage?} | null`, `lastSuccess: {at,fileName,bytes} | null` and `nextAttemptAt: string | null`. Attempt results are `success`, `failed` or `success_with_warning`. UTC timestamps are formatted as MYT in Settings. Failure is operational status, not a business-data mutation or a failed database health check. No HTTP trigger, deletion or stored-file listing endpoint is provided; manual export and previewed restore continue through the existing backup flow.

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

Working hours remain editable through `settings.update`, including after legacy calendar activation. Changing `dayStart` or `availableHours` creates or replaces today's MYT calendar period using the transaction timestamp; callers must preserve the returned `calendarHistory` / `calendarCutover` metadata unchanged. Earlier assigned-day calendars and started/paused/completed locked segments are retained. Newly committed inventory drafts have a server-owned `calendarManagedRelease` field so their pending release floors can follow later hours changes; public job create/update inputs cannot write it. Manual and unmarked older release floors are preserved. Generate and review a fresh planning draft after changing hours; the save does not add or delete production cards.

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

- `GET /api/data`: `search`, `deliveryFrom`, `deliveryTo`, `unit` (`MT|Bags`), `productionStatus`, `deliveryStatus`, `overdue` (`production|pickup`), `importId`, `page`. Returns 50-row `items`, `page`, `total` and filtered `stats` across all matches. Current lead/pickup days use the Malaysia calendar and saved Issue Date; raw imported day counts remain available separately.
- `GET /api/data/import-context`: server-authoritative `{asOfDate,targetIssueDate,timeZone:"Asia/Kuala_Lumpur",revision}`. Dates are Malaysia today and tomorrow; no client date override is accepted.
- `GET /api/data/imports`: batch options (ID, file name, as-of date, import timestamp and row count).
- `GET /api/data/:id`: current fields, production/delivery status, linked card ID, deadline counts, review flag and immutable versions.
- `POST /api/data/preview`: `SourceImportInput` (`fileName`, `sheetName`, `digest`, `asOfDate`, normalized `rows`). Read-only validation/comparison; every row must have Goods Issue Date (`deliveryDate`) equal to server tomorrow and `asOfDate` equal to server today. Response includes `asOfDate`, `targetIssueDate`, added/changed/unchanged totals and changed field names. `409 IMPORT_TARGET_DATE_CHANGED` requires reloading context and re-previewing the retained file.
- `GET /api/backup`, `GET /api/backup/previous`: current or recovery portable version 7 backup. Data is fetched on demand, not in the live workspace response or Undo snapshot.

All source mutations use the existing `POST /api/commands` revision/command-ID envelope:

```ts
{ type: 'data.import', input: SourceImportInput }
{ type: 'job.createFromSource', input: { sourceOrderId, sourceOrderVersion, date, lineId, bin, remarks } }
{ type: 'data.setDeliveryStatus', sourceOrderId, delivered, reason? }
{ type: 'settings.activateCalendar', effectiveFrom, dayStart, availableHours }
{ type: 'job.start', jobId }
```

`job.start` rejects a client-supplied `actualStart`; the server timestamp is retained on retry. Import accepts up to 2,000 orders per transaction, validates every row before writes, and retains existing orders absent from the file. An order can be split across several cards; a combined card stores ordered source allocations. Imports only insert previously unseen DO + full-material identities; existing orders are skipped without new source versions or changed import dates. Source fields on linked cards cannot be changed through ordinary `job.update`; cancelled cards can be replanned. Delivery reopen requires a reason. Imported Done never invents actual production timestamps.

Legacy database portable backup v3 is `{schemaVersion:3, exportedAt, planning:AppState, sourceData:{imports,orders,versions}}`. Restore validates the complete graph inside the transaction and retains both planning and source data as a recovery copy. Version 1/2 planning backups remain accepted and replace Data with an empty set. Live `AppState.schemaVersion` remains 2 for planning compatibility.

### Combined order production

```ts
{ type: 'job.createFromSources', input: { orders: [{sourceOrderId, sourceOrderVersion, plannedQuantity}], date, lineId, bin, remarks } }
{ type: 'job.combinePending', jobIds: [firstId, secondId], bin, remarks }
{ type: 'production.correctJobTotal', jobId, correctedTotalQuantity, reason, postingKey, occurredOn? }
```

Create accepts 1–500 unique order shares and derives the product, snapshots and card total on the server. Combine accepts 2–500 pending/unposted source cards on one date and line with identical product/packaging/bucket identity. It keeps the earliest card and cancels the other originals atomically. Stale versions, incompatible products and invalid allocations roll back the whole command. All normal revision checks and command receipts apply.

`Job.sourceAllocations[]` saves source ID, version, immutable source snapshot (including customer/date when available) and planned quantity in the source unit. Legacy singular source metadata remains readable. Portable backup v4 includes the optional allocation field and full production ledger. Import previews expose `skipped` and per-row `importAction: "insert" | "queue-review" | "skip-unchanged"`; `changed` is informational and never authorizes overwrite.

`GET /api/inventory/jobs/:id/production` returns the physical card total and optional `orderTotals` split by source order; a `null` source ID identifies extra stock. Correcting a card total retains original postings and records the required reversal or additional receipt. A combined card is posted once and attributed in allocation order, with output beyond the allocated total becoming compatible stock.

Draft demand rows may include `sourceAllocationQuantity`: the actual order portion of physical `quantity`. Draft job `sourceAllocations` cannot exceed current unplanned order demand; their sum can be smaller than physical card quantity, with the balance becoming stock. Omit allocations for a pure stock continuation.

`POST /api/inventory/draft` accepts optional boolean `combineSameProduct` (default `true`). Adjacent compatible MTO orders in accepted priority order are grouped within the same due date before line allocation; each card retains its source allocations, with at most 500 orders per card. Grouping never pulls a later order ahead of intervening demand. Different due dates remain separate batches. `false` keeps separate order cards. Queue priority is in-progress continuation, unfinished earlier accepted batches, newly accepted batches, then MTS; batch order is stable. The response includes `carryovers` and `carryoverBacklog` in addition to new `jobs`, demand/backlog, utilisation and late warnings. Generation is read-only; it only proposes changes to eligible existing cards.


## Overview receipt summary and planning previews

Production summary counts `production` movements and reversals of production by ledger `occurred_on`. Imported baseline production, receipts of other types, dispatch and stock adjustments are excluded. MT uses the immutable movement snapshot (or original production snapshot on reversal); bag conversion uses saved weight, never today's stock policy. Unknown bag conversions are omitted from net MT and counted in `unconvertedCount` (movement entries). `jobCount` counts distinct linked jobs, including a job whose net receipt is zero. The returned workspace revision identifies the same read snapshot; the client reconciles a mismatch before displaying it with planning metrics.

Move review is a pure client-side calculation using shared scheduling rules and current order deadlines from the same revision. Confirm sends the existing `job.move` command with the unchanged workspace version guard. Deadline risk uses Malaysia calendar finish date, matching Generate planning.

Generated drafts use browser-local storage key `millplan.planning-draft.v1`, with a strict version1 parser and 8 MB limit. There is no new server draft endpoint or database schema change. Saved drafts retain their base revision/timestamp; a changed workspace or passed planning date requires regeneration. Before `planning.commitDraft`, the exact command ID, expected revision and body are persisted. Reload retries reuse them so the command receipt resolves an already-committed result before stale checking. Local storage uses best-effort instance/timestamp/fingerprint checks and storage events for other tabs; it is not an atomic multi-user draft service. Workspace backup is version5 and does not include this browser-local draft.

## Date-specific line hours, progress and import reviews

`settings.replaceWorkingHoursOverrides` accepts `{date, lines:[{lineId,dayStart,availableHours}], reason}`. It atomically replaces exceptions for one current/future MYT date; omitted lines inherit the effective calendar, `availableHours:0` closes a line and an empty list clears that date. Server-owned activation metadata, canonical date/line uniqueness, interval validation, revision checks and command receipts apply. `settings.update` cannot replace this metadata. Pending work and inventory drafts resolve each future date/line window independently; locked execution segments remain absolute.

`GET /api/inventory/production-progress?jobId=a&jobId=b` accepts 1–100 unique IDs and returns `{revision,serverNow,jobs}` from one repeatable-read snapshot. Each job has native-unit `plannedTotal`, nullable `actualTotal`, trusted/untrusted samples, nullable `estimate` and `estimateUnavailableReason`. Actual totals are net ledger receipts. Live estimates require three increasing trusted samples across at least 15 active minutes, latest within 20 minutes, a running/unpaused card below target, and its locked plan end. Corrections append estimate-reset events; completion samples do not qualify. Estimates label ahead/on-plan/late with a five-minute tolerance.

`GET /api/data/reviews?status=pending&page=1` returns 50-row pages, filtered total and per-status counts. `GET /api/data/reviews/:id` returns current/candidate fields, observed/current source versions, protected fields and provenance. Existing import rows use `importAction:"queue-review"` for changed candidates or `"skip-unchanged"`; only unseen identities use `"insert"`.

Commands `data.applySourceCorrection {reviewId,expectedSourceVersion,selectedFields,reason}` and `data.dismissSourceCorrection {reviewId,expectedSourceVersion,reason}` use the ordinary versioned command envelope. Apply verifies the pending candidate and source version under lock, permits only selected safe fields, recalculates compatible reservations and creates an immutable source version. DO/material/unit identity, protected manual fields and quantity with reservations/execution cannot be replaced. Stock movements, old allocations and card snapshots are not replayed or rewritten. An obsolete review can be dismissed against the current source version. Duplicated semantic imports backfill missing review candidates without replaying inventory.

Portable database backup V7 is `{schemaVersion:7,exportedAt,planning,sourceData,inventory,productionProgress,baselineHistory,dailyPlanning}`. The complete reference graph is validated and the previous workspace is retained transactionally. `dailyPlanning` contains `admissionBatches`, `orderAdmissions` and `continuationReservations`; `planning.settings.linePreferences` stores routing preferences. Planning `AppState` and offline export remain version 2. V1-V6 restore remains supported; missing admission metadata does not silently admit legacy orders into automatic new demand.

## Stock-only Baseline, next-day SAP and split cards (V7)

`POST /api/inventory/daily-import/preview` accepts `{reports: StockReportInput[]}` and returns revision, file/date/stock counts, formula/continuity/count differences, warnings and `requiresReconcile`. It is read-only and does not inspect or project orders. `GET /api/data/:id/observations` reads retained historical observations; new stock-only imports do not append them.

New revision-checked `/api/commands` variants:

```typescript
{type:'inventory.importStockReports', reports:StockReportInput[], reconcile:boolean, reason:string}
{type:'data.importBatch', inputs:SourceImportInput[]}
{type:'data.setPlanningControl', sourceOrderId:string,
 action:'release'|'hold'|'cancel'|'historicalDone'|'historicalOut', reason:string, stockAccounted?:boolean}
{type:'job.splitPending', jobId:string, groups:Array<{
 date:string, lineId:'PM1'|'PM2'|'PM3'|'PM4', bin:string, remarks:string,
 allocations:Array<{sourceOrderId:string,plannedQuantity:number}>, unallocatedQuantity:number
}>}
```

A stock report includes `fileName`, SHA-256 `digest`, `sheetName`, `asOfDate` and `stockRows` only. Stock rows carry exact unit/bag-weight/policy and all reported daily movements. `orderRows` is excluded from the new command; the legacy daily-report entry only tolerates an empty array and cannot import orders or trigger missing-order checks. Reports in one batch need unique ascending dates. Stock differences require explicit reconciliation and a nonblank reason; existing ledger history is never replayed.

SAP `data.import` and `data.importBatch` enforce next-day dates server-side, including manually mapped files. They reject empty/mixed-date batches. DO + complete material identifies an order; duplicates retain saved quantity/date/status/manual fields, changed candidates enter review, and missing identities are not deleted. New identities record accepted batch target date and ordinal; duplicate retries retain original priority.

A split creates2–500 nonempty pending children with server-owned `derivedFromJobId`. Quantities use whole Bags or0.001MT; every source allocation and unallocated quantity must balance exactly. Dates/lines/bin/remarks may vary, product and saved source facts cannot. The original is cancelled and retained; its actual output/stock is never changed. Unstarted cards with posted output or locks are rejected. Same-order split portions can recombine only with matching saved source version and snapshot. All validation, child persistence, audit, revision and retry receipts commit together.

Database and automatic backups export V7 and retain validated legacy V5/V6 recovery files. Older restore previews warn about omitted acceptance/continuation history. Historical observations, controls and split lineage remain restorable; a new Baseline never adds order history.

### Reviewed carryovers and PM preferences

`planning.commitDraft` accepts `{type:'planning.commitDraft',previewRevision,jobs:InventoryDraftJob[],carryovers:DraftCarryover[]}`; at least one new job or carryover is required. A carryover contains `jobId`, `kind:'reschedule'|'continuation'`, native `remainingQuantity`, `unit`, original date/line, priority date/ordinal, proposed `date`, `lineId`, `notBefore` and reserved `segments`. All values are revalidated against current stock, actual output and capacity in the same revision-checked transaction. Network retries use the original command ID.

`reschedule` retains the pending card ID, quantity and allocations, and may span several selected days without splitting or cloning the card. `continuation` retains the card's original PM, actual timestamps and locked historical segments; its remaining-capacity reservation is stored separately and cleared/recomputed after actual updates. Zero reservations suppress obsolete unlocked capacity after posted output, including corrected-to-zero receipts; they do not count as new production. Partial capacity leaves a backlog. Other confirmed future cards stay unchanged. Generation at midnight does not itself move cards.

`settings.update` accepts optional `settings.linePreferences = {enabled,defaultPreferredLines,rules:[{fsCode,packaging:'Bags'|'Bulk',preferredLines}]}`. Codes are complete case-normalized FS tokens, never material substrings; rules are unique per code/packaging and each PM list has 1-4 distinct entries. Demand priority wins, followed by earliest day, preferred PM and same-day overflow PM. Equal preferred PMs use earlier completion. See [inventory workflow](inventory-workflow.md#line-preferences) for the default table.

The one-time operational reset is local maintenance only, after backup and restore verification. No HTTP reset endpoint is introduced. Configuration/catalog/item policy survives; new stock must be imported before automatic generation. DataGrip's loopback port remains 5434.
