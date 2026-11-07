// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { getFunctionName } from 'convex/server';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { assertAgentResponseShape } from './agent-response-shape.mjs';
import { describeFailure } from '../dist/system-errors.js';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { digest } from '../dist/hash.js';

// Production wrapper path: the CLI and MCP both reach these actions through HostedAgentTransport,
// and both print describeFailure(error) for a refusal.
const jobs = f => [...f.tables.projectHostedRecordHeads.values()].filter(row => row.kind === 'job').length;

async function opened(t) {
  const s = await resolutionFixture(t, { overlap: false }),
    f = s.f;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  return { s, f, root: fs.realpathSync(s.root) };
}

/** Execute exactly the advertised continuation, then replay the original source action. */
async function finish(s, f, retained, command) {
  const { action, ...next } = retained.next;
  assert.equal(action, 'recover-apply');
  const before = jobs(f);
  const recovered = await s.transport().dispatch(action, next);
  assert.equal(recovered.result.status, 'applied');
  assert.equal(recovered.result.applyOperationId, retained.applyOperationId);
  const replay = await s.transport().dispatch('sync', command);
  assert.equal(replay.operationId, command.operationId, 'the original source identity is kept');
  assert.equal(jobs(f), before, 'no new source job');
  const remote = await f.readLane(f.lane.laneId);
  assert.equal(readHostedLaneCheckout(s.root).selection.head, remote.head, 'exact target applied');
  return recovered;
}

test('B2 permissions: a candidate made mode 000 after its pending receipt keeps typed recovery that runs to completion', async t => {
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: false });
  const candidate = join(root, '..forge-client'),
    bytes = Buffer.from('verified cached bytes');
  fs.mkdirSync(join(candidate, 'objects'), { recursive: true });
  fs.writeFileSync(join(candidate, 'objects', digest(bytes)), bytes);
  const rename = fs.renameSync;
  let quarantined;
  t.mock.method(fs, 'renameSync', (from, to) => {
    const result = rename(from, to);
    if (from === candidate && !quarantined) {
      quarantined = String(to);
      fs.chmodSync(quarantined, 0); // After the pending receipt and the move, before re-verification.
    }
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    if (quarantined && fs.existsSync(quarantined)) fs.chmodSync(quarantined, 0o700);
  });
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  let retained;
  try {
    await assert.rejects(s.transport().dispatch('sync', command), error => {
      assert.notEqual(error.code, 'HOSTED_ACTION_FAILED');
      retained = error.recovery;
      assertAgentResponseShape({ error: describeFailure(error) }, s.root, { sourceCompleted: true });
      return true;
    });
  } finally {
    fs.renameSync.mock.restore();
    syncBuiltinESMExports();
  }
  assert(quarantined, 'the candidate was quarantined');
  assert(!fs.existsSync(candidate), 'an unreadable candidate is never put back into the checkout');
  await finish(s, f, retained, command);
  fs.chmodSync(quarantined, 0o700);
  assert.deepEqual(fs.readFileSync(join(quarantined, 'objects', digest(bytes))), bytes, 'bytes retained');
});

test('B2 missing marker: a marker removed between source submission and the first local apply keeps its baseline, and the advertised action progresses', async t => {
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: false });
  const original = s.exchange.client.mutation,
    marker = join(root, '.forge', 'hosted-lane.json');
  let removed = false;
  s.exchange.client.mutation = async (ref, args) => {
    const result = await original(ref, args);
    if (getFunctionName(ref) === 'projectHostedSyncJobs:submit' && !removed) {
      removed = true;
      fs.rmSync(marker);
    }
    return result;
  };
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  let retained;
  try {
    await assert.rejects(s.transport().dispatch('sync', command), error => {
      retained = error.recovery;
      assertAgentResponseShape({ error: describeFailure(error) }, s.root, { sourceCompleted: true });
      return true;
    });
  } finally {
    s.exchange.client.mutation = original;
  }
  assert(removed, 'the marker was removed after source submission');
  await finish(s, f, retained, command);
});

// Dogfood 2026-11-07 (118a5539 comment): `save --sync` with one unsaved edit stopped with source
// done and the local apply pending; getting out took recover-apply, redoing the edit and syncing
// again. An edit the sync does not touch is now carried, as Git carries it.
test('dogfood replay: sync --apply carries one unsaved edit in a file main did not change, and save then records it', async t => {
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: false }); // main adds accepted.txt only
  fs.writeFileSync(join(root, 'a.txt'), 'unsaved local edit\n');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  const synced = await s.transport().dispatch('sync', command);
  const remote = await f.readLane(f.lane.laneId);
  assert.equal(synced.result.applied.head, remote.head);
  assert.equal(readHostedLaneCheckout(root).selection.head, remote.head);
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'unsaved local edit\n', 'edit kept in place');
  assert(fs.existsSync(join(root, 'accepted.txt')), 'main change installed');
  assert.equal(synced.result.applied.displacedRecovery, undefined);
  await s.transport().dispatch('save', { message: 'record the carried edit' });
  const saved = readHostedLaneCheckout(root).state.files.find(file => file.path === 'a.txt');
  assert.equal(saved.blob, digest(Buffer.from('unsaved local edit\n')));
});

test('dogfood replay: an unsaved edit on a file main changed refuses before installing and one named command finishes', async t => {
  const { s, f, root } = await opened(t);
  f.moveMain({ overlap: true }); // main changes a.txt
  fs.writeFileSync(join(root, 'a.txt'), 'unsaved local edit\n');
  const command = { laneId: f.lane.laneId, operationId: randomUUID(), apply: true };
  let retained;
  await assert.rejects(s.transport().dispatch('sync', command), error => {
    retained = error.recovery;
    assert.equal(retained.blockers[0].path, 'a.txt');
    assertAgentResponseShape({ error: describeFailure(error) }, s.root, { sourceCompleted: true });
    assert.match(error.message, /recover-apply/);
    return true;
  });
  assert.equal(fs.readFileSync(join(root, 'a.txt'), 'utf8'), 'unsaved local edit\n', 'nothing installed');
  const { action, ...next } = retained.next;
  const recovered = await s.transport().dispatch(action, next);
  assert.equal(recovered.result.status, 'applied');
  assert.equal(fs.readFileSync(join(recovered.result.preservedAt, 'a.txt'), 'utf8'), 'unsaved local edit\n');
  const remote = await f.readLane(f.lane.laneId);
  assert.equal(readHostedLaneCheckout(root).selection.head, remote.head);
});
