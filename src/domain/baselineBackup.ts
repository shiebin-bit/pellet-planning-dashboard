import type { PortableBaselineHistory } from './dailyImport';
import type { PortableWorkspaceBackupV5 } from './productionProgress';

export interface PortableWorkspaceBackupV6 extends Omit<PortableWorkspaceBackupV5, 'schemaVersion'> {
  schemaVersion: 6;
  baselineHistory: PortableBaselineHistory;
}
