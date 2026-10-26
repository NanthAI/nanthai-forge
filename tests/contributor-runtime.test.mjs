// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('contributor and lifecycle query metadata bundle in the actual non-Node Convex runtime boundary', async () => {
  const result = await build({
    entryPoints: [
      'convex/projectWork.ts',
      'convex/projectContributors.ts',
      'convex/projectProposals.ts',
      'convex/projectBackups.ts',
      'convex/projectLifecycle.ts',
    ],
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'esm',
    write: false,
    outdir: 'unused-runtime-test',
    logLevel: 'silent',
  });
  assert.equal(result.outputFiles.length, 5);
  assert.ok(result.outputFiles.every(file => file.contents.length > 0));
});
