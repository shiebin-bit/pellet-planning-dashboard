# Inventory and stock workflow

This document is the operational handoff for the inventory upgrade. It describes the current PostgreSQL-backed workflow for importing the daily stock workbook, reconciling orders to stock, generating a reviewable production draft, recording physical movements, and recovering the workspace.

## Scope and operating boundary

Orders and inventory are available in the database workspace on separate pages. Open **Orders** for orders and **Stock** for inventory:

| Page / tab | Use |
| --- | --- |
| **Orders → Orders** | Review SAP orders, stock reserved for each order, produced quantity, collected quantity, and quantity still to plan. Open an order to record production/collection and to review its import history. |
| **Stock → Stock** | View on-hand, reserved, and available stock by product and exact compatibility bucket. Manage the product policy, physical-count adjustments, receipts, returns, and rework. |
| **Stock → Daily stock** | Select a date and review the movement and closing balance for each product/bucket. |

The offline `dist/index.html` remains a planning-only workspace. It does not provide the inventory tabs or PostgreSQL stock ledger.

Company workbooks and raw customer/order identifiers must remain private. Use fictional fixtures in the public repository.

## Quantity and compatibility rules

Inventory items are either **Bags** or **MT**. They are separate units and are never silently converted from one item type to the other.

- A bag item must use a declared **25 kg** or **50 kg** bag weight. Quantities are whole bags, including in an imported order, stock movement, production receipt, collection, safety-stock target, and generated draft card.
- A bulk item is measured in **MT** with a precision of **0.001 MT**. Bulk items have no bag weight.
- Each inventory balance and reservation is keyed by material code plus the exact `Medication` and `FMR / OMED` values. Blank values are a real, separate compatibility bucket; they do not mean “match any value”.
- A physical movement cannot make a bucket negative. Corrections are audited ledger entries and reversals; existing movements are not edited in place.

The product policy is configured on **Stock**:

- `mto` / **Make for order** plans the shortage for each advice/order.
- `mts` / **Make for stock** uses a numeric safety-stock target after order demand has been considered.
- A product may have one default extra, either a fixed quantity in its unit or a percentage. The default is zero. The extra is calculated once against the unsplit demand, then the planner may split that demand across cards; it is not duplicated for every split card.
- A bag product must have its 25 kg or 50 kg weight confirmed before automatic planning. Items with an unknown policy do not receive automatic safety-stock replenishment. Explicit order shortages may be planned once their unit and bag weight are known.

A product safety-stock target applies to the standard (blank Medication/FMR) variant. Medication-specific and FMR-specific orders retain independent demand and reservations. Extra is grouped once per compatible product/bucket.

Example: if an exact bucket has 30 units available against a 100-unit order, an MTO demand has 70 units still to plan. For an MTS product with a numeric safety target of 20, the same order shortage plus replenishment to target is 70 + 20 = **90 units** to plan. The result is always expressed in the item’s own unit: whole bags for bags, or MT to three decimals for bulk.

## Daily workbook contract

Choose **Orders → Import Excel → Baseline import** for dated company worksheets such as `26th` or `27th`. Choose **SAP orders** for `bag order` / `bulk order` exports. These modes never silently switch based on the file. The reader uses cached cell values only: no VBA, formulas or external links are executed.

### Baseline import

Select one or more files and review them in ascending report-date order. R14 supplies the report date and must match the dated worksheet name. Finished-goods rows before row131 read B material, C description, D bag weight, F packaging, G Opening, H Production, I Received, J Sales return, K Rework, L Issue, M Closing and N Safety stock. Numeric safety selects MTS; PER ADVICE selects MTO; blank or unknown policies require review. Packing-bin summaries have no allocatable product detail and are excluded.

The lower order table is never read. Remark, DONE/OUT/CANCEL/HOLD, Medication and FMR/OMED there are ignored, even when malformed or missing dates. Baseline cannot create orders, update order status/reservations, or mark an order missing. Full material identity is retained for stock; short FS labels are display only.

