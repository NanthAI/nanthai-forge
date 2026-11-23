// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { conflictTrio, resolveEarly, drainReady } from './early-resolution-replay.mjs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
import { moduleUrl } from './convex-module.mjs';
const records = await import(moduleUrl('../convex/projectHostedRecords.ts'));
const tracking = await import(moduleUrl('../convex/projectHostedOverlapStore.ts'));
async function trackedTrio(t) {
  const trio = await conflictTrio(t);
  const { f } = trio;
  for (const entry of f.entries)
    await f.transaction(
      'track-synthetic-author-delta',
      {
        _handler: async ctx => {
          const record = await records.readHostedRecord(ctx, {
            projectId: f.projectId,
            actor: 'owner',
            kind: 'lane',
            key: entry.lane.laneId,
          });
          const lane = JSON.parse(record.value);
          const base = new Map(
            JSON.parse(f.c.objects.get(lane.base.head)).files.map(file => [file.path, file]),
          );
          const changes = JSON.parse(f.c.objects.get(lane.head))
            .files.filter(file => base.get(file.path)?.blob !== file.blob)
            .map(file => ({ path: file.path, before: base.get(file.path) ?? null, after: file }));
          await tracking.trackHostedOverlapLane(ctx, f.projectId, lane, {
            changes,
            complete: true,
            baseSequence: 0,
          });
        },
      },
      {},
    );
  return trio;
}
const notices = f => [...f.tables.projectHostedConflictNotices.values()].filter(r => r.open);

test('8c9b84fc rep 2: a resolve save never tells the author to change the edit already resolved against a pending prefix', async t => {
  const trio = await trackedTrio(t);
  const resolved = await resolveEarly(trio);
  const peers = new Set(trio.f.entries.slice(0, 2).map(e => e.lane.laneId));
  assert.equal(notices(trio.f).filter(r => r.laneId === resolved.lane.laneId && peers.has(r.peer)).length, 0);
  for (let n = 0; n < 20; n++) {
    const run = trio.f.runs().find(r => r.status === 'queued' && !r.cancelRequested);
    if (!run) break;
    await trio.f.rawChecks.pass(await trio.f.rawChecks.activate(run.id));
    await drainReady(trio.f);
  }
  assert.equal((await trio.f.current(resolved.state.id)).submission.phase, 'landed');
  assert.equal(notices(trio.f).length, 0, 'no stale notice after both sides land');
});

test('8c9b84fc rep 2: acceptance retires old notices even when completion leaves a resolution Lane open', async t => {
  const trio = await trackedTrio(t);
  const resolved = await resolveEarly(trio);
  const owner = [...trio.f.tables.projectHostedOverlapLanes.values()].find(
    r => r.laneId === resolved.lane.laneId,
  );
  const peer = trio.f.entries[1].lane;
  trio.f.patch('projectHostedOverlapLanes', owner._id, { conflicted: true });
  trio.f.insert('projectHostedConflictNotices', {
    projectId: trio.f.projectId,
    laneId: owner.laneId,
    laneHead: owner.head,
    peer: peer.laneId,
    peerHead: peer.head,
    peerGoal: 'synthetic peer',
    open: true,
    flaggedAt: Date.now(),
    updatedAt: Date.now(),
    laneStartedAt: Date.now(),
    paths: [],
  });
  for (let n = 0; n < 20; n++) {
    const run = trio.f.runs().find(r => r.status === 'queued' && !r.cancelRequested);
    if (!run) break;
    await trio.f.rawChecks.pass(await trio.f.rawChecks.activate(run.id));
    await drainReady(trio.f);
  }
  assert.equal((await trio.f.current(resolved.state.id)).submission.phase, 'landed');
  assert.equal(notices(trio.f).length, 0);
});
