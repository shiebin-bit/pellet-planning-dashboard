# Testing

Use Node 24.x. `npm ci` installs the lockfile exactly.

`tests/browser-table-ux.cjs` adds fictional 57-row stock/history fixtures in the isolated test database. It checks synchronized top/bottom pagination, empty-filter recovery, bounded scrolling/sticky headers, horizontal controls at desktop/390/320px, bottom-row physical-count modal focus/scroll restoration, close-before-load cancellation, retained drafts and idempotent retry after a lost adjustment response. It also verifies independent planning/stock/history date labels and reads the downloaded quick Excel to prove empty History filters do not truncate a planning-day report. All fixtures/screenshots stay in ignored `output/playwright/table-ux`; the original test workspace is restored in `finally`.

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

`npm run test:browser` runs eleven scripts covering the base workflow, efficiency, pause/audit, UI, Data, inventory, table UX, Settings preview, list navigation, combined production and editable calendars. Mutation suites replace the selected workspace and restore the starting state in `finally`. Use a **separate disposable database/server**, never the real planning service. Create `millplan_browser_test` using the same `createdb` command as above with that database name. Copy `.env` to ignored `.env.browser-test`; change only its DATABASE_URL database path to `/millplan_browser_test`, keep HOST=127.0.0.1 and set PORT=8091. Build `dist` first.

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

Installed Chrome is a fallback if the bundled Chromium is absent. `PLAYWRIGHT_CHANNEL=chrome` can select it explicitly. Each suite closes its browser and saves ignored evidence under `output/playwright/database/`, `output/playwright/redesign/` or `output/playwright/data/`.

The original suite's **12 workflow groups** cover:

1. Empty database loading and ignoring pre-existing browser-only records.
2. Add/edit confirmation and persistence across reload.
3. Whole-card movement, bin confirmation and server Undo.
4. Current-time Start, issue/resolve and Done with actual output/server time.
5. Stale edits require explicit reload and never recreate a remotely removed task.
6. Actual-output conflicts retain draft values until explicit reload and preserve completed timestamps.
7. Explicit reconnection cannot advance a draft's revision without a reload gate.
8. A lost successful response retries one command ID without duplicate production.
9. Network failure locks the originating form, does not show Saved, and recovers the same pending command.
10. History line filter, numeric Excel readback, PDF generation and settings conflict/reload/persistence.
11. JSON restore/demo reset retain recovery copies, reconcile intentional settings replacement and fit desktop/mobile layouts.
12. Initial connection failure blocks fallback and reconnects without page errors.

The efficiency suite adds catalog management/defaults/manual input and snapshot preservation, unsaved Settings isolation, cancelled-source exclusion, blank new orders, quantity/carry-over preview, copy append/reset, lost-copy-response recovery and stale-draft review. It verifies 124 History fixtures across three pages, combined filters, actual coverage, activity pagination, empty results, full Excel export while page 2 is displayed, and desktop/mobile layouts.

The pause/audit suite covers required pause reasons, trusted time, locked plans and reload persistence; multiple pauses/resume; lost pause/resume replies with request deduplication; Done closing an open interval; stale drafts and explicit review; paused filtering and reason search; before/after quantities, moves, Undo, settings and catalog snapshots; legacy activity; cross-day downtime independent of planned segments; Excel numeric readback, daily clipping, complete range stops, print/PDF and responsive layouts; copying paused cards clears execution data; offline Undo appends reverse structured changes. Unit/API tests additionally reject invalid transitions, overlapping imported intervals, clock regression, duplicate/open intervals, stale revisions and command-ID misuse. Optional fields preserve legacy JSON/recovery compatibility.

The UI regression suite adds four-line board fit at 1366 × 768, first-screen Overview hierarchy, all six pages at 320/390/768/1440px, calendar/export/dialog/drawer bounds, keyboard focus and Escape, primary/status text contrast (4.5:1), and print visibility. It uses explicit demo fixtures and blocks browser writes after setup.

