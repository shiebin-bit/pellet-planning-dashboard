export interface OperationsSummary {
  revision: number;
  serverNow: string;
  asOfDate: string;
  dueSoonThrough: string;
  counts: {
    overdueToPlan: number;
    dueSoon: number;
    stockShortages: number;
    pendingImportReviews: number;
  };
  freshness: {
    latestOrderImport: {
      asOfDate: string;
      importedAt: string;
    } | null;
    newestExcelAsOfDate: string | null;
    inventoryBaselineDate: string | null;
    lastVerifiedStockCountDate: string | null;
  };
}
