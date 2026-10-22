import { ApiError } from './api';
import type { SourceImportInput, SourceImportPreview, SourceOrderDetail, SourceOrderPage } from '../domain/sourceTypes';

export async function dataRequest<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
      headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error?.message || 'The request failed.', data.error?.code || 'REQUEST_FAILED', data.workspace);
    return data as T;
  } finally { clearTimeout(timeout); }
}
export const readSourceOrders = (query: URLSearchParams) => dataRequest<SourceOrderPage>('/api/data?' + query);
export const readSourceOrder = (id: string) => dataRequest<SourceOrderDetail>('/api/data/' + encodeURIComponent(id));
export const previewSourceImport = (input: SourceImportInput) => dataRequest<SourceImportPreview>('/api/data/preview', input);
export interface ImportBatchOption { id: string; fileName: string; asOfDate: string; importedAt: string; rowCount: number }
export const readImportBatches = () => dataRequest<ImportBatchOption[]>('/api/data/imports');
