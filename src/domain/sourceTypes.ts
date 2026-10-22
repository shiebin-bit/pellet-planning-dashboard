import type { JobStatus, LineId, QuantityMode } from "./types";

/** Normalized values produced by the Excel import preview. */
export interface SourceOrderFields {
  doNo: string;
  deliveryDate: string;
  soldToParty: string;
  shipToParty: string;
  materialCode: string;
  description: string;
  quantity: number;
  unit: "MT" | "Bags";
  deliveryLeadDays: number | null;
  remark: string;
  daysOutstanding: number | null;
  medication: string;
  fmrOmed: string;
}

export interface SourceImportInput {
  fileName: string;
  sheetName: string;
  digest: string;
  asOfDate: string;
  rows: SourceOrderFields[];
}

export type ImportRowDisposition = "added" | "unchanged" | "changed";

export interface SourceImportPreviewRow {
  key: string;
  disposition: ImportRowDisposition;
  existingOrderId: string | null;
  fields: SourceOrderFields;
  changedFields: string[];
}

export interface SourceImportPreview {
  added: number;
  unchanged: number;
  changed: number;
  rows: SourceImportPreviewRow[];
}

export type DeliveryStatus = "pending" | "delivered";
export type DeliverySource = "import" | "manual" | null;
export type SourceProductionStatus = JobStatus | "unplanned" | "external-complete";

export interface SourceOrderSummary extends SourceOrderFields {
  id: string;
  version: number;
  importId: string;
  importFileName: string;
  importAsOfDate: string;
  deliveryStatus: DeliveryStatus;
  deliverySource: DeliverySource;
  deliveryRecordedAt: string | null;
  deliveryReason: string | null;
  productionStatus: SourceProductionStatus;
  linkedJobId: string | null;
  currentDeliveryLeadDays: number | null;
  currentDaysOutstanding: number | null;
  needsReview: boolean;
  updatedAt: string;
}

export interface SourceOrderDetail extends SourceOrderSummary {
  /** Total retained versions. Only the newest 200 are returned in `versions`. */
  versionTotal: number;
  versions: Array<{
    version: number;
    importId: string;
    importedAt: string;
    fields: SourceOrderFields;
  }>;
}

export interface SourceOrderPage {
  items: SourceOrderSummary[];
  page: number;
  pageSize: 50;
  total: number;
  stats: {
    total: number;
    planned: number;
    running: number;
    completed: number;
    delivered: number;
    overdue: number;
  };
}

export interface CreateJobFromSourceInput {
  sourceOrderId: string;
  sourceOrderVersion: number;
  date: string;
  lineId: LineId;
  bin: string;
  remarks: string;
  mode?: QuantityMode;
}

export interface PortableSourceData {
  imports: Array<{
    id: string; fileName: string; sheetName: string; digest: string; semanticDigest: string;
    asOfDate: string; rowCount: number; importedAt: string;
  }>;
  orders: Array<{
    id: string; doNo: string; materialCode: string; latestVersion: number; latestImportId: string;
    deliveryStatus: DeliveryStatus; deliverySource: DeliverySource; deliveryRecordedAt: string | null;
    deliveryReason: string | null; needsReview: boolean; updatedAt: string;
  }>;
  versions: Array<{
    sourceOrderId: string; version: number; importId: string; fields: SourceOrderFields;
    contentHash: string; createdAt: string;
  }>;
}

export interface PortableWorkspaceBackupV3 {
  schemaVersion: 3;
  exportedAt: string;
  planning: import("./types").AppState;
  sourceData: PortableSourceData;
}
