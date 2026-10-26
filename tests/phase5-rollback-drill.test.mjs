// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../scripts/child-env.mjs';
import { vanishedCloneRuntimeOnly } from '../scripts/phase5-rollback-copy.mjs';

test('live clone tolerates vanished temporary owner locks but never missing durable source or records', () => {
  const source = '/synthetic/owner';
  const missing = path => ({
    status: 1,
    stderr: Buffer.from(`cp: ${source}/.forge/work/${path}: No such file or directory\n`),
  });
  for (const path of ['integration-preview-request.lock', 'lock', 'lock-queue/ticket.json', 'capture.tmp'])
    assert.equal(vanishedCloneRuntimeOnly(missing(path), source), true);
  for (const path of ['work.json', 'records/abcdef', 'objects/abcdef', 'lane-example/source.lock'])
    assert.equal(vanishedCloneRuntimeOnly(missing(path), source), false);
});

test('clone never hides permission failures, other source paths or a mixed failure', () => {
  const source = '/synthetic/owner';
  for (const stderr of [
    `cp: ${source}/.forge/work/example.lock: Permission denied`,
    'cp: /other/.forge/work/example.lock: No such file or directory',
    `cp: ${source}/.forge/work/example.lock: No such file or directory\ncp: ${source}/.forge/work/work.json: No such file or directory`,
    '',
  ])
    assert.equal(vanishedCloneRuntimeOnly({ status: 1, stderr: Buffer.from(stderr) }, source), false);
  assert.equal(
    vanishedCloneRuntimeOnly(
      { status: 2, stderr: Buffer.from(`cp: ${source}/.forge/work/example.lock: No such file or directory`) },
      source,
    ),
    false,
  );
});

test('offline rollback starts from accepted main when it differs from bootstrap and lands after epoch 2', () => {
  const result = spawnSync(process.execPath, ['scripts/phase5-rollback-drill.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: childEnv(),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const drill = JSON.parse(result.stdout);
  assert.equal(drill.kind, 'synthetic');
  assert.equal(drill.lanes, 2);
  assert.deepEqual(drill.forward, { mode: 'server', epoch: 1 });
  assert.deepEqual(drill.reverse, { mode: 'native-owner', epoch: 2 });
  assert.equal(drill.byteIdenticalSourceStates, true);
  assert.equal(drill.logicalRecordsMatch, true);
  assert.equal(drill.localCheckpointAndLanding, true);
  assert.equal(drill.copyDeleted, true);
});
