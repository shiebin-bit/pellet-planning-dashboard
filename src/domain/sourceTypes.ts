import type { JobStatus, LineId, QuantityMode } from "./types";

/** Normalized values produced by the Excel import preview. */
export interface SourceOrderFields {
  goodsMovementStatus?: string;
  sourceSheet?: string;
  sourceRow?: number;
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

export type SourceOrderFieldName = keyof SourceOrderFields;

export interface SourceImportInput {
  fileName: string;
  sheetName: string;
  digest: string;
  asOfDate: string;
  rows: SourceOrderFields[];
}

export interface SourceImportPreviewContext {
  includeBaseline: boolean;
  annotations: Array<{
    doNo: string;
    materialCode: string;
    remark: string;
    medication: string;
    fmrOmed: string;
  }>;
}

export type ImportRowDisposition = "added" | "unchanged" | "changed";
export type SourceImportAction = "insert" | "queue-review" | "skip-unchanged";

export interface SourceImportPreviewRow {
  key: string;
  disposition: ImportRowDisposition;
  /** Persistence outcome: existing order identities are never changed by an import. */
  importAction: SourceImportAction;
  existingOrderId: string | null;
  fields: SourceOrderFields;
  /** Effective values currently retained for this order, including protected manual inventory fields. */
  previousFields?: SourceOrderFields | null;
  previousAsOfDate?: string | null;
  changedFields: string[];
  /** Fields the correction workflow will not allow for the current order. */
  protectedFields?: SourceOrderFieldName[];
  currentVersion?: number | null;
  /** True when an existing order's effective operational values would change. */
  operationalChanged?: boolean;
}

export type SourceImportReviewStatus = "pending" | "applied" | "dismissed";

export interface SourceImportReviewProvenance {
  id: string;
  fileName: string;
  sheetName: string;
  digest: string;
  asOfDate: string;
  importedAt: string;
}

export interface SourceImportReview {
  id: string;
  status: SourceImportReviewStatus;
  sourceOrderId: string;
  doNo: string;
  materialCode: string;
  observedSourceVersion: number;
  currentSourceVersion: number;
  currentFields: SourceOrderFields;
  candidateFields: SourceOrderFields;
  changedFields: SourceOrderFieldName[];
  protectedFields: SourceOrderFieldName[];
  sourceImport: SourceImportReviewProvenance;
  createdAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  selectedFields: SourceOrderFieldName[] | null;
  appliedSourceVersion: number | null;
}

export interface SourceImportReviewPage {
  items: SourceImportReview[];
  page: number;
  pageSize: 50;
  total: number;
  counts: Record<SourceImportReviewStatus, number>;
}

export interface SourceImportPreview {
  added: number;
  /** Existing order identities that will be left unchanged, whether workbook values differ or not. */
  skipped: number;
  unchanged: number;
  changed: number;
  operationalChanged?: number;
  rows: SourceImportPreviewRow[];
}

export type DeliveryStatus = "pending" | "delivered";
export type DeliverySource = "import" | "manual" | null;
export type SourceProductionStatus = JobStatus | "unplanned" | "external-complete";

export interface SourceOrderSummary extends SourceOrderFields {
  netToPlan?: number;
  /** True when stock reservations and ledger movements govern this order. */
  inventoryTracked: boolean;
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

export interface CreateJobFromSourcesInput {
  orders: Array<{
    sourceOrderId: string;
    sourceOrderVersion: number;
    /** Quantity allocated to this card in the source order's unit. */
    plannedQuantity: number;
  }>;
  date: string;
  lineId: LineId;
  bin: string;
  remarks: string;
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

export interface PortableSourceDiscrepancy {
  id: string;
  sourceOrderId: string;
  importId: string;
  observedSourceVersion: number;
  candidateFields: SourceOrderFields;
  candidateHash: string;
  changedFields: SourceOrderFieldName[];
  status: SourceImportReviewStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolutionReason: string | null;
  selectedFields: SourceOrderFieldName[] | null;
  appliedSourceVersion: number | null;
}

export interface PortableSourceDataWithReviews extends PortableSourceData {
  discrepancies: PortableSourceDiscrepancy[];
}

export interface PortableWorkspaceBackupV3 {
  schemaVersion: 3;
  exportedAt: string;
  planning: import("./types").AppState;
  sourceData: PortableSourceData;
}
