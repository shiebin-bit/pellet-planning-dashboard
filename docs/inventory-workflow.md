# Inventory and stock workflow

This document is the operational handoff for the inventory upgrade. It describes the current PostgreSQL-backed workflow for importing the daily stock workbook, reconciling orders to stock, generating a reviewable production draft, recording physical movements, and recovering the workspace.

## Scope and operating boundary

Orders and inventory are available in the database workspace on separate pages. Open **Data** for orders and **Stock** for inventory:

| Page / tab | Use |
| --- | --- |
| **Data → Orders** | Review SAP orders, stock reserved for each order, produced quantity, collected quantity, and quantity still to plan. Open an order to record production/collection and to review its import history. |
| **Stock → Stock** | View on-hand, reserved, and available stock by product and exact compatibility bucket. Manage the product policy, physical-count adjustments, receipts, returns, and rework. |
| **Stock → Daily stock** | Select a date and review the movement and closing balance for each product/bucket. |

The offline `dist/index.html` remains a planning-only workspace. It does not provide the inventory tabs or PostgreSQL stock ledger.

The source-file scale used for the handoff is described only as **443 order rows and 87 finished-goods stock items**. Do not put the source workbook, customer/company names, or raw DO codes in this repository, screenshots, fixtures, or public GitHub history.

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

Use **Data → Import Excel** in the PostgreSQL workspace. The feed adapter accepts the saved cell values of `.xlsx` and `.xlsm` workbooks; it does not run VBA, evaluate formulas, follow external links, or use scratch calculations.

The workbook must contain these exact worksheet names (case and surrounding spaces are normalized):

- `bag order`
- `bulk order`
- one dated daily-stock sheet such as `18th`

### Order sheets

Both order sheets use the SAP core order range **A:I**. Rows start at row 2. The adapter reads the DO number, raw goods-movement status, delivery date, sold-to party, ship-to party, material code, description, delivery quantity, and sales unit from that range. A delivery quantity in a bag sheet must be an integer; bulk quantity is MT to 0.001. A DO + material pair must be unique within each order sheet. SAP item numbers are required when otherwise identical rows need to be distinguished.

The raw status is retained with the immutable source order version. It is not replaced by the dashboard’s interpreted status labels. `DONE` and `OUT` are interpreted for inventory planning as described below.

### Dated daily-stock sheet

The dated sheet supplies the physical baseline and historical annotations:

- `R14` is the workbook as-of date.
- Finished-goods rows in the first 130 rows identify the material, description, bag/bulk mode, bag weight where applicable, opening, production, received, sales return, rework, issue, and closing quantities. A numeric safety-stock value selects MTS; a blank safety-stock value leaves the item MTO and marks it for policy review.
- `G130`, when present, is the packing-bin total. It is retained as a **reference only** and is excluded from allocatable finished-goods stock.
- Historical annotation rows begin at row 131. The adapter reads the dated sheet’s order annotation fields (DO in column C, material in column L, remark in column S, Medication in column V, and FMR / OMED in column W). These manual Medication/FMR values are preserved on later imports and are not overwritten by a later blank feed value.
- Columns X and Y are not part of the contract. Do not use them as scratch fields or depend on them for import behavior.

The importer only needs the contract fields above. Keep any other workbook presentation, formulas, or helper cells out of the reconciliation decision.

## First import and later imports

1. Confirm that the workbook has `bag order`, `bulk order`, and one dated daily sheet. Confirm the dated sheet’s `R14` date and review the order and stock counts before saving.
2. On the first inventory import, select **Establish opening inventory from [as-of date] Closing**. This creates the physical baseline from the dated sheet and checks the baseline balance for every product/bucket.
3. On a later import, leave the baseline option off. The import updates the source orders, versions, raw statuses, product descriptions, and manual annotations; it does **not** replace physical stock. To reconcile a later verified count, select **Reconcile physical Closing**, review the per-product ledger/count differences and confirm the reasoned adjustments.
4. Review **Orders** and **Stock** after the import. Resolve missing bag weights, missing policies, incompatible units, and Medication/FMR mismatches before generating a draft.

The dated baseline is a count boundary. A historical `DONE` row means production was complete before tracking began; it does not create a second production receipt. A historical `OUT` row means the order was fully collected before tracking began; it does not create a dispatch or replay a historical delivery. The 18 October Closing baseline is therefore not replayed through historical `DONE`/`OUT`/other annotations.

