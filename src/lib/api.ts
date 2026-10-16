import type { Command, WorkspaceEnvelope } from '../domain/commands';

export interface CommandRequest {
  expectedRevision: number;
  commandId: string;
  command: Command;
}

export class ApiError extends Error {
  constructor(message: string, public code: string, public workspace?: WorkspaceEnvelope) {
    super(message);
  }
}

async function request(path: string, body?: CommandRequest): Promise<WorkspaceEnvelope> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store', signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error?.message || 'The database request failed.', data.error?.code || 'REQUEST_FAILED', data.workspace);
    if (!data.state || !Number.isSafeInteger(data.revision) || typeof data.canUndo !== 'boolean') {
      throw new Error('The server returned an invalid workspace.');
    }
    return data as WorkspaceEnvelope;
  } finally { clearTimeout(timer); }
}

export const readDatabaseWorkspace = () => request('/api/workspace');

/** A repeated request ID lets the server resolve a lost response without applying twice. */
export async function sendCommand(body: CommandRequest): Promise<WorkspaceEnvelope> {
  try { return await request('/api/commands', body); }
  catch (error) {
    if (error instanceof ApiError) throw error;
    return request('/api/commands', body);
  }
}
