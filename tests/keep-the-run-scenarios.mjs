// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
 * Each write total shows its landed feed rows separately. Red baselines include the failed row.
 * Item 9064e885 stamps proof pins and verified wait facts on existing rows. The fixed-clock
 * fixtures add 1,672 to 34,173 read bytes and 223 to 8,502 write bytes, with the same call and
 * document counts. The two C1 follower cases also exercise the order-history fields.
 * Item ced8e98f adds 2,085 to 15,392 read bytes and 1,014 to 4,781 write bytes
 * on existing rows, with the same call and document counts.
 * Item 4e013cdb: cadence and first-check donor evidence ride existing rows. The C1 cases
 * each read 4,002 B and write 884 B more, with unchanged calls and document counts.
 * Item ced8e98f follow-up: each replaced attempt names its cause and each landed attempt
 * its no-hold stamp, on the same writes: 0 to 180 read and 109 to 398 write bytes more.
 * Item fc1831eb: the Lane overlap row carries `saves` for Loose ends, on rows already read: 50 to 170 read bytes more in the
 * cases, with unchanged calls and document counts. */
export const MEASURED = {
  'global-risk mover, strict': {
    calls: 59,
    documents: 1194,
    readBytes: 1_179_936,
    writeBytes: 444_740 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, fast': {
    calls: 59,
    documents: 1194,
    readBytes: 1_179_496,
    writeBytes: 444_704 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'order-sensitive mover, strict': {
    calls: 59,
    documents: 1194,
    readBytes: 1_179_968,
    writeBytes: 444_760 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'order-sensitive mover, fast': {
    calls: 59,
    documents: 1194,
    readBytes: 1_179_528,
    writeBytes: 444_724 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, fast': {
    calls: 66,
    documents: 1457,
    readBytes: 1_571_648,
    writeBytes: 511_949 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, fast, carry off': {
    calls: 59,
    documents: 1194,
    readBytes: 1_186_116,
    writeBytes: 445_266 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, fast, carry off': {
    calls: 73,
    documents: 1542,
    readBytes: 1_618_305,
    writeBytes: 569_857 + 2 * LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, strict, red': {
    calls: 49,
    documents: 978,
    readBytes: 985_643,
    writeBytes: 384_647 + LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, strict, red': {
    calls: 32,
    documents: 556,
    readBytes: 582_490,
    writeBytes: 230_043 + LANDED_FEED_ROW_BYTES,
  },
  'global-risk mover, strict, C1 follower': {
    calls: 128,
    documents: 2605,
    readBytes: 2_625_810,
    writeBytes: 918_025 + 3 * LANDED_FEED_ROW_BYTES,
  },
  'unrelated mover, strict, C1 follower': {
    calls: 136,
    documents: 2924,
    readBytes: 3_139_926,
    writeBytes: 1_011_526 + 3 * LANDED_FEED_ROW_BYTES,
  },
  'no checking row, strict': {
    calls: 23,
    documents: 432,
    readBytes: 444_010,
    writeBytes: 170_948 + LANDED_FEED_ROW_BYTES,
  },
  'no checking row, fast': {
    calls: 23,
    documents: 432,
    readBytes: 443_846,
    writeBytes: 170_930 + LANDED_FEED_ROW_BYTES,
  },
};

/** Byte tolerance (Item 168e4ed8, friction e5d08bac). Calls and document counts stay exact; stored bytes
 * may drift inside a band, so two Lanes that each grow a stored message by a few bytes do not both edit
 * the same pinned rows and conflict (2026-11-22: receipts 3b12acba and f464dea8 both moved WIRED.red, and
 * Lanes 5aab97d0 and aff9138d then conflicted; one landing took 3 land runs).
 *
 * Where the numbers come from, the history of edits to these rows (the comments above `WIRED` and
 * `MEASURED`): message and field growth moved a delta by 1, 1, 19, 34, 35, 90, 135 or 180 bytes. Features
 * that wired a new fact (receipt pins, replay evidence, donor evidence, queue-row read) moved it by 724 to
 * 4,162 bytes and each carried its own Item. So:
 * - `WIRED` (keep minus retire, small deltas): a measured delta within 256 bytes of the pin passes, in
 *   either direction, on read and write bytes. 256 covers every message-growth edit above with margin and
 *   stays under every feature-sized one, so a feature still re-pins with its reason.
 * - `MEASURED` (whole-scenario totals of 0.4 to 3.1 MB read): a ceiling of the pin plus 0.25%, never less
 *   than 64 bytes (about 3 bytes on each of the 1,194 rows the main scenario reads). One-sided: a drop
 *   never fails. An extra row is an extra document, which stays exact, so the band hides only growth
 *   of rows already read or written.
 * The band is measured from the pin, not from the last landing, so drift cannot accumulate: the first
 * change that moves a number past the band re-pins it, with the reason, as before. A change that edits
 * these rows without need should not: leave the pin alone while the measurement is inside the band. */
export const WIRED_BYTE_BAND = 256;
export const MEASURED_BYTE_BAND = { relative: 0.0025, floor: 64 };
const measuredBand = pinned =>
  Math.max(MEASURED_BYTE_BAND.floor, Math.ceil(pinned * MEASURED_BYTE_BAND.relative));

/** The per-metric ceiling a `MEASURED` scenario must stay under. `extraWriteBytes` is the fixture's
 * feed-commit and alias projection writes, which are added on top of the pinned write total. */
export const measuredCeiling = (pin, extraWriteBytes = 0) => ({
  calls: pin.calls,
  documents: pin.documents,
  readBytes: pin.readBytes + measuredBand(pin.readBytes),
  writeBytes: pin.writeBytes + measuredBand(pin.writeBytes) + extraWriteBytes,
});

/** Problems of one `MEASURED` scenario, empty when it passes. Each names the scenario, the metric and the delta. */
export function measuredProblems(name, pin, measured, extraWriteBytes = 0) {
  const limit = measuredCeiling(pin, extraWriteBytes);
  const problems = [];
  for (const metric of ['calls', 'documents'])
    if (measured[metric] > pin[metric])
      problems.push(
        `${name}: ${metric} ${measured[metric]} > pinned ${pin[metric]} (${signed(measured[metric] - pin[metric])}; calls and documents have no band)`,
      );
  for (const metric of ['readBytes', 'writeBytes']) {
    const base = pin[metric] + (metric === 'writeBytes' ? extraWriteBytes : 0);
    const delta = measured[metric] - base;
    if (measured[metric] > limit[metric])
      problems.push(
        `${name}: ${metric} ${measured[metric]} is ${signed(delta)} B over the pin ${base} (band +${limit[metric] - base} B); re-pin MEASURED with the reason`,
      );
  }
  return problems;
}

/** Problems of one `WIRED` kind: calls exact, bytes within WIRED_BYTE_BAND of the pin either way. */
export function wiredProblems(kind, pin, delta) {
  const problems = [];
  if (delta.calls !== pin.calls)
    problems.push(
      `${kind}: calls delta ${delta.calls} != pinned ${pin.calls} (${signed(delta.calls - pin.calls)}; exact)`,
    );
  for (const metric of ['readBytes', 'writeBytes'])
    if (Math.abs(delta[metric] - pin[metric]) > WIRED_BYTE_BAND)
      problems.push(
        `${kind}: ${metric} delta ${delta[metric]} is ${signed(delta[metric] - pin[metric])} B from the pin ${pin[metric]} (band +/-${WIRED_BYTE_BAND} B); set WIRED.${kind}.${metric} to the measured delta, with the reason`,
      );
  return problems;
}
const signed = n => (n >= 0 ? `+${n}` : `${n}`);

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
// Item 9064e885 adds receipt pins and the first kept transition on existing rows.
// The keep and retire paths touch those rows a different number of times. Calls are unchanged.
// Item ced8e98f records replay evidence on existing writes. Each arm touches those rows at
// different stages. The measured deltas preserve the alias-write split and exact call counts.
// Item 4e013cdb: audit and first-check donor evidence add 180 read bytes to carry and
// 4,162 read/884 write bytes to scoped recheck. The red delta and call counts are unchanged.
// Item ced8e98f follow-up: replacement causes add 90 read/90 write bytes to carry and 90 read/180
// write bytes to scoped recheck. The red delta and call counts are unchanged.
// Item 10b0a94b: a main-race recheck reads the queue row to see whether a check slot is free
// (option B), adding 724 read bytes to scoped recheck. Writes, red, carry and calls are unchanged.
// Item 5b4b5918: the keep arms judge their bound admission proof in the binding tick, so a claim and
// an advance go: carry and scoped recheck each 2 fewer calls, about 51 KB fewer reads and 21 KB fewer writes.
// Item fc1831eb: the fixture Intent has no Item marker, so the legacy no-Item landing note is no longer posted in
// either arm: each measured delta moves by 11 read and 2 write bytes; calls unchanged.
// Item 168e4ed8: the stored CHECK_FAILED text names the retry form (about 120 more bytes per failed
// check): red writes 30 bytes more against its retire; the other arms are unchanged.
// Item ced8e98f (recheck none): every attempt write stamps the causes on the replay it already
// writes, adding 251 read/40 write bytes to carry, 375 read/122 write bytes to scoped recheck and
// moves red by -233 read/-122 write bytes. No call is added.
// Item 5b4b5918 moved main: a kept proof bound on a moved main with nothing ahead starts its retry in the
// binding write, so its ready write, acceptance preparation and refused publish go: carry and scoped
// recheck each 7 fewer calls, about 184 KB fewer reads and 42 KB fewer writes.
// Item 411727ba: source resolve reuses the project row its step fence read, so each resolve call reads the
// project document once instead of twice; the red keep runs fewer resolves than its retire: red moves by
// +2,251 read bytes. No call or write changes.
// Item 5e3c3a3c (recompose cap): the retire arm's re-checked request row carries `mainRaces: 1` (14 B)
// on every read of it, so the carry delta moves by -609 read bytes. No call or write changes.
// Item 3c01e736: the compose state stores its compact server steps (about 225 bytes), so each read or write of
// a compose row moves by that much: carry +675 read/-98 write, scoped recheck +742 read/+4 write, red -917 read/-309 write.
// No call is added.
// Item fa2c1383: keep/cancel decisions stay on the canonical run. The keep arm writes its observation
// once, and the retire stamps its decision on the existing cancellation write. Calls stay exact.
// Item 1018d0f8 (discarded run count): request rows carry `runs` and short run keys (about 31 B) on every read,
// and the finish-read copies leave them out; the arms read different numbers of each, so carry moves by -738,
// scoped recheck by +282 and red by -1,176 read bytes. No call is added; writes stay within the band.
export const WIRED = {
  carry: { calls: -2, readBytes: 189_377, writeBytes: 18_883 },
  'scoped-recheck': { calls: 8, readBytes: 329_089, writeBytes: 89_950 },
  red: { calls: -17, readBytes: -387_669, writeBytes: -141_605 },
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
