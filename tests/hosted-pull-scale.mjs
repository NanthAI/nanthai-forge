// SPDX-License-Identifier: Apache-2.0
// Isolated synthetic scale budget, called by hosted-pull-budget.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { pullFixture } from './hosted-pull-fixture.mjs';
import { pullHostedProject } from '../dist/hosted-pull.js';
const count = Number(process.argv[2]),
  cleanup = [];
process.env.FORGE_OBJECT_CACHE = 'off';
const f = pullFixture({ after: fn => cleanup.push(fn) }, count);
try {
  fs.mkdirSync(join(f.root, 'dist'));
  fs.writeFileSync(join(f.root, 'dist/out'), 'regenerable');
  fs.symlinkSync('../dependencies', join(f.root, 'node_modules'));
  const measured = [];
  for (const changed of [0, 10, 1000]) {
    if (changed)
      f.select(Array.from({ length: changed }, (_, i) => [`src/${i}.txt`, `change ${changed} ${i}\n`]));
    f.reset();
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
    const wallMs = Math.round(performance.now() - start),
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
    });
  }
  const peakRssMiB = Math.round(process.resourceUsage().maxRSS / 1024);
  assert(peakRssMiB < (count === 3000 ? 250 : 400), `peak RSS ${peakRssMiB}MiB`);
  console.log(JSON.stringify({ files: count, peakRssMiB, measured }));
} finally {
  for (const fn of cleanup) fn();
}
