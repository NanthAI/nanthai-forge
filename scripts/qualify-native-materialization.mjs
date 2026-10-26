// SPDX-License-Identifier: Apache-2.0
// node scripts/qualify-native-materialization.mjs /absolute/baseline/dist
// Build the candidate first. Baseline must be an independently retained runtime.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const baseline = process.argv[2];
if (!baseline) throw new Error('Supply the original compiled dist directory; no baseline is inferred.');
const candidate = fileURLToPath(new URL('../dist/', import.meta.url));
const load = async path => ({
  ...(await import(pathToFileURL(join(path, 'native-source.js')))),
  ...(await import(pathToFileURL(join(path, 'native-materialization.js')))),
});
const versions = { baseline: await load(resolve(baseline)), candidate: await load(candidate) };
const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-materialization-qualification-'))),
  owner = join(root, 'owner');
mkdirSync(owner);
const source = new versions.candidate.NativeSource(owner),
  results = [];
try {
  for (const size of [8 * 1024 * 1024, 16 * 1024 * 1024, 32 * 1024 * 1024]) {
    const files = [];
    for (let index = 0; index < 4; index++)
      files.push({
        path: `nested/file-${index}`,
        blob: source.put(Buffer.alloc(size, index + 1)),
        mode: index === 0 ? 'executable' : 'file',
      });
    const head = source.writeState(files, [], 'Identical synthetic measurement', '2026-01-01T00:00:00.000Z');
    for (const mode of ['ordinary', 'recovery'])
      for (let repetition = 0; repetition < 3; repetition++)
        for (const version of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
          const dir = join(root, `${size}-${mode}-${repetition}-${version}`);
          mkdirSync(dir);
          const implementation = versions[version],
            reader = mode === 'recovery' ? new implementation.NativeMaterialization(owner) : undefined;
          const started = performance.now();
          try {
            for (let lane = 0; lane < 8; lane++)
              (reader ?? new implementation.NativeSource(owner)).materialize(
                head,
                join(dir, `lane-${lane}`),
                false,
              );
          } finally {
            reader?.dispose?.();
          }
          const elapsedMs = performance.now() - started;
          for (let lane = 0; lane < 8; lane++)
            for (const file of files) {
              const path = join(dir, `lane-${lane}`, file.path),
                stat = lstatSync(path);
              assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), file.blob);
              assert.equal(stat.nlink, 1);
              assert.equal(stat.mode & 0o777, file.mode === 'executable' ? 0o700 : 0o600);
            }
          results.push({
            size,
            head,
            mode,
            repetition,
            version,
            lanes: 8,
            files: 32,
            logicalBytes: size * 32,
            elapsedMs,
          });
          rmSync(dir, { recursive: true, force: true });
        }
  }
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        baseline: resolve(baseline),
        candidate,
        fixture:
          'Four distinct blobs, eight eager workspaces; identical source; alternating order; no OS-cache control; all output bytes/modes/link counts verified; fixtures removed. Measures materialization only, not full recovery or physical disk savings.',
        results,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
