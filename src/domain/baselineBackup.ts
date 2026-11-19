import type { PortableBaselineHistory } from './dailyImport';
import type { PortableWorkspaceBackupV5 } from './productionProgress';
import type { PortableDailyPlanning } from './dailyPlanning';

export interface PortableWorkspaceBackupV6 extends Omit<PortableWorkspaceBackupV5, 'schemaVersion'> {
  schemaVersion: 6;
  baselineHistory: PortableBaselineHistory;
}

export interface PortableWorkspaceBackupV7 extends Omit<PortableWorkspaceBackupV6,'schemaVersion'> {
  schemaVersion:7;
  dailyPlanning:PortableDailyPlanning;
}
