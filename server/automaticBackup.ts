import { randomUUID } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AutomaticBackupAttempt, AutomaticBackupStatus, AutomaticBackupSuccess } from '../src/domain/automaticBackup';
import { validatePortableBackupV5 } from './sourceBackup';

const MAX_PORTABLE_BACKUP_BYTES = 64 * 1024 * 1024;
const RETRY_DELAY_MS = 15 * 60 * 1_000;
const MANAGED_FILE = /^millplan-auto-v5-(\d{8}T\d{9}Z)\.json$/;

export interface AutomaticBackupConfig {
  enabled: boolean;
  directory: string;
  intervalHours: number;
  retentionCount: number;
}

interface AutomaticBackupDependencies {
  exportBackup(): Promise<unknown>;
  now?: () => Date;
  validateBackup?: (value: unknown) => void;
  retryDelayMs?: number;
}

export class AutomaticBackupService {
  private readonly now: () => Date;
  private readonly validateBackup: (value: unknown) => void;
  private readonly retryDelayMs: number;
  private state: AutomaticBackupStatus['state'];
  private lastAttempt: AutomaticBackupAttempt | null = null;
  private lastSuccess: AutomaticBackupSuccess | null = null;
  private nextAttemptAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly config: AutomaticBackupConfig, private readonly dependencies: AutomaticBackupDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.validateBackup = dependencies.validateBackup ?? (value => { validatePortableBackupV5(value); });
    this.retryDelayMs = dependencies.retryDelayMs ?? RETRY_DELAY_MS;
    this.state = config.enabled ? 'idle' : 'disabled';
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    if (!this.config.enabled) return;
    try {
      await mkdir(this.config.directory, { recursive: true });
      this.lastSuccess = await this.findLatestValidBackup();
      this.state = 'idle';
      const dueAt = this.lastSuccess
        ? Date.parse(this.lastSuccess.at) + this.config.intervalHours * 3_600_000
        : this.now().getTime();
      this.schedule(Math.max(this.now().getTime(), dueAt));
    } catch {
      this.recordFailure('DIRECTORY_UNAVAILABLE', 'The automatic backup directory is unavailable.');
    }
  }

  getStatus(): AutomaticBackupStatus {
    return {
      enabled: this.config.enabled,
      format: 'portable-v5',
      intervalHours: this.config.intervalHours,
      retentionCount: this.config.retentionCount,
      state: this.state,
      lastAttempt: this.lastAttempt ? { ...this.lastAttempt } : null,
      lastSuccess: this.lastSuccess ? { ...this.lastSuccess } : null,
      nextAttemptAt: this.nextAttemptAt,
    };
  }

  /** Runs the due job. Exposed for deterministic lifecycle tests; it is never an HTTP action. */
  runDueBackup(): Promise<void> {
    if (!this.config.enabled || this.closed) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.clearTimer();
    const current = this.performBackup().finally(() => {
      if (this.inflight === current) this.inflight = null;
    });
    this.inflight = current;
    return current;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    await this.inflight;
  }

  private async performBackup(): Promise<void> {
    const attemptedAt = this.now();
    this.state = 'running';
    this.nextAttemptAt = null;
    let backup: unknown;
    try {
      await mkdir(this.config.directory, { recursive: true });
    } catch {
      this.recordFailure('DIRECTORY_UNAVAILABLE', 'The automatic backup directory is unavailable.', attemptedAt);
      return;
    }
    try {
      backup = await this.dependencies.exportBackup();
      this.validateBackup(backup);
    } catch {
      this.recordFailure('EXPORT_FAILED', 'The portable workspace export failed.', attemptedAt);
      return;
    }
    let contents: string;
    try {
      contents = JSON.stringify(backup);
      if (typeof contents !== 'string') throw new Error('not serializable');
    } catch {
      this.recordFailure('EXPORT_INVALID', 'The portable workspace export could not be serialized.', attemptedAt);
      return;
    }
    const bytes = Buffer.byteLength(contents, 'utf8');
    if (bytes > MAX_PORTABLE_BACKUP_BYTES) {
      this.recordFailure('EXPORT_TOO_LARGE', 'The portable workspace export exceeds the 64 MB limit.', attemptedAt);
      return;
    }
    const fileName = managedFileName(attemptedAt);
    try {
      await this.writeAtomically(fileName, contents);
    } catch {
      this.recordFailure('WRITE_FAILED', 'The automatic backup file could not be saved.', attemptedAt);
      return;
    }
    this.lastSuccess = { at: attemptedAt.toISOString(), fileName, bytes };
    let warning: AutomaticBackupAttempt | null = null;
    try {
      const pruned = await this.pruneManagedBackups();
      if (!pruned) warning = attempt(attemptedAt, 'success_with_warning', 'PRUNE_FAILED', 'The backup was saved, but older automatic backups could not all be removed.');
    } catch {
      warning = attempt(attemptedAt, 'success_with_warning', 'PRUNE_FAILED', 'The backup was saved, but older automatic backups could not all be removed.');
    }
    this.lastAttempt = warning ?? attempt(attemptedAt, 'success');
    this.state = 'idle';
    this.schedule(attemptedAt.getTime() + this.config.intervalHours * 3_600_000);
  }

  private async writeAtomically(fileName: string, contents: string): Promise<void> {
    const finalPath = path.join(this.config.directory, fileName);
    const tempPath = path.join(this.config.directory, `.${fileName}.${randomUUID()}.tmp`);
    const handle = await open(tempPath, 'wx', 0o600);
    let renamed = false;
    try {
      await handle.writeFile(contents, { encoding: 'utf8' });
      await handle.sync();
      await handle.close();
      await rename(tempPath, finalPath);
      renamed = true;
      if (process.platform !== 'win32') {
        const directory = await open(this.config.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await handle.close().catch(() => undefined);
      if (!renamed) await unlink(tempPath).catch(() => undefined);
    }
  }

  private async findLatestValidBackup(): Promise<AutomaticBackupSuccess | null> {
    const entries = await readdir(this.config.directory, { withFileTypes: true });
    const candidates = entries
      .filter(entry => entry.isFile() && MANAGED_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left));
    for (const fileName of candidates) {
      const details = await this.readValidManagedBackup(fileName);
      if (!details) continue;
      const at = timestampFromManagedFile(fileName);
      if (at) return { at, fileName, bytes: details.bytes };
    }
    return null;
  }

  private async pruneManagedBackups(): Promise<boolean> {
    const entries = await readdir(this.config.directory, { withFileTypes: true });
    const candidates = entries
      .filter(entry => entry.isFile() && MANAGED_FILE.test(entry.name))
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left));
    const valid: string[] = [];
    for (const fileName of candidates) if (await this.readValidManagedBackup(fileName)) valid.push(fileName);
    let complete = true;
    for (const fileName of valid.slice(this.config.retentionCount)) {
      try { await unlink(path.join(this.config.directory, fileName)); }
      catch { complete = false; }
    }
    return complete;
  }

  private async readValidManagedBackup(fileName: string): Promise<{ bytes: number } | null> {
    try {
      const filePath = path.join(this.config.directory, fileName);
      const details = await stat(filePath);
      if (!details.isFile() || details.size > MAX_PORTABLE_BACKUP_BYTES) return null;
      const value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      this.validateBackup(value);
      return { bytes: details.size };
    } catch {
      return null;
    }
  }

  private recordFailure(code: string, sanitizedMessage: string, at = this.now()): void {
    this.lastAttempt = attempt(at, 'failed', code, sanitizedMessage);
    this.state = 'degraded';
    this.schedule(at.getTime() + this.retryDelayMs);
  }

  private schedule(at: number): void {
    if (this.closed || !this.config.enabled) return;
    this.clearTimer();
    const delay = Math.max(0, at - this.now().getTime());
    this.nextAttemptAt = new Date(this.now().getTime() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueBackup();
    }, Math.min(delay, 2_147_483_647));
    this.timer.unref();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextAttemptAt = null;
  }
}

function attempt(at: Date, result: AutomaticBackupAttempt['result'], code?: string, sanitizedMessage?: string): AutomaticBackupAttempt {
  return { at: at.toISOString(), result, ...(code ? { code } : {}), ...(sanitizedMessage ? { sanitizedMessage } : {}) };
}

export function managedFileName(at: Date): string {
  return `millplan-auto-v5-${at.toISOString().replace(/[-:.]/g, '')}.json`;
}

function timestampFromManagedFile(fileName: string): string | null {
  const match = MANAGED_FILE.exec(fileName);
  if (!match) return null;
  const compact = match[1];
  const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T${compact.slice(9, 11)}:${compact.slice(11, 13)}:${compact.slice(13, 15)}.${compact.slice(15, 18)}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}
