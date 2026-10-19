import { describe, expect, it } from "vitest";
import { createDefaultSettings, createEmptyState } from "./defaults";
import { createSampleState } from "./sample";

describe("workspace defaults", () => {
  it("creates an empty workspace with neutral, independent settings", () => {
    const first = createEmptyState();
    const second = createEmptyState();

    expect(first).toEqual({
      schemaVersion: 1,
      jobs: [],
      settings: createDefaultSettings(),
      events: [],
    });

    first.settings.rates.PM1 = 99;
    first.settings.slowProductPrefixes.push("TEST");
    expect(second.settings.siteName).toBe("Pellet Plant");
    expect(second.settings.rates.PM1).toBe(8.5);
    expect(second.settings.slowProductPrefixes).toEqual(["6811", "6542"]);
    expect(createSampleState("2026-10-19").settings).toEqual({
      ...createDefaultSettings(),
      siteName: "Demo Pellet Plant",
    });
  });
});
