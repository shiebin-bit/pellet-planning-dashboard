import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validatePortableBackupV3 } from "../../server/sourceBackup";
import { createDefaultSettings } from "./defaults";
import type { PortableWorkspaceBackupV3, SourceOrderFields } from "./sourceTypes";

const NOW = "2026-10-22T04:00:00.000Z";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(source[key])}`).join(",")}}`;
}

function backup(): PortableWorkspaceBackupV3 {
  const fields: SourceOrderFields = {
    doNo: "DO-1", deliveryDate: "2026-10-22", soldToParty: "Customer", shipToParty: "Plant",
    materialCode: "6220-A", description: "Imported feed", quantity: 240, unit: "Bags",
    deliveryLeadDays: 1, remark: "", daysOutstanding: 2, medication: "", fmrOmed: "",
  };
  return {
    schemaVersion: 3,
    exportedAt: NOW,
    planning: {
      schemaVersion: 2, catalog: [], settings: createDefaultSettings(), events: [], jobs: [{
        id: "job-1", date: "2026-10-22", lineId: "PM1", sequence: 1, orderNo: fields.doNo,
        productCode: fields.materialCode, description: fields.description, bin: "B01", mode: "bags",
        bagCount: 240, quantityMt: 12, status: "pending", remarks: "", actualStart: null, actualEnd: null,
        binNeedsReview: false, createdAt: NOW, updatedAt: NOW, sourceOrderId: "source-1",
        sourceOrderVersion: 1, sourceSnapshot: { doNo: fields.doNo, materialCode: fields.materialCode,
          description: fields.description, quantity: fields.quantity, unit: fields.unit }, bagWeightKgSnapshot: 50,
      }],
    },
    sourceData: {
      imports: [{ id: "import-1", fileName: "sap.xlsx", sheetName: "Sheet1", digest: "a".repeat(64), semanticDigest: "b".repeat(64), asOfDate: "2026-10-22", rowCount: 1, importedAt: NOW }],
      orders: [{ id: "source-1", doNo: " DO-1 ", materialCode: " 6220-A ", latestVersion: 1, latestImportId: "import-1", deliveryStatus: "pending", deliverySource: null, deliveryRecordedAt: null, deliveryReason: null, needsReview: false, updatedAt: NOW }],
      versions: [{ sourceOrderId: "source-1", version: 1, importId: "import-1", fields, contentHash: createHash("sha256").update(canonicalJson(fields)).digest("hex"), createdAt: NOW }],
    },
  };
}

describe("portable source backup validation", () => {
  it("normalizes identity whitespace while preserving a valid source link graph", () => {
    const parsed = validatePortableBackupV3(backup());
    expect(parsed.sourceData.orders[0].doNo).toBe("DO-1");
    expect(parsed.sourceData.orders[0].materialCode).toBe("6220-A");
  });

  it("rejects planning fields that diverge from the source snapshot", () => {
    const value = backup();
    value.planning.jobs[0].productCode = "WRONG";
    expect(() => validatePortableBackupV3(value)).toThrow(/planning fields/i);
  });

  it("rejects inconsistent delivery tuples and out-of-range PostgreSQL integers", () => {
    const inconsistent = backup();
    inconsistent.sourceData.orders[0].deliveryStatus = "delivered";
    expect(() => validatePortableBackupV3(inconsistent)).toThrow(/delivery source and recorded time/i);

    const oversized = backup();
    oversized.sourceData.imports[0].rowCount = 2_147_483_648;
    expect(() => validatePortableBackupV3(oversized)).toThrow(/PostgreSQL integer range/i);
  });
});
