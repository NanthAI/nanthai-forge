// SPDX-License-Identifier: Apache-2.0
// Node-free: bundled into the Convex check backend. File reads live in test-timings-file.mjs.
export const timingHistoryLimits = { files: 4096, bytes: 1024 * 1024, runs: 128 };
const positive = value => Number.isFinite(value) && value > 0;
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const testPath = path => /^tests\/[^/\\]+\.test\.mjs$/.test(path) && path.length <= 1024;
const encoder = new TextEncoder();
const utf8Bytes = text => encoder.encode(text).length;
export const emptyHistory = () => ({ version: 1, files: {}, runs: [] });

/** Corrupt or oversized history means round-robin. */
export function parseTimingHistory(text) {
  try {
    if (typeof text !== 'string' || utf8Bytes(text) > timingHistoryLimits.bytes) return emptyHistory();
    const history = JSON.parse(text);
    if (
      history?.version !== 1 ||
      !history.files ||
      typeof history.files !== 'object' ||
      Array.isArray(history.files) ||
      Object.keys(history.files).length > timingHistoryLimits.files ||
      !Array.isArray(history.runs) ||
      history.runs.length > timingHistoryLimits.runs
    )
      return emptyHistory();
    return {
      version: 1,
      files: Object.fromEntries(
        Object.entries(history.files)
          .filter(
            ([file, item]) =>
              testPath(file) && positive(item?.durationMs) && typeof item.updatedAt === 'string',
          )
          .map(([file, item]) => [file, { durationMs: item.durationMs, updatedAt: item.updatedAt }]),
      ),
      runs: history.runs.filter(run => typeof run === 'string' && run.length <= 128),
    };
  } catch {
    return emptyHistory();
  }
}

export const timingDurations = history =>
  Object.fromEntries(Object.entries(history.files).map(([file, item]) => [file, item.durationMs]));

/** One EWMA observation per completed run; retain only the checked snapshot's inventory. */
export function updateTimingHistory(history, { runId, endedAt, files, durations }) {
  if (history.runs.includes(runId)) return history;
  const inventory = new Set(files);
  const entries = new Map(
    Object.entries(history.files).filter(([file]) => inventory.has(file) && testPath(file)),
  );
  for (const [file, durationMs] of Object.entries(durations)) {
    if (!inventory.has(file) || !testPath(file) || !positive(durationMs)) continue;
    const previous = entries.get(file);
    entries.set(file, {
      durationMs: previous ? previous.durationMs * 0.7 + durationMs * 0.3 : durationMs,
      updatedAt: endedAt,
    });
  }
  const retained = [...entries]
    .sort((a, b) => compare(b[1].updatedAt, a[1].updatedAt) || compare(a[0], b[0]))
    .slice(0, timingHistoryLimits.files);
  const next = {
    version: 1,
    files: Object.fromEntries(retained),
    runs: [...history.runs, runId].slice(-timingHistoryLimits.runs),
  };
  let bytes = utf8Bytes(JSON.stringify(next));
  while (bytes > timingHistoryLimits.bytes && retained.length) {
    const [file, item] = retained.pop();
    bytes -=
      utf8Bytes(JSON.stringify(file)) + 1 + utf8Bytes(JSON.stringify(item)) + (retained.length ? 1 : 0);
    delete next.files[file];
  }
  return next;
}

/** Unknown files use the historical nearest-rank p75, or one second without observations. */
export function testDuration(file, durations = {}) {
  if (positive(durations[file])) return durations[file];
  const values = Object.values(durations)
    .filter(positive)
    .sort((a, b) => a - b);
  return values[Math.ceil(values.length * 0.75) - 1] ?? 1000;
}

/** Simulate the supervisor's FIFO queue of whole files across its worker slots. */
export function shardDuration(files, durations = {}, workers = 2) {
  const slots = Array.from({ length: workers }, () => 0);
  const fallback = testDuration('', durations);
  for (const file of files) {
    const slot = slots.indexOf(Math.min(...slots));
    slots[slot] += positive(durations[file]) ? durations[file] : fallback;
  }
  return Math.max(...slots);
}

