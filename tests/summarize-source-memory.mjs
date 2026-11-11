// SPDX-License-Identifier: Apache-2.0
// Recompute the research tables from raw paired observations; no workload or network calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootstrapInterval } from '../scripts/bootstrap-interval.mjs';
const report = JSON.parse(readFileSync(process.argv[2] ?? 'tests/fixtures/source-step-memory.json'));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pick = (size, phase, implementation = 'current') =>
  report.runs.filter(
    run => run.files === size && run.phase === phase && run.implementation === implementation,
  );
const summary = { phases: [], sync: [], fits: [] };
for (const phase of ['save', 'sync', 'compose', 'conflict-sync']) {
  const points = report.sizes.map(size => {
    const runs = pick(size, phase);
    assert.equal(runs.length, report.pairs);
    assert(runs.length % 2 === 1, 'median helper requires an odd run count');
    const rss = runs.map(run => run.maxRssBytes / 1048576);
    summary.phases.push({
      files: size,
      phase,
      medianMiB: median(rss),
      minMiB: Math.min(...rss),
      maxMiB: Math.max(...rss),
      medianWallMs: median(runs.map(run => run.wallMs)),
    });
    return [size, median(rss)];
  });
  const xbar = points.reduce((n, p) => n + p[0], 0) / points.length;
  const ybar = points.reduce((n, p) => n + p[1], 0) / points.length;
  const slope =
    points.reduce((n, [x, y]) => n + (x - xbar) * (y - ybar), 0) /
    points.reduce((n, [x]) => n + (x - xbar) ** 2, 0);
  const intercept = ybar - slope * xbar;
  const residual = points.reduce((n, [x, y]) => n + (y - intercept - slope * x) ** 2, 0);
  const total = points.reduce((n, [, y]) => n + (y - ybar) ** 2, 0);
  summary.fits.push({
    phase,
    interceptMiB: intercept,
    slopeMiBPerFile: slope,
    filesAt512MiB: (512 - intercept) / slope,
    rSquared: 1 - residual / total,
  });
}
for (const size of report.sizes) {
  const a = pick(size, 'sync'),
    b = pick(size, 'sync', 'stream');
  assert.equal(b.length, report.pairs);
  const differences = key =>
    a.map(run => {
      const candidate = b.find(other => other.pair === run.pair);
      assert(candidate.stateByteEquality);
      assert.deepEqual(candidate.result, run.result);
      assert.deepEqual(candidate.r2, run.r2);
      return candidate[key] - run[key];
    });
  summary.sync.push({
    files: size,
    currentMedianMiB: median(a.map(run => run.maxRssBytes / 1048576)),
    streamMedianMiB: median(b.map(run => run.maxRssBytes / 1048576)),
    currentMedianWallMs: median(a.map(run => run.wallMs)),
    streamMedianWallMs: median(b.map(run => run.wallMs)),
    memory: bootstrapInterval(differences('maxRssBytes').map(bytes => bytes / 1048576)),
    wall: bootstrapInterval(differences('wallMs')),
    r2: a[0].r2,
    readBytes: a[0].readBytes,
    calls: a[0].calls,
  });
}
process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
