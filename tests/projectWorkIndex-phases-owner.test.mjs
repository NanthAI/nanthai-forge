// SPDX-License-Identifier: Apache-2.0
// Split from projectWorkIndex-phases.test.mjs so check shards can run both long workers in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import './projectWorkIndex-progress-fixture.mjs'; // Compile outside the measured action process.
import { moduleUrl } from './convex-module.mjs';
// The precompiled worker also needs the modules the phases file compiles at load.
await import('./hosted-fixture.mjs');
await import('./project-exchange-fixture.mjs');
for (const name of ['Journal', 'Store', 'States', 'Diffstats', 'Projection'])
  await import(moduleUrl(`../convex/projectWorkIndexBuild${name}.ts`));
test('owner-supplied View facts retain the existing post-parent call budgets', async t => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--max-old-space-size=384', 'tests/projectWorkIndex-phases-worker.mjs', 'owner'],
    { env: { ...process.env, FORGE_TEST_PRECOMPILED: '1' }, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout.match(/PHASE_RESULT (.+)/)[1]);
  assert.equal(result.rejected, 0);
  assert.equal(result.sourceFileReads, 0);
  assert.equal(result.sourceFileResolves, 0);
  assert(result.viewCallsPerRecord <= 2, JSON.stringify(result));
  assert(result.remaining.calls <= 8000, JSON.stringify(result));
  t.diagnostic(
    JSON.stringify({ viewCallsPerRecord: result.viewCallsPerRecord, remaining: result.remaining }),
  );
});