/** LPT greedy bin packing, with each bin modelled as the runner's concurrent workers. */
export function partitionTests(files, count, durations = {}, workers = 2) {
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(workers) || workers <= 0)
    throw new Error('Expected positive integer shard and worker counts.');
  const ordered = [...new Set(files)].sort(compare);
  const groups = Array.from({ length: Math.min(count, ordered.length) }, () => []);
  if (!Object.values(durations).some(positive)) {
    ordered.forEach((file, index) => groups[index % groups.length].push(file));
    return groups;
  }
  const fallback = testDuration('', durations);
  const weights = Object.fromEntries(
    ordered.map(file => [file, positive(durations[file]) ? durations[file] : fallback]),
  );
  const slots = groups.map(() => Array.from({ length: workers }, () => 0));
  for (const file of ordered.sort((a, b) => weights[b] - weights[a] || compare(a, b))) {
    let best = 0;
    const score = index => [
      Math.max(...slots[index], Math.min(...slots[index]) + weights[file]),
      slots[index].reduce((a, b) => a + b, 0),
      index,
    ];
    for (let index = 1; index < groups.length; index++) {
      const a = score(index),
        b = score(best);
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) best = index;
    }
    const slot = slots[best].indexOf(Math.min(...slots[best]));
    slots[best][slot] += weights[file];
    groups[best].push(file);
  }
  return groups;
}

// Rounded above the observed 23s p75 control preparation, allowing Candidate build
// and result upload too. This is a planning estimate, never measured test evidence.
export const shardJobOverheadMs = 60_000;
/** Estimated test time per shard when capacity is idle. Planning and job setup add
 * about 1.5 minutes before the slowest shard, and static runs in parallel. */
export const shardTargetMs = 150_000;
export const maxTestShards = 20;
/** Convex function calls per check across Actions jobs: eight jobs (seven test
 * shards plus static) at six calls each, as before results carried their log. */
export const checkCallBudget = 48;

/** Prefer the wall target when capacity is idle. Under pressure maximize estimated
 * checks per occupied runner-second, accounting for unused slots and job startup.
 * Budget includes static; org capacity also reserves the optional parallel pack.
 * `callsPerJob` is the Convex calls one job makes; jobs times calls stays within
 * checkCallBudget, so more shards never mean more Convex calls per check. */
export function timedShards(
  files,
  durations = {},
  { concurrencyBudget = 12, callsPerJob = 6, activeChecks = 1, jobCap } = {},
) {
  if (!Number.isSafeInteger(concurrencyBudget) || concurrencyBudget < 2)
    throw new Error('Expected a concurrency budget of at least two jobs.');
  if (!Number.isSafeInteger(callsPerJob) || callsPerJob < 1 || callsPerJob * 2 > checkCallBudget)
    throw new Error('Expected per-job Convex calls that fit two jobs in the check call budget.');
  const capacity = jobCap ?? 20;
  if (
    !Number.isSafeInteger(activeChecks) ||
    activeChecks < 1 ||
    !Number.isSafeInteger(capacity) ||
    capacity < 3
  )
    throw new Error('Expected positive check demand and capacity for test, static and pack jobs.');
  const unique = [...new Set(files)];
  const maximum = Math.min(
    concurrencyBudget - 1,
    Math.floor(checkCallBudget / callsPerJob) - 1,
    maxTestShards,
    jobCap === undefined ? Infinity : capacity - 2,
    unique.length,
  );
  if (!maximum) return [];
  const measured = Object.values(durations).some(positive);
  // No shard can finish before its slowest file, so more shards past that point
  // only spend runner minutes.
  const fallback = testDuration('', durations);
  const heaviest = Math.max(...unique.map(file => (positive(durations[file]) ? durations[file] : fallback)));
  const target = Math.max(shardTargetMs, heaviest);
  const limit = measured ? maximum : Math.min(8, maximum);
  let groups,
    best,
    bestRate = -1;
  for (let count = 1; count <= limit; count++) {
    groups = partitionTests(unique, count, durations);
    const estimates = groups.map(group => shardDuration(group, durations));
    // Plan, static and optional pack consume runner time too. The org hard cap
    // remains GitHub's; this is a fluid throughput estimate, not a reservation.
    const runnerMs = estimates.reduce((sum, ms) => sum + ms, 0) + (count + 3) * shardJobOverheadMs;
    const rate = Math.min(capacity, activeChecks * count) / runnerMs;
    if (rate > bestRate) {
      best = groups;
      bestRate = rate;
    }
    if (measured && Math.max(...estimates) <= target) break;
  }
  return activeChecks > 1 ? best : groups;
}
