/** A preview can be committed unchanged only while its first proposed start is still in the future. */
export function draftPlanningFloor(nowIso: string): string {
  const interval=5*60_000;
  return new Date(Math.ceil((Date.parse(nowIso)+interval)/interval)*interval).toISOString();
}

export function draftConfirmationDeadline(rows: ReadonlyArray<{notBefore: string}>): number | null {
  const starts = rows.map(row => Date.parse(row.notBefore)).filter(Number.isFinite);
  return starts.length ? Math.min(...starts) : null;
}

export function isDraftStartPassed(rows: ReadonlyArray<{notBefore: string}>, now: number): boolean {
  const deadline = draftConfirmationDeadline(rows);
  return deadline !== null && now >= deadline;
}