Order import recalculates reservations in due-date and status order. Reservation is a planning allocation, not a physical movement: on-hand still includes reserved stock, while available stock excludes it.

Existing manual planning cards are retained. Importing the workbook does not create cards and does not automatically backfill ledger entries for old manual cards. Record new physical production, collection, receipt, return, rework, or count corrections explicitly.

## Stock ledger and order progress

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

The imported baseline day retains the reported workbook totals after the baseline balance check. Later dates are derived from posted ledger movements. Use a count adjustment when a physical count differs from the running ledger; do not re-import the same historical count as a new production or delivery event.

## Generate planning draft

Select **Generate planning** from **Data**. The draft generator is a preview and review workflow, not an automatic commit.

1. The default window starts at the current planning date (never before today) and ends three calendar days later. You may change the start/end dates, subject to the 31-day generation limit.
2. Overdue orders are included. Within the draft, due/order demand is prioritized before MTS safety-stock replenishment. Demand is grouped by exact material, Medication, and FMR / OMED compatibility.
3. The planner considers all four lines (**PM1–PM4**), the active production rates, changeovers, the default **07:00–19:00** work window, carry-over, and configured downtime. Existing non-cancelled tasks remain in place; new tasks append after existing work and never move or rewrite an existing task.
4. Bag demand is split only into integer bag quantities. Bulk demand remains at 0.001 MT precision. Each proposed card keeps its production purpose (`mto` or `mts`), source order where applicable, compatibility bucket, date, line, and not-before time.
5. Review and edit the proposed dates, lines and quantities; confirm bins on the board after saving. Review the capacity/late warnings and the unscheduled backlog. A draft may be regenerated after a workspace conflict.
6. Select **Confirm N cards** only after the preview is acceptable. Nothing is saved by generating or editing the preview; only confirmation appends the reviewed cards. If capacity is insufficient, the remaining demand stays in the backlog for review rather than being silently committed.

After confirmation, review the Planning board and destination bins. The generated cards remain pending until normal production execution records start, receipts, pauses, and Done.

## Backup and recovery

### Portable JSON

The database workspace’s **Settings → Workspace backup** download is schema version 4. It includes:

- planning cards, catalog, settings, activity, and execution history;
- the source graph: imported workbooks, source orders, immutable source versions, and links to planning cards; and
- inventory items/policies, baseline reports, exact-bucket orders/statuses, reservations, the complete ledger, posting keys, and corrections.

Restoring JSON is a reviewed **replace**, not a merge. Validation runs before the replacement, and the complete workspace that existed immediately before the replacement remains available as the previous recovery download.

Legacy schema versions **1–3** do not contain the inventory ledger. The restore preview must warn that restoring one clears current inventory and reservations. The previous full recovery copy is retained so the operator can download it before deciding whether to continue. Version 4 inventory backups must be restored in the PostgreSQL workspace; offline localStorage remains planning-only.

### PostgreSQL dump

For the full database backup path, run the existing command from the project directory:

```powershell
.\scripts\backup.ps1
```

It creates an ignored `backups/millplan-<UTC time>.dump` file using `pg_dump -Fc`. Keep protected copies outside the working checkout and agree retention and restore ownership with the company. The dump is the recovery path for database metadata, command receipts, migrations, source graph, stock, and ledger data that should not be reduced to a portable JSON file.

The local Docker/PostgreSQL development connection remains on loopback port **5434** for DataGrip. This inventory workflow does not change that local port or imply a company-server deployment.

## Data handling rules

- Treat the real SAP workbook and any customer/company export as private operational data. Never commit the source workbook, `.xlsx`/`.xlsm` derivatives, raw DO codes, screenshots containing identifiers, or database dumps to public GitHub.
- Use fictional material codes, customers, order numbers, and dates in tests and examples. The handoff documents only the generic source scale (443 orders and 87 stock items).
- Review `git status` before a commit and keep source workbooks in a protected location outside the repository. The repository’s ignored extensions are a safeguard, not permission to force-add a file.
- No release, deployment, CI, or test-pass status is asserted by this workflow document. Use the project’s existing installation and disposable-database verification instructions when validating a change.
