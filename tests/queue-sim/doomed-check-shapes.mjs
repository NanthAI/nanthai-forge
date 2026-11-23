// SPDX-License-Identifier: Apache-2.0
// Item 1018d0f8: checks an older order-sensitive entry makes unusable (lost runner time). Every shape
// runs through the real queue code, one JSON line each (MEASURE_OUT appends them to a file; LABEL tags
// the lines of one run, SHAPES=a,b picks shapes). Run explicitly, like replay-runner.mjs:
//   LABEL=today nforge heavy --no-build -- \
//     node --import ./tests/check-runtime.mjs --test tests/queue-sim/doomed-check-shapes.mjs
// Columns: runs, runs no landing used (lostRuns) and their runner ticks (lostTicks), landing ticks
// after arrival (mean, max, plain and order-sensitive changes apart), Convex calls, DB bytes, idle tasks.
import test from 'node:test';
import { appendFileSync } from 'node:fs';
import { synthetic } from '../hosted-landing-batches-fixture.mjs';
import { drive } from './overtake-drive.mjs';
import { stream as mixed } from './streams.mjs';
Object.assign(process.env, {
  ...synthetic,
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-overtake',
});
const LABEL = process.env.LABEL ?? '';
const OUT = process.env.MEASURE_OUT;
const only = process.env.SHAPES ? process.env.SHAPES.split(',') : null;
const D = 150 * Number(process.env.DSCALE || 1);
const spend = index => (f, ids) => {
  for (const row of f.tables.projectHostedLandingRequests.values())
    if (row.submissionId === ids[index])
      f.patch('projectHostedLandingRequests', row._id, { overtaken: 'earlier:generation' });
};
const risky = i => `.github/actions/w${i}/action.yml`;
const script = i => `scripts/test-s${i}.mjs`;
const stream = (seed, count, gap, riskShare, mode) => mixed(seed, count, gap, riskShare, mode, D);
const shapes = {
  // Incident 0e94a117 shape (builder's replay): schema re-checks 1000 ticks, step spent, late plain arrivals.
  'incident-k3': {
    memberPaths: ['src/first.ts', 'convex/schema.ts', 'src/p1.ts', ...[0, 1, 2].map(i => `src/q${i}.ts`)],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 3 ? 0 : 300),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 1000) : D),
  },
  'incident-k6': {
    memberPaths: [
      'src/first.ts',
      'convex/schema.ts',
      'src/p1.ts',
      ...[0, 1, 2, 3, 4, 5].map(i => `src/q${i}.ts`),
    ],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 3 ? 0 : 300),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 1000) : D),
  },
  // Same, step NOT spent: the late plain arrivals may still overtake once (43b51a5e).
  'incident-k6-unspent': {
    memberPaths: [
      'src/first.ts',
      'convex/schema.ts',
      'src/p1.ts',
      ...[0, 1, 2, 3, 4, 5].map(i => `src/q${i}.ts`),
    ],
    fixture: { landingMode: 'fast' },
    arrives: i => (i < 3 ? 0 : 300),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 1000) : D),
  },
  // Normal-speed schema (same check time as everyone), late plain arrivals mid-check.
  'schema-even-k4': {
    memberPaths: ['src/first.ts', 'convex/schema.ts', ...[0, 1, 2, 3].map(i => `src/q${i}.ts`)],
    fixture: { landingMode: 'fast' },
    arrives: i => (i < 2 ? 0 : 60 + 20 * i),
    duration: i => (i === 0 ? 0 : D),
  },
  // e66c904c type: newer changes with their own risk (CI actions) behind the schema entry, one plain.
  'own-risk-3': {
    memberPaths: ['src/first.ts', 'convex/schema.ts', ...[0, 1, 2].map(risky), 'src/plain.ts'],
    fixture: { landingMode: 'fast' },
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 400) : D),
  },
  'own-risk-3-late': {
    memberPaths: ['src/first.ts', 'convex/schema.ts', ...[0, 1, 2].map(risky), 'src/plain.ts'],
    fixture: { landingMode: 'fast' },
    arrives: i => (i < 2 ? 0 : 100),
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 400) : D),
  },
  // 1539fbee type: a check-script change arriving behind two older plain entries still checking.
  'script-behind-plain': {
    memberPaths: ['src/a.ts', 'src/b.ts', script(0), 'src/c.ts', 'src/d.ts'],
    fixture: { landingMode: 'fast' },
    arrives: i => i * 40,
    duration: () => D,
  },
  // Two check-script changes and plain traffic around them (eae4125b lost to 22167f83 and 1539fbee).
  'two-scripts-stream': {
    memberPaths: ['src/a.ts', script(0), 'src/b.ts', script(1), 'src/c.ts', 'src/d.ts', 'src/e.ts'],
    fixture: { landingMode: 'fast' },
    arrives: i => i * 50,
    duration: () => D,
  },
  // The holder fails: everything checked on its predicted head must recover without it.
  'holder-withdrawn': {
    memberPaths: ['src/first.ts', 'convex/schema.ts', ...[0, 1, 2].map(i => `src/q${i}.ts`), risky(9)],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 2 ? 0 : 100),
    withdraws: (i, nth) => i === 1 && nth === 2,
    duration: (i, nth) => (i === 0 ? 0 : i === 1 ? (nth === 1 ? 30 : 600) : D),
  },
  // No risk at all: the fix must change nothing here.
  'plain-8': {
    memberPaths: Array.from({ length: 8 }, (_, i) => `src/p${i}.ts`),
    fixture: { landingMode: 'fast' },
    arrives: i => i * 30,
    duration: () => D,
  },
  // 43b51a5e pass-age guard: an older plain entry O is still checking ahead of the spent schema holder.
  // When O lands the holder re-pins, and a newer change that already passed takes main then.
  'older-ahead': {
    memberPaths: ['src/o.ts', 'convex/schema.ts', 'src/y0.ts', 'src/y1.ts'],
    fixture: { landingMode: 'fast' },
    prepare: spend(1),
    arrives: i => (i < 2 ? 0 : 60),
    duration: i => (i === 0 ? 3 * D : D),
  },
  // Dogfood-like risk share (about one landing in ten is order-sensitive), three seeds.
  'stream-lo-1': stream(101, 16, 40, 0.1),
  'stream-lo-2': stream(202, 16, 40, 0.1),
  'stream-lo-3': stream(303, 16, 40, 0.1),
  'stream-a': stream(11, 14, 45, 0.3),
  'stream-b': stream(29, 14, 45, 0.3),
  'stream-c': stream(53, 14, 25, 0.2),
  'stream-d': stream(71, 14, 70, 0.4),
  'stream-strict': stream(11, 14, 45, 0.3, 'strict'),
};
const mean = values => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
for (const [name, shape] of Object.entries(shapes)) {
  if (only && !only.includes(name)) continue;
  test(name, async t => {
    let line;
    try {
      const width = process.env.WIDTH ? { concurrency: Number(process.env.WIDTH) } : {};
      const r = await drive(t, {
        ownerApprovalPaths: ['scripts/deploy*'],
        ...shape,
        fixture: { ...shape.fixture, ...width },
      });
      const landed = r.landedAt.filter(v => v !== undefined);
      const lat = r.landedAt.map((v, i) => (v === undefined ? null : v - (shape.arrives?.(i) ?? 0)));
      const plain = shape.memberPaths.map(p => /^src\//.test(p));
      const used = r.runTicks.filter(x => x.used),
        lost = r.runTicks.filter(x => !x.used);
      line = {
        label: LABEL,
        shape: name,
        runs: r.runTicks.length,
        lostRuns: lost.length,
        lostTicks: lost.reduce((a, b) => a + b.ticks, 0),
        usedTicks: used.reduce((a, b) => a + b.ticks, 0),
        landed: landed.length,
        meanLat: mean(lat.filter(v => v !== null)),
        maxLat: Math.max(...lat.filter(v => v !== null)),
        plainLat: mean(lat.filter((v, i) => v !== null && plain[i])),
        riskLat: mean(lat.filter((v, i) => v !== null && !plain[i])),
        last: Math.max(...landed),
        calls: r.calls,
        readMB: +(r.readBytes / 1e6).toFixed(2),
        writeMB: +(r.writeBytes / 1e6).toFixed(2),
        idle: r.idle,
        // First-check decisions (proof or refusal reason) and the landings whose pass carried across
        // a moved main, with the main paths it carried across.
        firstCheck: Object.fromEntries(
          [...new Set(r.firstCheck)].map(reason => [reason, r.firstCheck.filter(x => x === reason).length]),
        ),
        carried: r.proofs.flatMap((proof, i) => (proof ? [{ entry: i, across: proof.mainPaths }] : [])),
        lat,
        perEntryRuns: r.runs,
        waits: r.orderWaits.map(w => w.map(x => x.held).join('+')),
      };
    } catch (error) {
      line = { label: LABEL, shape: name, error: String(error.message).slice(0, 600) };
    }
    if (OUT) appendFileSync(OUT, JSON.stringify(line) + '\n');
    console.log(JSON.stringify(line));
  });
}
