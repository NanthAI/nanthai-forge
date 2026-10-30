// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import './hosted-fixture.mjs'; // Compile outside the measured action process.
import { moduleUrl } from './convex-module.mjs';
// The validating fake resolves these query targets lazily, even when the worker
// supplies their results. Precompile them before the memory-limited process.
for (const name of ['projectWork', 'projectBackups', 'projectObjects'])
  await import(moduleUrl(`../convex/${name}.ts`));
const exec = promisify(execFile);
const worker = new URL('./projectWorkIndex-memory-worker.mjs', import.meta.url).pathname;
test('128 MB server-held record index stays below the Node action memory limit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'forge-index-memory-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  await exec(process.execPath, [worker, 'fixture', directory]);
  const run = async mode => {
    const { stdout } = await exec(process.execPath, ['--max-old-space-size=384', worker, mode, directory], {
      env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' },
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout.match(/MEMORY_RESULT (.+)/)[1]);
  };
  const before = await run('before'),
    after = await run('after');
  assert(after.workBytes >= 126445313);
  // Only explicit operator preparation may pay this full-history budget.
  assert(after.calls <= 40, JSON.stringify(after));
  assert(after.queryCalls + after.mutationCalls <= 2200, JSON.stringify(after));
  assert(after.readBytes <= after.workBytes * 2, JSON.stringify(after));
  assert(after.dbWriteBytes <= after.workBytes * 2, JSON.stringify(after));
  assert(after.maxRSS < 512 * 1024 * 1024, JSON.stringify(after));
  assert(after.maxStepBytes < 600000, JSON.stringify(after));
  assert(after.maxStepMs > 0 && after.maxStepMs < 30000, JSON.stringify(after));
  assert(after.longestActionMs < 30000, JSON.stringify(after));
  t.diagnostic(JSON.stringify({ before, after, estimatedActionGbHours: (0.5 * after.elapsedMs) / 3600000 }));
});
