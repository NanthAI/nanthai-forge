// SPDX-License-Identifier: Apache-2.0
// Isolated synthetic scale budget, called by hosted-pull-budget.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject } from '../dist/hosted-pull.js';
import { liveMemorySampler } from './live-memory-sampler.mjs';
// Argument 3 'plant' is the proof the guard sees a regression: it retains 0.6 x the bound during each
// pull (clean peak + that is about 2x the clean peak) and runs only the two cheap phases.
const count = Number(process.argv[2]),
  plant = process.argv[3] === 'plant',
  cleanup = [];
assert.equal(typeof globalThis.gc, 'function', 'the pull budget must run with --expose-gc');
// Retained growth over the in-run baseline, measured after a full GC (tests/live-memory-sampler.mjs).
// Clean peaks, 2026-11-09, idle and under 6 CPU burners: 2.7 MiB at 3000 files, 16.1 MiB at 29000
// (RSS read 330-434 MiB for the same code, so it cannot gate; it stays a diagnostic).
const LIVE_DELTA_BOUND_MIB = count === 3000 ? 4 : 28,
  kept = [];
process.env.FORGE_OBJECT_CACHE = 'off';
// Build output survives pull because the project ignores it; Forge never drops a folder by name.
const f = pullFixture({ after: fn => cleanup.push(fn) }, count, [['.gitignore', '/dist/\n']]);
try {
  fs.mkdirSync(join(f.root, 'dist'));
  fs.writeFileSync(join(f.root, 'dist/out'), 'regenerable');
  fs.symlinkSync('../dependencies', join(f.root, 'node_modules'));
  const measured = [],
    memory = liveMemorySampler();
  for (const changed of plant ? [0, 10] : [0, 10, 1000]) {
    if (changed)
      f.select(Array.from({ length: changed }, (_, i) => [`src/${i}.txt`, `change ${changed} ${i}\n`]));
    f.reset();
    memory.restart();
    if (plant) kept.push(Buffer.alloc(Math.round(LIVE_DELTA_BOUND_MIB * 0.6 * 1048576), 1));
    let localStats = 0;
    const lstat = fs.lstatSync;
    fs.lstatSync = (...args) => {
      localStats++;
      return lstat(...args);
    };
    syncBuiltinESMExports();
    const start = performance.now();
    let result;
    try {
      result = await pullHostedProject(f.root, f.address, f.transport);
    } finally {
      fs.lstatSync = lstat;
      syncBuiltinESMExports();
    }
    memory.sample();
    const live = memory.report(),
      wallMs = Math.round(performance.now() - start),
      calls = f.calls.queries + f.calls.pages.length;
    assert.equal(calls, changed ? 3 + Math.ceil(changed / 100) : 1);
    assert.equal(f.calls.gets.length, changed ? changed + 1 : 0);
    assert.equal(f.calls.pack, 0);
    assert(f.calls.pages.every(page => page.length <= 100));
    assert.equal(result.downloadedBytes, f.calls.bytes);
    assert.equal(fs.readFileSync(join(f.root, 'dist/out'), 'utf8'), 'regenerable');
    assert.equal(fs.readlinkSync(join(f.root, 'node_modules')), '../dependencies');
    // Shared CI/machines have no elapsed-time SLA. Guard linear filesystem work
    // deterministically; retain wall time as measured evidence, not a load-dependent gate.
    assert(localStats <= 8 * count + 20000, `${localStats} local stats at ${count}`);
    measured.push({
      changed,
      convexCalls: calls,
      r2Gets: f.calls.gets.length,
      downloadedBytes: result.downloadedBytes,
      wallMs,
      localStats,
      peakLiveDeltaMiB: +(live.peakLiveMiB - live.baselineLiveMiB).toFixed(1),
    });
  }
  const peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  const peakLiveDeltaMiB = Math.max(...measured.map(m => m.peakLiveDeltaMiB));
  assert(
    peakLiveDeltaMiB <= LIVE_DELTA_BOUND_MIB,
    `peak live memory +${peakLiveDeltaMiB} MiB over the pre-pull baseline at ${count} files (bound ${LIVE_DELTA_BOUND_MIB})`,
  );
  console.log(JSON.stringify({ files: count, peakRssMiB, peakLiveDeltaMiB, measured }));
} finally {
  for (const fn of cleanup) fn();
}
