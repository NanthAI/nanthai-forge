// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383): the owner's end-user case (comment 00a694d5). Per kept run, the
// Convex cost against the runner-minutes and time to main it saves, for a quiet project (1-2 agents),
// a 3-5 agent project and a 10-agent project, and the cost per 1,000 landings that follows.
//
// Convex cost of a kept run = the measured fixture rows (keep arm minus retire arm, today's code,
// tests/keep-the-run-cost.test.mjs) plus what the fixture's runner does not do, priced from
// docs/operations/cost-to-serve.md: the real twelve-shard ingest, the CI source resolve each new run
// pays, the prove action, the hold-order write and the memoised main-gate reads. Every unmeasured
// part is an upper bound, and every credit a keep earns elsewhere (fewer cascades) is left out of the
// Convex side.
//
// Runner-minutes and time come from the 11-17 trace (tests/keep-the-run-replay.mjs): the median whole
// check and scoped recheck, the elapsed share of the run at each recorded main-move cancel, and how
// often a replacement was retired again.
import { replayKeepTheRun } from './keep-the-run-replay.mjs';
import { scopedRecheckPays } from '../dist/stale-check-keep.js';

// Item f65d8024 and docs/operations/cost-to-serve.md: one 490-byte row per accepted Lane.
const LANDED_FEED_ROW_BYTES = 490;

/** Deterministic measurements from tests/keep-the-run-cost.test.mjs, excluding harness reads.
 * Each write total shows its landed feed rows separately. Red baselines include the failed row. */
