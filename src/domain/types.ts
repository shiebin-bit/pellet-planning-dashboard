export const LINE_IDS = ["PM1", "PM2", "PM3", "PM4"] as const;

export type LineId = (typeof LINE_IDS)[number];
export type JobStatus = "pending" | "running" | "completed" | "cancelled";
export type QuantityMode = "bags" | "bulk";

export interface ScheduleSegment {
  jobId: string;
  lineId: LineId;
  kind: "production" | "changeover";
  start: number;
  end: number;
}

export interface Job {
  id: string;
  date: string;
  lineId: LineId;
  sequence: number;
  orderNo: string;
  productCode: string;
  description: string;
  bin: string;
  mode: QuantityMode;
  bagCount: number | null;
  quantityMt: number;
  status: JobStatus;
  remarks: string;
  actualStart: string | null;
  actualEnd: string | null;
  actualQuantityMt?: number | null;
  completionNote?: string;
  binNeedsReview: boolean;
  createdAt: string;
  updatedAt: string;
  lockedSegments?: ScheduleSegment[];
  issue?: {
    reason: string;
    reportedAt: string;
  };
}

export interface JobInput {
  date: string;
  lineId: LineId;
  orderNo: string;
  productCode: string;
  description: string;
  bin: string;
  mode: QuantityMode;
  bagCount: number | null;
  quantityMt: number;
  remarks: string;
}

export interface Downtime {
  id: string;
  date: string;
  lineId: LineId | "all";
  start: string;
  end: string;
  reason: string;
}

export interface Settings {
  siteName: string;
  timeZone: string;
  dayStart: string;
  availableHours: number;
  changeoverMinutes: number;
  bagWeightKg: number;
  rates: Record<LineId, number>;
  slowProductPrefixes: string[];
  slowRatePM2: number;
  downtime: Downtime[];
}

export interface HistoryEvent {
  id: string;
  at: string;
  type: string;
  jobId?: string;
  message: string;
}

export interface AppState {
  schemaVersion: 1;
  jobs: Job[];
  settings: Settings;
  events: HistoryEvent[];
}

export interface ScheduledJob extends Job {
  plannedStart: number | null;
  plannedEnd: number | null;
  durationMinutes: number;
  rate: number;
  changeoverMinutes: number;
  segments: ScheduleSegment[];
  overflow: boolean;
}

export interface LineSchedule {
  lineId: LineId;
  jobs: ScheduledJob[];
  segments: ScheduleSegment[];
  availableMinutes: number;
  productionMinutes: number;
  changeoverMinutes: number;
  utilisation: number | null;
  plannedMt: number;
  totalProductionMinutes: number;
  overflowMinutes: number;
  finishAt: number | null;
}

export interface Board {
  date: string;
  start: number;
  end: number;
  lines: LineSchedule[];
  backlog: Job[];
}
