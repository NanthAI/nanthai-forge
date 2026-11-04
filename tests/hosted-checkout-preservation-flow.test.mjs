// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
function build(root) {
  for (const path of ['dist/app.js', 'generated/api.d.ts']) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), 'synthetic build output');
  }
  symlinkSync('../dependencies', join(root, 'node_modules'));
  return () => {
    assert.equal(readFileSync(join(root, 'dist/app.js'), 'utf8'), 'synthetic build output');
    assert.equal(readFileSync(join(root, 'generated/api.d.ts'), 'utf8'), 'synthetic build output');
    assert.equal(readlinkSync(join(root, 'node_modules')), '../dependencies');
  };
}

test('hosted sync after a build preserves output; remote advance/local conflict replay installs current lifecycle pins', async t => {
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  writeFileSync(join(s.root, '.gitignore'), '/generated/\n');
  await s.transport().dispatch('save', { message: 'declare synthetic generated output' });
  const check = build(s.root),
    before = readHostedLaneCheckout(s.root);
  f.moveMain({ overlap: false });
  writeFileSync(join(s.root, 'draft.ts'), 'unsaved local draft');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  await assert.rejects(s.transport().dispatch('sync', command), error => {
    assert.equal(error.code, 'WORK_CONFLICT');
    assert.equal(error.recovery.sourceCompleted, true);
    assert.equal(error.recovery.blockers[0].path, 'draft.ts');
    assert.equal(error.recovery.next.action, 'recover-apply');
    return true;
  });
  const remote = await f.readLane(f.lane.laneId);
  assert.notEqual(remote.head, before.selection.head);
  assert.equal(readHostedLaneCheckout(s.root).selection.head, before.selection.head);
  assert.equal(readFileSync(join(s.root, 'draft.ts'), 'utf8'), 'unsaved local draft');
  // Remove only this synthetic obstruction, then replay the original operation.
  rmSync(join(s.root, 'draft.ts'));
  const jobs = [...f.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'job').length;
  const result = await s.transport().dispatch('sync', command);
  assert.equal(result.operationId, command.operationId);
  assert.equal(result.result.applied.head, remote.head);
  assert.equal(
    [...f.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'job').length,
    jobs,
    'replay does not restart source computation',
  );
  assert.equal(readHostedLaneCheckout(s.root).selection.sourceVersion, remote.sourceVersion);
  check();
  const cleanup = await s
    .transport()
    .dispatch('abandon', { laneId: f.lane.laneId, reason: 'synthetic test complete' });
  assert.equal(cleanup.result.result.status, 'applied');
  const lifecycle = s.calls.filter(c => c.name === 'projectHostedLifecycle:transition').at(-1);
  const expected = JSON.parse(lifecycle.args.request).target.expected;
  assert.equal(expected.head, remote.head);
  assert.equal(expected.sourceVersion, remote.sourceVersion);
  check();
});

test('full open, conflict edit, build and resolve preserve dependency links without artifact cleanup', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  const synced = await s.transport().dispatch('sync', { laneId: f.lane.laneId });
  const conflict = synced.result.conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  writeFileSync(join(conflict.root, '.gitignore'), '/generated/\n');
  const check = build(conflict.root);
  const command = { laneId: conflict.laneId, operationId: randomUUID() };
  const fixed = await s.transport(conflict.root).dispatch('resolve', command);
  assert.equal(fixed.result.source.outcome.result.status, 'resolved');
  const head = readHostedLaneCheckout(conflict.root).selection.head;
  assert.equal(readFileSync(join(conflict.root, 'a.txt'), 'utf8'), 'chosen\nb\nc\n');
  check();
  const replay = await s.transport(conflict.root).dispatch('resolve', command);
  assert.equal(replay.operationId, fixed.operationId);
  assert.equal(readHostedLaneCheckout(conflict.root).selection.head, head);
  check();
});
