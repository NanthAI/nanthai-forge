// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { nativePaths } from '../dist/native-source.js';
import { readIgnoredStatus } from '../dist/ignored-status.js';

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
test('50,000 files and five nested ignore levels keep Forge scan overhead within 5%, with zero hosted calls', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'forge-ignore-scale-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => {
    calls++;
    throw Error('Unexpected hosted IO');
  });
  const directories = [];
  let directory = root;
  for (let depth = 0; depth < 5; depth++) {
    directory = join(directory, 'nested');
    mkdirSync(directory);
    directories.push(directory);
    writeFileSync(join(directory, '.gitignore'), '*.discard\n');
    for (let index = 0; index < 10_000; index++)
      writeFileSync(join(directory, `${index}.${index % 10 === 0 ? 'discard' : 'txt'}`), '');
  }
  const scan = () => {
    const start = performance.now(),
      paths = nativePaths(root);
    return { ms: performance.now() - start, count: paths.length };
  };
  const setForge = enabled => {
    for (const dir of directories)
      if (enabled) writeFileSync(join(dir, '.forgeignore'), '*.discard\n');
      else unlinkSync(join(dir, '.forgeignore'));
  };
  scan(); // Warm filesystem metadata and runtime before the paired observations.
  const git = [],
    forge = [];
  for (let sample = 0; sample < 9; sample++) {
    // Reverse order on alternating pairs to avoid a systematic warm-cache bias.
    if (sample % 2 === 0) {
      const baseline = scan();
      assert.equal(baseline.count, 45_005);
      git.push(baseline.ms);
      setForge(true);
      const added = scan();
      assert.equal(added.count, 45_010);
      forge.push(added.ms);
      setForge(false);
    } else {
      setForge(true);
      const added = scan();
      assert.equal(added.count, 45_010);
      forge.push(added.ms);
      setForge(false);
      const baseline = scan();
      assert.equal(baseline.count, 45_005);
      git.push(baseline.ms);
    }
  }
  const baselineMs = median(git),
    forgeMs = median(forge),
    overhead = forgeMs / baselineMs - 1;
  setForge(true);
  const statusStart = performance.now(),
    status = readIgnoredStatus(root),
    statusMs = performance.now() - statusStart;
  assert.deepEqual(status.counts, { '.gitignore': 0, '.forgeignore': 5000, builtin: 0 });
  assert.equal(calls, 0);
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  t.diagnostic(
    JSON.stringify({
      files: 50000,
      nestedLevels: 5,
      gitIgnoreFiles: 5,
      forgeIgnoreFiles: 5,
      samples: 9,
      baselineMs,
      forgeMs,
      overheadPercent: overhead * 100,
      statusMs,
      peakRssMiB,
      convexCalls: calls,
      documentsRead: 0,
      documentsWritten: 0,
    }),
  );
  assert(peakRssMiB < 512, `peak RSS ${peakRssMiB} MiB exceeds the synthetic scan budget`);
  assert(overhead <= 0.05, `Forge scan adds ${(overhead * 100).toFixed(2)}% over Git-only scan`);
});