With an empty ledger, the initial batch records the first Opening and the reported daily aggregate movements. Closing is checked using exact whole bags or 0.001MT. Discrepancies require an explicit reconciliation reason and adjustment. Historical aggregate production has no fabricated job or per-order attribution. Later imports retain raw reports and only change physical stock through confirmed count adjustments; they never replay an entire day's production and dispatch.

Previously stored historical observations remain available for audit, but a new Baseline import does not create or project order observations. Actual production and collection remain separate recorded actions.

### SAP orders

SAP sheets use A:I: Delivery, raw goods movement status, Goods Issue Date, sold-to, ship-to, full Material, Description, Delivery quantity, Sales Unit. Both `bag order` and `bulk order` are read when present. The server supplies Malaysia today and tomorrow; only Goods Issue Date equal to tomorrow is eligible. Old, later and invalid-date rows are counted and excluded before validating unrelated fields. Manual column mapping uses the same rule. No matches means no empty batch is saved.

The preview shows target Issue Date, matching Bags/Bulk rows and earlier/later/invalid exclusions. Dates are read-only. The server revalidates on commit; if midnight changes the day, keep the file and preview again. New identities are appended. Existing quantities, dates, execution status and manual fields remain unchanged, and differences enter the review queue. Missing orders are never deleted or assumed OUT. Each newly accepted order keeps its original batch target date and stable ordinal; a duplicate import never promotes its priority.

Import previews write nothing. Confirmation revalidates the batch under the workspace revision lock. Repeated files and network retries cannot replay inventory. Selected files and draft values stay available after a failed save or conflict.

## First import and later imports

1. Confirm that the selected mode has its required sheets: a dated daily sheet for Baseline, or bag/bulk order sheets for SAP. Confirm the dated sheet’s `R14` date and review the stock counts or next-day order/exclusion counts before saving.
2. Choose Baseline import for dated reports or SAP orders for append-only SAP exports; review the comparison.
3. Verify the target dates, eligible order counts and stock differences. Confirm a reason for any stock adjustment.
4. Review **Orders** and **Stock** after the import. Resolve missing bag weights, missing policies, incompatible units, and Medication/FMR mismatches before generating a draft.

Retained historical DONE/OUT describes readiness and collection only. Baseline no longer imports these statuses, and old raw status never creates an extra receipt or dispatch.

Order import recalculates reservations in due-date and status order. Reservation is a planning allocation, not a physical movement: on-hand still includes reserved stock, while available stock excludes it.

Existing manual planning cards are retained. Importing the workbook does not create cards and does not automatically backfill ledger entries for old manual cards. Record new physical production, collection, receipt, return, rework, or count corrections explicitly.

## Stock ledger and order progress

An order covered by compatible reserved inventory is **Stock ready**, not production completed. It remains uncollected until a collection is recorded, and creates no new production demand. The order summary and production filter distinguish Stock ready from actual or historically completed production. Reservations do not create production receipts.

Use the order detail panel and the Stock movement form for auditable postings:

| Action | Ledger effect |
| --- | --- |
| Import an order | Recalculates its reservation against the exact product/Medication/FMR bucket; no physical stock movement is posted. |
| Record production on a linked job | Adds the newly recorded production delta to physical stock in the job’s bucket and recalculates reservations. |
| Record a receipt from another source | Adds a `received` movement. A sales return adds a `return` movement; rework is a deduction. |
| Record a partial customer collection | Adds a negative dispatch/issue movement for only the collected quantity, reduces physical stock, and reduces the reservation. The collection cannot exceed the order remainder or its reserved quantity. |
| Record a stock-count adjustment | Adds a signed, reasoned adjustment. The resulting bucket balance must remain non-negative. |
| Correct a posted movement | Adds an auditable reversal/correction with a new posting key; it never rewrites the original entry. |

Production completion and customer collection are separate states. **Done** on a production card records production completion/output only. It does not prove that the customer collected the order. Collection may be recorded in parts; only the collected quantity is deducted. The final quantity collected sets the order to OUT automatically. Reversing a collection reopens the delivery when some quantity remains.

