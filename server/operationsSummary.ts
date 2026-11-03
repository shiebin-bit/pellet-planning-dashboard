import type pg from "pg";
import type { OperationsSummary } from "../src/domain/operationsSummary";
import { getInventoryFreshnessFromClient } from "./inventory";
import { countSourceOrders } from "./sourceData";

interface SummaryClockRow {
  revision: string;
  server_now: Date | string;
  as_of_date: string;
  due_soon_through: string;
}

interface ImportFreshnessRow {
  as_of_date: string;
  imported_at: Date | string;
  newest_excel_as_of_date: string | null;
}

export async function getOperationsSummary(pool: pg.Pool): Promise<OperationsSummary> {
  const client = await pool.connect();
  let inTransaction = false;
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    inTransaction = true;

    const context = (await client.query<SummaryClockRow>(
      `SELECT revision::text,
         CURRENT_TIMESTAMP AS server_now,
         (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS as_of_date,
         ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kuala_Lumpur')::date + 3)::text AS due_soon_through
         FROM workspace WHERE id=1`,
    )).rows[0];
    if (!context) throw new Error("Workspace is not initialized.");

    const yesterday = addDays(context.as_of_date, -1);
    const overdueToPlan = await countSourceOrders(client, new URLSearchParams({
      view: "needs-production",
      deliveryTo: yesterday,
    }), context.as_of_date);
    const dueSoon = await countSourceOrders(client, new URLSearchParams({
      deliveryStatus: "pending",
      deliveryFrom: context.as_of_date,
      deliveryTo: context.due_soon_through,
    }), context.as_of_date);

    const stockShortages = Number((await client.query<{ total: string }>(
      `WITH standard_physical AS (
         SELECT item_id, COALESCE(sum(quantity_delta_scaled),0)::bigint AS on_hand_scaled
           FROM inventory_ledger
          WHERE workspace_id=1 AND medication='' AND fmr_omed=''
          GROUP BY item_id
       ), standard_reserved AS (
         SELECT item_id, COALESCE(sum(quantity_scaled),0)::bigint AS reserved_scaled
           FROM inventory_reservations
          WHERE medication='' AND fmr_omed=''
          GROUP BY item_id
       )
       SELECT count(*)::text AS total
         FROM inventory_items item
         LEFT JOIN standard_physical physical ON physical.item_id=item.id
         LEFT JOIN standard_reserved reserved ON reserved.item_id=item.id
        WHERE item.workspace_id=1
          AND item.strategy='mts'
          AND item.target_quantity_scaled IS NOT NULL
          AND item.target_quantity_scaled - (COALESCE(physical.on_hand_scaled,0)-COALESCE(reserved.reserved_scaled,0)) > 0`,
    )).rows[0]?.total ?? "0");

    const pendingImportReviews = Number((await client.query<{ total: string }>(
      "SELECT count(*)::text AS total FROM source_order_discrepancies WHERE workspace_id=1 AND status='pending'",
    )).rows[0]?.total ?? "0");

    const latestImport = (await client.query<ImportFreshnessRow>(
      `SELECT as_of_date::text, imported_at, max(as_of_date) OVER ()::text AS newest_excel_as_of_date
         FROM source_imports
        WHERE workspace_id=1
        ORDER BY imported_at DESC, as_of_date DESC, id DESC
        LIMIT 1`,
    )).rows[0];
    const inventoryFreshness = await getInventoryFreshnessFromClient(client);

    await client.query("COMMIT");
    inTransaction = false;
    return {
      revision: Number(context.revision),
      serverNow: new Date(context.server_now).toISOString(),
      asOfDate: context.as_of_date,
      dueSoonThrough: context.due_soon_through,
      counts: { overdueToPlan, dueSoon, stockShortages, pendingImportReviews },
      freshness: {
        latestOrderImport: latestImport ? {
          asOfDate: latestImport.as_of_date,
          importedAt: new Date(latestImport.imported_at).toISOString(),
        } : null,
        newestExcelAsOfDate: latestImport?.newest_excel_as_of_date ?? null,
        inventoryBaselineDate: inventoryFreshness.baselineDate,
        lastVerifiedStockCountDate: inventoryFreshness.lastCountDate,
      },
    };
  } catch (error) {
    if (inTransaction) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function addDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
