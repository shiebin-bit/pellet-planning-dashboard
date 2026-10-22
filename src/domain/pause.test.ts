import { describe, expect, it } from "vitest";
import { executeCommand, parseCommand } from "./commands";
import { createEmptyState } from "./defaults";
import type { AppState, JobInput } from "./types";

const START = "2026-10-15T01:00:00.000Z";
const PAUSE = "2026-10-15T01:30:00.000Z";
const RESUME = "2026-10-15T01:45:00.000Z";

describe("production pause and resume", () => {
  it("keeps a paused job running, frozen, and occupying its line", () => {
    const running = runningState();
    const source = running.jobs[0];
    const paused = executeCommand(running, {
      type: "job.pause", jobId: source.id, reason: "  Hopper inspection  ",
    }, { nowIso: PAUSE });
    const job = paused.jobs[0];
    expect(job.status).toBe("running");
    expect(job.lockedSegments).toEqual(source.lockedSegments);
    expect(job.pauseIntervals).toEqual([{ pausedAt: PAUSE, resumedAt: null, reason: "Hopper inspection" }]);
    expect(paused.events.at(-1)).toMatchObject({
      at: PAUSE,
      type: "job.paused",
      changes: [
        { field: "pauseState", before: "running", after: "paused" },
        { field: "pauseReason", before: null, after: "Hopper inspection" },
      ],
    });
    const withSecond = executeCommand(paused, { type: "job.create", input: input("SECOND") });
    const second = withSecond.jobs.find(candidate => candidate.productCode === "SECOND")!;
    expect(() => executeCommand(withSecond, {
      type: "job.start", jobId: second.id,
    }, { nowIso: "2026-10-15T02:00:00.000Z" })).toThrow(/finish the current running job/i);
    expect(() => executeCommand(paused, {
      type: "job.pause", jobId: source.id, reason: "Again",
    }, { nowIso: RESUME })).toThrow(/already paused/i);
  });

  it("resumes only the final open interval with trusted ordered timestamps", () => {
    const running = runningState();
    const id = running.jobs[0].id;
    expect(() => executeCommand(running, {
      type: "job.pause", jobId: id, reason: "Early",
    }, { nowIso: "2026-10-15T00:59:59.000Z" })).toThrow(/earlier than actual start/i);
    expect(() => executeCommand(running, { type: "job.resume", jobId: id }, { nowIso: RESUME })).toThrow(/not paused/i);

    const paused = executeCommand(running, {
      type: "job.pause", jobId: id, reason: "Inspection",
    }, { nowIso: PAUSE });
    expect(() => executeCommand(paused, { type: "job.resume", jobId: id }, {
      nowIso: "2026-10-15T01:29:59.000Z",
    })).toThrow(/earlier than pause/i);
    const resumed = executeCommand(paused, { type: "job.resume", jobId: id }, { nowIso: RESUME });
    expect(resumed.jobs[0].pauseIntervals?.at(-1)?.resumedAt).toBe(RESUME);
    expect(resumed.events.at(-1)?.changes).toEqual([
      { field: "pauseState", before: "paused", after: "running" },
      { field: "pauseReason", before: "Inspection", after: null },
    ]);
  });

  it("completes while paused by atomically closing the pause and clears pauses on copied jobs", () => {
    const running = runningState();
    const id = running.jobs[0].id;
    const paused = executeCommand(running, {
      type: "job.pause", jobId: id, reason: "Material hold",
    }, { nowIso: PAUSE });
    expect(() => executeCommand(paused, {
      type: "job.complete", jobId: id, actualQuantityMt: 1,
    }, { nowIso: "2026-10-15T01:29:59.000Z" })).toThrow(/earlier than the active pause/i);

    const completed = executeCommand(paused, {
      type: "job.complete", jobId: id, actualQuantityMt: 1,
    }, { nowIso: RESUME });
    expect(completed.jobs[0].pauseIntervals).toEqual([
      { pausedAt: PAUSE, resumedAt: RESUME, reason: "Material hold" },
    ]);
    expect(completed.events.at(-1)?.changes).toEqual(expect.arrayContaining([
      { field: "status", before: "running", after: "completed" },
      { field: "pauseState", before: "paused", after: null },
      { field: "pauseReason", before: "Material hold", after: null },
    ]));

    const copied = executeCommand(completed, {
      type: "job.copyBatch",
      sourceDate: "2026-10-15",
      targetDate: "2026-10-16",
      items: [{ sourceJobId: id, orderNo: "COPY-1", quantity: { mode: "bulk", quantityMt: 1 } }],
    }, { nowIso: "2026-10-15T02:00:00.000Z" });
    const copy = copied.jobs.find(job => job.orderNo === "COPY-1")!;
    expect(copy).not.toHaveProperty("pauseIntervals");
  });

  it("parses pause commands without accepting client timestamps", () => {
    expect(parseCommand({ type: "job.pause", jobId: "job-1", reason: " Inspection " })).toEqual({
      type: "job.pause", jobId: "job-1", reason: " Inspection ",
    });
    expect(parseCommand({ type: "job.resume", jobId: "job-1" })).toEqual({ type: "job.resume", jobId: "job-1" });
    expect(() => parseCommand({
      type: "job.pause", jobId: "job-1", reason: "Inspection", pausedAt: PAUSE,
    })).toThrow(/not supported/i);
    expect(() => parseCommand({ type: "job.pause", jobId: "job-1", reason: "   " })).toThrow(/blank/i);
  });
});

function runningState(): AppState {
  const created = executeCommand(createEmptyState(), { type: "job.create", input: input("SOURCE") });
  return executeCommand(created, {
    type: "job.start", jobId: created.jobs[0].id,
  }, { nowIso: START });
}

function input(productCode: string): JobInput {
  return {
    date: "2026-10-15",
    lineId: "PM1",
    orderNo: `ORDER-${productCode}`,
    productCode,
    description: "Pause test",
    bin: "B01",
    mode: "bulk",
    bagCount: null,
    quantityMt: 1,
    remarks: "",
  };
}
