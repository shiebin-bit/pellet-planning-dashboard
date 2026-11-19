import type { InventoryUnit } from './inventoryTypes';
import type { LineId, ScheduleSegment } from './types';

export type CarryoverKind = 'reschedule' | 'continuation';

/** Trusted server-derived work that must be scheduled before newly admitted demand. */
export interface CarryoverCandidate {
  jobId: string;
  kind: CarryoverKind;
  /** Whole Bags or MT with at most three decimals. */
  remainingQuantity: number;
  unit: InventoryUnit;
  priorityDate: string;
  ordinal: number;
  originalDate: string;
  originalLineId: LineId;
}

/** Preview/commit representation. Clients may edit date/line but never quantity or kind. */
export interface DraftCarryover extends CarryoverCandidate {
  date: string;
  lineId: LineId;
  notBefore: string;
  segments: ScheduleSegment[];
}

export interface CarryoverPlanningContext {
  candidates: CarryoverCandidate[];
}

export interface PortableOrderAdmission {
  batchId: string;
  sourceOrderId: string;
  ordinal: number;
}

export interface PortableAdmissionBatch {
  id: string;
  targetDate: string;
  semanticDigest: string;
  acceptedAt: string;
  rowCount: number;
}

export interface PortableContinuationReservation {
  jobId: string;
  remainingQuantity: number;
  unit: InventoryUnit;
  date: string;
  lineId: LineId;
  notBefore: string;
  segments: ScheduleSegment[];
  plannedAt: string;
}

export interface PortableDailyPlanning {
  admissionBatches: PortableAdmissionBatch[];
  orderAdmissions: PortableOrderAdmission[];
  continuationReservations: PortableContinuationReservation[];
}
