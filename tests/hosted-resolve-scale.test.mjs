// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { syncFixture } from './hosted-sync-fixture.mjs';

test('resolve at dogfood size reads conflict pages and edited blobs within a fixed control-call budget', async t => {
  const s = await syncFixture();
  const unchanged = s.file('unchanged/0000.txt', 'unchanged bytes must stay lazy\n');
  const common = Array.from({ length: 3000 }, (_, i) => ({
    ...unchanged,
    path: `unchanged/${String(i).padStart(4, '0')}.txt`,
  }));
  const conflicts = Array.from({ length: 50 }, (_, i) => `conflicts/${String(i).padStart(3, '0')}.txt`);
  const original = s.state(
    [...common, ...conflicts.map(path => s.file(path, 'base\n'))],
    [s.baseline.sha256],
  );
  const left = await s.lane(
    s.state([...common, ...conflicts.map(path => s.file(path, 'left\n'))], [original.sha256]),
  );
  const right = await s.lane(
    s.state([...common, ...conflicts.map(path => s.file(path, 'right\n'))], [original.sha256]),
  );
  const x = s.selection([left, right]);
  await s.prepare(x);
  await s.stage(x);
  await s.submit(x);
  const candidate = (await s.publish(await s.work(x))).outcome.result;
  const draft = (
    await s.execute(
      s.request('resolution', { candidateId: candidate.id, conflicts: candidate.result.conflicts }),
    )
  ).terminal.outcome.result;
  const saved = await s.save((await s.readLane(draft.lane.laneId)).entry, [
    ...common,
    ...conflicts.map(path => s.file(path, 'resolved\n')),
  ]);
  // Retained dogfood records are irrelevant to this selected resolution.
  for (let i = 0; i < 560; i++)
    s.insert('projectHostedRecordHeads', {
      projectId: s.projectId,
      kind: 'lane',
      key: randomUUID(),
      version: 0,
      parent: '',
      status: 'active',
      recordId: 'unselected',
    });
  for (let i = 0; i < 32000; i++)
    s.insert('projectObjects', {
      projectId: s.projectId,
      digest: i.toString(16).padStart(64, '0'),
      size: 1,
      location: 'r2',
      removed: false,
      r2Committed: true,
      nonce: 'unselected',
      r2Key: 'unselected',
    });
  const before = s.counts.length,
    started = performance.now();
  const { terminal, output } = await s.execute(
    s.request('resolve', { laneId: saved.laneId, expected: s.pins(saved) }),
  );
  const calls = s.counts.slice(before);
  const metrics = {
    conflictedFiles: conflicts.length,
    treeFiles: common.length + conflicts.length,
    unrelatedLanes: 560,
    unrelatedObjects: 32000,
    calls: calls.length,
    documents: calls.reduce((n, call) => n + call.documents, 0),
    writes: calls.reduce((n, call) => n + call.writes, 0),
    objectReads: output.reads.length,
    resolvedObjects: output.metrics.resolvedObjects,
    maxRssBytes: output.metrics.maxRssBytes,
    wallMs: Math.round(performance.now() - started),
  };
  assert.equal(terminal.outcome.result.status, 'resolved');
  assert(calls.length <= 16, JSON.stringify(metrics));
  assert(metrics.documents <= 250 && metrics.writes <= 64, JSON.stringify(metrics));
  assert(output.reads.length <= 8, JSON.stringify(metrics));
  assert(!output.reads.some(pin => pin.sha256 === unchanged.blob));
  assert(metrics.maxRssBytes < 1024 * 1024 * 1024, JSON.stringify(metrics));
  t.diagnostic(JSON.stringify(metrics));
});
