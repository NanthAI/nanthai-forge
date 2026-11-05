// SPDX-License-Identifier: Apache-2.0
// Opt-in benchmark; never adds repeated compiler runs to ordinary verification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareConvexApi } from './prepare-convex-api.mjs';

const pairs = 8;
const nativeWeb =
  'node node_modules/@typescript/native/bin/tsc --noUncheckedSideEffectImports false --types "*" -p web/tsconfig.json';
const legacyWeb = 'node node_modules/typescript/bin/tsc -p web/tsconfig.json';
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert.ok(manifest.scripts.typecheck.includes(nativeWeb), 'Expected the explicit native web route');
const fullAfter = manifest.scripts.typecheck;
const fullBefore = fullAfter.replace(nativeWeb, legacyWeb);
const root = mkdtempSync(join(tmpdir(), 'forge-typecheck-measure-'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let seed = 0x6f726765;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const median = values => {
  const sorted = values.toSorted((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
};
function summary(samples, field) {
  const before = samples.filter(sample => sample.variant === 'before').map(sample => sample[field]);
  const after = samples.filter(sample => sample.variant === 'after').map(sample => sample[field]);
  // Resample paired observations, preserving each pair's shared load conditions.
  const ratios = Array.from({ length: 10000 }, () => {
    const indices = Array.from({ length: pairs }, () => Math.floor(random() * pairs));
    return median(indices.map(i => after[i])) / median(indices.map(i => before[i]));
  }).sort((a, b) => a - b);
  return {
    beforeMedian: median(before),
    afterMedian: median(after),
    afterOverBefore: median(after) / median(before),
    ratio95: [ratios[249], ratios[9749]],
  };
}
function measure(command) {
  const memoryPath = join(root, 'memory');
  const start = performance.now();
  const darwin = process.platform === 'darwin';
  const result = spawnSync(
    '/usr/bin/time',
    darwin ? ['-l', 'sh', '-c', command] : ['-f', '%M', '-o', memoryPath, 'sh', '-c', command],
    { encoding: 'utf8' },
  );
  const seconds = (performance.now() - start) / 1000;
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const memory = darwin
    ? Number(result.stderr.match(/(\d+)\s+maximum resident set size/)?.[1])
    : Number(readFileSync(memoryPath, 'utf8').trim()) * 1024;
  assert.ok(memory > 0, 'Peak RSS unavailable');
  return { seconds, peakRssBytes: memory };
}
try {
  prepareConvexApi(process.cwd());
  const metadata = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    lockSha256: hash('package-lock.json'),
    webConfigSha256: hash('web/tsconfig.json'),
    pairs,
    method:
      'One unscored warmup per variant; 8 alternating AB/BA pairs; full nonincremental checks; OS caches retained; paired median-ratio percentile bootstrap, 10000 resamples, seed 0x6f726765. Peak RSS is the maximum child-process high-water mark, not simultaneous process-tree RSS. Full is the sequential npm typecheck body; web is the isolated landing typecheck:web command. Both routes use identical source after the type-only generic fix.',
  };
  console.log(JSON.stringify({ metadata }));
  for (const [scope, before, after] of [
    ['web', legacyWeb, nativeWeb],
    ['full', fullBefore, fullAfter],
  ]) {
    measure(before);
    measure(after);
    const samples = [];
    for (let pair = 0; pair < pairs; pair++) {
      for (const variant of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
        const sample = { scope, pair, variant, ...measure(variant === 'before' ? before : after) };
        samples.push(sample);
        console.log(JSON.stringify({ sample }));
      }
    }
    console.log(
      JSON.stringify({
        summary: {
          scope,
          wallSeconds: summary(samples, 'seconds'),
          peakRssBytes: summary(samples, 'peakRssBytes'),
        },
      }),
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
