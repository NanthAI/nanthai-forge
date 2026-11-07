// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fixture } from './hosted-sync-client-fixture.mjs';
import { applyHostedSync } from '../dist/hosted-sync-client.js';
import { recoverLocalApply } from '../dist/hosted-apply-recovery.js';
import { checkoutHostedLane } from '../dist/hosted-lane-checkout.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { clientCacheRoot } from '../dist/root-paths.js';
import { randomUUID } from 'node:crypto';

/** Run recovery in a child that SIGKILLs itself right after the named rename boundary. */
function crash(s, request, boundary) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./hosted-apply-recovery-crash-child.mjs', import.meta.url))],
    {
      env: childEnv,
      input: JSON.stringify({
        root: s.root,
        request,
        boundary,
        timing: 'after',
        objects: [...s.objects].map(([id, bytes]) => [id, bytes.toString('base64')]),
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(child.signal, 'SIGKILL', child.stdout + child.stderr);
}
async function blocked(s, request) {
  fs.writeFileSync(join(s.root, 'a'), 'original local draft');
  let retained;
  await assert.rejects(applyHostedSync(s.root, request, s.transport), error => {
    retained = error.recovery;
    return error.code === 'WORK_CONFLICT';
  });
  return retained;
}

const stages = directory => fs.readdirSync(directory).filter(name => name.startsWith('baseline-'));

test('N1: two SIGKILLs without editor activity leave no unused baseline stage after success and replay', async t => {
  const s = await fixture(t),
    request = s.command();
  await blocked(s, request);
  // 1. Killed right after the baseline file is published into the live tree.
  crash(s, request, 'install');
  // 2. Resumed with no editor activity: the published baseline is clean, so the stage the resume
  //    builds is never consumed; killed right after restored:true, before it is removed.
  crash(s, request, 'restored-receipt');
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  const directory = dirname(recovered.preservedAt);
  assert.deepEqual(stages(directory), [], 'no unused baseline stage after success');
  assert.equal(fs.readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'original local draft');
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  const replay = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(replay.applied.replayed, true);
  assert.deepEqual(stages(directory), [], 'no unused baseline stage after completed-operation replay');
  assert.equal(
    fs.readFileSync(join(replay.preservedAt, 'a'), 'utf8'),
    'original local draft',
    'user preservation tree untouched',
  );
});

test('B2 root link: a checkout root recreated as a link after preservation finds its journal and never writes through the link', async t => {
  const s = await fixture(t),
    request = s.command(),
    retained = await blocked(s, request);
  crash(s, request, 'round-recorded'); // The draft is already kept.
  const elsewhere = s.root + '-elsewhere';
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(join(elsewhere, 'unrelated'), 'UNRELATED TARGET BYTES');
  fs.rmSync(s.root, { recursive: true });
  fs.symlinkSync(elsewhere, s.root);
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(recoverLocalApply(s.root, request.operationId, s.transport), error => {
      assert.equal(error.code, 'WORK_CONFLICT');
      const recovery = error.recovery;
      assert.equal(recovery.phase, 'local-apply');
      assert.equal(recovery.root, s.root, 'the retained root, not the link target');
      assert.equal(recovery.blockers[0].kind, 'root-link');
      assert.equal(recovery.next.action, 'recover-apply');
      assert.equal(recovery.applyOperationId, request.operationId);
      assert.equal(recovery.operationId, retained.operationId);
      assert.deepEqual(recovery.from, retained.from);
      assert.deepEqual(recovery.to, retained.to);
      return true;
    });
  assert.deepEqual(fs.readdirSync(elsewhere), ['unrelated'], 'nothing written through the link');
  assert(!fs.existsSync(clientCacheRoot(elsewhere)), 'no cache beside the link target');
  // The advertised action progresses once the link is moved aside.
  fs.unlinkSync(s.root);
  const recovered = await recoverLocalApply(s.root, request.operationId, s.transport);
  assert.equal(recovered.status, 'applied');
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(fs.readFileSync(join(recovered.preservedAt, 'a'), 'utf8'), 'original local draft');
  assert.equal(fs.readFileSync(join(elsewhere, 'unrelated'), 'utf8'), 'UNRELATED TARGET BYTES');
});

test('B2 Lane moved before the first apply receipt: recovery ends with an explicit superseded outcome that progresses, never a WORK_STALE loop', async t => {
  const s = await fixture(t),
    request = s.command();
  await blocked(s, request);
  assert(
    !fs.existsSync(join(clientCacheRoot(s.root), `${request.operationId}.json`)),
    'no checkout receipt yet',
  );
  // Same target bytes, newer Lane version only.
  s.setFiles([{ ...s.files[0], blob: s.put('after\n') }, ...s.files.slice(1)]);
  const current = s.selection();
  assert.equal(current.head, request.lane.head);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await recoverLocalApply(s.root, request.operationId, s.transport);
    assert.equal(result.status, 'superseded');
    assert.equal(result.applyOperationId, request.operationId);
    assert.deepEqual(result.superseded.expected, {
      head: request.lane.head,
      version: request.lane.version,
      sourceVersion: request.lane.sourceVersion,
    });
    assert.equal(result.superseded.current.version, current.version);
    assert.deepEqual(result.from, request.from);
    assert.deepEqual(result.to, request.lane);
    assert.deepEqual(result.next, { action: 'open', laneId: request.lane.laneId });
    assert.equal(
      readHostedLaneCheckout(s.root).selection.version,
      request.from.version,
      'no silent pin switch',
    );
    // Nothing was going to be installed, so nothing moved (e0ae9db0 F2): the draft stays in place.
    assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'original local draft');
    assert.equal(result.preservedAt, null);
  }
  // The explicit next step installs the current head; it refuses to overwrite the draft.
  const open = () =>
    checkoutHostedLane(
      s.root,
      { operationId: randomUUID(), url: request.url, projectId: current.projectId, laneId: current.laneId },
      s.transport,
    );
  await assert.rejects(open(), { code: 'WORK_CONFLICT' });
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'original local draft');
  fs.renameSync(join(s.root, 'a'), join(s.root, '..', 'draft-moved-by-user'));
  fs.writeFileSync(join(s.root, 'a'), 'before\n');
  await checkoutHostedLane(
    s.root,
    { operationId: randomUUID(), url: request.url, projectId: current.projectId, laneId: current.laneId },
    s.transport,
  );
  assert.equal(fs.readFileSync(join(s.root, 'a'), 'utf8'), 'after\n');
  assert.equal(readHostedLaneCheckout(s.root).selection.version, current.version);
});
