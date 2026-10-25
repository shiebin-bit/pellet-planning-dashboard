import type { InventoryExtra, InventoryHistoricalStatus, InventoryUnit } from "./inventoryTypes";

export const BULK_SCALE = 1_000;

/** Converts API quantities to exact integer storage units (bags or 0.001 MT). */
export function quantityToScaled(unit: InventoryUnit, quantity: number, label = "quantity"): number {
  if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`${label} must be a non-negative finite number.`);
  const scaled = unit === "Bags" ? quantity : quantity * BULK_SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-8) {
    throw new Error(unit === "Bags" ? `${label} must be a whole number of bags.` : `${label} must have no more than three decimal places.`);
  }
  if (!Number.isSafeInteger(rounded)) throw new Error(`${label} is too large.`);
  return rounded;
}

export function signedQuantityToScaled(unit: InventoryUnit, quantity: number, label = "quantity"): number {
  if (!Number.isFinite(quantity)) throw new Error(`${label} must be a finite number.`);
  const sign = quantity < 0 ? -1 : 1;
  return sign * quantityToScaled(unit, Math.abs(quantity), label);
}

export function scaledToQuantity(unit: InventoryUnit, quantityScaled: number): number {
  if (!Number.isSafeInteger(quantityScaled)) throw new Error("Stored inventory quantity is outside the safe integer range.");
  return unit === "Bags" ? quantityScaled : quantityScaled / BULK_SCALE;
}

/** Extra is calculated once against the unsplit demand and rounded up to the item precision. */
export function extraQuantityScaled(unit: InventoryUnit, demandScaled: number, extra: InventoryExtra | null): number {
  if (!extra || demandScaled <= 0) return 0;
  if (extra.type === "fixed") return quantityToScaled(unit, extra.quantity, "fixed extra quantity");
  const percentMillionths = decimalToInteger(extra.percent, 1_000, "extra percent");
  return Math.ceil(demandScaled * percentMillionths / 100_000);
}

export function normalizeBucketText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function bucketIdentity(medication: string, fmrOmed: string): string {
  return `${normalizeBucketText(medication)}\u0000${normalizeBucketText(fmrOmed)}`;
}

export function historicalStatus(goodsMovementStatus: string | undefined, remark: string): InventoryHistoricalStatus {
  const movement = normalizeBucketText(goodsMovementStatus ?? "").toLocaleUpperCase("en-US");
  const note = normalizeBucketText(remark).toLocaleUpperCase("en-US");
  if (movement === "OUT" || note === "OUT") return "out";
  if (movement === "DONE" || note === "DONE") return "done";
  return "pending";
}

export function sourceBusinessKey(doNo: string, materialCode: string): string {
  return `${doNo.trim().toLocaleUpperCase("en-US")}\u0000${materialCode.trim().toLocaleUpperCase("en-US")}`;
}

export function baselineBalances(
  openingScaled: number,
  productionScaled: number,
  receivedScaled: number,
  returnScaled: number,
  reworkScaled: number,
  issueScaled: number,
): number {
  const result = openingScaled + productionScaled + receivedScaled + returnScaled - reworkScaled - issueScaled;
  if (!Number.isSafeInteger(result)) throw new Error("Baseline balance is outside the safe integer range.");
  return result;
}

export function orderNeedScaled(orderedScaled: number, deliveredScaled: number, reservedScaled: number): number {
  return Math.max(0, orderedScaled - deliveredScaled - reservedScaled);
}

export function netToPlanScaled(orderNeed: number, scheduledUnreceived: number): number {
  return Math.max(0, orderNeed - scheduledUnreceived);
}

function decimalToInteger(value: number, scale: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number.`);
  const scaled = value * scale;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-8) throw new Error(`${label} has too many decimal places.`);
  if (!Number.isSafeInteger(rounded)) throw new Error(`${label} is too large.`);
  return rounded;
}