For a running card, use **Record production quantity** each day. Enter the new daily quantity; the service stores a cumulative production total and posts only the delta that has not already been received. When selecting **Done**, enter the final cumulative quantity, including quantities already recorded on previous days. The same unit rules apply: integer bags or MT to 0.001.

Stock adjustments, receiving, returns, rework, production receipts, collections, and corrections carry a date, exact compatibility bucket, posting key, and reason/note in the inventory ledger. Stock and order screens show recent entries; the full ledger is included in the database backup.

## Daily stock calculation

The **Daily stock** tab reports one row per product and exact Medication/FMR bucket. The operational balance is:

```text
Opening + Production + Received + Sales return - Rework - Issue + Adjustment = Closing
```

Daily stock retains each dated report and its reconciliation diagnostics. Ledger movements and subsequent reasoned corrections remain auditable.

## Generate planning draft

Select **Generate planning** from **Orders**. The draft generator is a preview and review workflow, not an automatic commit.

1. The default window starts at the current planning date (never before today) and ends three calendar days later. You may change the start/end dates, subject to the 31-day generation limit.
2. The queue is work in progress, unfinished earlier accepted batches, new accepted batches, then MTS replenishment. Within one batch the original import order is stable. Stock reservations, collected quantities and existing unreceived plans determine the remaining shortage; stock-ready orders awaiting collection are not planned again. HOLD, CANCEL and review-blocked orders are excluded. Legacy orders without acceptance metadata do not automatically enter the new-demand queue.
3. Compatible MTO orders with the same due date may share a batch, preserving per-order allocations. Capacity may split it across dates/PMs. Clear **Combine same-product orders with the same due date** to keep separate cards. Manual combining remains available.
4. An overdue pending card with no output or locked actual work is proposed as **Carry over** using its original card ID, quantity and order allocations. A started or posted card is **Continue** on its original PM, reserving only remaining production capacity. Continuation reservations are separate from historical locked segments. Receipts, Done or corrections invalidate an old preview and recalculate remaining capacity. Nothing moves merely because midnight passes. Unrelated confirmed future cards stay in place.
5. The planner uses saved rates, changeovers, working hours (default 07:00-19:00), exact-product PM preferences and downtime. Order priority wins, then earliest possible day, then preferred PM, then other PMs on that same day. Equal preferred PMs choose the earlier finish. Capacity shortage therefore diverts production before waiting another day for a preferred PM. Bags stay integer and Bulk stays 0.001 MT.
6. Review Continue / Carry over / New, original IDs, remaining quantities, dates, PMs, utilisation, late warnings and backlog. New-card quantities/dates/PMs remain editable. Confirm saves the batch atomically, including carryover-only proposals; a conflict preserves the draft for regeneration. Work that cannot fit remains unplanned.

Current-day drafts leave a rounded **5–10 minute review window** before their first available production start. Confirm before the displayed first proposed start. Once it passes, regenerate the retained draft using the remaining capacity; saving never silently moves a full-line card past its reviewed end time. Future-day proposals remain valid until their first proposed start unless the workspace changes. A definitive save rejection displays its server reason and keeps the draft. An uncertain network response must still be checked with its original request ID, even after the start time passes.

### Line preferences

Settings -> Production rules -> Line preferences supports enabling/disabling, search, add/edit/delete and the default PMs for unmatched products. These edits share **Save settings** and the unsaved-changes guard. Defaults are:

| Exact FS code | Packaging | Equal preferred PMs |
| --- | --- | --- |
| 5220, 5220M | Bags | PM1 |
| 5220 | Bulk | PM1, PM4 |
| 5811, 5211 | Bags | PM2 |
| 5210 | Bags | PM2, PM3 |
| 5210 | Bulk | PM2 |
| 5222 | Bags | PM2, PM4 |
| Unlisted product / packaging | Corresponding packaging | PM3 |

