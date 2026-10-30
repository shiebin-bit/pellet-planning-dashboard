# Millplan · Pellet Planning Dashboard

A production planning dashboard for four pelleting lines, with a shared PostgreSQL workspace, movable production cards, inventory reservations and Excel/PDF reports. Planners import SAP order lists and daily stock workbooks from Excel, or enter production manually. The dashboard stores source orders separately, creates linked production cards on request, and calculates sequence, duration and planned utilisation.

Built with React, TypeScript, Express and PostgreSQL 16. Docker Compose runs the application and database together.

![Four-line planning board connected to PostgreSQL, showing optional sample records](docs/assets/planning-board.png)

## Start on Windows

Install and open **Docker Desktop** with Linux containers enabled, then double-click **`OPEN-DASHBOARD.cmd`** (or the equivalent **`START-DASHBOARD.cmd`**). Both launch the Docker application backed by PostgreSQL. The first launch builds the image and creates a private `.env` with a random database password. It may take a few minutes.

Open **[http://127.0.0.1:8080](http://127.0.0.1:8080)**. A new database starts empty. Add your first production, or explicitly load sample records in Settings → Backup & recovery → Reset demo.

To stop, double-click **`STOP-DASHBOARD.cmd`**. Stopping or rebuilding containers preserves the PostgreSQL volume. **Do not run `docker compose down -v` against data you need.**

Equivalent PowerShell commands:

```powershell
.\scripts\setup.ps1
docker compose up --build -d --wait
docker compose stop
```

The default setup serves only this PC. It has no login or user roles. Company-wide access needs authentication, TLS, restricted database credentials and an agreed backup owner before deployment. A public source repository does not publish the running dashboard or its database; GitHub Pages cannot run this backend. The real SAP source workbook is private operational data and must never be committed to public GitHub.

## What it does

| Area | Features |
| --- | --- |
| Overview | Planned MT, recorded output with completion coverage, utilisation, completion, four line summaries, working-shift status timelines, recorded downtime by mill and items needing attention |
| Planning board | Four horizontal lines on desktop; mobile defaults to per-line production lists with a Timeline switch for dragging; Day/Full plan; carry-over; changeover and downtime; direct date/month/year selection |
| Planning batches | Due-date priority; optional same-product/same-due-date order batches with per-order quantities; capacity splits across lines/days; later-due batches stay separate |
| Card movement | Drag a pending card to another line or sequence; destination-bin review; recalculated line rate; one-step Undo; keyboard and held-touch movement |
| Production details | Same-product orders can share one card with separate allocations; Add/edit in a dialog; searchable product catalog with description/default delivery; manual products; bags or bulk, orders, bins, remarks and issues |
| Copy planning | Select manual cards by source date/line (linked Excel orders are excluded), enter fresh order references and adjusted quantities, preview target utilisation/carry-over, then append the batch atomically |
| Data | Customer orders, Excel worksheet/header mapping, insert-only Excel imports, saved-versus-Excel comparisons, retained raw order versions, quick views, searchable orders and expandable delivery/deadline filters; 50 rows per page |
| Stock | Separate Stock and Daily stock tabs; on-hand/reserved/available balances, exact standard-MTS replenishment shortage, explicit snapshot/baseline/count dates, loading/retry feedback, stock policies, physical-count dialogs and movement history |
| Inventory | Separate Bags/bulk stock, exact Medication/FMR compatibility buckets, MTO/MTS policy, reservations, auditable stock movements, daily balances and reviewable planning drafts |
| Actual production | Start records the current server time; running cards accept daily production receipts; Done asks for the final cumulative output and records the server's end time; later output corrections retain the original timestamps; pause/resume with reasons and recorded stop durations |
| History | Combined date/line/status/search filters; totals across all matches, actual-output coverage; records and activity in pages of 50; before/after changes for edits, moves, execution, settings and catalog |
| Table navigation | Stock, daily stock and production history use bounded scrolling, sticky headers/actions, horizontal controls and synchronized top/bottom pagination; date labels distinguish list filters from planning-day exports |
| Reports | Daily or up to 31 days; optional line selection; numeric Excel output with production-stop intervals; A4 landscape print/Save as PDF |
| Settings and backup | Product catalog with deactivate/reactivate; calendar, rates, bag weight and downtime; version 4 JSON backup including the source graph and full inventory ledger; workspace recovery; PostgreSQL dumps |

The bright workbench shows the planning date and Add production only on Overview and Planning board. Production exports are available on Overview, Planning board and History; History also has a direct Date range report button. Backups are in Settings → Backup & recovery. Overview puts daily totals and the four-line timeline first, followed by attention and output reconciliation. Line-capacity details and the next-task queue expand on demand; recorded downtime remains visible. The horizontal board fits all four mills on a 1366 × 768 display; forms and production details open over the current page. Navigation collapses to icons on tablets and a drawer on phones. Status colours always have text or accessible descriptions. Narrow planning cards show a full-code, quantity, order and dated-time preview on hover or keyboard focus; Escape dismisses the preview, Enter opens details, and Space retains keyboard dragging.

Production details keep Start, Record quantity and Done in a fixed bottom action bar. Record quantity focuses the partial-receipt form; Done opens the cumulative final-output form and keeps its confirmation visible while scrolling.

The main Orders table groups delivery/deadline and status/collection into seven columns. Expand Breakdown for reserved stock, produced, collected and scheduled quantities. Bags display as whole numbers; bulk MT keeps three decimals so a 0.001 MT shortage remains visible. The planning order picker retains its full nine-column view.

Orders, Stock and Daily stock use a shared product title such as **5220 · 25kg Bags** or **5220 · Bulk**, with the description and complete SAP material code below it. The FS code comes from the description; it is never sliced out of the material ID. Order packaging uses the saved description before the current stock policy. Unknown bag weights display Bags without guessing a size. Standard-MTS stock shows **Short X Bags/MT** against available stock; Medication/FMR variants are kept separate. Initial loads and errors never imply zero balances or a missing baseline. Refreshes keep the last successful balances with feedback; changing the Daily stock date hides the previous date until the new response arrives. Missing product descriptions do not prevent daily balances from loading.

On screens up to 600px, Planning opens a PM1–PM4 list showing product, packaging, status, native quantity, planned time, order count and changeover. Tap a row to use the existing production details and Move action, or switch to **Timeline** for dragging. The view choice lasts for the current app session. Desktop always keeps the horizontal board; both mobile views honor Day/Full plan and show unavailable periods.

Orders, Stock, Daily stock and History remember their own search, filters, page and scroll positions while navigating in the current app session. Stock also remembers its selected tab and Daily stock date. Changing a filter resets its list to page one; Clear filters restores all Orders. A browser refresh starts fresh. The board's order picker has independent filters. Orders offers All orders, Needs production (remaining shortage after stock reservations and unfinished cards), Ready for pickup (remaining order covered by reserved stock), and Needs review. These views combine with search and the collapsed Advanced filters; summary totals cover every matching page. Legacy orders without an inventory baseline use their linked-card/production status.

Settings has Workspace, Production rules, Unavailable periods, Products, Stock policies (database only), and Backup & recovery tabs. Drafts survive tab switches. The sticky Save settings bar applies only to workspace/rate/calendar drafts; catalog and stock changes save separately. Invalid planning settings reveal and focus their section before submitting. Navigating away from Settings still discards unsaved drafts.

Card colours: **gray** not started, **blue** running, **yellow** paused, **green** completed, **red** issue. Yellow stripes indicate changeover. Started/completed plans stay locked, and each line can have only one running production.

Database saves are confirmed before cards/forms show success. Concurrent stale changes keep the draft and require an explicit Reload latest before resubmitting. Uncertain saves keep the originating form open and offer Retry connection; retrying an acknowledged command cannot create a duplicate. Other changes refresh approximately every 15 seconds when no editor/details/settings draft is open.

## Excel orders → production → delivery

Open **Data → Import Excel**, choose an `.xlsx` file (up to 5 MB / 2,000 rows), then verify the worksheet, header row, column mapping, text-date format and **Excel as-of date**. The preview distinguishes new orders from existing orders that will be skipped. Differences show **Saved · retained** versus **Excel · skipped**. Existing orders keep their quantity, delivery date, description, raw status, manual fields, source version and original import date, even when the file differs. Zero, empty text and missing values remain distinct. Every error must be corrected before confirming the entire import. Import does not create production cards. The inventory feed variant is documented in [Inventory and stock workflow](docs/inventory-workflow.md).

The 13 columns are DO no, Delivery date, Sold to Party, Ship to Party, Material code, Description, Qty, Unit, Delivery lead days, Remark, Days of outstanding, Medication and FMR / OMED. Identifiers retain text/leading zeros. Units are MT or whole Bags. Formula cells require cached saved results; the app never evaluates formulas or external links. Date formats are selected explicitly. Use fictional workbooks in tests and examples; do not place the real source workbook, company/customer names or raw DO codes in this repository.

**DO no + full Material code** identifies an order. Import only adds unseen identities; existing orders and orders absent from a later file are retained. Choose **Plan production** on Data or **Plan from Data** on the board, then **Add same-product order** to put several compatible orders on one production card. Each order has its own planned quantity; details list its DO, customer, delivery date and saved allocation. **Combine cards** combines compatible, not-started source cards on the same date and line; original cards stay in History as cancelled records. Grouping requires the same full material, unit/bag weight and Medication/FMR bucket. Card totals, duration and utilisation count once. Production receipts are allocated to orders in saved order, with surplus entering stock. Source-linked cards cannot be copied.

Production titles read the short code from the description (for example `FS 5220 BROILER…` → `5220`), while the full SAP material code remains in details and is still the identity used for inventory and imports. Manual products without an FS code keep their entered code. Existing source-linked card allocations are read-only; cancel and replan pending work to change them. Started/completed cards retain their production data.

Order allocations appear at the top of production details: batch total and order count, then each DO, planned quantity, customer, delivery date and recorded production. **Combine with other cards** opens compatible pending cards beside the current selection; review each delivery date and choose which orders belong in the batch. Combining remains optional. Missing customer/delivery fields on older cards are displayed from the saved source order without rewriting the card's quantities or snapshots.

Production **Done** completes production only; it does not prove that the customer collected the order. Collection is recorded separately and can be partial, with only the collected quantity deducted from the matching stock bucket. In a dated inventory feed, raw `DONE` means production-ready/complete and raw `OUT` means historically fully collected; neither replays a historical production or delivery movement against the opening Closing baseline. A conflicting historical status is flagged for review and never creates fictitious actual timestamps. For inventory-tracked orders, record quantities collected and reverse mistaken collections with a reason. Legacy workspaces without a stock baseline retain their delivery confirmation controls. Recorded delivery time is the confirmation time, not necessarily the physical pickup time.

Delivery lead days is the number of calendar days until the delivery due date. Days of outstanding is 1 on the due date, 2 on the following date, and increases daily in MYT until full collection. Production readiness and delivery completion are independent.

The default production window is **07:00–19:00** on all four lines. Change **Planning day starts** and **Daily available hours** in Settings → Workspace, then save. The new window takes effect from the server's current Malaysia date. Pending work for today/future dates recalculates, with overflow continuing in the next working window; past-assigned plans and started/completed segments retain their prior calendar. A shift can cross midnight. Generate planning uses the saved window and downtime to split available capacity; regenerate the draft after changing hours. Saving settings preserves card quantities and does not add or delete cards. MT/hour determines each batch's production duration; daily hours determine how much fits in each shift. Actual Start, pauses and Done record action times independently of shift hours.

## Inventory quick examples

Inventory keeps Bags and bulk MT separate. Bag quantities are whole numbers with a 25 kg or 50 kg weight; bulk quantities use MT to 0.001. For an exact Medication/FMR bucket, **30 stock against a 100-unit MTO order leaves 70 to plan**. If the product is MTS with a numeric safety-stock target of 20, the order shortage plus replenishment is **70 + 20 = 90 to plan**. The default extra is 0; a fixed or percentage extra is applied once to the unsplit demand, not once per generated split card.

See [Inventory and stock workflow](docs/inventory-workflow.md) for the daily `bag order` / `bulk order` / dated-sheet contract, reservations, ledger movements, planning draft review, and schema version 4 recovery rules. Existing manual cards remain intact; importing inventory does not auto-backfill their ledger receipts.

## Historical demo records

For presentations, the administrator script can append explicitly fictional history to an existing **demo workspace**. Load the initial sample in Settings first if the workspace is empty. The script accepts up to 31 calendar days before today in Malaysia time, skips every date/line that already has records, preserves existing records and settings, and does nothing on a repeat import. It creates no automatic startup seed.

Preview from the project directory with Docker running:

```powershell
docker compose run --rm --no-deps `
  --volume "${PWD}/scripts:/app/scripts:ro" `
  --volume "${PWD}/src/domain:/app/src/domain:ro" `
  app node --import tsx scripts/seed-demo-history.ts `
  --dry-run --from 2026-09-20 --to 2026-10-19 --seed 20261020
```

After reviewing the counts and running `scripts/backup.ps1`, repeat with `--apply` in place of `--dry-run`. Import appends records in one revision-checked transaction and retains the preceding workspace as a recovery copy. It refuses non-demo workspaces. All generated products, orders, descriptions and activity are marked as fictional; they are not company or SAP records. A native development setup can use `npm run seed:demo-history --` with the same arguments and its private `DATABASE_URL`.

## Existing browser records

`OPEN-OFFLINE-DASHBOARD.cmd` opens the optional standalone **offline** `dist/index.html` after a build. It uses browser localStorage and the device clock. `OPEN-DASHBOARD.cmd` and `START-DASHBOARD.cmd` always start the HTTP application, which uses PostgreSQL and the server clock; these are separate workspaces.

To migrate: open the old offline dashboard in its original browser/path → Settings → Download backup. Open the database dashboard → Settings → Restore JSON backup → review → Replace workspace. This replaces rather than merges records, settings and activity. A copy of the preceding database workspace remains available for download after reload. Nothing is silently imported or seeded.

Database JSON version 4 includes planning, the complete source graph, imported orders, immutable source versions, job links, inventory policies, baseline reports, reservations and the full stock ledger. Offline backups remain planning-only. Version 4 backups containing inventory must be restored in the PostgreSQL workspace. Legacy versions 1–3 do not contain inventory; restoring one warns that current stock and reservations will be cleared, while the complete workspace immediately before the replacement remains available as a previous recovery copy. Catalog changes affect future input only: saved production records retain their details. JSON does not contain command receipts or database migrations. Use PostgreSQL dumps for full database recovery.

## Planning assumptions

- Default rates in MT/hour: PM1 8.5, PM2 7.5, PM3 6.5, PM4 7.0; PM2 uses 6.5 for prefixes 6811 and 6542.
- Default bags are 50 kg. Production hours = MT ÷ applicable rate.
- Different full material codes add changeover when either adjacent card comes from Data; two manual cards compare their first four product-code characters. The default changeover is 30 minutes.
- The default shift is 07:00–19:00 (12 hours). Saved working hours apply from today onward; overnight shifts and carry-over are supported. Historical assignments retain their recorded calendar.
- Downtime interrupts production/changeover and reduces availability. Work may carry into following days.
- Planned utilisation measures production inside the selected planning-day window divided by available time. It includes carry-over. Planned MT and report records are grouped by assigned planning date.
- Pausing records the server time and a required reason; Resume closes that interval. Done also closes an ongoing pause. Paused tasks retain their locked plan and occupy their line. Reporting an issue and recording a pause are separate actions.
- Recorded downtime sums only explicit pause intervals. Overview clips these to the selected working-day window across all records, including jobs assigned to earlier dates. Across mills the total is line-minutes, so two mills paused for 30 minutes contribute 60 minutes.
- Actual elapsed time includes stops; elapsed minus recorded stops is **not productive time or OEE**. Older tasks without pause intervals show zero recorded downtime, which does not prove there were no stops. Unknown actual MT remains blank, while known zero remains zero.
- Scheduling and display use Asia/Kuala_Lumpur, independently of the browser's time zone.
- Inventory quantities use whole bags for 25 kg/50 kg bag items and 0.001 MT for bulk items. Medication and FMR / OMED are exact compatibility buckets, including a separate blank bucket.
- Inventory MTO plans order shortages per advice; MTS replenishes a numeric safety-stock target after order demand. A product's fixed or percentage extra defaults to zero and is applied once before any card split.
- Daily stock follows `Opening + Production + Received + Sales return - Rework - Issue + Adjustment = Closing`. Later imports add only new orders by default. An explicitly confirmed physical-count import records previewed differences as adjustments and never replaces the ledger; production receipts add stock and partial collections deduct it.

The optional sample reflects the original prototype's product families/quantities and configurable planning assumptions. Its order references, site, bins, statuses and actual results are illustrative, not an SAP import. The private source-file scale is 443 order rows and 87 finished-goods stock items; no company/customer names, raw DO codes, source workbook, exported reports, credentials or local backups are committed.

## Development

Requires **Node.js 24.x**, npm and Docker. The Docker-only startup does not require Node on Windows.

```powershell
npm ci
.\scripts\setup.ps1
docker compose -f compose.yml -f compose.dev.yml up -d db --wait
npm run build
npm start
```

This runs the native API on port 8080, using PostgreSQL on loopback port 5434. In another terminal run `npm run dev` for Vite at [http://127.0.0.1:5178](http://127.0.0.1:5178). Its `/api` proxy targets port 8080. Keep the example `ALLOWED_ORIGINS` in `.env` for Vite. Stop the Docker **app** before running a native API on the same port. `npm run preview` previews assets only; use `npm start` for the complete built application.

On other operating systems, copy `.env.example` to `.env`, set a long random hex password and use that same password in `DATABASE_URL`, then run `docker compose up --build -d --wait`. Never commit `.env`.

## Verification

```powershell
npm test                  # domain, command, catalog, copy, backup, report and storage tests
npm run build             # frontend + server TypeScript and production HTML
npm audit --omit=dev      # deployed npm dependency audit
```

Real PostgreSQL API and browser suites require **disposable databases**. See [testing instructions](docs/TESTING.md). They cover persistence, concurrent revisions, rollback, retries, actual timestamps, reports, recovery and inventory workflows. Use the existing commands as verification steps; this README does not assert a passing test, deployment or CI result.

## Handoff documentation

- [Architecture and database](docs/ARCHITECTURE.md)
- [Command API](docs/API.md)
- [Startup, backup, recovery and troubleshooting](docs/OPERATIONS.md)
- [Testing and verification](docs/TESTING.md)
- [Inventory and stock workflow](docs/inventory-workflow.md)
- [中文操作说明](docs/USER_GUIDE.zh-CN.md)

The present scope is one shared workspace for a local pilot. Login/roles, named audit actors, scheduled backup service, external SAP reconciliation, and company-server deployment remain future work. The local Docker/PostgreSQL connection stays on loopback port 5434 for DataGrip. No open-source licence is granted by this repository.
