import type { InventorySnapshot, InventoryOrderProgressSnapshot, InventoryDailyStockRow, InventoryOrderJournalRow, InventoryDraftPreview, InventoryDraftRequest, InventoryLedgerEntry } from '../domain/inventoryTypes';

export async function inventoryRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Inventory request failed.');
  return data as T;
}
export const readInventory = () => inventoryRequest<InventorySnapshot>('/api/inventory');
export const readJobProduction = (jobId: string) => inventoryRequest<{total:number;unit:string;orderTotals?:Array<{sourceOrderId:string|null;total:number}>}>(`/api/inventory/jobs/${encodeURIComponent(jobId)}/production`);
export const readInventoryOrders = () => inventoryRequest<InventoryOrderProgressSnapshot>('/api/inventory/orders');
export const readDailyStock = (date: string) => inventoryRequest<InventoryDailyStockRow[]>(`/api/inventory/daily?date=${encodeURIComponent(date)}`);
export const readOrderJournal = (id: string) => inventoryRequest<InventoryOrderJournalRow[]>(`/api/inventory/orders/${encodeURIComponent(id)}/journal`);
export const readLedger = (itemId: string) => inventoryRequest<InventoryLedgerEntry[]>(`/api/inventory/ledger?itemId=${encodeURIComponent(itemId)}`);
export const previewInventoryDraft = (request: InventoryDraftRequest) => inventoryRequest<InventoryDraftPreview>('/api/inventory/draft', request);
