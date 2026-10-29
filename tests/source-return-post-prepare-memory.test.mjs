// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moduleUrl } from './convex-module.mjs';
const exec = promisify(execFile);
moduleUrl('../convex/projectSourceReturn.ts');
test('post-prepare fallback and original-operation recovery fit 256 MiB with 100 MB Work and 1.46 GB logical source', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-post-prepare-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const worker = new URL('./source-return-post-prepare-worker.mjs', import.meta.url).pathname;
  await exec(process.execPath, [worker, 'fixture', directory], { maxBuffer: 1024 * 1024 });
  // Collect within the asserted RSS budget instead of allowing a 384 MiB old
  // generation and host-dependent young-generation growth. The same fixture,
  // cold retries and peak-RSS assertion still run in the constrained process.
  const { stdout } = await exec(
    process.execPath,
    [
      '--expose-gc',
      '--trace-gc-nvp',
      '--max-old-space-size=128',
      '--max-semi-space-size=4',
      worker,
      'recover',
      directory,
    ],
    { env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' }, maxBuffer: 32 * 1024 * 1024 },
  );
  const result = JSON.parse(stdout.match(/MEMORY_RESULT (.+)/)[1]);
  const peakHeap = Math.max(
    result.sampledHeap,
    ...Array.from(stdout.matchAll(/(?:start_object_size|total_size_before)=(\d+)/g), m => Number(m[1])),
  );
  t.diagnostic(JSON.stringify({ ...result, peakHeap }));
  assert.ok(result.workBytes >= 100_000_000);
  assert.equal(result.objects, 14705);
  assert.equal(result.logicalBytes, 1461289991);
  assert.equal(result.views, 1079);
  assert.equal(result.lanes, 347);
  assert.ok(peakHeap < 320 * 1024 * 1024, `peak heap ${peakHeap}`);
  assert.ok(result.maxRSS < 256 * 1024 * 1024, `peak RSS ${result.maxRSS}`);
});
