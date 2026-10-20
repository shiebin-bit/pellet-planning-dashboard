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

POST requires `Content-Type: application/json`. The maximum body size is 10 MB; unknown request/command fields are rejected.

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
| `job.start` | `jobId`, `actualStart`: ISO timestamp with an explicit offset |
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

Workspace exports are version 2. `workspace.restore` also accepts strict version 1 JSON, normalizes it to version 2 with an empty catalog, and preserves a recovery copy of the replaced workspace.

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
