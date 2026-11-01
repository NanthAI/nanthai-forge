// B1.5d scoring shared by run-cell (live) and rescore (recorded agent output).

/** Epoch ms a task reached main, from an arm's landing() result. */
export function landedAtMs(landing) {
  if (landing.mergedAt) return Date.parse(landing.mergedAt);
  if (!landing.acceptedAt) return null;
  return Number(landing.acceptedAt) || Date.parse(landing.acceptedAt);
}

/** Per-task record fields that depend on the landing. */
export function landingFields(landing, dispatchedAtMs) {
  const at = landedAtMs(landing);
  return { landing, timeToMainSeconds: at ? (at - dispatchedAtMs) / 1000 : null };
}

/** Cell totals: wall time only when every task landed. */
export function cellSummary(records, taskCount, cellStartMs) {
  const landedTimes = records.map(r => landedAtMs(r.landing)).filter(Boolean);
  const wallSeconds =
    landedTimes.length === taskCount ? (Math.max(...landedTimes) - cellStartMs) / 1000 : null;
  return {
    wallSecondsToAllLanded: wallSeconds,
    landed: records.filter(r => r.landing.landed).length,
    tasks: taskCount,
    landingsPerHour: wallSeconds ? (taskCount / wallSeconds) * 3600 : null,
  };
}
