export type AutomaticBackupState = 'disabled' | 'idle' | 'running' | 'degraded';
export type AutomaticBackupAttemptResult = 'success' | 'failed' | 'success_with_warning';

export interface AutomaticBackupAttempt {
  at: string;
  result: AutomaticBackupAttemptResult;
  code?: string;
  sanitizedMessage?: string;
}

export interface AutomaticBackupSuccess {
  at: string;
  fileName: string;
  bytes: number;
}

export interface AutomaticBackupStatus {
  enabled: boolean;
  format: 'portable-v5';
  intervalHours: number;
  retentionCount: number;
  state: AutomaticBackupState;
  lastAttempt: AutomaticBackupAttempt | null;
  lastSuccess: AutomaticBackupSuccess | null;
  nextAttemptAt: string | null;
}