export const MEASURED = {
  'global-risk mover, strict': {
    calls: 59,
    documents: 1194,
    readBytes: 1_168_625,
    writeBytes: 441_011 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, fast': {
    calls: 59,
    documents: 1194,
    readBytes: 1_168_185,
    writeBytes: 440_975 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'order-sensitive mover, strict': {
    calls: 59,
    documents: 1194,
    readBytes: 1_168_657,
    writeBytes: 441_031 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'order-sensitive mover, fast': {
    calls: 59,
    documents: 1194,
    readBytes: 1_168_217,
    writeBytes: 440_995 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, fast': {
    calls: 66,
    documents: 1457,
    readBytes: 1_553_962,
    writeBytes: 506_960 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, fast, carry off': {
    calls: 59,
    documents: 1194,
    readBytes: 1_174_805,
    writeBytes: 441_537 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, fast, carry off': {
    calls: 73,
    documents: 1542,
    readBytes: 1_600_969,
    writeBytes: 564_092 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, strict, red': {
    calls: 49,
    documents: 978,
    readBytes: 977_944,
    writeBytes: 381_425 + LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, strict, red': {
    calls: 32,
    documents: 556,
    readBytes: 578_128,
    writeBytes: 228_157 + LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, strict, C1 follower': {
    calls: 128,
    documents: 2605,
    readBytes: 2_593_619,
    writeBytes: 908_583 + 3 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, strict, C1 follower': {
    calls: 136,
    documents: 2924,
    readBytes: 3_084_818,
    writeBytes: 996_581 + 3 * LANDED_FEED_ROW_BYTES,
  },
  'no checking row, strict': {
    calls: 23,
    documents: 432,
    readBytes: 440_203,
    writeBytes: 169_602 + LANDED_FEED_ROW_BYTES,
  },
  'no checking row, fast': {
    calls: 23,
    documents: 432,
    readBytes: 440_039,
    writeBytes: 169_584 + LANDED_FEED_ROW_BYTES,
  },
};

/** The wired hold-order write: the kept run's landing row and one forked attempt (bindAdmissionProof's
 * shape), read and written once. Bound: twice the largest measured pair (8,082 B). */
export const HOLD_ORDER = { calls: 0, readBytes: 16_384, writeBytes: 16_384 };
/** `mainGate` and `currentFastMode`, memoised per sweep, read only when a checking row reaches the
 * keep rule. Bound: a few audit-state documents, inside the sweep's existing transaction. */
export const GATE_READS = { calls: 0, readBytes: 16_384, writeBytes: 0 };
/** cost-to-serve.md: packed twelve-shard CI batch ingest (6 calls; 288,826 DB B; 20,084 reply B). */
export const INGEST = { calls: 6, readBytes: 288_826, writeBytes: 0, egressBytes: 20_084 };
/** cost-to-serve.md: `projectHostedActionsSource:resolve`, 114 calls and 13.848 MB read over ten
 * landings, one twelve-shard run each. */
export const RESOLVE = { calls: 11.4, readBytes: 1_384_800, writeBytes: 0 };
/** cost-to-serve.md: `projectHostedReuse:prove`, 8 calls: 0.526 MB egress, 0.007953 GB-hours. */
export const PROVE = { calls: 1, readBytes: 0, writeBytes: 0, egressBytes: 65_750, gbHours: 0.000994 };
/** Lane B: one composition job, priced from cost-to-serve.md's per-landing families over its
 * measured 2.4 composition jobs per landing (S6): `projectConvexSourceNode:step`, source control and
 * V8, `projectConvexSourceObjects:resolve`, and save, sync, compose and conflict resolution. Those
 * families also carry every save and check source delivery, so this is an upper bound per compose. */
export const COMPOSE = {
  calls: (7.6 + 24.4 + 29 + 11.7) / 2.4,
  readBytes: (1_079_630.4 + 408_578.7 + 360_023.1) / 2.4,
  writeBytes: (193_606.3 + 31_456.4) / 2.4,
  egressBytes: (15_570_999.5 + 256.5) / 2.4,
  gbHours: (18.0823 + 1.2964 + 0.0965) / 2.4 / 3600,
};
/** Lane B: what a probe adds in mutations: the sweep's precompose reserve, the precompose settlement
 * that caches or fails it with its rule re-evaluation, and the finish reserve that adopts it, against
 * the one reserve a retire writes. Bound: four `projectHostedFinishDriver:step`-sized mutations at
 * twice the a6 mean (113 calls; 6.965 MB read, 1.268 MB written). */
export const PROBE_SETTLE = {
  calls: 4,
  readBytes: 8 * (6_965_000 / 113),
  writeBytes: 8 * (1_268_000 / 113),
  egressBytes: 0,
  gbHours: 0,
};

/** Professional rates (cost-to-serve.md). The serving proxy is DB I/O and egress; calls and action
 * compute are included in the plan, and priced only in the full-list figure. */
export const RATES = { ioPerGb: 0.2, egressPerGb: 0.12, perCall: 2e-6, perGbHour: 0.3 };
/** A private repository's GitHub-hosted Linux runner list price, per job-minute: what a saved
 * runner-minute is worth to an end user (runner-minutes on this public repository cost $0). */
export const RUNNER_MINUTE_USD = 0.008;

const add = (...parts) => {
  const total = { calls: 0, readBytes: 0, writeBytes: 0, egressBytes: 0, gbHours: 0 };
  for (const [sign, part] of parts)
    for (const key of Object.keys(total)) total[key] += sign * (part[key] ?? 0);
  return total;
};
const minus = (keep, retire) => add([1, MEASURED[keep]], [-1, MEASURED[retire]]);
export const servingUsd = c =>
  ((c.readBytes + c.writeBytes) / 1e9) * RATES.ioPerGb + (c.egressBytes / 1e9) * RATES.egressPerGb;
export const fullListUsd = c => servingUsd(c) + c.calls * RATES.perCall + c.gbHours * RATES.perGbHour;

/** The wired keep against the retire it replaces on the same scenario, switch on against off: fixture
 * calls and DB bytes from the mover's pass until every landing settles (the "line 3" rows of
 * tests/hosted-landing-keep-the-run.test.mjs hold the wiring to these). They include the hold-order write
 * and the gate reads; the fixture's runner reports in few calls and resolves no source. Bytes moved by a few
 * (carry, scoped recheck) and about 1 KB (red, which retires more source work) with the source repair wakes (e62d834b, review 308f217c): each scheduled source step arms a wake at its lease end that its commit cancels (a scheduler insert, a status read and a cancel), and a job that fails or is cancelled outside a commit reads its step row to cancel any wake left; no call. */
// Item 85f456c1 (2026-11-20): carry and red moved -19 write bytes each: the line's Flow fields (summary day, check key)
// grow slightly more on the retire's extra run than on the keep. Calls and reads unchanged.
// Item 85f456c1, In-queue writer and batch truth gap (2026-11-20): each moved by one write byte (carry and scoped recheck +1, red -1, keep minus retire): a bound
// Lane's mark now says 'queued', one byte longer than 'saved'.
// Calls and reads unchanged.
// e3082c24: source timings on compose settlement move the exact byte deltas.
// Candidate 7: dispatch attribution rides on the run and metrics rows and on
// a deferred replacement's existing attempt. The number of calls is the same.
// Item 2c420916: the health facts add 34 or 35 bytes per acceptance row. The carry
// delta moves +135 read/-1 write bytes, scoped recheck +102 read, red -34 read.
// The scenarios read different existing receipts. Call counts are unchanged.
// Item 0930a720: prefetch saves a descriptor call and 11,410 read bytes on the
// replacement compose in the red retire arm, narrowing the keep's savings.
// Item f65d8024 adds a bounded feed projection to terminal settlement and reuses the loaded
// acceptance plan during publication. The arms settle different rows and calls stay unchanged.
export const WIRED = {
  carry: { calls: 7, readBytes: 405_020, writeBytes: 74_728 },
  'scoped-recheck': { calls: 17, readBytes: 534_892, writeBytes: 143_345 },
  red: { calls: -17, readBytes: -385_993, writeBytes: -144_697 },
};

/** Convex delta of one kept run against the retire it replaces (positive = the keep costs more). */
export const KEPT_CONVEX = {
  // Its pass carries: one prove action; the retire's replacement would have resolved its source.
  carry: add([1, WIRED.carry], [1, PROVE], [-1, RESOLVE]),
  // Carry with an overlapping follower: today's keep (no order) against today's retire (order held),
  // the upper bound for the wired hold-order keep.
  'carry, C1 follower': add(
    [1, minus('unrelated mover, strict, C1 follower', 'global-risk mover, strict, C1 follower')],
    [1, PROVE],
    [-1, RESOLVE],
    [1, HOLD_ORDER],
    [1, GATE_READS],
  ),
  // Carry refused, then the scoped recheck: the kept run's own completion is a real ingest the
  // retired run never paid; the recheck and the retire's replacement each resolve source (no credit).
  'scoped-recheck': add([1, WIRED['scoped-recheck']], [1, INGEST], [1, PROVE]),
  // The kept run fails: the landing ends; the retire's replacement would have resolved, run and failed.
  red: add([1, WIRED.red], [-1, RESOLVE]),
};

/** Runner job-minutes and minutes to main one kept run saves against a retire at elapsed share `e`.
 * Both arms pay the elapsed part. The retire pays a full replacement, which further movers retire
 * `again` more times on average (each wastes half a run); the keep pays the rest of its run, plus a
 * scoped recheck (which those movers may retire too) when it cannot carry. */
export function keptSaving(kind, { e, again, full, scoped }) {
  const cascade = (again * full.jobs) / 2;
  const cascadeWall = (again * full.wall) / 2;
  if (kind !== 'scoped-recheck') return { jobs: e * full.jobs + cascade, wall: e * full.wall + cascadeWall };
  const hit = (again * scoped.wall) / full.wall;
  return {
    jobs: e * full.jobs + cascade - scoped.jobs * (1 + hit / 2),
    wall: e * full.wall + cascadeWall - scoped.wall * (1 + hit / 2),
  };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2;
};

/** The 11-17 window is the 10-agent project (114 landings; at most 10-12 active builders). Smaller
 * projects land proportionally less often, so a run meets a main move, and a replacement meets
 * another, proportionally less often. */
export const TIERS = [
  { name: '1-2 agents', agents: 1.5 },
  { name: '3-5 agents', agents: 4 },
  { name: '10 agents', agents: 10 },
];

/** Lane B probe Convex cost per landing at the trace's 10 agents, scaled to `scale` (agents / 10).
 * A first probe on a run kept to its end replaces the retire's recompose and pays only its mutations;
 * a first probe on a run retired later, a re-probe and a probe a later mover made stale each pay a
 * whole compose too. Second-mover composes need two movers in one run, so they scale twice; the
 * trace's count is floored at the cascade rate the saving side credits (`again` per probe). */
export function probeOverhead(probes, landings, scale, again, price) {
  if (!probes) return 0;
  const first = probes.first + probes.firstRetiredLater;
  const second = Math.max((probes.again + probes.stale) * scale * scale, first * scale * again);
  const extraComposes = probes.firstRetiredLater * scale + second;
  const settles = first * scale + second;
  return (extraComposes * price(COMPOSE) + settles * price(PROBE_SETTLE)) / landings;
}

export function scenarioTable(replay = replayKeepTheRun()) {
  const { calibration, outcomes, landings, probes } = replay;
  const { full, scoped, scopedShare } = calibration;
  const kept = Object.values(outcomes).reduce((a, b) => a + b, 0) - (outcomes['retired-later'] ?? 0);
  const economics = e => ({ elapsed: e, scopedShare, redShare: 0 });
  // Carry and red keep at any elapsed share: their typical case is the median recorded cancel. A
  // scoped recheck keeps only where it pays: its typical case is the median of those, its worst
  // case is just past the payback point.
  const carryE = median(calibration.elapsed);
  const paying = calibration.elapsed.filter(e => scopedRecheckPays(economics(e)));
  const scopedE = median(paying);
  const scopedWorstE = Math.max(scopedShare.jobs, scopedShare.wall) + 0.01;
  const againAt10 = 57 / calibration.landingsWithCancels - 1;
  return TIERS.map(tier => {
    const scale = tier.agents / 10;
    const again = againAt10 * scale;
    const keptPerLanding = (kept / landings) * scale;
    // Lane B's probes, spread over its kept runs so every row prices a kept run in full.
    const probeServing = probeOverhead(probes, landings, scale, again, servingUsd);
    const probeFullList = probeOverhead(probes, landings, scale, again, fullListUsd);
    const rows = Object.entries({
      carry: carryE,
      'carry, C1 follower': carryE,
      red: carryE,
      'scoped-recheck': scopedE,
      'scoped-recheck, worst kept': scopedWorstE,
    }).map(([kind, e]) => {
      const convex = KEPT_CONVEX[kind.replace(', worst kept', '')];
      const saved = keptSaving(kind.startsWith('scoped') ? 'scoped-recheck' : kind, {
        e,
        again,
        full,
        scoped,
      });
      return {
        kind,
        elapsed: e,
        savedJobMinutes: saved.jobs,
        savedWallMinutes: saved.wall,
        savedRunnerUsd: saved.jobs * RUNNER_MINUTE_USD,
        convexServingUsd: servingUsd(convex) + probeServing / keptPerLanding,
        convexFullListUsd: fullListUsd(convex) + probeFullList / keptPerLanding,
        convexBytes: convex.readBytes + convex.writeBytes + convex.egressBytes,
        convexCalls: convex.calls,
      };
    });
    const worst = Math.max(...rows.map(r => r.convexServingUsd));
    return {
      ...tier,
      keptPerLanding,
      againPerReplacement: again,
      probeServingUsdPer1000Landings: probeServing * 1000,
      probeFullListUsdPer1000Landings: probeFullList * 1000,
      rows,
      // Every kept run priced at the costliest kind: the upper bound per 1,000 landings.
      servingUsdPer1000Landings: keptPerLanding * 1000 * worst,
      fullListUsdPer1000Landings: keptPerLanding * 1000 * Math.max(...rows.map(r => r.convexFullListUsd)),
    };
  });
}
