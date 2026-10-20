import { describe, expect, it } from "vitest";
import { createSampleState } from "./sample";
import { parseWorkspaceBackup, validateWorkspaceBackup } from "./backup";
import { getScheduledJobs } from "./engine";
import type { AppState } from "./types";

const DATE = "2026-10-15";

function rawBackup(): any {
  return JSON.parse(JSON.stringify(createSampleState(DATE)));
}

function completedJob(raw: any): any {
  const found = raw.jobs.find((job: any) => job.status === "completed");
  if (!found) throw new Error("Sample has no completed job");
  return found;
}

function pendingJob(raw: any): any {
  const found = raw.jobs.find((job: any) => job.status === "pending" && job.quantityMt > 0);
  if (!found) throw new Error("Sample has no pending job");
  return found;
}

describe("workspace backup validation", () => {
  it("round-trips a current sample into a fresh deep clone", () => {
    const original = createSampleState(DATE);
    const restored = parseWorkspaceBackup(JSON.stringify(original));

    expect(restored).toEqual(original);
    expect(restored).not.toBe(original);
    expect(restored.jobs).not.toBe(original.jobs);
    expect(restored.settings).not.toBe(original.settings);
    expect(restored.settings.rates).not.toBe(original.settings.rates);
    expect(restored.events).not.toBe(original.events);
    const lockedIndex = restored.jobs.findIndex((job) => job.lockedSegments?.length);
    expect(restored.jobs[lockedIndex].lockedSegments).not.toBe(
      original.jobs[lockedIndex].lockedSegments,
    );
  });

  it("accepts legacy completed records without actual-output fields and preserves null or zero actuals", () => {
    const raw = rawBackup();
    for (const job of raw.jobs.filter((item: any) => item.status === "completed")) {
      delete job.actualQuantityMt;
      delete job.completionNote;
    }
    const legacy = validateWorkspaceBackup(raw);
    expect(
      legacy.jobs
        .filter((job) => job.status === "completed")
        .every((job) => !("actualQuantityMt" in job) && !("completionNote" in job)),
    ).toBe(true);

    const withNull = rawBackup();
    completedJob(withNull).actualQuantityMt = null;
    expect(validateWorkspaceBackup(withNull).jobs.find((job) => job.status === "completed")?.actualQuantityMt).toBeNull();

    const withZero = rawBackup();
    const zeroId = completedJob(withZero).id;
    completedJob(withZero).actualQuantityMt = 0;
    completedJob(withZero).completionNote = "  Zero output confirmed  ";
    const restored = parseWorkspaceBackup(JSON.stringify(withZero));
    const zero = restored.jobs.find((job) => job.id === zeroId)!;
    expect(zero.actualQuantityMt).toBe(0);
    expect(zero.completionNote).toBe("  Zero output confirmed  ");
  });

  it("preserves raw product, order, issue, and audit text without normalization", () => {
    const raw = rawBackup();
    const pending = pendingJob(raw);
    pending.productCode = "  =6220 RAW  ";
    pending.orderNo = "  Order / customer text  ";
    pending.issue = {
      reason: "  Operator-entered issue text  ",
      reportedAt: "2026-10-15T02:00:00.000Z",
    };
    raw.events.push({
      id: "raw-event",
      at: "2026-10-15T02:01:00.000Z",
      type: "custom.audit",
      jobId: pending.id,
      message: "  Exact audit message  ",
    });

    const restored = validateWorkspaceBackup(raw);
    const job = restored.jobs.find((item) => item.id === pending.id)!;
    expect(job.productCode).toBe("  =6220 RAW  ");
    expect(job.orderNo).toBe("  Order / customer text  ");
    expect(job.issue?.reason).toBe("  Operator-entered issue text  ");
    expect(restored.events.at(-1)?.message).toBe("  Exact audit message  ");
  });

  it("rejects empty, truncated, oversized, and unsupported JSON", () => {
    expect(() => parseWorkspaceBackup("   ")).toThrow(/empty/i);
    expect(() => parseWorkspaceBackup('{"schemaVersion":1')).toThrow(/valid JSON/i);
    expect(() => parseWorkspaceBackup(" ".repeat(10_000_001))).toThrow(/exceeds/i);
    expect(() => parseWorkspaceBackup('{"schemaVersion":2,"jobs":[],"settings":{},"events":[]}')).toThrow(/catalog.*required/i);
    expect(() => parseWorkspaceBackup('{"schemaVersion":3,"catalog":[],"jobs":[],"settings":{},"events":[]}')).toThrow(/schemaVersion.*unsupported/i);
  });

  it("rejects malformed top-level, settings, job, and event data", () => {
    expect(() => validateWorkspaceBackup(null)).toThrow(/backup must be an object/i);

    const missingSettings = rawBackup();
    delete missingSettings.settings;
    expect(() => validateWorkspaceBackup(missingSettings)).toThrow(/settings.*required/i);

    const badHours = rawBackup();
    badHours.settings.availableHours = 25;
    expect(() => validateWorkspaceBackup(badHours)).toThrow(/availableHours.*24 or less/i);

    const badTime = rawBackup();
    badTime.settings.dayStart = "25:00";
    expect(() => validateWorkspaceBackup(badTime)).toThrow(/dayStart.*HH:mm/i);

    const badRate = rawBackup();
    badRate.settings.rates.PM1 = 0;
    expect(() => validateWorkspaceBackup(badRate)).toThrow(/rates.PM1.*greater than 0/i);

    const badJob = rawBackup();
    badJob.jobs[0].lineId = "PM9";
    expect(() => validateWorkspaceBackup(badJob)).toThrow(/jobs\[0\].lineId/i);

    const badDate = rawBackup();
    badDate.jobs[0].date = "2026-02-30";
    expect(() => validateWorkspaceBackup(badDate)).toThrow(/valid calendar date/i);

    const badStatus = rawBackup();
    badStatus.jobs[0].status = "done";
    expect(() => validateWorkspaceBackup(badStatus)).toThrow(/status.*completed/i);

    const badNumber = rawBackup();
    badNumber.jobs[0].quantityMt = Number.POSITIVE_INFINITY;
    expect(() => validateWorkspaceBackup(badNumber)).toThrow(/quantityMt.*finite number/i);

    const badEvent = rawBackup();
    badEvent.events[0].at = "not-a-time";
    expect(() => validateWorkspaceBackup(badEvent)).toThrow(/events\[0\].at.*ISO date-time/i);
  });

  it("rejects duplicate job, event, and downtime ids", () => {
    const duplicateJobs = rawBackup();
    duplicateJobs.jobs.push({ ...duplicateJobs.jobs[0] });
    expect(() => validateWorkspaceBackup(duplicateJobs)).toThrow(/jobs.*duplicates/i);

    const duplicateEvents = rawBackup();
    duplicateEvents.events.push({ ...duplicateEvents.events[0] });
    expect(() => validateWorkspaceBackup(duplicateEvents)).toThrow(/events.*duplicates/i);

    const duplicateDowntime = rawBackup();
    duplicateDowntime.settings.downtime = [
      { id: "same", date: DATE, lineId: "all", start: "10:00", end: "11:00", reason: "One" },
      { id: "same", date: DATE, lineId: "PM1", start: "12:00", end: "13:00", reason: "Two" },
    ];
    expect(() => validateWorkspaceBackup(duplicateDowntime)).toThrow(/downtime.*duplicates/i);
  });

  it("rejects schedules that exceed the bounded planner and duplicate running jobs per line", () => {
    const unschedulable = rawBackup();
    const huge = pendingJob(unschedulable);
    huge.mode = "bulk";
    huge.bagCount = null;
    huge.quantityMt = 100_000_000;
    expect(() => validateWorkspaceBackup(unschedulable)).toThrow(/cannot schedule job.*bounded calendar/i);

    const noCapacity = rawBackup();
    noCapacity.settings.availableHours = 0;
    expect(() => validateWorkspaceBackup(noCapacity)).not.toThrow();

    const infiniteDuration = rawBackup();
    infiniteDuration.settings.availableHours = 0;
    const unbounded = pendingJob(infiniteDuration);
    unbounded.mode = "bulk";
    unbounded.bagCount = null;
    unbounded.quantityMt = Number.MAX_VALUE;
    expect(() => validateWorkspaceBackup(infiniteDuration)).toThrow(/finite duration/i);

    const duplicateRunning = rawBackup();
    const first = pendingJob(duplicateRunning);
    first.status = "running";
    first.actualStart = "2026-10-15T01:00:00.000Z";
    const second = {
      ...first,
      id: "second-running-job",
      date: "2026-10-16",
      sequence: first.sequence + 1,
      createdAt: "2026-10-15T01:01:00.000Z",
      updatedAt: "2026-10-15T01:01:00.000Z",
    };
    duplicateRunning.jobs.push(second);
    expect(() => validateWorkspaceBackup(duplicateRunning)).toThrow(
      /more than one running job on PM\d.*finish the current running job/i,
    );
  });

  it("validates cross-date downtime and locked plans without changing their planning dates", () => {
    const crossDate = rawBackup();
    const pending = pendingJob(crossDate);
    pending.date = "2026-10-16";
    pending.sequence = 1;
    pending.mode = "bulk";
    pending.bagCount = null;
    pending.quantityMt = 1;
    crossDate.settings.downtime.push({
      id: "next-day-maintenance",
      date: "2026-10-16",
      lineId: pending.lineId,
      start: "08:30",
      end: "20:30",
      reason: "Cross-date maintenance",
    });
    const completed = completedJob(crossDate);
    const locked = JSON.parse(JSON.stringify(completed.lockedSegments));

    const restored = validateWorkspaceBackup(crossDate);
    expect(restored.jobs.find((job) => job.id === pending.id)?.date).toBe("2026-10-16");
    expect(restored.jobs.find((job) => job.id === completed.id)?.lockedSegments).toEqual(locked);
    expect(getScheduledJobs(restored).find((job) => job.id === pending.id)?.plannedStart).toBe(
      Date.parse("2026-10-16T20:30:00+08:00"),
    );
    expect(crossDate.jobs.find((job: any) => job.id === pending.id).date).toBe("2026-10-16");
  });

  it("rejects invalid actual-output and lifecycle timestamp relationships", () => {
    const backwards = rawBackup();
    const done = completedJob(backwards);
    done.actualEnd = "2026-10-15T00:00:00.000Z";
    done.actualStart = "2026-10-15T01:00:00.000Z";
    expect(() => validateWorkspaceBackup(backwards)).toThrow(/actualEnd.*earlier/i);

    const missingEnd = rawBackup();
    completedJob(missingEnd).actualEnd = null;
    expect(() => validateWorkspaceBackup(missingEnd)).toThrow(/completed jobs require/i);

    const pendingActual = rawBackup();
    pendingJob(pendingActual).actualStart = "2026-10-15T01:00:00.000Z";
    expect(() => validateWorkspaceBackup(pendingActual)).toThrow(/pending jobs cannot/i);

    const negativeActual = rawBackup();
    completedJob(negativeActual).actualQuantityMt = -0.01;
    expect(() => validateWorkspaceBackup(negativeActual)).toThrow(/actualQuantityMt.*0 or greater/i);

    const noteOnPending = rawBackup();
    pendingJob(noteOnPending).completionNote = "Not completed";
    expect(() => validateWorkspaceBackup(noteOnPending)).toThrow(/completionNote.*completed job/i);

    const issueOnCompleted = rawBackup();
    completedJob(issueOnCompleted).issue = {
      reason: "Stale issue",
      reportedAt: "2026-10-15T01:00:00.000Z",
    };
    expect(() => validateWorkspaceBackup(issueOnCompleted)).toThrow(/issue.*pending or running/i);
  });

  it("rejects invalid locked segments and cross-job or cross-line identities", () => {
    const wrongJob = rawBackup();
    completedJob(wrongJob).lockedSegments[0].jobId = "another-job";
    expect(() => validateWorkspaceBackup(wrongJob)).toThrow(/jobId.*parent job id/i);

    const wrongLine = rawBackup();
    completedJob(wrongLine).lockedSegments[0].lineId = "PM4";
    expect(() => validateWorkspaceBackup(wrongLine)).toThrow(/lineId.*parent line/i);

    const backwards = rawBackup();
    const segment = completedJob(backwards).lockedSegments[0];
    segment.end = segment.start;
    expect(() => validateWorkspaceBackup(backwards)).toThrow(/segment start/i);

    const pendingLocked = rawBackup();
    pendingJob(pendingLocked).lockedSegments = [{
      jobId: pendingJob(pendingLocked).id,
      lineId: pendingJob(pendingLocked).lineId,
      kind: "production",
      start: 1,
      end: 2,
    }];
    expect(() => validateWorkspaceBackup(pendingLocked)).toThrow(/must be empty/i);
  });

  it("rejects unknown keys, accessor objects, sparse arrays, and excessive collection sizes", () => {
    const unknown = rawBackup();
    unknown.jobs[0].plannedStart = 123;
    expect(() => validateWorkspaceBackup(unknown)).toThrow(/plannedStart.*not supported/i);

    const accessor = rawBackup();
    Object.defineProperty(accessor.jobs[0], "productCode", { get: () => "6220", enumerable: true });
    expect(() => validateWorkspaceBackup(accessor)).toThrow(/accessor property/i);

    const sparse = rawBackup();
    sparse.events = new Array(2);
    expect(() => validateWorkspaceBackup(sparse)).toThrow(/events\[0\].*missing/i);

    const tooMany = rawBackup();
    tooMany.events = new Array(50_001).fill(tooMany.events[0]);
    expect(() => validateWorkspaceBackup(tooMany)).toThrow(/more than 50000/i);

    const injected = JSON.stringify({
      schemaVersion: 1,
      jobs: [],
      settings: rawBackup().settings,
      events: [],
      __proto_pollution__: true,
    });
    expect(() => parseWorkspaceBackup(injected)).toThrow(/not supported/i);
  });

  it("does not share mutable data with the supplied value", () => {
    const raw = rawBackup();
    const restored = validateWorkspaceBackup(raw);
    const originalProduct = raw.jobs[0].productCode;
    const originalRate = raw.settings.rates.PM1;
    const originalMessage = raw.events[0].message;
    const originalCatalogCode = raw.catalog[0].code;
    const originalSegmentStart = completedJob(raw).lockedSegments[0].start;

    restored.jobs[0].productCode = "CHANGED";
    restored.settings.rates.PM1 = 99;
    restored.events[0].message = "CHANGED";
    restored.catalog[0].code = "CHANGED";
    restored.jobs.find((job) => job.status === "completed")!.lockedSegments![0].start = 0;
    expect(raw.jobs[0].productCode).toBe(originalProduct);
    expect(raw.settings.rates.PM1).toBe(originalRate);
    expect(raw.events[0].message).toBe(originalMessage);
    expect(raw.catalog[0].code).toBe(originalCatalogCode);
    expect(completedJob(raw).lockedSegments[0].start).toBe(originalSegmentStart);

    raw.jobs[0].bin = "RAW-CHANGED";
    raw.settings.slowProductPrefixes[0] = "RAW-CHANGED";
    expect(restored.jobs[0].bin).not.toBe("RAW-CHANGED");
    expect(restored.settings.slowProductPrefixes[0]).not.toBe("RAW-CHANGED");
  });

  it("upgrades strict schema-version-one backups and validates schema-version-two catalogs", () => {
    const legacy = rawBackup();
    legacy.schemaVersion = 1;
    delete legacy.catalog;
    const restored: AppState = validateWorkspaceBackup(legacy);
    expect(restored.schemaVersion).toBe(2);
    expect(restored.catalog).toEqual([]);

    const duplicate = rawBackup();
    duplicate.catalog.push({ ...duplicate.catalog[0], id: "another-id", code: `  ${duplicate.catalog[0].code.toLowerCase()}  ` });
    expect(() => validateWorkspaceBackup(duplicate)).toThrow(/duplicate product code/i);

    const missingCatalog = rawBackup();
    delete missingCatalog.catalog;
    expect(() => validateWorkspaceBackup(missingCatalog)).toThrow(/catalog.*required/i);
  });

  it("preserves legacy jobs without pause fields and validates ordered pause intervals", () => {
    const legacy = rawBackup();
    expect(legacy.jobs.every((job: any) => !("pauseIntervals" in job))).toBe(true);
    const restoredLegacy = validateWorkspaceBackup(legacy);
    expect(restoredLegacy.jobs.every(job => !("pauseIntervals" in job))).toBe(true);

    const raw = rawBackup();
    const running = pendingJob(raw);
    running.status = "running";
    running.actualStart = "2026-10-15T01:00:00.000Z";
    running.pauseIntervals = [
      { pausedAt: "2026-10-15T01:30:00.000Z", resumedAt: "2026-10-15T01:45:00.000Z", reason: "First" },
      { pausedAt: "2026-10-15T02:00:00.000Z", resumedAt: null, reason: "Open" },
    ];
    expect(validateWorkspaceBackup(raw).jobs.find(job => job.id === running.id)?.pauseIntervals).toEqual(running.pauseIntervals);

    const pending = rawBackup();
    pendingJob(pending).pauseIntervals = [{ pausedAt: "2026-10-15T01:00:00.000Z", resumedAt: null, reason: "Invalid" }];
    expect(() => validateWorkspaceBackup(pending)).toThrow(/pending jobs cannot have production pauses/i);

    const openCompleted = rawBackup();
    completedJob(openCompleted).pauseIntervals = [{
      pausedAt: completedJob(openCompleted).actualStart,
      resumedAt: null,
      reason: "Still open",
    }];
    expect(() => validateWorkspaceBackup(openCompleted)).toThrow(/completed jobs cannot have an open/i);

    const overlap = rawBackup();
    const completed = completedJob(overlap);
    const completedStart = Date.parse(completed.actualStart);
    completed.pauseIntervals = [
      { pausedAt: completed.actualStart, resumedAt: new Date(completedStart + 20 * 60_000).toISOString(), reason: "First" },
      { pausedAt: new Date(completedStart + 10 * 60_000).toISOString(), resumedAt: completed.actualEnd, reason: "Overlap" },
    ];
    expect(() => validateWorkspaceBackup(overlap)).toThrow(/without overlap/i);
  });

  it("strictly validates optional structured audit changes while preserving old events", () => {
    const raw = rawBackup();
    raw.events.forEach((event: any) => delete event.changes);
    expect(raw.events.every((event: any) => !("changes" in event))).toBe(true);
    raw.events[0].changes = [
      { field: "status", before: "pending", after: "running" },
      { field: "settings.downtime", before: "[]", after: "[{\"id\":\"d1\"}]" },
    ];
    expect(validateWorkspaceBackup(raw).events[0].changes).toEqual(raw.events[0].changes);

    const duplicate = rawBackup();
    duplicate.events[0].changes = [
      { field: "status", before: "pending", after: "running" },
      { field: "status", before: "running", after: "completed" },
    ];
    expect(() => validateWorkspaceBackup(duplicate)).toThrow(/duplicates.*status/i);

    const unchanged = rawBackup();
    unchanged.events[0].changes = [{ field: "status", before: "running", after: "running" }];
    expect(() => validateWorkspaceBackup(unchanged)).toThrow(/changed value/i);

    const unsupported = rawBackup();
    unsupported.events[0].changes = [{ field: "updatedAt", before: "a", after: "b" }];
    expect(() => validateWorkspaceBackup(unsupported)).toThrow(/allowed audit field/i);

    const tooMany = rawBackup();
    tooMany.events[0].changes = Array.from({ length: 101 }, (_, index) => ({
      field: `settings.test${index}`,
      before: index,
      after: index + 1,
    }));
    expect(() => validateWorkspaceBackup(tooMany)).toThrow(/more than 100 items/i);

    const nonscalar = rawBackup();
    nonscalar.events[0].changes = [{ field: "status", before: { value: "pending" }, after: "running" }];
    expect(() => validateWorkspaceBackup(nonscalar)).toThrow(/finite number.*null/i);
  });
});
