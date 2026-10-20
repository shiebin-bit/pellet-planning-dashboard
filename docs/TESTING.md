# Testing

Use Node 24.x. `npm ci` installs the lockfile exactly.

```powershell
npm test
npm run build
npm audit --omit=dev
```

The unit suite covers scheduling, quantities, frozen states, carry-over, conflicts, actual output, attention selection, report bounds, version 1/2 backup validation, recoverable storage, catalog uniqueness/snapshots/autocomplete, atomic copy, empty defaults and deterministic synthetic history.

The six synthetic-history cases cover a bounded fictional month, preserved source records and computed plans, frozen completed work, bags and output variance, chronological non-overlap, repeat imports, Malaysia date boundaries and unschedulable downtime. The administrator CLI defaults to a dry run and requires a demo workspace; verify its write path against a disposable database before changing import behavior. Check that an event-insert failure rolls back preceding job inserts, a concurrent revision change aborts the import, and a repeated import leaves both rows and revision unchanged.

## Real PostgreSQL API tests

These tests **truncate their configured tables**. Use a dedicated database with a separated `test` token in its name, such as `millplan_test`. The guard rejects the configured application database even if its credentials/query parameters differ. With no TEST_DATABASE_URL the suite skips; skipped tests are not a successful database verification.

```powershell
docker compose -f compose.yml -f compose.dev.yml up -d db --wait
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" millplan_test'
# Set TEST_DATABASE_URL privately to the matching loopback:5434/millplan_test URL.
npm run test:api
Remove-Item Env:TEST_DATABASE_URL
```

The API tests exercise concurrent revisions, invalid-command rollback, duplicate receipts, command-ID conflicts, move Undo, restore/recovery, demo reset, server timestamps and HTTP boundaries. They also test migration 003, catalog uniqueness/persistence and historical snapshots, plus whole-copy rollback, append ordering, reset fields and duplicate copy retry. They use real PostgreSQL. Keep DATABASE_URL pointed at the normal application identity and TEST_DATABASE_URL at a different disposable database; the guard deliberately rejects matching identities.

## Browser integration

`npm run test:browser` runs `tests/browser.cjs` and `tests/browser-efficiency.cjs`; both replace the entire selected workspace and restore the starting state in `finally`. Use a **separate disposable database/server**, never the real planning service. Create `millplan_browser_test` using the same `createdb` command as above with that database name. Copy `.env` to ignored `.env.browser-test`; change only its DATABASE_URL database path to `/millplan_browser_test`, keep HOST=127.0.0.1 and set PORT=8091. Build `dist` first.

```powershell
npx playwright install chromium
node --env-file=.env.browser-test --import tsx server/index.ts
```

In another terminal:

```powershell
$env:BROWSER_BASE_URL='http://127.0.0.1:8091'
$env:BROWSER_ALLOW_REPLACE='1'
npm run test:browser
Remove-Item Env:BROWSER_BASE_URL, Env:BROWSER_ALLOW_REPLACE
```

Installed Chrome is a fallback if the bundled Chromium is absent. `PLAYWRIGHT_CHANNEL=chrome` can select it explicitly. The suite closes its browser and saves ignored evidence under `output/playwright/database/`.

Its **12 workflow groups** cover:

1. Empty database loading and ignoring pre-existing browser-only records.
2. Add/edit confirmation and persistence across reload.
3. Whole-card movement, bin confirmation and server Undo.
4. Manual start, issue/resolve and Done with actual output/server time.
5. Stale edits require explicit reload and never recreate a remotely removed task.
6. Actual-output conflicts retain draft values until explicit reload and preserve completed timestamps.
7. Explicit reconnection cannot advance a draft's revision without a reload gate.
8. A lost successful response retries one command ID without duplicate production.
9. Network failure locks the originating form, does not show Saved, and recovers the same pending command.
10. History line filter, numeric Excel readback, PDF generation and settings conflict/reload/persistence.
11. JSON restore/demo reset retain recovery copies, reconcile intentional settings replacement and fit desktop/mobile layouts.
12. Initial connection failure blocks fallback and reconnects without page errors.

The efficiency suite adds catalog management/defaults/manual input and snapshot preservation, unsaved Settings isolation, cancelled-source exclusion, blank new orders, quantity/carry-over preview, copy append/reset, lost-copy-response recovery and stale-draft review. It verifies 124 History fixtures across three pages, combined filters, actual coverage, activity pagination, empty results, full Excel export while page 2 is displayed, and desktop/mobile layouts.

CI runs both suites on Ubuntu with PostgreSQL 16, Node 24 and Playwright Chromium. Browser tests use the CI-only database after the API suite.

## Release checks

Alongside the automated suites, verify the full Compose image starts healthy; records/revision persist after app and DB restarts; a real stopped DB returns 503 and recovers; and a custom-format dump restores to another database with matching records and metadata. Never use the application's actual data for destructive outage or fixture testing.

For the offline compatibility build, check four fitted horizontal lines at 1366×768, direct drag/insertion/Undo, retained input drafts, Done, report downloads, restore recovery, and 390px touch layouts. The delivery verification retained the existing 9 horizontal, 10 drag and 5 report/restore workflow groups. These local historical QA scripts/evidence are excluded from source because they use machine-specific paths; the portable database suite is committed.