CI runs the complete suite on Ubuntu with PostgreSQL 16, Node 24 and Playwright Chromium. Browser tests use the CI-only database after the API suite.

## Release checks

Alongside the automated suites, verify the full Compose image starts healthy; records/revision persist after app and DB restarts; a real stopped DB returns 503 and recovers; and a custom-format dump restores to another database with matching records and metadata. Never use the application's actual data for destructive outage or fixture testing.

For the offline compatibility build, check four fitted horizontal lines at 1366×768, direct drag/insertion/Undo, retained input drafts, Done, report downloads, restore recovery, and 390px touch layouts. The delivery verification retained the existing 9 horizontal, 10 drag and 5 report/restore workflow groups. These local historical QA scripts/evidence are excluded from source because they use machine-specific paths; the portable database suite is committed.


The Data suite uploads fictional `.xlsx` files with all 13 screenshot fields, detects the header, validates the import preview and lost-response retry, checks 50-row paging and filtered statistics, creates whole-order MT/Bags cards from Data and the board, verifies immutable source fields and bag-weight snapshots, reimports changed quantities without overwriting production, separates Done from delivery, reads back backup v4 and checks mobile/dialog focus. Numeric identifier/date/formula/parser edge cases are covered by unit tests. No real SAP workbook was available, so real-file compatibility remains a first-import verification step.

Calendar/source tests cover 07:00–19:00 carry-over, cross-assigned-date queues, historical calendar selection, locked overlap rejection, source edit/copy protection, atomic import failure, revision conflict, command retry, delivery provenance, source-version compatibility and portable recovery. Test setup remains isolated from the deployed workspace.

The Excel Data release passes 96 unit tests across 17 files, 15 PostgreSQL API tests and 35 browser workflow groups across the five suites. Deployment also rehearses calendar activation against a copy of the latest workspace and compares every original job payload, catalog item and execution timestamp before and after activation.


## Inventory verification

The inventory suite uses only fictional workbook fixtures and a disposable PostgreSQL database. It covers exact reservation arithmetic, MTS safety stock and overproduction, multiple receipts and partial collections, cumulative production correction, delivery reversal, full OUT and reopening, historical DONE/OUT without replay, later-import policy preservation, physical-count differences, command retries, concurrent revision conflicts and atomic rollback. Domain tests cover 25kg/50kg snapshots, downtime, horizon capacity, split cards and append-only planning. Browser checks import a fictional XLSM, generate/review/save a draft, record partial output and collection, and verify the separate Stock navigation, direct-route reload, keyboard tab switching, Daily stock, backup v4 and 320/390px layouts. Screenshots and generated fixtures remain under ignored output/playwright/inventory.

Run API files serially (`--test-concurrency=1`) because they reset the same disposable test workspace. Never run API and browser mutation suites concurrently against one database.

Order/stock detail dialog regressions verify bottom-row opening, viewport bounds, background isolation, keyboard-reachable disclosures, scroll/focus restoration, in-dialog policy saving and status feedback, and transitions into planning or production details. The order picker is checked at1366/390/320px with bounded table scrolling, keyboard horizontal scrolling when needed, collapsible filters and a visible sticky planning action.

Main Orders-table checks use long fictional customer/product names at1920/1366/1024/390/320px: desktop columns fit without overflow, text remains within cells, narrow-layout scroll controls work and remain visible down the long list, and the page has no horizontal overflow.

## Insert-only imports and combined production

Due-date batch checks cover generating `5220(A+B) → 5811 → later 5220(C)`, switching the combine option, saving per-order quantities and showing due dates in the draft. Planner unit tests additionally cover four-line batching before assignment, 501-order allocation limits, compatible stock extras across split days, and full-material/Medication isolation. The UI suite checks visible card rows for intersections and clipping at 1640×900, 1366×768, 1366×650 and 390×844, including the short-height regression.

