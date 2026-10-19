import type { AppState, Settings } from "./types";

export function createDefaultSettings(): Settings {
  return {
    siteName: "Pellet Plant",
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
}

export function createEmptyState(): AppState {
  return {
    schemaVersion: 1,
    jobs: [],
    settings: createDefaultSettings(),
    events: [],
  };
}