5220M, 5220MER and 5220CCB are distinct complete codes. Preferences never merge stock compatibility buckets or move existing cards. Changed rules apply when generating a fresh draft.

After confirmation, review the Planning board and destination bins. The generated cards remain pending until normal production execution records start, receipts, pauses, and Done.

## Backup and recovery

### Portable JSON

The database workspace’s **Settings → Workspace backup** download is schema version 7. It includes:

- planning cards, catalog, settings, activity, and execution history;
- the source graph: imported workbooks, source orders, immutable source versions, and links to planning cards; and
- inventory items/policies, baseline reports, exact-bucket orders/statuses, reservations, the complete ledger, posting keys, and corrections;
- import discrepancy reviews and receipt-based progress samples/reset evidence;
- retained daily history, accepted SAP batches/order ordinals, continuation reservations and exact-product PM preferences.

Restoring JSON is a reviewed **replace**, not a merge. Validation runs before the replacement, and the complete workspace that existed immediately before the replacement remains available as the previous recovery download.

Legacy schema versions **1–3** do not contain the inventory ledger. The restore preview must warn that restoring one clears current inventory and reservations. The previous full recovery copy is retained so the operator can download it before deciding whether to continue. Versions 4-7 inventory backups must be restored in the PostgreSQL workspace; offline localStorage remains planning-only.

Versions 1–4 have no review/progress collections. The restore preview warns before clearing those collections; v4 retains its inventory ledger.

Versions 1-6 remain readable. The preview warns that old backups have no accepted-batch or continuation records; old orders without acceptance metadata do not automatically join the new-demand queue.

### One-time operational reset

Use the private local maintenance procedure only after a full backup and a successful restore rehearsal in a separate database. Clear operational orders, schedules, stock balances and business history; retain catalog, stock-product parameters, safety/extra policies, capacities, working hours and other configuration. No public reset control is added. Do not replay old October files automatically. First import a new stock baseline, then eligible next-day SAP orders; Generate requires the stock baseline.

### PostgreSQL dump

For the full database backup path, run the existing command from the project directory:

```powershell
.\scripts\backup.ps1
```

It creates an ignored `backups/millplan-<UTC time>.dump` file using `pg_dump -Fc`. Keep protected copies outside the working checkout and agree retention and restore ownership with the company. The dump is the recovery path for database metadata, command receipts, migrations, source graph, stock, and ledger data that should not be reduced to a portable JSON file.

The local Docker/PostgreSQL development connection remains on loopback port **5434** for DataGrip. This inventory workflow does not change that local port or imply a company-server deployment.

## Data handling rules

- Treat the real SAP workbook and any customer/company export as private operational data. Never commit the source workbook, `.xlsx`/`.xlsm` derivatives, raw DO codes, screenshots containing identifiers, or database dumps to public GitHub.
- Use fictional material codes, customers, order numbers, and dates in tests and examples. The handoff excludes all raw company data).
- Review `git status` before a commit and keep source workbooks in a protected location outside the repository. The repository’s ignored extensions are a safeguard, not permission to force-add a file.
- No release, deployment, CI, or test-pass status is asserted by this workflow document. Use the project’s existing installation and disposable-database verification instructions when validating a change.

## Combined production cards

A production card can hold multiple source-order allocations for one exact product/unit/bag-weight/Medication/FMR bucket. **Plan from Orders** allows several orders and explicit per-order quantities. **Combine cards** merges pending source cards on the same date and line; the earliest card survives and the remaining originals are cancelled for history. Started or posted production cannot be combined.

The card is scheduled and counted once. Details and the Excel **Order allocations** sheet enumerate DO, customer, delivery and planned quantity. Partial production is attributed in saved allocation order; surplus is unassigned stock. Production correction reverses attributed quantities without replacing the original ledger. Cancelling pending cards releases all their allocations. Source-linked combined cards are excluded from Copy planning.

Short FS codes such as `5220` are display labels parsed from the description. Matching still uses the full material identity, so Bags, bulk and distinct materials never merge just because they share a short label.