The combined-production suite uses fictional orders and stock in a disposable database. It checks same-product selection while disabling a different full material with the same FS display code, per-order quantity inputs, desktop/320px/390px dialogs, short display codes and retained full material IDs, partial receipts and Done without double posting, combining pending cards while retaining cancelled originals, Excel/print allocation details and portable backup round trips. Reimporting a changed existing order alongside a new one must leave its saved fields, source versions and ledger unchanged and add only the new order. Evidence stays under ignored `output/playwright/combined-production/`.

The order-details regression checks the prominent allocation section before schedule/actions, read-only customer/delivery hydration for legacy cards and every combine candidate, one visible modal, Escape/focus return, anchored selection, and a three-order merge. Both automatic command responses are deliberately lost before explicit retry; all attempts must use one command ID and preserve the selection without duplicate cards. Compatibility unit tests share the backend batch identity and cover full material, stock variants, duplicate sources and the aggregate 500-order boundary.

This release also checks generated extra output end to end: 30 MT on hand plus a 100 MT order and 20 MT extra produces a 90 MT card with a 70 MT order allocation. Editing stock extra changes the unscheduled-extra warning; saving and restoring retain the physical total and source allocation separately. Final local verification passed 121 unit tests, 30 PostgreSQL API tests and all ten browser scripts.

Fixed-action regressions verify drawer actions stay visible at 1366×650, 390px and 320px while details scroll, transient feedback does not cover the footer, the quantity shortcut focuses without posting, external form submits preserve native validation, and cancellation restores focus including the conflict path. Toolbar checks assert date/Add only on Overview and Planning, reports only on Overview/Planning/History, direct History range reports and Settings-only full backup. Orders precision fixtures assert seven main columns, nine picker columns, at least 14px primary text, 20.000 MT ordered versus 19.999 MT reserved and 0.001 MT to plan, expandable breakdowns and whole Bags.

Product/stock/mobile regressions cover FS display codes with full SAP identity retained, explicit and description-derived bag sizes, saved order packaging despite a different current stock-policy weight, standard-MTS shortage after reservations, and exclusion of MTO/Medication/FMR variants. Controlled browser responses test initial loading, service failure and retry, last-successful stock balances during refresh, optional product metadata failure without hiding daily balances, and hiding previous-date daily rows while a new date loads. Mobile checks verify four PM list groups, combined-card quantity and order count, Enter-to-open, reachable Move, focus return, no page overflow at 320px, switching back to four timeline tracks, and unchanged desktop fit. Unit coverage includes exact 0.001 MT replenishment arithmetic.

This UI release passed 126 unit tests, 30 PostgreSQL API tests and all ten browser scripts. Table checks also cover a Chrome overlay-scrollbar boundary where a reserved gutter could advertise horizontal scrolling even though the complete table was already visible; bounded scrolling, sticky headers and genuine horizontal controls remain verified on desktop and mobile.

## Editable working calendar

Calendar tests cover legacy materialization, repeated same-day changes, later effective periods, metadata tamper rejection, canonical history/backup validation and historical zero-capacity calendars. They preserve started/paused/completed locks, manual/API release constraints and unmarked old cards; server-managed inventory floors rebase, copies lose the marker and mixed combines retain the latest floor without gaining it. API tests exercise stale revisions, exact retries and failed calendar writes without partial persistence.

`tests/browser-calendar.cjs` edits an already activated calendar, reloads Settings, checks the board window and retained quantities/locks, compares 320 MT in an 8-hour day against 480 MT in a 12-hour day across four fictional 10 MT/hr lines, and accepts a 20:00 finish. A 22:00–06:00 shift with 01:00–02:00 downtime produces 280 MT and commits successfully; outside-window legacy warnings and 320/390px layouts are checked. Evidence stays under ignored `output/playwright/redesign/calendar/`. Final local verification passed 137 unit tests, 31 PostgreSQL API tests and all eleven browser scripts against a disposable database; production data was not used for mutation tests.
