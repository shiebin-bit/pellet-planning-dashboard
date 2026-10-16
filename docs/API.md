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
  state: AppState; // schemaVersion, jobs, settings, events
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
| `job.complete` | `jobId`, `actualQuantityMt`, optional `completionNote`; end time is server-generated |
| `job.recordActual` | `jobId`, `actualQuantityMt`, optional `completionNote`; preserves existing start/end |
| `job.cancel` | `jobId` |
| `job.reportIssue` | `jobId`, nonblank `reason` |
| `job.resolveIssue` | `jobId` |
| `job.confirmBin` | `jobId` |
| `settings.update` | complete `settings: Settings` |
| `workspace.restore` | `backup: AppState`; validates then replaces workspace with recovery copy |
| `workspace.resetDemo` | `date: YYYY-MM-DD`; replaces workspace with demo and retains recovery copy |
| `workspace.undoLastMove` | No additional fields |

Lines are `PM1` through `PM4`. Quantity mode is `bags` or `bulk`; use `bagCount: null` for bulk. Quantities must be finite and non-negative. Bagged MT is calculated using the configured bag weight. Scheduling and status constraints are checked server-side. See [domain types](../src/domain/types.ts) for complete settings/job/backup shapes.

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
