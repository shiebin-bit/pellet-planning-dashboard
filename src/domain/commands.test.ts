import { describe, expect, it } from "vitest";
import { createSampleState } from "./sample";
import { executeCommand, parseCommand } from "./commands";

describe("shared workspace commands", () => {
  it("strictly parses commands and rejects unknown fields", () => {
    const command = parseCommand({
      type: "job.move", jobId: "job-1", toLineId: "PM2", beforeJobId: "job-2",
    });
    expect(command).toEqual({ type: "job.move", jobId: "job-1", toLineId: "PM2", beforeJobId: "job-2" });
    expect(() => parseCommand({ type: "job.cancel", jobId: "job-1", state: {} })).toThrow(/not supported/i);
    expect(() => parseCommand({ type: "job.create", input: { date: "2026-10-15" } })).toThrow(/required/i);
    expect(() => parseCommand({ type: "workspace.resetDemo", date: "2026-02-30" })).toThrow(/valid calendar/i);
    expect(parseCommand({ type: "job.update", jobId: "job-1", patch: { remarks: "Revised" } })).toEqual({
      type: "job.update", jobId: "job-1", patch: { remarks: "Revised" },
    });
    expect(() => parseCommand({ type: "job.update", jobId: "job-1", patch: { status: "completed" } })).toThrow(/not supported/i);
  });

  it("dispatches ordinary commands and uses the trusted completion timestamp", () => {
    const sample = createSampleState("2026-10-15");
    const pending = sample.jobs.find(job => job.status === "pending" && job.quantityMt > 0)!;
    const started = executeCommand(sample, {
      type: "job.start", jobId: pending.id,
    }, { nowIso: "2026-10-15T00:00:00.000Z" });
    const completed = executeCommand(started, {
      type: "job.complete", jobId: pending.id, actualQuantityMt: pending.quantityMt, completionNote: "Server confirmation",
    }, { nowIso: "2026-10-15T04:00:00.000Z" });
    expect(completed.jobs.find(job => job.id === pending.id)).toMatchObject({
      status: "completed", actualEnd: "2026-10-15T04:00:00.000Z", completionNote: "Server confirmation",
    });
  });

  it("keeps workspace-level operations behind a trusted provider", () => {
    const state = createSampleState("2026-10-15");
    expect(() => executeCommand(state, { type: "workspace.undoLastMove" })).toThrow(/trusted workspace provider/i);
    expect(() => executeCommand(state, { type: "workspace.restore", backup: state })).toThrow(/trusted workspace provider/i);
  });
});
