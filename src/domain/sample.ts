import { completeJob, getBoard, startJob } from "./engine";
import {
  LINE_IDS,
  type AppState,
  type Job,
  type LineId,
  type QuantityMode,
  type Settings,
} from "./types";

interface SampleJob {
  lineId: LineId;
  productCode: string;
  quantityMt: number;
  description?: string;
  mode?: QuantityMode;
  bagCount?: number | null;
  bin?: string;
  remarks?: string;
}

const SAMPLE_JOBS: SampleJob[] = [
  { lineId: "PM1", productCode: "6220 BLC", quantityMt: 8, mode: "bags", bagCount: 160, description: "Starter batch", bin: "B01" },
  { lineId: "PM1", productCode: "6220", quantityMt: 187.5, mode: "bags", bagCount: 3750, description: "Main production run", bin: "B02" },

  { lineId: "PM2", productCode: "6210 BLC", quantityMt: 8, mode: "bags", bagCount: 160, description: "Starter batch", bin: "B03" },
  { lineId: "PM2", productCode: "6210", quantityMt: 164.5, mode: "bags", bagCount: 3290, description: "Main production run", bin: "B04" },

  { lineId: "PM3", productCode: "6210B6", quantityMt: 6, bin: "B05" },
  { lineId: "PM3", productCode: "6210B10", quantityMt: 10, bin: "B05" },
  { lineId: "PM3", productCode: "6210B18", quantityMt: 18, bin: "B06" },
  { lineId: "PM3", productCode: "6148", quantityMt: 18, bin: "B07" },
  { lineId: "PM3", productCode: "6211", quantityMt: 13, mode: "bags", bagCount: 260, bin: "B08" },
  { lineId: "PM3", productCode: "6210B10", quantityMt: 10, bin: "B05" },
  { lineId: "PM3", productCode: "6222", quantityMt: 20, bin: "B09" },
  { lineId: "PM3", productCode: "6220", quantityMt: 39, mode: "bags", bagCount: 780, bin: "B10" },

  { lineId: "PM4", productCode: "6227", quantityMt: 6, bin: "B11" },
  { lineId: "PM4", productCode: "6227", quantityMt: 18, bin: "B11" },
  { lineId: "PM4", productCode: "6227", quantityMt: 20, bin: "B12" },
  { lineId: "PM4", productCode: "6227", quantityMt: 18, bin: "B12" },
  { lineId: "PM4", productCode: "6227", quantityMt: 18, bin: "B13" },
  { lineId: "PM4", productCode: "6220", quantityMt: 26, mode: "bags", bagCount: 520, bin: "B14" },
  { lineId: "PM4", productCode: "6227", quantityMt: 18, bin: "B11" },
  { lineId: "PM4", productCode: "6227", quantityMt: 20, bin: "B12" },
  { lineId: "PM4", productCode: "6227", quantityMt: 12, bin: "B13" },
  { lineId: "PM4", productCode: "6227", quantityMt: 10, bin: "B11" },
  { lineId: "PM4", productCode: "6227", quantityMt: 18, bin: "B12" },
];

export function createSampleState(date: string): AppState {
  if (!isValidDate(date)) {
    throw new Error("Sample date must use YYYY-MM-DD.");
  }

  const settings: Settings = {
    siteName: "Demo Pellet Plant",
    timeZone: "Asia/Kuala_Lumpur",
    dayStart: "08:30",
    availableHours: 23,
    changeoverMinutes: 30,
    bagWeightKg: 50,
    rates: { PM1: 8.5, PM2: 7.5, PM3: 6.5, PM4: 7 },
    slowProductPrefixes: ["6811", "6542"],
    slowRatePM2: 6.5,
    downtime: [],
  };

  const createdAt = new Date(`${date}T00:00:00.000Z`).toISOString();
  const sequenceByLine = Object.fromEntries(
    LINE_IDS.map((lineId) => [lineId, 0]),
  ) as Record<LineId, number>;
  const jobs: Job[] = SAMPLE_JOBS.map((source, index) => {
    const sequence = (sequenceByLine[source.lineId] += 1);
    return {
      id: `demo-${source.lineId.toLowerCase()}-${sequence}`,
      date,
      lineId: source.lineId,
      sequence,
      orderNo: `DEMO-${String(index + 1).padStart(3, "0")}`,
      productCode: source.productCode,
      description: source.description ?? `Product ${source.productCode}`,
      bin: source.bin ?? `B${String(index + 1).padStart(2, "0")}`,
      mode: source.mode ?? "bulk",
      bagCount: source.bagCount ?? null,
      quantityMt: source.quantityMt,
      status: "pending",
      remarks: source.remarks ?? "Demo schedule data",
      actualStart: null,
      actualEnd: null,
      binNeedsReview: false,
      createdAt,
      updatedAt: createdAt,
    };
  });

  for (const lineId of LINE_IDS) {
    const sequence = (sequenceByLine[lineId] += 1);
    jobs.push({
      id: `demo-${lineId.toLowerCase()}-backlog`,
      date,
      lineId,
      sequence,
      orderNo: `DEMO-${lineId}-TBC`,
      productCode: lineId === "PM2" ? "6811" : "TBC",
      description: "Backlog quantity awaiting confirmation",
      bin: "TBC",
      mode: "bulk",
      bagCount: null,
      quantityMt: 0,
      status: "pending",
      remarks: "Demo backlog — enter quantity before scheduling",
      actualStart: null,
      actualEnd: null,
      binNeedsReview: false,
      createdAt,
      updatedAt: createdAt,
    });
  }

  let state: AppState = {
    schemaVersion: 1,
    jobs,
    settings,
    events: [
      {
        id: "demo-initialized",
        at: createdAt,
        type: "demo.initialized",
        message: "Loaded global Demo production plan.",
      },
    ],
  };

  const completedIds = [
    "demo-pm1-1",
    "demo-pm2-1",
    "demo-pm3-1",
    "demo-pm3-2",
    "demo-pm4-1",
  ];
  for (const [index, id] of completedIds.entries()) {
    const scheduled = findScheduledJob(state, date, id);
    if (scheduled.plannedStart === null || scheduled.plannedEnd === null) continue;
    const actualStart = new Date(
      scheduled.plannedStart + (index % 3) * 4 * 60_000,
    ).toISOString();
    const actualEnd = new Date(
      Math.max(new Date(actualStart).getTime(), scheduled.plannedEnd + (index % 2) * 3 * 60_000),
    ).toISOString();
    const actualQuantityMt =
      index === 3
        ? Math.max(0, scheduled.quantityMt - 0.5)
        : scheduled.quantityMt;
    const completionNote =
      index === 3 ? "Illustrative demo shortfall after final weigh-in" : undefined;
    state = startJob(state, id, actualStart);
    state = completeJob(
      state,
      id,
      actualQuantityMt,
      completionNote,
      actualEnd,
    );
  }

  return state;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function findScheduledJob(state: AppState, date: string, id: string) {
  const board = getBoard(state, date);
  const job = board.lines.flatMap((line) => line.jobs).find((item) => item.id === id);
  if (!job) throw new Error(`Demo job ${id} could not be scheduled.`);
  return job;
}
